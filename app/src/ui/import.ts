/**
 * 새 곡: MusicXML / MXL / MIDI import and in-browser audio transcription, each with a
 * review card (editable title, detected key/time/tempo, hand split, mini sheet) and a
 * falling-note preview per difficulty.
 *
 * 오디오 tab: a recording (mp3/wav/m4a/ogg) is decoded, transcribed with Spotify
 * basic-pitch (TF.js, lazy-loaded), its tempo and first downbeat are estimated, and the
 * recording is attached to the chart so it plays along in the play screen. The user can
 * correct BPM / downbeat / time signature before saving, and continue in the editor.
 * The YouTube link tab stays disabled (needs a local conversion worker).
 */
import { synth } from '../audio/synth';
import { AudioTrack } from '../audio/track';
import type { Chart } from '../core/chart';
import { ImportError, importFile } from '../import';
import { LANE_HUE, fitKeyRange, laneLayout } from '../render/lanes';
import { SheetView } from '../render/sheet';
import { newAudioId, putAudio } from '../state/audio-store';
import { addUserChart, tsLabel } from '../state/library';
import type { Settings } from '../state/settings';
import type { TranscribeStage } from '../transcribe/basic-pitch';
import { estimateTempo, type TempoEstimate } from '../transcribe/tempo';
import { notesToChart, toMonophonic, type RawNote } from '../transcribe/to-chart';
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
  ['오디오 읽기', '디코딩 · 22.05 kHz 모노'],
  ['모델 불러오기', 'Basic Pitch · TF.js'],
  ['채보', '음 높이 · 길이 · 세기 추출'],
  ['템포·박자 분석', 'BPM · 첫 박 위치'],
  ['완료', '결과를 확인해 주세요'],
];
const LINK_STEPS: [string, string][] = [
  ['오디오 가져오기', '링크에서 44.1kHz로'],
  ['음원 분리', 'Demucs · 피아노 / 보컬 / 드럼 / 베이스'],
  ['채보', 'Basic Pitch · 음 높이와 길이 추출'],
  ['템포·박자 분석', 'BPM · 박자표 · 첫 박 위치'],
  ['양손 분리', '음역과 성부 흐름으로 나누기'],
];
const NOT_READY = '준비 중 — 로컬 변환 워커 필요';
const STAGE_STEP: Record<TranscribeStage, number> = { decode: 0, model: 1, infer: 2, notes: 2 };
const STAGE_TXT: Record<TranscribeStage, string> = { decode: '오디오 읽는 중', model: '모델 불러오는 중', infer: '채보 중', notes: '음표 정리 중' };
const MAX_MIN = 10;
const WARN_MIN = 4;
const MAX_BYTES = 200 * 1024 * 1024;
const TS_OPTIONS: [number, number][] = [[4, 4], [3, 4], [2, 4], [6, 8]];

type Inst = 'piano' | 'mono';

