/**
 * Owns: /api/export/dxf endpoint.
 * Does NOT own: DXF generation logic, element DB queries, auth.
 */
const router = require('express').Router();
const { getAllElements } = require('../db/elements');
const { getAllLevels } = require('../db/levels');
const { getAllFamilyInstances } = require('../db/families');
const { generateDXF } = require('../services/dxf-export');

router.post('/dxf', async (req, res) => {
  try {
    const { viewMode = '2d', levelId = null } = req.body || {};

    const [walls, columns, levels, familyInstances] = await Promise.all([
      getAllElements(),
      getAllElements(),
      getAllLevels(),
      getAllFamilyInstances(),
    ]);

    const wallElements = walls.filter(e => e.type === 'wall');
    const colElements = columns.filter(e => e.type === 'column');

    let filteredWalls = wallElements;
    let filteredCols = colElements;
    let filteredFi = familyInstances;

    if (levelId) {
      const lvl = levels.find(l => String(l.id) === String(levelId));
      const elev = lvl ? parseFloat(lvl.elevation) : 0;
      const tol = 0.2;
      filteredWalls = wallElements.filter(e => {
        const baseElev = parseFloat(e.computed?.floor_elevation || e.base_level_elevation || 0);
        return Math.abs(baseElev - elev) < tol;
      });
      filteredCols = colElements.filter(e => {
        const baseElev = parseFloat(e.computed?.floor_elevation || e.base_level_elevation || 0);
        return Math.abs(baseElev - elev) < tol;
      });
      filteredFi = familyInstances.filter(fi => {
        const fiElev = parseFloat(fi.floor_elevation || 0);
        return Math.abs(fiElev - elev) < tol;
      });
    }

    const dxfContent = generateDXF(
      filteredWalls,
      filteredCols,
      filteredFi,
      levelId ? levels.filter(l => String(l.id) === String(levelId)) : levels,
      [],
      { viewMode, levelId }
    );

    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `atlantist_${viewMode}_${timestamp}.dxf`;

    res.set({
      'Content-Type': 'application/dxf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(dxfContent);
  } catch (err) {
    console.error('[dxf] POST /dxf', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;