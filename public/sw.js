/**
 * Atlantist Service Worker
 * Network-first for HTML pages; cache-first for static assets.
 * Bumping CACHE_VERSION invalidates all stale caches.
 */
const CACHE_VERSION = 'v39'; // bumped: dirty-flag render-on-demand, magic link fix, auth rate limit fix
const CACHE_NAME = `atlantist-${CACHE_VERSION}`;

// Static assets to pre-cache (no HTML — HTML is always network-first)
const PRECACHE_ASSETS = [
  '/favicon.ico',
  '/manifest.json',
  '/css/brand-tokens.css',
  '/css/app.css?v=28',
  '/css/app-shell.css?v=4',
  '/css/viewport.css?v=3',
  '/css/atl-cascade.css?v=2',
  '/css/ui-overhaul.css',
  '/css/ui-motion.css?v=2',
  '/images/logo.svg',
  '/logo/atlantist-logo.svg',
  '/brand/favicon.svg',
  '/brand/apple-touch-icon.png',
  '/brand/icon-192.png',
  '/brand/icon-512.png',
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => {
      // Write CACHE_VERSION to localStorage so the page can detect a genuine
      // version change even when the browser caches /sw.js by URL. This runs
      // synchronously before activate, so localStorage is updated by the time
      // the page's controllerchange handler fires.
      try { localStorage.setItem('sw-cache-version', CACHE_VERSION); } catch(e) {}
      return self.skipWaiting();
    })
  );
});

// ─── Activate ──────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ─────────────────────────────────────────────────────────────────
const R2_HOST = 'pub-629428d185ca4960a0a73c850d32294b.r2.dev';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // ── R2 CORS proxy ─────────────────────────────────────────────────────────
  // R2 bucket has no Access-Control-Allow-Origin header, causing CORS blocks.
  // Rewrite R2 requests through our server proxy instead.
  if (url.host === R2_HOST) {
    const key = url.pathname.replace(/^\//, '');
    const proxyUrl = new URL('/api/r2-proxy', self.location.origin);
    proxyUrl.searchParams.set('key', key);
    event.respondWith(fetch(proxyUrl.toString()));
    return;
  }

  // Network-first for API routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'offline', message: 'No network connection' }),
        { headers: { 'Content-Type': 'application/json' }, status: 503 }
      ))
    );
    return;
  }

  // Network-first for HTML pages (navigation requests + page routes)
  // WHY: HTML pages change on every deploy; stale cache causes broken app
  const isNavigation = request.mode === 'navigate';
  const isHTMLRoute = !url.pathname.match(/\.\w+$/) || url.pathname.endsWith('.html');

  if (isNavigation || isHTMLRoute) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || new Response(
          '<h1>Offline</h1><p>Atlantist requires a network connection.</p>',
          { headers: { 'Content-Type': 'text/html' }, status: 503 }
        )))
    );
    return;
  }

  // Network-first for JS/CSS — prevents stale-cache class of bugs
  // WHY: cache-first caused users to keep broken JS after hotfixes deployed.
  // Falling back to cache only if network is unreachable.
  const isJS = url.pathname.endsWith('.js');
  const isCSS = url.pathname.endsWith('.css');

  if (isJS || isCSS) {
    event.respondWith(
      fetch(request).then((response) => {
        if (!response || response.status !== 200) return response;
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        if ((isJS && !ct.includes('javascript')) || (isCSS && !ct.includes('css'))) {
          return response; // wrong content-type — don't cache
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || new Response('', { status: 503 })))
    );
    return;
  }

  // Cache-first for other static assets (fonts, images, icons)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      });
    })
  );
});

// ─── Message handler — SKIP_WAITING for immediate activation ──────────────────
// WHY: app.js sends this on Reload button click. Without this handler, the button
// does nothing — the new SW stays in waiting state and the banner persists.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting().then(() => self.clients.claim());
  }
});
