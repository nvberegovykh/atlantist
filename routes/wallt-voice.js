/**
 * Owns: /api/wallt/voice/* — ElevenLabs TTS endpoints.
 * Does NOT own: Web Audio playback (client-side), voice preference storage.
 *
 * Endpoints:
 *   GET  /api/wallt/voice/catalog   — list bundled voices + user selected
 *   GET  /api/wallt/voice/quota      — ElevenLabs usage stats
 *   POST /api/wallt/voice/speak      — stream TTS audio, returns MP3 stream
 *   PUT  /api/wallt/voice/preferences — save voice_character_id + voice_enabled + volume
 *   GET  /api/wallt/voice/preferences — load voice preferences for current user
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const pool  = require('../db/index');
const { streamSpeech, getBundledVoices, checkQuota } = require('../services/wallt-voice');

// ── Helpers ────────────────────────────────────────────────────────────────

async function getVoicePrefs(userId) {
  if (!userId) return { voice_character_id: null, voice_enabled: false, voice_volume: 0.8 };
  const { rows } = await pool.query(
    `SELECT voice_character_id, voice_enabled, voice_volume
     FROM wallt_core_user_profile WHERE user_id = $1`,
    [userId]
  );
  if (!rows.length) return { voice_character_id: null, voice_enabled: false, voice_volume: 0.8 };
  return rows[0];
}

async function saveVoicePrefs(userId, { voice_character_id, voice_enabled, voice_volume }) {
  await pool.query(
    `INSERT INTO wallt_core_user_profile (user_id, voice_character_id, voice_enabled, voice_volume, profile_json)
     VALUES ($1, $2, $3, $4, '{}')
     ON CONFLICT (user_id) DO UPDATE
       SET voice_character_id = $2, voice_enabled = $3, voice_volume = $4, updated_at = NOW()`,
    [userId, voice_character_id || null, voice_enabled !== undefined ? voice_enabled : false, voice_volume || 0.8]
  );
}

// ── GET /api/wallt/voice/catalog ───────────────────────────────────────────

router.get('/catalog', optionalAuth, async (req, res) => {
  const bundled = getBundledVoices();
  const prefs   = await getVoicePrefs(req.user ? req.user.id : null);

  res.json({
    voices: bundled,
    selected: prefs.voice_character_id,
    enabled:  prefs.voice_enabled,
    volume:   prefs.voice_volume,
  });
});

// ── GET /api/wallt/voice/quota ──────────────────────────────────────────────

router.get('/quota', optionalAuth, async (req, res) => {
  const quota = await checkQuota();
  if (!quota) {
    return res.json({
      available: false,
      reason: 'ELEVENLABS_API_KEY not configured or fetch failed',
    });
  }
  res.json({ available: true, ...quota });
});

// ── POST /api/wallt/voice/speak ─────────────────────────────────────────────
// Body: { text, mode?, voice_id? }
// Returns: audio/mpeg Readable stream (or JSON error)

router.post('/speak', optionalAuth, async (req, res) => {
  const { text, mode = 'routine', voice_id: overrideVoiceId } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Resolve voice: override > user pref > default first bundled voice
  const prefs    = await getVoicePrefs(req.user ? req.user.id : null);
  const voiceId  = overrideVoiceId || prefs.voice_character_id || getBundledVoices()[0].voice_id;

  // Respect voice_enabled gate
  if (!prefs.voice_enabled) {
    return res.status(200).json({ skipped: true, reason: 'voice disabled' });
  }

  const volume = prefs.voice_volume || 0.8;

  // Set headers for streaming response
  res.set({
    'Content-Type':  'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store',
    'X-Voice-Id':    voiceId,
    'X-Mode':        mode,
  });

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const stream = await streamSpeech({
      voiceId,
      text,
      mode,
      volume,
      signal: req.abortSignal,
    });

    if (!stream) {
      // Graceful degradation — return JSON indicating unavailability
      res.set('Content-Type', 'application/json');
      return res.status(503).json({
        error: 'voice_unavailable',
        reason: 'ElevenLabs API key missing, quota exhausted, or service unavailable',
      });
    }

    // Pipe ElevenLabs stream directly to response (chunked)
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.set('Content-Type', 'application/json');
        res.status(503).json({ error: 'stream_error', reason: err.message });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (err) {
    if (aborted) return;
    console.error('[wallt-voice] speak error:', err.message);
    if (!res.headersSent) {
      res.set('Content-Type', 'application/json');
      res.status(500).json({ error: 'speak_failed' });
    }
  }
});

// ── GET /api/wallt/voice/preferences ───────────────────────────────────────

router.get('/preferences', optionalAuth, async (req, res) => {
  const prefs = await getVoicePrefs(req.user ? req.user.id : null);
  res.json({ ...prefs });
});

// ── PUT /api/wallt/voice/preferences ──────────────────────────────────────

router.put('/preferences', optionalAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });

  const { voice_character_id, voice_enabled, voice_volume } = req.body;

  if (voice_volume !== undefined && (voice_volume < 0 || voice_volume > 1)) {
    return res.status(400).json({ error: 'voice_volume must be 0.0–1.0' });
  }

  await saveVoicePrefs(req.user.id, { voice_character_id, voice_enabled, voice_volume });

  const updated = await getVoicePrefs(req.user.id);
  res.json({ ok: true, ...updated });
});

module.exports = router;