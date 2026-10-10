/**
 * The piano-roll canvas: sizing, drawing and every pointer/wheel interaction. Edits go
 * back to the editor through `RollHost` as whole charts, so the host owns undo.
 *
 *  - 선택: click selects (Shift adds), drag a note moves it (time + pitch), drag its right
 *    edge resizes, drag empty space rubber-bands (on touch: pans).
 *  - 연필: click on empty space adds a note one grid step long; keep dragging to set its
 *    length. Clicking a note behaves like 선택 for quick fixes.
 *  - 지우개: click or swipe over notes to delete them.
 *  - Ruler drag seeks, keyboard gutter click previews a pitch, wheel scrolls (Shift:
 *    horizontal), Ctrl+wheel zooms, two-finger pinch zooms.
 */
import { measureAt, type Chart, type ChartNote, type Hand } from '../../core/chart';
import { addNote, deleteNotes, moveNotes, newNoteId, resizeNotes, setNoteEnd, snapMs, snapStepMs } from '../../core/edit';
import {
  clampView,
  defaultView,
  drawRoll,
  fitVertical,
  hitTest,
  layoutRoll,
  midiOfY,
  msOfX,
  notesInBox,
  visibleMs,
  xOfMs,
  zoomAt,
  type RollLayout,
  type RollView,
} from '../../render/roll';
import type { EditorTool } from '../../state/editor-prefs';

export interface RollHost {
  readonly chart: Chart;
  readonly tool: EditorTool;
  /** Hand given to notes drawn with the pencil. */
  readonly hand: Hand;
  readonly selection: Set<string>;
  selectionChanged(): void;
  /** Begins a drag; later frames derive from the returned chart. */
  dragStart(): Chart;
  dragUpdate(next: Chart): void;
  dragEnd(): void;
  /** A one-step edit. */
  commit(next: Chart): void;
  seek(ms: number): void;
  preview(midi: number): void;
  /** Length for a pencil click in ms. */
  newNoteDuration(): number;
}

type Mode = 'move' | 'resize' | 'create' | 'box' | 'seek' | 'pan' | 'erase' | 'pinch' | null;

