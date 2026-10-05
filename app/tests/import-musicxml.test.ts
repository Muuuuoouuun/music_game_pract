import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { BUILTIN_SONGS, ImportError, chartFromMusicXml, chartToMusicXml, importFile } from '../src/import';
import type { Chart } from '../src/core/chart';

const PIANO = '<score-part id="P1"><part-name>Piano</part-name></score-part>';

/** A partwise score; `parts` maps part id → measure bodies. */
function score(parts: Record<string, string[]>, partList?: string, head = ''): string {
  const list = partList ?? Object.keys(parts).map((id) => `<score-part id="${id}"><part-name>Music</part-name></score-part>`).join('');
  const body = Object.entries(parts)
    .map(([id, ms]) => `<part id="${id}">${ms.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join('')}</part>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1">${head}<part-list>${list}</part-list>${body}</score-partwise>`;
}

const attrs = (div = 1, beats = 4, type = 4, extra = '') =>
  `<attributes><divisions>${div}</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${type}</beat-type></time>${extra}</attributes>`;

function n(step: string, octave: number, dur: number, opts: { alter?: number; chord?: boolean; staff?: number; voice?: number; tie?: string[]; extra?: string } = {}) {
  return (
    `<note>${opts.chord ? '<chord/>' : ''}<pitch><step>${step}</step>${opts.alter ? `<alter>${opts.alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
    `<duration>${dur}</duration>${(opts.tie ?? []).map((t) => `<tie type="${t}"/>`).join('')}<voice>${opts.voice ?? 1}</voice>` +
    `${opts.staff ? `<staff>${opts.staff}</staff>` : ''}${opts.extra ?? ''}</note>`
  );
}
const rest = (dur: number, staff?: number) => `<note><rest/><duration>${dur}</duration>${staff ? `<staff>${staff}</staff>` : ''}</note>`;
const backup = (d: number) => `<backup><duration>${d}</duration></backup>`;
const forward = (d: number) => `<forward><duration>${d}</duration></forward>`;
const tempo = (bpm: number) => `<direction><direction-type><words>T</words></direction-type><sound tempo="${bpm}"/></direction>`;

const simple = (c: Chart) => c.notes.map((x) => [x.midi, x.measure, x.beat, x.hand]);

describe('chartFromMusicXml: timing', () => {
  it('follows divisions changes between measures', () => {
    const c = chartFromMusicXml(
      score({ P1: [attrs(1) + n('C', 4, 2) + n('D', 4, 2), '<attributes><divisions>4</divisions></attributes>' + n('E', 4, 2) + n('F', 4, 14)] }),
    );
    expect(c.notes.map((x) => [x.midi, x.measure, x.beat])).toEqual([
      [60, 0, 0],
      [62, 0, 2],
      [64, 1, 0],
      [65, 1, 0.5],
    ]);
    // default tempo 100 → 600 ms per quarter
    expect(c.meta.bpm).toBe(100);
    expect(c.notes[3].startMs).toBeCloseTo(4 * 600 + 300);
    expect(c.notes[3].durationMs).toBeCloseTo(3.5 * 600);
    expect(c.measures.map((m) => m.startMs)).toEqual([0, 2400]);
    expect(c.meta.durationMs).toBeCloseTo(4800);
  });

  it('reads chords, backup and forward across voices', () => {
    const c = chartFromMusicXml(
      score({
        P1: [
          attrs(2) +
            n('C', 5, 4) + n('E', 5, 4, { chord: true }) + n('G', 5, 4, { chord: true }) + n('A', 5, 4) +
            backup(8) + forward(2) + n('C', 4, 2, { voice: 2 }) + n('D', 4, 4, { voice: 2 }),
        ],
      }),
    );
    expect(c.notes.map((x) => [x.midi, x.beat])).toEqual([
      [72, 0],
      [76, 0],
      [79, 0],
      [60, 1],
      [62, 2],
      [81, 2],
    ]);
    expect(c.measures[0].durationMs).toBeCloseTo(2400);
  });

  it('merges ties into one note at the tie start, across barlines', () => {
    const c = chartFromMusicXml(
      score({
        P1: [
          attrs(1) + n('E', 4, 2) + n('C', 4, 2, { tie: ['start'] }),
          n('C', 4, 1, { tie: ['stop', 'start'] }) + n('C', 4, 1, { tie: ['stop'] }) + n('C', 4, 2),
        ],
      }),
    );
    expect(c.notes).toHaveLength(3);
    const tied = c.notes.find((x) => x.midi === 60 && x.measure === 0)!;
    expect(tied.beat).toBe(2);
    expect(tied.durationMs).toBeCloseTo(4 * 600);
    const after = c.notes.find((x) => x.midi === 60 && x.measure === 1)!;
    expect(after.beat).toBe(2);
  });

  it('also merges ties written only as <tied> notations', () => {
    const c = chartFromMusicXml(
      score({
        P1: [attrs(1) + n('G', 4, 2, { extra: '<notations><tied type="start"/></notations>' }) + n('G', 4, 2, { extra: '<notations><tied type="stop"/></notations>' })],
      }),
    );
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].durationMs).toBeCloseTo(2400);
  });

  it('skips grace notes (no time) and cue notes (keep time), ignores unpitched', () => {
    const grace = '<note><grace/><pitch><step>B</step><octave>4</octave></pitch><voice>1</voice></note>';
    const cue = '<note><cue/><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>';
    const drum = '<note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>1</duration></note>';
    const c = chartFromMusicXml(score({ P1: [attrs(1) + grace + n('C', 4, 1) + cue + drum + n('D', 4, 1)] }));
    expect(c.notes.map((x) => [x.midi, x.beat])).toEqual([
      [60, 0],
      [62, 3],
    ]);
  });

  it('applies a mid-piece tempo change at its beat', () => {
    const c = chartFromMusicXml(
      score({
        P1: [
          attrs(1) + tempo(60) + n('C', 4, 1) + n('D', 4, 1) + tempo(120) + n('E', 4, 1) + n('F', 4, 1),
          n('G', 4, 4),
        ],
      }),
    );
    const ms = c.notes.map((x) => x.startMs);
    expect(ms).toEqual([0, 1000, 2000, 2500, 3000]);
    expect(c.measures[0].bpm).toBe(60);
    expect(c.measures[1].bpm).toBe(120);
    expect(c.measures[1].startMs).toBeCloseTo(3000);
    expect(c.meta.bpm).toBe(60);
    expect(c.meta.durationMs).toBeCloseTo(5000);
    expect(c.notes[1].durationMs).toBeCloseTo(1000);
  });

  it('uses <metronome> when there is no sound tempo, including dotted beat units', () => {
    const met = '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>';
    const c = chartFromMusicXml(score({ P1: [attrs(1, 6, 8) + met + n('C', 4, 3)] }));
    expect(c.meta.bpm).toBe(90);
    expect(c.measures[0].durationMs).toBeCloseTo((3 * 60000) / 90);
  });

  it('takes a measure-level <sound tempo> and applies the first marking from the start', () => {
    const c = chartFromMusicXml(score({ P1: [attrs(1) + n('C', 4, 4), '<sound tempo="150"/>' + n('D', 4, 4)] }));
    expect(c.measures.map((m) => m.bpm)).toEqual([150, 150]);
    expect(c.notes[1].startMs).toBeCloseTo(1600);
  });

  it('measures a pickup by its content', () => {
    const xml = score({ P1: [attrs(1, 3, 4) + n('D', 4, 1), n('G', 4, 3), n('A', 4, 2)] }).replace('<measure number="1">', '<measure number="0" implicit="yes">');
    const c = chartFromMusicXml(xml);
    expect(c.measures.map((m) => m.durationMs)).toEqual([600, 1800, 1200]);
    expect(c.measures.map((m) => m.timeSignature)).toEqual([[3, 4], [3, 4], [3, 4]]);
    expect(c.notes[1]).toMatchObject({ measure: 1, beat: 0, startMs: 600 });
    expect(c.meta.durationMs).toBe(3600);
  });

  it('uses the longest part for the measure length', () => {
    const c = chartFromMusicXml(
      score({ P1: [attrs(1) + n('C', 5, 1)], P2: [attrs(1) + n('C', 3, 4)] }, `<score-part id="P1"><part-name>A</part-name></score-part><score-part id="P2"><part-name>B</part-name></score-part>`),
    );
    expect(c.measures[0].durationMs).toBe(2400);
  });

  it('takes velocity from <sound dynamics>', () => {
    const dyn = '<direction><direction-type><dynamics><p/></dynamics></direction-type><sound dynamics="54.44"/></direction>';
    const c = chartFromMusicXml(score({ P1: [attrs(1) + n('C', 4, 2) + dyn + n('D', 4, 2)] }));
    expect(c.notes.map((x) => x.velocity)).toEqual([80, 49]);
  });
});

