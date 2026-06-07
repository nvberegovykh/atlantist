/* ============================================================
   App Shell — Phase 31 unified BIM shell layer.
   Owns: left nav rail, sidebar panel switching, version
   timeline drawer, properties panel tabs, contextual
   toolbar morph, presence share button.
   Does NOT own: Three.js scene, modal forms, API calls.
   ============================================================ */

/* ── Expose switchPropsTab early ─────────────────────────────
   app-shell.js loads after app.html buttons are rendered.
   Toolbar buttons (onclick="window.switchPropsTab&&switchPropsTab(...)")
   may fire before initAppShell() runs, so we expose the stub
   immediately. The real implementation overwrites it below.      */
window.switchPropsTab = function(tabId) {
  /* Stub — will be replaced by the real function after init. */
};

/* ── Nav Rail ────────────────────────────────────────────────
   Icon strip on the left. Clicking opens the expanded panel.  */

const NAV_TABS = [
  {
    id:      'explorer',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h18v4H3z"/><path d="M3 9h18v4H3z"/><path d="M3 15h18v4H3z"/></svg>`,
    label:   'Explorer',
    tooltip: 'Explorer — project tree',
  },
  {
    id:      'library',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
    label:   'Library',
    tooltip: 'Library — BIM families & materials',
  },
  {
    id:      'integrations',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>`,
    label:   'Integrations',
    tooltip: 'Integrations — APS, IFC, gbXML, DXF',
  },
  {
    id:      'drive',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12H2"/><path d="M5 12l-3 4 3 4"/><path d="M19 12l3 4-3 4"/><path d="M12 2l-4 3 4 3 4-3-4-3"/><path d="M12 22l-4-3 4-3 4 3-4 3"/></svg>`,
    label:   'Drive',
    tooltip: 'Google Drive — browse & import files',
  },
  {
    id:      'scheduling',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="8" y1="4" x2="8" y2="20"/></svg>`,
    label:   'Scheduling',
    tooltip: 'Scheduling — Gantt, milestones',
  },
  {
    id:      'simulations',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>`,
    label:   'Simulations',
    tooltip: 'Simulations — all analysis engines',
  },
  {
    id:      'collaboration',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
    label:   'Collaboration',
    tooltip: 'Collaboration — presence, issues, chat',
  },
  {
    id:      'versions',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/><path d="M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>`,
    label:   'Versions',
    tooltip: 'Versions — timeline, branch, restore',
  },
  {
    id:      'dob',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 12 18 15 15"/><line x1="12" y1="12" x2="12" y2="18"/></svg>`,
    label:   'DOB Filing',
    tooltip: 'DOB Filing — forms, status, packages',
  },
  {
    id:      'scripting',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v4M9 18l-3 3M15 18l3 3"/></svg>`,
    label:   'Scripting',
    tooltip: 'Scripting — Dynamo/Grasshopper node editor',
  },
  {
    id:      'store',
    icon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    label:   'Store',
    tooltip: 'Asset Store — browse, upload, manage',
  },
];

let activeNavTab = null;

function buildNavRail() {
  const rail = document.getElementById('nav-rail');
  if (!rail) return;
  rail.innerHTML = '';

  NAV_TABS.forEach((tab, i) => {
    if (i === 2) {
      // Divider before Integrations
      const div = document.createElement('div');
      div.className = 'nav-rail-divider';
      div.setAttribute('role', 'separator');
      rail.appendChild(div);
    }

    const btn = document.createElement('button');
    btn.className = 'nav-rail-btn';
    btn.id = `nav-btn-${tab.id}`;
    btn.setAttribute('data-tooltip', tab.tooltip);
    btn.setAttribute('aria-label', tab.label);
    btn.setAttribute('aria-controls', `sidebar-pane-${tab.id}`);
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = tab.icon;
    btn?.addEventListener('click', () => toggleNavTab(tab.id));
    rail.appendChild(btn);
  });

  // Warn about any rail buttons that failed to attach — selector not found in DOM
  document.querySelectorAll('[id^="nav-btn-"]').forEach(el => {
    if (!el.classList.contains('nav-rail-btn')) {
      console.warn(`[app-shell] Element #${el.id} exists in DOM but was not created by buildNavRail — check for duplicate IDs`);
    }
  });
}

