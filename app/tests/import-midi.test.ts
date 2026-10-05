import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { ImportError, chartFromMidi, chartFromMusicXml, chartToMusicXml, importFile } from '../src/import';
import type { Chart } from '../src/core/chart';

const PPQ = 480;
type N = [midi: number, beat: number, beats: number];

/** Builds a MIDI file. Positions in quarter notes. */
function build(opts: {
  bpm?: number;
  tempos?: [beat: number, bpm: number][];
  timeSignatures?: [beat: number, beats: number, type: number][];
  tracks: { notes: N[]; name?: string; channel?: number; program?: number }[];
}): Uint8Array {
  const midi = new Midi();
  if (opts.bpm) midi.header.setTempo(opts.bpm);
  for (const [beat, bpm] of opts.tempos ?? []) midi.header.tempos.push({ ticks: beat * PPQ, bpm });
  for (const [beat, b, t] of opts.timeSignatures ?? []) midi.header.timeSignatures.push({ ticks: beat * PPQ, timeSignature: [b, t] });
  midi.header.update();
  for (const t of opts.tracks) {
    const tr = midi.addTrack();
    if (t.name) tr.name = t.name;
    if (t.channel !== undefined) tr.channel = t.channel;
    if (t.program !== undefined) tr.instrument.number = t.program;
    for (const [m, beat, beats] of t.notes) tr.addNote({ midi: m, ticks: Math.round(beat * PPQ), durationTicks: Math.round(beats * PPQ), velocity: 0.8 });
  }
  return midi.toArray();
}

const key = (c: Chart) => c.notes.map((x) => `${x.measure}|${x.beat}|${x.midi}|${x.hand}`).sort();

