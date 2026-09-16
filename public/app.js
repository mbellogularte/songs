/* Sona player — Spotify-grade UI over an AI-scripted living world.
   Two audio decks crossfade between tracks like a DJ mix; every song brings
   its own AI-generated design identity (accent, typography, mood) and a timed
   visual script (scene, sections, lyrics). */

import { initVisualizer, setScene, setPlaying, setVisual, setIntensity, setSectionFx } from '/visualizer.js';

const $ = (id) => document.getElementById(id);
const gsap = window.gsap;

const state = {
  stream: null,
  currentTrackId: null,
  playedIds: new Set(),
  pending: [],           // optimistic queue entries awaiting the server
  waiting: false,
  suggestionsFor: null,
  visual: null,
  visualFor: null,
  lyricIdx: -2,
  sectionT: undefined,
  mixing: false,         // a crossfade into the next track is underway
};

/* ================= audio: two decks + crossfade ================= */
// iOS suspends the WebAudio graph the moment the app goes to the background,
// killing the sound. On iOS we therefore play the elements NATIVELY (background
// playback + lock screen controls work) and skip the analyser/crossfade graph;
// visuals get synthesized bands instead. Everywhere else: full WebAudio.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let audioCtx = null;
let analyser = null;
let freq = null;
let master = null;

const decks = [mkDeck(), mkDeck()];
let active = 0;
const deck = () => decks[active];

function mkDeck() {
  const el = new Audio();
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  // iOS is happier with media elements that live in the document
  (document.body || document.documentElement).appendChild(el);
  return { el, gain: null, unlocked: false };
}

// iOS Safari only allows .play() on elements once activated by a user gesture.
// A synchronous load() during the gesture activates the element WITHOUT
// consuming the gesture's one allowed play() — never play() here, or the
// real playback in the same tap gets blocked.
const SILENCE = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';
function unlockDecks() {
  for (const d of decks) {
    if (d.unlocked) continue;
    try {
      if (!d.el.src) d.el.src = SILENCE;
      d.el.load();
      d.unlocked = true;
    } catch { /* ignore */ }
  }
}

// any first touch anywhere: create/resume the audio context + activate decks
document.addEventListener('pointerdown', () => {
  connectAnalyser();
  unlockDecks();
  audioCtx?.resume();
}, { passive: true });

function connectAnalyser() {
  if (audioCtx || IOS) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  master = audioCtx.createGain();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  master.connect(analyser);
  analyser.connect(audioCtx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);
  for (const d of decks) {
    const src = audioCtx.createMediaElementSource(d.el);
    d.gain = audioCtx.createGain();
    src.connect(d.gain);
    d.gain.connect(master);
  }
}

function ramp(gainNode, to, sec) {
  if (!gainNode || !audioCtx) return;
  const g = gainNode.gain;
  g.cancelScheduledValues(audioCtx.currentTime);
  g.setValueAtTime(g.value, audioCtx.currentTime);
  g.linearRampToValueAtTime(to, audioCtx.currentTime + Math.max(0.05, sec));
}

// live bands feeding the visualizer: bass / mid / high / overall energy, 0..1
function getBands() {
  if (deck().el.paused) return { bass: 0, mid: 0, high: 0, energy: 0 };
  if (!analyser) {
    // no WebAudio (iOS): synthesize a pulse locked to the track's real tempo
    // (Gemini estimates the BPM) and scaled by the current section intensity
    const ct = deck().el.currentTime;
    const bpm = state.visual?.bpm || 120;
    let drive = 0.55;
    const secs = state.visual?.sections || [];
    for (const s of secs) {
      if (s.t <= ct) drive = s.intensity;
      else break;
    }
    const beat = Math.max(0, Math.sin(ct * Math.PI * 2 * (bpm / 60))) ** 3;
    return {
      bass: 0.16 + beat * (0.25 + drive * 0.4),
      mid: 0.22 + drive * 0.18 + 0.08 * Math.sin(ct * 1.3),
      high: 0.18 + drive * 0.15 + 0.1 * Math.sin(ct * 3.7 + 1),
      energy: 0.2 + drive * 0.35 + 0.06 * Math.sin(ct * 0.4),
    };
  }
  analyser.getByteFrequencyData(freq);
  const n = freq.length;
  const avg = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += freq[i];
    return s / ((b - a) * 255);
  };
  return {
    bass: avg(0, Math.floor(n * 0.08)),
    mid: avg(Math.floor(n * 0.08), Math.floor(n * 0.4)),
    high: avg(Math.floor(n * 0.4), n),
    energy: avg(0, n),
  };
}

