/**
 * Owns: /api/catalog/* — all parametric element type catalogs.
 * Does NOT own: element instances, level data, DAG solver.
 */
const router = require('express').Router();
const { getWallTypes, getColumnTypes, getRoofTypes } = require('../db/elements');
const { getDoorTypes, getWindowTypes } = require('../db/families');
const { getStairTypes, getRailingTypes, getBeamTypes, getFloorTypes, getCeilingTypes } = require('../db/templates');

router.get('/wall-types', async (req, res) => {
  try { res.json(await getWallTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/column-types', async (req, res) => {
  try { res.json(await getColumnTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/roof-types', async (req, res) => {
  try {
    const rows = await getRoofTypes();
    res.json({ roofTypes: rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.roof_style,
      slope_min: r.slope_min,
      slope_max: r.slope_max,
      description: r.description,
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/door-types', async (req, res) => {
  try { res.json(await getDoorTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/window-types', async (req, res) => {
  try { res.json(await getWindowTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stair-types', async (req, res) => {
  try { res.json(await getStairTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/railing-types', async (req, res) => {
  try { res.json(await getRailingTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/beam-types', async (req, res) => {
  try { res.json(await getBeamTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/floor-types', async (req, res) => {
  try { res.json(await getFloorTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/ceiling-types', async (req, res) => {
  try { res.json(await getCeilingTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;