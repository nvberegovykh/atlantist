/**
 * Owns: all DB queries for guide system — categories, guides, progress, submissions.
 * Does NOT own: guide rendering, skill tier enforcement (client-side only).
 */
const pool = require('./index');

// ─── Categories ──────────────────────────────────────────────────────────────

async function getAllCategories() {
  const res = await pool.query(
    'SELECT * FROM guide_categories ORDER BY sort_order ASC'
  );
  return res.rows;
}

async function getCategoryBySlug(slug) {
  const res = await pool.query(
    'SELECT * FROM guide_categories WHERE slug = $1', [slug]
  );
  return res.rows[0] || null;
}

// ─── Guides ───────────────────────────────────────────────────────────────────

async function getGuidesByCategory(categorySlug) {
  const res = await pool.query(
    `SELECT id, category_slug, title, slug, difficulty, time_estimate, summary, tags, featured, created_at, updated_at
     FROM guides WHERE category_slug = $1 AND published = true
     ORDER BY featured DESC, title ASC`,
    [categorySlug]
  );
  return res.rows;
}

async function getGuideBySlug(slug) {
  const res = await pool.query(
    'SELECT * FROM guides WHERE slug = $1 AND published = true', [slug]
  );
  return res.rows[0] || null;
}

async function getGuideById(id) {
  const res = await pool.query('SELECT * FROM guides WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getAllPublishedGuides(limit = 50) {
  const res = await pool.query(
    `SELECT id, category_slug, title, slug, difficulty, time_estimate, summary, tags, featured, created_at
     FROM guides WHERE published = true
     ORDER BY featured DESC, title ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function searchGuides(query) {
  const q = '%' + query.toLowerCase() + '%';
  const res = await pool.query(
    `SELECT id, category_slug, title, slug, difficulty, time_estimate, summary, tags
     FROM guides WHERE published = true
       AND (LOWER(title) LIKE $1 OR LOWER(summary) LIKE $1 OR $2 = ANY(LOWER(tags::text[])))
     ORDER BY featured DESC, title ASC LIMIT 20`,
    [q, query.toLowerCase()]
  );
  return res.rows;
}

async function getFeaturedGuides(limit = 5) {
  const res = await pool.query(
    `SELECT id, category_slug, title, slug, difficulty, time_estimate, summary, tags
     FROM guides WHERE featured = true AND published = true
     ORDER BY title ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

async function getUserProgress(userId) {
  const res = await pool.query(
    'SELECT guide_id, completed, completed_steps, progress_pct, updated_at FROM guide_progress WHERE user_id = $1',
    [userId]
  );
  return res.rows;
}

async function upsertGuideProgress(userId, guideId, completed, completedSteps, progressPct) {
  const res = await pool.query(
    `INSERT INTO guide_progress (user_id, guide_id, completed, completed_steps, progress_pct)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, guide_id) DO UPDATE SET
       completed = EXCLUDED.completed,
       completed_steps = EXCLUDED.completed_steps,
       progress_pct = EXCLUDED.progress_pct,
       updated_at = NOW()
     RETURNING *`,
    [userId, guideId, completed, JSON.stringify(completedSteps), progressPct]
  );
  return res.rows[0];
}

async function markGuideComplete(userId, guideId) {
  return upsertGuideProgress(userId, guideId, true, [], 100);
}

async function getGuideStats() {
  const res = await pool.query(`
    SELECT
      g.id, g.title, g.slug, g.category_slug,
      COUNT(DISTINCT gp.user_id) as total_learners,
      COUNT(DISTINCT CASE WHEN gp.completed THEN gp.user_id END) as completions
    FROM guides g
    LEFT JOIN guide_progress gp ON gp.guide_id = g.id
    GROUP BY g.id
    ORDER BY completions DESC
  `);
  return res.rows;
}

// ─── Submissions ───────────────────────────────────────────────────────────────

async function createGuideSubmission(data) {
  const { guide_id, category_slug, title, difficulty, time_estimate, steps, tags, submitted_by, author_name, author_email } = data;
  const res = await pool.query(
    `INSERT INTO guide_submissions (guide_id, category_slug, title, difficulty, time_estimate, steps, tags, submitted_by, author_name, author_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [guide_id || null, category_slug, title, difficulty || 'Beginner', time_estimate, JSON.stringify(steps || []), tags || [], submitted_by, author_name, author_email]
  );
  return res.rows[0];
}

async function getPendingSubmissions() {
  const res = await pool.query(
    "SELECT * FROM guide_submissions WHERE status = 'pending' ORDER BY created_at DESC"
  );
  return res.rows;
}

async function getSubmissionById(id) {
  const res = await pool.query('SELECT * FROM guide_submissions WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function approveSubmission(id, reviewedBy, notes) {
  const res = await pool.query(
    `UPDATE guide_submissions SET status = 'approved', reviewed_by = $1, review_notes = $2, reviewed_at = NOW()
     WHERE id = $3 RETURNING *`,
    [reviewedBy, notes, id]
  );
  return res.rows[0];
}

async function rejectSubmission(id, reviewedBy, notes) {
  const res = await pool.query(
    `UPDATE guide_submissions SET status = 'rejected', reviewed_by = $1, review_notes = $2, reviewed_at = NOW()
     WHERE id = $3 RETURNING *`,
    [reviewedBy, notes, id]
  );
  return res.rows[0];
}

async function getSubmissionStats() {
  const res = await pool.query(`
    SELECT
      status, COUNT(*) as count
    FROM guide_submissions
    GROUP BY status ORDER BY count DESC
  `);
  return res.rows;
}

// ─── Admin: update guide ───────────────────────────────────────────────────────

async function updateGuide(id, data) {
  const fields = [];
  const vals = [];
  let i = 1;
  const allowed = ['title', 'difficulty', 'time_estimate', 'summary', 'steps', 'tags', 'featured', 'published'];
  for (const k of allowed) {
    if (data[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      vals.push(k === 'steps' || k === 'tags' ? JSON.stringify(data[k]) : data[k]);
    }
  }
  if (!fields.length) return getGuideById(id);
  fields.push('updated_at = NOW()');
  vals.push(id);
  const res = await pool.query(
    `UPDATE guides SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0];
}

async function reorderGuideCategories(orderMap) {
  // orderMap: [{ slug, sort_order }]
  for (const { slug, sort_order } of orderMap) {
    await pool.query('UPDATE guide_categories SET sort_order = $1 WHERE slug = $2', [sort_order, slug]);
  }
}

module.exports = {
  getAllCategories,
  getCategoryBySlug,
  getGuidesByCategory,
  getGuideBySlug,
  getGuideById,
  getAllPublishedGuides,
  searchGuides,
  getFeaturedGuides,
  getUserProgress,
  upsertGuideProgress,
  markGuideComplete,
  getGuideStats,
  createGuideSubmission,
  getPendingSubmissions,
  getSubmissionById,
  approveSubmission,
  rejectSubmission,
  getSubmissionStats,
  updateGuide,
  reorderGuideCategories,
};