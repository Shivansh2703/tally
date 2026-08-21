// Pure detection logic. No DOM, no Web Audio, no timers, no Date.now() —
// every input arrives as an argument so this is testable without a mic.

// ponytail: rAF polling caps this at ~8 reliable events/sec (frame budget +
// refractory floor). Upgrade path if a faster cadence is ever needed: an
// AudioWorklet running its own FFT off the main thread.

const BANDS = 16;

// How the sound is identified. A single 23ms snapshot cannot tell a knuckle tap
// from a dropped box — both are broadband thumps in one frame. What separates
// them is how the sound DIES: the tap is gone in ~12ms, the box rings for ~60ms.
// So the fingerprint spans three consecutive frames, and normalising across the
// whole thing (not per frame) is what keeps the decay envelope in the signature.
const FP_FRAMES = 3;
// The multi-frame fingerprint's length — what a stored calibration's centroid and
// negatives must match. Exported so app.js can validate persisted state against the
// live shape instead of hardcoding 48 a second place.
export const FINGERPRINT_DIM = BANDS * FP_FRAMES;
// Frame 0 is the LOUDEST of the first few frames, not the frame that crossed the
// threshold. Load-bearing: the analyser hop never lines up with the onset the same
// way twice, so a fixed window samples a different phase of the decay each time.
// Measured — without this alignment the multi-frame fingerprint is WORSE than the
// single-frame one it replaces (scatter swamps the extra information).
const ALIGN_WINDOW = 3;
const MAX_PENDING_FRAMES = ALIGN_WINDOW + FP_FRAMES - 1;
// ...but the decision closes on TIME, not on frame count, so a slow or throttled
// device settles with fewer frames instead of hanging on an onset forever.
const LOOKAHEAD_MS = 100;
// While an onset is being judged it absorbs the frames that follow — they are its decay.
// That means a rejected sound briefly blinds the detector, so a much louder onset inside
// the window takes over instead of being swallowed.
const RESTART_RATIO = 1.5;
// A candidate negative this close to the calibrated sound is thrown away rather than
// stored, so a sloppy tap during the room check cannot teach the app to ignore the
// very sound it counts. Deliberately SMALL: anything that actually matched was never
// a candidate in the first place (only rejected onsets are offered), so the guard is
// catching near-misses, not taps. Measured — at 0.05 it discarded every negative the
// loud room had to offer (distractors landed at 0.168-0.170 against a 0.150 threshold)
// and the whole feature silently did nothing.
const NEGATIVE_MARGIN = 0.01;
// ...and a negative only overrules a match if it is closer by a real margin, not by a
// hair. Keeps one borderline negative from stealing every marginal tap.
const NEGATIVE_DOMINANCE = 0.02;
const MAX_NEGATIVES = 24;

// 16 log-spaced band energies from a linear-magnitude spectrum. Raw, unnormalised —
// relative loudness between frames is exactly the decay information we are after.
export function bandEnergies(spectrum) {
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
  return bands;
}

function normalise(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return v;
}

// Single-frame fingerprint: the shape of one moment, unit-normalised.
export function fingerprint(spectrum) {
  return normalise(bandEnergies(spectrum));
}

// Multi-frame fingerprint: FP_FRAMES of raw bands laid end to end and normalised
// as one vector, so both the shape AND the decay across frames are in the signature.
// Short input is padded by repeating its last frame (a device too slow to deliver
// the tail still gets a usable, if blunter, signature).
export function fingerprintFrames(frames) {
  const v = new Float64Array(BANDS * FP_FRAMES);
  for (let k = 0; k < FP_FRAMES; k++) {
    const b = frames[Math.min(k, frames.length - 1)];
    for (let j = 0; j < BANDS; j++) v[k * BANDS + j] = b[j];
  }
  return normalise(v);
}

// Pick the loudest of the first ALIGN_WINDOW frames, then take FP_FRAMES from there.
function alignedFingerprint(frames) {
  let best = 0;
  let bestEnergy = -1;
  for (let k = 0; k < Math.min(ALIGN_WINDOW, frames.length); k++) {
    let e = 0;
    for (let j = 0; j < BANDS; j++) e += frames[k][j];
    if (e > bestEnergy) { bestEnergy = e; best = k; }
  }
  return fingerprintFrames(frames.slice(best));
}

