/**
 * Owns: /api/projects/* — project CRUD, team management, invites.
 * Does NOT own: BIM element data, energy simulations, rendering.
 */
const router = require('express').Router();
const pool = require('../db/index');
const { createProject, getProjectById, getProjectWithStats, updateProject, deleteProject, listProjectsForUser, getProjectMembers, addProjectMember, removeProjectMember, updateMemberRole, isUserMember, getUserRole } = require('../db/projects');
const { createInvite, getInviteByToken, acceptInvite, getProjectInvites } = require('../db/invites');
const { authMiddleware } = require('./auth');
const { canonicalUrl } = require('../lib/canonical-url');
const projectKeys = require('../lib/crypto/project-keys');

// All project routes require authentication
router.use(authMiddleware);

// GET /api/projects — List user's projects
router.get('/', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const projects = await listProjectsForUser(req.user.id);
    res.json(projects);
  } catch (err) {
    console.error('[projects] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects — Create new project
router.post('/', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const project = await createProject({
      name: req.body.name,
      type: req.body.type,
      description: req.body.description,
      owner_id: req.user.id,
      settings: req.body.settings
    });

    // Initialise E2E encryption key record for the new project.
    // Non-fatal: logs a warning if ATLANTIST_MASTER_KEY is not configured.
    try {
      await projectKeys.ensureProjectKey(project.id);
    } catch (keyErr) {
      console.warn('[projects] ensureProjectKey failed (non-fatal):', keyErr.message);
    }

    res.status(201).json(project);
  } catch (err) {
    console.error('[projects] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id — Get project details
router.get('/:id', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Check membership
    const isMember = await isUserMember(req.params.id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a project member' });
    }
    const project = await getProjectWithStats(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Include user's role in project
    const userRole = await getUserRole(req.params.id, req.user.id);
    res.json({ ...project, user_role: userRole });
  } catch (err) {
    console.error('[projects] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:id — Update project
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Check if user is owner or admin
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (!userRole || userRole === 'viewer') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const project = await updateProject(req.params.id, req.body);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (err) {
    console.error('[projects] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/dob-metadata — Get DOB filing metadata
// Returns: filing_status, inspector_notes, seismic_category, building_code, jurisdiction
// Auto-detects jurisdiction from project settings or defaults to NYC.
router.get('/:id/dob-metadata', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const isMember = await isUserMember(req.params.id, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a project member' });

    const project = await getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const settings = typeof project.settings === 'object' ? project.settings : {};
    // Auto-detect jurisdiction from settings
    const detectedJurisdiction = project.jurisdiction ||
      settings.jurisdiction ||
      detectJurisdiction(settings);
    const detectedSeismic = project.seismic_category ||
      settings.seismic_category ||
      inferSeismicCategory(settings);

    res.json({
      filing_status: project.filing_status || 'pre_filing',
      inspector_notes: project.inspector_notes || '',
      seismic_category: detectedSeismic,
      building_code: project.building_code || 'NYC BC 2020',
      jurisdiction: detectedJurisdiction,
      suggested_filing_status: suggestFilingStatus(settings),
      bin: settings.BIN || null,
      borough: settings.borough || null,
    });
  } catch (err) {
    console.error('[projects] GET /:id/dob-metadata', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:id/dob-metadata — Update DOB filing metadata
router.patch('/:id/dob-metadata', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (!userRole || userRole === 'viewer') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const allowed = ['filing_status', 'inspector_notes', 'seismic_category', 'building_code', 'jurisdiction'];
    const fields = [];
    const vals = [];
    let idx = 1;
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        fields.push(`${k} = $${idx++}`);
        vals.push(req.body[k]);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    await pool.query(
      `UPDATE projects SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      vals
    );
    const project = await getProjectById(req.params.id);
    res.json(project);
  } catch (err) {
    console.error('[projects] PATCH /:id/dob-metadata', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/dob-metadata — Update DOB metadata (alias for PATCH above)
// Deprecated: use PATCH above. Keeping POST for backward compat.

// POST /api/projects/:id/touch — Update last_opened_at (when user opens project)
router.post('/:id/touch', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const isMember = await isUserMember(req.params.id, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a project member' });
    await pool.query(
      'UPDATE projects SET last_opened_at = NOW(), updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[projects] POST /:id/touch', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:id — Delete project (owner only)
router.delete('/:id', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Check if user is owner
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Only owner can delete project' });
    }
    await deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[projects] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/members — Get project members
router.get('/:id/members', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const isMember = await isUserMember(req.params.id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a project member' });
    }
    const members = await getProjectMembers(req.params.id);
    res.json(members);
  } catch (err) {
    console.error('[projects] GET /:id/members', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/members/invite — Send invite to join project
router.post('/:id/members/invite', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Check if user is owner or admin
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (!userRole || userRole === 'viewer') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { email, role = 'member' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }

    const invite = await createInvite({
      email,
      project_id: req.params.id,
      invited_by_user_id: req.user.id,
      role
    });

    const inviteLink = canonicalUrl(`/invite/${invite.token}`);

    // Get project name for email
    const project = await getProjectById(req.params.id);
    const projectName = project?.name || 'Project';

    // Send invite email via Polsia proxy
    const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
    const FROM_ADDRESS = process.env.EMAIL_FROM || 'Atlantist <noreply@atlantist.cloud>';
    const REPLY_TO = 'Atlantist <support@atlantist.cloud>';
    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="font-size: 24px; font-weight: 700; color: #4a7dbd; letter-spacing: -0.5px;">⚡ Atlantist</div>
        </div>
        <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px; text-align: center;">You've been invited to join a project</h1>
        <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 32px;">
          <strong>${escapeHtml(req.user.first_name || 'Someone')}</strong> invited you to join <strong>${escapeHtml(projectName)}</strong> as a ${role}.
        </p>
        <div style="text-align: center; margin-bottom: 32px;">
          <a href="${inviteLink}" style="display: inline-block; background: #4a7dbd; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 6px;">
            Accept Invitation →
          </a>
        </div>
        <p style="font-size: 12px; color: #999; text-align: center;">
          This invite expires in 7 days.<br>
          <span style="word-break: break-all; color: #666;">${inviteLink}</span>
        </p>
      </div>
    `;

    if (EMAIL_PROXY_URL) {
      try {
        await fetch(EMAIL_PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: email,
            from: FROM_ADDRESS,
            reply_to: REPLY_TO,
            subject: `You've been invited to join ${projectName}`,
            html_body: htmlBody
          })
        });
        console.log(`[projects] Invite email sent to ${email}`);
      } catch (emailErr) {
        console.error(`[projects] Invite email error: ${emailErr.message}`);
      }
    } else {
      console.log(`[projects] Invite for ${email} to project ${projectName}: ${inviteLink}`);
    }

    res.status(201).json({
      invite_id: invite.id,
      invite_link: inviteLink,
      message: 'Invite sent'
    });
  } catch (err) {
    console.error('[projects] POST /:id/members/invite', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/members/accept-invite — Accept invite
router.post('/:id/members/accept-invite', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { token } = req.body;
    const invite = await acceptInvite(token, req.user.id);
    if (!invite) {
      return res.status(400).json({ error: 'Invalid or expired invite' });
    }

    // Add user to project
    await addProjectMember(req.params.id, req.user.id, invite.role);

    res.json({ success: true, message: 'Joined project successfully' });
  } catch (err) {
    console.error('[projects] POST /:id/members/accept-invite', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:id/members/:userId — Remove member (owner/admin only)
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Check if user is owner or admin
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (!userRole || userRole === 'viewer') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    // Cannot remove owner
    const targetRole = await getUserRole(req.params.id, req.params.userId);
    if (targetRole === 'owner') {
      return res.status(403).json({ error: 'Cannot remove project owner' });
    }
    await removeProjectMember(req.params.id, req.params.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[projects] DELETE /:id/members/:userId', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:id/members/:userId — Update member role (owner only)
router.patch('/:id/members/:userId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Only owner can change roles
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Only owner can change member roles' });
    }
    const { role } = req.body;
    if (!role) {
      return res.status(400).json({ error: 'role required' });
    }
    await updateMemberRole(req.params.id, req.params.userId, role);
    res.json({ ok: true });
  } catch (err) {
    console.error('[projects] PATCH /:id/members/:userId', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/invites — Get project invites
router.get('/:id/invites', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userRole = await getUserRole(req.params.id, req.user.id);
    if (!userRole || userRole === 'viewer') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const invites = await getProjectInvites(req.params.id);
    res.json(invites);
  } catch (err) {
    console.error('[projects] GET /:id/invites', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/viewport — Load saved viewport layout for cross-device continuity
router.get('/:id/viewport', async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const vpLayout = project.settings?.viewport_layout || null;
    res.json({ viewport_layout: vpLayout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/projects/:id/viewport — Save viewport layout for cross-device continuity
router.put('/:id/viewport', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { layout, panes } = req.body;
    if (!layout) return res.status(400).json({ error: 'layout required' });
    const project = await getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const settings = { ...(project.settings || {}), viewport_layout: { layout, panes } };
    await updateProject(req.params.id, { settings });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── DOB Metadata helpers ───────────────────────────────────────────────────────

// Detect jurisdiction from project settings (city, state, country hints)
function detectJurisdiction(settings) {
  const s = settings || {};
  if (s.city || s.location) {
    const loc = (s.city || s.location || '').toLowerCase();
    if (loc.includes('new york') || loc.includes('nyc') || loc.includes('manhattan')) return 'New York City';
    if (loc.includes('brooklyn')) return 'New York City (Brooklyn)';
    if (loc.includes('queens')) return 'New York City (Queens)';
    if (loc.includes('bronx')) return 'New York City (Bronx)';
    if (loc.includes('staten')) return 'New York City (Staten Island)';
  }
  if (s.state === 'NY' || s.state === 'New York') return 'New York State';
  if (s.country === 'US' || s.country === 'USA') return 'United States';
  return 'Unknown';
}

// Infer seismic design category from building height + occupancy type
function inferSeismicCategory(settings) {
  const s = settings || {};
  const heightM = s.building_height_m || s.height_m || 0;
  const occupancy = (s.occupancy_type || s.occupancy || 'II').toUpperCase();
  // ASCE 7-22 simplified: Seismic Design Category based on occupancy + height
  // Category B (low risk): most non-essential buildings < 9.1m in moderate seismic
  // Category D (high): essential + tall structures
  if (heightM > 20 && (occupancy === 'III' || occupancy === 'IV')) return 'D';
  if (heightM > 9.1) return 'C';
  return 'B';
}

// Suggest filing status based on project settings
function suggestFilingStatus(settings) {
  const s = settings || {};
  if (s.submitted || s.filed) return 'filed';
  if (s.under_review) return 'under_review';
  if (s.filing_in_progress) return 'in_progress';
  return 'pre_filing';
}

module.exports = router;