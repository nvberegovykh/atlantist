/**
 * Atlantist Cloud OS Explorer
 * Full-screen multiserver cloud filesystem navigator.
 * Mounts before BIM canvas; replaces legacy entry-screen card grid.
 *
 * Sections:
 *   - Projects (Atlantist DB — user's own + shared)
 *   - Drive (Google Drive BIM folders — RVT/RFA/DWG/IFC)
 *   - Templates (read-only starter library)
 *   - Shared with me (team invites)
 *   - Recent (last 20 opened across all sources)
 *   - Trash
 *
 * Actions per file type:
 *   Project (.rvt / Atlantist):  Edit (open in BIM) | View (read-only) | Play (walkthrough) | Markup | Versions | Share | Rename | Duplicate | Download | Delete
 *   Drive file:                  Import | View | Download | Share | Rename
 *   Folder:                      Open | Rename | Share | Delete
 *   Schedule (.xlsx):            Open as Schedule | Download
 *   PDF:                         Markup | Download | Share
 */

(function () {
  'use strict';

  /* ── Constants ────────────────────────────────────────────────────────────── */
  const VIEWS = { grid: 'grid', list: 'list' };
  const SECTIONS = {
    recent:    { label: 'Recents',       icon: iconClock(),      source: 'recent' },
    projects:  { label: 'My Projects',   icon: iconFolder(),     source: 'projects' },
    shared:    { label: 'Shared with Me',icon: iconTeam(),       source: 'shared' },
    drive:     { label: 'Google Drive',  icon: iconDrive(),      source: 'drive' },
    templates: { label: 'Templates',     icon: iconTemplate(),   source: 'templates' },
    trash:     { label: 'Trash',         icon: iconTrash(),      source: 'trash' },
  };

  const FILE_ICONS = {
    rvt:  { emoji: '🏗️', css: 'badge-rvt' },
    rfa:  { emoji: '🧩', css: 'badge-rfa' },
    ifc:  { emoji: '🔷', css: 'badge-ifc' },
    dwg:  { emoji: '📐', css: 'badge-dwg' },
    dxf:  { emoji: '📏', css: 'badge-dxf' },
    xlsx: { emoji: '📊', css: 'badge-xlsx' },
    pdf:  { emoji: '📄', css: 'badge-pdf' },
    proj: { emoji: '🏛️', css: 'badge-proj' },
    folder:{ emoji: '📁', css: 'badge-folder' },
  };

  /* ── State ────────────────────────────────────────────────────────────────── */
  let _view = VIEWS.grid;
  let _section = 'recent';
  let _navStack = [{ id: null, label: 'Home', section: 'recent' }];
  let _items = [];
  let _selected = new Set();   // item IDs
  let _searchQ = '';
  let _sortBy = 'modified';
  let _loading = false;
  let _driveFolder = null;     // current Drive folder ID if inside Drive
  let _ctxTarget = null;
  let _userInitials = 'A';
  let _storageUsed = 0;
  let _storageTotal = 10 * 1024 * 1024 * 1024; // 10 GB default

  /* ── Mount ─────────────────────────────────────────────────────────────────── */
  window.CloudExplorer = {
    mount,
    unmount,
    open,
  };

  function mount(opts = {}) {
    if (document.getElementById('cloud-explorer')) return;
    _userInitials = opts.initials || 'A';
    _buildShell();
    _bindGlobal();
    _navigate('recent');
    // Ensure CSS is loaded
    if (!document.querySelector('link[href*="explorer.css"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/css/explorer.css';
      document.head.appendChild(l);
    }
  }

  function unmount() {
    const el = document.getElementById('cloud-explorer');
    if (!el) return;
    el.classList.add('expl-hidden');
    setTimeout(() => el.remove(), 300);
    document.removeEventListener('click', _closeCtxMenu);
    document.removeEventListener('keydown', _globalKey);
  }

  function open(projectId) {
    unmount();
    if (window.openProject) window.openProject(projectId);
    else if (window._bootProject) window._bootProject(projectId);
  }

  /* ── Shell HTML ───────────────────────────────────────────────────────────── */
  function _buildShell() {
    const el = document.createElement('div');
    el.id = 'cloud-explorer';
    el.innerHTML = `
      <!-- Top bar -->
      <div id="expl-topbar">
        <div id="expl-logo">ATLAN<span>IST</span></div>
        <div id="expl-nav-btns">
          <button class="expl-nav-btn" id="expl-back"  title="Back"    disabled>‹</button>
          <button class="expl-nav-btn" id="expl-fwd"   title="Forward" disabled>›</button>
        </div>
        <!-- Breadcrumb -->
        <div id="expl-breadcrumb"></div>
        <!-- Search -->
        <div id="expl-search-wrap">
          <span id="expl-search-icon">${iconSearch(14)}</span>
          <input id="expl-search" placeholder="Search…" autocomplete="off" spellcheck="false"/>
        </div>
        <!-- View toggle -->
        <div id="expl-view-btns">
          <button class="expl-view-btn active" data-view="grid" title="Grid view">${iconGrid()}</button>
          <button class="expl-view-btn"        data-view="list" title="List view">${iconList()}</button>
        </div>
        <!-- Profile -->
        <button id="expl-profile-btn" title="Account">${_userInitials}</button>
      </div>

      <!-- Body -->
      <div id="expl-body">
        <!-- Sidebar -->
        <nav id="expl-sidebar">
          <div class="expl-sidebar-section">
            <div class="expl-sidebar-label">Locations</div>
            ${Object.entries(SECTIONS).map(([k, s]) => `
              <button class="expl-sidebar-item${k === 'recent' ? ' active' : ''}" data-section="${k}">
                ${s.icon} <span>${s.label}</span>
              </button>
            `).join('')}
          </div>
          <div class="expl-sidebar-section" id="expl-sidebar-tags" style="display:none">
            <div class="expl-sidebar-label">Tags</div>
          </div>
        </nav>

        <!-- Content -->
        <div id="expl-content">
          <!-- Action bar -->
          <div id="expl-action-bar" class="no-selection">
            <span id="expl-selection-label" style="display:none"></span>
            <div class="expl-action-group" id="expl-actions-ctx" style="display:none"></div>
            <div style="flex:1"></div>
            <select id="expl-sort-select">
              <option value="modified">Modified</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="type">Type</option>
            </select>
            <div class="expl-action-sep"></div>
            <button id="expl-upload-btn" class="expl-action-btn secondary" title="Upload file">${iconUpload(13)} Upload</button>
            <button id="expl-new-btn" title="New project">${iconPlus(13)} New Project</button>
          </div>

          <!-- Scroll area -->
          <div id="expl-scroll" style="position:relative">
            <!-- Drop overlay -->
            <div id="expl-drop-overlay">
              ${iconUpload(48)}
              <p>Drop files to upload</p>
              <span style="font-size:13px;color:rgba(255,255,255,0.4)">RVT, RFA, IFC, DWG, XLSX, PDF</span>
            </div>
            <!-- Content injected here -->
            <div id="expl-grid"></div>
            <div id="expl-empty" style="display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:60px;color:rgba(255,255,255,0.3);text-align:center">
              ${iconFolder(48)}
              <h3 style="font-size:18px;font-weight:600;color:rgba(255,255,255,0.5);margin:0">Nothing here yet</h3>
              <p style="font-size:13px;margin:0">Create a new project or upload a BIM file to get started.</p>
              <button onclick="window.CloudExplorer && CloudExplorer._showNewProjectModal()" style="margin-top:8px;padding:9px 20px;border-radius:9px;border:none;background:#6c8bff;color:#fff;font-size:13px;font-weight:600;cursor:pointer">
                + New Project
              </button>
            </div>
          </div>

          <!-- Status bar -->
          <div id="expl-statusbar">
            <span id="expl-status-count">—</span>
            <div id="expl-storage-bar-wrap">
              <span style="font-size:11px;color:rgba(255,255,255,0.3)" id="expl-storage-label"></span>
              <div id="expl-storage-bar"><div id="expl-storage-bar-fill" style="width:0%"></div></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Context menu (hidden) -->
      <div id="expl-ctx-menu" style="display:none"></div>

      <!-- Upload queue -->
      <div id="expl-upload-queue"></div>
    `;
    document.body.appendChild(el);
  }

  /* ── Global bindings ──────────────────────────────────────────────────────── */
  function _bindGlobal() {
    // Sidebar navigation
    document.querySelectorAll('.expl-sidebar-item').forEach(btn => {
      btn.addEventListener('click', () => _navigate(btn.dataset.section));
    });

    // View toggle
    document.querySelectorAll('.expl-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _view = btn.dataset.view;
        document.querySelectorAll('.expl-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === _view));
        _render();
      });
    });

    // Nav buttons
    document.getElementById('expl-back').addEventListener('click', _goBack);
    document.getElementById('expl-fwd').addEventListener('click',  _goFwd);

    // Search
    const searchEl = document.getElementById('expl-search');
    searchEl.addEventListener('input', () => {
      _searchQ = searchEl.value.toLowerCase();
      _render();
    });

    // Sort
    document.getElementById('expl-sort-select').addEventListener('change', e => {
      _sortBy = e.target.value;
      _render();
    });

    // New project
    document.getElementById('expl-new-btn').addEventListener('click', _showNewProjectModal);

    // Upload
    document.getElementById('expl-upload-btn').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.rvt,.rfa,.ifc,.dwg,.dxf,.xlsx,.pdf';
      inp.multiple = true;
      inp.onchange = e => _uploadFiles(Array.from(e.target.files));
      inp.click();
    });

    // Drag and drop on scroll area
    const scroll = document.getElementById('expl-scroll');
    const dropOverlay = document.getElementById('expl-drop-overlay');
    scroll.addEventListener('dragenter', e => { e.preventDefault(); dropOverlay.classList.add('active'); });
    scroll.addEventListener('dragleave', e => { if (!scroll.contains(e.relatedTarget)) dropOverlay.classList.remove('active'); });
    scroll.addEventListener('dragover', e => e.preventDefault());
    scroll.addEventListener('drop', e => {
      e.preventDefault();
      dropOverlay.classList.remove('active');
      _uploadFiles(Array.from(e.dataTransfer.files));
    });

    // Close context menu
    document.addEventListener('click', _closeCtxMenu);
    // Keyboard
    document.addEventListener('keydown', _globalKey);

    // Expose for inline onclick
    window.CloudExplorer._showNewProjectModal = _showNewProjectModal;
  }

  function _globalKey(e) {
    if (!document.getElementById('cloud-explorer')) return;
    if (e.key === 'Escape') { _selected.clear(); _updateActionBar(); _closeCtxMenu(); }
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      _items.forEach(i => _selected.add(i.id));
      _render();
    }
    if (e.key === 'Enter' && _selected.size === 1) {
      const item = _items.find(i => i.id === [..._selected][0]);
      if (item) _openItem(item);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && _selected.size > 0 && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      _deleteSelected();
    }
  }

  /* ── Navigation ───────────────────────────────────────────────────────────── */
  let _fwdStack = [];
  const _fwdPointer = [];

  function _navigate(section, opts = {}) {
    _section = section;
    _driveFolder = opts.driveFolder || null;
    _selected.clear();
    const label = opts.label || SECTIONS[section]?.label || section;
    _navStack.push({ id: opts.id || null, label, section, driveFolder: _driveFolder });
    _fwdStack = [];
    _updateSidebar();
    _updateBreadcrumb();
    _updateNavBtns();
    _loadSection();
  }

  function _goBack() {
    if (_navStack.length <= 1) return;
    _fwdStack.push(_navStack.pop());
    const prev = _navStack[_navStack.length - 1];
    _section = prev.section;
    _driveFolder = prev.driveFolder || null;
    _selected.clear();
    _updateSidebar();
    _updateBreadcrumb();
    _updateNavBtns();
    _loadSection();
  }

  function _goFwd() {
    if (_fwdStack.length === 0) return;
    const next = _fwdStack.pop();
    _navStack.push(next);
    _section = next.section;
    _driveFolder = next.driveFolder || null;
    _selected.clear();
    _updateSidebar();
    _updateBreadcrumb();
    _updateNavBtns();
    _loadSection();
  }

  function _updateNavBtns() {
    document.getElementById('expl-back').disabled = _navStack.length <= 1;
    document.getElementById('expl-fwd').disabled  = _fwdStack.length === 0;
  }

  function _updateSidebar() {
    document.querySelectorAll('.expl-sidebar-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.section === _section);
    });
  }

  function _updateBreadcrumb() {
    const el = document.getElementById('expl-breadcrumb');
    el.innerHTML = _navStack.map((crumb, i) => {
      const isLast = i === _navStack.length - 1;
      return `
        ${i > 0 ? '<span class="expl-crumb-sep">›</span>' : ''}
        <button class="expl-crumb${isLast ? ' active' : ''}" data-idx="${i}">${crumb.label}</button>
      `;
    }).join('');
    el.querySelectorAll('.expl-crumb:not(.active)').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        _fwdStack = _navStack.splice(idx + 1);
        const crumb = _navStack[_navStack.length - 1];
        _section = crumb.section;
        _driveFolder = crumb.driveFolder || null;
        _selected.clear();
        _updateSidebar();
        _updateBreadcrumb();
        _updateNavBtns();
        _loadSection();
      });
    });
  }

  /* ── Data loading ─────────────────────────────────────────────────────────── */
  async function _loadSection() {
    _loading = true;
    _showSkeletons();
    try {
      switch (_section) {
        case 'recent':    _items = await _fetchRecent();    break;
        case 'projects':  _items = await _fetchProjects();  break;
        case 'shared':    _items = await _fetchShared();    break;
        case 'drive':     _items = await _fetchDrive();     break;
        case 'templates': _items = await _fetchTemplates(); break;
        case 'trash':     _items = await _fetchTrash();     break;
        default:          _items = [];
      }
    } catch (err) {
      console.error('[Explorer] load failed:', err);
      _items = [];
    }
    _loading = false;
    _render();
    _updateStorage();
  }

  async function _api(method, path, body) {
    const uuid = localStorage.getItem('atlantist_session_uuid');
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(uuid ? { 'X-Session-UUID': uuid } : {}),
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  async function _fetchRecent() {
    try {
      const data = await _api('GET', '/api/explorer/recent');
      return data.items || [];
    } catch {
      // Fallback: fetch projects sorted by last_opened
      try {
        const data = await _api('GET', '/api/projects');
        return (data.projects || data || []).slice(0, 20).map(_projectToItem);
      } catch { return []; }
    }
  }

  async function _fetchProjects() {
    try {
      const data = await _api('GET', '/api/projects');
      const rows = data.projects || data || [];
      return rows.map(_projectToItem);
    } catch { return []; }
  }

  async function _fetchShared() {
    try {
      const data = await _api('GET', '/api/explorer/shared');
      return data.items || [];
    } catch {
      // Fallback: same as projects (shared will include role≠owner)
      const all = await _fetchProjects();
      return all.filter(i => i.meta?.my_role && i.meta.my_role !== 'owner');
    }
  }

  async function _fetchDrive() {
    try {
      const folderId = _driveFolder || 'root';
      const data = await _api('GET', `/api/drive/list?folderId=${encodeURIComponent(folderId)}`);
      const files = data.files || data.items || [];
      return files.map(_driveFileToItem);
    } catch { return []; }
  }

  async function _fetchTemplates() {
    try {
      const data = await _api('GET', '/api/explorer/templates');
      return data.items || _defaultTemplates();
    } catch { return _defaultTemplates(); }
  }

  async function _fetchTrash() {
    try {
      const data = await _api('GET', '/api/explorer/trash');
      return data.items || [];
    } catch { return []; }
  }

  function _projectToItem(p) {
    return {
      id: p.id,
      name: p.name || p.slug || 'Untitled',
      type: 'proj',
      source: 'atlantist',
      size: p.storage_bytes || 0,
      modified: p.last_opened_at || p.updated_at || p.created_at,
      isLive: p.live_session_count > 0,
      members: parseInt(p.member_count) || 1,
      meta: p,
    };
  }

  function _driveFileToItem(f) {
    const ext = (f.name || '').split('.').pop().toLowerCase();
    const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
    return {
      id: f.id,
      name: f.name,
      type: isFolder ? 'folder' : (FILE_ICONS[ext] ? ext : 'file'),
      source: 'drive',
      driveId: f.id,
      size: parseInt(f.size) || 0,
      modified: f.modifiedTime,
      isFolder,
      meta: f,
    };
  }

  function _defaultTemplates() {
    return [
      { id: 'tpl-residential', name: 'Residential House', type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Residential' } },
      { id: 'tpl-commercial',  name: 'Commercial Office',  type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Commercial' } },
      { id: 'tpl-blank',       name: 'Blank Project',      type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Custom' } },
    ];
  }

  /* ── Rendering ────────────────────────────────────────────────────────────── */
  function _render() {
    const grid = document.getElementById('expl-grid');
    const empty = document.getElementById('expl-empty');
    if (!grid) return;

    let items = _items;

    // Filter
    if (_searchQ) {
      items = items.filter(i => i.name.toLowerCase().includes(_searchQ));
    }

    // Sort
    items = [...items].sort((a, b) => {
      // Folders always first
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      switch (_sortBy) {
        case 'name': return a.name.localeCompare(b.name);
        case 'size': return (b.size || 0) - (a.size || 0);
        case 'type': return (a.type || '').localeCompare(b.type || '');
        default:     return (new Date(b.modified || 0)) - (new Date(a.modified || 0));
      }
    });

    if (items.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'flex';
    } else {
      grid.style.display = '';
      empty.style.display = 'none';
    }

    grid.className = _view === VIEWS.list ? 'list-mode' : '';

    if (_view === VIEWS.list) {
      grid.innerHTML = `
        <div class="expl-list-header">
          <span></span><span></span>
          <span>Name</span>
          <span>Type</span>
          <span>Size</span>
          <span>Modified</span>
          <span></span>
        </div>
        ${items.map(item => _renderRow(item)).join('')}
      `;
    } else {
      grid.innerHTML = items.map(item => _renderCard(item)).join('');
    }

    // Bind click events
    grid.querySelectorAll('[data-item-id]').forEach(el => {
      const id = el.dataset.itemId;
      el.addEventListener('click', e => _handleItemClick(e, id));
      el.addEventListener('dblclick', () => {
        const item = _items.find(i => i.id === id);
        if (item) _openItem(item);
      });
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        _showCtxMenu(e, id);
      });
    });

    _updateActionBar();
    _updateStatusBar(items.length);
  }

  function _renderCard(item) {
    const fi = FILE_ICONS[item.type] || FILE_ICONS['proj'];
    const sel = _selected.has(item.id);
    const modStr = _fmtDate(item.modified);
    const sizeStr = item.size ? _fmtSize(item.size) : '';

    return `
      <div class="expl-card${sel ? ' selected' : ''}" data-item-id="${item.id}">
        ${item.isLive ? '<div class="expl-card-live">Live</div>' : ''}
        <div class="expl-card-check">${sel ? iconCheck() : ''}</div>
        <div class="expl-card-thumb">
          ${item.type === 'folder'
            ? `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
            : `<span style="font-size:38px">${fi.emoji}</span>`
          }
          ${item.type !== 'folder' ? `<span class="expl-card-type-badge ${fi.css}">${item.type.toUpperCase()}</span>` : ''}
        </div>
        <div class="expl-card-info">
          <div class="expl-card-name" title="${_esc(item.name)}">${_esc(item.name)}</div>
          <div class="expl-card-meta">${[modStr, sizeStr].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
    `;
  }

  function _renderRow(item) {
    const fi = FILE_ICONS[item.type] || FILE_ICONS['proj'];
    const sel = _selected.has(item.id);
    const actions = _itemActions(item);

    return `
      <div class="expl-row${sel ? ' selected' : ''}" data-item-id="${item.id}">
        <input type="checkbox" class="expl-row-check" ${sel ? 'checked' : ''} onclick="event.stopPropagation()">
        <span class="expl-row-icon">${item.type === 'folder' ? '📁' : fi.emoji}</span>
        <span class="expl-row-name">${_esc(item.name)}</span>
        <span class="expl-row-type">${item.type.toUpperCase()}</span>
        <span class="expl-row-size">${item.size ? _fmtSize(item.size) : '—'}</span>
        <span class="expl-row-mod">${_fmtDate(item.modified) || '—'}</span>
        <span class="expl-row-actions">
          ${actions.slice(0, 3).map(a => `
            <button class="expl-row-action-btn" data-action="${a.id}" title="${a.label}">${a.label}</button>
          `).join('')}
        </span>
      </div>
    `;
  }

  function _showSkeletons() {
    const grid = document.getElementById('expl-grid');
    if (!grid) return;
    grid.style.display = '';
    document.getElementById('expl-empty').style.display = 'none';
    grid.className = '';
    grid.innerHTML = Array(8).fill(0).map(() =>
      `<div class="expl-skeleton expl-skel-card"></div>`
    ).join('');
  }

  /* ── Action bar ───────────────────────────────────────────────────────────── */
  function _updateActionBar() {
    const bar        = document.getElementById('expl-action-bar');
    const labelEl    = document.getElementById('expl-selection-label');
    const ctxEl      = document.getElementById('expl-actions-ctx');
    const count      = _selected.size;

    if (count === 0) {
      bar.classList.add('no-selection');
      labelEl.style.display = 'none';
      ctxEl.style.display = 'none';
      return;
    }

    bar.classList.remove('no-selection');
    labelEl.style.display = '';
    ctxEl.style.display = '';
    labelEl.innerHTML = `<strong>${count}</strong> selected`;

    const items = _items.filter(i => _selected.has(i.id));
    const primary = items[0];
    const actions = count === 1 ? _itemActions(primary) : _multiActions();

    ctxEl.innerHTML = actions.map(a => `
      <button class="expl-action-btn ${a.style || 'secondary'}" data-action="${a.id}" ${a.disabled ? 'disabled' : ''}>
        ${a.icon ? a.icon + ' ' : ''}${a.label}
      </button>
    `).join('');

    ctxEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => _doAction(btn.dataset.action, items));
    });
  }

  function _itemActions(item) {
    if (!item) return [];
    const isProject = item.source === 'atlantist' || item.type === 'proj';
    const isDrive   = item.source === 'drive';
    const isFolder  = item.isFolder;
    const isTemplate= item.source === 'template';

    if (isFolder) return [
      { id: 'open',    label: 'Open',   style: 'primary' },
      { id: 'share',   label: 'Share',  style: 'secondary' },
      { id: 'rename',  label: 'Rename', style: 'secondary' },
      { id: 'delete',  label: 'Delete', style: 'danger' },
    ];

    if (isTemplate) return [
      { id: 'use-template', label: 'Use Template', style: 'primary' },
      { id: 'view',         label: 'Preview',      style: 'secondary' },
    ];

    if (isProject) return [
      { id: 'edit',     label: 'Edit',     style: 'primary',    icon: iconEdit(11)   },
      { id: 'view',     label: 'View',     style: 'secondary',  icon: iconEye(11)    },
      { id: 'play',     label: 'Play',     style: 'secondary',  icon: iconPlay(11)   },
      { id: 'markup',   label: 'Markup',   style: 'secondary',  icon: iconMarkup(11) },
      { id: 'versions', label: 'Versions', style: 'secondary'                        },
      { id: 'share',    label: 'Share',    style: 'secondary',  icon: iconShare(11)  },
      { id: 'duplicate',label: 'Duplicate',style: 'secondary'                        },
      { id: 'download', label: 'Download', style: 'secondary'                        },
      { id: 'delete',   label: 'Delete',   style: 'danger'                           },
    ];

    if (isDrive) {
      const ext = item.type;
      const importable = ['rvt','rfa','ifc','dwg','dxf','xlsx'].includes(ext);
      return [
        ...(importable ? [{ id: 'import-drive', label: 'Import', style: 'primary' }] : []),
        { id: 'view',     label: 'View',     style: 'secondary' },
        { id: 'markup',   label: 'Markup',   style: 'secondary' },
        { id: 'download', label: 'Download', style: 'secondary' },
        { id: 'share',    label: 'Share',    style: 'secondary' },
      ];
    }

    return [
      { id: 'view',   label: 'View',   style: 'primary'   },
      { id: 'delete', label: 'Delete', style: 'danger'     },
    ];
  }

  function _multiActions() {
    return [
      { id: 'share',   label: 'Share Selected',  style: 'secondary' },
      { id: 'delete',  label: 'Delete Selected', style: 'danger'    },
    ];
  }

  /* ── Actions ──────────────────────────────────────────────────────────────── */
  function _doAction(actionId, items) {
    const item = items[0];
    switch (actionId) {
      case 'edit':
      case 'open':
        _openItem(item);
        break;
      case 'view':
        _openItem(item, { readonly: true });
        break;
      case 'play':
        _openItem(item, { walkthrough: true });
        break;
      case 'markup':
        _openItem(item, { markup: true });
        break;
      case 'import-drive':
        _importFromDrive(item);
        break;
      case 'use-template':
        _useTemplate(item);
        break;
      case 'versions':
        _showVersions(item);
        break;
      case 'share':
        _showShare(items);
        break;
      case 'rename':
        _showRename(item);
        break;
      case 'duplicate':
        _duplicateProject(item);
        break;
      case 'download':
        _downloadItem(item);
        break;
      case 'delete':
        _deleteSelected();
        break;
    }
  }

  function _openItem(item, opts = {}) {
    if (item.isFolder && item.source === 'drive') {
      // Navigate into Drive folder
      _driveFolder = item.driveId || item.id;
      _navigate('drive', { driveFolder: _driveFolder, label: item.name, id: item.id });
      return;
    }
    if (item.type === 'folder') {
      // Atlantist folder (future)
      return;
    }
    // Open project in BIM editor
    const projectId = item.meta?.id || item.id;
    if (item.source === 'template') {
      _useTemplate(item);
      return;
    }
    // Touch the project (update last_opened_at)
    _api('POST', `/api/projects/${projectId}/touch`).catch(() => {});
    unmount();
    // Signal the app to open this project
    const mode = opts.walkthrough ? 'walkthrough' : opts.readonly ? 'view' : opts.markup ? 'markup' : 'edit';
    if (window._bootProject) {
      window._bootProject(projectId, { mode });
    } else if (window.openProject) {
      window.openProject(projectId, mode);
    } else {
      // Fallback: navigate to the app URL with project param
      window.location.href = `/app?project=${projectId}&mode=${mode}`;
    }
  }

  function _importFromDrive(item) {
    // Wire into the existing DrivePanel import flow
    if (window.DrivePanel) {
      // Pre-select the file in Drive panel
      window._selectedDriveFile = item.meta;
      // Trigger import
      const btn = document.getElementById('btn-drive-import');
      if (btn) { unmount(); btn.click(); return; }
    }
    // Fallback: call import API directly
    unmount();
    _api('POST', '/api/drive/import', { fileId: item.driveId || item.id, fileName: item.name })
      .then(res => {
        if (res.projectId) window._bootProject && window._bootProject(res.projectId);
      })
      .catch(err => alert('Import failed: ' + err.message));
  }

  function _useTemplate(item) {
    const name = prompt('New project name:', item.name + ' Copy') || (item.name + ' Copy');
    _api('POST', '/api/projects', {
      name,
      project_type: item.meta?.project_type || 'Custom',
      template_id: item.id.startsWith('tpl-') ? item.id : null,
    }).then(res => {
      const projectId = res.project?.id || res.id;
      if (projectId) { unmount(); window._bootProject && window._bootProject(projectId); }
    }).catch(err => alert('Could not create project: ' + err.message));
  }

  function _showVersions(item) {
    // Future: show a versions panel overlay
    alert('Version history coming soon for: ' + item.name);
  }

  function _showShare(items) {
    const ids = items.map(i => i.id).join(', ');
    alert('Share dialog for: ' + ids + '\n(Full invite flow coming soon)');
  }

  function _showRename(item) {
    const newName = prompt('Rename:', item.name);
    if (!newName || newName === item.name) return;
    _api('PATCH', `/api/projects/${item.id}`, { name: newName })
      .then(() => { item.name = newName; _render(); })
      .catch(err => alert('Rename failed: ' + err.message));
  }

  function _duplicateProject(item) {
    const name = prompt('Duplicate name:', item.name + ' Copy') || (item.name + ' Copy');
    _api('POST', '/api/projects', {
      name,
      project_type: item.meta?.project_type || 'Custom',
      clone_from: item.id,
    }).then(res => {
      const newItem = _projectToItem(res.project || res);
      _items.unshift(newItem);
      _render();
    }).catch(err => alert('Duplicate failed: ' + err.message));
  }

  function _downloadItem(item) {
    if (item.source === 'drive') {
      window.open(`/api/drive/download?fileId=${item.driveId || item.id}`, '_blank');
    } else {
      window.open(`/api/projects/${item.id}/export`, '_blank');
    }
  }

  async function _deleteSelected() {
    const ids = [..._selected];
    if (ids.length === 0) return;
    const names = _items.filter(i => ids.includes(i.id)).map(i => i.name).join(', ');
    if (!confirm(`Delete ${ids.length} item(s)?\n${names}\n\nThis cannot be undone.`)) return;
    for (const id of ids) {
      const item = _items.find(i => i.id === id);
      if (!item) continue;
      try {
        if (item.source === 'atlantist' || item.type === 'proj') {
          await _api('DELETE', `/api/projects/${id}`);
        }
        _items = _items.filter(i => i.id !== id);
      } catch (err) {
        console.error('Delete failed for', id, err);
      }
    }
    _selected.clear();
    _render();
  }

  /* ── File upload ──────────────────────────────────────────────────────────── */
  async function _uploadFiles(files) {
    for (const file of files) {
      const uploadId = 'upload-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      _addUploadItem(uploadId, file.name);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/projects/upload');
        const uuid = localStorage.getItem('atlantist_session_uuid');
        if (uuid) xhr.setRequestHeader('X-Session-UUID', uuid);
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) _updateUploadProgress(uploadId, Math.round(e.loaded / e.total * 100));
        };
        await new Promise((resolve, reject) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              _updateUploadStatus(uploadId, 'Done');
              try {
                const res = JSON.parse(xhr.responseText);
                if (res.projectId) {
                  _items.unshift({ id: res.projectId, name: file.name, type: 'proj', source: 'atlantist', size: file.size, modified: new Date().toISOString(), meta: res });
                  _render();
                }
              } catch {}
              resolve();
            } else {
              _updateUploadStatus(uploadId, 'Failed');
              reject(new Error('Upload failed: ' + xhr.status));
            }
          };
          xhr.onerror = () => { _updateUploadStatus(uploadId, 'Error'); reject(new Error('Network error')); };
          xhr.send(formData);
        });
      } catch (err) {
        console.error('[Explorer] upload error:', err);
      }
      setTimeout(() => document.getElementById(uploadId)?.remove(), 3000);
    }
  }

  function _addUploadItem(id, name) {
    const q = document.getElementById('expl-upload-queue');
    if (!q) return;
    const el = document.createElement('div');
    el.id = id;
    el.className = 'expl-upload-item';
    el.innerHTML = `
      <div class="expl-upload-item-name">${_esc(name)}</div>
      <div class="expl-upload-item-bar"><div class="expl-upload-item-fill" style="width:0%"></div></div>
      <div class="expl-upload-item-status">Uploading…</div>
    `;
    q.appendChild(el);
  }

  function _updateUploadProgress(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('.expl-upload-item-fill').style.width = pct + '%';
    el.querySelector('.expl-upload-item-status').textContent = pct + '%';
  }

  function _updateUploadStatus(id, status) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('.expl-upload-item-fill').style.width = status === 'Done' ? '100%' : '0%';
    el.querySelector('.expl-upload-item-status').textContent = status;
  }

  /* ── New project modal ────────────────────────────────────────────────────── */
  function _showNewProjectModal() {
    // Reuse existing new-project flow if available
    if (window.showNewProjectModal) { window.showNewProjectModal(); return; }
    if (window.initEntryScreen) { unmount(); window.initEntryScreen(); return; }

    const name = prompt('Project name:');
    if (!name) return;
    const type = prompt('Type (Residential / Commercial / Industrial / Mixed-Use / Custom):', 'Custom') || 'Custom';
    _api('POST', '/api/projects', { name, project_type: type })
      .then(res => {
        const projectId = res.project?.id || res.id;
        if (projectId) { unmount(); window._bootProject && window._bootProject(projectId); }
      })
      .catch(err => alert('Failed: ' + err.message));
  }

  /* ── Context menu ─────────────────────────────────────────────────────────── */
  function _showCtxMenu(e, itemId) {
    _closeCtxMenu();
    const item = _items.find(i => i.id === itemId);
    if (!item) return;
    if (!_selected.has(itemId)) { _selected.clear(); _selected.add(itemId); _render(); }
    const actions = _itemActions(item);
    const menu = document.getElementById('expl-ctx-menu');
    menu.innerHTML = actions.map((a, idx) => {
      if (a.sep) return '<div class="expl-ctx-sep"></div>';
      return `<div class="expl-ctx-item${a.style === 'danger' ? ' danger' : ''}" data-action="${a.id}">${a.icon || ''} ${a.label}</div>`;
    }).join('');
    menu.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        _closeCtxMenu();
        _doAction(el.dataset.action, [item]);
      });
    });
    // Position
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - (actions.length * 38 + 20));
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.style.display = 'block';
    _ctxTarget = itemId;
  }

  function _closeCtxMenu() {
    const menu = document.getElementById('expl-ctx-menu');
    if (menu) menu.style.display = 'none';
    _ctxTarget = null;
  }

  /* ── Item click ───────────────────────────────────────────────────────────── */
  function _handleItemClick(e, id) {
    if (e.shiftKey) {
      // Range select
      const ids = _items.map(i => i.id);
      const last = [..._selected].pop();
      const fromIdx = last ? ids.indexOf(last) : 0;
      const toIdx   = ids.indexOf(id);
      const [a, b] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
      ids.slice(a, b + 1).forEach(i => _selected.add(i));
    } else if (e.metaKey || e.ctrlKey) {
      if (_selected.has(id)) _selected.delete(id);
      else _selected.add(id);
    } else {
      if (_selected.has(id) && _selected.size === 1) {
        // Click selected item again — deselect
        _selected.clear();
      } else {
        _selected.clear();
        _selected.add(id);
      }
    }
    _updateActionBar();
    // Update checkmarks without full re-render
    document.querySelectorAll('[data-item-id]').forEach(el => {
      const sel = _selected.has(el.dataset.itemId);
      el.classList.toggle('selected', sel);
      const chk = el.querySelector('.expl-card-check');
      if (chk) chk.innerHTML = sel ? iconCheck() : '';
    });
  }

  /* ── Status bar ───────────────────────────────────────────────────────────── */
  function _updateStatusBar(count) {
    const el = document.getElementById('expl-status-count');
    if (el) el.innerHTML = `<strong>${count}</strong> item${count !== 1 ? 's' : ''}`;
  }

  async function _updateStorage() {
    try {
      const data = await _api('GET', '/api/explorer/storage');
      _storageUsed = data.used || 0;
      _storageTotal = data.total || 10 * 1024 * 1024 * 1024;
      const pct = Math.min(100, Math.round(_storageUsed / _storageTotal * 100));
      const fillEl = document.getElementById('expl-storage-bar-fill');
      const labelEl = document.getElementById('expl-storage-label');
      if (fillEl) fillEl.style.width = pct + '%';
      if (labelEl) labelEl.textContent = `${_fmtSize(_storageUsed)} of ${_fmtSize(_storageTotal)}`;
    } catch { /* storage endpoint optional */ }
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────── */
  function _fmtSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function _fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMs < 60000)    return 'Just now';
    if (diffMs < 3600000)  return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    if (diffDays < 7)      return diffDays + 'd ago';
    if (diffDays < 365)    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function _esc(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── SVG Icons ────────────────────────────────────────────────────────────── */
  function iconFolder(sz=16) { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`; }
  function iconClock(sz=16)  { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`; }
  function iconTeam(sz=16)   { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`; }
  function iconDrive(sz=16)  { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 17.32 4H6.68a2 2 0 0 0-1.77.89z"/></svg>`; }
  function iconTemplate(sz=16){return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>`; }
  function iconTrash(sz=16)  { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`; }
  function iconSearch(sz=14) { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`; }
  function iconGrid(sz=14)   { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`; }
  function iconList(sz=14)   { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`; }
  function iconUpload(sz=16) { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>`; }
  function iconPlus(sz=13)   { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`; }
  function iconCheck()       { return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`; }
  function iconEdit(sz=11)   { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`; }
  function iconEye(sz=11)    { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`; }
  function iconPlay(sz=11)   { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`; }
  function iconMarkup(sz=11) { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`; }
  function iconShare(sz=11)  { return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`; }

})();