initVisualizer($('scene'), getBands).catch((err) => console.error('visualizer failed', err));

/* ================= design tokens (per-song AI identity) ================= */
const LYRIC_FONTS = {
  sans: "'Figtree', 'Helvetica Neue', sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

function applyPalette(palette, energy) {
  const p = Array.isArray(palette) && palette.length ? palette : ['#5a6478', '#333b4c', '#232936'];
  const root = document.documentElement.style;
  root.setProperty('--c0', p[0]);
  root.setProperty('--c1', p[1] || p[0]);
  root.setProperty('--c2', p[2] || p[1] || p[0]);
  root.setProperty('--glow', p[0] + '55');
  setScene(p, energy ?? 0.5);
}

function applyDesign(design, palette) {
  const root = document.documentElement.style;
  const accent = design?.accent || palette?.[0] || '#8090a8';
  root.setProperty('--accent', accent);
  root.setProperty('--title-w', design?.titleWeight || '800');
  root.setProperty('--title-tt', design?.titleCase === 'uppercase' ? 'uppercase' : 'none');
  root.setProperty('--lyric-w', design?.lyricWeight || '700');
  root.setProperty('--lyric-ff', LYRIC_FONTS[design?.lyricFont] || LYRIC_FONTS.sans);
  document.body.className = `mood-${design?.mood || 'clean'}`;
}

/* ================= AI visual script ================= */
function applyVisual(track) {
  if (!track?.visual || state.visualFor === track.id) return;
  state.visualFor = track.id;
  state.visual = track.visual;
  state.lyricIdx = -2;
  state.sectionT = undefined;
  setVisual(track.visual.scene);
  applyDesign(track.visual.design, track.palette);
  buildLyrics(track.visual.lyrics || []);
}

function buildLyrics(lines) {
  const box = $('lyrics');
  box.innerHTML = '';
  for (const l of lines) {
    const div = document.createElement('div');
    div.className = 'line';
    div.textContent = l.text;
    box.appendChild(div);
  }
  const lead = $('stage').clientHeight / 2 + 30;
  gsap ? gsap.set(box, { y: lead }) : (box.style.transform = `translateY(${lead}px)`);
}

function syncTimeline() {
  const v = state.visual;
  if (!v) return;
  const t = deck().el.currentTime;

  // lyrics: slide the active line into the center of the stage
  const lines = v.lyrics || [];
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= t + 0.25) idx = i;
    else break;
  }
  if (idx !== state.lyricIdx) {
    state.lyricIdx = idx;
    const box = $('lyrics');
    const els = box.children;
    for (let i = 0; i < els.length; i++) {
      els[i].className = 'line' + (i === idx ? ' active' : i < idx ? ' past' : '');
    }
    const stage = $('stage');
    // #lyrics is pinned to the stage top, so line.offsetTop is stable — slide
    // the whole list so the active line sits exactly in the stage center
    let target;
    if (idx >= 0 && els[idx]) {
      target = stage.clientHeight / 2 - els[idx].offsetTop - els[idx].offsetHeight / 2;
    } else {
      target = stage.clientHeight / 2 + 30; // lead-in: first line waits just below center
    }
    gsap ? gsap.to(box, { y: target, duration: 0.7, ease: 'power3.out' }) : (box.style.transform = `translateY(${target}px)`);
  }

  // sections: intensity + scene evolution (weather, beat fx, warmth)
  const secs = v.sections || [];
  let cur = null;
  for (const s of secs) {
    if (s.t <= t) cur = s;
    else break;
  }
  if (cur?.t !== state.sectionT) {
    state.sectionT = cur?.t;
    setIntensity(cur ? cur.intensity : null);
    setSectionFx(cur && (cur.weather || cur.beatEffect || cur.warmth != null)
      ? { weather: cur.weather, weatherIntensity: cur.weatherIntensity, beatEffect: cur.beatEffect, warmth: cur.warmth }
      : null);
  }
}

