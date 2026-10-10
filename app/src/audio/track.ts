/**
 * A decoded recording: waveform peaks for display, mono samples for transcription,
 * and synced playback for the editor and the play screen.
 *
 * Positions are milliseconds into the file. Callers convert chart time with
 * `chart.audio.offsetMs` (audioMs = chartMs + offsetMs).
 */

export class AudioTrack {
  readonly buffer: AudioBuffer;
  private ctx: AudioContext;
  private source: AudioBufferSourceNode | null = null;
  private gainNode: GainNode;
  /** ctx.currentTime at which `startedAtMs` was playing, with rate. */
  private startedCtx = 0;
  private startedAtMs = 0;
  private rate = 1;

  private constructor(buffer: AudioBuffer, ctx: AudioContext) {
    this.buffer = buffer;
    this.ctx = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.connect(ctx.destination);
  }

  static async fromBlob(blob: Blob, ctx: AudioContext = sharedContext()): Promise<AudioTrack> {
    const data = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data.slice(0));
    return new AudioTrack(buffer, ctx);
  }

  get durationMs(): number {
    return this.buffer.duration * 1000;
  }

  /** Max |amplitude| per bucket (0–1) for drawing a waveform strip. */
  peaks(buckets: number): Float32Array {
    const out = new Float32Array(buckets);
    const n = this.buffer.length;
    const per = Math.max(1, Math.floor(n / buckets));
    const chans = Array.from({ length: this.buffer.numberOfChannels }, (_, c) => this.buffer.getChannelData(c));
    for (let b = 0; b < buckets; b++) {
      const s0 = b * per;
      const s1 = Math.min(n, s0 + per);
      let m = 0;
      for (const ch of chans) for (let i = s0; i < s1; i++) { const v = Math.abs(ch[i]); if (v > m) m = v; }
      out[b] = m;
    }
    return out;
  }

  /** Mono samples at `sampleRate` (basic-pitch wants 22050 Hz). */
  async mono(sampleRate = 22050): Promise<Float32Array> {
    const length = Math.ceil(this.buffer.duration * sampleRate);
    const off = new OfflineAudioContext(1, length, sampleRate);
    const src = off.createBufferSource();
    src.buffer = this.buffer;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  /** Start so that `audioMs` plays right now; `rate` is the practice tempo multiplier. */
  play(audioMs: number, rate = 1, gain = 1): void {
    this.stop();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    src.connect(this.gainNode);
    this.gainNode.gain.value = gain;
    const offsetSec = Math.max(0, audioMs) / 1000;
    const when = this.ctx.currentTime + Math.max(0, -audioMs) / 1000 / rate;
    src.start(when, Math.min(offsetSec, this.buffer.duration));
    src.onended = () => { if (this.source === src) this.source = null; };
    this.source = src;
    this.startedCtx = when;
    this.startedAtMs = audioMs;
    this.rate = rate;
  }

  stop(): void {
    if (!this.source) return;
    try { this.source.stop(); } catch { /* already stopped */ }
    this.source.disconnect();
    this.source = null;
  }

  get playing(): boolean {
    return this.source !== null;
  }

  /** Current position in ms, or null when stopped. */
  position(): number | null {
    if (!this.source) return null;
    return this.startedAtMs + (this.ctx.currentTime - this.startedCtx) * 1000 * this.rate;
  }

  setGain(gain: number): void {
    this.gainNode.gain.value = gain;
  }

  dispose(): void {
    this.stop();
    this.gainNode.disconnect();
  }
}

let shared: AudioContext | null = null;
/** One AudioContext for every track; created lazily so it can be unlocked by a gesture. */
export function sharedContext(): AudioContext {
  if (!shared) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    shared = new AC();
  }
  return shared;
}
