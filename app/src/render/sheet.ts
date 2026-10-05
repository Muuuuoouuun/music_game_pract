/**
 * Sheet view: OpenSheetMusicDisplay engraves `chart.musicXml` in the dark stage palette
 * and an absolutely positioned overlay SVG carries everything game-related: next-note
 * rings, ±ms labels, wrong-key ghost noteheads, the A–B band, per-measure tints and the
 * playhead. Noteheads themselves are recoloured with CSS classes (styles/play.css).
 *
 * OSMD is ~1 MB, so it is imported lazily the first time a sheet is shown.
 */
import type { Chart } from '../core/chart';
import type { Judgment } from '../core/engine';
import { type MeasureSpan, type NoteKey, diatonic, isSharp, matchNotes, staffOffset, xAtBeat } from './sheet-map';

/* Minimal shapes of the OSMD internals we read (the package's own types are much wider). */
interface Pt { x: number; y: number }
interface BBox { AbsolutePosition: Pt; Size: { width: number; height: number } }
interface OPitch { FundamentalNote: number; Octave: number }
interface ONote {
  isRest(): boolean;
  halfTone: number;
  Pitch?: OPitch;
  NoteTie?: { StartNote: unknown };
}
interface GNote { sourceNote: ONote; getNoteheadSVGs?(): Element[]; PositionAndShape: BBox }
interface GStaffEntry { relInMeasureTimestamp: { RealValue: number }; graphicalVoiceEntries: { notes: GNote[] }[]; PositionAndShape: BBox }
interface GMeasure {
  staffEntries: GStaffEntry[];
  PositionAndShape: BBox;
  beginInstructionsWidth: number;
  InitiallyActiveClef?: { ClefType: number };
  ParentStaffLine?: { PositionAndShape: BBox };
  ParentMusicSystem?: unknown;
}
interface OSMDLike {
  zoom: number;
  load(xml: string): Promise<unknown>;
  render(): void;
  setOptions(o: Record<string, unknown>): void;
  EngravingRules: Record<string, unknown>;
  GraphicSheet: { MeasureList: (GMeasure | undefined)[][]; MusicPages: { MusicSystems: unknown[] }[] };
}

type OSMDCtor = new (el: HTMLElement, opts: Record<string, unknown>) => OSMDLike;
let osmdCtor: Promise<OSMDCtor> | null = null;
function loadOsmd(): Promise<OSMDCtor> {
  osmdCtor ??= import('opensheetmusicdisplay').then((m) => {
    const mod = m as unknown as { OpenSheetMusicDisplay?: OSMDCtor; default?: { OpenSheetMusicDisplay?: OSMDCtor } };
    const C = mod.OpenSheetMusicDisplay ?? mod.default?.OpenSheetMusicDisplay;
    if (!C) throw new Error('OSMD not found');
    return C;
  });
  return osmdCtor;
}

export type Mark = Judgment | 'next' | 'off' | null;

interface Staff { top: number; clef: 'G' | 'F' }
interface Span extends MeasureSpan { sys: number; left: number; staves: Staff[] }
interface Head { els: Element[]; cx: number; cy: number }

const SVGNS = 'http://www.w3.org/2000/svg';
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}
const LETTER: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const heat = (a: number) =>
  `color-mix(in oklab, var(--j-great) ${Math.round(Math.max(0, Math.min(1, (a - 0.6) / 0.4)) * 100)}%, var(--j-wrong))`;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface SheetOptions {
  /** Engraving zoom for a given host width. */
  zoomFor?: (width: number) => number;
  /** Only engrave the first N measures (import preview). */
  maxMeasures?: number;
  /** Scroll container that follows the playhead system by system. */
  scroller?: HTMLElement | null;
  emptyText?: string;
}

