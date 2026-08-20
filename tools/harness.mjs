// Drives the REAL detector.js end-to-end over synthesized fixtures and scores it against
// ground truth. Dev tool, not shipped. The unit tests check logic; this checks whether the
// thing actually counts — it is what caught the two defects unit tests could not see in v0.
//
// It mirrors app.js's live pipeline exactly: 1.5s noise floor -> 5 calibration taps through a
// centroid-less detector -> calibrate() -> 5s room check (harvesting negatives) -> count, at
// the app's real 250ms default cooldown. Where this file and app.js disagree, this file is
// wrong; keep them in step.
//
// Every room is scored over several independent noise draws and totalled, because one draw is
// not a measurement — the same unmodified detector scores 1 missed / 3 false positives on one
// and 3 missed / 0 on another. Fixtures are synthesized in memory; nothing to generate first.
//
//   node tools/harness.mjs                       # score the current detector
//   node tools/harness.mjs --detector <path>     # score another copy (head-to-head)
//   node tools/harness.mjs --detector <old> --legacy   # ...if that copy predates the
//                                                # multi-frame fingerprint (opt-in, see below)
//   node tools/harness.mjs --separability        # per-onset distances, taps vs distractors
//   node tools/harness.mjs --sweep               # re-derive the calibration threshold constants
//   node tools/harness.mjs --replay <capture>    # re-score a real-device debug capture

import { readFileSync } from 'node:fs';
import { generateRoom, ROOMS, SEEDS } from './fixtures.mjs';

