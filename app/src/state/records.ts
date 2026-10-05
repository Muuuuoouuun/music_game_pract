/** Best scores, today's practice plan and the last result, persisted per browser. */
import type { HandMode, Judgment, Rank } from '../core/engine';
import { Emitter, load, save } from './store';

export interface Cell {
  n: number;
  w: number;
  errSum: number;
  errN: number;
  miss: number;
  wrong: number;
}

/** Everything the result screen and AI coach need, detached from the live Session. */
export interface ResultData {
  example: boolean;
  songId: string;
  title: string;
  hands: HandMode;
  rate: number;
  /** Displayed tempo (first measure bpm × rate). */
  bpm: number;
  auto: boolean;
  wait: boolean;
  /** 0-based inclusive loop range, or null for the whole song. */
  loop: { from: number; to: number } | null;
  score: number;
  acc: number;
  rank: Rank;
  counts: Record<Judgment | 'wrong', number>;
  total: number;
  maxCombo: number;
  errors: number[];
  cells: Partial<Record<'R' | 'L', Cell[]>>;
  handsList: ('R' | 'L')[];
  bars: number;
  /** First measure is an anacrusis (bar numbers start after it). */
  pickup?: boolean;
  measures: (number | null)[];
  notes: { id: string; midi: number; hand: 'R' | 'L'; measure: number; res: Judgment; err: number }[];
  /** Wrong presses placed on the sheet: measure + beat (quarters inside the measure). */
  wrongs: { midi: number; measure: number; beat: number }[];
  fc: boolean;
  pp: boolean;
  coach: string;
  at: number;
}

export interface BestRecord {
  score: number;
  rank: Rank;
  acc: number;
  rate: number;
  at: number;
}

export interface PlanItem {
  id: string;
  songId: string | null;
  title: string;
  sub: string;
  hands: HandMode;
  rate: number;
  wait?: boolean;
  loop?: { from: number; to: number };
  isNew?: boolean;
}

export const recordsChanged = new Emitter<void>();

type BestMap = Record<string, BestRecord>;
const best: BestMap = load<BestMap>('best', {});

export function getBest(songId: string, hands: HandMode): BestRecord | null {
  return best[`${songId}|${hands}`] ?? null;
}

/** Saves the record if it beats the previous one; returns true when it did. */
export function submitBest(r: ResultData): boolean {
  if (r.example || r.auto || r.loop) return false;
  const key = `${r.songId}|${r.hands}`;
  const old = best[key];
  if (old && old.score >= r.score) return false;
  best[key] = { score: r.score, rank: r.rank, acc: r.acc, rate: r.rate, at: r.at };
  save('best', best);
  recordsChanged.emit();
  return true;
}

export function forgetSong(songId: string): void {
  for (const k of Object.keys(best)) if (k.startsWith(songId + '|')) delete best[k];
  save('best', best);
  plan.splice(0, plan.length, ...plan.filter((p) => p.songId !== songId));
  save('plan', plan);
  recordsChanged.emit();
}

export const plan: PlanItem[] = load<PlanItem[] | null>('plan', null) ?? [];
let planSeeded = load<boolean>('planSeeded', false);

/** First visit: a starter plan for the first built-in song, like the mockup's. */
export function seedPlan(songId: string): void {
  if (planSeeded) return;
  planSeeded = true;
  save('planSeeded', true);
  if (plan.length) return;
  plan.push(
    { id: 'p1', songId, title: '5–8마디 오른손 ×3', sub: '템포 75% · A–B 반복', hands: 'R', rate: 0.75, loop: { from: 4, to: 7 } },
    { id: 'p2', songId, title: '왼손만 템포 75%', sub: '전곡 · 메트로놈 켬', hands: 'L', rate: 0.75 },
    { id: 'p3', songId, title: '양손 템포 50%', sub: '전곡 · 대기 모드', hands: 'B', rate: 0.5, wait: true },
  );
  save('plan', plan);
}

export function addPlan(items: Omit<PlanItem, 'id'>[]): void {
  for (const it of items) plan.push({ ...it, id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), isNew: true });
  save('plan', plan);
  recordsChanged.emit();
}

export function removePlan(id: string): void {
  const i = plan.findIndex((p) => p.id === id);
  if (i >= 0) plan.splice(i, 1);
  save('plan', plan);
  recordsChanged.emit();
}

export function loadLastResult(): ResultData | null {
  return load<ResultData | null>('lastResult', null);
}
export function saveLastResult(r: ResultData): void {
  save('lastResult', r);
}
