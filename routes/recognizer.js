/**
 * Owns: /api/crafting/recognize/* — Universal input layer.
 * Converts any source into a crafting_things record.
 * Does NOT own: crafting_things CRUD (db/crafting.js).
 */
const router = require('express').Router();
const multer = require('multer');
const { authMiddleware } = require('./auth');
const { recognize, normalizeProperties, fromBIMModel } = require('../services/thing-recognizer');
const { createThing, updateThing, getThingById } = require('../db/crafting');

// Multer config for file uploads (pdf, voice)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ── helpers ──────────────────────────────────────────────────────────────────

function parseBody(req, fields) {
  const out = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) out[f] = req.body[f];
  }
  return out;
}

/** Highlight properties below a confidence threshold. */
function highlightLowConfidence(props) {
  const threshold = 0.7;
  const low = {};
  for (const [key, conf] of Object.entries(props.property_confidences || {})) {
    if (conf < threshold) {
      low[key] = { value: props[key], confidence: conf, needs_correction: true };
    }
  }
  return low;
}

// ── Recognize & Create Thing ─────────────────────────────────────────────────

// POST /api/crafting/recognize
// Universal endpoint — detect input type from Content-Type / body shape, recognize, persist.
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { input_method, input_data, project_id, create_thing = true } = req.body;

    if (!input_method) return res.status(400).json({ error: 'input_method is required' });
    if (!input_data) return res.status(400).json({ error: 'input_data is required' });

    let recognized;
    try {
      recognized = await recognize(input_method, input_data, req.userId);
    } catch (err) {
      return res.status(422).json({
        error: 'Recognition failed',
        detail: err.message,
        input_method,
      });
    }

    let thing = null;
    if (create_thing) {
      thing = await createThing({
        name: recognized.name,
        description: `Created via ${input_method} recognition`,
        properties_json: recognized.properties,
        source_type: recognized.source_type,
        source_ref: recognized.source_ref,
        created_by: req.userId,
        project_id: project_id ? parseInt(project_id) : null,
        is_assembly: false,
      });
    }

    const lowConfidence = highlightLowConfidence(recognized.properties);

    res.status(201).json({
      thing,
      recognized: {
        name: recognized.name,
        properties: recognized.properties,
        source_type: recognized.source_type,
        source_ref: recognized.source_ref,
      },
      low_confidence: lowConfidence,
      correction_prompt: Object.keys(lowConfidence).length > 0
        ? `The following properties need review: ${Object.keys(lowConfidence).join(', ')}.`
        : null,
    });
  } catch (err) {
    console.error('[recognizer] POST /:', err.message);
    res.status(500).json({ error: 'Recognition failed: ' + err.message });
  }
});

// ── Input Method Endpoints ────────────────────────────────────────────────────

