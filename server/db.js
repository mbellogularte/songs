import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   text PRIMARY KEY,
      value text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS streams (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title            text,
      seed_prompt      text NOT NULL,
      provider         text,
      current_position double precision NOT NULL DEFAULT 0,
      created_at       timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stream_id   uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      position    double precision NOT NULL,
      prompt      text NOT NULL,
      source      text NOT NULL DEFAULT 'auto',
      title       text,
      palette     jsonb,
      energy      real,
      provider    text,
      status      text NOT NULL DEFAULT 'queued',
      error       text,
      mime        text,
      duration_ms integer,
      audio       bytea,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS tracks_stream_pos ON tracks (stream_id, position);
    CREATE INDEX IF NOT EXISTS tracks_status ON tracks (status);
  `);
}

export async function getSetting(key, fallback = null) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}
