/* Latex membrane: presets + shared page helpers (index.html, hero.html)
 *
 * LATEX_PRESETS: partial params objects applied over LatexSurface.DEFAULTS.
 * LATEX_KIT:     URL / localStorage params, quality auto-pick, reduced motion.
 *
 * Performance keys (simWidth, substeps) belong to the quality setting, so presets,
 * saved params and share links leave them out. Use ?quality=high|medium|low instead.
 */
(function () {
  'use strict';

  const PRESETS = {
    default: {},
    soft: {
      tension: 0.16, damping: 0.955, visc: 0.12,
      hoverRadius: 0.17, hoverAmp: 0.45,
      stretchK: 60, stretchC: 9,
    },
    snappy: {
      tension: 0.42, damping: 0.988, visc: 0.03, contactDamp: 0.95,
      pinK: 0.4, pressEase: 0.14,
      stretchK: 210, stretchC: 4,
    },
    'orange flood': { tintAmt: 1.2, glow: 1.2, thinAmt: 1.1 },
    // the first-day glossy latex look: ringing membrane, specular, micro grain, darker transmission
    glossy: {
      tension: 0.26, damping: 0.975, flat: 0.012, push: 0.35, pinK: 0.25, visc: 0.08, contactDamp: 0.9,
      hoverRadius: 0.10, hoverAmp: 0.30, pinAmp: 1.1, pressEase: 0.07, tilt: 0,
      stretchK: 90, stretchC: 7, stretchThin: 1.6,
      cream: '#efe4cf', tintAmt: 0.55, thinAmt: 0.8, transl: 0.75, refract: 0.06,
      gloss: 0.55, specAmt: 0.9, grainAmt: 0.15, ambient: 0.42, diffuse: 0.72, wrap: 0,
      rim: 0.10, shadow: 0.9, glow: 0.6, vignette: 0.22, bend: 0,
    },
    'no tilt': { tilt: 0 },
    // 12 Nov: the atmosphere of Juan's reference boards (forms glow orange from inside and dissolve at
    // the edges, a halo of light around them, soft warm cast shadow, the sheet falling to taupe)
    ambience: {
      through: 0.95, throughBase: 0.32, fog: 0.24, fogBlur: 0.11, drum: 1.0, translucent: 0, sheen: 0,   // off for now (13 Nov): Juan saw hard edges on the nose with them on
      bleed: 0.35, bleedRadius: 0.04, tintCurve: 1.4, thinAmt: 1.45, tintAmt: 1.1, glow: 0.75,
      halo: 0.8, cast: 0.14, castLen: 0.1, focus: 0.3, bgAmt: 0.68, bgShade: '#c9ae8d', vignette: 0.04,
      cream: '#f8ecd8', tint: '#ff7424', shadowTint: '#ecd6bf',
      lightPosX: 0.28, lightPosY: 0.82, falloff: 0.075, liveSoft: 0.016, filmGrain: 0.038, filmStretch: 0.024,
      rim: 0.12, ambient: 0.68, diffuse: 0.36, heightScale: 0.17,
    },
    // Juan's panel tuning on the silicone shader, 14 Oct night (recovered from localStorage; visc dropped, it destabilised the sim)
    'juan 14 oct b': {
      damping: 0.9, flat: 0.06, push: 0.05, reach: 0.48, pressEase: 0.18, stretchC: 30, softness: 0.08,
      heightScale: 0.3, tintAmt: 0.35, transl: 0.08, refract: 0.04, ambient: 0.33, diffuse: 1.17, wrap: 1,
      shadow: 0, glow: 0.04, vignette: 0, lightX: -1,
    },
    // Juan's own panel tuning from 14 Oct (recovered from localStorage), on top of the glossy shader
    'juan 14 oct': {
      tension: 0.02, damping: 0.97, cream: '#fff8eb', specColor: '#ffa024', heightScale: 0.11, refract: 0,
      ambient: 0.38, diffuse: 0.85, rim: 0.285, glow: 1.58, lightY: 0.29, lightZ: 0.49,
      gloss: 0.55, specAmt: 0.9, grainAmt: 0.15, wrap: 0, tilt: 0, visc: 0.08, contactDamp: 0.9, push: 0.35,
    },
    night: {
      cream: '#1b1613', tint: '#ff3c02', specColor: '#ffd9c2',
      ambient: 0.3, diffuse: 0.9, rim: 0.18, glow: 0.9,
    },
  };

  const PERF = ['simWidth', 'substeps'];
  const STORE = 'bruta.latexlive.params.v1';   // own key: tunings saved in the first experiment never leak in here

  function defaults() { return window.LatexSurface.DEFAULTS; }

  function round(v) { return typeof v === 'number' ? Math.round(v * 10000) / 10000 : v; }

  // params that differ from DEFAULTS, minus perf keys and any keys in `skip`
  function diff(params, skip) {
    const D = defaults(), out = {};
    for (const k in D) {
      if (PERF.includes(k) || (skip && k in skip)) continue;
      if (round(params[k]) !== round(D[k])) out[k] = round(params[k]);
    }
    return out;
  }

  function same(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => round(a[k]) === round(b[k]));
  }

  // which preset (if any) a diff matches exactly
  function matchPreset(d) {
    for (const k in PRESETS) if (same(d, diff(Object.assign({}, defaults(), PRESETS[k])))) return k;
    return null;
  }

  // "key:value,key:value": colors and numbers both survive URLSearchParams encoding
  function encode(d) { return Object.keys(d).map(k => k + ':' + d[k]).join(','); }
  // allowPerf: an explicit ?p= may still carry simWidth / substeps (old links did)
  function parse(str, allowPerf) {
    const D = defaults(), out = {};
    (str || '').split(',').forEach(kv => {
      const i = kv.indexOf(':');
      if (i < 1) return;
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!(k in D) || (PERF.includes(k) && !allowPerf)) return;
      out[k] = typeof D[k] === 'number' ? (isNaN(+v) || v === '' ? D[k] : +v) : v;
    });
    return out;
  }

  function shareURL(d, scene, page) {
    const u = new URL(page || location.pathname, location.href);
    // keep ':' and ',' readable; only '#' (colors) and the like get escaped
    const esc = v => encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2C/gi, ',');
    const parts = [];
    const p = encode(d);
    if (p) parts.push('p=' + esc(p));
    if (scene) parts.push('scene=' + esc(scene));
    u.search = parts.length ? '?' + parts.join('&') : '';
    return u.toString();
  }

  function load() {
    try { const v = JSON.parse(localStorage.getItem(STORE) || 'null'); return v && typeof v === 'object' ? v : null; }
    catch (_) { return null; }
  }
  let saveT;
  function save(d) {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch (_) { /* private mode */ } }, 250);
  }

  const mq = s => !!(window.matchMedia && window.matchMedia(s).matches);
  const reducedMotion = () => mq('(prefers-reduced-motion: reduce)');
  const coarsePointer = () => mq('(pointer: coarse)');

  // ?quality= wins; narrow viewport → low; touch / few cores / little memory → medium; else high
  function pickQuality(q) {
    const forced = q && q.get('quality');
    if (forced && window.LatexSurface.QUALITY[forced]) return forced;
    if (window.innerWidth < 700) return 'low';
    const cores = navigator.hardwareConcurrency || 8;
    const mem = navigator.deviceMemory || 8;
    if (coarsePointer() || cores <= 4 || mem <= 4) return 'medium';
    return 'high';
  }

  // the params a page starts with: ?p= > ?preset= > localStorage > defaults
  function initialParams(q) {
    if (q.get('p')) return { from: 'url', params: parse(q.get('p'), true) };
    if (q.get('preset') && PRESETS[q.get('preset')]) return { from: 'preset', params: Object.assign({}, PRESETS[q.get('preset')]) };
    const stored = load();
    if (stored) return { from: 'storage', params: parse(encode(stored)) };
    return { from: 'defaults', params: {} };
  }

  // reset the look/physics to DEFAULTS + partial, keep the quality keys; rebuild only what changed
  function apply(surf, partial, forced) {
    const P = surf.params, D = defaults();
    const before = { softness: P.softness, simWidth: P.simWidth };
    for (const k in D) if (!PERF.includes(k)) P[k] = D[k];
    Object.assign(P, partial || {}, forced || {});
    if (P.softness !== before.softness) surf.rebuild();
    if (P.simWidth !== before.simWidth) surf.setSimWidth(P.simWidth);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      t.remove(); return ok;
    }
  }

  window.LATEX_PRESETS = PRESETS;
  window.LATEX_KIT = {
    PERF, STORE, diff, same, matchPreset, encode, parse, shareURL, load, save,
    reducedMotion, coarsePointer, pickQuality, initialParams, apply, copy,
  };
})();
