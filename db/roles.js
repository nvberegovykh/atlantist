/**
 * Owns: all DB queries for app_roles table.
 * Does NOT own: role enforcement logic, auth middleware.
 */
const pool = require('./index');

// Get role for a user (returns 'user' as default if no role set)
async function getUserRole(userId) {
  const res = await pool.query(
    'SELECT role FROM app_roles WHERE user_id = $1',
    [userId]
  );
  return res.rows[0]?.role || 'user';
}

// Set or update role for a user
async function setUserRole(userId, role) {
  const res = await pool.query(
    `INSERT INTO app_roles (user_id, role)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, created_at = NOW()
     RETURNING *`,
    [userId, role]
  );
  return res.rows[0];
}

// Check if user is admin
async function isAdmin(userId) {
  const role = await getUserRole(userId);
  return role === 'admin';
}

// List all users with roles
async function listUsersWithRoles(limit = 100, offset = 0) {
  const res = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.role as user_type, r.role as app_role, u.last_active, u.created_at
     FROM app_users u
     LEFT JOIN app_roles r ON u.id = r.user_id
     ORDER BY u.last_active DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

async function getAllAdmins() {
  const res = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.created_at, u.last_active
     FROM app_users u
     JOIN app_roles r ON u.id = r.user_id
     WHERE r.role = 'admin'
     ORDER BY u.created_at ASC`
  );
  return res.rows;
}

module.exports = {
  getUserRole,
  setUserRole,
  isAdmin,
  listUsersWithRoles,
  getAllAdmins
};