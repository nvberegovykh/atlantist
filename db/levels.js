/**
 * Owns: all DB queries for the levels table.
 * Does NOT own: DAG recalculation, HTTP routing, element queries.
 */
const pool = require('./index');

// Returns levels scoped to a project. projectId=null/undefined → all levels (backward compat for energy/fire-protection/DXF routes)
async function getAllLevels(projectId) {
  if (projectId == null) {
    const res = await pool.query('SELECT * FROM levels ORDER BY elevation ASC');
    return res.rows;
  }
  const res = await pool.query(
    'SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC',
    [projectId]
  );
  return res.rows;
}

async function getLevelById(id) {
  const res = await pool.query('SELECT * FROM levels WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getAllLevelsByProject(projectId) {
  const res = await pool.query(
    'SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC',
    [projectId]
  );
  return res.rows;
}

async function createLevel(data) {
  const { name, elevation, is_building_storey = true, phase = 'New Construction', project_id = 1 } = data;
  const res = await pool.query(
    `INSERT INTO levels (name, elevation, is_building_storey, phase, project_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, elevation, is_building_storey, phase, project_id]
  );
  return res.rows[0];
}

async function updateLevel(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(data)) {
    if (['name', 'elevation', 'is_building_storey', 'phase'].includes(key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }
  if (fields.length === 0) return getLevelById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const res = await pool.query(
    `UPDATE levels SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteLevel(id) {
  await pool.query('DELETE FROM levels WHERE id = $1', [id]);
}

// Count walls/columns bound to a level (for display)
async function getLevelElementCounts(levelId) {
  const wallRes = await pool.query(
    `SELECT COUNT(*) FROM elements WHERE type = 'wall' AND (base_level_id = $1 OR top_level_id = $1)`,
    [levelId]
  );
  const colRes = await pool.query(
    `SELECT COUNT(*) FROM elements WHERE type = 'column' AND (base_level_id = $1 OR top_level_id = $1)`,
    [levelId]
  );
  return {
    walls: parseInt(wallRes.rows[0].count, 10),
    columns: parseInt(colRes.rows[0].count, 10)
  };
}

module.exports = { getAllLevels, getAllLevelsByProject, getLevelById, createLevel, updateLevel, deleteLevel, getLevelElementCounts };