// 1 - dot(a,b) for unit vectors, clamped to [0, 2].
// The length check is not defensive boilerplate — it is the guard that would have caught
// a real shipped bug. When the fingerprint grew from 16 values to 48, app.js was briefly
// still building 16, and this function read past the end and returned NaN; NaN <= threshold
// is false, so the app rejected every sound and counted nothing, silently. Reverse the
// argument order and it is worse: it truncates and returns a small, entirely believable
// distance, which would OVER-count — the failure this app exists to prevent. Fail loudly.
export function cosineDistance(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineDistance: length mismatch ${a.length} vs ${b.length}`);
  }
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

// examples: fingerprints of the sound to count.
// negatives: fingerprints of sounds heard in the room that are NOT it — the app
// harvests these from the room check, where nobody is supposed to be tapping.
// -> {centroid, matchThreshold, spread, negatives}
export function calibrate(examples, negatives = []) {
  const n = examples.length;
  const dim = examples[0].length;
  const centroid = new Float64Array(dim);
  for (const ex of examples) {
    for (let i = 0; i < dim; i++) centroid[i] += ex[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= n;
  normalise(centroid);

  const distances = examples.map((ex) => cosineDistance(ex, centroid));
  const mean = distances.reduce((a, b) => a + b, 0) / n;
  const variance =
    distances.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const spread = stddev;

  // The [0.11, 0.14] clamp is measured, not chosen — swept against ground truth over
  // 15 noise draws (`node tools/harness.mjs --sweep`). It replaces v0's [0.02, 0.15],
  // which was tuned to the SINGLE-FRAME distance scale; the multi-frame fingerprint
  // sits higher, and leaving the old clamp in place missed 9 taps in a quiet room.
  // Honest reading of how narrow it is: for this fingerprint the scatter of 3-5
  // calibration examples is a poor predictor of live scatter, so a nearly fixed
  // threshold beats an adaptive one. The mean+2*stddev term still moves inside the
  // band; it just does not get to move far.
  let matchThreshold = mean + 2 * stddev;
  matchThreshold = Math.min(0.14, Math.max(0.11, matchThreshold));

  // Anything that looks like the target is NOT a usable negative — see NEGATIVE_MARGIN.
  const kept = negatives
    .filter((neg) => neg.length === dim && cosineDistance(neg, centroid) > matchThreshold + NEGATIVE_MARGIN)
    .slice(0, MAX_NEGATIVES);

  return { centroid, matchThreshold, spread, negatives: kept };
}

const FLUX_BUFFER_SIZE = 60; // ~1s at 60fps

export function createDetector({
  centroid,
  matchThreshold,
  negatives = [],
  noiseFloor = 0,
  sensitivity = 0.5,
  strictness = 0,
  refractoryMs = 120,
  onEvent = null,
}) {
  let prevFrame = null;
  const fluxBuffer = [];
  let lastCountedT = -Infinity;
  let curSensitivity = sensitivity;
  let curStrictness = strictness;
  let curRefractoryMs = refractoryMs;
  // An onset waiting on its own decay before it can be judged.
  let pending = null;

  // Judge a pending onset and clear it. Returns the event if it counts, else null.
  function settle() {
    const { t, flux, threshold, frames } = pending;
    pending = null;

    const fp = alignedFingerprint(frames);
    let distance = null;
    let matched = true;
    if (centroid) {
      distance = cosineDistance(fp, centroid);
      // Strictness scales the CALIBRATED threshold, linearly: 1.0x at 0 (today's
      // behaviour), 0.75x at the 0.5 default (the "tighten" the owner asked for),
      // 0.5x at 1. Does not touch the negatives check below, which compares
      // against `distance`, not the threshold.
      const effectiveThreshold = matchThreshold * (1 - 0.5 * curStrictness);
      matched = distance <= effectiveThreshold;
      // Closer to something we were told to ignore than to the thing we count.
      if (matched && negatives.length) {
        matched = !negatives.some((neg) => cosineDistance(fp, neg) < distance - NEGATIVE_DOMINANCE);
      }
    }

    const ev = { t, matched, distance, flux, threshold, fingerprint: fp, frames };
    if (onEvent) onEvent(ev);
    if (!matched) return null;   // a rejected sound does NOT arm the refractory
    lastCountedT = t;
    return ev;
  }

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
      const multiplier = 5 - 4.5 * curSensitivity; // higher sensitivity -> lower bar
      const threshold = Math.max(median(fluxBuffer) * multiplier, noiseFloor);
      detector.threshold = threshold;

      // 3. an onset already under judgement absorbs the frames that follow it —
      // they are its own decay, which is the whole point. Frames must be COPIED:
      // the caller reuses one buffer for every read.
      if (pending) {
        // A clearly louder onset inside the window is not the first one's decay — it is
        // a new sound, and the first was its leading edge or unrelated noise. Restart on
        // it, or a bit of clatter just before a real tap eats the tap.
        // The superseded onset is deliberately NOT reported through onEvent. It was
        // never judged — it has no fingerprint, only a leading edge — and the room
        // check turns everything onEvent reports as unmatched into a sound to IGNORE.
        // Handing it the leading edge of a real tap is how the app would learn to
        // ignore taps. Silence here is the safe answer, not an oversight.
        if (flux > pending.flux * RESTART_RATIO) {
          pending = { t: tMs, flux, threshold, frames: [bandEnergies(spectrum)] };
          return null;
        }
        if (tMs - pending.t <= LOOKAHEAD_MS && pending.frames.length < MAX_PENDING_FRAMES) {
          pending.frames.push(bandEnergies(spectrum));
          if (pending.frames.length < MAX_PENDING_FRAMES) return null;
        }
        return settle();
      }

      if (flux <= threshold) return null;

      // 4. refractory gate — the single biggest source of miscounts: one
      // tap ringing off a bench must not score twice.
      if (tMs - lastCountedT < curRefractoryMs) return null;

      // 5. hold it and listen to how it dies. The event surfaces from settle()
      // a few frames later, carrying this original onset timestamp.
      pending = { t: tMs, flux, threshold, frames: [bandEnergies(spectrum)] };
      return null;
    },

    setSensitivity(x) {
      curSensitivity = x;
    },

    setStrictness(x) {
      curStrictness = x;
    },

    setRefractory(ms) {
      curRefractoryMs = ms;
    },

    // The caller has stopped feeding — mode switch, recalibration, teardown. Because the
    // decision is deferred, an onset can be sitting in flight at that moment; without
    // this it is dropped and the tap that caused it is silently never counted. Judge it
    // with whatever frames arrived.
    flush() {
      return pending ? settle() : null;
    },
  };

  return detector;
}
