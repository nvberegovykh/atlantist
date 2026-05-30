/**
 * Owns: ad_campaigns table — Meta video ad campaign metadata.
 * Does NOT own: video generation, R2 storage, Meta Ads agent.
 */
const { query } = require('./index');

const TABLE = 'ad_campaigns';

async function createAdCampaign({
  campaign_id, page_type, audience, goal, copy_mode,
  brand_headline, site_url, status, trigger, metadata,
  ad_asset_urls = [], created_by = null,
} = {}) {
  const sql = `
    INSERT INTO ${TABLE}
      (campaign_id, page_type, audience, goal, copy_mode, brand_headline,
       site_url, status, trigger, metadata, ad_asset_urls, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (campaign_id) DO UPDATE SET
      metadata = EXCLUDED.metadata,
      ad_asset_urls = EXCLUDED.ad_asset_urls,
      status = EXCLUDED.status,
      updated_at = NOW()
    RETURNING *
  `;
  const { rows } = await query(sql, [
    campaign_id, page_type, audience, goal, copy_mode, brand_headline,
    site_url || 'https://atlantist.cloud', status || 'draft', trigger || 'manual',
    JSON.stringify(metadata || {}), JSON.stringify(ad_asset_urls), created_by,
  ]);
  return rows[0];
}

async function getAdCampaignById(id) {
  const { rows } = await query(
    `SELECT * FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getAdCampaignByCampaignId(campaignId) {
  const { rows } = await query(
    `SELECT * FROM ${TABLE} WHERE campaign_id = $1`,
    [campaignId]
  );
  return rows[0] || null;
}

async function getAllAdCampaigns({ status, audience, limit = 20 } = {}) {
  let sql = `SELECT * FROM ${TABLE}`;
  const params = [];
  const conditions = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (audience) {
    params.push(audience);
    conditions.push(`audience = $${params.length}`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await query(sql, params);
  return rows;
}

async function getLatestDraftCampaigns({ limit = 5 } = {}) {
  const { rows } = await query(
    `SELECT * FROM ${TABLE} WHERE status = 'draft' ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function updateAdCampaignStatus(id, status) {
  const { rows } = await query(
    `UPDATE ${TABLE} SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

async function updateAdCampaign(id, updates) {
  const fields = [];
  const params = [];
  let paramIdx = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${paramIdx++}`);
    params.push(updates.status);
  }
  if (updates.metadata !== undefined) {
    fields.push(`metadata = $${paramIdx++}`);
    params.push(JSON.stringify(updates.metadata));
  }
  if (updates.ad_asset_urls !== undefined) {
    fields.push(`ad_asset_urls = $${paramIdx++}`);
    params.push(JSON.stringify(updates.ad_asset_urls));
  }
  if (updates.trigger !== undefined) {
    fields.push(`trigger = $${paramIdx++}`);
    params.push(updates.trigger);
  }

  if (fields.length === 0) return getAdCampaignById(id);

  fields.push(`updated_at = NOW()`);
  params.push(id);
  const { rows } = await query(
    `UPDATE ${TABLE} SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function deleteAdCampaign(id) {
  await query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
}

async function getAdCampaignStats() {
  const { rows } = await query(`
    SELECT
      status,
      COUNT(*) as count,
      MAX(created_at) as last_created
    FROM ${TABLE}
    GROUP BY status
    ORDER BY COUNT(*) DESC
  `);
  return rows;
}

module.exports = {
  createAdCampaign,
  getAdCampaignById,
  getAdCampaignByCampaignId,
  getAllAdCampaigns,
  getLatestDraftCampaigns,
  updateAdCampaignStatus,
  updateAdCampaign,
  deleteAdCampaign,
  getAdCampaignStats,
};