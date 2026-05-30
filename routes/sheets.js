// Owns: Drawing sheet CRUD, viewport CRUD, title block management, PDF export
// Does NOT own: design book metadata (via db/design-book.js), Three.js rendering
const router = require('express').Router();
const db = require('../db/sheets');
const sheetPdf = require('../services/sheet-pdf');

// ── Title Blocks ─────────────────────────────────────────────────────────

router.get('/title-blocks', async (req, res) => {
  try {
    const blocks = await db.getTitleBlocks();
    res.json(blocks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/title-blocks', async (req, res) => {
  try {
    const block = await db.createTitleBlock(req.body);
    res.status(201).json(block);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/title-blocks/:id', async (req, res) => {
  try {
    const block = await db.updateTitleBlock(parseInt(req.params.id), req.body);
    res.json(block);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drawing Sheets ───────────────────────────────────────────────────────

// GET /api/sheets?design_book_id=X  — list all sheets for a design book
router.get('/', async (req, res) => {
  try {
    const bookId = parseInt(req.query.design_book_id);
    if (!bookId) return res.status(400).json({ error: 'design_book_id required' });
    const sheets = await db.getSheetsByBook(bookId);
    res.json(sheets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sheets/init?design_book_id=X  — seed default DOB sheet set
router.post('/init', async (req, res) => {
  try {
    const bookId = parseInt(req.query.design_book_id);
    if (!bookId) return res.status(400).json({ error: 'design_book_id required' });
    const { project_name, address } = req.body;
    const sheets = await db.initDefaultSheets(bookId, project_name, address);
    res.status(201).json(sheets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sheets  — create / upsert a sheet
router.post('/', async (req, res) => {
  try {
    const bookId = parseInt(req.body.design_book_id);
    if (!bookId) return res.status(400).json({ error: 'design_book_id required' });
    const sheet = await db.upsertSheet(bookId, req.body);
    res.status(201).json(sheet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sheets/:id
router.get('/:id', async (req, res) => {
  try {
    const sheet = await db.getSheetById(parseInt(req.params.id));
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });
    res.json(sheet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/sheets/:id
router.patch('/:id', async (req, res) => {
  try {
    const sheet = await db.updateSheet(parseInt(req.params.id), req.body);
    res.json(sheet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sheets/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.deleteSheet(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sheet Viewports ──────────────────────────────────────────────────────

// GET /api/sheets/:sheetId/viewports
router.get('/:sheetId/viewports', async (req, res) => {
  try {
    const viewports = await db.getViewportsBySheet(parseInt(req.params.sheetId));
    res.json(viewports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sheets/:sheetId/viewports
router.post('/:sheetId/viewports', async (req, res) => {
  try {
    const vp = await db.createViewport(parseInt(req.params.sheetId), req.body);
    res.status(201).json(vp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/sheets/viewports/:id
router.patch('/viewports/:id', async (req, res) => {
  try {
    const vp = await db.updateViewport(parseInt(req.params.id), req.body);
    res.json(vp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sheets/viewports/:id
router.delete('/viewports/:id', async (req, res) => {
  try {
    await db.deleteViewport(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PDF Export ──────────────────────────────────────────────────────────

// POST /api/sheets/:id/export/pdf  — generate PDF for a single sheet
router.post('/:id/export/pdf', async (req, res) => {
  try {
    const sheet = await db.getSheetById(parseInt(req.params.id));
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });
    const viewports = await db.getViewportsBySheet(sheet.id);
    const pdfBytes = await sheetPdf.generateSheetPdf(sheet, viewports);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sheet.sheet_no}-${sheet.sheet_name.replace(/\//g, '-')}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('PDF export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sheets/export/set?design_book_id=X  — generate PDF for full set
router.post('/export/set', async (req, res) => {
  try {
    const bookId = parseInt(req.query.design_book_id);
    if (!bookId) return res.status(400).json({ error: 'design_book_id required' });
    const sheets = await db.getSheetsByBook(bookId);
    const included = sheets.filter(s => s.include_in_set).sort((a, b) => a.display_order - b.display_order);
    const pdfBytes = await sheetPdf.generateSheetSetPdf(included);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="drawing-set-${new Date().toISOString().slice(0,10)}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('PDF set export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sheets/align-floors?design_book_id=X  — Auto Align Floors
// Binds elevation-view drawing sheets to BIM levels using naming pattern matching.
// Sets base_elevation from level.elevation, elevation_offset = 0 (aligned).
// Returns: list of updated sheets with level bindings.
router.post('/align-floors', async (req, res) => {
  try {
    const bookId = parseInt(req.query.design_book_id);
    if (!bookId) return res.status(400).json({ error: 'design_book_id required' });
    const updated = await db.alignFloorSheets(bookId);
    res.json({ aligned: updated.length, sheets: updated });
  } catch (e) {
    console.error('[sheets] POST /align-floors', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sheets/by-level?design_book_id=X&level_id=Y  — sheets for a specific level
router.get('/by-level', async (req, res) => {
  try {
    const bookId = parseInt(req.query.design_book_id);
    const levelId = parseInt(req.query.level_id);
    if (!bookId || !levelId) return res.status(400).json({ error: 'design_book_id and level_id required' });
    const sheets = await db.getSheetsByLevel(bookId, levelId);
    res.json(sheets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;