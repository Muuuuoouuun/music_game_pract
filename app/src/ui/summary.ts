/** Turns a finished Session into the plain ResultData the result screen and coach read. */
import type { Session } from '../core/engine';
import type { Cell, ResultData } from '../state/records';
import { beatAt, hasPickup } from '../render/sheet-map';
import { coachLine } from './coach';

export function summarize(s: Session, opts: { songId: string; auto: boolean; example?: boolean }): ResultData {
  const chart = s.chart;
  const { hands, rate, wait, loop } = s.opts;
  const bars = chart.measures.length;
  const handsList: ('R' | 'L')[] = hands === 'B' ? ['R', 'L'] : [hands];
  const cells: ResultData['cells'] = {};
  for (const h of handsList) cells[h] = Array.from({ length: bars }, (): Cell => ({ n: 0, w: 0, errSum: 0, errN: 0, miss: 0, wrong: 0 }));
  const W: Record<string, number> = { perfect: 1, great: 0.7, good: 0.4, miss: 0, ok: 1, okw: 0 };
  for (const n of s.notes) {
    const c = cells[n.note.hand]?.[n.note.measure];
    if (!c) continue;
    c.n++;
    c.w += W[n.result ?? 'miss'];
    if (!wait && n.result && n.result !== 'miss') {
      c.errSum += n.err;
      c.errN++;
    }
    if (!n.result || n.result === 'miss') c.miss++;
  }
  for (const w of s.wrongs) {
    const h = cells.L && (w.midi < 60 || !cells.R) ? 'L' : 'R';
    const c = cells[h]?.[w.measure];
    if (c) c.wrong++;
  }
  const counts = { ...s.counts };
  const total = s.total;
  const top = wait ? counts.ok : counts.perfect;
  const R: ResultData = {
    example: !!opts.example,
    songId: opts.songId,
    title: chart.meta.title,
    hands,
    rate,
    bpm: Math.round(chart.meta.bpm * rate),
    auto: opts.auto,
    wait,
    loop: loop ? { from: loop.from, to: loop.to } : null,
    score: s.score,
    acc: s.accuracy,
    rank: s.rank,
    counts,
    total,
    maxCombo: s.maxCombo,
    errors: s.timingErrors(),
    cells,
    handsList,
    bars,
    pickup: hasPickup(chart),
    measures: s.measureAccuracy(),
    notes: s.notes.map((n) => ({ id: n.note.id, midi: n.note.midi, hand: n.note.hand, measure: n.note.measure, res: n.result ?? 'miss', err: n.err })),
    wrongs: s.wrongs.map((w) => {
      const p = beatAt(chart, rate, w.t);
      return { midi: w.midi, measure: w.measure, beat: p.measure === w.measure ? p.beat : 0 };
    }),
    fc: counts.miss === 0 && counts.wrong === 0 && s.judgedCount >= total,
    pp: top === total && counts.wrong === 0,
    coach: '',
    at: Date.now(),
  };
  R.coach = coachLine(R);
  return R;
}
