// Owns: Design Book CRUD — books, placeholders, product selections, PDF export
// Does NOT own: element/level data (read-only via elements/levels routes)
const router = require('express').Router();
const db = require('../db/design-book');
const pool = require('../db/index');
const productApi = require('../services/product-api');

// ── Auto-population ──────────────────────────────────────────────────────────────
// POST /api/design-book/auto-populate — generate sheet placeholders from model data
// The "no manual annotation required" pipeline: queries elements, levels, families,
// rooms, and stairs, then creates placeholder entries for each required sheet.

router.post('/auto-populate', async (req, res) => {
  try {
    const projectId = req.body.project_id ? parseInt(req.body.project_id) : null;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const result = await db.autoPopulateFromModel(projectId);
    res.json(result);
  } catch (err) {
    console.error('[design-book] POST /auto-populate', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/design-book/populate-crafting — populate from crafting_things + sourcing
// Generates procurement list from BIM components recognized by the Crafting Engine.
// Returns: sourcing log with suppliers, unit costs, lead times, total estimated cost.
router.post('/populate-crafting', async (req, res) => {
  try {
    const projectId = req.body.project_id ? parseInt(req.body.project_id) : null;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const result = await db.populateFromCraftingThings(projectId);
    res.json(result);
  } catch (err) {
    console.error('[design-book] POST /populate-crafting', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/design-book?project_id=X  — get or create book for project
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id ? parseInt(req.query.project_id) : null;
    const book = await db.getOrCreateBook(projectId);
    res.json(book);
  } catch (e) {
    console.error('design-book GET:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/design-book/:id  — update book metadata
router.patch('/:id', async (req, res) => {
  try {
    const book = await db.updateBook(parseInt(req.params.id), req.body);
    res.json(book);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Placeholders ─────────────────────────────────────────────────────────────

// GET /api/design-book/:bookId/placeholders
router.get('/:bookId/placeholders', async (req, res) => {
  try {
    const items = await db.getPlaceholders(parseInt(req.params.bookId));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/design-book/:bookId/placeholders
router.post('/:bookId/placeholders', async (req, res) => {
  try {
    const item = await db.createPlaceholder(parseInt(req.params.bookId), req.body);
    res.status(201).json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/design-book/placeholders/:id
router.patch('/placeholders/:id', async (req, res) => {
  try {
    const item = await db.updatePlaceholder(parseInt(req.params.id), req.body);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/design-book/placeholders/:id
router.delete('/placeholders/:id', async (req, res) => {
  try {
    await db.deletePlaceholder(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Product Selections ───────────────────────────────────────────────────────

// GET /api/design-book/:bookId/products
router.get('/:bookId/products', async (req, res) => {
  try {
    const items = await db.getProductSelections(parseInt(req.params.bookId));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/design-book/:bookId/products
router.post('/:bookId/products', async (req, res) => {
  try {
    const item = await db.createProductSelection(parseInt(req.params.bookId), req.body);
    res.status(201).json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/design-book/products/:id
router.patch('/products/:id', async (req, res) => {
  try {
    const item = await db.updateProductSelection(parseInt(req.params.id), req.body);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/design-book/products/:id
router.delete('/products/:id', async (req, res) => {
  try {
    await db.deleteProductSelection(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Product API / Browser ────────────────────────────────────────────────────

// GET /api/design-book/product-search?q=&source=pella|simpson|generic
router.get('/product-search', async (req, res) => {
  try {
    const { q = '', source = 'pella' } = req.query;
    const results = await productApi.search(source, q);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Export ───────────────────────────────────────────────────────────────────

// GET /api/design-book/:bookId/export/open-items — JSON of all open placeholders
router.get('/:bookId/export/open-items', async (req, res) => {
  try {
    const bookId = parseInt(req.params.bookId);
    const [book, placeholders, products] = await Promise.all([
      db.getBookById(bookId),
      db.getPlaceholders(bookId),
      db.getProductSelections(bookId),
    ]);
    const openItems = placeholders.filter(p => p.status === 'open' || p.status === 'pending_approval');
    res.json({
      book,
      open_items: openItems,
      products,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/design-book/:bookId/sourcing-log — procurement list from crafting system
// Returns: sourcing log with suppliers, unit costs, lead times, substitution notes, total cost.
router.get('/:bookId/sourcing-log', async (req, res) => {
  try {
    const bookId = parseInt(req.params.bookId);
    const book = await db.getBookById(bookId);
    if (!book) return res.status(404).json({ error: 'Design book not found' });
    const products = await db.getProductSelections(bookId);
    res.json({
      book_id: bookId,
      sourcing_log: book.sourcing_log || [],
      total_estimated_cost: book.total_estimated_cost || 0,
      procurement_status: book.procurement_status || 'draft',
      products,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/design-book/:bookId/sourcing-log — update procurement status
router.patch('/:bookId/sourcing-log', async (req, res) => {
  try {
    const bookId = parseInt(req.params.bookId);
    const { procurement_status, product_updates } = req.body;

    if (procurement_status !== undefined) {
      await pool.query(
        `UPDATE design_books SET procurement_status = $1, updated_at = NOW() WHERE id = $2`,
        [procurement_status, bookId]
      );
    }

    // Update individual product selections (substitution notes, order_status, etc.)
    if (Array.isArray(product_updates)) {
      for (const u of product_updates) {
        if (u.id) {
          const fields = [];
          const vals = [];
          let idx = 1;
          for (const k of ['substitution_notes', 'order_status', 'estimated_cost', 'lead_time_days', 'unit_cost']) {
            if (u[k] !== undefined) {
              fields.push(`${k} = $${idx++}`);
              vals.push(u[k]);
            }
          }
          if (fields.length) {
            fields.push('updated_at = NOW()');
            vals.push(u.id);
            await pool.query(
              `UPDATE design_book_product_selections SET ${fields.join(', ')} WHERE id = $${idx}`,
              vals
            );
          }
        }
      }
    }

    const book = await db.getBookById(bookId);
    const products = await db.getProductSelections(bookId);
    res.json({ ok: true, book, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
