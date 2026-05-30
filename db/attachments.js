/**
 * Owns: attachment_constraints, attachment_overlays, connection_types,
 *       load_path_graph table access.
 * Does NOT own: attachment resolution logic (services/), constraint propagation (services/dag-solver.js).
 */
const db = require('./index');

// ─── Module Projects ──────────────────────────────────────────────────────────

const moduleProjects = {
  upsert: async (data) => {
    const { project_id, system_name, system_label, M_value, M_raw_input, is_locked, is_nyc, show_multiples } = data;
    const r = await db.query(`
      INSERT INTO module_projects (project_id, system_name, system_label, M_value, M_raw_input, is_locked, is_nyc, show_multiples)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (project_id) DO UPDATE SET
        system_name = EXCLUDED.system_name,
        system_label = EXCLUDED.system_label,
        M_value = EXCLUDED.M_value,
        M_raw_input = EXCLUDED.M_raw_input,
        is_locked = EXCLUDED.is_locked,
        is_nyc = EXCLUDED.is_nyc,
        show_multiples = EXCLUDED.show_multiples,
        updated_at = NOW()
      RETURNING *
    `, [project_id, system_name || 'si', system_label || 'SI (Meter)', M_value || 1000, M_raw_input || null, is_locked || false, is_nyc || false, show_multiples || false]);
    return r.rows[0] || null;
  },

  getByProject: async (projectId) => {
    const r = await db.query('SELECT * FROM module_projects WHERE project_id = $1', [projectId]);
    return r.rows[0] || null;
  },

  lock: async (projectId, lock = true) => {
    const r = await db.query('UPDATE module_projects SET is_locked = $2, updated_at = NOW() WHERE project_id = $1 RETURNING *', [projectId, lock]);
    return r.rows[0] || null;
  },

  toggleMultiples: async (projectId, showMultiples) => {
    const r = await db.query('UPDATE module_projects SET show_multiples = $2, updated_at = NOW() WHERE project_id = $1 RETURNING *', [projectId, showMultiples]);
    return r.rows[0] || null;
  },
};

// ─── Connection Types ─────────────────────────────────────────────────────────

const connectionTypes = {
  list: async () => {
    const r = await db.query('SELECT * FROM connection_types ORDER BY code');
    return r.rows;
  },

  getByCode: async (code) => {
    const r = await db.query('SELECT * FROM connection_types WHERE code = $1', [code]);
    return r.rows[0] || null;
  },

  getByCategory: async (category) => {
    const r = await db.query('SELECT * FROM connection_types WHERE category = $1 ORDER BY code', [category]);
    return r.rows;
  },
};

// ─── Attachment Constraints ───────────────────────────────────────────────────

