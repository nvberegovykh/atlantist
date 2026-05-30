/**
 * Owns: ElevenLabs TTS integration — streaming text-to-speech for Wallt voice companion.
 * Does NOT own: Voice preference storage, UI controls, audio playback (client-side Web Audio).
 *
 * Wraps ElevenLabs streaming API: POST /v1/text-to-speech/{voice_id}/stream
 * Returns a Readable stream of MP3 bytes for Express to pipe to the client.
 * Gracefully degrades when ELEVENLABS_API_KEY is absent or quota is exhausted.
 *
 * Stability / similarity_boost mapping by message type:
 *   routine   → stability: 0.7,  similarity_boost: 0.75  (calm, professional)
 *   warning   → stability: 0.4,  similarity_boost: 0.6   (slightly urgent)
 *   humor     → stability: 0.3,  similarity_boost: 0.5   (natural variance)
 *   escalation→ stability: 0.5,  similarity_boost: 0.7   (authoritative)
 */

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = process.env.ELEVENLABS_API_KEY;

// ── Voice catalog: bundled voices matching Wallt's persona ──────────────────
// These are publicly documented ElevenLabs voice IDs.
// Replace or add custom clone IDs via the voice selection panel.
const BUNDLED_VOICES = [
  {
    voice_id: 'JBFQNCRmNWJ2EcrPnTJY',
    name: 'Marcus',
    description: 'Direct, confident, professional — calm authority with a slight edge.',
    gender: 'male',
    accent: 'neutral',
    preview_url: 'https://api.elevenlabs.io/v1/voices/JBFQNCRmNWJ2EcrPnTJY',
  },
  {
    voice_id: 'EXAVITQ4ZR04fchhHnx1',
    name: 'Sofia',
    description: 'Warm, precise, measured — authoritative without coldness.',
    gender: 'female',
    accent: 'neutral',
    preview_url: 'https://api.elevenlabs.io/v1/voices/EXAVITQ4ZR04fchhHnx1',
  },
  {
    voice_id: 'XB0fDUBXUypgZCD98U3W',
    name: 'Jordan',
    description: 'Professional but approachable — clear, concise, no-nonsense.',
    gender: 'neutral',
    accent: 'neutral',
    preview_url: 'https://api.elevenlabs.io/v1/voices/XB0fDUBXUypgZCD98U3W',
  },
  {
    voice_id: 'VR6AewLTigWU4urK0DYX',
    name: 'Ava',
    description: 'Authoritative, articulate — perfect for technical explanations.',
    gender: 'female',
    accent: 'neutral',
    preview_url: 'https://api.elevenlabs.io/v1/voices/VR6AewLTigWU4urK0DYX',
  },
];

// Stability / similarity_boost by message intent
const TTS_MODES = {
  routine:    { stability: 0.7, similarity_boost: 0.75, style: 0.0 },
  warning:    { stability: 0.4, similarity_boost: 0.6,  style: 0.2 },
  humor:      { stability: 0.3, similarity_boost: 0.5,  style: 0.3 },
  escalation: { stability: 0.5, similarity_boost: 0.7,  style: 0.1 },
};

// ── Pre-process text for better TTS output ────────────────────────────────

/**
 * Clean and annotate text for ElevenLabs:
 * - Strip markdown / HTML
 * - Replace BIM-specific notation with spoken equivalents
 * - Add micro-pauses (.) for emphasis boundaries
 */
function preprocessText(text) {
  // Remove markdown bold/italic/links
  let cleaned = text
    .replace(/\n+/g, '. ')
    .replace(/\b(Wallt)\b/gi, 'Wallt')          // keep as-is but normalize
    .replace(/`([^`]+)`/g, '$1')                // inline code → words
    .replace(/\bBIM\b/gi, 'B-I-M')
    .replace(/\bDAG\b/gi, 'D-A-G')
    .replace(/\bAPI\b/gi, 'A-P-I')
    .replace(/[.]{3,}/g, '.')
    .replace(/\b_+\b/g, '')                     // remove underscore runs
    .replace(/\b(\/[\/\/\/\/]+\b)/g, '')         // remove URL slugs
    .trim();

  // Limit to 2500 chars (ElevenLabs limit ~5000, keep headroom for headers)
  if (cleaned.length > 2500) cleaned = cleaned.slice(0, 2497) + '…';

  return cleaned;
}

// ── Core TTS fetch ────────────────────────────────────────────────────────

/**
 * Stream TTS audio from ElevenLabs for the given text + voice + mode.
 * Returns a Readable stream or null if unavailable.
 *
 * @param {Object} opts
 * @param {string} opts.voiceId      — ElevenLabs voice ID
 * @param {string} opts.text         — text to synthesize
 * @param {'routine'|'warning'|'humor'|'escalation'} [opts.mode='routine']
 * @param {number}  [opts.volume=0.8] — volume 0.0–1.0
 * @param {AbortSignal} [opts.signal] — for cancellation
 */
async function streamSpeech({ voiceId, text, mode = 'routine', volume = 0.8, signal }) {
  if (!API_KEY) {
    console.warn('[wallt-voice] ELEVENLABS_API_KEY not set — voice degraded to text-only');
    return null;
  }

  const settings = TTS_MODES[mode] || TTS_MODES.routine;
  const processedText = preprocessText(text);

  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',   // MP3 for broad browser support
      },
      body: JSON.stringify({
        text: processedText,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability:         settings.stability,
          similarity_boost: settings.similarity_boost,
          style:            settings.style,
          use_speaker_boost: true,
        },
        optimize_streaming_latency: 4, // max latency reduction
      }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.info('[wallt-voice] TTS request cancelled');
      return null;
    }
    console.error('[wallt-voice] fetch error:', err.message);
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // 429 = quota exhausted, 402 = payment required — degrade gracefully
    if (response.status === 429 || response.status === 402) {
      console.warn('[wallt-voice] ElevenLabs quota exhausted (HTTP %d) — voice degraded', response.status);
    } else {
      console.error('[wallt-voice] ElevenLabs error %d: %s', response.status, body.slice(0, 200));
    }
    return null;
  }

  return response.body; // ReadableStream
}

// ── Quota check ───────────────────────────────────────────────────────────

/**
 * Check ElevenLabs character usage for the current month.
 * Returns { used, limit, remaining } or null on failure.
 */
async function checkQuota() {
  if (!API_KEY) return null;

  try {
    const res = await fetch(`${ELEVENLABS_BASE}/user/subscription`, {
      headers: { 'xi-api-key': API_KEY },
    });
    if (!res.ok) return null;
    const sub = await res.json();
    return {
      used:      sub.character_count       || 0,
      limit:     sub.character_limit      || 10000,
      remaining: sub.character_remaining  || 0,
      plan:      sub.plan                 || 'free',
    };
  } catch {
    return null;
  }
}

module.exports = {
  streamSpeech,
  preprocessText,
  checkQuota,
  getBundledVoices: () => BUNDLED_VOICES,
  TTS_MODES,
};