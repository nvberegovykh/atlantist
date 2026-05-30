/**
 * Owns: DB queries for template projects — the pre-built project scaffolds
 * that users can instantiate for common building typologies.
 * Does NOT own: element CRUD, user projects, project settings.
 */
const pool = require('./index');

// List all published template projects
async function getTemplateProjects() {
  const res = await pool.query(`
    SELECT id, name, description, type, thumbnail_url,
           settings->>'level_count'  AS level_count,
           settings->>'typical_floor_height' AS floor_height,
           settings->>'construction_type' AS construction_type
    FROM projects
    WHERE is_template = true AND archived = false
    ORDER BY name ASC
  `);
  return res.rows;
}

// Get full template data (levels, elements, families, grids, rooms, ceilings, floors, stairs, curved)
async function getTemplateData(projectId) {
  const [proj, levels, elements, families, grids, rooms, ceilings, floors, stairs, curved] = await Promise.all([
    pool.query('SELECT * FROM projects WHERE id = $1', [projectId]).then(r => r.rows[0]),
    pool.query('SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC', [projectId]),
    pool.query('SELECT * FROM elements WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM family_instances WHERE host_wall_id IN (SELECT id FROM elements WHERE project_id = $1)', [projectId]),
    pool.query('SELECT * FROM structural_grids WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM rooms WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM ceilings WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM floors WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM stairs WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM curved_surfaces WHERE project_id = $1', [projectId]),
  ]);
  return {
    project: proj, levels: levels.rows, elements: elements.rows,
    families: families.rows, grids: grids.rows, rooms: rooms.rows,
    ceilings: ceilings.rows, floors: floors.rows, stairs: stairs.rows,
    curved_surfaces: curved.rows,
  };
}