const constraints = {
  create: async (data) => {
    const {
      host_element_id, attached_element_id, project_id, attachment_type,
      connection_type_code, connection_metadata, host_face_u, host_face_v, host_face_z,
      offset_x, offset_y, offset_z, computed_x, computed_y, computed_z, priority
    } = data;
    const r = await db.query(`
      INSERT INTO attachment_constraints
        (host_element_id, attached_element_id, project_id, attachment_type, connection_type_code,
         connection_metadata, host_face_u, host_face_v, host_face_z, offset_x, offset_y, offset_z,
         computed_x, computed_y, computed_z, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [host_element_id, attached_element_id, project_id, attachment_type, connection_type_code || null,
       JSON.stringify(connection_metadata || {}), host_face_u ?? 0.5, host_face_v ?? 0.5, host_face_z ?? 0,
       offset_x ?? 0, offset_y ?? 0, offset_z ?? 0, computed_x || null, computed_y || null, computed_z || null,
       priority ?? 50]);
    return r.rows[0] || null;
  },

  getById: async (id) => {
    const r = await db.query('SELECT * FROM attachment_constraints WHERE id = $1', [id]);
    return r.rows[0] || null;
  },

  getByHost: async (hostElementId) => {
    const r = await db.query(`
      SELECT ac.*, ct.name as connection_name, ct.category, ct.code_references
      FROM attachment_constraints ac
      LEFT JOIN connection_types ct ON ct.code = ac.connection_type_code
      WHERE ac.host_element_id = $1
      ORDER BY ac.priority DESC, ac.created_at
    `, [hostElementId]);
    return r.rows;
  },

  getByAttached: async (attachedElementId) => {
    const r = await db.query(`
      SELECT ac.*, ct.name as connection_name, ct.category
      FROM attachment_constraints ac
      LEFT JOIN connection_types ct ON ct.code = ac.connection_type_code
      WHERE ac.attached_element_id = $1
    `, [attachedElementId]);
    return r.rows;
  },

  listByProject: async (projectId) => {
    const r = await db.query(`
      SELECT ac.*, ct.name as connection_name, ct.category, ct.code_references
      FROM attachment_constraints ac
      LEFT JOIN connection_types ct ON ct.code = ac.connection_type_code
      WHERE ac.project_id = $1
      ORDER BY ac.created_at DESC
    `, [projectId]);
    return r.rows;
  },

  updatePosition: async (id, { computed_x, computed_y, computed_z }) => {
    const r = await db.query(`
      UPDATE attachment_constraints
      SET computed_x = COALESCE($2, computed_x),
          computed_y = COALESCE($3, computed_y),
          computed_z = COALESCE($4, computed_z),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, computed_x, computed_y, computed_z]);
    return r.rows[0] || null;
  },

  delete: async (id) => {
    const r = await db.query('DELETE FROM attachment_constraints WHERE id = $1 RETURNING id', [id]);
    return r.rows[0] || null;
  },

  deleteByElement: async (elementId) => {
    await db.query('DELETE FROM attachment_constraints WHERE host_element_id = $1 OR attached_element_id = $1', [elementId]);
  },

  getDownstream: async (hostElementId) => {
    // Recursive downstream attachments (elements that depend on this host)
    const r = await db.query(`
      WITH RECURSIVE downstream AS (
        SELECT ac.attached_element_id, ac.id, 1 as depth
        FROM attachment_constraints ac
        WHERE ac.host_element_id = $1
        UNION ALL
        SELECT ac.attached_element_id, ac.id, d.depth + 1
        FROM attachment_constraints ac
        JOIN downstream d ON d.attached_element_id = ac.host_element_id
        WHERE d.depth < 20
      )
      SELECT * FROM downstream
    `, [hostElementId]);
    return r.rows;
  },

  countByProject: async (projectId) => {
    const r = await db.query('SELECT COUNT(*) as count FROM attachment_constraints WHERE project_id = $1', [projectId]);
    return parseInt(r.rows[0].count);
  },
};

// ─── Attachment Overlays ───────────────────────────────────────────────────────