function toggleNavTab(tabId) {
  // Special: Scripting opens Node Editor directly, no sidebar pane
  if (tabId === 'scripting') {
    closeNavRail();
    if (window._ne) window._ne.open();
    return;
  }
  if (tabId === 'store') {
    closeNavRail();
    window.openStore && window.openStore();
    return;
  }

  const expanded = document.getElementById('sidebar-expanded');
  if (!expanded) return;

  if (activeNavTab === tabId) {
    // Collapse
    closeNavRail();
    return;
  }

  activeNavTab = tabId;
  expanded.classList.add('open');
  expanded.dataset.state = 'open'; // UIElement data-state sync

  // Deactivate all rail buttons
  document.querySelectorAll('.nav-rail-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  });

  // Activate this one
  const activeBtn = document.getElementById(`nav-btn-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.setAttribute('aria-expanded', 'true');
  }

  // Show correct pane
  document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById(`sidebar-pane-${tabId}`);
  if (pane) pane.classList.add('active');

  // Sync with legacy sidebar-left tabs (EXPLORER text tab, Levels, Library)
  if (tabId === 'explorer' || tabId === 'library' || tabId === 'levels') {
    window.switchSLTab && window.switchSLTab(tabId);
  }

  // Adjust main layout
  document.getElementById('main-layout') && adjustMainLayout();
}

function closeNavRail() {
  activeNavTab = null;
  const expanded = document.getElementById('sidebar-expanded');
  if (expanded) {
    expanded.classList.remove('open');
    expanded.dataset.state = 'closed'; // UIElement data-state sync
  }
  document.querySelectorAll('.nav-rail-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  });
  adjustMainLayout();
}

function adjustMainLayout() {
  // Guard: DOM may not be ready if called before initAppShell (race on dynamic script load)
  if (document.readyState === 'loading') return;
  const expanded = document.getElementById('sidebar-expanded');
  const mainLayout = document.getElementById('main-layout');
  if (!mainLayout) return;
  const isOpen = expanded && expanded.classList.contains('open');

  // --sidebar-w: only the expanded nav panel (0 or 15rem).
  // --left-panel-w (12.5rem) is always the explorer sidebar width — CSS constant.
  // --nav-w (2.75rem) always present.
  // .main-layout margin = calc(var(--nav-w) + var(--left-panel-w) + var(--sidebar-w))
  const sidebarW = isOpen ? '15rem' : '0';
  mainLayout.style.setProperty('--sidebar-w', sidebarW);
  // Also set on :root so #sidebar-expanded (fixed-positioned, outside main-layout)
  // picks up the var and animates its width correctly. BUG-UI-2 fix.
  document.documentElement.style.setProperty('--sidebar-w', sidebarW);

  // Notify viewport system to recompute renderer sizes after CSS transition.
  setTimeout(() => {
    if (typeof window._atlNotifyVPResize === 'function') window._atlNotifyVPResize();
  }, 220);
}

/* ── Sidebar Pane Content ──────────────────────────────────── */

function buildSidebarPanes() {
  const container = document.getElementById('sidebar-expanded');
  if (!container) return;

  container.innerHTML = buildExplorerPane() +
    buildLibraryPane() +
    buildIntegrationsPane() +
    buildDrivePane() +
    buildSchedulingPane() +
    buildSimulationsPane() +
    buildCollaborationPane() +
    buildVersionsPane() +
    buildDobPane() +
    buildStorePane();
}

function paneShell(id, title, desc, body) {
  return `<div class="sidebar-pane" id="sidebar-pane-${id}" role="tabpanel" aria-labelledby="nav-btn-${id}">
    <div class="sidebar-pane-header">
      <div class="sidebar-pane-title">${title}</div>
      ${desc ? `<div class="sidebar-pane-desc">${desc}</div>` : ''}
    </div>
    <div class="sidebar-pane-body">${body}</div>
  </div>`;
}

function featureRow(icon, label, meta, onclick) {
  return `<button class="sidebar-feature-row" onclick="${onclick}" aria-label="${label}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
    <span class="row-label">${label}</span>
    ${meta ? `<span class="row-meta">${meta}</span>` : ''}
  </button>`;
}

function buildExplorerPane() {
  return paneShell('explorer', 'Explorer', 'Project tree', `
    <div class="sidebar-section-head">Project Tree</div>
    ${featureRow('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', 'Levels', '', "window.switchSLTab&&switchSLTab('levels');closeNavRail()")}
    ${featureRow('<rect x="3" y="4" width="18" height="3" rx="1"/><rect x="3" y="10" width="18" height="3" rx="1"/>', 'Walls', '', "window.switchSLTab&&switchSLTab('explorer');closeNavRail()")}
    ${featureRow('<rect x="9" y="3" width="6" height="18" rx="1"/>', 'Columns', '', "window.switchSLTab&&switchSLTab('explorer');closeNavRail()")}
    ${featureRow('<path d="M3 9h18v4H3z"/><line x1="7" y1="7" x2="7" y2="10"/>', 'Floors & Ceilings', '', "window.switchSLTab&&switchSLTab('explorer');closeNavRail()")}
    ${featureRow('<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 21V9"/>', 'Rooms', '', "window.switchSLTab&&switchSLTab('explorer');closeNavRail()")}
    <div class="sidebar-section-head">Sheets</div>
    ${featureRow('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/>', 'Schedules (A-400)', '', "document.getElementById('btn-show-schedule')&&document.getElementById('btn-show-schedule').click();closeNavRail()")}
    ${featureRow('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', 'Design Book', '', "window.toggleDesignBook&&toggleDesignBook();closeNavRail()")}
  `);
}

function buildLibraryPane() {
  return paneShell('library', 'Library', 'Families, materials, MEP fixtures', `
    <div class="sidebar-section-head">Families</div>
    ${featureRow('<rect x="3" y="4" width="18" height="3" rx="1"/><rect x="3" y="10" width="18" height="3" rx="1"/>', 'Wall Types', '', "window.openTypeLibrary&&openTypeLibrary()")}
    ${featureRow('<rect x="9" y="3" width="6" height="18" rx="1"/>', 'Column Types', '', "window.openTypeLibrary&&openTypeLibrary()")}
    ${featureRow('<path d="M14 21V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16"/>', 'Door & Window Families', '', "window.openTypeLibrary&&openTypeLibrary()")}
    ${featureRow('<polyline points="3,21 3,16 8,16 8,11 13,11 13,6 18,6 18,3 21,3"/>', 'Stair & Railing Types', '', "window.openTypeLibrary&&openTypeLibrary()")}
    ${featureRow('<polyline points="3,12 12,3 21,12"/><rect x="5" y="12" width="14" height="9"/>', 'Roof Types', '', "window.openTypeLibrary&&openTypeLibrary()")}
    <div class="sidebar-section-head">Materials</div>
    ${featureRow('<path d="M3 6h18M3 12h18M3 18h18"/>', 'Concrete, Steel, Timber, Glass', '', "window.openTypeLibrary&&openTypeLibrary()")}
    <div class="sidebar-section-head">MEP Fixtures</div>
    ${featureRow('<rect x="5" y="5" width="14" height="8" rx="1"/><rect x="9" y="13" width="6" height="6" rx="1"/>', 'HVAC / Plumbing / Electrical', '', "document.getElementById('btn-mep-fixtures')&&document.getElementById('btn-mep-fixtures').click()")}
  `);
}

function buildIntegrationsPane() {
  return paneShell('integrations', 'Integrations', 'Autodesk APS, IFC, gbXML, DXF', `
    <div class="sidebar-section-head">Import</div>
    ${featureRow('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', 'IFC Import', '', "document.getElementById('btn-ifc-import')&&document.getElementById('btn-ifc-import').click()")}
    ${featureRow('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><path d="M17 13v2m0 4v-2m0 0h-2m4 0h-2" stroke-width="2"/>', 'Revit (.rvt) via APS', '', "document.getElementById('btn-aps')&&document.getElementById('btn-aps').click()")}
    <div class="sidebar-section-head">Export</div>
    ${featureRow('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', 'IFC Export', '', "document.getElementById('btn-ifc-export')&&document.getElementById('btn-ifc-export').click()")}
    ${featureRow('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', 'DXF Export (CAD)', '', "document.getElementById('btn-export-cad')&&document.getElementById('btn-export-cad').click()")}
    ${featureRow('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', 'gbXML / IDF / Energy', '', "document.getElementById('btn-energy')&&document.getElementById('btn-energy').click()")}
    <div class="sidebar-section-head">Sync</div>
    ${featureRow('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12H2"/><path d="M5 12l-3 4 3 4"/><path d="M19 12l3 4-3 4"/><path d="M12 2l-4 3 4 3 4-3-4-3"/><path d="M12 22l-4-3 4-3 4 3-4 3"/></svg>', 'Google Drive', '', "window.toggleNavTab&&window.toggleNavTab('drive');closeNavRail()")}
  `);
}

function buildDrivePane() {
  return `<div class="sidebar-pane" id="sidebar-pane-drive" role="tabpanel" aria-labelledby="nav-btn-drive">
    <div class="sidebar-pane-header">
      <div class="sidebar-pane-title">Google Drive</div>
      <div class="sidebar-pane-desc">Browse and import files</div>
    </div>
    <div class="sidebar-pane-body">
      <div id="drive-panel-content">
        <!-- Status + connect state injected by DrivePanel.init() -->
        <div id="drive-connect-state" style="padding:10px 14px;background:var(--shell-accent-dim,rgba(52,121,196,0.1));border-radius:6px;margin:12px 14px;font-size:12px">
          <div style="text-align:center;padding:12px 0;color:var(--shell-muted)">Loading Drive…</div>
        </div>
        <div id="drive-folder-tree" style="display:none">
          <div style="padding:6px 14px 4px;font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.08em;text-transform:uppercase">Folders</div>
          <div id="drive-breadcrumb" style="padding:4px 14px;font-size:11px;color:var(--accent);display:flex;align-items:center;gap:4px;overflow:hidden"></div>
          <div id="drive-folder-list" style="padding:4px 0"></div>
        </div>
        <div id="drive-file-list" style="display:none;margin-top:4px">
          <div style="padding:6px 14px 4px;font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.08em;text-transform:uppercase">Files</div>
          <div id="drive-files-container"></div>
        </div>
        <div id="drive-import-error" style="display:none;margin:8px 14px;padding:8px 10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);border-radius:5px;font-size:11px;color:#ef4444"></div>
        <div id="drive-download-progress" style="display:none;margin:8px 14px">
          <div id="drive-progress-label" style="font-size:11px;color:var(--text-muted);margin-bottom:4px"></div>
          <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden">
            <div id="drive-progress-bar" style="height:100%;background:var(--accent);transition:width 0.3s;border-radius:2px;width:0%"></div>
          </div>
        </div>
        <div style="padding:12px 14px;border-top:1px solid var(--border);margin-top:8px;display:flex;justify-content:space-between;align-items:center">
          <span id="drive-last-synced" style="font-size:10px;color:var(--text-muted)">—</span>
          <div style="display:flex;gap:6px">
            <button id="btn-drive-refresh" onclick="window.DrivePanel&&DrivePanel.refresh()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text-muted);font-size:10px;padding:4px 8px;border-radius:4px;cursor:pointer" aria-label="Refresh file list">↻</button>
            <button id="btn-drive-import" disabled onclick="window.DrivePanel&&DrivePanel.importSelected()" style="background:var(--accent);border:none;color:white;font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;cursor:pointer;opacity:0.4" aria-label="Import selected file">Import →</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function buildSchedulingPane() {
  return paneShell('scheduling', 'Scheduling', 'Gantt, milestones, task assignment', `
    <div class="sidebar-section-head">Timeline</div>
    ${featureRow('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="8" y1="4" x2="8" y2="20"/>', 'Project Gantt', '', "document.getElementById('modal-gantt')&&(document.getElementById('modal-gantt').style.display='flex',document.getElementById('modal-gantt').classList.remove('hidden'))")}
    <div class="sidebar-section-head" style="display:flex;align-items:center;gap:8px">Features <span class="badge-alpha">Alpha</span></div>
    <div style="padding:8px 14px;font-size:11px;color:var(--shell-muted);line-height:1.5">
      Interactive Gantt charts, task assignment, milestone tracking, critical path (CPM) analysis, and Revit phasing-linked construction sequences are available in open alpha.
    </div>
  `);
}

function buildSimulationsPane() {
  return paneShell('simulations', 'Simulations', 'All analysis engines in one place', `
    <div class="sidebar-section-head">Engines</div>
    ${featureRow('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', 'Energy Analysis', 'LIVE', "document.getElementById('btn-energy')&&document.getElementById('btn-energy').click()")}
    ${featureRow('<rect x="5" y="5" width="14" height="10" rx="1"/><rect x="8" y="15" width="8" height="4" rx="1"/>', 'MEP Systems', 'LIVE', "document.getElementById('btn-mep')&&document.getElementById('btn-mep').click()")}
    ${featureRow('<path d="M12 22s8-4 8-10a8 8 0 1 0-16 0c0 6 8 10 8 10z"/>', 'Fire Protection', 'LIVE', "document.getElementById('btn-fire')&&document.getElementById('btn-fire').click()")}
    ${featureRow('<circle cx="12" cy="12" r="9"/><path d="M12 3v4M3.5 7.5l3.2 1.8"/>', 'Geotechnical', 'LIVE', "document.getElementById('btn-geo')&&document.getElementById('btn-geo').click()")}
    <div class="sidebar-section-head" style="display:flex;align-items:center;gap:8px">Coming Soon</div>
    <button class="sidebar-feature-row" style="opacity:0.5;cursor:default" aria-disabled="true" aria-label="Structural FEA — coming Q3 2026">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="3" rx="1"/><rect x="3" y="18" width="18" height="3" rx="1"/><line x1="7" y1="6" x2="7" y2="18"/><line x1="17" y1="6" x2="17" y2="18"/></svg>
      <span class="row-label">Structural FEA</span>
      <span class="row-meta">Q3 2026</span>
    </button>
    <div style="padding:10px 14px 4px">
      <button onclick="document.getElementById('modal-simulations')&&(document.getElementById('modal-simulations').style.display='flex',document.getElementById('modal-simulations').classList.remove('hidden'))" style="width:100%;padding:8px;background:var(--shell-accent-dim);border:1px solid rgba(52,121,196,0.25);border-radius:6px;color:var(--shell-accent);font-size:12px;font-weight:600;cursor:pointer;transition:background 0.12s" onmouseover="this.style.background='rgba(52,121,196,0.22)'" onmouseout="this.style.background='var(--shell-accent-dim)'" aria-label="Open unified simulations launcher">
        Open Launcher →
      </button>
    </div>
  `);
}

function buildCollaborationPane() {
  return paneShell('collaboration', 'Collaboration', 'Presence, issues, comments', `
    <div class="sidebar-section-head">Live</div>
    ${featureRow('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>', 'Share Project', '', "document.getElementById('btn-share-presence')&&document.getElementById('btn-share-presence').click()")}
    ${featureRow('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>', 'Active Collaborators', '', "document.getElementById('btn-collab')&&document.getElementById('btn-collab').click()")}
    <div class="sidebar-section-head">Issues</div>
    ${featureRow('<path d="M12 2l9 16H3L12 2z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/>', 'Issue Tracker', '', "document.getElementById('btn-show-issues')&&document.getElementById('btn-show-issues').click()")}
    <div class="sidebar-section-head">Forum</div>
    ${featureRow('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 'Community Forum', '', "document.getElementById('btn-forum')&&document.getElementById('btn-forum').click()")}
    <div class="sidebar-section-head" style="display:flex;align-items:center;gap:8px">Chat <span class="badge-alpha">Alpha</span></div>
    <div style="padding:8px 14px;font-size:11px;color:var(--shell-muted);line-height:1.5">
      Real-time in-model chat threads, camera-linked comment pins, and @mention notifications are available in open alpha.
    </div>
  `);
}

function buildVersionsPane() {
  return paneShell('versions', 'Versions', 'Timeline, branch, restore', `
    <div class="sidebar-section-head">Timeline</div>
    <button class="sidebar-feature-row" onclick="openVersionDrawer()" aria-label="Open version timeline drawer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></svg>
      <span class="row-label">Version Timeline</span>
      <span class="row-meta">↓ drawer</span>
    </button>
    <div class="sidebar-section-head" style="display:flex;align-items:center;gap:8px">Branch & Restore <span class="badge-alpha">Alpha</span></div>
    <div style="padding:8px 14px;font-size:11px;color:var(--shell-muted);line-height:1.5">
      Named model snapshots, branch-from-point, comparison diffs, and one-click restore are available in open alpha. Every parameter change is already logged in the audit ledger.
    </div>
    <div class="sidebar-section-head">Audit Log</div>
    ${featureRow('<rect x="3" y="4" width="18" height="3" rx="1"/><rect x="3" y="10" width="18" height="6" rx="1"/>', 'Event Ledger', 'immutable', "console.log('event ledger: view coming soon')")}
  `);
}

function buildDobPane() {
  return paneShell('dob', 'DOB Filing', 'NYC Department of Buildings', `
    <div class="sidebar-section-head">Actions</div>
    ${featureRow('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 12 18 15 15"/><line x1="12" y1="12" x2="12" y2="18"/>', 'DOB Filing Tracker', '', "document.getElementById('modal-dob-tracker')&&(document.getElementById('modal-dob-tracker').style.display='flex',document.getElementById('modal-dob-tracker').classList.remove('hidden'))")}
    ${featureRow('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', 'Generate DOB Package', '', "document.getElementById('btn-energy')&&document.getElementById('btn-energy').click()")}
    <div class="sidebar-section-head">Status</div>
    <div style="padding:8px 14px;font-size:11px;color:var(--shell-muted);line-height:1.5">
      9-PDF DOB submission bundle (EN-001 through EN-008 + TR1) is generated automatically from your energy simulation run.
    </div>
  `);
}

function buildStorePane() {
  return paneShell('store', 'Asset Store', 'Marketplace for BIM assets', `
    <div class="sidebar-section-head">Browse</div>
    ${featureRow('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>', 'Browse Store', '', "window.openStore && window.openStore();closeNavRail()")}
    ${featureRow('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', 'Categories', '7 types', "window.openStore && window.openStore('categories');closeNavRail()")}
    <div class="sidebar-section-head">My Assets</div>
    ${featureRow('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 'My Library', 'acquired assets', "window.openMyAssets && window.openMyAssets();closeNavRail()")}
    ${featureRow('<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>', 'My Listings', 'uploaded assets', "window.openMyAssets && window.openMyAssets('listings');closeNavRail()")}
    ${featureRow('<path d="M3 6h18M3 12h18M3 18h18"/>', 'Analytics', 'earnings', "window.openMyAssets && window.openMyAssets('analytics');closeNavRail()")}
    <div class="sidebar-section-head">Upload</div>
    ${featureRow('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', 'Upload Asset', '', "window.openUploadModal && window.openUploadModal();closeNavRail()")}
    <div class="sidebar-section-head">External</div>
    ${featureRow('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>', 'External Search', 'BIMObject, Exchange', "window.openStore && window.openStore('external');closeNavRail()")}
  `);
}

/* ── Properties Panel Tabs ─────────────────────────────────── */

const PROPS_TABS = [
  { id: 'properties', label: 'Summary'    },
  { id: 'materials',  label: 'Materials'  },
  { id: 'constraints',label: 'Constraints'},
  { id: 'history',    label: 'History'    },
  { id: 'violations', label: 'Violations' },
];

let activePropsTab = 'properties';

function buildPropsTabStrip() {
  const header = document.getElementById('props-header');
  if (!header) return;

  // Check if tabs already injected
  if (document.getElementById('props-tabs')) return;

  const strip = document.createElement('div');
  strip.id = 'props-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Properties panel tabs');

  PROPS_TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'props-tab-btn' + (tab.id === activePropsTab ? ' active' : '');
    btn.id = `props-tab-btn-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', `props-tab-pane-${tab.id}`);
    btn.setAttribute('aria-selected', String(tab.id === activePropsTab));
    btn.textContent = tab.label;
    btn?.addEventListener('click', () => switchPropsTab(tab.id));
    strip.appendChild(btn);
  });

  // Insert after header
  header.insertAdjacentElement('afterend', strip);

  // Wrap existing content in tab panes
  wrapPropsContent();
}

function wrapPropsContent() {
  const propsContent = document.getElementById('properties-content');
  if (!propsContent) return;

  // Wrap existing properties-content in the Properties pane
  const wrapper = document.createElement('div');
  wrapper.id = 'props-tab-pane-properties';
  wrapper.className = 'props-tab-pane active';
  wrapper.setAttribute('role', 'tabpanel');
  wrapper.setAttribute('aria-labelledby', 'props-tab-btn-properties');
  propsContent.parentNode.insertBefore(wrapper, propsContent);
  wrapper.appendChild(propsContent);

  // Create Materials pane
  insertPropPane('materials', `
    <div style="padding:10px 14px;font-size:11px;color:var(--shell-muted)">
      Select an element to inspect its material layers.
    </div>
    <div id="props-materials-list"></div>
  `);

  // Create Constraints pane
  insertPropPane('constraints', `
    <div style="padding:10px 14px;font-size:11px;color:var(--shell-muted)">
      DAG parameter constraints for the selected element.
    </div>
    <div id="props-constraints-list" style="padding:0 14px;font-size:11px;color:var(--shell-muted)">No element selected.</div>
  `);

  // Create History pane
  insertPropPane('history', `
    <div style="padding:10px 14px;font-size:11px;color:var(--shell-muted)">
      Recent changes from the event ledger.
    </div>
    <div id="props-history-list"></div>
  `);

  // Create Violations pane
  insertPropPane('violations', `
    <div style="padding:10px 14px;font-size:11px;color:var(--shell-muted)">
      Code compliance violations detected by the constraint solver.
    </div>
    <div id="props-violations-list">
      <div style="padding:6px 14px;font-size:11px;color:var(--shell-success)">✓ No violations detected</div>
    </div>
  `);
}

function insertPropPane(id, html) {
  const strip = document.getElementById('props-tabs');
  if (!strip) return;
  const pane = document.createElement('div');
  pane.id = `props-tab-pane-${id}`;
  pane.className = 'props-tab-pane';
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-labelledby', `props-tab-btn-${id}`);
  pane.innerHTML = html;
  strip.insertAdjacentElement('afterend', pane);
}

function switchPropsTab(tabId) {
  activePropsTab = tabId;
  document.querySelectorAll('.props-tab-btn').forEach(btn => {
    const active = btn.id === `props-tab-btn-${tabId}`;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.props-tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `props-tab-pane-${tabId}`);
  });
}

/* ── Version Timeline Drawer ────────────────────────────────── */

let vtlOpen = false;
const VTL_MOCK_COMMITS = [
  { label: 'Phase 30', current: false },
  { label: 'Phase 29', current: false },
  { label: 'Phase 27', current: false },
  { label: 'Rotation', current: false },
  { label: 'Current',  current: true  },
];

function buildVersionDrawer() {
  const existing = document.getElementById('version-timeline-drawer');
  if (existing) return; // Already built

  const drawer = document.createElement('div');
  drawer.id = 'version-timeline-drawer';
  drawer.setAttribute('role', 'region');
  drawer.setAttribute('aria-label', 'Version timeline');

  drawer.innerHTML = `
    <div id="version-timeline-handle" role="button" tabindex="0" aria-expanded="false" aria-controls="version-timeline-drawer" onclick="toggleVersionDrawer()" onkeydown="if(event.key==='Enter'||event.key===' ')toggleVersionDrawer()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></svg>
      <span class="vtl-title">Version Timeline</span>
      <span class="vtl-spacer"></span>
      <button id="btn-vtl-close" onclick="event.stopPropagation();closeVersionDrawer()" aria-label="Close version timeline">✕</button>
    </div>
    <div id="vtl-inner" style="display:flex;flex:1;overflow:hidden">
      <div id="version-timeline-track" role="list" aria-label="Version commits">
        ${VTL_MOCK_COMMITS.map((c, i) => `
          <div class="vtl-commit${c.current ? ' current' : ''}" role="listitem" tabindex="0" aria-label="Version: ${c.label}${c.current ? ' (current)' : ''}" onkeydown="if(event.key==='Enter')this.click()">
            <div class="vtl-dot"></div>
            <div class="vtl-label">${c.label}</div>
          </div>
        `).join('')}
      </div>
      <div id="vtl-actions">
        <button class="vtl-action-btn" onclick="showVtlToast('Snapshot saved')" aria-label="Save snapshot">Save Snapshot</button>
        <button class="vtl-action-btn" onclick="showVtlToast('Branch feature 2014 open alpha')" aria-label="Branch from this point">Branch</button>
        <button class="vtl-action-btn" onclick="showVtlToast('Restore 2014 open alpha')" aria-label="Restore selected version">Restore</button>
      </div>
    </div>
  `;

  document.body.appendChild(drawer);
}

function showVtlToast(msg) {
  // Reuse existing toast system if available
  if (window.showToast) { window.showToast(msg, 'info'); return; }
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1d5fa6;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;pointer-events:none';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function openVersionDrawer() {
  buildVersionDrawer();
  const drawer = document.getElementById('version-timeline-drawer');
  if (!drawer) return;
  vtlOpen = true;
  drawer.classList.add('open');
  const handle = document.getElementById('version-timeline-handle');
  if (handle) handle.setAttribute('aria-expanded', 'true');
}

function closeVersionDrawer() {
  const drawer = document.getElementById('version-timeline-drawer');
  if (!drawer) return;
  vtlOpen = false;
  drawer.classList.remove('open');
  const handle = document.getElementById('version-timeline-handle');
  if (handle) handle.setAttribute('aria-expanded', 'false');
}

function toggleVersionDrawer() {
  if (vtlOpen) closeVersionDrawer(); else openVersionDrawer();
}

/* ── Presence Share Button ──────────────────────────────────── */

function buildShareButton() {
  const cluster = document.getElementById('presence-cluster');
  if (!cluster) return;
  if (document.getElementById('btn-share-presence')) return; // Already built

  const btn = document.createElement('button');
  btn.id = 'btn-share-presence';
  btn.setAttribute('aria-label', 'Share project with collaborators');
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Share`;
  btn?.addEventListener('click', () => {
    const url = window.location.href;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => showVtlToast('Project link copied!')).catch(() => showVtlToast('Share: ' + url));
    } else {
      showVtlToast('Share link: ' + url);
    }
  });

  cluster.insertAdjacentElement('afterend', btn);
  cluster.style.display = 'flex';
}

