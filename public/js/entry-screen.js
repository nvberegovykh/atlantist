/**
 * Owns: project entry screen overlay — directories, project cards, new project flow.
 * Does NOT own: BIM state, Three.js scene, element data.
 */

// ─── State ───────────────────────────────────────────────────────────────────
let activeDir = 'recent';
let searchQuery = '';
let projectList = [];

const TYPE_BADGES = {
  'Residential': { bg: '#064e3b', color: '#6ee7b7' },
  'Commercial':  { bg: '#1e3a5f', color: '#93c5fd' },
  'Industrial':  { bg: '#451a03', color: '#fcd34d' },
  'Mixed-Use':   { bg: '#3b0764', color: '#e9d5ff' },
  'Custom':      { bg: '#1a1a1a', color: '#9ca3af' },
};

const DIR_ICONS = {
  recent:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  personal:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  work:      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
  templates: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  archived:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
};

const DIR_LABELS = {
  recent:    'Recent',
  personal:  'Personal',
  work:      'Work',
  templates: 'Templates',
  archived:  'Archived',
};

const PROJECT_TYPES = [
  { id: 'Residential', label: 'Residential', icon: '🏠', desc: 'House, apartment, townhouse' },
  { id: 'Commercial',  label: 'Commercial',  icon: '🏢', desc: 'Office, retail, hospitality' },
  { id: 'Industrial',  label: 'Industrial',  icon: '🏭', desc: 'Warehouse, manufacturing, lab' },
  { id: 'Mixed-Use',  label: 'Mixed-Use',  icon: '🌆', desc: 'Multi-purpose development' },
  { id: 'Custom',     label: 'Custom',      icon: '✨', desc: 'Start from a blank project' },
];

// ─── API helpers (same as app.js) ────────────────────────────────────────────
// Guards against HTML error pages (deploys, 302 to login, crashes) parsing as JSON.
// Throws a descriptive error pointing at the actual failing endpoint.
async function _api(method, path, body) {
  const sessionUuid = localStorage.getItem('atlantist_session_uuid');
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionUuid ? { 'X-Session-UUID': sessionUuid } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = (res.headers.get('content-type') || '');
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Expected JSON from ${method} ${path} but got Content-Type: ${ct}; body: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Demo Auto-Load ────────────────────────────────────────────────────────────
async function _autoLoadDemo() {
  // If ?demo= is present, app.js boot IIFE handles the full load.
  // Return true here so initEntryScreen() skips the project picker.
  const params = new URLSearchParams(window.location.search);
  return !!params.get('demo');
}

// ─── Loading bar helper ────────────────────────────────────────────────────
function _setLoadingBar(pct) {
  const bar = document.getElementById('loading-bar');
  if (bar) bar.style.width = Math.min(100, pct) + '%';
}

// ─── Anonymous session init ────────────────────────────────────────────────
// Ensures the backend has an app_users row for this browser session so
// non-auth API calls (e.g. demo project reads) don't 500 on missing user context.
async function _initAnonSession() {
  try {
    let uuid = localStorage.getItem('atlantist_session_uuid');
    if (!uuid) {
      uuid = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now());
      localStorage.setItem('atlantist_session_uuid', uuid);
    }
    await fetch('/api/auth/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_uuid: uuid }),
    });
  } catch (_) { /* non-fatal */ }
}

// ─── Entry Screen Bootstrap ──────────────────────────────────────────────────
export async function initEntryScreen() {
  _setLoadingBar(15);

  // Check for demo slug first — auto-load without showing entry screen
  const demoLoaded = await _autoLoadDemo();
  if (demoLoaded) return;

  _setLoadingBar(35);

  // Init anonymous session so backend recognises this browser
  await _initAnonSession();

  _setLoadingBar(55);

  const overlay = document.getElementById('entry-screen-overlay');
  if (!overlay) return;

  // Inject directory icons into sidebar
  _injectSidebarIcons();

  overlay.style.opacity = '0';
  overlay.style.display = 'flex';

  // Fade in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.style.transition = 'opacity .3s ease-out';
      overlay.style.opacity = '1';
    });
  });

  await _bindEntryScreen();

  // Hide the app-loading overlay NOW (before _loadProjects) so user sees entry screen
  // while projects are fetching. Don't wait for project list load to dismiss the spinner.
  const appLoading = document.getElementById('app-loading-overlay');
  if (appLoading) { appLoading.style.opacity = '0'; setTimeout(() => { appLoading.style.display = 'none'; }, 300); }

  _setLoadingBar(80);
  await _loadProjects();
  _setLoadingBar(100);
}

