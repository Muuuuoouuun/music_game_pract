/**
 * Transcribed notes + tempo → Chart (pure, tested).
 *
 *  - Constant tempo, one time signature. Chart time 0 is the start of the first written
 *    measure: when notes precede the detected downbeat (`offsetMs`) a shorter pickup
 *    measure (whole beats, rounded up to the 16th grid) is put in front, and whole bars
 *    when the downbeat was found well into the music.
 *  - Starts (and ends) within ±`snapTolMs` (35 ms) of the 16th grid are moved onto it;
 *    anything further off keeps its true time and gets a fractional `beat`, exactly like
 *    the MIDI importer. The snapped time is what the engine judges.
 *  - Notes shorter than 40 ms are dropped, durations are at least 60 ms, the same pitch
 *    re-onsetting within 30 ms is one note, and overlaps of one pitch are trimmed.
 *  - Hands by pitch with voice continuity (`splitHandsByPitch`), or one hand for a
 *    monophonic source. `audio.offsetMs` is rewritten to the audio position of chart
 *    time 0 (the detected downbeat minus whatever was laid in front of it).
 */
import type { Chart, ChartAudio, ChartMeasure, ChartNote, Hand } from '../core/chart';
import { assignIds, finalizeNotes, hashId, r6, splitHandsByPitch } from '../import/common';
import { chartToMusicXml } from '../import/toMusicXml';

export interface RawNote {
  midi: number;
  /** ms into the audio file */
  startMs: number;
  durationMs: number;
  /** 1–127 */
  velocity: number;
}

export interface ToChartOptions {
  bpm: number;
  /** Audio position (ms) of the first downbeat. */
  offsetMs: number;
  timeSignature?: [number, number];
  title: string;
  /** `offsetMs` inside is recomputed; the rest is kept. */
  audio?: ChartAudio;
  snapTolMs?: number;
  /** Put every note in one hand (melody line) instead of splitting by pitch. */
  singleHand?: Hand;
  id?: string;
  fileName?: string;
}

export const MIN_NOTE_MS = 60;
export const DROP_BELOW_MS = 40;
export const MERGE_WITHIN_MS = 30;

interface Work {
  midi: number;
  start: number;
  end: number;
  velocity: number;
  voice: string;
  hand?: Hand;
}

