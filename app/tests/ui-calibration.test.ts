import { describe, expect, it } from 'vitest';
import { calibrate } from '../src/ui/calibration';

const beats = Array.from({ length: 8 }, (_, i) => 1000 + i * 600);

describe('calibrate', () => {
  it('returns the median lag of taps on the beats', () => {
    const lags = [42, 38, 45, 40, 39, 44, 41, 43];
    const r = calibrate(beats.map((b, i) => b + lags[i]), beats, 600);
    expect(r?.offset).toBe(42);
    expect(r?.used).toBe(8);
  });

  it('drops outliers and taps that belong to no beat', () => {
    const taps = [1000 + 30, 1600 + 25, 2200 + 180, 2800 + 28, 3400 + 32, 4000 + 300, 4600 + 27];
    const r = calibrate(taps, beats, 600);
    expect(r?.offset).toBeGreaterThanOrEqual(27);
    expect(r?.offset).toBeLessThanOrEqual(30);
    expect(r?.used).toBe(5);
  });

  it('counts only the first tap per beat and handles early taps', () => {
    const taps = [1000 - 20, 1000 - 5, 1600 - 22, 2200 - 18, 2800 - 21, 3400 - 19];
    expect(calibrate(taps, beats, 600)?.offset).toBe(-20);
  });

  it('needs enough taps', () => {
    expect(calibrate([1010, 1610], beats, 600)).toBeNull();
    expect(calibrate([], [], 600)).toBeNull();
  });
});
