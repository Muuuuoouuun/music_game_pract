/**
 * Judgment engine. Pure and DOM-free: callers pass song time in milliseconds and the
 * engine answers with judgment events. Song time 0 is the first downbeat of the
 * chart, already scaled by the practice tempo (a note at chart 1000 ms plays at
 * 2000 ms when rate = 0.5).
 *
 * Rules (docs/00-product-concept.md, mockups/BRIEF.md):
 *  - Perfect ≤ 45 ms, Great ≤ 90 ms, Good ≤ 140 ms, otherwise Miss once the note is
 *    140 ms in the past.
 *  - A press matches the closest unjudged note of the same pitch inside the Good window;
 *    a press with no match is Wrong (combo reset, no score).
 *  - Score = Σ weight / note count × 1,000,000. Ranks S ≥ 95, A ≥ 90, B ≥ 80, C ≥ 70.
 *  - Wait mode: time stops at the next unplayed note ("gate") until its key is played.
 *    Notes count as "ok" (first try) or "okw" (after a wrong key).
 */
import type { Chart, ChartNote, Hand } from './chart';

export type Judgment = 'perfect' | 'great' | 'good' | 'miss' | 'ok' | 'okw';
export type HandMode = Hand | 'B';

export interface Windows {
  perfect: number;
  great: number;
  good: number;
}

export const DEFAULT_WINDOWS: Windows = { perfect: 45, great: 90, good: 140 };

export const WEIGHT: Record<Judgment, number> = {
  perfect: 1,
  great: 0.7,
  good: 0.4,
  miss: 0,
  ok: 1,
  okw: 0,
};

export interface SessionOptions {
  hands: HandMode;
  /** Tempo multiplier, e.g. 0.5 / 0.75 / 1. */
  rate: number;
  wait: boolean;
  /** Inclusive, 0-based measure range for A–B practice. */
  loop?: { from: number; to: number };
  windows?: Windows;
}

export interface SessionNote {
  note: ChartNote;
  /** Song time of the note at this session's rate. */
  t: number;
  dur: number;
  result: Judgment | null;
  /** Signed timing error (negative = early). 0 for misses. */
  err: number;
}

export interface WrongPress {
  midi: number;
  t: number;
  measure: number;
  /** Pitch the player most likely meant (closest note in time). */
  intended: number | null;
}

export type JudgeEvent =
  | { kind: 'hit'; judgment: Exclude<Judgment, 'miss'>; note: SessionNote; err: number }
  | { kind: 'miss'; judgment: 'miss'; note: SessionNote }
  | { kind: 'wrong'; wrong: WrongPress };

export type Rank = 'S' | 'A' | 'B' | 'C' | 'D';

export function rankOf(accuracy: number): Rank {
  return accuracy >= 95 ? 'S' : accuracy >= 90 ? 'A' : accuracy >= 80 ? 'B' : accuracy >= 70 ? 'C' : 'D';
}

export class Session {
  readonly chart: Chart;
  readonly opts: Required<Omit<SessionOptions, 'loop'>> & { loop?: { from: number; to: number } };
  readonly notes: SessionNote[];
  /** Song time where play begins (start of the loop's first measure, or 0). */
  readonly startT: number;
  /** Song time where play ends. */
  readonly endT: number;
  readonly counts: Record<Judgment | 'wrong', number> = { perfect: 0, great: 0, good: 0, miss: 0, ok: 0, okw: 0, wrong: 0 };
  readonly wrongs: WrongPress[] = [];
  combo = 0;
  maxCombo = 0;
  private sumW = 0;
  private judged = 0;
  private gateWrong = false;
  private gateT: number | null = null;

  constructor(chart: Chart, options: SessionOptions) {
    this.chart = chart;
    this.opts = { windows: DEFAULT_WINDOWS, ...options };
    const { hands, rate, loop } = this.opts;
    const inLoop = (m: number) => !loop || (m >= loop.from && m <= loop.to);
    this.notes = chart.notes
      .filter((n) => (hands === 'B' || n.hand === hands) && inLoop(n.measure))
      .map((n) => ({ note: n, t: n.startMs / rate, dur: n.durationMs / rate, result: null, err: 0 }));
    const ms = chart.measures;
    if (loop && ms.length) {
      const a = ms[Math.max(0, loop.from)];
      const b = ms[Math.min(ms.length - 1, loop.to)];
      this.startT = a.startMs / rate;
      this.endT = (b.startMs + b.durationMs) / rate;
    } else {
      this.startT = 0;
      this.endT = chart.meta.durationMs / rate;
    }
    this.gateT = this.computeGate();
  }

  get total(): number {
    return this.notes.length;
  }
  get judgedCount(): number {
    return this.judged;
  }
  get done(): boolean {
    return this.judged >= this.notes.length;
  }
  /** 0–1,000,000. Unplayed notes count as zero, so the score only grows. */
  get score(): number {
    return this.total ? Math.round((this.sumW / this.total) * 1e6) : 0;
  }
  /** Final accuracy over all notes (0–100). */
  get accuracy(): number {
    return this.total ? (this.sumW / this.total) * 100 : 0;
  }
  /** Accuracy over notes judged so far, for the live HUD. */
  get runningAccuracy(): number {
    return this.judged ? (this.sumW / this.judged) * 100 : 100;
  }
  get rank(): Rank {
    return rankOf(this.accuracy);
  }
  get fullCombo(): boolean {
    return this.done && this.counts.miss === 0 && this.counts.wrong === 0;
  }
  get perfectPlay(): boolean {
    const top = this.opts.wait ? this.counts.ok : this.counts.perfect;
    return this.done && top === this.total && this.counts.wrong === 0;
  }

