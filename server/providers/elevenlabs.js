// ElevenLabs Music API. Composes a track from a text prompt.
export async function generate({ prompt }) {
  const lengthMs = Math.min(300_000, Math.max(10_000, Number(process.env.TRACK_LENGTH_MS) || 90_000));
  const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, music_length_ms: lengthMs }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`elevenlabs ${res.status}: ${body.slice(0, 400)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  const durationMs = Math.round((audio.length * 8) / 128_000 * 1000);
  return { audio, mime: 'audio/mpeg', durationMs };
}
