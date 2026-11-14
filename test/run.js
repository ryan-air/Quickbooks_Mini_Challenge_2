/*
 * node test/run.js [--verbose]
 *
 * Feeds synthetic stroke data straight into shape.js and scoring.js.
 * IMPORTANT HONESTY NOTE: the "humans" here come from a motion model (sub-movements with
 * bell-shaped velocity, correlated tremor, timing jitter, pauses, lift-offs). They are a
 * stand-in, not people. Thresholds tuned on them still need checking against real strokes
 * (use the Lab's "Export stroke JSON" button and add recordings to test/humans/*.json).
 */
const fs = require('fs'), path = require('path');
const Sc = require('../scoring.js'), Sh = require('../shape.js'), Sy = require('../synth.js');
const verbose = process.argv.includes('--verbose');

// ── simulated human ─────────────────────────────────────────────
function simHuman(poly, rand, o) {
  o = o || {};
  const dev = o.device || 'mouse125';
  const speedF = 0.65 + rand() * 0.9;
  // split at sharp corners into sub-movements
  const rounded = Sy.chaikin(poly, 1, false);
  const moves = []; let cur = [rounded[0]];
  for (let i = 1; i < rounded.length - 1; i++) {
    cur.push(rounded[i]);
    const a = rounded[i - 1], b = rounded[i], c = rounded[i + 1];
    const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    if (cos < 0.3 && cur.length > 4 && rand() < 0.8) { moves.push(cur); cur = [b]; }
  }
  cur.push(rounded[rounded.length - 1]); moves.push(cur);

  const strokes = [];
  let t = 800 + rand() * 500, stroke = null, lastTs = 0;
  const liftEvery = 2 + Math.floor(rand() * 4);
  let ar = { x: 0, y: 0 }, drift = { x: 0, y: 0 };
  const step = dev === 'frame60' || dev === 'touch60' ? 16.67 : 8;
  let tNext = t;
  const evtDt = () => dev === 'frame60' ? 16.67 + rand.gauss() * 1.2 : dev === 'touch60' ? 16.67 + rand.gauss() * 2 : 8 + rand.gauss() * 0.9 + (rand() < 0.04 ? 8 : 0);
  const quant = (ts) => dev === 'frame60' ? Math.round(ts) : Math.round(ts * 10) / 10;

  moves.forEach((mv, mi) => {
    const smooth = Sy.chaikin(mv, 2, false), c = Sy.cumLen(smooth), L = c[c.length - 1];
    if (L < 4) return;
    const D = (250 + 2.4 * Math.pow(L, 0.95) * (0.8 + rand() * 0.5)) / speedF; // ms
    const floor = 0.08 + rand() * 0.15, shape = 0.8 + rand() * 0.5;
    // curvature along the movement -> speed ∝ R^(1/3) (two-thirds power law), on top of a bell profile
    const nS = 60, kap = [];
    for (let k = 0; k < nS; k++) { const a = Sy.pointAt(smooth, c, L * Math.max(0, k - 2) / nS), b = Sy.pointAt(smooth, c, L * k / nS), d = Sy.pointAt(smooth, c, L * Math.min(nS, k + 2) / nS); const ab = Sy.dist(a, b), bc = Sy.dist(b, d), ac = Sy.dist(a, d); const cr = Math.abs((b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x)); kap.push(Math.min(0.2, ab * bc * ac > 0 ? 2 * cr / (ab * bc * ac) : 0)); }
    const pl = (u) => { const k = Math.min(nS - 1, Math.floor(u * nS)); const R = 1 / Math.max(0.004, kap[k]); return Math.pow(R / 60, 1 / 3) * (o.noPowerLaw ? 0 : 1) + (o.noPowerLaw ? 1 : 0); };
    const f = (u) => (floor + (1 - floor) * Math.pow(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, u))), shape)) * Math.min(2.2, Math.max(0.45, pl(u)));
    // pause or lift before this movement
    const lift = mi > 0 && mi % liftEvery === 0;
    if (!stroke || lift) {
      if (stroke) t += 150 + rand() * 450;
      stroke = { pointerType: dev.startsWith('touch') ? 'touch' : 'mouse', trusted: true, points: [] };
      strokes.push(stroke); tNext = t;
    } else if (rand() < 0.25) { t += 130 + rand() * 250; tNext = t; }
    // integrate
    let fm = 0; for (let k = 0; k < 200; k++) fm += f((k + 0.5) / 200); fm /= 200;
    let s = 0, tt = 0;
    while (s < L && tt < D * 3) {
      const u = tt / D, v = (L / D) * f(Math.min(u, 0.999)) / fm;
      // advance in event-sized steps
      const dt = evtDt();
      tt += dt; s += v * dt;
      const p = Sy.pointAt(smooth, c, Math.min(s, L));
      ar.x = 0.82 * ar.x + rand.gauss() * 0.45; ar.y = 0.82 * ar.y + rand.gauss() * 0.45;
      drift.x = 0.985 * drift.x + rand.gauss() * 0.12; drift.y = 0.985 * drift.y + rand.gauss() * 0.12;
      const x = Math.round(p.x + ar.x + drift.x), y = Math.round(p.y + ar.y + drift.y);
      const ts = quant(t + tt);
      if (ts > lastTs) {
        stroke.points.push({ x, y, t: ts, pressure: dev.startsWith('touch') ? 0.3 + rand() * 0.3 : 0.5, tiltX: 0, tiltY: 0, width: dev.startsWith('touch') ? 18 + rand() * 6 : 1, height: dev.startsWith('touch') ? 18 + rand() * 6 : 1 });
        lastTs = ts;
      }
    }
    t += tt;
  });
  return strokes.filter((s) => s.points.length > 2);
}

