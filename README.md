# Sona

A promptable infinite music stream. Type a thought, get an endless AI-generated mix — every track composed live while the previous one plays.

See [PLAN.md](PLAN.md) for the full concept, architecture and design language.

## Run locally

```bash
npm install
DATABASE_URL=postgres://… \
GEMINI_API_KEY=… \
ELEVENLABS_API_KEY=… \
MUSIC_PROVIDER=lyria \
npm start
```

Open http://localhost:3000.

## Environment

| Var | Meaning |
| --- | --- |
| `DATABASE_URL` | Neon/Postgres connection string (required) |
| `GEMINI_API_KEY` | Google AI key — Lyria 3.5 + Gemini 2.5 Flash brain (required) |
| `ELEVENLABS_API_KEY` | ElevenLabs key for the `elevenlabs` provider |
| `MUSIC_PROVIDER` | `lyria` (default) or `elevenlabs` — also switchable at runtime via `PUT /api/settings` |
| `TRACK_LENGTH_MS` | ElevenLabs track length (default 90000) |
| `LOOKAHEAD` | Tracks generated ahead of the playhead (default 2) |