export class RollCanvas {
  readonly el: HTMLCanvasElement;
  readonly view: RollView = defaultView();
  layout: RollLayout;
  private host: RollHost;
  private size = { w: 300, h: 200, dpr: 1 };
  private needsDraw = true;
  private mode: Mode = null;
  private down = { x: 0, y: 0, scrollMs: 0, scrollY: 0, shift: false };
  private base: Chart | null = null;
  private primary: ChartNote | null = null;
  private created: { id: string; startMs: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch = { dist: 0, pxPerSec: 0, ms: 0 };
  private container: HTMLElement;

  constructor(host: RollHost, container: HTMLElement) {
    this.host = host;
    this.container = container;
    this.el = document.createElement('canvas');
    this.el.setAttribute('aria-label', '피아노 롤');
    this.el.tabIndex = -1;
    container.appendChild(this.el);
    this.layout = layoutRoll(this.view, this.size);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e));
    this.el.addEventListener('pointerleave', () => {
      if (this.mode) return;
      this.view.hoverId = null;
      this.view.ghost = null;
      this.requestDraw();
    });
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.resize()).observe(container);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.size = { w, h, dpr: window.devicePixelRatio || 1 };
    this.layout = layoutRoll(this.view, this.size);
    clampView(this.view, this.layout, this.host.chart);
    this.requestDraw();
  }

  requestDraw(): void {
    this.needsDraw = true;
  }

  /** Draws when something changed; called from the app's rAF loop. */
  frame(): void {
    if (!this.needsDraw || !this.size.w || !this.size.h) return;
    this.needsDraw = false;
    this.layout = drawRoll(this.el, this.host.chart, this.view, this.size);
  }

  /** Scrolls to the start and centers the pitch range. */
  fit(): void {
    this.resize();
    this.view.scrollMs = 0;
    fitVertical(this.host.chart, this.view, this.layout);
    this.requestDraw();
  }

  /** Keeps the playhead in view, paging ahead when it nears the right edge. */
  follow(ms: number): void {
    const L = this.layout;
    const x = xOfMs(this.view, L, ms);
    if (x > L.gridX + L.gridW * 0.9 || x < L.gridX) {
      this.view.scrollMs = ms - visibleMs(this.view, L) * 0.1;
      clampView(this.view, L, this.host.chart);
    }
    this.requestDraw();
  }

  zoomBy(factor: number): void {
    zoomAt(this.view, this.layout, this.host.chart, factor, this.layout.gridX + this.layout.gridW / 2);
    this.requestDraw();
  }

  /* ---- helpers ---- */

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private snap(chart: Chart, ms: number): number {
    return this.view.snap === 'off' ? Math.max(0, ms) : snapMs(chart, ms, this.view.snap);
  }

  private step(chart: Chart, ms: number): number {
    return this.view.snap === 'off' ? 0 : snapStepMs(chart, ms, this.view.snap);
  }

  /** Start of the grid cell containing `ms` (what a pencil click fills). */
  private cellStart(chart: Chart, ms: number): number {
    if (this.view.snap === 'off' || !chart.measures.length) return Math.max(0, ms);
    const m = chart.measures[measureAt(chart, ms)];
    const step = snapStepMs(chart, ms, this.view.snap);
    return Math.max(0, m.startMs + Math.floor((ms - m.startMs) / step + 1e-6) * step);
  }

  private inGrid(p: { x: number; y: number }): boolean {
    const L = this.layout;
    return p.x >= L.gridX && p.y >= L.gridY && p.x <= L.w && p.y <= L.h;
  }

  private setCursor(c: string): void {
    if (this.el.style.cursor !== c) this.el.style.cursor = c;
  }

  /* ---- pointer ---- */

  private onDown(e: PointerEvent): void {
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.el.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2 && e.pointerType === 'touch') {
      this.cancelDrag();
      const [a, b] = [...this.pointers.values()];
      this.mode = 'pinch';
      this.pinch = { dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), pxPerSec: this.view.pxPerSec, ms: msOfX(this.view, this.layout, (a.x + b.x) / 2) };
      return;
    }
    if (this.mode) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const L = this.layout;
    const chart = this.host.chart;
    this.down = { x: p.x, y: p.y, scrollMs: this.view.scrollMs, scrollY: this.view.scrollY, shift: e.shiftKey };
    this.el.focus({ preventScroll: true });

    if (p.y < L.topH && p.x >= L.gridX) {
      this.mode = 'seek';
      this.host.seek(this.snap(chart, msOfX(this.view, L, p.x)));
      return;
    }
    if (p.x < L.gridX && p.y >= L.gridY) {
      this.host.preview(midiOfY(this.view, L, p.y));
      return;
    }
    if (!this.inGrid(p)) return;

    const hit = hitTest(chart, this.view, L, p.x, p.y);
    const tool = this.host.tool;
    const sel = this.host.selection;

    if (tool === 'eraser') {
      this.mode = 'erase';
      if (hit) this.host.commit(deleteNotes(chart, [hit.note.id]));
      return;
    }
    if (hit) {
      if (e.shiftKey) {
        if (sel.has(hit.note.id)) sel.delete(hit.note.id);
        else sel.add(hit.note.id);
        this.host.selectionChanged();
        this.requestDraw();
        return;
      }
      if (!sel.has(hit.note.id)) {
        sel.clear();
        sel.add(hit.note.id);
        this.host.selectionChanged();
      }
      this.primary = hit.note;
      this.base = this.host.dragStart();
      this.mode = hit.edge ? 'resize' : 'move';
      this.setCursor(hit.edge ? 'ew-resize' : 'grabbing');
      this.requestDraw();
      return;
    }
    if (tool === 'pencil') {
      const ms = this.cellStart(chart, msOfX(this.view, L, p.x));
      const midi = midiOfY(this.view, L, p.y);
      const id = newNoteId(chart);
      this.base = this.host.dragStart();
      this.created = { id, startMs: ms };
      this.host.dragUpdate(addNote(this.base, { id, midi, startMs: ms, durationMs: this.host.newNoteDuration(), hand: this.host.hand }));
      sel.clear();
      sel.add(id);
      this.host.selectionChanged();
      this.mode = 'create';
      this.view.ghost = null;
      this.requestDraw();
      return;
    }
    if (e.pointerType === 'touch') {
      this.mode = 'pan';
      return;
    }
    this.mode = 'box';
    this.view.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    this.requestDraw();
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    const L = this.layout;
    const chart = this.host.chart;
    switch (this.mode) {
      case null: {
        this.hover(p);
        return;
      }
      case 'pinch': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
        const cx = (a.x + b.x) / 2;
        this.view.pxPerSec = Math.max(20, Math.min(400, (this.pinch.pxPerSec * dist) / this.pinch.dist));
        this.view.scrollMs = this.pinch.ms - ((cx - L.gridX) / this.view.pxPerSec) * 1000;
        clampView(this.view, L, chart);
        this.requestDraw();
        return;
      }
      case 'seek': {
        this.host.seek(this.snap(chart, msOfX(this.view, L, Math.max(L.gridX, p.x))));
        return;
      }
      case 'pan': {
        this.view.scrollMs = this.down.scrollMs - ((p.x - this.down.x) / this.view.pxPerSec) * 1000;
        this.view.scrollY = this.down.scrollY - (p.y - this.down.y);
        clampView(this.view, L, chart);
        this.requestDraw();
        return;
      }
      case 'erase': {
        const hit = hitTest(chart, this.view, L, p.x, p.y);
        if (hit) this.host.commit(deleteNotes(chart, [hit.note.id]));
        return;
      }
      case 'box': {
        if (this.view.box) {
          this.view.box.x1 = p.x;
          this.view.box.y1 = p.y;
          this.requestDraw();
        }
        return;
      }
      case 'move': {
        if (!this.base || !this.primary) return;
        const rawMs = this.primary.startMs + ((p.x - this.down.x) / this.view.pxPerSec) * 1000;
        const dMs = this.snap(this.base, rawMs) - this.primary.startMs;
        const dMidi = -Math.round((p.y - this.down.y) / this.view.rowH);
        this.host.dragUpdate(moveNotes(this.base, this.host.selection, { dMs, dMidi }));
        return;
      }
      case 'resize': {
        if (!this.base || !this.primary) return;
        const end0 = this.primary.startMs + this.primary.durationMs;
        const rawEnd = end0 + ((p.x - this.down.x) / this.view.pxPerSec) * 1000;
        let end = this.snap(this.base, rawEnd);
        const step = this.step(this.base, this.primary.startMs);
        if (end <= this.primary.startMs) end = this.primary.startMs + (step || 30);
        this.host.dragUpdate(resizeNotes(this.base, this.host.selection, end - end0));
        return;
      }
      case 'create': {
        if (!this.base || !this.created) return;
        const { id, startMs } = this.created;
        const cur = this.host.chart;
        const raw = msOfX(this.view, L, p.x);
        const step = this.step(cur, startMs);
        let end = step ? this.cellStart(cur, raw) + step : raw;
        end = Math.max(startMs + (step || 30), end);
        this.host.dragUpdate(setNoteEnd(cur, [id], end));
        return;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const p = this.local(e);
    switch (this.mode) {
      case 'pinch':
        if (this.pointers.size < 2) this.mode = null;
        return;
      case 'box': {
        const box = this.view.box;
        this.view.box = null;
        if (box) {
          const ids = notesInBox(this.host.chart, this.view, this.layout, box);
          const sel = this.host.selection;
          if (!this.down.shift) sel.clear();
          for (const id of ids) sel.add(id);
          this.host.selectionChanged();
        }
        break;
      }
      case 'move':
      case 'resize':
      case 'create':
        this.host.dragEnd();
        break;
    }
    this.mode = null;
    this.base = null;
    this.primary = null;
    this.created = null;
    this.hover(p);
    this.requestDraw();
  }

  private cancelDrag(): void {
    if ((this.mode === 'move' || this.mode === 'resize' || this.mode === 'create') && this.base) {
      this.host.dragUpdate(this.base);
      this.host.dragEnd();
    }
    this.view.box = null;
    this.mode = null;
    this.base = null;
    this.primary = null;
    this.created = null;
  }

  private hover(p: { x: number; y: number }): void {
    const L = this.layout;
    const chart = this.host.chart;
    const tool = this.host.tool;
    let hoverId: string | null = null;
    let ghost: RollView['ghost'] = null;
    let cursor = 'default';
    if (p.y < L.topH && p.x >= L.gridX) cursor = 'col-resize';
    else if (p.x < L.gridX && p.y >= L.gridY) cursor = 'pointer';
    else if (this.inGrid(p)) {
      const hit = hitTest(chart, this.view, L, p.x, p.y);
      if (hit) {
        hoverId = hit.note.id;
        cursor = tool === 'eraser' ? 'not-allowed' : hit.edge ? 'ew-resize' : 'grab';
      } else if (tool === 'pencil') {
        const ms = this.cellStart(chart, msOfX(this.view, L, p.x));
        ghost = { midi: midiOfY(this.view, L, p.y), startMs: ms, durationMs: this.host.newNoteDuration(), hand: this.host.hand };
        cursor = 'crosshair';
      } else cursor = tool === 'eraser' ? 'default' : 'crosshair';
    }
    this.setCursor(cursor);
    const ghostChanged = !!ghost !== !!this.view.ghost || (ghost && this.view.ghost && (ghost.midi !== this.view.ghost.midi || ghost.startMs !== this.view.ghost.startMs));
    if (hoverId !== this.view.hoverId || ghostChanged) {
      this.view.hoverId = hoverId;
      this.view.ghost = ghost;
      this.requestDraw();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const chart = this.host.chart;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(this.view, this.layout, chart, Math.exp(-e.deltaY * 0.0015), p.x);
    } else {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.layout.gridH : 1;
      let dx = e.deltaX * k;
      let dy = e.deltaY * k;
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      this.view.scrollMs += (dx / this.view.pxPerSec) * 1000;
      this.view.scrollY += dy;
      clampView(this.view, this.layout, chart);
    }
    this.hover(p);
    this.requestDraw();
  }
}