// ── test set ─────────────────────────────────────────────────────
const poseKeys = Object.keys(Sy.POSES);
const PROMPT_FOR = {
  three: { expectedRaisedFingers: 3, tolerance: 2 }, peace: { expectedRaisedFingers: 2, tolerance: 2 },
  wave: { expectedRaisedFingers: 5, tolerance: 3 }, thumbsUp: { expectedRaisedFingers: 1, tolerance: 2 },
  rockOn: { expectedRaisedFingers: 2, tolerance: 2 }, fist: { expectedRaisedFingers: 0, tolerance: 2 },
  spread: { expectedRaisedFingers: 5, tolerance: 3 }, point: { expectedRaisedFingers: 1, tolerance: 2 },
};
function makeHand(key, rand, sloppy) {
  const [raised, thumb] = Sy.POSES[key]();
  let poly = Sy.handOutline(raised, thumb, rand, sloppy);
  poly = Sy.transform(poly, rand, 0.8 + rand() * 0.35, (rand() - 0.5) * 0.5, (rand() - 0.5) * 60, (rand() - 0.5) * 30);
  return poly;
}
function pct(a, b) { return b ? Math.round(100 * a / b) : 0; }

const devices = ['mouse125', 'frame60', 'touch60'];
const N = 160;
const rows = { human: [], A: [], B: [], C: [] };
const shapeRows = [];
for (let i = 0; i < N; i++) {
  const rand = Sy.rng(1000 + i), key = poseKeys[i % poseKeys.length];
  const sloppy = i % 2 ? 1.6 : 0.6;
  const poly = makeHand(key, rand, sloppy);
  const open = poly.slice(0, poly.length - Math.floor(rand() * 8)); // leave outline slightly open
  const dev = devices[i % devices.length];
  const hs = simHuman(open, rand, { device: dev });
  const sh = Sh.check(hs, PROMPT_FOR[key]);
  const dy = Sc.analyze(hs);
  rows.human.push({ key, dev, shape: sh, dyn: dy });
  shapeRows.push({ key, sh });
  const ba = Sy.botA(poly), bb = Sy.botB(poly), bc = Sy.botC(poly, { rand: Sy.rng(5000 + i) });
  rows.A.push({ key, shape: Sh.check(ba, PROMPT_FOR[key]), dyn: Sc.analyze(ba) });
  rows.B.push({ key, shape: Sh.check(bb, PROMPT_FOR[key]), dyn: Sc.analyze(bb) });
  rows.C.push({ key, shape: Sh.check(bc, PROMPT_FOR[key]), dyn: Sc.analyze(bc) });
}

