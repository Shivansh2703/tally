// Pure detection logic. No DOM, no Web Audio, no timers, no Date.now() —
// every input arrives as an argument so this is testable without a mic.

// ponytail: rAF polling caps this at ~8 reliable events/sec (frame budget +
// refractory floor). Upgrade path if a faster cadence is ever needed: an
// AudioWorklet running its own FFT off the main thread.

const BANDS = 16;

// 16 log-spaced band energies from linear-magnitude spectrum, L2-normalised.
export function fingerprint(spectrum) {
  const n = spectrum.length;
  const bands = new Float64Array(BANDS);
  const minIdx = 1; // skip DC bin, log(0) is undefined
  const maxIdx = n;
  const logMin = Math.log(minIdx);
  const logMax = Math.log(maxIdx);

  for (let b = 0; b < BANDS; b++) {
    const lo = Math.exp(logMin + (logMax - logMin) * (b / BANDS));
    const hi = Math.exp(logMin + (logMax - logMin) * ((b + 1) / BANDS));
    let loI = Math.max(minIdx, Math.round(lo));
    let hiI = Math.min(maxIdx, Math.round(hi));
    if (hiI <= loI) hiI = loI + 1;
    let sum = 0;
    let count = 0;
    for (let i = loI; i < hiI && i < n; i++) {
      sum += spectrum[i];
      count++;
    }
    bands[b] = count > 0 ? sum / count : 0;
  }

  let norm = 0;
  for (let i = 0; i < BANDS; i++) norm += bands[i] * bands[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < BANDS; i++) bands[i] /= norm;
  }
  return bands;
}

// 1 - dot(a,b) for unit vectors, clamped to [0, 2].
export function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.min(2, Math.max(0, 1 - dot));
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// examples: array of fingerprints -> {centroid, matchThreshold, spread}
export function calibrate(examples) {
  const n = examples.length;
  const dim = examples[0].length;
  const centroid = new Float64Array(dim);
  for (const ex of examples) {
    for (let i = 0; i < dim; i++) centroid[i] += ex[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= n;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += centroid[i] * centroid[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) centroid[i] /= norm;
  }

  const distances = examples.map((ex) => cosineDistance(ex, centroid));
  const mean = distances.reduce((a, b) => a + b, 0) / n;
  const variance =
    distances.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const spread = stddev;

  let matchThreshold = mean + 2 * stddev;
  matchThreshold = Math.min(0.15, Math.max(0.02, matchThreshold));

  return { centroid, matchThreshold, spread };
}

const FLUX_BUFFER_SIZE = 60; // ~1s at 60fps

export function createDetector({
  centroid,
  matchThreshold,
  noiseFloor = 0,
  sensitivity = 0.5,
  refractoryMs = 120,
}) {
  let prevFrame = null;
  const fluxBuffer = [];
  let lastCountedT = -Infinity;
  let curSensitivity = sensitivity;
  let curRefractoryMs = refractoryMs;

  const detector = {
    flux: 0,
    threshold: 0,

    feed(spectrum, tMs) {
      // 1. spectral flux against previous frame
      let flux = 0;
      if (prevFrame) {
        for (let i = 0; i < spectrum.length; i++) {
          const d = spectrum[i] - prevFrame[i];
          if (d > 0) flux += d;
        }
      }
      prevFrame = Float64Array.from(spectrum);
      detector.flux = flux;

      // 2. adaptive threshold — real median, not mean, so steady noise
      // pushes its own ceiling up and self-rejects.
      fluxBuffer.push(flux);
      if (fluxBuffer.length > FLUX_BUFFER_SIZE) fluxBuffer.shift();
      const multiplier = 3.5 - 3 * curSensitivity; // higher sensitivity -> lower bar
      const threshold = Math.max(median(fluxBuffer) * multiplier, noiseFloor);
      detector.threshold = threshold;

      if (flux <= threshold) return null;

      // 3. refractory gate — the single biggest source of miscounts: one
      // tap ringing off a bench must not score twice.
      if (tMs - lastCountedT < curRefractoryMs) return null;

      // 4. fingerprint match — a rejected sound does NOT arm the
      // refractory, so a real tap right after a false transient still counts.
      // No centroid (calibration capture) skips this stage: flux + refractory only.
      let distance = null;
      if (centroid) {
        const fp = fingerprint(spectrum);
        distance = cosineDistance(fp, centroid);
        if (distance > matchThreshold) return null;
      }

      // 5. count it
      lastCountedT = tMs;
      return { t: tMs, distance, flux };
    },

    setSensitivity(x) {
      curSensitivity = x;
    },

    setRefractory(ms) {
      curRefractoryMs = ms;
    },
  };

  return detector;
}