describe('chartFromMidi', () => {
  it('uses the tempo map and 4/4 measures by default', () => {
    const c = chartFromMidi(
      build({
        bpm: 120,
        tempos: [[4, 60]],
        tracks: [{ notes: [[60, 0, 1], [62, 1, 1], [64, 4, 1], [65, 5, 2]] }],
      }),
    );
    expect(c.notes.map((x) => x.startMs)).toEqual([0, 500, 2000, 3000]);
    expect(c.notes[3].durationMs).toBeCloseTo(2000);
    expect(c.measures.map((m) => [m.startMs, m.durationMs, m.bpm])).toEqual([
      [0, 2000, 120],
      [2000, 4000, 60],
    ]);
    expect(c.meta).toMatchObject({ bpm: 120, timeSignature: [4, 4], durationMs: 6000, source: { kind: 'midi' } });
    expect(c.notes.map((x) => [x.measure, x.beat])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(c.notes[0].velocity).toBe(Math.floor(0.8 * 127)); // the encoder truncates
  });

  it('follows time signature changes', () => {
    const c = chartFromMidi(
      build({ bpm: 100, timeSignatures: [[0, 3, 4], [6, 6, 8]], tracks: [{ notes: [[67, 0, 3], [67, 3, 3], [67, 6, 3], [67, 9, 1.5]] }] }),
    );
    expect(c.measures.map((m) => m.timeSignature)).toEqual([[3, 4], [3, 4], [6, 8], [6, 8]]);
    expect(c.measures.map((m) => m.durationMs)).toEqual([1800, 1800, 1800, 1800]);
    expect(c.notes.map((x) => x.measure)).toEqual([0, 1, 2, 3]);
  });

  it('two piano tracks: higher average pitch is the right hand', () => {
    const c = chartFromMidi(
      build({
        bpm: 100,
        tracks: [
          { name: 'Piano LH?', notes: [[48, 0, 2], [55, 2, 2], [62, 4, 4]] },
          { name: 'Piano', notes: [[72, 0, 1], [76, 1, 1], [58, 2, 1]] },
        ],
      }),
    );
    expect(c.notes.map((x) => `${x.midi}${x.hand}`)).toEqual(['48L', '72R', '76R', '55L', '58R', '62L']);
    expect(c.notes.map((x) => x.id)).toEqual(['m0-2-0', 'm0-1-0', 'm0-1-1', 'm0-2-1', 'm0-1-2', 'm1-2-0']);
  });

  it('skips drum tracks and prefers piano over other instruments', () => {
    const c = chartFromMidi(
      build({
        bpm: 100,
        tracks: [
          { name: 'Drums', channel: 9, notes: [[36, 0, 0.5], [38, 1, 0.5]] },
          { name: 'Strings', program: 48, channel: 1, notes: [[50, 0, 4]] },
          { name: 'Melody', program: 0, channel: 2, notes: [[72, 0, 1], [48, 0, 1], [62, 1, 1]] },
        ],
      }),
    );
    expect(c.notes.map((x) => `${x.midi}${x.hand}`)).toEqual(['48L', '72R', '62R']);
  });

  it('falls back to all melodic tracks when none is piano', () => {
    const c = chartFromMidi(
      build({ bpm: 100, tracks: [{ program: 40, notes: [[76, 0, 1]] }, { program: 42, notes: [[43, 0, 1]] }] }),
    );
    expect(c.notes.map((x) => `${x.midi}${x.hand}`)).toEqual(['43L', '76R']);
  });

  it('single track: splits by pitch with continuity', () => {
    const c = chartFromMidi(
      build({
        bpm: 100,
        tracks: [{ notes: [[64, 0, 1], [48, 0, 1], [62, 1, 1], [43, 2, 1], [60, 3, 1], [57, 3, 1], [72, 4, 1]] }],
      }),
    );
    expect(c.notes.map((x) => `${x.midi}${x.hand}`)).toEqual(['48L', '64R', '62R', '43L', '57L', '60R', '72R']);
  });

  it('a melody-only track stays in the right hand even below middle C', () => {
    const c = chartFromMidi(build({ bpm: 100, tracks: [{ notes: [[67, 0, 1], [64, 1, 1], [59, 2, 1], [60, 3, 1]] }] }));
    expect(c.notes.every((x) => x.hand === 'R')).toBe(true);
  });

  it('snaps near-grid onsets to the 16th grid, keeps clearly off-grid ones', () => {
    // 120 BPM: one tick ≈ 1.04 ms
    const midi = new Midi();
    midi.header.setTempo(120);
    const tr = midi.addTrack();
    tr.addNote({ midi: 60, ticks: 485, durationTicks: 470 }); // 5 ms late → 480
    tr.addNote({ midi: 62, ticks: 960 - 12, durationTicks: 480 }); // 12.5 ms early → 960
    tr.addNote({ midi: 64, ticks: 1440 + 60, durationTicks: 240 }); // 32nd off grid (62 ms) → kept
    tr.addNote({ midi: 65, ticks: 1920, durationTicks: 10 }); // ~10 ms long → dropped
    tr.addNote({ midi: 15, ticks: 1920, durationTicks: 480 }); // below A0 → folded up
    tr.addNote({ midi: 115, ticks: 2400, durationTicks: 480 }); // above C8 → folded down
    const c = chartFromMidi(midi.toArray());
    const byMidi = Object.fromEntries(c.notes.map((x) => [x.midi, x]));
    expect(byMidi[60]).toMatchObject({ startMs: 500, beat: 1 });
    expect(byMidi[60].durationMs).toBe(500);
    expect(byMidi[62]).toMatchObject({ startMs: 1000, beat: 2 });
    expect(byMidi[64].beat).toBeCloseTo(3.125);
    expect(byMidi[64].startMs).toBeCloseTo(1562.5);
    expect(byMidi[65]).toBeUndefined();
    expect(byMidi[27]).toBeDefined();
    expect(byMidi[103]).toBeDefined();
    expect(c.notes.every((x) => x.midi >= 21 && x.midi <= 108)).toBe(true);
  });

  it('reads the key signature and names the chart after the file', () => {
    const midi = new Midi();
    midi.header.setTempo(90);
    midi.header.keySignatures.push({ ticks: 0, key: 'D', scale: 'major' });
    midi.addTrack().addNote({ midi: 62, ticks: 0, durationTicks: 480 });
    // @tonejs/midi writes the key byte with an extra +7 offset; patch it to the real sf = 2 (D).
    const bytes = midi.toArray();
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 0x02) bytes[i + 3] = 2;
    }
    const c = chartFromMidi(bytes.buffer as ArrayBuffer, { fileName: 'scale.mid' });
    expect(c.meta).toMatchObject({ key: 'D major', title: 'scale', bpm: 90, source: { kind: 'midi', fileName: 'scale.mid' } });
  });

  it('throws ImportError for garbage and drum-only files', () => {
    expect(() => chartFromMidi(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(ImportError);
    expect(() => chartFromMidi(build({ tracks: [{ channel: 9, notes: [[36, 0, 1]] }] }))).toThrow(/음표/);
  });

  it('importFile reads .mid files', async () => {
    const bytes = build({ bpm: 100, tracks: [{ notes: [[60, 0, 1]] }] });
    const c = await importFile(new File([bytes as Uint8Array<ArrayBuffer>], 'one.MID'));
    expect(c.meta.source).toEqual({ kind: 'midi', fileName: 'one.MID' });
    expect(c.notes).toHaveLength(1);
    expect(c.musicXml).toContain('<score-partwise');
  });
});

describe('chartToMusicXml round trip', () => {
  const sample = () =>
    chartFromMidi(
      build({
        bpm: 96,
        tempos: [[8, 132]],
        timeSignatures: [[0, 4, 4], [12, 3, 4]],
        tracks: [
          {
            name: 'Piano R',
            notes: [
              // chord + melody, 16ths, a note tied over the barline, overlapping voices
              [72, 0, 1], [76, 0, 1], [79, 0, 1], [74, 1, 0.5], [76, 1.5, 0.25], [77, 1.75, 0.25], [79, 2, 3],
              [84, 5, 0.75], [83, 5.75, 0.25], [81, 6, 2], [72, 6, 1], [74, 7, 1],
              [70, 8, 1], [73, 9, 1], [78, 10, 6], [80, 12, 1], [82, 13, 2],
            ],
          },
          {
            name: 'Piano L',
            notes: [[48, 0, 4], [55, 4, 2], [52, 6, 2], [43, 8, 5], [50, 13, 2], [38, 14, 1]],
          },
        ],
      }),
    );

  it('keeps (measure, beat, midi, hand) for every note', () => {
    const c = sample();
    const xml = chartToMusicXml(c);
    const back = chartFromMusicXml(xml);
    expect(key(back)).toEqual(key(c));
    expect(back.measures.map((m) => m.timeSignature)).toEqual(c.measures.map((m) => m.timeSignature));
    expect(back.measures.map((m) => m.bpm)).toEqual(c.measures.map((m) => m.bpm));
    expect(back.measures.map((m) => Math.round(m.startMs))).toEqual(c.measures.map((m) => Math.round(m.startMs)));
    // durations survive at grid precision
    const dur = (ch: Chart) => ch.notes.map((x) => `${x.midi}@${x.startMs.toFixed(1)}:${x.durationMs.toFixed(1)}`).sort();
    expect(dur(back)).toEqual(dur(c));
  });

  it('writes a valid grand staff with ties, chords, backups and key', () => {
    const c = sample();
    c.meta.key = 'Bb major';
    const xml = chartToMusicXml(c);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.querySelector('staves')?.textContent).toBe('2');
    expect(doc.querySelector('key fifths')?.textContent).toBe('-2');
    expect(doc.querySelectorAll('clef')).toHaveLength(2);
    expect(doc.querySelectorAll('tie[type="start"]').length).toBeGreaterThan(0);
    expect(doc.querySelectorAll('chord').length).toBeGreaterThan(0);
    expect(doc.querySelectorAll('backup').length).toBeGreaterThanOrEqual(c.measures.length);
    expect(doc.querySelectorAll('sound[tempo]')).toHaveLength(2);
    expect(doc.querySelectorAll('measure')).toHaveLength(c.measures.length);
    // flats in a flat key: midi 70 → B-flat
    expect(xml).toContain('<step>B</step><alter>-1</alter><octave>4</octave>');
    // every voice fills its measure exactly
    for (const m of Array.from(doc.querySelectorAll('measure'))) {
      const sums = new Map<string, number>();
      for (const nEl of Array.from(m.querySelectorAll('note'))) {
        if (nEl.querySelector('chord')) continue;
        const v = nEl.querySelector('voice')!.textContent!;
        sums.set(v, (sums.get(v) ?? 0) + Number(nEl.querySelector('duration')!.textContent));
      }
      expect(new Set(sums.values()).size).toBe(1);
    }
  });
});
