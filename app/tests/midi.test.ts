import { describe, expect, it, vi } from 'vitest';
import { MidiInput, eventTime, parseMidiMessage, statusHelp } from '../src/input/midi';

/** Minimal stand-in for a browser MIDIAccess with hot-pluggable inputs. */
function fakeAccess() {
  const inputs = new Map<string, { id: string; name: string; manufacturer: string; state: string; onmidimessage: ((e: unknown) => void) | null }>();
  const access = { inputs, outputs: new Map(), onstatechange: null as null | (() => void), sysexEnabled: false };
  return {
    access,
    plug(id: string, name: string) {
      inputs.set(id, { id, name, manufacturer: 'Roland', state: 'connected', onmidimessage: null });
      access.onstatechange?.();
    },
    unplug(id: string) {
      inputs.get(id)!.state = 'disconnected';
      access.onstatechange?.();
    },
    send(id: string, data: number[], timeStamp = performance.now()) {
      inputs.get(id)!.onmidimessage?.({ data: Uint8Array.from(data), timeStamp });
    },
  };
}

describe('parseMidiMessage', () => {
  it('reads note on/off, running-status note off and sustain pedal', () => {
    expect(parseMidiMessage([0x90, 60, 100], 1, 'd')).toMatchObject({ type: 'on', midi: 60, channel: 0 });
    expect(parseMidiMessage([0x93, 60, 0], 1, 'd')).toMatchObject({ type: 'off', channel: 3 });
    expect(parseMidiMessage([0x80, 60, 64], 1, 'd')).toMatchObject({ type: 'off' });
    expect(parseMidiMessage([0xb0, 64, 127], 1, 'd')).toMatchObject({ type: 'pedal', down: true });
    expect(parseMidiMessage([0xb0, 7, 100], 1, 'd')).toBeNull(); // volume CC ignored
    expect(parseMidiMessage([0xfe], 1, 'd')).toBeNull(); // active sensing
  });

  it('falls back to now for implausible timestamps', () => {
    expect(eventTime(0, 500)).toBe(500);
    expect(eventTime(480, 500)).toBe(480);
    expect(eventTime(10, 5000)).toBe(5000);
  });
});

describe('MidiInput', () => {
  it('reports unsupported browsers instead of throwing', async () => {
    const m = new MidiInput({} as Navigator);
    expect((await m.connect()).kind).toBe('unsupported');
    expect(statusHelp(m.status, 0)).toContain('Chrome');
  });

  it('reports a denied permission', async () => {
    const nav = { requestMIDIAccess: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) } as unknown as Navigator;
    const m = new MidiInput(nav);
    const s = await m.connect();
    expect(s.kind).toBe('denied');
  });

  it('lists devices, follows hot-plugging and forwards notes with their timestamps', async () => {
    const f = fakeAccess();
    f.plug('in-1', 'Roland FP-30X');
    const m = new MidiInput({ requestMIDIAccess: () => Promise.resolve(f.access) } as unknown as Navigator);
    expect((await m.connect()).kind).toBe('ready');
    expect(m.primaryName).toBe('Roland FP-30X');

    const notes: unknown[] = [];
    m.onNote((e) => notes.push(e));
    const t = performance.now();
    f.send('in-1', [0x90, 64, 90], t);
    expect(notes[0]).toMatchObject({ type: 'on', midi: 64, deviceId: 'in-1', time: t });
    expect(m.held.has(64)).toBe(true);

    f.plug('in-2', 'USB MIDI Keyboard');
    expect(m.devices).toHaveLength(2);
  });

  it('releases held notes when the keyboard is unplugged mid-note', async () => {
    const f = fakeAccess();
    f.plug('in-1', 'Yamaha P-125');
    const m = new MidiInput({ requestMIDIAccess: () => Promise.resolve(f.access) } as unknown as Navigator);
    await m.connect();
    const fn = vi.fn();
    m.onNote(fn);
    f.send('in-1', [0x90, 60, 80]);
    f.unplug('in-1');
    expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'off', midi: 60 }));
    expect(m.held.size).toBe(0);
    expect(m.primaryName).toBeNull();
  });

  it('only listens to selected devices', async () => {
    const f = fakeAccess();
    f.plug('a', 'Piano');
    f.plug('b', 'Pad controller');
    const m = new MidiInput({ requestMIDIAccess: () => Promise.resolve(f.access) } as unknown as Navigator);
    await m.connect();
    m.setSelected(['a']);
    const fn = vi.fn();
    m.onNote(fn);
    f.send('b', [0x90, 36, 100]);
    expect(fn).not.toHaveBeenCalled();
    f.send('a', [0x90, 60, 100]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
