/**
 * Play screen controller: attract demo → count-in → timed (or wait-mode) play → finish.
 * Judging is the engine's Session; this module owns the clock, the auto-player, the
 * feedback (HUD, judgment pop, sheet marks, highway FX) and the practice controls.
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
import { saveLastResult, submitBest, type PlanItem, type ResultData } from '../state/records';
import { HANDS_KO, settings, updateSettings, type Settings } from '../state/settings';
import { SongClock, beatGrid, countInBeatMs, type Beat } from './clock';
import { liveCoach } from './coach';
import { planAuto, type AutoPlan } from './demo';
import { $, $$, ICON, reducedMotion, restartAnim, toast } from './dom';
import { barNo, clamp, scoreHTML, signed } from './format';
import { PianoKeys } from './piano-keys';
import { playTemplate } from './play-view';
import { summarize } from './summary';

const JTXT: Record<string, string> = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS', wrong: 'WRONG', ok: '정답', okw: '다시 쳐서 정답' };
const COUNT_ROWS = {
  normal: [['perfect', 'PERFECT'], ['great', 'GREAT'], ['good', 'GOOD'], ['miss', 'MISS'], ['wrong', 'WRONG']],
  wait: [['ok', '정답'], ['okw', '다시 쳐서'], ['wrong', '틀린 건반']],
} as const;
const WIDE = typeof matchMedia === 'function' ? matchMedia('(min-width: 980px)') : null;

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
  private counted = false;
  private chipTxt = '';
  private coachT = 0;
  private coachHold = 0;
  private sheetTimer = 0;

  constructor(root: HTMLElement, deps: PlayDeps) {
    this.root = root;
    this.deps = deps;
  }

  mount(): void {
    this.root.innerHTML = playTemplate();
    const ids = ['modeChip', 'modeTxt', 'phTitle', 'phMeta', 'score', 'accMini', 'prog', 'controls', 'btnMain', 'btnRestart', 'btnDrawer',
      'optWait', 'optLoop', 'loopA', 'loopB', 'optMetro', 'optAuto', 'optSoundKeys', 'optSoundMidi', 'offset', 'offsetVal', 'view',
      'lifeM', 'feverM', 'acc', 'maxc', 'hudCounts', 'scorePanel', 'sheetWrap', 'sheetHost', 'stage', 'hw', 'combo', 'comboN', 'judge', 'fs',
      'big', 'overlay', 'ovEyebrow', 'ovEyeTxt', 'ovPlay', 'ovPauseRow', 'ovResume', 'ovRestart', 'keys', 'coachLive'];
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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'play') this.togglePause(true);
    });
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
    this.el.phTitle.textContent = song.title;
    const opts = Array.from({ length: bars }, (_, i) => `<option value="${i}">${barNo(i, this.pickup)}</option>`).join('');
    this.el.loopA.innerHTML = opts;
    this.el.loopB.innerHTML = opts;
    this.buildRange();
    this.sheet.setLoop(settings.loop.on ? { from: settings.loop.from, to: settings.loop.to } : null);
    void this.sheet.show(chart).then((ok) => {
      if (!ok) this.sizeSheet();
    });
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

  startAttract(fromTop: boolean): void {
    if (!this.chart) return;
    this.mode = 'attract';
    this.finishAt = 0;
    this.waiting = false;
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
    this.afterStart();
  }

  startPlay(keepPasses = false): void {
    if (!this.chart) return;
    synth.unlock();
    this.releaseAll();
    this.setDrawer(false);
    this.mode = 'play';
    this.finishAt = 0;
    this.waiting = false;
    this.hinted = true;
    this.counted = false;
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
    this.hw.clearFx();
    this.el.judge.className = 'judge';
    this.el.fs.className = 'fs';
    this.setCombo(0, false);
    this.afterStart();
    if (!this.deps.isActive()) location.hash = '#play';
  }

  private afterStart(): void {
    this.buildCounts(settings.wait);
    this.syncUI();
    this.refreshSheet();
    this.coachSoon(0);
  }

  togglePause(force?: boolean): void {
    if (this.mode !== 'play') return;
    const want = force ?? !this.clock.paused;
    if (want === this.clock.paused) return;
    if (want) {
      this.clock.pause();
      this.releaseAll();
    } else {
      const d = this.clock.resume();
      if (this.finishAt) this.finishAt += d;
      if (this.waiting) this.waitSince = performance.now();
    }
    this.syncUI();
    this.coachSoon(0);
  }

  /** Start a practice plan item (from home or the result screen). */
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

  /** Song + settings for a home shortcut, landing in the attract demo. */
  prepare(songId: string, patch: Partial<Settings>): void {
    if (songId !== this.song?.id) this.setSong(songId);
    updateSettings(patch);
    this.afterSettings();
    this.startAttract(true);
  }

  private afterSettings(): void {
    this.buildRange();
    this.sheet.setLoop(settings.loop.on ? { from: settings.loop.from, to: settings.loop.to } : null);
  }

  private applySettings(patch: Partial<Settings>): void {
    updateSettings(patch);
    this.afterSettings();
    if (this.mode === 'play') {
      this.startPlay();
      toast('설정이 바뀌어 처음부터 다시 시작해요.');
    } else this.startAttract(true);
  }

  /* ------------------------------------------------------------ input */

  onInput(e: NoteInput): void {
    if (!this.deps.isActive()) return;
    const m = e.midi;
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
      toast('지금은 데모 화면이에요. 직접 플레이를 누르면 판정이 시작돼요.');
    }
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape') return false;
    if (this.el.controls.classList.contains('open')) this.setDrawer(false);
    else if (this.mode === 'play') this.togglePause();
    else return false;
    return true;
  }

  private releaseAll(): void {
    this.keys?.releaseAll();
    this.autoRel.length = 0;
    synth.allOff();
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
    if (!this.clock.paused) this.step(now);
    const t = this.clock.time(now);
    if (settings.view !== 'sheet') {
      this.hw.render({
        t, now, dt, notes: s.notes, beats: this.beats, startT: s.startT, endT: s.endT, loop: !!s.opts.loop, wait: s.opts.wait,
        waiting: this.waiting, gate: s.gate, live: !this.clock.paused && !this.waiting && t > s.startT - 4 * this.quarterMs(),
        fever: this.fever >= 1, danger: this.mode === 'play' && this.life < 30, hue: this.lastHue, measures: this.chart!.measures.length, pickup: this.pickup,
      });
    }
    if (settings.view !== 'hw') this.updatePlayhead(t);
    this.hud(t, dt);
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
          this.coachSoon(120);
        }
      } else this.waiting = false;
    }
    if (this.mode === 'play') this.beatsUpTo(t, s);
    if (this.mode === 'attract' || this.auto) this.autoStep(now, t, s);
    if (!s.opts.wait) for (const ev of s.update(t)) this.handle(ev);
    if (this.mode === 'attract') {
      if (t > s.endT + 1600) this.startAttract(true);
      return;
    }
    if (s.done && !this.finishAt) {
      if (s.opts.loop) {
        this.finishAt = now + 1100;
        this.showBig(`${this.passes.length + 1}회째 끝`, true);
      } else {
        this.finishAt = now + 1700;
        const top = s.opts.wait ? s.counts.ok : s.counts.perfect;
        const pp = top === s.total && !s.counts.wrong;
        const fc = !s.counts.miss && !s.counts.wrong;
        this.showBig(pp ? 'PERFECT PLAY' : fc ? 'FULL COMBO' : 'CLEAR', true);
      }
    }
    if (this.finishAt && now >= this.finishAt) {
      if (s.opts.loop) this.nextPass();
      else this.finish();
    }
  }

  /** Count-in ticks and the metronome, scheduled a few ms ahead on the audio clock. */
  private beatsUpTo(t: number, s: Session): void {
    const ahead = s.opts.wait ? 0 : 30;
    while (this.beatIdx < this.beats.length && this.beats[this.beatIdx].t <= t + ahead) {
      const b = this.beats[this.beatIdx++];
      const when = synth.ctx ? synth.ctx.currentTime + Math.max(0, b.t - t) / 1000 : undefined;
      if (b.measure < 0) {
        synth.tick(b.bar, when);
        this.showBig(['준비', '3', '2', '1'][4 + b.measure] ?? '', false);
        this.counted = true;
      } else {
        if (this.counted) {
          this.counted = false;
          this.showBig('GO', false);
        }
        if (settings.metro && b.t < s.endT - 1) synth.tick(b.bar, when);
      }
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
    const n = this.passes.length;
    const prev = this.passes[n - 2];
    this.startPlay(true);
    const lp = settings.loop;
    this.coachSet(
      `${barNo(lp.from, this.pickup)}–${barNo(lp.to, this.pickup)}마디 ${n}회째 끝: 정확도 ${R.acc.toFixed(1)}%` +
        (prev ? ` (지난 회차 ${prev.acc.toFixed(1)}%)` : '') +
        '. 바로 다음 회차가 시작돼요. 결과 탭에서 이번 회차를 볼 수 있어요.',
      5200,
    );
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
      this.coachSoon();
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
      this.lastHue = LANE_HUE[n.note.midi % 12];
      this.sheet.setMark(n.note.id, j);
      if (!s.opts.wait && (j === 'great' || j === 'good')) this.sheet.label(n.note.id, ev.err);
      if (settings.view !== 'hw') this.sheet.halo(n.note.id, j);
    }
    this.markNext();
    this.coachSoon();
  }

  private markNext(): void {
    const s = this.session;
    if (!s) return;
    const g = s.gateNotes();
    this.sheet.setNext(g.map((n) => n.note.id));
    this.keys.setTargets(s.opts.wait ? g.map((n) => n.note.midi) : []);
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

  private showBig(text: string, fin: boolean): void {
    const b = this.el.big;
    b.textContent = text;
    b.className = 'big' + (fin ? ' fin' : '');
    restartAnim(b, 'pop');
  }

  /* ------------------------------------------------------------ HUD + controls UI */

  private buildCounts(wait: boolean): void {
    const ul = this.el.hudCounts;
    const key = wait ? 'wait' : 'normal';
    if (ul.dataset.m === key) return;
    ul.dataset.m = key;
    ul.innerHTML = COUNT_ROWS[key].map(([k, l]) => `<li data-k="${k}"><span>${l}</span><b>0</b></li>`).join('');
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
    const acc = s.runningAccuracy.toFixed(2) + '%';
    if (this.el.acc.textContent !== acc) {
      this.el.acc.textContent = acc;
      this.el.accMini.textContent = 'ACC ' + acc;
    }
    this.el.maxc.textContent = String(s.maxCombo);
    for (const li of this.el.hudCounts.children) {
      const k = (li as HTMLElement).dataset.k as Judgment | 'wrong';
      const b = li.lastElementChild!;
      const v = String(s.counts[k]);
      if (b.textContent !== v) b.textContent = v;
    }
    this.el.prog.style.width = clamp((t - s.startT) / Math.max(1, s.endT - s.startT), 0, 1) * 100 + '%';
    this.el.lifeM.style.setProperty('--v', String(this.life / 100));
    this.el.feverM.style.setProperty('--v', String(this.fever));
    this.el.view.classList.toggle('fever', this.fever >= 1);
    this.el.view.classList.toggle('danger', this.mode === 'play' && this.life < 30);
    const m = this.mode === 'attract' ? 'demo' : this.clock.paused ? 'pause' : this.waiting ? 'wait' : 'play';
    const txt = m === 'demo' ? 'DEMO' : m === 'pause' ? 'PAUSED' : m === 'wait' ? 'WAIT' : this.auto ? 'AUTO' : 'PLAY';
    if (this.chipTxt !== txt) {
      this.chipTxt = txt;
      this.el.modeChip.dataset.m = m;
      this.el.modeTxt.textContent = txt;
    }
  }

  private syncUI(): void {
    const m = this.mode;
    const paused = this.clock.paused;
    this.el.btnMain.innerHTML = m === 'attract' ? ICON.play + '직접 플레이' : paused ? ICON.play + '계속하기' : ICON.pause + '일시정지';
    (this.el.btnRestart as HTMLButtonElement).disabled = m !== 'play';
    this.el.overlay.hidden = m === 'play' && !paused;
    this.el.overlay.classList.toggle('attract', m === 'attract');
    this.el.ovPlay.hidden = m !== 'attract';
    this.el.ovPauseRow.hidden = m === 'attract';
    (this.el.ovEyebrow.querySelector('i') as HTMLElement).hidden = m !== 'attract';
    this.el.ovEyeTxt.textContent = m === 'attract' ? 'DEMO · 자동 연주 중 · 소리 꺼짐' : '일시정지 · Esc로 다시 시작';
    this.chipTxt = '';
    const lp = settings.loop;
    const loopTxt = lp.on ? ` · ${barNo(lp.from, this.pickup)}–${barNo(lp.to, this.pickup)}마디 반복${m === 'play' ? ` ${this.passes.length + 1}회째` : ''}` : '';
    const c = this.chart;
    const bpm = c ? Math.round(c.meta.bpm * settings.rate) : 0;
    this.el.phMeta.textContent = `${this.song?.composer ?? ''} · BPM ${bpm} · ${HANDS_KO[settings.hands]}${settings.wait ? ' · 대기 모드' : ''}${loopTxt}`;
    $$<HTMLButtonElement>('[data-rate]', this.root).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === settings.rate)));
    $$<HTMLButtonElement>('[data-hands]', this.root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hands === settings.hands)));
    $$<HTMLButtonElement>('[data-view]', this.root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === settings.view)));
    const chk = (id: string, v: boolean) => ((this.el[id] as HTMLInputElement).checked = v);
    chk('optWait', settings.wait);
    chk('optLoop', lp.on);
    chk('optMetro', settings.metro);
    chk('optAuto', settings.autoplay);
    chk('optSoundKeys', settings.soundKeys);
    chk('optSoundMidi', settings.soundMidi);
    (this.el.loopA as HTMLSelectElement).value = String(lp.from);
    (this.el.loopB as HTMLSelectElement).value = String(lp.to);
    (this.el.offset as HTMLInputElement).value = String(settings.offset);
    this.el.offsetVal.textContent = signed(settings.offset) + ' ms';
  }

  /** External settings change (device screen calibration, result screen offset). */
  settingsUpdated(): void {
    if (this.el) this.syncUI();
  }

  private setDrawer(open: boolean): void {
    this.el.controls.classList.toggle('open', open);
    this.el.btnDrawer.setAttribute('aria-expanded', String(open));
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

  private bindControls(): void {
    const r = this.root;
    this.el.btnDrawer.addEventListener('click', () => this.setDrawer(!this.el.controls.classList.contains('open')));
    document.addEventListener('pointerdown', (e) => {
      if (this.el.controls.classList.contains('open') && !(e.target as Element).closest?.('#controls')) this.setDrawer(false);
    });
    $$<HTMLButtonElement>('[data-view]', r).forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view as Settings['view'])));
    this.el.btnMain.addEventListener('click', () => (this.mode === 'attract' ? this.startPlay() : this.togglePause()));
    this.el.ovPlay.addEventListener('click', () => this.startPlay());
    this.el.ovResume.addEventListener('click', () => this.togglePause(false));
    this.el.ovRestart.addEventListener('click', () => this.startPlay());
    this.el.btnRestart.addEventListener('click', () => this.startPlay());
    $$<HTMLButtonElement>('[data-rate]', r).forEach((b) => b.addEventListener('click', () => this.applySettings({ rate: Number(b.dataset.rate) })));
    $$<HTMLButtonElement>('[data-hands]', r).forEach((b) => b.addEventListener('click', () => this.applySettings({ hands: b.dataset.hands as Settings['hands'] })));
    const box = (id: string) => this.el[id] as HTMLInputElement;
    box('optWait').addEventListener('change', (e) => this.applySettings({ wait: (e.target as HTMLInputElement).checked }));
    box('optLoop').addEventListener('change', (e) => this.applySettings({ loop: { ...settings.loop, on: (e.target as HTMLInputElement).checked } }));
    const onAB = () => {
      const a = Number((this.el.loopA as HTMLSelectElement).value);
      let b = Number((this.el.loopB as HTMLSelectElement).value);
      if (b < a) b = a;
      if (settings.loop.on) this.applySettings({ loop: { on: true, from: a, to: b } });
      else {
        updateSettings({ loop: { on: false, from: a, to: b } });
        this.syncUI();
        toast(`${barNo(a, this.pickup)}–${barNo(b, this.pickup)}마디를 골랐어요. A–B 반복을 켜면 이 구간만 돌아요.`);
      }
    };
    this.el.loopA.addEventListener('change', onAB);
    this.el.loopB.addEventListener('change', onAB);
    box('optMetro').addEventListener('change', (e) => updateSettings({ metro: (e.target as HTMLInputElement).checked }));
    box('optAuto').addEventListener('change', (e) => {
      updateSettings({ autoplay: (e.target as HTMLInputElement).checked });
      if (this.mode === 'play' && settings.autoplay) this.auto = true;
      this.syncUI();
    });
    box('optSoundKeys').addEventListener('change', (e) => updateSettings({ soundKeys: (e.target as HTMLInputElement).checked }));
    box('optSoundMidi').addEventListener('change', (e) => updateSettings({ soundMidi: (e.target as HTMLInputElement).checked }));
    box('offset').addEventListener('input', (e) => {
      updateSettings({ offset: Number((e.target as HTMLInputElement).value) });
      this.el.offsetVal.textContent = signed(settings.offset) + ' ms';
    });
  }

  /* ------------------------------------------------------------ layout */

  enter(): void {
    requestAnimationFrame(() => {
      this.sheet.refit();
      this.sizeSheet();
      this.layout();
    });
  }

  leave(): void {
    if (this.mode === 'play' && !this.clock.paused) this.togglePause(true);
    this.setDrawer(false);
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
    const reserve = WIDE?.matches ? 236 : 16;
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
      view.style.setProperty('--oy', top + 10 + 'px');
    } else {
      const pr = this.el.scorePanel.getBoundingClientRect();
      const below = vr.bottom - pr.bottom;
      view.style.setProperty('--jy', (below >= 60 ? pr.bottom - vr.top + below * 0.45 : vr.height - 40) + 'px');
      view.style.setProperty('--by', vr.height * 0.45 + 'px');
    }
    view.style.setProperty('--hx', hx + 'px');
  }

  /* ------------------------------------------------------------ live coach */

  private coachSet(text: string, hold = 0): void {
    const p = this.el.coachLive;
    this.coachHold = hold ? performance.now() + hold : 0;
    if (p.textContent === text) return;
    p.textContent = text;
    restartAnim(p, 'flash');
  }

  private coachSoon(delay = 320): void {
    if (this.coachT && delay > 0) return; // already scheduled: a steady stream of notes must not starve the coach
    clearTimeout(this.coachT);
    this.coachT = window.setTimeout(() => {
      this.coachT = 0;
      const now = performance.now();
      if (now < this.coachHold) return this.coachSoon(this.coachHold - now + 40);
      this.coachSet(this.coachText());
    }, delay);
  }

  private coachText(): string {
    const s = this.session;
    if (!s) return '';
    const t = this.clock.time();
    const cur = beatAt(this.chart!, settings.rate, Math.max(0, t)).measure;
    const first = s.notes[0];
    const lw = this.lastWrong && performance.now() - this.lastWrong.at < 4500 ? this.lastWrong : null;
    return liveCoach({
      mode: this.mode,
      paused: this.clock.paused,
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
