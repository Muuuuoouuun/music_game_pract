/**
 * Chart → MusicXML 3.1 (partwise) for the sheet view of charts that did not come from
 * MusicXML (MIDI files, later audio transcription).
 *
 * One piano part on a grand staff: R notes on the treble staff (1), L notes on the bass
 * staff (2). Everything is quantized to a 16th-note grid (divisions = 4). Notes that
 * overlap within a staff are spread over extra voices; chords are notes in one voice
 * with the same start and length; gaps are filled with rests, and notes crossing a
 * barline (or with a length no single note value can show) are split and tied.
 *
 * The output parses back through `chartFromMusicXml` into the same
 * (measure, beat, midi, hand) set for grid-aligned charts. Durations are converted
 * with each measure's starting tempo, so a note spanning a tempo change is approximate.
 */
import type { Chart, ChartNote } from '../core/chart';
import { parseKeyName } from './common';

const DIV = 4; // divisions per quarter → 16th grid
const SHARP_NAMES: [string, number][] = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];
const FLAT_NAMES: [string, number][] = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
];
/** Note values (in 16ths) that one notehead can show, largest first. */
const VALUES: [number, string, number][] = [
  [16, 'whole', 0],
  [12, 'half', 1],
  [8, 'half', 0],
  [6, 'quarter', 1],
  [4, 'quarter', 0],
  [3, 'eighth', 1],
  [2, 'eighth', 0],
  [1, '16th', 0],
];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function split(len: number): [number, string, number][] {
  const out: [number, string, number][] = [];
  let left = len;
  while (left > 0) {
    const v = VALUES.find(([d]) => d <= left)!;
    out.push(v);
    left -= v[0];
  }
  return out;
}

function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

interface Group {
  start: number;
  end: number;
  midis: number[];
}