function _injectSidebarIcons() {
  const icons = {
    'es-icon-recent':    DIR_ICONS.recent,
    'es-icon-personal':  DIR_ICONS.personal,
    'es-icon-work':      DIR_ICONS.work,
    'es-icon-templates': DIR_ICONS.templates,
    'es-icon-archived':  DIR_ICONS.archived,
  };
  for (const [id, svg] of Object.entries(icons)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = svg;
  }
}

async function _bindEntryScreen() {
  // Directory nav
  document.querySelectorAll('[data-dir]').forEach(el => {
    el?.addEventListener('click', (e) => {
      e.stopPropagation();
      activeDir = el.dataset.dir;
      document.querySelectorAll('[data-dir]').forEach(x => x.classList.remove('dir-active'));
      el.classList.add('dir-active');
      _renderGrid();
    });
  });

  // Search
  document.getElementById('entry-search')?.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    _renderGrid();
  });

  // New Project button
  document.getElementById('entry-new-project-btn')?.addEventListener('click', _showTypeSelector);

  // Type selector close
  document.getElementById('entry-type-backdrop')?.addEventListener('click', _hideTypeSelector);
  document.getElementById('entry-type-close')?.addEventListener('click', _hideTypeSelector);

  // Type cards
  document.querySelectorAll('[data-project-type]').forEach(el => {
    el?.addEventListener('click', () => _selectProjectType(el.dataset.projectType));
  });

  // Name form
  document.getElementById('entry-name-submit')?.addEventListener('click', _submitNewProject);
  document.getElementById('entry-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _submitNewProject();
  });
}

async function _loadProjects() {
  try {
    const projects = await _api('GET', '/api/projects');
    projectList = projects || [];
    _renderGrid();
  } catch (err) {
    // 401 = not authenticated — show login prompt
    if (err.message && err.message.includes('HTTP 401')) {
      _showLoginPrompt();
      return;
    }
    projectList = [];
    _renderGrid();
  }
}

function _showLoginPrompt() {
  // Show sign-in CTA in the project grid area
  const grid = document.getElementById('entry-project-grid');
  const empty = document.getElementById('entry-empty-state');
  if (grid) grid.innerHTML = '';
  if (empty) {
    empty.style.display = 'flex';
    const msg = empty.querySelector('.entry-empty-msg');
    if (msg) msg.textContent = 'Sign in to see your projects';
    // Add sign-in button if not already there
    if (!empty.querySelector('.es-signin-btn')) {
      const btn = document.createElement('button');
      btn.className = 'es-signin-btn';
      btn.textContent = 'Sign in / Create account →';
      btn.style.cssText = 'margin-top:16px;padding:10px 24px;background:#3479c4;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer';
      btn.onclick = () => {
        // Trigger the main app signup modal
        const loginBtn = document.getElementById('account-login-prompt');
        const signupModal = document.getElementById('modal-signup');
        if (loginBtn) loginBtn.click();
        else if (signupModal) {
          signupModal.style.display = 'flex';
          signupModal.classList.remove('hidden');
        }
      };
      empty.appendChild(btn);
    }
  }
}

function _filteredProjects() {
  let list = projectList;

  if (activeDir === 'recent') {
    list = [...projectList].sort((a, b) =>
      new Date(b.last_opened_at || b.updated_at) - new Date(a.last_opened_at || a.updated_at)
    ).slice(0, 12);
  } else if (activeDir === 'personal') {
    list = projectList.filter(p => p.my_role === 'owner' && !p.archived);
  } else if (activeDir === 'work') {
    list = projectList.filter(p => p.my_role !== 'owner' && !p.archived);
  } else if (activeDir === 'templates') {
    // Show templates from DB (no archived filter)
    list = projectList.filter(p => p.is_template && !p.archived);
  } else if (activeDir === 'archived') {
    list = projectList.filter(p => p.archived);
  }

  if (searchQuery) {
    list = list.filter(p => (p.name || '').toLowerCase().includes(searchQuery) ||
                            (p.type || p.project_type || '').toLowerCase().includes(searchQuery));
  }

  return list;
}

