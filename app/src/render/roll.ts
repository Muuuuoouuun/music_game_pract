/**
 * Piano-roll renderer for the editor. DOM-free: it draws into a canvas it is handed
 * and reads everything else from the chart and a `RollView`.
 *
 * Geometry: time runs left → right (`pxPerSec`, 20–400, scrolled by `scrollMs`), pitch
 * top → bottom (one row per key, C8 at the top, A0 at the bottom, scrolled by
 * `scrollY` px). A top strip holds the bar ruler and, when a recording is attached,
 * its waveform aligned with `chart.audio.offsetMs` (audio ms = chart ms + offset).
 * A left gutter draws the keyboard. Everything is in CSS pixels; `size.dpr` scales the
 * backing store for HiDPI.
 */
import { isBlackKey, noteName, type Chart, type ChartNote, type Hand } from '../core/chart';
import { MIDI_MAX, MIDI_MIN, SNAP_QUARTERS, timingOf, type SnapDivision } from '../core/edit';
import { LANE_HUE } from './lanes';

export const ZOOM_MIN = 20;
export const ZOOM_MAX = 400;
export const ROWS = MIDI_MAX - MIDI_MIN + 1;

export interface GhostNote {
  midi: number;
  startMs: number;
  durationMs: number;
  hand: Hand;
}

export interface RollWave {
  peaks: Float32Array;
  durationMs: number;
  /** Audio position that plays at chart time 0. */
  offsetMs: number;
}

export interface RollView {
  pxPerSec: number;
  /** Chart time at the left edge of the grid. */
  scrollMs: number;
  /** Pixels scrolled down from the C8 row. */
  scrollY: number;
  rowH: number;
  snap: SnapDivision | 'off';
  /** Where playback starts (dashed line) while stopped. */
  cursorMs: number;
  /** Playhead while playing. */
  playMs: number | null;
  selection: ReadonlySet<string>;
  hoverId: string | null;
  ghost: GhostNote | null;
  /** Rubber-band rectangle in canvas CSS pixels. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  wave: RollWave | null;
}

export interface RollSize {
  w: number;
  h: number;
  dpr: number;
}

export interface RollLayout {
  w: number;
  h: number;
  gutterW: number;
  rulerH: number;
  waveH: number;
  /** Ruler + waveform. */
  topH: number;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

export interface RollTheme {
  bg: string;
  rowWhite: string;
  rowBlack: string;
  octaveLine: string;
  barLine: string;
  beatLine: string;
  subLine: string;
  text: string;
  dim: string;
  faint: string;
  rulerBg: string;
  waveBg: string;
  wave: string;
  keyWhite: string;
  keyBlack: string;
  keyText: string;
  noteL: string;
  noteLStroke: string;
  noteText: string;
  select: string;
  hover: string;
  playhead: string;
  cursor: string;
  ghost: string;
  box: string;
  boxFill: string;
  pastEnd: string;
}

export const DEFAULT_THEME: RollTheme = {
  bg: '#0f0c2b',
  rowWhite: 'rgba(245,239,226,0.045)',
  rowBlack: 'rgba(0,0,0,0.18)',
  octaveLine: 'rgba(172,167,216,0.35)',
  barLine: 'rgba(241,236,255,0.42)',
  beatLine: 'rgba(241,236,255,0.14)',
  subLine: 'rgba(241,236,255,0.06)',
  text: '#f1ecff',
  dim: '#aca7d8',
  faint: '#77729f',
  rulerBg: '#151236',
  waveBg: '#0a0820',
  wave: 'rgba(118,224,255,0.55)',
  keyWhite: '#e9e3d4',
  keyBlack: '#2a2456',
  keyText: '#3b345f',
  noteL: 'rgba(197,75,140,0.78)',
  noteLStroke: '#f0a0cf',
  noteText: 'rgba(10,8,32,0.85)',
  select: '#ffcd78',
  hover: 'rgba(255,255,255,0.35)',
  playhead: '#ffcd78',
  cursor: 'rgba(172,167,216,0.7)',
  ghost: 'rgba(241,236,255,0.6)',
  box: '#ffcd78',
  boxFill: 'rgba(255,205,120,0.12)',
  pastEnd: 'rgba(0,0,0,0.28)',
};

export function defaultView(): RollView {
  return {
    pxPerSec: 120,
    scrollMs: 0,
    scrollY: 0,
    rowH: 14,
    snap: 16,
    cursorMs: 0,
    playMs: null,
    selection: new Set(),
    hoverId: null,
    ghost: null,
    box: null,
    wave: null,
  };
}

export function layoutRoll(view: RollView, size: { w: number; h: number }): RollLayout {
  const rulerH = 22;
  const waveH = view.wave ? 44 : 0;
  const topH = rulerH + waveH;
  const gutterW = size.w < 520 ? 34 : 46;
  return {
    w: size.w,
    h: size.h,
    gutterW,
    rulerH,
    waveH,
    topH,
    gridX: gutterW,
    gridY: topH,
    gridW: Math.max(0, size.w - gutterW),
    gridH: Math.max(0, size.h - topH),
  };
}

/* ---- coordinate helpers ---- */

export const xOfMs = (view: RollView, L: RollLayout, ms: number): number => L.gridX + ((ms - view.scrollMs) / 1000) * view.pxPerSec;
export const msOfX = (view: RollView, L: RollLayout, x: number): number => view.scrollMs + ((x - L.gridX) / view.pxPerSec) * 1000;
/** Top edge of the row for `midi`. */
export const yOfMidi = (view: RollView, L: RollLayout, midi: number): number => L.gridY + (MIDI_MAX - midi) * view.rowH - view.scrollY;
export const midiOfY = (view: RollView, L: RollLayout, y: number): number =>
  Math.max(MIDI_MIN, Math.min(MIDI_MAX, MIDI_MAX - Math.floor((y - L.gridY + view.scrollY) / view.rowH)));
export const visibleMs = (view: RollView, L: RollLayout): number => (L.gridW / view.pxPerSec) * 1000;

/** Keeps scroll positions inside the chart (with room past the end to add notes) and the zoom in range. */
export function clampView(view: RollView, L: RollLayout, chart: Chart): void {
  view.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.pxPerSec));
  const vis = visibleMs(view, L);
  const maxMs = Math.max(0, chart.meta.durationMs + Math.max(2000, vis * 0.5) - vis);
  view.scrollMs = Math.max(0, Math.min(maxMs, view.scrollMs));
  view.scrollY = Math.max(0, Math.min(Math.max(0, ROWS * view.rowH - L.gridH), view.scrollY));
}

