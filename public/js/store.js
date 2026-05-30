/* ============================================================
   Atlantist Asset Store — Phase 30a
   Owns: store modal UI, card grid, upload flow, my-assets panel.
   Does NOT own: API endpoints, file upload to R2, Stripe checkout.
   ============================================================ */

const STORE_CATEGORIES = ['Scripts', 'BIM Families', '3D Models', 'MEP Circuits', 'Materials', 'Templates', 'Plugins'];
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'most_downloaded', label: 'Most Downloaded' },
  { value: 'top_rated', label: 'Top Rated' },
  { value: 'price_low', label: 'Price: Low to High' },
  { value: 'price_high', label: 'Price: High to Low' },
];
const DISTRIBUTOR_LABELS = {
  BIMObject: 'via BIMObject',
  'Autodesk Exchange': 'via Autodesk Exchange',
  Poliigon: 'via Poliigon',
  TFHUB: 'via TFHUB',
};

// ── Modal Shell ────────────────────────────────────────────

function ensureStoreModal() {
  if (document.getElementById('modal-store')) return;
  const html = `<div id="modal-store" class="hidden" style="position:fixed;inset:0;z-index:350;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)">
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;width:min(960px,97vw);max-height:92vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 40px 100px rgba(0,0,0,0.65)">
    <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <span id="store-modal-title" style="font-size:16px;font-weight:700;color:var(--text)">Asset Store</span>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <div style="display:flex;gap:4px" id="store-source-filters">
          <button class="store-src-btn active" data-src="all">All</button>
          <button class="store-src-btn" data-src="internal">Atlantist Store</button>
          <button class="store-src-btn" data-src="external">External</button>
        </div>
        <button onclick="closeStore()" style="background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer;padding:4px 8px;line-height:1">×</button>
      </div>
    </div>
    <div id="store-filters-bar" style="padding:10px 20px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex-shrink:0;background:var(--bg-panel)">
      <div style="display:flex;gap:6px;flex:1">
        <div style="position:relative;flex:1;max-width:280px">
          <input id="store-search" placeholder="Search assets..." style="width:100%;padding:6px 12px 6px 32px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
          <svg style="position:absolute;left:8px;top:50%;transform:translateY(-50%);width:14px;height:14px;opacity:0.4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <select id="store-cat-filter" style="padding:6px 10px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
          <option value="">All Categories</option>
          ${STORE_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <select id="store-sort-filter" style="padding:6px 10px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
          ${SORT_OPTIONS.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}
        </select>
      </div>
      <div id="store-pagination" style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)"></div>
    </div>
    <div id="store-content" style="flex:1;overflow-y:auto;padding:20px">
      <!-- grid injected by JS -->
    </div>
  </div>
</div>`;
  document.body.insertAdjacentHTML('beforeend', html);

  // Source filter buttons
  document.querySelectorAll('.store-src-btn').forEach(btn => {
    btn.style.cssText = 'padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-raised);color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;transition:all 0.12s';
    btn?.addEventListener('click', () => {
      document.querySelectorAll('.store-src-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const src = btn.dataset.src;
      storeState.source = src;
      if (src === 'external') document.getElementById('store-filters-bar').style.display = 'none';
      else document.getElementById('store-filters-bar').style.display = 'flex';
      loadStoreAssets();
    });
  });

  // Search debounce
  const searchInput = document.getElementById('store-search');
  let debounceTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { storeState.query = searchInput.value; loadStoreAssets(); }, 300);
  });
  document.getElementById('store-cat-filter')?.addEventListener('change', e => { storeState.category = e.target.value; loadStoreAssets(); });
  document.getElementById('store-sort-filter')?.addEventListener('change', e => { storeState.sort = e.target.value; loadStoreAssets(); });
}

// ── State ──────────────────────────────────────────────────

const storeState = {
  query: '', category: '', sort: 'newest', source: 'all',
  page: 1, perPage: 20,
  assets: [], external: [], total: 0,
  loading: false,
};

// ── Open / Close ───────────────────────────────────────────

window.openStore = function(pane) {
  ensureStoreModal();
  const modal = document.getElementById('modal-store');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');

  if (pane === 'external') {
    storeState.source = 'external';
    document.querySelectorAll('.store-src-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-src="external"]').classList.add('active');
    document.getElementById('store-filters-bar').style.display = 'none';
  } else if (pane === 'categories') {
    storeState.source = 'all';
    document.querySelectorAll('.store-src-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-src="all"]').classList.add('active');
    document.getElementById('store-filters-bar').style.display = 'flex';
  } else {
    storeState.source = 'all';
    document.querySelectorAll('.store-src-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-src="all"]').classList.add('active');
    document.getElementById('store-filters-bar').style.display = 'flex';
  }

  storeState.page = 1;
  document.getElementById('store-search').value = storeState.query;
  document.getElementById('store-cat-filter').value = storeState.category;
  document.getElementById('store-sort-filter').value = storeState.sort;
  loadStoreAssets();
};

window.closeStore = function() {
  const modal = document.getElementById('modal-store');
  if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
};

// ── API & Loading ──────────────────────────────────────────

