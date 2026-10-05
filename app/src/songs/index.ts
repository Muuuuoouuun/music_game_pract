/**
 * Built-in songs (public domain), stored as MusicXML and parsed on demand.
 * The summary fields are static so the song list renders without parsing;
 * tests/import-musicxml.test.ts checks they match the parsed charts.
 */
import type { Chart } from '../core/chart';
import { chartFromMusicXml } from '../import/musicxml';
import odeToJoy from './ode-to-joy.musicxml?raw';
import twinkle from './twinkle.musicxml?raw';
import minuetInG from './minuet-in-g.musicxml?raw';
import furElise from './fur-elise.musicxml?raw';

export interface SongEntry {
  id: string;
  title: string;
  composer: string;
  /** 1–10 */
  level: number;
  /** Quarter notes per minute. */
  bpm: number;
  timeSignature: string;
  /** Written measures, including a pickup measure. */
  measures: number;
  load(): Chart;
}

function entry(meta: Omit<SongEntry, 'load'>, xml: string, fileName: string): SongEntry {
  return {
    ...meta,
    load() {
      const chart = chartFromMusicXml(xml, { id: meta.id, fileName });
      chart.meta.source = { kind: 'builtin', fileName };
      chart.meta.title = meta.title;
      chart.meta.composer = meta.composer;
      return chart;
    },
  };
}

export const BUILTIN_SONGS: SongEntry[] = [
  entry(
    { id: 'ode-to-joy', title: 'Ode to Joy', composer: 'L. v. Beethoven', level: 1, bpm: 100, timeSignature: '4/4', measures: 8 },
    odeToJoy,
    'ode-to-joy.musicxml',
  ),
  entry(
    { id: 'twinkle', title: 'Twinkle Twinkle Little Star', composer: 'Traditional', level: 1, bpm: 90, timeSignature: '4/4', measures: 12 },
    twinkle,
    'twinkle.musicxml',
  ),
  entry(
    { id: 'minuet-in-g', title: 'Minuet in G', composer: 'C. Petzold (BWV Anh. 114)', level: 3, bpm: 110, timeSignature: '3/4', measures: 16 },
    minuetInG,
    'minuet-in-g.musicxml',
  ),
  entry(
    { id: 'fur-elise', title: 'Für Elise', composer: 'L. v. Beethoven', level: 4, bpm: 72, timeSignature: '3/8', measures: 9 },
    furElise,
    'fur-elise.musicxml',
  ),
];
