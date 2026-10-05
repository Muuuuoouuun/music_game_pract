/**
 * MusicXML (uncompressed) → Chart.
 *
 * Positions are tracked in quarter notes (duration / divisions) per part with a cursor
 * that `<backup>`/`<forward>` move, then converted to ms through a tempo map built from
 * every `<sound tempo>` (or `<metronome>` when a direction has no sound tempo).
 *
 * Decisions (see also the function docs):
 *  - Chart time 0 is the start of the first written measure (the pickup, if any).
 *  - A measure lasts as long as its longest voice in any part (so pickups and short
 *    final measures get their real length); an empty measure uses its time signature.
 *  - Tied notes become one ChartNote at the tie start with the summed duration.
 *  - Grace and cue notes are not played; unpitched (percussion) notes are ignored.
 *  - Known limitation: repeats, voltas, D.C./D.S. are NOT unrolled. Notes play once,
 *    as written, so the highway matches the sheet view measure for measure.
 */
import type { Chart, ChartMeasure, ChartNote, Hand } from '../core/chart';
import {
  ImportError,
  assignIds,
  finalizeNotes,
  hashId,
  keyName,
  r6,
  splitHandsByPitch,
  stripExtension,
  type ImportOptions,
} from './common';

const DEFAULT_BPM = 100;
const DEFAULT_VELOCITY = 80;
const EPS = 1e-6;

const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const UNIT_QUARTERS: Record<string, number> = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
};

/** Part names that mark the piano part in a score with several instruments. */
const PIANO_RE = /piano|keyboard|klavier|pianoforte|clavier|pno|피아노|건반/i;

// ---- DOM helpers ------------------------------------------------------------------------

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(el.children)) if (!name || c.localName === name) out.push(c);
  return out;
}
function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
}
function txt(el: Element | null | undefined, name?: string): string | null {
  const e = name ? kid(el, name) : el;
  const t = e?.textContent?.trim();
  return t ? t : null;
}
function num(el: Element | null | undefined, name?: string): number | null {
  const t = txt(el, name);
  if (t === null) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}
function descendants(el: Element, name: string): Element[] {
  return Array.from(el.getElementsByTagName(name));
}

// ---- parse model ---------------------------------------------------------------------------

interface MeasureRef {
  /** The element holding the music data (partwise `<measure>`, timewise `<part>`). */
  el: Element;
}

interface PartRef {
  id: string;
  label: string;
  measures: MeasureRef[];
}

interface RawNote {
  part: number;
  measure: number;
  /** Quarter-note offset inside the measure. */
  pos: number;
  /** Quarter notes. */
  dur: number;
  midi: number;
  staff: number;
  voice: string;
  tieStart: boolean;
  tieStop: boolean;
  velocity: number;
  /** Filled after measure lengths are known. */
  absQ: number;
  hand?: Hand;
}

interface TempoEvent {
  measure: number;
  pos: number;
  bpm: number;
  order: number;
}

interface PartResult {
  notes: RawNote[];
  /** Max cursor reached per measure, in quarters. */
  content: number[];
  /** Time signature set inside each measure, if any. */
  timeSigs: ([number, number] | undefined)[];
  staves: number;
  key?: string;
}

function parseXml(xml: string): Document {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml');
  } catch (e) {
    throw new ImportError('MusicXML 파일을 읽을 수 없어요. 파일이 손상됐거나 MusicXML 형식이 아니에요.', { cause: e });
  }
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
    throw new ImportError('MusicXML 파일을 읽을 수 없어요. 파일이 손상됐거나 MusicXML 형식이 아니에요.');
  }
  return doc;
}

