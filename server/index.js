import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initDb, getSetting, setSetting } from './db.js';
import * as engine from './engine.js';
import * as brain from './brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const TRACK_COLUMNS = `id, stream_id, position, prompt, source, title, palette, energy,
  provider, status, error, mime, duration_ms, visual, created_at`;

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, provider: await engine.currentProvider() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- settings: switch the music provider at runtime ---
app.get('/api/settings', async (_req, res) => {
  res.json({ music_provider: await engine.currentProvider(), available: ['lyria', 'elevenlabs'] });
});

app.put('/api/settings', async (req, res) => {
  const provider = String(req.body?.music_provider || '').toLowerCase();
  if (!['lyria', 'elevenlabs'].includes(provider)) {
    return res.status(400).json({ error: 'music_provider must be "lyria" or "elevenlabs"' });
  }
  await setSetting('music_provider', provider);
  res.json({ music_provider: provider });
});

// --- streams ---
app.post('/api/streams', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const provider = req.body?.provider ? String(req.body.provider).toLowerCase() : null;

  const { rows } = await pool.query(
    `INSERT INTO streams (seed_prompt, provider) VALUES ($1, $2) RETURNING *`,
    [prompt, provider]
  );
  const stream = rows[0];

  // First track comes straight from the listener's prompt.
  await pool.query(
    `INSERT INTO tracks (stream_id, position, prompt, source, provider) VALUES ($1, 1, $2, 'user', $3)`,
    [stream.id, prompt, provider]
  );
  engine.kick();
  engine.ensureLookahead(stream.id).catch((err) => console.error(err));
  brain
    .streamTitle(prompt)
    .then((title) => pool.query('UPDATE streams SET title = $2 WHERE id = $1', [stream.id, title]))
    .catch(() => {});

  res.status(201).json(stream);
});

app.get('/api/streams/:id', async (req, res) => {
  const { rows: streams } = await pool.query('SELECT * FROM streams WHERE id = $1', [req.params.id]);
  if (!streams.length) return res.status(404).json({ error: 'stream not found' });
  const { rows: tracks } = await pool.query(
    `SELECT ${TRACK_COLUMNS} FROM tracks WHERE stream_id = $1 ORDER BY position ASC`,
    [req.params.id]
  );
  // lazily backfill visual scripts for tracks generated before this feature
  for (const t of tracks) {
    if (t.status === 'ready' && !t.visual) engine.ensureVisual(t.id).catch(() => {});
  }
  res.json({ ...streams[0], tracks });
});

// Enqueue a listener-prompted track.
app.post('/api/streams/:id/tracks', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const { rows: streams } = await pool.query('SELECT * FROM streams WHERE id = $1', [req.params.id]);
  if (!streams.length) return res.status(404).json({ error: 'stream not found' });

  const { rows: maxPos } = await pool.query(
    'SELECT COALESCE(MAX(position), 0) AS p FROM tracks WHERE stream_id = $1',
    [req.params.id]
  );
  const { rows } = await pool.query(
    `INSERT INTO tracks (stream_id, position, prompt, source) VALUES ($1, $2, $3, $4)
     RETURNING ${TRACK_COLUMNS}`,
    [req.params.id, Number(maxPos[0].p) + 1, prompt, req.body?.source === 'suggestion' ? 'suggestion' : 'user']
  );
  engine.kick();
  res.status(201).json(rows[0]);
});

// Reorder the upcoming queue: body is the full ordered list of track ids.
app.post('/api/streams/:id/reorder', async (req, res) => {
  const ids = req.body?.trackIds;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'trackIds required' });
  const { rows: streams } = await pool.query('SELECT * FROM streams WHERE id = $1', [req.params.id]);
  if (!streams.length) return res.status(404).json({ error: 'stream not found' });

  const base = Number(streams[0].current_position);
  for (let i = 0; i < ids.length; i++) {
    await pool.query('UPDATE tracks SET position = $3 WHERE id = $1 AND stream_id = $2', [
      ids[i],
      req.params.id,
      base + (i + 1) / (ids.length + 1) + i,
    ]);
  }
  res.json({ ok: true });
});

// The client reports which track just started playing; move the playhead and
// top up the queue.
app.post('/api/streams/:id/advance', async (req, res) => {
  const trackId = req.body?.trackId;
  const { rows } = await pool.query('SELECT position FROM tracks WHERE id = $1 AND stream_id = $2', [
    trackId,
    req.params.id,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'track not found' });
  await pool.query('UPDATE streams SET current_position = $2 WHERE id = $1', [
    req.params.id,
    rows[0].position,
  ]);
  await engine.ensureLookahead(req.params.id);
  res.json({ ok: true });
});

app.get('/api/streams/:id/suggestions', async (req, res) => {
  const { rows: streams } = await pool.query('SELECT * FROM streams WHERE id = $1', [req.params.id]);
  if (!streams.length) return res.status(404).json({ error: 'stream not found' });
  const { rows: history } = await pool.query(
    `SELECT title, prompt FROM tracks WHERE stream_id = $1 ORDER BY position DESC LIMIT 5`,
    [req.params.id]
  );
  res.json({ suggestions: await brain.suggestions(streams[0].seed_prompt, history.reverse()) });
});

// --- landing social proof: real recently generated tracks ---
let statsCache = { at: 0, data: null };
app.get('/api/stats', async (_req, res) => {
  if (Date.now() - statsCache.at < 60_000 && statsCache.data) return res.json(statsCache.data);
  const { rows: totals } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'ready')::int AS tracks,
            (SELECT count(*)::int FROM streams) AS streams,
            COALESCE(sum(duration_ms) FILTER (WHERE status = 'ready'), 0)::bigint AS ms
     FROM tracks`
  );
  const { rows: recent } = await pool.query(
    `SELECT title, visual->'scene'->>'world' AS world
     FROM tracks WHERE status = 'ready' AND title IS NOT NULL
     ORDER BY created_at DESC LIMIT 14`
  );
  statsCache = { at: Date.now(), data: { ...totals[0], recent } };
  res.json(statsCache.data);
});

