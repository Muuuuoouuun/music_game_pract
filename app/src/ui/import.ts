/**
 * 새 곡: real MusicXML / MXL / MIDI import with a review card (editable title, detected
 * key/time/tempo, hand split, mini sheet) and a falling-note preview per difficulty.
 * The YouTube link and audio tabs keep the mockup's console but are clearly disabled
 * until the band2sheet transcription server is connected.
 */
import type { Chart } from '../core/chart';
import { ImportError, importFile } from '../import';
import { LANE_HUE, fitKeyRange, laneLayout } from '../render/lanes';
import { SheetView } from '../render/sheet';
import { addUserChart, tsLabel } from '../state/library';
import type { Settings } from '../state/settings';
import { $, $$, esc, toast } from './dom';

type Src = 'score' | 'link' | 'audio';
const VARIANTS = {
  easy: { hands: 'R' as const, rate: 0.75, label: 'EASY', sub: '오른손 · 템포 75%' },
  normal: { hands: 'R' as const, rate: 1, label: 'NORMAL', sub: '오른손 · 템포 100%' },
  orig: { hands: 'B' as const, rate: 1, label: 'ORIGINAL', sub: '양손 · 템포 100%' },
};
type Variant = keyof typeof VARIANTS;

const SCORE_STEPS: [string, string][] = [
  ['파일 읽기', 'MusicXML · MXL · MIDI'],
  ['악보 해석', '음표·쉼표·붙임줄 읽기'],
  ['박자 그리드', '마디 · 박자표 · 템포'],
  ['양손 나누기', '보표와 음역으로 왼손·오른손'],
  ['완료', '결과를 확인해 주세요'],
];
const AUDIO_STEPS: [string, string][] = [
  ['오디오 가져오기', '링크·파일에서 44.1kHz로'],
  ['음원 분리', 'Demucs · 피아노 / 보컬 / 드럼 / 베이스'],
  ['채보', 'Basic Pitch · 음 높이와 길이 추출'],
  ['템포·박자 분석', 'BPM · 박자표 · 첫 박 위치'],
  ['양손 분리', '음역과 성부 흐름으로 나누기'],
  ['난이도 생성', 'Easy / Normal / Original'],
];
const NOT_READY = '준비 중 — 음원 변환 서버(band2sheet) 연결 후 사용 가능';

export interface ImportDeps {
  /** Song added (and optionally start it with a variant). */
  added(songId: string, play: Partial<Settings> | null): void;
}

export class ImportScreen {
  private root: HTMLElement;
  private deps: ImportDeps;
  private src: Src = 'score';
  private chart: Chart | null = null;
  private fileName = '';
  private variant: Variant = 'normal';
  private mini: SheetView | null = null;
  private busy = false;
  private t0 = 0;
  private logT0 = 0;
  private stripTimer = 0;

  constructor(root: HTMLElement, deps: ImportDeps) {
    this.root = root;
    this.deps = deps;
  }

