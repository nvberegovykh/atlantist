/**
 * Owns: all DB queries for curved_surfaces (hyperboloid, paraboloid, ruled, NURBS,
 * revolution, sweep, loft, and conic arc primitives) and curve_data on elements.
 * Does NOT own: DAG recalculation, HTTP routing, WebSocket broadcast.
 */
const pool = require('./index');

async function getAllCurvedSurfaces(projectId) {
  if (!projectId) return [];
  const res = await pool.query(`
    SELECT cs.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name,  tl.elevation AS top_level_elevation
    FROM curved_surfaces cs
    LEFT JOIN levels bl ON bl.id = cs.base_level_id
    LEFT JOIN levels tl ON tl.id = cs.top_level_id
    WHERE cs.project_id = $1
    ORDER BY cs.created_at ASC
  `, [String(projectId)]);
  return res.rows;
}

async function getCurvedSurfaceById(id) {
  if (!id) return null;
  const res = await pool.query(`
    SELECT cs.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name,  tl.elevation AS top_level_elevation
    FROM curved_surfaces cs
    LEFT JOIN levels bl ON bl.id = cs.base_level_id
    LEFT JOIN levels tl ON tl.id = cs.top_level_id
    WHERE cs.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function createCurvedSurface(data) {
  const {
    project_id = 1, name = 'Curved Surface', surface_type,
    base_level_id = null, top_level_id = null,
    parameters = {}, control_points = [],
    axis_start = null, axis_end = null,
    profile_curve = null, path_curve = null, loft_cross_sections = null,
    computed = {}, material = 'concrete', thickness = 0.15, color = '#7a9cbf',
    ifc_global_id = null, ifc_entity_id = null, ifc_type = null,
  } = data;

  const res = await pool.query(`
    INSERT INTO curved_surfaces
      (project_id, name, surface_type, base_level_id, top_level_id,
       parameters, control_points, axis_start, axis_end,
       profile_curve, path_curve, loft_cross_sections, computed,
       material, thickness, color, ifc_global_id, ifc_entity_id, ifc_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *
  `, [
    project_id, name, surface_type, base_level_id, top_level_id,
    JSON.stringify(parameters), JSON.stringify(control_points),
    axis_start ? JSON.stringify(axis_start) : null,
    axis_end   ? JSON.stringify(axis_end)   : null,
    profile_curve    ? JSON.stringify(profile_curve)    : null,
    path_curve       ? JSON.stringify(path_curve)       : null,
    loft_cross_sections ? JSON.stringify(loft_cross_sections) : null,
    JSON.stringify(computed), material, thickness, color,
    ifc_global_id, ifc_entity_id, ifc_type,
  ]);
  return res.rows[0];
}

async function updateCurvedSurface(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;

  const jsonFields = ['parameters','control_points','axis_start','axis_end',
    'profile_curve','path_curve','loft_cross_sections','computed'];
  for (const key of jsonFields) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(JSON.stringify(data[key]));
    }
  }
  const scalarFields = ['name','surface_type','base_level_id','top_level_id',
    'material','thickness','color','ifc_global_id','ifc_entity_id','ifc_type'];
  for (const key of scalarFields) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }

  if (fields.length === 0) return getCurvedSurfaceById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);

  const res = await pool.query(
    `UPDATE curved_surfaces SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteCurvedSurface(id) {
  await pool.query(`DELETE FROM curved_surfaces WHERE id = $1`, [id]);
}

module.exports = {
  getAllCurvedSurfaces,
  getCurvedSurfaceById,
  createCurvedSurface,
  updateCurvedSurface,
  deleteCurvedSurface,
};