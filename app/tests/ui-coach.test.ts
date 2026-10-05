import { describe, expect, it } from 'vitest';
import type { Chart, ChartNote } from '../src/core/chart';
import { Session } from '../src/core/engine';
import { coachLine, coachRecs, liveCoach, type LiveCoachInput } from '../src/ui/coach';
import { summarize } from '../src/ui/summary';

const base: LiveCoachInput = {
  mode: 'play', paused: false, wait: false, gateNotes: [], preStart: null, recent: [], lastWrong: null, combo: 0, hitErrors: [],
};

describe('liveCoach', () => {
  it('explains pause, wait-mode targets and the first note', () => {
    expect(liveCoach({ ...base, paused: true })).toContain('일시정지');
    const w = liveCoach({ ...base, wait: true, gateNotes: [{ midi: 64, measure: 2 }] });
    expect(w).toContain('3마디 E(미)음');
    expect(w).toContain('PC 키 D');
    expect(liveCoach({ ...base, preStart: { measure: 0, midi: 60 } })).toBe('1마디부터 시작해요. 첫 음은 C(도)음, PC 키 A예요.');
  });

  it('prefers a fresh wrong key, then a miss, then a timing drift', () => {
    const wrong = liveCoach({ ...base, lastWrong: { midi: 62, measure: 1, intended: 60 }, recent: [{ res: 'miss', measure: 1, midi: 64, err: 0 }] });
    expect(wrong).toContain('C(도)음 대신 D(레)음');
    expect(liveCoach({ ...base, recent: [{ res: 'miss', measure: 1, midi: 64, err: 0 }] })).toContain('2마디 E(미)음을 놓쳤어요');
    const late = liveCoach({ ...base, recent: [{ res: 'good', measure: 3, midi: 67, err: 110 }, { res: 'perfect', measure: 3, midi: 65, err: 5 }] });
    expect(late).toContain('4마디 G(솔)음을 110ms 늦게');
  });

  it('suggests a latency offset for a steady global lag and cheers long combos', () => {
    const lag = liveCoach({ ...base, hitErrors: Array(10).fill(42) });
    expect(lag).toContain('+40ms');
    expect(liveCoach({ ...base, combo: 12 })).toContain('12음 연속');
    expect(liveCoach({ ...base, mode: 'attract' })).toContain('데모 연주 중');
  });
});

function chart(): Chart {
  const pitches = [60, 62, 64, 65, 67, 65, 64, 62];
  const notes: ChartNote[] = pitches.map((midi, i) => ({
    id: 'n' + i, midi, startMs: i * 500, durationMs: 500, hand: 'R', velocity: 80, measure: Math.floor(i / 4), beat: i % 4,
  }));
  return {
    schema: 'keystage.chart/v1',
    meta: { id: 't', title: 'T', source: { kind: 'builtin' }, bpm: 120, timeSignature: [4, 4], durationMs: 4000 },
    measures: [0, 1].map((i) => ({ index: i, startMs: i * 2000, durationMs: 2000, timeSignature: [4, 4] as [number, number], bpm: 120 })),
    notes,
  };
}

describe('result coach', () => {
  it('names the dragging measure and recommends a slow A–B loop of it', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    s.notes.forEach((n) => s.press(n.note.midi, n.t + (n.note.measure === 1 ? 80 : 0)));
    const R = summarize(s, { songId: 't', auto: false });
    expect(R.coach).toBe('2마디 오른손이 평균 80ms 늦어요. BPM 95으로 낮춰 3번 연습해 보세요.');
    const recs = coachRecs(R);
    expect(recs[0].plan).toMatchObject({ songId: 't', loop: { from: 1, to: 1 }, hands: 'R', rate: 0.75 });
  });

  it('reports wait-mode retries and a perfect run', () => {
    const s = new Session(chart(), { hands: 'R', rate: 1, wait: true });
    s.press(61, 0);
    s.notes.forEach((n) => s.press(n.note.midi, n.t));
    const R = summarize(s, { songId: 't', auto: false });
    expect(R.counts).toMatchObject({ ok: 7, okw: 1, wrong: 1 });
    expect(coachLine(R)).toContain('틀린 건반을 1번');
    const p = new Session(chart(), { hands: 'R', rate: 1, wait: false });
    p.notes.forEach((n) => p.press(n.note.midi, n.t));
    const P = summarize(p, { songId: 't', auto: false });
    expect(P.pp).toBe(true);
    expect(P.coach).toContain('흠잡을 데 없는 연주');
    expect(P.wrongs).toEqual([]);
  });
});
