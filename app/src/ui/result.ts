/**
 * Result: rank reveal + stamp, judgment bars, timing histogram, per-measure accuracy
 * (heat strip + tinted sheet with judged noteheads and wrong-key ghosts), AI coach line
 * and a recommendation checklist that feeds 오늘의 연습.
 */
import type { Chart } from '../core/chart';
import { Session } from '../core/engine';
import { SheetView } from '../render/sheet';
import { getSong, songs } from '../state/library';
import { addPlan, type PlanItem, type ResultData } from '../state/records';
import { HANDS_KO, OFFSET_MAX, OFFSET_MIN, settings, updateSettings } from '../state/settings';
import { coachRecs, type Rec } from './coach';
import { mulberry32 } from './demo';
import { $, $$, ICON, esc, reducedMotion, restartAnim, toast } from './dom';
import { avg, barNo, clamp, commas, signed } from './format';
import { summarize } from './summary';

const JUDGES = {
  normal: [['perfect', 'PERFECT'], ['great', 'GREAT'], ['good', 'GOOD'], ['miss', 'MISS'], ['wrong', 'WRONG']],
  wait: [['ok', '정답'], ['okw', '다시 쳐서'], ['wrong', '틀린 건반']],
} as const;
const heat = (a: number) => `color-mix(in oklab, var(--j-great) ${Math.round(clamp((a - 0.6) / 0.4, 0, 1) * 100)}%, var(--j-wrong))`;

export interface ResultDeps {
  /** 다시 하기: same settings, straight to the count-in. */
  retry(r: ResultData): void;
  /** 설정 바꿔 다시: the ready card with this run's settings. */
  adjust(r: ResultData): void;
  /** 다음 곡: the ready card of the next song on the shelf. */
  next(r: ResultData): void;
  startPlan(p: Omit<PlanItem, 'id'>): void;
  offsetChanged(): void;
}

/** A believable two-hand run on a chart, pushed through the real engine (first visit). */
export function exampleResult(chart: Chart, songId: string): ResultData {
  const s = new Session(chart, { hands: 'B', rate: 1, wait: false });
  const rnd = mulberry32(20261005);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.15;
  const bars = chart.measures.length;
  const drag = Math.max(0, Math.floor(bars * 0.75) - 1);
  const rNotes = s.notes.filter((n) => n.note.hand === 'R');
  const missed = rNotes[Math.floor(rNotes.length * 0.55)];
  const presses: { midi: number; t: number }[] = [];
  for (const n of s.notes) {
    if (n === missed) continue;
    let err = gauss() * 26 + 6;
    if (n.note.measure === drag) err = n.note.hand === 'L' ? 82 : err + 22;
    presses.push({ midi: n.note.midi, t: n.t + err });
  }
  for (const frac of [0.3, 0.8]) {
    const n = s.notes[Math.floor(s.notes.length * frac)];
    if (n) presses.push({ midi: n.note.midi + (frac < 0.5 ? 2 : -3), t: n.t + 240 });
  }
  presses.sort((a, b) => a.t - b.t).forEach((p) => s.press(p.midi, p.t));
  s.update(Infinity);
  return summarize(s, { songId, auto: false, example: true });
}

export class ResultScreen {
  private root: HTMLElement;
  private deps: ResultDeps;
  private sheet: SheetView | null = null;
  private shown: ResultData | null = null;
  private recs: (Rec & { added?: boolean })[] = [];
  private chartFor: string | null = null;

  constructor(root: HTMLElement, deps: ResultDeps) {
    this.root = root;
    this.deps = deps;
  }

