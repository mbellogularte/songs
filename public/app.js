/* Sona player — the world walks and breathes with the music. */

import { initVisualizer, setScene, setPlaying, setVisual, setIntensity } from '/visualizer.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');

const state = {
  stream: null,          // latest stream payload from the server
  currentTrackId: null,  // track loaded in the <audio> element
  playedIds: new Set(),
  waiting: false,        // stream ran ahead of generation
  suggestionsFor: null,  // track id the current suggestions belong to
  visual: null,          // AI visual script of the current track
  visualFor: null,
  lyricIdx: -1,
  sectionT: undefined,
};

/* AI visual script: scene spec + timed lyrics + section timeline */
function applyVisual(track) {
  if (!track?.visual || state.visualFor === track.id) return;
  state.visualFor = track.id;
  state.visual = track.visual;
  state.lyricIdx = -1;
  state.sectionT = undefined;
  setVisual(track.visual.scene);
}

function syncTimeline() {
  const v = state.visual;
  if (!v) return;
  const t = audio.currentTime;

  const lines = v.lyrics || [];
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= t) idx = i;
    else break;
  }
  if (idx !== state.lyricIdx) {
    state.lyricIdx = idx;
    const text = idx >= 0 ? lines[idx].text : '';
    const el = $('lyric');
    if (window.gsap) {
      window.gsap.to(el, {
        opacity: 0, filter: 'blur(6px)', duration: 0.35, overwrite: 'auto',
        onComplete: () => {
          el.textContent = text;
          window.gsap.to(el, { opacity: 1, filter: 'blur(0px)', duration: 0.9 });
        },
      });
    } else {
      el.textContent = text;
    }
  }

  const secs = v.sections || [];
  let cur = null;
  for (const s of secs) {
    if (s.t <= t) cur = s;
    else break;
  }
  if (cur?.t !== state.sectionT) {
    state.sectionT = cur?.t;
    setIntensity(cur ? cur.intensity : null);
  }
}

/* ---------------- audio analysis ---------------- */
let audioCtx = null;
let analyser = null;
let freq = null;

function connectAnalyser() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  src.connect(analyser);
  analyser.connect(audioCtx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);
}

// live bands feeding the visualizer: bass / mid / high / overall energy, 0..1
function getBands() {
  if (!analyser || audio.paused) return { bass: 0, mid: 0, high: 0, energy: 0 };
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

function applyPalette(palette, energy) {
  const p = Array.isArray(palette) && palette.length ? palette : ['#3a4150', '#262b36', '#1a1e27'];
  const root = document.documentElement.style;
  root.setProperty('--c0', p[0]);
  root.setProperty('--c1', p[1] || p[0]);
  root.setProperty('--c2', p[2] || p[1] || p[0]);
  root.setProperty('--glow', p[0] + '66');
  setScene(p, energy ?? 0.5);
}

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

/* ---------------- stream lifecycle ---------------- */
$('seed-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('seed-input').value.trim();
  if (!prompt) return;
  $('seed-form').classList.add('thinking');
  connectAnalyser(); // user gesture: unlock audio
  audioCtx?.resume();
  try {
    const stream = await api('/api/streams', { method: 'POST', body: { prompt } });
    history.replaceState(null, '', `/s/${stream.id}`);
    enterPlayer();
    startPolling(stream.id);
  } catch (err) {
    $('seed-form').classList.remove('thinking');
    $('seed-input').placeholder = 'something went wrong — try again';
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
      render();
      maybeAutoplay();
    } catch (err) {
      console.error('poll failed', err);
    }
  };
  poll();
  pollTimer = setInterval(poll, 2500);
}

/* ---------------- playback ---------------- */
function upcoming() {
  if (!state.stream) return [];
  return state.stream.tracks.filter(
    (t) => !state.playedIds.has(t.id) && t.id !== state.currentTrackId && t.status !== 'failed'
  );
}

function nextReady() {
  const up = upcoming();
  if (!up.length) return null;
  // respect queue order, but don't stall the stream if a later track is ready
  return up[0].status === 'ready' ? up[0] : up.find((t) => t.status === 'ready') || null;
}

async function playTrack(track) {
  state.waiting = false;
  state.currentTrackId = track.id;
  audio.src = `/api/tracks/${track.id}/audio`;
  connectAnalyser();
  audioCtx?.resume();
  try {
    await audio.play();
  } catch (err) {
    console.error('play blocked', err);
  }
  applyPalette(track.palette, track.energy);
  state.visual = null;
  state.lyricIdx = -1;
  $('lyric').textContent = '';
  setIntensity(null);
  applyVisual(track);
  if (window.gsap) {
    window.gsap.fromTo(
      '#now-title',
      { opacity: 0, filter: 'blur(10px)', y: 8 },
      { opacity: 1, filter: 'blur(0px)', y: 0, duration: 2.2, ease: 'power2.out' }
    );
  }
  api(`/api/streams/${state.stream.id}/advance`, { method: 'POST', body: { trackId: track.id } }).catch(() => {});
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || track.prompt,
      artist: 'Sona',
      album: state.stream?.title || 'infinite stream',
    });
  }
  render();
  refreshSuggestions();
}

function maybeAutoplay() {
  // Autostart the very first ready track, or continue after a generation gap.
  // A user-initiated pause (currentTrackId set, not waiting) is respected.
  const fresh = !state.currentTrackId && !state.playedIds.size && !state.waiting;
  if (!fresh && !state.waiting) return;
  const next = nextReady();
  if (next) playTrack(next);
}

