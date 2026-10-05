/**
 * Standard MIDI file → Chart, via @tonejs/midi.
 *
 *  - Timing comes from the file's tempo map (`header.ticksToSeconds`); no tempo event
 *    means 120 BPM (the MIDI default). Measures are laid out from tick 0 with the
 *    header's time signatures (default 4/4), each `ppq × 4 × beats / beatType` ticks.
 *  - Tracks: drum tracks (channel 10 / percussion) are skipped. Piano tracks (GM family
 *    "piano" or a name containing piano/keyboard/피아노) are preferred; if there are
 *    none, every melodic track is used. Exactly two candidate tracks → the one with the
 *    higher average pitch is R, the other L. Otherwise the notes are merged and split
 *    by pitch (`splitHandsByPitch`, >= C4 → R with continuity).
 *  - Quantization: a note start (and end) within 25 ms of the 16th-note grid is moved
 *    onto the grid, and that snapped time IS the chart's startMs (the judged time).
 *    Files exported from notation software are already exact, and recorded files get
 *    tidy beats without moving notes that are clearly off-grid (those keep their true
 *    onset and a fractional `beat`).
 *  - Notes shorter than 30 ms are dropped; pitches outside the 88 keys are folded by
 *    octaves into A0–C8 (21–108) so they keep their pitch class.
 */
import { Midi } from '@tonejs/midi';
import type { Chart, ChartMeasure, ChartNote, Hand } from '../core/chart';
import {
  ImportError,
  assignIds,
  finalizeNotes,
  hashId,
  r6,
  splitHandsByPitch,
  stripExtension,
  type ImportOptions,
} from './common';
import { chartToMusicXml } from './toMusicXml';

const SNAP_SEC = 0.025;
const MIN_SEC = 0.03;
const PIANO_RE = /piano|keyboard|klavier|clavier|pno|피아노|건반/i;

interface Raw {
  track: number;
  midi: number;
  startTick: number;
  endTick: number;
  velocity: number;
  hand?: Hand;
}