/** Collects parts from `score-partwise`, or regroups a `score-timewise` file per part. */
function collectParts(root: Element): PartRef[] {
  const labels = new Map<string, string>();
  const order: string[] = [];
  for (const sp of descendants(root, 'score-part')) {
    const id = sp.getAttribute('id') ?? '';
    order.push(id);
    const bits = [txt(sp, 'part-name'), txt(sp, 'part-abbreviation')];
    for (const si of kids(sp, 'score-instrument')) bits.push(txt(si, 'instrument-name'), txt(si, 'instrument-sound'));
    for (const mi of kids(sp, 'midi-instrument')) {
      const prog = num(mi, 'midi-program');
      if (prog !== null && prog >= 1 && prog <= 8) bits.push('piano');
    }
    labels.set(id, bits.filter(Boolean).join(' '));
  }
  const parts = new Map<string, PartRef>();
  const get = (id: string) => {
    let p = parts.get(id);
    if (!p) {
      p = { id, label: labels.get(id) ?? '', measures: [] };
      parts.set(id, p);
    }
    return p;
  };
  if (root.localName === 'score-partwise') {
    for (const part of kids(root, 'part')) {
      const p = get(part.getAttribute('id') ?? `P${parts.size + 1}`);
      for (const m of kids(part, 'measure')) p.measures.push({ el: m });
    }
  } else {
    // score-timewise: <measure><part id>…</part></measure>
    for (const m of kids(root, 'measure')) {
      for (const part of kids(m, 'part')) get(part.getAttribute('id') ?? 'P1').measures.push({ el: part });
    }
  }
  const out: PartRef[] = [];
  for (const id of order) if (parts.has(id)) out.push(parts.get(id)!);
  for (const p of parts.values()) if (!out.includes(p)) out.push(p);
  return out;
}

function parseTime(time: Element): [number, number] | undefined {
  const beats = kids(time, 'beats').map((b) => (b.textContent ?? '').split('+').reduce((s, x) => s + (parseFloat(x) || 0), 0));
  const types = kids(time, 'beat-type').map((b) => parseFloat(b.textContent ?? '') || 0);
  if (!beats.length || !types.length || types.some((t) => t <= 0)) return undefined;
  const bt = Math.max(...types);
  let total = 0;
  beats.forEach((b, i) => (total += b * (bt / (types[i] ?? types[0]))));
  return total > 0 ? [total, bt] : undefined;
}

function tempoFromDirection(dir: Element): number | null {
  for (const s of kids(dir, 'sound')) {
    const t = parseFloat(s.getAttribute('tempo') ?? '');
    if (t > 0) return t;
  }
  for (const dt of kids(dir, 'direction-type')) {
    const met = kid(dt, 'metronome');
    if (!met) continue;
    const unit = txt(met, 'beat-unit');
    const pm = txt(met, 'per-minute');
    const perMinute = pm ? parseFloat(pm.replace(/[^\d.]/g, ' ').trim().split(/\s+/)[0]) : NaN;
    if (!unit || !(perMinute > 0)) continue;
    let q = UNIT_QUARTERS[unit] ?? 1;
    const dots = kids(met, 'beat-unit-dot').length;
    let add = q / 2;
    for (let i = 0; i < dots; i++, add /= 2) q += add;
    return perMinute * q;
  }
  return null;
}

function dynamicsVelocity(el: Element | null): number | null {
  const d = parseFloat(el?.getAttribute('dynamics') ?? '');
  if (!(d >= 0)) return null;
  // MusicXML dynamics are a percentage of forte = MIDI velocity 90.
  return Math.max(1, Math.min(127, Math.round(d * 0.9)));
}

function pitchToMidi(pitch: Element): number | null {
  const step = txt(pitch, 'step')?.toUpperCase();
  const octave = num(pitch, 'octave');
  if (!step || !(step in STEP_SEMITONE) || octave === null) return null;
  const alter = num(pitch, 'alter') ?? 0;
  return (octave + 1) * 12 + STEP_SEMITONE[step] + Math.round(alter);
}