// Synthesis dominates runtime and the fixtures are deterministic in (room, seed),
// so a sweep over many parameter sets pays for them exactly once.
const cache = new Map();
const fixture = (name, seed) => {
  const key = `${name}:${seed}`;
  if (!cache.has(key)) cache.set(key, generateRoom(name, seed));
  return cache.get(key);
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

// This used to be a silent `ev.fingerprint || fingerprint(frame)` fallback, added so the
// harness could also drive the pre-multi-frame detector for a head-to-head. That shim is
// how the harness and app.js drifted apart without anyone noticing: the harness quietly
// took the correct path while app.js took a broken one and counted nothing. Now the
// fallback is opt-in and everything else fails loudly.
const LEGACY = has('--legacy');
function exampleFrom(ev, frame) {
  if (ev.fingerprint) return ev.fingerprint;
  if (LEGACY) return fingerprint(frame);
  throw new Error(
    'detector returned an event with no .fingerprint. If you are scoring a detector from '
    + 'before the multi-frame fingerprint landed, pass --legacy to opt into the single-frame '
    + 'fallback. Otherwise this is a real mismatch — fix it rather than papering over it.',
  );
}

const DETECTOR = opt('--detector', new URL('../detector.js', import.meta.url).pathname);
const { fingerprint, calibrate, createDetector, cosineDistance } = await import(DETECTOR);

const NOISE_MS = 1500;   // app.js runCalibration step 1
const CAL_EXAMPLES = 5;  // app.js MAX_EXAMPLES (auto-finish without a Done click)
const CAL_REFRACTORY = 250;
const ROOM_MS = 5000;    // app.js runCalibration step 4
const COOLDOWN = 250;    // app.js defaultState().settings.sound.cooldownMs
const SENSITIVITY = 0.5;
const TOLERANCE_S = 0.15;

// Calibration threshold override, for --sweep. calibrate() owns these constants in
// detector.js; this only lets the harness re-derive them by measurement rather than
// by assertion. null = use whatever detector.js decided.
let CALIB = null;
function retune(cal, examples) {
  if (!CALIB) return cal;
  const { k, lo, hi } = CALIB;
  const ds = examples.map((e) => cosineDistance(e, cal.centroid));
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
  cal.matchThreshold = Math.min(hi, Math.max(lo, mean + k * sd));
  return cal;
}

// One pass of the app's whole flow over one fixture.
function run(name, seed) {
  const { hopMs, truth, frames } = fixture(name, seed);
  const at = (i) => i * hopMs;
  let i = 0;

  // 1. noise floor — mean positive spectral flux over the first 1.5s, x1.5
  let prev = null;
  let sum = 0;
  let n = 0;
  for (; at(i) < NOISE_MS; i++) {
    const spec = frames[i];
    if (prev) {
      let flux = 0;
      for (let k = 0; k < spec.length; k++) flux += Math.max(0, spec[k] - prev[k]);
      sum += flux;
      n++;
    }
    prev = spec;
  }
  const noiseFloor = n > 0 ? (sum / n) * 1.5 : 0;

  // 2. calibration examples through a centroid-less detector
  const calDet = createDetector({ centroid: null, noiseFloor, sensitivity: SENSITIVITY, refractoryMs: CAL_REFRACTORY });
  const examples = [];
  for (; i < frames.length && examples.length < CAL_EXAMPLES; i++) {
    const ev = calDet.feed(frames[i], at(i));
    // ev.fingerprint on the new detector (multi-frame); fall back for an older copy
    if (ev) examples.push(exampleFrom(ev, frames[i]));
  }
  // Throws, exactly like the spread guard below — review found the two failure channels
  // inconsistent: this one used to return {error}, which scoreRoom folded into the table
  // as a small ERR marker while the surviving seeds still fed the TOTAL. A room where 2
  // of 5 draws failed to calibrate would quietly publish a better headline number — the
  // precise class of silent drift this harness exists to kill. Loud beats convenient.
  if (examples.length < CAL_EXAMPLES) {
    throw new Error(`${name} seed ${seed}: only captured ${examples.length}/${CAL_EXAMPLES} calibration taps — `
      + 'the fixture cannot drive the app\'s own calibration flow, so no score from it is comparable.');
  }

  // 3. room check — count matches AND harvest what it rejects as negative examples.
  // An older detector never fires onEvent, so negatives stays empty and it scores as before.
  let cal = retune(calibrate(examples), examples);
  // app.js refuses a calibration this scattered and makes the worker redo it (SPREAD_BOUND
  // in runCalibration). The harness has no way to redo, so if a fixture ever produces one
  // it must say so rather than quietly scoring a calibration the app would have rejected.
  // Measured across all current draws the worst is ~0.08, so this should never fire.
  if (cal.spread > 0.25) {
    throw new Error(`${name} seed ${seed}: calibration spread ${cal.spread.toFixed(3)} exceeds the 0.25 bound `
      + 'that app.js rejects — the harness would be scoring a calibration the app would never accept.');
  }
  const negatives = [];
  const roomDet = createDetector({
    centroid: cal.centroid, matchThreshold: cal.matchThreshold, noiseFloor,
    sensitivity: SENSITIVITY, refractoryMs: 120,
    onEvent: (ev) => { if (!ev.matched && ev.fingerprint) negatives.push(ev.fingerprint); },
  });
  let roomMatches = 0;
  const roomEnd = at(i) + ROOM_MS;
  for (; i < frames.length && at(i) < roomEnd; i++) {
    if (roomDet.feed(frames[i], at(i))) roomMatches++;
  }
  cal = retune(calibrate(examples, negatives), examples);
  const liveFrom = at(i);

  // 4. count the rest
  const det = createDetector({
    centroid: cal.centroid, matchThreshold: cal.matchThreshold, negatives: cal.negatives,
    noiseFloor, sensitivity: SENSITIVITY, refractoryMs: COOLDOWN,
  });
  const hits = [];
  for (; i < frames.length; i++) {
    const ev = det.feed(frames[i], at(i));
    if (ev) hits.push(ev.t / 1000);
  }

  // 5. score against ground truth, excluding taps spent on calibration and the room check
  const live = truth.filter((t) => t * 1000 > liveFrom + 100);
  const unmatched = [...hits];
  let matched = 0;
  for (const t of live) {
    const k = unmatched.findIndex((h) => Math.abs(h - t) < TOLERANCE_S);
    if (k >= 0) { matched++; unmatched.splice(k, 1); }
  }
  return {
    name, seed, expected: live.length, counted: hits.length, matched,
    missed: live.length - matched, falsePositives: unmatched.length,
    spread: +cal.spread.toFixed(4), threshold: +cal.matchThreshold.toFixed(4),
    negatives: negatives.length, roomMatches,
  };
}

function score() {
  console.log(`detector: ${DETECTOR}`);
  console.log(`${SEEDS.length} noise draws per room, totalled\n`);
  console.log('room     taps  missed falsePos  per-draw missed/falsePos');
  let M = 0;
  let F = 0;
  const scoreRoom = ({ name }) => {
    let m = 0;
    let f = 0;
    let exp = 0;
    const per = [];
    for (const seed of SEEDS) {
      const r = run(name, seed);
      m += r.missed; f += r.falsePositives; exp += r.expected;
      per.push(`${r.missed}/${r.falsePositives}`);
    }
    console.log(`${name.padEnd(8)} ${String(exp).padEnd(5)} ${String(m).padEnd(6)} ${String(f).padEnd(9)} ${per.join('  ')}`);
    return { m, f };
  };

  for (const room of ROOMS.filter((r) => !r.separate)) {
    const { m, f } = scoreRoom(room);
    M += m; F += f;
  }
  console.log(`\n${'TOTAL'.padEnd(8)} ${''.padEnd(5)} ${String(M).padEnd(6)} ${F}`);

  // Scored and printed, never folded into the total above — see the ROOMS comment in
  // fixtures.mjs. Keeping it out keeps every published number comparable; printing it
  // every run keeps the harder case from quietly falling out of view.
  const harder = ROOMS.filter((r) => r.separate);
  if (harder.length) {
    console.log('\nnot in the total — distractors here are bright AND slow, so only the decay');
    console.log('separates them from a tap. The three rooms above flatter a decay-based matcher.');
    console.log('room     taps  missed falsePos  per-draw missed/falsePos');
    for (const room of harder) scoreRoom(room);
  }
  return { missed: M, falsePositives: F };
}

// Decisive diagnostic: distance-to-centroid for every onset, split by ground truth.
// If the two distributions overlap, no threshold in this family separates them.
function separability(name, seed) {
  const { hopMs, truth, frames } = fixture(name, seed);
  const at = (i) => i * hopMs;
  const isTap = (ms) => truth.some((t) => Math.abs(t * 1000 - ms) < 120);
  let i = 0;
  let prev = null;
  let sum = 0;
  let n = 0;
  for (; at(i) < NOISE_MS; i++) {
    const spec = frames[i];
    if (prev) { let f = 0; for (let k = 0; k < spec.length; k++) f += Math.max(0, spec[k] - prev[k]); sum += f; n++; }
    prev = spec;
  }
  const noiseFloor = n > 0 ? (sum / n) * 1.5 : 0;
  const calDet = createDetector({ centroid: null, noiseFloor, sensitivity: SENSITIVITY, refractoryMs: CAL_REFRACTORY });
  const examples = [];
  for (; i < frames.length && examples.length < CAL_EXAMPLES; i++) {
    const ev = calDet.feed(frames[i], at(i));
    if (ev) examples.push(exampleFrom(ev, frames[i]));
  }
  const cal = calibrate(examples);
  const taps = [];
  const others = [];
  const probe = createDetector({
    centroid: cal.centroid, matchThreshold: 2, noiseFloor, // threshold 2 = accept all, we want distances
    sensitivity: SENSITIVITY, refractoryMs: COOLDOWN,
    onEvent: (ev) => { (isTap(ev.t) ? taps : others).push(ev.distance); },
  });
  for (; i < frames.length; i++) probe.feed(frames[i], at(i));
  const stat = (a) => {
    if (!a.length) return 'n=0';
    const s = [...a].sort((x, y) => x - y);
    return `n=${s.length} min=${s[0].toFixed(3)} med=${s[Math.floor(s.length / 2)].toFixed(3)} max=${s[s.length - 1].toFixed(3)}`;
  };
  const maxTap = taps.length ? Math.max(...taps) : 0;
  const minOther = others.length ? Math.min(...others) : Infinity;
  console.log(`${name} (seed ${seed}) autoThresh=${cal.matchThreshold.toFixed(3)}`);
  console.log(`   TAPS        ${stat(taps)}`);
  console.log(`   DISTRACTORS ${stat(others)}`);
  console.log(`   separable: ${minOther > maxTap
    ? `YES — any threshold in (${maxTap.toFixed(3)}, ${minOther.toFixed(3)})`
    : `NO — distributions overlap ${minOther.toFixed(3)}..${maxTap.toFixed(3)}`}`);
}

// Re-score a debug capture exported from a real device. No ground truth in the file, so this
// reports what the app decided and what a different threshold would have decided instead.
function replay(path) {
  const cap = JSON.parse(readFileSync(path, 'utf8'));
  const events = cap.events || [];
  const counted = events.filter((e) => e.matched);
  const rejected = events.filter((e) => !e.matched);
  console.log(`capture: ${path}`);
  console.log(`  ${events.length} onsets — ${counted.length} counted, ${rejected.length} rejected`);
  console.log(`  matchThreshold at capture time: ${cap.matchThreshold}`);
  const dt = events.map((e) => e.dtMs).filter((x) => x > 0).sort((a, b) => a - b);
  if (dt.length) {
    console.log(`  real frame spacing: min=${dt[0].toFixed(1)}ms med=${dt[Math.floor(dt.length / 2)].toFixed(1)}ms max=${dt[dt.length - 1].toFixed(1)}ms`);
  }
  const stat = (a, label) => {
    if (!a.length) { console.log(`  ${label} n=0`); return; }
    const s = a.map((e) => e.distance).sort((x, y) => x - y);
    console.log(`  ${label} n=${s.length} min=${s[0].toFixed(3)} med=${s[Math.floor(s.length / 2)].toFixed(3)} max=${s[s.length - 1].toFixed(3)}`);
  };
  stat(counted, 'counted   ');
  stat(rejected, 'rejected  ');
  console.log('  count at other thresholds:');
  for (const th of [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25]) {
    console.log(`    ${String(th).padEnd(5)} -> ${events.filter((e) => e.distance <= th).length} counted`);
  }
  if (cap.negatives?.length) {
    let wouldReject = 0;
    for (const e of events) {
      if (e.fingerprint && cap.negatives.some((neg) => cosineDistance(e.fingerprint, neg) < e.distance)) wouldReject++;
    }
    console.log(`  ${cap.negatives.length} negatives stored; nearest-negative rule rejects ${wouldReject} of ${events.length} onsets`);
  }
}

function sweep() {
  console.log('re-deriving matchThreshold = clamp(mean + k*sd, lo, hi) against ground truth');
  console.log('k    lo     hi     missed  falsePos   quiet    noisy    loud');
  const rows = [];
  for (const k of [2, 2.5, 3, 4]) {
    for (const lo of [0.08, 0.09, 0.10, 0.11, 0.12]) {
      for (const hi of [0.13, 0.14, 0.15, 0.16, 0.17]) {
        if (hi <= lo) continue;
        CALIB = { k, lo, hi };
        let M = 0;
        let F = 0;
        const per = [];
        for (const { name } of ROOMS.filter((r) => !r.separate)) {
          let m = 0;
          let f = 0;
          for (const seed of SEEDS) {
            const r = run(name, seed);
            m += r.missed; f += r.falsePositives;
          }
          M += m; F += f;
          per.push(`${m}m/${f}f`.padEnd(8));
        }
        rows.push({ k, lo, hi, M, F, per });
        console.log(`${String(k).padEnd(4)} ${String(lo).padEnd(6)} ${String(hi).padEnd(6)} ${String(M).padEnd(7)} ${String(F).padEnd(10)} ${per.join(' ')}`);
      }
    }
  }
  CALIB = null;
  // Print the Pareto frontier, not a single "winner". Ranking by false positives alone
  // picks a setting that misses a fifth of the taps; the trade has to be visible to be
  // chosen honestly.
  const frontier = rows
    .filter((r) => !rows.some((o) => o !== r && o.M <= r.M && o.F <= r.F && (o.M < r.M || o.F < r.F)))
    .sort((a, b) => a.M - b.M);
  console.log('\nPareto frontier (nothing else is better on BOTH axes):');
  for (const r of frontier) console.log(`  k=${r.k} lo=${r.lo} hi=${r.hi} -> ${String(r.M).padStart(2)} missed / ${String(r.F).padStart(2)} falsePos`);
}

if (has('--sweep')) sweep();
else if (has('--replay')) replay(opt('--replay'));
else if (has('--separability')) for (const { name } of ROOMS) for (const seed of SEEDS) separability(name, seed);
else score();
