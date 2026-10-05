/**
 * Song library: the built-in catalogue plus charts the player imported. Imported charts
 * are stored one per localStorage key next to a small index, so a full quota only costs
 * the newest song, never the rest of the shelf.
 */
import type { Chart } from '../core/chart';
import { BUILTIN_SONGS } from '../import';
import { Emitter, load, remove, save } from './store';

export interface LibrarySong {
  id: string;
  title: string;
  composer: string;
  level: number;
  bpm: number;
  timeSignature: string;
  measures: number;
  builtin: boolean;
  art: string;
  mark: string;
  load(): Chart;
}

interface UserIndexEntry {
  id: string;
  title: string;
  composer: string;
  level: number;
  bpm: number;
  timeSignature: string;
  measures: number;
  kind: string;
  addedAt: number;
}

export const libraryChanged = new Emitter<void>();

const cache = new Map<string, Chart>();
/** Charts that could not be persisted live here for the session. */
const volatile = new Map<string, Chart>();
let userIndex: UserIndexEntry[] = load<UserIndexEntry[]>('songs', []);

const ARTS: [RegExp, string, string][] = [
  [/ode|joy|환희/i, 'ode', 'SYM. No.9'],
  [/twinkle|작은 별/i, 'twinkle', 'K.265'],
  [/minuet|미뉴에트/i, 'canon', 'BWV Anh.114'],
  [/elise|엘리제/i, 'elise', 'WoO 59'],
];
const ROTATE = ['river', 'arirang', 'canon', 'twinkle'];

function artFor(title: string, i: number): [string, string] {
  for (const [re, art, mark] of ARTS) if (re.test(title)) return [art, mark];
  return [ROTATE[i % ROTATE.length], ''];
}

/** Rough 1–10 difficulty from note density and chord load, for imported songs. */
export function estimateLevel(chart: Chart): number {
  const secs = Math.max(1, chart.meta.durationMs / 1000);
  const nps = chart.notes.length / secs;
  const hands = new Set(chart.notes.map((n) => n.hand)).size;
  return Math.max(1, Math.min(10, Math.round(nps * 1.4 + (hands > 1 ? 1.5 : 0))));
}

export function tsLabel(ts: [number, number]): string {
  return `${ts[0]}/${ts[1]}`;
}

export function songs(): LibrarySong[] {
  const out: LibrarySong[] = BUILTIN_SONGS.map((s, i) => {
    const [art, mark] = artFor(s.title, i);
    return {
      id: s.id, title: s.title, composer: s.composer, level: s.level, bpm: s.bpm, timeSignature: s.timeSignature,
      measures: s.measures, builtin: true, art, mark,
      load: () => cached(s.id, () => s.load()),
    };
  });
  for (const u of userIndex) {
    out.push({
      id: u.id, title: u.title, composer: u.composer, level: u.level, bpm: u.bpm, timeSignature: u.timeSignature,
      measures: u.measures, builtin: false, art: 'imp', mark: u.kind === 'midi' ? 'MIDI' : 'MusicXML',
      load: () => cached(u.id, () => readUserChart(u.id)),
    });
  }
  return out;
}

export function getSong(id: string | null | undefined): LibrarySong | undefined {
  if (!id) return undefined;
  return songs().find((s) => s.id === id);
}

function cached(id: string, make: () => Chart): Chart {
  let c = cache.get(id);
  if (!c) {
    c = make();
    cache.set(id, c);
  }
  return c;
}

function readUserChart(id: string): Chart {
  const v = volatile.get(id) ?? load<Chart | null>('song.' + id, null);
  if (!v) throw new Error('저장된 곡을 찾지 못했어요.');
  return v;
}

/** Adds an imported chart to the shelf. `persisted` is false when storage was full. */
export function addUserChart(chart: Chart): { song: LibrarySong; persisted: boolean } {
  let id = chart.meta.id || 'song';
  if (!id.startsWith('user-')) id = 'user-' + id;
  while (getSong(id)) id = id.replace(/(-\d+)?$/, '') + '-' + Math.floor(Math.random() * 1e4);
  const c: Chart = { ...chart, meta: { ...chart.meta, id } };
  const entry: UserIndexEntry = {
    id, title: c.meta.title, composer: c.meta.composer ?? '가져온 곡', level: estimateLevel(c), bpm: Math.round(c.meta.bpm),
    timeSignature: tsLabel(c.meta.timeSignature), measures: c.measures.length, kind: c.meta.source.kind, addedAt: Date.now(),
  };
  const persisted = save('song.' + id, c);
  if (!persisted) volatile.set(id, c);
  userIndex = [entry, ...userIndex];
  if (persisted && !save('songs', userIndex.filter((u) => !volatile.has(u.id)))) volatile.set(id, c);
  cache.set(id, c);
  libraryChanged.emit();
  return { song: getSong(id)!, persisted };
}

export function removeUserSong(id: string): void {
  userIndex = userIndex.filter((u) => u.id !== id);
  remove('song.' + id);
  volatile.delete(id);
  cache.delete(id);
  save('songs', userIndex.filter((u) => !volatile.has(u.id)));
  libraryChanged.emit();
}