function _renderGrid() {
  const grid = document.getElementById('entry-project-grid');
  const empty = document.getElementById('entry-empty-state');
  if (!grid) return;

  const filtered = _filteredProjects();

  if (filtered.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    if (empty) {
      empty.style.display = 'flex';
      const emptyMsg = empty.querySelector('.entry-empty-msg');
      if (emptyMsg) {
        emptyMsg.textContent = activeDir === 'templates'
          ? 'Templates coming soon'
          : activeDir === 'archived'
          ? 'No archived projects'
          : 'No projects yet. Create one above!';
      }
    }
    return;
  }

  if (empty) { empty.style.display = 'none'; }
  grid.style.display = 'grid';

  grid.innerHTML = filtered.map((p, i) => {
    const type = p.project_type || p.type || 'Custom';
    const badge = TYPE_BADGES[type] || TYPE_BADGES['Custom'];
    const thumb = p.thumbnail_url;
    const date = p.last_opened_at || p.updated_at;
    const dateStr = date ? _formatDate(date) : 'No activity';

    return `
      <div class="entry-card" data-project-id="${p.id}" style="animation-delay: ${i * 50}ms">
        <div class="entry-card-thumb">
          ${thumb
            ? `<img src="${_escAttr(thumb)}" alt="${_escAttr(p.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px" />`
            : `<div class="entry-card-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
               </div>`
          }
        </div>
        <div class="entry-card-body">
          <div class="entry-card-name">${_escHtml(p.name || 'Untitled Project')}</div>
          <div class="entry-card-meta">
            <span class="entry-card-badge" style="background:${badge.bg};color:${badge.color}">${_escHtml(type)}</span>
            <span class="entry-card-date">${dateStr}</span>
          </div>
        </div>
        <button class="entry-card-open-btn" data-tmpl="${p.is_template ? '1' : '0'}">${p.is_template ? 'Use Template' : 'Open'}</button>
        <button class="entry-card-menu-btn" title="More options" data-menu-project="${p.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
        <div class="entry-card-menu hidden" id="entry-menu-${p.id}">
          <button class="entry-menu-item" data-action="rename" data-projid="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Rename
          </button>
          <button class="entry-menu-item" data-action="duplicate" data-projid="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Duplicate
          </button>
          ${!p.archived ? `
          <button class="entry-menu-item" data-action="archive" data-projid="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            Archive
          </button>` : `
          <button class="entry-menu-item" data-action="unarchive" data-projid="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>
            Unarchive
          </button>`}
          <button class="entry-menu-item entry-menu-danger" data-action="delete" data-projid="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Delete
          </button>
        </div>
      </div>`;
  }).join('');

  // Stagger animation
  grid.querySelectorAll('.entry-card').forEach((card, i) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(12px)';
    setTimeout(() => {
      card.style.transition = 'opacity .25s ease-out, transform .25s ease-out';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, i * 50);
  });

  // Card click → open project (or show template modal)
  grid.querySelectorAll('.entry-card-open-btn').forEach(btn => {
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.entry-card');
      const id = parseInt(card.dataset.projectId, 10);
      const isTemplate = btn.dataset.tmpl === '1';
      _openProject(id, isTemplate);
    });
  });

  // Three-dot menu
  grid.querySelectorAll('.entry-card-menu-btn').forEach(btn => {
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const projid = btn.dataset.menuProject;
      const menu = document.getElementById(`entry-menu-${projid}`);
      // Close other menus
      document.querySelectorAll('.entry-card-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
      menu.classList.toggle('hidden');
    });
  });

  // Menu actions
  grid.querySelectorAll('.entry-menu-item').forEach(item => {
    item?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const projid = parseInt(item.dataset.projid, 10);
      document.getElementById(`entry-menu-${projid}`)?.classList.add('hidden');
      await _handleMenuAction(action, projid);
    });
  });
}

