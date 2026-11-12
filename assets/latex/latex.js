/* Latex membrane — WebGL2 engine
 *
 * Two passes per frame:
 *   1. SIM  — ping-pong heightfield (r = height toward camera, g = velocity,
 *             b = contact pressure). Wave equation + damping + a weak pull back
 *             to flat. Objects behind the membrane are one-sided constraints:
 *             where the membrane is below the object's dome it gets pushed out.
 *             The cursor is a soft thumb; a pressed pointer is a pin that holds
 *             the membrane at the finger and drags it laterally.
 *   2. DRAW — latex shading: cream base, pressure tint to orange, thinning
 *             (transparency) where stretched, refraction of the behind layer,
 *             glossy specular, rim, curvature shadow, micro grain.
 *
 * No dependencies. Needs WebGL2 + EXT_color_buffer_float (half float is enough).
 */
(function () {
  'use strict';

  const VERT = `#version 300 es
  precision highp float;
  out vec2 vUv;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const SIM = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uState;
  uniform sampler2D uAtlas;
  uniform vec2  uTexel;
  uniform float uAspect;
  uniform float uDt;
  uniform float uTension;
  uniform float uDamping;
  uniform float uFlat;
  uniform float uPush;
  uniform float uPinK;
  uniform float uVisc;
  uniform float uContactDamp;
  uniform float uBend;
  uniform float uBlendK;     // smooth-max sharpness between overlapping objects (lower = softer junction)
  uniform int   uCount;
  uniform vec4  uObjA[16];   // cx, cy (uv), cellSize (height units), angle
  uniform vec4  uObjB[16];   // press, cellIndex, flip, 0
  uniform vec4  uObjC[16];   // tilt x, tilt y (local box space: the side facing the cursor presses harder), 0, 0
  uniform sampler2D uLive;   // live rigs: height of real geometry coming through the sheet plane
  uniform float uLiveOn;
  uniform vec2  uLiveTexel;
  uniform vec4  uDimple;     // x, y (uv), radius (height units), depth (positive = pressed into the sheet)

  float objectHeight(int i, vec2 uv) {
    vec4 a = uObjA[i]; vec4 b = uObjB[i];
    if (b.x <= 0.0005) return 0.0;
    vec2 p = (uv - a.xy) * vec2(uAspect, 1.0);
    float c = cos(-a.w), s = sin(-a.w);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    vec2 local = p / a.z + 0.5;
    if (b.z > 0.5) local.x = 1.0 - local.x;
    if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return 0.0;
    float cell = b.y;
    vec2 cellXY = vec2(mod(cell, 4.0), floor(cell / 4.0));
    vec2 auv = (cellXY + vec2(local.x, 1.0 - local.y)) / 4.0;
    // tilt: the object leans toward the cursor, so its near side comes out further than its far side
    float k = clamp(1.0 + dot((local - 0.5) * 2.0, uObjC[i].xy), 0.3, 1.7);
    return b.x * k * texture(uAtlas, auv).r;
  }

  void main() {
    vec2 uv = vUv;
    vec4 st = texture(uState, uv);
    float h = st.x, v = st.y;
    vec4 sl = texture(uState, uv - vec2(uTexel.x, 0.0));
    vec4 sr = texture(uState, uv + vec2(uTexel.x, 0.0));
    vec4 sd = texture(uState, uv - vec2(0.0, uTexel.y));
    vec4 su = texture(uState, uv + vec2(0.0, uTexel.y));
    float lap = sl.x + sr.x + su.x + sd.x - 4.0 * h;
    float lapV = sl.y + sr.y + su.y + sd.y - 4.0 * v;   // viscosity: kills contact chatter, keeps the bounce

    // target: what is pressing from behind. Overlapping objects blend with a smooth maximum, so the
    // sheet wraps them as one form instead of creasing along the junction.
    float sumE = 1.0;                     // log-sum-exp with a 1 for the flat sheet: one object alone gives exactly its height
    for (int i = 0; i < 16; i++) {
      if (i >= uCount) break;
      sumE += exp(uBlendK * objectHeight(i, uv)) - 1.0;
    }
    if (uLiveOn > 0.5) {
      // 4 bilinear taps = a small box filter over the 2x live target: no stair-steps on moving outlines
      vec2 o = uLiveTexel * 0.75;
      float lv = 0.25 * (texture(uLive, uv + vec2(-o.x, -o.y)).r + texture(uLive, uv + vec2(o.x, -o.y)).r
                       + texture(uLive, uv + vec2(-o.x, o.y)).r + texture(uLive, uv + vec2(o.x, o.y)).r);
      sumE += exp(uBlendK * lv) - 1.0;
    }
    float T = log(sumE) / uBlendK;
    // the finger presses INTO the sheet: a wide, soft dimple (rubber spreads a point load far);
    // the objects below hold the sheet up, so under the finger they stand out and go orange
    vec2 dd = (uv - uDimple.xy) * vec2(uAspect, 1.0);
    float gd = exp(-dot(dd, dd) / max(uDimple.z * uDimple.z, 1e-5));
    float rest = -uDimple.w * gd;

    float acc = uTension * lap - uFlat * (h - rest) + uVisc * lapV;
    acc += uPinK * gd * (rest - h);
    // one-sided contact as a smooth softplus: a hard on/off per texel turns into texel-scale
    // reaction-diffusion patterns once the tension is low enough to stop smoothing the sheet
    float cw = 0.03;
    float pen = cw * log(1.0 + exp(clamp((T - h) / cw, -30.0, 30.0)));
    acc += uPush * pen;
    v *= mix(1.0, uContactDamp, clamp(pen / cw * 0.5, 0.0, 1.0));

    v = (v + acc * uDt) * uDamping;
    h = h + v * uDt;
    h += uBend * lap;   // bending stiffness: a thick sheet cannot wrinkle at texel scale

    // free edges (the frame is off-screen): clamp-to-edge sampling gives a Neumann boundary, no visible seam

    outColor = vec4(h, v, T, rest);
  }`;

  const DRAW = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uState;
  uniform sampler2D uBehind;
  uniform sampler2D uNoise;
  uniform float uNoiseScale;
  uniform vec2  uSimTexel;
  uniform float uAspect;
  uniform float uTime;
  uniform vec3  uCream;
  uniform vec3  uTint;
  uniform vec3  uSpecColor;
  uniform float uHeightScale;
  uniform float uTintAmt;
  uniform float uThinAmt;
  uniform float uTransl;
  uniform float uRefract;
  uniform float uGloss;
  uniform float uSpecAmt;
  uniform float uGrainAmt;
  uniform float uAmbient;
  uniform float uDiffuse;
  uniform float uRim;
  uniform float uShadow;
  uniform float uGlow;
  uniform float uVignette;
  uniform float uWrap;       // 0 = lambert, 1 = half-lambert wrap (soft, matte)
  uniform vec3  uLight;
  uniform vec3  uShadowTint; // the shadow side of cream silicone is warm, never grey
  uniform vec2  uLightPos;   // where the big soft light sits over the sheet (uv)
  uniform float uFalloff;    // light falloff across the sheet
  uniform vec4  uDrag;       // cx, cy (uv), ex, ey (height units): the material was dragged sideways
  uniform float uDragR;      // height units
  uniform float uDragTint;
  uniform float uPressTint;  // how much of a pressed bowl's depth counts as stretch (0 = none, 1 = all)
  uniform vec4  uSway;       // sx, sy: the whole sheet leans (fundamental mode)
  uniform vec4  uDrum;       // the whole sheet as a trampoline: height (+ = toward the camera), centre x, y (uv), warp
  uniform vec4  uAtm;        // atmosphere: colour bleed amount, bleed radius (height units), halo, cast shadow
  uniform vec4  uAtm2;       // cast shadow length (height units), soft focus, background shade amount, colour curve
  uniform sampler2D uLiveD;  // live forms: r = contact height, g = the form's real depth (negative = behind the sheet)
  uniform float uTintSoft;   // 1 = even colour ramp with no ceiling and no bands; 0 = the original three-stage ramp
  uniform float uThroughBase; // how much of the through colour a form shows before it stretches the sheet at all
  uniform vec4  uThrough;    // amount, fog length (how far behind a form still shows), blur per unit of gap, live on
  uniform float uAtm4;       // 1 = translucency and sheen appear only where the sheet is stretched; 0 = everywhere on a form
  uniform vec2  uAtm3;       // translucent shade (a form's shadow side goes deeper orange, not darker), soft sheen
  uniform vec3  uBgShade;    // what the sheet falls off to, away from the light (a warm taupe, multiplied)
  uniform sampler2D uPaint;  // colour the touch left in the material
  uniform float uPaintAmt;
  uniform vec3  uFilm;       // grain: amount, grain size (device px), frame tick
  uniform vec2  uFilm3;      // stretch (how far the grain is carried by a rising form), bump (how much it catches the light)
  uniform vec3  uFilm2;      // canvas size (px), stick (1 = the grain is in the rubber, 0 = film grain over the picture)
  uniform vec4  uRip[4];     // x, y (uv), age (s), strength (signed: + = toward the camera)
  uniform float uRipGrain;   // how much a passing ripple moves the grain
  uniform vec4  uRipA;       // ring height, speed (height units / s), width, life (s)
  uniform vec4  uRipB;       // pop height, pop frequency (Hz), pop radius, pop life (s)

  // the whole sheet leans toward the touch: a tilt windowed by the fundamental mode of the frame
  float sway(vec2 uv) {
    float win = sin(3.14159 * uv.x) * sin(3.14159 * uv.y);
    return (uSway.x * (uv.x - 0.5) * uAspect + uSway.y * (uv.y - 0.5)) * win * 2.0;
  }

  float hash21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  // film grain: fine, luminance only, re-rolled a few times a second. It belongs to the picture,
  // not to the rubber (the sheet itself stays smooth).
  // Gradient noise (each lattice corner holds a random DIRECTION, not a random brightness). Value
  // noise, used before, is brightest and darkest exactly on its grid, so it reads as soft squares,
  // and stretched it reads as stretched pixels. This has no visible grid.
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a0 = 6.2831853 * hash21(i), a1 = 6.2831853 * hash21(i + vec2(1.0, 0.0));
    float a2 = 6.2831853 * hash21(i + vec2(0.0, 1.0)), a3 = 6.2831853 * hash21(i + vec2(1.0, 1.0));
    float n0 = dot(vec2(cos(a0), sin(a0)), f), n1 = dot(vec2(cos(a1), sin(a1)), f - vec2(1.0, 0.0));
    float n2 = dot(vec2(cos(a2), sin(a2)), f - vec2(0.0, 1.0)), n3 = dot(vec2(cos(a3), sin(a3)), f - vec2(1.0, 1.0));
    return mix(mix(n0, n1, u.x), mix(n2, n3, u.x), u.y);
  }
  // Grain: four sizes of that noise, each layer turned to a different angle so no direction lines up.
  // The two larger sizes matter as much as the fine ones: fine specks alone cannot be FOLLOWED by the
  // eye, so when the sheet carried them they only shimmered and the movement was lost. The broader
  // mottling is what you see slide and stretch.
  float filmGrain(vec2 frag) {
    vec2 p = frag / uFilm.y + uFilm.z * vec2(37.0, 17.0);
    float n = gnoise(p * 1.75) * 0.62
            + gnoise(mat2(0.80, -0.60, 0.60, 0.80) * p * 0.93 + 31.7) * 0.66
            + gnoise(mat2(0.36, 0.93, -0.93, 0.36) * p * 0.42 + 74.3) * 0.80
            + gnoise(mat2(-0.53, 0.85, -0.85, -0.53) * p * 0.19 + 12.9) * 0.85;
    return sign(n) * pow(abs(n) * 1.1, 1.12) * 0.62;
  }

  // The grain of a sheet that is being stretched: s = 0 relaxed, 1 fully stretched. Pulled rubber
  // spreads its grain apart (the fine pattern gives way to one twice the size) and then irons it flat.
  float grainAt(vec2 p, float s) {
    float fine = filmGrain(p);
    float wide = filmGrain(p * 0.5 + 53.0) * 0.8;
    return mix(fine, wide, smoothstep(0.08, 0.55, s)) * (1.0 - 0.88 * smoothstep(0.5, 1.0, s));
  }

  // A click on a tensioned rubber sheet. Not water: water makes many thin rings that crawl outward
  // and last. Rubber is tight and lossy, so (1) the spot that was touched thuds: it overshoots and
  // settles in two or three quick beats, and (2) ONE broad swell runs out fast, widening and dying
  // within a fraction of a second. Both live in the shading only; the sim stays calm.
  float ripple(vec2 uv) {
    float sum = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 e = uRip[i];
      if (e.z < 0.0 || abs(e.w) < 1e-4) continue;
      float t = e.z;
      float r = length((uv - e.xy) * vec2(uAspect, 1.0));
      float on = smoothstep(0.0, 0.035, t);
      // the swell: a single crest with shallow troughs either side, broader as it travels
      float w = uRipA.z * (1.0 + 2.2 * t);
      float x = (r - uRipA.y * t) / w;
      float ring = (1.0 - x * x) * exp(-0.5 * x * x) * exp(-t / uRipA.w) / sqrt(1.0 + r * 3.0);
      // the thud: the touched patch rings like a drum skin, heavily damped
      float pr = r / uRipB.z;
      float pop = exp(-pr * pr) * exp(-t / uRipB.w) * cos(6.28318 * uRipB.y * t);
      sum += e.w * on * (uRipA.x * ring + uRipB.x * pop);
    }
    return sum;
  }

  // THE WHOLE SHEET IS ONE ELASTIC BED. Its lowest mode: the middle moves, the frame holds. A form
  // pushing through lifts all of it a little; when the form lets go the bed swings back past flat and
  // settles in a few slow beats. The bulge leans toward whatever is pushing.
  float drumShape(vec2 uv) {
    float win = sin(3.14159 * clamp(uv.x, 0.0, 1.0)) * sin(3.14159 * clamp(uv.y, 0.0, 1.0));
    vec2 d = (uv - uDrum.yz) * vec2(uAspect, 1.0);
    return win * (0.55 + 0.45 * exp(-dot(d, d) / 0.35));
  }
  float drum(vec2 uv) { return uDrum.x * drumShape(uv); }

  // cubic B-spline reconstruction from 4 bilinear taps (Sigg & Hadwiger)
  float heightCubic(vec2 uv) {
    vec2 res = 1.0 / uSimTexel;
    vec2 coord = uv * res - 0.5;
    vec2 f = fract(coord);
    coord -= f;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1, g1 = w2 + w3;
    vec2 p0 = (coord + 0.5 + w1 / g0 - 1.0) * uSimTexel;
    vec2 p1 = (coord + 0.5 + w3 / g1 + 1.0) * uSimTexel;
    float a = texture(uState, vec2(p0.x, p0.y)).x;
    float b = texture(uState, vec2(p1.x, p0.y)).x;
    float c = texture(uState, vec2(p0.x, p1.y)).x;
    float d = texture(uState, vec2(p1.x, p1.y)).x;
    return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
  }

  void main() {
    vec2 uv = vUv;

    // lateral drag: the material was displaced by u = e * g(r). Its divergence e·∇g is the strain:
    // positive = stretched (thinner, warmer), negative = bunched up (thicker, paler)
    vec2 dS = (uv - uDrag.xy) * vec2(uAspect, 1.0);
    float R2 = max(uDragR * uDragR, 1e-5);
    float gS = exp(-dot(dS, dS) / R2);
    float strain = dot(uDrag.zw, -2.0 * dS / R2 * gS);
    // the skin itself moves: the point on screen shows the material that was dragged here, so the
    // whole render (heights, objects, colour) is sampled through this displacement. Near the grab the
    // material follows the hand fully, far away not at all.
    vec2 uvM = uv - uDrag.zw * vec2(1.0 / uAspect, 1.0) * gS;
    // the bed coming toward the eye carries everything on it outward from its centre (and back in
    // when it sinks): forms, grain and marks all ride the bounce, so the whole picture moves
    uvM -= (uv - uDrum.yz) * drum(uv) * uDrum.w;

    vec4 st = texture(uState, uvM);
    float h = st.x;
    float T = st.z;
    float rest = st.w;
    // cubic B-spline sampling of the heightfield: bilinear has a kinked derivative at every texel
    // boundary, which shows as a lattice in the normals once the sheet is pressed hard
    // soft focus: what is low on the sheet dissolves, what stands proud stays crisp
    float foc = uAtm2.y * (1.0 - smoothstep(0.25, 0.8, max(h, 0.0)));
    vec2 e1 = uSimTexel * 1.5 * (1.0 + 3.0 * foc), e2 = uSimTexel * 3.0;
    // the height around this point (12 taps on two rings): colour scatters inside the silicone, so
    // it follows this wider reading and bleeds a little past the form's own edge
    float hW = h;
    if (uAtm.x > 0.0 || uAtm.z > 0.0) {
      vec2 rr = uAtm.y * vec2(1.0 / uAspect, 1.0);
      float acc = max(h, 0.0) * 2.0;
      for (int i = 0; i < 8; i++) {
        float a = 0.7853982 * float(i) + 0.3;
        acc += max(texture(uState, uvM + rr * vec2(cos(a), sin(a))).x, 0.0);
      }
      for (int i = 0; i < 4; i++) {
        float a = 1.5707963 * float(i);
        acc += max(texture(uState, uvM + rr * 0.5 * vec2(cos(a), sin(a))).x, 0.0) * 1.5;
      }
      hW = acc / 16.0;
    }
    float hc = heightCubic(uvM);
    float hl = heightCubic(uvM - vec2(e1.x, 0.0)) + sway(uv - vec2(e1.x, 0.0)) + ripple(uv - vec2(e1.x, 0.0)) + drum(uv - vec2(e1.x, 0.0));
    float hr = heightCubic(uvM + vec2(e1.x, 0.0)) + sway(uv + vec2(e1.x, 0.0)) + ripple(uv + vec2(e1.x, 0.0)) + drum(uv + vec2(e1.x, 0.0));
    float hd = heightCubic(uvM - vec2(0.0, e1.y)) + sway(uv - vec2(0.0, e1.y)) + ripple(uv - vec2(0.0, e1.y)) + drum(uv - vec2(0.0, e1.y));
    float hu = heightCubic(uvM + vec2(0.0, e1.y)) + sway(uv + vec2(0.0, e1.y)) + ripple(uv + vec2(0.0, e1.y)) + drum(uv + vec2(0.0, e1.y));
    vec2 g = vec2(hr - hl, hu - hd) / (2.0 * e1);         // dh per uv
    g.x /= uAspect;                                       // → per height unit
    g *= uHeightScale;
    float lap = (heightCubic(uvM - vec2(e2.x, 0.0)) + heightCubic(uvM + vec2(e2.x, 0.0))
               + heightCubic(uvM - vec2(0.0, e2.y)) + heightCubic(uvM + vec2(0.0, e2.y)) - 4.0 * hc) / 9.0;

    // micro grain: filtered noise texture, two scales (off by default: silicone is smooth)
    vec2 gp = uv * vec2(uAspect, 1.0);
    vec2 np = gp * uNoiseScale;
    float tx = 1.0 / 256.0;
    float g1 = texture(uNoise, np).r;
    float g2 = texture(uNoise, np * 3.1 + 0.37).g;
    float grain = g1 * 0.65 + g2 * 0.35;
    vec2 gradGrain = vec2(texture(uNoise, np + vec2(tx, 0.0)).r - texture(uNoise, np - vec2(tx, 0.0)).r,
                          texture(uNoise, np + vec2(0.0, tx)).r - texture(uNoise, np - vec2(0.0, tx)).r);
    vec3 nS = normalize(vec3(-g, 1.0));                                   // smooth normal (transmission, refraction)
    // a DIFFUSE reading of the shape (taps six texels out): light that has travelled inside the
    // silicone has forgotten the exact ridge it came in over. Translucency and sheen use this one;
    // read off the crisp normal they switch on along the ridge of a nose or a finger and draw a line.
    vec2 e3 = uSimTexel * 6.0;
    vec2 gD = vec2(heightCubic(uvM + vec2(e3.x, 0.0)) - heightCubic(uvM - vec2(e3.x, 0.0)),
                   heightCubic(uvM + vec2(0.0, e3.y)) - heightCubic(uvM - vec2(0.0, e3.y))) / (2.0 * e3);
    gD.x /= uAspect;
    vec3 nD = normalize(vec3(-gD * uHeightScale, 1.0));
    // THE GRAIN IS IN THE RUBBER. Three things make it belong to the sheet instead of the screen:
    //  - it is read at the material point (uvM), so dragged skin carries it;
    //  - a rising form stretches it: the pattern is pulled outward from every crown, like print on a
    //    balloon, so a face moving behind the sheet visibly drags the grain around with it;
    //  - it is relief, not ink: it tilts the normal, so it is lit and shadowed with the surface.
    // THE SHEET GIVES ALL AROUND A FORM. The slope of a WIDE reading of the height (two rings of
    // taps, out to 0.16 of the viewport height) points at whatever is pushing nearby, also from well
    // outside its outline. The grain is read a little way up that slope, so as a form comes through
    // the pattern spreads away from it, on the form and in the sheet around it, and closes back in
    // when the form leaves. Wide on purpose: a tight field smears the grain into fur on steep edges.
    vec2 wide = vec2(0.0);
    for (int i = 0; i < 8; i++) {
      float a = 0.7853982 * float(i);
      vec2 dir = vec2(cos(a), sin(a));
      // read mostly what is PUSHING (z, gone the moment a form leaves) and only a little of where the
      // sheet still is (x, which takes a second or two to settle flat): read off the sheet alone, the
      // grain trailed back to its place long after the face had gone
      vec2 s1 = texture(uState, uvM + dir * 0.07 * vec2(1.0 / uAspect, 1.0)).xz;
      vec2 s2 = texture(uState, uvM + dir * 0.16 * vec2(1.0 / uAspect, 1.0)).xz;
      wide += dir * (max(mix(s1.x, s1.y, 0.85), 0.0) / 0.07 + max(mix(s2.x, s2.y, 0.85), 0.0) / 0.16);
    }
    wide *= 0.125 * uFilm3.x;                                   // ~ slope of the wide height, times the give
    // the click's swell and thud, and the bed's own bounce, move the grain too: the pattern spreads
    // off a passing crest and closes back behind it. Without this the ripple was light sliding over a
    // texture that did not notice.
    float rE = 0.012;
    vec2 rG = vec2(ripple(uv + vec2(rE, 0.0)) - ripple(uv - vec2(rE, 0.0)), ripple(uv + vec2(0.0, rE)) - ripple(uv - vec2(0.0, rE))) / (2.0 * rE);
    rG.x /= uAspect;
    wide += rG * uFilm3.x * uRipGrain;
    float wl = length(wide);
    vec2 gCarry = (wl > 1e-5 ? wide / wl * 0.07 * tanh(wl / 0.07) : vec2(0.0)) * vec2(1.0 / uAspect, 1.0);   // rubber only gives so far
    vec2 gPos = mix(gl_FragCoord.xy, (uvM + gCarry) * uFilm2.xy, uFilm2.z);
    float gStep = uFilm.y * 0.6;
    // how hard the sheet is pushed out here (0 = resting, 1 = stretched tight over a form). The same
    // number drives the grain here and the translucency and the sheen further down: a resting sheet
    // is matte, opaque and grainy; a stretched one is smooth, lets light through and catches it.
    float push = uFilm2.z * smoothstep(0.12, 0.85, max(mix(h, T, 0.85), 0.0) * uThinAmt + length(g) * 0.35);
    float grainV = grainAt(gPos, push);
    vec2 grainG = 2.0 * vec2(grainAt(gPos + vec2(gStep, 0.0), push) - grainV, grainAt(gPos + vec2(0.0, gStep), push) - grainV);   // forward differences: 3 reads of the grain, not 5
    // on a slope the sheet is stretched tight and smooth: the relief fades there (left on, the
    // stretched grain turns into fur along the fingers and the sheet reads as plaster)
    float gFlat = 1.0 - 0.9 * smoothstep(0.05, 0.5, length(g));
    vec3 n = normalize(vec3(-g + gradGrain * 0.5 * uGrainAmt + grainG * uFilm.x * uFilm3.y * uFilm2.z * gFlat, 1.0));

    // how far the sheet is stretched here: height above its local rest (objects, and objects under a
    // pressing finger), the finger's own dimple, the drag strain, and a little slope
    float slope = length(g);
    // a pressed-in bowl counts only partly as stretch: pressing warms what is under the finger, it
    // does not flood it
    float liftRaw = max(h + ripple(uv) * 0.35 - rest * uPressTint, 0.0);
    float lift = mix(liftRaw, max(hW - rest * uPressTint, 0.0) * 1.15, uAtm.x);   // a crest stretches the sheet a little: forms under it warm for a beat
    float tension = lift * uThinAmt + max(-rest, 0.0) * 0.12 + max(strain, 0.0) * uDragTint + slope * 0.03;
    float thin = clamp(tension, 0.0, 1.0);
    float tight = mix(1.0, smoothstep(0.3, 0.95, thin), uAtm4);   // how stretched the sheet is, for the light

    // behind layer, refracted by the membrane
    vec2 buv = uv + nS.xy * uRefract * vec2(1.0 / uAspect, 1.0);
    buv = clamp(buv, vec2(0.001), vec2(0.999));
    vec3 behind = texture(uBehind, vec2(buv.x, 1.0 - buv.y)).rgb;

    // colour lives inside the material: cream → peach → coral → saturated orange as the sheet
    // stretches over a crown. Driven by height and slope (tension), not by what is behind.
    // an even ramp (tintSoft): the stretch never hits a ceiling (it eases toward full instead of being
    // clamped, which left a flat orange plateau with an edge around it)
    // straight up to 0.75, then a soft knee toward 1: depth still reads (a nose is warmer than a
    // cheek), but nothing hits a hard ceiling
    float tK = max(tension, 0.0);
    float thinC = mix(thin, tK < 0.75 ? tK : 0.75 + 0.25 * tanh((tK - 0.75) / 0.25), uTintSoft);
    float stretch = pow(thinC, uAtm2.w) * uTintAmt;
    // THE SHEET IS A LAYER. A form touching the rubber shows sharp and saturated; the further behind
    // the rubber it sits, the paler and blurrier it gets, until the milk of the silicone swallows it.
    // gap = sheet height minus the form's own depth at this point.
    float seen = 0.0;
    if (uThrough.x > 0.0 && uThrough.w > 0.5) {
      float sheet = max(h, 0.0);
      float gap0 = clamp(sheet - texture(uLiveD, uvM).g, 0.0, 1.5);
      vec2 br = uThrough.z * (0.15 + gap0) * vec2(1.0 / uAspect, 1.0);
      float acc = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = 0.7853982 * float(i) + 0.4;
        float gp = clamp(sheet - texture(uLiveD, uvM + br * vec2(cos(a), sin(a))).g, 0.0, 1.5);
        acc += exp(-gp / uThrough.y);
      }
      seen = (acc + 2.0 * exp(-gap0 / uThrough.y)) / 10.0;
      // seen through the rubber a form is peach to coral; the full orange still needs the sheet to be
      // stretched over it, so a pressed form keeps its modelling instead of going flat
      // PROGRESSIVE: a form only just behind the sheet is a faint warmth; the colour then builds with
      // how far the sheet is pushed out over it. (At 0.5 + 0.5 * thin the whole face went orange the
      // moment it touched.)
      stretch = max(stretch, seen * uThrough.x * (uThroughBase + (1.0 - uThroughBase) * pow(clamp(thinC, 0.0, 1.0), 1.2)));
    }    // skirts stay cream, crowns go orange
    // what the touch left: a blush on the cream, a deeper warmth on forms that were already warm.
    // It tops out in the coral, never the raw orange.
    float paint = texture(uPaint, uvM + gCarry * uFilm2.z).r;   // marks left by the touch ride the same give
    stretch = min(stretch + paint * uPaintAmt * (0.75 - 0.35 * min(stretch, 1.0)), max(stretch, 0.82));
    vec3 peach = mix(uCream, uTint, 0.28);
    vec3 coral = mix(uCream, uTint, 0.62);
    vec3 base = stretch < 0.4 ? mix(uCream, peach, smoothstep(0.0, 0.4, stretch))
              : stretch < 0.75 ? mix(peach, coral, smoothstep(0.4, 0.75, stretch))
              : mix(coral, mix(coral, uTint, 0.75), smoothstep(0.75, 1.0, stretch));   // never the raw tint
    // ...and the colour moves in ONE straight line from cream to orange. The three stepped stages
    // above each flatten at their ends and rush through their middle: on a face that reads as bands
    // with edges, and the edges look like the shape itself is distorted.
    base = mix(base, mix(uCream, uTint, 0.905 * clamp(stretch, 0.0, 1.0)), uTintSoft);
    // bunched-up material is thicker: paler
    base = mix(base, uCream * 1.03, clamp(-strain * uDragTint * 0.8, 0.0, 1.0));
    base *= 1.0 + (grain - 0.5) * 0.06 * uGrainAmt;

    vec3 L = normalize(uLight);
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 H = normalize(L + V);
    float ndl = dot(n, L), ndlS = dot(nS, L);
    float wrapD = ndl * 0.5 + 0.5, wrapS = ndlS * 0.5 + 0.5;
    float diff = mix(max(ndl, 0.0), wrapD * wrapD, uWrap);
    float diffS = mix(max(ndlS, 0.0), wrapS * wrapS, uWrap);
    // translucent silicone does not show a crease: the more translucent the look, the more the
    // light on a form is taken from the diffuse reading of the shape instead of the crisp one
    float wrapDf = dot(nD, L) * 0.5 + 0.5;
    diff = mix(diff, mix(max(dot(nD, L), 0.0), wrapDf * wrapDf, uWrap), 0.85 * uAtm3.x);
    float spec = pow(max(dot(n, H), 0.0), 6.0 + 80.0 * uGloss);      // broad, soft
    float fres = pow(1.0 - max(n.z, 0.0), 3.0);
    // contact shade: the valley where the skirt meets the flat sheet darkens softly (lap > 0), the
    // crown of a form lifts a touch (lap < 0): this is what reads as thickness
    float ao = clamp(1.0 - lap * uShadow * 60.0, 0.7, 1.06);

    // one big soft light, high key: the shadow side stays warm and bright (light scatters inside the
    // silicone), and the stretched orange zones glow from within instead of taking the shading
    float shade = (uAmbient + uDiffuse * diff) * ao;
    vec3 shadeCol = shade * mix(uShadowTint, vec3(1.0), smoothstep(0.55, 1.0, shade));
    vec3 lit = base * mix(shadeCol, vec3(max(shade, 0.97)), stretch * uGlow * 0.7);
    // TRANSLUCENT: light enters the silicone and comes back out coloured. So the side of a form that
    // faces away from the light does not go dark and brown, it goes DEEPER: more saturated, nearly
    // as bright. Modelling by colour instead of by darkness is what reads as light inside the form.
    float onForm = clamp(stretch * 1.6, 0.0, 1.0);
    vec3 deep = mix(uCream, uTint * vec3(1.0, 0.80, 0.66), 0.92);
    float wrapW = dot(nD, L) * 0.5 + 0.5;
    float shadeD = uAmbient + uDiffuse * mix(max(dot(nD, L), 0.0), wrapW * wrapW, uWrap);
    float inShade = 1.0 - smoothstep(0.42, 1.0, shadeD);                  // a long, soft turn into the shade
    lit = mix(lit, deep * (0.86 + 0.14 * shade), inShade * onForm * uAtm3.x * mix(0.2, 1.0, tight));
    vec2 lp = (uv - uLightPos) * vec2(uAspect, 1.0);
    lit *= 1.0 - uFalloff * dot(lp, lp);
    // the room: away from the light the sheet goes to a warm taupe, not to grey
    lit = mix(lit, lit * uBgShade, uAtm2.z * smoothstep(0.15, 1.35, length(lp)));
    // cast shadow: walk toward the light; anything that stands above the line to it shades this
    // point. Six steps and a soft threshold give a wide penumbra; the shade is warm.
    if (uAtm.w > 0.0) {
      vec2 toL = normalize(uLight.xy) * vec2(1.0 / uAspect, 1.0);
      float occ = 0.0;
      for (int i = 1; i <= 6; i++) {
        float d = uAtm2.x * float(i) / 6.0;
        float hs = texture(uState, uvM + toL * d).x;
        occ += smoothstep(0.0, 0.42, (hs - max(h, 0.0)) - d * 1.6) * (1.0 - float(i) / 9.0);
      }
      float sh = clamp(occ / 3.2, 0.0, 1.0) * uAtm.w;
      // the cast shadow belongs to the sheet AROUND a form. On the form itself it is let go: light
      // travels inside the silicone and fills it, and a shadow that starts exactly behind the ridge of
      // a nose is a hard line down its middle (it was, in deep orange).
      lit = mix(lit, lit * uBgShade * vec3(0.93, 0.88, 0.84), sh * (1.0 - 0.9 * onForm));
    }
    // halo: light caught in the sheet just outside a form (the wide reading is higher than the point)
    lit += max(hW - max(h, 0.0), 0.0) * uAtm.z * vec3(1.0, 0.95, 0.88) * (0.5 + 0.5 * diff);

    // through the thin zones we see what is behind, tinted by transmission
    float alpha = 1.0 - thin * uTransl;
    // the little that shows through (the sheet is ~95% opaque): a warm shadow of what is behind
    float lum = dot(behind, vec3(0.299, 0.587, 0.114));
    float shape = 1.0 - smoothstep(0.035, 0.07, lum);
    vec3 transmitted = mix(lit, lit * mix(vec3(1.0), uTint * 0.9 + 0.1, 0.5), shape);
    vec3 col = mix(lit, transmitted, clamp(thin * uTransl, 0.0, 1.0));
    col += uSpecColor * spec * uSpecAmt * (0.5 + 0.5 * (1.0 - thin));
    // soft matte light: one very broad, pale highlight from a big soft source. Only what a slope
    // gains over the flat sheet is added, so the sheet itself is not lifted and nothing looks wet.
    float sh0 = max(pow(max(dot(nD, H), 0.0), 3.0) - pow(H.z, 3.0), 0.0) * uAtm3.y * 1.1;
    col += vec3(1.0, 0.96, 0.90) * (sh0 / (1.0 + sh0 / 0.07)) * mix(0.1, 1.0, tight);   // soft knee: a glow that levels off, no edge, no glint
    // velvet sheen: broad, pale, strongest at grazing angles, never a hot highlight
    col += fres * uRim * mix(base, vec3(1.0), 0.5);

    // vignette
    vec2 vq = (uv - 0.5) * vec2(uAspect, 1.0);
    col *= 1.0 - uVignette * dot(vq, vq);

    // grain last, strongest in the midtones, a touch warm so it never greys the cream
    float lumOut = dot(col, vec3(0.299, 0.587, 0.114));
    float gThin = mix(1.0, 0.35 + 0.65 * gFlat, uFilm2.z);
    float gAmt = grainV * uFilm.x * gThin;
    // as film: added over the picture. As rubber: a slight mottling OF the colour (it darkens in the
    // shade with everything else); most of what you see is the relief above catching the light
    vec3 asFilm = col + gAmt * (0.55 + 0.45 * (1.0 - abs(lumOut * 2.0 - 1.0))) * vec3(1.0, 0.97, 0.93);
    col = mix(asFilm, col * (1.0 + gAmt * 0.9), uFilm2.z);

    outColor = vec4(col, 1.0);
  }`;

  // plain copy: used to carry the heightfield across a resize / sim-width change
  const COPY = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uSrc;
  void main() { outColor = texture(uSrc, vUv); }`;

  // live rigs: triangles [x, y, h] in the rig's own space, placed on the sheet; the nearest point wins
  const LIVE_VERT = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPos;
  uniform vec4 uPlace;       // cx, cy (uv), size (rig units -> viewport heights), angle
  uniform vec2 uFlipAspect;  // flip (1 / -1), aspect
  out float vH;
  void main() {
    vec2 p = aPos.xy * uPlace.z;
    p.x *= uFlipAspect.x;
    float c = cos(uPlace.w), s = sin(uPlace.w);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    vec2 uv = uPlace.xy + vec2(p.x / uFlipAspect.y, p.y);
    vH = aPos.z;
    gl_Position = vec4(uv * 2.0 - 1.0, -clamp(aPos.z, -1.5, 2.0) * 0.5, 1.0);
  }`;
  const LIVE_FRAG = `#version 300 es
  precision highp float;
  in float vH;
  out vec4 outColor;
  void main() {
    if (vH <= -1.5) discard;
    outColor = vec4(max(vH, 0.0), vH, 0.0, 1.0);
  }`;

  // soft bodies (hands): per pixel, the top of the form. A finger is a chain of round-ended tubes
  // (exact union inside the chain, so joints do not bulge); the palm is a cushion over a rounded
  // polygon; chains, palm and forearm merge with a smooth maximum, which makes the webbing.
  const SDF_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform vec4 uPlace;       // cx, cy (uv), size, angle
  uniform vec2 uFlipAspect;
  uniform vec4 uCapA[18];    // a.xyz, radius at a   (5 chains of 3, then single tubes)
  uniform vec4 uCapB[18];    // b.xyz, radius at b
  uniform int  uN;
  uniform vec2 uPoly[6];     // palm outline (through the joints)
  uniform vec4 uPalm;        // palm mid-plane z = x * a + y * b + c;  w = cushion radius
  uniform float uGrow;       // flesh beyond the joints
  uniform float uSquash;     // 1 = round tubes (bone), lower = flattened (flesh under pressure)
  uniform vec2 uPalmZ;       // lowest and highest z of the palm's own joints
  uniform vec4 uShape;       // k (smooth-max width), slope outside the form, plane, gain

  // outside the form the surface falls away at a fixed slope; the blur and the sheet make the skirt
  float skirt(float z, float d) { return z - d * uShape.y; }
  // smooth maximum that only lifts where two surfaces actually meet (width k)
  float smax(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return max(a, b) + h * h * k * 0.25;
  }
  float ball(vec2 p, vec4 c) {
    float d = length(p - c.xy);
    return d < c.w ? c.z + uSquash * sqrt(c.w * c.w - d * d) : skirt(c.z, d - c.w);   // squashed: flesh pressed on a sheet is wider than it is tall
  }
  float tube(vec2 p, vec4 A, vec4 B) {
    vec2 ab = B.xy - A.xy;
    float t = clamp(dot(p - A.xy, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
    // a tube seen end-on is its two end balls; seen from the side it is the swept ball
    return max(ball(p, mix(A, B, t)), max(ball(p, A), ball(p, B)));
  }
  float palm(vec2 p) {
    float d = dot(p - uPoly[0], p - uPoly[0]), sgn = 1.0;
    for (int i = 0, j = 5; i < 6; j = i, i++) {
      vec2 e = uPoly[j] - uPoly[i], w = p - uPoly[i];
      vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-8), 0.0, 1.0);
      d = min(d, dot(b, b));
      bvec3 c = bvec3(p.y >= uPoly[i].y, p.y < uPoly[j].y, e.x * w.y > e.y * w.x);
      if (all(c) || all(not(c))) sgn = -sgn;
    }
    float sd = sgn * sqrt(d) - uGrow;                 // < 0 inside the grown, round-cornered outline
    float zp = clamp(dot(p, uPalm.xy) + uPalm.z, uPalmZ.x, uPalmZ.y);   // never beyond the palm's own depth range
    if (sd >= 0.0) return skirt(zp, sd);
    float t = 1.0 - min(-sd / uPalm.w, 1.0);
    return zp + uPalm.w * sqrt(1.0 - t * t);
  }
  void main() {
    vec2 p = (vUv - uPlace.xy) * vec2(uFlipAspect.y, 1.0);
    float c = cos(-uPlace.w), s = sin(-uPlace.w);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) / uPlace.z;
    p.x *= uFlipAspect.x;
    float z[9];
    int n = 0;
    for (int f = 0; f < 5; f++) {
      float m = -1e3;
      for (int k = 0; k < 3; k++) m = max(m, tube(p, uCapA[f * 3 + k], uCapB[f * 3 + k]));
      z[n++] = m;
    }
    z[n++] = palm(p);
    for (int i = 15; i < 18; i++) { if (i >= uN) break; z[n++] = tube(p, uCapA[i], uCapB[i]); }
    float top = z[0];
    for (int i = 1; i < 9; i++) { if (i >= n) break; top = smax(top, z[i], uShape.x); }
    float h = (top - uShape.z) * uShape.w;
    if (h <= -1.5) discard;
    outColor = vec4(max(h, 0.0), h, 0.0, 1.0);
    gl_FragDepth = 0.5 - clamp(h, -1.5, 2.0) * 0.25;
  }`;

  // The touch leaves colour in the rubber. A scalar field in material space (so it travels with the
  // skin when it is dragged): each frame it fades a little, spreads a little, and takes a deposit
  // along the path the finger just covered. Rubbed latex warms and blushes, then recovers.
  const PAINT = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uPrev;
  uniform vec2  uTexel;
  uniform float uAspect;
  uniform vec4  uSeg;       // the finger's path this frame: a.xy -> b.xy (uv, material space)
  uniform vec4  uBrush;     // radius (height units), deposit, keep (fade per frame), spread
  void main() {
    float c = texture(uPrev, vUv).r;
    float n = 0.25 * (texture(uPrev, vUv + vec2(uTexel.x, 0.0)).r + texture(uPrev, vUv - vec2(uTexel.x, 0.0)).r
                    + texture(uPrev, vUv + vec2(0.0, uTexel.y)).r + texture(uPrev, vUv - vec2(0.0, uTexel.y)).r);
    float v = mix(c, n, uBrush.w) * uBrush.z;
    if (uBrush.y > 0.0) {
      vec2 k = vec2(uAspect, 1.0);
      vec2 p = (vUv - uSeg.xy) * k, ab = (uSeg.zw - uSeg.xy) * k;
      float t = clamp(dot(p, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
      float d = length(p - ab * t) / uBrush.x;
      // soft-edged, denser in the middle; it saturates instead of piling up
      float dep = uBrush.y * exp(-d * d * 1.6);
      v += dep * (1.0 - v);
    }
    outColor = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);
  }`;

  // separable Gaussian over the live height target: a thick sheet cannot follow a hard cliff, and a
  // cliff in the contact target is what makes the sim print contour lines
  const BLUR = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uSrc;
  uniform vec2 uStep;       // one texel along the blur axis, times sigma / 2
  void main() {
    vec2 a = vec2(0.0); float w = 0.0;
    for (int i = -6; i <= 6; i++) {
      float x = float(i) * 0.5;                 // samples every half sigma, out to 3 sigma
      float g = exp(-0.5 * x * x);
      a += g * texture(uSrc, vUv + uStep * float(i)).rg; w += g;
    }
    outColor = vec4(a / w, 0.0, 1.0);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }
  function hex(c) {
    const v = parseInt(c.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  // Euclidean distance transform (Felzenszwalb & Huttenlocher): for every pixel inside `mask`,
  // the distance to the nearest pixel outside it. Returns Float32Array of distances (px).
  function edt(mask, w, h) {
    const INF = 1e9;   // 64-bit math: a float32 sentinel loses the parabola intersections
    const f = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) f[i] = mask[i] ? INF : 0;
    const n = Math.max(w, h);
    const d = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n), row = new Float64Array(n);
    const edt1 = (len) => {
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s;
        for (;;) {
          const vk = v[k];
          s = ((row[q] + q * q) - (row[vk] + vk * vk)) / (2 * q - 2 * vk);
          if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        const vk = v[k];
        d[q] = (q - vk) * (q - vk) + row[vk];
      }
    };
    for (let x = 0; x < w; x++) {               // columns
      for (let y = 0; y < h; y++) row[y] = f[y * w + x];
      edt1(h);
      for (let y = 0; y < h; y++) f[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {               // rows
      for (let x = 0; x < w; x++) row[x] = f[y * w + x];
      edt1(w);
      for (let x = 0; x < w; x++) f[y * w + x] = Math.sqrt(Math.min(d[x], INF));
    }
    return f;
  }

  // A tensioned elastic sheet (stretched spandex / thick latex on a frame): quasi-static, no waves,
  // matte, no texture, warm where thin. The old glossy-latex look lives in presets.js as 'glossy'.
  const DEFAULTS = {
    // simulation
    simWidth: 384,
    substeps: 3,
    tension: 0.30,        // tension carries the skirt out from a form; with flat ≈ 0.001 the skirt is ~20 texels
    damping: 0.90,        // overdamped: rubber carries no waves; the front dies before it can bounce
    flat: 0.001,
    push: 0.5,
    pinK: 0.3,
    visc: 0.0,            // velocity diffusion: with a strong `flat` it goes unstable (checkerboard); bend does the smoothing instead
    contactDamp: 0.85,
    bend: 0.012,          // bending stiffness (thick sheet): smooths the heightfield every step
    blendK: 10,           // how softly overlapping objects merge (lower = softer)
    roundness: 1.0,       // scales every shape's edge radius (height profile fillet)
    edgeLevel: 0.45,      // height of the sheet at the silhouette edge (crown above it is crisp)
    skirt: 0.07,          // length of the soft tail outside the silhouette (fraction of the atlas cell)
    detailAmp: 0.12,      // height of raised details (buttons, fingertips) on top of a body
    // the cursor is one elastic body touching one elastic sheet: everything below is a damped spring
    cursorK: 170,         // the sheet's contact point follows the real cursor with a little lag
    cursorC: 21,
    hoverDepth: 0.07,     // resting a finger on the sheet: a wide, shallow dimple
    hoverRadius: 0.30,
    pressDepth: 0.34,     // pressing in: a wide, shallow bowl; the objects under the finger stand out and warm up
    pressRadius: 0.36,
    pressTint: 0.35,      // how much of the bowl's depth counts as stretch for the colour
    depthK: 40,           // how fast the dimple deepens / recovers (spring)
    depthC: 9,
    dragR: 0.42,          // radius of the skin that follows the hand (height units)
    dragMax: 0.3,         // how far the skin can be pulled (height units), soft-limited
    dragTint: 0.3,        // orange on the stretched side, paler on the bunched side
    dragK: 240,           // snap back: stiff and underdamped, a short wobble like a rubber face
    dragC: 15,
    pullLift: 0.7,        // a far pull lifts the grabbed skin toward you instead of pressing in
    kick: 0.35,           // the release kicks the whole sheet into a sway
    // atmosphere (all off here: the 'ambience' preset turns them on)
    bleed: 0.0,           // colour follows a wider reading of the height: it floods the form and bleeds past its edge
    bleedRadius: 0.035,   // ...how wide (height units)
    halo: 0.0,            // light caught in the sheet around a form
    cast: 0.0,            // soft cast shadow away from the light
    castLen: 0.09,        // ...how far it reaches (height units)
    focus: 0.0,           // soft focus on the low parts of a form
    bgAmt: 0.0,           // the sheet falls off to bgShade away from the light
    bgShade: '#d8c2a6',
    stretchDrive: 1,      // 1 = translucency and sheen grow with how far a form pushes the sheet out; 0 = constant
    translucent: 0.0,     // a form's shadow side goes deeper orange instead of darker (light inside the silicone)
    sheen: 0.0,           // one broad, pale, matte highlight on the slopes that face the light
    tintSoft: 0,          // 1 = one even ramp from cream to orange (no bands, no plateau); 0 = the three-stage ramp
    throughBase: 0.3,     // colour a form shows from just behind the sheet, before any stretch (0 = none, 1 = all at once)
    through: 0.0,         // the sheet as a layer: forms behind it show through by how close they are (live forms)
    fog: 0.22,            // ...how far behind the rubber a form can sit and still show
    fogBlur: 0.10,        // ...how much it blurs with distance
    tintCurve: 2.0,       // 2 = colour only on crowns; lower = colour arrives sooner, across the form
    paintAmt: 1.0,        // the touch leaves colour: overall strength (0 = off)
    paintHover: 0.10,     // ...gliding over the sheet: a faint warm trace (per height unit travelled)
    paintPress: 0.90,     // ...holding a press: a blot that deepens (per second)
    paintDrag: 2.6,       // ...pressing and moving: a scratch along the stroke (per height unit travelled)
    paintSize: 0.042,     // ...width of the mark (height units)
    paintFade: 3.2,       // ...seconds for a mark to fade to about a third
    paintSpread: 0.22,    // ...how much it bleeds into the rubber around it
    filmGrain: 0.035,     // film grain over the whole picture (not a texture of the sheet)
    filmSize: 1.6,        // grain size in css px
    filmStick: 1,         // 1 = the grain belongs to the rubber (moves and stretches with it, never re-rolls); 0 = film grain
    filmStretch: 0.012,   // how much the sheet gives around a form: the grain spreads away from whatever pushes (0 = stiff)
    filmBump: 0.7,        // how much the grain is relief that catches the light (0 = flat mottling only)
    filmRate: 14,         // re-rolls per second
    cursorBall: 0,        // radius of the cursor ball behind the sheet (viewport heights); 0 = the old finger dimple
    ballHover: 0.4,       // how far it pushes the sheet out when the cursor rests on it
    ballPress: 0.82,      // ...and on a press
    drum: 0.0,            // the whole sheet as an elastic bed: how far forms and fingers move all of it (0 = off)
    drumFreq: 1.2,        // ...beats per second (slow: it is the whole sheet)
    drumDamp: 0.13,       // ...0.1 keeps bouncing, 0.5 barely overshoots
    drumKick: 1.2,        // ...extra shove on first touch, on letting go, on a click
    drumWarp: 0.16,       // ...how much the picture is carried outward as the bed rises
    ripGrain: 2.0,        // a passing ripple moves the grain this much (0 = the ripple is light only)
    bounce: 0.5,          // a form's first touch and its letting go make the sheet thud (0 = off)
    ripAmt: 0.30,         // click: height of the one swell that runs out from the touch
    ripSpeed: 2.6,        // ...how fast it runs (height units / s): rubber is quick
    ripWidth: 0.13,       // ...how broad it is (never a thin ring)
    ripLife: 0.26,        // ...how soon it dies (s)
    popAmt: 0.34,         // click: the touched patch overshoots and settles
    popFreq: 6.5,         // ...beats per second
    popRadius: 0.24,
    popLife: 0.2,         // ...how soon the beats die (s)
    swayAmt: 0.05,        // the whole sheet leans toward the touch
    swayVel: 0.025,       // ...and with the cursor's motion
    swayK: 28,
    swayC: 9,
    reach: 0.32,          // how close the cursor must be for an object to press (height units, added to its size)
    pressEase: 0.04,      // objects rise gently (less excitation of the sheet)
    tilt: 0.25,           // objects lean toward the cursor: near side out, far side back
    tiltEase: 0.08,
    idle: 0.10,           // objects breathing on their own
    idleSpeed: 0.35,
    liveSoft: 0.012,      // live rigs: blur of the geometry's height (fraction of the viewport height)
    softness: 0.026,      // blur of the height profiles (fraction of the cell): a thick sheet softens everything, and this makes the outward skirt
    // look
    cream: '#f6eddf',
    tint: '#ff7a2a',      // the orange perceived through cream silicone (peach-orange, saturated, not neon)
    specColor: '#ffa024',
    heightScale: 0.14,    // gentler slopes: the shadow side never goes steep enough to darken
    tintAmt: 1.15,
    thinAmt: 1.05,        // crown height → orange (a flat top sits at coral-orange, raised details go hotter)
    transl: 0.08,         // ~95% opaque
    refract: 0.0,
    gloss: 0.06,          // highlight breadth (low = very broad)
    specAmt: 0.04,        // a broad, soft highlight only: no wet gloss
    grainAmt: 0.0,        // no texture
    grainSize: 3.0,       // px per grain texel
    ambient: 0.7,         // high key: the flat sheet IS the cream, shadow sides stay bright
    diffuse: 0.3,         // ambient + diffuse ≤ 1: the lit side never clips to white
    wrap: 0.75,           // very soft studio light: broad gradients, nothing harsh
    rim: 0.04,            // velvet sheen at grazing angles
    shadow: 0.03,         // almost no contact shade: depth comes from the gradients
    shadowTint: '#efdfcf',// shadow side stays warm and light
    glow: 1.0,
    vignette: 0.02,
    lightX: -0.55,        // one big soft light from the top-left
    lightY: 0.6,
    lightZ: 0.75,
    lightPosX: 0.25,
    lightPosY: 0.85,
    falloff: 0.025,       // the sheet darkens only a touch away from the light
  };

  class LatexSurface {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.params = Object.assign({}, DEFAULTS, opts.params || {});
      this.shapes = opts.shapes || window.LATEX_SHAPES;
      this.dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr || 1.5);
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 not available');
      this.gl = gl;
      const extF = gl.getExtension('EXT_color_buffer_float');
      const extLin = gl.getExtension('OES_texture_float_linear');
      if (extF && extLin) { this.fmt = { internal: gl.RGBA32F, type: gl.FLOAT }; }
      else if (extF || gl.getExtension('EXT_color_buffer_half_float')) { this.fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT }; }
      else throw new Error('Float render targets not available');

      this.sim = program(gl, VERT, SIM);
      this.draw = program(gl, VERT, DRAW);
      this.copyProg = program(gl, VERT, COPY);
      this.liveProg = program(gl, LIVE_VERT, LIVE_FRAG);
      this.blurProg = program(gl, VERT, BLUR);
      this.paintProg = program(gl, VERT, PAINT);
      this.sdfProg = program(gl, VERT, SDF_FRAG);
      this.liveVao = gl.createVertexArray();
      this.liveBuf = gl.createBuffer();
      gl.bindVertexArray(this.liveVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.liveBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.rigs = [];
      this.opts = opts;
      this.quality = null;
      this.vao = gl.createVertexArray();

      this.objects = [];
      this.pointer = { x: 0.5, y: 0.5, inside: false, down: false };
      // the elastic state: a lagging contact point, a dimple depth, a sideways drag, a whole-sheet sway
      this.cur = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
      this.dimple = { depth: 0, v: 0 };
      this.drag = { cx: 0.5, cy: 0.5, grabX: 0.5, grabY: 0.5, ex: 0, ey: 0, vx: 0, vy: 0 };
      this.sway = { x: 0, y: 0, vx: 0, vy: 0 };
      this.drum = { z: 0, v: 0, cx: 0.5, cy: 0.5 };   // the whole sheet as a trampoline
      this.rips = [];            // recent clicks: { x, y, t0, amp }
      this.time = 0;
      this.frame = 0;
      this.fps = 0;
      this._fpsAcc = 0; this._fpsN = 0;

      // behind layer + atlas canvases
      this.behindCanvas = document.createElement('canvas');
      this.atlasCanvas = document.createElement('canvas');
      this.atlasCanvas.width = this.atlasCanvas.height = LatexSurface.CELL * 4;
      this.atlasTex = this._tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, LatexSurface.CELL * 4, LatexSurface.CELL * 4, gl.LINEAR);
      this.behindTex = null;
      // tiling grain texture
      const noise = new Uint8Array(256 * 256 * 4);
      for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
      this.noiseTex = this._tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 256, 256, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, noise);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

      this.resize();
      this._bind();
      // debounced: a drag-resize rebuilds the targets once, not per event
      window.addEventListener('resize', () => {
        clearTimeout(this._resizeT);
        this._resizeT = setTimeout(() => this.resize(), LatexSurface.RESIZE_DEBOUNCE);
      });
    }

    /* ---------- resources ---------- */
    _tex(internal, format, type, w, h, filter) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    _target(w, h) {
      const gl = this.gl;
      const tex = this._tex(this.fmt.internal, gl.RGBA, this.fmt.type, w, h, gl.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w, h };
    }

    // force: rebuild the sim targets even when the canvas size is unchanged (sim width / quality change)
    resize(force) {
      const gl = this.gl;
      const W = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
      const H = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
      if (!force && this.canvas.width === W && this.canvas.height === H && this.state) return;
      this.canvas.width = W; this.canvas.height = H;
      this.aspect = W / H;
      const sw = this.params.simWidth, sh = Math.max(16, Math.round(sw / this.aspect));
      const old = this.state;
      this.state = [this._target(sw, sh), this._target(sw, sh)];
      // keep the membrane: resample the old heightfield (uv -> uv) into both new targets
      if (old) {
        this._copyState(old[0], this.state);
        for (const s of old) { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); }
      }
      this.simW = sw; this.simH = sh;
      if (this.paint) for (const t of this.paint) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      this.paint = [0, 1].map(() => {
        const tex = this._tex(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, sw, sh, gl.LINEAR);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex, fb };
      });
      this._paintLast = null;
      if (this.liveT) { gl.deleteTexture(this.liveT.tex); gl.deleteFramebuffer(this.liveT.fb); gl.deleteRenderbuffer(this.liveT.rb); }
      {
        const lw = sw * 2, lh = sh * 2;
        const tex = this._tex(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, lw, lh, gl.LINEAR);
        const fb = gl.createFramebuffer(), rb = gl.createRenderbuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, lw, lh);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.liveT = { tex, fb, rb, w: lw, h: lh };
        if (this.liveB) { gl.deleteTexture(this.liveB.tex); gl.deleteFramebuffer(this.liveB.fb); }
        const tex2 = this._tex(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, lw, lh, gl.LINEAR);
        const fb2 = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb2);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex2, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.liveB = { tex: tex2, fb: fb2 };
      }
      this.behindCanvas.width = Math.min(W, 1600);
      this.behindCanvas.height = Math.round(this.behindCanvas.width / this.aspect);
      if (this.behindTex) gl.deleteTexture(this.behindTex);
      this.behindTex = this._tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.behindCanvas.width, this.behindCanvas.height, gl.LINEAR);
      this.drawBehind();
    }

    setSimWidth(w) {
      this.params.simWidth = w;
      this.resize(true);
    }

    _copyState(src, dsts) {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      gl.useProgram(this.copyProg.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.copyProg.u.uSrc, 0);
      for (const d of dsts) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb);
        gl.viewport(0, 0, d.w, d.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // 'high' | 'medium' | 'low' -> sim width, substeps, max device pixel ratio
    setQuality(q) {
      const Q = LatexSurface.QUALITY[q];
      if (!Q) return;
      this.quality = q;
      this.params.substeps = Q.substeps;
      this.params.simWidth = Q.simWidth;
      this.dpr = Math.min(window.devicePixelRatio || 1, Q.maxDpr);
      this.resize(true);
    }

    /* ---------- scene ---------- */
    _mapObject(o, i) {
      return {
        id: o.id, pose: null, dirPress: null,        // a scene director may drive these
        shape: o.shape, x: o.x, y: o.y, size: o.size, angle: o.angle || 0, flip: !!o.flip,
        leanX: o.leanX || 0, leanY: o.leanY || 0,    // static 3D tilt: the leaning side presses further
        minPress: o.minPress || 0,                   // presses on its own, cursor or not
        drift: o.drift || 0,                         // slow wander, turn and lean (animated offsets)
        ax: 0, ay: 0, aAngle: 0, aLeanX: 0, aLeanY: 0,
        src: o.src, heightSrc: o.heightSrc,
        maxPress: o.maxPress == null ? 1 : o.maxPress,
        press: 0, target: 0, cell: i, phase: Math.random() * Math.PI * 2,
        tx: 0, ty: 0,
        img: null, heightImg: null, aspect: 1
      };
    }
    // load an image object's pictures (or a sprite shape's sheet + meta), then rebuild the layers
    _loadObjectImages(objs) {
      const pending = [];
      for (const o of objs) {
        if (o.shape === 'image' && o.src) {
          pending.push(this._loadImage(o.src).then(img => { o.img = img; o.aspect = img.width / img.height; }));
          if (o.heightSrc) pending.push(this._loadImage(o.heightSrc).then(img => { o.heightImg = img; }));
        }
        const shape = this.shapes[o.shape];
        if (shape && shape.sprite && !shape._sheet && !shape._loading) {
          shape._loading = true;
          pending.push(Promise.all([this._loadImage(shape.sprite), fetch(shape.meta).then(r => r.json())])
            .then(([img, meta]) => { shape._sheet = img; shape._meta = meta; shape.w = meta.fw; shape.h = meta.fh; }));
        }
      }
      if (pending.length) Promise.all(pending).then(() => this.rebuild());
    }

    // draw the current frame of a sprite shape into the design box (0..w, 0..h)
    _drawSpriteFrame(ctx, shape, w, h) {
      const m = shape._meta;
      if (!m || !shape._sheet) return;
      // cross-fade between consecutive frames so a 12.5 fps bake moves continuously at 60 fps
      const ft = this.time * m.fps, k = Math.floor(ft) % m.frames, k2 = (k + 1) % m.frames, f = ft - Math.floor(ft);
      const blit = (i, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.drawImage(shape._sheet, (i % m.cols) * m.fw, Math.floor(i / m.cols) * m.fh, m.fw, m.fh, 0, 0, w, h);
      };
      ctx.globalCompositeOperation = 'source-over';
      blit(k, 1);
      blit(k2, f);                         // opaque frames: source-over at alpha f is an exact lerp
      ctx.globalAlpha = 1;
    }

    setScene(scene) {
      // a scene may carry physics overrides (moving content needs a sheet that recovers fast);
      // undo the previous scene's before applying this one's
      if (this._sceneSaved) { Object.assign(this.params, this._sceneSaved); this._sceneSaved = null; }
      if (scene.params) {
        this._sceneSaved = {};
        for (const k in scene.params) { this._sceneSaved[k] = this.params[k]; this.params[k] = scene.params[k]; }
      }
      this.scene = scene;
      this.director = scene.director ? scene.director() : null;
      this.objects = scene.objects.slice(0, 16).map((o, i) => this._mapObject(o, i));
      this.rigs = [];
      if (scene.live && window.LatexLive) {
        const mine = scene;
        Promise.all(scene.live.map(d => window.LatexLive.loadRig(d))).then(r => { if (this.scene === mine) { this.rigs = r; if (this.onRigs) this.onRigs(r); } });
      }
      this._loadObjectImages(this.objects);
      this.rebuild();
      this.reset();
    }

    /* ---------- scene editing (the panel and right-drag use these) ---------- */
    getObjects() {
      return this.objects.map(o => ({ shape: o.shape, x: +o.x.toFixed(4), y: +o.y.toFixed(4), size: +o.size.toFixed(3), angle: +o.angle.toFixed(3), flip: o.flip || undefined, leanX: o.leanX ? +o.leanX.toFixed(3) : undefined, leanY: o.leanY ? +o.leanY.toFixed(3) : undefined, minPress: o.minPress || undefined, drift: o.drift || undefined, src: o.src, heightSrc: o.heightSrc }));
    }
    addObject(def) {
      if (this.objects.length >= 16) return -1;
      const o = this._mapObject(def, this.objects.length);
      this.objects.push(o);
      this._loadObjectImages([o]);
      this.rebuild();
      this._changed();
      return this.objects.length - 1;
    }
    removeObject(i) {
      if (!this.objects[i]) return;
      this.objects.splice(i, 1);
      this.objects.forEach((o, k) => { o.cell = k; });
      this.rebuild();
      this._changed();
    }
    updateObject(i, props) {
      const o = this.objects[i];
      if (!o) return;
      Object.assign(o, props);
      if ('flip' in props || 'shape' in props) this.rebuild(); else this.drawBehind();
      this._changed();
    }
    clearObjects() { this.objects = []; this.rebuild(); this._changed(); }
    _changed() { if (this.onObjectsChange) this.onObjectsChange(this.getObjects()); }
    // topmost object whose box contains the uv point (box in the object's own rotated, flipped space)
    hitTest(uv) {
      for (let i = this.objects.length - 1; i >= 0; i--) {
        const o = this.objects[i], shape = this.shapes[o.shape] || {};
        let w = shape.w || 1, h = shape.h || 1;
        if (o.shape === 'image' && o.img) { w = o.img.width; h = o.img.height; }
        const m = Math.max(w, h), hx = o.size * w / m / 2, hy = o.size * h / m / 2;
        let px = (uv.x - o.x) * this.aspect, py = uv.y - o.y;
        const c = Math.cos(-o.angle), s = Math.sin(-o.angle);
        const rx = c * px - s * py, ry = s * px + c * py;
        if (Math.abs(rx) <= hx && Math.abs(ry) <= hy) return i;
      }
      return -1;
    }
    _loadImage(src) {
      return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    }

    // object box: longest side in height units = size; the atlas cell includes padding
    _cellSize(o) { return o.size / (1 - 2 * LatexSurface.PAD); }

    _drawShape(ctx, o, mode, boxPx) {
      const shape = this.shapes[o.shape];
      if (!shape) return;
      let w = shape.w, h = shape.h;
      if (o.shape === 'image') {
        if (!o.img) return;
        w = o.img.width; h = o.img.height;
      }
      const s = boxPx / Math.max(w, h);
      ctx.save();
      ctx.scale(s, s);
      ctx.translate(-w / 2, -h / 2);
      if (o.shape === 'image') {
        if (mode === 'mask') {
          if (o.heightImg) ctx.drawImage(o.heightImg, 0, 0, w, h);
          else {
            // silhouette alpha → flat dome
            ctx.drawImage(o.img, 0, 0, w, h);
            ctx.globalCompositeOperation = 'source-in';
            ctx.fillStyle = '#e6e6e6'; ctx.fillRect(0, 0, w, h);
          }
        } else {
          ctx.drawImage(o.img, 0, 0, w, h);
          ctx.globalCompositeOperation = 'source-in';
          ctx.fillStyle = window.LATEX_COLORS.body; ctx.fillRect(0, 0, w, h);
        }
      } else if (shape.sprite) {
        if (mode === 'mask') this._drawSpriteFrame(ctx, shape, w, h);   // frames are height maps; nothing behind
      } else {
        shape.draw(ctx, mode, this.time, o.pose);
      }
      ctx.restore();
    }

    _roundPx(o, cell, pad) {
      const shape = this.shapes[o.shape] || {};
      let w = shape.w, h = shape.h;
      if (o.shape === 'image' && o.img) { w = o.img.width; h = o.img.height; }
      const scale = (cell - 2 * pad) / Math.max(w || 1, h || 1);
      return Math.max(2, (shape.round != null ? shape.round : 0.18 * Math.min(w || 1, h || 1)) * scale * this.params.roundness);
    }

    // animated shapes: redraw their relief with the current time and re-upload just their atlas cell.
    // The distance transform is cached on the object, so this is a draw, a multiply and a 512² upload.
    _refreshAnimated() {
      const gl = this.gl, cell = LatexSurface.CELL, pad = cell * LatexSurface.PAD, blur = cell * this.params.softness * 0.5;
      if (!this._animCanvas) {
        this._animCanvas = document.createElement('canvas'); this._animCanvas.width = this._animCanvas.height = cell;
        this._animBlur = document.createElement('canvas'); this._animBlur.width = this._animBlur.height = cell;
      }
      const sctx = this._animCanvas.getContext('2d', { willReadFrequently: true });
      const bctx = this._animBlur.getContext('2d');
      let any = false;
      for (const o of this.objects) {
        const shape = this.shapes[o.shape];
        if (!shape || !shape.animated) continue;
        any = true;
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
        sctx.fillStyle = '#000'; sctx.fillRect(0, 0, cell, cell);
        sctx.translate(cell / 2, cell / 2);
        if (o.flip) sctx.scale(-1, 1);
        this._drawShape(sctx, o, 'mask', cell - 2 * pad);
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        if (!shape.sprite) {                        // sprite frames are height maps already
          if (!o.cache) o.cache = {};
          this._heightFromMask(sctx, cell, this._roundPx(o, cell, pad), true, shape.edgeGray == null ? 0.5 : shape.edgeGray, o.cache);
        }
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.fillStyle = '#000'; bctx.fillRect(0, 0, cell, cell);
        const b = shape.sprite ? 0 : blur;           // baked frames are already soft: blurring them wiped the face's features
        bctx.filter = b > 0.2 ? `blur(${b.toFixed(1)}px)` : 'none';
        bctx.drawImage(this._animCanvas, 0, 0);
        bctx.filter = 'none';
        gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, (o.cell % 4) * cell, Math.floor(o.cell / 4) * cell, gl.RGBA, gl.UNSIGNED_BYTE, this._animBlur);
      }
      return any;
    }

    // Height profile from a drawn mask: the silhouette's inside distance becomes a quarter-round
    // fillet of radius `round` (so a circle is a hemisphere, a slab gets soft edges); parts drawn
    // brighter than the body become small caps on top, darker parts become shallow recesses.
    _heightFromMask(sctx, cell, roundPx, relief, edgeGray, cache) {
      const img = sctx.getImageData(0, 0, cell, cell);
      const px = img.data, n = cell * cell;
      const P = this.params;
      const scaleOut = 255 / (1 + P.detailAmp);
      // animated relief shapes: the silhouette never changes, so the distance work is done once
      if (cache && cache.base) {
        const { sil, base, outside } = cache;
        for (let i = 0; i < n; i++) {
          const h = sil[i] ? base[i] * (px[i * 4] / 255) : outside[i];
          const v = Math.max(0, Math.min(255, h * scaleOut));
          px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
        }
        sctx.putImageData(img, 0, 0);
        return;
      }
      const gray = new Float32Array(n);
      for (let i = 0; i < n; i++) gray[i] = px[i * 4] / 255;
      const BODY = 0.80;
      const sil = new Uint8Array(n), raised = new Uint8Array(n), sunk = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        sil[i] = gray[i] > 0.02 ? 1 : 0;
        raised[i] = !relief && gray[i] > 0.93 ? 1 : 0;
        sunk[i] = !relief && sil[i] && gray[i] < BODY - 0.06 ? 1 : 0;
      }
      const inv = new Uint8Array(n);
      for (let i = 0; i < n; i++) inv[i] = sil[i] ? 0 : 1;
      const dS = edt(sil, cell, cell), dO = edt(inv, cell, cell), dR = edt(raised, cell, cell), dK = edt(sunk, cell, cell);
      const fillet = (d, r) => { if (d >= r) return 1; const t = 1 - d / r; return Math.sqrt(Math.max(0, 1 - t * t)); };
      const rDetail = Math.max(2, roundPx * 0.45), rSunk = Math.max(2, roundPx * 0.5);
      // elastic tension: the crown is crisp, the base dissolves. The silhouette edge sits at `edgeLevel`,
      // the quarter-round rises from there to the top, and outside the silhouette a long exponential
      // tail (`skirt`) carries the sheet down to flat. The tail is faded out before the cell edge.
      // The tail is windowed by its distance from the silhouette (an offset of the object's own
      // outline), never by the cell edge: a cell-edge fade draws a square around every object.
      const E = P.edgeLevel, skirtPx = Math.max(1, cell * P.skirt), pad = cell * LatexSurface.PAD;
      const reach = pad * 0.92;                 // the silhouette is inset by `pad`, so this much room always exists
      const base = cache ? new Float32Array(n) : null, outside = cache ? new Float32Array(n) : null;
      for (let i = 0; i < n; i++) {
        let h = 0;
        if (sil[i]) {
          if (relief) {
            // continuous relief: the drawn gray is the height, the fillet rounds the outline
            const b = E + (1 - E) * fillet(dS[i], roundPx);
            if (base) base[i] = b;
            h = b * gray[i];
          } else {
            h = E + (1 - E) * fillet(dS[i], roundPx);
            if (raised[i]) h += P.detailAmp * fillet(dR[i], rDetail);
            if (sunk[i]) h -= P.detailAmp * 0.6 * fillet(dK[i], rSunk);
          }
        } else {
          const t = Math.min(1, dO[i] / reach);
          const win = 1 - t * t * (3 - 2 * t);   // smooth to zero well inside the cell
          h = E * (relief ? edgeGray : 1) * Math.exp(-dO[i] / skirtPx) * win;
          if (outside) outside[i] = h;
        }
        const v = Math.max(0, Math.min(255, h * scaleOut));
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
      }
      if (cache) { cache.sil = sil; cache.base = base; cache.outside = outside; }
      sctx.putImageData(img, 0, 0);
    }

    drawAtlas() {
      const gl = this.gl, ac = this.atlasCanvas, ctx = ac.getContext('2d');
      const cell = LatexSurface.CELL, pad = cell * LatexSurface.PAD, blur = cell * this.params.softness;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ac.width, ac.height);
      // draw each object crisp into a scratch, turn it into a height profile, then blur into its cell
      const scratch = document.createElement('canvas');
      scratch.width = scratch.height = cell;
      const sctx = scratch.getContext('2d', { willReadFrequently: true });
      for (const o of this.objects) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
        sctx.fillStyle = '#000'; sctx.fillRect(0, 0, cell, cell);
        sctx.translate(cell / 2, cell / 2);
        if (o.flip) sctx.scale(-1, 1);
        this._drawShape(sctx, o, 'mask', cell - 2 * pad);
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        const shape = this.shapes[o.shape] || {};
        o.cache = shape.animated ? {} : null;     // a rebuild starts the animated cache over
        if (!(o.shape === 'image' && o.heightImg) && !shape.sprite) this._heightFromMask(sctx, cell, this._roundPx(o, cell, pad), !!shape.relief, shape.edgeGray == null ? 0.5 : shape.edgeGray, o.cache);
        const cx = (o.cell % 4) * cell, cy = Math.floor(o.cell / 4) * cell;
        ctx.save();
        ctx.beginPath(); ctx.rect(cx, cy, cell, cell); ctx.clip();
        const b = shape.relief ? blur * 0.5 : blur;   // a relief map carries its own softness
        ctx.filter = b > 0.2 ? `blur(${b.toFixed(1)}px)` : 'none';
        ctx.drawImage(scratch, cx, cy);
        ctx.restore();
      }
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ac);
    }

    drawBehind() {
      if (!this.behindTex) return;
      const gl = this.gl, bc = this.behindCanvas, ctx = bc.getContext('2d');
      const W = bc.width, H = bc.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.fillStyle = window.LATEX_COLORS.bg; ctx.fillRect(0, 0, W, H);
      for (const o of this.objects) {
        ctx.save();
        ctx.translate(o.x * W, (1 - o.y) * H);
        ctx.rotate(-o.angle);          // uv is y-up, canvas is y-down
        if (o.flip) ctx.scale(-1, 1);
        this._drawShape(ctx, o, 'color', o.size * H);
        ctx.restore();
      }
      gl.bindTexture(gl.TEXTURE_2D, this.behindTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bc);
    }

    reset() {
      const gl = this.gl;
      for (const s of this.state) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.dimple.depth = this.dimple.v = 0;
      this.drag.ex = this.drag.ey = this.drag.vx = this.drag.vy = 0;
      this.sway.x = this.sway.y = this.sway.vx = this.sway.vy = 0;
      if (this.drum) { this.drum.z = this.drum.v = 0; }
      this.rips = []; this._wasPressing = false;
      if (this.paint) for (const t of this.paint) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._paintLast = null;
      for (const o of this.objects) o.press = 0;
    }

    /* ---------- input ---------- */
    _uv(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
    }
    _bind() {
      const c = this.canvas;
      c.style.touchAction = 'none';
      c.addEventListener('contextmenu', e => e.preventDefault());   // right button moves objects
      // wheel over an object rotates it; shift + wheel resizes it
      c.addEventListener('wheel', e => {
        const i = this._move ? this._move.i : this.hitTest(this._uv(e));
        if (i < 0) return;
        e.preventDefault();
        const o = this.objects[i];
        const lim = v => Math.max(-0.7, Math.min(0.7, v));
        if (e.shiftKey) o.size = Math.max(0.05, Math.min(1.6, o.size * (1 - e.deltaY * 0.0015)));
        else if (e.ctrlKey) o.leanY = lim(o.leanY + e.deltaY * 0.0012);   // pitch: top or bottom edge presses more
        else if (e.altKey) o.leanX = lim(o.leanX + e.deltaY * 0.0012);    // yaw: left or right edge presses more
        else o.angle += e.deltaY * 0.0025;                                 // spin
        clearTimeout(this._wheelT);
        this._wheelT = setTimeout(() => { this.drawBehind(); this._changed(); if (this.onObjectEdit) this.onObjectEdit(i); }, 120);
      }, { passive: false });
      c.addEventListener('pointermove', e => {
        const p = this._uv(e);
        if (this._move) {                                             // right-drag: carry the object
          const m = this._move, o = this.objects[m.i];
          if (o) { o.x = p.x - m.dx; o.y = p.y - m.dy; }
          return;
        }
        this.pointer.x = p.x; this.pointer.y = p.y; this.pointer.inside = true;
        if (e.pointerType === 'mouse') this.pointer.touch = false;
        // touch: a finger that travels before the hold timer fires becomes a pin right away
        if (this._touch && Math.hypot(e.clientX - this._touch.cx, e.clientY - this._touch.cy) > LatexSurface.TOUCH_SLOP) this._touchPin();
      });
      c.addEventListener('pointerdown', e => {
        const p = this._uv(e);
        if (e.button === 2) {                                         // right button: pick up an object
          const i = this.hitTest(p);
          if (i >= 0) {
            try { c.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
            const o = this.objects[i];
            this._move = { i, dx: p.x - o.x, dy: p.y - o.y };
            this.pointer.inside = false;
          }
          return;
        }
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        if (e.pointerType === 'touch' && this.opts.touchHold !== false) { this._touchStart(e, p); return; }
        try { c.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events have no active pointer */ }
        this.pointer.down = true; this.pointer.inside = true;
        this.pointer.x = p.x; this.pointer.y = p.y;
        this._grab(p);
      });
      const up = e => {
        if (this._move) { this._move = null; this.drawBehind(); this._changed(); return; }
        if (this._touch) {
          // plain tap: a short press pulse at the tap point
          clearTimeout(this._holdT);
          const t = this._touch; this._touch = null;
          this._grab(t);
          this._pulseUntil = this.time + LatexSurface.PULSE_S;
          this.pointer.inside = false;
          return;
        }
        if (e && e.pointerType === 'touch') this.pointer.inside = false;
        if (!this.pointer.down) return;
        this.pointer.down = false;      // the drag and the dimple spring back on their own
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('pointerleave', () => { this.pointer.inside = false; });
    }

    _touchStart(e, p) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
      this.pointer.touch = true; this.pointer.inside = true;
      this.pointer.x = p.x; this.pointer.y = p.y;
      this._touch = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY };
      clearTimeout(this._holdT);
      this._holdT = setTimeout(() => this._touchPin(), LatexSurface.HOLD_MS);
    }
    // hold (or travel) -> behave exactly like a mouse press grabbed at the touch-down point
    _touchPin() {
      const t = this._touch;
      if (!t) return;
      this._touch = null;
      clearTimeout(this._holdT);
      this.pointer.down = true;
      this._grab(t);
    }
    // a press starts here: the material under the finger is what gets dragged
    _grab(p) {
      const d = this.drag;
      d.grabX = p.x; d.grabY = p.y; d.cx = p.x; d.cy = p.y;
      d.ex = d.ey = d.vx = d.vy = 0;
      this.cur.x = p.x; this.cur.y = p.y; this.cur.vx = this.cur.vy = 0;
    }

    // critically-ish damped spring step for a scalar: returns [x, v]
    static spring(x, v, target, k, c, dt) {
      const a = -k * (x - target) - c * v;
      v += a * dt; x += v * dt;
      return [x, v];
    }

    /* ---------- per-frame ---------- */
    _updateObjects(dt) {
      const P = this.params, a = this.aspect, S = LatexSurface.spring;
      // the contact point lags the real cursor (the sheet has mass)
      const cu = this.cur;
      [cu.x, cu.vx] = S(cu.x, cu.vx, this.pointer.x, P.cursorK, P.cursorC, dt);
      [cu.y, cu.vy] = S(cu.y, cu.vy, this.pointer.y, P.cursorK, P.cursorC, dt);
      const mx = cu.x * a, my = cu.y;
      if (this.director) {
        const byId = {};
        for (const o of this.objects) if (o.id) byId[o.id] = o;
        this.director.update(byId, dt, this.time);
      }
      for (const o of this.objects) {
        const dx = o.x * a - mx, dy = o.y - my;
        const d = Math.hypot(dx, dy);
        const reach = o.size * 0.55 + P.reach;
        let prox = this.pointer.inside ? 1 - Math.min(1, d / reach) : 0;
        prox = prox * prox * (3 - 2 * prox);
        const idle = P.idle * (0.5 + 0.5 * Math.sin(this.time * P.idleSpeed + o.phase));
        o.target = Math.max(idle, prox, o.minPress) * o.maxPress;
        if (o.dirPress != null) {                          // directed: the director already eased it
          o.target = Math.max(o.dirPress, prox * o.maxPress);
          o.press = o.target;
        }
        if (o.drift) {                                     // wander, turn and lean; a posed shape leans where it looks
          const t = this.time, k = o.drift, ph = o.phase;
          const sh = this.shapes[o.shape], pose = sh && sh.pose ? sh.pose(t) : null;
          o.ax = k * (0.06 * Math.sin(t * 0.31 + ph) + 0.015 * Math.sin(t * 1.1 + ph * 2));
          o.ay = k * (0.045 * Math.sin(t * 0.23 + ph * 1.7) + 0.012 * Math.sin(t * 0.9 + ph));
          o.aAngle = k * (0.2 * Math.sin(t * 0.27 + ph * 0.6) + 0.04 * Math.sin(t * 1.4 + ph));
          if (pose) {
            o.aLeanX = k * (0.5 * pose.lookX);              // turning toward a side pushes that side out
            o.aLeanY = k * (0.45 * pose.lookY);             // looking up pushes the brow out, down pushes the chin
          } else {
            o.aLeanX = 0.4 * k * Math.sin(t * 0.37 + ph); o.aLeanY = 0.35 * k * Math.sin(t * 0.47 + 1 + ph);
          }
        }
        const ease = o.target > o.press ? P.pressEase : P.pressEase * 0.6;
        if (o.dirPress == null) o.press += (o.target - o.press) * Math.min(1, ease * dt * 60);
        // a sprite baked as a tight box that follows the object: move the object along the baked track
        const sh = this.shapes[o.shape], mt = sh && sh._meta;
        if (mt && mt.track) {
          const ft = this.time * mt.fps, k = Math.floor(ft) % mt.frames, k2 = (k + 1) % mt.frames, f = ft - Math.floor(ft);
          const tx = mt.track[k][0] + (mt.track[k2][0] - mt.track[k][0]) * f, ty = mt.track[k][1] + (mt.track[k2][1] - mt.track[k][1]) * f;
          let vx = (o.flip ? -tx : tx) * o.size, vy = -ty * o.size;          // box units → height units, y up
          const c = Math.cos(o.angle + o.aAngle), s = Math.sin(o.angle + o.aAngle);
          const rx = c * vx - s * vy, ry = s * vx + c * vy;
          o.sx = rx / a; o.sy = ry;
        } else { o.sx = 0; o.sy = 0; }
        // tilt toward the cursor, expressed in the object's own box space (rotated, flipped like the shader)
        let gx = 0, gy = 0;
        if (this.pointer.inside && d > 1e-4 && prox > 0) {
          const c = Math.cos(-o.angle), s = Math.sin(-o.angle);
          let lx = -dx, ly = -dy;                          // toward the cursor
          const rx = c * lx - s * ly, ry = s * lx + c * ly;
          lx = o.flip ? -rx : rx; ly = ry;
          const len = Math.hypot(lx, ly) || 1;
          const amt = P.tilt * prox;
          gx = lx / len * amt; gy = ly / len * amt;
        }
        gx += o.leanX + o.aLeanX; gy += o.leanY + o.aLeanY;   // the object's own tilt (+ drift), in its box space
        const te = Math.min(1, P.tiltEase * dt * 60);
        o.tx += (gx - o.tx) * te; o.ty += (gy - o.ty) * te;
      }
      // sideways drag: while pressed the skin follows the hand; released, it snaps back (stiff spring,
      // underdamped: a short wobble) and kicks the whole sheet
      const dr = this.drag;
      const pressing = this.pointer.down || this._pulseUntil > this.time;   // a touch tap presses briefly
      // the click's elastic answer: pressing sends a small swell out (the sheet is pushed in), letting
      // go sends a bigger one and makes the patch thud, more so the further the skin was pulled
      if (pressing !== !!this._wasPressing) {
        this._wasPressing = pressing;
        const pulled = Math.min(1, Math.hypot(dr.ex * a, dr.ey) / Math.max(P.dragMax, 1e-4));
        const deep = Math.min(1, Math.abs(this.dimple.depth) / Math.max(P.pressDepth, 1e-4));
        // A TAP bounces, a DRAG does not. Nothing fires when the finger lands: at that moment a tap and
        // the start of a drag are the same thing, and a sheet that jumps the instant it is touched
        // fights the drag. The answer comes on letting go: a quick tap that barely moved gets the full
        // thud and a throw of the whole bed; a hold or a drag is released gently, by how far the skin
        // was pulled.
        let amp = 0;
        if (pressing) { this._pressT0 = this.time; }
        else {
          const held = this.time - (this._pressT0 == null ? this.time : this._pressT0);
          const tap = held < 0.32 && pulled < 0.2;
          if (tap) { amp = 0.7; this.drum.v += 1.0 * P.drumKick; }
          else { amp = 0.12 * deep + 0.3 * pulled; this.drum.v += 0.7 * pulled * P.drumKick; }
        }
        if (Math.abs(amp) > 0.02) {
          this.rips.push({ x: dr.cx, y: dr.cy, t0: this.time, amp });
          if (this.rips.length > 4) this.rips.shift();
        }
      }
      if (this.pointer.down) {
        dr.cx = cu.x; dr.cy = cu.y;
        dr.ex = cu.x - dr.grabX; dr.ey = cu.y - dr.grabY; dr.vx = dr.vy = 0;
        dr.held = true;
      } else {
        if (dr.held) { dr.held = false; this.sway.vx += dr.ex * a * P.kick * 10; this.sway.vy += dr.ey * P.kick * 10; }
        [dr.ex, dr.vx] = S(dr.ex, dr.vx, 0, P.dragK, P.dragC, dt);
        [dr.ey, dr.vy] = S(dr.ey, dr.vy, 0, P.dragK, P.dragC, dt);
      }
      // dimple depth: resting finger → shallow, press → deep, a far pull → lifts instead, gone → recovers
      const pull = Math.min(1, Math.hypot(dr.ex * a, dr.ey) / Math.max(P.dragMax, 1e-4));
      // with the cursor ball on, the cursor is something BEHIND the sheet pushing out, so the finger's
      // own dimple into the sheet is off
      const noDimple = P.cursorBall > 0 ? 0 : 1;
      const depthGoal = noDimple * (pressing ? P.pressDepth - P.pullLift * pull * pull : (this.pointer.inside && !this.pointer.touch ? P.hoverDepth : 0));
      // the ball: rises to meet the sheet when the cursor is over it, pushes further on a press, sinks
      // away when the cursor leaves. A spring, like everything else here.
      if (!this.ball) this.ball = { h: -0.3, v: 0 };
      const ballGoal = P.cursorBall > 0 ? (pressing ? P.ballPress : (this.pointer.inside ? P.ballHover : -0.3)) : -0.3;
      [this.ball.h, this.ball.v] = S(this.ball.h, this.ball.v, ballGoal, 70, 11, dt);
      const dm = this.dimple;
      [dm.depth, dm.v] = S(dm.depth, dm.v, depthGoal, P.depthK, P.depthC, dt);
      // the whole sheet leans toward the touch and with its motion
      const sw = this.sway;
      const on = this.pointer.inside ? 1 : 0;
      const tx = on * ((cu.x - 0.5) * P.swayAmt + cu.vx * P.swayVel) * (pressing ? 2.2 : 1);
      const ty = on * ((cu.y - 0.5) * P.swayAmt + cu.vy * P.swayVel) * (pressing ? 2.2 : 1);
      [sw.x, sw.vx] = S(sw.x, sw.vx, tx, P.swayK, P.swayC, dt);
      [sw.y, sw.vy] = S(sw.y, sw.vy, ty, P.swayK, P.swayC, dt);
      // the bed: pushed out by every form that is through it and pushed in by a pressing finger,
      // on a slow, lightly damped spring. Its centre drifts toward whatever is doing the pushing.
      const dm2 = this.drum;
      let load = 0, lx = 0, ly = 0;
      for (const r of this.rigs) { const w = Math.max(0, r.pen || 0); if (w > 0 && r._uv) { load += w; lx += r._uv[0] * w; ly += r._uv[1] * w; } }
      const finger = Math.max(0, this.dimple.depth);
      if (finger > 0.01) { lx += cu.x * finger; ly += cu.y * finger; }
      const tot = load + finger;
      const cgx = tot > 1e-3 ? lx / tot : 0.5, cgy = tot > 1e-3 ? ly / tot : 0.5;
      const ce = Math.min(1, dt * 2.5);
      dm2.cx += (cgx - dm2.cx) * ce; dm2.cy += (cgy - dm2.cy) * ce;
      const goal = (load * 1.6 - finger * 0.3) * P.drum;   // a held finger leans the bed in only a little, or holding still makes it bounce
      const wd = 6.2832 * P.drumFreq;
      for (let i = 0; i < 4; i++) { const hh = dt / 4; dm2.v += (-wd * wd * (dm2.z - goal) - 2 * P.drumDamp * wd * dm2.v) * hh; dm2.z += dm2.v * hh; }
    }

    // drag vector in height units, soft-limited: rubber only stretches so far
    _dragVisible() {
      const d = this.drag, a = this.aspect, L = this.params.dragMax;
      const ex = d.ex * a, ey = d.ey;
      const m = Math.hypot(ex, ey);
      if (m < 1e-6) return [0, 0];
      const k = (L * Math.tanh(m / L)) / m;
      return [ex * k, ey * k];
    }

    step(dt) {
      const gl = this.gl, P = this.params;
      dt = Math.min(dt, 1 / 30);
      this.time += dt;
      this._updateObjects(dt);
      if ((this.frame & 1) === 0) this._refreshAnimated();   // living shapes: every other frame

      this._paintStep(dt);
      this._renderLive();

      // ---- sim ----
      gl.bindVertexArray(this.vao);
      gl.useProgram(this.sim.p);
      const u = this.sim.u;
      gl.viewport(0, 0, this.simW, this.simH);
      gl.uniform2f(u.uTexel, 1 / this.simW, 1 / this.simH);
      gl.uniform1f(u.uAspect, this.aspect);
      gl.uniform1f(u.uDt, 1.0);
      gl.uniform1f(u.uTension, P.tension);
      gl.uniform1f(u.uDamping, P.damping);
      gl.uniform1f(u.uFlat, P.flat);
      gl.uniform1f(u.uPush, P.push);
      gl.uniform1f(u.uPinK, P.pinK);
      gl.uniform1f(u.uVisc, P.visc);
      gl.uniform1f(u.uContactDamp, P.contactDamp);
      gl.uniform1f(u.uBend, P.bend);
      gl.uniform1f(u.uBlendK, P.blendK);
      gl.uniform1i(u.uCount, this.objects.length);
      const A = new Float32Array(64), B = new Float32Array(64), C = new Float32Array(64);
      this.objects.forEach((o, i) => {
        A[i * 4] = o.x + o.ax + (o.sx || 0); A[i * 4 + 1] = o.y + o.ay + (o.sy || 0); A[i * 4 + 2] = this._cellSize(o); A[i * 4 + 3] = o.angle + o.aAngle;
        B[i * 4] = o.press; B[i * 4 + 1] = o.cell; B[i * 4 + 2] = o.flip ? 1 : 0; B[i * 4 + 3] = 0;
        C[i * 4] = o.tx; C[i * 4 + 1] = o.ty;
      });
      gl.uniform4fv(u.uObjA, A);
      gl.uniform4fv(u.uObjB, B);
      gl.uniform4fv(u.uObjC, C);
      const pressing = this.pointer.down || this._pulseUntil > this.time;
      const dRad = pressing ? P.pressRadius : P.hoverRadius;
      // while the skin is pulled, the finger sits on the material grabbed at the start; the render's
      // displacement carries that spot to the cursor on screen
      const dx = this.pointer.down ? this.drag.grabX : this.cur.x, dy = this.pointer.down ? this.drag.grabY : this.cur.y;
      gl.uniform4f(u.uDimple, dx, dy, dRad, this.dimple.depth);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.uniform1i(u.uAtlas, 1);
      gl.uniform1i(u.uState, 0);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.liveT.tex);
      gl.uniform1i(u.uLive, 4);
      gl.uniform1f(u.uLiveOn, (this.rigs.length || this._ballOn) ? 1 : 0);
      gl.uniform2f(u.uLiveTexel, 1 / this.liveT.w, 1 / this.liveT.h);
      for (let i = 0; i < P.substeps; i++) {
        const src = this.state[0], dst = this.state[1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.state.reverse();
      }

      // ---- draw ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.draw.p);
      const d = this.draw.u;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state[0].tex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.behindTex);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
      gl.uniform1i(d.uState, 0);
      gl.uniform1i(d.uBehind, 2);
      gl.uniform1i(d.uNoise, 3);
      gl.uniform1f(d.uNoiseScale, this.canvas.height / (256 * P.grainSize));
      gl.uniform2f(d.uSimTexel, 1 / this.simW, 1 / this.simH);
      gl.uniform1f(d.uAspect, this.aspect);
      gl.uniform1f(d.uTime, this.time);
      gl.uniform3fv(d.uCream, hex(P.cream));
      gl.uniform3fv(d.uTint, hex(P.tint));
      gl.uniform3fv(d.uSpecColor, hex(P.specColor));
      gl.uniform1f(d.uHeightScale, P.heightScale);
      gl.uniform1f(d.uTintAmt, P.tintAmt);
      gl.uniform1f(d.uThinAmt, P.thinAmt);
      gl.uniform1f(d.uTransl, P.transl);
      gl.uniform1f(d.uRefract, P.refract);
      gl.uniform1f(d.uGloss, P.gloss);
      gl.uniform1f(d.uSpecAmt, P.specAmt);
      gl.uniform1f(d.uGrainAmt, P.grainAmt);
      gl.uniform1f(d.uAmbient, P.ambient);
      gl.uniform1f(d.uDiffuse, P.diffuse);
      gl.uniform1f(d.uRim, P.rim);
      gl.uniform1f(d.uShadow, P.shadow);
      gl.uniform1f(d.uGlow, P.glow);
      gl.uniform1f(d.uVignette, P.vignette);
      gl.uniform1f(d.uWrap, P.wrap);
      gl.uniform3f(d.uLight, P.lightX, P.lightY, P.lightZ);
      gl.uniform3fv(d.uShadowTint, hex(P.shadowTint));
      gl.uniform2f(d.uLightPos, P.lightPosX, P.lightPosY);
      gl.uniform1f(d.uFalloff, P.falloff);
      const dv = this._dragVisible();
      gl.uniform4f(d.uDrag, this.drag.cx, this.drag.cy, dv[0], dv[1]);
      gl.uniform1f(d.uDragR, P.dragR);
      gl.uniform1f(d.uDragTint, P.dragTint);
      gl.uniform1f(d.uPressTint, P.pressTint);
      gl.uniform4f(d.uSway, this.sway.x, this.sway.y, 0, 0);
      gl.uniform4f(d.uDrum, this.drum.z, this.drum.cx, this.drum.cy, P.drumWarp);
      gl.uniform1f(d.uRipGrain, P.ripGrain);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.paint[0].tex);
      gl.uniform1i(d.uPaint, 5);
      gl.uniform1f(d.uPaintAmt, P.paintAmt);
      gl.uniform4f(d.uAtm, P.bleed, P.bleedRadius, P.halo, P.cast);
      gl.uniform4f(d.uAtm2, P.castLen, P.focus, P.bgAmt, P.tintCurve);
      gl.uniform3fv(d.uBgShade, hex(P.bgShade));
      gl.uniform2f(d.uAtm3, P.translucent, P.sheen);
      gl.uniform1f(d.uAtm4, P.stretchDrive);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.liveT.tex);
      gl.uniform1i(d.uLiveD, 6);
      gl.uniform1f(d.uThroughBase, P.throughBase);
      gl.uniform1f(d.uTintSoft, P.tintSoft);
      gl.uniform4f(d.uThrough, P.through, P.fog, P.fogBlur, (this.rigs.length || this._ballOn) ? 1 : 0);
      gl.uniform3f(d.uFilm, P.filmGrain, Math.max(1, P.filmSize * this.dpr), P.filmStick > 0.5 ? 0 : Math.floor(this.time * P.filmRate) % 1024);
      gl.uniform3f(d.uFilm2, this.canvas.width, this.canvas.height, P.filmStick);
      gl.uniform2f(d.uFilm3, P.filmStretch, P.filmBump);
      const R = new Float32Array(16);
      this.rips = this.rips.filter(r => this.time - r.t0 < 1.2 && this.time >= r.t0);
      this.rips.forEach((r, i) => { R[i * 4] = r.x; R[i * 4 + 1] = r.y; R[i * 4 + 2] = this.time - r.t0; R[i * 4 + 3] = r.amp; });
      gl.uniform4fv(d.uRip, R);
      gl.uniform4f(d.uRipA, P.ripAmt, P.ripSpeed, P.ripWidth, P.ripLife);
      gl.uniform4f(d.uRipB, P.popAmt, P.popFreq, P.popRadius, P.popLife);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this.frame++;
      this._fpsAcc += dt; this._fpsN++;
      if (this._fpsAcc >= 0.5) { this.fps = Math.round(this._fpsN / this._fpsAcc); this._fpsAcc = 0; this._fpsN = 0; }
    }

    // what the touch leaves behind. Three kinds of contact, three marks:
    //   resting / gliding  -> a faint warm trace, only while the finger moves
    //   pressing           -> a blot that deepens the longer it is held
    //   pressing + moving  -> a scratch: the strongest, narrowest mark, laid along the stroke
    _paintStep(dt) {
      const gl = this.gl, P = this.params, a = this.aspect, cu = this.cur;
      const pressing = this.pointer.down || this._pulseUntil > this.time;
      // where the finger is ON THE MATERIAL: the skin follows the hand at first, so a drag begins
      // as a blot and becomes a streak once the rubber stops giving and the finger slides over it
      let mx = cu.x, my = cu.y;
      if (this.pointer.down) { const dv = this._dragVisible(); mx -= dv[0] / a; my -= dv[1]; }
      // a press starts a NEW stroke where the finger is. On a phone the contact point is still
      // wherever the last touch ended; without this the first frame of a touch drew one long scratch
      // from there to the finger.
      if (pressing !== !!this._paintPressing) { this._paintPressing = pressing; this._paintLast = null; }
      if (this.pointer.touch && !pressing) this._paintLast = null;
      const last = this._paintLast || { x: mx, y: my };
      const travel = Math.hypot((mx - last.x) * a, my - last.y);            // height units this frame
      const speed = travel / Math.max(dt, 1e-4);
      let dep = 0, radius = P.paintSize;
      const touching = this.pointer.inside || pressing;
      if (touching && P.paintAmt > 0) {
        if (pressing) {
          dep = P.paintPress * dt + P.paintDrag * travel;
          radius = P.paintSize * (1 + 0.5 / (1 + speed * 2.5));              // a held press spreads, a fast scratch stays thin
        } else if (!this.pointer.touch) {
          dep = P.paintHover * travel;
          radius = P.paintSize * 1.5;
        }
      }
      const jump = travel > 0.6;                                             // the cursor came back in somewhere else: no line across
      const ax = jump ? mx : last.x, ay = jump ? my : last.y;
      this._paintLast = touching ? { x: mx, y: my } : null;
      const u = this.paintProg.u;
      gl.bindVertexArray(this.vao);
      gl.useProgram(this.paintProg.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.paint[1].fb);
      gl.viewport(0, 0, this.simW, this.simH);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.paint[0].tex);
      gl.uniform1i(u.uPrev, 0);
      gl.uniform2f(u.uTexel, 1 / this.simW, 1 / this.simH);
      gl.uniform1f(u.uAspect, a);
      gl.uniform4f(u.uSeg, ax, ay, mx, my);
      gl.uniform4f(u.uBrush, radius, Math.min(dep, 0.9), Math.exp(-dt / Math.max(P.paintFade, 0.05)), P.paintSpread);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.paint.reverse();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // rasterise every live rig into the height target: depth test keeps the point nearest the camera
    _renderLive() {
      this._ballOn = this.params.cursorBall > 0 && this.ball && this.ball.h > -0.28;
      if (!this.rigs.length && !this._ballOn) return;
      const gl = this.gl, T = this.liveT;
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
      gl.viewport(0, 0, T.w, T.h);
      gl.clearColor(0, -1.5, 0, 1); gl.clearDepth(1);      // g = -1.5: nothing behind the sheet here
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
      for (const r of this.rigs) {
        r.update(this.time);
        // first touch and letting go: the sheet answers with a small thud (the click's own thud,
        // far gentler). Touching pushes out, letting go dips in and comes back.
        if (r.pen != null && r.centre && this.params.bounce > 0) {
          const touching = r.pen > 0.02;
          if (r._touching != null && touching !== r._touching) {
            const dd = r.def, fx = dd.flip ? -1 : 1;
            this.rips.push({ x: dd.x + r.centre[0] * fx * dd.size / this.aspect, y: dd.y + r.centre[1] * dd.size, t0: this.time, amp: (touching ? 0.5 : -0.75) * this.params.bounce });
            if (this.rips.length > 4) this.rips.shift();
            this.drum.v += (touching ? 0.5 : -1.3) * this.params.drumKick;      // first touch nudges the bed out; letting go drops it
          }
          r._touching = touching;
          r._uv = [r.def.x + r.centre[0] * (r.def.flip ? -1 : 1) * r.def.size / this.aspect, r.def.y + r.centre[1] * r.def.size];
        }
        if (!r.count) continue;
        const d = r.def;
        if (r.sdf) {
          const u = this.sdfProg.u;
          gl.useProgram(this.sdfProg.p);
          gl.bindVertexArray(this.vao);
          gl.uniform4f(u.uPlace, d.x, d.y, d.size, d.angle || 0);
          gl.uniform2f(u.uFlipAspect, d.flip ? -1 : 1, this.aspect);
          gl.uniform4fv(u.uCapA, r.capA);
          gl.uniform4fv(u.uCapB, r.capB);
          gl.uniform1i(u.uN, r.nCaps);
          gl.uniform2fv(u.uPoly, r.poly);
          gl.uniform4fv(u.uPalm, r.palmPlane);
          gl.uniform1f(u.uGrow, r.grow);
          gl.uniform1f(u.uSquash, d.squash == null ? 1 : d.squash);
          gl.uniform2f(u.uPalmZ, r.palmZ[0], r.palmZ[1]);
          gl.uniform4f(u.uShape, r.k, d.slope, r.plane, d.gain);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          continue;
        }
        gl.useProgram(this.liveProg.p);
        gl.bindVertexArray(this.liveVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.liveBuf);
        gl.bufferData(gl.ARRAY_BUFFER, r.verts.subarray(0, r.count * 3), gl.DYNAMIC_DRAW);
        gl.uniform4f(this.liveProg.u.uPlace, d.x, d.y, d.size, d.angle || 0);
        gl.uniform2f(this.liveProg.u.uFlipAspect, d.flip ? -1 : 1, this.aspect);
        gl.drawArrays(gl.TRIANGLES, 0, r.count);
      }
      // the cursor: a little ball behind the sheet, drawn with the soft-body pass as a single round
      // form (the finger and palm slots are parked far away). It sits on the material the finger is
      // on, so it rides dragged skin exactly as the old dimple did.
      if (this._ballOn) {
        const P = this.params, u = this.sdfProg.u, r = P.cursorBall, G = 3.6;
        if (!this._ballA) { this._ballA = new Float32Array(72).fill(99); this._ballB = new Float32Array(72).fill(99); this._ballPoly = new Float32Array(12).fill(99); }
        const A = this._ballA, B = this._ballB;
        for (let i = 0; i < 72; i += 4) { A[i + 2] = -9; A[i + 3] = 0.001; B[i + 2] = -9; B[i + 3] = 0.001; }
        const bx = this.pointer.down ? this.drag.grabX : this.cur.x, by = this.pointer.down ? this.drag.grabY : this.cur.y;
        const px = (bx - 0.5) * this.aspect, py = by - 0.5, cz = this.ball.h / G - r;       // top of the ball = ball.h
        A[60] = px; A[61] = py; A[62] = cz; A[63] = r; B[60] = px; B[61] = py; B[62] = cz; B[63] = r;
        gl.useProgram(this.sdfProg.p);
        gl.bindVertexArray(this.vao);
        gl.uniform4f(u.uPlace, 0.5, 0.5, 1, 0);
        gl.uniform2f(u.uFlipAspect, 1, this.aspect);
        gl.uniform4fv(u.uCapA, A); gl.uniform4fv(u.uCapB, B);
        gl.uniform1i(u.uN, 16);
        gl.uniform2fv(u.uPoly, this._ballPoly);
        gl.uniform4f(u.uPalm, 0, 0, -9, 0.001);
        gl.uniform1f(u.uGrow, 0);
        gl.uniform2f(u.uPalmZ, -9, -9);
        gl.uniform1f(u.uSquash, 1);
        gl.uniform4f(u.uShape, 0.004, 16.0, 0, G);   // steep sides: a small ball that stands proud, not a wide mound
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.DEPTH_TEST);
      // soften: horizontal into the scratch target, vertical back
      const sig = this.params.liveSoft * T.h;      // sigma in live texels (liveSoft is a fraction of the viewport height)
      if (sig > 0.3) {
        gl.bindVertexArray(this.vao);
        gl.useProgram(this.blurProg.p);
        gl.uniform1i(this.blurProg.u.uSrc, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.liveB.fb);
        gl.bindTexture(gl.TEXTURE_2D, T.tex);
        gl.uniform2f(this.blurProg.u.uStep, sig * 0.5 / T.w, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
        gl.bindTexture(gl.TEXTURE_2D, this.liveB.tex);
        gl.uniform2f(this.blurProg.u.uStep, 0, sig * 0.5 / T.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    start() {
      if (this._running) return;
      this._running = true;
      this._last = performance.now();
      const loop = now => {
        if (!this._running) return;
        const dt = Math.max(0, (now - this._last) / 1000); this._last = now;   // step() clamps the top end
        this.step(dt);
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
      if (!this._visBound) {
        this._visBound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) { if (this._running) { this._hiddenPause = true; this.stop(); } }
          else if (this._hiddenPause) { this._hiddenPause = false; if (!this.paused) this.start(); }
        });
      }
    }
    stop() { this._running = false; cancelAnimationFrame(this._raf); }
    pause() { this.paused = true; this.stop(); }
    resume() { this.paused = false; if (!document.hidden) this.start(); else this._hiddenPause = true; }

    // refresh atlas/behind after a param that affects them changes
    rebuild() { this.drawAtlas(); this.drawBehind(); }
  }

  LatexSurface.DEFAULTS = DEFAULTS;
  LatexSurface.PAD = 0.17;   // atlas cell padding: room for the soft skirt outside the silhouette
  LatexSurface.CELL = 512;   // atlas cell size (4×4 cells); height profiles need the resolution for buttons and fingers
  LatexSurface.QUALITY = {
    ultra:  { simWidth: 1024, substeps: 3, maxDpr: 1.5 },   // for fine relief (the clip faces): 4x the texels, ~4x the sim cost
    high:   { simWidth: 512, substeps: 3, maxDpr: 1.5 },
    medium: { simWidth: 384, substeps: 3, maxDpr: 1.25 },
    low:    { simWidth: 256, substeps: 2, maxDpr: 1 },
  };
  LatexSurface.RESIZE_DEBOUNCE = 100;  // ms
  LatexSurface.HOLD_MS = 180;          // touch: hold this long to become a pin
  LatexSurface.TOUCH_SLOP = 10;        // px a finger may travel before it becomes a pin anyway
  LatexSurface.PULSE_S = 0.25;         // touch: a tap holds the pin this long
  window.LatexSurface = LatexSurface;
})();
