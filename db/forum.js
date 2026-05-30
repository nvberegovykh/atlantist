/**
 * Owns: forum_threads, forum_replies, forum_status_log CRUD.
 * Does NOT own: HTTP routing, WebSocket broadcast, auth.
 */
const pool = require('./index');

// ─── Threads ────────────────────────────────────────────────────────────────────

async function listThreads({ category, status, page = 1, limit = 20, search }) {
  const offset = (page - 1) * limit;
  let where = [];
  let params = [];
  let p = 1;

  if (category) { where.push(`ft.category = $${p++}`); params.push(category); }
  if (status)   { where.push(`ft.status = $${p++}`);   params.push(status); }
  if (search)   { where.push(`ft.search_vector @@ plainto_tsquery('english', $${p++})`); params.push(search); }

  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const res = await pool.query(`
    SELECT ft.*,
           u.email     AS author_email,
           u.first_name AS author_name,
           u.role       AS author_role,
           ft.pinned    AS pinned,
           ft.locked    AS locked,
           ft.is_team_post
    FROM   forum_threads ft
    JOIN   app_users     u ON u.id = ft.author_user_id
    ${whereSQL}
    ORDER BY ft.pinned DESC, ft.last_reply_at DESC NULLS LAST, ft.created_at DESC
    LIMIT  $${p++} OFFSET $${p++}
  `, [...params, limit, offset]);

  const countRes = await pool.query(`
    SELECT COUNT(*) AS total
    FROM   forum_threads ft
    ${whereSQL}
  `, params);

  return { threads: res.rows, total: parseInt(countRes.rows[0].total) };
}

async function getThreadById(id) {
  const res = await pool.query(`
    SELECT ft.*,
           u.email      AS author_email,
           u.first_name AS author_name,
           u.role       AS author_role,
           ft.pinned    AS pinned,
           ft.locked    AS locked,
           ft.is_team_post
    FROM   forum_threads ft
    JOIN   app_users     u ON u.id = ft.author_user_id
    WHERE  ft.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function createThread({ title, body, category, author_user_id, is_team_post = false }) {
  const res = await pool.query(`
    INSERT INTO forum_threads (title, body, category, author_user_id, is_team_post, search_vector)
    VALUES ($1, $2, $3, $4, $5,
      setweight(to_tsvector('english', coalesce($1,'')), 'A') ||
      setweight(to_tsvector('english', coalesce($2,'')), 'B'))
    RETURNING *
  `, [title, body || '', category || 'general', author_user_id, is_team_post]);
  return res.rows[0];
}

async function updateThread(id, fields) {
  const allowed = ['title','body','category','status','pinned','locked','hidden','moderation_reason','ai_response_count','ai_escalated','reply_count','last_reply_at'];
  const updates = [];
  const values = [];
  let p = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      updates.push(`${k} = $${p++}`);
      values.push(v);
    }
  }
  if (!updates.length) return null;
  values.push(id);
  const res = await pool.query(`
    UPDATE forum_threads
    SET    ${updates.join(',')}, updated_at = NOW()
    WHERE  id = $${p}
    RETURNING *
  `, values);
  return res.rows[0];
}

async function bumpAiResponseCount(threadId) {
  const res = await pool.query(`
    UPDATE forum_threads
    SET    ai_response_count = ai_response_count + 1,
           ai_escalated = CASE WHEN ai_response_count + 1 >= 3 THEN TRUE ELSE ai_escalated END,
           updated_at = NOW()
    WHERE  id = $1
    RETURNING ai_response_count, ai_escalated
  `, [threadId]);
  return res.rows[0];
}

async function getUnansweredThreads(sinceMinutes = 5) {
  const res = await pool.query(`
    SELECT ft.*, u.first_name AS author_name
    FROM   forum_threads ft
    JOIN   app_users     u ON u.id = ft.author_user_id
    WHERE  ft.hidden = FALSE
      AND  ft.created_at > NOW() - INTERVAL '${sinceMinutes} minutes'
    ORDER BY ft.created_at DESC
  `);
  return res.rows;
}

// ─── Replies ────────────────────────────────────────────────────────────────────

async function getRepliesByThread(threadId) {
  const res = await pool.query(`
    SELECT fr.*,
           u.first_name AS author_name,
           u.email      AS author_email,
           u.role       AS author_role
    FROM   forum_replies fr
    JOIN   app_users     u ON u.id = fr.author_user_id
    WHERE  fr.thread_id = $1 AND fr.hidden = FALSE
    ORDER BY fr.created_at ASC
  `, [threadId]);
  return res.rows;
}

async function createReply({ thread_id, parent_id, body, author_user_id, is_team_post = false }) {
  const depth = parent_id
    ? await pool.query('SELECT depth FROM forum_replies WHERE id = $1', [parent_id]).then(r => (r.rows[0]?.depth ?? 0) + 1)
    : 0;

  const res = await pool.query(`
    INSERT INTO forum_replies (thread_id, parent_id, body, author_user_id, is_team_post, depth)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [thread_id, parent_id || null, body, author_user_id, is_team_post, Math.min(depth, 3)]);

  // Bump thread reply_count + last_reply_at
  await pool.query(`
    UPDATE forum_threads
    SET    reply_count = reply_count + 1,
           last_reply_at = NOW(),
           status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
    WHERE  id = $1
  `, [thread_id]);

  return res.rows[0];
}

