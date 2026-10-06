/**
 * Play screen controller. The flow is a small phase machine (see phase.ts):
 *
 *   준비 (ready + attract demo) → count-in → 연주 중 (focus) ⇄ 일시정지 → end card → result
 *
 * Judging is the engine's Session; this module owns the clock, the auto-player, the
 * feedback (focus HUD, judgment pop, sheet marks, highway FX), the ready card and the
 * pause menu. While a run is on, the app chrome steps aside (`.app.focus`).
 */
import { synth } from '../audio/synth';
import type { Chart } from '../core/chart';
import { Session, type JudgeEvent, type Judgment, type SessionNote } from '../core/engine';
import type { InputHub, NoteInput } from '../input/hub';
import { Highway } from '../render/highway';
import { LANE_HUE, fitKeyRange } from '../render/lanes';
import { SheetView } from '../render/sheet';
import { beatAt, hasPickup } from '../render/sheet-map';
import { getSong, songs, type LibrarySong } from '../state/library';
import { getBest, saveLastResult, submitBest, type PlanItem, type ResultData } from '../state/records';
import { HANDS_KO, settings, updateSettings, type Settings } from '../state/settings';
import { SongClock, beatGrid, countInBeatMs, type Beat } from './clock';
import { liveCoach } from './coach';
import { planAuto, type AutoPlan } from './demo';
import { $, $$, ICON, esc, reducedMotion, restartAnim, toast } from './dom';
import { barNo, clamp, commas, keyHint, nKo, scoreHTML, signed } from './format';
import { AutoHide, READY, comboMilestone, isFocus, isRunning, keyStartAllowed, nextPhase, resumeSchedule, type PhaseAction, type PhaseState } from './phase';
import { PianoKeys } from './piano-keys';
import { playTemplate } from './play-view';
import { summarize } from './summary';

const JTXT: Record<string, string> = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS', wrong: 'WRONG', ok: '정답', okw: '다시 쳐서 정답' };
const COUNT_ROWS = {
  normal: [['perfect', 'PERFECT'], ['great', 'GREAT'], ['good', 'GOOD'], ['miss', 'MISS'], ['wrong', 'WRONG']],
  wait: [['ok', '정답'], ['okw', '다시 쳐서'], ['wrong', '틀린 건반']],
} as const;
const WIDE = typeof matchMedia === 'function' ? matchMedia('(min-width: 980px)') : null;
/** Settings that define the run itself: changing one discards a suspended run. */
const RUN_KEYS: (keyof Settings)[] = ['rate', 'hands', 'wait', 'loop'];

type PauseReason = 'user' | 'hidden' | 'blur' | 'midi' | 'fullscreen';

export interface PlayDeps {
  hub: InputHub;
  isActive(): boolean;
  /** Called with the result of a finished (non-loop) run. */
  onFinish(r: ResultData, newBest: boolean): void;
  /** A loop pass finished: the result tab should show it. */
  onPass(r: ResultData): void;
}

export class PlayScreen {
  private root: HTMLElement;
  private deps: PlayDeps;
  private hw!: Highway;
  private sheet!: SheetView;
  private keys!: PianoKeys;
  private el!: Record<string, HTMLElement>;
  song: LibrarySong | null = null;
  chart: Chart | null = null;
  private pickup = false;
  private session: Session | null = null;
  private mode: 'attract' | 'play' = 'attract';
  private ps: PhaseState = READY;
  private clock = new SongClock();
  private beats: Beat[] = [];
  private beatIdx = 0;
  private waiting = false;
  private waitSince = 0;
  private finishAt = 0;
  private plans = new Map<SessionNote, AutoPlan>();
  private fired = new Set<SessionNote>();
  private wrongFired = new Set<SessionNote>();
  private auto = false;
  private autoRel: { m: number; at: number; sound: boolean }[] = [];
  private passes: ResultData[] = [];
  private hinted = false;
  private lastWrong: { midi: number; measure: number; intended: number | null; at: number } | null = null;
  private disp = 0;
  private lastSv = -1;
  private fever = 0;
  private life = 100;
  private lastHue = LANE_HUE[4];
  private sheetTimer = 0;
  private readySince = 0;
  private wake = new AutoHide(2000);
  private awake = false;
  private resumeSt: { ticks: { at: number; label: string }[]; end: number } | null = null;
  private pauseReason: PauseReason | null = null;
  private midiLost = false;
  private hadMidi = false;
  private wantFs = false;
  private measTxt = '';
  private hintTxt = '';

  constructor(root: HTMLElement, deps: PlayDeps) {
    this.root = root;
    this.deps = deps;
  }