// --- audio with Range support so seeking works ---
app.get('/api/tracks/:id/audio', async (req, res) => {
  const { rows } = await pool.query('SELECT audio, mime FROM tracks WHERE id = $1 AND status = $2', [
    req.params.id,
    'ready',
  ]);
  if (!rows.length || !rows[0].audio) return res.status(404).json({ error: 'audio not ready' });
  const { audio, mime } = rows[0];

  res.set({
    'Content-Type': mime || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), audio.length - 1) : audio.length - 1;
    if (start >= audio.length) {
      return res.status(416).set('Content-Range', `bytes */${audio.length}`).end();
    }
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${audio.length}`,
      'Content-Length': end - start + 1,
    });
    return res.end(audio.subarray(start, end + 1));
  }
  res.set('Content-Length', audio.length);
  res.end(audio);
});

// --- static frontend / PWA ---
// no-cache (= always revalidate, 304s keep it cheap) so deploys actually reach
// clients — without this Safari caches app.js heuristically for days and
// users keep running stale code. Vendor libs + fonts never change: cache hard.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (/[/\\](vendor|fonts)[/\\]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA catch-all with share-ready meta: /s/:id links carry the stream's own
// title + prompt in their OpenGraph tags (WhatsApp, iMessage, Slack previews)
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const DEFAULT_OG_TITLE = 'Sona — Infinite AI Music Stream';
const DEFAULT_OG_DESC = 'Type a thought, get an endless generated mix. Every track composed live — with its own world of visuals.';
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

app.get('*', async (req, res) => {
  let html = INDEX_HTML;
  const m = req.path.match(/^\/s\/([0-9a-f-]{36})/);
  if (m) {
    try {
      const { rows } = await pool.query('SELECT title, seed_prompt FROM streams WHERE id = $1', [m[1]]);
      if (rows[0]) {
        html = html
          .replaceAll(DEFAULT_OG_TITLE, escapeHtml(`${rows[0].title || 'Infinite stream'} · Sona`))
          .replaceAll(DEFAULT_OG_DESC, escapeHtml(`An endless AI-generated mix tuned to: “${rows[0].seed_prompt}”. Press play.`))
          .replace('content="https://sona-l4zq.onrender.com/"', `content="https://sona-l4zq.onrender.com${req.path}"`);
      }
    } catch { /* default meta */ }
  }
  res.type('html').send(html);
});

const port = process.env.PORT || 3000;

async function requeueStuck() {
  // Tracks stuck in 'generating' from a previous process are re-queued on boot.
  await pool.query(`UPDATE tracks SET status = 'queued' WHERE status = 'generating'`);
}

initDb()
  .then(requeueStuck)
  .then(() => {
    app.listen(port, () => console.log(`sona listening on :${port}`));
    engine.kick();
  })
  .catch((err) => {
    console.error('fatal: db init failed', err);
    process.exit(1);
  });
