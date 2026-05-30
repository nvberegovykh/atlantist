/**
 * Owns: all DB queries for support_tickets and support_comments tables.
 * Does NOT own: email notifications, ticket routing logic.
 */
const pool = require('./index');

// Create support ticket
async function createTicket(data) {
  const { user_id, email, subject, description, priority = 'normal', category = 'other' } = data;
  const res = await pool.query(
    `INSERT INTO support_tickets (user_id, email, subject, description, priority, category)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [user_id, email, subject, description, priority, category]
  );
  return res.rows[0];
}

// Get ticket by ID
async function getTicketById(id) {
  const res = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Get ticket with comments
async function getTicketWithComments(id) {
  const ticket = await getTicketById(id);
  if (!ticket) return null;
  const commentsRes = await pool.query(
    `SELECT * FROM support_comments WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  ticket.comments = commentsRes.rows;
  return ticket;
}

// List tickets with optional filters
async function listTickets(filters = {}) {
  const { status, priority, assigned_to, user_id, category, limit = 50, offset = 0 } = filters;
  let query = 'SELECT * FROM support_tickets WHERE 1=1';
  const params = [];
  let idx = 1;

  if (status) { query += ` AND status = $${idx++}`; params.push(status); }
  if (priority) { query += ` AND priority = $${idx++}`; params.push(priority); }
  if (assigned_to) { query += ` AND assigned_to = $${idx++}`; params.push(assigned_to); }
  if (user_id) { query += ` AND user_id = $${idx++}`; params.push(user_id); }
  if (category) { query += ` AND category = $${idx++}`; params.push(category); }

  query += ` ORDER BY priority DESC, created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const res = await pool.query(query, params);
  return res.rows;
}

// Update ticket
async function updateTicket(id, data) {
  const { status, priority, assigned_to, resolution_notes } = data;
  const fields = [];
  const values = [];
  let idx = 1;
  const allowed = ['status', 'priority', 'assigned_to', 'resolution_notes'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return getTicketById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const res = await pool.query(
    `UPDATE support_tickets SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// Add comment to ticket
async function addComment(ticketId, data) {
  const { user_id, author_name, content, is_internal = false } = data;
  const res = await pool.query(
    `INSERT INTO support_comments (ticket_id, user_id, author_name, content, is_internal)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ticketId, user_id, author_name, content, is_internal]
  );
  return res.rows[0];
}

// Get ticket comments
async function getTicketComments(ticketId) {
  const res = await pool.query(
    'SELECT * FROM support_comments WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticketId]
  );
  return res.rows;
}

// Get ticket counts by status
async function getTicketCounts() {
  const res = await pool.query(`
    SELECT status, COUNT(*) as count FROM support_tickets GROUP BY status
  `);
  return res.rows;
}

// Get open tickets assigned to admin
async function getAssignedTickets(assignedTo) {
  const res = await pool.query(
    `SELECT * FROM support_tickets WHERE assigned_to = $1 AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at ASC`,
    [assignedTo]
  );
  return res.rows;
}

// Close resolved tickets (auto-cleanup)
async function closeResolvedTickets(daysOld = 30) {
  const res = await pool.query(
    `UPDATE support_tickets SET status = 'closed', updated_at = NOW()
     WHERE status = 'resolved' AND updated_at < NOW() - INTERVAL '${daysOld} days'`
  );
  return res.rowCount;
}

module.exports = {
  createTicket,
  getTicketById,
  getTicketWithComments,
  listTickets,
  updateTicket,
  addComment,
  getTicketComments,
  getTicketCounts,
  getAssignedTickets,
  closeResolvedTickets
};