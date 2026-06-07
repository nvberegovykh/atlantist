'use strict';

const express = require('express');
const router  = express.Router();

/**
 * GET /api/forma/projects
 * Stub: Autodesk Forma connector — returns not-yet-connected state.
 * Real integration will use the Autodesk Forma REST API (OAuth 2.0 PKCE).
 */
router.get('/projects', (req, res) => {
  res.json({
    connected: false,
    message: 'Autodesk Forma integration coming in next release.',
  });
});

module.exports = router;
