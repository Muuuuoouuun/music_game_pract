/**
 * AI coach text, ported from the mockup: a live one-liner under the stage while playing,
 * a summary line on the result screen and a checklist of practice recommendations.
 * Pure functions over plain data so the rules can be tested.
 */
import type { HandMode, Judgment } from '../core/engine';
import type { PlanItem, ResultData } from '../state/records';
import { HANDS_KO } from '../state/settings';
import { avg, barNo, keyHint, nKo, signed } from './format';

export interface LiveCoachInput {
  mode: 'attract' | 'play';
  paused: boolean;
  wait: boolean;
  /** Wait mode: notes the gate is waiting for. */
  gateNotes: { midi: number; measure: number }[];
  /** Before the first downbeat of a real play: where it starts. */
  preStart: { measure: number; midi: number } | null;
  /** Judged notes in the current and previous measure, in judgment order. */
  recent: { res: Judgment; measure: number; midi: number; err: number }[];
  /** Most recent wrong press within the last few seconds. */
  lastWrong: { midi: number; measure: number; intended: number | null } | null;
  combo: number;
  /** Timing errors of every hit so far (timed mode). */
  hitErrors: number[];
  /** The chart opens with a pickup bar (affects bar numbers). */
  pickup?: boolean;
}

export function liveCoach(c: LiveCoachInput): string {
  const pre = c.mode === 'attract' ? '(데모) ' : '';
  const bar = (m: number) => barNo(m, c.pickup);
  if (c.mode === 'play' && c.paused) return '일시정지 중이에요. 계속하기를 누르거나 Esc로 이어서 쳐요.';
  if (c.wait && c.gateNotes.length) {
    const ns = c.gateNotes;
    return (
      pre +
      `${bar(ns[0].measure)}마디 ${ns.map((n) => nKo(n.midi) + '음').join(' + ')} 차례예요. ` +
      `${ns.map((n) => keyHint(n.midi)).join(', ')}를 누르면 다음 음으로 넘어가요.`
    );
  }
  if (c.mode === 'play' && c.preStart) {
    return `${bar(c.preStart.measure)}마디부터 시작해요. 첫 음은 ${nKo(c.preStart.midi)}음, ${keyHint(c.preStart.midi)}예요.`;
  }
  const wr = c.lastWrong;
  if (wr && wr.intended != null && wr.intended !== wr.midi) {
    return pre + `방금 ${bar(wr.measure)}마디에서 ${nKo(wr.intended)}음 대신 ${nKo(wr.midi)}음을 눌렀어요. 악보의 빨간 점선 음표가 실제로 친 음이에요.`;
  }
  const miss = [...c.recent].reverse().find((n) => n.res === 'miss');
  if (miss) return pre + `${bar(miss.measure)}마디 ${nKo(miss.midi)}음을 놓쳤어요. A–B 구간 반복으로 이 마디만 따로 연습해 보세요.`;
  if (!c.wait) {
    const groups = new Map<string, { m: number; midi: number; e: number[] }>();
    for (const n of c.recent) {
      if (n.res === 'miss') continue;
      const k = n.measure + '_' + n.midi;
      const g = groups.get(k) ?? { m: n.measure, midi: n.midi, e: [] };
      g.e.push(n.err);
      groups.set(k, g);
    }
    let worst: { m: number; midi: number; e: number[]; mean: number } | null = null;
    for (const g of groups.values()) {
      const mean = avg(g.e);
      if (Math.abs(mean) >= 35 && (!worst || Math.abs(mean) > Math.abs(worst.mean))) worst = { ...g, mean };
    }
    if (worst) {
      return (
        pre +
        `방금 ${bar(worst.m)}마디 ${nKo(worst.midi)}음을 ${worst.e.length > 1 ? '평균 ' : ''}${Math.round(Math.abs(worst.mean))}ms ` +
        `${worst.mean < 0 ? '빨리' : '늦게'} 쳤어요. ${worst.mean < 0 ? '건반을 끝까지 기다렸다 눌러 보세요.' : '박을 속으로 세며 미리 손을 올려 두세요.'}`
      );
    }
    if (c.hitErrors.length >= 8) {
      const mean = avg(c.hitErrors);
      if (Math.abs(mean) >= 30) {
        const r5 = Math.round(mean / 5) * 5;
        return pre + `전체적으로 평균 ${Math.round(Math.abs(mean))}ms ${mean > 0 ? '늦어요' : '빨라요'}. 건반이나 스피커 지연 때문이라면 지연 보정을 ${r5 > 0 ? '+' : ''}${r5}ms로 맞춰 보세요.`;
      }
    }
  }
  if (c.combo >= 8) return pre + `${c.combo}음 연속으로 정확해요. 손목 힘을 빼고 이 흐름 그대로 가요.`;
  if (c.mode === 'attract') return '데모 연주 중이에요. 직접 플레이를 누르면 4박 카운트 뒤에 내 연주를 악보와 하이웨이에서 함께 채점해요.';
  return '좋아요. 다음 마디를 악보에서 미리 눈으로 읽어 두세요.';
}

