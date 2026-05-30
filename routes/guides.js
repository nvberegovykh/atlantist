/**
 * Owns: /api/guides/* endpoints — guide categories, guides, progress, submissions.
 * Does NOT own: UI rendering, guide content display.
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const {
  getAllCategories, getCategoryBySlug,
  getGuidesByCategory, getGuideBySlug, getAllPublishedGuides, searchGuides,
  getFeaturedGuides, getUserProgress, upsertGuideProgress, markGuideComplete,
  getGuideStats, createGuideSubmission, getPendingSubmissions,
  approveSubmission, rejectSubmission, getSubmissionStats, updateGuide,
} = require('../db/guides');
const { getUserRole } = require('../db/roles');

// ─── Public ───────────────────────────────────────────────────────────────────

// GET /api/guides/categories
router.get('/categories', async (_req, res) => {
  try {
    const categories = await getAllCategories();
    res.json({ categories });
  } catch (err) {
    console.error('[guides] GET /categories', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guides/category/:slug — list guides in a category
router.get('/category/:slug', async (req, res) => {
  try {
    const category = await getCategoryBySlug(req.params.slug);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    const guides = await getGuidesByCategory(req.params.slug);
    res.json({ category, guides });
  } catch (err) {
    console.error('[guides] GET /category/:slug', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guides/featured
router.get('/featured', async (_req, res) => {
  try {
    const guides = await getFeaturedGuides(5);
    res.json({ guides });
  } catch (err) {
    console.error('[guides] GET /featured', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guides/search?q=query
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json({ guides: [] });
    const guides = await searchGuides(q);
    res.json({ guides });
  } catch (err) {
    console.error('[guides] GET /search', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guides/guide/:slug — single guide with full steps
router.get('/guide/:slug', async (req, res) => {
  try {
    const guide = await getGuideBySlug(req.params.slug);
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    res.json({ guide });
  } catch (err) {
    console.error('[guides] GET /guide/:slug', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guides/all — all published guides (for browse view)
router.get('/all', async (_req, res) => {
  try {
    const guides = await getAllPublishedGuides(100);
    res.json({ guides });
  } catch (err) {
    console.error('[guides] GET /all', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Authenticated: Progress ───────────────────────────────────────────────────

// GET /api/guides/progress — user progress for all guides
router.get('/progress', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.anonymous) {
      return res.json({ progress: [] }); // anonymous: no persistent progress
    }
    const progress = await getUserProgress(req.user.id);
    res.json({ progress });
  } catch (err) {
    console.error('[guides] GET /progress', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/guides/progress — upsert step progress
router.post('/progress', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.anonymous) {
      return res.status(403).json({ error: 'Sign up to track progress' });
    }
    const { guide_id, completed_steps, progress_pct } = req.body;
    if (!guide_id) return res.status(400).json({ error: 'guide_id required' });
    const completed = progress_pct >= 100;
    const progress = await upsertGuideProgress(req.user.id, guide_id, completed, completed_steps || [], progress_pct || 0);
    res.json({ success: true, progress });
  } catch (err) {
    console.error('[guides] POST /progress', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/guides/progress/complete — mark a guide as completed
router.post('/progress/complete', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.anonymous) {
      return res.status(403).json({ error: 'Sign up to track progress' });
    }
    const { guide_id } = req.body;
    if (!guide_id) return res.status(400).json({ error: 'guide_id required' });
    const progress = await markGuideComplete(req.user.id, guide_id);
    res.json({ success: true, progress });
  } catch (err) {
    console.error('[guides] POST /progress/complete', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Authenticated: Submissions ────────────────────────────────────────────────

// POST /api/guides/submit — submit a guide addition (requires Registered tier = email verified)
router.post('/submit', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.anonymous) return res.status(403).json({ error: 'Verify your email to submit guides' });

    const { category_slug, title, difficulty, time_estimate, steps, tags } = req.body;
    if (!category_slug || !title) {
      return res.status(400).json({ error: 'category_slug and title required' });
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'steps must be a non-empty array' });
    }

    const submission = await createGuideSubmission({
      category_slug, title, difficulty, time_estimate, steps, tags,
      submitted_by: req.user.id,
      author_name: req.user.first_name || null,
      author_email: req.user.email || null,
    });

    res.json({ success: true, submission });
  } catch (err) {
    console.error('[guides] POST /submit', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin ─────────────────────────────────────────────────────────────────────

function adminOnly(req, res, next) {
  if (!req.user || req.user.app_role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// GET /api/guides/admin/stats — guide stats + submission stats
router.get('/admin/stats', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const guideStats = await getGuideStats();
    const submissionStats = await getSubmissionStats();
    res.json({ guide_stats: guideStats, submission_stats: submissionStats });
  } catch (err) {
    console.error('[guides] GET /admin/stats', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guides/admin/submissions — pending submissions queue
router.get('/admin/submissions', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const submissions = await getPendingSubmissions();
    res.json({ submissions });
  } catch (err) {
    console.error('[guides] GET /admin/submissions', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/guides/admin/submission/:id/approve
router.patch('/admin/submission/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { notes } = req.body;
    const submission = await approveSubmission(parseInt(req.params.id), req.user.id, notes || null);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    res.json({ success: true, submission });
  } catch (err) {
    console.error('[guides] PATCH /admin/submission/approve', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/guides/admin/submission/:id/reject
router.patch('/admin/submission/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { notes } = req.body;
    const submission = await rejectSubmission(parseInt(req.params.id), req.user.id, notes || null);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    res.json({ success: true, submission });
  } catch (err) {
    console.error('[guides] PATCH /admin/submission/reject', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/guides/admin/guide/:id — edit guide inline
router.patch('/admin/guide/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const guide = await updateGuide(parseInt(req.params.id), req.body);
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    res.json({ success: true, guide });
  } catch (err) {
    console.error('[guides] PATCH /admin/guide/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/guides/admin/featured/:id — toggle featured
router.patch('/admin/featured/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { featured } = req.body;
    const guide = await updateGuide(parseInt(req.params.id), { featured });
    res.json({ success: true, guide });
  } catch (err) {
    console.error('[guides] PATCH /admin/featured/:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;