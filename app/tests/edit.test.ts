import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import type { Chart, ChartNote } from '../src/core/chart';
import {
  UndoStack,
  addNote,
  beatLabel,
  blankChart,
  chartToMidiBytes,
  deleteNotes,
  hasConstantTempo,
  moveNotes,
  newNoteId,
  quantize,
  rebuildFromMeasures,
  rebuildTiming,
  resizeNotes,
  setHand,
  setNoteEnd,
  setVelocity,
  snapMs,
  splitHandsByPitch,
  timingOf,
  transpose,
} from '../src/core/edit';
import { chartFromMidi } from '../src/import';

type Spec = [midi: number, startMs: number, durationMs: number, hand?: 'L' | 'R'];

/** 4/4 at 100 BPM (quarter = 600 ms) unless told otherwise, with notes laid in. */
function make(notes: Spec[], opts: { bpm?: number; ts?: [number, number]; offsetMs?: number; bars?: number } = {}): Chart {
  let c = blankChart({ id: 't', title: 'Test', bpm: opts.bpm ?? 100, timeSignature: opts.ts ?? [4, 4], bars: opts.bars ?? 2 });
  for (const [midi, startMs, durationMs, hand] of notes) c = addNote(c, { midi, startMs, durationMs, hand: hand ?? (midi >= 60 ? 'R' : 'L') });
  if (opts.offsetMs !== undefined) c = rebuildTiming(c, { bpm: opts.bpm ?? 100, timeSignature: opts.ts ?? [4, 4], offsetMs: opts.offsetMs });
  return c;
}
const ids = (c: Chart) => c.notes.map((n) => n.id);
const pos = (c: Chart) => c.notes.map((n) => [n.measure, n.beat]);
const key = (c: Chart) => c.notes.map((n) => `${n.measure}|${n.beat}|${n.midi}|${n.hand}`).sort();

describe('rebuildTiming', () => {
  it('lays a constant 4/4 grid and re-derives measure/beat', () => {
    const c = make([[60, 0, 600], [64, 900, 300], [67, 2400, 600], [72, 3000, 1200]]);
    const r = rebuildTiming(c, { bpm: 100, timeSignature: [4, 4], offsetMs: 0 });
    expect(r.measures.map((m) => [m.startMs, m.durationMs])).toEqual([[0, 2400], [2400, 2400]]);
    expect(pos(r)).toEqual([[0, 0], [0, 1.5], [1, 0], [1, 1]]);
    expect(r.meta).toMatchObject({ bpm: 100, timeSignature: [4, 4], durationMs: 4800 });
    // the input is untouched
    expect(c.measures.length).toBe(2);
    expect(c).not.toBe(r);
  });

  it('puts notes before the first downbeat in a pickup measure of real length', () => {
    const c = make([[67, 0, 300], [69, 300, 300], [72, 600, 600], [60, 3000, 600]]);
    const r = rebuildTiming(c, { bpm: 100, timeSignature: [4, 4], offsetMs: 600 });
    expect(r.measures.map((m) => [m.startMs, m.durationMs])).toEqual([[0, 600], [600, 2400], [3000, 2400]]);
    expect(pos(r)).toEqual([[0, 0], [0, 0.5], [1, 0], [2, 0]]);
    expect(timingOf(r)).toEqual({ bpm: 100, timeSignature: [4, 4], offsetMs: 600 });
    expect(beatLabel(r, r.notes[1])).toBe('못갖춘마디 1.5박');
    expect(beatLabel(r, r.notes[3])).toBe('2마디 1박');
  });

  it('handles 3/4 and 6/8 beat units', () => {
    const c = make([[60, 0, 500], [62, 1000, 500], [64, 1500, 500], [65, 2250, 250]], { bpm: 120 });
    const r = rebuildTiming(c, { bpm: 120, timeSignature: [3, 4], offsetMs: 0 });
    expect(r.measures.map((m) => m.startMs)).toEqual([0, 1500]);
    expect(r.measures[0].durationMs).toBe(1500);
    expect(pos(r)).toEqual([[0, 0], [0, 2], [1, 0], [1, 1.5]]);
    expect(beatLabel(r, r.notes[3])).toBe('2마디 2.5박');
    const six = rebuildTiming(c, { bpm: 120, timeSignature: [6, 8], offsetMs: 0 });
    expect(six.measures[0].durationMs).toBe(1500);
    expect(beatLabel(six, six.notes[3])).toBe('2마디 4박'); // 1.5 quarters = the 4th eighth
  });

  it('wraps a negative or over-long offset into one measure', () => {
    const c = make([[60, 0, 600], [62, 1800, 600]]);
    const neg = rebuildTiming(c, { bpm: 100, timeSignature: [4, 4], offsetMs: -1800 });
    expect(neg.measures[0]).toMatchObject({ startMs: 0, durationMs: 600 });
    expect(pos(neg)).toEqual([[0, 0], [1, 2]]);
    const whole = rebuildTiming(c, { bpm: 100, timeSignature: [4, 4], offsetMs: 2400 });
    expect(whole.measures[0]).toMatchObject({ startMs: 0, durationMs: 2400 });
  });

  it('keeps the bar count of an empty chart and covers an attached recording', () => {
    const empty = blankChart({ id: 'n', title: '새 곡', bars: 8 });
    const faster = rebuildTiming(empty, { bpm: 120, timeSignature: [4, 4], offsetMs: 0 });
    expect(faster.measures.length).toBe(8);
    expect(faster.meta.durationMs).toBe(16000);
    const withAudio: Chart = { ...empty, audio: { id: 'a', durationMs: 30000, offsetMs: 1000, gain: 1 } };
    const r = rebuildTiming(withAudio, { bpm: 100, timeSignature: [4, 4], offsetMs: 0 });
    expect(r.meta.durationMs).toBeGreaterThanOrEqual(29000);
    expect(r.measures.length).toBe(Math.ceil(29000 / 2400));
  });
});

