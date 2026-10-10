/**
 * 악보 편집 (#edit/<songId>, #edit/new): correct a transcription or write a chart by hand.
 *
 * The screen owns the chart and its undo stack; the canvas (`RollCanvas`) and the panels
 * hand back whole charts through pure ops from `core/edit`. Saving writes MusicXML for
 * the sheet view and upserts the song into the library; a built-in song is saved as a
 * copy "<제목> (편집)".
 */
import { synth } from '../../audio/synth';
import { AudioTrack } from '../../audio/track';
import { noteName, type Chart, type Hand } from '../../core/chart';
import {
  BPM_MAX,
  BPM_MIN,
  UndoStack,
  beatLabel,
  blankChart,
  chartToMidiBytes,
  deleteNotes,
  hasConstantTempo,
  moveNotes,
  quantize,
  rebuildFromMeasures,
  rebuildTiming,
  setHand,
  setVelocity,
  snapStepMs,
  timingOf,
  type SnapDivision,
  type TimingSpec,
} from '../../core/edit';
import { chartToMusicXml } from '../../import';
import { getAudio } from '../../state/audio-store';
import { editorPrefs, saveEditorPrefs, type EditorTool } from '../../state/editor-prefs';
import { addUserChart, getSong, saveUserChart } from '../../state/library';
import { $, $$, esc, toast } from '../dom';
import { nKo } from '../format';
import { RollCanvas, type RollHost } from './canvas';
import { Transport } from './transport';

export interface EditorDeps {
  /** A chart was saved under `id`; the play screen may want to reload it. */
  saved(id: string): void;
  /** Leave the editor (the unsaved-changes guard already passed). */
  close(): void;
}

const TS_OPTIONS: [number, number][] = [[4, 4], [3, 4], [2, 4], [6, 8]];
const SNAPS: (SnapDivision | 'off')[] = ['off', 4, 8, 16, '8t', '16t'];
const SNAP_NAMES: Record<string, string> = { off: '끄기', 4: '4분', 8: '8분', 16: '16분', '8t': '8분 셋잇단', '16t': '16분 셋잇단' };

