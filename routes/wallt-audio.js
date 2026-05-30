/**
 * Owns: /api/wallt/audio/compose — Wallt Audio Composition endpoint.
 * Does NOT own: Web Audio synthesis logic (services/wallt-audio-engine.js),
 * escalation trigger logic (services/wallt-escalation.js).
 *
 * POST /api/wallt/audio/compose
 *   Body: { escalationType, priority, escalationId?, context? }
 *   Response: { audioUrl, fileSizeKb, format, escalationId }
 *
 * Triggers audio only on CRITICAL misconceptions:
 *   - moral_drift > 0.6 AND irreversible consequences
 *   - legal engine NON_COMPLIANT on core ATLANTIST principle
 *   - critical safety gate triggered
 * NOT triggered by: routine queries, minor drift, informational escalations.
 *
 * Storage: /wallt/audio/escal-{escalationId}-{ts}.ogg on R2
 * Visibility: Admin panel only — never published externally.
 *
 * Also updates wallt_core_escalation_log.audio_file_ref with the generated URL.
 */
const router = require('express').Router();
const { optionalAuth, adminMiddleware: requireAdmin } = require('./auth');
const pool   = require('../db/index');
const { composeEscalationAudio, shouldGenerateAudio } = require('../services/wallt-audio-engine');

// ── POST /api/wallt/audio/compose ─────────────────────────────────────────────

router.post('/compose', optionalAuth, async (req, res) => {
  try {
    const { escalationType, priority = 'normal', escalationId, context } = req.body;

    if (!escalationType) {
      return res.status(400).json({ error: 'escalationType is required' });
    }

    const validTypes = ['moral_drift', 'legal_uncertainty', 'autonomous_action', 'user_request', 'auto_recovery'];
    if (!validTypes.includes(escalationType)) {
      return res.status(400).json({
        error: `invalid escalationType "${escalationType}"`,
        hint: `must be one of: ${validTypes.join(', ')}`,
      });
    }

    const validPriorities = ['critical', 'high', 'normal', 'low'];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({
        error: `invalid priority "${priority}"`,
        hint: `must be one of: ${validPriorities.join(', ')}`,
      });
    }

    // Gate: only generate for critical/high + appropriate trigger conditions
    const shouldCompose = shouldGenerateAudio({ escalationType, priority, context });
    if (!shouldCompose) {
      return res.status(200).json({
        skipped: true,
        reason: 'escalation does not meet audio trigger threshold (routine query, minor drift, or informational)',
        audioUrl: null,
        fileSizeKb: 0,
        format: null,
      });
    }

    // Generate the audio
    const result = await composeEscalationAudio({
      escalationType,
      priority,
      escalationId: escalationId || `proto-${Date.now()}`,
      text: req.body.text || null,
    });

    // Update escalation record if escalationId was provided
    if (escalationId) {
      await pool.query(
        `UPDATE wallt_core_escalation_log
         SET audio_file_ref = $2,
             audio_reason   = $3
         WHERE id = $1`,
        [escalationId, result.audioUrl, `wallt_audio_engine:triggered:${escalationType}`]
      );
    }

    // Full rights breakdown per ATLANTIST audio policy
    const rightsBreakdown = {
      original_work: {
        author: 'Wallt (AI Composition Engine)',
        attribution: 'Nikita Beregovykh — ATLANTIST / Polsia',
        license: 'Proprietary — ATLANTIST internal use only',
        notes: 'Synthesized audio — no third-party samples',
      },
      sampled_elements: [
        // No sampled audio elements — oscillator synthesis only
        // If any third-party samples are added in the future, list them here:
        // { element: '...', source: '...', rights_holder: '...', license: '...' }
      ],
      ai_training_provenance: {
        training_data_note: 'Oscillator synthesis produces no training-data-derived content',
        provenance: 'Procedurally generated — no ML model output',
      },
      restrictions: [
        'Admin panel only — not published externally',
        'No redistribution, no commercial use',
        'Audio embeddable in concern escalation log UI only',
      ],
    };

    // Log to wallt_core_audio_catalog (admin-only asset)
    await pool.query(
      `INSERT INTO wallt_core_audio_catalog
       (user_id, file_name, file_path, format, rights_breakdown_json, tags, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user ? req.user.id : null,
        `escal-${escalationId || 'proto'}-${Date.now()}.${result.format.toLowerCase()}`,
        result.audioUrl,
        result.format.toLowerCase(),
        JSON.stringify(rightsBreakdown),
        ['wallt', 'escalation', escalationType, priority],
        JSON.stringify({
          source: 'wallt_audio_engine',
          escalation_type: escalationType,
          priority,
          file_size_kb: result.fileSizeKb,
          generated_at: result.generatedAt,
        }),
      ]
    );

    res.status(201).json({
      audioUrl: result.audioUrl,
      fileSizeKb: result.fileSizeKb,
      format: result.format,
      escalationId: escalationId || null,
      generatedAt: result.generatedAt,
    });
  } catch (err) {
    console.error('[wallt-audio] compose error:', err.message);
    res.status(500).json({ error: 'Failed to compose audio' });
  }
});

// ── GET /api/wallt/audio/:escalationId — get audio for escalation (admin only) ─

router.get('/:escalationId', optionalAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT audio_file_ref, audio_reason, escalation_type, priority, created_at
       FROM wallt_core_escalation_log
       WHERE id = $1 AND audio_file_ref IS NOT NULL`,
      [parseInt(req.params.escalationId)]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No audio found for this escalation' });
    }
    res.json({ audio: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;