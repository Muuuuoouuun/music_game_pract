/**
 * Small piano-ish synth (triangle + octave sine through a closing low-pass) and the
 * metronome click, ported from the mockup. The AudioContext starts suspended until the
 * first user gesture; `unlock()` is wired to pointerdown/keydown in main.ts.
 */
interface Voice {
  g: GainNode;
  o1: OscillatorNode;
  o2: OscillatorNode;
}

export class Synth {
  ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private voices = new Map<number, Voice>();
  /** Notes released while the sustain pedal was down; they ring until the pedal lifts. */
  private sustained = new Set<number>();
  private pedal = false;

  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        const comp = this.ctx.createDynamicsCompressor();
        this.out = this.ctx.createGain();
        this.out.gain.value = 0.55;
        this.out.connect(comp);
        comp.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      /* audio is optional */
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  noteOn(midi: number, velocity = 0.8): void {
    if (!this.ready || !this.ctx || !this.out) return;
    this.kill(midi, true);
    this.sustained.delete(midi);
    const c = this.ctx;
    const t = c.currentTime;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = c.createGain();
    const lp = c.createBiquadFilter();
    const o1 = c.createOscillator();
    const o2 = c.createOscillator();
    const g2 = c.createGain();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(12000, f * 8), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, f * 2.5), t + 0.8);
    o1.type = 'triangle';
    o1.frequency.value = f;
    o2.type = 'sine';
    o2.frequency.value = f * 2;
    g2.gain.value = 0.2;
    o1.connect(lp);
    o2.connect(g2);
    g2.connect(lp);
    lp.connect(g);
    g.connect(this.out);
    const peak = 0.26 * Math.max(0.05, Math.min(1, velocity)) + 0.06;
    const ring = this.pedal ? 6 : 2.4;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ring);
    o1.start(t);
    o2.start(t);
    o1.stop(t + ring + 0.1);
    o2.stop(t + ring + 0.1);
    this.voices.set(midi, { g, o1, o2 });
  }

  noteOff(midi: number): void {
    if (this.pedal && this.voices.has(midi)) {
      this.sustained.add(midi);
      return;
    }
    this.kill(midi, false);
  }

  setPedal(down: boolean): void {
    this.pedal = down;
    if (down) return;
    for (const m of this.sustained) this.kill(m, false);
    this.sustained.clear();
  }

  allOff(): void {
    for (const m of [...this.voices.keys()]) this.kill(m, true);
    this.sustained.clear();
  }

  /** Metronome click; `when` is an AudioContext time for sample-accurate scheduling. */
  tick(accent: boolean, when?: number): void {
    if (!this.ready || !this.ctx || !this.out) return;
    const c = this.ctx;
    const t = Math.max(c.currentTime, when ?? c.currentTime);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.14 : 0.09, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.08);
  }

  /** performance.now() time at which AudioContext time `ctxTime` is rendered. */
  perfTimeOf(ctxTime: number): number {
    const c = this.ctx;
    if (!c) return performance.now();
    const ts = typeof c.getOutputTimestamp === 'function' ? c.getOutputTimestamp() : null;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
    }
    return performance.now() + (ctxTime - c.currentTime) * 1000;
  }

  private kill(midi: number, fast: boolean): void {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;
    this.voices.delete(midi);
    const t = this.ctx.currentTime;
    try {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setValueAtTime(Math.max(v.g.gain.value, 0.0001), t);
      v.g.gain.exponentialRampToValueAtTime(0.0001, t + (fast ? 0.03 : 0.22));
      v.o1.stop(t + 0.3);
      v.o2.stop(t + 0.3);
    } catch {
      /* already stopped */
    }
  }
}

export const synth = new Synth();
