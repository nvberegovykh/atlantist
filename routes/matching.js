/**
 * Owns: /api/matching/* — skill-based team matching algorithm.
 * Does NOT own: project creation, invite sending, collaboration management.
 */
const router = require('express').Router();
const { findMatches, getAllMatchingUsers, getUserMatchCount, scoreMatch } = require('../db/matching');
const { upsertPreferences, getPreferences } = require('../db/matching');
const { authMiddleware } = require('./auth');

// GET /api/matching/collaborators — Find potential collaborators
router.get('/collaborators', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { project_type, role, specialty, location, limit = 20 } = req.query;
    const matches = await findMatches(req.user.id, project_type, {
      role, specialty, location, limit: parseInt(limit, 10)
    });

    // Score each match
    const currentUser = await require('../db/users').getUserById(req.user.id);
    const scoredMatches = matches.map(user => ({
      ...user,
      match_score: scoreMatch(user, currentUser, project_type)
    }));

    // Sort by score descending
    scoredMatches.sort((a, b) => b.match_score - a.match_score);

    res.json(scoredMatches);
  } catch (err) {
    console.error('[matching] GET /collaborators', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matching/me — Get current user's matching profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const prefs = await getPreferences(req.user.id);
    if (!prefs) {
      return res.json({
        looking_for_work: true,
        available_hours_per_week: 20,
        preferred_project_types: [],
        preferred_roles: [],
        match_radius_miles: 50,
        skills: [],
        bio: ''
      });
    }
    res.json(prefs);
  } catch (err) {
    console.error('[matching] GET /me', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/matching/me — Update matching preferences
router.put('/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const prefs = await upsertPreferences(req.user.id, req.body);
    res.json(prefs);
  } catch (err) {
    console.error('[matching] PUT /me', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matching/auto-match — Auto-match for project creation
router.get('/auto-match', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { project_type } = req.query;
    if (!project_type) {
      return res.status(400).json({ error: 'project_type required' });
    }

    // Find complementary roles
    const currentUser = await require('../db/users').getUserById(req.user.id);
    const matches = await findMatches(req.user.id, project_type, { limit: 10 });

    const scoredMatches = matches.map(user => {
      // Calculate complementary score
      let complementaryScore = 0;

      // Different role = +30 points
      if (user.role !== currentUser.role) {
        complementaryScore += 30;
      }

      // Compatible project type = +40 points
      if (user.project_type === project_type) {
        complementaryScore += 40;
      }

      // Skills that complement current user
      const mySkills = new Set(currentUser.specializations || []);
      const theirSkills = user.specializations || [];
      const complementarySkills = theirSkills.filter(s => !mySkills.has(s));
      complementaryScore += Math.min(complementarySkills.length * 10, 20);

      // Looking for work = +10 points
      if (user.looking_for_work) {
        complementaryScore += 10;
      }

      return {
        ...user,
        complementary_score: complementaryScore,
        project_type_match: user.project_type === project_type,
        role_complement: user.role !== currentUser.role
      };
    });

    // Sort by complementary score
    scoredMatches.sort((a, b) => b.complementary_score - a.complementary_score);

    res.json(scoredMatches.slice(0, 5)); // Top 5 matches
  } catch (err) {
    console.error('[matching] GET /auto-match', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matching/stats — Get matching statistics
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const allUsers = await getAllMatchingUsers(1000, 0);
    const currentUserMatchCount = await getUserMatchCount(req.user.id);

    // Calculate stats
    const totalSeekers = allUsers.filter(u => u.looking_for_work).length;
    const byRole = {};
    const byProjectType = {};
    const bySpecialization = {};

    allUsers.forEach(u => {
      byRole[u.role] = (byRole[u.role] || 0) + 1;
      byProjectType[u.project_type] = (byProjectType[u.project_type] || 0) + 1;
      (u.specializations || []).forEach(s => {
        bySpecialization[s] = (bySpecialization[s] || 0) + 1;
      });
    });

    res.json({
      total_matching_users: allUsers.length,
      total_seekers: totalSeekers,
      my_project_count: currentUserMatchCount,
      by_role: byRole,
      by_project_type: byProjectType,
      top_specializations: Object.entries(bySpecialization)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([skill, count]) => ({ skill, count }))
    });
  } catch (err) {
    console.error('[matching] GET /stats', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;