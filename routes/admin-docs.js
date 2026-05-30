/**
 * Owns: /admin/docs — admin-only inline docs editor page.
 * Does NOT own: public docs, public-facing API, user content.
 */
const path = require('path');
const router = require('express').Router();
const { getSessionByToken } = require('../db/auth');
const { getUserRole } = require('../db/roles');

router.get('/', async (req, res) => {
  const token = req.cookies?.session_token;
  if (!token) return res.redirect(303, '/app');
  try {
    const session = await getSessionByToken(token);
    if (!session) return res.redirect(303, '/app');
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).send('<h1>403 Forbidden</h1><p>Admin access required.</p>');
    res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'docs.html'));
  } catch (err) {
    res.status(500).send('<h1>500</h1><p>' + err.message + '</p>');
  }
});

module.exports = router;