export function chartFromMidi(data: ArrayBuffer | Uint8Array, opts: ImportOptions = {}): Chart {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let midi: Midi;
  try {
    midi = new Midi(bytes);
  } catch (e) {
    throw new ImportError('MIDI 파일을 읽을 수 없어요. 파일이 손상됐거나 표준 MIDI 파일(.mid)이 아니에요.', { cause: e });
  }
  const h = midi.header;
  const ppq = h.ppq || 480;
  const sec = (tick: number) => h.ticksToSeconds(tick);
  /** ms rounded to the microsecond so 60000/bpm products don't leave 1799.9999… */
  const msOf = (tick: number) => Math.round(sec(tick) * 1e6) / 1e3;

  const melodic = midi.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.notes.length > 0 && t.channel !== 9 && !t.instrument.percussion);
  if (!melodic.length) throw new ImportError('MIDI 파일에서 연주할 음표를 찾지 못했어요. (드럼 트랙만 있거나 비어 있어요)');
  const piano = melodic.filter(({ t }) => t.instrument.family === 'piano' || PIANO_RE.test(t.name) || PIANO_RE.test(t.instrument.name));
  const chosen = piano.length ? piano : melodic;

  // Collect, snap to the 16th grid, filter.
  const grid = ppq / 4;
  const snap = (tick: number) => {
    const g = Math.round(tick / grid) * grid;
    return Math.abs(sec(g) - sec(tick)) <= SNAP_SEC ? g : tick;
  };
  const raws: Raw[] = [];
  for (const { t, i } of chosen) {
    for (const n of t.notes) {
      const end = n.ticks + n.durationTicks;
      if (sec(end) - sec(n.ticks) < MIN_SEC) continue;
      const s = snap(n.ticks);
      let e = snap(end);
      if (e <= s) e = Math.max(end, s + 1);
      let m = n.midi;
      while (m < 21) m += 12;
      while (m > 108) m -= 12;
      raws.push({ track: i, midi: m, startTick: s, endTick: e, velocity: Math.max(1, Math.min(127, Math.round(n.velocity * 127))) });
    }
  }
  if (!raws.length) throw new ImportError('MIDI 파일에서 연주할 음표를 찾지 못했어요.');

  // Hands.
  if (chosen.length === 2) {
    const avg = (ti: number) => {
      const ps = raws.filter((r) => r.track === ti).map((r) => r.midi);
      return ps.reduce((a, b) => a + b, 0) / Math.max(1, ps.length);
    };
    const [a, b] = chosen.map((c) => c.i);
    const rightTrack = avg(a) >= avg(b) ? a : b;
    for (const r of raws) r.hand = r.track === rightTrack ? 'R' : 'L';
  } else {
    splitHandsByPitch(raws.map((r) => Object.assign(r, { start: r.startTick, voice: `t${r.track}` })));
  }

  // Measures from ticks.
  const sigs = h.timeSignatures
    .map((s) => ({ ticks: s.ticks, ts: [s.timeSignature[0] || 4, s.timeSignature[1] || 4] as [number, number] }))
    .sort((a, b) => a.ticks - b.ticks);
  if (!sigs.length || sigs[0].ticks > 0) sigs.unshift({ ticks: 0, ts: [4, 4] });
  const tempos = h.tempos.slice().sort((a, b) => a.ticks - b.ticks);
  const bpmAt = (tick: number) => {
    let bpm = tempos.length && tempos[0].ticks <= tick ? tempos[0].bpm : 120;
    for (const t of tempos) if (t.ticks <= tick) bpm = t.bpm;
    return bpm;
  };
  const endTick = Math.max(...raws.map((r) => r.endTick));
  const mTicks: number[] = [];
  const measures: ChartMeasure[] = [];
  let t = 0;
  while (t < endTick || measures.length === 0) {
    let si = 0;
    for (let k = 0; k < sigs.length; k++) if (sigs[k].ticks <= t) si = k;
    const ts = sigs[si].ts;
    let len = Math.round((ppq * 4 * ts[0]) / ts[1]);
    const next = sigs[si + 1]?.ticks;
    if (next !== undefined && next > t && next < t + len) len = next - t;
    const startMs = msOf(t);
    // Tempo meta events store µs per quarter, so 90 BPM reads back as 90.00009: round for display.
    const bpm = Math.round(bpmAt(t) * 1000) / 1000;
    measures.push({ index: measures.length, startMs, durationMs: r6(msOf(t + len) - startMs), timeSignature: ts, bpm });
    mTicks.push(t);
    t += len;
  }
  const measureOf = (tick: number) => {
    let lo = 0;
    let hi = mTicks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (mTicks[mid] <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const notes: ChartNote[] = raws.map((r) => {
    const m = measureOf(r.startTick);
    const startMs = msOf(r.startTick);
    return {
      id: '',
      midi: r.midi,
      startMs,
      durationMs: Math.max(1, r6(msOf(r.endTick) - startMs)),
      hand: r.hand ?? (r.midi >= 60 ? 'R' : 'L'),
      velocity: r.velocity,
      measure: m,
      beat: r6((r.startTick - mTicks[m]) / ppq),
    };
  });
  const final = finalizeNotes(notes);
  assignIds(final, (n) => (n.hand === 'R' ? 1 : 2));

  const ks = h.keySignatures[0];
  const last = measures[measures.length - 1];
  const title = opts.title ?? (opts.fileName ? stripExtension(opts.fileName) : null) ?? (midi.name?.trim() || '제목 없음');
  const chart: Chart = {
    schema: 'keystage.chart/v1',
    meta: {
      id: opts.id ?? `midi-${hashId(bytes)}`,
      title,
      source: { kind: 'midi', ...(opts.fileName ? { fileName: opts.fileName } : {}) },
      bpm: measures[0].bpm,
      timeSignature: measures[0].timeSignature,
      ...(ks?.key ? { key: `${ks.key} ${ks.scale}` } : {}),
      durationMs: last.startMs + last.durationMs,
    },
    measures,
    notes: final,
  };
  chart.musicXml = chartToMusicXml(chart);
  return chart;
}
