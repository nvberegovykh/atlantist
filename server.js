const http = require('http');
const express = require('express');
const sentry = require('./services/sentry');
const path = require('path');
const cookieParser = require('cookie-parser');
const wsServer = require('./services/ws-server');
const walltSessionStore = require('./services/wallt-session-store');
const walltCache = require('./services/wallt-memory-cache');
const { getSessionByToken } = require('./db/auth');
const { getUserRole, setUserRole } = require('./db/roles');
const { getUserByEmail } = require('./db/users');
const { authMiddleware: _authMiddleware } = require('./routes/auth');
const { rateLimit } = require('./lib/rate-limit');

// Rate limiters — applied to high-risk endpoints
const authRateLimit = rateLimit({ max: 20, windowSec: 60, keyPrefix: 'rl:auth' });
const aiRateLimit   = rateLimit({ max: 30, windowSec: 60, keyPrefix: 'rl:ai',
  keyFn: req => (req.user && req.user.id) ? String(req.user.id) : (req.ip || 'anon') });

// Demo project IDs — GETs on these are always public, no auth required.
// Seeded at startup from the DB (projects.is_demo = TRUE) so we handle
// integer IDs correctly instead of relying on a hardcoded UUID.
const DEMO_PROJECT_IDS = new Set();
const pool = require('./db/index');
(async () => {
  try {
    const res = await pool.query('SELECT id FROM projects WHERE is_demo = TRUE');
    for (const row of res.rows) DEMO_PROJECT_IDS.add(String(row.id));
    console.log('[requireBimAuth] demo project IDs loaded:', [...DEMO_PROJECT_IDS]);
  } catch (e) {
    console.warn('[requireBimAuth] failed to load demo IDs at startup:', e.message);
  }
})();

// BIM auth gate: 401 if no session token.
// Exception: GET requests for demo projects pass through unauthenticated.
function requireBimAuth(req, res, next) {
  // Allow unauthenticated GET reads for demo projects
  if (req.method === 'GET') {
    const pid = req.query.project_id || req.params.project_id || req.params.id;
    if (pid && DEMO_PROJECT_IDS.has(String(pid))) {
      req.user = req.user || null; // may be null — routes must handle
      return next();
    }
  }
  // Also allow anon sessions (X-Session-UUID) through for auth resolution
  _authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    next();
  });
}

const app = express();
const port = process.env.PORT || 3000;