/** Scrolls vertically so the chart's pitch range (or middle C) sits in the middle. */
export function fitVertical(chart: Chart, view: RollView, L: RollLayout): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of chart.notes) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
  }
  const center = Number.isFinite(lo) ? (lo + hi) / 2 : 60;
  view.scrollY = (MIDI_MAX - center + 0.5) * view.rowH - L.gridH / 2;
  clampView(view, L, chart);
}

/** Zooms around canvas x, keeping the time under the pointer fixed. */
export function zoomAt(view: RollView, L: RollLayout, chart: Chart, factor: number, x: number): void {
  const ms = msOfX(view, L, x);
  view.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.pxPerSec * factor));
  view.scrollMs = ms - ((x - L.gridX) / view.pxPerSec) * 1000;
  clampView(view, L, chart);
}

export interface Hit {
  note: ChartNote;
  /** Pointer is on the right edge (resize handle). */
  edge: boolean;
}

const EDGE_PX = 7;

/** Topmost note under canvas point (x, y); later (higher) notes win like they draw. */
export function hitTest(chart: Chart, view: RollView, L: RollLayout, x: number, y: number): Hit | null {
  if (x < L.gridX || y < L.gridY) return null;
  const midi = midiOfY(view, L, y);
  const ms = msOfX(view, L, x);
  let best: ChartNote | null = null;
  for (const n of chart.notes) {
    if (n.midi !== midi) continue;
    const x0 = xOfMs(view, L, n.startMs);
    const x1 = Math.max(x0 + 4, xOfMs(view, L, n.startMs + n.durationMs));
    if (x >= x0 - 1 && x <= x1 + 1) best = n;
    if (n.startMs > ms + 1000) break;
  }
  if (!best) return null;
  const x1 = Math.max(xOfMs(view, L, best.startMs) + 4, xOfMs(view, L, best.startMs + best.durationMs));
  const wide = x1 - xOfMs(view, L, best.startMs) > EDGE_PX * 2;
  return { note: best, edge: wide && x >= x1 - EDGE_PX };
}