async function loadStoreAssets() {
  storeState.loading = true;
  renderStoreLoading();

  const params = new URLSearchParams();
  if (storeState.query) params.set('q', storeState.query);
  if (storeState.category) params.set('category', storeState.category);
  if (storeState.sort) params.set('sort', storeState.sort);
  params.set('page', storeState.page);
  params.set('limit', storeState.perPage);
  if (storeState.source === 'external') params.set('distributor', 'all');

  try {
    const res = await fetch(`/api/store/search?${params.toString()}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data;
    try { data = await res.json(); } catch {
      throw new Error(`Non-JSON response from /store/search`);
    }
    storeState.assets = data.internal || [];
    storeState.external = data.external || [];
    storeState.total = data.total || 0;
    renderStoreGrid();
  } catch (err) {
    console.error('[store] load error:', err);
    document.getElementById('store-content').innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">
      <p>Failed to load assets. <button onclick="loadStoreAssets()" style="color:var(--accent);background:none;border:none;cursor:pointer">Retry</button></p>
    </div>`;
  } finally {
    storeState.loading = false;
  }
}

function renderStoreLoading() {
  document.getElementById('store-content').innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;padding:4px">
    ${Array.from({length: 8}, () => `<div style="background:var(--bg-raised);border-radius:12px;height:180px;animation:storePulse 1.2s infinite alternate"></div>`).join('')}
  </div>`;
}

function renderStoreGrid() {
  const src = storeState.source;
  const internal = src === 'external' ? [] : storeState.assets;
  const external = src === 'all' ? storeState.external : (src === 'external' ? storeState.external : []);

  let html = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">`;

  if (internal.length === 0 && external.length === 0) {
    html += `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 12px;opacity:0.3"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <p style="font-size:14px;margin-bottom:4px">No assets found</p>
      <p style="font-size:12px">Try adjusting your search or filters</p>
    </div>`;
  }

  internal.forEach(asset => { html += renderAssetCard(asset, 'internal'); });
  external.forEach(asset => { html += renderAssetCard(asset, 'external'); });

  html += `</div>`;
  html += renderPagination();
  document.getElementById('store-content').innerHTML = html;
  document.getElementById('store-pagination').innerHTML =
    `${storeState.total} asset${storeState.total !== 1 ? 's' : ''} · Page ${storeState.page}`;
}

function renderPagination() {
  const totalPages = Math.ceil(storeState.total / storeState.perPage) || 1;
  if (totalPages <= 1) return '';
  return `<div style="display:flex;gap:8px;padding:16px 0;justify-content:center;align-items:center">
    <button onclick="storeChangePage(${storeState.page - 1})" ${storeState.page <= 1 ? 'disabled' : ''} style="padding:6px 14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;cursor:pointer;opacity:${storeState.page <= 1 ? '0.4' : '1'}">← Prev</button>
    <span style="font-size:12px;color:var(--text-muted)">${storeState.page} / ${totalPages}</span>
    <button onclick="storeChangePage(${storeState.page + 1})" ${storeState.page >= totalPages ? 'disabled' : ''} style="padding:6px 14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;cursor:pointer;opacity:${storeState.page >= totalPages ? '0.4' : '1'}">Next →</button>
  </div>`;
}

window.storeChangePage = function(page) {
  storeState.page = page;
  loadStoreAssets();
};

// ── Card Rendering ─────────────────────────────────────────

function renderAssetCard(asset, source) {
  const isExternal = source === 'external';
  const distLabel = isExternal ? `<span class="store-dist-badge">${DISTRIBUTOR_LABELS[asset.distributor] || asset.distributor}</span>` : '';
  const priceLabel = isExternal
    ? (asset.price_usd ? `$${asset.price_usd}` : 'Free')
    : (asset.is_paid ? `$${parseFloat(asset.price_usd).toFixed(2)}` : 'Free');
  const priceColor = asset.is_paid ? 'var(--accent)' : 'var(--success)';
  const previewUrl = asset.preview_url || asset.internal_preview || null;
  const preview = previewUrl
    ? `<img src="${previewUrl}" alt="${asset.name || asset.title}" style="width:100%;height:120px;object-fit:cover;border-radius:8px 8px 0 0">`
    : `<div style="width:100%;height:120px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(52,121,196,0.15),rgba(52,121,196,0.05));border-radius:8px 8px 0 0">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(52,121,196,0.4)" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
       </div>`;
  const stars = isExternal ? '' : renderStars(asset.rating_avg || 0);
  const downloadCount = asset.download_count > 0 ? `<span style="font-size:11px;opacity:0.6">${asset.download_count.toLocaleString()} ↓</span>` : '';
  const acquireBtn = isExternal
    ? `<a href="${asset.external_url}${asset.external_url.includes('?') ? '&' : '?'}utm_source=atlantist&utm_medium=store" target="_blank" rel="noopener" style="display:block;width:100%;padding:7px;text-align:center;background:var(--accent);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer">Get →</a>`
    : (asset.is_paid
        ? `<button onclick="window.initiateAcquire(${asset.id})" style="width:100%;padding:7px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;cursor:pointer">Acquire · ${priceLabel}</button>`
        : `<button onclick="window.initiateAcquire(${asset.id})" style="width:100%;padding:7px;background:var(--success);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;cursor:pointer">Free · Get</button>`);
  const externalLinkIcon = isExternal ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>` : '';

  return `<div class="store-card" style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:transform 0.15s,border-color 0.15s" onmouseover="this.style.borderColor='rgba(52,121,196,0.5)';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform='translateY(0)'">
    ${preview}
    <div style="padding:12px">
      <div style="display:flex;align-items:start;gap:6px;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:var(--text);flex:1;line-height:1.3">${asset.name || asset.title}</span>
        ${distLabel}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
        <span style="background:var(--bg-overlay);padding:2px 6px;border-radius:4px">${asset.category}</span>
        ${downloadCount}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        ${stars}
        <span style="font-size:13px;font-weight:700;color:${priceColor}">${priceLabel}</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <div style="flex:1">${acquireBtn}</div>
        <button onclick="event.stopPropagation();addToWishlist(${asset.id}, ${isExternal})" title="Save to Wishlist" style="padding:7px 8px;background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;flex-shrink:0">♡</button>
      </div>
    </div>
  </div>`;
}

function renderStars(rating) {
  const r = parseFloat(rating) || 0;
  const full = Math.floor(r);
  const half = r - full >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  let html = '<div style="display:flex;gap:2px">';
  for (let i = 0; i < full; i++) html += `<svg width="12" height="12" viewBox="0 0 24 24" fill="var(--accent)" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  if (half) html += `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="half${Math.random().toString(36)}"><stop offset="50%" stop-color="var(--accent)"/><stop offset="50%" stop-color="var(--bg-overlay)"/></linearGradient></defs><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="url(#half${Math.random().toString(36)})"/></svg>`;
  for (let i = 0; i < empty; i++) html += `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.3"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  html += `</div>`;
  return html;
}

// ── Acquire Flow ───────────────────────────────────────────

window.initiateAcquire = async function(assetId) {
  try {
    const res = await fetch(`/api/store/assets/${assetId}/acquire`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      showToast(`Could not acquire asset (HTTP ${res.status}): ${text.slice(0, 100)}`, 'error');
      return;
    }
    const ct = (res.headers.get('content-type') || '');
    if (!ct.includes('application/json')) {
      const text = await res.text().catch(() => '');
      showToast(`Unexpected response from acquire endpoint: ${ct} — ${text.slice(0, 100)}`, 'error');
      return;
    }
    const data = await res.json();

    if (data.is_free || data.acquisition) {
      showToast('Asset acquired! Added to your library.', 'success');
      loadStoreAssets();
    } else if (data.client_secret || data.checkout_intent) {
      // Paid asset — show price breakdown modal
      await window.openAcquireBreakdown(assetId);
    }
  } catch (err) {
    showToast('Acquisition failed. Please try again.', 'error');
  }
};

// ── My Assets Panel ────────────────────────────────────────

window.openMyAssets = function(pane) {
  closeStore();
  ensureMyAssetsModal();

  const modal = document.getElementById('modal-my-assets');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
  document.getElementById('ma-title').textContent =
    pane === 'listings' ? 'My Listings' : pane === 'analytics' ? 'Seller Analytics' : 'My Library';
  document.getElementById('ma-content').innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">Loading…</div>';

  if (pane === 'analytics') loadSellerAnalytics();
  else if (pane === 'listings') loadMyListings();
  else loadMyAssets();
};

window.closeMyAssets = function() {
  const m = document.getElementById('modal-my-assets');
  if (m) { m.style.display = 'none'; m.classList.add('hidden'); }
};

function ensureMyAssetsModal() {
  if (document.getElementById('modal-my-assets')) return;
  const html = `<div id="modal-my-assets" class="hidden" style="position:fixed;inset:0;z-index:350;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)">
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;width:min(900px,97vw);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 40px 100px rgba(0,0,0,0.65)">
    <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span id="ma-title" style="font-size:16px;font-weight:700;color:var(--text)">My Assets</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button onclick="window.openUploadModal()" style="padding:7px 14px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;cursor:pointer">+ Upload Asset</button>
        <button onclick="closeMyAssets()" style="background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer;padding:4px 8px">×</button>
      </div>
    </div>
    <div id="ma-content" style="flex:1;overflow-y:auto;padding:20px"></div>
  </div>
</div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function loadMyAssets() {
  try {
    const res = await fetch('/api/store/assets/my-acquisitions', { credentials: 'include' });
    if (!res.ok) {
      const content = document.getElementById('ma-content');
      if (content) content.innerHTML = `<p style="color:var(--error)">Failed to load assets (HTTP ${res.status})</p>`;
      return;
    }
    let assets;
    try { assets = await res.json(); } catch {
      const content = document.getElementById('ma-content');
      if (content) content.innerHTML = `<p style="color:var(--error)">Invalid server response</p>`;
      return;
    }
    const content = document.getElementById('ma-content');

    if (!assets.length) {
      content.innerHTML = `<div style="text-align:center;padding:60px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" style="margin:0 auto 16px;opacity:0.3"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p style="font-size:14px;color:var(--text-muted);margin-bottom:4px">No acquired assets yet</p>
        <p style="font-size:12px;color:var(--text-muted)">Browse the store to find BIM assets</p>
        <button onclick="closeMyAssets();openStore()" style="margin-top:16px;padding:8px 20px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:13px;cursor:pointer">Browse Store</button>
      </div>`;
      return;
    }

    content.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">` +
      assets.map(a => `<div style="display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:10px">
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600;color:var(--text)">${a.title}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${a.category} · Acquired ${new Date(a.acquired_at).toLocaleDateString()}${a.was_paid ? ` · Paid` : ' · Free'}</div>
        </div>
        <button onclick="window.downloadAsset(${a.id}, '${a.title.replace(/'/g, "\\'")}')" style="padding:6px 16px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;cursor:pointer">↓ Download</button>
      </div>`).join('') + `</div>`;
  } catch (err) {
    document.getElementById('ma-content').innerHTML = `<p style="color:var(--error)">Failed to load: ${err.message}</p>`;
  }
}

async function loadMyListings() {
  try {
    const res = await fetch('/api/store/assets/mine', { credentials: 'include' });
    const assets = await res.json();
    const content = document.getElementById('ma-content');

    if (!assets.length) {
      content.innerHTML = `<div style="text-align:center;padding:60px">
        <p style="font-size:14px;color:var(--text-muted)">You haven't uploaded any assets yet.</p>
        <button onclick="closeMyAssets();window.openUploadModal()" style="margin-top:16px;padding:8px 20px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:13px;cursor:pointer">+ Upload Your First Asset</button>
      </div>`;
      return;
    }

    content.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">` +
      assets.map(a => `<div style="display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:10px">
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600;color:var(--text)">${a.title}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${a.category} · ${a.is_public ? 'Published' : a.status} · ${a.price_usd > 0 ? '$' + a.price_usd : 'Free'} · ${a.download_count} downloads</div>
        </div>
        <div style="display:flex;gap:6px">
          ${a.is_public ? '' : `<button onclick="window.publishAsset(${a.id})" style="padding:6px 14px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;cursor:pointer">Publish</button>`}
          <button onclick="window.editAsset(${a.id})" style="padding:6px 14px;background:var(--bg-overlay);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;cursor:pointer">Edit</button>
          <button onclick="window.deleteAsset(${a.id},'${(a.title||'').replace(/'/g,"\\&#39;")}')" title="Delete" style="padding:6px 10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--error);font-size:12px;cursor:pointer">✕</button>
        </div>
      </div>`).join('') + `</div>`;
  } catch (err) {
    document.getElementById('ma-content').innerHTML = `<p style="color:var(--error)">Failed to load: ${err.message}</p>`;
  }
}

async function loadSellerAnalytics() {
  try {
    const res = await fetch('/api/store/assets/payout', { credentials: 'include' });
    const data = await res.json();
    const content = document.getElementById('ma-content');
    const fmt = n => n != null ? `$${parseFloat(n).toFixed(2)}` : '$0.00';

    const txns = data.recent_transactions || [];
    const paidTxns = txns.filter(t => t.is_paid);
    const freeTxns = txns.filter(t => !t.is_paid);

    content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">
      <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--accent)">${data.total_listings || 0}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Total Listings</div>
      </div>
      <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--text)">${data.total_downloads || 0}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Downloads</div>
      </div>
      <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--success)">${fmt(data.gross_revenue)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Gross Revenue</div>
      </div>
      <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#e5a000">${fmt(data.platform_commission_usd)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Platform Fee (10%)</div>
      </div>
      <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--success)">${fmt(data.net_revenue)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Net Earnings</div>
      </div>
      <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--text)">${data.total_views || 0}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Views</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;padding:16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:12px">
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:700;color:var(--success)">${paidTxns.length}</div>
        <div style="font-size:11px;color:var(--text-muted)">Paid Transactions</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:700;color:var(--text-muted)">${freeTxns.length}</div>
        <div style="font-size:11px;color:var(--text-muted)">Free Transfers</div>
      </div>
    </div>

    ${txns.length ? `<div>
      <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-muted)">Recent Transactions</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">
            <th style="text-align:left;padding:6px 8px">Asset</th>
            <th style="text-align:left;padding:6px 8px">Buyer</th>
            <th style="text-align:right;padding:6px 8px">Price</th>
            <th style="text-align:right;padding:6px 8px">Fee</th>
            <th style="text-align:right;padding:6px 8px">Net</th>
            <th style="text-align:left;padding:6px 8px">Date</th>
          </tr>
        </thead>
        <tbody>
          ${txns.map(t => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px;color:var(--text)">${t.asset_title || '—'}</td>
            <td style="padding:8px;color:var(--text-muted)">${t.buyer_name || t.buyer_email || '—'}</td>
            <td style="padding:8px;text-align:right;color:var(--text)">${t.is_paid ? fmt(t.amount_usd) : '<span style="color:var(--text-muted)">Free</span>'}</td>
            <td style="padding:8px;text-align:right;color:#e5a000">${t.is_paid ? fmt(t.commission_usd) : '—'}</td>
            <td style="padding:8px;text-align:right;font-weight:600;color:${t.is_paid ? 'var(--success)' : 'var(--text-muted)'}">${t.is_paid ? '+' + fmt(t.net_usd) : 'Free'}</td>
            <td style="padding:8px;color:var(--text-muted)">${new Date(t.acquired_at).toLocaleDateString()}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<p style="font-size:13px;color:var(--text-muted);margin-top:16px">No transactions yet.</p>'}
    <p style="font-size:11px;color:var(--text-muted);margin-top:20px;line-height:1.6">
      <strong>Commission breakdown:</strong> Seller receives $X | Platform fee: 10% | Listed at: $Z<br>
      Free assets are commission-free. Payouts are instant — funds go directly to your Stripe account.
    </p>`;
  } catch (err) {
    document.getElementById('ma-content').innerHTML = `<p style="color:var(--error)">Failed to load analytics: ${err.message}</p>`;
  }
}