async function hideReply(id, reason) {
  const res = await pool.query(`
    UPDATE forum_replies SET hidden = TRUE, moderation_reason = $2, updated_at = NOW()
    WHERE  id = $1
    RETURNING thread_id
  `, [id, reason]);
  return res.rows[0];
}

// ─── Status log ────────────────────────────────────────────────────────────────

async function logStatusChange(threadId, fromStatus, toStatus, changedBy, note) {
  await pool.query(`
    INSERT INTO forum_status_log (thread_id, from_status, to_status, changed_by, note)
    VALUES ($1, $2, $3, $4, $5)
  `, [threadId, fromStatus, toStatus, changedBy, note || null]);
}

async function getStatusHistory(threadId) {
  const res = await pool.query(`
    SELECT fsl.*, u.first_name AS changed_by_name
    FROM   forum_status_log fsl
    LEFT   JOIN app_users u ON u.id = fsl.changed_by
    WHERE  fsl.thread_id = $1
    ORDER BY fsl.created_at ASC
  `, [threadId]);
  return res.rows;
}

// ─── Moderation queue ──────────────────────────────────────────────────────────

async function getModerationQueue() {
  const threads = await pool.query(`
    SELECT ft.*, u.email AS author_email, u.first_name AS author_name
    FROM   forum_threads ft
    JOIN   app_users     u ON u.id = ft.author_user_id
    WHERE  ft.hidden = TRUE
    ORDER BY ft.created_at DESC
    LIMIT  50
  `);
  const replies = await pool.query(`
    SELECT fr.*, u.email AS author_email, u.first_name AS author_name, ft.title AS thread_title
    FROM   forum_replies fr
    JOIN   app_users      u ON u.id = fr.author_user_id
    JOIN   forum_threads  ft ON ft.id = fr.thread_id
    WHERE  fr.hidden = TRUE
    ORDER BY fr.created_at DESC
    LIMIT  50
  `);
  return { threads: threads.rows, replies: replies.rows };
}

async function restoreContent(id, isThread) {
  if (isThread) {
    await pool.query('UPDATE forum_threads SET hidden = FALSE, moderation_reason = NULL WHERE id = $1', [id]);
  } else {
    await pool.query('UPDATE forum_replies SET hidden = FALSE, moderation_reason = NULL WHERE id = $1', [id]);
  }
}

// ─── Escalations ───────────────────────────────────────────────────────────────

async function getEscalatedThreads() {
  const res = await pool.query(`
    SELECT ft.*, u.first_name AS author_name
    FROM   forum_threads ft
    JOIN   app_users     u ON u.id = ft.author_user_id
    WHERE  ft.ai_escalated = TRUE AND ft.hidden = FALSE
    ORDER BY ft.ai_response_count DESC, ft.created_at DESC
  `);
  return res.rows;
}

module.exports = {
  listThreads, getThreadById, createThread, updateThread, bumpAiResponseCount, getUnansweredThreads,
  getRepliesByThread, createReply, hideReply,
  logStatusChange, getStatusHistory,
  getModerationQueue, restoreContent,
  getEscalatedThreads
};