  mount(): void {
    this.root.innerHTML = playTemplate();
    this.root.classList.add('play');
    this.root.tabIndex = -1;
    const ids = ['fhud', 'prog', 'btnPause', 'fMeas', 'fLoop', 'fTag', 'score', 'accMini', 'view', 'meters', 'lifeM', 'feverM', 'hudL', 'acc', 'maxc',
      'hudCounts', 'scorePanel', 'sheetWrap', 'sheetHost', 'stage', 'hw', 'combo', 'comboN', 'judge', 'fs', 'big', 'whint', 'keysWrap', 'keys',
      'ready', 'btnFs', 'rdTitle', 'rdComp', 'rdFacts', 'rdBest', 'rdDev', 'btnStart', 'btnStartT', 'btnFresh', 'rdHint', 'waitNote', 'abRow',
      'loopA', 'loopB', 'more', 'moreSum', 'optMetro', 'optAuto', 'optKeyStart', 'optSoundKeys', 'optSoundMidi', 'offset', 'offsetVal',
      'pmenu', 'pmAlert', 'pmSub', 'pmAcc', 'pmCombo', 'pmScore', 'pmCounts', 'coachLive', 'pmResume', 'pmRestart', 'pmSettings', 'pmExit', 'announce'];
    this.el = Object.fromEntries(ids.map((id) => [id, $('#' + id, this.root)]));
    this.hw = new Highway(this.el.hw as HTMLCanvasElement);
    this.sheet = new SheetView(this.el.sheetHost, { scroller: this.el.sheetWrap, zoomFor: (w) => this.sheetZoom(w) });
    this.sheet.onRendered = () => {
      this.sizeSheet();
      this.refreshSheet();
    };
    this.keys = new PianoKeys(this.el.keys);
    this.keys.onPress = (type, m, time) => {
      synth.unlock();
      this.deps.hub.pointer(type, m, time);
    };
    this.bindControls();
    this.el.view.dataset.view = settings.view;
    if (typeof ResizeObserver !== 'undefined') {
      let rz = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(rz);
        rz = requestAnimationFrame(() => this.onResize());
      });
      [this.el.view, this.el.stage, this.el.scorePanel].forEach((e) => ro.observe(e));
    } else window.addEventListener('resize', () => this.onResize());
    WIDE?.addEventListener?.('change', () => this.layout());

    // auto-pause: tab hidden, window blur, leaving fullscreen, MIDI keyboard unplugged
    document.addEventListener('visibilitychange', () => document.hidden && this.pause('hidden'));
    window.addEventListener('blur', () => this.pause('blur'));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) {
        if (isRunning(this.ps.phase)) this.pause('fullscreen');
        else if (this.ps.phase === 'ready') this.wantFs = false;
      }
      this.syncFs();
    });
    const midi = this.deps.hub.midi;
    this.hadMidi = !!midi.primaryName;
    midi.onChange(() => this.midiChanged());

    // wake the pause button and cursor on movement
    const poke = () => this.poke();
    for (const ev of ['pointermove', 'pointerdown', 'wheel'] as const) this.root.addEventListener(ev, poke, { passive: true });
    this.syncFs();
    this.renderPhase();
  }

  /* ------------------------------------------------------------ phases */

  get phase(): PhaseState['phase'] {
    return this.ps.phase;
  }

  private setPhase(a: PhaseAction): boolean {
    const next = nextPhase(this.ps, a);
    if (next === this.ps) return false;
    this.ps = next;
    this.renderPhase();
    return true;
  }

  private renderPhase(): void {
    const { phase, suspended } = this.ps;
    const r = this.root;
    const was = r.dataset.phase;
    r.dataset.phase = phase;
    r.classList.toggle('suspended', suspended);
    this.el.pmenu.hidden = phase !== 'paused';
    this.el.ready.inert = phase !== 'ready';
    this.el.ready.setAttribute('aria-hidden', String(phase !== 'ready'));
    this.el.fhud.inert = phase === 'ready' || phase === 'paused';
    this.applyFocus();
    if (phase === 'ready') {
      this.readySince = performance.now();
      this.renderReady();
      if (was && was !== 'ready' && this.deps.isActive()) (this.el.btnStart as HTMLButtonElement).focus({ preventScroll: true });
    } else if (phase === 'paused') {
      this.renderPause();
      if (this.deps.isActive()) (this.el.pmResume as HTMLButtonElement).focus({ preventScroll: true });
    } else if (was === 'ready' || was === 'paused') {
      // take focus off the card/menu buttons so Space pauses instead of re-clicking them
      const a = document.activeElement as HTMLElement | null;
      if (a && r.contains(a) && a !== r) r.focus({ preventScroll: true });
    }
    if (phase !== 'playing') this.setHint('');
    else if (reducedMotion() && !this.el.big.classList.contains('fin')) this.el.big.className = 'big'; // the count-in number does not fade by itself
  }

  /** Hide the app top bar while a run is on (only while the play screen is showing). */
  private applyFocus(): void {
    const app = document.getElementById('app');
    if (!app) return;
    const on = this.deps.isActive() && isFocus(this.ps.phase);
    if (on === app.classList.contains('focus')) return;
    const bar = app.querySelector<HTMLElement>('.topbar');
    if (bar && on) app.style.setProperty('--tb-h', bar.offsetHeight + 'px');
    app.classList.toggle('focus', on);
  }

  private poke(): void {
    this.wake.poke(performance.now());
  }

  /** The main action on the ready screen: start, or continue a suspended run. */
  primary(): void {
    if (this.ps.phase !== 'ready') return;
    if (this.ps.suspended) this.resume();
    else this.startPlay();
  }

  pause(reason: PauseReason = 'user'): void {
    if (!isRunning(this.ps.phase)) return;
    this.clock.pause();
    this.resumeSt = null;
    this.releaseAll();
    this.pauseReason = reason;
    this.setPhase('pause');
    this.announce(reason === 'midi' ? '건반 연결이 끊겨 일시정지했어요' : '일시정지');
  }

  resume(): void {
    if (!this.setPhase('resume')) return;
    synth.unlock();
    this.pauseReason = null;
    this.auto = this.auto || settings.autoplay;
    this.enterFs();
    const s = this.session!;
    this.resumeSt = resumeSchedule(performance.now(), this.quarterMs(), s.opts.wait);
    if (!this.resumeSt.ticks.length) this.finishResume();
  }

  private finishResume(): void {
    this.resumeSt = null;
    const d = this.clock.resume();
    if (this.finishAt) this.finishAt += d;
    if (this.waiting) this.waitSince = performance.now();
  }

  /** 설정 바꾸기: back to the ready card, the paused run kept aside. */
  private toSettings(): void {
    this.setPhase('settings');
  }

  /** 곡 나가기: drop the run and go back to the song list. */
  private exitSong(): void {
    this.passes = [];
    this.startAttract(true);
    location.hash = '#home';
  }

  /* ------------------------------------------------------------ song + session */

  setSong(id: string | null, quiet = false): void {
    const list = songs();
    let song = getSong(id) ?? list[0];
    let chart: Chart | null = null;
    for (const s of [song, ...list]) {
      try {
        chart = s.load();
        song = s;
        break;
      } catch (e) {
        console.warn('song load failed', s.id, e);
        if (!quiet) toast(`'${s.title}'을(를) 불러오지 못했어요.`);
      }
    }
    if (!chart) return;
    this.song = song;
    this.chart = chart;
    this.pickup = hasPickup(chart);
    const bars = chart.measures.length;
    const lp = settings.loop;
    const from = clamp(lp.from, 0, bars - 1);
    const to = clamp(Math.max(from, lp.to), from, bars - 1);
    updateSettings({ songId: song.id, loop: { on: lp.on && bars > 1, from, to } });
    const opts = Array.from({ length: bars }, (_, i) => `<option value="${i}">${barNo(i, this.pickup)}</option>`).join('');
    this.el.loopA.innerHTML = opts;
    this.el.loopB.innerHTML = opts;
    this.buildRange();
    this.sheet.setLoop(settings.loop.on ? { from: settings.loop.from, to: settings.loop.to } : null);
    void this.sheet.show(chart).then((ok) => {
      if (!ok) this.sizeSheet();
    });
    this.passes = [];
    this.startAttract(false);
  }

  private activeNotes() {
    const h = settings.hands;
    return this.chart!.notes.filter((n) => h === 'B' || n.hand === h);
  }

  private buildRange(): void {
    if (!this.chart) return;
    let notes = this.activeNotes();
    if (!notes.length) notes = this.chart.notes;
    const [lo, hi] = fitKeyRange(notes.map((n) => n.midi));
    this.keys.build(lo, hi);
    this.hw.setLanes(this.keys.layout);
    this.layout();
  }

  private newSession(): Session {
    const chart = this.chart!;
    if (settings.hands !== 'B' && !this.activeNotes().length) {
      toast(`이 곡에는 ${HANDS_KO[settings.hands]} 파트가 없어서 양손으로 바꿨어요.`);
      updateSettings({ hands: 'B' });
      this.buildRange();
    }
    const lp = settings.loop;
    return new Session(chart, {
      hands: settings.hands,
      rate: settings.rate,
      wait: settings.wait,
      loop: lp.on ? { from: lp.from, to: lp.to } : undefined,
    });
  }

  private quarterMs(): number {
    return countInBeatMs(this.chart!, settings.rate, settings.loop.on ? settings.loop.from : 0);
  }

  /** The muted attract demo behind the ready card (also: drop whatever run was on). */
  startAttract(fromTop: boolean): void {
    if (!this.chart) return;
    this.mode = 'attract';
    this.finishAt = 0;
    this.waiting = false;
    this.resumeSt = null;
    this.pauseReason = null;
    this.releaseAll();
    const s = (this.session = this.newSession());
    this.auto = true;
    const { plans, fumble } = planAuto(s.notes, 'demo', Math.random, (m) => this.keys.has(m));
    this.plans = plans;
    this.fired.clear();
    this.wrongFired.clear();
    this.lastWrong = null;
    this.fever = 0;
    this.life = 100;
    let start = s.startT - 1200;
    if (!fromTop && !s.opts.wait && fumble) {
      // open mid-phrase so the first frame already has coloured noteheads, a ghost, combo and score
      start = clamp(fumble.t + this.quarterMs() * 1.6, s.startT, Math.max(s.startT, s.endT - 1500));
      const evs: [number, number][] = [];
      for (const n of s.notes) {
        const p = plans.get(n)!;
        if (p.wrong && n.t + p.wrong.dt < start) {
          this.wrongFired.add(n);
          evs.push([n.t + p.wrong.dt, p.wrong.midi]);
        }
        if (!p.miss && n.t + p.err < start) {
          this.fired.add(n);
          evs.push([n.t + p.err, n.note.midi]);
        }
      }
      evs.sort((a, b) => a[0] - b[0]).forEach(([t, m]) => this.applyMeters(s.press(m, t)));
      for (const ev of s.update(start)) this.applyMeters(ev);
      const w = s.wrongs[s.wrongs.length - 1];
      if (w) this.lastWrong = { midi: w.midi, measure: w.measure, intended: w.intended, at: performance.now() };
    }
    this.clock.start(start);
    this.beats = beatGrid(this.chart, settings.rate, s.startT);
    this.beatIdx = this.beats.findIndex((b) => b.t > start);
    if (this.beatIdx < 0) this.beatIdx = this.beats.length;
    this.disp = s.score;
    this.hw.clearFx();
    this.setCombo(s.combo, false);
    this.ps.phase === 'ready' && !this.ps.suspended ? this.renderReady() : this.setPhase('reset');
    this.afterStart();
  }

  startPlay(keepPasses = false): void {
    if (!this.chart) return;
    synth.unlock();
    this.releaseAll();
    this.mode = 'play';
    this.finishAt = 0;
    this.waiting = false;
    this.resumeSt = null;
    this.pauseReason = null;
    this.hinted = true;
    if (!keepPasses) this.passes = [];
    const s = (this.session = this.newSession());
    this.auto = settings.autoplay;
    this.plans = planAuto(s.notes, 'perfect').plans;
    this.fired.clear();
    this.wrongFired.clear();
    this.lastWrong = null;
    this.fever = 0;
    this.life = 100;
    this.clock.start(s.startT - 4 * this.quarterMs());
    this.beats = beatGrid(this.chart, settings.rate, s.startT);
    this.beatIdx = 0;
    this.disp = 0;
    this.lastSv = -1;
    this.hw.clearFx();
    this.el.judge.className = 'judge';
    this.el.fs.className = 'fs';
    this.el.big.className = 'big';
    this.setCombo(0, false);
    if (!this.deps.isActive()) location.hash = '#play';
    this.ps = nextPhase(isRunning(this.ps.phase) ? READY : this.ps, 'start');
    this.renderPhase();
    this.afterStart();
    this.enterFs();
  }

  private afterStart(): void {
    this.buildCounts(settings.wait);
    this.syncUI();
    this.refreshSheet();
  }

  /** Start a practice plan item (from home or the result screen): straight to the count-in. */
  applyPlan(p: Pick<PlanItem, 'songId' | 'hands' | 'rate' | 'wait' | 'loop'>): void {
    if (p.songId && p.songId !== this.song?.id) this.setSong(p.songId);
    updateSettings({
      hands: p.hands,
      rate: p.rate,
      wait: !!p.wait,
      loop: p.loop ? { on: true, from: p.loop.from, to: p.loop.to } : { on: false },
    } as Partial<Settings>);
    this.afterSettings();
    this.startPlay();
  }

  /** Song + settings, landing on the ready card (attract demo behind it). */
  prepare(songId: string, patch: Partial<Settings> = {}): void {
    if (songId !== this.song?.id) this.setSong(songId);
    updateSettings(patch);
    this.afterSettings();
    this.passes = [];
    this.startAttract(true);
  }

  private afterSettings(): void {
    this.buildRange();
    this.sheet.setLoop(settings.loop.on ? { from: settings.loop.from, to: settings.loop.to } : null);
  }

  /** A choice on the ready card. Run settings restart the demo and drop a suspended run. */
  private applySettings(patch: Partial<Settings>): void {
    updateSettings(patch);
    if (Object.keys(patch).some((k) => RUN_KEYS.includes(k as keyof Settings))) {
      this.afterSettings();
      const dropped = this.ps.suspended;
      this.setPhase('invalidate');
      this.passes = [];
      this.startAttract(true);
      if (dropped) toast('연주 설정이 바뀌어서 처음부터 시작해요.');
    } else this.syncUI();
  }

  /* ------------------------------------------------------------ input */

  onInput(e: NoteInput): void {
    if (!this.deps.isActive()) return;
    const m = e.midi;
    const now = performance.now();
    if (e.type === 'on') this.poke();
    if (e.type === 'on' && e.source === 'midi' && this.ps.phase === 'ready' && settings.keyStart && keyStartAllowed(now, this.readySince)) {
      // 건반을 누르면 시작: this press only starts the run, it is not judged
      this.primary();
      if (this.keys.has(m)) this.keys.down(m);
      return;
    }
    if (!this.keys.has(m)) return; // outside the shown keyboard: sound only
    if (e.type === 'off') {
      this.keys.up(m);
      return;
    }
    this.keys.down(m);
    this.hw.flash(m, false);
    const s = this.session;
    if (this.mode === 'play' && !this.clock.paused && s) {
      let t = this.clock.inputTime(e.time, settings.offset);
      if (s.opts.wait && this.waiting && s.gate !== null) t = Math.max(t, s.gate); // held at the gate: a press is "now"
      this.handle(s.press(m, t));
    } else if (this.mode === 'attract' && !this.hinted) {
      this.hinted = true;
      toast('지금은 미리 보기예요. 시작을 누르면 판정이 시작돼요.');
    }
  }

  handleKey(e: KeyboardEvent): boolean {
    const space = e.code === 'Space' || e.key === ' ';
    const enter = e.key === 'Enter';
    const esc = e.key === 'Escape';
    if (!space && !enter && !esc) return false;
    const t = e.target as Element | null;
    const onControl = !!t?.closest?.('button,a,select,input,textarea,summary,[contenteditable="true"]');
    const p = this.ps.phase;
    if (p === 'ready') {
      if (esc || onControl) return false;
      if (!e.repeat) this.primary();
      return true;
    }
    if (isRunning(p)) {
      if (enter || (space && onControl)) return false;
      if (!e.repeat) this.pause('user');
      return true;
    }
    if (p === 'paused') {
      if (enter || (space && onControl)) return false;
      if (!e.repeat) this.resume();
      return true;
    }
    return space; // end card: just keep Space from scrolling
  }

  private releaseAll(): void {
    this.keys?.releaseAll();
    this.autoRel.length = 0;
    synth.allOff();
  }

  private midiChanged(): void {
    const name = this.deps.hub.midi.primaryName;
    if (!name && this.hadMidi) {
      this.midiLost = true;
      if (isRunning(this.ps.phase)) this.pause('midi');
      else if (this.ps.phase === 'paused') {
        this.pauseReason = 'midi';
        this.renderPause();
      }
    } else if (name && this.midiLost) {
      this.midiLost = false;
      if (this.ps.phase === 'paused') this.renderPause();
    }
    this.hadMidi = !!name;
    if (this.ps.phase === 'ready') this.renderReady();
  }

  /* ------------------------------------------------------------ fullscreen */

  private async toggleFs(): Promise<void> {
    const d = document;
    if (!d.fullscreenEnabled) return;
    try {
      if (d.fullscreenElement) {
        this.wantFs = false;
        await d.exitFullscreen();
      } else {
        this.wantFs = true;
        await d.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      this.wantFs = false;
      toast('전체 화면으로 바꾸지 못했어요. 브라우저가 막았을 수 있어요.');
    }
    this.syncFs();
  }

  /** Re-enter fullscreen at start/resume when the player chose it this session. */
  private enterFs(): void {
    if (!this.wantFs || document.fullscreenElement || !document.fullscreenEnabled) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  }

  private syncFs(): void {
    const b = this.el.btnFs;
    const ok = typeof document !== 'undefined' && !!document.fullscreenEnabled;
    b.hidden = !ok;
    const on = !!document.fullscreenElement;
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = (on ? ICON.fullExit : ICON.full) + `<span>${on ? '전체 화면 끄기' : '전체 화면'}</span>`;
  }

  /* ------------------------------------------------------------ frame loop */

  frame(now: number, dt: number): void {
    for (let i = this.autoRel.length - 1; i >= 0; i--) {
      const r = this.autoRel[i];
      if (now >= r.at) {
        this.keys.up(r.m);
        if (r.sound) synth.noteOff(r.m);
        this.autoRel.splice(i, 1);
      }
    }
    const s = this.session;
    if (!s) return;
    if (this.resumeSt) this.resumeStep(now);
    if (!this.clock.paused) this.step(now);
    const t = this.clock.time(now);
    if (this.ps.phase === 'countin' && !this.clock.paused && t >= s.startT) this.setPhase('go');
    const meters = this.metersOn();
    if (settings.view !== 'sheet') {
      this.hw.render({
        t, now, dt, notes: s.notes, beats: this.beats, startT: s.startT, endT: s.endT, loop: !!s.opts.loop, wait: s.opts.wait,
        waiting: this.waiting, gate: s.gate, live: !this.clock.paused && !this.waiting && t > s.startT - 4 * this.quarterMs(),
        fever: meters && this.fever >= 1, danger: meters && this.mode === 'play' && this.life < 30, hue: this.lastHue,
        measures: this.chart!.measures.length, pickup: this.pickup,
      });
    }
    if (settings.view !== 'hw') this.updatePlayhead(t);
    this.hud(t, dt);
    const ph = this.ps.phase;
    const awake = ph === 'playing' || ph === 'countin' ? this.wake.awake(now) : ph !== 'ended';
    if (awake !== this.awake) {
      this.awake = awake;
      this.root.classList.toggle('awake', awake);
    }
  }

  private resumeStep(now: number): void {
    const r = this.resumeSt!;
    while (r.ticks.length && now >= r.ticks[0].at) {
      const tk = r.ticks.shift()!;
      synth.tick(tk.label === '3');
      this.showBig(tk.label, false);
    }
    if (now >= r.end) this.finishResume();
  }

  private step(now: number): void {
    const s = this.session!;
    let t = this.clock.time(now);
    if (s.opts.wait) {
      const g = s.gate;
      if (this.clock.hold(g, now)) {
        t = g!;
        if (!this.waiting) {
          this.waiting = true;
          this.waitSince = now;
          this.markNext();
        }
      } else if (this.waiting) {
        this.waiting = false;
        this.setHint('');
      }
    }
    if (this.mode === 'play') this.beatsUpTo(t, s);
    if (this.mode === 'attract' || this.auto) this.autoStep(now, t, s);
    if (!s.opts.wait) for (const ev of s.update(t)) this.handle(ev);
    if (this.mode === 'attract') {
      if (t > s.endT + 1600) this.startAttract(true);
      return;
    }
    if (s.done && !this.finishAt) {
      if (this.ps.phase === 'countin') this.setPhase('go');
      this.setPhase('finish');
      if (s.opts.loop) {
        this.finishAt = now + 1500;
        const prev = this.passes[this.passes.length - 1];
        this.showBig(`${this.passes.length + 1}회째 끝`, true, `정확도 ${s.accuracy.toFixed(1)}%${prev ? ` · 지난 회차 ${prev.acc.toFixed(1)}%` : ''}`);
      } else {
        this.finishAt = now + 1700;
        const top = s.opts.wait ? s.counts.ok : s.counts.perfect;
        const pp = top === s.total && !s.counts.wrong;
        const fc = !s.counts.miss && !s.counts.wrong;
        const title = pp ? 'PERFECT PLAY' : fc ? 'FULL COMBO' : 'CLEAR';
        this.showBig(title, true, `${commas(s.score)}점 · 정확도 ${s.accuracy.toFixed(1)}%`);
        this.announce(`${title}. ${commas(s.score)}점`);
      }
    }
    if (this.finishAt && now >= this.finishAt) {
      if (s.opts.loop) this.nextPass();
      else this.finish();
    }
  }

  /** Count-in ticks (big 4-3-2-1) and the metronome, scheduled a few ms ahead on the audio clock. */
  private beatsUpTo(t: number, s: Session): void {
    const ahead = s.opts.wait ? 0 : 30;
    while (this.beatIdx < this.beats.length && this.beats[this.beatIdx].t <= t + ahead) {
      const b = this.beats[this.beatIdx++];
      const when = synth.ctx ? synth.ctx.currentTime + Math.max(0, b.t - t) / 1000 : undefined;
      if (b.measure < 0) {
        synth.tick(b.bar, when);
        this.showBig(String(-b.measure), false);
      } else if (settings.metro && b.t < s.endT - 1) synth.tick(b.bar, when);
    }
  }

  private autoStep(now: number, t: number, s: Session): void {
    const sound = this.mode === 'play';
    if (s.opts.wait) {
      if (this.waiting && now - this.waitSince > 260) {
        for (const n of s.gateNotes()) {
          if (this.fired.has(n)) continue;
          this.fired.add(n);
          this.autoHit(n.note.midi, n.t, n.dur, sound);
        }
      }
      return;
    }
    for (const n of s.notes) {
      if (n.t > t + 200) break;
      const p = this.plans.get(n);
      if (!p) continue;
      if (this.mode === 'attract' && p.wrong && !this.wrongFired.has(n) && t >= n.t + p.wrong.dt) {
        this.wrongFired.add(n);
        this.autoHit(p.wrong.midi, n.t + p.wrong.dt, 140, false);
      }
      if (n.result || this.fired.has(n) || p.miss) continue;
      const pt = n.t + p.err;
      if (t >= pt) {
        this.fired.add(n);
        this.autoHit(n.note.midi, pt, n.dur, sound);
      }
    }
  }

  private autoHit(m: number, pt: number, dur: number, sound: boolean): void {
    if (this.keys.has(m)) {
      this.keys.down(m);
      this.hw.flash(m, false);
    }
    if (sound) synth.noteOn(m, 0.7);
    this.autoRel.push({ m, at: performance.now() + clamp(dur * 0.8, 110, 480), sound });
    this.handle(this.session!.press(m, pt));
  }

  private nextPass(): void {
    const s = this.session!;
    const R = summarize(s, { songId: this.song!.id, auto: this.auto });
    this.passes.push(R);
    saveLastResult(R);
    this.deps.onPass(R);
    this.startPlay(true);
  }

  private finish(): void {
    const R = summarize(this.session!, { songId: this.song!.id, auto: this.auto });
    const best = submitBest(R);
    saveLastResult(R);
    this.passes = [];
    this.startAttract(true);
    this.deps.onFinish(R, best);
  }

  /* ------------------------------------------------------------ judgment feedback */

  private applyMeters(ev: JudgeEvent | null): void {
    if (!ev) return;
    const j = ev.kind === 'wrong' ? 'wrong' : ev.judgment;
    if (j === 'miss') {
      this.fever = 0;
      this.life = Math.max(0, this.life - 8);
    } else if (j === 'wrong') {
      this.fever = 0;
      this.life = Math.max(0, this.life - 4);
    } else if (j === 'perfect' || j === 'ok') {
      this.fever = Math.min(1, this.fever + 0.125);
      this.life = Math.min(100, this.life + 2);
    } else if (j === 'great') {
      this.fever = Math.max(0, this.fever - 0.25);
      this.life = Math.min(100, this.life + 1);
    } else this.fever = 0;
  }

  private handle(ev: JudgeEvent | null): void {
    if (!ev) return;
    const s = this.session!;
    this.applyMeters(ev);
    if (ev.kind === 'wrong') {
      const w = ev.wrong;
      this.keys.wrong(w.midi);
      this.hw.flash(w.midi, true);
      this.showJudge('wrong');
      this.setCombo(0, false);
      const p = beatAt(this.chart!, settings.rate, w.t);
      this.sheet.ghost(w.midi, w.measure, p.measure === w.measure ? p.beat : 0);
      this.lastWrong = { midi: w.midi, measure: w.measure, intended: w.intended, at: performance.now() };
      return;
    }
    const n = ev.note;
    if (ev.kind === 'miss') {
      this.showJudge('miss');
      this.setCombo(0, false);
      this.sheet.setMark(n.note.id, 'miss');
    } else {
      const j = ev.judgment;
      this.hw.burst(n.note.midi, j === 'ok' ? 'perfect' : j === 'okw' ? 'good' : j);
      this.showJudge(j, s.opts.wait ? undefined : ev.err);
      this.setCombo(s.combo, true);
      if (this.mode === 'play' && comboMilestone(s.combo)) this.announce(`${s.combo} 콤보`);
      this.lastHue = LANE_HUE[n.note.midi % 12];
      this.sheet.setMark(n.note.id, j);
      if (!s.opts.wait && (j === 'great' || j === 'good')) this.sheet.label(n.note.id, ev.err);
      if (settings.view !== 'hw') this.sheet.halo(n.note.id, j);
    }
    this.markNext();
  }

  private markNext(): void {
    const s = this.session;
    if (!s) return;
    const g = s.gateNotes();
    this.sheet.setNext(g.map((n) => n.note.id));
    this.keys.setTargets(s.opts.wait ? g.map((n) => n.note.midi) : []);
    // wait mode: a subtle note-name hint while the music is held at the gate
    if (s.opts.wait && this.mode === 'play' && this.waiting && g.length) {
      this.setHint(`<span>다음</span> ${g.map((n) => `<b>${esc(nKo(n.note.midi))}</b>`).join(' + ')} <em>${esc(g.map((n) => keyHint(n.note.midi)).join(' · '))}</em>`);
    } else if (!this.waiting) this.setHint('');
  }

  private setHint(html: string): void {
    if (html === this.hintTxt) return;
    this.hintTxt = html;
    this.el.whint.innerHTML = html;
    this.el.whint.hidden = !html;
  }

  /** Re-apply the whole session state to the sheet (new run or re-engraving). */
  private refreshSheet(): void {
    const s = this.session;
    if (!s || !this.chart) return;
    this.sheet.clearMarks();
    const inRun = new Set(s.notes.map((n) => n.note.id));
    for (const n of this.chart.notes) if (!inRun.has(n.id)) this.sheet.setMark(n.id, 'off');
    for (const n of s.notes) {
      if (!n.result) continue;
      this.sheet.setMark(n.note.id, n.result);
      if (!s.opts.wait && (n.result === 'great' || n.result === 'good')) this.sheet.label(n.note.id, n.err);
    }
    for (const w of s.wrongs) {
      const p = beatAt(this.chart, settings.rate, w.t);
      this.sheet.ghost(w.midi, w.measure, p.measure === w.measure ? p.beat : 0);
    }
    this.markNext();
    this.updatePlayhead(this.clock.time(), true);
  }

  private updatePlayhead(t: number, instant = false): void {
    const s = this.session;
    if (!s || !this.sheet.ready) return;
    const lead = t < s.startT;
    const p = beatAt(this.chart!, settings.rate, Math.max(t, s.startT));
    this.sheet.playhead(p.measure, p.beat, lead, instant);
  }

  private showJudge(kind: string, err?: number): void {
    const j = this.el.judge;
    const fs = this.el.fs;
    j.textContent = JTXT[kind];
    j.dataset.k = kind;
    restartAnim(j, 'pop');
    if (err !== undefined && Math.abs(err) >= 8) {
      fs.textContent = (err < 0 ? 'FAST ' : 'SLOW ') + signed(Math.round(err)) + 'ms';
      fs.className = 'fs ' + (err < 0 ? 'fast' : 'slow');
      restartAnim(fs, 'pop');
    } else {
      fs.className = 'fs';
      fs.textContent = '';
    }
  }

  private setCombo(n: number, bump: boolean): void {
    const c = this.el.combo;
    this.el.comboN.textContent = String(n);
    c.classList.toggle('off', n < 2);
    if (bump && n >= 2 && !reducedMotion()) restartAnim(c, 'bump');
  }

  /** Count-in numbers and the end card (title + a small line under it). */
  private showBig(text: string, fin: boolean, sub = ''): void {
    const b = this.el.big;
    b.innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '');
    b.className = 'big' + (fin ? ' fin' : '');
    restartAnim(b, 'pop');
  }

  private announce(text: string): void {
    const a = this.el.announce;
    a.textContent = '';
    requestAnimationFrame(() => (a.textContent = text));
  }

  /* ------------------------------------------------------------ HUD */

  /** LIFE/FEVER only where they mean something: timed play of the whole song (or 상세). */
  private metersOn(): boolean {
    return settings.hud === 'detail' || (!settings.wait && !settings.loop.on && !this.auto);
  }

  private buildCounts(wait: boolean): void {
    const key = wait ? 'wait' : 'normal';
    for (const ul of [this.el.hudCounts, this.el.pmCounts]) {
      if (ul.dataset.m === key) continue;
      ul.dataset.m = key;
      ul.innerHTML = COUNT_ROWS[key].map(([k, l]) => `<li data-k="${k}"><span>${l}</span><b>0</b></li>`).join('');
    }
  }

  private fillCounts(ul: HTMLElement): void {
    const s = this.session!;
    for (const li of ul.children) {
      const k = (li as HTMLElement).dataset.k as Judgment | 'wrong';
      const b = li.lastElementChild!;
      const v = String(s.counts[k]);
      if (b.textContent !== v) b.textContent = v;
    }
  }

  /** "3/8": the bar being played over the bars in the song (pickup bar counts as 0). */
  private measureLabel(t: number): string {
    const s = this.session!;
    const bars = this.chart!.measures.length;
    const total = this.pickup ? bars - 1 : bars;
    const m = beatAt(this.chart!, settings.rate, clamp(t, s.startT, Math.max(s.startT, s.endT - 1))).measure;
    return `${this.pickup ? Math.max(0, m) : m + 1}/${total}`;
  }

  private hud(t: number, dt: number): void {
    const s = this.session!;
    const target = s.score;
    this.disp += (target - this.disp) * Math.min(1, dt * 0.01);
    if (Math.abs(target - this.disp) < 2) this.disp = target;
    const sv = Math.round(this.disp);
    if (sv !== this.lastSv) {
      this.lastSv = sv;
      this.el.score.innerHTML = scoreHTML(sv);
    }
    if (this.ps.phase === 'ready') return;
    const acc = s.runningAccuracy.toFixed(2) + '%';
    if (this.el.acc.textContent !== acc) {
      this.el.acc.textContent = acc;
      this.el.accMini.textContent = acc;
    }
    if (settings.hud === 'detail') {
      this.el.maxc.textContent = String(s.maxCombo);
      this.fillCounts(this.el.hudCounts);
    }
    this.el.prog.style.width = clamp((t - s.startT) / Math.max(1, s.endT - s.startT), 0, 1) * 100 + '%';
    const mt = this.measureLabel(t);
    if (mt !== this.measTxt) {
      this.measTxt = mt;
      this.el.fMeas.textContent = mt;
    }
    this.el.lifeM.style.setProperty('--v', String(this.life / 100));
    this.el.feverM.style.setProperty('--v', String(this.fever));
    const meters = this.metersOn();
    this.el.view.classList.toggle('fever', meters && this.fever >= 1);
    this.el.view.classList.toggle('danger', meters && this.mode === 'play' && this.life < 30);
  }

  private renderPause(): void {
    const s = this.session;
    if (!s || !this.song) return;
    const t = this.clock.time();
    const alert = this.el.pmAlert;
    if (this.pauseReason === 'midi') {
      alert.hidden = false;
      alert.classList.toggle('ok', !this.midiLost);
      alert.innerHTML = this.midiLost
        ? '<b>건반 연결이 끊겼어요.</b> 케이블과 전원을 확인해 주세요. PC 키보드로 이어서 칠 수도 있어요. <a href="#device">건반 연결 보기</a>'
        : `<b>건반이 다시 연결됐어요.</b> ${esc(this.deps.hub.midi.primaryName ?? '')} · 계속하기를 누르면 3박 세고 이어서 쳐요.`;
    } else {
      alert.hidden = true;
    }
    const lp = s.opts.loop;
    this.el.pmSub.textContent = [
      this.song.title,
      t >= s.startT ? this.measureLabel(t) + '마디' : '시작 전',
      HANDS_KO[settings.hands],
      '템포 ' + Math.round(settings.rate * 100) + '%',
      lp ? `${barNo(lp.from, this.pickup)}–${barNo(lp.to, this.pickup)}마디 반복` : null,
      s.opts.wait ? '대기 모드' : null,
    ].filter(Boolean).join(' · ');
    const judged = s.judgedCount > 0;
    this.el.pmAcc.textContent = judged ? s.runningAccuracy.toFixed(1) + '%' : '–';
    this.el.pmCombo.innerHTML = `${s.combo}<small> / 최대 ${s.maxCombo}</small>`;
    this.el.pmScore.textContent = commas(s.score);
    this.buildCounts(s.opts.wait);
    this.fillCounts(this.el.pmCounts);
    this.el.coachLive.textContent = this.coachText();
  }

  private renderReady(): void {
    const song = this.song;
    const c = this.chart;
    if (!song || !c) return;
    this.el.rdTitle.textContent = song.title;
    this.el.rdComp.textContent = song.composer || '작곡가 미상';
    const bpm = Math.round(c.meta.bpm * settings.rate);
    const notes = this.activeNotes().length;
    const ts = c.meta.timeSignature.join('/');
    this.el.rdFacts.innerHTML = [
      ['BPM', settings.rate === 1 ? String(bpm) : `${bpm}<small> / ${Math.round(c.meta.bpm)}</small>`],
      ['박자', ts],
      ['레벨', `Lv.${song.level}`],
      ['마디', String(this.pickup ? c.measures.length - 1 : c.measures.length)],
      ['노트', `${notes}<small> ${HANDS_KO[settings.hands]}</small>`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const best = getBest(song.id, settings.hands);
    const noRecord = settings.loop.on ? 'A–B 구간 반복은 최고 기록에 남지 않아요.' : settings.autoplay ? '자동 연주는 최고 기록에 남지 않아요.' : '';
    this.el.rdBest.innerHTML = best
      ? `<span class="lbl">최고 기록 · ${HANDS_KO[settings.hands]}</span><b class="mono">${commas(best.score)}</b><span class="rd-rank" data-r="${esc(best.rank)}">${esc(best.rank)}</span><span class="rd-sub">${best.acc.toFixed(1)}% · 템포 ${Math.round(best.rate * 100)}%</span>${noRecord ? `<em>${noRecord}</em>` : ''}`
      : `<span class="lbl">최고 기록 · ${HANDS_KO[settings.hands]}</span><span class="rd-sub">아직 기록이 없어요. 끝까지 치면 여기에 남아요.</span>${noRecord ? `<em>${noRecord}</em>` : ''}`;
    const midi = this.deps.hub.midi;
    const name = midi.primaryName;
    this.el.rdDev.className = 'rd-dev' + (name ? ' on' : '');
    this.el.rdDev.innerHTML = name
      ? `<i></i><span>MIDI · <b>${esc(name)}</b> 연결됨</span>`
      : `<i></i><span>${midi.status.kind === 'denied' ? 'MIDI가 막혀 있어요' : '건반이 연결되지 않았어요'} · PC 키보드·화면 건반으로도 칠 수 있어요</span> <a href="#device">건반 연결 →</a>`;
    const sus = this.ps.suspended;
    this.el.btnStartT.textContent = sus ? '이어서 하기' : '시작';
    this.el.btnFresh.hidden = !sus;
    const first = this.session?.notes[0];
    const from = settings.loop.on ? settings.loop.from : 0;
    const keysTxt = settings.keyStart && name ? ' 또는 건반을 아무거나 누르면' : '을 누르면';
    this.el.rdHint.innerHTML = sus
      ? `${esc(this.measTxt || '')}마디에서 멈췄어요. <kbd>Space</kbd> <kbd>Enter</kbd>${keysTxt} 3박 세고 이어서 쳐요.`
      : `<kbd>Space</kbd> <kbd>Enter</kbd>${keysTxt} 4박 세고 시작해요.` +
        (first ? ` <span class="rd-first">${barNo(from, this.pickup)}마디부터 · 첫 음 <b>${esc(nKo(first.note.midi))}</b> ${esc(keyHint(first.note.midi))}</span>` : '');
    this.syncUI();
  }

  private syncUI(): void {
    const r = this.root;
    const lp = settings.loop;
    r.dataset.hud = settings.hud;
    r.dataset.meters = String(this.metersOn());
    r.classList.toggle('waitmode', settings.wait);
    const press = (attr: string, v: (b: HTMLElement) => boolean) =>
      $$<HTMLButtonElement>(`button[data-${attr}]`, r).forEach((b) => b.setAttribute('aria-pressed', String(v(b))));
    press('rate', (b) => Number(b.dataset.rate) === settings.rate);
    press('hands', (b) => b.dataset.hands === settings.hands);
    press('view', (b) => b.dataset.view === settings.view);
    press('wait', (b) => (b.dataset.wait === '1') === settings.wait);
    press('loop', (b) => (b.dataset.loop === '1') === lp.on);
    press('hud', (b) => b.dataset.hud === settings.hud);
    this.el.abRow.hidden = !lp.on;
    this.el.waitNote.hidden = !settings.wait;
    const chk = (id: string, v: boolean) => ((this.el[id] as HTMLInputElement).checked = v);
    chk('optMetro', settings.metro);
    chk('optAuto', settings.autoplay);
    chk('optKeyStart', settings.keyStart);
    chk('optSoundKeys', settings.soundKeys);
    chk('optSoundMidi', settings.soundMidi);
    (this.el.loopA as HTMLSelectElement).value = String(lp.from);
    (this.el.loopB as HTMLSelectElement).value = String(lp.to);
    (this.el.offset as HTMLInputElement).value = String(settings.offset);
    this.el.offsetVal.textContent = signed(settings.offset) + ' ms';
    this.el.moreSum.textContent = [
      settings.metro ? '메트로놈' : null,
      settings.autoplay ? '자동 연주' : null,
      settings.offset ? `보정 ${signed(settings.offset)}ms` : null,
      settings.hud === 'detail' ? '상세 HUD' : null,
    ].filter(Boolean).join(' · ');
    // focus HUD pills
    const loopTxt = lp.on ? `${barNo(lp.from, this.pickup)}–${barNo(lp.to, this.pickup)}마디 · ${this.passes.length + 1}회째` : '';
    this.el.fLoop.hidden = !loopTxt;
    this.el.fLoop.textContent = loopTxt;
    const tag = this.auto && this.mode === 'play' ? 'AUTO' : settings.wait ? '대기 모드' : '';
    this.el.fTag.hidden = !tag;
    this.el.fTag.textContent = tag;
  }

  /** External settings change (device screen calibration, result screen offset). */
  settingsUpdated(): void {
    if (this.el) this.syncUI();
  }

  /** Sheet-only view engraves larger; next to the highway it stays compact. */
  private sheetZoom(w: number): number {
    if (settings.view === 'sheet') return w >= 900 ? 1.05 : w >= 600 ? 0.85 : 0.66;
    return w >= 900 ? 0.8 : w >= 600 ? 0.7 : 0.58;
  }

  private setView(v: Settings['view']): void {
    const was = settings.view;
    updateSettings({ view: v });
    this.el.view.dataset.view = v;
    this.syncUI();
    requestAnimationFrame(() => {
      if ((was === 'sheet') !== (v === 'sheet')) this.sheet.rezoom();
      else this.sheet.refit();
      this.sizeSheet();
      requestAnimationFrame(() => this.layout());
    });
  }

  private setHud(h: Settings['hud']): void {
    if (h === settings.hud) return;
    updateSettings({ hud: h });
    this.syncUI();
    requestAnimationFrame(() => {
      this.layout();
      this.sheet.refit();
      this.sizeSheet();
    });
  }

  private bindControls(): void {
    const r = this.root;
    const on = (id: string, fn: () => void) => this.el[id].addEventListener('click', fn);
    on('btnStart', () => this.primary());
    // a mouse click on a choice should not keep focus there: Space/Enter then start the run
    this.el.ready.addEventListener('click', (e) => {
      const c = (e.target as Element).closest<HTMLElement>('button, input[type="checkbox"]');
      if (c && e.detail > 0 && c !== this.el.btnStart) c.blur();
    });
    on('btnFresh', () => this.startPlay());
    on('btnFs', () => void this.toggleFs());
    on('btnPause', () => this.pause('user'));
    on('pmResume', () => this.resume());
    on('pmRestart', () => this.startPlay());
    on('pmSettings', () => this.toSettings());
    on('pmExit', () => this.exitSong());
    $$<HTMLButtonElement>('button[data-view]', r).forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view as Settings['view'])));
    $$<HTMLButtonElement>('button[data-hud]', r).forEach((b) => b.addEventListener('click', () => this.setHud(b.dataset.hud as Settings['hud'])));
    $$<HTMLButtonElement>('button[data-rate]', r).forEach((b) => b.addEventListener('click', () => Number(b.dataset.rate) !== settings.rate && this.applySettings({ rate: Number(b.dataset.rate) })));
    $$<HTMLButtonElement>('button[data-hands]', r).forEach((b) => b.addEventListener('click', () => b.dataset.hands !== settings.hands && this.applySettings({ hands: b.dataset.hands as Settings['hands'] })));
    $$<HTMLButtonElement>('button[data-wait]', r).forEach((b) =>
      b.addEventListener('click', () => (b.dataset.wait === '1') !== settings.wait && this.applySettings({ wait: b.dataset.wait === '1' })),
    );
    $$<HTMLButtonElement>('button[data-loop]', r).forEach((b) =>
      b.addEventListener('click', () => {
        const want = b.dataset.loop === '1';
        if (want === settings.loop.on) return;
        if (want && (this.chart?.measures.length ?? 0) < 2) return toast('마디가 하나뿐이라 구간을 고를 수 없어요.');
        this.applySettings({ loop: { ...settings.loop, on: want } });
      }),
    );
    const box = (id: string) => this.el[id] as HTMLInputElement;
    const onAB = () => {
      const a = Number((this.el.loopA as HTMLSelectElement).value);
      let b = Number((this.el.loopB as HTMLSelectElement).value);
      if (b < a) b = a;
      this.applySettings({ loop: { on: true, from: a, to: b } });
    };
    this.el.loopA.addEventListener('change', onAB);
    this.el.loopB.addEventListener('change', onAB);
    box('optMetro').addEventListener('change', (e) => this.applySettings({ metro: (e.target as HTMLInputElement).checked }));
    box('optAuto').addEventListener('change', (e) => {
      this.applySettings({ autoplay: (e.target as HTMLInputElement).checked });
      this.renderReady();
    });
    box('optKeyStart').addEventListener('change', (e) => {
      this.applySettings({ keyStart: (e.target as HTMLInputElement).checked });
      this.renderReady();
    });
    box('optSoundKeys').addEventListener('change', (e) => this.applySettings({ soundKeys: (e.target as HTMLInputElement).checked }));
    box('optSoundMidi').addEventListener('change', (e) => this.applySettings({ soundMidi: (e.target as HTMLInputElement).checked }));
    box('offset').addEventListener('input', (e) => {
      updateSettings({ offset: Number((e.target as HTMLInputElement).value) });
      this.el.offsetVal.textContent = signed(settings.offset) + ' ms';
    });
    box('offset').addEventListener('change', () => this.syncUI());
  }

  /* ------------------------------------------------------------ layout */

  enter(): void {
    this.applyFocus();
    if (this.ps.phase === 'ready') {
      this.readySince = performance.now();
      this.renderReady();
    }
    requestAnimationFrame(() => {
      this.sheet.refit();
      this.sizeSheet();
      this.layout();
    });
  }

  leave(): void {
    this.pause('hidden');
    this.applyFocus();
  }

  private onResize(): void {
    if (!this.deps.isActive()) return;
    this.layout();
    clearTimeout(this.sheetTimer);
    this.sheetTimer = window.setTimeout(() => {
      this.sheet.refit();
      this.sizeSheet();
    }, 120);
  }

  /** Size the score panel: one system tall next to the highway, the full view on its own. */
  private sizeSheet(): void {
    const wrap = this.el.sheetWrap;
    if (settings.view === 'hw') return;
    if (settings.view === 'both') {
      const h = this.sheet.ready ? this.sheet.systemHeight() : 0;
      wrap.style.height = h ? Math.floor(h) + 'px' : '';
      wrap.style.maxHeight = '';
    } else {
      const avail = Math.round(this.el.view.clientHeight - this.el.scorePanel.offsetTop - 10 - 78);
      wrap.style.height = '';
      wrap.style.maxHeight = Math.max(120, avail) + 'px';
    }
    this.layout();
  }

  private layout(): void {
    const view = this.el?.view;
    if (!view) return;
    const vr = view.getBoundingClientRect();
    if (!vr.width || !vr.height) return;
    this.root.style.setProperty('--kh', this.el.keysWrap.offsetHeight + 'px');
    const reserve = WIDE?.matches && settings.hud === 'detail' ? 236 : 16;
    const avail = Math.max(200, vr.width - 2 * reserve);
    const L = this.keys.layout;
    const target = Math.min(avail, L.whites * (L.whites <= 12 ? 76 : 62), 1100);
    this.el.keys.style.width = target + 'px';
    this.el.keys.classList.toggle('dense', target / L.whites < 19);
    view.style.setProperty('--side', reserve + 'px');
    const st = this.el.stage;
    const r = st.getBoundingClientRect();
    let hx = vr.width / 2;
    if (r.width && r.height && settings.view !== 'sheet') {
      const kr = this.el.keys.getBoundingClientRect();
      this.hw.resize(r.width, r.height, kr.left - r.left, kr.width);
      hx = this.hw.centerX + (r.left - vr.left);
      const top = r.top - vr.top;
      const both = settings.view === 'both';
      view.style.setProperty('--cy', top + r.height * (both ? 0.44 : 0.42) + 'px');
      view.style.setProperty('--jy', top + r.height * (both ? 0.8 : 0.72) + 'px');
      view.style.setProperty('--by', top + r.height * 0.45 + 'px');
    } else {
      const pr = this.el.scorePanel.getBoundingClientRect();
      const below = vr.bottom - pr.bottom;
      view.style.setProperty('--jy', (below >= 60 ? pr.bottom - vr.top + below * 0.45 : vr.height - 40) + 'px');
      view.style.setProperty('--by', (pr.height ? pr.top - vr.top + pr.height * 0.5 : vr.height * 0.45) + 'px');
    }
    view.style.setProperty('--hx', hx + 'px');
  }

  /* ------------------------------------------------------------ coach (pause menu) */

  private coachText(): string {
    const s = this.session;
    if (!s) return '';
    const t = this.clock.time();
    const cur = beatAt(this.chart!, settings.rate, Math.max(0, t)).measure;
    const first = s.notes[0];
    const lw = this.lastWrong && performance.now() - this.lastWrong.at < 8000 ? this.lastWrong : null;
    return liveCoach({
      mode: this.mode,
      paused: false,
      wait: s.opts.wait,
      gateNotes: s.opts.wait && s.gate !== null ? s.gateNotes().map((n) => ({ midi: n.note.midi, measure: n.note.measure })) : [],
      preStart: this.mode === 'play' && t < s.startT && first ? { measure: s.opts.loop?.from ?? 0, midi: first.note.midi } : null,
      recent: s.notes
        .filter((n) => n.result && n.note.measure >= cur - 1 && n.note.measure <= cur)
        .map((n) => ({ res: n.result!, measure: n.note.measure, midi: n.note.midi, err: n.err })),
      lastWrong: lw,
      combo: s.combo,
      hitErrors: s.timingErrors(),
      pickup: this.pickup,
    });
  }
}
