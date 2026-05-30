/**
 * Owns: support_triage_rules table, keyword-based ticket categorization.
 * Does NOT own: ticket creation, routing, or notifications.
 */
const pool = require('./index');

// Keyword weight map for each rule
const PRIORITY_WEIGHT = { high: 3, normal: 2, low: 1 };

async function getActiveRules() {
  const res = await pool.query(
    'SELECT * FROM support_triage_rules WHERE enabled = true ORDER BY confidence DESC'
  );
  return res.rows;
}

/**
 * Analyze subject + description and return the best matching category and priority.
 * Falls back to default (other, normal) if no rules match.
 */
async function autoTriage(subject, description) {
  const text = ((subject || '') + ' ' + (description || '')).toLowerCase();
  const rules = await getActiveRules();

  let bestCategory = 'other';
  let bestPriority = 'normal';
  let bestScore = 0;

  for (const rule of rules) {
    const matches = rule.keywords.filter(kw => text.includes(kw.toLowerCase()));
    if (matches.length === 0) continue;
    const score = matches.length * rule.confidence * PRIORITY_WEIGHT[rule.priority] / 100;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
      bestPriority = rule.priority;
    }
  }

  return { category: bestCategory, priority: bestPriority, confidence: Math.min(Math.round(bestScore), 100) };
}

async function addTriageRule(data) {
  const { keywords, category, priority = 'normal', confidence = 80 } = data;
  const res = await pool.query(
    `INSERT INTO support_triage_rules (keywords, category, priority, confidence)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [keywords, category, priority, confidence]
  );
  return res.rows[0];
}

async function listTriageRules() {
  const res = await pool.query('SELECT * FROM support_triage_rules ORDER BY confidence DESC');
  return res.rows;
}

async function toggleRule(id, enabled) {
  const res = await pool.query(
    'UPDATE support_triage_rules SET enabled = $1 WHERE id = $2 RETURNING *',
    [enabled, id]
  );
  return res.rows[0];
}

async function deleteRule(id) {
  await pool.query('DELETE FROM support_triage_rules WHERE id = $1', [id]);
}

module.exports = {
  autoTriage,
  addTriageRule,
  listTriageRules,
  toggleRule,
  deleteRule,
};