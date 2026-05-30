/**
 * Owns: all DB queries for stairs and stair_types catalog.
 * Does NOT own: DAG recalculation, HTTP routing, railing queries.
 */
const pool = require('./index');

async function getAllStairs(projectId) {
  if (!projectId) return [];
  const res = await pool.query(`
    SELECT s.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name,  tl.elevation AS top_level_elevation
    FROM stairs s
    LEFT JOIN levels bl ON bl.id = s.base_level_id
    LEFT JOIN levels tl ON tl.id = s.top_level_id
    WHERE s.project_id = $1
    ORDER BY s.created_at ASC
  `, [String(projectId)]);
  return res.rows;
}

async function getStairById(id) {
  if (!id) return null;
  const res = await pool.query(`
    SELECT s.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name,  tl.elevation AS top_level_elevation
    FROM stairs s
    LEFT JOIN levels bl ON bl.id = s.base_level_id
    LEFT JOIN levels tl ON tl.id = s.top_level_id
    WHERE s.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function getStairsByLevelId(levelId) {
  if (!levelId) return [];
  const res = await pool.query(
    `SELECT * FROM stairs WHERE base_level_id = $1 OR top_level_id = $1`,
    [String(levelId)]
  );
  return res.rows;
}

async function createStair(data) {
  const {
    project_id = 1,
    name = 'Main Stair',
    stair_type = 'straight',
    base_level_id = null,
    top_level_id = null,
    width = 1.0,
    number_of_risers = 16,
    number_of_treads = 15,
    tread_depth = 0.275,
    landing_width = 1.2,
    flight_count = 1,
    position_x = 0,
    position_y = 0,
    rotation_degrees = 0,
    material = 'Concrete',
    total_rise = 3.0,
    riser_height = 0.1875,
    going = 0,
    slope_degrees = 30,
  } = data;

  const res = await pool.query(
    `INSERT INTO stairs (project_id, name, stair_type, base_level_id, top_level_id,
     width, number_of_risers, number_of_treads, tread_depth, landing_width, flight_count,
     position_x, position_y, rotation_degrees, material, total_rise, riser_height, going, slope_degrees)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [project_id, name, stair_type, base_level_id, top_level_id,
     width, number_of_risers, number_of_treads, tread_depth, landing_width, flight_count,
     position_x, position_y, rotation_degrees, material, total_rise, riser_height, going, slope_degrees]
  );
  return res.rows[0];
}

async function updateStair(id, data) {
  if (!id) return null;
  const fields = [];
  const values = [];
  let idx = 1;

  const allowed = [
    'name','stair_type','configuration','base_level_id','top_level_id',
    'width','number_of_risers','number_of_treads','tread_depth','landing_width',
    'flight_count','total_rise','riser_height','going','slope_degrees',
    'position_x','position_y','rotation_degrees','material',
  ];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }

  if (fields.length === 0) return getStairById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);

  const res = await pool.query(
    `UPDATE stairs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteStair(id) {
  if (!id) return;
  await pool.query('DELETE FROM stairs WHERE id = $1', [id]);
}

async function computeStairGeometry(stairId) {
  if (!stairId) return null;

  const { getLevelById } = require('./levels');
  const stair = await getStairById(stairId);
  if (!stair || !stair.base_level_id || !stair.top_level_id) return null;

  const baseLevel = await getLevelById(stair.base_level_id);
  const topLevel  = await getLevelById(stair.top_level_id);
  if (!baseLevel || !topLevel) return null;

  const rise = parseFloat(topLevel.elevation) - parseFloat(baseLevel.elevation);
  const riserH = stair.number_of_risers > 0 ? rise / stair.number_of_risers : 0.175;
  const treadD = stair.number_of_treads > 0 ? rise / stair.number_of_treads : 0.275;
  const slope  = Math.atan2(rise, (stair.number_of_treads > 0 ? stair.number_of_treads : 10) * treadD) * 180 / Math.PI;

  return {
    total_rise: Math.round(rise * 1000) / 1000,
    riser_height: Math.round(riserH * 1000) / 1000,
    going: Math.round(treadD * 1000) / 1000,
    slope_degrees: Math.round(slope * 10) / 10,
  };
}

async function getStairTypes() {
  const res = await pool.query('SELECT * FROM stair_types ORDER BY name ASC');
  return res.rows;
}

module.exports = {
  getAllStairs, getStairById, getStairsByLevelId,
  createStair, updateStair, deleteStair, computeStairGeometry,
  getStairTypes,
};