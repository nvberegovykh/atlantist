/**
 * Owns: static page serving for legal pages and shortcut aliases.
 * Does NOT own: SPA shell (/app), landing page, admin pages.
 */
const router = require('express').Router();
const path = require('path');

const VALID_LEGAL_PAGES = new Set(['privacy', 'terms', 'cookies', 'dpa', 'sla', 'content-policy']);
const LEGAL_DIR = path.join(__dirname, '..', 'public', 'legal');

router.get('/legal/:page', (req, res) => {
  const page = req.params.page.replace(/\/$/, '');
  if (VALID_LEGAL_PAGES.has(page)) {
    return res.sendFile(path.join(LEGAL_DIR, `${page}.html`));
  }
  res.redirect(302, '/');
});

// Shortcut aliases
router.get('/terms',          (_req, res) => res.sendFile(path.join(LEGAL_DIR, 'terms.html')));
router.get('/privacy',        (_req, res) => res.sendFile(path.join(LEGAL_DIR, 'privacy.html')));
router.get('/cookies',        (_req, res) => res.sendFile(path.join(LEGAL_DIR, 'cookies.html')));
router.get('/eula',           (_req, res) => res.sendFile(path.join(LEGAL_DIR, 'terms.html')));
router.get('/disclaimer',    (_req, res) => res.sendFile(path.join(LEGAL_DIR, 'terms.html')));
router.get('/acceptable-use',(_req, res) => res.redirect(302, '/legal/content-policy'));

// Docs + demo
router.get('/docs',                                    (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs', 'index.html')));
router.get('/docs/features/recreatable-model',        (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs', 'design-guide.html')));
router.get('/demo/nyc-midrise',                        (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'demo.html')));

// Subscribe acknowledge
router.get('/subscribe/acknowledge', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'subscribe-acknowledge.html')));

module.exports = router;