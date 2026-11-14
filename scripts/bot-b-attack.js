#!/usr/bin/env node
/*
 * bot-b-attack.js — watch "bot B" try to get past Palm Reader, and fail.
 *
 * Opens the page in a real Chrome window and drives the real mouse through the
 * Chrome DevTools Protocol. Those events are *trusted* (same as OS-level automation),
 * so the isTrusted check cannot help: the bot is caught purely on how it draws.
 *
 * Bot B: reads the ghost hand off the pad, smooths it into a spline and traces it
 * at constant speed with perfectly even 16 ms event timing. If the booth asks for
 * "one more try", the bot draws again, like a real script would.
 *
 *   node scripts/bot-b-attack.js               # opens the page, waits for you to press Enter, then the bot attacks
 *   node scripts/bot-b-attack.js --auto        # no waiting: the bot starts straight away
 *   node scripts/bot-b-attack.js --headless    # no window, bot starts straight away, report only
 *   node scripts/bot-b-attack.js --close       # close the window when done
 *
 * Video flow: run it, draw your own hand in the window and get verified, then press Enter
 * in the terminal. The page resets and the bot draws its attempt.
 *
 * Needs Node 22+ (built-in WebSocket) and Chrome/Edge. Set CHROME_PATH if it is not found.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const Sy = require('../synth.js');

const args = new Set(process.argv.slice(2));
const HEADLESS = args.has('--headless'), CLOSE = args.has('--close') || HEADLESS;
const AUTO = args.has('--auto') || (HEADLESS && !args.has('--wait'));   // otherwise wait for Enter first
const readline = require('readline');
const waitForEnter = () => new Promise((ok) => { const rl = readline.createInterface({ input: process.stdin }); rl.once('line', () => { rl.close(); ok(); }); rl.once('close', ok); });
const PORT = 9300 + Math.floor(Math.random() * 500);
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };

function findChrome() {
  const c = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = c.find((p) => p && fs.existsSync(p));
  if (!hit) { console.error('Chrome/Edge not found. Set CHROME_PATH.'); process.exit(1); }
  return hit;
}

// ── minimal CDP client ──────────────────────────────────────────────
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        let id = 0; const pending = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.bad(new Error(d.error.message)) : p.ok(d.result); } };
        const send = (method, params = {}) => new Promise((ok, bad) => { const i2 = ++id; pending.set(i2, { ok, bad }); ws.send(JSON.stringify({ id: i2, method, params })); });
        const evaluate = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
          return r.result.value;
        };
        return { ws, send, evaluate };
      }
    } catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('Could not reach Chrome on the debugging port.');
}

// pad units (600 x 450, tilted pad) -> viewport pixels, computed in the page
const PAD_TO_CLIENT = `(pts) => {
  const pad = document.getElementById('pad'), r = pad.getBoundingClientRect();
  const W = pad.clientWidth, H = pad.clientHeight, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const T = -1.2 * Math.PI / 180, c = Math.cos(T), s = Math.sin(T);
  return pts.map((p) => { const lx = p.x * W / 600 - W / 2, ly = p.y * H / 450 - H / 2; return { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c, t: p.t }; });
}`;

async function drawAttempt(cdp, n) {
  const prompt = await cdp.evaluate('PalmApp.getPrompt().text');
  console.log(`\n${C.bold}Attempt ${n}${C.off}  prompt: "${prompt}"`);
  await cdp.evaluate(`document.getElementById('pad').scrollIntoView({ block: 'center' })`);
  await sleep(400);

  // bot B: read the ghost, spline it, constant speed, even 16 ms ticks
  const ghost = await cdp.evaluate('PalmApp.getGhost()');
  const stroke = Sy.botB(ghost, { t0: 0 })[0].points;
  const pts = await cdp.evaluate(`(${PAD_TO_CLIENT})(${JSON.stringify(stroke)})`);
  console.log(`${C.dim}  tracing ghost hand: ${pts.length} mouse events, one every 16 ms, constant 420 units/s${C.off}`);

  const base = Date.now() / 1000, start = Date.now();
  const mouse = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, timestamp: base + p.t / 1000, ...extra });
  await mouse('mousePressed', pts[0], { clickCount: 1 });
  for (let i = 1; i < pts.length; i++) {
    const wait = start + pts[i].t - Date.now(); if (wait > 0) await sleep(wait);
    await mouse('mouseMoved', pts[i]);
  }
  await mouse('mouseReleased', pts[pts.length - 1], { clickCount: 1 });
  await sleep(300);

  console.log(`${C.dim}  pressing "That's my hand"…${C.off}`);
  await cdp.evaluate(`document.getElementById('doneBtn').click()`);
  for (let i = 0; i < 60 && (await cdp.evaluate('PalmApp.getState()')) !== 'verdict'; i++) await sleep(100);

  return cdp.evaluate(`(() => { const l = PalmApp.getLab(); return {
    kind: l.kind, score: l.combined, first: l.firstScore, shape: l.shape.pass, fingers: l.shape.estimatedFingers,
    verify: document.getElementById('verifyHead').textContent, line: document.getElementById('bubble').textContent,
    features: l.dyn.features.filter((f) => f.applicable).map((f) => ({ name: f.name, status: f.status, value: f.value })) }; })()`);
}

function report(r) {
  const col = r.kind === 'pass' ? C.green : r.kind === 'retry' ? C.yellow : C.red;
  const label = { pass: 'PASSED', retry: 'ONE MORE TRY', flag: 'REJECTED: SUSPICIOUS', shape: 'REJECTED: NOT A HAND' }[r.kind];
  console.log(`  ${col}${C.bold}${label}${C.off}  dynamics ${r.score.toFixed(1)}/100${r.first !== null ? ` (average of ${r.first.toFixed(0)} and this attempt)` : ''} · shape ${r.shape ? 'ok' : 'failed'}`);
  console.log(`  Madame Eyeball: "${r.line}"`);
  console.log(`  Verification bar: ${r.verify}`);
  for (const f of r.features) {
    const tag = f.status === 'botLike' ? `${C.red}bot-like  ${C.off}` : f.status === 'neutral' ? `${C.yellow}neutral   ${C.off}` : `${C.green}human-like${C.off}`;
    console.log(`    ${tag} ${f.name.padEnd(22)} ${C.dim}${f.value}${C.off}`);
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palm-bot-'));
  const chrome = spawn(findChrome(), [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,1000', ...(HEADLESS ? ['--headless=new'] : []), PAGE], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  try {
    const cdp = await connect();
    await cdp.send('Runtime.enable');
    const ready = async () => { for (let i = 0; i < 80; i++) { try { if (await cdp.evaluate('!!window.PalmApp')) return; } catch (e) { /* page is reloading */ } await sleep(100); } };
    await ready();
    console.log(`${C.bold}Bot B vs. Palm Reader${C.off}  ${C.dim}(smooth spline, constant speed, even timing; trusted browser input)${C.off}`);

    if (!AUTO) {
      console.log(`\nThe page is open. Do your human run in the browser window first.\n${C.bold}Press Enter here when you are ready to release the bot…${C.off}`);
      await waitForEnter();
      if ((await cdp.evaluate('PalmApp.getState()')) !== 'landing') {   // fresh page, so nothing from the human run carries over
        await cdp.send('Page.reload'); await sleep(800); await ready();
      }
    }
    await cdp.evaluate(`document.getElementById('startBtn').click()`);
    await sleep(600);
    let r = await drawAttempt(cdp, 1); report(r);
    if (r.kind === 'retry') {                            // a script would happily try again
      await sleep(1500);
      await cdp.evaluate(`document.getElementById('againBtn').click()`);
      await sleep(600);
      r = await drawAttempt(cdp, 2); report(r);
    }
    console.log(r.kind === 'pass' ? `\n${C.green}Bot got through this time.${C.off}` : `\n${C.red}${C.bold}Bot B was turned away.${C.off}`);

    if (!CLOSE) {
      await sleep(1200);
      await cdp.evaluate(`document.getElementById('peekBtn') && document.getElementById('peekBtn').click()`);
      console.log(`${C.dim}Opened "Peek behind the curtain" in the browser. Ctrl+C to close.${C.off}`);
      await new Promise(() => {});
    }
    cdp.ws.close(); cleanup();
    process.exit(r.kind === 'pass' ? 1 : 0);
  } catch (e) { console.error(e.message); cleanup(); process.exit(2); }
})();