describe('rebuildFromMeasures', () => {
  it('keeps tempo changes and extends the grid for notes past the end', () => {
    const base = make([[60, 0, 600]]);
    const measures = [
      { index: 0, startMs: 0, durationMs: 2400, timeSignature: [4, 4] as [number, number], bpm: 100 },
      { index: 1, startMs: 2400, durationMs: 2000, timeSignature: [4, 4] as [number, number], bpm: 120 },
    ];
    const c: Chart = { ...base, measures };
    const r = rebuildFromMeasures(addNote(c, { midi: 64, startMs: 5000, durationMs: 500, hand: 'R' }));
    expect(hasConstantTempo(r)).toBe(false);
    expect(r.measures.map((m) => [m.startMs, m.durationMs, m.bpm])).toEqual([[0, 2400, 100], [2400, 2000, 120], [4400, 2000, 120]]);
    expect(pos(r)).toEqual([[0, 0], [2, 1.2]]);
    expect(r.meta.durationMs).toBe(6400);
  });
});

describe('note ops', () => {
  const base = make([[60, 0, 600], [64, 600, 600], [48, 0, 1200, 'L'], [72, 1200, 300]]);

  it('adds notes with stable e-<n> ids, sorted and clamped', () => {
    expect(ids(base)).toEqual(['e-3', 'e-1', 'e-2', 'e-4']);
    expect(newNoteId(base)).toBe('e-5');
    const c = addNote(base, { midi: 300, startMs: -50, durationMs: 5, hand: 'R', velocity: 999 });
    const n = c.notes.find((x) => x.id === 'e-5')!;
    expect(n).toMatchObject({ midi: 108, startMs: 0, durationMs: 30, velocity: 127, measure: 0, beat: 0 });
    expect(base.notes.length).toBe(4);
  });

  it('deletes by id', () => {
    const c = deleteNotes(base, ['e-1', 'e-4']);
    expect(ids(c)).toEqual(['e-3', 'e-2']);
    expect(deleteNotes(base, [])).toBe(base);
  });

  it('moves in time and pitch, clamping the group as a block', () => {
    const c = moveNotes(base, ['e-1', 'e-2'], { dMs: 600, dMidi: 2 });
    expect(c.notes.filter((n) => ['e-1', 'e-2'].includes(n.id)).map((n) => [n.startMs, n.midi, n.beat])).toEqual([[600, 62, 1], [1200, 66, 2]]);
    const early = moveNotes(base, ['e-1', 'e-2'], { dMs: -5000 });
    expect(early.notes.find((n) => n.id === 'e-1')!.startMs).toBe(0);
    expect(early.notes.find((n) => n.id === 'e-2')!.startMs).toBe(600); // shape kept
    const high = moveNotes(base, ['e-3', 'e-4'], { dMidi: 100 });
    expect(high.notes.find((n) => n.id === 'e-4')!.midi).toBe(108);
    expect(high.notes.find((n) => n.id === 'e-3')!.midi).toBe(84);
    const low = transpose(base, ids(base), -100);
    expect(low.notes.map((n) => n.midi).sort((a, b) => a - b)).toEqual([21, 33, 37, 45]);
    expect(moveNotes(base, ['e-1'], {})).toBe(base);
  });

  it('resizes with a 30 ms floor and sets ends', () => {
    const c = resizeNotes(base, ['e-1'], -1000);
    expect(c.notes.find((n) => n.id === 'e-1')!.durationMs).toBe(30);
    const d = setNoteEnd(base, ['e-1', 'e-2'], 1500);
    expect(d.notes.find((n) => n.id === 'e-1')!.durationMs).toBe(1500);
    expect(d.notes.find((n) => n.id === 'e-2')!.durationMs).toBe(900);
    expect(setNoteEnd(base, ['e-2'], 610).notes.find((n) => n.id === 'e-2')!.durationMs).toBe(30);
  });

  it('sets hand and velocity', () => {
    const c = setHand(base, ['e-3'], 'R');
    expect(c.notes.every((n) => n.hand === 'R')).toBe(true);
    expect(setHand(base, ['e-3'], 'L')).toBe(base);
    expect(setVelocity(base, ['e-1'], 0).notes.find((n) => n.id === 'e-1')!.velocity).toBe(1);
    expect(setVelocity(base, ['e-1'], 100).notes.find((n) => n.id === 'e-1')!.velocity).toBe(100);
  });

  it('splits hands by pitch', () => {
    const c = splitHandsByPitch(setHand(base, ids(base), 'L'), 60);
    expect(c.notes.map((n) => n.hand)).toEqual(['L', 'R', 'R', 'R']);
  });
});

