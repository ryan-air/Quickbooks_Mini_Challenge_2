/*
 * shape.js — lenient "does this look roughly like a hand?" check.
 *
 * Deliberately generous: it exists to reject empty submissions, single lines and
 * scribbles, NOT to grade anybody's drawing skills. The finger count is a crude
 * protrusion count and is only compared against the prompt with a tolerance.
 *
 * Method: rasterise the ink on a 120x90 grid, dilate it a little so open outlines
 * close, flood-fill from the border to get a filled silhouette, then count peaks in
 * the silhouette's radius-vs-angle profile around its centroid ("protrusions").
 * One peak facing away from the others is treated as the wrist and dropped.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PalmShape = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const S = {
    PAD_W: 600, PAD_H: 450,
    MIN_POINTS: 40,
    MIN_INK_LEN_FRAC: 0.8,     // total ink length >= this * min(padW, padH)
    MIN_BBOX_FRAC: 0.08,       // bounding box area >= this fraction of the pad
    LINE_RATIO: 0.06,          // minor/major axis spread below this = a straight line
    MAX_OVERDRAW: 2.4,         // ink length (in cells) / distinct cells touched
    MAX_DENSITY: 0.55,         // dilated ink cells / bbox cells
    MAX_TURNS_PER_100: 4.5,    // sharp turns per 100 units of ink
    GW: 150, GH: 112,
    MAX_INK_RATIO: 3.5,        // ink length / (2 * (bbox w + h)): outline ~1.5, scribbles 6+
    BINS: 90,
    PEAK_PROMINENCE: 0.12,     // fraction of the largest radius
    MIN_FINGERS_TOL: 1,        // tolerance is never tighter than this
  };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function hull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }
  const polyArea = (h) => { let a = 0; for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i].x * h[j].y - h[j].x * h[i].y; } return Math.abs(a) / 2; };

  function check(strokes, prompt, opts) {
    const o = Object.assign({}, S, opts || {});
    const reasons = [];
    const out = { pass: false, confidence: 0, estimatedFingers: 0, reasons, debug: null };
    const pts = [];
    let inkLen = 0;
    for (const s of strokes || []) {
      const p = s.points || [];
      for (let i = 0; i < p.length; i++) { pts.push(p[i]); if (i) inkLen += dist(p[i - 1], p[i]); }
    }
    // 1. minimum effort
    if (pts.length < o.MIN_POINTS) { reasons.push('Hardly any ink on the pad.'); return out; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const bw = maxX - minX, bh = maxY - minY;
    if (inkLen < o.MIN_INK_LEN_FRAC * Math.min(o.PAD_W, o.PAD_H)) reasons.push('Too little ink; a bigger hand, please.');
    if (bw * bh < o.MIN_BBOX_FRAC * o.PAD_W * o.PAD_H) reasons.push('That hand is tiny. Use more of the pad.');
    // 2. not a straight line (PCA spread)
    let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
    const lineRatio = Math.sqrt(l2 / (l1 || 1));
    if (lineRatio < o.LINE_RATIO) reasons.push('That is a line, not a hand.');

    // 3. rasterise
    const GW = o.GW, GH = o.GH, cw = o.PAD_W / GW, ch = o.PAD_H / GH;
    const ink = new Uint8Array(GW * GH), touched = new Uint8Array(GW * GH);
    let touchedCount = 0, cellLen = 0;
    const cell = (x, y) => [Math.min(GW - 1, Math.max(0, Math.floor(x / cw))), Math.min(GH - 1, Math.max(0, Math.floor(y / ch)))];
    for (const s of strokes) {
      const p = s.points || [];
      for (let i = 0; i < p.length; i++) {
        const n = i ? Math.max(1, Math.ceil(dist(p[i - 1], p[i]) / (cw * 0.5))) : 1;
        for (let k = 1; k <= n; k++) {
          const a = i ? p[i - 1] : p[0], b = p[i], f = k / n;
          const [cx, cy] = cell(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
          if (!touched[cy * GW + cx]) { touched[cy * GW + cx] = 1; touchedCount++; }
          ink[cy * GW + cx] = 1;
        }
        if (i) cellLen += dist(p[i - 1], p[i]) / cw;
      }
    }
    // closing chords: join "free" stroke ends (ends not touching other ink) so open outlines can be filled
    const ends = [];
    strokes.forEach((s, si) => { const p = s.points; if (p.length > 1) { ends.push({ p: p[0], si, i: 0 }); ends.push({ p: p[p.length - 1], si, i: p.length - 1 }); } });
    const free = ends.filter((e) => {
      for (let sj = 0; sj < strokes.length; sj++) {
        const q = strokes[sj].points;
        for (let k = 0; k < q.length; k++) {
          if (sj === e.si && Math.abs(k - e.i) < 20) continue;
          if (dist(q[k], e.p) < 12) return false;
        }
      }
      return true;
    });
    const chords = [];
    if (free.length >= 2) {
      const diag = Math.hypot(bw, bh);
      const used = new Set();
      for (let a = 0; a < free.length; a++) {
        if (used.has(a)) continue;
        let best = -1, bd = 0.6 * diag;
        for (let b = 0; b < free.length; b++) if (b !== a && !used.has(b)) { const d = dist(free[a].p, free[b].p); if (d < bd) { bd = d; best = b; } }
        if (best >= 0) { used.add(a); used.add(best); chords.push([free[a].p, free[best].p]); }
      }
    }
    const chordInk = new Uint8Array(GW * GH);
    for (const [a, b] of chords) {
      const n = Math.max(1, Math.ceil(dist(a, b) / (cw * 0.5)));
      for (let k = 0; k <= n; k++) { const [x, y] = cell(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n); chordInk[y * GW + x] = 1; }
    }
    const dilate = (src, r) => {
      const d = new Uint8Array(GW * GH);
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        if (!src[y * GW + x]) continue;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < GW && Y < GH) d[Y * GW + X] = 1;
        }
      }
      return d;
    };
    const both = new Uint8Array(GW * GH); for (let i = 0; i < both.length; i++) both[i] = ink[i] | chordInk[i];
    let dil = dilate(ink, 1), dilCount = 0;
    for (let i = 0; i < dil.length; i++) dilCount += dil[i];
    const bboxCells = Math.max(1, (bw / cw + 3) * (bh / ch + 3));
    const density = dilCount / bboxCells;
    const overdraw = cellLen / Math.max(1, touchedCount);

    // scribble detection: sharp turns per length on a resampled path
    let turns = 0;
    for (const s of strokes) {
      const r = [s.points[0]];
      for (const p of s.points) if (dist(p, r[r.length - 1]) >= 10) r.push(p);
      for (let i = 1; i < r.length - 1; i++) {
        const ax = r[i].x - r[i - 1].x, ay = r[i].y - r[i - 1].y, bx = r[i + 1].x - r[i].x, by = r[i + 1].y - r[i].y;
        if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1) < -0.35) turns++;
      }
    }
    const turnsPer100 = (turns / Math.max(inkLen, 1)) * 100;
    const inkRatio = inkLen / Math.max(1, 2 * (bw + bh));
    const scribble = inkRatio > o.MAX_INK_RATIO || overdraw > o.MAX_OVERDRAW || density > o.MAX_DENSITY || turnsPer100 > o.MAX_TURNS_PER_100;
    if (scribble) reasons.push('That looks like a scribble. Outline a hand, no need to colour it in.');

    // fill silhouette: flood from the border across non-ink cells. Try thin ink first and thicken
    // only if the outline leaks (no enclosed interior), so narrow gaps between fingers survive.
    function fill(barrier) {
      const outside = new Uint8Array(GW * GH), stack = [];
      const push = (x, y) => { if (x < 0 || y < 0 || x >= GW || y >= GH) return; const i = y * GW + x; if (outside[i] || barrier[i]) return; outside[i] = 1; stack.push(i); };
      for (let x = 0; x < GW; x++) { push(x, 0); push(x, GH - 1); }
      for (let y = 0; y < GH; y++) { push(0, y); push(GW - 1, y); }
      while (stack.length) { const i = stack.pop(), x = i % GW, y = (i / GW) | 0; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
      const m = new Uint8Array(GW * GH); let a = 0, sx = 0, sy = 0, inside = 0;
      for (let i = 0; i < m.length; i++) if (!outside[i]) { m[i] = 1; a++; sx += i % GW; sy += (i / GW) | 0; if (!barrier[i]) inside++; }
      return { m, a, cx: sx / Math.max(a, 1), cy: sy / Math.max(a, 1), inside };
    }
    const minInterior = 0.06 * (bw / cw) * (bh / ch);
    let F = null, filled = false;
    for (const r of [0, 1, 2]) {
      F = fill(r === 0 ? both : dilate(both, r));
      if (F.inside >= minInterior) { filled = true; break; }
    }
    const mask = new Uint8Array(GW * GH);
    let area = 0, cx, cy;
    if (filled) { mask.set(F.m); area = F.a; cx = F.cx; cy = F.cy; }
    else { // open drawing: fall back to the ink itself, centred on the ink centroid
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < both.length; i++) if (both[i]) { mask[i] = 1; sx += i % GW; sy += (i / GW) | 0; n++; }
      area = n; cx = sx / Math.max(n, 1); cy = sy / Math.max(n, 1);
    }
    for (let i = 0; i < mask.length; i++) if (both[i]) mask[i] = 1;

    // radius-vs-angle profile
    const B = o.BINS, r = new Array(B).fill(0);
    const bnd = [];
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      if (!mask[y * GW + x]) continue;
      const ang = Math.atan2((y - cy) * ch, (x - cx) * cw), d = Math.hypot((x - cx) * cw, (y - cy) * ch);
      const b = ((Math.round(((ang + Math.PI) / (2 * Math.PI)) * B)) % B + B) % B;
      if (d > r[b]) r[b] = d;
      const edge = x === 0 || y === 0 || x === GW - 1 || y === GH - 1 || !mask[y * GW + x - 1] || !mask[y * GW + x + 1] || !mask[(y - 1) * GW + x] || !mask[(y + 1) * GW + x];
      if (edge) bnd.push({ x: (x + 0.5) * cw, y: (y + 0.5) * ch });
    }
    const rs = r.map((v, i) => (r[(i + B - 1) % B] + v + r[(i + 1) % B]) / 3);
    const rmax = Math.max(...rs, 1);
    const peaks = [];
    for (let i = 0; i < B; i++) {
      const v = rs[i];
      let isMax = true;
      for (let d = 1; d <= 3; d++) if (rs[(i + B - d) % B] > v || rs[(i + d) % B] >= v) { isMax = false; break; }
      if (!isMax) continue;
      let minL = v, minR = v;
      for (let d = 1; d < B / 2; d++) { const w = rs[(i + B - d) % B]; if (w > v) break; minL = Math.min(minL, w); }
      for (let d = 1; d < B / 2; d++) { const w = rs[(i + d) % B]; if (w > v) break; minR = Math.min(minR, w); }
      const prom = v - Math.max(minL, minR);
      if (prom >= o.PEAK_PROMINENCE * rmax && v >= 0.45 * rmax) {
        const ang = (i / B) * 2 * Math.PI - Math.PI;
        peaks.push({ angle: ang, r: v, x: cx * cw + Math.cos(ang) * v, y: cy * ch + Math.sin(ang) * v, prom });
      }
    }
    // drop the wrist: the peak pointing most against the combined direction of the others
    let fingers = peaks.slice();
    if (peaks.length >= 3) {
      let sx = 0, sy = 0; for (const p of peaks) { sx += Math.cos(p.angle); sy += Math.sin(p.angle); }
      const sl = Math.hypot(sx, sy) || 1;
      let worst = -1, worstDot = Infinity;
      peaks.forEach((p, i) => { const dot = (Math.cos(p.angle) * sx + Math.sin(p.angle) * sy) / sl; if (dot < worstDot) { worstDot = dot; worst = i; } });
      if (worst >= 0 && worstDot < -0.1) { out.wrist = peaks[worst]; fingers.splice(worst, 1); }
    } else if (peaks.length === 2) {
      fingers = peaks.slice(0, 1); out.wrist = peaks[1];
    }
    out.estimatedFingers = fingers.length;
    const h = hull(bnd);
    const solidity = h.length > 2 ? Math.min(1, (area * cw * ch) / polyArea(h)) : 1;
    out.debug = { filled, chords: chords.map(([a, b]) => [a, b]), hull: h, tips: fingers, wrist: out.wrist || null, centroid: { x: cx * cw, y: cy * ch }, peaks, solidity, density, overdraw, turnsPer100, inkRatio, lineRatio, inkLen, bbox: { minX, minY, maxX, maxY } };

    // 4. prompt match
    let matched = true;
    if (prompt && prompt.expectedRaisedFingers !== null && prompt.expectedRaisedFingers !== undefined) {
      const tol = Math.max(prompt.tolerance || 0, o.MIN_FINGERS_TOL);
      if (Math.abs(out.estimatedFingers - prompt.expectedRaisedFingers) > tol) {
        matched = false;
        reasons.push(`I counted about ${out.estimatedFingers} finger${out.estimatedFingers === 1 ? '' : 's'}, expected around ${prompt.expectedRaisedFingers}.`);
      }
    }
    out.pass = reasons.length === 0;
    // confidence: 1 minus penalties; informative only
    let conf = 1;
    if (!matched) conf -= 0.35;
    conf -= Math.max(0, density - 0.35) * 0.6;
    conf -= Math.max(0, overdraw - 1.6) * 0.15;
    if (peaks.length === 0 && prompt && prompt.expectedRaisedFingers > 0) conf -= 0.2;
    out.confidence = Math.max(0, Math.min(1, out.pass ? conf : Math.min(conf, 0.45)));
    return out;
  }

  return { check, S, hull };
});
