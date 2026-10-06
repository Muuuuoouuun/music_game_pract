import { describe, expect, it } from 'vitest';
import { AutoHide, READY, comboMilestone, isFocus, isRunning, keyStartAllowed, nextPhase, resumeSchedule, type PhaseAction, type PhaseState } from '../src/ui/phase';

const run = (s: PhaseState, ...as: PhaseAction[]) => as.reduce(nextPhase, s);

describe('play phases', () => {
  it('goes ready → countin → playing → ended → ready', () => {
    let s = nextPhase(READY, 'start');
    expect(s.phase).toBe('countin');
    s = nextPhase(s, 'go');
    expect(s.phase).toBe('playing');
    s = nextPhase(s, 'finish');
    expect(s.phase).toBe('ended');
    expect(nextPhase(s, 'reset')).toEqual(READY);
  });

  it('pauses from count-in or play and resumes through a count-in', () => {
    expect(run(READY, 'start', 'pause').phase).toBe('paused');
    expect(run(READY, 'start', 'go', 'pause').phase).toBe('paused');
    expect(run(READY, 'start', 'go', 'pause', 'resume').phase).toBe('countin');
    expect(run(READY, 'start', 'go', 'pause', 'resume', 'go').phase).toBe('playing');
  });

  it('restarts from the pause menu and starts the next loop pass from the end card', () => {
    expect(run(READY, 'start', 'go', 'pause', 'start')).toEqual({ phase: 'countin', suspended: false });
    expect(run(READY, 'start', 'go', 'finish', 'start').phase).toBe('countin');
  });

  it('설정 바꾸기 keeps the paused run until a run setting changes', () => {
    const s = run(READY, 'start', 'go', 'pause', 'settings');
    expect(s).toEqual({ phase: 'ready', suspended: true });
    expect(nextPhase(s, 'resume').phase).toBe('countin');
    expect(nextPhase(s, 'invalidate')).toEqual(READY);
    expect(nextPhase(nextPhase(s, 'invalidate'), 'resume')).toEqual(READY); // nothing left to continue
    expect(nextPhase(s, 'start')).toEqual({ phase: 'countin', suspended: false });
  });

  it('ignores actions that do not apply', () => {
    expect(nextPhase(READY, 'pause')).toBe(READY);
    expect(nextPhase(READY, 'resume')).toBe(READY);
    expect(nextPhase(READY, 'go')).toBe(READY);
    expect(nextPhase(READY, 'finish')).toBe(READY);
    expect(nextPhase(READY, 'reset')).toBe(READY);
    const playing = run(READY, 'start', 'go');
    expect(nextPhase(playing, 'start')).toBe(playing); // no restart without pausing first
    expect(nextPhase(playing, 'settings')).toBe(playing);
    const ended = nextPhase(playing, 'finish');
    expect(nextPhase(ended, 'pause')).toBe(ended); // the end card cannot be paused
    const counting = nextPhase(READY, 'start');
    expect(nextPhase(counting, 'finish')).toBe(counting);
  });

  it('reset leaves any phase for the ready screen', () => {
    for (const s of [run(READY, 'start'), run(READY, 'start', 'go'), run(READY, 'start', 'pause'), run(READY, 'start', 'pause', 'settings')]) {
      expect(nextPhase(s, 'reset')).toEqual(READY);
    }
  });

  it('knows which phases hide the chrome and which run the clock', () => {
    expect(isFocus('ready')).toBe(false);
    expect((['countin', 'playing', 'paused', 'ended'] as const).every(isFocus)).toBe(true);
    expect(isRunning('countin') && isRunning('playing')).toBe(true);
    expect(isRunning('paused') || isRunning('ready') || isRunning('ended')).toBe(false);
  });
});

describe('AutoHide', () => {
  it('stays awake for its duration after the last poke', () => {
    const a = new AutoHide(2000);
    expect(a.awake(0)).toBe(false);
    a.poke(1000);
    expect(a.awake(1000)).toBe(true);
    expect(a.awake(2999)).toBe(true);
    expect(a.awake(3000)).toBe(false);
    a.poke(2500); // moving again extends it
    expect(a.awake(4400)).toBe(true);
    a.sleep();
    expect(a.awake(4400)).toBe(false);
  });
});

describe('resume count', () => {
  it('ticks 3-2-1 on the beat, clamped to a sane tempo', () => {
    const r = resumeSchedule(1000, 600, false);
    expect(r.ticks).toEqual([{ at: 1000, label: '3' }, { at: 1600, label: '2' }, { at: 2200, label: '1' }]);
    expect(r.end).toBe(2800);
    expect(resumeSchedule(0, 2000, false).end).toBe(2700);
    expect(resumeSchedule(0, 100, false).end).toBe(750);
  });
  it('resumes at once in wait mode', () => {
    expect(resumeSchedule(500, 600, true)).toEqual({ ticks: [], end: 500 });
  });
});

describe('announcements and key start', () => {
  it('announces only milestone combos', () => {
    const said = Array.from({ length: 400 }, (_, i) => i + 1).filter(comboMilestone);
    expect(said).toEqual([10, 25, 50, 100, 200, 300, 400]);
  });
  it('ignores keys right after the ready screen appears', () => {
    expect(keyStartAllowed(1000, 500)).toBe(false);
    expect(keyStartAllowed(1300, 500)).toBe(true);
  });
});