// negative shape tests
const rand = Sy.rng(99);
const neg = {};
function scribble() { const pts = []; let x = 250, y = 200, t = 0; for (let i = 0; i < 400; i++) { x += (rand() - 0.5) * 70; y += (rand() - 0.5) * 70; x = Math.max(100, Math.min(500, x)); y = Math.max(80, Math.min(380, y)); pts.push({ x, y, t: t += 8 }); } return [{ pointerType: 'mouse', points: pts }]; }
function zigzag() { const pts = []; let t = 0; for (let i = 0; i < 120; i++) pts.push({ x: 120 + (i * 3.5), y: i % 2 ? 150 : 330, t: t += 8 }); return [{ pointerType: 'mouse', points: pts }]; }
function line() { const pts = []; for (let i = 0; i < 100; i++) pts.push({ x: 100 + i * 4, y: 200 + i * 0.8 + rand(), t: i * 8 }); return [{ pointerType: 'mouse', points: pts }]; }
function dot() { return [{ pointerType: 'mouse', points: [{ x: 300, y: 200, t: 0 }, { x: 301, y: 201, t: 8 }] }]; }
function circle() { const pts = []; for (let i = 0; i <= 120; i++) { const a = i / 120 * 6.28; pts.push({ x: 300 + 110 * Math.cos(a) + rand(), y: 225 + 110 * Math.sin(a) + rand(), t: i * 8 }); } return [{ pointerType: 'mouse', points: pts }]; }
function coil() { const pts = []; for (let i = 0; i < 500; i++) { const a = i * 0.35; pts.push({ x: 300 + (40 + i * 0.1) * Math.cos(a), y: 225 + (40 + i * 0.1) * Math.sin(a), t: i * 8 }); } return [{ pointerType: 'mouse', points: pts }]; }
let negFail = 0;
const negResults = {};
for (const [name, fn] of Object.entries({ scribble, zigzag, line, dot, coil })) {
  let rej = 0, tot = 20;
  for (let k = 0; k < tot; k++) { if (!Sh.check(fn(), { expectedRaisedFingers: 3, tolerance: 1 }).pass) rej++; }
  negResults[name] = rej + '/' + tot; if (rej < tot) negFail++;
}
negResults['circle (expects 3 fingers)'] = Sh.check(circle(), { expectedRaisedFingers: 3, tolerance: 1 }).pass ? 'PASSED (bad)' : 'rejected';

// ── report ─────────────────────────────────────────────────────
const shapePass = rows.human.filter((r) => r.shape.pass).length;
const dynPass = rows.human.filter((r) => r.dyn.band === 'pass').length;
const both = rows.human.filter((r) => r.shape.pass && r.dyn.band === 'pass').length;
console.log(`\nSimulated humans: ${N}  (3 devices x 8 poses x 2 sloppiness levels, outlines left slightly open)`);
console.log(`  shape check passes:   ${shapePass}/${N}  (${pct(shapePass, N)}%)`);
console.log(`  dynamics band=pass:   ${dynPass}/${N}  (${pct(dynPass, N)}%)`);
console.log(`  both (final pass):    ${both}/${N}  (${pct(both, N)}%)`);
const retry = rows.human.filter((r) => r.dyn.band === 'retry').length;
console.log(`  dynamics retry/flag:  ${retry} / ${N - dynPass - retry}`);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(`  mean dynamics score:  ${mean(rows.human.map((r) => r.dyn.score)).toFixed(1)}\n`);

console.log('Bots (same hands, fed straight to the scorer, isTrusted=true so ONLY dynamics are tested)');
const table = [];
for (const [k, label] of [['A', '(a) polyline, const speed'], ['B', '(b) spline, const speed'], ['C', '(c) spline, random speed + jitter']]) {
  const r = rows[k];
  const flagged = {}; r.forEach((x) => x.dyn.features.forEach((f) => { if (f.status === 'botLike') flagged[f.id] = (flagged[f.id] || 0) + 1; }));
  const top = Object.entries(flagged).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => `${id} ${pct(n, N)}%`).join(', ');
  table.push({ drawer: label, 'shape ok': pct(r.filter((x) => x.shape.pass).length, N) + '%', 'mean score': mean(r.map((x) => x.dyn.score)).toFixed(1), 'dynamics pass': pct(r.filter((x) => x.dyn.band === 'pass').length, N) + '%', 'retry': pct(r.filter((x) => x.dyn.band === 'retry').length, N) + '%', 'flagged': pct(r.filter((x) => x.dyn.band === 'flag').length, N) + '%', 'top bot-like features': top });
}
const hf = {}; rows.human.forEach((x) => x.dyn.features.forEach((f) => { if (f.status === 'botLike') hf[f.id] = (hf[f.id] || 0) + 1; }));
table.push({ drawer: 'simulated human', 'shape ok': pct(shapePass, N) + '%', 'mean score': mean(rows.human.map((x) => x.dyn.score)).toFixed(1), 'dynamics pass': pct(dynPass, N) + '%', retry: pct(retry, N) + '%', flagged: pct(N - dynPass - retry, N) + '%', 'top bot-like features': Object.entries(hf).map(([id, n]) => `${id} ${pct(n, N)}%`).join(', ') || '-' });
console.table(table);

