/** Player settings shared by the play screen, device screen and home shortcuts. */
import type { HandMode } from '../core/engine';
import { Emitter, load, save } from './store';

export type ViewMode = 'sheet' | 'both' | 'hw';
/** In-play HUD: 집중 (only what is needed) or 상세 (side stats and meters). */
export type HudMode = 'focus' | 'detail';

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
  /** 건반을 누르면 시작: a MIDI key press on the ready screen starts the run. */
  keyStart: boolean;
  hud: HudMode;
  /** 원곡 소리: play the chart's attached recording in sync with the run. */
  backing: boolean;
  /** 0–1 volume of the backing track. */
  backingGain: number;
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
  keyStart: true,
  hud: 'focus',
  backing: true,
  backingGain: 0.8,
  songId: null,
};

function sanitize(s: Partial<Settings>): Settings {
  const v: Settings = { ...DEFAULTS, ...s, loop: { ...DEFAULTS.loop, ...(s.loop ?? {}) } };
  if (!['sheet', 'both', 'hw'].includes(v.view)) v.view = 'both';
  if (![0.5, 0.75, 1].includes(v.rate)) v.rate = 1;
  if (!['R', 'L', 'B'].includes(v.hands)) v.hands = 'R';
  if (v.hud !== 'detail') v.hud = 'focus';
  v.keyStart = v.keyStart !== false;
  v.offset = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(Number(v.offset) || 0)));
  v.backing = v.backing !== false;
  v.backingGain = Number.isFinite(Number(v.backingGain)) ? Math.max(0, Math.min(1, Number(v.backingGain))) : 0.8;
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