describe('chartFromMusicXml: hands and parts', () => {
  it('maps a grand staff: staff 1 → R, staff 2 → L', () => {
    const c = chartFromMusicXml(
      score({ P1: [attrs(1, 4, 4, '<staves>2</staves>') + n('C', 3, 4, { staff: 1 }) + backup(4) + n('C', 5, 4, { staff: 2, voice: 5 })] }, PIANO),
    );
    // Hand comes from the staff, not from the pitch.
    expect(simple(c)).toEqual([
      [48, 0, 0, 'R'],
      [72, 0, 0, 'L'],
    ]);
    expect(c.notes.map((x) => x.id)).toEqual(['m0-1-0', 'm0-2-0']);
  });

  it('prefers the piano part over a voice part', () => {
    const c = chartFromMusicXml(
      score(
        {
          P1: [attrs(1) + n('A', 4, 4)],
          P2: [attrs(1, 4, 4, '<staves>2</staves>') + n('E', 5, 4, { staff: 1 }) + backup(4) + n('C', 3, 4, { staff: 2 })],
        },
        '<score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Pno.</part-name><score-instrument id="P2-I1"><instrument-name>Grand Piano</instrument-name></score-instrument></score-part>',
      ),
    );
    expect(simple(c)).toEqual([
      [48, 0, 0, 'L'],
      [76, 0, 0, 'R'],
    ]);
  });

  it('matches Korean part names', () => {
    const c = chartFromMusicXml(
      score({ P1: [attrs(1) + n('A', 4, 4)], P2: [attrs(1) + n('C', 5, 4)] }, '<score-part id="P1"><part-name>노래</part-name></score-part><score-part id="P2"><part-name>피아노</part-name></score-part>'),
    );
    expect(c.notes.map((x) => x.midi)).toEqual([72]);
  });

  it('falls back to the first grand-staff part when nothing is named piano', () => {
    const c = chartFromMusicXml(
      score(
        { P1: [attrs(1) + n('A', 4, 4)], P2: [attrs(1, 4, 4, '<staves>2</staves>') + n('B', 4, 4, { staff: 1 }) + backup(4) + n('D', 3, 4, { staff: 2 })] },
        '<score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Harp</part-name></score-part>',
      ),
    );
    expect(simple(c)).toEqual([
      [50, 0, 0, 'L'],
      [71, 0, 0, 'R'],
    ]);
  });

  it('two single-staff parts: first → R, second → L', () => {
    const c = chartFromMusicXml(
      score(
        { P1: [attrs(1) + n('C', 3, 4)], P2: [attrs(1) + n('C', 5, 4)] },
        '<score-part id="P1"><part-name>Violin</part-name></score-part><score-part id="P2"><part-name>Cello</part-name></score-part>',
      ),
    );
    expect(simple(c)).toEqual([
      [48, 0, 0, 'R'],
      [72, 0, 0, 'L'],
    ]);
  });

  it('single staff: splits by pitch but keeps a melody voice on one hand', () => {
    const c = chartFromMusicXml(
      score({
        P1: [
          // voice 1: melody that dips to B3; voice 2: bass line that rises to D4
          attrs(1) + n('E', 4, 1) + n('C', 4, 1) + n('B', 3, 1) + n('C', 4, 1) +
            backup(4) + n('C', 3, 2, { voice: 2 }) + n('G', 3, 1, { voice: 2 }) + n('D', 4, 1, { voice: 2 }),
        ],
      }),
    );
    const hands = Object.fromEntries(c.notes.map((x) => [`${x.midi}@${x.beat}`, x.hand]));
    expect(hands).toEqual({ '64@0': 'R', '60@1': 'R', '59@2': 'R', '60@3': 'R', '48@0': 'L', '55@2': 'L', '62@3': 'L' });
  });

  it('single staff, one voice spanning both registers: chords split at middle C', () => {
    const c = chartFromMusicXml(
      score({ P1: [attrs(1) + n('C', 3, 1) + n('E', 4, 1, { chord: true }) + n('D', 4, 1) + n('A', 2, 1) + n('G', 3, 1) + n('C', 5, 1, { chord: true })] }),
    );
    expect(c.notes.map((x) => `${x.midi}${x.hand}`)).toEqual(['48L', '64R', '62R', '45L', '55L', '72R']);
  });

  it('reads key, title and composer', () => {
    const head =
      '<work><work-title>Sonatine</work-title></work><identification><creator type="composer">M. Clementi</creator><creator type="lyricist">x</creator></identification>';
    const c = chartFromMusicXml(score({ P1: [attrs(1).replace('<fifths>0</fifths>', '<fifths>1</fifths><mode>major</mode>') + n('G', 4, 4)] }, undefined, head));
    expect(c.meta).toMatchObject({ title: 'Sonatine', composer: 'M. Clementi', key: 'G major', source: { kind: 'musicxml' } });
    const keys = [
      [1, 'minor', 'E minor'],
      [-3, 'minor', 'C minor'],
      [-1, 'major', 'F major'],
      [6, 'major', 'F# major'],
      [-6, 'major', 'Gb major'],
      [0, 'dorian', 'D dorian'],
    ] as const;
    for (const [f, m, name] of keys) {
      const k = chartFromMusicXml(score({ P1: [attrs(1).replace('<fifths>0</fifths>', `<fifths>${f}</fifths><mode>${m}</mode>`) + n('C', 4, 4)] }));
      expect(k.meta.key).toBe(name);
    }
  });

  it('title falls back to movement-title, credit words, opts.title, then file name', () => {
    const body = { P1: [attrs(1) + n('C', 4, 4)] };
    expect(chartFromMusicXml(score(body, undefined, '<movement-title>Mvt</movement-title>')).meta.title).toBe('Mvt');
    expect(
      chartFromMusicXml(score(body, undefined, '<credit page="1"><credit-type>title</credit-type><credit-words>Credit Title</credit-words></credit>')).meta.title,
    ).toBe('Credit Title');
    expect(chartFromMusicXml(score(body), { title: 'Given' }).meta.title).toBe('Given');
    const f = chartFromMusicXml(score(body), { fileName: 'my song.musicxml', id: 'x1' });
    expect(f.meta).toMatchObject({ title: 'my song', id: 'x1', source: { kind: 'musicxml', fileName: 'my song.musicxml' } });
  });

  it('gives deterministic ids and keeps the source xml', () => {
    const xml = score({ P1: [attrs(1) + n('C', 4, 1) + n('E', 4, 1, { chord: true }) + n('D', 4, 3), n('C', 4, 4)] });
    const a = chartFromMusicXml(xml);
    const b = chartFromMusicXml(xml);
    expect(a.meta.id).toBe(b.meta.id);
    expect(a.notes.map((x) => x.id)).toEqual(['m0-1-0', 'm0-1-1', 'm0-1-2', 'm1-1-0']);
    expect(a.musicXml).toBe(xml);
  });

  it('converts score-timewise', () => {
    const xml =
      '<score-timewise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>' +
      `<measure number="1"><part id="P1">${attrs(1)}${n('C', 4, 4)}</part></measure>` +
      `<measure number="2"><part id="P1">${n('D', 4, 4)}</part></measure></score-timewise>`;
    const c = chartFromMusicXml(xml);
    expect(simple(c)).toEqual([
      [60, 0, 0, 'R'],
      [62, 1, 0, 'R'],
    ]);
  });

  it('throws ImportError with a Korean message on bad input', () => {
    expect(() => chartFromMusicXml('not xml at all <<<')).toThrow(ImportError);
    expect(() => chartFromMusicXml('<html><body/></html>')).toThrow(/MusicXML/);
    expect(() => chartFromMusicXml(score({ P1: [attrs(1) + rest(4)] }))).toThrow(/음표/);
  });
});