/** One-line verdict for the result screen. */
export function coachLine(R: ResultData): string {
  const handName = (h: HandMode) => HANDS_KO[h];
  const bar = (m: number) => barNo(m, R.pickup);
  if (R.pp) {
    return (
      '흠잡을 데 없는 연주예요. ' +
      (R.wait ? '이제 대기 모드를 끄고 템포 75%로 쳐 보세요.' : R.hands === 'R' ? '다음엔 양손 모드에 도전해 보세요.' : R.rate < 1 ? '이제 템포 100%로 올려 보세요.' : '같은 감각으로 다른 곡에도 도전해 보세요.')
    );
  }
  if (R.wait) {
    return R.counts.wrong
      ? `틀린 건반을 ${R.counts.wrong}번 눌렀고, ${R.counts.okw}음은 다시 쳐서 찾았어요. 같은 구간을 대기 모드로 한 번 더 익혀 보세요.`
      : '모든 음을 한 번에 찾았어요. 이제 대기 모드를 끄고 템포 75%로 쳐 보세요.';
  }
  let worst: { h: 'R' | 'L'; i: number; avg: number; trouble: number; miss: number; wrong: number } | null = null;
  for (const h of R.handsList) {
    (R.cells[h] ?? []).forEach((c, i) => {
      const a = c.errN ? c.errSum / c.errN : 0;
      const trouble = Math.abs(a) + 70 * c.miss + 35 * c.wrong;
      if (!worst || trouble > worst.trouble) worst = { h, i, avg: a, trouble, miss: c.miss, wrong: c.wrong };
    });
  }
  const slowBpm = Math.max(40, Math.round((R.bpm * 0.8) / 5) * 5);
  const w = worst as { h: 'R' | 'L'; i: number; avg: number; trouble: number; miss: number; wrong: number } | null;
  if (w && w.trouble >= 30) {
    const a = w.avg;
    if (Math.abs(a) >= 30 && Math.abs(a) >= 70 * w.miss) {
      return `${bar(w.i)}마디 ${handName(w.h)}이 평균 ${Math.round(Math.abs(a))}ms ${a > 0 ? '늦어요' : '빨라요'}. BPM ${slowBpm}으로 낮춰 3번 연습해 보세요.`;
    }
    if (w.miss) return `${bar(w.i)}마디 ${handName(w.h)}에서 ${w.miss}개를 놓쳤어요. 템포 75%로 그 마디만 3번 반복해 보세요.`;
    if (w.wrong) return `${bar(w.i)}마디에서 다른 건반을 ${w.wrong}번 눌렀어요. 다음 음 자리에 손가락을 미리 올려 두세요.`;
  }
  const mean = avg(R.errors);
  if (Math.abs(mean) >= 18) {
    return `전체적으로 평균 ${Math.round(Math.abs(mean))}ms ${mean > 0 ? '늦게' : '빠르게'} 치고 있어요. 지연 보정을 ${signed(Math.round(mean))}ms로 맞춰 보세요.`;
  }
  return '타이밍이 고르게 안정적이에요. ' + (R.hands === 'R' ? '양손 모드로 넘어가 볼 때예요.' : '템포를 올리거나 다른 곡에 도전해 보세요.');
}

export interface Rec {
  text: string;
  act: string;
  plan?: Omit<PlanItem, 'id'>;
  /** Suggested latency offset (ms) instead of a plan item. */
  offset?: number;
}

