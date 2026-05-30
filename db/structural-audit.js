/**
 * Owns: structural_audit_runs + attachment_audit_results DB access,
 *       connection_type_catalog reads, dag_edges metadata updates.
 * Does NOT own: audit computation logic (services/structural-audit-engine.js),
 *               HTTP routing, Three.js rendering.
 */

// Module constants — derived from SP-A specification
const DRIFT_TOLERANCE_MM = 37.5;  // M/16 tolerance threshold (1.476")
const FIX_SNAP_MM = 75;           // M/8 snap precision for repair (2.953")
const MODULE_MM = 600;            // 1 module = 600mm (1.97')

const db = require('./index');

const runs = {
  create: async ({ project_id, run_name, audit_type = 'full', disclaimer_accepted, created_by }) => {
    const r = await db.query(`
      INSERT INTO structural_audit_runs (project_id, run_name, audit_type, disclaimer_accepted, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [project_id, run_name || `Audit ${new Date().toLocaleDateString()}`, audit_type, disclaimer_accepted || false, created_by || null]);
    return r.rows[0] || null;
  },

  getById: async (id) => {
    const r = await db.query('SELECT * FROM structural_audit_runs WHERE id = $1', [id]);
    return r.rows[0] || null;
  },

  listByProject: async (projectId) => {
    const r = await db.query(
      'SELECT * FROM structural_audit_runs WHERE project_id = $1 ORDER BY created_at DESC',
      [projectId]
    );
    return r.rows;
  },

  updateStatus: async (id, status) => {
    const r = await db.query(
      `UPDATE structural_audit_runs SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    return r.rows[0] || null;
  },

  updateResults: async (id, { totals, load_path_summary, lateral_system_check }) => {
    const fields = ['status = $2', 'updated_at = NOW()'];
    const vals = [id, 'completed'];
    let p = 3;
    if (totals) { fields.push(`totals = $${p++}`); vals.push(JSON.stringify(totals)); }
    if (load_path_summary) { fields.push(`load_path_summary = $${p++}`); vals.push(JSON.stringify(load_path_summary)); }
    if (lateral_system_check) { fields.push(`lateral_system_check = $${p++}`); vals.push(JSON.stringify(lateral_system_check)); }
    const r = await db.query(
      `UPDATE structural_audit_runs SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
      vals
    );
    return r.rows[0] || null;
  },

  markFailed: async (id, error) => {
    const r = await db.query(
      `UPDATE structural_audit_runs
       SET status = 'failed', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    return r.rows[0] || null;
  },

  delete: async (id) => {
    await db.query('DELETE FROM structural_audit_runs WHERE id = $1', [id]);
  },
};

const results = {
  upsert: async ({ run_id, entity_type, entity_id, entity_name, verdict, category, issue_code, message, details, fix_available, fix_position }) => {
    const r = await db.query(`
      INSERT INTO attachment_audit_results
        (run_id, entity_type, entity_id, entity_name, verdict, category, issue_code, message, details, fix_available, fix_position)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (run_id, entity_type, entity_id, issue_code)
      DO UPDATE SET
        verdict = EXCLUDED.verdict,
        entity_name = EXCLUDED.entity_name,
        message = EXCLUDED.message,
        details = EXCLUDED.details,
        fix_available = EXCLUDED.fix_available,
        fix_position = EXCLUDED.fix_position
      RETURNING *
    `, [run_id, entity_type, entity_id, entity_name || null, verdict, category, issue_code, message || null, JSON.stringify(details || {}), fix_available || false, fix_position ? JSON.stringify(fix_position) : null]);
    return r.rows[0] || null;
  },

  bulkInsert: async (rows) => {
    if (!rows.length) return [];
    const values = rows.map((r, i) => {
      const base = i * 11;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`;
    }).join(',');
    const params = rows.flatMap(r => [
      r.run_id, r.entity_type, r.entity_id, r.entity_name || null, r.verdict, r.category,
      r.issue_code, r.message || null, JSON.stringify(r.details || {}), r.fix_available || false,
      r.fix_position ? JSON.stringify(r.fix_position) : null
    ]);
    const r = await db.query(
      `INSERT INTO attachment_audit_results
        (run_id, entity_type, entity_id, entity_name, verdict, category, issue_code, message, details, fix_available, fix_position)
       VALUES ${values}
       ON CONFLICT (run_id, entity_type, entity_id, issue_code)
       DO UPDATE SET verdict = EXCLUDED.verdict, message = EXCLUDED.message, details = EXCLUDED.details`,
      params
    );
    return r.rows;
  },

  listByRun: async (runId) => {
    const r = await db.query(
      'SELECT * FROM attachment_audit_results WHERE run_id = $1 ORDER BY verdict DESC, entity_type, entity_id',
      [runId]
    );
    return r.rows;
  },

  listByRunAndVerdict: async (runId, verdict) => {
    const r = await db.query(
      'SELECT * FROM attachment_audit_results WHERE run_id = $1 AND verdict = $2 ORDER BY entity_type, entity_id',
      [runId, verdict]
    );
    return r.rows;
  },

  deleteByRun: async (runId) => {
    await db.query('DELETE FROM attachment_audit_results WHERE run_id = $1', [runId]);
  },
};

const connectionTypes = {
  list: async () => {
    const r = await db.query('SELECT * FROM connection_type_catalog ORDER BY category, connection_type');
    return r.rows;
  },

  getByType: async (connectionType) => {
    const r = await db.query('SELECT * FROM connection_type_catalog WHERE connection_type = $1', [connectionType]);
    return r.rows[0] || null;
  },

  listByCategory: async (category) => {
    const r = await db.query('SELECT * FROM connection_type_catalog WHERE category = $1 ORDER BY connection_type', [category]);
    return r.rows;
  },
};

// ── DAG edge attachment helpers ──────────────────────────────────────────────

const edges = {
  getByParent: async (parentId) => {
    const r = await db.query('SELECT * FROM dag_edges WHERE parent_id = $1', [parentId]);
    return r.rows;
  },

  getByChild: async (childId) => {
    const r = await db.query('SELECT * FROM dag_edges WHERE child_id = $1', [childId]);
    return r.rows;
  },

  updateMetadata: async (parentId, childId, { connection_type, material_pair, attachment_offset_mm }) => {
    const fields = [];
    const vals = [parentId, childId];
    let p = 3;
    if (connection_type !== undefined) { fields.push(`connection_type = $${p++}`); vals.push(connection_type); }
    if (material_pair !== undefined) { fields.push(`material_pair = $${p++}`); vals.push(material_pair); }
    if (attachment_offset_mm !== undefined) { fields.push(`attachment_offset_mm = $${p++}`); vals.push(attachment_offset_mm); }
    if (!fields.length) return null;
    const r = await db.query(
      `UPDATE dag_edges SET ${fields.join(', ')} WHERE parent_id = $1 AND child_id = $2 RETURNING *`,
      vals
    );
    return r.rows[0] || null;
  },

  // Get all structural edges for a project (walls, columns, floors, stairs bound to levels)
  getProjectStructuralEdges: async (projectId) => {
    const r = await db.query(`
      SELECT de.*,
             e.type AS child_element_type, e.type_name AS child_name,
             e.parameters AS child_params, e.computed AS child_computed,
             l.name AS parent_level_name, l.elevation AS parent_level_elevation
      FROM dag_edges de
      JOIN elements e ON de.child_id = e.id
      LEFT JOIN levels l ON de.parent_id = l.id
      WHERE e.project_id = $1
        AND de.parent_type IN ('level', 'wall', 'column')
        AND de.child_type IN ('wall', 'column', 'family', 'floor', 'stair')
      ORDER BY l.elevation DESC NULLS LAST, de.child_id
    `, [projectId]);
    return r.rows;
  },

  // Check if an attachment has drifted beyond tolerance
  checkDrift: async (childId, hostPosition, toleranceMm = DRIFT_TOLERANCE_MM) => {
    // Get child element position from its parameters/computed
    const r = await db.query(`
      SELECT e.parameters, e.computed, e.type_name
      FROM elements e WHERE e.id = $1
    `, [childId]);
    if (!r.rows.length) return null;
    const { parameters, computed } = r.rows[0];
    const childX = parameters?.x ?? computed?.x ?? 0;
    const childZ = parameters?.z ?? computed?.z ?? 0;
    const drift = Math.sqrt(Math.pow(childX - (hostPosition?.x || 0), 2) + Math.pow(childZ - (hostPosition?.z || 0), 2));
    return {
      childId,
      drift_mm: Math.round(drift * 1000),
      tolerance_mm: toleranceMm,
      is_drifted: drift * 1000 > toleranceMm,
    };
  },
};

module.exports = {
  DRIFT_TOLERANCE_MM,
  FIX_SNAP_MM,
  MODULE_MM,
  runs,
  results,
  connectionTypes,
  edges,
};