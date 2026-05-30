/**
 * Owns: static store pages (commission, dashboard, library, asset, search).
 * Does NOT own: store API routes (/api/store), store dashboard SPA.
 */
const router = require('express').Router();
const path = require('path');

router.get('/commission', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store-commission.html')));
router.get('/dashboard',   (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store-dashboard.html')));
router.get('/library',     (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store-library.html')));
router.get('/asset/:slug',(_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store-asset.html')));
router.get('/search',      (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store-search.html')));
router.get('/',            (_req, res) => res.redirect(302, '/app?panel=store'));

module.exports = router;