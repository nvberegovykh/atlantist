/**
 * Owns: all schedule generation queries (door, window, room, finish, material).
 * Does NOT own: DAG recalculation, HTTP routing, Three.js rendering.
 */
const pool = require('./index');

// ── Room Schedule ─────────────────────────────────────────────────────────────
// Rooms are extracted from wall encloses + level bounding boxes.
// A "room" element stores metadata: number, name, level_id, area, volume, finishes.
async function getRoomSchedule() {
  const res = await pool.query(`
    SELECT
      l.name AS level_name,
      l.elevation AS level_elevation,
      r.number AS room_number,
      r.name AS room_name,
      r.area_sqm,
      r.volume_cum,
      r.floor_finish,
      r.ceiling_finish,
      r.department,
      r.parameters->>'baseHeight' AS base_height
    FROM rooms r
    JOIN levels l ON r.level_id = l.id
    ORDER BY l.elevation ASC, r.number ASC
  `);
  return res.rows;
}

// ── Finish Schedule ────────────────────────────────────────────────────────────
async function getFinishSchedule() {
  const res = await pool.query(`
    SELECT
      l.name AS level_name,
      r.number AS room_number,
      r.name AS room_name,
      r.floor_finish,
      r.wall_finish,
      r.ceiling_finish,
      r.base_finish
    FROM rooms r
    JOIN levels l ON r.level_id = l.id
    WHERE r.floor_finish IS NOT NULL OR r.wall_finish IS NOT NULL OR r.ceiling_finish IS NOT NULL
    ORDER BY l.elevation ASC, r.number ASC
  `);
  return res.rows;
}

// ── Material Takeoff ────────────────────────────────────────────────────────────
// Wall material takeoff from wall_layers + family instances count
async function getMaterialTakeoff() {
  // Wall layers: total area + volume by material
  const walls = await pool.query(`
    SELECT
      wl.material,
      wl.function,
      COUNT(DISTINCT wl.element_id) AS wall_count,
      SUM(wl.thickness * e.computed->>'length' / NULLIF((SELECT SUM(thickness) FROM wall_layers wl2 WHERE wl2.element_id = wl.element_id), 0)) AS total_area_sqm,
      SUM(wl.thickness * (e.computed->>'height')::numeric * (e.computed->>'length')::numeric) AS total_volume_cum
    FROM wall_layers wl
    JOIN elements e ON wl.element_id = e.id
    GROUP BY wl.material, wl.function
    ORDER BY wl.material ASC
  `);

  // Door families count by type
  const doors = await pool.query(`
    SELECT type_name AS material, COUNT(*) AS count
    FROM family_instances WHERE family_type = 'door'
    GROUP BY type_name
    ORDER BY type_name ASC
  `);

  // Window families count by type
  const windows = await pool.query(`
    SELECT type_name AS material, COUNT(*) AS count
    FROM family_instances WHERE family_type = 'window'
    GROUP BY type_name
    ORDER BY type_name ASC
  `);

  return {
    wall_materials: walls.rows,
    doors: doors.rows,
    windows: windows.rows,
  };
}

// ── Section Lines ─────────────────────────────────────────────────────────────
async function createSectionLine(data) {
  const { name, start_x, start_z, end_x, end_z, depth_y, camera_direction, project_id = 1 } = data;
  const res = await pool.query(
    `INSERT INTO section_lines (name, start_x, start_z, end_x, end_z, depth_y, camera_direction, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name, start_x, start_z, end_x, end_z, depth_y, camera_direction, project_id]
  );
  return res.rows[0];
}

async function getSectionLines(projectId) {
  const res = await pool.query(
    `SELECT * FROM section_lines WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId]
  );
  return res.rows;
}

async function deleteSectionLine(id) {
  await pool.query(`DELETE FROM section_lines WHERE id = $1`, [id]);
}

module.exports = {
  getRoomSchedule,
  getFinishSchedule,
  getMaterialTakeoff,
  createSectionLine,
  getSectionLines,
  deleteSectionLine,
};