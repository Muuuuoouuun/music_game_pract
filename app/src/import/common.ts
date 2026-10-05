/**
 * Helpers shared by the MusicXML and MIDI importers: errors, ids, key names, hand
 * splitting and the final note clean-up every chart goes through.
 */
import { sortNotes, type ChartNote, type Hand } from '../core/chart';

/** Thrown by every importer. `message` is Korean and safe to show to the user as is. */
export class ImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportError';
  }
}

export interface ImportOptions {
  /** Chart id. Defaults to a content hash so re-importing the same file gives the same id. */
  id?: string;
  fileName?: string;
  /** Used when the file itself carries no title (before falling back to the file name). */
  title?: string;
}

/** FNV-1a over a string or bytes, as 8 hex digits. Stable ids for imported charts. */
export function hashId(data: string | Uint8Array): string {
  let h = 0x811c9dc5;
  if (typeof data === 'string') {
    for (let i = 0; i < data.length; i++) {
      h ^= data.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      h ^= data[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function stripExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.[^.]+$/, '');
}

/** Round to 1e-6 to keep float positions (quarters, beats) comparable. */
export function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// ---- keys -------------------------------------------------------------------------

const MODE_FIFTHS_OFFSET: Record<string, number> = {
  lydian: -1,
  major: 0,
  ionian: 0,
  mixolydian: 1,
  dorian: 2,
  minor: 3,
  aeolian: 3,
  phrygian: 4,
  locrian: 5,
};

/** Note name at a circle-of-fifths position (0 = C, 1 = G, -1 = F, 7 = C#, -7 = Cb). */
function fifthsName(pos: number): string {
  const letters = 'FCGDAEB';
  const i = pos + 1;
  const letter = letters[((i % 7) + 7) % 7];
  const acc = Math.floor(i / 7);
  return letter + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc));
}

/** `fifths` from a key signature plus a mode → "G major", "E minor", "D dorian". */
export function keyName(fifths: number, mode?: string | null): string {
  const m = (mode ?? 'major').trim().toLowerCase() || 'major';
  const off = MODE_FIFTHS_OFFSET[m];
  if (off === undefined) return `${fifthsName(fifths)} major`;
  return `${fifthsName(fifths + off)} ${m === 'ionian' ? 'major' : m === 'aeolian' ? 'minor' : m}`;
}

