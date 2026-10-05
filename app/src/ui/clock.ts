/**
 * Song clock. Song time 0 is the chart's first downbeat at the session's rate (the same
 * time base as engine.Session). Real time comes from performance.now(), which is also
 * the clock MIDI and keyboard events are stamped with.
 */
import type { Chart } from '../core/chart';

export class SongClock {
  /** performance.now() value at song time 0. */
  private t0 = 0;
  private pausedAt: number | null = null;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Make the song time equal `songT` right now and run. */
  start(songT: number): void {
    this.t0 = this.now() - songT;
    this.pausedAt = null;
  }

  /** Song time at real time `at` (defaults to now; frozen while paused). */
  time(at?: number): number {
    if (this.pausedAt !== null) return this.pausedAt - this.t0;
    return (at ?? this.now()) - this.t0;
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  /** Resume where we paused; returns how long the pause lasted. */
  resume(): number {
    if (this.pausedAt === null) return 0;
    const d = this.now() - this.pausedAt;
    this.t0 += d;
    this.pausedAt = null;
    return d;
  }

  /**
   * Wait mode: never let the song run past `gate`. Returns true while holding.
   * Holding shifts t0 so that time() stays exactly at the gate.
   */
  hold(gate: number | null, at = this.now()): boolean {
    if (gate === null || this.pausedAt !== null) return false;
    if (at - this.t0 < gate) return false;
    this.t0 = at - gate;
    return true;
  }

  /** Song time of an input event stamped at `eventTime`, with the device latency removed. */
  inputTime(eventTime: number, offsetMs: number): number {
    return eventTime - offsetMs - this.t0;
  }
}

/** Quarter-note length in ms of the measure at the start of play, scaled by rate. */
export function countInBeatMs(chart: Chart, rate: number, fromMeasure = 0): number {
  const m = chart.measures[Math.max(0, Math.min(chart.measures.length - 1, fromMeasure))];
  const bpm = m?.bpm || chart.meta.bpm || 100;
  return 60000 / bpm / rate;
}

export interface Beat {
  /** Song time (at rate). */
  t: number;
  /** First beat of a measure. */
  bar: boolean;
  /** 0-based measure index; negative for count-in beats. */
  measure: number;
}

/**
 * Metronome / beat-line grid from the chart's measures: each measure is split into its
 * time-signature numerator (4/4 → 4 beats, 6/8 → 6). Count-in beats precede `startT`.
 */
export function beatGrid(chart: Chart, rate: number, startT: number, countIn = 4): Beat[] {
  const out: Beat[] = [];
  const startMeasure = chart.measures.findIndex((m) => Math.abs(m.startMs / rate - startT) < 1);
  const cb = countInBeatMs(chart, rate, startMeasure < 0 ? 0 : startMeasure);
  for (let i = countIn; i >= 1; i--) out.push({ t: startT - i * cb, bar: i === countIn, measure: -i });
  for (const m of chart.measures) {
    const n = Math.max(1, m.timeSignature[0]);
    const len = m.durationMs / n;
    for (let b = 0; b < n; b++) {
      const t = (m.startMs + b * len) / rate;
      if (t >= startT - 0.5) out.push({ t, bar: b === 0, measure: m.index });
    }
  }
  return out;
}
