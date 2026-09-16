// The "brain": Gemini 2.5 Flash turns raw user prompts into track metadata
// (title, color palette, energy), evolves the stream with follow-up prompts,
// and produces direction suggestions. Falls back to deterministic defaults
// if the LLM call fails so the music engine never stalls.

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = process.env.BRAIN_MODEL || 'gemini-3.6-flash';

async function ask(system, user, schema) {
  const res = await fetch(`${API}/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 1.0,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`brain ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

function hashHue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function fallbackPalette(prompt) {
  const hue = hashHue(prompt);
  return [
    `hsl(${hue}, 70%, 55%)`,
    `hsl(${(hue + 40) % 360}, 60%, 45%)`,
    `hsl(${(hue + 320) % 360}, 55%, 35%)`,
  ];
}

const META_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Evocative 2-4 word track title, no quotes' },
    palette: {
      type: 'array',
      items: { type: 'string' },
      description: '3 CSS hex colors that feel like this music, brightest first',
    },
    energy: { type: 'number', description: '0.0 (still, ambient) to 1.0 (peak club energy)' },
    musicPrompt: {
      type: 'string',
      description: 'Rich one-paragraph production brief for a music generation model: genre, mood, instrumentation, tempo, structure',
    },
  },
  required: ['title', 'palette', 'energy', 'musicPrompt'],
};

export async function trackMeta(prompt, historyTitles = []) {
  try {
    const meta = await ask(
      'You are the music director of an infinite AI music stream. Given a listener prompt, produce track metadata. The palette is the "light" of the scene: warm amber for soul, cold cyan for ambient, magenta/violet for club — pick colors that genuinely match the sound. Answer in the language-neutral: title can be English.',
      `Listener prompt: "${prompt}"\nRecent tracks in this stream: ${historyTitles.join(', ') || '(none)'}`,
      META_SCHEMA
    );
    // Models sometimes annotate colors ("#FFB703 bright amber") — keep only the hex.
    meta.palette = (Array.isArray(meta.palette) ? meta.palette : [])
      .map((c) => String(c).match(/#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/)?.[0])
      .filter(Boolean);
    if (meta.palette.length < 2) meta.palette = fallbackPalette(prompt);
    meta.energy = Math.max(0, Math.min(1, Number(meta.energy) || 0.5));
    return meta;
  } catch (err) {
    console.error('brain.trackMeta fallback:', err.message);
    return {
      title: prompt.split(/\s+/).slice(0, 4).join(' '),
      palette: fallbackPalette(prompt),
      energy: 0.5,
      musicPrompt: prompt,
    };
  }
}

export async function nextPrompt(seedPrompt, history) {
  try {
    const out = await ask(
      'You are a DJ curating an infinite personalized music stream. Given the seed vibe and recent tracks, write the prompt for the NEXT track: it should feel like a natural continuation — same world, but evolving (never a repeat). One concise sentence describing genre, mood, instrumentation, tempo.',
      `Seed vibe: "${seedPrompt}"\nRecent tracks (oldest first):\n${history
        .map((t) => `- ${t.title || t.prompt}`)
        .join('\n') || '(none yet)'}`,
      {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      }
    );
    return out.prompt;
  } catch (err) {
    console.error('brain.nextPrompt fallback:', err.message);
    return seedPrompt;
  }
}

export async function suggestions(seedPrompt, history) {
  try {
    const out = await ask(
      'You suggest directions an infinite AI music stream could take next. Given the current vibe, produce 3 short, distinct, tempting directions. Each has a 2-3 word label (like a mood chip) and a one-sentence music prompt. Make them diverge: one stays close, one shifts mood, one is a bold turn.',
      `Seed vibe: "${seedPrompt}"\nRecent tracks: ${history.map((t) => t.title || t.prompt).join(', ') || '(none)'}`,
      {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['label', 'prompt'],
            },
          },
        },
        required: ['suggestions'],
      }
    );
    return (out.suggestions || []).slice(0, 3);
  } catch (err) {
    console.error('brain.suggestions fallback:', err.message);
    return [];
  }
}

