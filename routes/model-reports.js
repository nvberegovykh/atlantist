/**
 * Owns: /api/models/:id/report — user-filed abuse reports on projects (BIM models).
 * Also: /api/models/:id/lock-status — lock state check for non-owners.
 * Does NOT own: admin review queue (routes/abuse.js), scan-based flagging (routes/abuse.js).
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const {
  createAbuseReport,
  countDistinctReporters,
  reporterAlreadyFiled,
  setProjectLockStatus,
  getProjectLockStatus,
  getProjectOwnerId,
  getMyReportForProject,
  getReportsForProject
} = require('../db/abuse-reports');
const { isUserMember } = require('../db/projects');

const VALID_REASONS = ['harmful_intent', 'illegal_substance_or_structure', 'weapon_design', 'other'];

// POST /api/models/:id/report — file an abuse report against a project
router.post('/:id/report', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    const project_id = parseInt(req.params.id, 10);
    const { reason, description } = req.body;

    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason. Must be one of: ' + VALID_REASONS.join(', ') });
    }
    if (!description || description.trim().length < 30) {
      return res.status(400).json({ error: 'Description must be at least 30 characters' });
    }

    // Prevent self-reporting
    const ownerId = await getProjectOwnerId(project_id);
    if (ownerId === req.user.id) {
      return res.status(400).json({ error: 'You cannot report your own project' });
    }

    // One report per user per project
    const alreadyFiled = await reporterAlreadyFiled(project_id, req.user.id);
    if (alreadyFiled) {
      return res.status(409).json({ error: 'You have already reported this project' });
    }

    const report = await createAbuseReport({
      project_id,
      reporter_user_id: req.user.id,
      reason,
      description: description.trim()
    });

    // Escalate lock_status based on distinct reporter count
    const distinctReporters = await countDistinctReporters(project_id);
    const currentLock = await getProjectLockStatus(project_id);

    if (distinctReporters >= 2 && currentLock !== 'under_review' && currentLock !== 'banned') {
      await setProjectLockStatus(project_id, 'under_review');
    } else if (distinctReporters === 1 && currentLock === 'none') {
      await setProjectLockStatus(project_id, 'reported');
    }

    res.status(201).json({ success: true, report_id: report.id });
  } catch (err) {
    console.error('[model-reports] POST /:id/report', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/:id/lock-status — check lock state and reporter banner
router.get('/:id/lock-status', authMiddleware, async (req, res) => {
  try {
    const project_id = parseInt(req.params.id, 10);
    const lock_status = await getProjectLockStatus(project_id);
    const ownerId = await getProjectOwnerId(project_id);
    const isOwner = req.user && req.user.id === ownerId;

    let myReport = null;
    if (req.user) {
      myReport = await getMyReportForProject(project_id, req.user.id);
    }

    res.json({ lock_status, is_owner: isOwner, my_report: myReport });
  } catch (err) {
    console.error('[model-reports] GET /:id/lock-status', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