const overlays = {
  upsert: async (data) => {
    const { project_id, constraint_id, element_id, verdict, category, issue_code, message, code_reference, fix_suggestion, fix_position } = data;
    const r = await db.query(`
      INSERT INTO attachment_overlays (project_id, constraint_id, element_id, verdict, category, issue_code, message, code_reference, fix_suggestion, fix_position)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [project_id, constraint_id || null, element_id || null, verdict, category, issue_code || null, message, code_reference || null, fix_suggestion || null, JSON.stringify(fix_position || {})]);
    return r.rows[0] || null;
  },

  listByProject: async (projectId, verdictFilter) => {
    let query = 'SELECT * FROM attachment_overlays WHERE project_id = $1';
    const params = [projectId];
    if (verdictFilter) {
      query += ' AND verdict = $2';
      params.push(verdictFilter);
    }
    query += ' ORDER BY created_at DESC';
    const r = await db.query(query, params);
    return r.rows;
  },

  getUnresolved: async (projectId) => {
    const r = await db.query(`
      SELECT * FROM attachment_overlays
      WHERE project_id = $1 AND resolved_at IS NULL
      ORDER BY verdict DESC, created_at DESC
    `, [projectId]);
    return r.rows;
  },

  resolve: async (id) => {
    const r = await db.query('UPDATE attachment_overlays SET resolved_at = NOW() WHERE id = $1 RETURNING *', [id]);
    return r.rows[0] || null;
  },

  resolveByProject: async (projectId) => {
    const r = await db.query('UPDATE attachment_overlays SET resolved_at = NOW() WHERE project_id = $1 AND resolved_at IS NULL', [projectId]);
    return r.rowCount;
  },

  getStats: async (projectId) => {
    const r = await db.query(`
      SELECT verdict, COUNT(*) as count
      FROM attachment_overlays
      WHERE project_id = $1 AND resolved_at IS NULL
      GROUP BY verdict
    `, [projectId]);
    const stats = { RED: 0, AMBER: 0, GREEN: 0, PENDING: 0 };
    for (const row of r.rows) { stats[row.verdict] = parseInt(row.count); }
    return stats;
  },

  clearByConstraint: async (constraintId) => {
    await db.query('UPDATE attachment_overlays SET resolved_at = NOW() WHERE constraint_id = $1', [constraintId]);
  },
};

// ─── Load Path Graph ───────────────────────────────────────────────────────────

const loadPath = {
  upsertEdge: async (data) => {
    const { project_id, element_id, element_type, from_element_id, to_element_id, load_magnitude_kn, load_type, is_lateral, lateral_system_type, has_missing_support, clear_span_mm, level_name } = data;
    const r = await db.query(`
      INSERT INTO load_path_graph (project_id, element_id, element_type, from_element_id, to_element_id, load_magnitude_kn, load_type, is_lateral, lateral_system_type, has_missing_support, clear_span_mm, level_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (project_id, element_id) DO UPDATE SET
        element_type = EXCLUDED.element_type,
        from_element_id = EXCLUDED.from_element_id,
        to_element_id = EXCLUDED.to_element_id,
        load_magnitude_kn = EXCLUDED.load_magnitude_kn,
        load_type = EXCLUDED.load_type,
        is_lateral = EXCLUDED.is_lateral,
        lateral_system_type = EXCLUDED.lateral_system_type,
        has_missing_support = EXCLUDED.has_missing_support,
        clear_span_mm = EXCLUDED.clear_span_mm,
        level_name = EXCLUDED.level_name,
        updated_at = NOW()
      RETURNING *
    `, [project_id, element_id, element_type || null, from_element_id || null, to_element_id || null,
       load_magnitude_kn || null, load_type || null, is_lateral || false, lateral_system_type || null,
       has_missing_support || false, clear_span_mm || null, level_name || null]);
    return r.rows[0] || null;
  },

  listByProject: async (projectId) => {
    const r = await db.query(`
      SELECT * FROM load_path_graph WHERE project_id = $1 ORDER BY created_at
    `, [projectId]);
    return r.rows;
  },

  getMissingSupport: async (projectId) => {
    const r = await db.query(`
      SELECT * FROM load_path_graph WHERE project_id = $1 AND has_missing_support = true
    `, [projectId]);
    return r.rows;
  },

  getLateralElements: async (projectId) => {
    const r = await db.query(`
      SELECT * FROM load_path_graph WHERE project_id = $1 AND is_lateral = true
    `, [projectId]);
    return r.rows;
  },

  deleteByProject: async (projectId) => {
    await db.query('DELETE FROM load_path_graph WHERE project_id = $1', [projectId]);
  },

  getByElement: async (elementId) => {
    const r = await db.query('SELECT * FROM load_path_graph WHERE element_id = $1', [elementId]);
    return r.rows;
  },
};

// ─── Element helpers (avoid inline pool.query in routes/) ─────────────────────

const elements = {
  listByProject: async (projectId, elementIds) => {
    let q = 'SELECT * FROM elements WHERE project_id = $1';
    const params = [projectId];
    if (elementIds?.length) {
      q += ' AND id = ANY($2)';
      params.push(elementIds);
    }
    const r = await db.query(q, params);
    return r.rows;
  },

  listStructuralByProject: async (projectId) => {
    const r = await db.query(`
      SELECT e.id, e.type, e.type_name, e.parameters,
             l.id as base_level_id, l.name as level_name,
             (e.parameters->>'elevation')::numeric as elevation,
             (e.parameters->>'x')::numeric as position_x,
             (e.parameters->>'z')::numeric as position_z
      FROM elements e
      LEFT JOIN levels l ON l.id = e.base_level_id
      WHERE e.project_id = $1
    `, [projectId]);
    return r.rows;
  },

  getById: async (elementId) => {
    const r = await db.query('SELECT * FROM elements WHERE id = $1', [elementId]);
    return r.rows;
  },

  listByProjectForSpatial: async (projectId) => {
    const r = await db.query(`
      SELECT id, type, type_name, parameters
      FROM elements
      WHERE project_id = $1
    `, [projectId]);
    return r.rows;
  },
};

module.exports = {
  moduleProjects,
  connectionTypes,
  constraints,
  overlays,
  loadPath,
  elements,
};