/* ================= api ================= */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

/* ================= landing: floating genre prompts ================= */
// label shown on the card; prompt is what actually seeds the stream
const GENRES = [
  'Afro House', 'Speed Garage', 'Sammy Virji x KETTAMA', 'Jump-Up Drum & Bass', 'Hard Techno',
  'Hard Dance', 'Melodic House', 'French House', 'Latin House', 'Brazilian Funk',
  'Dungeon Synth', 'Comfy Synth', 'Blackgaze', 'Breakcore / Footwork Jungle', 'Deconstructed Club',
  'Neo-Microhouse', 'Krushclub', 'Sigilkore', 'Odetari x 6arelyhuman', 'Hyperpop-Adjacent / Digicore',
  'Oklou x Danny L Harle', 'PluggnB', 'Summrs x Kankan', 'Rage', 'Trap EDM', 'Boom Bap Revival',
  'UK Underground Rap', 'EsDeeKid x fakemink', 'Sexy Drill', 'Cash Cobain x Ice Spice',
  'Baltimore Club-Rap', 'Neoperreo', 'AKRIILA', 'Vinahouse', 'Funkot / Indobounce', 'Bedroom Pop',
  'Japanese City Pop', '50s Vocal Revival', 'Cinematic Score',
  { l: 'Feng', p: 'Feng — late night bus home, headphones in' },
  { l: 'dexter in the newsagent', p: 'dexter in the newsagent — dim red light, slow wind' },
  { l: 'Infinity Knives & Brian Ennals', p: 'Infinity Knives & Brian Ennals — underground DC basement' },
  { l: 'Too Many Strikers', p: 'Too Many Strikers — bedroom guitars, trap drums' },
  { l: 'bunii', p: 'bunii — sad boy indie skate session' },
  { l: 'overtonight', p: 'overtonight — acoustic R&B at 2am' },
  { l: 'Mexican Reggaeton', p: 'Mexican Reggaeton — slow perreo, dark plugg' },
  { l: 'El Malilla', p: 'El Malilla — CDMX street perreo' },
  { l: 'Kidd Voodoo', p: 'Kidd Voodoo — Santiago underground reggaeton' },
  { l: 'La Obsesión Factory', p: 'La Obsesión Factory — queer club, deconstructed dembow' },
  { l: 'Planta Industrial', p: 'Planta Industrial — Chilean garage rock, cheap beer' },
  { l: 'Marilina Bertoldi', p: 'Marilina Bertoldi — Mexican punk basement' },
  { l: 'Duquesa', p: 'Duquesa — favela bass, car speakers' },
  { l: 'Latin Electronic', p: 'Latin Electronic — Colombian night ride, aleteo' },
  { l: 'Amapiano', p: 'Amapiano — Durban taxi rank, dark drums' },
];

