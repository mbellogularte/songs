// Music engine: picks queued tracks from the DB, generates audio through the
// selected provider, and keeps every stream topped up with LOOKAHEAD tracks
// ahead of the playhead so the stream never runs dry.

import { pool, getSetting } from './db.js';
import * as brain from './brain.js';
import * as lyria from './providers/lyria.js';
import * as elevenlabs from './providers/elevenlabs.js';

const PROVIDERS = { lyria, elevenlabs };
export const LOOKAHEAD = Number(process.env.LOOKAHEAD) || 2;
const CONCURRENCY = Number(process.env.GEN_CONCURRENCY) || 2;

let active = 0;
let scheduled = false;

export async function currentProvider() {
  const name = (await getSetting('music_provider', process.env.MUSIC_PROVIDER || 'lyria')).toLowerCase();
  return PROVIDERS[name] ? name : 'lyria';
}

export function kick() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    pump().catch((err) => console.error('engine pump error:', err));
  });
}

async function pump() {
  while (active < CONCURRENCY) {
    const { rows } = await pool.query(
      `UPDATE tracks SET status = 'generating'
       WHERE id = (
         SELECT id FROM tracks WHERE status = 'queued'
         ORDER BY created_at ASC LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, stream_id, prompt, provider`
    );
    if (!rows.length) return;
    active++;
    generateTrack(rows[0])
      .catch((err) => console.error('generateTrack error:', err))
      .finally(() => {
        active--;
        kick();
      });
  }
}

async function generateTrack(track) {
  const providerName = track.provider || (await currentProvider());
  const provider = PROVIDERS[providerName];
  console.log(`[engine] generating track ${track.id} via ${providerName}: ${track.prompt.slice(0, 80)}`);
  try {
    const { rows: history } = await pool.query(
      `SELECT title, prompt FROM tracks WHERE stream_id = $1 AND status = 'ready' ORDER BY position DESC LIMIT 5`,
      [track.stream_id]
    );
    const meta = await brain.trackMeta(track.prompt, history.map((t) => t.title).filter(Boolean));
    await pool.query(
      `UPDATE tracks SET title = $2, palette = $3, energy = $4, provider = $5 WHERE id = $1`,
      [track.id, meta.title, JSON.stringify(meta.palette), meta.energy, providerName]
    );

    const { audio, mime, durationMs } = await provider.generate({ prompt: meta.musicPrompt || track.prompt });
    await pool.query(
      `UPDATE tracks SET status = 'ready', audio = $2, mime = $3, duration_ms = $4, error = NULL WHERE id = $1`,
      [track.id, audio, mime, durationMs]
    );
    console.log(`[engine] track ${track.id} ready (${audio.length} bytes, ~${Math.round(durationMs / 1000)}s)`);
    ensureVisual(track.id).catch(() => {});
  } catch (err) {
    console.error(`[engine] track ${track.id} failed:`, err.message);
    // one automatic retry before giving up — providers occasionally refuse a
    // phrasing (e.g. artist names) and the brain rephrases on every attempt
    const { rows } = await pool.query(
      `UPDATE tracks SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 < 2 THEN 'queued' ELSE 'failed' END,
         error = $2
       WHERE id = $1 RETURNING status`,
      [track.id, String(err.message).slice(0, 500)]
    );
    if (rows[0]?.status === 'queued') {
      console.log(`[engine] retrying track ${track.id}`);
      kick();
    }
  }
}

// Gemini listens to the finished audio and scripts the track's visuals
// (scene spec + section timeline + timed lyrics). Fire-and-forget with an
// in-flight guard so lazy backfills don't double-analyze.
const analyzing = new Set();
export async function ensureVisual(trackId) {
  if (analyzing.has(trackId)) return;
  analyzing.add(trackId);
  try {
    const { rows } = await pool.query(
      `SELECT audio, mime, prompt, title FROM tracks WHERE id = $1 AND status = 'ready' AND visual IS NULL`,
      [trackId]
    );
    if (!rows.length || !rows[0].audio) return;
    const t = rows[0];
    console.log(`[engine] scripting visuals for ${trackId}`);
    const visual = await brain.analyzeTrack(t.audio, t.mime, `"${t.title || ''}" — ${t.prompt}`);
    await pool.query(`UPDATE tracks SET visual = $2 WHERE id = $1`, [trackId, JSON.stringify(visual)]);
    console.log(`[engine] visuals ready for ${trackId}: ${visual.scene?.world || '?'}`);
  } catch (err) {
    console.error(`[engine] visual analysis failed for ${trackId}:`, err.message);
  } finally {
    analyzing.delete(trackId);
  }
}

// Make sure `LOOKAHEAD` upcoming tracks exist past the playhead; auto-fill
// with brain-evolved prompts when the listener hasn't queued anything.
export async function ensureLookahead(streamId) {
  const { rows: streams } = await pool.query('SELECT * FROM streams WHERE id = $1', [streamId]);
  const stream = streams[0];
  if (!stream) return;

  const { rows: upcoming } = await pool.query(
    `SELECT count(*)::int AS n FROM tracks
     WHERE stream_id = $1 AND position > $2 AND status IN ('queued','generating','ready')`,
    [streamId, stream.current_position]
  );
  let missing = LOOKAHEAD - upcoming[0].n;

  while (missing-- > 0) {
    const { rows: history } = await pool.query(
      `SELECT title, prompt FROM tracks
       WHERE stream_id = $1 AND status IN ('ready','generating','queued')
       ORDER BY position DESC LIMIT 6`,
      [streamId]
    );
    const prompt = await brain.nextPrompt(stream.seed_prompt, history.reverse());
    const { rows: maxPos } = await pool.query(
      'SELECT COALESCE(MAX(position), 0) AS p FROM tracks WHERE stream_id = $1',
      [streamId]
    );
    await pool.query(
      `INSERT INTO tracks (stream_id, position, prompt, source) VALUES ($1, $2, $3, 'auto')`,
      [streamId, Number(maxPos[0].p) + 1, prompt]
    );
  }
  kick();
}
