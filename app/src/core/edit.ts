/**
 * Chart editing: pure, DOM-free operations for the 교정·추가 editor.
 *
 *  - Timing: `rebuildTiming` lays a constant tempo grid over the notes (first downbeat
 *    at `offsetMs`; anything before it is a pickup measure 0 of real length) and
 *    re-derives every note's (measure, beat). `rebuildFromMeasures` keeps an existing
 *    grid (tempo changes) and only re-derives notes, extending the grid when notes
 *    run past its end.
 *  - Note ops return a new chart and never touch the input. Ids stay stable; new notes
 *    get `e-<n>`. Pitch is clamped to the 88 keys (21–108), durations to >= 30 ms, and
 *    a group move/transpose is clamped as a whole so chords keep their shape.
 *  - `UndoStack` is a bounded past/present/future stack; `replaceTop` coalesces drags.
 *  - `chartToMidiBytes` writes a two-track (R/L) Standard MIDI file whose tempo map and
 *    time signatures come from `chart.measures`. A pickup measure is encoded as a
 *    repeated time signature at the first downbeat, which `chartFromMidi` reads back as
 *    a short first measure, so (measure, beat, midi, hand) round-trip on grid charts.
 */
import { Midi } from '@tonejs/midi';
import { measureAt, sortNotes, type Chart, type ChartMeasure, type ChartNote, type Hand } from './chart';
import { parseKeyName, r6 } from '../import/common';

export const MIDI_MIN = 21;
export const MIDI_MAX = 108;
export const MIN_DURATION_MS = 30;
export const BPM_MIN = 20;
export const BPM_MAX = 400;

export type SnapDivision = 4 | 8 | 16 | '8t' | '16t';
/** Grid step in quarter notes per division. */
export const SNAP_QUARTERS: Record<SnapDivision, number> = { 4: 1, 8: 0.5, 16: 0.25, '8t': 1 / 3, '16t': 1 / 6 };
export const SNAP_LABEL: Record<SnapDivision, string> = { 4: '4분', 8: '8분', 16: '16분', '8t': '8분 셋잇단', '16t': '16분 셋잇단' };

