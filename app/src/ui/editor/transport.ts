/**
 * Editor playback: the synth plays notes from the cursor at the practice rate and, when
 * a recording is attached, the AudioTrack runs alongside at the same rate. While the
 * recording plays its clock is the master (chart ms = audio ms − offset); otherwise
 * performance.now() drives the position.
 */
import { synth } from '../../audio/synth';
import type { AudioTrack } from '../../audio/track';
import type { Chart } from '../../core/chart';

export class Transport {
  playing = false;
  rate = 1;
  noteSound = true;
  gain = 0.8;
  track: AudioTrack | null = null;
  /** Audio position that plays at chart time 0. */
  audioOffsetMs = 0;
  private startPerf = 0;
  private startMs = 0;
  private lastMs = 0;
  private active = new Map<string, { midi: number; endMs: number }>();

  play(fromMs: number, rate: number): void {
    this.stop();
    synth.unlock();
    this.rate = rate;
    this.startMs = fromMs;
    this.lastMs = fromMs - 1e-6;
    this.startPerf = performance.now();
    this.playing = true;
    if (this.track) {
      const audioMs = fromMs + this.audioOffsetMs;
      if (audioMs < this.track.durationMs) this.track.play(audioMs, rate, this.gain);
    }
  }

  stop(): void {
    this.track?.stop();
    for (const a of this.active.values()) synth.noteOff(a.midi);
    this.active.clear();
    this.playing = false;
  }

  /** Chart position in ms. */
  position(now = performance.now()): number {
    if (this.track?.playing) {
      const p = this.track.position();
      if (p !== null) return p - this.audioOffsetMs;
    }
    return this.startMs + (now - this.startPerf) * this.rate;
  }

  /** Fires and releases notes up to `now`. Returns the position, or null once past the chart's end. */
  frame(now: number, chart: Chart): number | null {
    if (!this.playing) return null;
    const pos = this.position(now);
    for (const n of chart.notes) {
      if (n.startMs > pos) break;
      if (n.startMs > this.lastMs && !this.active.has(n.id)) {
        if (this.noteSound) synth.noteOn(n.midi, n.velocity / 127);
        this.active.set(n.id, { midi: n.midi, endMs: n.startMs + n.durationMs });
      }
    }
    for (const [id, a] of this.active) {
      if (a.endMs <= pos) {
        synth.noteOff(a.midi);
        this.active.delete(id);
      }
    }
    this.lastMs = pos;
    const audioEnd = this.track ? this.track.durationMs - this.audioOffsetMs : 0;
    if (pos > Math.max(chart.meta.durationMs, audioEnd) + 400) {
      this.stop();
      return null;
    }
    return pos;
  }

  setGain(gain: number): void {
    this.gain = gain;
    this.track?.setGain(gain);
  }
}
