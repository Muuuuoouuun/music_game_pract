import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/core/chart';
import { SongClock, beatGrid, countInBeatMs } from '../src/ui/clock';

function chart(): Chart {
  return {
    schema: 'keystage.chart/v1',
    meta: { id: 't', title: 'T', source: { kind: 'builtin' }, bpm: 120, timeSignature: [4, 4], durationMs: 3500 },
    measures: [
      { index: 0, startMs: 0, durationMs: 2000, timeSignature: [4, 4], bpm: 120 },
      { index: 1, startMs: 2000, durationMs: 1500, timeSignature: [3, 4], bpm: 120 },
    ],
    notes: [],
  };
}

describe('SongClock', () => {
  it('runs from a start time, pauses and resumes without losing song time', () => {
    let now = 1000;
    const c = new SongClock(() => now);
    c.start(-2000); // count-in
    expect(c.time()).toBe(-2000);
    now += 500;
    expect(c.time()).toBe(-1500);
    c.pause();
    now += 10_000;
    expect(c.time()).toBe(-1500);
    expect(c.resume()).toBe(10_000);
    now += 100;
    expect(c.time()).toBe(-1400);
  });

  it('holds at a wait-mode gate', () => {
    let now = 0;
    const c = new SongClock(() => now);
    c.start(0);
    now = 400;
    expect(c.hold(500)).toBe(false);
    now = 900;
    expect(c.hold(500)).toBe(true);
    expect(c.time()).toBe(500);
    now = 1500;
    expect(c.hold(500)).toBe(true);
    expect(c.time()).toBe(500);
    now = 1600; // gate opened: the clock moves on from the gate, not from where it would have been
    expect(c.hold(null)).toBe(false);
    expect(c.time()).toBe(600);
  });

  it('maps input event stamps to song time with the latency offset removed', () => {
    let now = 5000;
    const c = new SongClock(() => now);
    c.start(0);
    expect(c.inputTime(5250, 30)).toBe(220);
    now = 6000;
    expect(c.inputTime(5990, 0)).toBe(990);
  });
});

describe('beat grid and count-in', () => {
  it('uses the first measure tempo scaled by rate for the count-in', () => {
    expect(countInBeatMs(chart(), 1)).toBe(500);
    expect(countInBeatMs(chart(), 0.5)).toBe(1000);
  });

  it('splits measures by their time signature and prepends four count-in beats', () => {
    const g = beatGrid(chart(), 1, 0);
    expect(g.slice(0, 4).map((b) => b.t)).toEqual([-2000, -1500, -1000, -500]);
    expect(g[0].bar).toBe(true);
    const song = g.slice(4);
    expect(song.map((b) => b.t)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000]);
    expect(song.filter((b) => b.bar).map((b) => b.measure)).toEqual([0, 1]);
  });

  it('starts at a loop measure and stretches with the rate', () => {
    const g = beatGrid(chart(), 0.5, 4000);
    expect(g[0].t).toBe(4000 - 4 * 1000);
    expect(g[4]).toMatchObject({ t: 4000, bar: true, measure: 1 });
  });
});
