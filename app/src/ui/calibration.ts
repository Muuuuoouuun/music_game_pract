/**
 * Latency calibration: the player taps along with clicks; the offset is the median of
 * (tap time − beat time) after dropping taps that belong to no beat and outliers.
 * Positive = the input (or the sound reaching the player's ears) arrives late.
 */
import { median } from './format';

export interface Calibration {
  offset: number;
  /** Taps that counted. */
  used: number;
  /** Half the range of the counted taps (a "±" for the UI). */
  spread: number;
}

export function calibrate(taps: number[], beats: number[], beatMs: number, minTaps = 4): Calibration | null {
  if (!beats.length) return null;
  const byBeat = new Map<number, number>();
  for (const tap of taps) {
    let bi = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - tap) < Math.abs(beats[bi] - tap)) bi = i;
    const d = tap - beats[bi];
    if (Math.abs(d) >= beatMs * 0.45 || byBeat.has(bi)) continue; // one tap per beat, the first one
    byBeat.set(bi, d);
  }
  const ds = [...byBeat.values()];
  if (ds.length < minTaps) return null;
  const m0 = median(ds);
  const mad = median(ds.map((d) => Math.abs(d - m0)));
  const kept = ds.filter((d) => Math.abs(d - m0) <= Math.max(35, 3 * mad));
  if (kept.length < minTaps) return null;
  return {
    offset: Math.round(median(kept)),
    used: kept.length,
    spread: Math.round((Math.max(...kept) - Math.min(...kept)) / 2),
  };
}
