/**
 * One stream of note events from every input: a MIDI keyboard, the computer keyboard
 * and the on-screen keys. The game listens here and never cares where a note came from.
 */
import { MidiInput, eventTime } from './midi';

export type InputSource = 'midi' | 'pc' | 'pointer';

export interface NoteInput {
  type: 'on' | 'off';
  midi: number;
  velocity: number;
  time: number;
  source: InputSource;
}

/** Computer keyboard layout from the mockups: home row = white keys from C4, Z row = C3 octave. */
export const PC_KEYS: Record<string, number> = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65, KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69,
  KeyU: 70, KeyJ: 71, KeyK: 72, KeyO: 73, KeyL: 74, KeyP: 75, Semicolon: 76,
  KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57, KeyM: 59,
};

export const PC_LABEL: Record<number, string> = Object.fromEntries(
  Object.entries(PC_KEYS).map(([code, m]) => [m, code === 'Semicolon' ? ';' : code.slice(3)]),
);

type Listener = (e: NoteInput) => void;

export class InputHub {
  readonly midi: MidiInput;
  private listeners = new Set<Listener>();
  private pcDown = new Set<string>();
  private detach: (() => void)[] = [];

  constructor(midi = new MidiInput()) {
    this.midi = midi;
    this.detach.push(
      midi.onNote((e) => this.emit({ type: e.type, midi: e.midi, velocity: e.velocity, time: e.time, source: 'midi' })),
    );
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Listen to the computer keyboard. `enabled` lets the app ignore keys while a text field has focus. */
  attachKeyboard(target: Window = window, enabled: () => boolean = () => true): void {
    const down = (e: KeyboardEvent) => {
      const midi = PC_KEYS[e.code];
      if (midi === undefined || e.ctrlKey || e.metaKey || e.altKey || !enabled()) return;
      const el = e.target as HTMLElement | null;
      if (el && el.closest?.('input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,select')) return;
      e.preventDefault();
      if (e.repeat || this.pcDown.has(e.code)) return;
      this.pcDown.add(e.code);
      this.emit({ type: 'on', midi, velocity: 0.8, time: eventTime(e.timeStamp), source: 'pc' });
    };
    const up = (e: KeyboardEvent) => {
      if (!this.pcDown.delete(e.code)) return;
      this.emit({ type: 'off', midi: PC_KEYS[e.code], velocity: 0, time: eventTime(e.timeStamp), source: 'pc' });
    };
    const blur = () => {
      for (const code of this.pcDown) this.emit({ type: 'off', midi: PC_KEYS[code], velocity: 0, time: performance.now(), source: 'pc' });
      this.pcDown.clear();
    };
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('blur', blur);
    this.detach.push(() => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
    });
  }

  /** On-screen keys call this. */
  pointer(type: 'on' | 'off', midi: number, time = performance.now()): void {
    this.emit({ type, midi, velocity: type === 'on' ? 0.75 : 0, time: eventTime(time), source: 'pointer' });
  }

  dispose(): void {
    this.detach.forEach((f) => f());
    this.listeners.clear();
  }

  private emit(e: NoteInput): void {
    this.listeners.forEach((f) => f(e));
  }
}
