/**
 * Play-flow phases, kept free of the DOM so the rules can be tested:
 *
 *   ready ──start──▶ countin ──go──▶ playing ──finish──▶ ended
 *     ▲                │  ▲            │                   │
 *     │              pause│resume     pause               start (next loop pass)
 *     │                ▼  │            ▼                   ▼
 *     └──settings──── paused ◀─────────┘                 countin
 *
 * `ready` doubles as the attract demo. 설정 바꾸기 from the pause menu goes back to
 * `ready` with the paused run kept aside (`suspended`), so 이어서 하기 can pick it up
 * unless a setting that changes the run (tempo, hands, mode, section) was touched.
 */
export type Phase = 'ready' | 'countin' | 'playing' | 'paused' | 'ended';
export type PhaseAction = 'start' | 'go' | 'pause' | 'resume' | 'settings' | 'invalidate' | 'finish' | 'reset';

export interface PhaseState {
  phase: Phase;
  /** A paused run waits behind the ready screen. */
  suspended: boolean;
}

export const READY: PhaseState = { phase: 'ready', suspended: false };

/** The next state, or the same object when the action does not apply. */
export function nextPhase(s: PhaseState, a: PhaseAction): PhaseState {
  const p = s.phase;
  switch (a) {
    case 'start': // a fresh run: from the ready screen, 처음부터 in the pause menu, or the next loop pass
      return p === 'ready' || p === 'paused' || p === 'ended' ? { phase: 'countin', suspended: false } : s;
    case 'go':
      return p === 'countin' ? { phase: 'playing', suspended: false } : s;
    case 'pause':
      return p === 'countin' || p === 'playing' ? { phase: 'paused', suspended: false } : s;
    case 'resume': // always through a short count so the hands can find the keys again
      return p === 'paused' || (p === 'ready' && s.suspended) ? { phase: 'countin', suspended: false } : s;
    case 'settings':
      return p === 'paused' ? { phase: 'ready', suspended: true } : s;
    case 'invalidate':
      return p === 'ready' && s.suspended ? READY : s;
    case 'finish':
      return p === 'playing' ? { phase: 'ended', suspended: false } : s;
    case 'reset':
      return p === 'ready' && !s.suspended ? s : READY;
  }
}

/** Phases where the app chrome steps aside for the notes. */
export const isFocus = (p: Phase): boolean => p !== 'ready';
/** Phases where the song clock should be running (auto-pause applies). */
export const isRunning = (p: Phase): boolean => p === 'countin' || p === 'playing';

/**
 * "Wake on movement": the pause button and the cursor show for `ms` after the last
 * pointer movement or touch, then fade away again.
 */
export class AutoHide {
  private until = -Infinity;
  readonly ms: number;

  constructor(ms = 2000) {
    this.ms = ms;
  }

  poke(now: number): void {
    this.until = now + this.ms;
  }

  awake(now: number): boolean {
    return now < this.until;
  }

  sleep(): void {
    this.until = -Infinity;
  }
}

/** A short 3-2-1 before a paused run continues (none in wait mode, which has no timing). */
export function resumeSchedule(now: number, beatMs: number, wait: boolean, beats = 3): { ticks: { at: number; label: string }[]; end: number } {
  if (wait) return { ticks: [], end: now };
  const b = Math.max(250, Math.min(900, beatMs));
  const ticks = Array.from({ length: beats }, (_, i) => ({ at: now + i * b, label: String(beats - i) }));
  return { ticks, end: now + beats * b };
}

/** Combo counts worth announcing to screen readers (not every hit). */
export const comboMilestone = (n: number): boolean => n === 10 || n === 25 || n === 50 || (n >= 100 && n % 100 === 0);

/**
 * 건반을 누르면 시작: ignore presses right after the ready screen appears, so keys still
 * held from the last run (or the chord that ended it) do not start the next one.
 */
export const keyStartAllowed = (now: number, readySince: number, guardMs = 800): boolean => now - readySince >= guardMs;
