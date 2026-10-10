/** Editor conveniences remembered between sessions (snap, zoom, tool, sound). */
import type { SnapDivision } from '../core/edit';
import { load, save } from './store';

export type EditorTool = 'select' | 'pencil' | 'eraser';

export interface EditorPrefs {
  snap: SnapDivision | 'off';
  pxPerSec: number;
  tool: EditorTool;
  /** Play the synth for notes during editor playback. */
  noteSound: boolean;
  /** Backing-track volume 0–1. */
  audioGain: number;
  rate: number;
}

const DEFAULTS: EditorPrefs = { snap: 16, pxPerSec: 120, tool: 'select', noteSound: true, audioGain: 0.8, rate: 1 };

function sanitize(p: Partial<EditorPrefs>): EditorPrefs {
  const v: EditorPrefs = { ...DEFAULTS, ...p };
  if (![4, 8, 16, '8t', '16t', 'off'].includes(v.snap as string | number)) v.snap = 16;
  if (!['select', 'pencil', 'eraser'].includes(v.tool)) v.tool = 'select';
  v.pxPerSec = Math.max(20, Math.min(400, Number(v.pxPerSec) || 120));
  v.audioGain = Math.max(0, Math.min(1, Number(v.audioGain) || 0));
  if (![0.5, 0.75, 1].includes(v.rate)) v.rate = 1;
  v.noteSound = v.noteSound !== false;
  return v;
}

export const editorPrefs: EditorPrefs = sanitize(load<Partial<EditorPrefs>>('editor', {}));

export function saveEditorPrefs(patch: Partial<EditorPrefs>): void {
  Object.assign(editorPrefs, sanitize({ ...editorPrefs, ...patch }));
  save('editor', editorPrefs);
}