/** Inverse of `keyName` for the generator: "G major" → {fifths: 1, mode: 'major'}. */
export function parseKeyName(key: string | undefined): { fifths: number; mode: string } {
  const m = /^\s*([A-Ga-g])([#b]*)\s*(\w+)?/.exec(key ?? '');
  if (!m) return { fifths: 0, mode: 'major' };
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const mode = (m[3] ?? 'major').toLowerCase();
  const pos = 'FCGDAEB'.indexOf(letter) - 1 + 7 * ((acc.match(/#/g)?.length ?? 0) - (acc.match(/b/g)?.length ?? 0));
  const fifths = pos - (MODE_FIFTHS_OFFSET[mode] ?? 0);
  if (fifths < -7 || fifths > 7) return { fifths: 0, mode: 'major' };
  return { fifths, mode: MODE_FIFTHS_OFFSET[mode] === undefined ? 'major' : mode };
}

// ---- hands --------------------------------------------------------------------------

export interface SplitNote {
  midi: number;
  /** Any monotonic time unit (quarters or ms). */
  start: number;
  /** Notes with the same key form one melodic line (a MusicXML voice, a MIDI track). */
  voice: string;
  hand?: Hand;
}

const SPLIT = 60; // middle C: >= 60 → R
const LOW = 55; // a voice entirely >= 55 with median >= 60 stays in the right hand
const HIGH = 64; // a voice entirely <= 64 with median < 60 stays in the left hand

/**
 * Pitch-based hand split for music without staff/track hand information.
 *
 * Rule:
 *  1. Continuity first: a voice that lives on one side of middle C (all notes >= G3 and
 *     median >= C4, or all notes <= E4 and median < C4) is kept on one hand as a whole,
 *     so a melody dipping to B3 is not torn between hands.
 *  2. Otherwise each onset is split by pitch: >= F4 (65) → R, <= F#3 (54) → L. Notes in
 *     the ambiguous zone G3–E4 go by middle C when they sound together with other
 *     notes (a chord is split at C4), and when alone they go to the hand whose last
 *     note was closest in pitch (so a single-voice MIDI track with melody + bass keeps
 *     D4 in the right hand after a bass note).
 */
export function splitHandsByPitch<T extends SplitNote>(notes: T[]): void {
  const byVoice = new Map<string, T[]>();
  for (const n of notes) {
    const list = byVoice.get(n.voice);
    if (list) list.push(n);
    else byVoice.set(n.voice, [n]);
  }
  const mixed: T[] = [];
  for (const list of byVoice.values()) {
    const pitches = list.map((n) => n.midi).sort((a, b) => a - b);
    const median = pitches[Math.floor(pitches.length / 2)];
    const min = pitches[0];
    const max = pitches[pitches.length - 1];
    if (min >= LOW && median >= SPLIT) list.forEach((n) => (n.hand = 'R'));
    else if (max <= HIGH && median < SPLIT) list.forEach((n) => (n.hand = 'L'));
    else mixed.push(...list);
  }
  if (!mixed.length) return;
  // Onset groups per voice, in time order.
  const groups = new Map<string, T[]>();
  for (const n of mixed) {
    const k = `${n.voice}\u0000${n.start}`;
    const g = groups.get(k);
    if (g) g.push(n);
    else groups.set(k, [n]);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].start - b[0].start);
  let lastR = 67;
  let lastL = 48;
  for (const g of ordered) {
    for (const n of g) {
      if (n.midi >= HIGH + 1) n.hand = 'R';
      else if (n.midi < LOW) n.hand = 'L';
      else if (g.length > 1) n.hand = n.midi >= SPLIT ? 'R' : 'L';
      else {
        const dR = Math.abs(n.midi - lastR);
        const dL = Math.abs(n.midi - lastL);
        n.hand = dR < dL ? 'R' : dL < dR ? 'L' : n.midi >= SPLIT ? 'R' : 'L';
      }
    }
    const rs = g.filter((n) => n.hand === 'R').map((n) => n.midi);
    const ls = g.filter((n) => n.hand === 'L').map((n) => n.midi);
    if (rs.length) lastR = Math.min(...rs);
    if (ls.length) lastL = Math.max(...ls);
  }
}

// ---- final clean-up ---------------------------------------------------------------------

/**
 * Removes exact duplicates (same pitch and start: unisons between voices can't be
 * pressed twice), shortens a note that is still sounding when the same pitch starts
 * again, and sorts per `sortNotes`.
 */
export function finalizeNotes(notes: ChartNote[]): ChartNote[] {
  const seen = new Map<string, ChartNote>();
  const out: ChartNote[] = [];
  for (const n of notes) {
    const k = `${n.midi}@${Math.round(n.startMs * 1000)}`;
    const prev = seen.get(k);
    if (prev) {
      prev.durationMs = Math.max(prev.durationMs, n.durationMs);
      continue;
    }
    seen.set(k, n);
    out.push(n);
  }
  sortNotes(out);
  const lastByPitch = new Map<number, ChartNote>();
  for (const n of out) {
    const p = lastByPitch.get(n.midi);
    if (p && p.startMs + p.durationMs > n.startMs) p.durationMs = Math.max(1, n.startMs - p.startMs);
    lastByPitch.set(n.midi, n);
  }
  return out;
}

/** Deterministic ids `m{measure}-{staff}-{n}`; `n` counts within (measure, staff) in sorted order. */
export function assignIds(notes: ChartNote[], staffOf: (n: ChartNote) => string | number): void {
  const counters = new Map<string, number>();
  for (const n of notes) {
    const key = `m${n.measure}-${staffOf(n)}`;
    const c = counters.get(key) ?? 0;
    counters.set(key, c + 1);
    n.id = `${key}-${c}`;
  }
}
