// Synthesize bench audio and dump STFT magnitude frames, so the real detector can be
// driven end-to-end over realistic sound without a microphone. Dev tool, not shipped.
//
// Ported from the numpy script the v0 seat wrote in a session temp dir (which is deleted
// with the job — owner ruled 2026-08-20 that the instrument lives in the repo). Pure Node:
// one toolchain, no dependencies, no build step, same as the rest of this repo.
//
// The fixtures are NOT byte-identical to the numpy ones — a different PRNG draws a different
// noise bed. That matters more than it sounds: the SAME detector scores 1 missed / 3 false
// positives on one noise draw and 3 missed / 0 on another. One draw is not a measurement, so
// the harness runs several seeds per room and totals them. Fixtures are generated in memory;
// the CLI below only exists for dumping one to disk to eyeball it.
//
// Usage: node tools/fixtures.mjs [outDir]   (default: tools/fixtures/, gitignored)
//        writes <room>.json (STFT frames for the harness) and <room>.wav, which Chrome
//        can be told to use AS THE MICROPHONE — that is how the real app gets driven
//        end to end without a person tapping a bench. See tools/driveapp.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';

const SR = 44100;
const FFT = 1024;
const HOP = Math.trunc(SR * 0.016); // ~16ms, matches the app's requestAnimationFrame polling

// Deterministic PRNG — fixtures must be reproducible or the measurements mean nothing.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussians(rand, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(rand(), 1e-12);
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * rand();
    out[i] = r * Math.cos(th);
    if (i + 1 < n) out[i + 1] = r * Math.sin(th);
  }
  return out;
}

// Impulsive transient: noise burst under an exponential decay, then spectrally shaped.
// bright: sharp/high — a knuckle or tool on a hard bench (the sound we count)
// !bright: dull/low — a dropped box (the sound we must NOT count)
function click(rand, durS, decayMs, bright) {
  const n = Math.trunc(SR * durS);
  const x = gaussians(rand, n);
  for (let i = 0; i < n; i++) x[i] *= Math.exp(-(i / SR) / (decayMs / 1000));
  const y = new Float64Array(n); // one-pole low-pass
  const a = 0.9;
  for (let i = 1; i < n; i++) y[i] = a * y[i - 1] + (1 - a) * x[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = bright ? x[i] - y[i] : y[i];
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] /= peak + 1e-9;
  return out;
}

function build(rand, nTaps, nDistractors, noiseDb, brightDistractors = false, gapS = 1.0, leadS = 3.0) {
  const total = Math.trunc(SR * (leadS + gapS * (nTaps + 2)));
  const buf = gaussians(rand, total);
  const bed = 10 ** (noiseDb / 20);
  for (let i = 0; i < total; i++) buf[i] *= bed;
  const truth = [];
  for (let i = 0; i < nTaps; i++) {
    const s = Math.trunc(SR * (leadS + gapS * i));
    const c = click(rand, 0.05, 12, true);
    for (let k = 0; k < c.length && s + k < total; k++) buf[s + k] += c[k] * 0.6;
    truth.push(s / SR);
  }
  for (let i = 0; i < nDistractors; i++) {
    const s = Math.trunc(SR * (leadS + gapS * i + gapS * 0.45));
    // brightDistractors: same spectral tilt as a tap, but the box's long decay. The three
    // original rooms use dull distractors, which differ from a tap in BOTH brightness and
    // decay — and decay is exactly what the fingerprint reads, so those rooms flatter it.
    // This one takes that advantage away and leaves only the decay to go on.
    const d = click(rand, 0.18, 60, brightDistractors);
    for (let k = 0; k < d.length && s + k < total; k++) buf[s + k] += d[k] * 0.7;
  }
  return { buf, truth };
}

// Iterative radix-2 FFT, in place, on split real/imag arrays. Only here because the
// browser's AnalyserNode does this for us in the app and Node has no built-in.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function stftFrames(x) {
  const win = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
  const frames = [];
  for (let start = 0; start + FFT < x.length; start += HOP) {
    const re = new Float64Array(FFT);
    const im = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) re[i] = x[start + i] * win[i];
    fft(re, im);
    const mag = new Array(FFT / 2);
    for (let i = 0; i < FFT / 2; i++) mag[i] = +Math.hypot(re[i], im[i]).toFixed(6);
    frames.push(mag);
  }
  return frames;
}

// The first three are the comparable set — every accuracy number this repo has ever
// published comes from them, so they do not change. `hard` was added after review pointed
// out that those three flatter a decay-sensitive fingerprint by construction; it is scored
// and reported separately so the historical comparison stays honest AND the harder case is
// never out of sight.
export const ROOMS = [
  { name: 'quiet', taps: 30, distractors: 0, noiseDb: -60 },
  { name: 'noisy', taps: 30, distractors: 10, noiseDb: -34 },
  { name: 'loud', taps: 30, distractors: 15, noiseDb: -22 },
  { name: 'hard', taps: 30, distractors: 15, noiseDb: -22, brightDistractors: true, separate: true },
];

// 16-bit mono PCM at 48kHz. Chrome's fake-capture reader wants 48k — hand it 44.1k and
// getUserMedia yields a live track of digital silence, with no error anywhere.
const WAV_RATE = 48000;
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const src = (i * from) / to;
    const j = Math.floor(src);
    const f = src - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return out;
}

function wav(input, inputRate) {
  const samples = resample(input, inputRate, WAV_RATE);
  const sampleRate = WAV_RATE;
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);        // PCM
  head.writeUInt16LE(1, 22);        // mono
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export const SEEDS = [7, 11, 23, 42, 97];

// One room, one noise draw, in memory. Deterministic in (name, seed).
export function generateRoom(name, seed) {
  const r = ROOMS.find((x) => x.name === name);
  if (!r) throw new Error(`unknown room: ${name}`);
  const rand = mulberry32(seed);
  const { buf, truth } = build(rand, r.taps, r.distractors, r.noiseDb, !!r.brightDistractors);
  return { hopMs: (HOP / SR) * 1000, truth, frames: stftFrames(buf) };
}

export function generate(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const r of ROOMS) {
    const rand = mulberry32(SEEDS[0]);
    const { buf, truth } = build(rand, r.taps, r.distractors, r.noiseDb, !!r.brightDistractors);
    writeFileSync(`${outDir}/${r.name}.json`, JSON.stringify({ hopMs: (HOP / SR) * 1000, truth, frames: stftFrames(buf) }));
    writeFileSync(`${outDir}/${r.name}.wav`, wav(buf, SR));
    console.log(`${r.name}: ${truth.length} taps, ${r.distractors} distractors, ${r.noiseDb}dB bed -> ${r.name}.json + ${r.name}.wav`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generate(process.argv[2] || new URL('./fixtures', import.meta.url).pathname);
}