console.log('Negative shape tests (should be rejected):', negResults);
const s = rows.human.map((r) => r.shape);
console.log('Estimated fingers vs expected (human sims):');
const byPose = {};
shapeRows.forEach(({ key, sh }) => { (byPose[key] = byPose[key] || []).push(sh.estimatedFingers); });
for (const k of poseKeys) console.log(`  ${k.padEnd(9)} expected ${PROMPT_FOR[k].expectedRaisedFingers}  est: ${byPose[k].join(' ')}`);

// untrusted events
const ut = Sy.botC(makeHand('three', Sy.rng(3)), { trusted: false, rand: Sy.rng(3) });
const utr = Sc.analyze(ut);
console.log(`\nUntrusted-event bot (c): score ${utr.score.toFixed(1)} band ${utr.band}`);

// optional real recordings
const dir = path.join(__dirname, 'humans');
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length) {
    console.log(`\nReal recordings in test/humans (${files.length}):`);
    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const strokes = j.strokes || j;
      const a = Sc.analyze(strokes), sh = Sh.check(strokes, null);
      console.log(`  ${f.padEnd(28)} score ${a.score.toFixed(1)} ${a.band}  shape ${sh.pass ? 'ok' : 'x'} fingers~${sh.estimatedFingers}`);
    }
  }
}

if (verbose) {
  const r = rows.human[0];
  console.log('\nFeature detail for one simulated human:');
  r.dyn.features.forEach((f) => console.log(`  ${f.name.padEnd(22)} ${f.score.toFixed(2)} ${f.status.padEnd(9)} ${f.value}`));
  ['A', 'B', 'C'].forEach((k) => { console.log(`\nBot ${k}:`); rows[k][0].dyn.features.forEach((f) => console.log(`  ${f.name.padEnd(22)} ${f.score.toFixed(2)} ${f.status.padEnd(9)} ${f.value}`)); });
}
process.exitCode = 0;
if (process.argv.includes('--dist')) {
  const col = (rs, id) => rs.map((r) => r.dyn.features.find((f) => f.id === id)).filter(Boolean);
  const q = (a, p) => { a = a.slice().sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]; };
  for (const [name, rs] of [['human', rows.human], ['C', rows.C]]) {
    for (const id of ['tremor', 'curvature', 'timestamps', 'speed']) {
      const sc = col(rs, id).map((f) => f.score);
      console.log(name.padEnd(6), id.padEnd(10), 'score p5/p25/p50/p95', [0.05, 0.25, 0.5, 0.95].map((p) => q(sc, p).toFixed(2)).join(' / '));
    }
  }
  const rho = rows.human.map((r) => parseFloat(r.dyn.features.find((f) => f.id === 'tremor').value.split('ratio ')[1])).filter((x) => !isNaN(x));
  const rhoC = rows.C.map((r) => parseFloat(r.dyn.features.find((f) => f.id === 'tremor').value.split('ratio ')[1])).filter((x) => !isNaN(x));
  console.log('rho human p5/p50/p95', [0.05, 0.5, 0.95].map((p) => q(rho, p).toFixed(1)).join(' / '), ' botC', [0.05, 0.5, 0.95].map((p) => q(rhoC, p).toFixed(1)).join(' / '));
  const sl = rows.human.map((r) => parseFloat(r.dyn.features.find((f) => f.id === 'curvature').value.split('slope ')[1])).filter((x) => !isNaN(x));
  console.log('curv slope human p5/p50/p95', [0.05, 0.5, 0.95].map((p) => q(sl, p).toFixed(2)).join(' / '));
  const ink = rows.human.map((r) => r.shape.debug && r.shape.debug.inkRatio).filter(Boolean);
  console.log('inkRatio human p50/max', q(ink, 0.5).toFixed(2), Math.max(...ink).toFixed(2));
}
if (process.argv.includes('--fails')) {
  rows.human.forEach((r, i) => { if (!r.shape.pass) console.log(i, r.key, r.dev, 'est', r.shape.estimatedFingers, r.shape.reasons.join(' | '), r.shape.debug && ('filled=' + r.shape.debug.filled)); });
}