// every prompt idea gets its own light, like generated tracks do — a stable
// palette hashed from the name, shown as a little gradient thumb
function promptPalette(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue}, 72%, 58%)`, `hsl(${(hue + 46) % 360}, 64%, 44%)`, `hsl(${(hue + 320) % 360}, 55%, 36%)`];
}

const rectsOverlap = (a, b, pad = 0) =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

function seedFloatingPrompts() {
  const box = $('float-prompts');
  if (!box || box.children.length) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const count = W < 640 ? 6 : 10;
  const picks = [...GENRES].sort(() => Math.random() - 0.5).slice(0, count + 4);
  // keep clear of the logo / tagline / input column in the middle
  const centerW = Math.min(700, W * 0.76);
  const forbidden = { x: (W - centerW) / 2, y: H * 0.28, w: centerW, h: H * 0.46 };
  const placed = [];

  for (const genre of picks) {
    if (placed.length >= count) break;
    const label = typeof genre === 'string' ? genre : genre.l;
    const prompt = typeof genre === 'string' ? genre : genre.p;
    const chip = document.createElement('button');
    chip.className = 'float-chip';
    const [c0, c1] = promptPalette(label);
    chip.innerHTML = `<span class="fthumb" style="background:linear-gradient(135deg, ${c0}, ${c1})"></span><span></span>`;
    chip.lastChild.textContent = label;
    chip.title = prompt;
    chip.addEventListener('click', () => {
      $('seed-input').value = prompt;
      $('seed-form').requestSubmit();
    });
    box.appendChild(chip);

    // measure, then try random spots until one doesn't collide
    const cw = chip.offsetWidth;
    const ch = chip.offsetHeight;
    let spot = null;
    for (let t = 0; t < 60 && !spot; t++) {
      const r = { x: 16 + Math.random() * (W - 32 - cw), y: 12 + Math.random() * (H - 24 - ch), w: cw, h: ch };
      if (rectsOverlap(r, forbidden, 8)) continue;
      if (placed.some((p) => rectsOverlap(r, p, 26))) continue;
      spot = r;
    }
    if (!spot) {
      chip.remove();
      continue;
    }
    placed.push(spot);
    chip.style.left = `${spot.x}px`;
    chip.style.top = `${spot.y}px`;
    const i = placed.length;
    if (gsap) {
      gsap.to(chip, { opacity: 1, duration: 1.4, delay: 0.3 + i * 0.13, ease: 'power2.out' });
      gsap.to(chip, {
        x: `random(-12, 12)`, y: `random(-10, 10)`,
        duration: 'random(4, 7)', delay: i * 0.2,
        yoyo: true, repeat: -1, repeatRefresh: true, ease: 'sine.inOut',
      });
    } else {
      chip.style.opacity = 1;
    }
  }
}
seedFloatingPrompts();

/* ================= landing: social proof ================= */
function initSocialProof() {
  const av = document.querySelector('.sp-avatars');
  if (!av || av.children.length) return;
  ['aria', 'nox', 'kai', 'mira', 'juno', 'sol'].forEach((seed) => {
    const dot = document.createElement('span');
    dot.className = 'sp-av';
    const [a, b] = promptPalette(seed);
    dot.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    av.appendChild(dot);
  });

  const counter = document.querySelector('[data-countup]');
  if (counter && gsap) {
    const target = Number(counter.dataset.countup);
    const fmt = (v) => (v < 1e6 ? `${Math.round(v / 1000)}K` : `${(v / 1e6).toFixed(1)}M`);
    const o = { v: 0 };
    gsap.to(o, {
      v: target, duration: 2.2, ease: 'power2.out', delay: 0.4,
      onUpdate: () => { counter.textContent = fmt(o.v); },
      onComplete: () => { counter.textContent = '3M+'; },
    });
  }

  // live ticker: the tracks Sona actually generated most recently
  api('/api/stats').then(({ recent }) => {
    if (!recent?.length) return;
    let i = 0;
    const el = $('sp-ticker');
    const tick = () => {
      const r = recent[i % recent.length];
      i++;
      const text = `just generated: “${r.title}”${r.world ? ` — ${r.world}` : ''}`;
      if (gsap) {
        gsap.to(el, { opacity: 0, duration: 0.4, onComplete: () => { el.textContent = text; gsap.to(el, { opacity: 1, duration: 0.6 }); } });
      } else {
        el.textContent = text;
      }
    };
    tick();
    setInterval(tick, 5200);
  }).catch(() => {});
}
initSocialProof();

/* ================= stream lifecycle ================= */
$('seed-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('seed-input').value.trim();
  if (!prompt) return;
  $('seed-form').classList.add('thinking');
  connectAnalyser();
  unlockDecks();
  audioCtx?.resume();
  try {
    const stream = await api('/api/streams', { method: 'POST', body: { prompt } });
    history.replaceState(null, '', `/s/${stream.id}`);
    enterPlayer();
    startPolling(stream.id);
  } catch (err) {
    $('seed-form').classList.remove('thinking');
    $('seed-input').placeholder = 'Something went wrong — try again';
    $('seed-input').value = '';
    console.error(err);
  }
});

function enterPlayer() {
  $('landing').hidden = true;
  $('player').hidden = false;
}

let pollTimer = null;
function startPolling(streamId) {
  const poll = async () => {
    try {
      const stream = await api(`/api/streams/${streamId}`);
      state.stream = stream;
      state.pending = state.pending.filter(
        (p) => !stream.tracks.some((t) => t.prompt === p.prompt && t.status !== undefined && Math.abs(new Date(t.created_at) - p.at) < 60_000)
      );
      render();
      maybeAutoplay();
    } catch (err) {
      console.error('poll failed', err);
    }
  };
  poll();
  pollTimer = setInterval(poll, 2500);
}

/* ================= playback ================= */
function allTracks() {
  return state.stream ? state.stream.tracks : [];
}

// The server's current_position is the durable playhead — after a refresh the
// local playedIds set is empty, so without it the whole history would look
// "upcoming" again and playback would restart from track 1.
function playheadPos() {
  return Number(state.stream?.current_position ?? 0);
}

function upcoming() {
  const pos = playheadPos();
  return allTracks().filter(
    (t) =>
      Number(t.position) > pos &&
      !state.playedIds.has(t.id) &&
      t.id !== state.currentTrackId &&
      t.status !== 'failed'
  );
}

// after a reload: the track sitting exactly at the playhead was the one
// playing — resume with it instead of skipping ahead
function resumeCandidate() {
  if (state.currentTrackId || state.playedIds.size) return null;
  return allTracks().find(
    (t) => Number(t.position) === playheadPos() && t.status === 'ready'
  ) || null;
}

function nextReady() {
  const up = upcoming();
  if (!up.length) return null;
  return up[0].status === 'ready' ? up[0] : up.find((t) => t.status === 'ready') || null;
}

function currentTrack() {
  return allTracks().find((t) => t.id === state.currentTrackId) || null;
}

async function playTrack(track, fadeSec = 0) {
  state.waiting = false;
  state.mixing = false;
  const prevIdx = active;
  const prev = decks[prevIdx];
  const nextIdx = audioCtx ? 1 - active : active;
  const next = decks[nextIdx];

  state.currentTrackId = track.id;
  next.el.src = `/api/tracks/${track.id}/audio`;
  connectAnalyser();
  audioCtx?.resume();
  if (next.gain) next.gain.gain.value = fadeSec > 0 ? 0 : 1;
  // switch decks BEFORE play(): the 'play'/'timeupdate' events fire against
  // deck() and would otherwise be routed to the old deck and dropped —
  // leaving the icon on ▶ and the seek bar frozen while music plays
  active = nextIdx;
  if (audioCtx && prevIdx !== nextIdx) {
    ramp(next.gain, 1, fadeSec || 0.05);
    ramp(prev.gain, 0, fadeSec || 0.05);
    setTimeout(() => {
      prev.el.pause();
      prev.el.removeAttribute('src');
    }, (fadeSec || 0.05) * 1000 + 150);
  }
  next.el.play().catch((err) => {
    console.error('play blocked', err);
    updatePlayIcon(false); // surface the real state: ready but needs a tap
  });

  applyPalette(track.palette, track.energy);
  state.visual = null;
  state.visualFor = null;
  state.lyricIdx = -2;
  buildLyrics([]);
  setIntensity(null);
  setSectionFx(null);
  applyVisual(track);
  if (!track.visual) applyDesign(null, track.palette);
  gsap?.fromTo('#now-title', { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out' });

  api(`/api/streams/${state.stream.id}/advance`, { method: 'POST', body: { trackId: track.id } }).catch(() => {});
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || track.prompt,
      artist: 'Sona',
      album: state.stream?.title || 'Infinite stream',
    });
  }
  render();
  refreshSuggestions();
}

function maybeAutoplay() {
  const fresh = !state.currentTrackId && !state.playedIds.size && !state.waiting;
  if (!fresh && !state.waiting) return;
  const next = (fresh && resumeCandidate()) || nextReady();
  if (next) playTrack(next, 0);
}

function advance(fadeSec = 1.2) {
  if (state.currentTrackId) state.playedIds.add(state.currentTrackId);
  const next = nextReady();
  if (next) {
    playTrack(next, fadeSec);
  } else {
    state.waiting = true;
    state.currentTrackId = null;
    render();
  }
}

for (const d of decks) {
  d.el.addEventListener('ended', () => {
    if (d !== deck() || state.mixing) return;
    advance(0.2);
  });
  d.el.addEventListener('timeupdate', () => {
    if (d !== deck()) return;
    const el = d.el;
    if (el.duration) {
      const pct = (el.currentTime / el.duration) * 100;
      $('progress-fill').style.width = `${pct}%`;
      $('progress-knob').style.left = `${pct}%`;
      $('t-cur').textContent = fmtTime(el.currentTime);
      $('t-dur').textContent = fmtTime(el.duration);
      // DJ mix: start crossfading into the next track before this one ends
      // (needs the WebAudio gain graph — on iOS tracks switch on 'ended')
      if (audioCtx && !state.mixing && el.duration - el.currentTime < 5 && nextReady()) {
        state.mixing = true;
        if (state.currentTrackId) state.playedIds.add(state.currentTrackId);
        playTrack(nextReady(), 4);
      }
    }
    syncTimeline();
  });
  d.el.addEventListener('play', () => { if (d === deck()) updatePlayIcon(true); });
  d.el.addEventListener('pause', () => { if (d === deck()) updatePlayIcon(false); });
}

function fmtTime(s) {
  if (!isFinite(s)) return '–:––';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function updatePlayIcon(playing) {
  document.querySelector('.icon-play').style.display = playing ? 'none' : '';
  document.querySelector('.icon-pause').style.display = playing ? '' : 'none';
  setPlaying(playing);
}

$('btn-play').addEventListener('click', () => {
  connectAnalyser();
  unlockDecks();
  audioCtx?.resume();
  const el = deck().el;
  if (el.paused) {
    if (!state.currentTrackId) {
      const next = resumeCandidate() || nextReady();
      if (next) return playTrack(next, 0);
      state.waiting = true;
      render();
      return;
    }
    el.play();
  } else {
    el.pause();
  }
});
$('btn-next').addEventListener('click', () => advance(1.2));

$('progress').addEventListener('click', (e) => {
  const el = deck().el;
  if (!el.duration) return;
  const r = $('progress').getBoundingClientRect();
  el.currentTime = ((e.clientX - r.left) / r.width) * el.duration;
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => deck().el.play());
  navigator.mediaSession.setActionHandler('pause', () => deck().el.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => advance(1.2));
}

/* ================= rendering ================= */
function render() {
  const s = state.stream;
  if (!s) return;

  const cur = currentTrack();
  // transport reflects real availability: spinner while nothing is playable,
  // skip only lights up when a next track is actually ready
  const playable = !!cur || !!nextReady();
  $('btn-play').classList.toggle('loading', !playable);
  $('btn-play').disabled = !playable;
  $('btn-next').disabled = !nextReady();

  if (cur) applyVisual(cur); // visual script may arrive after playback started
  if (cur) {
    $('now-state').textContent = 'Now playing';
    setTitle(cur.title || cur.prompt);
    $('now-hint').textContent = '';
  } else if (state.waiting || !s.tracks.some((t) => t.status === 'ready')) {
    // stay neutral until a track is actually ready — no committing to a song
    // that might still fail, no buggy title switches
    $('now-state').textContent = 'Generating';
    setTitle(s.title || s.seed_prompt);
    $('now-hint').textContent = state.playedIds.size
      ? 'The next track is on its way …'
      : 'The first track takes a little longer — usually ready within a minute.';
  }

  renderQueue();
}

// long titles scale down and truncate instead of breaking the layout
function setTitle(text) {
  const el = $('now-title');
  el.textContent = text || '';
  el.classList.toggle('long', text?.length > 24 && text.length <= 40);
  el.classList.toggle('xlong', text?.length > 40);
}

function thumbStyle(track) {
  let p = track.palette;
  // tracks that haven't been generated yet get the same hashed light as the
  // floating prompt ideas — every entry has its own color from the start
  if (!Array.isArray(p) || p.length < 2) p = promptPalette(track.prompt || '');
  return `linear-gradient(135deg, ${p[0]}, ${p[1]}${p[2] ? ', ' + p[2] : ''})`;
}

const STATUS_LABEL = {
  ready: 'ready',
  generating: 'forming …',
  queued: 'queued',
  failed: 'failed',
};

function renderQueue() {
  const container = $('queue');
  // Up Next = what's coming: everything at or behind the server playhead
  // (played in any session) and the currently playing track stay out
  const pos = playheadPos();
  const tracks = [
    ...allTracks().filter(
      (t) => Number(t.position) > pos && !state.playedIds.has(t.id) && t.id !== state.currentTrackId
    ),
    ...state.pending,
  ];
  const seen = new Set();
  const animateNew = state.queueRendered; // no entry animation on first paint

  tracks.forEach((t) => {
    seen.add(t.id);
    let el = container.querySelector(`[data-id="${t.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'qtrack';
      el.dataset.id = t.id;
      el.innerHTML = `<div class="qthumb"></div><div class="qmain"><span class="qtitle"></span><span class="qsub"></span></div><span class="qmeta"></span>`;
      container.appendChild(el);
      makeDraggable(el);
      // CSS animation, not a JS tween: rapid re-renders (optimistic row →
      // real row + poll) can kill an in-flight tween and leave rows stuck
      // invisible at opacity 0
      if (animateNew) {
        el.classList.add('row-in');
        setTimeout(() => el.classList.remove('row-in'), 700);
      }
    }
    el.querySelector('.qtitle').textContent = t.title || t.prompt;
    el.querySelector('.qsub').textContent =
      t.source === 'auto' ? 'Sona · auto mix' : t.source === 'suggestion' ? 'Sona · from a suggestion' : 'Sona · your prompt';
    const bg = thumbStyle(t);
    if (bg) el.querySelector('.qthumb').style.background = bg;
    const meta = t.id === state.currentTrackId
      ? 'playing'
      : state.playedIds.has(t.id)
        ? 'played'
        : STATUS_LABEL[t.status] || t.status;
    el.querySelector('.qmeta').textContent = meta;

    const keepIntro = el.classList.contains('row-in');
    el.className = 'qtrack';
    if (keepIntro) el.classList.add('row-in');
    if (t.id === state.currentTrackId) el.classList.add('playing');
    else if (state.playedIds.has(t.id)) el.classList.add('played');
    else el.classList.add(t.status);
    const reorderable = !t.optimistic && !state.playedIds.has(t.id) && t.id !== state.currentTrackId;
    if (reorderable) el.classList.add('draggable');

    container.appendChild(el); // keep DOM order in sync with position order
  });

  [...container.children].forEach((el) => {
    if (!seen.has(el.dataset.id)) el.remove();
  });
  state.queueRendered = true;
}