/* ── Contextual Toolbar Morph ───────────────────────────────── */
/* Data-context groups in the toolbar light up based on selection type.
   We watch for selection events broadcast by app.js.             */

function bindContextualToolbar() {
  // Listen for selection events from app.js
  window.addEventListener('bim-selection', (e) => {
    applyToolbarContext(e.detail && e.detail.type);
  });

  // If nothing selected, clear context
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#viewport-area') && !e.target.closest('#toolbar')) return;
  });
}

function applyToolbarContext(elementType) {
  document.querySelectorAll('.toolbar-context-group').forEach(g => {
    g.classList.remove('context-visible');
  });
  if (!elementType) return;
  const group = document.querySelector(`.toolbar-context-group[data-context="${elementType}"]`);
  if (group) group.classList.add('context-visible');
}

/* ── Version Drawer toggle from "Versions" tab btn ─────────── */
// Expose on window for nav rail btn click

/* ── Init ───────────────────────────────────────────────────── */

function initAppShell() {
  buildNavRail();
  buildSidebarPanes();

  // Bootstrap data-state on sidebar-expanded so CSS animation system
  // has a defined starting state (avoids undefined → 'open' transition flash)
  const _expInit = document.getElementById('sidebar-expanded');
  if (_expInit && !_expInit.dataset.state) _expInit.dataset.state = 'closed';

  // margin-left is handled by CSS: margin-left: calc(var(--nav-w) + var(--sidebar-w))
  // on .main-layout. No JS pixel values needed here.

  // Wire properties tabs after app.js inits (slight delay)
  setTimeout(() => {
    buildPropsTabStrip();
    buildShareButton();
  }, 800);

  bindContextualToolbar();

  // Keyboard shortcut: ` (backtick) toggles version drawer
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '`') {
      e.preventDefault();
      toggleVersionDrawer();
    }
  });
}

// Wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAppShell);
} else {
  initAppShell();
}

/* ── Expose globals ─────────────────────────────────────────── */
window.toggleNavTab       = toggleNavTab;
window.closeNavRail       = closeNavRail;
window.openVersionDrawer  = openVersionDrawer;
window.closeVersionDrawer = closeVersionDrawer;
window.toggleVersionDrawer = toggleVersionDrawer;
window.switchPropsTab     = switchPropsTab;
window.applyToolbarContext = applyToolbarContext;
