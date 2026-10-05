/**
 * Perspective "stage" highway on Canvas 2D (mockup D §8): spotlights and truss lights
 * breathing on the beat, a road whose lanes line up with the on-screen keys, falling notes
 * coloured by pitch, beat/bar lines from the chart's measures, the A–B loop slab, the
 * wait-mode gate pulse, and hit-line flashes, particles and rings.
 */
import type { SessionNote } from '../core/engine';
import type { Beat } from '../ui/clock';
import { LANE_HUE, type LaneLayout } from './lanes';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** ms of music visible between the far edge and the hit line. */
export const LOOK = 2000;

export interface HighwayFrame {
  t: number;
  now: number;
  dt: number;
  notes: SessionNote[];
  beats: Beat[];
  startT: number;
  endT: number;
  loop: boolean;
  wait: boolean;
  waiting: boolean;
  gate: number | null;
  /** Clock running (not paused, not holding at a gate, past the count-in start). */
  live: boolean;
  fever: boolean;
  danger: boolean;
  hue: number;
  measures: number;
  /** Chart opens with a pickup: engraved bar numbers equal measure indices. */
  pickup: boolean;
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; dec: number; h: number; sz: number }
interface Ring { x: number; y: number; r0: number; r1: number; life: number; h: number }

const SPOTS: { x: number; c: ((a: number) => string) | null; ph: number }[] = [
  { x: 0.06, c: (a) => `rgba(255,205,130,${a})`, ph: 0 },
  { x: 0.3, c: null, ph: 1.7 },
  { x: 0.7, c: (a) => `rgba(255,110,170,${a})`, ph: 3.1 },
  { x: 0.94, c: (a) => `rgba(110,190,255,${a})`, ph: 4.4 },
];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Highway {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private L: LaneLayout | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private x0 = 0;
  private hw = 0;
  private cx = 0;
  hitY = 0;
  private topY = 0;
  private vpY = 0;
  private k = 0.3;
  private a = 1;
  private sBot = 1;
  private bg: CanvasGradient | null = null;
  private road: CanvasGradient | null = null;
  private sep: CanvasGradient | null = null;
  private parts: Particle[] = [];
  private rings: Ring[] = [];
  private flashes = new Map<number, { a: number; wrong: boolean }>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  setLanes(L: LaneLayout): void {
    this.L = L;
  }

  /** Fit to the stage box; `keysLeft`/`keysWidth` are the keyboard's position inside it. */
  resize(width: number, height: number, keysLeft: number, keysWidth: number): void {
    if (!width || !height) {
      this.w = 0;
      return;
    }
    const c = this.ctx;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = width;
    this.h = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.x0 = keysLeft;
    this.hw = keysWidth;
    this.cx = keysLeft + keysWidth / 2;
    this.hitY = height - 14;
    this.topY = Math.max(16, height * 0.05);
    this.k = height < 300 ? 0.36 : 0.3;
    this.a = 1 / this.k - 1;
    this.vpY = (this.topY - this.hitY * this.k) / (1 - this.k);
    this.sBot = (height - this.vpY) / (this.hitY - this.vpY);
    const bg = c.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#06051a');
    bg.addColorStop(0.55, '#120e36');
    bg.addColorStop(1, '#22164a');
    this.bg = bg;
    const road = c.createLinearGradient(0, this.topY, 0, height);
    road.addColorStop(0, 'rgba(16,12,46,.35)');
    road.addColorStop(1, 'rgba(8,6,26,.9)');
    this.road = road;
    const sep = c.createLinearGradient(0, this.topY, 0, height);
    sep.addColorStop(0, 'rgba(160,150,255,0)');
    sep.addColorStop(0.7, 'rgba(160,150,255,.2)');
    sep.addColorStop(1, 'rgba(160,150,255,.32)');
    this.sep = sep;
  }

  get centerX(): number {
    return this.cx;
  }

  clearFx(): void {
    this.parts.length = 0;
    this.rings.length = 0;
    this.flashes.clear();
  }

  flash(midi: number, wrong: boolean): void {
    this.flashes.set(midi, { a: 1, wrong });
  }

  burst(midi: number, kind: 'perfect' | 'great' | 'good'): void {
    const ln = this.L?.lane[midi];
    if (!ln || !this.w) return;
    const lx = this.x0 + ln.l * this.hw;
    const lw = ln.w * this.hw;
    const x = lx + lw / 2;
    const y = this.hitY;
    const h = LANE_HUE[midi % 12];
    const rm = reduced();
    const n = rm ? (kind === 'perfect' ? 3 : 1) : kind === 'perfect' ? 26 : kind === 'great' ? 16 : 8;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
      const sp = 160 + Math.random() * (kind === 'perfect' ? 440 : 280);
      this.parts.push({ x: x + (Math.random() - 0.5) * lw * 0.6, y, vx: Math.cos(a) * sp * 0.7, vy: Math.sin(a) * sp, life: 1, dec: 1.3 + Math.random() * 1.3, h, sz: 2 + Math.random() * 3.5 });
    }
    if (kind === 'perfect') this.rings.push({ x, y, r0: lw * 0.3, r1: lw * 1.3, life: 1, h });
    else if (kind === 'great' && !rm) this.rings.push({ x, y, r0: lw * 0.25, r1: lw * 0.8, life: 0.7, h: 195 });
  }

  private sOfZ(z: number): number {
    return 1 / (1 + this.a * z);
  }
  private yOfS(s: number): number {
    return this.vpY + (this.hitY - this.vpY) * s;
  }
  private xOf(x: number, s: number): number {
    return this.cx + (x - this.cx) * s;
  }
  private laneX(m: number): [number, number] {
    const ln = this.L!.lane[m];
    return [this.x0 + ln.l * this.hw, ln.w * this.hw];
  }
  private quad(xa: number, xb: number, sa: number, sb: number): void {
    const c = this.ctx;
    const ya = this.yOfS(sa);
    const yb = this.yOfS(sb);
    c.beginPath();
    c.moveTo(this.xOf(xa, sa), ya);
    c.lineTo(this.xOf(xb, sa), ya);
    c.lineTo(this.xOf(xb, sb), yb);
    c.lineTo(this.xOf(xa, sb), yb);
    c.closePath();
  }

  /** Beat phase 0–1 (0 = on the beat) from the grid, for the pulsing lights. */
  private phase(beats: Beat[], t: number): [number, number] {
    let lo = 0;
    let hi = beats.length - 1;
    if (hi < 1 || t < beats[0].t) return [0.99, 0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const b = beats[lo];
    const next = beats[lo + 1];
    const len = next ? next.t - b.t : 600;
    return [clamp((t - b.t) / len, 0, 1), lo];
  }

  render(f: HighwayFrame): void {
    const L = this.L;
    const { w, h, dpr } = this;
    if (!w || !L || !this.bg) return;
    const c = this.ctx;
    const { t, now, dt } = f;
    const rm = reduced();
    const [ph, bi] = this.phase(f.beats, t);
    const pulse = f.live ? (rm ? 0.35 : Math.exp(-ph * 4)) : 0.15;
    const hueT = (now / 14) % 360;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.shadowBlur = 0;
    c.fillStyle = this.bg;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'lighter';
    for (const s of SPOTS) {
      const ox = w * s.x;
      const oy = -20;
      const len = h * 1.3;
      const ang = Math.atan2(h - oy, this.cx - ox) + (rm ? 0 : Math.sin(now / 2600 + s.ph) * 0.2);
      const sp = 0.15;
      const col = s.c ?? ((a: number) => `hsla(${f.fever ? hueT : f.hue},95%,62%,${a})`);
      const gr = c.createLinearGradient(ox, oy, ox + Math.cos(ang) * len, oy + Math.sin(ang) * len);
      gr.addColorStop(0, col(0.2 + 0.14 * pulse));
      gr.addColorStop(1, col(0));
      c.fillStyle = gr;
      c.beginPath();
      c.moveTo(ox, oy);
      c.lineTo(ox + Math.cos(ang - sp) * len, oy + Math.sin(ang - sp) * len);
      c.lineTo(ox + Math.cos(ang + sp) * len, oy + Math.sin(ang + sp) * len);
      c.closePath();
      c.fill();
    }
    const nT = Math.max(6, Math.floor(w / 46));
    for (let i = 0; i < nT; i++) {
      const x = ((i + 0.5) * w) / nT;
      const on = f.live && (i + bi) % 3 === 0;
      const gr = c.createRadialGradient(x, 6, 0, x, 6, on ? 22 : 10);
      gr.addColorStop(0, on ? `rgba(255,225,170,${0.5 + 0.5 * pulse})` : 'rgba(170,160,255,.25)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gr;
      c.fillRect(x - 24, 0, 48, 32);
    }
    const fg = c.createRadialGradient(this.cx, this.hitY, 0, this.cx, this.hitY, this.hw * 0.9);
    fg.addColorStop(0, `rgba(255,170,90,${0.1 + 0.12 * pulse})`);
    fg.addColorStop(1, 'rgba(255,170,90,0)');
    c.fillStyle = fg;
    c.fillRect(0, 0, w, h);
    if (f.fever) {
      const g2 = c.createRadialGradient(this.cx, h, 0, this.cx, h, Math.max(w, h) * 0.8);
      g2.addColorStop(0, `hsla(${hueT},90%,60%,${0.12 + 0.18 * pulse})`);
      g2.addColorStop(1, `hsla(${hueT},90%,60%,0)`);
      c.fillStyle = g2;
      c.fillRect(0, 0, w, h);
    }
    c.globalCompositeOperation = 'source-over';

    const xl = this.x0;
    const xr = this.x0 + this.hw;
    const sB = this.sBot;
    const sT = this.k;
    c.beginPath();
    c.moveTo(this.xOf(xl, sB), h);
    c.lineTo(this.xOf(xr, sB), h);
    c.lineTo(this.xOf(xr, sT), this.topY);
    c.lineTo(this.xOf(xl, sT), this.topY);
    c.closePath();
    c.fillStyle = this.road!;
    c.fill();

    // lane tints, brighter when a note is about to land in them
    const near = new Map<number, number>();
    for (const n of f.notes) {
      if (n.result) continue;
      const z = (n.t - t) / LOOK;
      if (z > 1) break;
      if (z > -0.05 && !near.has(n.note.midi)) near.set(n.note.midi, z);
    }
    for (let m = L.lo; m <= L.hi; m++) {
      if (L.lane[m].b) continue;
      const [lx, lw] = this.laneX(m);
      const z = near.get(m);
      const boost = z === undefined ? 0 : clamp(1 - z / 0.45, 0, 1);
      this.quad(lx, lx + lw, sB, sT);
      c.fillStyle = `hsla(${LANE_HUE[m % 12]},90%,60%,${0.03 + 0.07 * boost})`;
      c.fill();
    }

    if (f.loop) {
      const za = (f.startT - t) / LOOK;
      const zb = (f.endT - t) / LOOK;
      const a = Math.max(za, -0.03);
      const b = Math.min(zb, 1);
      if (b > a) {
        this.quad(xl, xr, this.sOfZ(a), this.sOfZ(b));
        c.fillStyle = 'rgba(255,205,120,.07)';
        c.fill();
      }
      c.font = '700 11px "JetBrains Mono", monospace';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      for (const [z, lab] of [[za, 'A'], [zb, 'B']] as const) {
        if (z < -0.03 || z > 1) continue;
        const s = this.sOfZ(z);
        const y = this.yOfS(s);
        c.strokeStyle = 'rgba(255,205,120,.8)';
        c.lineWidth = 1.5;
        c.setLineDash([7, 5]);
        c.beginPath();
        c.moveTo(this.xOf(xl, s), y);
        c.lineTo(this.xOf(xr, s), y);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = 'rgba(255,220,160,.95)';
        c.fillText(lab, this.xOf(xr, s) + 8, y);
      }
    }

    c.strokeStyle = this.sep!;
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < L.whites; i++) {
      const x = xl + (i / L.whites) * this.hw;
      c.moveTo(this.xOf(x, sB), h);
      c.lineTo(this.xOf(x, sT), this.topY);
    }
    c.stroke();

    // beat + bar lines
    c.font = '10px "JetBrains Mono", monospace';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (const b of f.beats) {
      const z = (b.t - t) / LOOK;
      if (z < -0.03) continue;
      if (z > 1) break;
      const s = this.sOfZ(z);
      const y = this.yOfS(s);
      const fade = 1 - z * 0.6;
      c.strokeStyle = b.bar ? `rgba(255,215,150,${0.4 * fade})` : `rgba(170,160,255,${0.12 * fade})`;
      c.lineWidth = b.bar ? 1.6 : 1;
      c.beginPath();
      c.moveTo(this.xOf(xl, s), y);
      c.lineTo(this.xOf(xr, s), y);
      c.stroke();
      const label = f.pickup ? b.measure : b.measure + 1;
      if (b.bar && label >= 1 && b.measure < f.measures) {
        c.fillStyle = `rgba(255,215,150,${0.65 * fade})`;
        c.fillText(String(label), this.xOf(xl, s) - 8, y);
      }
    }

    c.lineWidth = 2.5;
    c.strokeStyle = f.fever ? `hsl(${hueT} 95% 66%)` : `rgba(255,205,120,${0.55 + 0.35 * pulse})`;
    c.shadowColor = c.strokeStyle;
    c.shadowBlur = 14;
    c.beginPath();
    c.moveTo(this.xOf(xl, sB), h);
    c.lineTo(this.xOf(xl, sT), this.topY);
    c.moveTo(this.xOf(xr, sB), h);
    c.lineTo(this.xOf(xr, sT), this.topY);
    c.stroke();
    c.shadowBlur = 0;

    this.drawNotes(f);

    const y = this.hitY;
    for (let m = L.lo; m <= L.hi; m++) {
      if (L.lane[m].b) continue;
      const [lx, lw] = this.laneX(m);
      const fl = this.flashes.get(m)?.a ?? 0;
      c.fillStyle = `hsla(${LANE_HUE[m % 12]},95%,62%,${0.35 + 0.5 * fl})`;
      c.fillRect(lx + 2, y - 3, lw - 4, 6);
    }
    c.shadowColor = f.fever ? `hsl(${hueT} 95% 65%)` : '#ffcd78';
    c.shadowBlur = 14 + 14 * pulse;
    c.fillStyle = `rgba(255,243,220,${0.75 + 0.25 * pulse})`;
    c.fillRect(xl, y - 1, this.hw, 2);
    c.shadowBlur = 0;

    this.drawFx(dt);

    if (f.danger) {
      const v = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
      v.addColorStop(0, 'rgba(255,79,116,0)');
      v.addColorStop(1, `rgba(255,79,116,${0.18 + 0.12 * pulse})`);
      c.fillStyle = v;
      c.fillRect(0, 0, w, h);
    }
  }

  private drawNotes(f: HighwayFrame): void {
    const c = this.ctx;
    const L = this.L!;
    const { t, now } = f;
    c.textAlign = 'center';
    for (const n of f.notes) {
      const z0 = (n.t - t) / LOOK;
      if (z0 > 1) break;
      const z1 = (n.t + n.dur * 0.9 - t) / LOOK;
      if (z1 < -0.04) continue;
      const midi = n.note.midi;
      const ln = L.lane[midi];
      if (!ln) continue;
      const hit = !!n.result && n.result !== 'miss';
      const miss = n.result === 'miss';
      const za = hit ? Math.max(z0, 0) : Math.max(z0, -0.04);
      const zb = Math.min(z1, 1);
      if (zb <= za) continue;
      const [lx, lw] = this.laneX(midi);
      const ins = lw * (ln.b ? 0.05 : 0.1);
      const xa = lx + ins;
      const xb = lx + lw - ins;
      const sa = this.sOfZ(za);
      const sb = this.sOfZ(zb);
      const ya = this.yOfS(sa);
      const yb = this.yOfS(sb);
      const hue = LANE_HUE[midi % 12];
      let alpha = Math.min(1, (1 - za) / 0.12) * (1 - za * 0.25);
      if (hit) alpha *= 0.38;
      if (miss) alpha *= 0.5;
      const left = n.note.hand === 'L';
      this.quad(xa, xb, sa, sb);
      const gr = c.createLinearGradient(0, ya, 0, yb);
      if (miss) {
        gr.addColorStop(0, `rgba(150,145,190,${0.5 * alpha})`);
        gr.addColorStop(1, `rgba(150,145,190,${0.12 * alpha})`);
      } else {
        gr.addColorStop(0, `hsla(${hue},95%,${hit ? 72 : 62}%,${alpha * (left ? 0.45 : 0.92)})`);
        gr.addColorStop(1, `hsla(${hue},90%,48%,${alpha * (left ? 0.15 : 0.38)})`);
      }
      c.fillStyle = gr;
      c.fill();
      if (left && !miss) {
        c.strokeStyle = `hsla(${hue},95%,72%,${alpha})`;
        c.lineWidth = 1.5;
        c.stroke();
      }
      if (hit) continue;
      const sc = this.sOfZ(za + 0.014);
      this.quad(xa, xb, sa, sc);
      c.fillStyle = miss ? `rgba(190,185,220,${0.55 * alpha})` : `hsla(${hue},100%,86%,${alpha})`;
      if (!miss && za < 0.6) {
        c.shadowColor = `hsl(${hue} 95% 60%)`;
        c.shadowBlur = 18 * sa;
      }
      c.fill();
      c.shadowBlur = 0;
      if (f.wait && f.waiting && n.t === f.gate) {
        this.quad(xa - 3, xb + 3, this.sOfZ(za - 0.01), this.sOfZ(za + 0.04));
        c.strokeStyle = `rgba(255,205,120,${0.6 + 0.4 * Math.sin(now / 110)})`;
        c.lineWidth = 2.5;
        c.stroke();
      }
      if (!miss && (xb - xa) * sa > 26 && za < 0.7) {
        c.fillStyle = `rgba(16,10,40,${0.85 * alpha})`;
        c.font = `700 ${Math.round(10 + 5 * sa)}px "JetBrains Mono", monospace`;
        c.fillText(NAMES[midi % 12], this.xOf((xa + xb) / 2, sa), ya - (ya - this.yOfS(this.sOfZ(za + 0.05))) * 0.5 - 6 * sa);
      }
    }
  }

  private drawFx(dt: number): void {
    const c = this.ctx;
    const h = this.h;
    c.globalCompositeOperation = 'lighter';
    const sFl = this.sOfZ(0.5);
    const yFl = this.yOfS(sFl);
    for (const [m, fl] of this.flashes) {
      fl.a -= dt / 220;
      if (fl.a <= 0 || !this.L!.lane[m]) {
        this.flashes.delete(m);
        continue;
      }
      const [lx, lw] = this.laneX(m);
      this.quad(lx, lx + lw, this.sBot, sFl);
      const gr = c.createLinearGradient(0, h, 0, yFl);
      const hue = LANE_HUE[m % 12];
      gr.addColorStop(0, fl.wrong ? `rgba(255,79,116,${0.55 * fl.a})` : `hsla(${hue},95%,62%,${0.5 * fl.a})`);
      gr.addColorStop(1, fl.wrong ? 'rgba(255,79,116,0)' : `hsla(${hue},95%,62%,0)`);
      c.fillStyle = gr;
      c.fill();
    }
    const k = dt / 1000;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= p.dec * k;
      if (p.life <= 0) {
        this.parts.splice(i, 1);
        continue;
      }
      p.vy += 900 * k;
      p.x += p.vx * k;
      p.y += p.vy * k;
      c.fillStyle = `hsla(${p.h},100%,${60 + 25 * p.life}%,${p.life})`;
      const s = p.sz * (0.4 + 0.6 * p.life);
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= k * 2.6;
      if (r.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      const e = 1 - r.life;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - e, 3));
      c.strokeStyle = `hsla(${r.h},100%,75%,${r.life})`;
      c.lineWidth = 3 * r.life + 0.5;
      c.beginPath();
      c.ellipse(r.x, r.y, rad, rad * 0.32, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
  }
}
