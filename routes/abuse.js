/**
 * Admin abuse detection routes.
 * Owns: abuse scan records, flagged models, admin queue at /admin/abuse.
 *       User-reported project queue at GET /reports, POST /reports/:id/decide.
 * Does NOT own: scan execution logic (jobs/deep-abuse-scan.js), model-report filing (routes/model-reports.js).
 */
const express = require('express');
const router = express.Router();
const { getUserRole } = require('../db/users');
const {
  requireAdminSession,
  getAbuseScans,
  getAbusePendingModels,
  getAbuseRecentActions,
  getFlaggedModel,
  suspendUser,
  resolveFlaggedModel,
  logAbuseAction,
  getScanRecord,
  getFlaggedModelsByScan,
  eraseModel,
  updateFlaggedModelResolved
} = require('../db/abuse');
const {
  listAbuseReports,
  getAbuseReportById,
  decideAbuseReport,
  setProjectLockStatus,
  getProjectOwnerId
} = require('../db/abuse-reports');
const { applyBanConsequences, issueFalseFlagCompensation } = require('../services/ban-engine');

async function requireAdmin(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const session = await requireAdminSession(token);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin required' });
    req.userId = session.user_id;
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const [scans, pending, recentActions] = await Promise.all([
      getAbuseScans(),
      getAbusePendingModels(),
      getAbuseRecentActions()
    ]);
    res.json({ scans, pending, recentActions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/scan/:id', requireAdmin, async (req, res) => {
  try {
    const scan = await getScanRecord(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    const flaggedModels = await getFlaggedModelsByScan(req.params.id);
    res.json({ scan, flaggedModels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scan/trigger', requireAdmin, async (req, res) => {
  try {
    const { type = 'deep' } = req.body;
    if (!['daily', 'deep'].includes(type)) {
      return res.status(400).json({ error: 'Invalid scan type' });
    }
    const { spawn } = require('child_process');
    const jobFile = type === 'deep' ? 'jobs/deep-abuse-scan.js' : 'jobs/abuse-scan.js';
    const child = spawn('node', [jobFile], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ success: true, message: `${type} scan triggered`, scan_id: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/resolve/:id', requireAdmin, async (req, res) => {
  try {
    const { resolution } = req.body;
    if (!['cleared', 'suspended', 'erased'].includes(resolution)) {
      return res.status(400).json({ error: 'Invalid resolution' });
    }
    const record = await getFlaggedModel(req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });

    if (resolution === 'suspended' && record.owner_user_id) {
      await suspendUser(record.owner_user_id);
    }

    if (resolution === 'erased') {
      await eraseModel(record.model_type, record.model_id);
    }

    await updateFlaggedModelResolved(req.params.id, resolution, req.userId);
    await logAbuseAction(record.id, req.userId, 'admin_resolved', JSON.stringify({ resolution }));

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User-report admin queue ───────────────────────────────────────────────

// GET /api/abuse/reports — paginated list of user-filed reports
router.get('/reports', requireAdmin, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const reports = await listAbuseReports({ status, limit: parseInt(limit), offset: parseInt(offset) });
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/abuse/reports/:id/decide — uphold or dismiss a user-filed report
router.post('/reports/:id/decide', requireAdmin, async (req, res) => {
  try {
    const { decision, notes } = req.body;
    if (!['uphold', 'dismiss'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be uphold or dismiss' });
    }

    const report = await getAbuseReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    await decideAbuseReport(req.params.id, req.userId, decision, notes);

    if (decision === 'uphold') {
      // Mark banned in projects table first (for quick status reads)
      await setProjectLockStatus(report.project_id, 'banned');

      // Full ban consequence engine: hard-delete model, put owner in grace, send emails
      applyBanConsequences(report.project_id, report.owner_user_id, {
        decided_by: req.userId,
        report_id: report.id,
        owner_email: report.owner_email,
        notes: notes || null
      }).catch(err => console.error('[abuse] applyBanConsequences failed:', err.message));

      await logAbuseAction(null, req.userId, 'report_upheld', JSON.stringify({
        report_id: report.id,
        project_id: report.project_id,
        notes: notes || null
      }));
    } else {
      // Dismiss: restore lock status to none
      await setProjectLockStatus(report.project_id, 'none');
      await logAbuseAction(null, req.userId, 'report_dismissed', JSON.stringify({
        report_id: report.id,
        project_id: report.project_id,
        notes: notes || null
      }));

      // Issue 50%-off × 3mo coupon + apology email to project owner
      if (report.owner_user_id) {
        issueFalseFlagCompensation(report.reporter_user_id, report.owner_user_id, {
          owner_email: report.owner_email,
          project_name: report.project_name
        }).catch(err => console.error('[abuse] issueFalseFlagCompensation failed:', err.message));
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[abuse] POST /reports/:id/decide', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;