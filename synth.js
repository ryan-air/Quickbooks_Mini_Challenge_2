/*
 * synth.js — synthetic hands and the three built-in "Be the bot" drawers.
 * Used by the Lab panel and by test/run.js. Coordinates are pad units (600 x 450).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PalmSynth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return r;
  }

  // Hand silhouette as a closed polyline. raised = [pinky, ring, middle, index] booleans,
  // thumb = 'out' | 'up' | 'in'. Slightly sloppy when `sloppy` > 0.
  function handOutline(raised, thumb, rand, sloppy) {
    rand = rand || Math.random; sloppy = sloppy || 0;
    const J = (n) => (rand() - 0.5) * 2 * n * sloppy;
    const tops = [185, 140, 120, 150];      // fingertip y per finger (pinky..index)
    const w = 34, gap = 14, x0 = 200, palmTop = 245;
    const P = [];
    const add = (x, y) => P.push({ x: x + J(5), y: y + J(5) });
    add(245, 425); add(245, 345); add(x0, 320); add(x0 - 1, palmTop);
    for (let i = 0; i < 4; i++) {
      const xl = x0 + i * (w + gap), xr = xl + w;
      if (raised[i]) {
        const top = tops[i] + J(14);
        add(xl, palmTop - 30); add(xl, top + 12); add(xl + 3, top + 2); add(xl + w / 2, top - 3); add(xr - 3, top + 2); add(xr, top + 12); add(xr, palmTop - 30);
      } else {
        add(xl + 2, palmTop - 14); add(xl + w / 2, palmTop - 22); add(xr - 2, palmTop - 14);
      }
      add(xr + gap / 2, palmTop + 6);
    }
    const xe = x0 + 4 * (w + gap) - gap;
    if (thumb === 'up') { add(xe + 6, palmTop + 20); add(xe + 16, 150); add(xe + 36, 140); add(xe + 52, 160); add(xe + 40, 280); }
    else if (thumb === 'out') { add(xe + 10, palmTop + 30); add(xe + 60, 215); add(xe + 88, 220); add(xe + 80, 245); add(xe + 40, 300); }
    else { add(xe + 8, palmTop + 25); add(xe + 20, 270); add(xe + 12, 300); }
    add(xe, 335); add(xe - 25, 345); add(xe - 25, 425);
    P.push({ x: P[0].x, y: P[0].y });
    return P;
  }
  // shorthand presets
  const POSES = {
    three: () => [[false, true, true, true], 'in'],
    peace: () => [[false, false, true, true], 'in'],
    wave: () => [[true, true, true, true], 'out'],
    thumbsUp: () => [[false, false, false, false], 'up'],
    rockOn: () => [[true, false, false, true], 'in'],
    fist: () => [[false, false, false, false], 'in'],
    spread: () => [[true, true, true, true], 'out'],
    point: () => [[false, false, false, true], 'in'],
  };

  function transform(poly, rand, scale, rot, dx, dy) {
    const cx = 300, cy = 290, c = Math.cos(rot), s = Math.sin(rot);
    return poly.map((p) => { const x = (p.x - cx) * scale, y = (p.y - cy) * scale; return { x: cx + dx + x * c - y * s, y: cy + dy + x * s + y * c }; });
  }

  // geometry utils
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function chaikin(poly, n, closed) {
    let p = poly;
    for (let k = 0; k < n; k++) {
      const q = [];
      for (let i = 0; i < p.length - (closed ? 0 : 1); i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        q.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
      }
      p = closed ? q : [poly[0]].concat(q, [poly[poly.length - 1]]);
    }
    return p;
  }
  function cumLen(p) { const c = [0]; for (let i = 1; i < p.length; i++) c.push(c[i - 1] + dist(p[i - 1], p[i])); return c; }
  function pointAt(p, c, s) { // position at arc length s
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const seg = c[hi] - c[lo] || 1, f = Math.min(1, Math.max(0, (s - c[lo]) / seg));
    return { x: p[lo].x + (p[hi].x - p[lo].x) * f, y: p[lo].y + (p[hi].y - p[lo].y) * f };
  }

  /*
   * Sample a path at (speedFn(s/L) in units/s). dtFn() gives the next inter-event gap in ms.
   * Returns [{x,y,t,pressure...}]
   */
  function sampleStroke(path, t0, speedFn, dtFn, jitter, rand) {
    const c = cumLen(path), L = c[c.length - 1], out = [];
    let s = 0, t = t0;
    while (s < L) {
      const p = pointAt(path, c, s);
      out.push({ x: p.x + (jitter ? rand.gauss() * jitter : 0), y: p.y + (jitter ? rand.gauss() * jitter : 0), t, pressure: 0.5, tiltX: 0, tiltY: 0, width: 1, height: 1 });
      const dt = dtFn();
      s += Math.max(0.05, speedFn(s / L)) * dt / 1000; t += dt;
    }
    const e = path[path.length - 1];
    out.push({ x: e.x, y: e.y, t, pressure: 0.5, tiltX: 0, tiltY: 0, width: 1, height: 1 });
    return out;
  }

  // (a) straight-line polyline, constant speed, perfectly even timestamps
  function botA(poly, opts) {
    opts = opts || {};
    const pts = sampleStroke(poly, opts.t0 || 1000, () => 420, () => 16, 0, null);
    return [{ pointerType: 'mouse', trusted: opts.trusted !== false, points: pts }];
  }
  // (b) smoothed spline, constant speed, even timestamps
  function botB(poly, opts) {
    opts = opts || {};
    const sp = chaikin(poly, 3, false);
    const pts = sampleStroke(sp, opts.t0 || 1000, () => 420, () => 16, 0, null);
    return [{ pointerType: 'mouse', trusted: opts.trusted !== false, points: pts }];
  }
  // (c) smoothed spline, randomised speed profile, Gaussian jitter on position and time
  function botC(poly, opts) {
    opts = opts || {};
    const rand = opts.rand || rng(opts.seed || 7);
    const sp = chaikin(poly, 3, false);
    const n = 2 + Math.floor(rand() * 2);                // 2-3 strokes with pauses
    const c = cumLen(sp), L = c[c.length - 1];
    const strokes = [];
    let t = opts.t0 || 1000;
    for (let i = 0; i < n; i++) {
      const a = (L * i) / n, b = (L * (i + 1)) / n, seg = [];
      for (let s = a; s <= b; s += 3) seg.push(pointAt(sp, c, s));
      const base = 330 + rand() * 180, ph = rand() * 6.28, ph2 = rand() * 6.28;
      const speed = (u) => base * (0.18 + 0.82 * Math.pow(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, u))), 0.8)) * (1 + 0.25 * Math.sin(ph + u * 11) + 0.15 * Math.sin(ph2 + u * 23));
      const pts = sampleStroke(seg, t, speed, () => Math.max(6, 16 + rand.gauss() * 2.2), 0.8, rand);
      strokes.push({ pointerType: 'mouse', trusted: opts.trusted !== false, points: pts });
      t = pts[pts.length - 1].t + 180 + rand() * 260;
    }
    return strokes;
  }

  return { rng, handOutline, POSES, transform, chaikin, cumLen, pointAt, sampleStroke, botA, botB, botC, dist };
});
