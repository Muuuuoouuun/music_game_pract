/** Keyboard geometry shared by the on-screen keys, the highway and the import preview. */
import { isBlackKey } from '../core/chart';

/** Stage-light gels: every pitch class owns a hue around the wheel. */
export const LANE_HUE = [352, 8, 28, 42, 54, 150, 168, 192, 214, 248, 272, 304];

export interface Lane {
  /** Left edge as a fraction of the keyboard width. */
  l: number;
  w: number;
  b: boolean;
}

export interface LaneLayout {
  lo: number;
  hi: number;
  lane: Record<number, Lane>;
  whites: number;
}

export function laneLayout(lo: number, hi: number): LaneLayout {
  const whites: number[] = [];
  for (let m = lo; m <= hi; m++) if (!isBlackKey(m)) whites.push(m);
  const W = whites.length;
  const bw = 0.6 / W;
  const lane: Record<number, Lane> = {};
  for (let m = lo; m <= hi; m++) {
    if (!isBlackKey(m)) lane[m] = { l: whites.indexOf(m) / W, w: 1 / W, b: false };
    else {
      const i = whites.filter((x) => x < m).length;
      lane[m] = { l: i / W - bw / 2, w: bw, b: true };
    }
  }
  return { lo, hi, lane, whites: W };
}

function whiteCount(lo: number, hi: number): number {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (!isBlackKey(m)) n++;
  return n;
}

/**
 * Range of keys to show for a set of pitches: from the C at or below the lowest note to
 * the nearest E or B at or above the highest one, widened (upwards, then downwards at the
 * top of the piano) until at least `minWhites` white keys show. Clamped to A0–C8.
 */
export function fitKeyRange(midis: Iterable<number>, minWhites = 10): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of midis) {
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  if (!Number.isFinite(lo)) return [60, 76];
  lo = Math.max(21, lo - (lo % 12));
  const up = (m: number) => {
    const pc = m % 12;
    return pc <= 4 ? m + (4 - pc) : m + (11 - pc);
  };
  hi = Math.min(108, up(hi));
  while (whiteCount(lo, hi) < minWhites && hi < 108) hi = Math.min(108, up(hi + 1));
  while (whiteCount(lo, hi) < minWhites && lo > 21) lo = Math.max(21, lo - 12);
  return [lo, hi];
}
