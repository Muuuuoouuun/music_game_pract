/**
 * Web MIDI input: finds connected keyboards, follows hot-plugging, and turns raw
 * messages into note events stamped on the performance.now() clock.
 *
 * Support (2026): Chrome / Edge / Opera and Chromium-based desktop wrappers (Electron)
 * work; Firefox 108+ asks for a site permission; Safari and every iOS browser have no
 * Web MIDI at all. The status field tells the UI which of these cases it is in so it
 * can explain the fix instead of failing silently.
 */

export type MidiStatus =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'unsupported'; reason: 'no-api' | 'insecure-context' }
  | { kind: 'denied'; message: string }
  | { kind: 'ready' };

export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
  connected: boolean;
}

export interface MidiNoteEvent {
  type: 'on' | 'off';
  midi: number;
  /** 0–1 (note-off reports 0). */
  velocity: number;
  channel: number;
  /** performance.now() time of the event. */
  time: number;
  deviceId: string;
}

export interface MidiPedalEvent {
  type: 'pedal';
  /** true when the sustain pedal (CC64) is held. */
  down: boolean;
  time: number;
  deviceId: string;
}

type Listener<T> = (e: T) => void;

/** Parse one MIDI message. Exported for tests. */
export function parseMidiMessage(
  data: ArrayLike<number>,
  time: number,
  deviceId: string,
): MidiNoteEvent | MidiPedalEvent | null {
  if (!data || data.length < 2) return null;
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;
  if (status === 0x90 && d2 > 0) return { type: 'on', midi: d1, velocity: d2 / 127, channel, time, deviceId };
  if (status === 0x80 || (status === 0x90 && d2 === 0)) return { type: 'off', midi: d1, velocity: 0, channel, time, deviceId };
  if (status === 0xb0 && d1 === 64) return { type: 'pedal', down: d2 >= 64, time, deviceId };
  return null;
}

/**
 * Event timestamps from Web MIDI share the performance.now() clock. Some drivers
 * report 0 or a stale value; fall back to "now" when the stamp is implausible.
 */
export function eventTime(stamp: number | undefined, now = performance.now()): number {
  return stamp && stamp > 0 && stamp <= now + 5 && stamp > now - 1000 ? stamp : now;
}

export class MidiInput {
  status: MidiStatus = { kind: 'idle' };
  devices: MidiDevice[] = [];
  /** Device ids to listen to; empty = all connected inputs. */
  selected = new Set<string>();
  /** Notes currently held down, keyed by midi number. */
  readonly held = new Map<number, MidiNoteEvent>();
  pedal = false;

  private access: MIDIAccess | null = null;
  private noteListeners = new Set<Listener<MidiNoteEvent>>();
  private pedalListeners = new Set<Listener<MidiPedalEvent>>();
  private changeListeners = new Set<Listener<MidiInput>>();
  private nav: Navigator;

  constructor(nav: Navigator = navigator) {
    this.nav = nav;
  }

  get supported(): boolean {
    return typeof (this.nav as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function';
  }

  /** Ask the browser for MIDI access. Safe to call more than once. */
  async connect(): Promise<MidiStatus> {
    if (this.access) return this.status;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return this.setStatus({ kind: 'unsupported', reason: 'insecure-context' });
    }
    if (!this.supported) return this.setStatus({ kind: 'unsupported', reason: 'no-api' });
    this.setStatus({ kind: 'requesting' });
    try {
      this.access = await this.nav.requestMIDIAccess({ sysex: false });
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return this.setStatus({ kind: 'denied', message });
    }
    this.access.onstatechange = () => this.bindInputs();
    this.bindInputs();
    return this.setStatus({ kind: 'ready' });
  }

  onNote(fn: Listener<MidiNoteEvent>): () => void {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }
  onPedal(fn: Listener<MidiPedalEvent>): () => void {
    this.pedalListeners.add(fn);
    return () => this.pedalListeners.delete(fn);
  }
  /** Fires on status changes and when devices are plugged in or out. */
  onChange(fn: Listener<MidiInput>): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** First connected device name, for the status chip. */
  get primaryName(): string | null {
    return this.devices.find((d) => d.connected && this.isListening(d.id))?.name ?? null;
  }

  isListening(id: string): boolean {
    return this.selected.size === 0 || this.selected.has(id);
  }

  setSelected(ids: string[]): void {
    this.selected = new Set(ids);
    this.releaseAll();
    this.emitChange();
  }

  /** Inject a message as if it came from a device (used by tests and the on-screen test pad). */
  receive(data: ArrayLike<number>, time: number, deviceId = 'virtual'): void {
    const ev = parseMidiMessage(data, eventTime(time), deviceId);
    if (!ev) return;
    if (ev.type === 'pedal') {
      this.pedal = ev.down;
      this.pedalListeners.forEach((f) => f(ev));
      return;
    }
    if (ev.type === 'on') this.held.set(ev.midi, ev);
    else this.held.delete(ev.midi);
    this.noteListeners.forEach((f) => f(ev));
  }

  private bindInputs(): void {
    if (!this.access) return;
    const seen: MidiDevice[] = [];
    this.access.inputs.forEach((input) => {
      const connected = input.state === 'connected';
      seen.push({ id: input.id, name: input.name || 'MIDI 기기', manufacturer: input.manufacturer || '', connected });
      input.onmidimessage = connected
        ? (e: MIDIMessageEvent) => {
            if (!this.isListening(input.id) || !e.data) return;
            this.receive(e.data, e.timeStamp, input.id);
          }
        : null;
    });
    const lost = this.devices.some((d) => d.connected && !seen.find((s) => s.id === d.id && s.connected));
    this.devices = seen;
    if (lost) this.releaseAll();
    this.emitChange();
  }

  /** A device vanished mid-note: release everything so no key stays stuck. */
  private releaseAll(): void {
    const now = performance.now();
    for (const [midi, ev] of this.held) {
      const off: MidiNoteEvent = { ...ev, type: 'off', velocity: 0, time: now };
      this.held.delete(midi);
      this.noteListeners.forEach((f) => f(off));
    }
    this.pedal = false;
  }

  private setStatus(s: MidiStatus): MidiStatus {
    this.status = s;
    this.emitChange();
    return s;
  }

  private emitChange(): void {
    this.changeListeners.forEach((f) => f(this));
  }
}

/** Korean help text for each status, shown in the device panel. */
export function statusHelp(s: MidiStatus, deviceCount: number): string {
  switch (s.kind) {
    case 'idle':
    case 'requesting':
      return 'MIDI 건반을 찾는 중이에요.';
    case 'unsupported':
      return s.reason === 'insecure-context'
        ? 'MIDI는 https 또는 localhost 주소에서만 쓸 수 있어요.'
        : '이 브라우저는 MIDI를 지원하지 않아요. 컴퓨터의 Chrome이나 Edge에서 열어 주세요. (Safari·아이폰·아이패드는 아직 안 돼요)';
    case 'denied':
      return 'MIDI 사용이 막혔어요. 주소창 왼쪽 사이트 설정에서 "MIDI 기기"를 허용한 뒤 새로고침해 주세요.';
    case 'ready':
      return deviceCount
        ? '건반이 연결됐어요. 아무 건반이나 눌러 신호가 들어오는지 확인해 보세요.'
        : 'MIDI 건반이 안 보여요. USB 케이블을 꽂고 건반 전원을 켜면 바로 나타나요.';
  }
}