export function chartToMusicXml(chart: Chart): string {
  const { fifths, mode } = parseKeyName(chart.meta.key);
  const names = fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
  const ms = chart.measures;

  // Measure lengths on the grid. Only the first/last measure may be shorter than the
  // signature (pickup / final bar); everything else uses the nominal length.
  const maxBeat = ms.map(() => 0);
  for (const n of chart.notes) {
    if (n.measure >= 0 && n.measure < ms.length) maxBeat[n.measure] = Math.max(maxBeat[n.measure], Math.round(n.beat * DIV) + 1);
  }
  const lens = ms.map((m, i) => {
    const nominal = Math.max(1, Math.round((m.timeSignature[0] * 4 * DIV) / m.timeSignature[1]));
    const actual = Math.round((m.durationMs * m.bpm * DIV) / 60000);
    const short = (i === 0 || i === ms.length - 1) && actual < nominal * 0.95;
    return Math.max(short ? Math.max(1, actual) : nominal, maxBeat[i]);
  });
  const starts: number[] = [];
  let total = 0;
  for (const l of lens) {
    starts.push(total);
    total += l;
  }

  // Grid notes per staff, de-duplicated, grouped into chords, laid out in voices.
  const lanesByStaff: Group[][][] = [[], []];
  for (const staff of [1, 2]) {
    const seen = new Map<string, { start: number; end: number; midi: number }>();
    for (const n of chart.notes as ChartNote[]) {
      if ((n.hand === 'R' ? 1 : 2) !== staff || n.measure < 0 || n.measure >= ms.length) continue;
      const m = ms[n.measure];
      const start = starts[n.measure] + Math.min(lens[n.measure] - 1, Math.max(0, Math.round(n.beat * DIV)));
      const dur = Math.max(1, Math.round((n.durationMs * m.bpm * DIV) / 60000));
      const end = Math.min(total, start + dur);
      const k = `${start}:${n.midi}`;
      const prev = seen.get(k);
      if (!prev || prev.end < end) seen.set(k, { start, end, midi: n.midi });
    }
    const chords = new Map<string, Group>();
    for (const v of seen.values()) {
      const k = `${v.start}:${v.end}`;
      const g = chords.get(k);
      if (g) g.midis.push(v.midi);
      else chords.set(k, { start: v.start, end: v.end, midis: [v.midi] });
    }
    const groups = [...chords.values()].sort((a, b) => a.start - b.start || b.end - a.end);
    const lanes: Group[][] = [];
    for (const g of groups) {
      g.midis.sort((a, b) => a - b);
      const lastEnd = (l: Group[]) => (l.length ? l[l.length - 1].end : 0);
      const lane = lanes.find((l) => lastEnd(l) === g.start) ?? lanes.find((l) => lastEnd(l) <= g.start);
      if (lane) lane.push(g);
      else lanes.push([g]);
    }
    if (!lanes.length) lanes.push([]);
    lanesByStaff[staff - 1] = lanes;
  }

  const pitchXml = (midi: number) => {
    const [step, alter] = names[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
  };

  const noteXml = (
    o: { midi?: number; chord?: boolean; dur: number; voice: number; staff: number; type?: string; dots?: number; tieStop?: boolean; tieStart?: boolean; measureRest?: boolean },
  ) => {
    const ties = (o.tieStop ? '<tie type="stop"/>' : '') + (o.tieStart ? '<tie type="start"/>' : '');
    const tied = (o.tieStop ? '<tied type="stop"/>' : '') + (o.tieStart ? '<tied type="start"/>' : '');
    return (
      '        <note>' +
      (o.chord ? '<chord/>' : '') +
      (o.midi === undefined ? (o.measureRest ? '<rest measure="yes"/>' : '<rest/>') : pitchXml(o.midi)) +
      `<duration>${o.dur}</duration>${ties}<voice>${o.voice}</voice>` +
      (o.type ? `<type>${o.type}</type>` : '') +
      '<dot/>'.repeat(o.dots ?? 0) +
      `<staff>${o.staff}</staff>` +
      (tied ? `<notations>${tied}</notations>` : '') +
      '</note>'
    );
  };

  const restsXml = (len: number, voice: number, staff: number) =>
    split(len).map(([d, type, dots]) => noteXml({ dur: d, voice, staff, type, dots }));

  const pickup = ms.length > 1 && lens[0] < Math.round((ms[0].timeSignature[0] * 4 * DIV) / ms[0].timeSignature[1]);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');
  out.push(`  <work><work-title>${esc(chart.meta.title)}</work-title></work>`);
  out.push('  <identification>');
  if (chart.meta.composer) out.push(`    <creator type="composer">${esc(chart.meta.composer)}</creator>`);
  out.push('    <encoding><software>KeyStage</software></encoding>');
  out.push('  </identification>');
  out.push('  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>');
  out.push('  <part id="P1">');

  let prevTs = '';
  let prevBpm = NaN;
  ms.forEach((m, i) => {
    const len = lens[i];
    const mStart = starts[i];
    const mEnd = mStart + len;
    const number = pickup ? i : i + 1;
    out.push(`    <measure number="${number}"${pickup && i === 0 ? ' implicit="yes"' : ''}>`);
    const ts = `${m.timeSignature[0]}/${m.timeSignature[1]}`;
    const time = ts !== prevTs ? `<time><beats>${m.timeSignature[0]}</beats><beat-type>${m.timeSignature[1]}</beat-type></time>` : '';
    if (i === 0) {
      out.push(
        `      <attributes><divisions>${DIV}</divisions><key><fifths>${fifths}</fifths>${chart.meta.key ? `<mode>${mode}</mode>` : ''}</key>${time}` +
          '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>',
      );
    } else if (time) {
      out.push(`      <attributes>${time}</attributes>`);
    }
    prevTs = ts;
    if (m.bpm !== prevBpm) {
      out.push(
        '      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>' +
          `<per-minute>${Math.round(m.bpm)}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${fmt(m.bpm)}"/></direction>`,
      );
      prevBpm = m.bpm;
    }

    const voices: string[][] = [];
    for (const staff of [1, 2]) {
      lanesByStaff[staff - 1].forEach((lane, li) => {
        const voice = (staff === 1 ? 1 : 5) + li;
        const inside = lane.filter((g) => g.start < mEnd && g.end > mStart);
        if (!inside.length) {
          if (li === 0) voices.push([noteXml({ dur: len, voice, staff, measureRest: true })]);
          return;
        }
        const items: string[] = [];
        let t = mStart;
        for (const g of inside) {
          const s = Math.max(g.start, mStart);
          const e = Math.min(g.end, mEnd);
          if (s > t) items.push(...restsXml(s - t, voice, staff));
          const pieces = split(e - s);
          pieces.forEach(([d, type, dots], pi) => {
            const tieStop = pi > 0 || g.start < s;
            const tieStart = pi < pieces.length - 1 || g.end > e;
            g.midis.forEach((midi, ci) => items.push(noteXml({ midi, chord: ci > 0, dur: d, voice, staff, type, dots, tieStop, tieStart })));
          });
          t = e;
        }
        if (t < mEnd) items.push(...restsXml(mEnd - t, voice, staff));
        voices.push(items);
      });
    }
    voices.forEach((v, vi) => {
      if (vi > 0) out.push(`        <backup><duration>${len}</duration></backup>`);
      out.push(...v);
    });
    if (i === ms.length - 1) out.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
    out.push('    </measure>');
  });
  out.push('  </part>');
  out.push('</score-partwise>');
  return out.join('\n') + '\n';
}
