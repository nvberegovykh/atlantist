/**
 * Owns: /api/renders CRUD, AI image generation via OpenAI, render history.
 * Does NOT own: Three.js scene, FBX export (client-side), camera export.
 */
const router = require('express').Router();
const OpenAI = require('openai');
const { createRender, getAllRenders, getRenderById, deleteRender } = require('../db/renders');

const R2_BASE = process.env.POLSIA_R2_BASE_URL || 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev';

// Style → architectural prompt suffix
const STYLE_PROMPTS = {
  photorealistic: 'Architectural photorealistic exterior rendering, warm afternoon sunlight, soft shadows, cinematic composition, 4K, professional architectural visualization',
  watercolor: 'Watercolor architectural illustration, soft loose brushstrokes, muted pastel palette, hand-painted quality, architectural concept sketch, artistic rendering',
  sketch: 'Architectural pencil sketch, fine linework, grey tone shading, technical drawing aesthetic, black and white illustration, presentation-quality hand sketch',
  analytical: 'Analytical architectural drawing, axonometric projection, line weight variation, muted greyscale with blue accents, technical presentation style, orthographic quality',
};

// POST /api/renders — AI render: capture viewport → OpenAI → store → return
router.post('/', async (req, res) => {
  try {
    const { imageBase64, style, viewpointName, cameraData, sourceCanvas } = req.body;

    if (!imageBase64 || !style) {
      return res.status(400).json({ error: 'imageBase64 and style are required' });
    }
    if (!STYLE_PROMPTS[style]) {
      return res.status(400).json({ error: 'Invalid style. Choose: photorealistic, watercolor, sketch, analytical' });
    }

    // Decode base64 image
    const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\\w+;base64,/, ''), 'base64');

    // Upload source canvas image to R2 for prompt context
    const sourceFilename = `renders/source_${Date.now()}.png`;
    const sourceUrl = await uploadToR2(imageBuffer, sourceFilename);

    // Call OpenAI with image + style prompt
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.images.edit({
      image: imageBuffer.toString('base64'),
      model: 'gpt-image-1',
      prompt: `This is a 3D architectural BIM model. Generate a ${style} style architectural visualization: ${STYLE_PROMPTS[style]}. Preserve the building geometry and composition. Do not add unrelated elements.`,
    });

    const imageUrl = response.data[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: 'No image URL returned from OpenAI' });

    const render = await createRender({
      style,
      imageUrl,
      thumbnailUrl: imageUrl,
      viewpointName: viewpointName || 'Unnamed View',
      cameraData: cameraData || {},
      promptUsed: STYLE_PROMPTS[style],
      sourceCanvas: sourceCanvas || '3d',
    });

    res.json(render);
  } catch (err) {
    console.error('[renders] AI render error:', err.message);
    res.status(500).json({ error: 'Render failed: ' + err.message });
  }
});

// GET /api/renders — list all renders
router.get('/', async (_req, res) => {
  try {
    res.json(await getAllRenders());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/renders/:id
router.get('/:id', async (req, res) => {
  try {
    const render = await getRenderById(req.params.id);
    if (!render) return res.status(404).json({ error: 'Not found' });
    res.json(render);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/renders/:id
router.delete('/:id', async (req, res) => {
  try {
    await deleteRender(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/renders/export-camera — export camera position as .json
router.post('/export-camera', async (req, res) => {
  try {
    const { cameraData, filename } = req.body;
    if (!cameraData) return res.status(400).json({ error: 'cameraData required' });

    const json = JSON.stringify(cameraData, null, 2);
    const buf = Buffer.from(json);
    const name = filename || `camera_export_${Date.now()}.json`;
    const key = `renders/camera/${name}`;
    await uploadToR2(buf, key);

    res.json({ downloadUrl: `${R2_BASE}/renders/camera/${name}`, filename: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: upload buffer to R2
async function uploadToR2(buffer, key) {
  const r2Url = process.env.POLSIA_R2_UPLOAD_URL || `https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/${key}`;
  const res = await fetch(r2Url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed: ${res.status} ${text}`);
  }
  return `${R2_BASE}/${key}`;
}

module.exports = router;