/* ================= drag to reorder ================= */
let drag = null;
function makeDraggable(el) {
  el.addEventListener('pointerdown', (e) => {
    if (!el.classList.contains('draggable')) return;
    drag = { el, startY: e.clientY, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || drag.el !== el) return;
    if (Math.abs(e.clientY - drag.startY) > 8) drag.moved = true;
    if (!drag.moved) return;
    el.classList.add('dragging');
    const container = $('queue');
    const siblings = [...container.querySelectorAll('.qtrack.draggable')].filter((s) => s !== el);
    const after = siblings.find((s) => e.clientY < s.getBoundingClientRect().top + s.offsetHeight / 2);
    if (after) container.insertBefore(el, after);
    else if (siblings.length) siblings[siblings.length - 1].after(el);
  });
  el.addEventListener('pointerup', async () => {
    if (!drag || drag.el !== el) return;
    const moved = drag.moved;
    el.classList.remove('dragging');
    drag = null;
    if (!moved) return;
    const ids = [...$('queue').querySelectorAll('.qtrack.draggable')].map((s) => s.dataset.id);
    try {
      await api(`/api/streams/${state.stream.id}/reorder`, { method: 'POST', body: { trackIds: ids } });
    } catch (err) {
      console.error('reorder failed', err);
    }
  });
}

