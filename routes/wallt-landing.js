/**
 * Owns: /wallt — Wallt standalone full-screen chat UI (Phase 34E).
 * Also serves /wallt/intro — the visual landing/demo page for non-logged-in visitors.
 * Does NOT own: install prompt logic (public/js/wallt-install.js).
 */
const router = require('express').Router();
const path = require('path');

// Full-screen standalone chat — PWA with install prompt, offline support
router.get('/wallt', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'wallt-app.html'));
});

// Visual landing/demo page — static HTML with demo chat preview
router.get('/wallt/intro', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'wallt-landing.html'));
});

// Personal Training Room — Nikita's private control interface
router.get('/wallt/training', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'wallt-training.html'));
});

module.exports = router;