describe('snap and quantize', () => {
  it('snaps to straight and triplet grids anchored at measure starts', () => {
    const c = make([], { bpm: 100 }); // quarter 600
    expect(snapMs(c, 740, 4)).toBe(600);
    expect(snapMs(c, 760, 8)).toBe(900);
    expect(snapMs(c, 740, 16)).toBe(750);
    expect(snapMs(c, 390, '8t')).toBe(400);
    expect(snapMs(c, 290, '16t')).toBe(300);
    expect(snapMs(c, 2390, 16)).toBe(2400); // next measure's downbeat
  });

  it('snaps across a pickup to the first downbeat', () => {
    const c = make([[67, 0, 300]], { offsetMs: 500 });
    expect(snapMs(c, 480, 4)).toBe(500);
    expect(snapMs(c, 1090, 4)).toBe(1100);
  });

  it('quantizes starts, ends and triplets', () => {
    const c = make([[60, 40, 580], [62, 1210, 260], [64, 2030, 200], [65, 2350, 140]]);
    const q = quantize(c, ids(c), 16);
    expect(q.notes.map((n) => n.startMs)).toEqual([0, 1200, 2100, 2400]);
    expect(q.notes.map((n) => n.durationMs)).toEqual([580, 260, 200, 140]);
    const qe = quantize(c, ids(c), 16, { starts: true, ends: true });
    expect(qe.notes.map((n) => [n.startMs, n.durationMs])).toEqual([[0, 600], [1200, 300], [2100, 150], [2400, 150]]);
    const t = quantize(make([[60, 190, 100], [60, 410, 100]]), ['e-1', 'e-2'], '8t');
    expect(t.notes.map((n) => n.startMs)).toEqual([200, 400]);
    expect(t.notes.map((n) => n.beat)).toEqual([0.333333, 0.666667]);
    expect(quantize(c, ids(c), 16, { starts: false, ends: false })).toBe(c);
  });
});

