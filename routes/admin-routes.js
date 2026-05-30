/**
 * Owns: /admin/* page serving (abuse queue, guides, updates, abuse-reports).
 * Does NOT own: API routes, auth middleware logic.
 */
const express = require('express');
const path = require('path');
const { getSessionByToken } = require('../db/auth');
const { getUserRole } = require('../db/roles');

const router = express.Router();

async function requireAdmin(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.redirect(303, '/app');
  try {
    const session = await getSessionByToken(token);
    if (!session) return res.redirect(303, '/app');
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).send('<h1>403 Forbidden</h1><p>Admin access required.</p>');
    req.adminRole = role;
    next();
  } catch (err) {
    res.status(500).send('<h1>500</h1><p>' + err.message + '</p>');
  }
}

const ADMIN_PAGES = ['abuse', 'abuse-reports', 'guides', 'updates', 'wallt-admin'];
const PAGE_FILES = {
  'abuse': 'admin-abuse.html',
  'abuse-reports': 'admin/abuse-reports.html',
  'guides': 'admin/guides.html',
  'updates': 'admin/updates.html',
  'wallt-admin': 'admin/wallt-admin.html',
};

// Generic admin page handler
router.get('/:page', async (req, res) => {
  const page = req.params.page;
  if (!ADMIN_PAGES.includes(page)) return res.status(404).send('Not found');
  const token = req.cookies?.session_token;
  if (!token) return res.redirect(303, '/app');
  try {
    const session = await getSessionByToken(token);
    if (!session) return res.redirect(303, '/app');
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).send('<h1>403 Forbidden</h1><p>Admin access required.</p>');
    const file = PAGE_FILES[page];
    res.sendFile(path.join(__dirname, '..', 'public', file));
  } catch (err) {
    res.status(500).send('<h1>500</h1><p>' + err.message + '</p>');
  }
});

module.exports = router;