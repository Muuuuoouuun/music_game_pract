/** Player settings shared by the play screen, device screen and home shortcuts. */
import type { HandMode } from '../core/engine';
import { Emitter, load, save } from './store';

export type ViewMode = 'sheet' | 'both' | 'hw';

export interface Settings {
  view: ViewMode;
  rate: number;
  hands: HandMode;
  wait: boolean;
  /** 0-based inclusive measures. */
  loop: { on: boolean; from: number; to: number };
  metro: boolean;
  /** Input latency in ms, subtracted from every key press. */
  offset: number;
  /** Play the built-in synth for PC keys and on-screen keys. */
  soundKeys: boolean;
  /** Play the built-in synth for MIDI keys (off: the piano makes its own sound). */
  soundMidi: boolean;
  autoplay: boolean;
  songId: string | null;
}

export const OFFSET_MIN = -150;
export const OFFSET_MAX = 300;

const DEFAULTS: Settings = {
  view: 'both',
  rate: 1,
  hands: 'R',
  wait: false,
  loop: { on: false, from: 0, to: 3 },
  metro: true,
  offset: 0,
  soundKeys: true,
  soundMidi: false,
  autoplay: false,
  songId: null,
};

function sanitize(s: Partial<Settings>): Settings {
  const v: Settings = { ...DEFAULTS, ...s, loop: { ...DEFAULTS.loop, ...(s.loop ?? {}) } };
  if (!['sheet', 'both', 'hw'].includes(v.view)) v.view = 'both';
  if (![0.5, 0.75, 1].includes(v.rate)) v.rate = 1;
  if (!['R', 'L', 'B'].includes(v.hands)) v.hands = 'R';
  v.offset = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(Number(v.offset) || 0)));
  v.autoplay = false; // never resume into auto-play
  return v;
}

export const settings: Settings = sanitize(load<Partial<Settings>>('settings', {}));
export const settingsChanged = new Emitter<Settings>();

export function updateSettings(patch: Partial<Settings>): void {
  const autoplay = patch.autoplay ?? settings.autoplay;
  const next = sanitize({ ...settings, ...patch, loop: { ...settings.loop, ...(patch.loop ?? {}) } });
  Object.assign(settings, next, { autoplay });
  save('settings', { ...settings, autoplay: false });
  settingsChanged.emit(settings);
}

export const HANDS_KO: Record<HandMode, string> = { R: '오른손', L: '왼손', B: '양손' };