export interface TimingSpec {
  bpm: number;
  timeSignature: [number, number];
  /** Chart time of the first full measure's downbeat. */
  offsetMs: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const quarterMs = (bpm: number) => 60000 / bpm;
/** Quarter notes in one measure of `ts`. */
export const measureQuarters = (ts: [number, number]): number => (ts[0] * 4) / ts[1];
const clampMidi = (m: number) => clamp(Math.round(m), MIDI_MIN, MIDI_MAX);
const noteEnd = (n: ChartNote) => n.startMs + n.durationMs;

// ---- timing ---------------------------------------------------------------------------

/** Re-derives (measure, beat) for every note against `measures`. */
function relocate(notes: ChartNote[], measures: ChartMeasure[]): ChartNote[] {
  const stub = { measures } as Chart;
  return notes.map((n) => {
    const mi = measureAt(stub, n.startMs);
    const m = measures[mi];
    const beat = m ? r6(Math.max(0, n.startMs - m.startMs) / quarterMs(m.bpm)) : 0;
    return n.measure === mi && n.beat === beat ? n : { ...n, measure: mi, beat };
  });
}

function finish(chart: Chart, measures: ChartMeasure[], notes: ChartNote[]): Chart {
  const last = measures[measures.length - 1];
  const sorted = sortNotes(notes.slice());
  return {
    ...chart,
    measures,
    notes: relocate(sorted, measures),
    meta: {
      ...chart.meta,
      bpm: measures[0].bpm,
      timeSignature: measures[0].timeSignature,
      durationMs: r6(last.startMs + last.durationMs),
    },
  };
}

/** The constant-tempo spec a chart currently follows (first measure's values; pickup → offset). */
export function timingOf(chart: Chart): TimingSpec {
  const m0 = chart.measures[0];
  if (!m0) return { bpm: chart.meta.bpm || 100, timeSignature: chart.meta.timeSignature ?? [4, 4], offsetMs: 0 };
  const nominal = measureQuarters(m0.timeSignature) * quarterMs(m0.bpm);
  const pickup = chart.measures.length > 1 && m0.durationMs < nominal - 1;
  return { bpm: m0.bpm, timeSignature: m0.timeSignature, offsetMs: pickup ? r6(m0.startMs + m0.durationMs) : r6(m0.startMs) };
}

/** True when every measure shares one tempo and time signature. */
export function hasConstantTempo(chart: Chart): boolean {
  const [m0, ...rest] = chart.measures;
  if (!m0) return true;
  return rest.every((m) => m.bpm === m0.bpm && m.timeSignature[0] === m0.timeSignature[0] && m.timeSignature[1] === m0.timeSignature[1]);
}

/**
 * Lays a constant tempo grid over the chart. The first full measure starts at
 * `offsetMs` (wrapped into one measure length); notes before it form a pickup measure 0
 * of exactly that length. The grid covers every note, the attached recording, and—
 * for an empty chart without audio—the current number of measures.
 */
export function rebuildTiming(chart: Chart, spec: TimingSpec, opts: { minEndMs?: number } = {}): Chart {
  const bpm = clamp(Number(spec.bpm) || 100, BPM_MIN, BPM_MAX);
  const ts: [number, number] = [Math.max(1, Math.round(spec.timeSignature[0])), Math.max(1, Math.round(spec.timeSignature[1]))];
  const qms = quarterMs(bpm);
  const mMs = measureQuarters(ts) * qms;
  let down = Number.isFinite(spec.offsetMs) ? spec.offsetMs : 0;
  if (down < 0) down += Math.ceil(-down / mMs) * mMs;
  if (down >= mMs - 1) down -= mMs;
  if (down < 1) down = 0;
  const pickup = down > 0;

  const notes = chart.notes;
  const lastEnd = notes.reduce((e, n) => Math.max(e, noteEnd(n)), 0);
  const audioEnd = chart.audio ? chart.audio.durationMs - chart.audio.offsetMs : 0;
  const measures: ChartMeasure[] = [];
  if (pickup) measures.push({ index: 0, startMs: 0, durationMs: r6(down), timeSignature: ts, bpm });
  const t0 = pickup ? down : 0;
  let full: number;
  if (!notes.length && !chart.audio && !opts.minEndMs) full = Math.max(1, chart.measures.length - (timingOf(chart).offsetMs > 0 ? 1 : 0));
  else full = Math.max(1, Math.ceil((Math.max(lastEnd, audioEnd, opts.minEndMs ?? 0) - t0 - 1e-6) / mMs));
  for (let i = 0; i < full; i++) {
    measures.push({ index: measures.length, startMs: r6(t0 + i * mMs), durationMs: r6(mMs), timeSignature: ts, bpm });
  }
  return finish(chart, measures, notes);
}

/**
 * Keeps the chart's measures (so tempo changes survive) and re-derives note positions,
 * appending measures in the last measure's tempo/signature when notes run past the end.
 */
export function rebuildFromMeasures(chart: Chart): Chart {
  if (!chart.measures.length) return rebuildTiming(chart, timingOf(chart));
  const measures = chart.measures.map((m, i) => (m.index === i ? m : { ...m, index: i }));
  const lastEnd = chart.notes.reduce((e, n) => Math.max(e, noteEnd(n)), 0);
  let last = measures[measures.length - 1];
  while (last.startMs + last.durationMs < lastEnd - 1e-6) {
    const next: ChartMeasure = {
      index: measures.length,
      startMs: r6(last.startMs + last.durationMs),
      durationMs: r6(measureQuarters(last.timeSignature) * quarterMs(last.bpm)),
      timeSignature: last.timeSignature,
      bpm: last.bpm,
    };
    measures.push(next);
    last = next;
  }
  return finish(chart, measures, chart.notes);
}

/** Nearest grid time to `ms` for `division`, anchored at measure starts (so odd pickups still snap to the downbeat). */
export function snapMs(chart: Chart, ms: number, division: SnapDivision): number {
  if (!chart.measures.length) return ms;
  const mi = measureAt(chart, ms);
  const m = chart.measures[mi];
  const step = SNAP_QUARTERS[division] * quarterMs(m.bpm);
  const k = Math.round((ms - m.startMs) / step);
  let best = m.startMs + k * step;
  const next = chart.measures[mi + 1];
  if (next && Math.abs(next.startMs - ms) < Math.abs(best - ms)) best = next.startMs;
  return r6(Math.max(0, best));
}

/** Grid step in ms at `ms` for `division`. */
export function snapStepMs(chart: Chart, ms: number, division: SnapDivision): number {
  const m = chart.measures[measureAt(chart, ms)];
  return SNAP_QUARTERS[division] * quarterMs(m?.bpm ?? chart.meta.bpm ?? 100);
}

/** "3마디 2.5박" in the measure's own beat unit; a pickup reads 못갖춘마디. */
export function beatLabel(chart: Chart, note: Pick<ChartNote, 'measure' | 'beat'>): string {
  const m = chart.measures[note.measure];
  const pickup = timingOf(chart).offsetMs > 0 && chart.measures.length > 1;
  const unit = m ? 4 / m.timeSignature[1] : 1;
  const beat = Math.round((note.beat / unit + 1) * 100) / 100;
  const bar = pickup ? (note.measure === 0 ? '못갖춘마디' : `${note.measure}마디`) : `${note.measure + 1}마디`;
  return `${bar} ${beat}박`;
}

// ---- note ops -------------------------------------------------------------------------

export interface NewNote {
  midi: number;
  startMs: number;
  durationMs: number;
  hand: Hand;
  velocity?: number;
  id?: string;
}

/** Next free `e-<n>` id. */
export function newNoteId(chart: Chart, taken: Iterable<string> = []): string {
  let max = 0;
  const scan = (id: string) => {
    const m = /^e-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const n of chart.notes) scan(n.id);
  for (const id of taken) scan(id);
  return `e-${max + 1}`;
}

export function addNote(chart: Chart, n: NewNote): Chart {
  const note: ChartNote = {
    id: n.id ?? newNoteId(chart),
    midi: clampMidi(n.midi),
    startMs: r6(Math.max(0, n.startMs)),
    durationMs: r6(Math.max(MIN_DURATION_MS, n.durationMs)),
    hand: n.hand,
    velocity: clamp(Math.round(n.velocity ?? 80), 1, 127),
    measure: 0,
    beat: 0,
  };
  return rebuildFromMeasures({ ...chart, notes: [...chart.notes, note] });
}

export function deleteNotes(chart: Chart, ids: Iterable<string>): Chart {
  const set = new Set(ids);
  if (!set.size) return chart;
  return rebuildFromMeasures({ ...chart, notes: chart.notes.filter((n) => !set.has(n.id)) });
}

function mapNotes(chart: Chart, ids: Iterable<string>, fn: (n: ChartNote) => ChartNote): Chart {
  const set = new Set(ids);
  if (!set.size) return chart;
  let changed = false;
  const notes = chart.notes.map((n) => {
    if (!set.has(n.id)) return n;
    const out = fn(n);
    if (out !== n) changed = true;
    return out;
  });
  return changed ? rebuildFromMeasures({ ...chart, notes }) : chart;
}

/**
 * Moves notes in time and pitch. The delta is clamped for the whole group, so a chord
 * pushed against A0, C8 or time 0 stops as one block instead of folding onto itself.
 */
export function moveNotes(chart: Chart, ids: Iterable<string>, d: { dMs?: number; dMidi?: number }): Chart {
  const set = new Set(ids);
  const sel = chart.notes.filter((n) => set.has(n.id));
  if (!sel.length) return chart;
  let dMs = d.dMs ?? 0;
  let dMidi = Math.round(d.dMidi ?? 0);
  const minStart = Math.min(...sel.map((n) => n.startMs));
  if (minStart + dMs < 0) dMs = -minStart;
  const lo = Math.min(...sel.map((n) => n.midi));
  const hi = Math.max(...sel.map((n) => n.midi));
  if (lo + dMidi < MIDI_MIN) dMidi = MIDI_MIN - lo;
  if (hi + dMidi > MIDI_MAX) dMidi = MIDI_MAX - hi;
  if (!dMs && !dMidi) return chart;
  return mapNotes(chart, set, (n) => ({ ...n, startMs: r6(n.startMs + dMs), midi: n.midi + dMidi }));
}

export function transpose(chart: Chart, ids: Iterable<string>, semitones: number): Chart {
  return moveNotes(chart, ids, { dMidi: semitones });
}

/** Changes durations by `dMs`, never below 30 ms. */
export function resizeNotes(chart: Chart, ids: Iterable<string>, dMs: number): Chart {
  if (!dMs) return chart;
  return mapNotes(chart, ids, (n) => ({ ...n, durationMs: r6(Math.max(MIN_DURATION_MS, n.durationMs + dMs)) }));
}

/** Sets the end time of each note to `endMs` (at least 30 ms after its start). */
export function setNoteEnd(chart: Chart, ids: Iterable<string>, endMs: number): Chart {
  return mapNotes(chart, ids, (n) => {
    const dur = r6(Math.max(MIN_DURATION_MS, endMs - n.startMs));
    return dur === n.durationMs ? n : { ...n, durationMs: dur };
  });
}

export function setHand(chart: Chart, ids: Iterable<string>, hand: Hand): Chart {
  return mapNotes(chart, ids, (n) => (n.hand === hand ? n : { ...n, hand }));
}

export function setVelocity(chart: Chart, ids: Iterable<string>, velocity: number): Chart {
  const v = clamp(Math.round(velocity), 1, 127);
  return mapNotes(chart, ids, (n) => (n.velocity === v ? n : { ...n, velocity: v }));
}

/**
 * Snaps note starts and/or ends to the grid. An end that would land on or before the
 * start moves to the next grid point, so quantized notes are never shorter than a step.
 */
export function quantize(chart: Chart, ids: Iterable<string>, division: SnapDivision, what: { starts?: boolean; ends?: boolean } = {}): Chart {
  const starts = what.starts ?? true;
  const ends = what.ends ?? false;
  if (!starts && !ends) return chart;
  return mapNotes(chart, ids, (n) => {
    const start = starts ? snapMs(chart, n.startMs, division) : n.startMs;
    let dur = n.durationMs;
    if (ends) {
      let end = snapMs(chart, n.startMs + n.durationMs, division);
      if (end <= start + 1e-6) end = snapMs(chart, start + snapStepMs(chart, start, division), division);
      dur = Math.max(MIN_DURATION_MS, end - start);
    }
    dur = r6(dur);
    return start === n.startMs && dur === n.durationMs ? n : { ...n, startMs: start, durationMs: dur };
  });
}

/** Every note at or above `splitMidi` goes to the right hand, the rest to the left. */
export function splitHandsByPitch(chart: Chart, splitMidi = 60): Chart {
  return setHand(
    setHand(chart, chart.notes.filter((n) => n.midi >= splitMidi).map((n) => n.id), 'R'),
    chart.notes.filter((n) => n.midi < splitMidi).map((n) => n.id),
    'L',
  );
}

/** An empty chart to write from scratch: `bars` measures of `timeSignature` at `bpm`. */
export function blankChart(opts: { id: string; title: string; bpm?: number; timeSignature?: [number, number]; bars?: number }): Chart {
  const bpm = opts.bpm ?? 100;
  const ts = opts.timeSignature ?? [4, 4];
  const mMs = measureQuarters(ts) * quarterMs(bpm);
  const bars = Math.max(1, opts.bars ?? 8);
  const measures: ChartMeasure[] = Array.from({ length: bars }, (_, i) => ({ index: i, startMs: r6(i * mMs), durationMs: r6(mMs), timeSignature: ts, bpm }));
  return {
    schema: 'keystage.chart/v1',
    meta: { id: opts.id, title: opts.title, composer: '직접 만든 곡', source: { kind: 'musicxml' }, bpm, timeSignature: ts, durationMs: r6(bars * mMs) },
    measures,
    notes: [],
  };
}

// ---- undo -------------------------------------------------------------------------------

export class UndoStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  private current: T;
  readonly cap: number;

