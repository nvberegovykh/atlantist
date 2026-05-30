/**
 * WalltBridge — Phase 34D
 * Routes Wallt action chips to existing app modules.
 * Called by wallt.js; never calls back into wallt.js to avoid circular deps.
 *
 * Exposes: window.WalltBridge.execute(action) → Promise<{ ok, message }>
 */
(function() {
  'use strict';

  // ── Telemetry helper ──────────────────────────────────────────────────────

  function logEvent(eventName, props) {
    fetch('/api/app-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        event_name: eventName,
        url: window.location.pathname,
        properties: props,
      }),
    }).catch(() => {});
  }

  // ── Toast helper ─────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    const existing = document.getElementById('wallt-bridge-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'wallt-bridge-toast';
    toast.style.cssText = [
      'position:fixed',
      'bottom:100px',
      'right:24px',
      'z-index:10000',
      'padding:10px 18px',
      'border-radius:8px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
      'font-size:13px',
      'font-weight:500',
      'color:#fff',
      'box-shadow:0 4px 20px rgba(0,0,0,.4)',
      'transition:opacity .3s',
      type === 'success' ? 'background:#1e4a2a;border:1px solid #2d7a42' : 'background:#4a1e1e;border:1px solid #7a2d2d',
    ].join(';');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
  }

  // ── open_modal handler ────────────────────────────────────────────────────

  function executeOpenModal(action) {
    const { modal_id, prefill = {} } = action.params;

    // Map modal_id to existing app.js panel open functions
    const modalMap = {
      'export':              () => openExportModal(prefill),
      'level-editor':        () => openLevelEditor(prefill),
      'element-properties':  () => openElementProperties(prefill),
      'energy-sim':          () => navigateTo('energy'),
      'family-browser':      () => openFamilyBrowser(prefill),
      'zoning-report':       () => openZoningReport(prefill),
      'structural-analysis': () => navigateTo('structural'),
      'schedule':            () => navigateTo('schedules'),
      'issue-create':        () => openIssueCreate(prefill),
    };

    const handler = modalMap[modal_id];
    if (!handler) return { ok: false, message: `Unknown modal: ${modal_id}` };

    try {
      handler();
      return { ok: true, message: `Opened ${modal_id.replace(/-/g, ' ')}` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  function openExportModal(prefill) {
    // Try to open the export panel — look for existing tab/button
    const exportBtn = document.querySelector('[data-panel="export"], [data-action="export"], #export-btn, .export-btn');
    if (exportBtn) {
      exportBtn.click();
    } else {
      // Fallback: trigger custom event that app.js listens to
      document.dispatchEvent(new CustomEvent('wallt:open-export', { detail: prefill }));
    }
    // Prefill format if provided
    if (prefill.format) {
      setTimeout(() => {
        const sel = document.querySelector('#export-format, [name="export-format"]');
        if (sel) sel.value = prefill.format;
      }, 200);
    }
    // Prefill level if provided
    if (prefill.level_id) {
      setTimeout(() => {
        const sel = document.querySelector('#export-level, [name="export-level"]');
        if (sel) sel.value = prefill.level_id;
      }, 200);
    }
  }

  function openLevelEditor(prefill) {
    document.dispatchEvent(new CustomEvent('wallt:open-level-editor', { detail: prefill }));
  }

  function openElementProperties(prefill) {
    if (prefill.element_id) {
      document.dispatchEvent(new CustomEvent('wallt:select-element', { detail: { id: prefill.element_id } }));
    } else {
      document.dispatchEvent(new CustomEvent('wallt:open-properties', { detail: prefill }));
    }
  }

  function openFamilyBrowser(prefill) {
    const familyBtn = document.querySelector('[data-panel="families"], #families-btn, .families-tab');
    if (familyBtn) {
      familyBtn.click();
    } else {
      document.dispatchEvent(new CustomEvent('wallt:open-families', { detail: prefill }));
    }
  }

  function openZoningReport(prefill) {
    document.dispatchEvent(new CustomEvent('wallt:open-zoning-report', { detail: prefill }));
  }

  function openIssueCreate(prefill) {
    document.dispatchEvent(new CustomEvent('wallt:create-issue', { detail: prefill }));
  }

  // ── spawn_element handler ─────────────────────────────────────────────────

  async function executeSpawnElement(action) {
    const { element_type, count = 1, params = {} } = action.params;
    const projectId = window.currentProjectId;

    if (!projectId) {
      return { ok: false, message: 'No active project — open a project first.' };
    }

    const spawned = [];
    const errors = [];

    for (let i = 0; i < Math.min(count, 50); i++) {
      try {
        let endpoint = '/api/elements';
        let body = { project_id: projectId, type: element_type, ...params };

        if (element_type === 'level') {
          endpoint = '/api/levels';
          body = {
            project_id: projectId,
            name: params.name || `Level ${i + 1}`,
            elevation: (params.elevation || 0) + i * (params.floor_height || 3.5),
          };
        } else if (element_type === 'floor') {
          endpoint = '/api/floors';
          body = { project_id: projectId, ...params };
        } else {
          // wall or column — use elements API
          body.type = element_type;
          // Offset x/z for multiple columns placed at corners
          if (count > 1 && element_type === 'column') {
            const corners = [
              { x: params.x || 0,   z: params.z || 0   },
              { x: (params.x || 0) + (params.width || 10), z: params.z || 0   },
              { x: params.x || 0,   z: (params.z || 0) + (params.depth || 10) },
              { x: (params.x || 0) + (params.width || 10), z: (params.z || 0) + (params.depth || 10) },
            ];
            const corner = corners[i % corners.length];
            body.position_x = corner.x;
            body.position_z = corner.z;
          }
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          errors.push(err.error || `HTTP ${res.status}`);
          continue;
        }

        const data = await res.json();
        spawned.push(data.element || data.level || data.floor || data);
      } catch (e) {
        errors.push(e.message);
      }
    }

    // Reload viewport to show new elements
    if (spawned.length > 0) {
      document.dispatchEvent(new CustomEvent('wallt:elements-spawned', { detail: { spawned, element_type } }));
      // Let app.js refresh its scene
      if (typeof window.loadBIMModel === 'function') window.loadBIMModel();
    }

    if (errors.length > 0 && spawned.length === 0) {
      return { ok: false, message: `Failed: ${errors[0]}` };
    }

    const msg = spawned.length === 1
      ? `Added 1 ${element_type}`
      : `Added ${spawned.length} ${element_type}s${errors.length ? ` (${errors.length} failed)` : ''}`;

    return { ok: true, message: msg, spawned };
  }

  // ── run_export handler ────────────────────────────────────────────────────

  function executeRunExport(action) {
    const { format, scope = {} } = action.params;
    // Open the export modal with format pre-selected
    openExportModal({ format, ...scope });
    return { ok: true, message: `Export panel opened — ${format.toUpperCase()} pre-selected` };
  }

  // ── navigate handler ──────────────────────────────────────────────────────

  function navigateTo(route) {
    // Tab nav: find button or link for the route
    const tabMap = {
      energy: '[data-tab="energy"], [data-panel="energy"], #energy-tab',
      structural: '[data-tab="structural"], [data-panel="structural"], #structural-tab',
      mep: '[data-tab="mep"], [data-panel="mep"], #mep-tab',
      schedules: '[data-tab="schedules"], [data-panel="schedules"], #schedules-tab',
      issues: '[data-tab="issues"], [data-panel="issues"], #issues-tab',
      'design-book': '[data-tab="design-book"], [data-panel="design-book"], #design-book-tab',
      'node-editor': '[data-tab="node-editor"], [data-panel="node-editor"], #node-editor-tab',
      'craft-tour': null,
      store: '[data-tab="store"], [data-panel="store"], #store-tab',
    };

    if (route === 'craft-tour' && window.CraftTour) {
      window.CraftTour.start();
      return;
    }

    const selector = tabMap[route];
    if (selector) {
      const btn = document.querySelector(selector);
      if (btn) { btn.click(); return; }
    }

    // Fallback: dispatch event
    document.dispatchEvent(new CustomEvent('wallt:navigate', { detail: { route } }));
  }

  function executeNavigate(action) {
    try {
      navigateTo(action.params.route);
      return { ok: true, message: `Navigated to ${action.params.route}` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // ── apply_zoning_check handler ────────────────────────────────────────────

  function executeApplyZoningCheck(action) {
    const { district, lot_id } = action.params;
    // Open zoning report panel with district prefilled
    openZoningReport({ district, lot_id });
    return { ok: true, message: `Zoning check for ${district} opened` };
  }

  // ── apply_rect_check handler ─────────────────────────────────────────────
  // Phase 35F: RECT Legal Engine — cooperative pricing compliance check.
  // Runs the full legal opinion set; blocks and escalates on NON_COMPLIANT.

  async function executeApplyRectCheck(action) {
    const { action_type, details, reason } = action.params;
    if (!action_type || !details || !reason) {
      return { ok: false, message: 'apply_rect_check requires action_type, details, and reason.' };
    }

    try {
      const res = await fetch('/api/wallt/legal-engine/rect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action_type, details, reason }),
      });

      const data = await res.json();

      if (data.blocked) {
        const rectOpinion = data.opinions?.rect;
        const summary = rectOpinion ? `${rectOpinion.verdict}: ${rectOpinion.reason}` : 'RECT_NON_COMPLIANT — escalation pending.';
        logEvent('rect_check_blocked', { action_type, verdict: data.overall_verdict, escalation_id: data.escalation_id });
        return {
          ok: false,
          message: `RECT check failed. This action is blocked pending Polsia approval. ${summary}`,
          blocked: true,
          escalation_id: data.escalation_id,
          verdict: data.overall_verdict,
          opinions: data.opinions,
        };
      }

      logEvent('rect_check_passed', { action_type, verdict: data.overall_verdict });
      return {
        ok: true,
        message: 'RECT check passed — cooperative pricing model preserved.',
        verdict: data.overall_verdict,
      };
    } catch (e) {
      logEvent('rect_check_failed', { action_type, error: e.message });
      return { ok: false, message: `RECT check failed: ${e.message}` };
    }
  }

  // ── Main execute() ────────────────────────────────────────────────────────

  async function execute(action) {
    logEvent('action_executed', { type: action.type, params: action.params });

    let result;
    try {
      switch (action.type) {
        case 'open_modal':
          result = executeOpenModal(action);
          break;
        case 'spawn_element':
          result = await executeSpawnElement(action);
          break;
        case 'run_export':
          result = executeRunExport(action);
          break;
        case 'navigate':
          result = executeNavigate(action);
          break;
        case 'apply_zoning_check':
          result = executeApplyZoningCheck(action);
          break;
        case 'apply_rect_check':
          result = await executeApplyRectCheck(action);
          break;
        default:
          result = { ok: false, message: `Unknown action type: ${action.type}` };
      }
    } catch (e) {
      logEvent('action_failed', { type: action.type, error: e.message });
      return { ok: false, message: e.message };
    }

    if (result.ok) {
      showToast(`✓ ${result.message}`);
      logEvent('action_executed', { type: action.type, outcome: 'success' });
    } else {
      showToast(`✗ ${result.message}`, 'error');
      logEvent('action_failed', { type: action.type, outcome: result.message });
    }

    return result;
  }

  // ── Undo support (spawn_element only) ────────────────────────────────────

  async function undo(action, execResult) {
    if (action.type !== 'spawn_element' || !execResult.spawned) {
      return { ok: false, message: 'Undo not supported for this action' };
    }

    const endpoint = action.params.element_type === 'level' ? '/api/levels' : '/api/elements';
    const failures = [];

    for (const el of execResult.spawned) {
      const id = el.id;
      if (!id) continue;
      try {
        const res = await fetch(`${endpoint}/${id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) failures.push(id);
      } catch (e) {
        failures.push(id);
      }
    }

    if (failures.length === 0) {
      showToast('✓ Undone');
      logEvent('action_undone', { type: action.type });
      if (typeof window.loadBIMModel === 'function') window.loadBIMModel();
      return { ok: true, message: 'Undone' };
    }

    showToast(`✗ Undo partially failed (${failures.length} items)`, 'error');
    return { ok: false, message: 'Partial undo failure' };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.WalltBridge = { execute, undo, navigateTo, showToast, logEvent };

})();
