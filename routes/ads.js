/**
 * Owns: /api/ads CRUD, ad campaign metadata.
 * Does NOT own: video/image generation, R2 storage, Meta Ads agent execution.
 */
const router = require('express').Router();
const {
  createAdCampaign,
  getAdCampaignById,
  getAllAdCampaigns,
  getLatestDraftCampaigns,
  updateAdCampaignStatus,
  updateAdCampaign,
  deleteAdCampaign,
  getAdCampaignStats,
} = require('../db/ads');

// GET /api/ads — list all campaigns
router.get('/', async (req, res) => {
  try {
    const { status, audience, limit } = req.query;
    const campaigns = await getAllAdCampaigns({
      status,
      audience,
      limit: parseInt(limit) || 20,
    });
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ads/stats — summary stats
router.get('/stats', async (_req, res) => {
  try {
    res.json(await getAdCampaignStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ads/drafts — latest draft campaigns (for Meta Ads agent to pick up)
router.get('/drafts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    res.json(await getLatestDraftCampaigns({ limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ads/:id
router.get('/:id', async (req, res) => {
  try {
    const campaign = await getAdCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ads — create or update a campaign (called by ad_generator.js)
router.post('/', async (req, res) => {
  try {
    const {
      campaign_id, page_type, audience, goal, copy_mode,
      brand_headline, site_url, status, trigger, metadata,
      ad_asset_urls, created_by,
    } = req.body;

    if (!campaign_id) {
      return res.status(400).json({ error: 'campaign_id is required' });
    }

    const campaign = await createAdCampaign({
      campaign_id, page_type, audience, goal, copy_mode,
      brand_headline, site_url, status, trigger, metadata,
      ad_asset_urls, created_by,
    });

    res.status(201).json(campaign);
  } catch (err) {
    console.error('[ads] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ads/:id — update status or metadata (Meta Ads agent hook)
router.patch('/:id', async (req, res) => {
  try {
    const { status, metadata, ad_asset_urls, trigger } = req.body;
    const existing = await getAdCampaignById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const updated = await updateAdCampaign(req.params.id, {
      status, metadata, ad_asset_urls, trigger,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ads/by-campaign-id/:campaignId/status — update by campaign_id (webhook friendly)
router.patch('/by-campaign-id/:campaignId/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    const { getAdCampaignByCampaignId } = require('../db/ads');
    const existing = await getAdCampaignByCampaignId(req.params.campaignId);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const updated = await updateAdCampaignStatus(existing.id, status);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ads/generate — trigger ad generation (Meta Ads agent hook)
router.post('/generate', async (req, res) => {
  try {
    const { page = 'hero', audience = 'architect', goal = 'signups', trigger = 'api' } = req.body;

    const { spawn } = require('child_process');
    const scriptPath = require('path').resolve(__dirname, '../scripts/ad_generator.js');
    const env = { ...process.env };

    const child = spawn('node', [scriptPath, '--site', 'https://atlantist.cloud', '--page', page, '--audience', audience, '--goal', goal], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });

    child.on('close', async (code) => {
      if (code !== 0 && stderr) {
        console.error('[ads/generate] script failed:', stderr);
        return res.status(500).json({ error: 'Ad generation failed', detail: stderr.slice(-500) });
      }

      // Pull campaign_id from stdout
      const idMatch = stdout.match(/Campaign ID: (atlantist_[^\n]+)/);
      const campaignId = idMatch ? idMatch[1] : null;

      res.json({
        ok: true,
        trigger,
        page,
        audience,
        goal,
        campaign_id: campaignId,
        output: stdout.slice(-2000),
      });
    });

    child.on('error', err => {
      console.error('[ads/generate] spawn error:', err.message);
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ads/:id
router.delete('/:id', async (req, res) => {
  try {
    await deleteAdCampaign(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;