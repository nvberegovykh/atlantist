/**
 * Owns: /api/schedules/* — all schedule types, CSV and PDF export.
 * Does NOT own: element/level data (read-only via elements/levels routes), family instance CRUD.
 */
const router = require('express').Router();
const { getDoorSchedule, getWindowSchedule } = require('../db/families');
const { getRoomSchedule, getFinishSchedule, getMaterialTakeoff, createSectionLine, getSectionLines, deleteSectionLine } = require('../db/schedules');
const { generateSchedulePdf } = require('../services/schedule-pdf');

// Helper: convert rows to CSV string
function toCSV(rows, columns) {
  if (!rows || rows.length === 0) return columns.join(',') + '\n';
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => {
    const v = r[c] !== undefined && r[c] !== null ? String(r[c]) : '';
    return v.includes(',') ? `"${v}"` : v;
  }).join(',')).join('\n');
  return header + '\n' + body;
}

// ── Schedule endpoints ───────────────────────────────────────────────────────

// GET /api/schedules/doors — A-400 door schedule
router.get('/doors', async (req, res) => {
  try { res.json(await getDoorSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/schedules/windows — A-400 window schedule
router.get('/windows', async (req, res) => {
  try { res.json(await getWindowSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/schedules/rooms — Room schedule
router.get('/rooms', async (req, res) => {
  try { res.json(await getRoomSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/schedules/finishes — Finish schedule
router.get('/finishes', async (req, res) => {
  try { res.json(await getFinishSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/schedules/materials — Material takeoff
router.get('/materials', async (req, res) => {
  try { res.json(await getMaterialTakeoff()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/schedules/all — All schedules in one call (for multi-tab UI)
router.get('/all', async (req, res) => {
  try {
    const [doors, windows, rooms, finishes, materials] = await Promise.all([
      getDoorSchedule(),
      getWindowSchedule(),
      getRoomSchedule().catch(() => []),
      getFinishSchedule().catch(() => []),
      getMaterialTakeoff().catch(() => ({ wall_materials: [], doors: [], windows: [] })),
    ]);
    res.json({ doors, windows, rooms, finishes, materials });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CSV Export ────────────────────────────────────────────────────────────────

// GET /api/schedules/export/:type — CSV export by type
router.get('/export/:type', async (req, res) => {
  const { type } = req.params;
  try {
    let rows, columns;
    switch (type) {
      case 'doors': {
        rows = await getDoorSchedule();
        columns = ['mark', 'type_name', 'width', 'height', 'material', 'fire_rating', 'door_type', 'hand', 'wall_host_type', 'level_name'];
        break;
      }
      case 'windows': {
        rows = await getWindowSchedule();
        columns = ['mark', 'type_name', 'width', 'height', 'sill_height', 'window_type', 'glazing', 'material', 'wall_host_type', 'level_name'];
        break;
      }
      case 'rooms': {
        rows = await getRoomSchedule();
        columns = ['level_name', 'room_number', 'room_name', 'area_sqm', 'volume_cum', 'floor_finish', 'ceiling_finish', 'department'];
        break;
      }
      case 'finishes': {
        rows = await getFinishSchedule();
        columns = ['level_name', 'room_number', 'room_name', 'floor_finish', 'wall_finish', 'ceiling_finish', 'base_finish'];
        break;
      }
      case 'materials': {
        const m = await getMaterialTakeoff();
        rows = [
          ...m.wall_materials.map(w => ({ category: 'wall', material: w.material, function: w.function, count: w.wall_count, area_sqm: w.total_area_sqm, volume_cum: w.total_volume_cum })),
          ...m.doors.map(d => ({ category: 'door', material: d.material, count: d.count })),
          ...m.windows.map(w => ({ category: 'window', material: w.material, count: w.count })),
        ];
        columns = ['category', 'material', 'function', 'count', 'area_sqm', 'volume_cum'];
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown schedule type: ' + type });
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist-${type}-schedule.csv"`);
    res.send(toCSV(rows, columns));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PDF Export ────────────────────────────────────────────────────────────────

// POST /api/schedules/export-pdf — PDF schedule by type
// Body: { type: 'doors'|'windows'|'rooms'|'finishes'|'materials', project_name: string }
router.post('/export-pdf', async (req, res) => {
  try {
    const { type, project_name = 'Atlantist Project' } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });

    let rows;
    switch (type) {
      case 'doors':
        rows = await getDoorSchedule();
        break;
      case 'windows':
        rows = await getWindowSchedule();
        break;
      case 'rooms':
        rows = await getRoomSchedule();
        break;
      case 'finishes':
        rows = await getFinishSchedule();
        break;
      case 'materials':
        rows = await getMaterialTakeoff();
        break;
      default:
        return res.status(400).json({ error: 'Unknown schedule type: ' + type });
    }

    const pdfBytes = await generateSchedulePdf(type, {
      rows,
      projectName: project_name,
      runDate: new Date().toISOString().slice(0, 10),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist-${type}-schedule.pdf"`);
    res.send(pdfBytes);
  } catch (e) {
    console.error('PDF export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Section Lines ─────────────────────────────────────────────────────────────

// GET /api/schedules/section-lines?project_id=X
router.get('/section-lines', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    res.json(await getSectionLines(projectId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/schedules/section-lines
router.post('/section-lines', async (req, res) => {
  try {
    const line = await createSectionLine(req.body);
    res.status(201).json(line);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/schedules/section-lines/:id
router.delete('/section-lines/:id', async (req, res) => {
  try {
    await deleteSectionLine(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;