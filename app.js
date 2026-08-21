// App shell wiring for Tally: mode switching (TAP / SOUND / MOTION-stub),
// calibration flow, persistence. DOM-touching code only runs from initApp(),
// so this module can be imported under `node --test` to exercise the pure
// logic below without a browser.
import { calibrate, createDetector, FINGERPRINT_DIM } from './detector.js';
import { applyBump, applyUndo } from './tally.js';

const STORAGE_KEY = 'tally-v1-state';
const MIN_EXAMPLES = 3;
const MAX_EXAMPLES = 5;

// Hard floor on the detection threshold from the "Measuring room noise" step
// (see detector.js: Math.max(median * multiplier, noiseFloor)) — no
// sensitivity setting can push the threshold below it.
export function noiseFloorFromRoom(avgFlux) {
  return avgFlux * 1.5;
}

// Owner ruling 2026-08-19 ~18:40: accept after 3 examples, keep listening up
// to 5. Pure decision so the "Done" affordance and the auto-stop share one
// rule instead of drifting apart.
export function calibrationStep(count, doneClicked) {
  const canFinish = count >= MIN_EXAMPLES;
  const finished = count >= MAX_EXAMPLES || (doneClicked && canFinish);
  return { canFinish, finished };
}

// Owner report 2026-08-20: after recalibrating, "the mic doesn't pick
// anything up." Root cause: unlike v0 (which unconditionally re-ran
// initMic() — fresh getUserMedia + fresh AudioContext — at the top of every
// calibration), the shell acquires the mic once ever (`if (!audioCtx)`) and
// never rechecks it. A real device can suspend the AudioContext (background/
// lock) or end the track (OS reclaims the mic) with nothing to detect or
// repair it. Pure decisions so they're testable without a mic.
export function micNeedsReacquire(audioCtxState, trackState) {
  return !audioCtxState || audioCtxState === 'closed' || trackState === 'ended';
}
export function micNeedsResume(audioCtxState) {
  return audioCtxState === 'suspended';
}

// Slider scales. The app asked people to move sliders it never explained; the owner had
// to ask what they do. These render the honest mechanics, not marketing words.
// Sensitivity drives ONLY the "was that a sound at all?" bar (see detector.js: the flux
// threshold is median * (5 - 4.5*s)); it never touches matching. Cooldown is the minimum
// gap between counts, which caps the counting rate.
export function sensitivityLabel(s) {
  const mult = 5 - 4.5 * s; // keep in step with detector.js's multiplier line
  return `${Math.round(s * 100)}% · bar ${mult.toFixed(1)}× room`;
}
// Strictness scales the calibrated match TOLERANCE (see detector.js's effectiveThreshold
// line): 1.0x at 0 (today's fixed behaviour), 0.75x at the 0.5 default (owner: "tighten
// it"), 0.5x at 1. Never touches the sensitivity bar above.
export function strictnessLabel(s) {
  const mult = 1 - 0.5 * s; // keep in step with detector.js's effectiveThreshold line
  return `${Math.round(s * 100)}% · match ${mult.toFixed(2)}× calibrated`;
}
export function cooldownLabel(ms) {
  const perSec = Math.round((1000 / ms) * 10) / 10;
  return `${ms} ms · max ${perSec}/s`;
}

// iOS with AirPods connected prefers the Bluetooth hands-free profile for getUserMedia:
// that kills the music AND switches input to the AirPods' own mic — which is on the
// worker's head, not at the bench, so taps arrive attenuated and phone-calibrated
// fingerprints stop matching. Pure chooser so it's testable: given the granted track's
// label and the device list, return the deviceId to re-acquire with, or null to keep
// what we were given.
const BLUETOOTHISH = /airpods|bluetooth|hands-?free|headset|hfp|buds|wh-\d|wf-\d/i;
const BUILTINISH = /built-?in|iphone|ipad|macbook|internal/i;
export function pickBuiltInMic(grantedLabel, devices) {
  if (!grantedLabel || !BLUETOOTHISH.test(grantedLabel)) return null;
  const builtIn = devices.find(
    (d) => d.kind === 'audioinput' && BUILTINISH.test(d.label || '') && !BLUETOOTHISH.test(d.label || ''),
  );
  return builtIn ? builtIn.deviceId : null;
}

