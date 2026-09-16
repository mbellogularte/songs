/* Sona visualizer — an endless side-scrolling silhouette world, Limbo-style,
   lit by the current track's palette and driven by live audio analysis.
   The scene itself is scripted per track by AI (see server brain.analyzeTrack):
   ground character, silhouette props, sky, weather and beat effects all come
   from a scene spec. The world "walks" like a platformer; energy sets the
   pace, bass pushes the light, beats spark, sections steer the mood. */

import {
  Application, Container, Graphics, Sprite, Texture, BlurFilter,
} from '/vendor/pixi.min.mjs';

const BG = 0x101216;
const CHUNK_W = 600;

/* ---------- color helpers ---------- */
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};
const rgbToInt = ([r, g, b]) => (r << 16) + (g << 8) + b;
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const BG_RGB = hexToRgb('#101216');
const NEAR_RGB = hexToRgb('#0a0b0e');

/* ---------- seeded value noise ---------- */
function makeNoise(seed) {
  const rand = (i) => {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return rand(i) * (1 - u) + rand(i + 1) * u;
  };
}

/* ---------- ground styles ---------- */
const GROUND_STYLES = {
  hills:     { freq: 1.0, amp: 1.0, jag: 0.15 },
  mountains: { freq: 1.5, amp: 1.9, jag: 0.55 },
  dunes:     { freq: 0.55, amp: 0.8, jag: 0.04 },
  plains:    { freq: 0.7, amp: 0.25, jag: 0.05 },
  waves:     { freq: 1.3, amp: 0.5, jag: 0.2 },
};

/* ---------- silhouette element library (drawn white, tinted later) ---------- */
const ELEMENTS = {
  tree(g, x, y, s, r) {
    const th = (55 + r * 135) * s;
    const w = (3 + r * 5) * s;
    g.moveTo(x - w, y + 4).lineTo(x - w * 0.12, y - th).lineTo(x + w * 0.12, y - th).lineTo(x + w, y + 4).closePath().fill(0xffffff);
    for (let bi = 0; bi < 3; bi++) {
      const by = y - th * (0.45 + bi * 0.18);
      const dir = bi % 2 ? 1 : -1;
      const bl = th * (0.22 - bi * 0.05);
      g.moveTo(x, by).lineTo(x + dir * bl, by - bl * 0.45).stroke({ width: 1.6, color: 0xffffff });
    }
  },
  pine(g, x, y, s, r) {
    const th = (70 + r * 120) * s;
    const w = (16 + r * 14) * s;
    g.rect(x - 1.5 * s, y - th * 0.2, 3 * s, th * 0.22).fill(0xffffff);
    for (let i = 0; i < 3; i++) {
      const ty = y - th * (0.16 + i * 0.28);
      const tw = w * (1 - i * 0.28);
      g.moveTo(x - tw, ty).lineTo(x, ty - th * 0.34).lineTo(x + tw, ty).closePath().fill(0xffffff);
    }
  },
  cactus(g, x, y, s, r) {
    const th = (45 + r * 70) * s;
    const w = 7 * s;
    g.roundRect(x - w / 2, y - th, w, th + 4, w / 2).fill(0xffffff);
    const ah = th * 0.45;
    g.roundRect(x - w * 2.2, y - th * 0.62, w * 0.8, ah, w * 0.4).fill(0xffffff);
    g.rect(x - w * 2.2, y - th * 0.62 - w * 0.2, w * 2.2, w * 0.8).fill(0xffffff);
    if (r > 0.5) {
      g.roundRect(x + w * 1.4, y - th * 0.5, w * 0.8, ah * 0.8, w * 0.4).fill(0xffffff);
      g.rect(x, y - th * 0.5 - w * 0.2, w * 2.2, w * 0.8).fill(0xffffff);
    }
  },
  building(g, x, y, s, r) {
    const bh = (80 + r * 190) * s;
    const bw = (24 + r * 36) * s;
    g.rect(x - bw / 2, y - bh, bw, bh + 6).fill(0xffffff);
    if (r > 0.4) g.rect(x - bw * 0.22, y - bh - 14 * s, bw * 0.44, 14 * s).fill(0xffffff);
    if (r > 0.75) g.rect(x - 1, y - bh - 30 * s, 2, 30 * s).fill(0xffffff);
  },
  tower(g, x, y, s, r) {
    const th = (110 + r * 130) * s;
    g.moveTo(x - 5 * s, y).lineTo(x - 1, y - th).lineTo(x + 1, y - th).lineTo(x + 5 * s, y).closePath().fill(0xffffff);
    for (let i = 1; i <= 3; i++) {
      const cy = y - th * (i / 3.6);
      const cw = (14 - i * 3) * s;
      g.moveTo(x - cw, cy).lineTo(x + cw, cy).stroke({ width: 1.4, color: 0xffffff });
    }
  },
  rock(g, x, y, s, r) {
    const rw = (18 + r * 26) * s;
    const rh = (10 + r * 16) * s;
    g.moveTo(x - rw, y + 4).lineTo(x - rw * 0.5, y - rh).lineTo(x + rw * 0.15, y - rh * (0.7 + r * 0.5))
      .lineTo(x + rw * 0.7, y - rh * 0.5).lineTo(x + rw, y + 4).closePath().fill(0xffffff);
  },
  grass(g, x, y, s, r) {
    const n = 4 + Math.floor(r * 5);
    for (let i = 0; i < n; i++) {
      const gx = x + (i - n / 2) * 3.2;
      const gh = (7 + ((r * 13 + i * 7) % 11)) * s;
      const lean = ((i % 3) - 1) * 3;
      g.moveTo(gx, y + 2).lineTo(gx + lean, y - gh).stroke({ width: 1.1, color: 0xffffff });
    }
  },
  arch(g, x, y, s, r) {
    const ah = (50 + r * 60) * s;
    const aw = (26 + r * 18) * s;
    g.rect(x - aw, y - ah, 8 * s, ah + 4).fill(0xffffff);
    g.rect(x + aw - 8 * s, y - ah, 8 * s, ah + 4).fill(0xffffff);
    if (r > 0.35) g.rect(x - aw, y - ah - 7 * s, aw * 2, 7 * s).fill(0xffffff);
  },
};

