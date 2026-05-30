/**
 * Owns: wallt_legal_registry + wallt_compliance_reports tables.
 * Does NOT own: legal opinion logic (services/wallt-legal-registry.js).
 * Phase 36L: Wallt Legal Registry — query, insert, compliance report CRUD.
 */
const pool = require('./index');

// ── Registry CRUD ────────────────────────────────────────────────────────────

/** Fetch codes for a jurisdiction/system. Pass codes=[] for all. */
async function getCodesForJurisdiction({ codes = [], jurisdiction, version = null } = {}) {
  let sql = `
    SELECT * FROM wallt_legal_registry
    WHERE is_current = TRUE AND is_active = TRUE
      AND ($1::VARCHAR[] IS NULL OR $1::VARCHAR[] = '{}' OR code_system = ANY($1))
      AND jurisdiction = $2
  `;
  const params = [codes.length ? codes : null, jurisdiction];
  if (version) {
    sql += ` AND version_label = $3`;
    params.push(version);
  }
  sql += ` ORDER BY code_system, code_number;`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Search registry by keywords */
async function searchCodes(query, { codes = [], jurisdiction, limit = 20 } = {}) {
  const keywordPattern = query.split(' ').filter(Boolean).join(' & ');
  let sql = `
    SELECT * FROM wallt_legal_registry
    WHERE is_active = TRUE
      AND ($1::VARCHAR[] IS NULL OR $1::VARCHAR[] = '{}' OR code_system = ANY($1))
      AND ($2::VARCHAR IS NULL OR jurisdiction = $2)
      AND (
        code_number ILIKE $3
        OR code_title ILIKE $3
        OR ai_summary ILIKE $3
        OR EXISTS (SELECT 1 FROM unnest(keywords) kw WHERE kw ILIKE $3)
      )
    ORDER BY code_system, version_effective_date DESC NULLS LAST
    LIMIT $4;
  `;
  const likePattern = `%${query}%`;
  const { rows } = await pool.query(sql, [codes.length ? codes : null, jurisdiction || null, likePattern, limit]);
  return rows;
}

/** Insert or update a registry entry */
async function upsertCode(entry) {
  const {
    code_system, code_number, code_title, jurisdiction,
    jurisdiction_context = 'us', version_label = '1.0',
    version_effective_date = null, version_expiry_date = null,
    parameter_name = null, parameter_value = null,
    value_min = null, value_max = null, unit = null, formula_reference = null,
    application_rules = {}, exceptions = [],
    section_ref = null, page_ref = null, table_ref = null, figure_ref = null,
    enforcement_level = 'code', penalty_severity = null, fine_amount_usd = null,
    ai_summary = null, ai_compliance_check_prompt = null, keywords = [],
    source_url = null, source_name = null, source_publish_date = null,
  } = entry;

  const { rows } = await pool.query(`
    INSERT INTO wallt_legal_registry (
      code_system, code_number, code_title, jurisdiction, jurisdiction_context,
      version_label, version_effective_date, version_expiry_date,
      parameter_name, parameter_value, value_min, value_max, unit, formula_reference,
      application_rules, exceptions,
      section_ref, page_ref, table_ref, figure_ref,
      enforcement_level, penalty_severity, fine_amount_usd,
      ai_summary, ai_compliance_check_prompt, keywords,
      source_url, source_name, source_publish_date,
      is_current, is_active, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24,$25,$26,$27,$28,$29,$30, TRUE, TRUE, NOW(), NOW()
    )
    ON CONFLICT (code_system, code_number, jurisdiction, version_label)
    DO UPDATE SET
      code_title = EXCLUDED.code_title,
      parameter_name = EXCLUDED.parameter_name,
      parameter_value = EXCLUDED.parameter_value,
      ai_summary = EXCLUDED.ai_summary,
      ai_compliance_check_prompt = EXCLUDED.ai_compliance_check_prompt,
      keywords = EXCLUDED.keywords,
      is_active = TRUE,
      updated_at = NOW()
    RETURNING *;
  `, [
    code_system, code_number, code_title, jurisdiction, jurisdiction_context,
    version_label, version_effective_date || null, version_expiry_date || null,
    parameter_name, parameter_value, value_min, value_max, unit, formula_reference,
    JSON.stringify(application_rules), JSON.stringify(exceptions),
    section_ref, page_ref, table_ref, figure_ref,
    enforcement_level, penalty_severity, fine_amount_usd,
    ai_summary, ai_compliance_check_prompt, keywords,
    source_url, source_name, source_publish_date || null,
  ]);
  return rows[0];
}

/** Retire a code version (mark superseded) */
async function retireCode(id, supersededById) {
  await pool.query(
    `UPDATE wallt_legal_registry SET is_current = FALSE, superseded_by = $2, updated_at = NOW() WHERE id = $1`,
    [id, supersededById]
  );
}

/** List all code systems + jurisdictions available */
async function listCodeSystems() {
  const { rows } = await pool.query(`
    SELECT DISTINCT code_system, jurisdiction, version_label, count(*) as count
    FROM wallt_legal_registry
    WHERE is_current = TRUE AND is_active = TRUE
    GROUP BY code_system, jurisdiction, version_label
    ORDER BY code_system, jurisdiction;
  `);
  return rows;
}

// ── Compliance Reports ────────────────────────────────────────────────────────

/** Write a compliance report */
async function saveComplianceReport(report) {
  const {
    user_id, codes_checked, jurisdiction, project_id = null,
    model_snapshot = null, overall_status,
    pass_count = 0, fail_count = 0, ambiguous_count = 0, not_applicable_count = 0,
    code_results = [], warnings = [], recommendations = [], parameters_used = {},
  } = report;

  const { rows } = await pool.query(`
    INSERT INTO wallt_compliance_reports (
      user_id, codes_checked, jurisdiction, project_id, model_snapshot,
      overall_status, pass_count, fail_count, ambiguous_count, not_applicable_count,
      code_results, warnings, recommendations, parameters_used,
      created_at, expires_at, is_pinned
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW(), NOW() + INTERVAL '90 days', FALSE)
    RETURNING *;
  `, [
    user_id, codes_checked, jurisdiction, project_id, JSON.stringify(model_snapshot || {}),
    overall_status, pass_count, fail_count, ambiguous_count, not_applicable_count,
    JSON.stringify(code_results), JSON.stringify(warnings), JSON.stringify(recommendations),
    JSON.stringify(parameters_used),
  ]);
  return rows[0];
}

/** Get user's compliance reports */
async function getReports({ user_id, project_id, limit = 20 } = {}) {
  let sql = `SELECT * FROM wallt_compliance_reports WHERE 1=1`;
  const params = [];
  if (user_id) { params.push(user_id); sql += ` AND user_id = $${params.length}`; }
  if (project_id) { params.push(project_id); sql += ` AND project_id = $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length};`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Pin a compliance report */
async function pinReport(id) {
  await pool.query(`UPDATE wallt_compliance_reports SET is_pinned = TRUE WHERE id = $1`, [id]);
}

module.exports = {
  getCodesForJurisdiction,
  searchCodes,
  upsertCode,
  retireCode,
  listCodeSystems,
  saveComplianceReport,
  getReports,
  pinReport,
};