/* ================= composer: instant prompts + bubbles ================= */
async function enqueuePrompt(prompt, source = 'user') {
  if (!prompt || !state.stream) return;
  // optimistic: the track appears in the queue the moment you send it
  const temp = {
    id: `tmp-${Date.now()}`,
    prompt,
    title: null,
    status: 'queued',
    source,
    optimistic: true,
    at: Date.now(),
  };
  state.pending.push(temp);
  renderQueue();
  try {
    const real = await api(`/api/streams/${state.stream.id}/tracks`, {
      method: 'POST',
      body: { prompt, source },
    });
    state.pending = state.pending.filter((p) => p.id !== temp.id);
    if (!state.stream.tracks.some((t) => t.id === real.id)) state.stream.tracks.push(real);
    renderQueue();
  } catch (err) {
    state.pending = state.pending.filter((p) => p.id !== temp.id);
    renderQueue();
    console.error(err);
  }
}

$('prompt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockDecks();
  const input = $('prompt-input');
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = '';
  enqueuePrompt(prompt, 'user');
});

async function refreshSuggestions() {
  if (!state.stream) return;
  if (state.suggestionsFor === state.currentTrackId) return;
  state.suggestionsFor = state.currentTrackId;
  try {
    const { suggestions } = await api(`/api/streams/${state.stream.id}/suggestions`);
    const box = $('suggestions');
    box.innerHTML = '';
    suggestions.slice(0, 2).forEach((sug, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = sug.label;
      chip.title = sug.prompt;
      chip.addEventListener('click', () => {
        gsap?.to(chip, { scale: 0.6, opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: () => chip.remove() });
        if (!gsap) chip.remove();
        enqueuePrompt(sug.prompt, 'suggestion');
      });
      box.appendChild(chip);
      // bubbles surface from the fog and gently bob
      if (gsap) {
        gsap.fromTo(chip,
          { opacity: 0, y: 16, filter: 'blur(5px)' },
          { opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.1, delay: i * 0.28, ease: 'power2.out' }
        );
        gsap.to(chip, { y: '-=4', duration: 1.8 + i * 0.3, delay: 1.2 + i * 0.28, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      } else {
        chip.style.opacity = 1;
      }
    });
  } catch (err) {
    console.error('suggestions failed', err);
  }
}

/* ================= settings: provider switch ================= */
$('btn-settings').addEventListener('click', async () => {
  const panel = $('settings-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    const { music_provider } = await api('/api/settings');
    panel.querySelectorAll('[data-provider]').forEach((b) => {
      b.classList.toggle('active', b.dataset.provider === music_provider);
    });
  }
});
document.querySelectorAll('#settings-panel [data-provider]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await api('/api/settings', { method: 'PUT', body: { music_provider: btn.dataset.provider } });
    document.querySelectorAll('#settings-panel [data-provider]').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
  });
});

/* ================= boot: resume a stream from /s/:id ================= */
const match = location.pathname.match(/^\/s\/([0-9a-f-]{36})/);
if (match) {
  enterPlayer();
  startPolling(match[1]);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
