/**
 * In-browser transcription with Spotify basic-pitch (TF.js). Everything heavy is behind
 * a dynamic import so the main bundle never carries TensorFlow; the model files are
 * copied into public/basic-pitch/ by scripts/copy-model.mjs and fetched relative to the
 * page (works under Vite's `base: './'` and a GitHub Pages sub-path).
 *
 * Backend: WebGL when the browser offers it, otherwise the CPU backend (slower but it
 * runs anywhere, headless Chromium included). `backendInUse()` tells which one.
 *
 * `transcribeAudio(track, opts)` → RawNote[] in ms, velocity from the model's amplitude.
 */
import type { GraphModel } from '@tensorflow/tfjs';
import type { AudioTrack } from '../audio/track';
import type { RawNote } from './to-chart';

export type TranscribeStage = 'decode' | 'model' | 'infer' | 'notes';

export interface TranscribeOptions {
  onProgress?(p: number, stage: TranscribeStage): void;
  signal?: AbortSignal;
  /** 0–1, default 0.5 (piano). A melody line likes 0.6–0.7. */
  onsetThreshold?: number;
  /** 0–1, default 0.3. */
  frameThreshold?: number;
  /** Default 58 ms (5 model frames). */
  minNoteMs?: number;
  minFreq?: number | null;
  maxFreq?: number | null;
  /** Semitone-neighbour suppression from the melodia paper; on by default. */
  melodiaTrick?: boolean;
  /** Frames a note may stay below `frameThreshold` before it ends (default 11). */
  energyTolerance?: number;
}

export const PIANO_DEFAULTS = { onsetThreshold: 0.5, frameThreshold: 0.3, minNoteMs: 58, melodiaTrick: true, energyTolerance: 11 } as const;

export class TranscribeError extends Error {
  readonly aborted: boolean;
  constructor(message: string, options?: { cause?: unknown; aborted?: boolean }) {
    super(message, options);
    this.name = 'TranscribeError';
    this.aborted = !!options?.aborted;
  }
}

const MODEL_FPS = Math.floor(22050 / 256); // basic-pitch annotation frames per second

type Tf = typeof import('@tensorflow/tfjs');
type Bp = typeof import('@spotify/basic-pitch');

let libs: Promise<{ tf: Tf; bp: Bp }> | null = null;
let modelPromise: Promise<GraphModel> | null = null;
let backend: string | null = null;

function loadLibs(): Promise<{ tf: Tf; bp: Bp }> {
  libs ??= Promise.all([import('@tensorflow/tfjs'), import('@spotify/basic-pitch')]).then(([tf, bp]) => ({ tf, bp }));
  return libs;
}

/** URL of model.json next to the page, whatever the deploy path is. */
export function modelUrl(): string {
  const base = import.meta.env.BASE_URL || './';
  const rel = (base.endsWith('/') ? base : base + '/') + 'basic-pitch/model.json';
  return new URL(rel, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/').href;
}

/** Backend that TF.js ended up with ('webgl' | 'cpu'), or null before the first load. */
export function backendInUse(): string | null {
  return backend;
}

async function pickBackend(tf: Tf): Promise<string> {
  if (backend) return backend;
  for (const name of ['webgl', 'cpu']) {
    try {
      if (await tf.setBackend(name)) {
        await tf.ready();
        backend = tf.getBackend();
        return backend;
      }
    } catch (e) {
      console.warn(`[transcribe] backend ${name} unavailable`, e);
    }
  }
  await tf.ready();
  backend = tf.getBackend();
  return backend;
}

/**
 * Loads TF.js, picks the backend and fetches the model (once; later calls reuse it).
 * `onProgress` gets the download fraction.
 */
export async function loadModel(onProgress?: (p: number) => void): Promise<{ model: GraphModel; backend: string }> {
  const { tf } = await loadLibs();
  const be = await pickBackend(tf);
  modelPromise ??= tf.loadGraphModel(modelUrl(), { onProgress: (p) => onProgress?.(p) }).catch((e) => {
    modelPromise = null;
    throw new TranscribeError('채보 모델을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', { cause: e });
  });
  const model = await modelPromise;
  onProgress?.(1);
  return { model, backend: be };
}

/** True when the page already paid for TF.js + the model. */
export function modelReady(): boolean {
  return modelPromise !== null;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TranscribeError('변환을 취소했어요.', { aborted: true });
}

/** Core: 22050 Hz mono samples → notes. */
export async function transcribeSamples(mono: Float32Array, opts: TranscribeOptions = {}): Promise<RawNote[]> {
  const progress = (p: number, s: TranscribeStage) => opts.onProgress?.(Math.max(0, Math.min(1, p)), s);
  checkAbort(opts.signal);
  progress(0, 'model');
  const { tf, bp } = await loadLibs();
  const { model } = await loadModel((p) => progress(p, 'model'));
  checkAbort(opts.signal);

  progress(0, 'infer');
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  const pitch = new bp.BasicPitch(Promise.resolve(model));
  // evaluateModel leaks its intermediate tensors; a scope frees them when we are done.
  const engine = tf.engine();
  engine.startScope();
  try {
    await pitch.evaluateModel(
      mono,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (p) => {
        checkAbort(opts.signal);
        progress(p, 'infer');
      },
    );
  } catch (e) {
    if (e instanceof TranscribeError) throw e;
    throw new TranscribeError(
      backend === 'webgl'
        ? '채보 도중 그래픽(WebGL) 처리에 실패했어요. 다른 브라우저에서 다시 시도하거나 파일을 더 짧게 잘라 주세요.'
        : '채보 도중 메모리가 부족했어요. 파일을 더 짧게 잘라서 다시 시도해 주세요.',
      { cause: e },
    );
  } finally {
    engine.endScope();
  }
  checkAbort(opts.signal);

  progress(0, 'notes');
  const minFrames = Math.max(1, Math.round(((opts.minNoteMs ?? PIANO_DEFAULTS.minNoteMs) / 1000) * MODEL_FPS));
  const events = bp.outputToNotesPoly(
    frames,
    onsets,
    opts.onsetThreshold ?? PIANO_DEFAULTS.onsetThreshold,
    opts.frameThreshold ?? PIANO_DEFAULTS.frameThreshold,
    minFrames,
    true,
    opts.maxFreq ?? null,
    opts.minFreq ?? null,
    opts.melodiaTrick ?? PIANO_DEFAULTS.melodiaTrick,
    opts.energyTolerance ?? PIANO_DEFAULTS.energyTolerance,
  );
  const timed = bp.noteFramesToTime(bp.addPitchBendsToNoteEvents(contours, events));
  progress(1, 'notes');
  return timed
    .map((n) => ({
      midi: Math.round(n.pitchMidi),
      startMs: Math.round(n.startTimeSeconds * 1000 * 10) / 10,
      durationMs: Math.round(n.durationSeconds * 1000 * 10) / 10,
      velocity: Math.max(1, Math.min(127, Math.round(n.amplitude * 127))),
    }))
    .sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

/** Decoded recording → notes (resamples to 22050 Hz mono first). */
export async function transcribeAudio(track: AudioTrack, opts: TranscribeOptions = {}): Promise<RawNote[]> {
  checkAbort(opts.signal);
  opts.onProgress?.(0, 'decode');
  let mono: Float32Array;
  try {
    mono = await track.mono(22050);
  } catch (e) {
    throw new TranscribeError('오디오를 22 kHz 모노로 변환하지 못했어요. 파일이 너무 길거나 손상됐을 수 있어요.', { cause: e });
  }
  opts.onProgress?.(1, 'decode');
  return transcribeSamples(mono, opts);
}
