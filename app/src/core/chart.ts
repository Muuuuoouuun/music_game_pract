/**
 * Chart: the playable, time-resolved form of a song. Every importer (built-in data,
 * MusicXML, MIDI file, later audio transcription) produces this shape, and the
 * engine, renderers and results only ever read it.
 *
 * Times are milliseconds from the first downbeat at 100% tempo. Tempo scaling
 * (practice at 50/75%) happens in the engine, never in the chart.
 */

export type Hand = 'L' | 'R';

export interface ChartNote {
  /** Stable within a chart; the sheet renderer and results key off it. */
  id: string;
  midi: number;
  startMs: number;
  durationMs: number;
  hand: Hand;
  /** 1–127. Imported sheets without dynamics use 80. */
  velocity: number;
  /** 0-based measure index. */
  measure: number;
  /** Beat position inside the measure in quarter-note units, 0-based. */
  beat: number;
}

export interface ChartMeasure {
  /** 0-based index; equals the position in `Chart.measures`. */
  index: number;
  startMs: number;
  durationMs: number;
  /** e.g. [4, 4], [3, 4], [6, 8] */
  timeSignature: [number, number];
  /** Quarter notes per minute in effect at the start of this measure. */
  bpm: number;
}

export type ChartSourceKind = 'builtin' | 'musicxml' | 'midi' | 'audio';

export interface ChartMeta {
  id: string;
  title: string;
  composer?: string;
  source: { kind: ChartSourceKind; fileName?: string };
  /** Tempo of the first measure, for display. */
  bpm: number;
  timeSignature: [number, number];
  /** Human-readable key, e.g. "C major", when known. */
  key?: string;
  durationMs: number;
}

export interface Chart {
  schema: 'keystage.chart/v1';
  meta: ChartMeta;
  measures: ChartMeasure[];
  /** Sorted by startMs, then midi. */
  notes: ChartNote[];
  /**
   * MusicXML used by the sheet view. Kept from the source file when it was MusicXML,
   * otherwise generated from the notes. Optional: the highway works without it.
   */
  musicXml?: string;
}

export function sortNotes(notes: ChartNote[]): ChartNote[] {
  return notes.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

/** Index of the measure that contains time `ms` (clamped to the chart). */
export function measureAt(chart: Chart, ms: number): number {
  const ms0 = chart.measures;
  if (!ms0.length) return 0;
  let lo = 0;
  let hi = ms0.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms0[mid].startMs <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function noteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[midi % 12] + (Math.floor(midi / 12) - 1);
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}