const DEFAULT_SCENE = {
  ground: { style: 'hills', roughness: 0.4 },
  elements: [
    { type: 'tree', layer: 'mid', density: 0.28, scale: 0.6 },
    { type: 'tree', layer: 'near', density: 0.22, scale: 0.55 },
    { type: 'grass', layer: 'near', density: 0.5, scale: 0.5 },
  ],
  sky: { orb: 'none', orbHeight: 0.5, starDensity: 0.25 },
  weather: { type: 'dust', intensity: 0.4 },
  beatEffect: 'flare',
};

/* ---------- module state ---------- */
const S = {
  app: null,
  getBands: null,
  playing: false,
  worldX: 0,
  travel: 0,
  energyBase: 0.45,
  intensity: null,      // live section intensity override
  sectionFx: null,      // live per-section overrides {weather, weatherIntensity, beatEffect, warmth}
  warmth: 0,
  ampFactor: 1,
  scene: DEFAULT_SCENE,
  cur: null,
  target: null,
  layers: [],
  light: null,
  horizon: null,
  orb: null,
  starBox: null,
  stars: [],
  flash: null,
  particles: [],
  particleBox: null,
  fireflyTex: null,
  flock: [],
  flockBox: null,
  lastBeat: 0,
  bassAvg: 0.001,
  sm: { bass: 0, mid: 0, high: 0, energy: 0 },
};

function sceneColors(palette) {
  const [a, b, c] = [0, 1, 2].map((i) => hexToRgb(palette[Math.min(i, palette.length - 1)]));
  return {
    light: a,
    horizon: mix(BG_RGB, a, 0.75),
    far: mix(BG_RGB, b, 0.4),
    mid: mix(BG_RGB, mix(b, c, 0.5), 0.28),
    near: mix(NEAR_RGB, c, 0.14),
    spark: mix(a, [255, 255, 255], 0.35),
  };
}
const IDLE = sceneColors(['#4a5468', '#333b4c', '#232936']);