  mount(): void {
    this.root.innerHTML = `
    <div class="wrap">
      <p class="eyebrow">REMIX CONSOLE</p>
      <h1 class="h-disp">새 곡 만들기</h1>
      <p class="lede">MusicXML이나 MIDI 악보 파일을 넣으면 바로 플레이할 수 있는 채보로 바꿔 드려요. 유튜브 링크와 오디오 파일 변환은 곧 열려요.</p>
      <div class="console">
        <div class="panel rack src">
          <div class="src-tabs" role="tablist" aria-label="가져올 소스">
            <button role="tab" data-src="score" aria-selected="true" type="button">악보 파일</button>
            <button role="tab" data-src="link" aria-selected="false" type="button">링크</button>
            <button role="tab" data-src="audio" aria-selected="false" type="button">오디오</button>
          </div>
          <div class="src-pane" data-pane="score">
            <label class="drop" id="dropScore">
              <input id="srcScore" type="file" accept=".musicxml,.xml,.mxl,.mid,.midi,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml,audio/midi,audio/x-midi">
              <b>악보 파일을 끌어다 놓거나 눌러서 고르세요</b>
              <div class="formats"><i>MusicXML</i><i>MXL</i><i>MIDI</i></div>
              <span id="scoreName">.musicxml · .xml · .mxl · .mid · .midi</span>
            </label>
            <p class="sim-note">MuseScore에서 '내보내기 → MusicXML'로 저장한 파일이 가장 정확해요. PDF·사진 악보 인식은 준비 중이에요.</p>
          </div>
          <div class="src-pane" data-pane="link" hidden>
            <label class="field-lbl" for="srcUrl">YouTube 링크</label>
            <input class="url" id="srcUrl" type="url" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" autocomplete="off">
            <p class="soon">${NOT_READY}</p>
          </div>
          <div class="src-pane" data-pane="audio" hidden>
            <label class="drop disabled" aria-disabled="true">
              <input type="file" disabled accept=".mp3,.wav">
              <b>오디오 파일 (mp3 · wav)</b>
              <div class="formats"><i>mp3</i><i>wav</i></div>
              <span>솔로 피아노 연주 녹음부터 지원할 예정이에요</span>
            </label>
            <p class="soon">${NOT_READY}</p>
          </div>
          <button class="btn cta" id="btnConvert" type="button">파일 고르기</button>
          <p class="rights">본인이 권리를 가진 음원·악보만 업로드하세요. 퍼블릭 도메인 악보(IMSLP·MuseScore PD 등)는 자유롭게 쓸 수 있어요.</p>
        </div>
        <div class="panel rack pipe">
          <div class="pipe-head"><h2>처리 단계</h2><span class="pipe-state" id="pipeState">대기 중</span></div>
          <ol class="steps" id="steps"></ol>
          <pre class="log" id="log" aria-live="polite"></pre>
        </div>
      </div>
      <div class="panel review" id="review" hidden>
        <div class="out-head"><h2>인식 결과 확인</h2><span class="rv-conf" id="rvConf"></span></div>
        <div class="rv-body">
          <div class="mini-wrap"><div id="impMini" role="img" aria-label="가져온 악보 앞부분"></div></div>
          <div class="rv-side">
            <div class="fld"><label for="impTitle">제목</label><input class="inp" id="impTitle" type="text" maxlength="80"></div>
            <dl class="detect" id="rvDetect"></dl>
            <div class="flag ok" id="rvHands"></div>
          </div>
        </div>
        <div class="out-actions" style="margin:0">
          <button class="btn cta" id="impAdd" type="button">곡 목록에 추가</button>
          <button class="btn" id="impPlay" type="button">바로 연주</button>
          <span class="shelf-note" id="impNote">확인한 제목으로 홈 화면에 카드가 생겨요.</span>
        </div>
      </div>
      <div class="panel out">
        <div class="out-head"><h2>생성된 채보</h2><span id="outState">악보를 넣으면 여기서 미리 볼 수 있어요</span></div>
        <div class="out-body">
          <canvas id="strip" aria-label="채보 미리보기"></canvas>
          <div>
            <div class="variants" role="group" aria-label="난이도 선택">
              ${(Object.keys(VARIANTS) as Variant[]).map((k) => `<button class="variant" data-v="${k}" aria-pressed="${k === 'normal'}" type="button"><b>${VARIANTS[k].label}</b><span>${VARIANTS[k].sub}</span><span class="mono" data-vn="${k}">–</span></button>`).join('')}
            </div>
            <div class="out-actions">
              <button class="btn cta" id="btnPlayImported" type="button" disabled>이 채보로 플레이</button>
              <span class="shelf-note" id="outHint">악보 파일을 먼저 넣어 주세요.</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
    $$<HTMLButtonElement>('.src-tabs [role=tab]', this.root).forEach((b) => b.addEventListener('click', () => this.setSrc(b.dataset.src as Src)));
    const input = $<HTMLInputElement>('#srcScore', this.root);
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this.load(f);
      input.value = '';
    });
    const drop = $('#dropScore', this.root);
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.load(f);
    });
    $('#btnConvert', this.root).addEventListener('click', () => {
      if (this.src === 'score') input.click();
    });
    $$<HTMLButtonElement>('.variant', this.root).forEach((b) =>
      b.addEventListener('click', () => {
        this.variant = b.dataset.v as Variant;
        $$('.variant', this.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.t0 = performance.now();
      }),
    );
    $('#impAdd', this.root).addEventListener('click', () => this.add(null));
    $('#impPlay', this.root).addEventListener('click', () => this.add(this.variantSettings(this.variant)));
    $('#btnPlayImported', this.root).addEventListener('click', () => this.add(this.variantSettings(this.variant)));
    this.mini = new SheetView($('#impMini', this.root), {
      maxMeasures: 4,
      zoomFor: (w) => (w >= 520 ? 0.62 : 0.5),
      emptyText: '이 파일에는 악보 미리보기가 없어요',
    });
    this.renderSteps();
  }

  enter(): void {
    clearInterval(this.stripTimer);
    this.stripTimer = window.setInterval(() => this.drawStrip(performance.now()), 33);
    this.mini?.refit();
  }

  leave(): void {
    clearInterval(this.stripTimer);
  }

  private variantSettings(v: Variant): Partial<Settings> {
    const x = VARIANTS[v];
    const hasR = this.chart?.notes.some((n) => n.hand === 'R');
    return { hands: hasR ? x.hands : 'B', rate: x.rate, wait: false, loop: { on: false, from: 0, to: 3 } };
  }

  private setSrc(s: Src): void {
    if (this.busy) return toast('변환이 끝난 뒤에 소스를 바꿀 수 있어요.');
    this.src = s;
    $$('.src-tabs [role=tab]', this.root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.src === s)));
    $$('.src-pane', this.root).forEach((p) => (p.hidden = p.dataset.pane !== s));
    const btn = $<HTMLButtonElement>('#btnConvert', this.root);
    btn.disabled = s !== 'score';
    btn.textContent = s === 'score' ? '파일 고르기' : '변환 시작 (준비 중)';
    this.renderSteps();
    $('#pipeState', this.root).textContent = s === 'score' ? (this.chart ? '완료' : '대기 중') : '준비 중';
  }

  private renderSteps(): void {
    const list = this.src === 'score' ? SCORE_STEPS : AUDIO_STEPS;
    $('#steps', this.root).innerHTML = list
      .map(([n, d], i) => `<li class="step" data-s="${this.src === 'score' ? 'wait' : 'off'}" data-i="${i}"><i class="led"></i><div><b>${n}</b><small>${d}</small></div><em>${this.src === 'score' ? '대기' : '준비 중'}</em><div class="bar"><i></i></div></li>`)
      .join('');
    if (this.src !== 'score') $('#log', this.root).textContent = NOT_READY + '\n';
  }

  private markStep(i: number, s: 'run' | 'done' | 'err', note?: string): void {
    const li = this.root.querySelector<HTMLElement>(`.step[data-i="${i}"]`);
    if (!li) return;
    li.dataset.s = s;
    li.querySelector('em')!.textContent = s === 'done' ? '완료' : s === 'err' ? '실패' : '진행';
    (li.querySelector('.bar i') as HTMLElement).style.width = s === 'run' ? '55%' : '100%';
    if (note) li.querySelector('small')!.textContent = note;
  }

  private log(line: string, ok = false): void {
    const el = $('#log', this.root);
    const dt = ((performance.now() - this.logT0) / 1000).toFixed(1).padStart(4, '0');
    el.insertAdjacentHTML('beforeend', `<span class="t">[${dt}s]</span> ${esc(line)}${ok ? ' <span class="ok">✓</span>' : ''}\n`);
    el.scrollTop = el.scrollHeight;
  }

  private async load(file: File): Promise<void> {
    if (this.busy) return;
    if (this.src !== 'score') this.setSrc('score');
    this.busy = true;
    this.logT0 = performance.now();
    this.renderSteps();
    $('#log', this.root).textContent = '';
    $('#review', this.root).hidden = true;
    const state = $('#pipeState', this.root);
    state.textContent = '변환 중';
    state.className = 'pipe-state run';
    $('#scoreName', this.root).textContent = `${file.name} · ${(file.size / 1024).toFixed(file.size < 102400 ? 1 : 0)}KB`;
    const pause = () => new Promise((r) => setTimeout(r, 140));
    try {
      this.markStep(0, 'run');
      this.log(`read     ${file.name} · ${file.size.toLocaleString()} bytes`);
      await pause();
      this.markStep(0, 'done');
      this.markStep(1, 'run');
      const chart = await importFile(file);
      this.markStep(1, 'done', `${chart.notes.length}음 · ${chart.meta.source.kind === 'midi' ? 'MIDI' : 'MusicXML'}`);
      this.log(`parse    ${chart.meta.source.kind === 'midi' ? 'MIDI → 악보 생성' : 'MusicXML'} · 음표 ${chart.notes.length}개`);
      await pause();
      this.markStep(2, 'done', `${tsLabel(chart.meta.timeSignature)} · ♩=${Math.round(chart.meta.bpm)} · ${chart.measures.length}마디`);
      this.log(`grid     ${tsLabel(chart.meta.timeSignature)} · ♩=${Math.round(chart.meta.bpm)} · ${chart.measures.length}마디`);
      await pause();
      const r = chart.notes.filter((n) => n.hand === 'R').length;
      const l = chart.notes.length - r;
      this.markStep(3, 'done', `오른손 ${r} · 왼손 ${l}`);
      this.log(`hands    오른손 ${r} · 왼손 ${l}`);
      await pause();
      this.markStep(4, 'done');
      this.log(`ready    ${chart.meta.title}`, true);
      state.textContent = '완료 · 확인해 주세요';
      state.className = 'pipe-state';
      this.chart = chart;
      this.fileName = file.name;
      this.showReview();
      toast('악보를 읽었어요. 제목을 확인하고 곡 목록에 추가해 주세요.');
    } catch (e) {
      const msg = e instanceof ImportError ? e.message : '파일을 읽는 중에 문제가 생겼어요. 다른 파일로 해 보세요.';
      if (!(e instanceof ImportError)) console.error(e);
      const cur = this.root.querySelector<HTMLElement>('.step[data-s="run"]');
      if (cur) this.markStep(Number(cur.dataset.i), 'err');
      this.log('error    ' + msg);
      state.textContent = '실패';
      state.className = 'pipe-state err';
      toast(msg, 4500);
    } finally {
      this.busy = false;
    }
  }

  private showReview(): void {
    const c = this.chart!;
    const r = c.notes.filter((n) => n.hand === 'R').length;
    const l = c.notes.length - r;
    const secs = Math.round(c.meta.durationMs / 1000);
    $<HTMLInputElement>('#impTitle', this.root).value = c.meta.title;
    $('#rvConf', this.root).textContent = c.meta.source.kind === 'midi' ? 'MIDI → 악보 자동 생성' : 'MusicXML 원본 악보';
    $('#rvDetect', this.root).innerHTML = [
      ['조성', c.meta.key ?? '알 수 없음'],
      ['박자', tsLabel(c.meta.timeSignature)],
      ['템포', '♩=' + Math.round(c.meta.bpm)],
      ['마디', c.measures.length + '마디'],
      ['음표', c.notes.length + '개'],
      ['길이', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    const [lo, hi] = fitKeyRange(c.notes.map((n) => n.midi));
    $('#rvHands', this.root).innerHTML = `<span><b>양손 나누기</b> 오른손 ${r}음 · 왼손 ${l}음 · 건반 ${hi - lo + 1}개 범위</span>`;
    $('#review', this.root).hidden = false;
    $('#impNote', this.root).textContent = '확인한 제목으로 홈 화면에 카드가 생겨요.';
    const counts = {
      easy: c.notes.filter((n) => n.hand === 'R').length || c.notes.length,
      normal: c.notes.filter((n) => n.hand === 'R').length || c.notes.length,
      orig: c.notes.length,
    };
    for (const k of Object.keys(VARIANTS) as Variant[]) {
      const el = this.root.querySelector(`[data-vn="${k}"]`);
      if (el) el.textContent = `노트 ${counts[k]}개 · BPM ${Math.round(c.meta.bpm * VARIANTS[k].rate)}`;
    }
    $<HTMLButtonElement>('#btnPlayImported', this.root).disabled = false;
    $('#outState', this.root).textContent = `${c.meta.title} · ${tsLabel(c.meta.timeSignature)} · BPM ${Math.round(c.meta.bpm)} · ${c.measures.length}마디`;
    $('#outHint', this.root).textContent = '고른 난이도로 바로 무대에 올라가요.';
    this.t0 = performance.now();
    requestAnimationFrame(() => void this.mini?.show(c));
  }

  private add(play: Partial<Settings> | null): void {
    if (!this.chart) return;
    const title = $<HTMLInputElement>('#impTitle', this.root).value.trim() || this.chart.meta.title || this.fileName;
    const chart: Chart = { ...this.chart, meta: { ...this.chart.meta, title } };
    const { song, persisted } = addUserChart(chart);
    toast(persisted ? `홈 화면에 '${title}' 카드를 추가했어요.` : `저장 공간이 부족해서 '${title}'은(는) 이번 접속에서만 쓸 수 있어요.`, 3600);
    this.chart = null;
    $('#review', this.root).hidden = true;
    $<HTMLButtonElement>('#btnPlayImported', this.root).disabled = true;
    $('#outState', this.root).textContent = `'${title}'을(를) 곡 목록에 넣었어요`;
    $('#outHint', this.root).textContent = '다른 악보를 더 넣을 수 있어요.';
    this.deps.added(song.id, play);
  }

  /** Falling-note preview of the chosen difficulty (mockup's #strip). */
  private drawStrip(now: number): void {
    const c = this.root.querySelector<HTMLCanvasElement>('#strip');
    if (!c) return;
    const d = Math.min(2, devicePixelRatio || 1);
    const cw = c.clientWidth;
    const chh = c.clientHeight;
    if (!cw) return;
    if (c.width !== Math.round(cw * d) || c.height !== Math.round(chh * d)) {
      c.width = Math.round(cw * d);
      c.height = Math.round(chh * d);
    }
    const x2 = c.getContext('2d')!;
    const w = cw;
    const h = chh;
    x2.setTransform(d, 0, 0, d, 0, 0);
    x2.fillStyle = '#09071e';
    x2.fillRect(0, 0, w, h);
    const v = VARIANTS[this.variant];
    const ch = this.chart;
    const notes = ch ? ch.notes.filter((n) => v.hands === 'B' || n.hand === v.hands || !ch.notes.some((x) => x.hand === v.hands)) : [];
    const [lo, hi] = notes.length ? fitKeyRange(notes.map((n) => n.midi)) : [60, 76];
    const L = laneLayout(lo, hi);
    const kh = 26;
    const hitY = h - kh - 2;
    const pad = 10;
    const W = w - pad * 2;
    for (let i = 1; i < L.whites; i++) {
      x2.fillStyle = 'rgba(160,150,255,.12)';
      x2.fillRect(pad + (i / L.whites) * W, 0, 1, hitY);
    }
    if (ch && notes.length) {
      const look = 2600;
      const end = ch.meta.durationMs / v.rate;
      const cycle = Math.min(end, 30000) + 1800;
      const t = ((now - this.t0) % cycle) - 900;
      for (const n of notes) {
        const nt = n.startMs / v.rate;
        if (nt > t + look) break;
        const yb = hitY - ((nt - t) / look) * hitY;
        const yt = hitY - ((nt + (n.durationMs / v.rate) * 0.9 - t) / look) * hitY;
        if (yt > hitY || yb < 0) continue;
        const ln = L.lane[n.midi];
        if (!ln) continue;
        const x = pad + ln.l * W + 1.5;
        const ww = ln.w * W - 3;
        x2.fillStyle = `hsla(${LANE_HUE[n.midi % 12]},95%,62%,${n.hand === 'L' ? 0.5 : 0.92})`;
        x2.fillRect(x, Math.max(0, yt), ww, Math.min(hitY, yb) - Math.max(0, yt));
        if (yb <= hitY) {
          x2.fillStyle = `hsl(${LANE_HUE[n.midi % 12]} 100% 88%)`;
          x2.fillRect(x, yb - 3, ww, 3);
        }
      }
    } else {
      x2.fillStyle = 'rgba(172,167,216,.5)';
      x2.font = '12px "IBM Plex Sans KR", sans-serif';
      x2.textAlign = 'center';
      x2.fillText(this.busy ? '채보 만드는 중…' : '아직 채보가 없어요', w / 2, hitY / 2);
    }
    x2.fillStyle = 'rgba(255,205,120,.85)';
    x2.fillRect(pad, hitY, W, 2);
    for (let m = lo; m <= hi; m++) {
      const ln = L.lane[m];
      if (ln.b) continue;
      x2.fillStyle = '#f5efe2';
      x2.fillRect(pad + ln.l * W + 0.5, hitY + 3, ln.w * W - 1, kh - 3);
    }
    for (let m = lo; m <= hi; m++) {
      const ln = L.lane[m];
      if (!ln.b) continue;
      x2.fillStyle = '#120f2a';
      x2.fillRect(pad + ln.l * W, hitY + 3, ln.w * W, (kh - 3) * 0.6);
    }
  }
}