  mount(): void {
    this.root.innerHTML = `
    <div class="wrap">
      <div class="res-head">
        <div><p class="eyebrow">RESULT</p><h1 class="h-disp" id="resTitle">결과</h1><p class="res-meta" id="resMeta"></p></div>
        <span class="tag-ex" id="resExample">예시 결과 · 아직 플레이 기록이 없어요</span>
      </div>
      <div class="res-grid">
        <div class="panel rank-card">
          <div class="rank-stage"><span class="rank" id="rank" data-r="A">A</span><span class="stamp" id="stamp" data-k="clear">CLEAR</span></div>
          <dl class="res-nums">
            <div><dt>점수</dt><dd class="big-score" id="resScore">0</dd></div>
            <div><dt>정확도</dt><dd id="resAcc">0%</dd></div>
            <div><dt>최대 콤보</dt><dd id="resCombo">0</dd></div>
          </dl>
        </div>
        <div class="panel p-jb"><h2>판정</h2><div id="jbars"></div></div>
        <div class="panel p-hist"><h2>타이밍 분포</h2><div id="histBox"></div><p class="hist-note" id="histNote"></p></div>
        <div class="panel p-sheet">
          <div class="ph2"><h2>마디별 정확도 · 악보</h2>
            <div class="sh-legend"><span><i class="lg-scale"></i>60% 이하 → 100%</span><span><i class="lg-dot" style="--c:var(--j-perfect)"></i>Perfect</span><span><i class="lg-dot" style="--c:var(--j-great)"></i>Great</span><span><i class="lg-dot" style="--c:var(--j-good)"></i>Good</span><span><i class="lg-dot" style="--c:var(--j-miss)"></i>Miss</span><span><i class="lg-ghost"></i>실제로 친 틀린 건반</span></div>
          </div>
          <div class="mheat" id="mheat" aria-label="마디별 정확도"></div>
          <div class="res-sheet-wrap"><div id="resSheet" role="img" aria-label="마디별 정확도를 색으로 칠한 악보"></div></div>
          <p class="hist-note" id="sheetNote"></p>
        </div>
        <div class="panel p-coach">
          <div class="coach-top"><span class="coach-tag">${ICON.spark}AI 코치</span><p id="coach"></p></div>
          <ul class="recs" id="recs"></ul>
          <div class="recs-f"><button class="btn cta" id="recAdd" type="button">고른 항목 오늘의 연습에 추가</button><span class="shelf-note" id="recNote"></span></div>
        </div>
      </div>
      <div class="res-actions">
        <button class="btn cta" id="btnRetry" type="button">${ICON.restart}다시 하기</button>
        <button class="btn" id="btnAdjust" type="button">설정 바꿔 다시</button>
        <button class="btn" id="btnWeak" type="button">약한 구간 반복</button>
        <button class="btn" id="btnNext" type="button">다음 곡 ${ICON.play}</button>
        <a class="btn ghost" href="#home">곡 선택</a>
      </div>
    </div>`;
    this.sheet = new SheetView($('#resSheet', this.root), { zoomFor: (w) => (w >= 700 ? 0.7 : 0.55) });
    this.sheet.onRendered = () => this.paintSheet();
    $('#recs', this.root).addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-off]');
      if (!b) return;
      updateSettings({ offset: clamp(settings.offset + Number(b.dataset.off), OFFSET_MIN, OFFSET_MAX) });
      this.deps.offsetChanged();
      b.disabled = true;
      b.textContent = '적용했어요';
      toast(`지연 보정을 ${signed(settings.offset)}ms로 맞췄어요.`);
    });
    $('#recAdd', this.root).addEventListener('click', () => {
      const items: Omit<PlanItem, 'id'>[] = [];
      $$<HTMLInputElement>('#recs input[data-rec]', this.root).forEach((cb) => {
        const r = this.recs[Number(cb.dataset.rec)];
        if (cb.checked && !cb.disabled && r?.plan) {
          items.push(r.plan);
          r.added = true;
          cb.disabled = true;
          cb.closest('.rec')?.classList.add('added');
        }
      });
      if (items.length) {
        addPlan(items);
        toast(`오늘의 연습에 ${items.length}개를 추가했어요.`);
        $('#recNote', this.root).textContent = '홈 화면의 오늘의 연습 목록에 들어갔어요.';
      } else toast('추가할 항목을 골라 주세요.');
    });
    $('#btnRetry', this.root).addEventListener('click', () => this.shown && this.deps.retry(this.shown));
    $('#btnAdjust', this.root).addEventListener('click', () => this.shown && this.deps.adjust(this.shown));
    $('#btnNext', this.root).addEventListener('click', () => this.shown && this.deps.next(this.shown));
    $('#btnWeak', this.root).addEventListener('click', () => {
      const p = this.recs.find((r) => r.plan?.loop)?.plan;
      const R = this.shown;
      if (p) this.deps.startPlan(p);
      else if (R) {
        const worst = R.measures.map((a, i) => ({ a, i })).filter((x) => x.a != null).sort((x, y) => x.a! - y.a!)[0];
        const from = worst ? Math.max(0, worst.i - (worst.i % 2)) : 0;
        this.deps.startPlan({ songId: R.songId, title: '', sub: '', hands: R.hands, rate: 0.75, loop: { from, to: Math.min(R.bars - 1, from + 1) } });
      }
    });
  }

  /** Show a result; with none yet, an example run on the first built-in song. */
  show(R: ResultData | null): void {
    if (!R) {
      const first = songs()[0];
      if (!first) return;
      R = exampleResult(first.load(), first.id);
    }
    this.shown = R;
    const el = (id: string) => $('#' + id, this.root);
    el('resExample').hidden = !R.example;
    el('resTitle').textContent = R.title;
    el('resMeta').textContent = [
      HANDS_KO[R.hands], '템포 ' + Math.round(R.rate * 100) + '%', 'BPM ' + R.bpm,
      R.loop ? `${barNo(R.loop.from, R.pickup)}–${barNo(R.loop.to, R.pickup)}마디 반복` : '전곡', R.wait ? '대기 모드' : null,
      '노트 ' + R.total + '개', R.auto ? '자동 연주 포함' : null,
    ].filter(Boolean).join(' · ');
    const rk = el('rank');
    rk.textContent = R.rank;
    rk.dataset.r = R.rank;
    restartAnim(rk, 'reveal');
    const st = el('stamp');
    st.dataset.k = R.pp ? 'pp' : R.fc ? 'fc' : 'clear';
    st.textContent = R.pp ? 'PERFECT PLAY' : R.fc ? 'FULL COMBO' : 'CLEAR';
    restartAnim(st, 'reveal');
    el('resAcc').textContent = R.acc.toFixed(2) + '%';
    el('resCombo').textContent = `${R.maxCombo} / ${R.total}`;
    const sc = el('resScore');
    const t0 = performance.now();
    const dur = reducedMotion() ? 0 : 1100;
    const score = R.score;
    const tick = (now: number) => {
      const p = dur ? clamp((now - t0) / dur, 0, 1) : 1;
      sc.textContent = commas(Math.round(score * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    el('jbars').innerHTML = JUDGES[R.wait ? 'wait' : 'normal']
      .map(([k, l]) => `<div class="jb" data-k="${k}"><span class="jb-l">${l}</span><span class="jb-t"><i style="--w:${Math.min(1, R.counts[k] / Math.max(1, R.total))}"></i></span><b>${R.counts[k]}</b></div>`)
      .join('');
    this.renderHist(R);
    this.renderHeat(R);
    const worstM = R.measures.map((a, i) => (a == null ? null : { a, i })).filter((x): x is { a: number; i: number } => !!x).sort((x, y) => x.a - y.a)[0];
    el('sheetNote').innerHTML = worstM ? `가장 약한 마디 <b>${barNo(worstM.i, R.pickup)}마디 · ${Math.round(worstM.a * 100)}%</b> · 틀린 건반 <b>${R.counts.wrong}</b>번 (빨간 점선 음표)` : '';
    el('coach').textContent = R.coach;
    this.recs = coachRecs(R);
    el('recs').innerHTML = this.recs
      .map((r, i) =>
        r.offset != null
          ? `<li class="rec"><span></span><label><b>${esc(r.text)}</b><span>${esc(r.act)}</span></label><button class="btn sm" type="button" data-off="${r.offset}">보정 ${r.offset > 0 ? '+' : ''}${r.offset}ms 적용</button></li>`
          : `<li class="rec"><input type="checkbox" id="rec-${i}" data-rec="${i}" checked><label for="rec-${i}"><b>${esc(r.text)}</b><span>${esc(r.act)}</span></label><span></span></li>`,
      )
      .join('');
    el('recNote').textContent = '';
    void this.loadSheet(R);
  }

  enter(): void {
    this.sheet?.refit();
  }

  private renderHist(R: ResultData): void {
    const hb = $('#histBox', this.root);
    const note = $('#histNote', this.root);
    if (R.wait) {
      hb.innerHTML = '<div class="hist-empty">대기 모드에서는 맞았는지 틀렸는지만 세요.<br>타이밍 분포는 일반 모드에서 볼 수 있어요.</div>';
      note.textContent = '';
      return;
    }
    const bins = new Array(14).fill(0);
    R.errors.forEach((e) => bins[clamp(Math.floor((e + 140) / 20), 0, 13)]++);
    const max = Math.max(1, ...bins);
    const bars = bins
      .map((v, i) => {
        const lo = -140 + i * 20;
        const mid = Math.abs(lo + 10);
        const z = mid <= 45 ? 'perfect' : mid <= 90 ? 'great' : 'good';
        const tip = `${signed(lo)} ~ ${signed(lo + 20)}ms · ${v}개`;
        return `<div class="hb" data-z="${z}" style="--h:${v / max}" tabindex="0" data-tip="${tip}" aria-label="${tip}"><i></i></div>`;
      })
      .join('');
    const axis = [-140, -90, -45, 0, 45, 90, 140].map((v) => `<span style="left:${((v + 140) / 280) * 100}%">${v === 0 ? '0' : signed(v)}</span>`).join('');
    hb.innerHTML = `<div class="hist"><span class="zone z-p"></span><span class="zone z-0"></span>${bars}</div><div class="hist-axis">${axis}</div><div class="hist-ends"><span>← 빠름</span><span>느림 →</span></div>`;
    const n = R.errors.length;
    const mean = avg(R.errors);
    const sd = n ? Math.sqrt(R.errors.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
    const early = R.errors.filter((e) => e < -10).length;
    const late = R.errors.filter((e) => e > 10).length;
    note.innerHTML = `평균 <b>${signed(Math.round(mean))}ms</b> · 흔들림 <b>±${Math.round(sd)}ms</b> · 빠름 <b>${early}</b> / 느림 <b>${late}</b>`;
  }

  /** Per-measure heat strip: always readable, also when the song has no sheet. */
  private renderHeat(R: ResultData): void {
    $('#mheat', this.root).innerHTML = R.measures
      .map((a, i) => {
        const n = barNo(i, R.pickup);
        const short = R.pickup && i === 0 ? '·' : n;
        return a == null
          ? `<span class="mh off" data-tip="${n}마디 · 연주 안 함"><i></i><em>${short}</em></span>`
          : `<span class="mh" style="--c:${heat(a)}" data-tip="${n}마디 · ${Math.round(a * 100)}%" tabindex="0"><i style="--a:${a}"></i><em>${short}</em></span>`;
      })
      .join('');
  }

  private async loadSheet(R: ResultData): Promise<void> {
    const song = getSong(R.songId);
    let chart: Chart | null = null;
    try {
      chart = song ? song.load() : null;
    } catch {
      chart = null;
    }
    if (!this.sheet) return;
    const key = song?.id ?? null;
    if (key !== this.chartFor || !this.sheet.hasSheet) {
      this.chartFor = key;
      await this.sheet.show(chart);
    } else this.paintSheet();
  }

  private paintSheet(): void {
    const R = this.shown;
    const sh = this.sheet;
    if (!R || !sh) return;
    sh.clearMarks();
    const song = getSong(R.songId);
    let chartIds: string[] = [];
    try {
      chartIds = song ? song.load().notes.map((n) => n.id) : [];
    } catch {
      chartIds = [];
    }
    const played = new Map(R.notes.map((n) => [n.id, n]));
    for (const id of chartIds) {
      const n = played.get(id);
      sh.setMark(id, n ? n.res : 'off');
    }
    for (const w of R.wrongs) sh.ghost(w.midi, w.measure, w.beat);
    sh.setTints(R.measures);
    sh.hidePlayhead();
  }
}
