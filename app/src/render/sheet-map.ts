/**
 * Pure helpers for the sheet view: matching chart notes to engraved notes, placing a
 * playhead between engraved positions, and putting arbitrary pitches on a staff.
 * Kept DOM- and OSMD-free so they can be unit-tested with plain data.
 */
import type { Chart } from '../core/chart';
import { measureAt } from '../core/chart';

export interface NoteKey {
  measure: number;
  /** Quarter notes from the start of the measure. */
  beat: number;
  midi: number;
}

/**
 * Pairs every chart note with at most one engraved note: first exact (same measure, pitch
 * and beat within `tol`), then the closest beat of the same pitch in the same measure
 * within `loose` quarters (rounding in imported files). Returns chart index → engraved index.
 */
export function matchNotes(chart: NoteKey[], engraved: NoteKey[], tol = 1e-3, loose = 0.26): Map<number, number> {
  const byKey = new Map<string, number[]>();
  engraved.forEach((g, i) => {
    const k = `${g.measure}|${g.midi}`;
    const list = byKey.get(k);
    if (list) list.push(i);
    else byKey.set(k, [i]);
  });
  const used = new Set<number>();
  const out = new Map<number, number>();
  for (const limit of [tol, loose]) {
    chart.forEach((n, ci) => {
      if (out.has(ci)) return;
      const list = byKey.get(`${n.measure}|${n.midi}`);
      if (!list) return;
      let best = -1;
      let bd = Infinity;
      for (const gi of list) {
        if (used.has(gi)) continue;
        const d = Math.abs(engraved[gi].beat - n.beat);
        if (d <= limit && d < bd) {
          bd = d;
          best = gi;
        }
      }
      if (best >= 0) {
        used.add(best);
        out.set(ci, best);
      }
    });
  }
  return out;
}

export interface MeasureSpan {
  /** x where the music of the measure starts (after clef/key/time at a system start). */
  x0: number;
  /** x of the closing barline. */
  x1: number;
  /** Length of the measure in quarter notes. */
  quarters: number;
  /** Engraved onsets (beat in quarters → x), any order, duplicates allowed. */
  points: { beat: number; x: number }[];
}

/** Playhead x inside a measure: linear between engraved onsets, padded to the barlines. */
export function xAtBeat(span: MeasureSpan, beat: number): number {
  const pts = [...span.points].sort((a, b) => a.beat - b.beat);
  const knots: { beat: number; x: number }[] = [];
  if (!pts.length || pts[0].beat > 1e-6) knots.push({ beat: 0, x: span.x0 });
  for (const p of pts) {
    const last = knots[knots.length - 1];
    if (last && Math.abs(last.beat - p.beat) < 1e-6) last.x = Math.min(last.x, p.x);
    else knots.push({ beat: p.beat, x: p.x });
  }
  const end = Math.max(span.quarters, knots[knots.length - 1].beat + 1e-6);
  knots.push({ beat: end, x: span.x1 });
  const b = Math.max(0, Math.min(end, beat));
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const c = knots[i];
    if (b <= c.beat) return a.x + ((c.x - a.x) * (b - a.beat)) / Math.max(1e-6, c.beat - a.beat);
  }
  return span.x1;
}

/** True when the first measure is shorter than its time signature (an anacrusis). */
export function hasPickup(chart: Chart): boolean {
  const m = chart.measures[0];
  if (!m || chart.measures.length < 2) return false;
  const full = (measureQuarters(m.timeSignature) * 60000) / (m.bpm || chart.meta.bpm || 100);
  return m.durationMs < full * 0.98;
}

export function measureQuarters(ts: [number, number]): number {
  return (ts[0] * 4) / ts[1];
}

/** Song time at `rate` → measure index and beat (quarters) inside it. */
export function beatAt(chart: Chart, rate: number, t: number): { measure: number; beat: number } {
  const ms = t * rate;
  const i = measureAt(chart, ms);
  const m = chart.measures[i];
  if (!m) return { measure: 0, beat: 0 };
  const q = measureQuarters(m.timeSignature);
  return { measure: i, beat: ((ms - m.startMs) / Math.max(1, m.durationMs)) * q };
}

const DIA = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

/** Diatonic step number (C4 = 28); sharps sit on the lower letter. */
export function diatonic(midi: number): number {
  return (Math.floor(midi / 12) - 1) * 7 + DIA[midi % 12];
}

export function isSharp(midi: number): boolean {
  return DIA[midi % 12] === DIA[(midi + 11) % 12];
}

/**
 * Vertical position of a pitch in staff spaces below the top staff line (0 = top line,
 * 4 = bottom line, negative = above). Treble top line is F5, bass top line is A3.
 */
export function staffOffset(dia: number, clef: 'G' | 'F'): number {
  const top = clef === 'G' ? 38 : 26;
  return (top - dia) / 2;
}
