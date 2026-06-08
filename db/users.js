/**
 * Owns: all DB queries for app_users table.
 * Does NOT own: session token generation, email sending, auth middleware.
 */
const pool = require('./index');

// Get user by session UUID (anonymous or registered)
async function getUserBySessionUuid(sessionUuid) {
  const res = await pool.query('SELECT * FROM app_users WHERE session_uuid = $1', [sessionUuid]);
  return res.rows[0] || null;
}

// Get user by email
async function getUserByEmail(email) {
  const res = await pool.query('SELECT * FROM app_users WHERE email = $1', [email]);
  return res.rows[0] || null;
}

// Get user by id
async function getUserById(id) {
  const res = await pool.query('SELECT * FROM app_users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Create or update user from session UUID (upsert)
async function upsertUser(data) {
  const { session_uuid, email, first_name, project_type, role, specializations, location } = data;
  const res = await pool.query(
    `INSERT INTO app_users (session_uuid, email, first_name, project_type, role, specializations, location, email_verified)
     VALUES ($1::VARCHAR(36), $2::VARCHAR(255), $3, $4, $5, $6::text[], $7, true)
     ON CONFLICT (session_uuid) DO UPDATE SET
       email = EXCLUDED.email,
       first_name = EXCLUDED.first_name,
       project_type = EXCLUDED.project_type,
       role = EXCLUDED.role,
       specializations = EXCLUDED.specializations,
       location = EXCLUDED.location,
       email_verified = true,
       updated_at = NOW(),
       last_active = NOW()
     RETURNING *`,
    [session_uuid, email, first_name, project_type, role || 'Architect', (specializations || []), location]
  );
  return res.rows[0];
}

// Create anonymous user with UUID
// WHY: use ::text (not ::VARCHAR(36)) for both positions so Postgres infers a single
// consistent type for $1 and avoids "inconsistent types deduced for parameter $1".
async function createAnonymousUser(sessionUuid) {
  const res = await pool.query(
    `INSERT INTO app_users (session_uuid, email, email_verified, first_name)
     VALUES ($1::text, ($1::text) || '@anon.atlantist', false, 'Anonymous')
     ON CONFLICT (session_uuid) DO UPDATE SET last_active = NOW()
     RETURNING *`,
    [sessionUuid]
  );
  return res.rows[0];
}

// Update user profile
async function updateUserProfile(id, data) {
  const { first_name, project_type, role, specializations, location, onboarding_complete, onboarding_checklist } = data;
  const fields = [];
  const values = [];
  let idx = 1;
  const allowed = ['first_name', 'project_type', 'role', 'specializations', 'location', 'onboarding_complete', 'onboarding_checklist'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      // specializations is TEXT[] in live DB; onboarding_checklist is JSONB
      if (key === 'specializations') {
        fields[fields.length - 1] = fields[fields.length - 1].replace(`= $${idx - 1}`, `= $${idx - 1}::text[]`);
        values.push(Array.isArray(data[key]) ? data[key] : []);
      } else if (key === 'onboarding_checklist') {
        fields[fields.length - 1] = fields[fields.length - 1].replace(`= $${idx - 1}`, `= $${idx - 1}::jsonb`);
        values.push(JSON.stringify(data[key]));
      } else {
        values.push(data[key]);
      }
    }
  }
  if (fields.length === 0) return getUserById(id);
  fields.push('updated_at = NOW()', 'last_active = NOW()');
  values.push(id);
  const res = await pool.query(
    `UPDATE app_users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// List all users (admin only)
async function listAllUsers(limit = 100, offset = 0) {
  const res = await pool.query(
    `SELECT id, email, first_name, project_type, role, specializations, location, onboarding_complete, last_active, created_at
     FROM app_users ORDER BY last_active DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

// Get user count
async function getUserCount() {
  const res = await pool.query('SELECT COUNT(*) FROM app_users');
  return parseInt(res.rows[0].count, 10);
}

// Update last active timestamp
async function touchLastActive(sessionUuid) {
  await pool.query('UPDATE app_users SET last_active = NOW() WHERE session_uuid = $1', [sessionUuid]);
}

// Set billing_state for access control (beta_free | active | cancelled | past_due)
async function setBillingState(userId, billingState) {
  const valid = ['beta_free', 'active', 'cancelled', 'past_due'];
  if (!valid.includes(billingState)) return null;
  const res = await pool.query(
    'UPDATE app_users SET billing_state = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [userId, billingState]
  );
  return res.rows[0] || null;
}

// Get billing state for a user
async function getBillingState(userId) {
  const res = await pool.query(
    'SELECT billing_state FROM app_users WHERE id = $1',
    [userId]
  );
  return res.rows[0]?.billing_state || 'beta_free';
}

module.exports = {
  getUserBySessionUuid,
  getUserByEmail,
  getUserById,
  upsertUser,
  createAnonymousUser,
  updateUserProfile,
  listAllUsers,
  getUserCount,
  touchLastActive,
  setBillingState,
  getBillingState
};