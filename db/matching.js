/**
 * Owns: all DB queries for matching_preferences table.
 * Does NOT own: matching algorithm logic, scoring calculations.
 */
const pool = require('./index');

// Get or create matching preferences for user
async function getPreferences(userId) {
  const res = await pool.query('SELECT * FROM matching_preferences WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

// Upsert matching preferences
async function upsertPreferences(userId, data) {
  const {
    looking_for_work = true,
    available_hours_per_week = 20,
    preferred_project_types = [],
    preferred_roles = [],
    match_radius_miles = 50,
    skills = [],
    bio = ''
  } = data;
  const res = await pool.query(
    `INSERT INTO matching_preferences (user_id, looking_for_work, available_hours_per_week, preferred_project_types, preferred_roles, match_radius_miles, skills, bio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id) DO UPDATE SET
       looking_for_work = EXCLUDED.looking_for_work,
       available_hours_per_week = EXCLUDED.available_hours_per_week,
       preferred_project_types = EXCLUDED.preferred_project_types,
       preferred_roles = EXCLUDED.preferred_roles,
       match_radius_miles = EXCLUDED.match_radius_miles,
       skills = EXCLUDED.skills,
       bio = EXCLUDED.bio,
       updated_at = NOW()
     RETURNING *`,
    [userId, looking_for_work, available_hours_per_week, JSON.stringify(preferred_project_types), JSON.stringify(preferred_roles), match_radius_miles, JSON.stringify(skills), bio]
  );
  return res.rows[0];
}

// Find matching users based on skills and project type
async function findMatches(currentUserId, projectType, filters = {}) {
  const { role, specialty, location, limit = 20 } = filters;

  // Base query: users with matching_preferences who are looking for work
  let query = `
    SELECT u.id, u.email, u.first_name, u.project_type, u.role, u.specializations, u.location,
           mp.looking_for_work, mp.available_hours_per_week, mp.preferred_project_types,
           mp.preferred_roles, mp.skills, mp.bio,
           mp.created_at as matched_at
    FROM app_users u
    JOIN matching_preferences mp ON u.id = mp.user_id
    WHERE mp.looking_for_work = true AND u.id != $1
  `;
  const params = [currentUserId];
  let idx = 2;

  // Filter by project type
  if (projectType) {
    query += ` AND (u.project_type = $${idx} OR $${idx} = ANY(mp.preferred_project_types))`;
    params.push(projectType);
    idx++;
  }

  // Filter by role
  if (role) {
    query += ` AND u.role = $${idx}`;
    params.push(role);
    idx++;
  }

  // Filter by specialty (specializations JSONB contains)
  if (specialty) {
    query += ` AND $${idx} = ANY(u.specializations)`;
    params.push(specialty);
    idx++;
  }

  query += ` ORDER BY u.last_active DESC LIMIT $${idx}`;
  params.push(limit);

  const res = await pool.query(query, params);
  return res.rows;
}

// Get all users with matching preferences (for admin)
async function getAllMatchingUsers(limit = 100, offset = 0) {
  const res = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.project_type, u.role, u.specializations, u.location, u.last_active,
            mp.looking_for_work, mp.available_hours_per_week, mp.skills, mp.bio, mp.updated_at
     FROM app_users u
     JOIN matching_preferences mp ON u.id = mp.user_id
     ORDER BY u.last_active DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

// Get user match count (how many projects they're on)
async function getUserMatchCount(userId) {
  const res = await pool.query(
    'SELECT COUNT(*) FROM project_members WHERE user_id = $1',
    [userId]
  );
  return parseInt(res.rows[0].count, 10);
}

// Score a potential match (simple scoring algorithm)
function scoreMatch(user, currentUser, projectType) {
  let score = 0;

  // Same project type: +40 points
  if (user.project_type === projectType) score += 40;
  else if (!projectType) score += 20; // partial credit for no preference

  // Complementary role: +30 points
  const roles = ['Architect', 'Engineer', 'MEP', 'PM'];
  if (user.role !== currentUser.role) score += 30;

  // Specialization match: +20 points per matching specialization
  const currentSpecializations = currentUser.specializations || [];
  const matchSpecializations = (user.specializations || []).filter(s =>
    currentSpecializations.includes(s)
  );
  score += Math.min(matchSpecializations.length * 10, 20);

  // Looking for work: +10 points
  if (user.looking_for_work) score += 10;

  return score;
}

module.exports = {
  getPreferences,
  upsertPreferences,
  findMatches,
  getAllMatchingUsers,
  getUserMatchCount,
  scoreMatch
};