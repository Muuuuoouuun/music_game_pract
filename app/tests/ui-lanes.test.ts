import { describe, expect, it } from 'vitest';
import { isBlackKey } from '../src/core/chart';
import { fitKeyRange, laneLayout } from '../src/render/lanes';

const whites = ([lo, hi]: [number, number]) => {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (!isBlackKey(m)) n++;
  return n;
};

describe('fitKeyRange', () => {
  it('rounds out to C … E like the mockup right-hand range', () => {
    expect(fitKeyRange([60, 62, 64, 65, 67])).toEqual([60, 76]); // C4–G4 → C4–E5 (10 whites)
  });

  it('rounds the top up to the nearest E or B', () => {
    expect(fitKeyRange([48, 55, 60, 79])).toEqual([48, 83]); // G5 → B5
    expect(fitKeyRange([50, 75])).toEqual([48, 76]); // D#5 → E5
  });

  it('keeps at least ten white keys', () => {
    const r = fitKeyRange([60]);
    expect(whites(r)).toBeGreaterThanOrEqual(10);
    expect(r[0]).toBe(60);
  });

  it('defaults to C4–E5 for an empty chart and clamps to the piano', () => {
    expect(fitKeyRange([])).toEqual([60, 76]);
    const r = fitKeyRange([21, 108]);
    expect(r[0]).toBeGreaterThanOrEqual(21);
    expect(r[1]).toBeLessThanOrEqual(108);
  });
});

describe('laneLayout', () => {
  it('spreads white keys evenly and centres black keys on the gaps', () => {
    const L = laneLayout(60, 76);
    expect(L.whites).toBe(10);
    expect(L.lane[60]).toMatchObject({ l: 0, w: 0.1, b: false });
    expect(L.lane[61].b).toBe(true);
    expect(L.lane[61].l + L.lane[61].w / 2).toBeCloseTo(0.1);
  });
});