/** Ids of notes touching a canvas rectangle. */
export function notesInBox(chart: Chart, view: RollView, L: RollLayout, box: { x0: number; y0: number; x1: number; y1: number }): string[] {
  const xa = Math.min(box.x0, box.x1);
  const xb = Math.max(box.x0, box.x1);
  const ya = Math.min(box.y0, box.y1);
  const yb = Math.max(box.y0, box.y1);
  const out: string[] = [];
  for (const n of chart.notes) {
    const x0 = xOfMs(view, L, n.startMs);
    const x1 = Math.max(x0 + 4, xOfMs(view, L, n.startMs + n.durationMs));
    const y0 = yOfMidi(view, L, n.midi);
    const y1 = y0 + view.rowH;
    if (x1 >= xa && x0 <= xb && y1 >= ya && y0 <= yb) out.push(n.id);
  }
  return out;
}

/* ---- drawing ---- */

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function noteFill(hand: Hand, midi: number, alpha: number, theme: RollTheme): string {
  if (hand === 'L') return theme.noteL.replace(/[\d.]+\)$/, `${alpha})`);
  return `hsla(${LANE_HUE[((midi % 12) + 12) % 12]},82%,64%,${alpha})`;
}

const FONT = '"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace';
const FONT_UI = '"IBM Plex Sans KR","Apple SD Gothic Neo",system-ui,sans-serif';

