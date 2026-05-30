/**
 * Wallt PWA Service Worker (Phase 34E)
 * Caches Wallt shell (landing + app pages + assets) for offline launch.
 * Network-first on API calls, background sync for queued messages.
 */
const CACHE_VERSION_WALLT = 'v1-wallt';
const CACHE_NAME_WALLT = `wallt-shell-${CACHE_VERSION_WALLT}`;

// Shell assets to cache for offline Wallt access
const WALLT_SHELL_ASSETS = [
  '/wallt',
  '/favicon.ico',
  '/manifest.webmanifest',
];

// Offline message queue key
const MSG_QUEUE_KEY = 'wallt-msg-queue';

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME_WALLT).then((cache) => {
      return cache.addAll(WALLT_SHELL_ASSETS).catch((err) => {
        console.warn('[sw-wallt] Precache partial, continuing:', err.message);
      });
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate ──────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('wallt-shell-') && key !== CACHE_NAME_WALLT)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Network-first for API routes
  if (url.pathname.startsWith('/api/wallt/')) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME_WALLT).then((cache) => {
              cache.put(request, clone);
            });
          }
          return resp;
        })
        .catch(() => {
          // Offline: try cache first, else offline JSON
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            return new Response(
              JSON.stringify({ error: 'offline', message: 'Wallt is offline — message queued for retry' }),
              { headers: { 'Content-Type': 'application/json' }, status: 503 }
            );
          });
        })
    );
    return;
  }

  // Network-first for Wallt shell pages
  if (url.pathname === '/wallt' || url.pathname.endsWith('wallt-app.html') || url.pathname.endsWith('wallt-landing.html')) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME_WALLT).then((cache) => cache.put(request, clone));
          }
          return resp;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || new Response(
            '<h1>Offline</h1><p>Wallt is offline. Connect to the internet to continue.</p>',
            { headers: { 'Content-Type': 'text/html' }, status: 503 }
          ))
        )
    );
    return;
  }

  // Cache-first for Wallt static assets (CSS, JS for wallt pages)
  if (
    url.pathname.includes('/css/wallt') ||
    url.pathname.includes('/js/wallt') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js')
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((resp) => {
          if (!resp || resp.status !== 200) return resp;
          const clone = resp.clone();
          caches.open(CACHE_NAME_WALLT).then((cache) => cache.put(request, clone));
          return resp;
        });
      })
    );
    return;
  }

  // Cache-first for fonts/images referenced in Wallt pages
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.pathname.match(/\/brand\/|\/logo\//)
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((resp) => {
          if (!resp || resp.status !== 200) return resp;
          const clone = resp.clone();
          caches.open(CACHE_NAME_WALLT).then((cache) => cache.put(request, clone));
          return resp;
        });
      })
    );
  }
});

// ─── Background Sync — queued messages ─────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'wallt-msg-sync') {
    event.waitUntil(replayQueuedMessages());
  }
});

async function replayQueuedMessages() {
  try {
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: 'WALLT_MSG_SYNC' });
    }
  } catch (err) {
    console.warn('[sw-wallt] Sync message send failed:', err.message);
  }
}

// ─── Push Notifications (opt-in scaffold) ───────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || 'Wallt has a message for you',
    icon: '/brand/icon-192.png',
    badge: '/brand/icon-192.png',
    tag: 'wallt-notif',
    requireInteraction: false,
    data: { url: data.url || '/wallt' },
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Wallt by Atlantist', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data.url || '/wallt')
  );
});

// ─── Message handler — receive queued message from client ──────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'WALLT_QUEUE_MESSAGE') {
    // Client wants us to queue a message for replay on reconnect
    // Store in IndexedDB for cross-session persistence
    event.waitUntil(queueMessage(event.data.payload));
  }
});

async function queueMessage(payload) {
  try {
    const db = await openQueueDB();
    const tx = db.transaction('msgQueue', 'readwrite');
    tx.objectStore('msgQueue').add({ payload, queuedAt: Date.now() });
  } catch (err) {
    console.warn('[sw-wallt] Queue write failed:', err.message);
  }
}

async function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wallt-queue', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      if (!e.target.result.objectStoreNames.contains('msgQueue')) {
        e.target.result.createObjectStore('msgQueue', { autoIncrement: true });
      }
    };
  });
}