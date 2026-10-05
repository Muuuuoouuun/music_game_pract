import { describe, expect, it } from 'vitest';
import type { Chart, ChartNote } from '../src/core/chart';
import { Session, rankOf } from '../src/core/engine';

/** 2 measures of 4/4 at 120 bpm: quarter notes C D E F | G G G G, plus one left-hand C3 whole note. */
function chart(): Chart {
  const q = 500;
  const pitches = [60, 62, 64, 65, 67, 67, 67, 67];
  const notes: ChartNote[] = pitches.map((midi, i) => ({
    id: `n${i}`, midi, startMs: i * q, durationMs: q, hand: 'R', velocity: 80, measure: Math.floor(i / 4), beat: i % 4,
  }));
  notes.push({ id: 'l0', midi: 48, startMs: 0, durationMs: 4 * q, hand: 'L', velocity: 80, measure: 0, beat: 0 });
  notes.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
  return {
    schema: 'keystage.chart/v1',
    meta: { id: 't', title: 'Test', source: { kind: 'builtin' }, bpm: 120, timeSignature: [4, 4], durationMs: 4000 },
    measures: [0, 1].map((i) => ({ index: i, startMs: i * 2000, durationMs: 2000, timeSignature: [4, 4] as [number, number], bpm: 120 })),
    notes,
  };
}

describe('Session timed judgment', () => {
  it('grades by the 45/90/140 ms windows and signs the error', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    expect(s.press(60, 30)).toMatchObject({ kind: 'hit', judgment: 'perfect', err: 30 });
    expect(s.press(62, 500 - 60)).toMatchObject({ kind: 'hit', judgment: 'great', err: -60 });
    expect(s.press(64, 1000 + 120)).toMatchObject({ kind: 'hit', judgment: 'good', err: 120 });
    // 150 ms late: outside every window, F4 is the only F → wrong press
    expect(s.press(65, 1500 + 150)?.kind).toBe('wrong');
    expect(s.combo).toBe(0);
  });

  it('turns unplayed notes into misses 140 ms after their time', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    expect(s.update(140)).toHaveLength(0);
    const ev = s.update(141);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'miss' });
  });

  it('matches repeated pitches to the closest unjudged note', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    for (const [m, t] of [[60, 0], [62, 500], [64, 1000], [65, 1500]] as const) s.press(m, t);
    const e1 = s.press(67, 2500 + 10);
    expect(e1).toMatchObject({ judgment: 'perfect' });
    if (e1?.kind === 'hit') expect(e1.note.t).toBe(2500);
  });

  it('scores Σweight / notes × 1e6 and ranks by accuracy', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    const times = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500];
    const pitches = [60, 62, 64, 65, 67, 67, 67, 67];
    times.forEach((t, i) => s.press(pitches[i], i === 7 ? t + 60 : t)); // 7 perfect + 1 great
    expect(s.done).toBe(true);
    expect(s.score).toBe(Math.round(((7 + 0.7) / 8) * 1e6));
    expect(s.rank).toBe('S');
    expect(s.fullCombo).toBe(true);
    expect(s.perfectPlay).toBe(false);
    expect(rankOf(89.9)).toBe('B');
  });

  it('ignores presses before the first or after the last note', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    expect(s.press(70, -1000)).toBeNull();
    expect(s.counts.wrong).toBe(0);
  });

  it('scales times by the practice rate', () => {
    const s = new Session(chart(), { hands: 'R', rate: 0.5, wait: false });
    expect(s.notes[1].t).toBe(1000);
    expect(s.press(62, 1000)).toMatchObject({ judgment: 'perfect' });
  });

  it('filters by hand and by A–B loop', () => {
    expect(new Session(chart(), { hands: 'L', rate: 1, wait: false }).total).toBe(1);
    expect(new Session(chart(), { hands: 'B', rate: 1, wait: false }).total).toBe(9);
    const loop = new Session(chart(), { hands: 'R', rate: 1, wait: false, loop: { from: 1, to: 1 } });
    expect(loop.total).toBe(4);
    expect(loop.startT).toBe(2000);
    expect(loop.endT).toBe(4000);
  });
});

describe('Session wait mode', () => {
  it('holds at the gate, counts a first-try hit as ok and a retry as okw', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: true });
    expect(s.gate).toBe(0);
    expect(s.press(60, 0)).toMatchObject({ judgment: 'ok' });
    expect(s.gate).toBe(500);
    expect(s.press(64, 500)?.kind).toBe('wrong');
    expect(s.press(62, 900)).toMatchObject({ judgment: 'okw' });
    expect(s.gate).toBe(1000);
    expect(s.update(99999)).toHaveLength(0); // no misses in wait mode
  });

  it('needs every note of a chord before moving on', () => {
    const s = new Session(chart(), { hands: 'B', rate: 1, wait: true });
    expect(s.gateNotes().map((n) => n.note.midi)).toEqual([48, 60]);
    s.press(60, 0);
    expect(s.gate).toBe(0);
    s.press(48, 0);
    expect(s.gate).toBe(500);
  });
});

describe('Session summaries', () => {
  it('reports per-measure accuracy and timing errors', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    s.press(60, -20);
    s.press(62, 520);
    s.update(10_000);
    const acc = s.measureAccuracy();
    expect(acc[0]).toBeCloseTo(0.5);
    expect(acc[1]).toBe(0);
    expect(s.timingErrors()).toEqual([-20, 20]);
  });
});