/* ---------- textures ---------- */
function radialTexture(size = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(cv);
}
function dotTexture(size = 32) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(cv);
}

/* ---------- terrain layers ---------- */
function makeLayer({ name, parallax, baseY, amp, freq, blur, seed }) {
  const container = new Container();
  // filter resolution pinned to 1: at renderer resolution 2 Pixi's filter
  // frame math breaks (renders only a quarter of the area) — and a blur
  // doesn't need retina resolution anyway
  if (blur) container.filters = [new BlurFilter({ strength: blur, quality: 2, resolution: 1 })];
  const hash = (i) => {
    const x = Math.sin(i * 127.1 + (seed * 7 + 3) * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    name, parallax, baseY, amp, freq, container, hash,
    noise: makeNoise(seed),
    noise2: makeNoise(seed + 101),
    chunks: new Map(),
    edge: new Map(),
    elements: [],
  };
}

function buildChunk(layer, idx, H) {
  const g = new Graphics();
  const x0 = idx * CHUNK_W;
  const gs = GROUND_STYLES[S.scene.ground?.style] || GROUND_STYLES.hills;
  const rough = Math.max(0, Math.min(1, S.scene.ground?.roughness ?? 0.4));
  const amp = layer.amp * S.ampFactor * gs.amp * (0.7 + rough * 0.6);
  const freq = layer.freq * gs.freq * (0.8 + rough * 0.5);
  const jag = gs.jag * (0.5 + rough);
  const baseY = layer.baseY * H;
  const step = 24;
  const pts = [];
  const prevEdge = layer.edge.get(idx - 1);
  for (let x = 0; x <= CHUNK_W; x += step) {
    const wx = x0 + x;
    const n = layer.noise(wx * freq) * (1 - jag) + layer.noise2(wx * freq * 3.1) * jag;
    let h = baseY - n * amp;
    if (prevEdge !== undefined && x < 120) {
      const t = x / 120;
      h = prevEdge * (1 - t * t) + h * (t * t); // blend from previous chunk edge
    }
    pts.push([x, h]);
  }
  layer.edge.set(idx, pts[pts.length - 1][1]);

  g.moveTo(0, H + 50);
  for (const [x, y] of pts) g.lineTo(x, y);
  g.lineTo(CHUNK_W, H + 50);
  g.closePath();
  g.fill(0xffffff);

  // AI-chosen silhouette props, independently random per site
  const SITE = 50;
  for (const el of layer.elements) {
    const draw = ELEMENTS[el.type];
    if (!draw) continue;
    const salt = el.type.length * 13.7;
    for (let s = 0; s < CHUNK_W / SITE; s++) {
      const site = idx * (CHUNK_W / SITE) + s;
      const r = layer.hash(site + salt);
      if (r < (el.density ?? 0.3) * 0.55) {
        const x = s * SITE + Math.floor(layer.hash(site + salt + 0.5) * (SITE - 12)) + 6;
        const rs = layer.hash(site + salt + 0.25);
        const groundY = pts[Math.min(Math.round(x / step), pts.length - 1)][1];
        draw(g, x, groundY, 0.45 + (el.scale ?? 0.5) * 0.9, rs);
      }
    }
  }
  g.x = idx * CHUNK_W;
  layer.container.addChild(g);
  layer.chunks.set(idx, g);
}

function ensureChunks(layer, H, W) {
  const px = S.worldX * layer.parallax;
  const first = Math.floor((px - 100) / CHUNK_W);
  const last = Math.floor((px + W + 500) / CHUNK_W);
  for (let i = first; i <= last; i++) {
    if (!layer.chunks.has(i)) buildChunk(layer, i, H);
  }
  for (const [i, g] of layer.chunks) {
    if (i < first - 1 || i > last + 1) {
      g.destroy();
      layer.chunks.delete(i);
      layer.edge.delete(i);
    }
  }
  // The container stays at 0 and each chunk scrolls itself. This keeps the
  // container's bounds pinned to the viewport, so the blur filters get a
  // correct render region at every device pixel ratio — no filterArea math.
  for (const [i, g] of layer.chunks) {
    g.x = i * CHUNK_W - px;
  }
}

/* ---------- sky ---------- */
function rebuildStars(W, H) {
  for (const st of S.stars) st.sp.destroy();
  S.stars = [];
  const density = S.scene.sky?.starDensity ?? 0.25;
  const n = Math.round(density * 90);
  for (let i = 0; i < n; i++) {
    const sp = new Sprite(S.fireflyTex);
    sp.anchor.set(0.5);
    sp.blendMode = 'add';
    sp.scale.set(0.04 + Math.random() * 0.07);
    sp.position.set(Math.random() * W, Math.random() * H * 0.55);
    S.starBox.addChild(sp);
    S.stars.push({ sp, phase: Math.random() * 6.28, speed: 0.01 + Math.random() * 0.03, base: 0.3 + Math.random() * 0.5 });
  }
}

/* ---------- weather particles ---------- */
function spawnWeather(W, H, kind, burst = false) {
  const sp = new Sprite(S.fireflyTex);
  sp.anchor.set(0.5);
  sp.blendMode = 'add';
  const p = { sp, kind, life: 1, x: Math.random() * (W + 80) - 40, y: 0 };
  switch (kind) {
    case 'rain':
      p.y = -10; p.vx = -1.6; p.vy = 7 + Math.random() * 4;
      p.decay = 0; sp.scale.set(0.045, 0.5); sp.alpha = 0.26;
      break;
    case 'snow':
      p.y = -10; p.vx = -0.3; p.vy = 0.5 + Math.random() * 0.7;
      p.decay = 0; p.wobble = Math.random() * 6.28; sp.scale.set(0.07 + Math.random() * 0.07); sp.alpha = 0.55;
      break;
    case 'embers':
      p.y = H * (0.75 + Math.random() * 0.2); p.vx = -0.2; p.vy = -(0.5 + Math.random() * 0.9);
      p.decay = 0.004 + Math.random() * 0.004; p.wobble = Math.random() * 6.28;
      sp.scale.set(0.07 + Math.random() * 0.09);
      break;
    case 'firefly':
      p.y = H * (0.5 + Math.random() * 0.38); p.vx = -0.15; p.vy = -(0.1 + Math.random() * 0.3);
      p.decay = burst ? 0.007 : 0.003; p.wobble = Math.random() * 6.28;
      sp.scale.set(burst ? 0.2 + Math.random() * 0.3 : 0.1 + Math.random() * 0.12);
      break;
    default: // dust
      p.y = H * (0.3 + Math.random() * 0.6); p.vx = -(0.1 + Math.random() * 0.3); p.vy = -(0.08 + Math.random() * 0.18);
      p.decay = 0.0015 + Math.random() * 0.002;
      sp.scale.set(0.08 + Math.random() * 0.12);
      sp.alpha = 0.4;
  }
  S.particleBox.addChild(sp);
  S.particles.push(p);
}

function spawnFlock(W, H) {
  const n = 5 + Math.floor(Math.random() * 5);
  const y0 = H * (0.16 + Math.random() * 0.28);
  for (let i = 0; i < n; i++) {
    const g = new Graphics();
    g.moveTo(-7, 0).lineTo(0, -2.6).lineTo(7, 0).lineTo(0, -0.8).closePath().fill(0xffffff);
    g.x = W + 60 + i * (26 + Math.random() * 30);
    g.y = y0 + (Math.random() - 0.5) * 46;
    S.flockBox.addChild(g);
    S.flock.push({ g, vx: 1.6 + Math.random() * 0.7, phase: Math.random() * 6.28, y0: g.y });
  }
}

/* ---------- beat effects ---------- */
function beat(strength, W, H) {
  const fx = S.sectionFx?.beatEffect || S.scene.beatEffect || 'flare';
  if (window.gsap) {
    window.gsap.to(S.light, {
      alpha: Math.min(1, 0.5 + S.sm.energy * 0.5 + 0.18),
      duration: 0.1, yoyo: true, repeat: 1, ease: 'sine.out', overwrite: 'auto',
    });
  }
  if (fx === 'burst' || fx === 'flare') {
    const n = fx === 'burst' ? 6 + Math.round(strength * 10) : 2 + Math.round(strength * 4);
    for (let i = 0; i < n; i++) spawnWeather(W, H, 'firefly', true);
  }
  if (fx === 'lightning' && strength > 0.5 && Math.random() < 0.45 && window.gsap) {
    window.gsap.fromTo(S.flash, { alpha: 0.28 }, { alpha: 0, duration: 0.5, ease: 'power3.out', overwrite: 'auto' });
  }
}

/* ---------- public api ---------- */
export async function initVisualizer(mount, getBands) {
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: BG,
    antialias: true,
    preference: 'webgl',
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  mount.appendChild(app.canvas);
  S.app = app;
  S.getBands = getBands;
  S.cur = JSON.parse(JSON.stringify(IDLE));
  S.target = JSON.parse(JSON.stringify(IDLE));

  // Pixi v8: renderer.width/height are already logical (CSS) units
  const H = () => app.renderer.height;
  const W = () => app.renderer.width;

  const lightTex = radialTexture();
  S.fireflyTex = dotTexture();

  // sky: stars, then light + horizon glow + orb disc
  S.starBox = new Container();
  app.stage.addChild(S.starBox);

  S.light = new Sprite(lightTex);
  S.light.anchor.set(0.5);
  S.light.blendMode = 'add';
  app.stage.addChild(S.light);

  S.horizon = new Sprite(lightTex);
  S.horizon.anchor.set(0.5);
  S.horizon.blendMode = 'add';
  S.horizon.alpha = 0.3;
  app.stage.addChild(S.horizon);

  S.orb = new Graphics();
  S.orb.circle(0, 0, 34).fill(0xffffff);
  S.orb.alpha = 0;
  app.stage.addChild(S.orb);

  // terrain
  S.layers = [
    makeLayer({ name: 'far', parallax: 0.15, baseY: 0.58, amp: 70, freq: 0.0016, blur: 10, seed: 11 }),
    makeLayer({ name: 'mid', parallax: 0.4, baseY: 0.7, amp: 100, freq: 0.0021, blur: 4, seed: 23 }),
  ];
  S.particleBox = new Container();
  S.flockBox = new Container();
  const near = makeLayer({ name: 'near', parallax: 1, baseY: 0.87, amp: 80, freq: 0.003, blur: 0, seed: 47 });
  S.layers.push(near);

  app.stage.addChild(S.layers[0].container);
  app.stage.addChild(S.layers[1].container);
  app.stage.addChild(S.flockBox);
  app.stage.addChild(S.particleBox);
  app.stage.addChild(near.container);

  // lightning flash overlay
  S.flash = new Sprite(Texture.WHITE);
  S.flash.alpha = 0;
  app.stage.addChild(S.flash);

  applyScene(DEFAULT_SCENE);
  rebuildStars(W(), H());

  let nextFlock = 700 + Math.random() * 900;
  let t = 0;

  app.ticker.add((ticker) => {
    const dt = ticker.deltaTime;
    t += dt;
    const bands = S.getBands ? S.getBands() : { bass: 0, mid: 0, high: 0, energy: 0 };
    const sm = S.sm;
    sm.bass += (bands.bass - sm.bass) * 0.12;
    sm.mid += (bands.mid - sm.mid) * 0.08;
    sm.high += (bands.high - sm.high) * 0.1;
    sm.energy += (bands.energy - sm.energy) * 0.04;

    const h = H(); const w = W();

    // beat detection: bass flux over rolling average
    S.bassAvg += (bands.bass - S.bassAvg) * 0.015;
    const now = performance.now();
    if (bands.bass > S.bassAvg * 1.45 && bands.bass > 0.22 && now - S.lastBeat > 260) {
      S.lastBeat = now;
      beat(Math.min(1, bands.bass), w, h);
    }

    // the walk: energy (or the live section intensity) sets the pace
    const drive = S.intensity ?? S.energyBase;
    const pace = (S.playing ? 0.35 + drive * 0.9 + sm.energy * 1.1 : 0.12) + S.travel;
    S.worldX += pace * dt;
    S.travel *= Math.pow(0.985, dt);

    // colors ease toward the scene target
    for (const k of Object.keys(S.target)) {
      S.cur[k] = mix(S.cur[k], S.target[k], 0.02 * dt);
    }

    // light breathes with bass, brightens with energy, and drifts through the
    // scene so the composition never sits still; sections can warm/cool it
    const sky = S.scene.sky || {};
    const targetWarmth = S.sectionFx?.warmth ?? 0;
    S.warmth += (targetWarmth - S.warmth) * 0.01 * dt;
    const warmed = S.warmth >= 0
      ? mix(S.cur.light, [255, 190, 120], S.warmth * 0.45)
      : mix(S.cur.light, [140, 180, 255], -S.warmth * 0.45);
    const lightX = w * (0.5 + 0.16 * Math.sin(S.worldX * 0.0006));
    const orbY = h * (0.14 + (1 - (sky.orbHeight ?? 0.5)) * 0.4);
    S.light.position.set(lightX, orbY);
    S.light.width = S.light.height = Math.max(w, h) * (1.05 + sm.bass * 0.4);
    S.light.alpha = 0.42 + sm.energy * 0.5;
    S.light.tint = rgbToInt(warmed.map(Math.round));

    S.orb.position.set(lightX, orbY);
    const orbOn = sky.orb && sky.orb !== 'none';
    S.orb.alpha += ((orbOn ? (sky.orb === 'moon' ? 0.75 : 0.55) : 0) - S.orb.alpha) * 0.02 * dt;
    S.orb.scale.set(1 + sm.bass * 0.1);
    S.orb.tint = sky.orb === 'moon'
      ? rgbToInt(mix(S.cur.light, [235, 240, 250], 0.6).map(Math.round))
      : rgbToInt(S.cur.light.map(Math.round));

    S.horizon.position.set(w * 0.5, h * 0.62);
    S.horizon.width = w * 2.2;
    S.horizon.height = h * (0.5 + sm.bass * 0.12);
    S.horizon.alpha = 0.2 + sm.energy * 0.3;
    S.horizon.tint = rgbToInt(S.cur.horizon.map(Math.round));

    // stars twinkle, and shimmer a little with the highs
    const starTint = rgbToInt(mix(S.cur.spark, [255, 255, 255], 0.5).map(Math.round));
    for (const st of S.stars) {
      st.phase += st.speed * dt;
      st.sp.alpha = st.base * (0.55 + 0.45 * Math.sin(st.phase)) * (0.7 + sm.high * 0.6);
      st.sp.tint = starTint;
    }

    // terrain tint + scroll
    const tints = [S.cur.far, S.cur.mid, S.cur.near];
    S.layers.forEach((layer, i) => {
      ensureChunks(layer, h, w);
      const tint = rgbToInt(tints[i].map(Math.round));
      for (const g of layer.chunks.values()) g.tint = tint;
    });

    // weather: emission follows spec intensity + the highs; sections override
    const weather = S.sectionFx?.weather
      ? { type: S.sectionFx.weather, intensity: S.sectionFx.weatherIntensity ?? 0.5 }
      : S.scene.weather || { type: 'dust', intensity: 0.4 };
    const kind = weather.type === 'fireflies' ? 'firefly' : weather.type;
    if (kind && kind !== 'none') {
      const cap = kind === 'rain' ? 210 : kind === 'snow' ? 150 : 130;
      const rate = (kind === 'rain' ? 0.5 : kind === 'snow' ? 0.25 : 0.1) * (0.4 + (weather.intensity ?? 0.5)) + sm.high * 0.4;
      if (S.particles.length < cap && Math.random() < rate) spawnWeather(w, h, kind);
    }
    const sparkTint = rgbToInt(S.cur.spark.map(Math.round));
    for (let i = S.particles.length - 1; i >= 0; i--) {
      const p = S.particles[i];
      if (p.wobble !== undefined) {
        p.wobble += 0.05 * dt;
        p.x += Math.sin(p.wobble) * 0.4 * dt;
      }
      p.x += ((p.vx || 0) - pace * (p.kind === 'rain' ? 0.2 : 0.55)) * dt;
      p.y += (p.vy || 0) * dt;
      if (p.decay) p.life -= p.decay * dt;
      p.sp.position.set(p.x, p.y);
      if (p.kind === 'firefly') p.sp.alpha = Math.max(0, p.life) * (0.7 + 0.3 * Math.sin((p.wobble || 0) * 3));
      else if (p.kind === 'embers') p.sp.alpha = Math.max(0, p.life) * (0.6 + 0.4 * Math.sin((p.wobble || 0) * 4));
      else if (p.kind === 'dust') p.sp.alpha = Math.max(0, p.life) * 0.5;
      p.sp.tint = sparkTint;
      const gone = (p.decay && p.life <= 0) || p.x < -30 || p.y > h + 20 || p.y < -30;
      if (gone) {
        p.sp.destroy();
        S.particles.splice(i, 1);
      }
    }

    // bird flocks drift through now and then
    nextFlock -= dt;
    if (nextFlock <= 0) {
      spawnFlock(w, h);
      nextFlock = 2200 + Math.random() * 2600;
    }
    const flockTint = rgbToInt(S.cur.near.map(Math.round));
    for (let i = S.flock.length - 1; i >= 0; i--) {
      const b = S.flock[i];
      b.phase += 0.18 * dt;
      b.g.x -= (b.vx + pace * 0.3) * dt;
      b.g.y = b.y0 + Math.sin(b.phase * 0.35) * 12;
      b.g.scale.y = 0.55 + Math.abs(Math.sin(b.phase)) * 0.8;
      b.g.tint = flockTint;
      b.g.alpha = 0.8;
      if (b.g.x < -30) {
        b.g.destroy();
        S.flock.splice(i, 1);
      }
    }

    // lightning flash covers the viewport
    S.flash.width = w;
    S.flash.height = h;
    S.flash.tint = rgbToInt(mix(S.cur.light, [255, 255, 255], 0.7).map(Math.round));
  });

  window.addEventListener('resize', () => {
    rebuildStars(W(), H());
    // terrain bakes the viewport height into each chunk — rebuild on resize
    for (const layer of S.layers) {
      for (const g of layer.chunks.values()) g.destroy();
      layer.chunks.clear();
      layer.edge.clear();
    }
  });
  window.__sona = S; // debug hook
  return true;
}

function applyScene(scene) {
  S.scene = scene;
  const byLayer = { mid: [], near: [] };
  for (const el of scene.elements || []) {
    (byLayer[el.layer] || byLayer.near).push(el);
  }
  for (const layer of S.layers) {
    if (layer.name === 'mid') layer.elements = byLayer.mid;
    if (layer.name === 'near') layer.elements = byLayer.near;
  }
}

// New track palette → new light; called on every track change.
export function setScene(palette, energy = 0.5) {
  if (!S.app) return;
  const pal = Array.isArray(palette) && palette.length ? palette : ['#4a5468', '#333b4c', '#232936'];
  S.target = sceneColors(pal);
  S.energyBase = Math.max(0, Math.min(1, energy));
  S.intensity = null;
  S.ampFactor = 0.7 + S.energyBase * 0.7;
  if (window.gsap) {
    window.gsap.fromTo(S.light, { alpha: S.light.alpha }, {
      alpha: Math.min(1, S.light.alpha + 0.35),
      duration: 1.6, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: 'auto',
    });
  }
}

// AI scene spec for the current track → the world walks into a new scene.
export function setVisual(spec) {
  if (!S.app || !spec) return;
  applyScene({ ...DEFAULT_SCENE, ...spec });
  const r = S.app.renderer;
  rebuildStars(r.width / r.resolution, r.height / r.resolution);
  S.travel = Math.max(S.travel, 9); // brisk walk into the new world
}

// Live section intensity from the track's timeline (null = use track energy).
export function setIntensity(v) {
  S.intensity = v == null ? null : Math.max(0, Math.min(1, v));
}

// Live per-section scene overrides — the visuals evolve through the song.
export function setSectionFx(fx) {
  S.sectionFx = fx || null;
}

export function setPlaying(playing) {
  S.playing = !!playing;
}