// Start-over's teeth. The detector's decision is deferred (~100ms), so the sound of the
// finger hitting the Start-over button itself can be mid-judgement when the click lands;
// without flushing, that pending onset settles on a later feed and becomes example #1 of
// the supposedly fresh set — a screen-tap seeded as the calibration sound. Found by
// review, demonstrated against the real detector. Flush and discard, THEN empty.
export function discardCapture(detector, examples) {
  detector.flush(); // settles anything in flight; the return value belongs to the discarded set
  examples.length = 0;
}

function defaultState() {
  return {
    count: 0,
    history: [],
    mode: 'tap',
    settings: {
      sound: { sensitivity: 0.5, strictness: 0, cooldownMs: 250, tick: false, debug: false },
      tap: { tick: false },
    },
    calibration: null,
    noiseFloor: 0,
  };
}

// The fingerprint dimension changed (16 -> 48, BANDS * FP_FRAMES) in the type-matching
// upgrade. A calibration saved under the old shape is not wrong data to migrate, it's
// data that means something different now — cosineDistance over mismatched-length
// vectors is undefined behavior, and this app's whole point is no false positives. So
// any shape mismatch discards the calibration wholesale, same as none was ever saved.
export function isValidCalibration(cal, dim = FINGERPRINT_DIM) {
  if (!cal || typeof cal !== 'object') return false;
  if (!Array.isArray(cal.centroid) || cal.centroid.length !== dim) return false;
  if (cal.negatives !== undefined) {
    if (!Array.isArray(cal.negatives)) return false;
    if (!cal.negatives.every((n) => Array.isArray(n) && n.length === dim)) return false;
  }
  return true;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return defaultState();
    const d = defaultState();
    const state = {
      ...d,
      ...saved,
      settings: {
        ...d.settings,
        ...(saved.settings || {}),
        sound: { ...d.settings.sound, ...(saved.settings && saved.settings.sound) },
        tap: { ...d.settings.tap, ...(saved.settings && saved.settings.tap) },
      },
    };
    if (state.calibration && !isValidCalibration(state.calibration)) state.calibration = null;
    return state;
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function initApp() {
  const state = loadState();

  const $ = (id) => document.getElementById(id);
  const countEl = $('countDisplay');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function showScreen(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    $(id).classList.add('active');
  }

  function persist() {
    saveState(state);
  }

  function render() {
    countEl.textContent = state.count;
    for (const btn of document.querySelectorAll('.mode-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    }
    $('soundControls').style.display = state.mode === 'sound' ? '' : 'none';
    $('tapHint').style.display = state.mode === 'tap' ? '' : 'none';
    $('tickToggle').checked = !!state.settings[state.mode]?.tick;
    $('debugToggle').checked = !!state.settings.sound.debug;
    $('debugRow').style.display = state.settings.sound.debug ? '' : 'none';
  }

  function pulse() {
    if (reduceMotion) return;
    countEl.classList.remove('pulse');
    // force reflow so the animation can retrigger on consecutive bumps
    void countEl.offsetWidth;
    countEl.classList.add('pulse');
  }

  function bump(delta) {
    const { count, applied } = applyBump(state.count, delta);
    state.count = count;
    if (applied !== 0) state.history.push(applied);
    persist();
    render();
    if (applied > 0) {
      pulse();
      if (navigator.vibrate) navigator.vibrate(30);
      // Haptic-only tick (no audio tone): a sound on count would feed back
      // into the mic in SOUND mode and self-trigger the detector, so audio
      // ticks are not offered at all rather than merely disabled — nothing
      // to enforce because nothing to leak. ponytail: haptic tick covers
      // the spec's "optional tick"; add an audio tick only if asked for one
      // that's not mic-adjacent (e.g. TAP-only).
      if (state.settings[state.mode]?.tick && navigator.vibrate) navigator.vibrate(15);
    }
  }

  $('btnMinus').onclick = () => bump(-1);
  $('btnPlus').onclick = () => bump(1);
  $('btnUndo').onclick = () => {
    const { count, history } = applyUndo(state.count, state.history);
    state.count = count;
    state.history = history;
    persist();
    render();
  };
  $('btnReset').onclick = () => {
    if (confirm('Reset the count to zero? This cannot be undone.')) {
      state.count = 0;
      state.history = [];
      persist();
      render();
    }
  };
  $('tickToggle').onchange = (e) => {
    state.settings[state.mode] = state.settings[state.mode] || {};
    state.settings[state.mode].tick = e.target.checked;
    persist();
  };

  // TAP mode: the whole readout area is the button, not just the digits.
  $('countDisplay-wrap').addEventListener('pointerdown', () => {
    if (state.mode === 'tap') bump(1);
  });

  // --- mode switching ------------------------------------------------------

  let stopSoundLoop = null;

  function setMode(mode) {
    if (stopSoundLoop) { stopSoundLoop(); stopSoundLoop = null; }
    state.mode = mode;
    persist();
    render();
    if (mode === 'sound') startSoundMode();
    if (mode === 'motion') showMotionStub();
    if (mode === 'tap') showScreen('screen-main');
  }

  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.onclick = () => setMode(btn.dataset.mode);
  }

  function showMotionStub() {
    showScreen('screen-motion-stub');
  }
  $('btnMotionBack').onclick = () => setMode('tap');

  // --- sound mode: mic plumbing --------------------------------------------

  let audioCtx, analyser, magBuf, micTrack;
  const dbBuf = new Float32Array(512);

  async function initMic() {
    if (micTrack) micTrack.stop();
    if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close().catch(() => {});
    // Safari (16.4+) only; everywhere else navigator.audioSession is undefined and this
    // is a no-op. 'play-and-record' is the session type meant for mic use — without it
    // iOS treats the page's capture as a phone call, which stops the user's music.
    // Whether music actually SURVIVES capture is up to iOS, not us; this is the most a
    // web page can ask for.
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    const AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    // If iOS handed us a Bluetooth headset mic, ask for the built-in one instead: the
    // bench mic belongs at the bench, and leaving the AirPods out of the capture path
    // keeps them on the high-quality music profile.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const wantId = pickBuiltInMic(stream.getAudioTracks()[0]?.label, devices);
      if (wantId) {
        const better = await navigator.mediaDevices.getUserMedia({
          audio: { ...AUDIO, deviceId: { exact: wantId } },
        });
        for (const t of stream.getAudioTracks()) t.stop();
        stream = better;
      }
    } catch {
      // keep the stream we were granted — a worse mic beats no mic
    }
    micTrack = stream.getAudioTracks()[0];
    // If the OS ended the track underneath us (seen when granting a second stream kills
    // the first and the re-acquire then throws), fail LOUDLY into fallbackToTap instead
    // of letting readSpectrum feed silence to a calibration that will "succeed" at 0.
    if (!micTrack || micTrack.readyState !== 'live') throw new Error('mic track not live after acquisition');
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    magBuf = new Float64Array(analyser.frequencyBinCount);
  }

  // Called before every entry into SOUND mode and before every calibration
  // (including Recalibrate, which used to skip this check entirely — see
  // micNeedsReacquire/micNeedsResume above).
  async function ensureMicReady() {
    if (micNeedsReacquire(audioCtx?.state, micTrack?.readyState)) {
      await initMic();
    } else if (micNeedsResume(audioCtx.state)) {
      await audioCtx.resume();
    }
  }

  function readSpectrum() {
    analyser.getFloatFrequencyData(dbBuf);
    for (let i = 0; i < dbBuf.length; i++) magBuf[i] = 10 ** (dbBuf[i] / 20);
    return magBuf;
  }

  function fallbackToTap(message) {
    $('soundError').textContent = message;
    $('soundError').style.display = '';
    setMode('tap');
  }

  async function startSoundMode() {
    $('soundError').style.display = 'none';
    try {
      await ensureMicReady();
    } catch {
      fallbackToTap('Microphone access was denied or unavailable — using TAP mode instead.');
      return;
    }
    if (state.calibration) {
      runDetectionLoop();
    } else {
      showScreen('screen-calibrate-start');
    }
  }

  $('btnCalibrateStart').onclick = () => runCalibration();
  $('btnRecalibrate').onclick = () => runCalibration();

  async function runCalibration() {
    // Recalibrate is reachable straight from the counting screen, bypassing
    // setMode()'s loop teardown — stop any live detection loop first so it
    // doesn't keep bumping the count from a stale detector underneath the
    // calibration screens.
    if (stopSoundLoop) { stopSoundLoop(); stopSoundLoop = null; }
    try {
      await ensureMicReady();
    } catch {
      fallbackToTap('Microphone access was denied or unavailable — using TAP mode instead.');
      return;
    }

    // 1. noise floor (1.5s)
    showScreen('screen-noise');
    let noiseFluxSum = 0, noiseFrames = 0, prevFrame = null;
    const noiseStart = performance.now();
    await new Promise((resolve) => {
      function tick() {
        const elapsed = performance.now() - noiseStart;
        $('noiseCountdown').textContent = Math.max(0, Math.ceil((1500 - elapsed) / 1000));
        const spec = readSpectrum();
        if (prevFrame) {
          let flux = 0;
          for (let i = 0; i < spec.length; i++) flux += Math.max(0, spec[i] - prevFrame[i]);
          noiseFluxSum += flux;
          noiseFrames++;
        }
        prevFrame = Float64Array.from(spec);
        if (elapsed < 1500) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    const noiseFloor = noiseFrames > 0 ? noiseFloorFromRoom(noiseFluxSum / noiseFrames) : 0;

    // 2. tap 3-5 times
    showScreen('screen-tap');
    const dotsEl = $('tapDots');
    dotsEl.innerHTML = '';
    const dots = [];
    for (let i = 0; i < MAX_EXAMPLES; i++) {
      const d = document.createElement('div');
      d.className = 'dot';
      dotsEl.appendChild(d);
      dots.push(d);
    }
    $('btnCalDone').style.display = 'none';
    $('btnCalDone').disabled = true;
    $('btnCalRestart').style.display = 'none';

    const examples = [];
    let doneClicked = false;
    $('btnCalDone').onclick = () => { doneClicked = true; };
    const tapDetector = createDetector({ centroid: null, noiseFloor, sensitivity: 0.5, refractoryMs: 250 });
    // One cough into the mic used to poison a calibration you could not abort — the only
    // exit was to finish the flow and Recalibrate (owner, 2026-08-20). Start over wipes
    // the captured examples and keeps going; the noise floor is NOT re-measured (same
    // room, seconds later — speed is the point of the button).
    $('btnCalRestart').onclick = () => {
      discardCapture(tapDetector, examples);
      doneClicked = false;
      for (const d of dots) d.classList.remove('filled');
      $('btnCalDone').style.display = 'none';
      $('btnCalDone').disabled = true;
      $('btnCalRestart').style.display = 'none';
    };
    await new Promise((resolve) => {
      function tick() {
        const spec = readSpectrum();
        const result = tapDetector.feed(spec, performance.now());
        if (result) {
          // The event carries its own fingerprint, built from the frames the detector
          // actually judged. Re-fingerprinting `spec` here would capture whatever frame
          // happened to be current when the decision surfaced, not the sound.
          examples.push(result.fingerprint);
          dots[examples.length - 1].classList.add('filled');
          $('btnCalRestart').style.display = '';
        }
        const step = calibrationStep(examples.length, doneClicked);
        if (step.canFinish) {
          $('btnCalDone').style.display = '';
          $('btnCalDone').disabled = false;
        }
        if (step.finished) { resolve(); return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    // 3. consistency check
    let cal = calibrate(examples);
    showScreen('screen-check');
    const SPREAD_BOUND = 0.25;
    if (cal.spread > SPREAD_BOUND) {
      $('checkTitle').textContent = 'Your taps were inconsistent';
      $('checkDetail').textContent = `Spread ${cal.spread.toFixed(3)} is above what we trust (${SPREAD_BOUND}). Tap the same way each time — same spot, same force — and redo.`;
      $('btnCheckContinue').style.display = 'none';
      $('btnCheckRedo').style.display = '';
      await new Promise((resolve) => { $('btnCheckRedo').onclick = resolve; });
      return runCalibration();
    }
    $('checkTitle').textContent = 'Calibration looks consistent';
    $('checkDetail').textContent = `Spread ${cal.spread.toFixed(3)}, from ${examples.length} example${examples.length === 1 ? '' : 's'}.`;
    $('btnCheckRedo').style.display = 'none';
    $('btnCheckContinue').style.display = '';
    await new Promise((resolve) => { $('btnCheckContinue').onclick = resolve; });

    // 4. room check — listen 5s. It already existed to warn the worker that the room
    // contains sounds like theirs; now it does a second job. Nobody is supposed to be
    // tapping during it, so everything it REJECTS is a sound the room makes that we are
    // not counting — exactly the negative examples the matcher needs. Nothing extra is
    // asked of the worker. calibrate() throws away any candidate that looks like the
    // calibrated sound, so a stray tap here cannot teach the app to ignore taps.
    showScreen('screen-room');
    const heardInRoom = [];
    const roomDetector = createDetector({
      centroid: cal.centroid, matchThreshold: cal.matchThreshold, noiseFloor,
      sensitivity: 0.5, refractoryMs: 120,
      onEvent: (ev) => { if (!ev.matched) heardInRoom.push(ev.fingerprint); },
    });
    let roomMatches = 0;
    const roomStart = performance.now();
    await new Promise((resolve) => {
      function tick() {
        const elapsed = performance.now() - roomStart;
        $('roomCountdown').textContent = Math.max(0, Math.ceil((5000 - elapsed) / 1000));
        const spec = readSpectrum();
        if (roomDetector.feed(spec, performance.now())) roomMatches++;
        if (elapsed < 5000) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    cal = calibrate(examples, heardInRoom);

    showScreen('screen-room-report');
    const learned = cal.negatives.length
      ? ` Learned ${cal.negatives.length} background sound${cal.negatives.length === 1 ? '' : 's'} to ignore.`
      : '';
    $('roomReport').textContent = (roomMatches === 0
      ? 'Room is clear — nothing in the background sounded like your tap.'
      : `Heard ${roomMatches} sound${roomMatches === 1 ? '' : 's'} in your room that looked like your tap. This will over-count. Consider a quieter spot or recalibrating.`) + learned;
    await new Promise((resolve) => { $('btnRoomContinue').onclick = resolve; });

    // Plain arrays, not Float64Arrays: JSON.stringify turns a typed array into an
    // object with numeric keys, which happens to still work but only by accident.
    state.calibration = {
      centroid: Array.from(cal.centroid),
      matchThreshold: cal.matchThreshold,
      spread: cal.spread,
      negatives: cal.negatives.map((n) => Array.from(n)),
    };
    state.noiseFloor = noiseFloor;
    persist();
    runDetectionLoop();
  }

  function runDetectionLoop() {
    showScreen('screen-main');
    const cal = state.calibration;
    const soundSettings = state.settings.sound;
    let lastFrameT = 0;
    const detector = createDetector({
      centroid: cal.centroid,
      matchThreshold: cal.matchThreshold,
      negatives: cal.negatives || [],
      noiseFloor: state.noiseFloor,
      sensitivity: soundSettings.sensitivity,
      strictness: soundSettings.strictness,
      refractoryMs: soundSettings.cooldownMs,
      onEvent: (ev) => { if (soundSettings.debug) record(ev); },
    });
    $('sensitivitySlider').value = soundSettings.sensitivity;
    $('strictnessSlider').value = soundSettings.strictness;
    $('cooldownSlider').value = soundSettings.cooldownMs;
    const paintSliderLabels = () => {
      $('sensVal').textContent = sensitivityLabel(soundSettings.sensitivity);
      $('strictVal').textContent = strictnessLabel(soundSettings.strictness);
      $('cooldownVal').textContent = cooldownLabel(soundSettings.cooldownMs);
    };
    paintSliderLabels();
    $('sensitivitySlider').oninput = (e) => {
      soundSettings.sensitivity = parseFloat(e.target.value);
      detector.setSensitivity(soundSettings.sensitivity);
      paintSliderLabels();
      persist();
    };
    $('strictnessSlider').oninput = (e) => {
      soundSettings.strictness = parseFloat(e.target.value);
      detector.setStrictness(soundSettings.strictness);
      paintSliderLabels();
      persist();
    };
    $('cooldownSlider').oninput = (e) => {
      soundSettings.cooldownMs = parseInt(e.target.value, 10);
      detector.setRefractory(soundSettings.cooldownMs);
      paintSliderLabels();
      persist();
    };

    let running = true;
    function loop() {
      if (!running) return;
      const spec = readSpectrum();
      const now = performance.now();
      frameDtMs = lastFrameT ? now - lastFrameT : 0;
      lastFrameT = now;
      if (detector.feed(spec, now)) bump(1);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    stopSoundLoop = () => {
      running = false;
      // The detector defers its decision, so a tap can be mid-judgement right now.
      // Settle it instead of dropping it — otherwise switching modes or hitting
      // Recalibrate an instant after a tap silently loses that count.
      if (detector.flush()) bump(1);
    };
  }

  // --- debug capture ---------------------------------------------------------
  // Every measurement in this repo so far comes from synthesized audio, and the
  // synthesizer decides what a tap and a thud sound like. This is how a real bench
  // gets a vote: record what the detector saw for every onset it COUNTED and every
  // onset it REJECTED, export it, and replay it through tools/harness.mjs. A real
  // recording then becomes a permanent fixture instead of an impression.
  const CAPTURE_LIMIT = 300;
  const capture = [];
  let frameDtMs = 0;

  function record(ev) {
    const round = (arr) => Array.from(arr, (v) => +v.toFixed(6));
    capture.push({
      t: Math.round(ev.t),
      matched: ev.matched,
      distance: ev.distance,
      flux: +ev.flux.toFixed(4),
      threshold: +ev.threshold.toFixed(4),
      dtMs: +frameDtMs.toFixed(2),
      fingerprint: round(ev.fingerprint),
      frames: ev.frames.map(round),
    });
    if (capture.length > CAPTURE_LIMIT) capture.shift();
    $('captureCount').textContent = `${capture.length} event${capture.length === 1 ? '' : 's'}`;
    $('btnExportCapture').disabled = false;
  }

  $('debugToggle').onchange = (e) => {
    state.settings.sound.debug = e.target.checked;
    $('debugRow').style.display = e.target.checked ? '' : 'none';
    persist();
  };

  $('btnExportCapture').onclick = () => {
    const cal = state.calibration || {};
    const blob = new Blob([JSON.stringify({
      capturedAt: new Date().toISOString(),
      matchThreshold: cal.matchThreshold,
      micLabel: micTrack?.label || 'unknown',
      noiseFloor: state.noiseFloor,
      sensitivity: state.settings.sound.sensitivity,
      strictness: state.settings.sound.strictness,
      cooldownMs: state.settings.sound.cooldownMs,
      negatives: cal.negatives || [],
      events: capture,
    })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tally-capture-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // --- wake lock -------------------------------------------------------------

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // best-effort only; no wake lock is a degraded experience, not an error state
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
  requestWakeLock();

  // --- boot --------------------------------------------------------------

  render();
  if (state.mode === 'sound') startSoundMode();
  else if (state.mode === 'motion') showMotionStub();
  else showScreen('screen-main');
}