const fmtMs = (ms: number) => `${Math.round(ms)} ms`;
const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const safeName = (s: string) => (s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'chart').slice(0, 80);

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export class EditorScreen implements RollHost {
  chart: Chart;
  tool: EditorTool = editorPrefs.tool;
  hand: Hand = 'R';
  readonly selection = new Set<string>();
  songId: string | null = null;
  /** Set while the leave confirm has been accepted, so the router lets the hash change through. */
  leaving = false;

  private root: HTMLElement;
  private deps: EditorDeps;
  private undo: UndoStack<Chart>;
  private roll!: RollCanvas;
  private transport = new Transport();
  private track: AudioTrack | null = null;
  private builtin = false;
  private isNew = false;
  private loaded = false;
  private dirtyFlag = false;
  private dragBase: Chart | null = null;
  private dragPushed = false;
  private coalesceKey: string | null = null;
  private coalesceAt = 0;
  private taps: number[] = [];
  private proceed: (() => void) | null = null;
  private rate = editorPrefs.rate;

  constructor(root: HTMLElement, deps: EditorDeps) {
    this.root = root;
    this.deps = deps;
    this.chart = blankChart({ id: 'new', title: '새 곡' });
    this.undo = new UndoStack(this.chart);
  }

  /* ------------------------------------------------------------------ mount */

  mount(): void {
    this.root.innerHTML = `
    <div class="ed-bar" role="toolbar" aria-label="파일·재생">
      <button class="btn sm ghost" id="edClose" type="button">← 닫기</button>
      <input class="inp ed-title" id="edTitle" type="text" aria-label="곡 제목" placeholder="곡 제목" maxlength="80">
      <span class="ed-sep"></span>
      <button class="btn sm" id="edUndo" type="button" title="되돌리기 (Ctrl+Z)">↶<span class="ed-lbl"> 되돌리기</span></button>
      <button class="btn sm" id="edRedo" type="button" title="다시하기 (Ctrl+Y)">↷<span class="ed-lbl"> 다시하기</span></button>
      <span class="ed-sep"></span>
      <button class="btn sm" id="edPlay" type="button" title="재생/일시정지 (Space)">▶<span class="ed-lbl"> 재생</span></button>
      <button class="btn sm" id="edStop" type="button" title="정지">■<span class="ed-lbl"> 정지</span></button>
      <div class="seg" id="edRate" role="group" aria-label="템포">${[0.5, 0.75, 1].map((r) => `<button type="button" data-rate="${r}" aria-pressed="${r === this.rate}">${r * 100}%</button>`).join('')}</div>
      <label class="ed-vol" id="edAudioCtl" hidden>원곡 <input type="range" id="edGain" min="0" max="1" step="0.05" aria-label="원곡 볼륨"></label>
      <label class="ed-chk"><input type="checkbox" id="edNoteSound"> 노트 소리</label>
      <span class="ed-grow"></span>
      <details class="ed-menu" id="edExport"><summary class="btn sm">내보내기 ▾</summary><div><button type="button" data-export="midi">MIDI (.mid)</button><button type="button" data-export="xml">MusicXML (.musicxml)</button></div></details>
      <button class="btn sm ghost ed-phone" id="edSheet" type="button" aria-expanded="false">타이밍·정보</button>
      <button class="btn sm cta" id="edSave" type="button" title="저장 (Ctrl+S)">저장</button>
    </div>
    <div class="ed-bar sub" role="toolbar" aria-label="편집 도구">
      <div class="seg" id="edTool" role="group" aria-label="도구">
        <button type="button" data-tool="select" title="선택: 드래그로 상자 선택, Shift로 추가">선택</button>
        <button type="button" data-tool="pencil" title="연필: 빈 곳 클릭 = 노트 추가, 드래그 = 길이">연필</button>
        <button type="button" data-tool="eraser" title="지우개: 노트를 클릭하거나 쓸어서 삭제">지우개</button>
      </div>
      <label class="ed-snap">스냅 <select class="sel" id="edSnap" aria-label="스냅">${SNAPS.map((s) => `<option value="${s}">${SNAP_NAMES[String(s)]}</option>`).join('')}</select></label>
      <span class="ed-sep"></span>
      <div class="seg" id="edHand" role="group" aria-label="선택 노트의 손"><button type="button" data-hand="R" title="오른손 (1)">오른손</button><button type="button" data-hand="L" title="왼손 (2)">왼손</button></div>
      <details class="ed-menu" id="edQuant"><summary class="btn sm">양자화 ▾</summary><div><button type="button" data-q="starts">시작만 맞추기</button><button type="button" data-q="both">시작과 끝 맞추기</button></div></details>
      <button class="btn sm" id="edDelete" type="button" title="삭제 (Delete)">삭제</button>
      <button class="btn sm" id="edAll" type="button" title="전체 선택 (Ctrl+A)">전체 선택</button>
      <span class="ed-sep"></span>
      <div class="seg ed-zoom" role="group" aria-label="확대"><button type="button" id="edZoomOut" title="축소 (−)">−</button><button type="button" id="edZoomIn" title="확대 (+)">+</button></div>
      <span class="ed-grow"></span>
      <span class="ed-kbd">Space 재생 · 방향키 이동 · 1/2 손 · Ctrl+휠 확대</span>
    </div>
    <div class="ed-body">
      <div class="ed-stage" id="edStage"></div>
      <aside class="ed-side" id="edSide" aria-label="타이밍과 정보">
        <div class="ed-side-head"><b>타이밍·정보</b><button class="btn sm ghost" id="edSheetClose" type="button">닫기</button></div>
        <section class="ed-panel">
          <h2>타이밍</h2>
          <div class="ed-row"><label for="tBpm">BPM</label><div class="ed-ctl"><input class="inp" id="tBpm" type="number" min="${BPM_MIN}" max="${BPM_MAX}" step="0.1" inputmode="decimal"><button class="btn sm" id="tTap" type="button" title="박에 맞춰 눌러 주세요 (최근 8번 평균)">탭 템포</button></div></div>
          <div class="ed-row"><label for="tTs">박자</label><select class="sel" id="tTs">${TS_OPTIONS.map(([a, b]) => `<option value="${a}/${b}">${a}/${b}</option>`).join('')}</select></div>
          <div class="ed-row"><label for="tOff">첫 박 위치</label><div class="ed-ctl"><input class="inp" id="tOff" type="number" step="10" inputmode="numeric"><span class="ed-unit">ms</span></div></div>
          <div class="ed-row"><span></span><div class="ed-ctl ed-wrap"><button class="btn sm" id="tHere" type="button" title="재생 위치를 첫 박으로">여기로</button><button class="btn sm" type="button" data-nudge="-10">−10</button><button class="btn sm" type="button" data-nudge="10">+10</button></div></div>
          <p class="ed-note" id="tTempoNote" hidden>템포가 바뀌는 곡이에요. 값을 바꾸면 곡 전체가 하나의 템포로 다시 맞춰져요.</p>
          <p class="ed-note">값을 바꾸면 격자가 바로 다시 그려지고, 노트의 마디·박 위치가 격자에 맞게 다시 계산돼요.</p>
          <div id="tAudio" hidden>
            <hr class="ed-hr">
            <div class="ed-row"><label for="tAOff">오디오 오프셋</label><div class="ed-ctl"><input class="inp" id="tAOff" type="number" step="10" inputmode="numeric"><span class="ed-unit">ms</span></div></div>
            <div class="ed-row"><span></span><div class="ed-ctl ed-wrap"><button class="btn sm" type="button" data-anudge="-10">−10</button><button class="btn sm" type="button" data-anudge="10">+10</button></div></div>
            <p class="ed-note"><b>노트와 소리 맞추기</b> 위쪽 파형에서 첫 음이 울리는 자리가 첫 노트와 겹치도록 조절하세요. 값을 키우면 소리가 앞으로 당겨져요.</p>
          </div>
        </section>
        <section class="ed-panel">
          <h2>정보</h2>
          <dl class="ed-facts" id="iFacts"></dl>
          <div class="ed-sel" id="iSel"></div>
        </section>
      </aside>
      <div class="ed-confirm" id="edConfirm" hidden role="dialog" aria-modal="true" aria-labelledby="edConfirmT">
        <div class="ed-confirm-card">
          <b id="edConfirmT">저장하지 않은 변경이 있어요</b>
          <p>지금 닫으면 이번에 편집한 내용이 사라져요.</p>
          <div class="ed-confirm-btns"><button class="btn cta" id="cSave" type="button">저장하고 닫기</button><button class="btn ghost" id="cDiscard" type="button">저장 안 함</button><button class="btn" id="cCancel" type="button">취소</button></div>
        </div>
      </div>
    </div>`;
    this.roll = new RollCanvas(this, $('#edStage', this.root));
    this.roll.view.snap = editorPrefs.snap;
    this.roll.view.pxPerSec = editorPrefs.pxPerSec;
    this.transport.noteSound = editorPrefs.noteSound;
    this.transport.gain = editorPrefs.audioGain;
    $<HTMLInputElement>('#edNoteSound', this.root).checked = editorPrefs.noteSound;
    $<HTMLInputElement>('#edGain', this.root).value = String(editorPrefs.audioGain);
    $<HTMLSelectElement>('#edSnap', this.root).value = String(editorPrefs.snap);
    this.wire();
    this.refreshAll();
  }

  private wire(): void {
    const r = this.root;
    const on = (sel: string, ev: string, fn: (e: Event) => void) => $(sel, r).addEventListener(ev, fn);
    on('#edClose', 'click', () => this.requestClose());
    on('#edTitle', 'input', () => this.setTitle($<HTMLInputElement>('#edTitle', r).value));
    on('#edUndo', 'click', () => this.doUndo());
    on('#edRedo', 'click', () => this.doRedo());
    on('#edPlay', 'click', () => this.togglePlay());
    on('#edStop', 'click', () => this.stopPlayback(false));
    on('#edRate', 'click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-rate]');
      if (b) this.setRate(Number(b.dataset.rate));
    });
    on('#edGain', 'input', () => {
      const g = Number($<HTMLInputElement>('#edGain', r).value);
      this.transport.setGain(g);
      saveEditorPrefs({ audioGain: g });
    });
    on('#edNoteSound', 'change', () => {
      const v = $<HTMLInputElement>('#edNoteSound', r).checked;
      this.transport.noteSound = v;
      saveEditorPrefs({ noteSound: v });
    });
    on('#edExport', 'click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-export]');
      if (!b) return;
      $<HTMLDetailsElement>('#edExport', r).open = false;
      if (b.dataset.export === 'midi') this.exportMidi();
      else this.exportXml();
    });
    on('#edSave', 'click', () => this.save());
    on('#edSheet', 'click', () => this.toggleSheet());
    on('#edSheetClose', 'click', () => this.toggleSheet(false));
    on('#edTool', 'click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-tool]');
      if (b) this.setTool(b.dataset.tool as EditorTool);
    });
    on('#edSnap', 'change', () => {
      const v = $<HTMLSelectElement>('#edSnap', r).value;
      this.roll.view.snap = v === 'off' ? 'off' : ((/^\d+$/.test(v) ? Number(v) : v) as SnapDivision);
      saveEditorPrefs({ snap: this.roll.view.snap });
      this.roll.requestDraw();
    });
    on('#edHand', 'click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-hand]');
      if (b) this.setSelectionHand(b.dataset.hand as Hand);
    });
    on('#edQuant', 'click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-q]');
      if (!b) return;
      $<HTMLDetailsElement>('#edQuant', r).open = false;
      this.quantizeSelection(b.dataset.q === 'both');
    });
    on('#edDelete', 'click', () => this.deleteSelection());
    on('#edAll', 'click', () => this.selectAll());
    on('#edZoomIn', 'click', () => this.zoom(1.25));
    on('#edZoomOut', 'click', () => this.zoom(0.8));
    // timing panel
    on('#tBpm', 'input', () => {
      const v = Number($<HTMLInputElement>('#tBpm', r).value);
      if (v >= BPM_MIN && v <= BPM_MAX) this.applyTiming({ bpm: v }, 'bpm');
    });
    on('#tBpm', 'change', () => this.refreshTiming());
    on('#tTs', 'change', () => {
      const [a, b] = $<HTMLSelectElement>('#tTs', r).value.split('/').map(Number);
      this.applyTiming({ timeSignature: [a, b] });
    });
    on('#tOff', 'input', () => {
      const v = Number($<HTMLInputElement>('#tOff', r).value);
      if (Number.isFinite(v)) this.applyTiming({ offsetMs: v }, 'offset');
    });
    on('#tOff', 'change', () => this.refreshTiming());
    on('#tHere', 'click', () => this.applyTiming({ offsetMs: this.roll.view.playMs ?? this.roll.view.cursorMs }));
    for (const b of $$<HTMLElement>('[data-nudge]', r)) b.addEventListener('click', () => this.applyTiming({ offsetMs: timingOf(this.chart).offsetMs + Number(b.dataset.nudge) }, 'offset'));
    on('#tTap', 'click', () => this.tap());
    on('#tAOff', 'input', () => {
      const v = Number($<HTMLInputElement>('#tAOff', r).value);
      if (Number.isFinite(v)) this.setAudioOffset(v, true);
    });
    for (const b of $$<HTMLElement>('[data-anudge]', r)) b.addEventListener('click', () => this.setAudioOffset((this.chart.audio?.offsetMs ?? 0) + Number(b.dataset.anudge), true));
    // selected note velocity
    $('#iSel', r).addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'iVel' || t.id === 'iVelN') {
        const v = Number(t.value);
        if (Number.isFinite(v)) this.apply(setVelocity(this.chart, this.selection, v), { coalesce: 'vel' });
      }
    });
    // confirm panel
    on('#cSave', 'click', () => {
      if (this.save()) this.runProceed();
      else this.hideConfirm();
    });
    on('#cDiscard', 'click', () => {
      this.dirtyFlag = false;
      this.runProceed();
    });
    on('#cCancel', 'click', () => this.hideConfirm());
    window.addEventListener('beforeunload', (e) => {
      if (this.loaded && this.dirtyFlag && !this.root.hidden) e.preventDefault();
    });
  }

  /* ------------------------------------------------------------------ open / leave */

  /** Loads a library song (built-in songs become an editable copy) or a blank chart for 'new'. */
  open(id: string): void {
    if (this.loaded && id === this.songId) {
      this.enter();
      return;
    }
    this.stopPlayback(false);
    let chart: Chart;
    if (id === 'new') {
      chart = blankChart({ id: 'new-' + Date.now().toString(36), title: '새 곡' });
      this.isNew = true;
      this.builtin = false;
    } else {
      const song = getSong(id);
      if (!song) {
        toast('곡을 찾지 못했어요.');
        this.deps.close();
        return;
      }
      try {
        chart = song.load();
      } catch {
        toast('곡을 불러오지 못했어요.');
        this.deps.close();
        return;
      }
      this.isNew = false;
      this.builtin = song.builtin;
    }
    this.songId = id;
    this.chart = rebuildFromMeasures(chart);
    this.undo.reset(this.chart);
    this.selection.clear();
    this.dirtyFlag = false;
    this.loaded = true;
    this.taps = [];
    this.coalesceKey = null;
    $<HTMLInputElement>('#edTitle', this.root).value = this.chart.meta.title;
    this.loadAudio();
    this.roll.view.cursorMs = 0;
    this.roll.fit();
    this.refreshAll();
    this.enter();
  }

  enter(): void {
    this.leaving = false;
    this.roll.resize();
    this.roll.requestDraw();
  }

  leave(): void {
    this.stopPlayback(false);
    this.leaving = false;
    this.hideConfirm();
    this.toggleSheet(false);
    for (const d of $$<HTMLDetailsElement>('details', this.root)) d.open = false;
  }

  get dirty(): boolean {
    return this.loaded && this.dirtyFlag;
  }

  private loadAudio(): void {
    this.track?.dispose();
    this.track = null;
    this.transport.track = null;
    this.roll.view.wave = null;
    const a = this.chart.audio;
    if (!a) return;
    void getAudio(a.id).then(async (blob) => {
      if (!blob || this.chart.audio?.id !== a.id) return;
      try {
        const t = await AudioTrack.fromBlob(blob);
        if (this.chart.audio?.id !== a.id) {
          t.dispose();
          return;
        }
        this.track = t;
        this.transport.track = t;
        this.roll.view.wave = { peaks: t.peaks(Math.min(20000, Math.max(1000, Math.round(t.durationMs / 10)))), durationMs: t.durationMs, offsetMs: a.offsetMs };
        this.roll.requestDraw();
      } catch {
        toast('녹음을 불러오지 못했어요. 노트만 편집할 수 있어요.');
      }
    });
  }

  /* ------------------------------------------------------------------ edits */

  private setChart(c: Chart): void {
    this.chart = c;
    this.dirtyFlag = true;
    const ids = new Set(c.notes.map((n) => n.id));
    for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
    if (c.audio) {
      this.transport.audioOffsetMs = c.audio.offsetMs;
      if (this.roll.view.wave) this.roll.view.wave.offsetMs = c.audio.offsetMs;
    }
    this.roll.requestDraw();
    this.refreshAll();
  }

  /** Records `next`; edits with the same `coalesce` key within 800 ms share one undo step. */
  private apply(next: Chart, opts: { coalesce?: string } = {}): void {
    if (next === this.chart) return;
    const now = performance.now();
    if (opts.coalesce && this.coalesceKey === opts.coalesce && now - this.coalesceAt < 800) this.undo.replaceTop(next);
    else this.undo.push(next);
    this.coalesceKey = opts.coalesce ?? null;
    this.coalesceAt = now;
    this.setChart(next);
  }

  // RollHost
  selectionChanged(): void {
    this.refreshInfo();
    this.refreshToolbar();
  }
  dragStart(): Chart {
    this.dragBase = this.chart;
    this.dragPushed = false;
    this.coalesceKey = null;
    return this.chart;
  }
  dragUpdate(next: Chart): void {
    if (next === this.chart) return;
    if (next === this.dragBase) {
      if (this.dragPushed) this.undo.pop();
      this.dragPushed = false;
    } else if (!this.dragPushed) {
      this.undo.push(next);
      this.dragPushed = true;
    } else this.undo.replaceTop(next);
    this.setChart(next);
  }
  dragEnd(): void {
    this.dragBase = null;
    this.dragPushed = false;
    this.refreshToolbar();
  }
  commit(next: Chart): void {
    this.apply(next);
  }
  seek(ms: number): void {
    const v = this.roll.view;
    v.cursorMs = Math.max(0, ms);
    if (this.transport.playing) this.transport.play(v.cursorMs, this.rate);
    this.roll.requestDraw();
  }
  preview(midi: number): void {
    synth.unlock();
    synth.noteOn(midi, 0.7);
    setTimeout(() => synth.noteOff(midi), 320);
  }
  newNoteDuration(): number {
    const v = this.roll.view;
    return v.snap === 'off' ? 300 : snapStepMs(this.chart, v.cursorMs, v.snap);
  }

  private setTitle(title: string): void {
    const t = title.slice(0, 80);
    if (t === this.chart.meta.title) return;
    this.apply({ ...this.chart, meta: { ...this.chart.meta, title: t } }, { coalesce: 'title' });
  }

  private doUndo(): void {
    const c = this.undo.undo();
    if (c) {
      this.coalesceKey = null;
      this.setChart(c);
    }
  }
  private doRedo(): void {
    const c = this.undo.redo();
    if (c) {
      this.coalesceKey = null;
      this.setChart(c);
    }
  }

  private setTool(t: EditorTool): void {
    this.tool = t;
    saveEditorPrefs({ tool: t });
    this.refreshToolbar();
  }

  private setRate(r: number): void {
    this.rate = r;
    saveEditorPrefs({ rate: r });
    if (this.transport.playing) this.transport.play(this.transport.position(), r);
    this.refreshToolbar();
  }

  private zoom(f: number): void {
    this.roll.zoomBy(f);
    saveEditorPrefs({ pxPerSec: this.roll.view.pxPerSec });
  }

  private selectAll(): void {
    this.selection.clear();
    for (const n of this.chart.notes) this.selection.add(n.id);
    this.selectionChanged();
    this.roll.requestDraw();
  }

  private deleteSelection(): void {
    if (!this.selection.size) return toast('삭제할 노트를 먼저 선택하세요.');
    const n = this.selection.size;
    this.apply(deleteNotes(this.chart, this.selection));
    toast(`노트 ${n}개를 지웠어요.`);
  }

  private setSelectionHand(hand: Hand): void {
    this.hand = hand;
    if (!this.selection.size) {
      this.refreshToolbar();
      return toast(hand === 'R' ? '연필로 그리는 노트가 오른손이 돼요.' : '연필로 그리는 노트가 왼손이 돼요.');
    }
    this.apply(setHand(this.chart, this.selection, hand));
  }

  private quantizeSelection(ends: boolean): void {
    const snap = this.roll.view.snap;
    if (snap === 'off') return toast('스냅을 켠 뒤 양자화할 수 있어요.');
    const ids = this.selection.size ? [...this.selection] : this.chart.notes.map((n) => n.id);
    if (!ids.length) return;
    const next = quantize(this.chart, ids, snap, { starts: true, ends });
    if (next === this.chart) return toast('이미 격자에 맞아 있어요.');
    this.apply(next);
    toast(`${this.selection.size ? '선택한' : '모든'} 노트 ${ids.length}개를 ${SNAP_NAMES[String(snap)]} 격자에 맞췄어요.`);
  }

  private nudge(dMs: number, dMidi: number, key: string): void {
    if (!this.selection.size) return;
    this.apply(moveNotes(this.chart, this.selection, { dMs, dMidi }), { coalesce: key });
  }

  private applyTiming(patch: Partial<TimingSpec>, coalesce?: string): void {
    const spec = { ...timingOf(this.chart), ...patch };
    this.apply(rebuildTiming(this.chart, spec), coalesce ? { coalesce } : {});
    if (!coalesce) this.refreshTiming();
  }

  private setAudioOffset(ms: number, coalesce: boolean): void {
    if (!this.chart.audio) return;
    const next: Chart = { ...this.chart, audio: { ...this.chart.audio, offsetMs: Math.round(ms) } };
    this.apply(next, coalesce ? { coalesce: 'aoff' } : {});
    if (this.transport.playing) this.transport.play(this.transport.position(), this.rate);
  }

  private tap(): void {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 9) this.taps.shift();
    const btn = $('#tTap', this.root);
    if (this.taps.length < 2) {
      btn.textContent = '탭 템포 (1)';
      return;
    }
    const gaps: number[] = [];
    for (let i = 1; i < this.taps.length; i++) gaps.push(this.taps[i] - this.taps[i - 1]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const bpm = Math.round((60000 / avg) * 10) / 10;
    btn.textContent = `탭 템포 (${this.taps.length})`;
    if (bpm >= BPM_MIN && bpm <= BPM_MAX) {
      this.applyTiming({ bpm }, 'tap');
      $<HTMLInputElement>('#tBpm', this.root).value = String(bpm);
    }
  }

  /* ------------------------------------------------------------------ playback */

  private togglePlay(): void {
    if (this.transport.playing) this.stopPlayback(true);
    else this.startPlayback();
  }

  private startPlayback(): void {
    this.transport.track = this.track;
    this.transport.audioOffsetMs = this.chart.audio?.offsetMs ?? 0;
    this.transport.play(this.roll.view.cursorMs, this.rate);
    this.refreshToolbar();
  }

  /** `pause` keeps the position; otherwise the cursor stays where playback began. */
  private stopPlayback(pause: boolean): void {
    if (this.transport.playing) {
      const pos = this.transport.position();
      this.transport.stop();
      if (pause) this.roll.view.cursorMs = Math.max(0, pos);
    }
    this.roll.view.playMs = null;
    this.roll.requestDraw();
    this.refreshToolbar();
  }

  frame(now: number): void {
    if (this.transport.playing) {
      const pos = this.transport.frame(now, this.chart);
      if (pos === null) {
        this.roll.view.playMs = null;
        this.refreshToolbar();
      } else {
        this.roll.view.playMs = pos;
        this.roll.follow(pos);
      }
    }
    this.roll.frame();
  }

  /* ------------------------------------------------------------------ keys */

  /** Returns true when the key was used (the caller prevents default). */
  handleKey(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (this.proceed) this.hideConfirm();
      else if (typing) (t as HTMLElement).blur();
      else {
        for (const d of $$<HTMLDetailsElement>('details[open]', this.root)) d.open = false;
        this.selection.clear();
        this.selectionChanged();
        this.roll.requestDraw();
      }
      return true;
    }
    if (mod && e.key.toLowerCase() === 's') {
      this.save();
      return true;
    }
    if (typing) return false;
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.doRedo();
      else this.doUndo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.doRedo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      this.selectAll();
      return true;
    }
    if (mod) return false;
    const v = this.roll.view;
    const first = this.chart.notes.find((n) => this.selection.has(n.id));
    const step = v.snap === 'off' ? 10 : snapStepMs(this.chart, first?.startMs ?? v.cursorMs, v.snap);
    switch (e.key) {
      case ' ':
        this.togglePlay();
        return true;
      case 'Delete':
      case 'Backspace':
        if (this.selection.size) this.deleteSelection();
        return true;
      case 'ArrowLeft':
        this.nudge(-(e.shiftKey ? step * 4 : step), 0, 'nudge-t');
        return true;
      case 'ArrowRight':
        this.nudge(e.shiftKey ? step * 4 : step, 0, 'nudge-t');
        return true;
      case 'ArrowUp':
        this.nudge(0, e.shiftKey ? 12 : 1, 'nudge-p');
        return true;
      case 'ArrowDown':
        this.nudge(0, e.shiftKey ? -12 : -1, 'nudge-p');
        return true;
      case '1':
        this.setSelectionHand('R');
        return true;
      case '2':
        this.setSelectionHand('L');
        return true;
      case 'Home':
        this.seek(0);
        return true;
      case 'End':
        this.seek(this.chart.meta.durationMs);
        return true;
      case '+':
      case '=':
        this.zoom(1.25);
        return true;
      case '-':
        this.zoom(0.8);
        return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ save / export / close */

  /** Writes the chart to the library. Returns false when nothing could be saved. */
  save(): boolean {
    const title = $<HTMLInputElement>('#edTitle', this.root).value.trim() || this.chart.meta.title || '제목 없음';
    let c: Chart = { ...this.chart, meta: { ...this.chart.meta, title } };
    if (this.builtin) {
      const copyTitle = /\(편집\)$/.test(title) ? title : `${title} (편집)`;
      c = { ...c, meta: { ...c.meta, id: `${c.meta.id}-edit`, title: copyTitle } };
    }
    try {
      c.musicXml = chartToMusicXml(c);
    } catch {
      delete c.musicXml;
    }
    const { song, persisted } = this.builtin || this.isNew ? addUserChart(c) : saveUserChart(c);
    this.builtin = false;
    this.isNew = false;
    this.songId = song.id;
    this.chart = { ...c, meta: { ...c.meta, id: song.id } };
    this.undo.reset(this.chart);
    this.dirtyFlag = false;
    this.coalesceKey = null;
    $<HTMLInputElement>('#edTitle', this.root).value = this.chart.meta.title;
    if (location.hash !== '#edit/' + song.id) location.hash = '#edit/' + song.id;
    toast(persisted ? `'${this.chart.meta.title}'을(를) 저장했어요.` : `저장 공간이 부족해서 '${this.chart.meta.title}'은(는) 이번 접속에서만 유지돼요.`, 3600);
    this.deps.saved(song.id);
    this.refreshAll();
    return true;
  }

  private exportMidi(): void {
    const bytes = chartToMidiBytes(this.chart);
    download(`${safeName(this.chart.meta.title)}.mid`, new Blob([new Uint8Array(bytes)], { type: 'audio/midi' }));
    toast('MIDI 파일을 내려받아요.');
  }

  private exportXml(): void {
    download(`${safeName(this.chart.meta.title)}.musicxml`, new Blob([chartToMusicXml(this.chart)], { type: 'application/vnd.recordare.musicxml+xml' }));
    toast('MusicXML 파일을 내려받아요.');
  }

  requestClose(): void {
    if (!this.dirty) return this.deps.close();
    this.showConfirm(() => this.deps.close());
  }

  /** The router wants to go to `targetHash` while there are unsaved changes. */
  askLeave(targetHash: string): void {
    this.showConfirm(() => {
      this.leaving = true;
      location.hash = targetHash;
    });
  }

  private showConfirm(proceed: () => void): void {
    this.proceed = proceed;
    $('#edConfirm', this.root).hidden = false;
    $<HTMLButtonElement>('#cSave', this.root).focus();
  }
  private hideConfirm(): void {
    this.proceed = null;
    $('#edConfirm', this.root).hidden = true;
  }
  private runProceed(): void {
    const p = this.proceed;
    this.hideConfirm();
    p?.();
  }

  private toggleSheet(open?: boolean): void {
    const side = $('#edSide', this.root);
    const next = open ?? !side.classList.contains('open');
    side.classList.toggle('open', next);
    $('#edSheet', this.root).setAttribute('aria-expanded', String(next));
  }

  /* ------------------------------------------------------------------ panels */

  private refreshAll(): void {
    this.refreshToolbar();
    this.refreshTiming();
    this.refreshInfo();
  }

  private refreshToolbar(): void {
    const r = this.root;
    $<HTMLButtonElement>('#edUndo', r).disabled = !this.undo.canUndo;
    $<HTMLButtonElement>('#edRedo', r).disabled = !this.undo.canRedo;
    $('#edPlay', r).innerHTML = this.transport.playing ? '❚❚<span class="ed-lbl"> 일시정지</span>' : '▶<span class="ed-lbl"> 재생</span>';
    for (const b of $$<HTMLElement>('#edRate [data-rate]', r)) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === this.rate));
    for (const b of $$<HTMLElement>('#edTool [data-tool]', r)) b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
    for (const b of $$<HTMLElement>('#edHand [data-hand]', r)) {
      const sel = this.chart.notes.filter((n) => this.selection.has(n.id));
      const all = sel.length > 0 && sel.every((n) => n.hand === b.dataset.hand);
      b.setAttribute('aria-pressed', String(sel.length ? all : this.hand === b.dataset.hand));
    }
    const has = this.selection.size > 0;
    $<HTMLButtonElement>('#edDelete', r).disabled = !has;
    $<HTMLButtonElement>('#edSave', r).textContent = this.dirtyFlag ? '저장 •' : '저장';
    $('#edAudioCtl', r).hidden = !this.chart.audio;
  }

  private refreshTiming(): void {
    const r = this.root;
    const spec = timingOf(this.chart);
    const bpm = $<HTMLInputElement>('#tBpm', r);
    if (document.activeElement !== bpm) bpm.value = String(Math.round(spec.bpm * 10) / 10);
    const ts = $<HTMLSelectElement>('#tTs', r);
    const tsv = `${spec.timeSignature[0]}/${spec.timeSignature[1]}`;
    if (![...ts.options].some((o) => o.value === tsv)) ts.add(new Option(tsv, tsv));
    ts.value = tsv;
    const off = $<HTMLInputElement>('#tOff', r);
    if (document.activeElement !== off) off.value = String(Math.round(spec.offsetMs));
    $('#tTempoNote', r).hidden = hasConstantTempo(this.chart);
    const a = this.chart.audio;
    $('#tAudio', r).hidden = !a;
    if (a) {
      const ao = $<HTMLInputElement>('#tAOff', r);
      if (document.activeElement !== ao) ao.value = String(Math.round(a.offsetMs));
    }
  }

  private refreshInfo(): void {
    const r = this.root;
    const c = this.chart;
    const R = c.notes.filter((n) => n.hand === 'R').length;
    const L = c.notes.length - R;
    const pickup = timingOf(c).offsetMs > 0 && c.measures.length > 1;
    const bars = c.measures.length - (pickup ? 1 : 0);
    $('#iFacts', r).innerHTML = [
      ['오른손', `${R}음`],
      ['왼손', `${L}음`],
      ['마디', `${bars}마디${pickup ? ' + 못갖춘' : ''}`],
      ['길이', fmtTime(c.meta.durationMs)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    const sel = c.notes.filter((n) => this.selection.has(n.id));
    const el = $('#iSel', r);
    if (!sel.length) {
      el.innerHTML = '<p class="ed-hint">노트를 클릭하거나 드래그해 선택하세요. 연필 도구로 빈 칸을 클릭하면 노트가 생기고, 끌면 길이가 정해져요.</p>';
      return;
    }
    const vel = sel.every((n) => n.velocity === sel[0].velocity) ? sel[0].velocity : null;
    const velRow = `<div class="ed-vel"><label for="iVel">세기</label><input type="range" id="iVel" min="1" max="127" value="${vel ?? 80}" aria-label="세기"><input class="inp" id="iVelN" type="number" min="1" max="127" value="${vel ?? ''}" placeholder="—"></div>`;
    if (sel.length === 1) {
      const n = sel[0];
      el.innerHTML = `<dl class="ed-facts one">
        <div><dt>음</dt><dd>${noteName(n.midi)} <small>${esc(nKo(n.midi))}</small></dd></div>
        <div><dt>손</dt><dd>${n.hand === 'R' ? '오른손' : '왼손'}</dd></div>
        <div><dt>시작</dt><dd>${fmtMs(n.startMs)}</dd></div>
        <div><dt>위치</dt><dd>${esc(beatLabel(c, n))}</dd></div>
        <div><dt>길이</dt><dd>${fmtMs(n.durationMs)}</dd></div>
      </dl>${velRow}`;
    } else {
      const lo = Math.min(...sel.map((n) => n.midi));
      const hi = Math.max(...sel.map((n) => n.midi));
      const rs = sel.filter((n) => n.hand === 'R').length;
      el.innerHTML = `<dl class="ed-facts one">
        <div><dt>선택</dt><dd>${sel.length}개</dd></div>
        <div><dt>손</dt><dd>오른손 ${rs} · 왼손 ${sel.length - rs}</dd></div>
        <div><dt>음역</dt><dd>${noteName(lo)}–${noteName(hi)}</dd></div>
        <div><dt>시작</dt><dd>${fmtMs(sel[0].startMs)} ~</dd></div>
      </dl>${velRow}`;
    }
  }
}
