/**
 * Module System UI — frontend for SP-A: Attachment Engine + Base Module
 * Owns: module panel UI, modal open/close, API calls, derived value preview.
 * Does NOT own: calculation logic (services/), DB persistence (db/attachments.js).
 */

(function() {
  var _currentProjectId = null;
  var _currentConfig = null;
  var _isLocked = false;

  // ─── Unit system presets ─────────────────────────────────────────────────────
  var SYSTEM_PRESETS = {
    si:      { label: 'SI (Meter)', M_default: 1000, M_hint: 'Standard: 600mm (residential), 1000mm (office), 1200mm (warehouse)', unitOptions: ['mm', 'cm', 'm'] },
    imperial:{ label: 'Imperial (ft-in)', M_default: 304.8, M_hint: 'Standard: 12" (residential), 48" (grid)', unitOptions: ['in', 'ft'] },
    modulor: { label: 'Le Corbusier Modulor', M_default: 226, M_hint: 'Base unit = 226mm. Derived from golden ratio.', unitOptions: ['mm', 'M'] },
    ken:     { label: 'Japanese Ken', M_default: 910, M_hint: 'Ken = 910mm (3 shaku 0 sun). 2-ken = 1820mm room.', unitOptions: ['mm', 'ken'] },
    custom:  { label: 'Custom', M_default: 1000, M_hint: 'Enter your own base module value.', unitOptions: ['mm', 'cm', 'm', 'in', 'ft'] },
  };

  // ─── Derived value computation (mirrors services/module-system.js) ──────────
  function computeDerived(M, systemName) {
    var M_mm = systemName === 'imperial' ? M * 25.4 : M;
    var halfM = M_mm / 2;
    var quarterM = M_mm / 4;
    var eighthM = M_mm / 8;
    var doubleM = M_mm * 2;
    var quadrupleM = M_mm * 4;

    var snapFine = eighthM;
    var snapCoarse = quarterM;
    var redOverlay = eighthM / 2;
    var amberOverlay = eighthM;

    return {
      M_mm: M_mm,
      grid: 'M (' + fmtMM(M_mm) + '), M/2 (' + fmtMM(halfM) + '), M/4 (' + fmtMM(quarterM) + '), 2M (' + fmtMM(doubleM) + '), 4M (' + fmtMM(quadrupleM) + ')',
      snapFine: 'M/8 = ' + fmtMM(eighthM),
      wall: 'M/4=' + fmtMM(quarterM) + ', M/3=' + fmtMM(M_mm / 3) + ', M/2=' + fmtMM(halfM),
      door: '2M=' + fmtMM(doubleM) + ' wide × 4M=' + fmtMM(quadrupleM) + ' tall',
      height: '4M = ' + fmtMM(quadrupleM),
      col: '4M = ' + fmtMM(quadrupleM),
      slab: 'M/4 = ' + fmtMM(quarterM),
      red: 'M/16 = ' + fmtMM(redOverlay),
      amber: 'M/8 = ' + fmtMM(amberOverlay),
      snapCoarse: 'M/4 = ' + fmtMM(snapCoarse),
    };
  }

  function fmtMM(mm) {
    if (Math.abs(mm) >= 1000) return (mm / 1000).toFixed(3) + ' m';
    return Math.round(mm) + ' mm';
  }

  function fmtInches(mm) {
    var in_ = mm / 25.4;
    var ft = Math.floor(in_ / 12);
    var ins = Math.round(in_ % 12);
    if (ft === 0) return ins + '"';
    if (ins === 0) return ft + "'";
    return ft + "'-" + ins + '"';
  }

  // ─── UI helpers ─────────────────────────────────────────────────────────────
  function showModal(id) {
    var el = document.getElementById(id);
    if (el) { el.style.display = 'flex'; el.classList.remove('hidden'); }
  }

  function hideModal(id) {
    var el = document.getElementById(id);
    if (el) { el.style.display = 'none'; }
  }

  // ─── Public API (called from app.html onclick handlers) ─────────────────────

  window.openModulePanel = function() {
    if (!window.currentProjectId) {
      alert('No project open. Create or open a project first.');
      return;
    }
    _currentProjectId = window.currentProjectId;
    showModal('modal-module');
    loadModuleConfig();
  };

  window.closeModulePanel = function() {
    hideModal('modal-module');
  };

  window.selectModuleSystem = function(system) {
    var preset = SYSTEM_PRESETS[system];
    if (!preset) return;

    // Update M input hint
    var hintEl = document.getElementById('module-M-hint');
    if (hintEl) hintEl.textContent = preset.M_hint;

    // Update unit dropdown
    var unitSel = document.getElementById('module-M-unit');
    if (unitSel) {
      unitSel.innerHTML = '';
      preset.unitOptions.forEach(function(u) {
        var opt = document.createElement('option');
        opt.value = u; opt.textContent = u;
        unitSel.appendChild(opt);
      });
    }

    // Set default M value
    var inputEl = document.getElementById('module-M-input');
    if (inputEl && !_isLocked) {
      inputEl.value = preset.M_default;
    }

    // Update system button highlights
    document.querySelectorAll('.module-sys-btn').forEach(function(btn) {
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
    });
    var activeBtn = document.querySelector('.module-sys-btn[data-system="' + system + '"]');
    if (activeBtn) {
      activeBtn.style.background = 'rgba(192,132,252,0.2)';
      activeBtn.style.borderColor = 'rgba(192,132,252,0.5)';
      activeBtn.style.color = '#c084fc';
    }

    updateModuleDerivedPreview();
  };

  window.updateModuleDerivedPreview = function() {
    var inputEl = document.getElementById('module-M-input');
    var unitEl = document.getElementById('module-M-unit');
    if (!inputEl || !unitEl) return;

    var M_val = parseFloat(inputEl.value) || 1000;
    var unit = unitEl.value;
    var systemEl = document.querySelector('.module-sys-btn[style*="rgba(192,132,252,0.2)"]');
    var system = systemEl ? systemEl.getAttribute('data-system') : 'si';

    // Convert to mm
    var M_mm = M_val;
    if (unit === 'in') M_mm = M_val * 25.4;
    else if (unit === 'ft') M_mm = M_val * 304.8;
    else if (unit === 'cm') M_mm = M_val * 10;
    else if (unit === 'm') M_mm = M_val * 1000;
    // mm stays as-is

    var d = computeDerived(M_mm, system);

    var els = {
      'd-grid': d.grid,
      'd-snap-fine': d.snapFine,
      'd-wall': d.wall,
      'd-door': d.door,
      'd-height': d.height,
      'd-col': d.col,
      'd-slab': d.slab,
      'd-red': d.red,
    };
    for (var id in els) {
      var el = document.getElementById(id);
      if (el) el.textContent = els[id];
    }

    // Update status display
    var systemLabel = SYSTEM_PRESETS[system] ? SYSTEM_PRESETS[system].label : 'Custom';
    var M_display = system === 'imperial' ? fmtInches(M_mm) + ' (' + fmtMM(M_mm) + ')' : fmtMM(M_mm);
    var dispEl = document.getElementById('module-M-display');
    if (dispEl) dispEl.textContent = M_display;
    var sysDispEl = document.getElementById('module-system-display');
    if (sysDispEl) sysDispEl.textContent = systemLabel + ' · Locked: ' + (_isLocked ? 'Yes' : 'No');
  };

  window.toggleModuleMultiples = function() {
    var cb = document.getElementById('module-multiples-toggle');
    if (!cb) return;
    var toggleEl = cb.parentElement.querySelector('span:first-child');
    var knobEl = cb.parentElement.querySelector('span:last-child');
    if (cb.checked) {
      if (toggleEl) toggleEl.style.background = '#c084fc';
      if (knobEl) knobEl.style.transform = 'translateX(20px)';
    } else {
      if (toggleEl) toggleEl.style.background = '';
      if (knobEl) knobEl.style.transform = '';
    }
    var badgeEl = document.getElementById('module-multiples-badge');
    if (badgeEl) badgeEl.textContent = 'Multiples: ' + (cb.checked ? 'On (4M)' : 'Off');
  };

  window.toggleModuleNYC = function() {
    var cb = document.getElementById('module-nyc-toggle');
    if (!cb) return;
    var toggleEl = cb.parentElement.querySelector('span:first-child');
    var knobEl = cb.parentElement.querySelector('span:last-child');
    if (cb.checked) {
      if (toggleEl) toggleEl.style.background = '#ef4444';
      if (knobEl) knobEl.style.transform = 'translateX(20px)';
    } else {
      if (toggleEl) toggleEl.style.background = '';
      if (knobEl) knobEl.style.transform = '';
    }
    var badgeEl = document.getElementById('module-nyc-badge');
    if (badgeEl) badgeEl.textContent = 'NYC DOB: ' + (cb.checked ? 'Yes (32" min doors)' : 'No');
  };

  window.toggleModuleLock = function() {
    var btn = document.getElementById('module-lock-btn');
    var banner = document.getElementById('module-locked-banner');
    if (!_isLocked) {
      _isLocked = true;
      if (btn) {
        btn.textContent = 'Unlock M';
        btn.style.background = 'rgba(34,197,94,0.15)';
        btn.style.borderColor = 'rgba(34,197,94,0.4)';
        btn.style.color = '#22c55e';
      }
      if (banner) banner.style.display = 'block';
      var M_input = document.getElementById('module-M-input');
      if (M_input) M_input.disabled = true;
    } else {
      if (!confirm('Unlock the module? Changing M value while elements are placed may cause geometry misalignment. Proceed?')) return;
      _isLocked = false;
      if (btn) {
        btn.textContent = 'Lock M';
        btn.style.background = 'rgba(245,158,11,0.15)';
        btn.style.borderColor = 'rgba(245,158,11,0.4)';
        btn.style.color = '#f59e0b';
      }
      if (banner) banner.style.display = 'none';
      var M_input2 = document.getElementById('module-M-input');
      if (M_input2) M_input2.disabled = false;
    }
    updateModuleDerivedPreview();
  };

  window.saveModuleConfig = async function() {
    if (!_currentProjectId) return;

    var inputEl = document.getElementById('module-M-input');
    var unitEl = document.getElementById('module-M-unit');
    var sysEl = document.querySelector('.module-sys-btn[style*="rgba(192,132,252,0.2)"]');
    var system = sysEl ? sysEl.getAttribute('data-system') : 'si';

    var M_val = parseFloat(inputEl.value) || 1000;
    var unit = unitEl.value;
    var M_mm = M_val;
    if (unit === 'in') M_mm = M_val * 25.4;
    else if (unit === 'ft') M_mm = M_val * 304.8;
    else if (unit === 'cm') M_mm = M_val * 10;
    else if (unit === 'm') M_mm = M_val * 1000;

    var multiplesEl = document.getElementById('module-multiples-toggle');
    var nycEl = document.getElementById('module-nyc-toggle');

    var payload = {
      system_name: system,
      system_label: SYSTEM_PRESETS[system] ? SYSTEM_PRESETS[system].label : 'Custom',
      M_value: M_mm,
      M_raw_input: M_val + ' ' + unit,
      is_locked: _isLocked,
      is_nyc: nycEl ? nycEl.checked : false,
      show_multiples: multiplesEl ? multiplesEl.checked : false,
    };

    try {
      var resp = await fetch('/api/attachments/module/' + _currentProjectId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        if (text.includes('MODULE_LOCKED')) {
          alert('Module is locked. Unlock first to change M value.');
        } else {
          alert('Error saving: ' + text.slice(0, 200));
        }
        return;
      }
      var data = await resp.json();

      // Update local state
      _currentConfig = data.module_project;
      var d = computeDerived(data.module_project.M_value, data.module_project.system_name);
      updateOverlaySummary(null);

      // Show success
      var badge = document.getElementById('module-badge');
      if (badge) {
        badge.style.background = 'rgba(34,197,94,0.15)';
        badge.style.borderColor = 'rgba(34,197,94,0.4)';
        badge.style.color = '#22c55e';
        badge.textContent = '✓';
        setTimeout(function() {
          badge.style.background = '';
          badge.style.borderColor = '';
          badge.style.color = '';
          badge.textContent = 'M';
        }, 1500);
      }

    } catch(err) {
      console.error('[module-system] save error:', err);
      alert('Failed to save module config: ' + err.message);
    }
  };

  window.loadModuleConfig = async function() {
    if (!_currentProjectId) return;
    try {
      var resp = await fetch('/api/attachments/module/' + _currentProjectId);
      var data = await resp.json();

      if (data.module_project) {
        _currentConfig = data.module_project;
        _isLocked = data.module_project.is_locked;

        // Populate UI
        var M_val = data.module_project.M_value;
        var unit = data.module_project.system_name === 'imperial' ? 'in' : 'mm';
        var inputEl = document.getElementById('module-M-input');
        if (inputEl) {
          inputEl.value = data.module_project.system_name === 'imperial' ? (M_val / 25.4).toFixed(1) : M_val;
          inputEl.disabled = _isLocked;
        }

        var unitEl = document.getElementById('module-M-unit');
        if (unitEl) unitEl.value = unit;

        var nycEl = document.getElementById('module-nyc-toggle');
        if (nycEl) nycEl.checked = data.module_project.is_nyc;
        toggleModuleNYC();

        var multEl = document.getElementById('module-multiples-toggle');
        if (multEl) multEl.checked = data.module_project.show_multiples;
        toggleModuleMultiples();

        var btn = document.getElementById('module-lock-btn');
        if (btn) {
          if (_isLocked) {
            btn.textContent = 'Unlock M';
            btn.style.background = 'rgba(34,197,94,0.15)';
            btn.style.borderColor = 'rgba(34,197,94,0.4)';
            btn.style.color = '#22c55e';
          }
        }

        var banner = document.getElementById('module-locked-banner');
        if (banner) banner.style.display = _isLocked ? 'block' : 'none';

        selectModuleSystem(data.module_project.system_name);
        updateModuleDerivedPreview();

        // Load overlay stats
        updateOverlaySummary(null);
      } else {
        selectModuleSystem('si');
        updateModuleDerivedPreview();
      }
    } catch(err) {
      console.error('[module-system] load error:', err);
      selectModuleSystem('si');
      updateModuleDerivedPreview();
    }
  };

  window.runModuleComplianceCheck = async function() {
    if (!_currentProjectId) return;
    try {
      var resp = await fetch('/api/attachments/check/' + _currentProjectId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!resp.ok) { alert('Compliance check failed (HTTP ' + resp.status + ')'); return; }
      var data = await resp.json();
      updateOverlaySummary(data.stats);

      if (data.stats && data.stats.RED > 0) {
        alert('⚠ ' + data.stats.RED + ' RED violations found. Check the overlay summary and fix before export.');
      } else if (data.stats && data.stats.AMBER > 0) {
        alert('⚡ ' + data.stats.AMBER + ' AMBER warnings found. Review recommended before filing.');
      } else {
        alert('✅ All attachments pass code compliance checks.');
      }
    } catch(err) {
      console.error('[module-system] compliance check error:', err);
      alert('Compliance check failed: ' + err.message);
    }
  };

  window.runLoadPathCheck = async function() {
    if (!_currentProjectId) return;
    try {
      var resp = await fetch('/api/attachments/load-path/' + _currentProjectId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!resp.ok) { alert('Load path check failed (HTTP ' + resp.status + ')'); return; }
      var data = await resp.json();
      var parts = [];
      parts.push('Load path: ' + data.summary.total_edges + ' edges');
      if (data.summary.missing_support_count > 0) {
        parts.push('⚠ ' + data.summary.missing_support_count + ' elements with missing support');
      } else {
        parts.push('✅ All elements have vertical support');
      }
      if (data.summary.has_lateral) {
        parts.push('✅ Lateral system: ' + data.summary.lateral_system_types.join(', '));
      } else {
        parts.push(data.lateral_system.missingSystem
          ? '⚠ ' + data.lateral_system.message
          : 'ℹ Single-story — lateral system not required');
      }
      alert(parts.join('\n'));
    } catch(err) {
      console.error('[module-system] load path error:', err);
      alert('Load path check failed: ' + err.message);
    }
  };

  function updateOverlaySummary(stats) {
    var container = document.getElementById('module-overlay-summary');
    if (!container) return;

    if (!stats) {
      // Fetch current stats
      fetch('/api/attachments/overlays/' + (_currentProjectId || '') + '?verdict=RED')
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          if (data.stats) updateOverlayStats(data.stats);
        })
        .catch(function() {});
      return;
    }

    updateOverlayStats(stats);
  }

  function updateOverlayStats(stats) {
    var container = document.getElementById('module-overlay-summary');
    if (!container) return;
    container.style.display = 'block';

    var redEl = document.getElementById('overlay-red-count');
    var amberEl = document.getElementById('overlay-amber-count');
    var greenEl = document.getElementById('overlay-green-count');

    if (redEl) redEl.textContent = (stats.RED || 0) + ' RED';
    if (amberEl) amberEl.textContent = (stats.AMBER || 0) + ' AMBER';
    if (greenEl) greenEl.textContent = (stats.GREEN || 0) + ' GREEN';

    var sum = (stats.RED || 0) + (stats.AMBER || 0) + (stats.GREEN || 0);
    if (sum === 0) container.style.display = 'none';
  }

  // Wire up live M input updates
  document.addEventListener('DOMContentLoaded', function() {
    var mInput = document.getElementById('module-M-input');
    var mUnit = document.getElementById('module-M-unit');
    if (mInput) {
      mInput.addEventListener('input', updateModuleDerivedPreview);
    }
    if (mUnit) {
      mUnit.addEventListener('change', updateModuleDerivedPreview);
    }
  });

  // ─── Snap utility (client-side) ───────────────────────────────────────────
  // Exposed so other UI components can use it
  window.moduleSnap = async function(targetPos_mm, anchors, M_mm, snapMode) {
    try {
      var resp = await fetch('/api/attachments/snap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_position_mm: targetPos_mm,
          anchor_positions_mm: anchors || [],
          M_mm: M_mm || 1000,
          snap_mode: snapMode || 'fine',
        }),
      });
      return await resp.json();
    } catch(err) {
      console.error('[module-system] snap error:', err);
      return { snapped: targetPos_mm, snapDelta: 0, isSnap: false };
    }
  };

})();