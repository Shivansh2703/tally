// Drive the REAL app in a real browser end to end, and export a debug capture from it.
// Dev tool, not shipped. Requires Chrome; set CHROME= to point at another binary.
//
//   node tools/fixtures.mjs            # writes the room .wav files this needs
//   node tools/driveapp.mjs loud       # boots the app, calibrates, counts, exports
//   node tools/harness.mjs --replay tools/fixtures/capture-loud.json
//
// Its output is NOT bit-reproducible, unlike tools/harness.mjs. Audio plays in real time
// against requestAnimationFrame, so exactly which onsets land inside the calibration and
// room-check windows shifts a little every run. The count and the fingerprint dimension are
// stable; the number of negatives learned drifts by a few. Do not quote its numbers as exact.
//
// Chrome's --use-file-for-fake-audio-capture is broken on macOS (known Chromium issue;
// verified here: the built-in fake beep produces audio, a valid 48kHz WAV produces
// digital silence). So instead we substitute exactly ONE thing — getUserMedia — and
// feed the fixture through the page's own Web Audio graph. Everything downstream is
// the shipped code: AnalyserNode, the rAF loop, calibration, the room check, the
// negatives harvest, the debug capture.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOM = process.argv[2] || 'quiet';
const OUT = process.argv[3] || `${REPO}/tools/fixtures/capture-${ROOM}.json`;
const PORT = 8331; const CDP = 9343;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = `${REPO}/tools/fixtures/chrome-profile`;

const wavB64 = readFileSync(`${REPO}/tools/fixtures/${ROOM}.wav`).toString('base64');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`,
  '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let ws; let id = 0; const waiting = new Map();
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) {
      ws = new WebSocket(p.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.onmessage = (m) => { const x = JSON.parse(m.data); if (waiting.has(x.id)) { waiting.get(x.id)(x); waiting.delete(x.id); } };
      break;
    }
  } catch {}
  await sleep(250);
}
const send = (method, params = {}) => { const mid = ++id; return new Promise((r) => { waiting.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); }); };
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');

// Injected BEFORE any page script runs, so app.js's first getUserMedia already sees it.
const shim = `
(() => {
  const B64 = "${wavB64}";
  const bytes = Uint8Array.from(atob(B64), c => c.charCodeAt(0));
  window.__tallyStart = null;
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    window.__tallyStart = performance.now();
    window.__tallyAudioCtx = ctx;
    return dest.stream;
  };
  localStorage.setItem('tally-v1-state', JSON.stringify({
    count: 0, history: [], mode: 'tap',
    settings: { sound: { sensitivity: 0.5, cooldownMs: 250, tick: false, debug: true }, tap: { tick: false } },
    calibration: null, noiseFloor: 0,
  }));
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: shim });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(1500);

const screen = () => evaluate(`document.querySelector('.screen.active')?.id || 'none'`);
console.log('booted, screen =', await screen());
await evaluate(`document.querySelector('.mode-btn[data-mode="sound"]').click()`);
await sleep(800);
console.log('after SOUND, screen =', await screen(), '| micStart(ms) =', await evaluate('window.__tallyStart && Math.round(window.__tallyStart)'));
const err = await evaluate(`document.getElementById('soundError').textContent`);
if (err) console.log('soundError:', err);
await evaluate(`document.getElementById('btnCalibrateStart').click()`);

let last = '';
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const s = await screen();
  if (s !== last) { console.log('  screen ->', s); last = s; }
  if (s === 'screen-tap') {
    const dots = await evaluate(`document.querySelectorAll('#tapDots .dot.filled').length`);
    if (dots >= 3) await evaluate(`document.getElementById('btnCalDone').offsetParent && document.getElementById('btnCalDone').click()`);
  }
  if (s === 'screen-check') {
    console.log('    ', await evaluate(`document.getElementById('checkTitle').textContent + ' | ' + document.getElementById('checkDetail').textContent`));
    await evaluate(`document.getElementById('btnCheckContinue').offsetParent && document.getElementById('btnCheckContinue').click()`);
  }
  if (s === 'screen-room-report') {
    console.log('    ', await evaluate(`document.getElementById('roomReport').textContent`));
    await evaluate(`document.getElementById('btnRoomContinue').click()`);
    break;
  }
  await sleep(300);
}

console.log('counting...');
await sleep(20000);

const out = await evaluate(`(() => {
  const st = JSON.parse(localStorage.getItem('tally-v1-state'));
  return {
    count: Number(document.getElementById('countDisplay').textContent),
    stored: st.count,
    matchThreshold: st.calibration && st.calibration.matchThreshold,
    centroidDims: st.calibration && st.calibration.centroid.length,
    negatives: st.calibration && st.calibration.negatives.length,
    captureLabel: document.getElementById('captureCount').textContent,
    exportEnabled: !document.getElementById('btnExportCapture').disabled,
  };
})()`);
console.log('\n=== RESULT (' + ROOM + ') ===');
for (const [k, v] of Object.entries(out)) console.log(String(k).padEnd(16), v);

// Pull the exact payload the Export button would write, and save it so the harness
// can replay it. This is the loop the whole debug-capture feature exists to close.
const payload = await evaluate(`(() => {
  const st = JSON.parse(localStorage.getItem('tally-v1-state'));
  const btn = document.getElementById('btnExportCapture');
  let captured = null;
  const realBlob = window.Blob;
  window.Blob = function (parts, opts) { captured = parts[0]; return new realBlob(parts, opts); };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  btn.click();
  HTMLAnchorElement.prototype.click = realClick;
  window.Blob = realBlob;
  return captured;
})()`);
writeFileSync(OUT, payload);
console.log('exported capture ->', OUT, `(${(payload.length / 1024).toFixed(0)} KB)`);
console.log(`replay it:  node tools/harness.mjs --replay ${OUT}`);
cleanup();
process.exit(0);
