/**
 * Owns: all DB queries for leads table.
 * Does NOT own: email campaign logic, lead scoring algorithms.
 */
const pool = require('./index');

// Create or update lead with GDPR consent
async function upsertLead(data) {
  const { email, source, name, company, phone, consent_given = false } = data;
  const res = await pool.query(
    `INSERT INTO leads (email, source, name, company, phone, tier, engagement_score, consent_given, consent_timestamp)
     VALUES ($1, $2, $3, $4, $5, 'new', 0, $6, $7)
     ON CONFLICT (email) DO UPDATE SET
       source = EXCLUDED.source,
       name = COALESCE(EXCLUDED.name, leads.name),
       company = COALESCE(EXCLUDED.company, leads.company),
       phone = COALESCE(EXCLUDED.phone, leads.phone),
       consent_given = EXCLUDED.consent_given,
       consent_timestamp = CASE WHEN EXCLUDED.consent_given AND NOT leads.consent_given THEN NOW() ELSE leads.consent_timestamp END,
       updated_at = NOW()
     RETURNING *`,
    [email, source, name || null, company || null, phone || null, consent_given, consent_given ? new Date() : null]
  );
  return res.rows[0];
}

// Get lead by email
async function getLeadByEmail(email) {
  const res = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
  return res.rows[0] || null;
}

// Get lead by ID
async function getLeadById(id) {
  const res = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Update lead tier and engagement
async function updateLeadEngagement(id, tier, score) {
  const res = await pool.query(
    `UPDATE leads SET tier = $2, engagement_score = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, tier, score]
  );
  return res.rows[0];
}

// Update lead score
async function incrementLeadScore(id, amount = 10) {
  const res = await pool.query(
    `UPDATE leads SET engagement_score = LEAST(engagement_score + $2, 100), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, amount]
  );
  return res.rows[0];
}

// Mark lead as verified (email verification completed)
async function verifyLead(email) {
  const res = await pool.query(
    `UPDATE leads SET verified = true, verified_at = NOW(), updated_at = NOW()
     WHERE email = $1 RETURNING *`,
    [email]
  );
  return res.rows[0];
}

// Update last login for lead (for inactive email trigger)
async function updateLastLogin(email, loginAt = new Date()) {
  const res = await pool.query(
    `UPDATE leads SET last_login_at = $2, updated_at = NOW()
     WHERE email = $1 RETURNING *`,
    [email, loginAt]
  );
  return res.rows[0];
}

// Set billing period end (for billing renewal email trigger)
async function setBillingPeriodEnd(email, periodEnd) {
  const res = await pool.query(
    `UPDATE leads SET billing_period_end = $2, updated_at = NOW()
     WHERE email = $1 RETURNING *`,
    [email, periodEnd]
  );
  return res.rows[0];
}

// List leads with optional filters
async function listLeads(filters = {}) {
  const { tier, source, limit = 100, offset = 0, verified_only } = filters;
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  let idx = 1;

  if (tier) {
    query += ` AND tier = $${idx++}`;
    params.push(tier);
  }
  if (source) {
    query += ` AND source = $${idx++}`;
    params.push(source);
  }
  if (verified_only) {
    query += ` AND verified = true`;
  }

  query += ` ORDER BY engagement_score DESC, created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const res = await pool.query(query, params);
  return res.rows;
}

// Get leads by tier
async function getLeadsByTier(tier) {
  const res = await pool.query(
    'SELECT * FROM leads WHERE tier = $1 ORDER BY engagement_score DESC',
    [tier]
  );
  return res.rows;
}

// Get lead counts by tier
async function getLeadCounts() {
  const res = await pool.query(`
    SELECT tier, COUNT(*) as count, AVG(engagement_score) as avg_engagement
    FROM leads GROUP BY tier
  `);
  return res.rows;
}

// Get verified leads for email sequences
async function getVerifiedLeadsForSequence(sequenceType) {
  const res = await pool.query(`
    SELECT * FROM leads
    WHERE verified = true AND consent_given = true
    ORDER BY created_at ASC
    LIMIT 500
  `);
  return res.rows;
}

// Get leads needing inactive email (verified, not sent in 7+ days)
async function getInactiveLeads() {
  const res = await pool.query(`
    SELECT l.* FROM leads l
    WHERE l.verified = true
      AND l.consent_given = true
      AND l.tier = 'new'
      AND l.last_login_at IS NOT NULL
      AND l.last_login_at < NOW() - INTERVAL '7 days'
    ORDER BY l.last_login_at ASC
    LIMIT 100
  `);
  return res.rows;
}

// Get leads needing billing renewal email (3 days before)
async function getBillingRenewalLeads() {
  const res = await pool.query(`
    SELECT * FROM leads
    WHERE verified = true
      AND consent_given = true
      AND billing_period_end IS NOT NULL
      AND billing_period_end BETWEEN NOW() AND NOW() + INTERVAL '4 days'
    ORDER BY billing_period_end ASC
  `);
  return res.rows;
}

// Bulk update tier for segment
async function updateLeadsTier(criteria, newTier) {
  const { tier, min_engagement } = criteria;
  let query = 'UPDATE leads SET tier = $1, updated_at = NOW() WHERE 1=1';
  const params = [newTier];
  let idx = 2;

  if (tier) {
    query += ` AND tier = $${idx++}`;
    params.push(tier);
  }
  if (min_engagement !== undefined) {
    query += ` AND engagement_score >= $${idx++}`;
    params.push(min_engagement);
  }

  const res = await pool.query(query, params);
  return res.rowCount;
}

async function createVerificationToken(email, token) {
  const res = await pool.query(
    `INSERT INTO email_verification_tokens (email, token) VALUES ($1, $2)`,
    [email, token]
  );
  return res.rowCount > 0;
}

async function getVerificationToken(token) {
  const res = await pool.query(
    `SELECT email FROM email_verification_tokens WHERE token = $1 AND used = false AND expires_at > NOW()`,
    [token]
  );
  return res.rows[0] || null;
}

async function markVerificationTokenUsed(token) {
  await pool.query(`UPDATE email_verification_tokens SET used = true WHERE token = $1`, [token]);
}

module.exports = {
  upsertLead,
  getLeadByEmail,
  getLeadById,
  updateLeadEngagement,
  incrementLeadScore,
  verifyLead,
  updateLastLogin,
  setBillingPeriodEnd,
  listLeads,
  getLeadsByTier,
  getLeadCounts,
  getVerifiedLeadsForSequence,
  getInactiveLeads,
  getBillingRenewalLeads,
  updateLeadsTier,
  createVerificationToken,
  getVerificationToken,
  markVerificationTokenUsed
};