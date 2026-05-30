/**
 * Owns: /api/users/* — user profile, skills, onboarding.
 * Does NOT own: auth, session management, billing.
 */
const router = require('express').Router();
const { getUserById, updateUserProfile, listAllUsers, getUserCount } = require('../db/users');
const { upsertPreferences, getPreferences } = require('../db/matching');

// Apply auth middleware (re-export from auth.js)
const { authMiddleware } = require('./auth');

// GET /api/users/me/profile — Get current user's profile
router.get('/me/profile', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      project_type: user.project_type,
      role: user.role,
      specializations: user.specializations,
      location: user.location,
      onboarding_complete: user.onboarding_complete,
      onboarding_checklist: user.onboarding_checklist,
      last_active: user.last_active,
      created_at: user.created_at
    });
  } catch (err) {
    console.error('[users] GET /me/profile', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/me/profile — Update current user's profile
router.patch('/me/profile', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const updated = await updateUserProfile(req.user.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      id: updated.id,
      email: updated.email,
      first_name: updated.first_name,
      project_type: updated.project_type,
      role: updated.role,
      specializations: updated.specializations,
      location: updated.location,
      onboarding_complete: updated.onboarding_complete,
      onboarding_checklist: updated.onboarding_checklist
    });
  } catch (err) {
    console.error('[users] PATCH /me/profile', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/me/preferences — Get matching preferences
router.get('/me/preferences', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    let prefs = await getPreferences(req.user.id);
    if (!prefs) {
      // Return default preferences
      prefs = {
        looking_for_work: true,
        available_hours_per_week: 20,
        preferred_project_types: [],
        preferred_roles: [],
        match_radius_miles: 50,
        skills: [],
        bio: ''
      };
    }
    res.json(prefs);
  } catch (err) {
    console.error('[users] GET /me/preferences', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/me/preferences — Update matching preferences
router.put('/me/preferences', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const prefs = await upsertPreferences(req.user.id, req.body);
    res.json(prefs);
  } catch (err) {
    console.error('[users] PUT /me/preferences', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/me/onboarding — Update onboarding checklist
router.patch('/me/onboarding', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { checklist, complete } = req.body;
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let newChecklist = checklist || user.onboarding_checklist || [];
    if (complete !== undefined && complete) {
      newChecklist = ['completed'];
    }

    const updated = await updateUserProfile(req.user.id, {
      onboarding_checklist: newChecklist,
      onboarding_complete: complete || false
    });
    res.json({ onboarding_complete: updated.onboarding_complete, onboarding_checklist: updated.onboarding_checklist });
  } catch (err) {
    console.error('[users] PATCH /me/onboarding', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id — Get user by ID (public profile for matching)
router.get('/:id', async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Return limited public profile
    res.json({
      id: user.id,
      first_name: user.first_name,
      project_type: user.project_type,
      role: user.role,
      specializations: user.specializations,
      location: user.location
    });
  } catch (err) {
    console.error('[users] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;