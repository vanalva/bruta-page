/* Latex experiment — shapes + scenes
 *
 * Every shape draws itself into its own design box (0..w, 0..h) in two modes:
 *   'mask'  → grayscale height map (white = presses the membrane the most)
 *   'color' → what the object looks like through the membrane (dark silhouette + faint detail)
 *
 * The engine scales the box so its longest side = 1 and centers it. Shapes never
 * touch the canvas transform; they only draw.
 *
 * Scenes place shapes in uv space (x 0..1 left→right, y 0..1 bottom→top) with
 * `size` as a fraction of the viewport height (longest side of the box).
 */
(function () {
  'use strict';

  const C = {
    bg: '#1a110b',        // behind-layer ground (warm, near black)
    body: '#070403',      // silhouette body
    body2: '#120a06',     // raised details
    detail: '#3b2316',    // light details (screens, labels)
    hole: '#241510',
  };

  function rr(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
  function ell(ctx, cx, cy, rx, ry, rot) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rot || 0, 0, Math.PI * 2);
    ctx.closePath();
  }
  function g(v) { // height → gray
    const k = Math.round(Math.max(0, Math.min(1, v)) * 255);
    return `rgb(${k},${k},${k})`;
  }
  // fill helper: in mask mode use height h, in color mode use color c
  function fill(ctx, mode, h, c) {
    ctx.fillStyle = mode === 'mask' ? g(h) : c;
    ctx.fill();
  }

  const SHAPES = {};

  /* ---- Game Boy (90 × 148) ---- */
  SHAPES.gameboy = {
    w: 90, h: 148,
    draw(ctx, mode) {
      // body: square top corners, big bottom-right corner
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(84, 0); ctx.arcTo(90, 0, 90, 6, 6);
      ctx.lineTo(90, 122); ctx.arcTo(90, 148, 64, 148, 26);
      ctx.lineTo(6, 148); ctx.arcTo(0, 148, 0, 142, 6);
      ctx.lineTo(0, 6); ctx.arcTo(0, 0, 6, 0, 6); ctx.closePath();
      fill(ctx, mode, 0.80, C.body);
      // screen bezel + screen (recessed)
      rr(ctx, 8, 12, 74, 56, 4); fill(ctx, mode, 0.74, C.body2);
      rr(ctx, 19, 19, 52, 42, 2); fill(ctx, mode, 0.68, C.detail);
      // d-pad (raised)
      rr(ctx, 20, 86, 8, 26, 2); fill(ctx, mode, 1.0, C.body2);
      rr(ctx, 11, 95, 26, 8, 2); fill(ctx, mode, 1.0, C.body2);
      // A / B buttons (raised)
      ell(ctx, 62, 100, 6.5, 6.5); fill(ctx, mode, 1.0, C.body2);
      ell(ctx, 77, 92, 6.5, 6.5); fill(ctx, mode, 1.0, C.body2);
      // select / start
      ctx.save(); ctx.translate(32, 122); ctx.rotate(-0.45);
      rr(ctx, -5, -2, 10, 4, 2); fill(ctx, mode, 0.9, C.body2);
      ctx.translate(16, 0);
      rr(ctx, -5, -2, 10, 4, 2); fill(ctx, mode, 0.9, C.body2);
      ctx.restore();
      // speaker slits
      ctx.save(); ctx.translate(74, 132); ctx.rotate(-0.5);
      for (let i = 0; i < 6; i++) { rr(ctx, i * 4 - 10, -8, 2, 16, 1); fill(ctx, mode, 0.72, C.detail); }
      ctx.restore();
    }
  };

  /* ---- Gamepad (160 × 72) ---- */
  SHAPES.gamepad = {
    w: 160, h: 72,
    draw(ctx, mode) {
      // body
      rr(ctx, 20, 8, 120, 46, 14); fill(ctx, mode, 0.82, C.body);
      // grips
      ell(ctx, 30, 40, 22, 30, 0.35); fill(ctx, mode, 0.82, C.body);
      ell(ctx, 130, 40, 22, 30, -0.35); fill(ctx, mode, 0.82, C.body);
      // d-pad
      rr(ctx, 36, 18, 9, 30, 2); fill(ctx, mode, 1.0, C.body2);
      rr(ctx, 25.5, 28.5, 30, 9, 2); fill(ctx, mode, 1.0, C.body2);
      // buttons
      const b = [[112, 22], [124, 32], [100, 32], [112, 42]];
      b.forEach(([x, y]) => { ell(ctx, x, y, 5.5, 5.5); fill(ctx, mode, 1.0, C.body2); });
      // start / select
      rr(ctx, 68, 30, 10, 4, 2); fill(ctx, mode, 0.9, C.body2);
      rr(ctx, 82, 30, 10, 4, 2); fill(ctx, mode, 0.9, C.body2);
    }
  };

  /* ---- Cassette (100 × 64) ---- */
  SHAPES.cassette = {
    w: 100, h: 64,
    draw(ctx, mode) {
      rr(ctx, 0, 0, 100, 64, 5); fill(ctx, mode, 0.85, C.body);
      rr(ctx, 8, 6, 84, 36, 3); fill(ctx, mode, 0.9, C.body2);           // label
      rr(ctx, 30, 20, 40, 14, 7); fill(ctx, mode, 0.7, C.detail);         // window
      ell(ctx, 36, 27, 6, 6); fill(ctx, mode, 0.55, C.hole);
      ell(ctx, 64, 27, 6, 6); fill(ctx, mode, 0.55, C.hole);
      // bottom trapezoid
      ctx.beginPath(); ctx.moveTo(22, 64); ctx.lineTo(28, 48); ctx.lineTo(72, 48); ctx.lineTo(78, 64); ctx.closePath();
      fill(ctx, mode, 0.78, C.body2);
      ell(ctx, 14, 56, 2.5, 2.5); fill(ctx, mode, 0.6, C.hole);
      ell(ctx, 86, 56, 2.5, 2.5); fill(ctx, mode, 0.6, C.hole);
    }
  };

  /* ---- Hand pressing (110 × 160), palm + 4 fingers + thumb ---- */
  SHAPES.hand = {
    w: 110, h: 160,
    draw(ctx, mode) {
      const tip = (x, y, w, h) => {
        // fingertips press harder than the base
        if (mode === 'mask') {
          const gr = ctx.createLinearGradient(0, y + h, 0, y);
          gr.addColorStop(0, g(0.78)); gr.addColorStop(1, g(1.0));
          ctx.fillStyle = gr;
        } else ctx.fillStyle = C.body;
        rr(ctx, x, y, w, h, w / 2); ctx.fill();
      };
      // palm
      rr(ctx, 24, 72, 68, 78, 26); fill(ctx, mode, 0.84, C.body);
      // fingers
      tip(26, 8, 16, 86);
      tip(44, 0, 16, 96);
      tip(62, 4, 16, 92);
      tip(80, 20, 15, 78);
      // thumb
      ctx.save(); ctx.translate(26, 96); ctx.rotate(0.95);
      tip(-7, -52, 15, 64);
      ctx.restore();
      // knuckle pads
      if (mode === 'mask') {
        [[34, 60], [52, 52], [70, 56], [87, 70]].forEach(([x, y]) => { ell(ctx, x, y, 8, 7); ctx.fillStyle = g(0.9); ctx.fill(); });
      }
    }
  };

  /* ---- Face, frontal (100 × 132) ---- */
  SHAPES.faceFront = {
    w: 100, h: 132,
    draw(ctx, mode) {
      ell(ctx, 50, 62, 44, 58); fill(ctx, mode, 0.72, C.body);           // head
      ell(ctx, 50, 118, 20, 14); fill(ctx, mode, 0.72, C.body);           // chin/jaw blend
      ell(ctx, 50, 44, 34, 10); fill(ctx, mode, 0.84, C.body2);           // brow ridge
      ell(ctx, 28, 72, 11, 9); fill(ctx, mode, 0.82, C.body2);            // cheekbones
      ell(ctx, 72, 72, 11, 9); fill(ctx, mode, 0.82, C.body2);
      // nose: bridge + tip
      if (mode === 'mask') {
        const gr = ctx.createLinearGradient(0, 48, 0, 88);
        gr.addColorStop(0, g(0.86)); gr.addColorStop(1, g(1.0));
        ctx.fillStyle = gr;
      } else ctx.fillStyle = C.body2;
      ctx.beginPath(); ctx.moveTo(50, 46); ctx.quadraticCurveTo(58, 70, 61, 84);
      ctx.quadraticCurveTo(50, 94, 39, 84); ctx.quadraticCurveTo(42, 70, 50, 46); ctx.closePath(); ctx.fill();
      // eye sockets (recessed)
      ell(ctx, 34, 58, 9, 5); fill(ctx, mode, 0.62, C.hole);
      ell(ctx, 66, 58, 9, 5); fill(ctx, mode, 0.62, C.hole);
      // lips
      rr(ctx, 36, 98, 28, 9, 4.5); fill(ctx, mode, 0.88, C.body2);
      // chin point
      ell(ctx, 50, 116, 10, 8); fill(ctx, mode, 0.92, C.body2);
    }
  };

  /* ---- Face, profile looking right (92 × 132) ---- */
  SHAPES.faceProfile = {
    w: 92, h: 132,
    draw(ctx, mode) {
      ctx.beginPath();
      ctx.moveTo(14, 2);
      ctx.quadraticCurveTo(52, -6, 62, 26);     // forehead
      ctx.quadraticCurveTo(66, 40, 60, 48);     // brow
      ctx.quadraticCurveTo(74, 56, 88, 66);     // nose bridge → tip
      ctx.quadraticCurveTo(80, 74, 66, 72);     // under nose
      ctx.quadraticCurveTo(72, 80, 68, 86);     // upper lip
      ctx.quadraticCurveTo(76, 92, 66, 98);     // mouth
      ctx.quadraticCurveTo(74, 106, 66, 116);   // chin
      ctx.quadraticCurveTo(54, 132, 30, 132);   // jaw → neck
      ctx.quadraticCurveTo(10, 120, 4, 90);     // back of head
      ctx.quadraticCurveTo(-6, 40, 14, 2);
      ctx.closePath();
      if (mode === 'mask') {
        const gr = ctx.createRadialGradient(80, 66, 4, 40, 60, 70);
        gr.addColorStop(0, g(1.0)); gr.addColorStop(0.35, g(0.9)); gr.addColorStop(1, g(0.74));
        ctx.fillStyle = gr; ctx.fill();
      } else fill(ctx, mode, 1, C.body);
      // ear
      ell(ctx, 22, 70, 8, 13, -0.2); fill(ctx, mode, 0.8, C.body2);
    }
  };

  /* ---- Organic blob (100 × 100), seeded ---- */
  function blob(seed) {
    return {
      w: 100, h: 100,
      draw(ctx, mode) {
        const pts = [];
        const N = 64;
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          const r = 38 + 7 * Math.sin(a * 3 + seed) + 4 * Math.sin(a * 5 + seed * 2.3) + 3 * Math.cos(a * 2 - seed);
          pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
        }
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i <= N; i++) {
          const p = pts[i % N], q = pts[(i + 1) % N];
          ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
        }
        ctx.closePath();
        if (mode === 'mask') {
          const gr = ctx.createRadialGradient(50, 50, 6, 50, 50, 46);
          gr.addColorStop(0, g(1.0)); gr.addColorStop(1, g(0.7));
          ctx.fillStyle = gr; ctx.fill();
        } else fill(ctx, mode, 1, C.body);
      }
    };
  }
  SHAPES.blob1 = blob(1.3);
  SHAPES.blob2 = blob(4.1);
  SHAPES.blob3 = blob(7.7);

  /* ---- Ring (100 × 100) ---- */
  SHAPES.ring = {
    w: 100, h: 100,
    draw(ctx, mode) {
      ctx.beginPath();
      ctx.arc(50, 50, 48, 0, Math.PI * 2);
      ctx.arc(50, 50, 28, 0, Math.PI * 2, true);
      ctx.closePath();
      fill(ctx, mode, 1.0, C.body);
    }
  };

  /* ---- Cursor arrow (70 × 100), a joke the brand can afford ---- */
  SHAPES.arrow = {
    w: 70, h: 100,
    draw(ctx, mode) {
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, 82); ctx.lineTo(20, 64); ctx.lineTo(34, 100);
      ctx.lineTo(50, 92); ctx.lineTo(36, 58); ctx.lineTo(64, 58); ctx.closePath();
      fill(ctx, mode, 1.0, C.body);
    }
  };

  /* ---- Image object: PNG silhouette (+ optional height map) ----
   * { shape: 'image', src: 'assets/foo.png', heightSrc: 'assets/foo-depth.png' }
   * The engine loads these; draw() is called once the images are ready.
   */
  SHAPES.image = {
    w: 100, h: 100, // overridden by image aspect at load time
    draw() {}
  };

  /* ---- Expressive face (100 × 140), a continuous relief map ----
   * relief: true → in mask mode the gray IS the height (0 = deep, 1 = closest to the sheet),
   * instead of the body/raised/sunk thresholds. Drawn with gradients so every feature blends.
   */
  // pose: mouthOpen 0..1, browRaise -1..1, smile -1..1
  function faceRelief(ctx, mode, pose) {
      const P = Object.assign({ mouthOpen: 0.45, browRaise: 0, smile: 0, lookX: 0, lookY: 0 }, pose);
      const mo = P.mouthOpen, br = P.browRaise, sm = P.smile;
      // looking: the features slide inside the head (up/down, left/right) while the outline stays
      const fx = 9 * P.lookX, fy = -7 * P.lookY;
      // head: forehead wide, jaw narrowing to the chin
      ctx.beginPath();
      ctx.moveTo(50, 0);
      ctx.bezierCurveTo(82, 0, 100, 28, 100, 58);
      ctx.bezierCurveTo(100, 92, 78, 128, 50, 140);
      ctx.bezierCurveTo(22, 128, 0, 92, 0, 58);
      ctx.bezierCurveTo(0, 28, 18, 0, 50, 0);
      ctx.closePath();
      if (mode !== 'mask') { ctx.fillStyle = C.body; ctx.fill(); return; }
      ctx.save();
      ctx.clip();
      const rad = (cx, cy, r0, r1, a, b, sx, sy) => {
        ctx.save();
        if (sx || sy) { ctx.translate(cx, cy); ctx.scale(sx || 1, sy || 1); ctx.translate(-cx, -cy); }
        const gr = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
        gr.addColorStop(0, g(a)); gr.addColorStop(1, g(b));
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r1, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
      // face plane, slightly domed: the edges fall away
      rad(50, 66, 10, 70, 0.52, 0.32);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.translate(fx, fy);   // every feature below follows the look
      // forehead
      rad(50, 34, 6, 38, 0.26, 0.0, 1.25, 0.9);
      // brow ridges (raise lifts them and thins them)
      rad(32, 56 - 5 * br, 2, 17, 0.3 - 0.06 * br, 0.0, 1.3, 0.45 - 0.1 * br);
      rad(68, 56 - 5 * br, 2, 17, 0.3 - 0.06 * br, 0.0, 1.3, 0.45 - 0.1 * br);
      // cheekbones
      rad(23, 80, 3, 18, 0.24, 0.0, 1.0, 0.7);
      rad(77, 80, 3, 18, 0.24, 0.0, 1.0, 0.7);
      // nose bridge, then the tip and the wings
      ctx.save();
      const nb = ctx.createLinearGradient(0, 54, 0, 90);
      nb.addColorStop(0, g(0.14)); nb.addColorStop(1, g(0.4));
      ctx.fillStyle = nb;
      ctx.beginPath(); ctx.moveTo(50, 52); ctx.quadraticCurveTo(57, 72, 58, 90); ctx.quadraticCurveTo(50, 96, 42, 90); ctx.quadraticCurveTo(43, 72, 50, 52); ctx.closePath(); ctx.fill();
      ctx.restore();
      rad(50, 88, 2, 11, 0.42, 0.0);
      rad(40, 92, 1, 7, 0.22, 0.0);
      rad(60, 92, 1, 7, 0.22, 0.0);
      // lips: upper bow and lower lip around the mouth; the lower lip and chin drop as it opens,
      // the corners widen with a smile
      const drop = 12 * mo, wide = 1.4 + 0.25 * sm;
      rad(50, 105, 2, 15, 0.22, 0.0, wide, 0.42);
      rad(50, 116 + drop, 2, 13, 0.24, 0.0, 1.3 + 0.2 * sm, 0.5);
      // chin
      rad(50, 129 + drop * 0.6, 2, 13, 0.28, 0.0, 1.1, 0.8);
      // recesses: eye sockets, nostrils, the open mouth, temples
      ctx.globalCompositeOperation = 'multiply';
      rad(33, 64, 2, 12, 0.3, 1.0, 1.4, 0.7);
      rad(67, 64, 2, 12, 0.3, 1.0, 1.4, 0.7);
      rad(44, 95, 0.5, 3.5, 0.5, 1.0);
      rad(56, 95, 0.5, 3.5, 0.5, 1.0);
      rad(50, 110 + drop * 0.5, 2, 10, 0.2 + 0.4 * (1 - mo), 1.0, 1.5 + 0.3 * sm, 0.25 + 0.6 * mo);
      rad(12, 60, 2, 14, 0.75, 1.0, 0.8, 1.2);
      rad(88, 60, 2, 14, 0.75, 1.0, 0.8, 1.2);
      // closed eyelids inside the sockets, a touch raised
      ctx.globalCompositeOperation = 'lighter';
      rad(33, 65, 1, 8, 0.1, 0.0, 1.3, 0.5);
      rad(67, 65, 1, 8, 0.1, 0.0, 1.3, 0.5);
      ctx.restore();
  }

  SHAPES.faceExpressive = {
    w: 100, h: 140, round: 24, relief: true, edgeGray: 0.5,
    draw(ctx, mode) { faceRelief(ctx, mode, { mouthOpen: 0.45, browRaise: 0, smile: 0 }); }
  };

  // the same face, alive: the engine redraws animated shapes every other frame with the time
  SHAPES.faceAnimated = {
    w: 100, h: 140, round: 24, relief: true, edgeGray: 0.5, animated: true,
    pose(t) {
      const s = (f, p) => Math.sin(t * f + (p || 0));
      let mouth = 0.5 + 0.5 * s(0.55, 0.9 * s(0.17));          // slow open / close with holds
      mouth = mouth * mouth * (3 - 2 * mouth);
      if (s(0.071) > 0.93) mouth = Math.max(mouth, 0.5 + 0.5 * s(2.4));   // now and then: a yawn-like gape
      if (s(0.19, 0.7) > 0.8) mouth = Math.max(mouth, 0.4 + 0.4 * s(5.0)); // ...and a quick chatter
      // where it looks: slow sweeps with quicker glances on top (-1..1)
      const lookX = 0.7 * s(0.29, 0.4) + 0.3 * s(1.3, 2.1);
      const lookY = 0.6 * s(0.23, 1.6) + 0.4 * s(0.9, 0.3);
      return {
        mouthOpen: Math.min(1, mouth),
        browRaise: 0.7 * s(0.31, 1.1) + 0.3 * s(0.83) + 0.3 * Math.max(0, lookY),   // looking up lifts the brows
        smile: 0.6 * s(0.23, 2.0),
        lookX, lookY,
      };
    },
    draw(ctx, mode, t, pose) { faceRelief(ctx, mode, pose || this.pose(t || 0)); }
  };

  /* ---- Director: a scripted performance for a cast of objects ----
   * Each beat lasts `d` seconds and sets targets per cast id. Every target is reached through a
   * damped spring (quick, settles, no overshoot to speak of), so moves feel intentional: arrive,
   * look, talk, pull away, a hand, the other hand, come back somewhere else.
   * Targets: press 0..1 · x, y (offsets from the object's placed position, uv) · angle · leanX, leanY
   *          mouth, brow, smile, lookX, lookY (face pose)
   */
  // smooth 1-D noise in -1..1: two octaves of value noise, seeded per channel so nothing moves in lockstep
  function vnoise(x, seed) {
    const i = Math.floor(x), f = x - i;
    const h = n => { const t = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return t - Math.floor(t); };
    const u = f * f * (3 - 2 * f);
    return (h(i) + (h(i + 1) - h(i)) * u) * 2 - 1;
  }
  function wobble(t, seed) { return 0.65 * vnoise(t * 0.45, seed) + 0.35 * vnoise(t * 1.4, seed + 7.3); }

  function director(beats, opts) {
    // springs [k, c]: soft enough to take 0.5–0.9 s, lightly underdamped for a little follow-through;
    // the channels have different speeds so a turn, a gaze and a lean never arrive together
    const K = Object.assign({ press: [16, 6.5], x: [14, 5.2], y: [14, 5.2], angle: [12, 4.6], leanX: [18, 5.8], leanY: [18, 5.8],
                              mouth: [40, 9], brow: [26, 7.5], smile: [20, 7], lookX: [30, 7.5], lookY: [30, 7.5] }, opts && opts.springs);
    // always-on micro-motion per channel (breathing, sway, gaze flicker), scaled by presence
    const N = Object.assign({ press: 0.06, x: 0.012, y: 0.01, angle: 0.035, leanX: 0.12, leanY: 0.1,
                              mouth: 0.08, brow: 0.18, smile: 0.1, lookX: 0.16, lookY: 0.12 }, opts && opts.noise);
    const state = {};          // id → key → { v, vel, target }
    let i = -1, left = 0, seedBase = Math.random() * 100;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = v => Array.isArray(v) ? rnd(v[0], v[1]) : v;
    function ensure(id) {
      if (!state[id]) { state[id] = {}; let n = 0; for (const k in K) state[id][k] = { v: 0, vel: 0, target: 0, seed: seedBase + (id.length * 13) + n++ * 3.7 }; }
      return state[id];
    }
    return {
      update(byId, dt, time) {
        left -= dt;
        if (left <= 0) {
          i = (i + 1) % beats.length;
          const b = beats[i];
          left = b.d * rnd(0.85, 1.5);
          for (const id in b) {
            if (id === 'd') continue;
            const st = ensure(id);
            const arriving = b[id].press != null && st.press.target < 0.15 && pick(b[id].press) > 0.3;
            for (const k in b[id]) if (st[k]) st[k].target = pick(b[id][k]);
            if (arriving) {   // nothing appears in place: it slides in from a little way off
              st.x.v = st.x.target + rnd(-0.09, 0.09); st.y.v = st.y.target + rnd(-0.06, 0.06);
              st.angle.v = st.angle.target + rnd(-0.25, 0.25);
            }
          }
        }
        for (const id in state) {
          const o = byId[id];
          if (!o) continue;
          const st = state[id];
          const presence = Math.max(0, Math.min(1, st.press.v));
          const out = {};
          for (const k in st) {
            const s = st[k], kc = K[k];
            const a = -kc[0] * (s.v - s.target) - kc[1] * s.vel;
            s.vel += a * dt; s.v += s.vel * dt;
            out[k] = s.v + N[k] * (k === 'press' ? presence : 1) * wobble(time, s.seed);
          }
          o.dirPress = Math.max(0, Math.min(1, out.press));
          o.ax = out.x; o.ay = out.y; o.aAngle = out.angle; o.aLeanX = out.leanX; o.aLeanY = out.leanY;
          o.pose = { mouthOpen: Math.max(0, Math.min(1, out.mouth)), browRaise: out.brow, smile: out.smile, lookX: out.lookX, lookY: out.lookY };
        }
      }
    };
  }

  // values in [a, b] are picked at random each time the beat plays; durations get ±random too
  const FACE_SHOW = [
    { d: 1.6, face: { press: [0.7, 0.85], lookX: [-0.2, 0.2], lookY: [-0.1, 0.2], mouth: [0.05, 0.2], brow: 0 } },   // arrives, settles
    { d: 1.3, face: { lookX: [-0.9, -0.6], angle: [-0.16, -0.08], x: [-0.05, -0.02], leanX: [-0.5, -0.3], mouth: [0, 0.15] } },  // looks left
    { d: 0.7, face: { lookX: [-0.3, 0.1], angle: [-0.04, 0.04] } },                                                        // ...back a bit
    { d: 1.4, face: { lookX: [0.6, 0.9], angle: [0.08, 0.16], x: [0.02, 0.05], leanX: [0.3, 0.5] } },                    // looks right
    { d: 1.1, face: { lookX: 0, angle: 0, x: 0, leanX: 0, lookY: [0.6, 0.9], leanY: [0.3, 0.45], brow: [0.6, 0.9] } },  // looks up
    { d: 1.2, face: { mouth: [0.7, 1], lookY: [0, 0.2], leanY: 0, brow: [0.1, 0.4], press: [0.8, 0.9] } },               // opens
    { d: 1.4, face: { mouth: [0.3, 0.5], smile: [0.3, 0.6] } },                                                           // murmurs (noise does the talking)
    { d: 1.0, face: { press: 0, mouth: 0, lookY: [-0.3, 0] } },                                                           // pulls away
    { d: 1.3, handL: { press: [0.45, 0.6], y: [-0.03, 0.03], angle: [0.2, 0.4] } },                                       // a hand, lightly
    { d: 1.1, handL: { press: [0.6, 0.72], y: [0.04, 0.08], angle: [0.3, 0.5], x: [0.0, 0.04] } },                       // pushes a little more, slides
    { d: 1.2, handR: { press: [0.45, 0.6], x: [-0.03, 0.02] }, handL: { press: [0.2, 0.35] } },                            // the other hand, the first eases off
    { d: 1.0, handR: { press: [0.6, 0.7], x: [-0.07, -0.03], y: [-0.05, -0.01] }, handL: { press: 0 } },
    { d: 1.5, face: { press: [0.75, 0.88], x: [-0.02, 0.02], y: [-0.03, 0], mouth: [0.3, 0.6], lookY: [-0.7, -0.4], leanY: [-0.35, -0.2] }, handR: { press: [0.3, 0.45] } },   // the face is back, looking down at the hand
    { d: 1.2, handR: { press: 0 }, handL: { press: [0.5, 0.65], y: [-0.02, 0.02] }, face: { lookX: [-0.5, -0.2] } },
    { d: 1.4, face: { lookX: [-0.9, -0.6], leanX: [-0.5, -0.3], lookY: 0, leanY: 0, mouth: [0.1, 0.3] }, handL: { press: [0.15, 0.3] } },
    { d: 1.2, face: { lookX: [0.6, 0.9], leanX: [0.3, 0.5], brow: [-0.7, -0.4] }, handL: { press: 0 } },
    { d: 1.0, face: { press: 0, lookX: 0, leanX: 0, brow: 0 } },                                                          // gone
    { d: 0.8, face: { x: [0.08, 0.16], y: [0, 0.06] } },                                                                  // moves while away
    { d: 1.3, face: { press: [0.75, 0.9], mouth: [0.7, 0.95], brow: [0.7, 1] } },                                         // reappears elsewhere, surprised
    { d: 1.2, face: { x: [-0.02, 0.02], y: 0, mouth: [0.1, 0.3], brow: [0, 0.3] }, handL: { press: [0.5, 0.65] }, handR: { press: [0.5, 0.65] } },   // both hands
    { d: 1.3, face: { lookY: [0.5, 0.8], leanY: [0.25, 0.4] }, handL: { y: [0.04, 0.08], press: [0.6, 0.7] }, handR: { y: [0.04, 0.08], press: [0.6, 0.7] } },
    { d: 1.1, handL: { press: 0, y: 0 }, handR: { press: 0, y: 0, x: 0 }, face: { lookY: 0, leanY: 0, press: [0.6, 0.75] } },
  ];

  /* ---- Video-derived hands: a sprite sheet of baked height maps (see notes/latex-experiment.md) ----
   * sprite: the sheet; meta: frames/cols/fw/fh/fps. The frames are already height maps (fillet + skirt
   * baked offline), so the engine blits them straight into the atlas every other frame.
   */
  SHAPES.handsVideo = {
    w: 320, h: 168, animated: true,
    sprite: 'assets/hands-ronlach.png', meta: 'assets/hands-ronlach.json',
    draw() {}   // the engine draws sprite frames itself
  };
  /* Generated relief clips (Kling 2.5 from a relief start frame, Magnific Patina height map per
   * frame, silhouette from the clip's orange chroma; bake script lives outside the project). */
  SHAPES.faceVideo = {
    w: 444, h: 250, animated: true,
    sprite: 'assets/face-relief.png', meta: 'assets/face-relief.json',
    draw() {}
  };
  SHAPES.handVideo = {
    w: 444, h: 250, animated: true,
    sprite: 'assets/hand-relief.png', meta: 'assets/hand-relief.json',
    draw() {}
  };

  /* ---- Primitives (the brief's step one: a sphere and a block) ----
   * `round` = edge radius in design-box px. The engine builds the height profile from the
   * silhouette's inside distance: a quarter-round fillet of that radius, so a circle with
   * round = its radius is a hemisphere and a box with a small round is a slab with soft edges.
   */
  SHAPES.sphere = {
    w: 100, h: 100, round: 50,
    draw(ctx, mode) { ell(ctx, 50, 50, 50, 50); fill(ctx, mode, 0.85, C.body); }
  };
  SHAPES.block = {
    w: 110, h: 76, round: 16,
    draw(ctx, mode) { rr(ctx, 0, 0, 110, 76, 14); fill(ctx, mode, 0.85, C.body); }
  };
  SHAPES.pill = {
    w: 140, h: 36, round: 18,
    draw(ctx, mode) { rr(ctx, 0, 0, 140, 36, 18); fill(ctx, mode, 0.85, C.body); }
  };
  // edge roundness for the drawn shapes (design-box px)
  SHAPES.gameboy.round = 7;
  SHAPES.gamepad.round = 12;
  SHAPES.cassette.round = 6;
  SHAPES.hand.round = 9;
  SHAPES.faceFront.round = 30;
  SHAPES.faceProfile.round = 26;
  SHAPES.blob1.round = 22; SHAPES.blob2.round = 22; SHAPES.blob3.round = 22;
  SHAPES.ring.round = 10;
  SHAPES.arrow.round = 6;

  /* ---- Scenes ---- */
  /* Live rigs (live.js): real 3D forms behind the sheet, moved by a tracked human performance.
   * `live` entries: track (tracks/*.json), x, y (uv of the source image centre), size (source image
   * height in viewport heights), angle, flip, plus rig options (gain, pen*, speed, offset). */
  // moving forms: more damping (no ripples travel away from a moving outline) and more substeps (the
  // sheet still keeps up); the skirt width (tension / flat) is the approved default
  const LIVE_PHYSICS = { damping: 0.78, substeps: 5 };
  const SCENES = {
    liveFace: {
      label: 'LIVE · face (tracked motion, real geometry)',
      params: LIVE_PHYSICS,
      objects: [],
      live: [{ track: 'tracks/face-kling.json', x: 0.5, y: 0.5, size: 0.95, penFar: 0.13, penNear: 0.26, gain: 3.6 }],
    },
    liveBoth: {
      label: 'LIVE · face and hand',
      params: LIVE_PHYSICS,
      objects: [],
      live: [
        { track: 'tracks/face-kling.json', x: 0.66, y: 0.5, size: 0.95, penFar: 0.13, penNear: 0.26, gain: 3.6 },
        { track: 'tracks/hand-kling.json', x: 0.30, y: 0.5, size: 0.72, flip: true, offset: 7.5 },
      ],
    },
    liveHand: {
      label: 'LIVE · hand (tracked motion, real geometry)',
      params: LIVE_PHYSICS,
      objects: [],
      live: [{ track: 'tracks/hand-kling.json', x: 0.5, y: 0.5, size: 0.95 }],
    },
    faceClip: {
      label: 'Face (generated relief clip)',
      params: { flat: 0.03, push: 0.9, damping: 0.84, bend: 0.025, tension: 0.22, pinK: 0.3 },
      objects: [
        { shape: 'faceVideo', x: 0.5, y: 0.5, size: 0.8, minPress: 0.78 },
      ]
    },
    handClip: {
      label: 'Hand (generated relief clip)',
      params: { flat: 0.03, push: 0.9, damping: 0.84, bend: 0.025, tension: 0.22, pinK: 0.3 },
      objects: [
        { shape: 'handVideo', x: 0.5, y: 0.5, size: 0.9, minPress: 0.72 },
      ]
    },
    video: {
      label: 'Real hands (from footage)',
      // moving content: the sheet must follow and recover fast, or it trails and rings
      params: { flat: 0.03, push: 0.9, damping: 0.84, bend: 0.025, tension: 0.22, pinK: 0.3 },
      objects: [
        { shape: 'handsVideo', x: 0.5, y: 0.5, size: 1.55, minPress: 0.9 },
      ]
    },
    face: {
      label: 'One living face (performance)',
      objects: [
        { id: 'face',  shape: 'faceAnimated', x: 0.5, y: 0.5, size: 0.8 },
        { id: 'handL', shape: 'hand', x: 0.2, y: 0.5, size: 0.62, angle: 0.3, flip: true },
        { id: 'handR', shape: 'hand', x: 0.8, y: 0.5, size: 0.62, angle: -0.3 },
      ],
      director: () => director(FACE_SHOW),
    },
    primitives: {
      label: 'Primitives: sphere + block',
      objects: [
        { shape: 'sphere', x: 0.36, y: 0.52, size: 0.36 },
        { shape: 'block',  x: 0.64, y: 0.48, size: 0.40, angle: -0.25 },
        { shape: 'pill',   x: 0.50, y: 0.16, size: 0.34, angle: 0.35 },
      ]
    },
    mixed: {
      label: 'Mixed: hand, face, gadgets',
      objects: [
        { shape: 'hand',        x: 0.17, y: 0.58, size: 0.62, angle: -0.35 },
        { shape: 'faceFront',   x: 0.50, y: 0.50, size: 0.66, angle: 0.06 },
        { shape: 'gameboy',     x: 0.82, y: 0.52, size: 0.52, angle: 0.18 },
        { shape: 'cassette',    x: 0.34, y: 0.16, size: 0.30, angle: -0.25 },
        { shape: 'gamepad',     x: 0.66, y: 0.14, size: 0.42, angle: 0.12 },
        { shape: 'blob1',       x: 0.72, y: 0.86, size: 0.30, angle: 0.0 },
        { shape: 'ring',        x: 0.10, y: 0.15, size: 0.22, angle: 0.0 },
        { shape: 'blob2',       x: 0.30, y: 0.88, size: 0.24, angle: 0.8 },
      ]
    },
    faces: {
      label: 'Faces',
      objects: [
        { shape: 'faceProfile', x: 0.22, y: 0.52, size: 0.70, angle: 0.0 },
        { shape: 'faceFront',   x: 0.56, y: 0.48, size: 0.74, angle: -0.05 },
        { shape: 'faceProfile', x: 0.86, y: 0.56, size: 0.58, angle: 0.0, flip: true },
        { shape: 'hand',        x: 0.74, y: 0.14, size: 0.46, angle: 2.6 },
      ]
    },
    gadgets: {
      label: 'Gadgets',
      objects: [
        { shape: 'gameboy',     x: 0.22, y: 0.50, size: 0.62, angle: -0.12 },
        { shape: 'gamepad',     x: 0.58, y: 0.70, size: 0.52, angle: 0.08 },
        { shape: 'cassette',    x: 0.60, y: 0.28, size: 0.40, angle: -0.3 },
        { shape: 'arrow',       x: 0.86, y: 0.50, size: 0.34, angle: -0.4 },
        { shape: 'ring',        x: 0.88, y: 0.16, size: 0.22, angle: 0.0 },
      ]
    },
    organic: {
      label: 'Organic blobs',
      objects: [
        { shape: 'blob1', x: 0.20, y: 0.60, size: 0.50 },
        { shape: 'blob2', x: 0.50, y: 0.40, size: 0.62, angle: 1.1 },
        { shape: 'blob3', x: 0.78, y: 0.62, size: 0.46, angle: 2.0 },
        { shape: 'blob2', x: 0.34, y: 0.14, size: 0.30, angle: 0.4 },
        { shape: 'blob1', x: 0.72, y: 0.18, size: 0.28, angle: 2.4 },
      ]
    },
    empty: {
      label: 'Empty membrane (drag only)',
      objects: []
    },
    // Photographic silhouettes: Magnific generation → background removal → Depth Anything 3,
    // height = inverted depth × alpha with a rounded edge bevel (assets/*-height.png, white = nearest).
    photo: {
      label: 'Photo silhouettes',
      objects: [
        { shape: 'image', src: 'assets/hand.png',    heightSrc: 'assets/hand-height.png',    x: 0.12, y: 0.56, size: 0.60, angle: -0.18 },
        { shape: 'image', src: 'assets/face.png',    heightSrc: 'assets/face-height.png',    x: 0.36, y: 0.58, size: 0.60, angle: 0.04 },
        { shape: 'image', src: 'assets/profile.png', heightSrc: 'assets/profile-height.png', x: 0.62, y: 0.58, size: 0.56, angle: 0.0 },
        { shape: 'image', src: 'assets/gameboy.png', heightSrc: 'assets/gameboy-height.png', x: 0.87, y: 0.60, size: 0.46, angle: 0.14 },
        { shape: 'image', src: 'assets/cat.png',     heightSrc: 'assets/cat-height.png',     x: 0.20, y: 0.21, size: 0.36, angle: 0.0 },
        { shape: 'image', src: 'assets/gamepad.png', heightSrc: 'assets/gamepad-height.png', x: 0.53, y: 0.20, size: 0.38, angle: -0.08 },
        { shape: 'image', src: 'assets/shell.png',   heightSrc: 'assets/shell-height.png',   x: 0.84, y: 0.19, size: 0.30, angle: 0.3 },
      ]
    }
  };

  window.LATEX_SHAPES = SHAPES;
  window.LATEX_SCENES = SCENES;
  window.LATEX_COLORS = C;
})();