// Instantiate a template: creates a new project from template data
async function instantiateTemplate(templateId, newName, ownerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get template data
    const t = await client.query('SELECT * FROM projects WHERE id = $1 AND is_template = true', [templateId]);
    if (!t.rows.length) throw new Error('Template not found');
    const src = t.rows[0];

    // Create new project
    const proj = await client.query(`
      INSERT INTO projects (name, type, description, owner_id, settings, is_template, archived)
      VALUES ($1, $2, $3, $4, $5, false, false)
      RETURNING *
    `, [newName, src.type, src.description || '', ownerId, src.settings || '{}']);

    const newId = proj.rows[0].id;

    // Clone levels
    const srcLevels = await client.query('SELECT * FROM levels WHERE project_id = $1', [templateId]);
    const levelIdMap = {};
    for (const lvl of srcLevels.rows) {
      const lvlRes = await client.query(`
        INSERT INTO levels (name, elevation, is_building_storey, phase, project_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [lvl.name, lvl.elevation, lvl.is_building_storey, lvl.phase, newId]);
      levelIdMap[lvl.id] = lvlRes.rows[0].id;
    }

    // Clone elements (walls, columns, floors, ceilings, roofs, stairs)
    const srcElements = await client.query('SELECT * FROM elements WHERE project_id = $1', [templateId]);
    const elementIdMap = {};
    for (const el of srcElements.rows) {
      const base = levelIdMap[el.base_level_id] || null;
      const top  = levelIdMap[el.top_level_id]  || null;
      const elRes = await client.query(`
        INSERT INTO elements (type, type_name, parameters, base_level_id, top_level_id, computed, project_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
      `, [el.type, el.type_name, el.parameters, base, top, el.computed, newId]);
      elementIdMap[el.id] = elRes.rows[0].id;
    }

    // Clone wall layers
    for (const el of srcElements.rows.filter(e => e.type === 'wall')) {
      const newElId = elementIdMap[el.id];
      const layers = await client.query('SELECT * FROM wall_layers WHERE element_id = $1 ORDER BY layer_order', [el.id]);
      for (const layer of layers.rows) {
        await client.query(`
          INSERT INTO wall_layers (element_id, layer_order, material, thickness, function, thickness_before_drawing)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [newElId, layer.layer_order, layer.material, layer.thickness, layer.function, layer.thickness_before_drawing]);
      }
    }

    // Clone floor layers
    for (const el of srcElements.rows.filter(e => e.type === 'floor')) {
      const newElId = elementIdMap[el.id];
      const layers = await client.query('SELECT * FROM floor_layers WHERE element_id = $1 ORDER BY layer_order', [el.id]);
      for (const layer of layers.rows) {
        await client.query(`
          INSERT INTO floor_layers (element_id, layer_order, material, thickness, function)
          VALUES ($1, $2, $3, $4, $5)
        `, [newElId, layer.layer_order, layer.material, layer.thickness, layer.function]);
      }
    }

    // Clone ceiling layers (multi-layer ceiling construction)
    const srcCeilings = await client.query('SELECT * FROM ceilings WHERE project_id = $1', [templateId]);
    for (const ceil of srcCeilings.rows) {
      const newLevelId = levelIdMap[ceil.host_level_id] || null;
      const cRes = await client.query(`
        INSERT INTO ceilings (project_id, host_level_id, room_id, elevation_offset, ceiling_type, parameters)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [newId, newLevelId, null, ceil.elevation_offset, ceil.ceiling_type, ceil.parameters]);
      const newCeilId = cRes.rows[0].id;
      const layers = await client.query('SELECT * FROM ceiling_layers WHERE element_id = $1 ORDER BY layer_order', [ceil.id]);
      for (const layer of layers.rows) {
        await client.query(`
          INSERT INTO ceiling_layers (element_id, layer_order, material, thickness, function)
          VALUES ($1, $2, $3, $4, $5)
        `, [newCeilId, layer.layer_order, layer.material, layer.thickness, layer.function]);
      }
    }

    // Clone floor slabs + floor layers (horizontal elements from floors table)
    const srcFloors = await client.query('SELECT * FROM floors WHERE project_id = $1', [templateId]);
    for (const floor of srcFloors.rows) {
      const newBaseId = floor.base_level_id ? (levelIdMap[floor.base_level_id] || null) : null;
      const newTopId  = floor.top_level_id  ? (levelIdMap[floor.top_level_id]  || null) : null;
      const fRes = await client.query(`
        INSERT INTO floors (project_id, base_level_id, top_level_id, area_sqm, thickness,
          position_x, position_y, elevation, parameters)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [newId, newBaseId, newTopId, floor.area_sqm, floor.thickness,
          floor.position_x, floor.position_y, floor.elevation, floor.parameters]);
      const newFloorId = fRes.rows[0].id;
      const fLayers = await client.query('SELECT * FROM floor_layers WHERE element_id = $1 ORDER BY layer_order', [floor.id]);
      for (const layer of fLayers.rows) {
        await client.query(`
          INSERT INTO floor_layers (element_id, layer_order, material, thickness, function)
          VALUES ($1, $2, $3, $4, $5)
        `, [newFloorId, layer.layer_order, layer.material, layer.thickness, layer.function]);
      }
    }

    // Clone curved surfaces (Phase 22 primitives)
    const srcCurved = await client.query('SELECT * FROM curved_surfaces WHERE project_id = $1', [templateId]);
    for (const cs of srcCurved.rows) {
      const newBaseId = cs.base_level_id ? (levelIdMap[cs.base_level_id] || null) : null;
      const newTopId = cs.top_level_id ? (levelIdMap[cs.top_level_id] || null) : null;
      await client.query(`
        INSERT INTO curved_surfaces (project_id, surface_type, parameters, control_points,
          axis_start, axis_end, profile_curve, path_curve, loft_cross_sections, computed,
          base_level_id, top_level_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [newId, cs.surface_type, cs.parameters, cs.control_points,
          cs.axis_start, cs.axis_end, cs.profile_curve, cs.path_curve,
          cs.loft_cross_sections, cs.computed, newBaseId, newTopId]);
    }

    // Clone family instances (doors/windows)
    const srcFams = await client.query(`
      SELECT fi.* FROM family_instances fi
      JOIN elements e ON fi.host_wall_id = e.id
      WHERE e.project_id = $1
    `, [templateId]);
    for (const fam of srcFams.rows) {
      const newHostId = elementIdMap[fam.host_wall_id];
      await client.query(`
        INSERT INTO family_instances (family_type, type_name, host_wall_id, host_face_u, mark, parameters, computed)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [fam.family_type, fam.type_name, newHostId, fam.host_face_u, fam.mark, fam.parameters, fam.computed]);
    }

    // Clone rooms
    const srcRooms = await client.query('SELECT * FROM rooms WHERE project_id = $1', [templateId]);
    for (const room of srcRooms.rows) {
      const newLevelId = levelIdMap[room.level_id];
      await client.query(`
        INSERT INTO rooms (number, name, level_id, area_sqm, volume_cum, floor_finish, wall_finish, ceiling_finish, department, project_id, parameters)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [room.number, room.name, newLevelId, room.area_sqm, room.volume_cum,
          room.floor_finish, room.wall_finish, room.ceiling_finish, room.department, newId, room.parameters]);
    }

    // Clone stairs (IBC-compliant stair elements from templates)
    const srcStairs = await client.query('SELECT * FROM stairs WHERE project_id = $1', [templateId]);
    const stairIdMap = {};
    for (const stair of srcStairs.rows) {
      const newBaseId = levelIdMap[stair.base_level_id] || null;
      const newTopId  = levelIdMap[stair.top_level_id]  || null;
      const sRes = await client.query(`
        INSERT INTO stairs (project_id, name, stair_type, base_level_id, top_level_id,
          width, number_of_risers, number_of_treads, tread_depth, landing_width, flight_count,
          position_x, position_y, rotation_degrees, material, total_rise, riser_height, going, slope_degrees)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING id, name, stair_type
      `, [newId, stair.name, stair.stair_type, newBaseId, newTopId,
          stair.width, stair.number_of_risers, stair.number_of_treads, stair.tread_depth,
          stair.landing_width, stair.flight_count,
          stair.position_x, stair.position_y, stair.rotation_degrees, stair.material,
          stair.total_rise, stair.riser_height, stair.going, stair.slope_degrees]);
      stairIdMap[stair.id] = sRes.rows[0].id;
    }

    // Clone railings (bound to newly cloned stairs)
    const srcRailings = await client.query('SELECT * FROM railings WHERE project_id = $1', [templateId]);
    for (const r of srcRailings.rows) {
      const newStairId = stairIdMap[r.host_stair_id] || null;
      if (newStairId) {
        await client.query(`
          INSERT INTO railings (project_id, name, host_stair_id, railing_type, height,
            top_rail_width, baluster_spacing, glass_thickness, side, material, glass_finish)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [newId, r.name, newStairId, r.railing_type, r.height,
            r.top_rail_width, r.baluster_spacing, r.glass_thickness, r.side, r.material, r.glass_finish]);
      }
    }

    // Clone structural grids and grid lines
    const srcGrids = await client.query('SELECT * FROM structural_grids WHERE project_id = $1', [templateId]);
    for (const g of srcGrids.rows) {
      const gRes = await client.query(`
        INSERT INTO structural_grids (name, system_type, origin_x, origin_z, spacing_x, spacing_z, bubble_visible, project_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
      `, [g.name, g.system_type, g.origin_x, g.origin_z, g.spacing_x, g.spacing_z, g.bubble_visible, newId]);
      const newGridId = gRes.rows[0].id;
      const lines = await client.query('SELECT * FROM structural_grid_lines WHERE grid_id = $1', [g.id]);
      for (const l of lines.rows) {
        await client.query(`
          INSERT INTO structural_grid_lines (grid_id, axis, label, coordinate, bubble_end_a, bubble_end_b)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [newGridId, l.axis, l.label, l.coordinate, l.bubble_end_a, l.bubble_end_b]);
      }
    }

    // Add owner as project member
    await client.query(`
      INSERT INTO project_members (user_id, project_id, role)
      VALUES ($1, $2, 'owner')
      ON CONFLICT DO NOTHING
    `, [ownerId, newId]);

    await client.query('COMMIT');
    return proj.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Element type catalog queries (supplements db/elements.js)
async function getStairTypes() {
  const res = await pool.query('SELECT * FROM stair_types ORDER BY name ASC');
  return res.rows;
}

async function getRailingTypes() {
  const res = await pool.query('SELECT * FROM railing_types ORDER BY name ASC');
  return res.rows;
}

async function getBeamTypes() {
  const res = await pool.query('SELECT * FROM beam_types ORDER BY name ASC');
  return res.rows;
}

async function getFloorTypes() {
  const res = await pool.query('SELECT * FROM floor_types ORDER BY name ASC');
  return res.rows;
}

async function getCeilingTypes() {
  const res = await pool.query('SELECT * FROM ceiling_types ORDER BY name ASC');
  return res.rows;
}

async function getMepFixtureTypes() {
  const res = await pool.query('SELECT * FROM mep_fixture_types ORDER BY discipline, name ASC');
  return res.rows;
}

module.exports = {
  getTemplateProjects, getTemplateData, instantiateTemplate,
  getStairTypes, getRailingTypes, getBeamTypes, getFloorTypes,
  getCeilingTypes, getMepFixtureTypes,
};