window.downloadAsset = async function(assetId, title) {
  try {
    const res = await fetch(`/api/store/assets/${assetId}/download`, { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      let msg = 'Download failed';
      try { msg = (await res.json()).error || msg; } catch { msg = `HTTP ${res.status}`; }
      showToast(msg, 'error');
      return;
    }
    let data;
    try { data = await res.json(); } catch {
      showToast('Invalid server response', 'error');
      return;
    }
    if (data.download_url) {
      showToast(`Downloading: ${title}`, 'success');
      window.open(data.download_url, '_blank');
    }
  } catch (err) {
    showToast('Download failed', 'error');
  }
};

window.publishAsset = async function(id) {
  try {
    const res = await fetch(`/api/store/assets/${id}/publish`, { method: 'POST', credentials: 'include' });
    if (res.ok) { showToast('Asset published!', 'success'); loadMyListings(); }
    else {
      let msg = 'Failed';
      try { msg = (await res.json()).error || msg; } catch { msg = `HTTP ${res.status}`; }
      showToast(msg, 'error');
    }
  } catch (err) { showToast('Publish failed', 'error'); }
};

window.editAsset = async function(id) {
  try {
    const res = await fetch(`/api/store/asset/${id}`, { credentials: 'include' });
    if (!res.ok) { showToast('Failed to load asset', 'error'); return; }
    const asset = await res.json();
    if (asset.uploader_id !== currentUserId) { showToast('Not authorized', 'error'); return; }

    ensureEditModal();
    document.getElementById('modal-store-edit').style.display = 'flex';
    document.getElementById('modal-store-edit').classList.remove('hidden');
    document.getElementById('edit-id').value = asset.id;
    document.getElementById('edit-title').value = asset.title || '';
    document.getElementById('edit-desc').value = asset.description || '';
    document.getElementById('edit-cat').value = asset.category || 'Scripts';
    document.getElementById('edit-tags').value = (asset.tags || []).join(', ');
    document.getElementById('edit-preview').value = asset.preview_url || '';
    document.getElementById('edit-price').value = asset.price_usd || 0;
    document.getElementById('edit-paid').checked = !!asset.is_paid;
    document.getElementById('edit-version').value = asset.version || '1.0.0';
  } catch (err) { showToast('Failed to load asset', 'error'); }
};

window.closeEditModal = function() {
  const m = document.getElementById('modal-store-edit');
  if (m) { m.style.display = 'none'; m.classList.add('hidden'); }
};

window.submitEdit = async function() {
  const id = document.getElementById('edit-id').value;
  const btn = document.getElementById('edit-submit');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const body = {
      title: document.getElementById('edit-title').value.trim(),
      description: document.getElementById('edit-desc').value.trim(),
      category: document.getElementById('edit-cat').value,
      tags: document.getElementById('edit-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      preview_url: document.getElementById('edit-preview').value.trim() || null,
      price_usd: parseFloat(document.getElementById('edit-price').value) || 0,
      is_paid: document.getElementById('edit-paid').checked,
      version: document.getElementById('edit-version').value.trim() || '1.0.0',
    };
    const res = await fetch(`/api/store/assets/${id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const d = await res.json(); showToast(d.error || 'Save failed', 'error'); return; }
    showToast('Asset updated', 'success');
    closeEditModal();
    loadMyListings();
  } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Save Changes'; }
};

function ensureEditModal() {
  if (document.getElementById('modal-store-edit')) return;
  const s = 'width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box';
  const lbl = 'display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px';
  const html = `<div id="modal-store-edit" class="hidden" style="position:fixed;inset:0;z-index:365;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)">
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;width:min(520px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 40px 100px rgba(0,0,0,0.65)">
    <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      <span style="font-size:15px;font-weight:700;color:var(--text)">Edit Asset</span>
      <button onclick="closeEditModal()" style="margin-left:auto;background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer">×</button>
    </div>
    <div style="padding:20px;display:flex;flex-direction:column;gap:14px">
      <input type="hidden" id="edit-id">
      <div><label style="${lbl}">Title</label><input id="edit-title" style="${s}"></div>
      <div><label style="${lbl}">Description</label><textarea id="edit-desc" rows="3" style="${s};resize:vertical"></textarea></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label style="${lbl}">Category</label><select id="edit-cat" style="${s}">${STORE_CATEGORIES.map(c => '<option value="' + c + '">' + c + '</option>').join('')}</select></div>
        <div><label style="${lbl}">Version</label><input id="edit-version" style="${s}"></div>
      </div>
      <div><label style="${lbl}">Tags (comma-separated)</label><input id="edit-tags" style="${s}"></div>
      <div><label style="${lbl}">Preview Image URL</label><input id="edit-preview" style="${s}"></div>
      <div><label style="${lbl}">Price (USD)</label>
        <div style="display:flex;align-items:center;gap:12px">
          <input id="edit-price" type="number" min="0" step="0.01" style="${s};flex:1">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);cursor:pointer;white-space:nowrap"><input type="checkbox" id="edit-paid" style="accent-color:var(--accent)"> Paid</label>
        </div>
      </div>
      <button id="edit-submit" onclick="submitEdit()" style="width:100%;padding:11px;background:var(--accent);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;cursor:pointer;margin-top:4px">Save Changes</button>
    </div>
  </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ── Upload Modal ────────────────────────────────────────────

window.openUploadModal = function() {
  closeStore();
  closeMyAssets();
  ensureUploadModal();
  const m = document.getElementById('modal-store-upload');
  m.style.display = 'flex';
  m.classList.remove('hidden');
};

window.closeUploadModal = function() {
  const m = document.getElementById('modal-store-upload');
  if (m) { m.style.display = 'none'; m.classList.add('hidden'); }
};

function ensureUploadModal() {
  if (document.getElementById('modal-store-upload')) return;
  const html = `<div id="modal-store-upload" class="hidden" style="position:fixed;inset:0;z-index:360;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)">
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;width:min(540px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 40px 100px rgba(0,0,0,0.65)">
    <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      <span style="font-size:15px;font-weight:700;color:var(--text)">Upload Asset</span>
      <button onclick="closeUploadModal()" style="margin-left:auto;background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer">×</button>
    </div>
    <div style="padding:20px;display:flex;flex-direction:column;gap:14px">
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Title *</label>
        <input id="up-title" placeholder="e.g. W14x90 Column Family" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Description</label>
        <textarea id="up-desc" placeholder="Describe what this asset does, compatibility, use case…" rows="3" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;resize:vertical;box-sizing:border-box"></textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Category *</label>
          <select id="up-cat" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
            ${STORE_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">File Type *</label>
          <input id="up-type" placeholder="e.g. .dyn, .ifc, .json" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Tags (comma-separated)</label>
        <input id="up-tags" placeholder="curtain-wall, aluminum, glazed" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Asset File *</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="up-path" placeholder="Paste URL (or upload below)" style="flex:1;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
          <label id="up-upload-btn" style="padding:8px 14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">
            <span id="up-upload-text">Upload File</span>
            <input type="file" id="up-file-input" style="display:none" onchange="handleFileSelect(this)">
          </label>
        </div>
        <div id="up-upload-status" style="font-size:11px;color:var(--success);margin-top:4px;display:none"></div>
        <div id="up-progress-bar" style="display:none;margin-top:6px;height:4px;background:var(--border);border-radius:4px;overflow:hidden">
          <div id="up-progress-fill" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Preview Image URL</label>
        <input id="up-preview" placeholder="https://..." style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Price (USD)</label>
        <div style="display:flex;align-items:center;gap:12px">
          <input id="up-price" type="number" min="0" step="0.01" placeholder="0 for free" style="flex:1;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);cursor:pointer">
            <input type="checkbox" id="up-paid" style="accent-color:var(--accent)"> Paid asset
          </label>
        </div>
        <div id="up-smart-pricing" style="font-size:11px;color:var(--accent);margin-top:2px;display:none"></div>
        <div id="up-commission-note" style="font-size:11px;color:var(--text-muted);margin-top:4px;display:none">
          2% platform fee. Free assets are commission-free. <a href="/store/commission" target="_blank" style="color:var(--accent)">See pricing →</a>
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">License</label>
        <select id="up-license" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
          <option value="royalty-free">Royalty-Free Commercial</option>
          <option value="cc0">CC0 (Public Domain)</option>
          <option value="cc-by">CC-BY (Attribution Required)</option>
          <option value="custom">Custom License</option>
        </select>
        <input id="up-license-custom" placeholder="Custom license terms…" style="display:none;width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;margin-top:6px;box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Version</label>
        <input id="up-version" value="1.0.0" style="width:100%;padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:8px;padding-top:4px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);cursor:pointer">
          <input type="checkbox" id="up-public" checked style="accent-color:var(--accent)"> List publicly
        </label>
      </div>
      <button id="up-submit" onclick="submitUpload()" style="width:100%;padding:11px;background:var(--accent);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;cursor:pointer;margin-top:4px">Upload Asset</button>
    </div>
  </div>
</div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('up-paid')?.addEventListener('change', e => {
    document.getElementById('up-commission-note').style.display = e.target.checked ? 'block' : 'none';
  });
  document.getElementById('up-license')?.addEventListener('change', e => {
    document.getElementById('up-license-custom').style.display = e.target.value === 'custom' ? 'block' : 'none';
  });
  document.getElementById('up-price')?.addEventListener('input', e => {
    const price = parseFloat(e.target.value) || 0;
    const note = document.getElementById('up-smart-pricing');
    if (note) {
      if (price > 0 && price < 5) {
        note.style.display = 'block';
        note.textContent = `Smart pricing: For assets under $5, we suggest at least $5.00 to avoid Stripe fees (2.9%+$0.30) eating your margin.`;
      } else if (price >= 5) {
        note.style.display = 'block';
        note.textContent = `At $${price.toFixed(2)}, you receive $${(price * 0.98).toFixed(2)} after the 2% platform fee.`;
      } else {
        note.style.display = 'none';
      }
    }
  });
}

window.submitUpload = async function() {
  const btn = document.getElementById('up-submit');
  const title = document.getElementById('up-title').value.trim();
  const file_path = document.getElementById('up-path').value.trim();

  if (!title || !file_path) { showToast('Title and file URL are required', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Uploading…';

  try {
    const res = await fetch('/api/store/assets', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: document.getElementById('up-desc').value.trim(),
        category: document.getElementById('up-cat').value,
        file_type: document.getElementById('up-type').value.trim() || 'unknown',
        file_path,
        preview_url: document.getElementById('up-preview').value.trim() || null,
        version: document.getElementById('up-version').value.trim() || '1.0.0',
        tags: document.getElementById('up-tags').value.split(',').map(t => t.trim()).filter(Boolean),
        price_usd: parseFloat(document.getElementById('up-price').value) || 0,
        is_paid: document.getElementById('up-paid').checked,
        license: document.getElementById('up-license').value,
        is_public: document.getElementById('up-public').checked,
      }),
    });

    if (!res.ok) {
      let msg = 'Upload failed';
      try { msg = (await res.json()).error || msg; } catch { msg = `HTTP ${res.status}`; }
      showToast(msg, 'error');
      btn.disabled = false; btn.textContent = 'Upload Asset';
      return;
    }
    let data;
    try { data = await res.json(); } catch {
      showToast('Invalid server response', 'error');
      btn.disabled = false; btn.textContent = 'Upload Asset';
      return;
    }

    // Auto-publish if public
    if (document.getElementById('up-public').checked) {
      await fetch(`/api/store/assets/${data.id}/publish`, { method: 'POST', credentials: 'include' });
    }

    // Auto-publish if public
    if (document.getElementById('up-public').checked) {
      await fetch(`/api/store/assets/${data.id}/publish`, { method: 'POST', credentials: 'include' });
    }

    showToast('Asset uploaded! Check My Listings to manage it.', 'success');
    closeUploadModal();
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Upload Asset';
  }
};

// ── R2 Direct Upload ─────────────────────────────────────────

window.handleFileSelect = async function(input) {
  const file = input.files[0];
  if (!file) return;

  const statusEl = document.getElementById('up-upload-status');
  const progressBar = document.getElementById('up-progress-bar');
  const progressFill = document.getElementById('up-progress-fill');
  const uploadText = document.getElementById('up-upload-text');

  statusEl.textContent = `Uploading ${file.name}…`;
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--accent)';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';
  uploadText.textContent = 'Uploading…';

  try {
    // Get presigned upload URL from server
    const presignedRes = await fetch(`/api/store/upload-url?filename=${encodeURIComponent(file.name)}&content_type=${encodeURIComponent(file.type || 'application/octet-stream')}`, { credentials: 'include' });
    if (!presignedRes.ok) throw new Error('Failed to get upload URL');
    const { upload_url, public_url, file_key } = await presignedRes.json();

    // Upload directly to R2
    const uploadRes = await fetch(upload_url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });

    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

    progressFill.style.width = '100%';
    statusEl.textContent = `✓ ${file.name} uploaded`;
    statusEl.style.color = 'var(--success)';
    uploadText.textContent = 'Upload Another';

    // Auto-fill file path and type fields
    document.getElementById('up-path').value = public_url;
    const ext = file.name.split('.').pop().toLowerCase();
    const typeMap = { dyn: 'Dynamo', gh: 'Grasshopper', py: 'Python', ifc: 'IFC', obj: 'OBJ', gltf: 'glTF', glb: 'glTF', json: 'JSON', xml: 'XML', rfa: 'Family', skp: 'SketchUp', pdf: 'PDF' };
    if (!document.getElementById('up-type').value.trim()) {
      document.getElementById('up-type').value = ext;
    }
  } catch (err) {
    statusEl.textContent = `Upload failed: ${err.message}`;
    statusEl.style.color = 'var(--error)';
    progressBar.style.display = 'none';
    uploadText.textContent = 'Upload File';
  }
};

// ── Acquire Price Breakdown Modal ────────────────────────────

window.openAcquireBreakdown = async function(assetId) {
  ensureAcquireBreakdownModal();
  const modal = document.getElementById('modal-acquire-breakdown');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');

  const content = document.getElementById('ab-content');
  content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Loading…</div>';

  try {
    const res = await fetch(`/api/store/asset/${assetId}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load asset');
    const asset = await res.json();

    const price = parseFloat(asset.price_usd);
    const platformCommissionUsd = parseFloat((price * 0.02).toFixed(2));
    const stripeFeeUsd = parseFloat((price * 0.029 + 0.30).toFixed(2));
    const buyerTotal = parseFloat((price + stripeFeeUsd).toFixed(2));
    const sellerReceives = parseFloat((price - platformCommissionUsd).toFixed(2));

    content.innerHTML = `
      <div style="text-align:center;padding-bottom:20px;border-bottom:1px solid var(--border)">
        <div style="font-size:16px;font-weight:700;color:var(--text)">${asset.title}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${asset.category} · by ${asset.uploader_name || asset.uploader_email || 'Unknown'}</div>
      </div>

      <div style="padding:20px 0">
        <div style="display:flex;justify-content:space-between;padding:7px 0;font-size:13px;color:var(--text)">
          <span>Asset price</span><span style="font-weight:600">$${price.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;font-size:13px;color:var(--text-muted)">
          <span>Stripe processing (2.9% + $0.30)</span><span style="font-weight:600">$${stripeFeeUsd.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid var(--border);margin-top:6px;font-size:14px;font-weight:700;color:var(--text)">
          <span>Buyer pays</span><span style="color:var(--blue)">$${buyerTotal.toFixed(2)}</span>
        </div>
      </div>

      <div style="background:rgba(59,186,108,0.06);border:1px solid rgba(59,186,108,0.15);border-radius:10px;padding:14px;margin-bottom:16px">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Creator receives</div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px">
          <span style="color:var(--text-dim)">Listing price</span><span>$${price.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:var(--text-muted)">
          <span>Platform fee (2%)</span><span>−$${platformCommissionUsd.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:8px 0 0;border-top:1px solid rgba(59,186,108,0.15);margin-top:4px;font-size:15px;font-weight:700;color:#3bba6c">
          <span>Creator net</span><span>+$${sellerReceives.toFixed(2)}</span>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="btn-confirm-checkout" onclick="confirmAcquireAndCheckout(${assetId})" style="width:100%;padding:12px;background:var(--accent);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;cursor:pointer">Pay $${buyerTotal.toFixed(2)}</button>
        <button onclick="closeAcquireBreakdown()" style="width:100%;padding:10px;background:var(--bg-raised);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:13px;cursor:pointer">Cancel</button>
      </div>

      <div style="text-align:center;padding-top:14px;font-size:11px;color:var(--text-muted)">
        <a href="/store/commission" style="color:var(--text-mid);text-decoration:underline">How pricing works</a> · Secured by Stripe
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--error)">Failed to load: ${err.message}</p>`;
  }
};

window.closeAcquireBreakdown = function() {
  const m = document.getElementById('modal-acquire-breakdown');
  if (m) { m.style.display = 'none'; m.classList.add('hidden'); }
};

// Load Stripe.js if not present
let stripeInstance = null;
async function getStripeInstance() {
  if (stripeInstance) return stripeInstance;
  if (!window.Stripe) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  // Fetch real key from backend config endpoint
  let key = 'pk_test_placeholder';
  try {
    const cfgRes = await fetch('/api/store/config', { credentials: 'include' });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (cfg.stripe_publishable_key) key = cfg.stripe_publishable_key;
    }
  } catch (_) {}
  stripeInstance = window.Stripe(key);
  return stripeInstance;
}

window.confirmAcquireAndCheckout = async function(assetId) {
  const btn = document.getElementById('btn-confirm-checkout');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    // Step 1: Get payment intent from our API
    const res = await fetch(`/api/store/assets/${assetId}/acquire`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      let msg = 'Checkout failed';
      try {
        const errBody = await res.json();
        msg = errBody.error || msg;
      } catch { /* non-JSON error response */ }
      showToast(msg, 'error');
      btn.disabled = false; btn.textContent = 'Try Again';
      return;
    }
    let data;
    try { data = await res.json(); } catch {
      showToast('Invalid server response', 'error');
      btn.disabled = false; btn.textContent = 'Try Again';
      return;
    }

    if (data.checkout_intent && data.url) {
      // Redirect to Stripe hosted checkout
      window.location.href = data.url;
      return;
    }

    if (data.client_secret) {
      // Use Stripe.js for embedded checkout
      const stripe = await getStripeInstance();

      // Redirect to Stripe hosted checkout page with the payment intent
      const result = await stripe.confirmPayment({
        client_secret: data.client_secret,
        confirmParams: {
          return_url: window.location.origin + '/app?store_success=1&asset=' + assetId,
        },
      });

      if (result.error) {
        showToast(result.error.message || 'Payment failed', 'error');
        btn.disabled = false;
        btn.textContent = 'Try Again';
      }
      // On success, Stripe redirects to return_url
      return;
    }

    // Fallback: free acquisition
    if (data.is_free) {
      showToast('Asset acquired! Added to your library.', 'success');
      closeAcquireBreakdown();
      loadStoreAssets();
    }
  } catch (err) {
    showToast('Checkout failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Try Again';
  }
};

function ensureAcquireBreakdownModal() {
  if (document.getElementById('modal-acquire-breakdown')) return;
  const html = `<div id="modal-acquire-breakdown" class="hidden" style="position:fixed;inset:0;z-index:370;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)">
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;width:min(440px,95vw);overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,0.65)">
      <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
        <span style="font-size:15px;font-weight:700;color:var(--text)">Confirm Purchase</span>
        <button onclick="closeAcquireBreakdown()" style="margin-left:auto;background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer">×</button>
      </div>
      <div id="ab-content" style="padding:24px"></div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ── Toast helper ────────────────────────────────────────────

function showToast(msg, type = 'info') {
  const colors = { success: 'var(--success)', error: 'var(--error)', info: 'var(--accent)', warning: '#e5a000' };
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;background:var(--bg-raised);border:1px solid ${colors[type] || colors.info};border-radius:10px;color:var(--text);font-size:13px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:360px;animation:toastIn 0.2s ease`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

// ── CSS animation ───────────────────────────────────────────

if (!document.getElementById('store-css')) {
  const style = document.createElement('style');
  style.id = 'store-css';
  style.textContent = `
    @keyframes storePulse { 0% { opacity: 0.4 } 100% { opacity: 0.7 } }
    @keyframes toastIn { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .store-card:hover { box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
    .store-dist-badge { font-size:10px;font-weight:600;background:rgba(52,121,196,0.15);color:var(--accent);padding:2px 6px;border-radius:4px;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;flex-shrink:0 }
    .store-src-btn.active { background:var(--accent) !important;color:white !important;border-color:var(--accent) !important }
    .store-star-btn { background:none;border:none;padding:2px;cursor:pointer;font-size:18px;line-height:1 }
    .store-star-btn.selected { color:#f59e0b }
    .store-star-btn:not(.selected) { color:var(--text-muted) }
  `;
  document.head.appendChild(style);
}

// ── Asset Detail Modal ──────────────────────────────────────────

window.openAssetDetail = async function(assetId) {
  ensureAssetDetailModal();
  const modal = document.getElementById('modal-store-detail');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
  document.getElementById('sd-content').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Loading…</div>';

  try {
    const [assetRes, reviewsRes] = await Promise.all([
      fetch(`/api/store/asset/${assetId}`, { credentials: 'include' }),
      fetch(`/api/store/asset/${assetId}/reviews`, { credentials: 'include' }),
    ]);
    if (!assetRes.ok) throw new Error('Failed to load asset');
    const asset = await assetRes.json();
    const reviews = reviewsRes.ok ? await reviewsRes.json() : [];

    const stars = renderStars(asset.rating_avg || 0);
    const price = asset.is_paid ? `$${parseFloat(asset.price_usd).toFixed(2)}` : 'Free';
    const priceColor = asset.is_paid ? 'var(--accent)' : 'var(--success)';
    const canReview = asset.uploader_id !== currentUserId; // set by acquire flow
    const preview = asset.preview_url
      ? `<img src="${asset.preview_url}" alt="${asset.title}" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px">`
      : `<div style="width:100%;height:160px;background:linear-gradient(135deg,rgba(52,121,196,0.15),rgba(52,121,196,0.05));border-radius:12px;display:flex;align-items:center;justify-content:center"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(52,121,196,0.3)" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>`;

    let reviewsHtml = '';
    if (!reviews.length) {
      reviewsHtml = `<p style="font-size:13px;color:var(--text-muted);padding:12px 0">No reviews yet. Be the first!</p>`;
    } else {
      reviewsHtml = reviews.map(r => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">${r.reviewer_name || 'User'}</span>
          ${renderStarsSmall(r.rating)}
          <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${new Date(r.created_at).toLocaleDateString()}</span>
        </div>
        ${r.body ? `<p style="font-size:12px;color:var(--text-muted);line-height:1.5">${r.body}</p>` : ''}
      </div>`).join('');
    }

    document.getElementById('sd-content').innerHTML = `
      <div style="display:grid;grid-template-columns:260px 1fr;gap:24px;align-items:start">
        <div>
          ${preview}
          <div style="margin-top:12px">
            <div style="font-size:20px;font-weight:700;color:${priceColor};margin-bottom:4px">${price}</div>
            <div style="font-size:12px;color:var(--text-muted)">${asset.category} · v${asset.version}</div>
            <div style="display:flex;align-items:center;gap:4px;margin-top:8px">${stars} <span style="font-size:12px;color:var(--text-muted)">${asset.rating_avg ? parseFloat(asset.rating_avg).toFixed(1) : '0.0'} (${asset.review_count || 0})</span></div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${asset.download_count || 0} downloads</div>
          </div>
        </div>
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:6px">${asset.title}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">By ${asset.uploader_name || asset.uploader_email || 'Unknown'}</div>
          ${asset.description ? `<p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:16px">${asset.description}</p>` : ''}
          ${asset.tags && asset.tags.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${asset.tags.map(t => `<span style="font-size:11px;background:var(--bg-overlay);padding:3px 8px;border-radius:4px;color:var(--text-muted)">${t}</span>`).join('')}</div>` : ''}
          ${asset.compatibility ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:16px"><strong>Compatibility:</strong> ${asset.compatibility}</div>` : ''}
        </div>
      </div>
      <div style="margin-top:24px;border-top:1px solid var(--border);padding-top:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <span style="font-size:14px;font-weight:700;color:var(--text)">Reviews</span>
          ${currentUserId && asset.uploader_id !== currentUserId ? `<button onclick="toggleReviewForm(${asset.id})" style="padding:5px 14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;cursor:pointer;font-weight:600">Write Review</button>` : ''}
        </div>
        <div id="review-form-wrap" style="display:none;margin-bottom:16px;padding:14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:10px">
          <div style="display:flex;gap:4px;margin-bottom:8px" id="review-stars-row">
            ${[1,2,3,4,5].map(i => `<button class="store-star-btn" data-star="${i}" onclick="selectReviewStar(${i})">★</button>`).join('')}
          </div>
          <textarea id="review-body" placeholder="Share your experience with this asset…" rows="2" style="width:100%;padding:8px 10px;background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;resize:vertical;outline:none;box-sizing:border-box;margin-bottom:8px"></textarea>
          <button id="review-submit-btn" onclick="submitReview(${asset.id})" style="padding:7px 18px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:12px;font-weight:600;cursor:pointer">Submit Review</button>
        </div>
        ${reviewsHtml}
      </div>
    `;
  } catch (err) {
    document.getElementById('sd-content').innerHTML = `<p style="color:var(--error);padding:20px">Failed to load: ${err.message}</p>`;
  }
};

window.closeAssetDetail = function() {
  const m = document.getElementById('modal-store-detail');
  if (m) { m.style.display = 'none'; m.classList.add('hidden'); }
};

function ensureAssetDetailModal() {
  if (document.getElementById('modal-store-detail')) return;
  const html = `<div id="modal-store-detail" class="hidden" style="position:fixed;inset:0;z-index:360;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)">
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;width:min(720px,95vw);max-height:88vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 40px 100px rgba(0,0,0,0.65)">
      <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        <span style="font-size:16px;font-weight:700;color:var(--text)">Asset Detail</span>
        <div style="margin-left:auto"><button onclick="closeAssetDetail()" style="background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer;padding:4px 8px">×</button></div>
      </div>
      <div id="sd-content" style="flex:1;overflow-y:auto;padding:24px"></div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// Update card clicks to open detail modal for internal assets
// Patch renderAssetCard to add click handler
const _renderAssetCard = renderAssetCard;
renderAssetCard = function(asset, source) {
  const card = _renderAssetCard(asset, source);
  if (source === 'internal') {
    return card.replace('<div class="store-card"', '<div class="store-card" style="cursor:pointer" onclick="openAssetDetail(' + asset.id + ')"');
  }
  return card;
};

function renderStarsSmall(rating) {
  const r = parseFloat(rating) || 0;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<svg width="12" height="12" viewBox="0 0 24 24" fill="${i <= Math.round(r) ? '#f59e0b' : 'none'}" stroke="${i <= Math.round(r) ? '#f59e0b' : 'var(--text-muted)'}" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }
  return '<div style="display:flex;gap:2px;align-items:center">' + html + '</div>';
}

// ── Review Helpers ──────────────────────────────────────────────
let selectedReviewRating = 0;

window.toggleReviewForm = function(assetId) {
  const wrap = document.getElementById('review-form-wrap');
  if (!wrap) return;
  wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
  selectedReviewRating = 0;
  document.querySelectorAll('#review-stars-row .store-star-btn').forEach(b => b.classList.remove('selected'));
};

window.selectReviewStar = function(n) {
  selectedReviewRating = n;
  document.querySelectorAll('#review-stars-row .store-star-btn').forEach(b => {
    b.classList.toggle('selected', parseInt(b.dataset.star) <= n);
  });
};

window.submitReview = async function(assetId) {
  if (!selectedReviewRating) { showToast('Select a star rating', 'warning'); return; }
  const body = document.getElementById('review-body').value.trim();
  const btn = document.getElementById('review-submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const res = await fetch(`/api/store/asset/${assetId}/reviews`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: selectedReviewRating, body }),
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error || 'Failed', 'error'); return; }
    showToast('Review submitted!', 'success');
    openAssetDetail(assetId); // refresh detail modal
  } catch (err) { showToast('Failed to submit review', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Submit Review'; }
};

// ── Wishlist Helpers ────────────────────────────────────────────

window.addToWishlist = async function(assetId, isExternal) {
  try {
    const body = isExternal ? { external_asset_id: assetId } : { internal_asset_id: assetId };
    const res = await fetch('/api/store/wishlist', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error || 'Failed', 'error'); return; }
    showToast('Saved to wishlist', 'success');
  } catch (err) { showToast('Failed to save', 'error'); }
};

// ── Delete Asset ────────────────────────────────────────────────

window.deleteAsset = async function(id, title) {
  if (!confirm(`Delete "${title || 'this asset'}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/store/assets/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) { const d = await res.json(); showToast(d.error || 'Delete failed', 'error'); return; }
    showToast('Asset deleted', 'success');
    loadMyListings();
  } catch (err) { showToast('Delete failed', 'error'); }
};

// ── Store Success Handler (post-Stripe checkout) ────────────────

(function handleStoreSuccess() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('store_success') === '1') {
    const assetId = params.get('asset');
    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('store_success');
    url.searchParams.delete('asset');
    window.history.replaceState({}, '', url.toString());
    // Show confirmation
    setTimeout(() => {
      showToast('Asset purchased! Check your library.', 'success');
      loadStoreAssets();
    }, 500);
  }
})();

// ── User ID helper (set after auth check) ───────────────────────
let currentUserId = null;
(async function () {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      let user;
      try { user = await res.json(); } catch { /* non-JSON auth response */ }
      if (user?.id) currentUserId = user.id;
    }
  } catch (_) { /* anon session */ }
})();