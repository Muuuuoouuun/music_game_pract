/**
 * Tempo and downbeat from note onsets (pure, no DOM, no TF).
 *
 *  1. Onset-strength envelope: 10 ms bins, each onset adds its velocity through a small
 *     triangular kernel (±30 ms) so jittery playing still lines up.
 *  2. Autocorrelation over the lags of 40–220 BPM, weighted by a tempo prior that is
 *     flat-ish inside 70–160 BPM and falls off outside. The best peak is refined by
 *     parabolic interpolation, then the double/half ambiguity is settled the way
 *     band2sheet's `fix_tempo_octave` does: a tempo under 70 is doubled, over 160 halved.
 *  3. Beat phase: velocity-weighted circular histogram of onset time mod beat period.
 *  4. Downbeat: of the `beatsPerBar` beat classes, the one whose onsets carry the most
 *     velocity (aligned ones count more); ties go to the earliest resulting offset.
 *  5. A weighted least-squares fit of onset time against beat index tightens BPM and
 *     phase (so 119.6 becomes 120.0 for a steady player).
 *
 * `offsetMs` is the time of the first downbeat at or just before the first onset: an
 * onset up to a quarter beat early still counts as on the downbeat, anything earlier
 * (an anacrusis) stays in front and becomes a pickup measure in `notesToChart`.
 */

export interface Onset {
  /** ms */
  t: number;
  /** 1–127 (or 0–1); defaults to equal weight. */
  v?: number;
}

export interface TempoEstimate {
  bpm: number;
  /** ms of the first downbeat (may be negative when the audio starts mid-bar). */
  offsetMs: number;
  /** 0–1: how clearly the onsets pick one tempo and sit on its grid. */
  confidence: number;
  /** How well onsets sit on the 16th grid of the result (beatGridScore). */
  gridFit: number;
  /** Runner-up tempi with their relative strength, for a "다른 후보" UI. */
  candidates: { bpm: number; score: number }[];
}

export interface TempoOptions {
  minBpm?: number;
  maxBpm?: number;
  /** Preferred range for the double/half decision. */
  preferMin?: number;
  preferMax?: number;
  beatsPerBar?: number;
  /** When set, the tempo is not searched; only phase/downbeat (and the fit) are computed. */
  fixedBpm?: number;
}

const BIN = 10; // ms
const KERNEL = 3; // ±bins

function weightOf(o: Onset): number {
  const v = o.v ?? 80;
  return v > 1 ? v / 127 : Math.max(0.05, v);
}

function envelope(onsets: Onset[], t0: number, n: number): Float64Array {
  const env = new Float64Array(n + KERNEL * 2 + 1);
  for (const o of onsets) {
    const c = Math.round((o.t - t0) / BIN) + KERNEL;
    const w = weightOf(o);
    for (let d = -KERNEL; d <= KERNEL; d++) {
      const i = c + d;
      if (i >= 0 && i < env.length) env[i] += w * (1 - Math.abs(d) / (KERNEL + 1));
    }
  }
  return env;
}

/** Tempo prior: 1 inside the preferred range (slightly favouring its middle), falling outside. */
export function tempoPrior(bpm: number, lo = 70, hi = 160): number {
  const mid = Math.sqrt(lo * hi);
  const tilt = 1 - 0.06 * Math.abs(Math.log2(bpm / mid));
  if (bpm >= lo && bpm <= hi) return tilt;
  const edge = bpm < lo ? lo : hi;
  const oct = Math.abs(Math.log2(bpm / edge));
  return tilt * Math.exp(-(oct * oct) / (2 * 0.3 * 0.3));
}

/**
 * 0–1: velocity-weighted share of onsets that sit on the beat grid (quarter notes and
 * their 16th subdivisions) of `bpm` anchored at `offsetMs`. Tolerance is 6% of a beat,
 * at least 15 ms, as a Gaussian so a slightly late note still counts for most of its weight.
 */
export function beatGridScore(onsets: Onset[], bpm: number, offsetMs: number, subdivisions = 4): number {
  if (!onsets.length || !(bpm > 0)) return 0;
  const P = 60000 / bpm;
  const g = P / subdivisions;
  const sigma = Math.max(15, P * 0.06);
  let num = 0;
  let den = 0;
  for (const o of onsets) {
    const w = weightOf(o);
    const rel = o.t - offsetMs;
    const d = rel - Math.round(rel / g) * g;
    num += w * Math.exp(-(d * d) / (2 * sigma * sigma));
    den += w;
  }
  return den ? num / den : 0;
}