function parsePart(part: PartRef, partIndex: number, tempos: TempoEvent[]): PartResult {
  const res: PartResult = { notes: [], content: [], timeSigs: [], staves: 1 };
  let divisions = 1;
  let velocity = DEFAULT_VELOCITY;
  part.measures.forEach(({ el }, m) => {
    let cursor = 0;
    let maxPos = 0;
    let lastStart = 0;
    const advance = (q: number) => {
      cursor = Math.max(0, cursor + q);
      maxPos = Math.max(maxPos, cursor);
    };
    for (const e of kids(el)) {
      switch (e.localName) {
        case 'attributes': {
          const d = num(e, 'divisions');
          if (d && d > 0) divisions = d;
          const st = num(e, 'staves');
          if (st && st > res.staves) res.staves = st;
          const time = kid(e, 'time');
          if (time && !res.timeSigs[m]) res.timeSigs[m] = parseTime(time);
          const key = kid(e, 'key');
          const fifths = num(key, 'fifths');
          if (!res.key && fifths !== null) res.key = keyName(fifths, txt(key, 'mode'));
          break;
        }
        case 'backup':
          cursor = Math.max(0, cursor - (num(e, 'duration') ?? 0) / divisions);
          break;
        case 'forward':
          advance((num(e, 'duration') ?? 0) / divisions);
          break;
        case 'direction': {
          const at = Math.max(0, cursor + (num(e, 'offset') ?? 0) / divisions);
          const bpm = tempoFromDirection(e);
          if (bpm) tempos.push({ measure: m, pos: at, bpm, order: tempos.length });
          const v = dynamicsVelocity(kid(e, 'sound'));
          if (v !== null) velocity = v;
          break;
        }
        case 'sound': {
          const t = parseFloat(e.getAttribute('tempo') ?? '');
          if (t > 0) tempos.push({ measure: m, pos: cursor, bpm: t, order: tempos.length });
          const v = dynamicsVelocity(e);
          if (v !== null) velocity = v;
          break;
        }
        case 'note': {
          if (kid(e, 'grace')) break; // ornaments: not judged, take no time
          const isChord = !!kid(e, 'chord');
          const dur = (num(e, 'duration') ?? 0) / divisions;
          const start = isChord ? lastStart : cursor;
          if (!isChord) {
            lastStart = cursor;
            advance(dur);
          }
          if (kid(e, 'cue')) break; // cue notes keep time but are not played
          const pitch = kid(e, 'pitch');
          if (!pitch) break; // rest / unpitched
          const midi = pitchToMidi(pitch);
          if (midi === null) break;
          const staff = Math.max(1, Math.round(num(e, 'staff') ?? 1));
          if (staff > res.staves) res.staves = staff;
          let tieStart = false;
          let tieStop = false;
          const ties = kids(e, 'tie').map((t) => t.getAttribute('type'));
          const tied = kids(kid(e, 'notations') ?? e, 'tied').map((t) => t.getAttribute('type'));
          for (const t of ties.length ? ties : tied) {
            if (t === 'start') tieStart = true;
            else if (t === 'stop') tieStop = true;
            else if (t === 'continue') tieStart = tieStop = true;
          }
          res.notes.push({
            part: partIndex,
            measure: m,
            pos: r6(start),
            dur: dur,
            midi,
            staff,
            voice: txt(e, 'voice') ?? '1',
            tieStart,
            tieStop,
            velocity: dynamicsVelocity(e) ?? velocity,
            absQ: 0,
          });
          break;
        }
        default:
          break;
      }
    }
    res.content[m] = r6(maxPos);
  });
  return res;
}

/** Which parts become the chart: piano-named parts, else the first grand staff, else all. */
function selectParts(parts: PartRef[], results: PartResult[]): number[] {
  const withNotes = parts.map((_, i) => i).filter((i) => results[i].notes.length > 0);
  const piano = withNotes.filter((i) => PIANO_RE.test(parts[i].label));
  if (piano.length) return piano;
  const grand = withNotes.find((i) => results[i].staves >= 2);
  if (grand !== undefined) return [grand];
  return withNotes;
}

