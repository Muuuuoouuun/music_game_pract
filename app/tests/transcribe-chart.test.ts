import { describe, expect, it } from 'vitest';
import { chartFromMusicXml } from '../src/import';
import { notesToChart, pickupMs, toMonophonic, type RawNote } from '../src/transcribe/to-chart';

const n = (midi: number, startMs: number, durationMs = 400, velocity = 90): RawNote => ({ midi, startMs, durationMs, velocity });
const audio = { id: 'a-test', fileName: 'x.wav', durationMs: 10000, offsetMs: 0, gain: 0.8 };

describe('notesToChart', () => {
  it('lays quarter notes at 120 BPM on the grid with measure/beat', () => {
    const raw = [n(60, 1000), n(62, 1500), n(64, 2000), n(65, 2500), n(67, 3000)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 1000, title: 'T', audio });
    expect(c.meta.source.kind).toBe('audio');
    expect(c.meta.bpm).toBe(120);
    expect(c.notes.map((x) => x.startMs)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(c.notes.map((x) => [x.measure, x.beat])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 0]]);
    expect(c.measures.length).toBe(2);
    expect(c.measures[1].startMs).toBe(2000);
    expect(c.meta.durationMs).toBe(4000);
    expect(c.audio?.offsetMs).toBe(1000);
    expect(c.musicXml).toContain('<score-partwise');
    expect(c.notes.every((x) => x.id)).toBe(true);
  });

  it('snaps starts within the tolerance and keeps clearly off-grid onsets', () => {
    const raw = [n(60, 1020), n(62, 1570), n(64, 2000), n(65, 2530)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 1000, title: 'T' });
    expect(c.notes[0].startMs).toBe(0); // 20 ms early → snapped
    expect(c.notes[1].startMs).toBe(570); // 55 ms from the nearest 16th (625) → kept, fractional beat
    expect(c.notes[1].beat).toBeCloseTo(1.14, 2);
    expect(c.notes[2].startMs).toBe(1000);
    expect(c.notes[3].startMs).toBe(1500); // 30 ms late → snapped
    const tight = notesToChart(raw, { bpm: 120, offsetMs: 1000, title: 'T', snapTolMs: 10 });
    expect(tight.notes[0].startMs).toBe(20);
  });

  it('drops blips, enforces the minimum duration, merges a re-onset of the same pitch', () => {
    const raw = [n(60, 1000, 30), n(62, 1000, 45), n(64, 2000, 200), n(64, 2020, 300), n(65, 3000, 10)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 1000, title: 'T' });
    expect(c.notes.map((x) => x.midi)).toEqual([62, 64]);
    expect(c.notes[0].durationMs).toBeGreaterThanOrEqual(60);
    expect(c.notes[1].durationMs).toBe(320); // 2000 → 2320 merged end
  });

  it('builds a pickup measure when notes precede the downbeat and moves audio.offsetMs back', () => {
    const raw = [n(67, 500, 400, 70), n(60, 1000), n(64, 1500), n(67, 2000), n(72, 2500), n(60, 3000)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 1000, title: 'T', audio });
    expect(c.measures[0].durationMs).toBe(500); // one-beat pickup
    expect(c.measures[0].startMs).toBe(0);
    expect(c.measures[1].startMs).toBe(500);
    expect(pickupMs(c)).toBe(500);
    expect(c.notes[0]).toMatchObject({ midi: 67, startMs: 0, measure: 0, beat: 0 });
    expect(c.notes[1]).toMatchObject({ midi: 60, startMs: 500, measure: 1, beat: 0 });
    expect(c.notes[5]).toMatchObject({ midi: 60, startMs: 2500, measure: 2, beat: 0 });
    expect(c.audio?.offsetMs).toBe(500); // audio 500 ms plays at chart 0
  });

  it('lays whole bars in front when the downbeat was found a bar in', () => {
    const raw = [n(60, 0), n(62, 500), n(64, 1000), n(65, 1500), n(67, 2000), n(69, 2500)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 2000, title: 'T', audio });
    expect(c.measures[0].durationMs).toBe(2000);
    expect(pickupMs(c)).toBe(0);
    expect(c.notes[0]).toMatchObject({ startMs: 0, measure: 0, beat: 0 });
    expect(c.notes[4]).toMatchObject({ startMs: 2000, measure: 1, beat: 0 });
    expect(c.audio?.offsetMs).toBe(0);
  });

  it('splits hands by pitch with voice continuity, or keeps one hand when asked', () => {
    const raw = [n(48, 0), n(72, 0), n(52, 500), n(76, 500), n(55, 1000), n(79, 1000)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 0, title: 'T' });
    expect(c.notes.filter((x) => x.hand === 'L').map((x) => x.midi)).toEqual([48, 52, 55]);
    expect(c.notes.filter((x) => x.hand === 'R').map((x) => x.midi)).toEqual([72, 76, 79]);
    const melody = [n(60, 0), n(59, 500), n(57, 1000), n(55, 1500), n(64, 2000)];
    const m = notesToChart(melody, { bpm: 120, offsetMs: 0, title: 'T' });
    expect(new Set(m.notes.map((x) => x.hand)).size).toBe(1); // a line dipping to G3 is not torn between hands
    const one = notesToChart(raw, { bpm: 120, offsetMs: 0, title: 'T', singleHand: 'R' });
    expect(one.notes.every((x) => x.hand === 'R')).toBe(true);
  });

  it('3/4: 1500 ms bars at 120 BPM, beat positions in quarters', () => {
    const raw = [n(60, 0), n(62, 500), n(64, 1000), n(65, 1500), n(67, 2000), n(69, 2500), n(71, 3000)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 0, title: 'T', timeSignature: [3, 4] });
    expect(c.measures.map((m) => m.durationMs)).toEqual([1500, 1500, 1500]);
    expect(c.notes.map((x) => [x.measure, x.beat])).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0]]);
    expect(c.meta.timeSignature).toEqual([3, 4]);
  });

  it('round-trips through the generated MusicXML for grid-aligned notes', () => {
    const raw = [n(60, 0), n(64, 0), n(62, 250), n(65, 500), n(48, 500, 900), n(67, 1000)];
    const c = notesToChart(raw, { bpm: 120, offsetMs: 0, title: 'RT' });
    const back = chartFromMusicXml(c.musicXml!);
    const key = (x: { measure: number; beat: number; midi: number; hand: string }) => `${x.measure}|${x.beat}|${x.midi}|${x.hand}`;
    expect(back.notes.map(key).sort()).toEqual(c.notes.map(key).sort());
  });

  it('folds out-of-range pitches by octave and gives a stable id for the same input', () => {
    const a = notesToChart([n(10, 0), n(120, 500)], { bpm: 120, offsetMs: 0, title: 'T' });
    expect(a.notes.map((x) => x.midi)).toEqual([22, 108]);
    const b = notesToChart([n(10, 0), n(120, 500)], { bpm: 120, offsetMs: 0, title: 'T' });
    expect(a.meta.id).toBe(b.meta.id);
    expect(a.meta.id.startsWith('audio-')).toBe(true);
  });

  it('throws a Korean message when nothing survives cleaning', () => {
    expect(() => notesToChart([n(60, 0, 5)], { bpm: 120, offsetMs: 0, title: 'T' })).toThrow(/음표/);
  });
});

describe('toMonophonic', () => {
  it('keeps the loudest of simultaneous notes and trims overlaps', () => {
    const raw = [n(60, 0, 900, 60), n(72, 10, 900, 100), n(64, 500, 900, 80), n(67, 1000, 300, 70)];
    const m = toMonophonic(raw);
    expect(m.map((x) => x.midi)).toEqual([72, 64, 67]);
    expect(m[0].durationMs).toBe(490);
    expect(m[1].durationMs).toBe(500);
    expect(m[2].durationMs).toBe(300);
  });
});