describe('built-in songs', () => {
  const expected: Record<string, { measures: number; notes: number; r: number; l: number }> = {
    'ode-to-joy': { measures: 8, notes: 39, r: 30, l: 9 },
    twinkle: { measures: 12, notes: 64, r: 42, l: 22 },
    'minuet-in-g': { measures: 16, notes: 101, r: 64, l: 37 },
    'fur-elise': { measures: 9, notes: 53, r: 35, l: 18 },
  };

  it.each(BUILTIN_SONGS.map((s) => [s.id, s] as const))('%s loads and matches its summary', (id, song) => {
    const c = song.load();
    const e = expected[id];
    expect(c.meta).toMatchObject({ id, title: song.title, composer: song.composer, bpm: song.bpm, source: { kind: 'builtin' } });
    expect(c.measures).toHaveLength(song.measures);
    expect(c.measures).toHaveLength(e.measures);
    expect(`${c.meta.timeSignature[0]}/${c.meta.timeSignature[1]}`).toBe(song.timeSignature);
    expect(song.level).toBeGreaterThanOrEqual(1);
    expect(song.level).toBeLessThanOrEqual(10);
    expect(c.notes).toHaveLength(e.notes);
    expect(c.notes.filter((x) => x.hand === 'R')).toHaveLength(e.r);
    expect(c.notes.filter((x) => x.hand === 'L')).toHaveLength(e.l);
    expect(new Set(c.notes.map((x) => x.id)).size).toBe(c.notes.length);
    for (const x of c.notes) {
      expect(x.midi).toBeGreaterThanOrEqual(36);
      expect(x.midi).toBeLessThanOrEqual(84);
      expect(x.startMs).toBeGreaterThanOrEqual(c.measures[x.measure].startMs - 1e-6);
      expect(x.startMs).toBeLessThan(c.measures[x.measure].startMs + c.measures[x.measure].durationMs);
    }
    expect(c.meta.durationMs).toBeCloseTo(c.measures.at(-1)!.startMs + c.measures.at(-1)!.durationMs);
    expect(c.musicXml).toContain('<work-title>');
    // The generated sheet for this chart parses back to the same notes.
    const back = chartFromMusicXml(chartToMusicXml(c));
    const key = (ch: Chart) => ch.notes.map((x) => `${x.measure}|${x.beat}|${x.midi}|${x.hand}`).sort();
    expect(key(back)).toEqual(key(c));
    expect(back.measures.map((m) => Math.round(m.durationMs))).toEqual(c.measures.map((m) => Math.round(m.durationMs)));
  });

  it('Ode to Joy is exactly the mockup data', () => {
    const brief: [number, number, number, string][] = [
      [64, 0, 1, 'R'], [64, 1, 1, 'R'], [65, 2, 1, 'R'], [67, 3, 1, 'R'],
      [67, 4, 1, 'R'], [65, 5, 1, 'R'], [64, 6, 1, 'R'], [62, 7, 1, 'R'],
      [60, 8, 1, 'R'], [60, 9, 1, 'R'], [62, 10, 1, 'R'], [64, 11, 1, 'R'],
      [64, 12, 1.5, 'R'], [62, 13.5, 0.5, 'R'], [62, 14, 2, 'R'],
      [64, 16, 1, 'R'], [64, 17, 1, 'R'], [65, 18, 1, 'R'], [67, 19, 1, 'R'],
      [67, 20, 1, 'R'], [65, 21, 1, 'R'], [64, 22, 1, 'R'], [62, 23, 1, 'R'],
      [60, 24, 1, 'R'], [60, 25, 1, 'R'], [62, 26, 1, 'R'], [64, 27, 1, 'R'],
      [62, 28, 1.5, 'R'], [60, 29.5, 0.5, 'R'], [60, 30, 2, 'R'],
      [48, 0, 4, 'L'], [55, 4, 4, 'L'], [48, 8, 4, 'L'], [55, 12, 4, 'L'],
      [48, 16, 4, 'L'], [55, 20, 4, 'L'], [48, 24, 4, 'L'], [55, 28, 2, 'L'], [48, 30, 2, 'L'],
    ];
    const c = BUILTIN_SONGS.find((s) => s.id === 'ode-to-joy')!.load();
    const got = c.notes.map((x) => [x.midi, +(x.startMs / 600).toFixed(6), +(x.durationMs / 600).toFixed(6), x.hand]);
    const sort = (a: unknown[][]) => a.map((x) => JSON.stringify(x)).sort();
    expect(sort(got)).toEqual(sort(brief));
    expect(c.meta.durationMs).toBe(32 * 600);
    expect(c.meta.key).toBe('C major');
  });

  it('Für Elise starts with a one-eighth pickup at quarter = 72', () => {
    const c = BUILTIN_SONGS.find((s) => s.id === 'fur-elise')!.load();
    expect(c.meta.key).toBe('A minor');
    expect(c.measures[0].durationMs).toBeCloseTo(0.5 * (60000 / 72));
    expect(c.measures[1].durationMs).toBeCloseTo(1.5 * (60000 / 72));
    expect(c.notes.slice(0, 2).map((x) => x.midi)).toEqual([76, 75]);
    expect(c.notes.filter((x) => x.measure === 2).map((x) => `${x.midi}${x.hand}@${x.beat}`)).toEqual([
      '45L@0', '69R@0', '52L@0.25', '57L@0.5', '60R@0.75', '64R@1', '69R@1.25',
    ]);
  });

  it('Minuet in G is in G major, 3/4', () => {
    const c = BUILTIN_SONGS.find((s) => s.id === 'minuet-in-g')!.load();
    expect(c.meta.key).toBe('G major');
    expect(c.measures.every((m) => m.timeSignature.join('/') === '3/4')).toBe(true);
    expect(c.measures[0].durationMs).toBeCloseTo((3 * 60000) / 110);
    expect(c.notes.filter((x) => x.measure === 0 && x.hand === 'R').map((x) => x.midi)).toEqual([74, 67, 69, 71, 72]);
  });
});

