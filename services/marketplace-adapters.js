/**
 * Owns: external marketplace source adapters for Phase 30B federated search.
 * Returns a common AssetResult shape from each source.
 * Does NOT own: caching, DB persistence, or HTTP routing.
 *
 * AssetResult: { id, source, name, description, thumbnail_url, format,
 *               license, price, price_label, external_url, tags, category }
 */

const https = require('https');
const http = require('http');

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchJson(url, { timeout = 6000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Atlantist-BIM/2.0 (marketplace-aggregator; +https://atlantist.cloud)',
        'Accept': 'application/json',
        ...headers,
      },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function priceLabel(price) {
  if (price === null || price === undefined) return 'Free';
  const n = parseFloat(price);
  if (isNaN(n) || n === 0) return 'Free';
  return `$${n.toFixed(2)}`;
}

// ─── GrabCAD Adapter ─────────────────────────────────────────────────────────
// GrabCAD has a documented public REST API at api.grabcad.com.

async function grabcadSearch(query, { limit = 10 } = {}) {
  try {
    const q = encodeURIComponent(query || 'bim');
    const url = `https://api.grabcad.com/v1/models?q=${q}&per_page=${Math.min(limit, 12)}&sort=likes_count`;
    const { status, body } = await fetchJson(url, { timeout: 5000 });
    if (status !== 200 || !body || !Array.isArray(body.models)) return [];

    return body.models.map(m => ({
      id: `gc-${m.id}`,
      source: 'GrabCAD',
      name: m.name || 'GrabCAD Model',
      description: m.description || '',
      thumbnail_url: m.preview_url || m.thumb_url || null,
      format: m.file_types ? m.file_types[0] || '.stp' : '.stp',
      license: 'free',
      price: 0,
      price_label: 'Free',
      external_url: `https://grabcad.com/library/${m.slug || m.id}`,
      tags: m.categories ? m.categories.map(c => c.name) : [],
      category: 'BIM Families',
    }));
  } catch (err) {
    console.warn('[adapter:grabcad]', err.message);
    return [];
  }
}

// ─── 3D Warehouse Adapter ─────────────────────────────────────────────────────
// 3D Warehouse has a public search API used by their website.

async function warehouse3dSearch(query, { limit = 10 } = {}) {
  try {
    const q = encodeURIComponent(query || 'bim');
    // 3D Warehouse public search endpoint
    const url = `https://3dwarehouse.sketchup.com/3dw/GetEntity?contentType=MODEL&count=${Math.min(limit, 12)}&orderType=LIKEDESCENDING&startIndex=0&q=${q}`;
    const { status, body } = await fetchJson(url, { timeout: 5000 });
    if (status !== 200 || !body || !body.entries) return [];

    return (body.entries || []).map(e => ({
      id: `3dw-${e.id || e.modelId}`,
      source: '3D Warehouse',
      name: e.title || e.name || '3D Warehouse Model',
      description: e.description || '',
      thumbnail_url: e.thumbnail || e.representImage || null,
      format: '.skp',
      license: 'free',
      price: 0,
      price_label: 'Free',
      external_url: `https://3dwarehouse.sketchup.com/model/${e.id || e.modelId}`,
      tags: e.tags || [],
      category: '3D Models',
    }));
  } catch (err) {
    console.warn('[adapter:3dwarehouse]', err.message);
    return [];
  }
}

// ─── BIMobject Adapter ─────────────────────────────────────────────────────────
// BIMobject does not have a public JSON search API. We use their OpenSearch/sitemap
// via the indexed DB entries — live calls would require scraping (not allowed).
// Returns [] to fall through to DB-indexed results.

async function bimobjectSearch(_query, _opts) {
  // No documented public REST API — results come from db/external_assets seed + indexer job.
  // Returning [] means the aggregator falls back to DB-backed results for this source.
  return [];
}

// ─── Polantis Adapter ─────────────────────────────────────────────────────────
// No public REST API. Results served from pre-indexed DB entries.

async function polantisSearch(_query, _opts) {
  return [];
}

// ─── NBS Source Adapter ─────────────────────────────────────────────────────────
// NBS Source (now NBS Chorus / Thenbs.com) has no public API. DB-backed.

async function nbsSearch(_query, _opts) {
  return [];
}

// ─── Revit City Adapter ─────────────────────────────────────────────────────────
// RevitCity does not expose a public REST API. DB-backed.

async function revitcitySearch(_query, _opts) {
  return [];
}

// ─── Adapter registry ─────────────────────────────────────────────────────────

const ADAPTERS = {
  'GrabCAD':       grabcadSearch,
  '3D Warehouse':  warehouse3dSearch,
  'BIMobject':     bimobjectSearch,
  'Polantis':      polantisSearch,
  'NBS Source':    nbsSearch,
  'Revit City':    revitcitySearch,
};

const ALL_SOURCES = Object.keys(ADAPTERS);

/**
 * Run all adapters in parallel. Failed adapters are silently omitted.
 * @returns {Promise<{ source: string, results: AssetResult[], error?: string }[]>}
 */
async function fetchAllAdapters(query, { limit = 10, sources = ALL_SOURCES } = {}) {
  const tasks = sources.map(async (source) => {
    const fn = ADAPTERS[source];
    if (!fn) return { source, results: [] };
    try {
      const results = await fn(query, { limit });
      return { source, results: Array.isArray(results) ? results : [] };
    } catch (err) {
      console.warn(`[marketplace-adapters] ${source} failed:`, err.message);
      return { source, results: [], error: err.message };
    }
  });

  return Promise.all(tasks);
}

module.exports = { fetchAllAdapters, ALL_SOURCES, ADAPTERS, priceLabel };
