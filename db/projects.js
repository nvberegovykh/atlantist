/**
 * Owns: all DB queries for projects, project_members tables.
 * Does NOT own: project geometry, BIM data, element bindings.
 */
const pool = require('./index');
const { toInt } = require('./index');

// Create a new project
async function createProject(data) {
  const { name, type, description, owner_id, settings, project_type } = data;
  const res = await pool.query(
    `INSERT INTO projects (name, type, description, settings, project_type, last_opened_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
    [name, type || 'Mixed-Use', description, JSON.stringify(settings || {}), project_type || type || 'Mixed-Use']
  );
  const project = res.rows[0];

  // Add owner as project member with 'owner' role
  if (owner_id) {
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [project.id, owner_id]
    );
  }
  return project;
}

// Get project by ID
async function getProjectById(id) {
  const res = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Get project by demo_slug (public, no auth required)
async function getProjectBySlug(slug) {
  const res = await pool.query('SELECT id, name, type, description, is_demo, demo_slug, settings, project_type, created_at FROM projects WHERE demo_slug = $1 AND is_demo = TRUE', [slug]);
  return res.rows[0] || null;
}

// Get project with member count
async function getProjectWithStats(id) {
  const projectRes = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (!projectRes.rows[0]) return null;
  const project = projectRes.rows[0];
  const memberCountRes = await pool.query(
    'SELECT COUNT(*) FROM project_members WHERE project_id = $1', [id]
  );
  project.member_count = parseInt(memberCountRes.rows[0].count, 10);
  return project;
}

// Update project
async function updateProject(id, data) {
  const allowed = ['name', 'type', 'description', 'settings', 'archived', 'project_type',
    'filing_status', 'inspector_notes', 'seismic_category', 'building_code', 'jurisdiction'];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const key of allowed) {
    if (data[key] !== undefined && key !== 'settings') {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    } else if (key === 'settings' && data[key] !== undefined) {
      fields.push(`settings = $${idx++}`);
      values.push(JSON.stringify(data[key]));
    }
  }
  if (fields.length === 0) return getProjectById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const res = await pool.query(
    `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// Delete project
async function deleteProject(id) {
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}

// List projects for a user
async function listProjectsForUser(userId) {
  const res = await pool.query(
    `SELECT p.*, pm.role as my_role,
            (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count
     FROM projects p
     JOIN project_members pm ON p.id = pm.project_id
     WHERE pm.user_id = $1
     ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC`,
    [userId]
  );
  return res.rows;
}

// Get project members with user details
async function getProjectMembers(projectId) {
  const res = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.project_type, u.role, u.specializations, u.location, pm.role as project_role, pm.joined_at
     FROM project_members pm
     JOIN app_users u ON pm.user_id = u.id
     WHERE pm.project_id = $1
     ORDER BY pm.joined_at ASC`,
    [projectId]
  );
  return res.rows;
}

// Add member to project
async function addProjectMember(projectId, userId, role = 'member') {
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = $3`,
    [projectId, userId, role]
  );
}

// Remove member from project
async function removeProjectMember(projectId, userId) {
  await pool.query(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
}

// Update member role
async function updateMemberRole(projectId, userId, newRole) {
  await pool.query(
    'UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2',
    [projectId, userId, newRole]
  );
}

// Check if user is member of project
async function isUserMember(projectId, userId) {
  const res = await pool.query(
    'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return res.rows.length > 0;
}

// Fast check: returns true if project has is_demo=TRUE (used to block writes to demo projects)
// project_id may arrive as a UUID string from routes; reject it rather than passing to SQL
async function isProjectDemo(projectId) {
  if (!projectId) return false;
  const intId = toInt(projectId);
  if (intId === null) return false; // UUID strings are never demo projects (demo slugs use varchar)
  const res = await pool.query('SELECT is_demo FROM projects WHERE id = $1', [intId]);
  return res.rows[0]?.is_demo === true;
}

// Get user's role in project
async function getUserRole(projectId, userId) {
  const res = await pool.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return res.rows[0]?.role || null;
}

module.exports = {
  createProject,
  getProjectById,
  getProjectBySlug,
  getProjectWithStats,
  updateProject,
  deleteProject,
  listProjectsForUser,
  getProjectMembers,
  addProjectMember,
  removeProjectMember,
  updateMemberRole,
  isUserMember,
  getUserRole,
  isProjectDemo
};