describe('UndoStack', () => {
  it('undoes, redoes and drops the redo list on a new push', () => {
    const u = new UndoStack(0);
    u.push(1);
    u.push(2);
    expect(u.canUndo).toBe(true);
    expect(u.undo()).toBe(1);
    expect(u.undo()).toBe(0);
    expect(u.undo()).toBeNull();
    expect(u.redo()).toBe(1);
    u.push(9);
    expect(u.canRedo).toBe(false);
    expect(u.present).toBe(9);
    expect(u.undo()).toBe(1);
  });

  it('coalesces drag frames with replaceTop and caps history at 200', () => {
    const u = new UndoStack(0);
    u.push(1);
    u.replaceTop(2);
    u.replaceTop(3);
    expect(u.present).toBe(3);
    expect(u.depth).toBe(1);
    expect(u.undo()).toBe(0);
    const big = new UndoStack(0);
    for (let i = 1; i <= 260; i++) big.push(i);
    expect(big.depth).toBe(200);
    let n = 0;
    while (big.undo() !== null) n++;
    expect(n).toBe(200);
    expect(big.present).toBe(60);
    const p = new UndoStack(0);
    p.push(1);
    p.push(2);
    expect(p.pop()).toBe(1);
    expect(p.canRedo).toBe(false);
    expect(p.present).toBe(1);
    big.reset(5);
    expect(big.canUndo).toBe(false);
    expect(big.present).toBe(5);
  });
});

describe('chartToMidiBytes', () => {
  it('writes two piano tracks with the chart tempo and title', () => {
    const c = make([[60, 0, 600], [64, 600, 600], [48, 0, 1200, 'L']]);
    const m = new Midi(chartToMidiBytes(c));
    expect(m.header.name).toBe('Test');
    expect(m.header.tempos.map((t) => [t.ticks, Math.round(t.bpm)])).toEqual([[0, 100]]);
    expect(m.header.timeSignatures.map((t) => [t.ticks, t.timeSignature])).toEqual([[0, [4, 4]]]);
    expect(m.tracks.map((t) => [t.name, t.notes.length])).toEqual([['Right Hand', 2], ['Left Hand', 1]]);
    expect(m.tracks[0].notes[0]).toMatchObject({ midi: 60, ticks: 0, durationTicks: 480 });
    expect(Math.round(m.tracks[0].notes[0].velocity * 127)).toBe(80);
  });

  it('round-trips through chartFromMidi: plain, pickup, 3/4 with triplets, tempo change', () => {
    const plain = make([[60, 0, 600], [64, 600, 600], [67, 1200, 300], [48, 0, 2400, 'L'], [72, 2400, 600], [76, 2400, 600], [55, 2400, 1200, 'L']]);
    expect(key(chartFromMidi(chartToMidiBytes(plain)))).toEqual(key(plain));

    const pickup = make([[67, 0, 300], [69, 300, 300], [72, 600, 600], [60, 3000, 600], [48, 600, 2400, 'L']], { offsetMs: 600 });
    const back = chartFromMidi(chartToMidiBytes(pickup));
    expect(back.measures.map((m) => m.durationMs)).toEqual([600, 2400, 2400]);
    expect(key(back)).toEqual(key(pickup));

    let waltz = make([[67, 0, 500], [60, 500, 500], [64, 1000, 500], [48, 500, 1500, 'L']], { bpm: 120, ts: [3, 4], offsetMs: 500 });
    for (let i = 0; i < 3; i++) waltz = addNote(waltz, { midi: 72 + i, startMs: 2000 + (i * 500) / 3, durationMs: 500 / 3, hand: 'R' });
    const w = chartFromMidi(chartToMidiBytes(waltz));
    expect(w.measures.map((m) => m.timeSignature)).toEqual([[3, 4], [3, 4], [3, 4]]);
    expect(key(w)).toEqual(key(waltz));

    const measures = [
      { index: 0, startMs: 0, durationMs: 2400, timeSignature: [4, 4] as [number, number], bpm: 100 },
      { index: 1, startMs: 2400, durationMs: 2000, timeSignature: [4, 4] as [number, number], bpm: 120 },
    ];
    const tempoChange = rebuildFromMeasures({ ...make([[60, 0, 600], [62, 1800, 600], [64, 2400, 500], [65, 3650, 250]]), measures });
    const t = chartFromMidi(chartToMidiBytes(tempoChange));
    expect(t.measures.map((m) => [m.startMs, m.bpm])).toEqual([[0, 100], [2400, 120]]);
    expect(key(t)).toEqual(key(tempoChange));
  });

  it('keeps ids and velocities stable across ops', () => {
    const c = make([[60, 0, 600]]);
    const n: ChartNote = c.notes[0];
    const moved = moveNotes(c, [n.id], { dMs: 300 });
    expect(moved.notes[0].id).toBe(n.id);
    expect(moved.notes[0].velocity).toBe(80);
  });
});
