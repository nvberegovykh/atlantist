/**
 * Owns: /api/rooms CRUD + auto-boundary from wall geometry.
 * Computes area/volume from enclosing walls per level.
 * Does NOT own: Three.js rendering, element queries.
 */
const router = require('express').Router();
const pool = require('../db/index');
const { appendEvent } = require('../db/events');
const { broadcastRoomCreated, broadcastRoomUpdated, broadcastRoomDeleted } = require('../services/ws-server');

// rooms.project_id is INTEGER; demo/fork passes UUID strings
function projectIdToInt(id) {
  if (id == null) return 1;
  const n = parseInt(id, 10);
  if (!isNaN(n)) return n;
  const stripped = String(id).replace(/-/g, '');
  return parseInt(stripped.slice(0, 8), 16);
}

// GET /api/rooms?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    // levels.project_id is VARCHAR; coerce integer to string for comparison
    const res2 = await pool.query(`
      SELECT r.*, l.name AS level_name, l.elevation AS level_elevation
      FROM rooms r
      LEFT JOIN levels l ON r.level_id = l.id
      WHERE (l.project_id = $1::integer OR l.project_id IS NULL)
      ORDER BY l.elevation ASC NULLS FIRST, r.number ASC
    `, [projectId]);
    res.json(res2.rows);
  } catch (err) {
    console.error('[rooms] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/:id
router.get('/:id', async (req, res) => {
  try {
    const res2 = await pool.query(`
      SELECT r.*, l.name AS level_name, l.elevation AS level_elevation
      FROM rooms r LEFT JOIN levels l ON r.level_id = l.id
      WHERE r.id = $1
    `, [req.params.id]);
    if (!res2.rows[0]) return res.status(404).json({ error: 'Room not found' });
    res.json(res2.rows[0]);
  } catch (err) {
    console.error('[rooms] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms — create room with auto-computed area from walls
router.post('/', async (req, res) => {
  try {
    const { number, name, level_id, department, floor_finish, wall_finish, ceiling_finish,
      base_finish, parameters, project_id } = req.body;

    // Compute area/volume from enclosing walls if level_id provided
    let area_sqm = null;
    let volume_cum = null;
    if (level_id) {
      const computed = await computeRoomFromWalls(level_id, project_id);
      area_sqm = computed.area;
      volume_cum = computed.volume;
    }

    const res2 = await pool.query(
      `INSERT INTO rooms (number, name, level_id, department, floor_finish, wall_finish, ceiling_finish,
        base_finish, area_sqm, volume_cum, parameters, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [number || '', name || 'Room', level_id || null, department, floor_finish, wall_finish,
        ceiling_finish, base_finish, area_sqm, volume_cum, JSON.stringify(parameters || {}), projectIdToInt(project_id)]
    );
    const room = res2.rows[0];
    await appendEvent({ entity_type: 'room', entity_id: room.id, event_type: 'create', before_data: null, after_data: room });
    broadcastRoomCreated(room);
    res.status(201).json(room);
  } catch (err) {
    console.error('[rooms] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rooms/:id — update room and recompute area/volume from walls
router.patch('/:id', async (req, res) => {
  try {
    const before = await pool.query(`SELECT * FROM rooms WHERE id = $1`, [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Room not found' });

    const { recompute, ...fields } = req.body;

    // Recompute area/volume from walls if requested
    if (recompute && before.rows[0].level_id) {
      // Derive project_id from the level the room is on
      const levelRes = await pool.query(`SELECT project_id FROM levels WHERE id = $1`, [before.rows[0].level_id]);
      const projectId = levelRes.rows[0]?.project_id ?? null;
      const computed = await computeRoomFromWalls(before.rows[0].level_id, projectId);
      fields.area_sqm = computed.area;
      fields.volume_cum = computed.volume;
    }

    const setClauses = [];
    const vals = [];
    let idx = 1;
    const allowed = ['number','name','level_id','department','floor_finish','wall_finish',
      'ceiling_finish','base_finish','area_sqm','volume_cum','parameters'];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        vals.push(key === 'parameters' ? JSON.stringify(fields[key]) : fields[key]);
      }
    }
    if (!setClauses.length) return res.json(before.rows[0]);
    setClauses.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const res2 = await pool.query(
      `UPDATE rooms SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals
    );
    const updated = res2.rows[0];
    await appendEvent({ entity_type: 'room', entity_id: updated.id, event_type: 'update', before_data: before.rows[0], after_data: updated });
    broadcastRoomUpdated(updated);
    res.json(updated);
  } catch (err) {
    console.error('[rooms] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rooms/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await pool.query(`SELECT * FROM rooms WHERE id = $1`, [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Room not found' });
    await pool.query(`DELETE FROM rooms WHERE id = $1`, [req.params.id]);
    await appendEvent({ entity_type: 'room', entity_id: req.params.id, event_type: 'delete', before_data: before.rows[0], after_data: null });
    broadcastRoomDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[rooms] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms/compute — compute area/volume from enclosing walls
// Body: { level_id, project_id }
router.post('/compute', async (req, res) => {
  try {
    const { level_id, project_id = 1 } = req.body;
    if (!level_id) return res.status(400).json({ error: 'level_id required' });
    const result = await computeRoomFromWalls(level_id, project_id);
    res.json(result);
  } catch (err) {
    console.error('[rooms] POST /compute', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Room boundary computation from enclosing wall geometry ──────────────────
// Uses wall endpoints and level height to compute:
// - Floor area: shoelace formula on wall footprint polygon
// - Volume: area × level height
async function computeRoomFromWalls(levelId, projectId) {
  // elements.project_id is VARCHAR; coerce integer projectId to string
  const wallsRes = await pool.query(`
    SELECT e.*,
      (e.parameters->>'start_x')::numeric as sx,
      (e.parameters->>'start_z')::numeric as sz,
      (e.parameters->>'end_x')::numeric as ex,
      (e.parameters->>'end_z')::numeric as ez
    FROM elements e
    WHERE e.type = 'wall'
      AND e.base_level_id = $1
      AND (e.project_id = $2::integer OR e.project_id IS NULL)
  `, [levelId, projectId]);

  if (!wallsRes.rows.length) return { area: 0, volume: 0, perimeter: 0 };

  // Get level height for volume
  const levelRes = await pool.query(`SELECT elevation, (parameters->>'height')::numeric as height FROM levels WHERE id = $1`, [levelId]);
  const levelHeight = parseFloat(levelRes.rows[0]?.height || 3);

  // Build a closed polygon from wall endpoints
  // Find the convex hull / outer boundary of wall endpoints
  const points = [];
  for (const w of wallsRes.rows) {
    if (w.sx !== null) points.push({ x: parseFloat(w.sx), z: parseFloat(w.sz) });
    if (w.ex !== null) points.push({ x: parseFloat(w.ex), z: parseFloat(w.ez) });
  }
  if (points.length < 3) return { area: 0, volume: 0, perimeter: 0 };

  // Sort points: find leftmost, then sort by polar angle
  const sorted = orderPointsByAngle(points);

  // Shoelace formula for polygon area
  const area = Math.abs(signedArea(sorted));
  const perimeter = polygonPerimeter(sorted);

  return {
    area: Math.round(area * 1000) / 1000,
    volume: Math.round(area * levelHeight * 1000) / 1000,
    perimeter: Math.round(perimeter * 1000) / 1000,
    wallCount: wallsRes.rows.length,
  };
}

// Graham scan for convex hull (works for simple buildings)
function orderPointsByAngle(points) {
  if (points.length < 3) return points;
  // Find centroid
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cz = points.reduce((s, p) => s + p.z, 0) / points.length;
  // Sort by angle from centroid
  return [...points].sort((a, b) => {
    const da = Math.atan2(a.z - cz, a.x - cx);
    const db = Math.atan2(b.z - cz, b.x - cx);
    return da - db;
  });
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
  }
  return a / 2;
}

function polygonPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x;
    const dz = pts[j].z - pts[i].z;
    p += Math.sqrt(dx * dx + dz * dz);
  }
  return p;
}

module.exports = router;