/** Practice checklist for the result screen (up to four items). */
export function coachRecs(R: ResultData): Rec[] {
  const recs: Rec[] = [];
  const hk = (h: HandMode) => HANDS_KO[h];
  const bar = (m: number) => barNo(m, R.pickup);
  const songId = R.songId;
  const groups = new Map<string, { m: number; hand: 'R' | 'L'; e: number[] }>();
  if (!R.wait) {
    for (const n of R.notes) {
      if (n.res === 'miss') continue;
      const k = n.measure + n.hand;
      const g = groups.get(k) ?? { m: n.measure, hand: n.hand, e: [] };
      g.e.push(n.err);
      groups.set(k, g);
    }
  }
  let worst: { m: number; hand: 'R' | 'L'; mean: number } | null = null;
  for (const g of groups.values()) {
    const mean = avg(g.e);
    if (g.e.length >= 1 && Math.abs(mean) >= 35 && (!worst || Math.abs(mean) > Math.abs(worst.mean))) worst = { m: g.m, hand: g.hand, mean };
  }
  if (worst) {
    const a = bar(worst.m);
    const ms = Math.round(Math.abs(worst.mean));
    recs.push({
      text: `${a}마디 ${hk(worst.hand)}이 평균 ${ms}ms ${worst.mean > 0 ? '늦어요' : '빨라요'}.`,
      act: `템포 75%로 낮춰 ${a}마디만 3번 연습해 보세요.`,
      plan: { songId, title: `${a}마디 ${hk(worst.hand)} ×3`, sub: '템포 75% · A–B 반복', loop: { from: worst.m, to: worst.m }, hands: worst.hand, rate: 0.75 },
    });
  }
  const ms = R.measures
    .map((x, i) => (x != null ? { acc: x, i } : null))
    .filter((x): x is { acc: number; i: number } => !!x)
    .sort((a, b) => a.acc - b.acc);
  const weak = ms.find((x) => x.acc < 0.95 && (!worst || x.i !== worst.m));
  if (weak) {
    // pair bars as engraved (1–2, 3–4, …), then back to measure indices
    const shift = R.pickup ? 0 : 1;
    const d = weak.i + shift;
    const from = Math.max(0, (d % 2 === 0 ? d - 1 : d) - shift);
    const to = Math.min(R.bars - 1, from + 1);
    const range = `${bar(from)}–${bar(to)}`;
    recs.push({
      text: `${bar(weak.i)}마디 정확도가 ${Math.round(weak.acc * 100)}%예요.`,
      act: `${range}마디를 A–B 반복으로 3번 쳐 보세요.`,
      plan: { songId, title: `${range}마디 ${hk(R.hands)} ×3`, sub: '템포 75% · A–B 반복', loop: { from, to }, hands: R.hands, rate: 0.75 },
    });
  }
  if (R.counts.wrong >= 2) {
    recs.push({
      text: `틀린 건반을 ${R.counts.wrong}번 눌렀어요.`,
      act: '대기 모드로 음 위치부터 익혀 보세요.',
      plan: { songId, title: `전곡 ${hk(R.hands)} 대기 모드`, sub: '정답 건반을 칠 때까지 기다리기', hands: R.hands, rate: 1, wait: true },
    });
  }
  if (R.errors.length >= 8) {
    const mean = avg(R.errors);
    if (Math.abs(mean) >= 25) {
      const r5 = Math.round(mean / 5) * 5;
      recs.push({
        text: `전체적으로 평균 ${Math.round(Math.abs(mean))}ms ${mean > 0 ? '늦게' : '빨리'} 쳤어요.`,
        act: `기기 지연 때문이라면 지연 보정을 ${r5 > 0 ? '+' : ''}${r5}ms 더 옮겨 보세요.`,
        offset: r5,
      });
    }
  }
  if (R.acc >= 90) {
    recs.push({
      text: '이번 연주는 안정적이에요.',
      act: R.hands === 'B' ? '템포 100%로 전곡에 도전해 보세요.' : '다음 단계로 양손을 템포 50%부터 시작해 보세요.',
      plan:
        R.hands === 'B'
          ? { songId, title: '전곡 도전', sub: `양손 · BPM ${Math.round(R.bpm / R.rate)}`, hands: 'B', rate: 1 }
          : { songId, title: '양손 템포 50%', sub: '전곡 · 대기 모드', hands: 'B', rate: 0.5, wait: true },
    });
  }
  if (!recs.length) {
    recs.push({ text: '모든 마디가 고르게 정확해요.', act: '템포를 한 단계 올려 보세요.', plan: { songId, title: '전곡 템포 100%', sub: HANDS_KO[R.hands], hands: R.hands, rate: 1 } });
  }
  return recs.slice(0, 4);
}
