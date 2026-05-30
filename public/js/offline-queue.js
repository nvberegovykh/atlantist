/**
 * Atlantist BIM 2.0 — Offline Edit Queue
 * IndexedDB-persisted queue of edits made during network disconnection.
 * Survives page refresh. Capped at 10MB per project (warn at 8MB, refuse at 10MB).
 *
 * Owns: IndexedDB access, queue CRUD, size tracking, cap enforcement.
 * Does NOT own: WebSocket lifecycle, replay orchestration, conflict resolution UI.
 */

const DB_NAME = 'atlantist-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'edit-queue';
const MAX_BYTES = 10 * 1024 * 1024;      // 10 MB hard cap
const WARN_BYTES = 8 * 1024 * 1024;      // 8 MB warning threshold
const QUEUE_TTL_MS = 5 * 60 * 1000;      // 5 minutes max offline window

let _db = null;

// ─── DB Lifecycle ────────────────────────────────────────────────────────────

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => { console.error('[offline-queue] DB open failed:', e); reject(e); };
  });
}

// ─── Queue Operations ─────────────────────────────────────────────────────────

/**
 * Append an edit to the queue for a given project.
 * Returns { ok: true } or { ok: false, reason: string, warn: bool }.
 */
async function enqueue(projectId, editPayload) {
  const db = await openDB();
  const entry = {
    projectId,
    timestamp: Date.now(),
    payload: editPayload,
  };

  const currentSize = await _estimateSize(projectId);
  const entrySize = JSON.stringify(entry).length * 2; // rough UTF-16 estimate

  if (currentSize >= MAX_BYTES) {
    return { ok: false, reason: 'queue_full', size: currentSize, maxSize: MAX_BYTES };
  }
  if (currentSize + entrySize >= MAX_BYTES) {
    return { ok: false, reason: 'entry_too_large', size: currentSize, maxSize: MAX_BYTES };
  }
  if (currentSize + entrySize >= WARN_BYTES) {
    entry._warn = true; // flag for UI to show warning
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(entry);
    req.onsuccess = () => resolve({ ok: true, warn: entry._warn || false, size: currentSize + entrySize });
    req.onerror = (e) => { console.error('[offline-queue] enqueue failed:', e); reject(e); };
  });
}

/**
 * Dequeue all pending edits for a project, oldest first.
 * Clears the entries after returning them.
 */
async function dequeueAll(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('projectId');
    const req = index.getAll(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
      const entries = req.result.sort((a, b) => a.timestamp - b.timestamp);
      // Delete them one by one
      for (const entry of entries) {
        store.delete(entry.id);
      }
      resolve(entries);
    };
    req.onerror = (e) => { console.error('[offline-queue] dequeueAll failed:', e); reject(e); };
  });
}

/**
 * Remove specific entries (used after successful replay of known entries).
 */
async function removeEntries(ids) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => { console.error('[offline-queue] removeEntries failed:', e); reject(e); };
  });
}

/**
 * Get count of pending edits for a project.
 */
async function pendingCount(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('projectId');
    const req = index.count(IDBKeyRange.only(projectId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

/**
 * Get total byte size of queued entries for a project.
 */
async function _estimateSize(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('projectId');
    const req = index.getAll(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
      let total = 0;
      for (const e of req.result) total += JSON.stringify(e).length * 2;
      resolve(total);
    };
    req.onerror = (e) => reject(e);
  });
}

/**
 * Expire entries older than QUEUE_TTL_MS for a given project.
 */
async function expireOld(projectId) {
  const db = await openDB();
  const cutoff = Date.now() - QUEUE_TTL_MS;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('projectId');
    const req = index.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.timestamp < cutoff) cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

/**
 * Get the timestamp of the oldest entry for a project (or null if none).
 */
async function oldestTimestamp(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('projectId');
    const req = index.openCursor(IDBKeyRange.only(projectId));
    let oldest = null;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (!oldest || cursor.value.timestamp < oldest) oldest = cursor.value.timestamp;
        cursor.continue();
      } else {
        resolve(oldest);
      }
    };
    req.onerror = (e) => reject(e);
  });
}

// ─── Size helpers (for UI) ─────────────────────────────────────────────────────

async function getQueueSize(projectId) {
  return _estimateSize(projectId);
}

async function isNearCap(projectId) {
  const size = await _estimateSize(projectId);
  if (size >= MAX_BYTES) return 'full';
  if (size >= WARN_BYTES) return 'warn';
  return 'ok';
}

// ─── Debug / testing ────────────────────────────────────────────────────────────

async function clearAll(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('projectId');
    const req = index.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

export {
  enqueue,
  dequeueAll,
  pendingCount,
  expireOld,
  oldestTimestamp,
  getQueueSize,
  isNearCap,
  clearAll,
  MAX_BYTES,
  WARN_BYTES,
  QUEUE_TTL_MS,
};