export function notesToChart(raw: RawNote[], opts: ToChartOptions): Chart {
  const ts = opts.timeSignature ?? [4, 4];
  const bpm = Math.max(20, Math.min(300, opts.bpm || 120));
  const snapTol = opts.snapTolMs ?? 35;
  const quarter = 60000 / bpm;
  const grid = quarter / 4;
  const barMs = (quarter * 4 * ts[0]) / ts[1];

  // 1. clean: fold pitch into the 88 keys, drop blips, merge re-onsets of one pitch
  const sorted = raw
    .filter((n) => Number.isFinite(n.startMs) && Number.isFinite(n.durationMs) && n.durationMs >= DROP_BELOW_MS)
    .map((n) => {
      let m = Math.round(n.midi);
      while (m < 21) m += 12;
      while (m > 108) m -= 12;
      return { ...n, midi: m };
    })
    .sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
  const cleaned: { midi: number; start: number; end: number; velocity: number }[] = [];
  const lastByPitch = new Map<number, (typeof cleaned)[number]>();
  for (const n of sorted) {
    const prev = lastByPitch.get(n.midi);
    if (prev && n.startMs - prev.start <= MERGE_WITHIN_MS) {
      prev.end = Math.max(prev.end, n.startMs + n.durationMs);
      prev.velocity = Math.max(prev.velocity, n.velocity);
      continue;
    }
    const c = { midi: n.midi, start: n.startMs, end: n.startMs + n.durationMs, velocity: n.velocity };
    cleaned.push(c);
    lastByPitch.set(n.midi, c);
  }
  const work: Work[] = cleaned.map((c) => ({
    midi: c.midi,
    start: c.start - opts.offsetMs,
    end: c.end - opts.offsetMs,
    velocity: Math.max(1, Math.min(127, Math.round(c.velocity) || 80)),
    voice: 'a',
  }));
  if (!work.length) throw new Error('채보된 음표가 없어요.');

  // 2. snap to the 16th grid where close
  const snap = (t: number) => {
    const g = Math.round(t / grid) * grid;
    return Math.abs(g - t) <= snapTol ? g : t;
  };
  for (const w of work) {
    const s = snap(w.start);
    let e = snap(w.end);
    if (e - s < MIN_NOTE_MS) e = s + Math.max(MIN_NOTE_MS, w.end - w.start);
    w.start = s;
    w.end = e;
  }

  // 3. measures: whole bars + a pickup in front when notes precede the downbeat
  const minStart = Math.min(...work.map((w) => w.start));
  let pre = 0; // ms of music laid before the detected downbeat
  if (minStart < -1e-6) {
    const ahead = -minStart;
    const fullBars = Math.floor(ahead / barMs);
    let rem = ahead - fullBars * barMs;
    if (rem > 1e-6) rem = Math.ceil(rem / grid - 1e-6) * grid; // pickup length on the 16th grid
    pre = fullBars * barMs + rem;
    if (rem > barMs * 0.98) pre = (fullBars + 1) * barMs; // nearly a full bar: just a full bar
  }
  for (const w of work) {
    w.start = r6(w.start + pre);
    w.end = r6(w.end + pre);
  }
  const maxEnd = Math.max(...work.map((w) => w.end));
  const measures: ChartMeasure[] = [];
  let t = 0;
  const pickupLen = pre > 0 ? pre - Math.floor(pre / barMs - 1e-9) * barMs : 0;
  if (pickupLen > 1e-6 && pickupLen < barMs - 1e-6) {
    measures.push({ index: 0, startMs: 0, durationMs: r6(pickupLen), timeSignature: ts, bpm });
    t = pickupLen;
  }
  while (t < maxEnd - 1e-6 || measures.length === 0) {
    measures.push({ index: measures.length, startMs: r6(t), durationMs: r6(barMs), timeSignature: ts, bpm });
    t += barMs;
  }
  const measureOf = (ms: number) => {
    let lo = 0;
    let hi = measures.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measures[mid].startMs <= ms + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // 4. hands
  if (opts.singleHand) for (const w of work) w.hand = opts.singleHand;
  else splitHandsByPitch(work);

  // 5. chart notes
  const notes: ChartNote[] = work.map((w) => {
    const m = measureOf(w.start);
    return {
      id: '',
      midi: w.midi,
      startMs: w.start,
      durationMs: Math.max(1, r6(w.end - w.start)),
      hand: w.hand ?? (w.midi >= 60 ? 'R' : 'L'),
      velocity: w.velocity,
      measure: m,
      beat: r6((w.start - measures[m].startMs) / quarter),
    };
  });
  const final = finalizeNotes(notes);
  assignIds(final, (n) => (n.hand === 'R' ? 1 : 2));

  const last = measures[measures.length - 1];
  const sig = final.map((n) => `${n.midi}@${Math.round(n.startMs)}`).join(',') + `|${bpm}|${ts.join('/')}`;
  const chart: Chart = {
    schema: 'keystage.chart/v1',
    meta: {
      id: opts.id ?? `audio-${hashId(sig)}`,
      title: opts.title || '제목 없음',
      source: { kind: 'audio', ...(opts.fileName ? { fileName: opts.fileName } : {}) },
      bpm: Math.round(bpm * 100) / 100,
      timeSignature: ts,
      durationMs: r6(last.startMs + last.durationMs),
    },
    measures,
    notes: final,
  };
  if (opts.audio) chart.audio = { ...opts.audio, offsetMs: r6(opts.offsetMs - pre) };
  chart.musicXml = chartToMusicXml(chart);
  return chart;
}

/** Length of music (ms) a chart lays before the detected downbeat: `audio.offsetMs` + this = detected downbeat. */
export function pickupMs(chart: Chart): number {
  const m = chart.measures[0];
  if (!m) return 0;
  const full = (60000 / m.bpm) * ((4 * m.timeSignature[0]) / m.timeSignature[1]);
  return m.durationMs < full * 0.98 ? m.durationMs : 0;
}

/**
 * One voice for a melody source: notes that start together (within `windowMs`) keep only
 * the loudest, and each note ends where the next begins. Sorted by start.
 */
export function toMonophonic(raw: RawNote[], windowMs = 50): RawNote[] {
  const sorted = raw.slice().sort((a, b) => a.startMs - b.startMs || b.velocity - a.velocity);
  const out: RawNote[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && n.startMs - prev.startMs <= windowMs) {
      if (n.velocity > prev.velocity) out[out.length - 1] = { ...n };
      continue;
    }
    out.push({ ...n });
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const gap = out[i + 1].startMs - out[i].startMs;
    if (out[i].durationMs > gap) out[i].durationMs = gap;
  }
  return out;
}