export class SheetView {
  readonly host: HTMLElement;
  private box: HTMLDivElement;
  private ov: SVGSVGElement;
  private layers!: Record<'bg' | 'nx' | 'ghost' | 'lbl' | 'fx' | 'ph', SVGGElement>;
  private opts: SheetOptions;
  private osmd: OSMDLike | null = null;
  private chart: Chart | null = null;
  private token = 0;
  private renderedWidth = 0;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private spans: (Span | null)[] = [];
  private systems: { top: number; bottom: number }[] = [];
  private heads = new Map<string, Head>();
  private marks = new Map<string, Mark>();
  private labels = new Map<string, number>();
  private ghosts: { midi: number; measure: number; beat: number }[] = [];
  private loop: { from: number; to: number } | null = null;
  private tints: (number | null)[] | null = null;
  private ph: SVGGElement | null = null;
  private curSys = -1;
  ready = false;
  onRendered: (() => void) | null = null;

  constructor(host: HTMLElement, opts: SheetOptions = {}) {
    this.host = host;
    this.opts = opts;
    host.classList.add('osmd-host');
    host.textContent = '';
    this.box = document.createElement('div');
    this.box.className = 'osmd';
    this.ov = sv('svg', { class: 'ov', 'aria-hidden': 'true' });
    host.append(this.box, this.ov);
    this.makeLayers();
  }

  get hasSheet(): boolean {
    return !!this.chart?.musicXml;
  }

  /** Load and engrave a chart. Resolves false when there is no sheet to show. */
  async show(chart: Chart | null): Promise<boolean> {
    const token = ++this.token;
    this.chart = chart;
    this.ready = false;
    this.resetState();
    this.renderedWidth = 0;
    if (!chart?.musicXml) {
      this.box.innerHTML = `<div class="osmd-empty"><div><b>NO SCORE</b>${this.opts.emptyText ?? '악보 없음 · 하이웨이로 연주하세요'}</div></div>`;
      this.clearOverlay();
      return false;
    }
    this.box.innerHTML = '<div class="osmd-loading">악보 불러오는 중…</div>';
    try {
      const C = await loadOsmd();
      if (token !== this.token) return false;
      this.box.textContent = '';
      this.osmd = new C(this.box, {
        autoResize: false, backend: 'svg', drawTitle: false, drawSubtitle: false, drawComposer: false, drawLyricist: false,
        drawCredits: false, drawPartNames: false, drawPartAbbreviations: false, drawMetronomeMarks: false, drawFingerings: false,
        disableCursor: true, stretchLastSystemLine: false, drawingParameters: 'compacttight',
        defaultColorMusic: '#ddd6fa', defaultColorNotehead: '#f5efe2', defaultColorStem: '#ddd6fa', defaultColorRest: '#8f8aba',
        defaultColorLabel: '#aca7d8', defaultColorTitle: '#aca7d8',
        ...(this.opts.maxMeasures ? { drawUpToMeasureNumber: this.opts.maxMeasures } : {}),
      });
      const r = this.osmd.EngravingRules;
      Object.assign(r, {
        StaffLineColor: '#5d5891', LedgerLineColorDefault: '#8a84bf', PageTopMargin: 2, PageBottomMargin: 2, PageLeftMargin: 1.5,
        PageRightMargin: 1.5, MinSkyBottomDistBetweenSystems: 3, RenderTitle: false,
      });
      await this.osmd.load(chart.musicXml);
      if (token !== this.token) return false;
      this.engrave();
      return this.ready;
    } catch (e) {
      if (token !== this.token) return false;
      console.warn('sheet render failed', e);
      this.osmd = null;
      this.box.innerHTML = '<div class="osmd-empty"><div><b>NO SCORE</b>악보를 그리지 못했어요 · 하이웨이로 연주하세요</div></div>';
      this.clearOverlay();
      return false;
    }
  }

  /** Re-engrave if the host width changed (call from a ResizeObserver). */
  refit(): void {
    if (!this.osmd || !this.chart?.musicXml) return;
    const w = Math.floor(this.host.clientWidth);
    if (w > 40 && Math.abs(w - this.renderedWidth) > 2) this.engrave();
  }

