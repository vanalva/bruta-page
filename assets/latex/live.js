/* Latex live rigs — real geometry behind the sheet, moved by tracked human motion
 *
 * A rig is a 3D form (a face mesh, a hand made of joints and tubes) whose points come from a
 * tracked performance (tools/track.py → tools/bake.py) or from a live tracker (capture.html).
 * Every frame the rig hands the engine triangles as [x, y, h]: x, y in units of the source image
 * height (origin at its centre, y up) and h = how far that point comes through the sheet plane.
 * The engine rasterises them into a height texture (nearest point wins) and the membrane sim
 * treats that texture as one more thing pressing from behind.
 *
 * Nothing here is scripted: positions are played back as tracked. The only authored numbers are
 * where the sheet plane sits relative to the form (`pen*`) and the short fade at the loop seam.
 */
(function () {
  'use strict';

  /* ---------- tracks ---------- */
  class Track {
    constructor(meta, data) {
      this.meta = meta; this.data = data;
      this.n = meta.frames; this.pts = meta.points; this.fps = meta.fps;
      this.duration = (this.n - 1) / this.fps;
      this.inv = 1 / meta.q;
    }
    static async load(url) {
      const meta = await (await fetch(url)).json();
      const buf = await (await fetch(url.replace(/[^/]+$/, '') + meta.bin)).arrayBuffer();
      return new Track(meta, new Int16Array(buf));
    }
    // Catmull-Rom between tracked frames: the bake is 24–30 fps, the page runs at 60+
    sample(t, out) {
      const ft = Math.max(0, Math.min(this.n - 1.0001, t * this.fps));
      const i1 = Math.floor(ft), f = ft - i1;
      const i0 = Math.max(0, i1 - 1), i2 = Math.min(this.n - 1, i1 + 1), i3 = Math.min(this.n - 1, i1 + 2);
      const f2 = f * f, f3 = f2 * f;
      const w0 = -0.5 * f3 + f2 - 0.5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + 0.5 * f, w3 = 0.5 * f3 - 0.5 * f2;
      const S = this.pts * 3, d = this.data, k = this.inv;
      const o0 = i0 * S, o1 = i1 * S, o2 = i2 * S, o3 = i3 * S;
      for (let i = 0; i < S; i++) out[i] = (w0 * d[o0 + i] + w1 * d[o1 + i] + w2 * d[o2 + i] + w3 * d[o3 + i]) * k;
      return out;
    }
    // a per-frame scalar from the meta (e.g. how near the head is), same interpolation, linear
    scalar(arr, t) {
      const ft = Math.max(0, Math.min(this.n - 1.0001, t * this.fps));
      const i = Math.floor(ft), f = ft - i;
      return arr[i] + (arr[Math.min(this.n - 1, i + 1)] - arr[i]) * f;
    }
  }

  function percentile(arr, p) {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
  }
  const smooth01 = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

  /* ---------- Loop subdivision, precomputed as weights ----------
   * The tracked face mesh has 468 points: as flat triangles the nose is a pyramid. One or two
   * levels of Loop subdivision turn it into a smooth surface. The topology never changes, so the
   * subdivision is a fixed list of (source point, weight) per output point, applied every frame. */
  function loopSubdivide(nv, tris) {
    const edgeKey = (a, b) => a < b ? a * 100000 + b : b * 100000 + a;
    const edges = new Map();          // key → { a, b, opp: [] , id }
    const nbrs = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < tris.length; t += 3) {
      const v = [tris[t], tris[t + 1], tris[t + 2]];
      for (let i = 0; i < 3; i++) {
        const a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3];
        const k = edgeKey(a, b);
        let e = edges.get(k);
        if (!e) { e = { a, b, opp: [], id: -1 }; edges.set(k, e); }
        e.opp.push(c);
        nbrs[a].add(b); nbrs[b].add(a);
      }
    }
    const boundary = new Uint8Array(nv), bnbrs = Array.from({ length: nv }, () => []);
    for (const e of edges.values()) if (e.opp.length === 1) { boundary[e.a] = boundary[e.b] = 1; bnbrs[e.a].push(e.b); bnbrs[e.b].push(e.a); }
    const W = [];                     // per output vertex: [idx, w, idx, w, ...]
    for (let i = 0; i < nv; i++) {
      if (nbrs[i].size === 0) { W.push([i, 1]); continue; }
      if (boundary[i] && bnbrs[i].length === 2) { W.push([i, 0.75, bnbrs[i][0], 0.125, bnbrs[i][1], 0.125]); continue; }
      const n = nbrs[i].size;
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      const w = [i, 1 - n * beta];
      for (const j of nbrs[i]) w.push(j, beta);
      W.push(w);
    }
    let id = nv;
    for (const e of edges.values()) {
      e.id = id++;
      if (e.opp.length === 2) W.push([e.a, 0.375, e.b, 0.375, e.opp[0], 0.125, e.opp[1], 0.125]);
      else W.push([e.a, 0.5, e.b, 0.5]);
    }
    const out = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ab = edges.get(edgeKey(a, b)).id, bc = edges.get(edgeKey(b, c)).id, ca = edges.get(edgeKey(c, a)).id;
      out.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    return { nv: id, tris: out, W };
  }
  // compose weight lists: level 2 expressed directly in source points
  function compose(W1, W2) {
    return W2.map(w => {
      const acc = new Map();
      for (let i = 0; i < w.length; i += 2) {
        const src = W1[w[i]], k = w[i + 1];
        for (let j = 0; j < src.length; j += 2) acc.set(src[j], (acc.get(src[j]) || 0) + src[j + 1] * k);
      }
      const o = [];
      for (const [idx, val] of acc) o.push(idx, val);
      return o;
    });
  }
  function packWeights(W) {
    let total = 0;
    for (const w of W) total += w.length / 2;
    const start = new Uint32Array(W.length + 1), idx = new Uint32Array(total), wt = new Float32Array(total);
    let p = 0;
    W.forEach((w, i) => { start[i] = p; for (let j = 0; j < w.length; j += 2) { idx[p] = w[j]; wt[p] = w[j + 1]; p++; } });
    start[W.length] = p;
    return { start, idx, wt, n: W.length };
  }

  /* ---------- base rig: placement, loop, presence ---------- */
  class Rig {
    constructor(def, track) {
      this.def = Object.assign({ x: 0.5, y: 0.5, size: 1, angle: 0, flip: false, speed: 1, offset: 0, fadeIn: 1.1, fadeOut: 1.1, hold: 0.6, away: 0.05 }, def);
      this.track = track;
      this.pts = new Float32Array((track ? track.pts : def.points) * 3);
      this.verts = new Float32Array(0);
      this.count = 0;            // vertices to draw this frame
      this.live = null;          // a live tracker may push points instead of a track
    }
    // where we are in the loop, and how present the form is (0 at the seam: it has left the sheet)
    _clock(time) {
      const T = this.track.duration, d = this.def, period = T + d.hold;
      const t = ((time * d.speed + d.offset) % period + period) % period;
      const pres = smooth01(t / d.fadeIn) * smooth01((T - t) / d.fadeOut);
      return { t: Math.min(t, T), pres };
    }
    _ensure(n) { if (this.verts.length < n * 3) this.verts = new Float32Array(n * 3); }
    // The sheet has mass and spring. How far a form is through it does not follow the performance
    // exactly: it chases it on a lightly damped spring, so a form that arrives overshoots a touch and
    // settles, and one that leaves lets the sheet go with a small rebound. `spring` 0 turns it off.
    _bounce(pen, time) {
      const k = this.def.spring == null ? 1 : this.def.spring;
      const dt = Math.min(0.05, Math.max(0, time - (this._bt == null ? time : this._bt)));
      this._bt = time;
      if (this._bp == null || dt === 0 || k <= 0) { this._bp = pen; this._bv = 0; return pen; }
      const w = 6.2832 * 2.4, z = 0.38;                       // 2.4 beats a second, settles in about two
      let p = this._bp, v = this._bv;
      for (let i = 0; i < 4; i++) { const h = dt / 4; v += (-w * w * (p - pen) - 2 * z * w * v) * h; p += v * h; }
      this._bp = p; this._bv = v;
      return pen + (p - pen) * k;
    }
  }

  /* ---------- face ----------
   * 468 tracked points + what the tracker does not give: a point inside the mouth (so an open mouth
   * is a hollow the sheet sinks into, by as much as the mouth is open) and a ring behind the face's
   * outline (the sides of the head going back, so the outline is a slope and not a cliff). */
  const INNER_LIPS = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

  class FaceRig extends Rig {
    constructor(def, track, meta) {
      super(Object.assign({ gain: 3.2, penFar: 0.17, penNear: 0.30, subdiv: 2, mouthDip: 0.9, back: 0.5, backOut: 0.16, level: 1, pitch: 0, yaw: 0 }, def), track);
      meta = meta || track.meta;
      let tris = meta.tris.slice(), nv = 468;
      // mouth: a fan around a centre point
      this.iMouth = nv++;
      for (let i = 0; i < INNER_LIPS.length; i++) tris.push(INNER_LIPS[i], INNER_LIPS[(i + 1) % INNER_LIPS.length], this.iMouth);
      // outline: every boundary edge gets a quad down to a point further out and further back
      const count = new Map(), key = (a, b) => a < b ? a * 1000 + b : b * 1000 + a;
      for (let t = 0; t < tris.length; t += 3) for (let i = 0; i < 3; i++) { const k = key(tris[t + i], tris[t + (i + 1) % 3]); count.set(k, (count.get(k) || 0) + 1); }
      this.rim = [];             // [source point, new point]
      const rimOf = new Map();
      const rimPoint = v => { if (!rimOf.has(v)) { rimOf.set(v, nv); this.rim.push([v, nv]); nv++; } return rimOf.get(v); };
      const baseTris = tris.length;
      for (let t = 0; t < baseTris; t += 3) for (let i = 0; i < 3; i++) {
        const a = tris[t + i], b = tris[t + (i + 1) % 3];
        if (count.get(key(a, b)) !== 1) continue;
        const ra = rimPoint(a), rb = rimPoint(b);
        tris.push(a, ra, b, b, ra, rb);
      }
      this.nBase = nv;
      this.base = new Float32Array(nv * 3);
      let W = null;
      for (let l = 0; l < this.def.subdiv; l++) {
        const s = loopSubdivide(nv, tris);
        W = W ? compose(W, s.W) : s.W; tris = s.tris; nv = s.nv;
      }
      this.tris = new Uint32Array(tris);
      this.sub = W ? packWeights(W) : null;
      this.fine = new Float32Array(nv * 3);
      this._ensure(this.tris.length);
      this.rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (track) {
        const near = meta.near;
        this.nearLo = percentile(near, 0.12); this.nearHi = percentile(near, 0.97);
        // level: the performer's average facing over the clip becomes "straight at the sheet"; what
        // is left is the real nodding and turning around that average
        const tmp = new Float32Array(468 * 3), n = [0, 0, 0];
        for (let f = 0; f < track.n; f += 2) { track.sample(f / track.fps, tmp); const m = faceNormal(tmp); n[0] += m[0]; n[1] += m[1]; n[2] += m[2]; }
        const l = Math.hypot(n[0], n[1], n[2]); n[0] /= l; n[1] /= l; n[2] /= l;
        this.avgNormal = n;
        const yaw = -Math.atan2(n[0], n[2]) * this.def.level + this.def.yaw;
        const pitch = Math.atan2(n[1], Math.hypot(n[0], n[2])) * this.def.level + this.def.pitch;
        this.rot = rotYX(yaw, pitch);
        // the sheet plane sits against the clip's typical nose-tip depth
        const zs = [];
        for (let f = 0; f < track.n; f += 3) { track.sample(f / track.fps, tmp); this._rotate(tmp, 468); let m = -1e9; for (let i = 2; i < tmp.length; i += 3) if (tmp[i] > m) m = tmp[i]; zs.push(m); }
        this.zRef = percentile(zs, 0.5);
      }
    }
    // rotate points about the face's own centre (x, y of the centre stay put)
    _rotate(P, n) {
      const R = this.rot;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; }
      cx /= n; cy /= n; cz /= n;
      for (let i = 0; i < n; i++) {
        const x = P[i * 3] - cx, y = P[i * 3 + 1] - cy, z = P[i * 3 + 2] - cz;
        P[i * 3] = cx + R[0] * x + R[1] * y + R[2] * z;
        P[i * 3 + 1] = cy + R[3] * x + R[4] * y + R[5] * z;
        P[i * 3 + 2] = cz + R[6] * x + R[7] * y + R[8] * z;
      }
      return [cx, cy, cz];
    }
    update(time) {
      const d = this.def, B = this.base;
      let pen;
      if (this.live) {
        B.set(this.live.pts.subarray(0, 468 * 3));
        pen = this.live.pen; this.zRef = this.live.zRef;
      } else {
        const c = this._clock(time);
        this.track.sample(c.t, this.pts);
        B.set(this.pts);
        const n = (this.track.scalar(this.track.meta.near, c.t) - this.nearLo) / Math.max(1e-6, this.nearHi - this.nearLo);
        pen = d.penFar + (d.penNear - d.penFar) * Math.max(-4, Math.min(1.15, n));
        pen = pen * c.pres - (1 - c.pres) * d.away;
        pen = this._bounce(pen, time);
      }
      const ctr = this._rotate(B, 468);
      this.pen = pen; this.centre = [ctr[0], ctr[1]];
      // face size: forehead to chin, the unit for everything added below
      const S = Math.hypot(B[30] - B[456], B[31] - B[457], B[32] - B[458]);
      // mouth centre, sunk by the opening
      let mx = 0, my = 0, mz = 0;
      for (const i of INNER_LIPS) { mx += B[i * 3]; my += B[i * 3 + 1]; mz += B[i * 3 + 2]; }
      const open = Math.hypot(B[39] - B[42], B[40] - B[43], B[41] - B[44]);      // points 13 and 14
      const o = this.iMouth * 3, k = 1 / INNER_LIPS.length;
      B[o] = mx * k; B[o + 1] = my * k; B[o + 2] = mz * k - d.mouthDip * open;
      // the sides of the head
      for (const [v, r] of this.rim) {
        const x = B[v * 3] - ctr[0], y = B[v * 3 + 1] - ctr[1], l = Math.hypot(x, y) || 1;
        B[r * 3] = B[v * 3] + x / l * d.backOut * S; B[r * 3 + 1] = B[v * 3 + 1] + y / l * d.backOut * S; B[r * 3 + 2] = B[v * 3 + 2] - d.back * S;
      }
      let P = B;
      if (this.sub) {
        const { start, idx, wt, n } = this.sub, F = this.fine;
        for (let i = 0; i < n; i++) {
          let x = 0, y = 0, z = 0;
          for (let j = start[i]; j < start[i + 1]; j++) { const q = idx[j] * 3, w = wt[j]; x += B[q] * w; y += B[q + 1] * w; z += B[q + 2] * w; }
          F[i * 3] = x; F[i * 3 + 1] = y; F[i * 3 + 2] = z;
        }
        P = F;
      }
      const plane = this.zRef - pen, g = d.gain;
      const V = this.verts, T = this.tris;
      for (let i = 0; i < T.length; i++) {
        const q = T[i] * 3;
        V[i * 3] = P[q]; V[i * 3 + 1] = P[q + 1]; V[i * 3 + 2] = (P[q + 2] - plane) * g;
      }
      this.count = T.length;
    }
  }
  // which way the face points: across the cheeks x chin to forehead
  function faceNormal(P) {
    const v = (a, b) => [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const r = v(234, 454), u = v(152, 10);
    const n = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }
  // R = Rx(pitch) . Ry(yaw), row-major
  function rotYX(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy];
  }

  /* ---------- hand: 21 tracked joints → a soft body of round-ended tubes ----------
   * The rig hands the engine a list of tubes (a → b, radius at each end). The engine's SDF pass
   * takes, per pixel, the top of every tube and merges them with a smooth maximum, so the fingers
   * web into the palm and the palm is one fleshy mass instead of a polygon. */
  // radii in palm widths (index knuckle to little-finger knuckle), knuckle → tip
  const FINGERS = [
    { j: [5, 6, 7, 8], r: [0.168, 0.156, 0.146, 0.15] },
    { j: [9, 10, 11, 12], r: [0.174, 0.16, 0.15, 0.154] },
    { j: [13, 14, 15, 16], r: [0.162, 0.15, 0.14, 0.144] },
    { j: [17, 18, 19, 20], r: [0.145, 0.134, 0.126, 0.13] },
    { j: [1, 2, 3, 4], r: [0.26, 0.2, 0.17, 0.165] },            // thumb: its first bone is the ball of the thumb
  ];

  class HandRig extends Rig {
    constructor(def, track, meta) {
      super(Object.assign({ gain: 3.6, pen: 0.17, zScale: 0.34, thick: 1, blend: 0.22, slope: 1.5, palmR: 0.15, grow: 0.2, inset: 0.08, heel: 0.3, squash: 0.62 }, def), track);
      this.sdf = true;
      this.palm = (meta || track.meta).palm;
      this.capA = new Float32Array(18 * 4); this.capB = new Float32Array(18 * 4);
      this.poly = new Float32Array(12); this.palmPlane = new Float32Array(4);
      this.nCaps = 0;
      if (track) {
        const zs = [], tmp = new Float32Array(63);
        for (let f = 0; f < track.n; f += 2) { track.sample(f / track.fps, tmp); let m = -1e9; for (let i = 2; i < 63; i += 3) if (tmp[i] > m) m = tmp[i]; zs.push(m); }
        this.zRef = percentile(zs, 0.5) * this.def.zScale;
      }
    }
    update(time) {
      const d = this.def;
      let pen = d.pen, pres = 1;
      if (this.live) { this.pts.set(this.live.pts); this.palm = this.live.palm; this.zRef = this.live.zRef; pen = this.live.pen; }
      else { const c = this._clock(time); this.track.sample(c.t, this.pts); pres = c.pres; }
      pen = pen * pres - (1 - pres) * d.away;
      if (!this.live) pen = this._bounce(pen, time);
      this.pen = pen; this.centre = [(this.pts[0] + this.pts[27]) / 2, (this.pts[1] + this.pts[28]) / 2];
      const P = this.pts, pw = this.palm * d.thick, zs = d.zScale;
      const A = this.capA, B = this.capB;
      let n = 0;
      for (const f of FINGERS) for (let k = 0; k < 3; k++) {
        const a = f.j[k] * 3, b = f.j[k + 1] * 3, o = n * 4;
        A[o] = P[a]; A[o + 1] = P[a + 1]; A[o + 2] = P[a + 2] * zs; A[o + 3] = f.r[k] * pw;
        B[o] = P[b]; B[o + 1] = P[b + 1]; B[o + 2] = P[b + 2] * zs; B[o + 3] = f.r[k + 1] * pw;
        n++;
      }
      // forearm: leaves the wrist away from the fingers and sinks behind the sheet
      const ax = P[0] - P[27], ay = P[1] - P[28], al = Math.hypot(ax, ay) || 1, ux = ax / al, uy = ay / al;
      {
        const o = n * 4;
        A[o] = P[0]; A[o + 1] = P[1]; A[o + 2] = P[2] * zs; A[o + 3] = 0.2 * pw;
        B[o] = P[0] + ux * pw * 1.8; B[o + 1] = P[1] + uy * pw * 1.8; B[o + 2] = P[2] * zs - pw * 0.7; B[o + 3] = 0.23 * pw;
        n++;
      }
      // the flesh of the palm: the heel pad under the little finger and a pad across the base of the fingers
      const pad = (ja, ta, jb, tb, r) => {
        const o = n * 4, lerp = (j, t, k) => P[k] + (P[j * 3 + k] - P[k]) * t;
        A[o] = lerp(ja, ta, 0); A[o + 1] = lerp(ja, ta, 1); A[o + 2] = lerp(ja, ta, 2) * zs; A[o + 3] = r * pw;
        B[o] = lerp(jb, tb, 0); B[o + 1] = lerp(jb, tb, 1); B[o + 2] = lerp(jb, tb, 2) * zs; B[o + 3] = r * pw;
        n++;
      };
      pad(17, 0.22, 17, 0.72, 0.21);
      pad(5, 0.86, 17, 0.86, 0.165);
      this.nCaps = n;
      // palm outline: the four knuckles, then the heel of the hand as wide as the knuckle row
      let kx = P[51] - P[15], ky = P[52] - P[16]; const kl = Math.hypot(kx, ky) || 1; kx /= kl; ky /= kl;   // index → little knuckle
      const hw = d.heel * pw, Q = this.poly;
      [5, 9, 13, 17].forEach((j, i) => { Q[i * 2] = P[j * 3]; Q[i * 2 + 1] = P[j * 3 + 1]; });
      Q[8] = P[0] + kx * hw; Q[9] = P[1] + ky * hw;
      Q[10] = P[0] - kx * hw; Q[11] = P[1] - ky * hw;
      // pull the outline in and grow it back round: the palm has no corners
      let qx = 0, qy = 0;
      for (let i = 0; i < 6; i++) { qx += Q[i * 2] / 6; qy += Q[i * 2 + 1] / 6; }
      for (let i = 0; i < 6; i++) {
        const dx = Q[i * 2] - qx, dy = Q[i * 2 + 1] - qy, l = Math.hypot(dx, dy) || 1, k = Math.max(0, 1 - d.inset * pw / l);
        Q[i * 2] = qx + dx * k; Q[i * 2 + 1] = qy + dy * k;
      }
      // palm mid-plane through the wrist and the two outer knuckles
      const x1 = P[15] - P[0], y1 = P[16] - P[1], z1 = (P[17] - P[2]) * zs, x2 = P[51] - P[0], y2 = P[52] - P[1], z2 = (P[53] - P[2]) * zs;
      const det = x1 * y2 - x2 * y1;
      let pa = 0, pb = 0;
      if (Math.abs(det) > 1e-7) { pa = (z1 * y2 - z2 * y1) / det; pb = (x1 * z2 - x2 * z1) / det; }
      const lim = 1.2; pa = Math.max(-lim, Math.min(lim, pa)); pb = Math.max(-lim, Math.min(lim, pb));   // edge-on palm: do not let the plane explode
      this.palmPlane[0] = pa; this.palmPlane[1] = pb; this.palmPlane[2] = P[2] * zs - pa * P[0] - pb * P[1]; this.palmPlane[3] = d.palmR * pw;
      this.grow = d.grow * pw;
      const pz = [0, 5, 9, 13, 17].map(j => P[j * 3 + 2] * zs);
      this.palmZ = [Math.min(...pz), Math.max(...pz)];
      this.plane = this.zRef + pw * 0.1 - pen;
      this.k = d.blend * pw;
      this.count = n;
    }
  }

  const cache = {};
  async function loadRig(def) {
    if (def.kind && !def.track) return def.kind === 'face' ? new FaceRig(def, null, def.meta) : new HandRig(def, null, def.meta || { palm: 0.3 });
    const track = cache[def.track] || (cache[def.track] = await Track.load(def.track));
    return track.meta.kind === 'face' ? new FaceRig(def, track) : new HandRig(def, track);
  }

  window.LatexLive = { loadRig, Track, FaceRig, HandRig };
})();
