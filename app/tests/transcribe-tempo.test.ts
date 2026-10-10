import { describe, expect, it } from 'vitest';
import { beatGridScore, estimateTempo, tempoPrior, type Onset } from '../src/transcribe/tempo';

/** Deterministic pseudo-random jitter (LCG) so the tests are repeatable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function train(bpm: number, count: number, opts: { div?: number; jitter?: number; start?: number; accent?: number; seed?: number; swing?: number } = {}): Onset[] {
  const P = 60000 / bpm;
  const div = opts.div ?? 1;
  const r = rng(opts.seed ?? 1);
  const out: Onset[] = [];
  for (let i = 0; i < count; i++) {
    let t = (opts.start ?? 0) + (i * P) / div;
    if (opts.swing && i % 2 === 1) t += (P / div) * opts.swing; // late off-beats
    if (opts.jitter) t += (r() * 2 - 1) * opts.jitter;
    const onBeat = i % div === 0;
    const bar = i % (div * 4) === 0;
    const v = bar ? 110 : onBeat ? 90 : 70 - (opts.accent ?? 0);
    out.push({ t, v });
  }
  return out;
}

describe('estimateTempo', () => {
  it('straight 8ths at 100 BPM → 100 (not 200 or 66.7)', () => {
    const r = estimateTempo(train(100, 64, { div: 2 }));
    expect(r.bpm).toBeGreaterThan(98);
    expect(r.bpm).toBeLessThan(102);
    expect(Math.abs(r.offsetMs)).toBeLessThan(20);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('120 BPM swing 8ths with ±20 ms jitter → 120', () => {
    const r = estimateTempo(train(120, 64, { div: 2, jitter: 20, swing: 0.33, seed: 7 }));
    expect(r.bpm).toBeGreaterThan(117);
    expect(r.bpm).toBeLessThan(123);
    expect(Math.abs(r.offsetMs)).toBeLessThan(40);
  });

  it('quarter notes at 120 with jitter → 120, offset at the first bar', () => {
    const r = estimateTempo(train(120, 32, { jitter: 15, seed: 3 }));
    expect(r.bpm).toBeGreaterThan(118);
    expect(r.bpm).toBeLessThan(122);
    expect(Math.abs(r.offsetMs)).toBeLessThan(30);
  });

  it('half-tempo trap: strong/weak alternation at 90 BPM (2-beat period) → 90, not 45', () => {
    const P = 60000 / 90;
    const onsets: Onset[] = [];
    for (let i = 0; i < 48; i++) onsets.push({ t: i * P, v: i % 2 === 0 ? 110 : 60 });
    const r = estimateTempo(onsets);
    expect(r.bpm).toBeGreaterThan(88);
    expect(r.bpm).toBeLessThan(92);
  });

  it('a slow isochronous train (60 BPM feel) is read at the doubled 120 (preferred 70–160)', () => {
    const r = estimateTempo(train(60, 24));
    expect(r.bpm).toBeGreaterThan(118);
    expect(r.bpm).toBeLessThan(122);
  });

  it('a very fast train (200 BPM 8ths = 400 onsets/min) is halved into range', () => {
    const r = estimateTempo(train(200, 80));
    expect(r.bpm).toBeGreaterThan(98);
    expect(r.bpm).toBeLessThan(102);
  });

  it('pickup: one quiet note a beat before accented bars → offset on the first accented note', () => {
    const P = 500; // 120 BPM
    const onsets: Onset[] = [{ t: 1000, v: 60 }];
    for (let i = 0; i < 32; i++) onsets.push({ t: 1500 + i * P, v: i % 4 === 0 ? 120 : 75 });
    const r = estimateTempo(onsets);
    expect(r.bpm).toBeGreaterThan(118);
    expect(r.bpm).toBeLessThan(122);
    expect(r.offsetMs).toBeGreaterThan(1470);
    expect(r.offsetMs).toBeLessThan(1530);
  });

  it('an onset slightly early for the downbeat still anchors there (no spurious pickup bar)', () => {
    const onsets = train(100, 32, { start: 2000 }).map((o, i) => (i === 0 ? { ...o, t: o.t - 40 } : o));
    const r = estimateTempo(onsets);
    expect(r.offsetMs).toBeGreaterThan(1900);
    expect(r.offsetMs).toBeLessThan(2100);
  });

  it('downbeat tie-break: equal classes pick the earliest offset', () => {
    const r = estimateTempo(train(120, 32).map((o) => ({ t: o.t, v: 80 })));
    expect(Math.abs(r.offsetMs)).toBeLessThan(20);
  });

  it('3/4: beatsPerBar 3 with accents every 3 beats finds the downbeat', () => {
    const P = 60000 / 100;
    const onsets: Onset[] = [];
    for (let i = 0; i < 36; i++) onsets.push({ t: 700 + i * P, v: i % 3 === 0 ? 120 : 70 });
    const r = estimateTempo(onsets, { beatsPerBar: 3 });
    expect(Math.round(r.bpm)).toBe(100);
    expect(Math.abs(r.offsetMs - 700)).toBeLessThan(25);
  });

  it('fixedBpm keeps the tempo and only finds the phase', () => {
    const r = estimateTempo(train(100, 32, { start: 300 }), { fixedBpm: 100 });
    expect(r.bpm).toBe(100);
    expect(Math.abs(r.offsetMs - 300)).toBeLessThan(20);
  });

  it('degenerate input falls back without throwing', () => {
    expect(estimateTempo([]).bpm).toBe(120);
    expect(estimateTempo([{ t: 100 }, { t: 400 }]).bpm).toBe(120);
    expect(estimateTempo([{ t: 100 }, { t: 400 }]).confidence).toBe(0);
  });
});

describe('beatGridScore / tempoPrior', () => {
  it('scores a perfectly aligned train 1 and a shifted one lower', () => {
    const on = train(120, 16);
    expect(beatGridScore(on, 120, 0)).toBeGreaterThan(0.99);
    expect(beatGridScore(on, 120, 60)).toBeLessThan(0.2);
    expect(beatGridScore(on, 120, 125)).toBeGreaterThan(0.99); // 16th grid still covers it
    expect(beatGridScore(on, 97, 0)).toBeLessThan(0.7);
  });

  it('prior is flat inside 70–160 and small an octave outside', () => {
    expect(tempoPrior(100)).toBeGreaterThan(0.95);
    expect(tempoPrior(35)).toBeLessThan(0.05);
    expect(tempoPrior(320)).toBeLessThan(0.05);
    expect(tempoPrior(60)).toBeLessThan(tempoPrior(70));
  });
});