/** Merges tied notes (same pitch, contiguous) into the note at the tie start. */
function mergeTies(notes: RawNote[]): RawNote[] {
  const sorted = notes.slice().sort((a, b) => a.absQ - b.absQ);
  const open = new Map<number, RawNote>();
  const out: RawNote[] = [];
  for (const n of sorted) {
    if (n.tieStop) {
      const o = open.get(n.midi);
      if (o && Math.abs(o.absQ + o.dur - n.absQ) < 1e-3) {
        o.dur += n.dur;
        if (!n.tieStart) open.delete(n.midi);
        continue;
      }
    }
    if (n.tieStart) open.set(n.midi, n);
    out.push(n);
  }
  return out;
}

function readTitle(root: Element): string | null {
  const work = txt(kid(root, 'work'), 'work-title');
  if (work) return work;
  const mv = txt(root, 'movement-title');
  if (mv) return mv;
  const credits = kids(root, 'credit');
  const titled = credits.find((c) => kids(c, 'credit-type').some((t) => t.textContent?.trim() === 'title'));
  const words = txt(titled ?? credits.find((c) => kid(c, 'credit-words')), 'credit-words');
  return words;
}

function readComposer(root: Element): string | undefined {
  for (const c of kids(kid(root, 'identification') ?? root, 'creator')) {
    if (c.getAttribute('type') === 'composer' && c.textContent?.trim()) return c.textContent.trim();
  }
  const credit = kids(root, 'credit').find((c) => kids(c, 'credit-type').some((t) => t.textContent?.trim() === 'composer'));
  return txt(credit, 'credit-words') ?? undefined;
}

/**
 * Parses MusicXML text into a Chart; `chart.musicXml` keeps the original text for the
 * sheet view.
 *
 * Hands: a part with 2+ staves maps staff 1 → R and the other staves → L. When the
 * chosen parts are exactly two single-staff parts, the first is R and the second L.
 * Any other single-staff part is split by pitch (see `splitHandsByPitch`: whole voices
 * stay on one hand when they live on one side of middle C, otherwise >= C4 → R).
 * Title: work-title → movement-title → credit words → opts.title → file name.
 */