/** Draws the whole roll. Returns the layout used so callers can hit-test with it. */
export function drawRoll(canvas: HTMLCanvasElement, chart: Chart, view: RollView, size: RollSize, theme: RollTheme = DEFAULT_THEME): RollLayout {
  const dpr = size.dpr || 1;
  const pw = Math.max(1, Math.round(size.w * dpr));
  const ph = Math.max(1, Math.round(size.h * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const L = layoutRoll(view, size);
  clampView(view, L, chart);
  const ctx = canvas.getContext('2d');
  if (!ctx) return L;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, L.w, L.h);

  const t0 = view.scrollMs;
  const t1 = msOfX(view, L, L.w);
  const rowLo = midiOfY(view, L, L.h);
  const rowHi = midiOfY(view, L, L.gridY);

  // Rows
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.gridX, L.gridY, L.gridW, L.gridH);
  ctx.clip();
  for (let m = rowLo; m <= rowHi; m++) {
    const y = yOfMidi(view, L, m);
    ctx.fillStyle = isBlackKey(m) ? theme.rowBlack : theme.rowWhite;
    ctx.fillRect(L.gridX, y, L.gridW, view.rowH);
    if (m % 12 === 0 || m % 12 === 5) {
      ctx.fillStyle = theme.octaveLine;
      ctx.fillRect(L.gridX, y + view.rowH - 0.5, L.gridW, 1);
    }
  }
  // Space past the chart's end
  const endX = xOfMs(view, L, chart.meta.durationMs);
  if (endX < L.w) {
    ctx.fillStyle = theme.pastEnd;
    ctx.fillRect(endX, L.gridY, L.w - endX, L.gridH);
  }
  // Grid lines
  const spec = timingOf(chart);
  const pickup = spec.offsetMs > 0 && chart.measures.length > 1;
  for (const m of chart.measures) {
    const mEnd = m.startMs + m.durationMs;
    if (mEnd < t0 || m.startMs > t1) continue;
    const qms = 60000 / m.bpm;
    const beatQ = 4 / m.timeSignature[1];
    const beatPx = (beatQ * qms * view.pxPerSec) / 1000;
    const subQ = view.snap === 'off' ? 0 : SNAP_QUARTERS[view.snap];
    const subPx = (subQ * qms * view.pxPerSec) / 1000;
    if (subQ && subPx >= 5 && subQ < beatQ) {
      ctx.fillStyle = theme.subLine;
      for (let q = subQ; q < m.durationMs / qms - 1e-6; q += subQ) {
        const x = xOfMs(view, L, m.startMs + q * qms);
        if (x >= L.gridX && x <= L.w) ctx.fillRect(Math.round(x), L.gridY, 1, L.gridH);
      }
    }
    if (beatPx >= 4) {
      ctx.fillStyle = theme.beatLine;
      for (let q = beatQ; q < m.durationMs / qms - 1e-6; q += beatQ) {
        const x = xOfMs(view, L, m.startMs + q * qms);
        if (x >= L.gridX && x <= L.w) ctx.fillRect(Math.round(x), L.gridY, 1, L.gridH);
      }
    }
    const bx = Math.round(xOfMs(view, L, m.startMs));
    if (bx >= L.gridX - 1 && bx <= L.w) {
      ctx.fillStyle = theme.barLine;
      ctx.fillRect(bx, L.gridY, m.index === 0 && pickup ? 1 : 1.5, L.gridH);
    }
  }
  // Notes
  const noteH = Math.max(4, view.rowH - 3);
  const showText = view.rowH >= 12;
  ctx.font = `600 9.5px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const drawNote = (n: ChartNote, selected: boolean, hovered: boolean) => {
    if (n.midi < rowLo || n.midi > rowHi) return;
    const x0 = xOfMs(view, L, n.startMs);
    const x1 = Math.max(x0 + 4, xOfMs(view, L, n.startMs + n.durationMs));
    if (x1 < L.gridX || x0 > L.w) return;
    const y = yOfMidi(view, L, n.midi) + (view.rowH - noteH) / 2;
    const w = x1 - x0;
    const alpha = 0.6 + 0.4 * Math.min(1, n.velocity / 127);
    rrect(ctx, x0, y, w, noteH, 3);
    ctx.fillStyle = noteFill(n.hand, n.midi, alpha, theme);
    ctx.fill();
    if (n.hand === 'L') {
      ctx.strokeStyle = theme.noteLStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (hovered) {
      ctx.fillStyle = theme.hover;
      ctx.fill();
    }
    if (selected) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fill();
      ctx.save();
      ctx.shadowColor = theme.select;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 2;
      rrect(ctx, x0 - 0.5, y - 0.5, w + 1, noteH + 1, 3.5);
      ctx.stroke();
      ctx.restore();
    }
    if (showText && w > 30) {
      ctx.fillStyle = n.hand === 'L' ? '#fff' : theme.noteText;
      ctx.fillText(noteName(n.midi), x0 + 4, y + noteH / 2 + 0.5);
    }
  };
  for (const n of chart.notes) {
    if (n.startMs > t1) break;
    if (n.startMs + n.durationMs < t0) continue;
    if (view.selection.has(n.id) || n.id === view.hoverId) continue;
    drawNote(n, false, false);
  }
  for (const n of chart.notes) {
    if (n.startMs > t1) break;
    if (n.startMs + n.durationMs < t0) continue;
    if (view.selection.has(n.id) || n.id === view.hoverId) drawNote(n, view.selection.has(n.id), n.id === view.hoverId);
  }
  // Ghost (pencil preview)
  if (view.ghost) {
    const g = view.ghost;
    const x0 = xOfMs(view, L, g.startMs);
    const x1 = Math.max(x0 + 4, xOfMs(view, L, g.startMs + g.durationMs));
    const y = yOfMidi(view, L, g.midi) + (view.rowH - noteH) / 2;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = theme.ghost;
    ctx.lineWidth = 1;
    rrect(ctx, x0, y, x1 - x0, noteH, 3);
    ctx.fillStyle = noteFill(g.hand, g.midi, 0.25, theme);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // Rubber band
  if (view.box) {
    const b = view.box;
    ctx.fillStyle = theme.boxFill;
    ctx.strokeStyle = theme.box;
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    ctx.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
  }
  ctx.restore();

  // Top strip: ruler
  ctx.fillStyle = theme.rulerBg;
  ctx.fillRect(0, 0, L.w, L.rulerH);
  ctx.font = `500 10.5px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.gridX, 0, L.gridW, L.topH);
  ctx.clip();
  for (const m of chart.measures) {
    if (m.startMs + m.durationMs < t0 || m.startMs > t1) continue;
    const x = xOfMs(view, L, m.startMs);
    ctx.fillStyle = theme.barLine;
    ctx.fillRect(Math.round(x), 0, 1, L.topH);
    const label = pickup ? (m.index === 0 ? '' : String(m.index)) : String(m.index + 1);
    if (label) {
      ctx.fillStyle = theme.dim;
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 4, L.rulerH / 2 + 0.5);
    }
  }
  // Waveform
  if (view.wave && L.waveH) {
    const wv = view.wave;
    ctx.fillStyle = theme.waveBg;
    ctx.fillRect(L.gridX, L.rulerH, L.gridW, L.waveH);
    const buckets = wv.peaks.length;
    if (buckets && wv.durationMs > 0) {
      const mid = L.rulerH + L.waveH / 2;
      const amp = L.waveH / 2 - 2;
      ctx.fillStyle = theme.wave;
      const msPerBucket = wv.durationMs / buckets;
      const x0 = Math.max(L.gridX, Math.floor(xOfMs(view, L, -wv.offsetMs)));
      const x1 = Math.min(L.w, Math.ceil(xOfMs(view, L, wv.durationMs - wv.offsetMs)));
      for (let x = x0; x < x1; x++) {
        const a = (msOfX(view, L, x) + wv.offsetMs) / msPerBucket;
        const b = (msOfX(view, L, x + 1) + wv.offsetMs) / msPerBucket;
        const i0 = Math.max(0, Math.floor(a));
        const i1 = Math.min(buckets - 1, Math.max(i0, Math.ceil(b) - 1));
        let p = 0;
        for (let i = i0; i <= i1; i++) if (wv.peaks[i] > p) p = wv.peaks[i];
        const hh = Math.max(0.5, p * amp);
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
  }
  // Playhead / cursor
  const headMs = view.playMs ?? view.cursorMs;
  const hx = Math.round(xOfMs(view, L, headMs));
  if (hx >= L.gridX && hx <= L.w) {
    ctx.save();
    if (view.playMs === null) ctx.setLineDash([4, 4]);
    ctx.strokeStyle = view.playMs === null ? theme.cursor : theme.playhead;
    ctx.lineWidth = view.playMs === null ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, L.h);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = theme.playhead;
    ctx.beginPath();
    ctx.moveTo(hx - 5, 0);
    ctx.lineTo(hx + 6, 0);
    ctx.lineTo(hx + 0.5, 7);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Keyboard gutter
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, L.gridY, L.gutterW, L.gridH);
  ctx.clip();
  ctx.fillStyle = theme.keyWhite;
  ctx.fillRect(0, L.gridY, L.gutterW, L.gridH);
  ctx.font = `500 9.5px ${FONT_UI}`;
  ctx.textAlign = 'right';
  for (let m = rowLo; m <= rowHi; m++) {
    const y = yOfMidi(view, L, m);
    if (isBlackKey(m)) {
      ctx.fillStyle = theme.keyBlack;
      ctx.fillRect(0, y + 0.5, L.gutterW * 0.6, view.rowH - 1);
    } else if (m % 12 === 0 || m % 12 === 5) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, y + view.rowH - 0.5, L.gutterW, 1);
    }
    if (m % 12 === 0 && view.rowH >= 9) {
      ctx.fillStyle = theme.keyText;
      ctx.fillText(noteName(m), L.gutterW - 4, y + view.rowH / 2 + 0.5);
    }
  }
  ctx.restore();
  ctx.fillStyle = theme.rulerBg;
  ctx.fillRect(0, 0, L.gutterW, L.topH);
  ctx.fillStyle = theme.octaveLine;
  ctx.fillRect(L.gutterW - 1, 0, 1, L.h);
  ctx.fillRect(0, L.topH - 1, L.w, 1);
  return L;
}
