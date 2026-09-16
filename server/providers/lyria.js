const API = 'https://generativelanguage.googleapis.com/v1beta';

// Lyria 3.5 via the Gemini API. Returns ~60s MP3 clips as inline base64.
export async function generate({ prompt }) {
  const model = process.env.LYRIA_MODEL || 'lyria-3.5';
  const res = await fetch(`${API}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`lyria ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find((p) => p.inlineData?.data);
  if (!audioPart) {
    throw new Error(`lyria: no audio in response (${JSON.stringify(data).slice(0, 300)})`);
  }
  const audio = Buffer.from(audioPart.inlineData.data, 'base64');
  const mime = audioPart.inlineData.mimeType || 'audio/mpeg';
  // Lyria returns 192kbps CBR MP3 — estimate duration from size.
  const durationMs = Math.round((audio.length * 8) / 192_000 * 1000);
  return { audio, mime, durationMs };
}
