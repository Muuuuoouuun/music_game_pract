/**
 * On-screen piano: ivory/ebony keys laid out with the same lane geometry as the highway,
 * lit per pitch hue when held, with PC key labels where the computer keyboard maps.
 * Pointer presses (mouse, touch, pen; sliding across keys) are reported via `onPress`.
 */
import { noteName } from '../core/chart';
import { PC_LABEL } from '../input/hub';
import { LANE_HUE, laneLayout, type LaneLayout } from '../render/lanes';
import { restartAnim } from './dom';

export class PianoKeys {
  readonly el: HTMLElement;
  layout: LaneLayout = laneLayout(60, 76);
  private keys = new Map<number, HTMLElement>();
  private held = new Map<number, number>();
  private ptr = new Map<number, number>();
  private labels: boolean;
  private interactive: boolean;
  onPress: ((type: 'on' | 'off', midi: number, time: number) => void) | null = null;

  constructor(el: HTMLElement, opts: { labels?: boolean; interactive?: boolean } = {}) {
    this.el = el;
    this.labels = opts.labels ?? true;
    this.interactive = opts.interactive !== false;
    if (this.interactive) this.bindPointer();
  }

  build(lo: number, hi: number): void {
    this.layout = laneLayout(lo, hi);
    this.keys.clear();
    this.held.clear();
    const frag = document.createDocumentFragment();
    for (let m = lo; m <= hi; m++) {
      const ln = this.layout.lane[m];
      const h = LANE_HUE[m % 12];
      const pc = this.labels ? PC_LABEL[m] : undefined;
      const k = document.createElement(this.interactive ? 'button' : 'span');
      if (k instanceof HTMLButtonElement) {
        k.type = 'button';
        k.tabIndex = -1;
      }
      k.className = 'key ' + (ln.b ? 'b' : 'w');
      k.dataset.midi = String(m);
      k.style.cssText = `left:${ln.l * 100}%;width:${ln.w * 100}%;--c:hsl(${h} 95% 62%);--c2:hsl(${h} 100% 86%);--c3:hsl(${h} 70% 28%)`;
      k.setAttribute('aria-label', noteName(m) + (pc ? ` (${pc})` : ''));
      if (this.labels) k.innerHTML = (m % 12 === 0 ? `<span class="nn">${noteName(m)}</span>` : '') + (pc ? `<span class="pc">${pc}</span>` : '');
      frag.appendChild(k);
      this.keys.set(m, k);
    }
    this.el.replaceChildren(frag);
  }

  has(m: number): boolean {
    return this.keys.has(m);
  }

  down(m: number): void {
    this.held.set(m, (this.held.get(m) ?? 0) + 1);
    this.keys.get(m)?.classList.add('down');
  }

  up(m: number): void {
    const n = Math.max(0, (this.held.get(m) ?? 0) - 1);
    this.held.set(m, n);
    if (!n) this.keys.get(m)?.classList.remove('down');
  }

  wrong(m: number): void {
    const k = this.keys.get(m);
    if (k) restartAnim(k, 'wrong');
  }

  setTargets(midis: number[]): void {
    for (const [m, k] of this.keys) k.classList.toggle('target', midis.includes(m));
  }

  releaseAll(): void {
    for (const [, k] of this.keys) k.classList.remove('down');
    this.held.clear();
  }

  private bindPointer(): void {
    const el = this.el;
    const keyAt = (t: EventTarget | null) => (t instanceof Element ? (t.closest('.key') as HTMLElement | null) : null);
    el.addEventListener('pointerdown', (e) => {
      const k = keyAt(e.target);
      if (!k) return;
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable */
      }
      const m = Number(k.dataset.midi);
      this.ptr.set(e.pointerId, m);
      this.onPress?.('on', m, e.timeStamp);
    });
    el.addEventListener('pointermove', (e) => {
      const old = this.ptr.get(e.pointerId);
      if (old === undefined) return;
      const k = keyAt(document.elementFromPoint(e.clientX, e.clientY));
      if (!k) return;
      const m = Number(k.dataset.midi);
      if (m !== old) {
        this.onPress?.('off', old, e.timeStamp);
        this.ptr.set(e.pointerId, m);
        this.onPress?.('on', m, e.timeStamp);
      }
    });
    const up = (e: PointerEvent) => {
      const m = this.ptr.get(e.pointerId);
      if (m === undefined) return;
      this.ptr.delete(e.pointerId);
      this.onPress?.('off', m, e.timeStamp);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