/** Beat phase in [0, P): velocity-weighted circular histogram of t mod P, Gaussian-smoothed. */
function beatPhase(onsets: Onset[], P: number): number {
  const res = Math.max(1, Math.min(4, P / 120)); // ms per histogram cell
  const n = Math.max(8, Math.round(P / res));
  const cell = P / n;
  const hist = new Float64Array(n);
  const sigma = Math.max(12, P * 0.05);
  const reach = Math.ceil((sigma * 3) / cell);
  for (const o of onsets) {
    const w = weightOf(o);
    const x = ((o.t % P) + P) % P;
    const c = Math.round(x / cell);
    for (let d = -reach; d <= reach; d++) {
      const dist = Math.abs(x - (c + d) * cell);
      const dd = Math.min(dist, P - dist);
      hist[(((c + d) % n) + n) % n] += w * Math.exp(-(dd * dd) / (2 * sigma * sigma));
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (hist[i] > hist[best]) best = i;
  // parabolic refinement around the peak
  const a = hist[(best - 1 + n) % n];
  const b = hist[best];
  const c = hist[(best + 1) % n];
  const den = a - 2 * b + c;
  const shift = den ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return ((((best + shift) * cell) % P) + P) % P;
}

/** Weighted least squares of onset time against beat index: refined period and phase. */
function refineGrid(onsets: Onset[], P: number, phase: number): { P: number; phase: number } {
  let sw = 0;
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  for (const o of onsets) {
    const k = Math.round((o.t - phase) / P);
    const d = o.t - (phase + k * P);
    if (Math.abs(d) > P * 0.2) continue;
    const w = weightOf(o);
    sw += w;
    sk += w * k;
    st += w * o.t;
    skk += w * k * k;
    skt += w * k * o.t;
  }
  if (sw <= 0) return { P, phase };
  const var_ = skk / sw - (sk / sw) ** 2;
  if (var_ < 1e-9) return { P, phase };
  let P2 = (skt / sw - (sk / sw) * (st / sw)) / var_;
  P2 = Math.max(P * 0.96, Math.min(P * 1.04, P2));
  const phase2 = st / sw - P2 * (sk / sw);
  return { P: P2, phase: ((phase2 % P2) + P2) % P2 };
}

function downbeat(onsets: Onset[], P: number, phase: number, beatsPerBar: number, firstT: number): number {
  const sigma = Math.max(15, P * 0.06);
  const sums = new Array<number>(beatsPerBar).fill(0);
  for (const o of onsets) {
    const k = Math.round((o.t - phase) / P);
    const d = o.t - (phase + k * P);
    const a = Math.exp(-(d * d) / (2 * sigma * sigma));
    sums[((k % beatsPerBar) + beatsPerBar) % beatsPerBar] += weightOf(o) * a;
  }
  const bar = P * beatsPerBar;
  const minStart = firstT - P * 0.25;
  const options = sums.map((s, b) => {
    // earliest downbeat of class b that is >= minStart
    let off = phase + b * P;
    off += Math.ceil((minStart - off) / bar) * bar;
    return { s, off };
  });
  options.sort((x, y) => y.s - x.s || x.off - y.off);
  return options[0].off;
}

export function estimateTempo(input: Onset[], opts: TempoOptions = {}): TempoEstimate {
  const minBpm = opts.minBpm ?? 40;
  const maxBpm = opts.maxBpm ?? 220;
  const lo = opts.preferMin ?? 70;
  const hi = opts.preferMax ?? 160;
  const bpb = Math.max(1, Math.round(opts.beatsPerBar ?? 4));
  const onsets = input.filter((o) => Number.isFinite(o.t)).sort((a, b) => a.t - b.t);
  const fallback = (bpm: number): TempoEstimate => ({
    bpm,
    offsetMs: onsets.length ? onsets[0].t : 0,
    confidence: 0,
    gridFit: onsets.length ? beatGridScore(onsets, bpm, onsets[0].t) : 0,
    candidates: [],
  });
  if (!onsets.length) return fallback(opts.fixedBpm ?? 120);
  const t0 = onsets[0].t;
  const span = onsets[onsets.length - 1].t - t0;

  let bpm: number;
  let candidates: { bpm: number; score: number }[] = [];
  let prominence = 0;
  if (opts.fixedBpm) {
    bpm = opts.fixedBpm;
    prominence = 1;
  } else {
    const lagMin = Math.max(1, Math.round(60000 / maxBpm / BIN));
    const lagMax = Math.round(60000 / minBpm / BIN);
    const n = Math.ceil(span / BIN) + 1;
    if (onsets.length < 3 || n < lagMin * 2) return fallback(120);
    const env = envelope(onsets, t0, n);
    const N = env.length;
    let ac0 = 0;
    for (let i = 0; i < N; i++) ac0 += env[i] * env[i];
    const usableMax = Math.min(lagMax, Math.floor((N - 1) * 0.75));
    if (usableMax <= lagMin) return fallback(120);
    const ac = new Float64Array(usableMax + 1);
    const score = new Float64Array(usableMax + 1);
    let mean = 0;
    for (let lag = lagMin; lag <= usableMax; lag++) {
      let s = 0;
      for (let i = 0; i + lag < N; i++) s += env[i] * env[i + lag];
      ac[lag] = (s / ac0) * (N / (N - lag));
      mean += ac[lag];
    }
    mean /= usableMax - lagMin + 1;
    // fundamental: the shortest lag that is nearly as strong as the strongest
    let acMax = 0;
    for (let lag = lagMin; lag <= usableMax; lag++) acMax = Math.max(acMax, ac[lag]);
    let L0 = usableMax;
    for (let lag = lagMin; lag <= usableMax; lag++) {
      if (ac[lag] >= acMax * 0.6 && (lag === lagMin || ac[lag] >= ac[lag - 1]) && (lag === usableMax || ac[lag] >= ac[lag + 1])) {
        L0 = lag;
        break;
      }
    }
    for (let lag = lagMin; lag <= usableMax; lag++) {
      const r = lag / L0;
      const k = Math.round(r);
      // isochronous input: a beat that is 3 (or 6) onsets long is less likely than 1, 2 or 4
      const sub = Math.abs(r - k) > 0.15 || k < 1 ? 0.97 : k === 1 || k === 2 ? 1 : k === 4 ? 0.98 : k === 3 || k === 6 ? 0.95 : 0.97;
      score[lag] = ac[lag] * tempoPrior(60000 / (lag * BIN), lo, hi) * sub;
    }
    // local maxima of the score, best first
    const peaks: { lag: number; score: number }[] = [];
    for (let lag = lagMin; lag <= usableMax; lag++) {
      const l = lag > lagMin ? score[lag - 1] : -1;
      const r = lag < usableMax ? score[lag + 1] : -1;
      if (score[lag] >= l && score[lag] >= r && score[lag] > 0) peaks.push({ lag, score: score[lag] });
    }
    if (!peaks.length) return fallback(120);
    peaks.sort((a, b) => b.score - a.score);
    const refineLag = (lag: number) => {
      const a = lag > lagMin ? ac[lag - 1] : ac[lag];
      const b = ac[lag];
      const c = lag < usableMax ? ac[lag + 1] : ac[lag];
      const den = a - 2 * b + c;
      return lag + (den ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
    };
    const top = peaks.slice(0, 6).map((p) => ({ bpm: 60000 / (refineLag(p.lag) * BIN), score: p.score }));
    const best = top[0];
    bpm = best.bpm;
    prominence = mean > 0 ? Math.max(0, Math.min(1, (ac[peaks[0].lag] / mean - 1) / 4)) : 0;
    candidates = top
      .map((c) => ({ bpm: Math.round(c.bpm * 10) / 10, score: Math.round((c.score / best.score) * 1000) / 1000 }))
      .filter((c, i, arr) => arr.findIndex((x) => Math.abs(Math.log2(x.bpm / c.bpm)) < 0.03) === i);
  }
  // double/half ambiguity → preferred range
  while (bpm < lo && bpm * 2 <= maxBpm) bpm *= 2;
  while (bpm > hi && bpm / 2 >= minBpm) bpm /= 2;

  let P = 60000 / bpm;
  let phase = beatPhase(onsets, P);
  if (!opts.fixedBpm) {
    for (let i = 0; i < 3; i++) {
      const r = refineGrid(onsets, P, phase);
      P = r.P;
      phase = r.phase;
    }
    bpm = 60000 / P;
  } else {
    phase = beatPhase(onsets, P);
  }
  const offsetMs = downbeat(onsets, P, phase, bpb, t0);
  if (candidates.length) candidates[0] = { ...candidates[0], bpm: Math.round(bpm * 10) / 10 };
  const gridFit = beatGridScore(onsets, bpm, offsetMs);
  const confidence = Math.max(0, Math.min(1, 0.5 * prominence + 0.5 * gridFit));
  return { bpm: Math.round(bpm * 100) / 100, offsetMs: Math.round(offsetMs * 10) / 10, confidence, gridFit, candidates };
}