function advance() {
  if (state.currentTrackId) state.playedIds.add(state.currentTrackId);
  const next = nextReady();
  if (next) {
    playTrack(next);
  } else {
    state.waiting = true;
    state.currentTrackId = null;
    render();
  }
}

audio.addEventListener('ended', advance);
audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    $('progress-fill').style.width = `${(audio.currentTime / audio.duration) * 100}%`;
  }
  syncTimeline();
});
audio.addEventListener('play', () => {
  document.querySelector('.icon-play').style.display = 'none';
  document.querySelector('.icon-pause').style.display = '';
  setPlaying(true);
});
audio.addEventListener('pause', () => {
  document.querySelector('.icon-play').style.display = '';
  document.querySelector('.icon-pause').style.display = 'none';
  setPlaying(false);
});

$('btn-play').addEventListener('click', () => {
  connectAnalyser();
  audioCtx?.resume();
  if (audio.paused) {
    if (!state.currentTrackId) {
      const next = nextReady();
      if (next) return playTrack(next);
      state.waiting = true;
      render();
      return;
    }
    audio.play();
  } else {
    audio.pause();
  }
});
$('btn-next').addEventListener('click', advance);

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', advance);
}

/* ---------------- rendering ---------------- */
function currentTrack() {
  return state.stream?.tracks.find((t) => t.id === state.currentTrackId) || null;
}

function render() {
  const s = state.stream;
  if (!s) return;
  $('stream-title').textContent = s.title || s.seed_prompt;

  const cur = currentTrack();
  if (cur) applyVisual(cur); // visual script may arrive after playback started
  if (cur) {
    $('now-state').textContent = 'now playing';
    $('now-title').textContent = cur.title || cur.prompt;
    $('now-title').classList.remove('foggy');
    $('now-prompt').textContent = cur.prompt;
  } else if (state.waiting || !s.tracks.some((t) => t.status === 'ready')) {
    $('now-state').textContent = 'emerging from the fog';
    $('now-title').textContent = upcoming()[0]?.title || upcoming()[0]?.prompt || s.seed_prompt;
    $('now-title').classList.add('foggy');
    $('now-prompt').textContent = 'the next track is being generated…';
  }

  renderQueue();
}

function renderQueue() {
  const container = $('queue');
  const tracks = state.stream.tracks;
  const seen = new Set();

  tracks.forEach((t) => {
    seen.add(t.id);
    let el = container.querySelector(`[data-id="${t.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'qtrack';
      el.dataset.id = t.id;
      el.innerHTML = `<span class="qtitle"></span><span class="qmeta"></span>`;
      container.appendChild(el);
      makeDraggable(el);
    }
    el.querySelector('.qtitle').textContent = t.title || t.prompt;
    const meta =
      t.id === state.currentTrackId
        ? 'playing'
        : state.playedIds.has(t.id)
          ? 'played'
          : t.status === 'ready'
            ? 'ready'
            : t.status === 'failed'
              ? 'failed'
              : t.status === 'generating'
                ? 'forming'
                : 'in the fog';
    el.querySelector('.qmeta').textContent = meta;

    el.className = 'qtrack';
    if (t.id === state.currentTrackId) el.classList.add('playing');
    else if (state.playedIds.has(t.id)) el.classList.add('played');
    else el.classList.add(t.status);
    const reorderable = !state.playedIds.has(t.id) && t.id !== state.currentTrackId;
    if (reorderable) el.classList.add('draggable');

    // keep DOM order in sync with position order
    container.appendChild(el);
  });

  // drop removed tracks
  [...container.children].forEach((el) => {
    if (!seen.has(el.dataset.id)) el.remove();
  });
}

/* ---------------- drag to reorder ---------------- */
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

/* ---------------- composer: prompts + suggestions ---------------- */
$('prompt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('prompt-input');
  const prompt = input.value.trim();
  if (!prompt || !state.stream) return;
  input.value = '';
  $('prompt-form').classList.add('thinking');
  try {
    await api(`/api/streams/${state.stream.id}/tracks`, { method: 'POST', body: { prompt } });
  } catch (err) {
    console.error(err);
  } finally {
    setTimeout(() => $('prompt-form').classList.remove('thinking'), 1200);
  }
});

async function refreshSuggestions() {
  if (!state.stream) return;
  if (state.suggestionsFor === state.currentTrackId) return;
  state.suggestionsFor = state.currentTrackId;
  try {
    const { suggestions } = await api(`/api/streams/${state.stream.id}/suggestions`);
    const box = $('suggestions');
    box.innerHTML = '';
    suggestions.forEach((sug, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.style.animationDelay = `${i * 0.35}s`;
      chip.textContent = sug.label;
      chip.title = sug.prompt;
      chip.addEventListener('click', async () => {
        chip.remove();
        await api(`/api/streams/${state.stream.id}/tracks`, {
          method: 'POST',
          body: { prompt: sug.prompt, source: 'suggestion' },
        }).catch(console.error);
      });
      box.appendChild(chip);
    });
  } catch (err) {
    console.error('suggestions failed', err);
  }
}

/* ---------------- settings: provider switch ---------------- */
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

/* ---------------- boot: resume a stream from /s/:id ---------------- */
const match = location.pathname.match(/^\/s\/([0-9a-f-]{36})/);
if (match) {
  enterPlayer();
  startPolling(match[1]);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