// ─── Sentry — init before routes, no-op if SENTRY_DSN unset ─────────────────
sentry.init(app);
app.use(sentry.requestHandler());
app.use(sentry.traceHandler());

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// WHY: 301 legacy hosts to canonical domain for SEO + social sharing consistency
const { CANONICAL_ORIGIN } = require('./lib/canonical-url');
const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).hostname; // atlantist.cloud
const LEGACY_HOSTS = new Set(['www.atlantist.cloud', 'nexaxis.polsia.app', 'atlantist.polsia.app']);
app.use((req, res, next) => {
  const host = req.hostname;
  if (LEGACY_HOSTS.has(host)) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// WHY: no-cache prevents stale JS/CSS across deploys (max-age=300 broke things)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) { // SW must never be cached
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, must-revalidate');
    } else if (filePath.endsWith('.wasm')) {
      // WASM MIME: browsers enforce application/wasm for WebAssembly module scripts
      res.set('Content-Type', 'application/wasm');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.use((_req, res, next) => { // no-cache HTML pages
  const origSendFile = res.sendFile.bind(res);
  res.sendFile = function (filePath, ...args) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    return origSendFile(filePath, ...args);
  };
  next();
});

// CSP — allow Three.js CDN, Google Fonts, R2 images, inline scripts, and importmap eval
app.use((_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://browser.sentry-cdn.com https://js.sentry-cdn.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://frontend-cdn.perplexity.ai; img-src 'self' data: blob: https://pub-629428d185ca4960a0a73c850d32294b.r2.dev https://*.r2.dev https://*.bimobject.com https://*.grabcad.com https://*.sketchup.com https://*.polantis.com https://*.revitcity.com; connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://unpkg.com https://frontend-cdn.perplexity.ai https://browser.sentry-cdn.com https://js.sentry-cdn.com https://o*.ingest.sentry.io; worker-src 'self' blob:");
  next();
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

// ─── Landing page — always public ─────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Contact page ───────────────────────────────────────────────────────────
app.get('/contact', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

// ─── Pricing page — standalone pricing page ──────────────────────────────
app.get('/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// ─── RECT pricing page — live cost graph (Phase 36) ──────────────────────
app.get('/rect', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rect.html'));
});

// ─── App route — resolves session role, serves SPA ─────────────────────────
app.get('/app', async (req, res) => {
  const sessionToken = req.cookies?.session_token;

  if (sessionToken) {
    try {
      const session = await getSessionByToken(sessionToken);
      if (session) {
        const appRole = await getUserRole(session.user_id);
        res.cookie('app_role', appRole === 'admin' ? 'admin' : 'user', { httpOnly: false, maxAge: 86400 * 1000, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
      } else {
        res.clearCookie('session_token');
      }
    } catch (err) {
      console.error('[app] session resolve error:', err.message);
    }
  }

  // WHY: nuke stale caches once per browser — bump cache_vN + SW CACHE_VERSION together
  if (!req.cookies?.cache_v20) {
    res.set('Clear-Site-Data', '"cache"');
    res.cookie('cache_v20', '1', { httpOnly: false, maxAge: 30 * 86400 * 1000 });
  }

  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─── Status, FAQ, and status.json — served from routes/status.js ──────────
app.use(require('./routes/status'));

// Legal pages + shortcut aliases + docs + subscribe acknowledge
app.use(require('./routes/static-pages'));

// ─── API routes ─────────────────────────────────────────────────────────────
// WHY: Surrogate-Control + no-store prevents Cloudflare CDN from caching API
// responses. Prior regression cached landing HTML as canonical response for
// /api/wall-types, breaking the BIM app on browsers that hit the edge cache.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Surrogate-Control', 'no-store');
  res.set('Vary', 'Accept-Encoding');
  next();
});
app.use('/api/levels', requireBimAuth, require('./routes/levels'));
app.use('/api/dag', requireBimAuth, require('./routes/dag'));
// IM-B: Information Modeling — type/instance split, type inheritance, constraint bindings
app.use('/api/im', requireBimAuth, require('./routes/im-elements'));
// elements router — list, CRUD, and layers at /api/elements
app.use('/api/elements', requireBimAuth, require('./routes/elements'));
app.use('/api/issues', require('./routes/issues'));
app.use('/api/families', require('./routes/families'));
app.use('/api/demo', require('./routes/demo'));
app.use('/api/renders', require('./routes/renders'));
app.use('/api/energy', require('./routes/energy'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/catalog', require('./routes/catalog'));
app.use('/api/auth', authRateLimit, require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/matching', require('./routes/matching'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/support', require('./routes/support'));
app.use('/api/fire-protection', require('./routes/fire-protection'));
app.use('/api/geotechnical', require('./routes/geotechnical'));
app.use('/api/guardrails', require('./routes/guardrails'));
app.use('/api/design-book', require('./routes/design-book'));
app.use('/api/sheets', require('./routes/sheets'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/client-errors', require('./routes/client-errors'));
app.use('/api/cost', require('./routes/cost-ledger'));
app.use('/api/subscribe-ack', require('./routes/subscribe-ack'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/export', require('./routes/dxf'));
app.use('/api/abuse', require('./routes/abuse'));
app.use('/api/models', require('./routes/model-reports'));
app.use('/api/guides', require('./routes/guides'));
app.use('/api/mep', require('./routes/sims-mep'));
app.use('/api/mep-fixtures', require('./routes/mep-fixtures'));
app.use('/api/mep-elements', require('./routes/mep-elements'));
app.use('/api/rvt-import', requireBimAuth, require('./routes/rvt-import'));
app.use('/api/ifc', require('./routes/ifc'));
app.use('/api/annotations', requireBimAuth, require('./routes/annotations'));
app.use('/api/grids', requireBimAuth, require('./routes/grids'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/floors', requireBimAuth, require('./routes/floors'));
app.use('/api/ceilings', requireBimAuth, require('./routes/ceilings'));
app.use('/api/curved-surfaces', require('./routes/curved-surfaces'));
app.use('/api/stairs', requireBimAuth, require('./routes/stairs'));
app.use('/api/railings', require('./routes/railings'));
app.use('/api/structural', require('./routes/structural'));
app.use('/api/structural-audit', require('./routes/structural-audit'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/overlay-check', require('./routes/overlay-check'));
app.use('/api/store', require('./routes/store'));
app.use('/api/store-webhook', require('./routes/store-webhook'));
app.use('/api/node-editor', require('./routes/node-editor'));
app.use('/api/updates', require('./routes/updates'));
app.use('/api/events', require('./routes/events'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/inbound-email', require('./routes/inbound-email'));
app.use('/api/forum', require('./routes/forum'));
app.use('/api/crafting', require('./routes/crafting'));
app.use('/api/crafting/recognize', aiRateLimit, require('./routes/recognizer'));
app.use('/api/crafting/sourcing', require('./routes/sourcing'));
// Wallt sub-routes — specific paths FIRST, then the catch-all last
app.use('/api/wallt/training',     require('./routes/wallt-training'));
app.use('/api/wallt/session',      require('./routes/wallt-session'));
app.use('/api/wallt/memory',       require('./routes/wallt-memory'));
app.use('/api/wallt/moral-drift',  require('./routes/wallt-moral-drift'));
app.use('/api/wallt/admin',        require('./routes/wallt-admin'));
app.use('/api/wallt/escalate',     require('./routes/wallt-escalate'));
app.use('/api/wallt/audio',        require('./routes/wallt-audio'));
app.use('/api/wallt/voice',       require('./routes/wallt-voice'));
app.use('/api/wallt/legal-registry', require('./routes/wallt-legal-registry'));
app.use('/api/wallt/legal-compliance', require('./routes/wallt-legal-compliance'));
app.use('/api/wallt/health',      require('./routes/wallt-health'));
app.use('/api/wallt/deploy',       require('./routes/wallt-deploy'));
app.use('/api/wallt/recover',     require('./routes/wallt-recover'));
app.use('/api/wallt/context',     require('./routes/wallt-context-graph'));
app.use('/api/wallt-api',         aiRateLimit, require('./routes/wallt-api'));
// vLLM proxy — health + metrics endpoints; routes to VLLM_BASE_URL if set, else OPENAI_BASE_URL
app.use('/api/vllm-proxy',        aiRateLimit, require('./services/vllm-proxy').createRouter());
// W5: KV Cache monitoring — hit/miss metrics, sector staleness, GPU mem, eviction log, alerts
app.use('/api/vllm-cache-monitor', require('./routes/vllm-cache-monitor'));
// W2: PagedAttention agent router — tiered prompts with cache namespacing for 10 agents
app.use('/api/wallt-agent',       require('./routes/wallt-agent'));
// W4: Goal 19 pipeline — 3-agent prefix sharing with PagedAttention
app.use('/api/goal19',            require('./routes/goal19-pipeline'));
// W4: Reasoner — deterministic graph traversal, view-first data access, pgvector ANN
app.use('/api/wallt-reasoner',    require('./routes/wallt-reasoner'));
app.use('/api/wallt/scan',        require('./routes/wallt-scan'));
app.use('/api/wallt',             aiRateLimit, require('./routes/wallt'));
app.use('/api/rect', require('./routes/rect-pricing'));
app.use('/api/viewport-states', require('./routes/viewport-states'));
app.use('/api/app-events', require('./routes/app-events'));
app.use('/api/live-sessions', require('./routes/live-sessions'));
app.use('/api/drive', require('./routes/drive'));
app.use('/api/drive', require('./routes/drive-schedule-import'));

// ─── Contributor system ──────────────────────────────────────────────────────
// Individual endpoints manage their own auth; no blanket middleware here.
app.use('/api/contributors', require('./routes/contributors'));
// Webhook uses express.raw() internally — mount before JSON body-parser catches /api
app.use('/api/contributors/webhook', require('./routes/contributor-webhook'));

// ─── Admin pages ────────────────────────────────────────────────────────────
app.use('/admin', require('./routes/admin-routes'));
app.use('/admin/docs', require('./routes/admin-docs'));

// ─── Store static pages ─────────────────────────────────────────────────────
app.use('/store', require('./routes/store-pages'));

// ─── Wallt landing page ───────────────────────────────────────────────────
app.use(require('./routes/wallt-landing'));

// ─── Blog and feature gallery — static HTML ───────────────────────────────
app.use(require('./routes/docs-static'));

// Sentry error handler — captures 5xx before our handler responds
app.use(sentry.errorHandler());

app.use((err, req, res, _next) => {
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}`;
  console.error(`[error] ${req.method} ${req.path} requestId=${requestId}`, err);
  if (req.path.startsWith('/api/')) {
    const code = err.code || err.status || 500;
    return res.status(typeof code === 'number' ? code : 500)
      .set('Content-Type', 'application/json')
      .json({ error: err.message || 'Internal server error', code, requestId });
  }
  // Non-API routes: fallthrough to catch-all
  res.status(500).send('Internal server error');
});

// Catch-all — redirect unknown SPA routes to landing page.
// BUG-CATCH-ALL: Static asset requests (wasm, js, css, png, etc.) that reach
// here mean the file is missing. Return 404 instead of 302 redirect so:
//   - Browsers don't parse HTML as wasm/js (avoids MIME type errors)
//   - ServiceWorker fetch handlers get a clean 404 to handle
//   - web-ifc.wasm 302 redirect bug is eliminated
app.get('*', (req, res) => {
  const path = req.path;
  // Static asset: any path with a file extension (dot in the last segment)
  const lastSegment = path.split('/').pop();
  if (lastSegment && lastSegment.includes('.')) {
    return res.status(404).send('Not found');
  }
  // SPA route — redirect to landing
  res.redirect(302, '/');
});

// Admin seed — creates initial admin from ADMIN_EMAIL env var
async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  try {
    const user = await getUserByEmail(adminEmail);
    if (!user) {
      console.log(`[admin] No user found for ADMIN_EMAIL=${adminEmail} — skip. Create account first at /app.`);
      return;
    }
    await setUserRole(user.id, 'admin');
    console.log(`[admin] User ${adminEmail} promoted to admin.`);
  } catch (err) {
    console.error('[admin] Seed error:', err.message);
  }
}

// Wrap in HTTP server so WebSocket can share the same port
const server = http.createServer(app);
wsServer.attach(server);
server.listen(port, async () => {
  console.log(`Atlantist BIM running on port ${port}`);
  require('./services/wallt-auto-recovery-init');
  walltSessionStore.cleanupOrphanedSessions().catch(e => console.warn('[wallt-session] Cleanup:', e?.message));
  await seedAdmin();
  walltCache.init().catch(e => console.warn('[wallt-cache] init:', e?.message));
});