// POST /api/crafting/recognize/bim/:elementId
// Direct BIM model selection — authoritative, no AI needed.
router.post('/bim/:elementId', authMiddleware, async (req, res) => {
  try {
    const elementId = parseInt(req.params.elementId);
    if (!elementId) return res.status(400).json({ error: 'invalid element ID' });

    const recognized = await fromBIMModel(elementId);

    const { name, properties, source_type, source_ref } = recognized;
    const thing = await createThing({
      name, properties_json: properties, source_type, source_ref,
      created_by: req.userId,
      project_id: req.body.project_id ? parseInt(req.body.project_id) : null,
    });

    res.status(201).json({ thing, recognized, low_confidence: {} });
  } catch (err) {
    console.error('[recognizer] bim:', err.message);
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crafting/recognize/image
// Upload image or pass base64/R2 URL — AI vision analysis.
router.post('/image', authMiddleware, async (req, res) => {
  try {
    const { image_data, image_mime_type = 'image/jpeg', user_prompt, project_id } = req.body;
    if (!image_data) return res.status(400).json({ error: 'image_data is required (base64, R2 URL, or data URI)' });

    const recognized = await recognize('image', image_data, req.userId);
    const thing = await createThing({
      name: recognized.name,
      properties_json: recognized.properties,
      source_type: 'image',
      source_ref: null,
      created_by: req.userId,
      project_id: project_id ? parseInt(project_id) : null,
    });

    const lowConfidence = highlightLowConfidence(recognized.properties);
    res.status(201).json({ thing, recognized: { name: recognized.name, properties: recognized.properties }, low_confidence: lowConfidence });
  } catch (err) {
    console.error('[recognizer] image:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crafting/recognize/url
// Paste retail URL — scrape and extract.
router.post('/url', authMiddleware, async (req, res) => {
  try {
    const { url, project_id } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!url.startsWith('http')) return res.status(400).json({ error: 'url must be a valid HTTP(S) URL' });

    const recognized = await recognize('url', url, req.userId);
    const thing = await createThing({
      name: recognized.name,
      properties_json: recognized.properties,
      source_type: 'url',
      source_ref: url,
      created_by: req.userId,
      project_id: project_id ? parseInt(project_id) : null,
    });

    const lowConfidence = highlightLowConfidence(recognized.properties);
    res.status(201).json({ thing, recognized: { name: recognized.name, properties: recognized.properties }, low_confidence: lowConfidence });
  } catch (err) {
    console.error('[recognizer] url:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crafting/recognize/pdf
// Upload PDF or text document — extract line items as Things.
router.post('/pdf', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const file = req.file;

    // Accept: application/pdf, text/plain
    const allowedMimes = ['application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedMimes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported file type. Upload PDF, TXT, DOC, or DOCX.' });
    }

    const { fromPDF } = require('../services/thing-recognizer');
    const buffer = file.data;
    const things = await fromPDF(buffer);

    const created = [];
    for (const t of things) {
      const thing = await createThing({
        name: t.name,
        properties_json: t.properties,
        source_type: 'pdf',
        source_ref: file.originalname,
        created_by: req.userId,
        project_id: req.body.project_id ? parseInt(req.body.project_id) : null,
      });
      created.push(thing);
    }

    res.status(201).json({
      count: created.length,
      things: created,
      source_type: 'pdf',
      note: 'Each recognized line item is a separate Thing',
    });
  } catch (err) {
    console.error('[recognizer] pdf:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crafting/recognize/text
// Natural language or voice text — NLP extraction.
router.post('/text', authMiddleware, async (req, res) => {
  try {
    const { text, user_context, project_id } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length < 3) return res.status(400).json({ error: 'text too short (minimum 3 characters)' });

    const recognized = await recognize('text', text, req.userId);
    const thing = await createThing({
      name: recognized.name,
      properties_json: recognized.properties,
      source_type: 'text',
      source_ref: null,
      created_by: req.userId,
      project_id: project_id ? parseInt(project_id) : null,
    });

    const lowConfidence = highlightLowConfidence(recognized.properties);
    res.status(201).json({
      thing, recognized: { name: recognized.name, properties: recognized.properties },
      low_confidence: lowConfidence,
      tolerance_ranges: recognized.properties.tolerance_ranges || null,
    });
  } catch (err) {
    console.error('[recognizer] text:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crafting/recognize/voice
// Audio file upload — Whisper transcribe + NLP extract.
router.post('/voice', authMiddleware, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file is required' });
    const file = req.file;
    const allowedMimes = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'];
    if (!allowedMimes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported audio format. Use WebM, MP4, MP3, OGG, or WAV.' });
    }

    const { fromVoice } = require('../services/thing-recognizer');
    const recognized = await fromVoice(file.data, file.mimetype);
    const thing = await createThing({
      name: recognized.name,
      properties_json: recognized.properties,
      source_type: 'voice',
      source_ref: null,
      created_by: req.userId,
      project_id: req.body.project_id ? parseInt(req.body.project_id) : null,
    });

    const lowConfidence = highlightLowConfidence(recognized.properties);
    res.status(201).json({ thing, recognized: { name: recognized.name, properties: recognized.properties }, low_confidence: lowConfidence });
  } catch (err) {
    console.error('[recognizer] voice:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crafting/recognize/asset
// Asset Store / BIM Library — pre-populated asset → Thing.
router.post('/asset', authMiddleware, async (req, res) => {
  try {
    const { asset_data, project_id } = req.body;
    if (!asset_data) return res.status(400).json({ error: 'asset_data is required' });

    const { fromAssetStore } = require('../services/thing-recognizer');
    const recognized = await fromAssetStore(asset_data);
    const thing = await createThing({
      name: recognized.name,
      properties_json: recognized.properties,
      source_type: 'asset_store',
      source_ref: recognized.source_ref,
      created_by: req.userId,
      project_id: project_id ? parseInt(project_id) : null,
    });

    const lowConfidence = highlightLowConfidence(recognized.properties);
    res.status(201).json({ thing, recognized: { name: recognized.name, properties: recognized.properties }, low_confidence: lowConfidence });
  } catch (err) {
    console.error('[recognizer] asset:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Correction Endpoint ──────────────────────────────────────────────────────

// PATCH /api/crafting/recognize/:thingId/correct
// User corrects a low-confidence property — updates the Thing and logs the correction.
router.patch('/:thingId/correct', authMiddleware, async (req, res) => {
  try {
    const thingId = parseInt(req.params.thingId);
    if (!thingId) return res.status(400).json({ error: 'invalid thing ID' });

    const existing = await getThingById(thingId);
    if (!existing) return res.status(404).json({ error: 'Thing not found' });
    if (existing.created_by !== req.userId) return res.status(403).json({ error: 'Forbidden' });

    const { corrected_properties } = req.body;
    if (!corrected_properties || typeof corrected_properties !== 'object') {
      return res.status(400).json({ error: 'corrected_properties object is required' });
    }

    // Normalize corrections
    const normalized = normalizeProperties(corrected_properties);

    // Merge with existing properties
    const existingProps = existing.properties_json || {};
    const merged = { ...existingProps, ...normalized };

    // Update confidence: mark corrected fields as high-confidence (0.99)
    merged.property_confidences = { ...(existingProps.property_confidences || {}) };
    for (const key of Object.keys(corrected_properties)) {
      merged.property_confidences[key] = 0.99;
    }
    merged.overall_confidence = Object.values(merged.property_confidences).reduce((a, b) => a + b, 0)
      / Math.max(1, Object.keys(merged.property_confidences).length);

    const updated = await updateThing(thingId, { properties_json: merged });

    // Log correction for model feedback
    const pool = require('../db/index');
    try {
      await pool.query(
        `INSERT INTO crafting_recognition_logs (thing_id, user_id, source_type, raw_properties_json, confidence, status)
         VALUES ($1,$2,'correction',$3,0.99,'completed')`,
        [thingId, req.userId, JSON.stringify(corrected_properties)]
      );
    } catch { /* non-critical */ }

    res.json({ thing: updated, corrections_applied: Object.keys(corrected_properties) });
  } catch (err) {
    console.error('[recognizer] correct:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Batch Recognize ───────────────────────────────────────────────────────────

// POST /api/crafting/recognize/batch
// Recognize multiple inputs in one call (for PDF line items or bulk URL paste).
router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const { inputs } = req.body;
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return res.status(400).json({ error: 'inputs array is required' });
    }
    if (inputs.length > 50) return res.status(400).json({ error: 'Maximum 50 inputs per batch' });

    const results = [];
    for (const inp of inputs) {
      try {
        const recognized = await recognize(inp.input_method, inp.input_data, req.userId);
        const thing = await createThing({
          name: recognized.name,
          properties_json: recognized.properties,
          source_type: recognized.source_type,
          source_ref: recognized.source_ref,
          created_by: req.userId,
          project_id: inp.project_id ? parseInt(inp.project_id) : null,
        });
        results.push({ success: true, thing });
      } catch (err) {
        results.push({ success: false, input: inp, error: err.message });
      }
    }

    res.status(201).json({
      total: inputs.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('[recognizer] batch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;