async function _handleMenuAction(action, projectId) {
  if (action === 'rename') {
    const newName = prompt('Enter new project name:');
    if (!newName?.trim()) return;
    try {
      await _api('PATCH', `/api/projects/${projectId}`, { name: newName.trim() });
      await _loadProjects();
      toast('Project renamed', 'success');
    } catch (err) { toast(err.message, 'error'); }
  } else if (action === 'duplicate') {
    try {
      const p = projectList.find(x => x.id === projectId);
      await _api('POST', '/api/projects', {
        name: (p?.name || 'Project') + ' (Copy)',
        type: p?.project_type || p?.type || 'Mixed-Use',
        description: p?.description || '',
      });
      await _loadProjects();
      toast('Project duplicated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  } else if (action === 'archive') {
    try {
      await _api('PATCH', `/api/projects/${projectId}`, { archived: true });
      await _loadProjects();
      toast('Project archived', 'success');
    } catch (err) { toast(err.message, 'error'); }
  } else if (action === 'unarchive') {
    try {
      await _api('PATCH', `/api/projects/${projectId}`, { archived: false });
      await _loadProjects();
      toast('Project restored', 'success');
    } catch (err) { toast(err.message, 'error'); }
  } else if (action === 'delete') {
    if (!confirm('Delete this project permanently? This cannot be undone.')) return;
    try {
      await _api('DELETE', `/api/projects/${projectId}`);
      await _loadProjects();
      toast('Project deleted', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }
}

function _showTypeSelector() {
  document.getElementById('entry-type-backdrop')?.classList.remove('hidden');
  document.getElementById('entry-type-modal')?.classList.remove('hidden');
}

function _hideTypeSelector() {
  document.getElementById('entry-type-backdrop')?.classList.add('hidden');
  document.getElementById('entry-type-modal')?.classList.add('hidden');
  const nameInput = document.getElementById('entry-name-input');
  if (nameInput) nameInput.value = '';
  else console.warn('[entry-screen] _hideTypeSelector: #entry-name-input not found on this page');
}

function _selectProjectType(typeId) {
  _hideTypeSelector();
  // Show name dialog
  const modal = document.getElementById('entry-name-modal');
  const backdrop = document.getElementById('entry-name-backdrop');
  const typeLabel = document.getElementById('entry-name-type-label');
  if (typeLabel) typeLabel.textContent = typeId;

  modal?.classList.remove('hidden');
  backdrop?.classList.remove('hidden');
  setTimeout(() => document.getElementById('entry-name-input')?.focus(), 100);
}

function _hideNameModal() {
  document.getElementById('entry-name-modal')?.classList.add('hidden');
  document.getElementById('entry-name-backdrop')?.classList.add('hidden');
}

async function _submitNewProject() {
  const input = document.getElementById('entry-name-input');
  const name = input?.value?.trim();
  if (!name) {
    toast('Enter a project name', 'error');
    return;
  }

  // Find selected type from type selector
  const typeLabel = document.getElementById('entry-name-type-label');
  const selectedType = typeLabel?.textContent || 'Custom';

  _hideNameModal();

  try {
    const project = await _api('POST', '/api/projects', {
      name,
      type: selectedType,
      description: '',
    });
    await _loadProjects();
    _openProject(project.id);
  } catch (err) {
    toast(err.message || 'Failed to create project', 'error');
  }
}

async function _openProject(projectId, isTemplate = false) {
  if (isTemplate) {
    // Show template preview modal with instantiate option
    await _showTemplateModal(projectId);
    return;
  }

  // Fade out entry screen
  const overlay = document.getElementById('entry-screen-overlay');
  overlay.style.transition = 'opacity .3s ease-in';
  overlay.style.opacity = '0';

  // Hide loading overlay and init app
  const appLoading = document.getElementById('app-loading-overlay');
  if (appLoading) appLoading.style.display = 'flex';

  window.currentProjectId = projectId;

  // Mark last opened
  fetch(`/api/projects/${projectId}/touch`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => {});

  // Dispatch event — app.js listener calls loadAll() and dismisses the loading overlay
  window.dispatchEvent(new CustomEvent('atlantist:project:open', {
    detail: { projectId }
  }));

  // Fade out entry overlay after a short delay
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 300);
}

// ─── Template Modal ─────────────────────────────────────────────────────────
async function _showTemplateModal(templateId) {
  const t = projectList.find(p => String(p.id) === String(templateId));
  if (!t) return;

  const { levels = [], elements = [], families = [] } = await _api('GET', `/api/templates/${templateId}/preview`).catch(() => ({}));

  // Build content summary
  const wallCount  = (elements || []).filter(e => e.type === 'wall').length;
  const colCount   = (elements || []).filter(e => e.type === 'column').length;
  const doorCount  = (families  || []).filter(f => f.family_type === 'door').length;
  const winCount   = (families  || []).filter(f => f.family_type === 'window').length;
  const levelCount = (levels    || []).filter(l => l.is_building_storey).length;
  const settings   = t.settings || {};

  const html = `
    <div class="tmpl-modal" style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7)">
      <div style="background:#1a1a2e;border-radius:12px;padding:32px;max-width:480px;width:100%;border:1px solid #333">
        <h2 style="font-size:20px;font-weight:700;color:#e2e8f0;margin-bottom:4px">${_escHtml(t.name)}</h2>
        <p style="font-size:13px;color:#8898b0;margin-bottom:20px">${_escHtml(t.description || '')}</p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">
          <div style="background:#111118;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:#5b9bd5">${levelCount}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:4px">Levels</div>
          </div>
          <div style="background:#111118;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:#5b9bd5">${wallCount}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:4px">Walls</div>
          </div>
          <div style="background:#111118;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:#5b9bd5">${colCount}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:4px">Columns</div>
          </div>
          <div style="background:#111118;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:#5b9bd5">${doorCount + winCount}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:4px">Doors + Windows</div>
          </div>
        </div>

        <div style="font-size:12px;color:#6b7280;margin-bottom:20px">
          <b>Construction:</b> ${settings.construction_type || 'N/A'} &nbsp;|&nbsp;
          <b>Floor height:</b> ${settings.typical_floor_height ? settings.typical_floor_height + 'm' : 'N/A'} &nbsp;|&nbsp;
          <b>HVAC:</b> ${settings.hvac_type || 'N/A'}
        </div>

        <div style="margin-bottom:20px">
          <label style="display:block;font-size:12px;color:#8898b0;margin-bottom:6px">Your project name</label>
          <input id="tmpl-name-input" type="text" placeholder="${_escAttr(t.name)} — My Version"
            style="width:100%;padding:10px 12px;background:#111118;border:1px solid #333;border-radius:8px;color:#e2e8f0;font-size:14px;box-sizing:border-box" />
        </div>

        <div style="display:flex;gap:10px">
          <button id="tmpl-cancel" style="flex:1;padding:10px;border:1px solid #333;border-radius:8px;background:transparent;color:#8898b0;cursor:pointer;font-size:14px">Cancel</button>
          <button id="tmpl-use" style="flex:2;padding:10px;border:none;border-radius:8px;background:#4a7dbd;color:#fff;cursor:pointer;font-size:14px;font-weight:600">
            Use Template →
          </button>
        </div>
      </div>
    </div>
  `;

  // Append to body
  const wrapper = document.createElement('div');
  wrapper.id = 'tmpl-modal-wrapper';
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);

  // Bind cancel
  document.getElementById('tmpl-cancel')?.addEventListener('click', () => {
    wrapper.remove();
  });

  // Bind use template
  document.getElementById('tmpl-use')?.addEventListener('click', async () => {
    const input = document.getElementById('tmpl-name-input');
    const name  = input?.value?.trim() || `${t.name} — My Version`;
    try {
      const project = await _api('POST', `/api/templates/${templateId}/instantiate`, { name });
      wrapper.remove();
      toast('Template instantiated!', 'success');
      await _loadProjects();
      _openProject(project.id);
    } catch (err) {
      toast(err.message || 'Failed to use template', 'error');
    }
  });

  // Focus name input
  setTimeout(() => document.getElementById('tmpl-name-input')?.focus(), 100);
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function _escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _escAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function toast(msg, type = 'info', duration = 2500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// Expose globally for onclick and boot-safety fallback
window.openEntryScreen = initEntryScreen;
window.initEntryScreen = initEntryScreen;

// Auto-init when module loads (entry screen is default view)
initEntryScreen();