  constructor(initial: T, cap = 200) {
    this.current = initial;
    this.cap = cap;
  }

  get present(): T {
    return this.current;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get depth(): number {
    return this.past.length;
  }

  /** Records `next` as a new step and clears the redo list. */
  push(next: T): void {
    if (next === this.current) return;
    this.past.push(this.current);
    if (this.past.length > this.cap) this.past.splice(0, this.past.length - this.cap);
    this.current = next;
    this.future = [];
  }

  /** Replaces the present without a new step: successive drag frames become one undo. */
  replaceTop(next: T): void {
    this.current = next;
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  /** Drops the present and returns to the previous step without a redo entry (a drag that ended where it began). */
  pop(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.current = prev;
    return prev;
  }

  /** Forgets history and starts over from `state` (after a save or a new chart). */
  reset(state: T): void {
    this.past = [];
    this.future = [];
    this.current = state;
  }
}

// ---- MIDI export ------------------------------------------------------------------------

const KEY_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];

/**
 * Standard MIDI file (format 1, 480 ppq): track 1 = right hand, track 2 = left hand,
 * both piano. Tempo and time-signature events follow `chart.measures`; a short measure
 * (pickup) is followed by a repeated time signature at the next downbeat so importers
 * that lay measures from the signatures reproduce the short bar.
 */
export function chartToMidiBytes(chart: Chart): Uint8Array {
  const midi = new Midi();
  const h = midi.header;
  const ppq = h.ppq;
  h.name = chart.meta.title;
  const measures = chart.measures.length ? chart.measures : rebuildTiming(chart, timingOf(chart)).measures;

  const mTicks: number[] = [];
  let tick = 0;
  measures.forEach((m, i) => {
    mTicks.push(tick);
    const prev = measures[i - 1];
    if (!prev || prev.bpm !== m.bpm) h.tempos.push({ ticks: tick, bpm: m.bpm });
    const nominalPrev = prev ? Math.round(measureQuarters(prev.timeSignature) * ppq) : 0;
    const prevTicks = prev ? tick - mTicks[i - 1] : 0;
    const tsChanged = !prev || prev.timeSignature[0] !== m.timeSignature[0] || prev.timeSignature[1] !== m.timeSignature[1];
    if (tsChanged || prevTicks < nominalPrev) h.timeSignatures.push({ ticks: tick, timeSignature: [m.timeSignature[0], m.timeSignature[1]] });
    tick += Math.max(1, Math.round((m.durationMs / quarterMs(m.bpm)) * ppq));
  });
  const { fifths, mode } = parseKeyName(chart.meta.key);
  if (chart.meta.key && (mode === 'major' || mode === 'minor')) h.keySignatures.push({ ticks: 0, key: KEY_NAMES[fifths + 7], scale: mode });
  h.update();

  const stub = { measures } as Chart;
  const tickOf = (ms: number) => {
    const mi = measureAt(stub, ms);
    const m = measures[mi];
    return mTicks[mi] + Math.round(((ms - m.startMs) / quarterMs(m.bpm)) * ppq);
  };
  const right = midi.addTrack();
  right.name = 'Right Hand';
  right.channel = 0;
  const left = midi.addTrack();
  left.name = 'Left Hand';
  left.channel = 1;
  for (const n of chart.notes) {
    const start = tickOf(n.startMs);
    const end = Math.max(start + 1, tickOf(n.startMs + n.durationMs));
    (n.hand === 'R' ? right : left).addNote({ midi: clampMidi(n.midi), ticks: start, durationTicks: end - start, velocity: (clamp(n.velocity, 1, 127) + 0.5) / 127 });
  }
  return midi.toArray();
}
