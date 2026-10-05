import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/core/chart';
import { beatAt, diatonic, hasPickup, isSharp, matchNotes, staffOffset, xAtBeat } from '../src/render/sheet-map';
import { barNo } from '../src/ui/format';

describe('matchNotes', () => {
  it('pairs by measure, beat and pitch, including chords and repeated pitches', () => {
    const chart = [
      { measure: 0, beat: 0, midi: 60 },
      { measure: 0, beat: 0, midi: 64 },
      { measure: 0, beat: 1, midi: 64 },
      { measure: 1, beat: 0.5, midi: 62 },
    ];
    const engraved = [
      { measure: 0, beat: 1, midi: 64 }, // 0
      { measure: 0, beat: 0, midi: 64 }, // 1
      { measure: 0, beat: 0, midi: 60 }, // 2
      { measure: 1, beat: 0.5, midi: 62 }, // 3
      { measure: 1, beat: 2, midi: 62 }, // 4 tie continuation, not in the chart
    ];
    const m = matchNotes(chart, engraved);
    expect([...m.entries()].sort()).toEqual([
      [0, 2],
      [1, 1],
      [2, 0],
      [3, 3],
    ]);
  });

  it('falls back to the nearest beat for rounding differences but never across measures', () => {
    const m = matchNotes(
      [{ measure: 2, beat: 1.333, midi: 67 }, { measure: 3, beat: 0, midi: 67 }],
      [{ measure: 2, beat: 1.3333333, midi: 67 }, { measure: 2, beat: 3, midi: 67 }],
    );
    expect(m.get(0)).toBe(0);
    expect(m.has(1)).toBe(false);
  });
});

describe('xAtBeat', () => {
  const span = { x0: 100, x1: 300, quarters: 4, points: [{ beat: 0, x: 110 }, { beat: 2, x: 200 }, { beat: 2, x: 202 }] };
  it('interpolates between engraved onsets and the closing barline', () => {
    expect(xAtBeat(span, 0)).toBe(110);
    expect(xAtBeat(span, 1)).toBe(155);
    expect(xAtBeat(span, 2)).toBe(200);
    expect(xAtBeat(span, 3)).toBe(250);
    expect(xAtBeat(span, 9)).toBe(300);
  });
  it('starts from the measure start when the first onset is later (rest)', () => {
    expect(xAtBeat({ x0: 0, x1: 100, quarters: 4, points: [{ beat: 2, x: 60 }] }, 1)).toBe(30);
  });
});

describe('beatAt', () => {
  const chart = {
    measures: [
      { index: 0, startMs: 0, durationMs: 2000, timeSignature: [4, 4], bpm: 120 },
      { index: 1, startMs: 2000, durationMs: 1500, timeSignature: [6, 8], bpm: 120 },
    ],
  } as unknown as Chart;
  it('converts session time at a rate into measure + quarter beat', () => {
    expect(beatAt(chart, 1, 1000)).toEqual({ measure: 0, beat: 2 });
    expect(beatAt(chart, 0.5, 5500)).toEqual({ measure: 1, beat: 1.5 }); // 2750 ms chart time, 6/8 = 3 quarters
  });
});

describe('staff placement', () => {
  it('puts C4 on the first ledger line below the treble staff and above the bass staff', () => {
    expect(staffOffset(diatonic(60), 'G')).toBe(5);
    expect(staffOffset(diatonic(60), 'F')).toBe(-1);
    expect(staffOffset(diatonic(77), 'G')).toBe(0); // F5 = top line
    expect(isSharp(61)).toBe(true);
    expect(isSharp(64)).toBe(false);
  });
});

describe('pickup bar numbering', () => {
  const mk = (first: number) =>
    ({
      meta: { bpm: 120 },
      measures: [
        { index: 0, startMs: 0, durationMs: first, timeSignature: [3, 8], bpm: 120 },
        { index: 1, startMs: first, durationMs: 750, timeSignature: [3, 8], bpm: 120 },
      ],
    }) as unknown as Chart;
  it('detects an anacrusis and numbers bars as engraved', () => {
    expect(hasPickup(mk(250))).toBe(true); // one eighth of a 3/8 bar
    expect(hasPickup(mk(750))).toBe(false);
    expect(barNo(0, true)).toBe('못갖춘');
    expect(barNo(1, true)).toBe('1');
    expect(barNo(0, false)).toBe('1');
  });
});