  private engrave(): void {
    const osmd = this.osmd;
    if (!osmd) return;
    const w = Math.floor(this.host.clientWidth);
    if (w < 40) return; // hidden: refit() will catch up when shown
    osmd.zoom = this.opts.zoomFor ? this.opts.zoomFor(w) : w >= 900 ? 0.8 : w >= 600 ? 0.7 : 0.58;
    try {
      osmd.render();
    } catch (e) {
      console.warn('OSMD render failed', e);
      return;
    }
    this.renderedWidth = w;
    this.measureGeometry();
    this.ready = true;
    this.repaint();
    this.onRendered?.();
  }

  private measureGeometry(): void {
    const osmd = this.osmd!;
    const svg = this.box.querySelector('svg');
    const hostR = this.host.getBoundingClientRect();
    const svgR = svg?.getBoundingClientRect();
    const vb = svg?.viewBox?.baseVal;
    this.scale = svgR && vb && vb.width ? svgR.width / vb.width : osmd.zoom;
    this.offX = (svgR ? svgR.left - hostR.left : 0) - (vb?.x ?? 0) * this.scale;
    this.offY = (svgR ? svgR.top - hostR.top : 0) - (vb?.y ?? 0) * this.scale;
    this.ov.setAttribute('width', String(svgR?.width ?? this.host.clientWidth));
    this.ov.setAttribute('height', String(svgR?.height ?? this.host.clientHeight));

    const list = osmd.GraphicSheet.MeasureList;
    const systems = osmd.GraphicSheet.MusicPages.flatMap((p) => p.MusicSystems);
    this.spans = [];
    this.systems = systems.map(() => ({ top: Infinity, bottom: -Infinity }));
    const engraved: (NoteKey & { g: GNote; staff: Staff })[] = [];
    list.forEach((row, i) => {
      const staves = (row ?? []).filter((g): g is GMeasure => !!g && !!g.PositionAndShape);
      if (!staves.length) {
        this.spans[i] = null;
        return;
      }
      const first = staves[0];
      const sys = Math.max(0, systems.indexOf(first.ParentMusicSystem));
      const infos: Staff[] = staves.map((gm) => ({
        top: gm.ParentStaffLine?.PositionAndShape.AbsolutePosition.y ?? gm.PositionAndShape.AbsolutePosition.y,
        clef: gm.InitiallyActiveClef?.ClefType === 1 ? 'F' : 'G',
      }));
      const x = first.PositionAndShape.AbsolutePosition.x;
      const span: Span = {
        sys, left: x, x0: x + (first.beginInstructionsWidth || 0) + 0.6, x1: x + first.PositionAndShape.Size.width,
        quarters: 4, staves: infos, points: [],
      };
      staves.forEach((gm, si) => {
        for (const se of gm.staffEntries) {
          const beat = se.relInMeasureTimestamp.RealValue * 4;
          span.points.push({ beat, x: se.PositionAndShape.AbsolutePosition.x });
          for (const ve of se.graphicalVoiceEntries) {
            for (const g of ve.notes) {
              const n = g.sourceNote;
              if (!n || n.isRest() || !n.Pitch) continue;
              if (n.NoteTie && n.NoteTie.StartNote !== n) continue; // tie continuation: the chart merged it
              engraved.push({ measure: i, beat, midi: n.halfTone + 12, g, staff: infos[si] });
            }
          }
        }
      });
      const s = this.systems[sys];
      for (const st of infos) {
        s.top = Math.min(s.top, st.top - 4.5);
        s.bottom = Math.max(s.bottom, st.top + 7);
      }
      this.spans[i] = span;
    });
    // measure lengths come from the chart (the engraving does not know about pickups)
    this.chart?.measures.forEach((m) => {
      const sp = this.spans[m.index];
      if (sp) sp.quarters = (m.timeSignature[0] * 4) / m.timeSignature[1];
    });

    this.heads.clear();
    const notes = this.chart?.notes ?? [];
    const pairs = matchNotes(notes, engraved);
    for (const [ci, gi] of pairs) {
      const e = engraved[gi];
      const els = e.g.getNoteheadSVGs?.() ?? [];
      const p = e.g.sourceNote.Pitch!;
      const expectY = this.py(e.staff.top + staffOffset((p.Octave + 3) * 7 + (LETTER[p.FundamentalNote] ?? 0), e.staff.clef));
      let pick: Element | null = null;
      let cx = this.px(e.g.PositionAndShape.AbsolutePosition.x + 0.6);
      let cy = expectY;
      let bd = Infinity;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const y = r.top + r.height / 2 - hostR.top;
        if (Math.abs(y - expectY) < bd) {
          bd = Math.abs(y - expectY);
          pick = el;
          cx = r.left + r.width / 2 - hostR.left;
          cy = y;
        }
      }
      this.heads.set(notes[ci].id, { els: pick ? [pick] : [], cx, cy });
    }
  }

  private px(u: number): number {
    return this.offX + u * 10 * this.scale;
  }
  private py(u: number): number {
    return this.offY + u * 10 * this.scale;
  }
  private get unit(): number {
    return 10 * this.scale;
  }

  private makeLayers(): void {
    this.layers = {} as typeof this.layers;
    for (const k of ['bg', 'nx', 'ghost', 'lbl', 'fx', 'ph'] as const) this.layers[k] = sv('g', { class: 'l-' + k }, this.ov);
  }
  private clearOverlay(): void {
    for (const g of Object.values(this.layers)) g.textContent = '';
    this.ph = null;
  }
  private resetState(): void {
    this.marks.clear();
    this.labels.clear();
    this.ghosts = [];
    this.curSys = -1;
  }

  /** Forget judgments, labels and ghosts (new run). */
  clearMarks(): void {
    for (const [id] of this.marks) this.paintHead(id, null);
    this.resetState();
    if (this.ready) this.repaint();
  }

  /** Repaint everything from stored state (after an engrave). */
  private repaint(): void {
    this.clearOverlay();
    if (!this.ready) return;
    this.drawBands();
    for (const [id, m] of this.marks) this.paintHead(id, m);
    this.drawRings();
    for (const [id, err] of this.labels) this.drawLabel(id, err);
    for (const g of this.ghosts) this.drawGhost(g);
    this.makePlayhead();
  }

  setMark(id: string, m: Mark): void {
    if (m) this.marks.set(id, m);
    else this.marks.delete(id);
    if (this.ready) this.paintHead(id, m);
  }

  /** Set the "next to play" notes (replaces the previous set). */
  setNext(ids: string[]): void {
    for (const [id, m] of this.marks) if (m === 'next') this.setMark(id, null);
    for (const id of ids) if (!this.marks.has(id) || this.marks.get(id) === 'next') this.setMark(id, 'next');
    if (this.ready) this.drawRings();
  }

  private paintHead(id: string, m: Mark): void {
    const h = this.heads.get(id);
    if (!h) return;
    for (const el of h.els) {
      [...el.classList].filter((c) => c.startsWith('ks-')).forEach((c) => el.classList.remove(c));
      if (m === 'next') el.classList.add('ks-nx');
      else if (m === 'off') el.classList.add('ks-off');
      else if (m) el.classList.add('ks-j', 'ks-j-' + m);
    }
  }

  private drawRings(): void {
    const g = this.layers.nx;
    g.textContent = '';
    const u = this.unit;
    for (const [id, m] of this.marks) {
      if (m !== 'next') continue;
      const h = this.heads.get(id);
      if (h) sv('ellipse', { cx: h.cx.toFixed(1), cy: h.cy.toFixed(1), rx: (u * 1.15).toFixed(1), ry: (u * 0.9).toFixed(1), class: 'ring' }, g);
    }
  }

  /** ±ms under a Great/Good notehead, like the mockup. */
  label(id: string, err: number): void {
    this.labels.set(id, err);
    if (this.ready) this.drawLabel(id, err);
  }
  private drawLabel(id: string, err: number): void {
    const h = this.heads.get(id);
    if (!h) return;
    const t = sv('text', { x: h.cx.toFixed(1), y: (h.cy + this.unit * 2.1).toFixed(1), class: 'msl ' + (err < 0 ? 'e' : 'l') }, this.layers.lbl);
    t.textContent = (err > 0 ? '+' : '−') + Math.round(Math.abs(err));
  }

  halo(id: string, j: Judgment): void {
    const h = this.heads.get(id);
    if (!h || !this.ready || reduced()) return;
    const col = { perfect: '--j-perfect', ok: '--j-perfect', great: '--j-great', good: '--j-good', okw: '--j-good', miss: '--j-miss' }[j];
    const c = sv('circle', { cx: h.cx.toFixed(1), cy: h.cy.toFixed(1), r: (this.unit * 1.1).toFixed(1), class: 'halo', style: `stroke:var(${col})` }, this.layers.fx);
    setTimeout(() => c.remove(), 600);
  }

  /** Red dashed notehead where a wrong key was actually played. */
  ghost(midi: number, measure: number, beat: number): void {
    const g = { midi, measure, beat };
    this.ghosts.push(g);
    if (this.ready) this.drawGhost(g);
  }
  private drawGhost(g: { midi: number; measure: number; beat: number }): void {
    const sp = this.spans[g.measure];
    if (!sp) return;
    const u = this.unit;
    const staff =
      (g.midi >= 60 ? sp.staves.find((s) => s.clef === 'G') : [...sp.staves].reverse().find((s) => s.clef === 'F')) ??
      (g.midi >= 60 ? sp.staves[0] : sp.staves[sp.staves.length - 1]);
    const x = this.px(xAtBeat(sp, g.beat) + 0.6);
    const off = staffOffset(diatonic(g.midi), staff.clef);
    const y = this.py(staff.top + off);
    const grp = sv('g', { class: 'ghost' }, this.layers.ghost);
    let d = '';
    for (let l = -1; l >= off - 0.01; l--) d += `M${(x - u * 1.05).toFixed(1)} ${this.py(staff.top + l).toFixed(1)}H${(x + u * 1.05).toFixed(1)}`;
    for (let l = 5; l <= off + 0.01; l++) d += `M${(x - u * 1.05).toFixed(1)} ${this.py(staff.top + l).toFixed(1)}H${(x + u * 1.05).toFixed(1)}`;
    if (d) sv('path', { d, class: 'ledger' }, grp);
    sv('ellipse', { cx: x.toFixed(1), cy: y.toFixed(1), rx: (u * 0.62).toFixed(1), ry: (u * 0.44).toFixed(1), transform: `rotate(-20 ${x.toFixed(1)} ${y.toFixed(1)})`, class: 'hd' }, grp);
    if (isSharp(g.midi)) {
      const t = sv('text', { x: (x - u * 1.7).toFixed(1), y: (y + u * 0.5).toFixed(1), 'font-size': (u * 1.6).toFixed(1) }, grp);
      t.textContent = '♯';
    }
  }

  setLoop(loop: { from: number; to: number } | null): void {
    this.loop = loop;
    if (this.ready) this.repaint();
  }

  setTints(acc: (number | null)[] | null): void {
    this.tints = acc;
    if (this.ready) this.repaint();
  }

  private measureBox(i: number): { x: number; y: number; w: number; h: number } | null {
    const sp = this.spans[i];
    const sys = sp && this.systems[sp.sys];
    if (!sp || !sys) return null;
    const x = this.px(sp.x0 - 0.8);
    return { x, y: this.py(sys.top + 1), w: this.px(sp.x1) - x, h: (sys.bottom - sys.top - 2.6) * this.unit };
  }

  private drawBands(): void {
    const bg = this.layers.bg;
    const lbl = this.layers.lbl;
    if (this.tints) {
      this.tints.forEach((a, i) => {
        const b = a == null ? null : this.measureBox(i);
        if (!b || a == null) return;
        sv('rect', { x: b.x + 2, y: b.y, width: Math.max(0, b.w - 4), height: b.h, rx: 4, class: 'tint', style: `fill:${heat(a)}` }, bg);
        const t = sv('text', { x: b.x + b.w - 5, y: b.y + 10, class: 'tlbl', style: `fill:${heat(a)}` }, lbl);
        t.textContent = Math.round(a * 100) + '%';
      });
    }
    if (this.loop) {
      for (let m = this.loop.from; m <= this.loop.to; m++) {
        const b = this.measureBox(m);
        if (!b) continue;
        sv('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'band' }, bg);
        if (m === this.loop.from) sv('text', { x: b.x + 4, y: b.y + b.h - 4, class: 'band-l' }, bg).textContent = 'A';
        if (m === this.loop.to) sv('text', { x: b.x + b.w - 11, y: b.y + b.h - 4, class: 'band-l' }, bg).textContent = 'B';
      }
    }
  }

  private makePlayhead(): void {
    this.ph = sv('g', { class: 'ph', visibility: 'hidden' }, this.layers.ph);
    this.curSys = -1;
  }

  /** Move the playhead to `beat` (quarters) of `measure`; `lead` draws it just before the note. */
  playhead(measure: number, beat: number, lead = false, instant = false): void {
    const sp = this.spans[measure];
    const ph = this.ph;
    if (!sp || !ph) return;
    const sys = this.systems[sp.sys];
    let x = this.px(xAtBeat(sp, beat) + 0.6);
    if (lead) x -= this.unit * 1.2;
    const top = this.py(sys.top + 1);
    const bot = this.py(sys.bottom - 1);
    if (this.curSys !== sp.sys) {
      ph.textContent = '';
      const u = this.unit;
      sv('rect', { x: -u * 0.9, y: 0, width: u * 1.8, height: bot - top, rx: 3, class: 'ph-band' }, ph);
      sv('path', { d: `M0 0V${bot - top}`, class: 'ph-line' }, ph);
      sv('path', { d: 'M-4.5 -5H4.5L0 0Z', class: 'ph-tri' }, ph);
      this.curSys = sp.sys;
      this.scrollTo(this.py(sys.top), instant);
    }
    ph.setAttribute('visibility', 'visible');
    ph.setAttribute('transform', `translate(${x.toFixed(1)} ${top.toFixed(1)})`);
  }

  hidePlayhead(): void {
    this.ph?.setAttribute('visibility', 'hidden');
  }

  private scrollTo(top: number, instant: boolean): void {
    const s = this.opts.scroller;
    if (!s || s.scrollHeight <= s.clientHeight + 2) return;
    const hostTop = this.host.offsetTop;
    s.scrollTo({ top: Math.max(0, hostTop + top), behavior: instant || reduced() ? 'auto' : 'smooth' });
  }

  /** Height in px of a window that shows exactly one system (never a sliver of the next). */
  systemHeight(): number {
    let h = 0;
    let pitch = Infinity;
    const sys = this.systems.filter((s) => Number.isFinite(s.top));
    // windows start at a system's top, but never above the top of the scroll area
    const startPx = (x: { top: number }) => Math.max(0, this.py(x.top));
    sys.forEach((s, i) => {
      h = Math.max(h, (s.bottom - s.top) * this.unit);
      if (i > 0) pitch = Math.min(pitch, this.py(s.top) - startPx(sys[i - 1]));
    });
    return Math.min(h, pitch);
  }

  /** Re-engrave now (e.g. after the zoom rule changed). */
  rezoom(): void {
    if (this.osmd && this.chart?.musicXml) this.engrave();
  }

  setZoomFor(fn: (width: number) => number): void {
    this.opts.zoomFor = fn;
  }

  /** Total engraved height in px. */
  contentHeight(): number {
    return Number(this.ov.getAttribute('height')) || this.host.scrollHeight;
  }
}
