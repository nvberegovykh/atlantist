// Static HTML pages that serve directly without a route module.
// Kept inline in server.js for low-churn landing pages.
// Docs pages with dynamic content use routes/admin-docs.js instead.
const express = require('express');
const path = require('path');
const router = express.Router();

const PUBLIC = path.join(__dirname, '..', 'public');

router.get('/docs/features', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'docs', 'features.html'));
});

router.get('/docs/wallt-api', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'docs', 'wallt-api.html'));
});

router.get('/blog', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'blog.html'));
});

router.get('/blog/atlantis-pro-manifesto', (_req, res) => {
  res.redirect(301, '/blog/atlantist-manifesto');
});

router.get('/blog/atlantist-manifesto', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'blog', 'atlantist-manifesto.html'));
});

module.exports = router;