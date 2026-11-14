// Loads app.js against a tiny stub DOM and drives the flow (start → bot → verdict → lab → fallback).
// Not a browser: it catches runtime errors and logic slips, not layout. See README for manual checks.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
function mkEl(id) {
  const el = { id, style: {}, dataset: {}, children: [], _l: {}, innerHTML: '', textContent: '', disabled: false, checked: true, value: '', clientWidth: 600, clientHeight: 450,
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); }, toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }, fire(t, e) { (this._l[t] || []).forEach((f) => f(Object.assign({ preventDefault() {}, isTrusted: true, target: el }, e))); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 450 }; }, focus() {}, scrollIntoView() {}, appendChild() {}, remove() {}, click() { this.fire('click', {}); },
    setPointerCapture() {}, querySelectorAll() { return []; }, offsetWidth: 1,
    getContext() { return new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : typeof t[k] !== 'undefined' ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); } };
  return el;
}
const els = {}; ids.forEach((i) => (els[i] = mkEl(i)));
const botBtns = ['a', 'b', 'c'].map((k) => { const b = mkEl('bot' + k); b.dataset.bot = k; return b; });
const doc = { getElementById: (i) => els[i] || (els[i] = mkEl(i)), querySelectorAll: (s) => (s === '[data-bot]' ? botBtns : s.includes('lamp') ? [mkEl('l1'), mkEl('l2'), mkEl('l3'), mkEl('l4')] : []), createElement: () => mkEl('x'), body: mkEl('body'), addEventListener() {}, activeElement: mkEl('ae'), fonts: { ready: Promise.resolve() } };
let now = 0; const timers = [];
const win = { devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800, matchMedia: () => ({ matches: false }), addEventListener() {}, document: doc, ResizeObserver: class { observe() {} }, navigator: { vibrate() {}, clipboard: { writeText: async () => {} } }, performance: { now: () => now }, requestAnimationFrame: (f) => { timers.push({ t: now + 16, f: () => f(now) }); return 1; }, cancelAnimationFrame() {}, setTimeout: (f, ms) => { timers.push({ t: now + (ms || 0), f }); return timers.length; }, clearTimeout() {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: class {}, Date, Math, JSON, Promise, console };
win.window = win; win.self = win;
const ctx = vm.createContext(Object.assign(win, { document: doc }));
const load = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
['scoring.js', 'shape.js', 'synth.js', 'app.js'].forEach(load);
const run = (ms) => { const end = now + ms; while (true) { timers.sort((a, b) => a.t - b.t); const n = timers[0]; if (!n || n.t > end) break; timers.shift(); now = Math.max(now, n.t); n.f(); } now = end; };

const App = win.PalmApp, log = (...a) => console.log(...a);
log('state at load:', App.getState());
els.startBtn.click(); log('after Insert palm:', App.getState(), '| prompt:', App.getPrompt().text);
for (const kind of ['a', 'b', 'c']) {
  els.trustMask.checked = true;
  botBtns.find((b) => b.dataset.bot === kind).click();
  run(12000);
  const lab = App.getLab();
  log(`bot ${kind}: state=${App.getState()} kind=${lab && lab.kind} score=${lab && lab.combined.toFixed(1)} shape=${lab && lab.shape.pass}`);
  els.againBtn && els.againBtn.fire && 0;
  App.startRound(false);
}
els.trustMask.checked = false;
botBtns[2].click(); run(12000);
log('bot c, untrusted:', App.getLab().kind, App.getLab().combined.toFixed(1));
// human-ish pointer stream through the real handlers
App.startRound(false);
const Sy = win.PalmSynth, rand = Sy.rng(5);
const poly = Sy.transform(Sy.handOutline(...Sy.POSES.peace(), rand, 0.5), rand, 1, 0, 0, 0);
const ink = els.ink; let t = 1000;
ink.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: poly[0].x + 0, clientY: poly[0].y, timeStamp: t, pressure: 0.5 });
poly.forEach((p, i) => { t += 8 + (i % 3); ink.fire('pointermove', { pointerId: 1, clientX: p.x + (i % 2), clientY: p.y, timeStamp: t, pressure: 0.5 }); });
ink.fire('pointerup', { pointerId: 1, type: 'pointerup', clientX: poly[poly.length - 1].x, clientY: poly[poly.length - 1].y, timeStamp: t + 8, pressure: 0 });
log('strokes captured:', App.getStrokes().length, 'points:', App.getStrokes()[0].points.length, 'first pt:', JSON.stringify(App.getStrokes()[0].points[0]).slice(0, 80));
els.doneBtn.click(); run(3000);
log('manual draw verdict:', App.getLab() && App.getLab().kind);
// lab render + export + fallback
els.labLink.click(); run(100); els.exportBtn.click(); run(100); els.replayBtn.click(); run(3000);
log('lab ok, export msg:', els.exportMsg.textContent);
els.fallbackLink.click(); els.beatPlay.click(); run(4000); log('beat: tap enabled =', !els.beatTap.disabled);
[0, 1, 2, 3].forEach((i) => { els.beatTap.fire('click', { timeStamp: 100 + i * 520 + (i * 37) % 60 }); });
log('after beat taps:', els.fbMsg.textContent.slice(0, 60), '| state', App.getState());
console.log('SMOKE OK');