interface AudioState {
  file: File;
  track: AudioTrack;
  raw: RawNote[] | null;
  tempo: TempoEstimate | null;
  bpm: number;
  offsetMs: number;
  ts: [number, number];
  backend: string | null;
  elapsedMs: number;
  audioId: string;
}

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
  private audio: AudioState | null = null;
  private inst: Inst = 'piano';
  private sens = 50;
  private abort: AbortController | null = null;
  private elapsedTimer = 0;
  private taps: number[] = [];
  private preview: { timer: number; notes: Chart['notes']; i: number; held: Set<number>; offset: number } | null = null;

  constructor(root: HTMLElement, deps: ImportDeps) {
    this.root = root;
    this.deps = deps;
  }

  mount(): void {
    this.root.innerHTML = `
    <div class="wrap">
      <p class="eyebrow">REMIX CONSOLE</p>
      <h1 class="h-disp">새 곡 만들기</h1>
      <p class="lede">MusicXML·MIDI 악보 파일, 또는 피아노 녹음(mp3·wav)을 넣으면 바로 플레이할 수 있는 채보로 바꿔 드려요. 녹음은 브라우저 안에서 변환되고 어디에도 업로드되지 않아요.</p>
      <div class="console">
        <div class="panel rack src">
          <div class="src-tabs" role="tablist" aria-label="가져올 소스">
            <button role="tab" data-src="score" aria-selected="true" type="button">악보 파일</button>
            <button role="tab" data-src="audio" aria-selected="false" type="button">오디오</button>
            <button role="tab" data-src="link" aria-selected="false" type="button">링크</button>
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
          <div class="src-pane" data-pane="audio" hidden>
            <label class="drop" id="dropAudio">
              <input id="srcAudio" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm">
              <b>녹음 파일을 끌어다 놓거나 눌러서 고르세요</b>
              <div class="formats"><i>mp3</i><i>wav</i><i>m4a</i><i>ogg</i></div>
              <span id="audioName">솔로 피아노나 한 악기 녹음 · 10분 이하</span>
            </label>
            <div class="wave" id="wave" hidden><canvas id="waveCv" aria-label="녹음 파형"></canvas><span class="wave-dur mono" id="waveDur"></span></div>
            <div class="aopts" id="aopts" hidden>
              <div class="og"><span class="og-l">악기</span><span class="seg" role="group" aria-label="악기"><button type="button" data-inst="piano" aria-pressed="true">피아노 · 여러 음</button><button type="button" data-inst="mono" aria-pressed="false">멜로디 한 줄</button></span>
                <span class="og-n" id="instNote">화음과 양손을 그대로 채보해요</span></div>
              <label class="ctl sens" for="sens"><span>감도</span><input type="range" id="sens" min="0" max="100" step="5" value="50"><output id="sensVal" for="sens">보통</output></label>
              <p class="sim-note warn" id="audioWarn" hidden></p>
            </div>
            <p class="sim-note">Spotify Basic Pitch 모델이 브라우저 안에서 돌아가요. 처음 한 번 모델(약 0.9MB)을 내려받고, 변환은 녹음 길이와 기기 성능에 따라 수십 초쯤 걸려요. 밴드·반주가 섞인 음원은 정확도가 크게 떨어져요.</p>
          </div>
          <div class="src-pane" data-pane="link" hidden>
            <label class="field-lbl" for="srcUrl">YouTube 링크</label>
            <input class="url" id="srcUrl" type="url" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" autocomplete="off" disabled>
            <p class="soon">${NOT_READY}</p>
          </div>
          <button class="btn cta" id="btnConvert" type="button">파일 고르기</button>
          <p class="rights">본인이 권리를 가진 음원·악보만 업로드하세요. 퍼블릭 도메인 악보(IMSLP·MuseScore PD 등)는 자유롭게 쓸 수 있어요. 녹음은 이 기기 안에만 저장돼요.</p>
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
        <div class="rv-audio" id="rvAudio" hidden>
          <div class="rv-audio-head"><b>템포·첫 박 맞추기</b><span class="shelf-note" id="aFit"></span></div>
          <div class="agrid">
            <div class="fld"><label for="aBpm">BPM</label><div class="row"><input class="inp" id="aBpm" type="number" min="30" max="300" step="0.1" inputmode="decimal"><button class="btn sm" id="aHalf" type="button" title="절반 템포">×½</button><button class="btn sm" id="aDouble" type="button" title="두 배 템포">×2</button><button class="btn sm" id="aTap" type="button" title="박자에 맞춰 여러 번 누르면 BPM을 재요">탭 템포</button></div></div>
            <div class="fld"><label for="aOffset">첫 박 위치 · 녹음 기준 ms</label><div class="row"><input class="inp" id="aOffset" type="number" step="1" inputmode="numeric"><button class="btn sm" id="aOffMinus" type="button" title="한 박 앞으로">−1박</button><button class="btn sm" id="aOffPlus" type="button" title="한 박 뒤로">+1박</button></div></div>
            <div class="fld"><label for="aTs">박자</label><select class="sel" id="aTs">${TS_OPTIONS.map((t) => `<option value="${t[0]}/${t[1]}">${t[0]}/${t[1]}</option>`).join('')}</select></div>
          </div>
          <div class="row wrap">
            <button class="btn" id="aApply" type="button">다시 계산</button>
            <button class="btn" id="aPreview" type="button" aria-pressed="false">원곡 미리듣기</button>
            <span class="shelf-note" id="aNote">녹음 위에 채보된 음을 신스로 겹쳐 들려줘요. 음이 어긋나면 첫 박 위치를, 마디선이 어긋나면 BPM이나 박자를 고쳐요.</span>
          </div>
        </div>
        <div class="out-actions" style="margin:0">
          <button class="btn cta" id="impAdd" type="button">곡 목록에 추가</button>
          <button class="btn" id="impEdit" type="button">편집기에서 다듬기</button>
          <button class="btn" id="impPlay" type="button">바로 연주</button>
          <span class="shelf-note" id="impNote">확인한 제목으로 홈 화면에 카드가 생겨요.</span>
        </div>
      </div>
      <div class="panel out">
        <div class="out-head"><h2>생성된 채보</h2><span id="outState">악보나 녹음을 넣으면 여기서 미리 볼 수 있어요</span></div>
        <div class="out-body">
          <canvas id="strip" aria-label="채보 미리보기"></canvas>
          <div>
            <div class="variants" role="group" aria-label="난이도 선택">
              ${(Object.keys(VARIANTS) as Variant[]).map((k) => `<button class="variant" data-v="${k}" aria-pressed="${k === 'normal'}" type="button"><b>${VARIANTS[k].label}</b><span>${VARIANTS[k].sub}</span><span class="mono" data-vn="${k}">–</span></button>`).join('')}
            </div>
            <div class="out-actions">
              <button class="btn cta" id="btnPlayImported" type="button" disabled>이 채보로 플레이</button>
              <span class="shelf-note" id="outHint">악보 파일이나 녹음을 먼저 넣어 주세요.</span>
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
    this.bindDrop('#dropScore', (f) => void this.load(f));
    const aInput = $<HTMLInputElement>('#srcAudio', this.root);
    aInput.addEventListener('change', () => {
      const f = aInput.files?.[0];
      if (f) void this.loadAudio(f);
      aInput.value = '';
    });
    this.bindDrop('#dropAudio', (f) => void this.loadAudio(f));
    $('#btnConvert', this.root).addEventListener('click', () => {
      if (this.src === 'score') input.click();
      else if (this.src === 'audio') {
        if (this.busy) this.abort?.abort();
        else if (this.audio) void this.convertAudio();
        else aInput.click();
      }
    });
    $$<HTMLButtonElement>('[data-inst]', this.root).forEach((b) =>
      b.addEventListener('click', () => {
        this.inst = b.dataset.inst as Inst;
        $$('[data-inst]', this.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('#instNote', this.root).textContent = this.inst === 'mono' ? '한 번에 한 음만 남기고 오른손 한 줄로 채보해요 (노래·플루트·바이올린 등)' : '화음과 양손을 그대로 채보해요';
      }),
    );
    const sens = $<HTMLInputElement>('#sens', this.root);
    sens.addEventListener('input', () => {
      this.sens = Number(sens.value);
      $('#sensVal', this.root).textContent = this.sens < 35 ? '낮게 · 또렷한 음만' : this.sens > 65 ? '높게 · 작은 음까지' : '보통';
    });
    $$<HTMLButtonElement>('.variant', this.root).forEach((b) =>
      b.addEventListener('click', () => {
        this.variant = b.dataset.v as Variant;
        $$('.variant', this.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.t0 = performance.now();
      }),
    );
    $('#impAdd', this.root).addEventListener('click', () => void this.add(null));
    $('#impEdit', this.root).addEventListener('click', () => void this.add(null, true));
    $('#impPlay', this.root).addEventListener('click', () => void this.add(this.variantSettings(this.variant)));
    $('#btnPlayImported', this.root).addEventListener('click', () => void this.add(this.variantSettings(this.variant)));
    this.bindAudioReview();
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
    if (this.audio) this.drawWave();
  }

  leave(): void {
    clearInterval(this.stripTimer);
    this.stopPreview();
  }

  private bindDrop(sel: string, onFile: (f: File) => void): void {
    const drop = $(sel, this.root);
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    });
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
    this.syncConvertButton();
    this.renderSteps();
    const state = $('#pipeState', this.root);
    state.className = 'pipe-state';
    state.textContent = s === 'link' ? '준비 중' : this.chart ? '완료' : '대기 중';
  }

  private syncConvertButton(): void {
    const btn = $<HTMLButtonElement>('#btnConvert', this.root);
    btn.disabled = this.src === 'link';
    btn.classList.toggle('cta', !(this.src === 'audio' && this.busy));
    btn.textContent =
      this.src === 'score' ? '파일 고르기'
      : this.src === 'link' ? '변환 시작 (준비 중)'
      : this.busy ? '변환 취소'
      : this.audio ? '변환 시작'
      : '오디오 파일 고르기';
  }

  private renderSteps(): void {
    const list = this.src === 'score' ? SCORE_STEPS : this.src === 'audio' ? AUDIO_STEPS : LINK_STEPS;
    const off = this.src === 'link';
    $('#steps', this.root).innerHTML = list
      .map(([n, d], i) => `<li class="step" data-s="${off ? 'off' : 'wait'}" data-i="${i}"><i class="led"></i><div><b>${n}</b><small>${d}</small></div><em>${off ? '준비 중' : '대기'}</em><div class="bar"><i></i></div></li>`)
      .join('');
    if (off) $('#log', this.root).textContent = NOT_READY + '\n';
  }

  private markStep(i: number, s: 'run' | 'done' | 'err', note?: string, pct?: number): void {
    const li = this.root.querySelector<HTMLElement>(`.step[data-i="${i}"]`);
    if (!li) return;
    li.dataset.s = s;
    li.querySelector('em')!.textContent = s === 'done' ? '완료' : s === 'err' ? '실패' : pct !== undefined ? `${Math.round(pct * 100)}%` : '진행';
    (li.querySelector('.bar i') as HTMLElement).style.width = s === 'run' ? `${Math.round((pct ?? 0.55) * 100)}%` : '100%';
    if (note) li.querySelector('small')!.textContent = note;
  }

  private log(line: string, ok = false): void {
    const el = $('#log', this.root);
    const dt = ((performance.now() - this.logT0) / 1000).toFixed(1).padStart(4, '0');
    el.insertAdjacentHTML('beforeend', `<span class="t">[${dt}s]</span> ${esc(line)}${ok ? ' <span class="ok">✓</span>' : ''}\n`);
    el.scrollTop = el.scrollHeight;
  }

  private fail(msg: string): void {
    const cur = this.root.querySelector<HTMLElement>('.step[data-s="run"]');
    if (cur) this.markStep(Number(cur.dataset.i), 'err');
    this.log('error    ' + msg);
    const state = $('#pipeState', this.root);
    state.textContent = '실패';
    state.className = 'pipe-state err';
    toast(msg, 4500);
  }

  /* ------------------------------------------------------------ score files */

  private async load(file: File): Promise<void> {
    if (this.busy) return;
    if (this.src !== 'score') this.setSrc('score');
    this.busy = true;
    this.logT0 = performance.now();
    this.renderSteps();
    $('#log', this.root).textContent = '';
    this.hideReview();
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
      this.fail(msg);
    } finally {
      this.busy = false;
    }
  }

  /* ------------------------------------------------------------ audio files */

  private async loadAudio(file: File): Promise<void> {
    if (this.busy) return;
    if (this.src !== 'audio') this.setSrc('audio');
    const name = $('#audioName', this.root);
    const warn = $('#audioWarn', this.root);
    warn.hidden = true;
    if (file.size > MAX_BYTES) return void toast('200MB가 넘는 파일은 열 수 없어요. 필요한 부분만 잘라서 올려 주세요.', 4500);
    name.textContent = `${file.name} · 읽는 중…`;
    let track: AudioTrack;
    try {
      track = await AudioTrack.fromBlob(file);
    } catch (e) {
      console.warn('decode failed', e);
      name.textContent = '솔로 피아노나 한 악기 녹음 · 10분 이하';
      return void toast('이 오디오 형식은 브라우저가 읽지 못해요. mp3·wav·m4a·ogg로 변환해서 다시 올려 주세요.', 5000);
    }
    const mins = track.durationMs / 60000;
    if (mins > MAX_MIN) {
      track.dispose();
      name.textContent = '솔로 피아노나 한 악기 녹음 · 10분 이하';
      return void toast(`${MAX_MIN}분이 넘는 녹음(${fmtDur(track.durationMs)})은 변환할 수 없어요. 필요한 부분만 잘라서 올려 주세요.`, 5500);
    }
    this.audio?.track.dispose();
    this.stopPreview();
    this.audio = { file, track, raw: null, tempo: null, bpm: 120, offsetMs: 0, ts: [4, 4], backend: null, elapsedMs: 0, audioId: newAudioId() };
    this.hideReview();
    name.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)}MB · ${fmtDur(track.durationMs)}`;
    $('#wave', this.root).hidden = false;
    $('#waveDur', this.root).textContent = fmtDur(track.durationMs);
    $('#aopts', this.root).hidden = false;
    if (mins > WARN_MIN) {
      warn.hidden = false;
      warn.textContent = `${WARN_MIN}분이 넘는 녹음이라 변환에 시간이 꽤 걸려요 (그래픽 가속 없이는 몇 분). 연습할 부분만 잘라 올리면 더 빨라요.`;
    }
    this.drawWave();
    this.syncConvertButton();
    this.renderSteps();
    $('#pipeState', this.root).textContent = '변환 시작을 눌러 주세요';
    $('#log', this.root).textContent = '';
  }

  private drawWave(): void {
    const a = this.audio;
    const c = this.root.querySelector<HTMLCanvasElement>('#waveCv');
    if (!a || !c || !c.clientWidth) return;
    const d = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight || 56;
    c.width = Math.round(w * d);
    c.height = Math.round(h * d);
    const x = c.getContext('2d')!;
    x.setTransform(d, 0, 0, d, 0, 0);
    x.fillStyle = '#09071e';
    x.fillRect(0, 0, w, h);
    const peaks = a.track.peaks(Math.max(32, Math.floor(w / 2)));
    const bw = w / peaks.length;
    x.fillStyle = 'rgba(255,205,120,.85)';
    for (let i = 0; i < peaks.length; i++) {
      const ph = Math.max(1, peaks[i] * (h - 6));
      x.fillRect(i * bw + 0.5, (h - ph) / 2, Math.max(1, bw - 1), ph);
    }
    if (a.tempo) {
      // first downbeat marker
      const t = a.offsetMs / a.track.durationMs;
      x.fillStyle = '#76e0ff';
      x.fillRect(Math.round(t * w), 0, 2, h);
    }
  }

  private thresholds(): { onsetThreshold: number; frameThreshold: number } {
    const s = this.sens / 100; // 0.5 = defaults
    const mono = this.inst === 'mono';
    return {
      onsetThreshold: Math.max(0.15, Math.min(0.9, 0.75 - 0.5 * s + (mono ? 0.15 : 0))),
      frameThreshold: Math.max(0.1, Math.min(0.7, 0.45 - 0.3 * s + (mono ? 0.05 : 0))),
    };
  }

  private async convertAudio(): Promise<void> {
    const a = this.audio;
    if (!a || this.busy) return;
    this.busy = true;
    this.stopPreview();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.logT0 = performance.now();
    this.renderSteps();
    this.hideReview();
    $('#log', this.root).textContent = '';
    this.syncConvertButton();
    const state = $('#pipeState', this.root);
    state.className = 'pipe-state run';
    const t0 = performance.now();
    let stageTxt = '시작';
    const tick = () => {
      state.textContent = `${stageTxt} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    };
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = window.setInterval(tick, 200);
    let lastLogged = -1;
    try {
      const th = this.thresholds();
      this.markStep(0, 'run');
      this.log(`read     ${a.file.name} · ${fmtDur(a.track.durationMs)} · ${a.track.buffer.sampleRate} Hz → 22050 Hz 모노`);
      const { transcribeAudio, backendInUse, modelReady } = await import('../transcribe/basic-pitch');
      const stepLog: Record<TranscribeStage, boolean> = { decode: false, model: false, infer: false, notes: false };
      const raw0 = await transcribeAudio(a.track, {
        signal,
        ...th,
        minNoteMs: this.inst === 'mono' ? 80 : 58,
        onProgress: (p, stage) => {
          const i = STAGE_STEP[stage];
          stageTxt = `${STAGE_TXT[stage]}${stage === 'infer' ? ` ${Math.round(p * 100)}%` : ''}`;
          for (let k = 0; k < i; k++) this.markStep(k, 'done');
          this.markStep(i, p >= 1 && stage !== 'infer' ? 'done' : 'run', undefined, stage === 'infer' ? p : undefined);
          if (!stepLog[stage]) {
            stepLog[stage] = true;
            if (stage === 'decode') this.markStep(0, 'done');
            if (stage === 'model') this.log(modelReady() ? 'model    이미 불러온 모델 재사용' : 'model    basic-pitch 모델 내려받는 중 (public/basic-pitch)');
            if (stage === 'infer') this.log(`infer    backend ${backendInUse() ?? '?'} · onset ${th.onsetThreshold.toFixed(2)} · frame ${th.frameThreshold.toFixed(2)}${this.inst === 'mono' ? ' · 단선율' : ''}`);
          }
          if (stage === 'infer') {
            const q = Math.floor(p * 4);
            if (q > lastLogged && q < 4) {
              lastLogged = q;
              if (q > 0) this.log(`infer    ${q * 25}%`);
            }
          }
        },
      });
      a.backend = backendInUse();
      const raw = this.inst === 'mono' ? toMonophonic(raw0) : raw0;
      this.markStep(2, 'done', `${raw.length}음${this.inst === 'mono' ? ` (원래 ${raw0.length})` : ''} · ${a.backend ?? ''}`);
      this.log(`notes    ${raw.length}개${raw0.length !== raw.length ? ` (단선율로 정리, 원래 ${raw0.length}개)` : ''}`);
      if (raw.length < 2) throw new ImportError('녹음에서 음표를 거의 찾지 못했어요. 감도를 높이거나, 피아노 소리가 또렷한 녹음으로 다시 해 보세요.');
      this.markStep(3, 'run');
      stageTxt = '템포 분석';
      const tempo = estimateTempo(raw.map((n) => ({ t: n.startMs, v: n.velocity })), { beatsPerBar: a.ts[0] === 6 && a.ts[1] === 8 ? 2 : a.ts[0] });
      a.raw = raw;
      a.tempo = tempo;
      a.bpm = Math.round(tempo.bpm * 10) / 10;
      a.offsetMs = Math.round(tempo.offsetMs);
      a.elapsedMs = performance.now() - t0;
      this.markStep(3, 'done', `♩=${a.bpm} · 첫 박 ${fmtMs(a.offsetMs)} · 신뢰도 ${Math.round(tempo.confidence * 100)}%`);
      this.log(`tempo    ♩=${a.bpm} · 첫 박 ${fmtMs(a.offsetMs)} · 격자 일치 ${Math.round(tempo.gridFit * 100)}% · 신뢰도 ${Math.round(tempo.confidence * 100)}%` + (tempo.candidates.length > 1 ? ` · 후보 ${tempo.candidates.slice(1, 3).map((c) => c.bpm).join(', ')}` : ''));
      this.rebuildAudioChart();
      this.markStep(4, 'done');
      this.log(`ready    ${this.chart!.meta.title} · ${(a.elapsedMs / 1000).toFixed(1)}s`, true);
      clearInterval(this.elapsedTimer);
      state.textContent = `완료 · ${(a.elapsedMs / 1000).toFixed(1)}s · 확인해 주세요`;
      state.className = 'pipe-state';
      this.showReview();
      toast('채보가 끝났어요. 템포와 첫 박을 확인하고 곡 목록에 추가하거나 편집기에서 다듬어 주세요.', 4000);
    } catch (e) {
      clearInterval(this.elapsedTimer);
      const aborted = (e as { aborted?: boolean })?.aborted === true;
      const msg = aborted ? '변환을 취소했어요.' : e instanceof ImportError || (e as Error)?.name === 'TranscribeError' ? (e as Error).message : '채보 중에 문제가 생겼어요. 콘솔에 자세한 내용이 있어요.';
      if (!aborted && !(e instanceof ImportError) && (e as Error)?.name !== 'TranscribeError') console.error(e);
      this.fail(msg);
      if (aborted) state.textContent = '취소됨';
    } finally {
      this.busy = false;
      this.abort = null;
      this.syncConvertButton();
    }
  }

  /** Build (or rebuild after an edit) the chart from the kept raw notes. */
  private rebuildAudioChart(): void {
    const a = this.audio;
    if (!a?.raw) return;
    const title = (this.chart && $<HTMLInputElement>('#impTitle', this.root).value.trim()) || a.file.name.replace(/\.[^.]+$/, '') || '녹음';
    this.chart = notesToChart(a.raw, {
      bpm: a.bpm,
      offsetMs: a.offsetMs,
      timeSignature: a.ts,
      title,
      fileName: a.file.name,
      singleHand: this.inst === 'mono' ? 'R' : undefined,
      audio: { id: a.audioId, fileName: a.file.name, durationMs: Math.round(a.track.durationMs), offsetMs: a.offsetMs, gain: 0.8 },
    });
    this.fileName = a.file.name;
  }

  private bindAudioReview(): void {
    const a = () => this.audio;
    const bpmIn = $<HTMLInputElement>('#aBpm', this.root);
    const offIn = $<HTMLInputElement>('#aOffset', this.root);
    const tsSel = $<HTMLSelectElement>('#aTs', this.root);
    const read = () => {
      const s = a();
      if (!s) return;
      const bpm = Number(bpmIn.value);
      if (bpm >= 30 && bpm <= 300) s.bpm = Math.round(bpm * 10) / 10;
      const off = Number(offIn.value);
      if (Number.isFinite(off)) s.offsetMs = Math.round(off);
      const [n, d] = tsSel.value.split('/').map(Number);
      s.ts = [n, d];
    };
    const apply = () => {
      const s = a();
      if (!s?.raw) return;
      read();
      this.stopPreview();
      try {
        this.rebuildAudioChart();
        this.showReview();
        toast(`♩=${s.bpm} · 첫 박 ${fmtMs(s.offsetMs)} · ${tsLabel(s.ts)}로 다시 계산했어요.`);
      } catch (e) {
        toast((e as Error).message || '다시 계산하지 못했어요.');
      }
    };
    $('#aApply', this.root).addEventListener('click', apply);
    $('#aHalf', this.root).addEventListener('click', () => {
      read();
      const s = a();
      if (!s) return;
      s.bpm = Math.max(30, Math.round((s.bpm / 2) * 10) / 10);
      bpmIn.value = String(s.bpm);
      apply();
    });
    $('#aDouble', this.root).addEventListener('click', () => {
      read();
      const s = a();
      if (!s) return;
      s.bpm = Math.min(300, Math.round(s.bpm * 2 * 10) / 10);
      bpmIn.value = String(s.bpm);
      apply();
    });
    const shift = (beats: number) => {
      read();
      const s = a();
      if (!s) return;
      s.offsetMs = Math.round(s.offsetMs + (60000 / s.bpm) * beats);
      offIn.value = String(s.offsetMs);
      apply();
    };
    $('#aOffMinus', this.root).addEventListener('click', () => shift(-1));
    $('#aOffPlus', this.root).addEventListener('click', () => shift(1));
    const tapBtn = $<HTMLButtonElement>('#aTap', this.root);
    tapBtn.addEventListener('click', () => {
      const now = performance.now();
      if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) this.taps = [];
      this.taps.push(now);
      if (this.taps.length > 9) this.taps.shift();
      if (this.taps.length < 3) {
        tapBtn.textContent = `탭 ${this.taps.length}…`;
        return;
      }
      const gaps = this.taps.slice(1).map((t, i) => t - this.taps[i]).sort((x, y) => x - y);
      const med = gaps[Math.floor(gaps.length / 2)];
      const bpm = Math.round((60000 / med) * 10) / 10;
      tapBtn.textContent = `탭 ${this.taps.length} · ♩=${bpm}`;
      bpmIn.value = String(bpm);
      const s = a();
      if (s) s.bpm = bpm;
    });
    tapBtn.addEventListener('blur', () => {
      this.taps = [];
      tapBtn.textContent = '탭 템포';
    });
    for (const el of [bpmIn, offIn]) el.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
    tsSel.addEventListener('change', apply);
    $('#aPreview', this.root).addEventListener('click', () => (this.preview ? this.stopPreview() : this.startPreview()));
  }

  /** 원곡 미리듣기: the recording from chart 0 with the transcribed notes on the synth. */
  private startPreview(): void {
    const a = this.audio;
    const c = this.chart;
    if (!a || !c?.audio) return;
    synth.unlock();
    const offset = c.audio.offsetMs;
    a.track.play(offset, 1, 0.9);
    const notes = c.notes;
    const held = new Set<number>();
    this.preview = { timer: 0, notes, i: 0, held, offset };
    const btn = $<HTMLButtonElement>('#aPreview', this.root);
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '미리듣기 멈춤';
    const step = () => {
      const p = this.preview;
      if (!p) return;
      const pos = a.track.position();
      if (pos === null || pos >= a.track.durationMs - 5) return this.stopPreview();
      const chartMs = pos - p.offset;
      while (p.i < p.notes.length && p.notes[p.i].startMs <= chartMs + 15) {
        const n = p.notes[p.i++];
        if (n.startMs < chartMs - 200) continue;
        synth.noteOn(n.midi, Math.max(0.2, n.velocity / 127) * 0.8);
        held.add(n.midi);
        window.setTimeout(() => {
          if (held.has(n.midi)) synth.noteOff(n.midi);
        }, Math.max(80, Math.min(n.durationMs, 1800)));
      }
      p.timer = requestAnimationFrame(step);
    };
    this.preview.timer = requestAnimationFrame(step);
  }

  private stopPreview(): void {
    const p = this.preview;
    if (!p) return;
    cancelAnimationFrame(p.timer);
    this.preview = null;
    this.audio?.track.stop();
    synth.allOff();
    const btn = this.root.querySelector<HTMLButtonElement>('#aPreview');
    if (btn) {
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '원곡 미리듣기';
    }
  }

  /* ------------------------------------------------------------ review + save */

  private hideReview(): void {
    $('#review', this.root).hidden = true;
    this.stopPreview();
  }

  private showReview(): void {
    const c = this.chart!;
    const a = c.meta.source.kind === 'audio' ? this.audio : null;
    const r = c.notes.filter((n) => n.hand === 'R').length;
    const l = c.notes.length - r;
    const secs = Math.round(c.meta.durationMs / 1000);
    $<HTMLInputElement>('#impTitle', this.root).value = c.meta.title;
    $('#rvConf', this.root).textContent =
      c.meta.source.kind === 'audio' ? `오디오 채보 · Basic Pitch${a?.backend ? ` (${a.backend})` : ''}` : c.meta.source.kind === 'midi' ? 'MIDI → 악보 자동 생성' : 'MusicXML 원본 악보';
    const rows: [string, string][] = [
      ['조성', c.meta.key ?? '알 수 없음'],
      ['박자', tsLabel(c.meta.timeSignature)],
      ['템포', '♩=' + (Number.isInteger(c.meta.bpm) ? c.meta.bpm : c.meta.bpm.toFixed(1))],
      ['마디', c.measures.length + '마디' + (isPickup(c) ? ' (못갖춘)' : '')],
      ['음표', c.notes.length + '개'],
      ['길이', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`],
    ];
    if (a?.tempo) rows.push(['첫 박', fmtMs(a.offsetMs)], ['템포 신뢰도', `${Math.round(a.tempo.confidence * 100)}%`]);
    $('#rvDetect', this.root).innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    const [lo, hi] = fitKeyRange(c.notes.map((n) => n.midi));
    $('#rvHands', this.root).innerHTML = `<span><b>양손 나누기</b> 오른손 ${r}음 · 왼손 ${l}음 · 건반 ${hi - lo + 1}개 범위</span>`;
    const ra = $('#rvAudio', this.root);
    ra.hidden = !a;
    if (a) {
      $<HTMLInputElement>('#aBpm', this.root).value = String(a.bpm);
      $<HTMLInputElement>('#aOffset', this.root).value = String(a.offsetMs);
      $<HTMLSelectElement>('#aTs', this.root).value = tsLabel(a.ts);
      const t = a.tempo;
      $('#aFit', this.root).textContent = t
        ? `자동 분석 ♩=${t.bpm.toFixed(1)} · 격자 일치 ${Math.round(t.gridFit * 100)}%${t.candidates.length > 1 ? ` · 다른 후보 ${t.candidates.slice(1, 3).map((x) => x.bpm).join(' / ')}` : ''}${t.confidence < 0.45 ? ' · 자신 없음 — 탭 템포로 맞춰 보세요' : ''}`
        : '';
      this.drawWave();
    }
    $('#review', this.root).hidden = false;
    $('#impNote', this.root).textContent = a ? '녹음도 함께 저장돼서 연주할 때 원곡이 같이 나와요 (더보기 → 원곡 소리).' : '확인한 제목으로 홈 화면에 카드가 생겨요.';
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

  private async add(play: Partial<Settings> | null, edit = false): Promise<void> {
    if (!this.chart) return;
    this.stopPreview();
    const title = $<HTMLInputElement>('#impTitle', this.root).value.trim() || this.chart.meta.title || this.fileName;
    const chart: Chart = { ...this.chart, meta: { ...this.chart.meta, title } };
    let audioNote = '';
    if (chart.audio && this.audio && chart.meta.source.kind === 'audio') {
      const ok = await putAudio(chart.audio.id, this.audio.file);
      if (!ok) {
        delete chart.audio;
        audioNote = ' 녹음은 저장 공간 문제로 붙이지 못했어요.';
      }
    }
    const { song, persisted } = addUserChart(chart);
    toast((persisted ? `홈 화면에 '${title}' 카드를 추가했어요.` : `저장 공간이 부족해서 '${title}'은(는) 이번 접속에서만 쓸 수 있어요.`) + audioNote, 3600);
    this.chart = null;
    if (this.audio) {
      this.audio.track.dispose();
      this.audio = null;
      $('#wave', this.root).hidden = true;
      $('#aopts', this.root).hidden = true;
      $('#audioName', this.root).textContent = '솔로 피아노나 한 악기 녹음 · 10분 이하';
      this.syncConvertButton();
    }
    this.hideReview();
    $<HTMLButtonElement>('#btnPlayImported', this.root).disabled = true;
    $('#outState', this.root).textContent = `'${title}'을(를) 곡 목록에 넣었어요`;
    $('#outHint', this.root).textContent = '다른 악보나 녹음을 더 넣을 수 있어요.';
    this.deps.added(song.id, play);
    if (edit) location.hash = '#edit/' + song.id;
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

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function isPickup(c: Chart): boolean {
  const m = c.measures[0];
  if (!m || c.measures.length < 2) return false;
  const full = (60000 / m.bpm) * ((4 * m.timeSignature[0]) / m.timeSignature[1]);
  return m.durationMs < full * 0.98;
}