describe('importFile', () => {
  const xml = score({ P1: [attrs(1) + n('C', 4, 2) + n('G', 4, 2)] }, PIANO, '<work><work-title>From File</work-title></work>');

  it('reads a .musicxml File', async () => {
    const c = await importFile(new File([xml], 'song.musicxml', { type: 'application/vnd.recordare.musicxml+xml' }));
    expect(c.meta).toMatchObject({ title: 'From File', source: { kind: 'musicxml', fileName: 'song.musicxml' } });
    expect(c.notes.map((x) => x.midi)).toEqual([60, 67]);
  });

  it('reads a compressed .mxl using META-INF/container.xml', async () => {
    const container =
      '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="scores/main.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
    const zip = zipSync({
      mimetype: strToU8('application/vnd.recordare.musicxml'),
      'META-INF/container.xml': strToU8(container),
      'scores/decoy.xml': strToU8('<nothing/>'),
      'scores/main.musicxml': strToU8(xml),
    });
    const c = await importFile(new File([zip], 'song.mxl'));
    expect(c.meta.title).toBe('From File');
    expect(c.notes).toHaveLength(2);
  });

  it('sniffs the content when the extension is wrong or missing', async () => {
    const c = await importFile(new File([xml], 'download.bin'));
    expect(c.notes).toHaveLength(2);
  });

  it('rejects unsupported and broken files with Korean messages', async () => {
    await expect(importFile(new File(['%PDF-1.4'], 'score.pdf'))).rejects.toThrow(/PDF/);
    await expect(importFile(new File(['hello'], 'notes.txt'))).rejects.toThrow(ImportError);
    await expect(importFile(new File([], 'empty.mid'))).rejects.toThrow(/빈 파일/);
    await expect(importFile(new File(['PK\u0003\u0004garbage'], 'broken.mxl'))).rejects.toThrow(/mxl/);
  });
});
