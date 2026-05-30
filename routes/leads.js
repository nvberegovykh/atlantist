/**
 * Owns: /api/leads/* — lead capture, management, GDPR consent, email verification.
 * Does NOT own: email campaigns, drip sequences, outreach automation.
 */
const router = require('express').Router();
const crypto = require('crypto');
const { upsertLead, getLeadByEmail, getLeadById, listLeads, getLeadCounts, incrementLeadScore, updateLeadEngagement, verifyLead, createVerificationToken, getVerificationToken, markVerificationTokenUsed } = require('../db/leads');
const { authMiddleware } = require('./auth');
const { canonicalUrl } = require('../lib/canonical-url');

const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Atlantist <noreply@atlantist.cloud>';
const REPLY_TO = 'Atlantist <support@atlantist.cloud>';

async function sendVerificationEmail(email, token) {
  const verifyUrl = canonicalUrl(`/api/leads/verify-email?token=${token}`);
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 32px;">
        <div style="font-size: 24px; font-weight: 700; color: #4a7dbd; letter-spacing: -0.5px;">⚡ Atlantist</div>
      </div>
      <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px; text-align: center;">Confirm your email</h1>
      <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 32px;">
        Click below to confirm your email and receive product updates. This link expires in 48 hours.
      </p>
      <div style="text-align: center; margin-bottom: 32px;">
        <a href="${verifyUrl}" style="display: inline-block; background: #4a7dbd; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 6px;">
          Confirm Email →
        </a>
      </div>
      <p style="font-size: 12px; color: #999; text-align: center;">
        If you didn't sign up for Atlantist, you can safely ignore this email.
      </p>
    </div>
  `;

  if (EMAIL_PROXY_URL) {
    try {
      const resp = await fetch(EMAIL_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email, from: FROM_ADDRESS, reply_to: REPLY_TO, subject: 'Confirm your email — Atlantist', html_body: htmlBody })
      });
      if (resp.ok) { console.log(`[leads] Verification email sent to ${email}`); return; }
      console.error(`[leads] Email proxy error: ${await resp.text()}`);
    } catch (err) { console.error(`[leads] Email proxy fetch error:`, err); }
  }

  console.log(`[leads] Verification email for ${email}: ${verifyUrl}`);
}

// POST /api/leads — Capture a new lead (public endpoint, GDPR compliant)
router.post('/', async (req, res) => {
  try {
    const { email, source, name, company, phone, consent_given } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const lead = await upsertLead({ email, source: source || 'web', name, company, phone, consent_given: !!consent_given });

    if (consent_given) {
      // Send verification email
      const token = crypto.randomBytes(32).toString('hex');
      await createVerificationToken(email, token);
      await sendVerificationEmail(email, token);
    }

    res.status(201).json({
      id: lead.id,
      email: lead.email,
      tier: lead.tier,
      engagement_score: lead.engagement_score,
      consent_received: !!consent_given
    });
  } catch (err) {
    console.error('[leads] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/verify-email — Email verification link (public, browser navigates here)
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/?lead_verify_error=invalid');

    const tokenRecord = await getVerificationToken(token);

    if (!tokenRecord) return res.redirect('/?lead_verify_error=expired');

    const email = tokenRecord.email;
    await verifyLead(email);
    await markVerificationTokenUsed(token);

    res.redirect('/?lead_verify=success');
  } catch (err) {
    console.error('[leads] GET /verify-email', err);
    res.redirect('/?lead_verify_error=server');
  }
});

// GET /api/leads — List leads (admin only)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { tier, source, limit, offset, verified_only } = req.query;
    const leads = await listLeads({
      tier,
      source,
      limit: parseInt(limit, 10) || 100,
      offset: parseInt(offset, 10) || 0,
      verified_only: verified_only === 'true'
    });
    res.json(leads);
  } catch (err) {
    console.error('[leads] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/stats — Get lead statistics
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const counts = await getLeadCounts();
    const stats = {};
    counts.forEach(c => { stats[c.tier] = { count: parseInt(c.count, 10), avg_engagement: parseFloat(c.avg_engagement) || 0 }; });
    res.json(stats);
  } catch (err) {
    console.error('[leads] GET /stats', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id — Get lead by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const lead = await getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    console.error('[leads] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id — Update lead (admin only)
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { tier, engagement_score } = req.body;
    let lead = await getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (tier !== undefined) lead = await updateLeadEngagement(req.params.id, tier, lead.engagement_score);
    else if (engagement_score !== undefined) lead = await updateLeadEngagement(req.params.id, lead.tier, engagement_score);
    res.json(lead);
  } catch (err) {
    console.error('[leads] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/increment — Increment engagement score
router.post('/:id/increment', authMiddleware, async (req, res) => {
  try {
    const { amount = 10 } = req.body;
    const lead = await incrementLeadScore(req.params.id, amount);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    console.error('[leads] POST /:id/increment', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;