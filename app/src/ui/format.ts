/** Number and note formatting in the mockup's voice. */
import { noteName } from '../core/chart';
import { PC_LABEL } from '../input/hub';

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const commas = (n: number | string): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const signed = (v: number): string => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v);

export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Score with dimmed leading zeros, e.g. 0,046,250 → "<lz>0,0</lz>46,250". */
export function scoreHTML(v: number): string {
  const s = commas(String(Math.max(0, Math.round(v))).padStart(7, '0'));
  const i = s.search(/[1-9]/);
  return i < 0 ? `<span class="lz">${s.slice(0, -1)}</span>0` : `<span class="lz">${s.slice(0, i)}</span>${s.slice(i)}`;
}

const SOL: Record<string, string> = { C: '도', D: '레', E: '미', F: '파', G: '솔', A: '라', B: '시' };
const PCS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "E(미)", "F♯(파♯)". */
export function nKo(m: number): string {
  const p = PCS[((m % 12) + 12) % 12];
  return p.replace('#', '♯') + '(' + SOL[p[0]] + (p.length > 1 ? '♯' : '') + ')';
}

/** Bar number as engraved: with a pickup the first full bar is 1 and the pickup is 못갖춘마디. */
export const barNo = (i: number, pickup = false): string => (pickup ? (i <= 0 ? '못갖춘' : String(i)) : String(i + 1));

export const keyHint = (m: number): string => (PC_LABEL[m] ? `PC 키 ${PC_LABEL[m]}` : `${noteName(m)} 건반`);