const VISUAL_SCHEMA = {
  type: 'object',
  properties: {
    vocals: { type: 'boolean', description: 'true if the track has sung vocals' },
    lyrics: {
      type: 'array',
      description: 'Sung lines you can clearly hear, with start time in seconds. Empty if instrumental. Max 24 lines.',
      items: {
        type: 'object',
        properties: {
          t: { type: 'number', description: 'start time of the line in seconds' },
          text: { type: 'string' },
        },
        required: ['t', 'text'],
      },
    },
    sections: {
      type: 'array',
      description: 'Musical timeline: intro, build, drop, verse, chorus, breakdown, outro… with start time and intensity. Use the optional fields to EVOLVE the scene through the song — weather shifts, beat effects change, light warms or cools. The visuals should keep changing with the music, not just once at the start.',
      items: {
        type: 'object',
        properties: {
          t: { type: 'number', description: 'start time in seconds' },
          label: { type: 'string' },
          intensity: { type: 'number', description: '0.0 calm to 1.0 peak' },
          weather: {
            type: 'string',
            enum: ['none', 'dust', 'rain', 'snow', 'embers', 'fireflies'],
            description: 'optional weather change for this section',
          },
          weatherIntensity: { type: 'number' },
          beatEffect: { type: 'string', enum: ['flare', 'lightning', 'burst'] },
          warmth: { type: 'number', description: 'optional light temperature shift for this section: -1 cold blue .. 0 neutral .. 1 warm golden' },
        },
        required: ['t', 'label', 'intensity'],
      },
    },
    design: {
      type: 'object',
      description: "The song's own design identity. Think like a concrete product designer or artist: who would design THIS song's screen? Derive typography and accent decisions from that reference. Every song should feel distinct but tasteful.",
      properties: {
        designer: {
          type: 'string',
          description: 'The concrete design reference in a few words, e.g. "Dieter Rams functional calm", "Saul Bass cutout drama", "Teenage Engineering playful tech", "A24 film title minimalism"',
        },
        accent: { type: 'string', description: 'UI accent color as hex — bold enough to color buttons and highlights' },
        titleCase: { type: 'string', enum: ['none', 'uppercase'] },
        titleWeight: { type: 'string', enum: ['700', '800', '900'] },
        lyricFont: { type: 'string', enum: ['sans', 'serif', 'mono'], description: 'sans = modern bold (default), serif = poetic/organic songs, mono = electronic/techy songs' },
        lyricWeight: { type: 'string', enum: ['600', '700', '800'] },
        mood: { type: 'string', enum: ['clean', 'raw', 'dreamy', 'electric'], description: 'clean = minimal grain, raw = heavy film grain, dreamy = soft glow, electric = punchy contrast' },
      },
      required: ['designer', 'accent', 'titleCase', 'titleWeight', 'lyricFont', 'lyricWeight', 'mood'],
    },
    scene: {
      type: 'object',
      description: 'The visual world this music evokes, as parameters for a silhouette landscape engine',
      properties: {
        world: { type: 'string', description: 'one-line description of the world' },
        ground: {
          type: 'object',
          properties: {
            style: { type: 'string', enum: ['hills', 'mountains', 'dunes', 'plains', 'waves'] },
            roughness: { type: 'number', description: '0 smooth .. 1 jagged' },
          },
          required: ['style', 'roughness'],
        },
        elements: {
          type: 'array',
          description: 'Silhouette props placed in the world, 1-4 entries',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['tree', 'pine', 'cactus', 'building', 'tower', 'rock', 'grass', 'arch'],
              },
              layer: { type: 'string', enum: ['mid', 'near'] },
              density: { type: 'number', description: '0 rare .. 1 everywhere' },
              scale: { type: 'number', description: '0 small .. 1 towering' },
            },
            required: ['type', 'layer', 'density', 'scale'],
          },
        },
        sky: {
          type: 'object',
          properties: {
            orb: { type: 'string', enum: ['sun', 'moon', 'none'] },
            orbHeight: { type: 'number', description: '0 at horizon .. 1 high in the sky' },
            starDensity: { type: 'number', description: '0 none .. 1 full night sky' },
          },
          required: ['orb', 'orbHeight', 'starDensity'],
        },
        weather: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['none', 'dust', 'rain', 'snow', 'embers', 'fireflies'] },
            intensity: { type: 'number' },
          },
          required: ['type', 'intensity'],
        },
        beatEffect: { type: 'string', enum: ['flare', 'lightning', 'burst'] },
      },
      required: ['world', 'ground', 'elements', 'sky', 'weather', 'beatEffect'],
    },
  },
  required: ['vocals', 'lyrics', 'sections', 'scene', 'design'],
};

// Gemini listens to the finished track and scripts its visuals: a scene spec
// for the silhouette engine, a section timeline, and timed lyrics if sung.
export async function analyzeTrack(audio, mime, context) {
  const res = await fetch(`${API}/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'You are the visual + design director of a music app whose background is an endless side-scrolling silhouette landscape (Limbo-style, lit by colored fog) with a Spotify-grade UI layer on top. Listen to the track and script its visuals AND its design identity. Pick scene elements that genuinely fit what you hear — a desert groove gets dunes and cacti, synthwave gets a skyline, folk gets forest, a sea shanty gets waves. Let the scene EVOLVE across sections (weather, beat effects, light warmth) so the visuals keep moving with the song. For the design identity, channel a concrete designer or artist who fits this exact song and derive accent color and typography from that reference. Transcribe sung lyrics with timestamps only if you clearly hear singing; never invent lyrics for instrumentals.',
        }],
      },
      contents: [{
        parts: [
          { text: `Track context: ${context}` },
          { inlineData: { mimeType: mime || 'audio/mpeg', data: audio.toString('base64') } },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: VISUAL_SCHEMA,
        temperature: 0.8,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`analyze ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

export async function streamTitle(prompt) {
  try {
    const out = await ask(
      'Name this music stream: a poetic 2-3 word title capturing the vibe. No quotes.',
      `Vibe: "${prompt}"`,
      { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
    );
    return out.title;
  } catch {
    return prompt.split(/\s+/).slice(0, 3).join(' ');
  }
}
