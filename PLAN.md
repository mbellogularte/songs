# Sona — Plan

**Der promptbare, unendliche Music-Stream.** Du beschreibst in einem Satz, was du hören willst — Sona generiert daraus einen Stream, der nie aufhört: Jeder Track wird live von KI komponiert, während der vorherige noch läuft.

## Konzept

1. **Start wie bei Lovable/ChatGPT:** Ein einziges Prompt-Feld. Eingabe startet den Stream — der erste Track wird direkt aus dem Prompt generiert.
2. **Unendlicher Feed:** Die Engine hält immer ~2 Tracks Vorlauf ("Lookahead"). Sobald ein Track anspielt, wird der übernächste bereits generiert — der Stream reißt nie ab, wie ein endloser DJ-Mix.
3. **Auto-Evolution:** Ohne weiteren Input entwickelt ein Gemini-"Brain" den Stream weiter — jeder Auto-Track ist eine natürliche Fortsetzung des bisherigen Vibes, nie eine Wiederholung.
4. **Prompt-Injection:** Über die Eingabezeile unten feuerst du jederzeit neue Track-Ideen ab. Sie landen in der Warteschlange und werden sofort generiert.
5. **Warteschlange wie bei Spotify:** Kommende Tracks lassen sich per Drag & Drop neu anordnen. Der Generierungsstatus ist visuell: fertige Tracks stehen scharf im Licht, generierende sind unscharfe, pulsierende Silhouetten im Nebel — kein einziger Spinner, kein Label.
6. **Live-Vorschläge:** Passend zum aktuellen Sound tauchen Vorschlags-Chips aus dem Nebel auf (eine nahe, eine verschobene, eine mutige Richtung). Ein Tap reiht den Vorschlag in die Queue ein.

## Music Engine (Backend, Provider-agnostisch)

- **Abstraktion:** `server/providers/*` — jeder Provider implementiert `generate({prompt}) → {audio, mime, durationMs}`.
- **Provider 1: Lyria 3.5** (Google Gemini API, `models/lyria-3.5`) — liefert ~60s-Tracks als MP3. *Default.*
- **Provider 2: ElevenLabs Music** (`/v1/music`) — Länge konfigurierbar via `TRACK_LENGTH_MS` (Default 90s).
- **Switchen:** Global per `PUT /api/settings {music_provider}` (persistiert in der DB) oder Env `MUSIC_PROVIDER`; im Frontend über das dezente ·-Menü unten links.
- **Brain:** Gemini 2.5 Flash liefert pro Track Titel, Farbpalette (das "Licht" der Szene), Energie-Wert und einen ausformulierten Produktions-Prompt; außerdem Stream-Titel, Auto-Fortsetzungen und die Richtungs-Vorschläge. Fällt bei Fehlern deterministisch zurück, damit die Engine nie stehen bleibt.
- **Persistenz:** Neon Postgres — Streams, Tracks (inkl. Audio als bytea), Settings. Der Server ist dadurch stateless und übersteht Restarts/Redeploys.
- **Worker:** In-Process-Queue mit `FOR UPDATE SKIP LOCKED` (2 parallele Generierungen), Requeue hängengebliebener Tracks beim Boot.

## Design (Limbo-Regeln, Spotify-Logik, Farbe aus der Musik)

- Grundton tiefes, kaltes Anthrazit — nie Schwarz, nie Weißflächen, kein UI-Chrome.
- **Farbe existiert nur als Licht:** Die Palette jedes Tracks leuchtet als riesiger, weicher Farbnebel (3 geblurte Blobs, Screen-Blend) durch den Hintergrund. Der Nebel atmet mit der Musik: Web-Audio-Analyser — Energie steuert Helligkeit/Sättigung, Bass drückt die Blobs nach vorn. Beim Trackwechsel wandert die Lichtstimmung (4s-Farbtransition), keine UI blendet über.
- Filmkorn (animierte SVG-Turbulence) + Vignette über allem; Typografie dünn, klein, niedriger Kontrast — nur der laufende Track ist voll lesbar.
- Queue = Silhouetten, die ins Licht treten (siehe oben). Vorschläge = halbtransparente Formen, die sich aus dem Nebel lösen. Prompt-Feld = eine einzelne dünne, glühende Linie in der aktuellen Track-Farbe.

## Tech-Stack & Deployment

- Node 20+/Express, `pg`, kein Build-Step; Vanilla-JS-Frontend als **PWA** (Manifest, Service Worker, installierbar, Media-Session für Lockscreen-Controls).
- Audio-Streaming mit HTTP-Range-Support (Seeking funktioniert).
- Deployment: **Render** (Web Service, Melotech-Workspace) + **Neon** (Postgres). Env: `DATABASE_URL`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `MUSIC_PROVIDER`.

## API-Überblick

| Endpoint | Zweck |
| --- | --- |
| `POST /api/streams {prompt}` | Stream starten (Track 1 + Lookahead) |
| `GET /api/streams/:id` | Stream + Queue-Status (Polling) |
| `POST /api/streams/:id/tracks {prompt}` | Track-Idee in die Queue feuern |
| `POST /api/streams/:id/reorder {trackIds}` | Queue umsortieren |
| `POST /api/streams/:id/advance {trackId}` | Playhead melden → Lookahead auffüllen |
| `GET /api/streams/:id/suggestions` | 3 Richtungs-Vorschläge |
| `GET /api/tracks/:id/audio` | Audio (Range-Support) |
| `GET/PUT /api/settings` | Music-Provider lesen/switchen |

## Später (V2-Ideen)

- Crossfade/gapless zwischen Tracks, echtes Realtime-Streaming (`lyria-realtime-exp`)
- Accounts, Stream-History, Sharing von Streams per Link
- Vorschläge als "Bubbles" mit Physik, Tilt-Parallaxe auf dem Handy
- Object Storage (R2/S3) statt bytea, wenn die Library wächst