  /** Wait mode: song time the clock must hold at, or null when nothing is pending. */
  get gate(): number | null {
    return this.opts.wait ? this.gateT : null;
  }

  /** Notes that must be played to open the current gate (a chord gives several). */
  gateNotes(): SessionNote[] {
    if (this.gateT === null) return [];
    return this.notes.filter((n) => !n.result && n.t === this.gateT);
  }

  /** Judge a key press at song time `t` (input offset already removed). */
  press(midi: number, t: number): JudgeEvent | null {
    return this.opts.wait ? this.pressWait(midi, t) : this.pressTimed(midi, t);
  }

  /** Advance to song time `t`; returns notes that just became misses. Not used in wait mode. */
  update(t: number): JudgeEvent[] {
    if (this.opts.wait) return [];
    const out: JudgeEvent[] = [];
    const late = this.opts.windows.good;
    for (const n of this.notes) {
      if (n.t > t) break;
      if (!n.result && t > n.t + late) {
        this.apply(n, 'miss', 0);
        out.push({ kind: 'miss', judgment: 'miss', note: n });
      }
    }
    return out;
  }

  private pressTimed(midi: number, t: number): JudgeEvent | null {
    const w = this.opts.windows;
    let best: SessionNote | null = null;
    let bd = Infinity;
    for (const n of this.notes) {
      if (n.result || n.note.midi !== midi) continue;
      const d = Math.abs(t - n.t);
      if (d <= w.good && d < bd) {
        bd = d;
        best = n;
      }
    }
    if (!best) {
      const first = this.notes[0]?.t ?? this.startT;
      const last = this.notes[this.notes.length - 1]?.t ?? this.endT;
      if (t < first - w.good || t > last + w.good) return null; // before the first / after the last note: free play
      return { kind: 'wrong', wrong: this.addWrong(midi, t) };
    }
    const judgment = bd <= w.perfect ? 'perfect' : bd <= w.great ? 'great' : 'good';
    const err = t - best.t;
    this.apply(best, judgment, err);
    return { kind: 'hit', judgment, note: best, err };
  }

  private pressWait(midi: number, t: number): JudgeEvent | null {
    const g = this.gateT;
    if (g === null) return null;
    if (t < this.startT - this.opts.windows.good) return null; // count-in: free play
    if (g - t <= this.opts.windows.good) {
      const n = this.notes.find((x) => !x.result && x.t === g && x.note.midi === midi);
      if (n) {
        const judgment = this.gateWrong ? 'okw' : 'ok';
        const err = t - g;
        this.apply(n, judgment, err);
        return { kind: 'hit', judgment, note: n, err };
      }
    }
    this.gateWrong = true;
    const intended = this.gateNotes()[0]?.note.midi ?? null;
    return { kind: 'wrong', wrong: this.addWrong(midi, Math.max(this.startT, Math.min(t, g)), intended) };
  }

  private addWrong(midi: number, t: number, intended?: number | null): WrongPress {
    this.counts.wrong++;
    this.combo = 0;
    let near: SessionNote | null = null;
    for (const n of this.notes) if (!near || Math.abs(n.t - t) < Math.abs(near.t - t)) near = n;
    const rate = this.opts.rate;
    const ms = this.chart.measures;
    let measure = near?.note.measure ?? 0;
    for (let i = ms.length - 1; i >= 0; i--) {
      if (ms[i].startMs / rate <= t) {
        measure = i;
        break;
      }
    }
    const w: WrongPress = { midi, t, measure, intended: intended !== undefined ? intended : near?.note.midi ?? null };
    this.wrongs.push(w);
    return w;
  }

  private apply(n: SessionNote, j: Judgment, err: number): void {
    n.result = j;
    n.err = j === 'miss' ? 0 : err;
    this.counts[j]++;
    this.sumW += WEIGHT[j];
    this.judged++;
    if (j === 'miss') this.combo = 0;
    else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }
    const g = this.computeGate();
    if (g !== this.gateT) {
      this.gateT = g;
      this.gateWrong = false;
    }
  }

  private computeGate(): number | null {
    for (const n of this.notes) if (!n.result) return n.t;
    return null;
  }

  /** Per-measure accuracy (0–1) for notes in the session; null where the measure had none. */
  measureAccuracy(): (number | null)[] {
    const acc: { w: number; n: number }[] = this.chart.measures.map(() => ({ w: 0, n: 0 }));
    for (const n of this.notes) {
      const a = acc[n.note.measure];
      if (!a) continue;
      a.n++;
      a.w += WEIGHT[n.result ?? 'miss'];
    }
    return acc.map((a) => (a.n ? a.w / a.n : null));
  }

  /** Timing errors of hit notes in timed mode (empty in wait mode). */
  timingErrors(): number[] {
    if (this.opts.wait) return [];
    return this.notes.filter((n) => n.result && n.result !== 'miss').map((n) => n.err);
  }
}
