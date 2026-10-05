/**
 * Auto-play plans. 'demo' is the lively attract mode (mostly Perfect, some Great/Good,
 * rare Miss and one fumbled wrong key that leaves a red ghost on the sheet); 'perfect'
 * is the 자동 연주 toggle (a tidy model performance).
 */
import type { SessionNote } from '../core/engine';

export interface AutoPlan {
  /** Planned timing error in ms. */
  err: number;
  miss?: boolean;
  /** A wrong key `dt` ms before this note (negative = earlier). */
  wrong?: { midi: number; dt: number };
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planAuto(
  notes: SessionNote[],
  style: 'demo' | 'perfect',
  rnd: () => number = Math.random,
  inRange: (m: number) => boolean = () => true,
): { plans: Map<SessionNote, AutoPlan>; fumble: SessionNote | null } {
  const plans = new Map<SessionNote, AutoPlan>();
  notes.forEach((n, i) => {
    const r = rnd();
    const sg = rnd() < 0.5 ? -1 : 1;
    if (style === 'perfect') plans.set(n, { err: (rnd() - 0.5) * 18 });
    else if (r < 0.03 && i > 8) plans.set(n, { err: 0, miss: true });
    else if (r < 0.08) plans.set(n, { err: sg * (96 + rnd() * 38) });
    else if (r < 0.22) plans.set(n, { err: sg * (50 + rnd() * 36) });
    else plans.set(n, { err: (rnd() - 0.5) * 72 });
  });
  let fumble: SessionNote | null = null;
  if (style === 'demo' && notes.length > 4) {
    // fumble once around the 9th note: a neighbour key a little early, then the right one a bit late
    const from = Math.min(8, Math.floor(notes.length / 3));
    fumble = notes.slice(from).find((n) => n.note.hand === 'R') ?? notes[from];
    const m = fumble.note.midi;
    const wrong = [m + 2, m - 2, m + 1, m - 1].find((x) => inRange(x) && !notes.some((o) => o.note.midi === x && Math.abs(o.t - fumble!.t) < 400));
    if (wrong !== undefined) plans.set(fumble, { err: 58, wrong: { midi: wrong, dt: -170 } });
    else fumble = null;
  }
  return { plans, fumble };
}