export function chartFromMusicXml(xml: string, opts: ImportOptions = {}): Chart {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (root.localName !== 'score-partwise' && root.localName !== 'score-timewise') {
    throw new ImportError('MusicXML 악보가 아니에요. score-partwise 형식의 MusicXML 파일을 올려 주세요.');
  }
  const parts = collectParts(root);
  const tempos: TempoEvent[] = [];
  const results = parts.map((p, i) => parsePart(p, i, tempos));
  const selected = selectParts(parts, results);
  if (!selected.length) throw new ImportError('악보에서 연주할 음표를 찾지 못했어요.');

  // Measure grid: time signatures carried forward, length = longest voice (any part).
  const count = Math.max(...parts.map((p) => p.measures.length));
  const timeSigs: [number, number][] = [];
  const lengths: number[] = [];
  const starts: number[] = [];
  let q = 0;
  for (let m = 0; m < count; m++) {
    const ts = results.map((r) => r.timeSigs[m]).find(Boolean) ?? timeSigs[m - 1] ?? [4, 4];
    timeSigs.push(ts);
    const content = Math.max(0, ...results.map((r) => r.content[m] ?? 0));
    const len = content > EPS ? content : (ts[0] * 4) / ts[1];
    starts.push(q);
    lengths.push(len);
    q = r6(q + len);
  }

  // Tempo map in quarters → ms. The first marking applies from the very start.
  const evs = tempos
    .filter((t) => t.measure < count)
    .map((t) => ({ q: r6(starts[t.measure] + Math.min(t.pos, lengths[t.measure])), bpm: t.bpm, order: t.order }))
    .sort((a, b) => a.q - b.q || a.order - b.order);
  const segs: { q: number; bpm: number; ms: number }[] = [{ q: 0, bpm: evs[0]?.bpm ?? DEFAULT_BPM, ms: 0 }];
  for (const e of evs) {
    const last = segs[segs.length - 1];
    // The first marking at a position wins (parts often repeat the same marking).
    if (e.q <= last.q + EPS || e.bpm === last.bpm) continue;
    segs.push({ q: e.q, bpm: e.bpm, ms: last.ms + ((e.q - last.q) * 60000) / last.bpm });
  }
  const segAt = (x: number) => {
    let s = segs[0];
    for (const g of segs) if (g.q <= x + EPS) s = g;
    return s;
  };
  const msAt = (x: number) => {
    const s = segAt(x);
    return s.ms + ((x - s.q) * 60000) / s.bpm;
  };

  const measures: ChartMeasure[] = starts.map((s, i) => {
    const startMs = msAt(s);
    return {
      index: i,
      startMs,
      durationMs: msAt(s + lengths[i]) - startMs,
      timeSignature: timeSigs[i],
      bpm: segAt(s).bpm,
    };
  });

  // Notes of the chosen parts: absolute positions, ties, hands.
  const handOf = new Map<RawNote, Hand>();
  const staffKey = new Map<RawNote, number>();
  const pitchSplit: (RawNote & { start: number })[] = [];
  const twoSingle = selected.length === 2 && selected.every((i) => results[i].staves < 2);
  let staffBase = 0;
  const raw: RawNote[] = [];
  for (const [k, pi] of selected.entries()) {
    const r = results[pi];
    for (const n of r.notes) n.absQ = r6(starts[n.measure] + n.pos);
    const merged = mergeTies(r.notes);
    for (const n of merged) {
      staffKey.set(n, staffBase + n.staff);
      if (r.staves >= 2) handOf.set(n, n.staff === 1 ? 'R' : 'L');
      else if (twoSingle) handOf.set(n, k === 0 ? 'R' : 'L');
      else pitchSplit.push(Object.assign(n, { start: n.absQ, voice: `${pi}:${n.staff}:${n.voice}` }));
    }
    raw.push(...merged);
    staffBase += Math.max(1, r.staves);
  }
  splitHandsByPitch(pitchSplit);
  for (const n of pitchSplit) handOf.set(n, n.hand ?? (n.midi >= 60 ? 'R' : 'L'));

  const staffOfNote = new Map<ChartNote, number>();
  const notes: ChartNote[] = raw.map((n) => {
    const startMs = msAt(n.absQ);
    const c: ChartNote = {
      id: '',
      midi: n.midi,
      startMs,
      durationMs: Math.max(1, msAt(n.absQ + n.dur) - startMs),
      hand: handOf.get(n)!,
      velocity: n.velocity,
      measure: n.measure,
      beat: r6(n.pos),
    };
    staffOfNote.set(c, staffKey.get(n)!);
    return c;
  });
  const final = finalizeNotes(notes);
  if (!final.length) throw new ImportError('악보에서 연주할 음표를 찾지 못했어요.');
  assignIds(final, (n) => staffOfNote.get(n)!);

  const key = selected.map((i) => results[i].key).find(Boolean) ?? results.map((r) => r.key).find(Boolean);
  const title = readTitle(root) ?? opts.title ?? (opts.fileName ? stripExtension(opts.fileName) : null) ?? '제목 없음';
  const last = measures[measures.length - 1];
  return {
    schema: 'keystage.chart/v1',
    meta: {
      id: opts.id ?? `musicxml-${hashId(xml)}`,
      title,
      composer: readComposer(root),
      source: { kind: 'musicxml', ...(opts.fileName ? { fileName: opts.fileName } : {}) },
      bpm: measures[0].bpm,
      timeSignature: measures[0].timeSignature,
      ...(key ? { key } : {}),
      durationMs: last.startMs + last.durationMs,
    },
    measures,
    notes: final,
    musicXml: xml,
  };
}
