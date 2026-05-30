/**
 * Owns: Geotechnical modal UI — soil layer editor, analysis dispatch, result rendering,
 *       3D cross-section visualization, timeline viewport bindings.
 * Does NOT own: calculation logic (services/geotechnical.js), API routes, DB access.
 *
 * Runs as a non-module script; attaches GeoPanel to window for app.js to call.
 */
(function () {
  'use strict';

  // ─── Defaults (NYC typical profile) ──────────────────────────────────────
  const NYC_DEFAULT_LAYERS = [
    { name: 'Fill / Urban Topsoil', type: 'Fill',      depthTop: 0,  depthBottom: 2,  unitWeight: 17,  cohesion: 0,   frictionAngle: 28, modulusE: 15000 },
    { name: 'Sandy Gravel',         type: 'Gravel',    depthTop: 2,  depthBottom: 5,  unitWeight: 19,  cohesion: 0,   frictionAngle: 36, modulusE: 60000 },
    { name: 'Stiff Glacial Clay',   type: 'Clay',      depthTop: 5,  depthBottom: 12, unitWeight: 17,  cohesion: 40,  frictionAngle: 0,  modulusE: 20000 },
    { name: 'Dense Sand/Gravel',    type: 'Sand',      depthTop: 12, depthBottom: 30, unitWeight: 18.5,cohesion: 0,   frictionAngle: 38, modulusE: 80000 },
  ];

  const SOIL_COLORS_HEX = {
    'Gravel':      '#8B6914',
    'Sand':        '#D4A96A',
    'Silty Sand':  '#C9A96A',
    'Clayey Sand': '#BF9862',
    'Silt':        '#B5936B',
    'Sandy Clay':  '#A58050',
    'Clay':        '#8B7355',
    'Silty Clay':  '#996B48',
    'Organic':     '#4A3A2A',
    'Fill':        '#9E8C6A',
  };

  const SOIL_TYPES = Object.keys(SOIL_COLORS_HEX);

  // ─── State ────────────────────────────────────────────────────────────────
  let soilLayers = JSON.parse(JSON.stringify(NYC_DEFAULT_LAYERS));
  let lastRunResults = null;
  let lastRunType = null;
  let viz3DState = { rotating: false, angle: 0, rafId: null };
  let timelineActive = false;
  let tlFrame = null;
  let tlYear = 0;
  let tlPlaying = false;
  let tlInterval = null;

  // ─── Modal open / close ───────────────────────────────────────────────────
  function open() {
    document.getElementById('modal-geotechnical').classList.remove('hidden');
    renderLayerRows();
    drawSoilPreview();
    restoreTab();
  }

  function close() {
    document.getElementById('modal-geotechnical').classList.add('hidden');
    stopViz3D();
  }

  // ─── Tab management ───────────────────────────────────────────────────────
  let activeGeoTab = localStorage.getItem('geo_active_tab') || 'bearing';

  function restoreTab() {
    selectTab(activeGeoTab);
  }

  function selectTab(tab) {
    activeGeoTab = tab;
    localStorage.setItem('geo_active_tab', tab);
    const panels = ['bearing', 'settlement', 'earth', 'pile', 'slope', 'consolidation', 'opensees'];
    panels.forEach(p => {
      const el = document.getElementById('geo-panel-' + p);
      if (el) el.classList.toggle('hidden', p !== tab);
    });
    document.querySelectorAll('[data-geo-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.geoTab === tab);
    });
  }

  function selectResultTab(tab) {
    const panels = ['summary', 'bearing-results', 'settlement-results', 'earth-results', 'pile-results', 'slope-results', 'consolidation-results', 'viz'];
    panels.forEach(p => {
      const el = document.getElementById('geo-panel-' + p);
      if (el) el.classList.toggle('hidden', p !== tab);
    });
    document.querySelectorAll('[data-result-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.resultTab === tab);
    });
    if (tab === 'viz' && lastRunResults) renderViz3D(lastRunResults);
  }

  // ─── Soil layer editor ────────────────────────────────────────────────────
  function renderLayerRows() {
    const container = document.getElementById('geo-layers-container');
    if (!container) return;
    container.innerHTML = '';
    soilLayers.forEach((layer, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr 100px 70px 70px 70px 70px 24px;gap:4px;margin-bottom:4px;align-items:center';
      row.innerHTML = `
        <input class="energy-input" value="${layer.name}" placeholder="Layer name"
               style="font-size:11px" data-field="name" data-idx="${idx}">
        <select class="energy-input" style="font-size:11px" data-field="type" data-idx="${idx}">
          ${SOIL_TYPES.map(t => `<option value="${t}" ${t === layer.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <input class="energy-input" type="number" value="${layer.depthBottom}" placeholder="Depth Bot (m)"
               style="font-size:10px" title="Depth to bottom (m)" data-field="depthBottom" data-idx="${idx}">
        <input class="energy-input" type="number" value="${layer.cohesion}" placeholder="c (kPa)"
               style="font-size:10px" title="Cohesion c (kPa)" data-field="cohesion" data-idx="${idx}">
        <input class="energy-input" type="number" value="${layer.frictionAngle}" placeholder="φ (°)"
               style="font-size:10px" title="Friction angle φ (°)" data-field="frictionAngle" data-idx="${idx}">
        <input class="energy-input" type="number" value="${layer.unitWeight}" placeholder="γ (kN/m³)"
               style="font-size:10px" title="Unit weight γ (kN/m³)" data-field="unitWeight" data-idx="${idx}">
        <button style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;padding:2px 6px"
                data-remove-idx="${idx}" title="Remove layer">✕</button>
      `;
      container.appendChild(row);
    });

    // Header labels above first row
    const header = document.createElement('div');
    header.style.cssText = 'display:grid;grid-template-columns:1fr 100px 70px 70px 70px 70px 24px;gap:4px;margin-bottom:2px';
    header.innerHTML = ['Name', 'Type', 'Bot (m)', 'c (kPa)', 'φ (°)', 'γ', ''].map(t =>
      `<span style="font-size:10px;color:#6b7280">${t}</span>`
    ).join('');
    container.insertBefore(header, container.firstChild);

    container.querySelectorAll('[data-field]').forEach(input => {
      input?.addEventListener('change', e => {
        const idx = parseInt(e.target.dataset.idx);
        const field = e.target.dataset.field;
        const val = ['depthBottom', 'cohesion', 'frictionAngle', 'unitWeight', 'modulusE'].includes(field)
          ? parseFloat(e.target.value) : e.target.value;
        soilLayers[idx][field] = val;
        fixLayerDepths();
        drawSoilPreview();
      });
    });
    container.querySelectorAll('[data-remove-idx]').forEach(btn => {
      btn?.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.removeIdx);
        soilLayers.splice(idx, 1);
        fixLayerDepths();
        renderLayerRows();
        drawSoilPreview();
      });
    });
  }

  function fixLayerDepths() {
    // Recalculate depthTop for each layer based on preceding layer's depthBottom
    for (let i = 0; i < soilLayers.length; i++) {
      soilLayers[i].depthTop = i === 0 ? 0 : soilLayers[i - 1].depthBottom;
    }
  }

  function addLayer() {
    const lastDepth = soilLayers.length > 0 ? soilLayers[soilLayers.length - 1].depthBottom : 0;
    soilLayers.push({
      name: 'New Layer',
      type: 'Sand',
      depthTop: lastDepth,
      depthBottom: lastDepth + 3,
      unitWeight: 18,
      cohesion: 0,
      frictionAngle: 30,
      modulusE: 25000,
    });
    renderLayerRows();
    drawSoilPreview();
  }

  // ─── Soil cross-section 2D preview canvas ────────────────────────────────
  function drawSoilPreview() {
    const canvas = document.getElementById('geo-soil-preview-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const totalDepth = soilLayers.reduce((max, l) => Math.max(max, l.depthBottom), 0) || 20;
    const scale = (H - 20) / totalDepth;
    const xPad = 60, barW = W - xPad - 30;

    soilLayers.forEach(layer => {
      const y0 = 10 + layer.depthTop * scale;
      const y1 = 10 + layer.depthBottom * scale;
      const h = Math.max(2, y1 - y0);

      // Fill color
      ctx.fillStyle = SOIL_COLORS_HEX[layer.type] || '#8B7355';
      ctx.fillRect(xPad, y0, barW, h);

      // Hatching pattern (diagonal lines)
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.5;
      for (let x = xPad; x < xPad + barW; x += 8) {
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x - 8, y0 + h);
        ctx.stroke();
      }
      ctx.restore();

      // Border
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(xPad, y0, barW, h);

      // Label
      ctx.fillStyle = '#e5e7eb';
      ctx.font = 'bold 10px system-ui';
      const midY = y0 + h / 2 + 4;
      ctx.fillText(layer.name, xPad + 4, Math.min(H - 4, Math.max(14, midY)));
    });

    // Depth axis
    ctx.fillStyle = '#9ca3af';
    ctx.font = '9px system-ui';
    for (let d = 0; d <= totalDepth; d += Math.max(1, Math.floor(totalDepth / 5))) {
      const y = 10 + d * scale;
      ctx.fillText(`${d}m`, 2, y + 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(xPad, y);
      ctx.lineTo(xPad + barW, y);
      ctx.stroke();
    }

    // Groundwater level
    const gwDepth = parseFloat(document.getElementById('geo-gw')?.value);
    if (!isNaN(gwDepth) && gwDepth > 0 && gwDepth <= totalDepth) {
      const gwY = 10 + gwDepth * scale;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(xPad, gwY);
      ctx.lineTo(xPad + barW, gwY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#3b82f6';
      ctx.font = '9px system-ui';
      ctx.fillText('GWT', xPad + barW - 24, gwY - 2);
    }
  }

  // ─── Run analysis ──────────────────────────────────────────────────────────
  async function runAnalysis() {
    const btn = document.getElementById('btn-geo-run');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }

    // Collect global params
    const B = parseFloat(document.getElementById('geo-b')?.value) || 2;
    const D = parseFloat(document.getElementById('geo-d')?.value) || 1.5;
    const c = parseFloat(document.getElementById('geo-c')?.value) || 20;
    const phi = parseFloat(document.getElementById('geo-phi')?.value) || 28;
    const gamma = parseFloat(document.getElementById('geo-gamma')?.value) || 18;
    const E_s = parseFloat(document.getElementById('geo-e')?.value) || 25000;
    const gw = parseFloat(document.getElementById('geo-gw')?.value) || null;
    const FOS = parseFloat(document.getElementById('geo-fos')?.value) || 3;

    // Active analysis tab → run_type
    const runTypeMap = {
      bearing: 'bearing_capacity',
      settlement: 'elastic_settlement',
      consolidation: 'consolidation_settlement',
      earth: 'lateral_earth_pressure',
      pile: 'pile_capacity',
      slope: 'slope_stability',
      opensees: 'opensees',
    };
    const run_type = runTypeMap[activeGeoTab] || 'bearing_capacity';

    // Tab-specific params
    let extraParams = {};
    if (activeGeoTab === 'bearing') {
      extraParams = {
        method: document.getElementById('geo-bearing-method')?.value || 'hansen',
        q_net: parseFloat(document.getElementById('geo-load')?.value) || 150,
        L: B,
      };
    } else if (activeGeoTab === 'settlement') {
      extraParams = {
        H_layer: parseFloat(document.getElementById('geo-layer-h')?.value) || 5,
        e0: parseFloat(document.getElementById('geo-e0')?.value) || 0.8,
        Cc: parseFloat(document.getElementById('geo-cc')?.value) || 0.3,
        OCR: parseFloat(document.getElementById('geo-ocr')?.value) || 1,
        sigma_v0: parseFloat(document.getElementById('geo-sigma-v0')?.value) || 50,
        delta_sigma: parseFloat(document.getElementById('geo-delta-sigma')?.value) || 100,
        z_max: 2 * B,
      };
    } else if (activeGeoTab === 'earth') {
      extraParams = {
        H_wall: parseFloat(document.getElementById('geo-wall-h')?.value) || 3,
        wall_type: document.getElementById('geo-wall-type')?.value || 'retaining',
        delta: parseFloat(document.getElementById('geo-delta')?.value) || 0,
      };
    } else if (activeGeoTab === 'pile') {
      extraParams = {
        H_pile: parseFloat(document.getElementById('geo-pile-h')?.value) || 15,
        alpha: parseFloat(document.getElementById('geo-alpha')?.value) || 0.65,
        cu: parseFloat(document.getElementById('geo-cu')?.value) || 50,
        q_tip: parseFloat(document.getElementById('geo-q-tip')?.value) || 500,
        FOS: FOS,
      };
    } else if (activeGeoTab === 'slope') {
      extraParams = {
        H_slope: parseFloat(document.getElementById('geo-slope-h')?.value) || 6,
        beta: parseFloat(document.getElementById('geo-slope-beta')?.value) || 30,
        x_slope: parseFloat(document.getElementById('geo-slope-len')?.value) || 10,
      };
    } else if (activeGeoTab === 'consolidation') {
      extraParams = {
        H_layer: parseFloat(document.getElementById('geo-consol-h')?.value) || 5,
        e0: parseFloat(document.getElementById('geo-e0')?.value) || 0.8,
        Cc: parseFloat(document.getElementById('geo-cc')?.value) || 0.3,
        OCR: parseFloat(document.getElementById('geo-ocr')?.value) || 1,
        delta_sigma: parseFloat(document.getElementById('geo-delta-sigma')?.value) || 100,
        sigma_v0: parseFloat(document.getElementById('geo-sigma-v0')?.value) || 50,
        Cr: parseFloat(document.getElementById('geo-cr')?.value) || 0.05,
      };
    } else if (activeGeoTab === 'opensees') {
      extraParams = {
        mesh_x_div: parseInt(document.getElementById('geo-mesh-x')?.value) || 10,
        mesh_z_div: parseInt(document.getElementById('geo-mesh-z')?.value) || 8,
        load_n: parseFloat(document.getElementById('geo-opensees-load')?.value) || 1000,
        B, D, pile_length: parseFloat(document.getElementById('geo-pile-len')?.value) || 15,
      };
    }

    const parameters = { B, D, c, phi, gamma, E_s, groundwater_depth: gw, FOS, ...extraParams };

    try {
      // Use quick calculate endpoint (no project_id required for one-off runs)
      const qs = new URLSearchParams({ run_type });
      Object.entries(parameters).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') qs.set(k, v);
      });

      const resp = await fetch(`/api/geotechnical/calculate?${qs}`);
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();

      lastRunResults = data.result;
      lastRunResults._soilLayers = soilLayers;
      lastRunResults._parameters = parameters;
      lastRunType = run_type;

      showResults(data.result, run_type);

      // Feed into timeline viewport
      initGeotechTimeline(data.result, run_type, parameters);

    } catch (err) {
      showToast('Geotech analysis failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '▶ Run Geotechnical Analysis'; }
    }
  }

  // ─── Result display ───────────────────────────────────────────────────────
  function showResults(result, runType) {
    document.getElementById('geo-run-state').classList.add('hidden');
    document.getElementById('geo-results-state').classList.remove('hidden');

    renderSummary(result, runType);
    renderBearingResults(result);
    renderSettlementResults(result);
    renderEarthResults(result);
    renderPileResults(result);
    renderSlopeResults(result);
    renderConsolidationResults(result);

    selectResultTab('summary');

    // Fetch and display guardrails compliance summary
    const projId = window.currentProjectId || 1;
    fetch(`/api/geotechnical/compliance-summary?project_id=${projId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching compliance-summary`);
        return r.json();
      })
      .then(data => {
        const panel = document.getElementById('geo-guardrails-panel');
        const htmlEl = document.getElementById('geo-guardrails-html');
        const designEl = document.getElementById('geo-guardrails-design');
        if (!panel || !htmlEl || !designEl) return;
        if (!data.hasResults) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        htmlEl.innerHTML = data.html || '';
        designEl.innerHTML = data.designHtml || '';
      })
      .catch(e => console.warn('[guardrails] Could not load geotech compliance:', e.message));
  }

  function pill(label, value, ok) {
    const color = ok === true ? '#22c55e' : ok === false ? '#ef4444' : '#3b82f6';
    return `<div style="display:flex;justify-content:space-between;align-items:center;
      padding:6px 10px;background:rgba(0,0,0,0.25);border-radius:6px;border-left:3px solid ${color};margin-bottom:6px">
      <span style="font-size:12px;color:#9ca3af">${label}</span>
      <span style="font-size:13px;font-weight:600;color:${color}">${value}</span>
    </div>`;
  }

  function renderSummary(result, runType) {
    const el = document.getElementById('geo-summary-content');
    if (!el) return;
    let html = '';

    // PASS/FAIL determination
    if (runType === 'bearing_capacity' || result.q_ult) {
      const q_all = result.q_all || 0;
      const q_net = lastRunResults?._parameters?.q_net || 150;
      const pass = q_all >= q_net;
      html += `<div style="margin-bottom:12px;padding:10px;background:${pass ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'};border-radius:8px;border:1px solid ${pass ? '#22c55e' : '#ef4444'}">
        <div style="font-size:15px;font-weight:700;color:${pass ? '#22c55e' : '#ef4444'}">${pass ? '✓ PASS' : '✕ FAIL'} — Bearing Capacity</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">
          q_ult = ${result.q_ult} kPa | q_all = ${result.q_all} kPa (FS=${lastRunResults?._parameters?.FOS || 3})
          | Applied = ${q_net} kPa
        </div>
      </div>`;
      html += pill('Ultimate Bearing Capacity', `${result.q_ult} kPa`, null);
      html += pill('Allowable Bearing Capacity', `${result.q_all} kPa`, pass);
      html += pill('Method', result.method || 'Hansen', null);
      if (result.factors) {
        html += pill('Bearing Factors Nq / Nc / Nγ', `${result.factors.Nq} / ${result.factors.Nc} / ${result.factors.Ngamma}`, null);
      }
    }

    if (runType === 'elastic_settlement' || runType === 'consolidation_settlement' || result.settlement_mm !== undefined) {
      const s = result.settlement_mm || 0;
      const allowable = 25; // mm — NAVFAC typical
      const pass = s <= allowable;
      html += `<div style="margin-top:8px;padding:10px;background:${pass ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'};border-radius:8px;border:1px solid ${pass ? '#22c55e' : '#ef4444'}">
        <div style="font-size:15px;font-weight:700;color:${pass ? '#22c55e' : '#ef4444'}">${pass ? '✓ PASS' : '✕ FAIL'} — Settlement ≤ 25mm</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">Predicted settlement: ${s} mm</div>
      </div>`;
      html += pill('Settlement', `${s} mm`, pass);
      if (result.method) html += pill('Method', result.method, null);
    }

    if (runType === 'lateral_earth_pressure' || result.Ka !== undefined) {
      html += `<div style="margin-top:8px;padding:10px;background:rgba(59,130,246,0.08);border-radius:8px;border:1px solid #3b82f6">
        <div style="font-size:14px;font-weight:700;color:#3b82f6">Earth Pressure Coefficients</div>
      </div>`;
      html += pill('Ka (Active)', result.Ka?.toFixed(3) || '—', null);
      html += pill('Kp (Passive)', result.Kp?.toFixed(3) || '—', null);
      html += pill('K₀ (At-Rest)', result.K0?.toFixed(3) || '—', null);
      html += pill('Pa (Active Force)', `${result.Pa_kN_m} kN/m`, null);
    }

    if (runType === 'pile_capacity' || result.Q_ult_kN !== undefined) {
      const q_all = result.Q_allow_kN || 0;
      const load = (lastRunResults?._parameters?.q_net || 150) * (lastRunResults?._parameters?.B || 2) ** 2;
      const pass = q_all > 0;
      html += `<div style="margin-top:8px;padding:10px;background:rgba(59,130,246,0.08);border-radius:8px;border:1px solid #3b82f6">
        <div style="font-size:14px;font-weight:700;color:#3b82f6">Pile Capacity</div>
      </div>`;
      html += pill('Ultimate Capacity Q_ult', `${result.Q_ult_kN} kN`, null);
      html += pill('Allowable Capacity Q_all', `${result.Q_allow_kN} kN`, pass);
      html += pill('Side Friction Q_side', `${result.Q_side_kN} kN`, null);
      html += pill('Tip Resistance Q_tip', `${result.Q_tip_kN} kN`, null);
    }

    if (runType === 'slope_stability' || result.FOS !== undefined || result.fellenius) {
      const fos = result.fellenius?.FOS || result.FOS || 999;
      const pass = fos >= 1.5;
      html += `<div style="margin-top:8px;padding:10px;background:${pass ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'};border-radius:8px;border:1px solid ${pass ? '#22c55e' : '#ef4444'}">
        <div style="font-size:15px;font-weight:700;color:${pass ? '#22c55e' : '#ef4444'}">${pass ? '✓ PASS' : '✕ FAIL'} — Slope Stability (FoS ≥ 1.5)</div>
      </div>`;
      if (result.fellenius) {
        html += pill('Fellenius FoS', result.fellenius.FOS?.toFixed(2) || '—', result.fellenius.FOS >= 1.5);
        html += pill('Bishop FoS', result.bishop?.FOS?.toFixed(2) || '—', (result.bishop?.FOS || 0) >= 1.5);
      } else {
        html += pill('Factor of Safety', fos?.toFixed(2) || '—', pass);
      }
    }

    html += `<div style="margin-top:16px;padding:8px 10px;background:#1a1400;border-radius:6px;border:1px solid #d97706;font-size:10px;color:#d97706">
      ⚠️ Results are advisory estimates per NAVFAC DM-7. Site-specific boring data and a licensed geotechnical engineer's report are required for permit submission.
    </div>`;

    el.innerHTML = html;
  }

  function renderBearingResults(result) {
    const el = document.getElementById('geo-bearing-results');
    if (!el || !result.q_ult) return;
    let html = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:rgba(255,255,255,0.05)">
        <th style="text-align:left;padding:6px 8px;color:#9ca3af">Parameter</th>
        <th style="text-align:right;padding:6px 8px;color:#9ca3af">Value</th>
      </tr></thead><tbody>`;
    const rows = [
      ['Foundation Width B', `${result.soil_data?.B || '—'} m`],
      ['Embedment Depth D', `${result.soil_data?.D || '—'} m`],
      ['Cohesion c', `${result.soil_data?.c || '—'} kPa`],
      ['Friction Angle φ', `${result.soil_data?.phi || '—'}°`],
      ['Unit Weight γ', `${result.soil_data?.gamma || '—'} kN/m³`],
      ['Overburden q', `${result.soil_data?.q || '—'} kPa`],
      ['Nq', result.factors?.Nq?.toFixed(2) || '—'],
      ['Nc', result.factors?.Nc?.toFixed(2) || '—'],
      ['Nγ', result.factors?.Ngamma?.toFixed(2) || '—'],
      ['q_ult (Ultimate)', `<strong style="color:#fbbf24">${result.q_ult} kPa</strong>`],
      ['q_all (Allowable, FS=' + (result.soil_data?.FOS || 3) + ')', `<strong style="color:#22c55e">${result.q_all} kPa</strong>`],
      ['Reference', result.navfac_table || 'NAVFAC DM 7.01'],
    ];
    rows.forEach(([k, v]) => {
      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:5px 8px;color:#9ca3af">${k}</td>
        <td style="padding:5px 8px;text-align:right;color:#e5e7eb">${v}</td>
      </tr>`;
    });
    html += '</tbody></table>';

    if (result.pressure_bulbs?.length) {
      html += `<div style="margin-top:12px;font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">PRESSURE BULBS (2:1 Method)</div>`;
      html += `<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:rgba(255,255,255,0.05)">
        <th style="padding:4px 8px;color:#9ca3af;text-align:left">Depth (m)</th>
        <th style="padding:4px 8px;color:#9ca3af;text-align:left">z/B</th>
        <th style="padding:4px 8px;color:#9ca3af;text-align:right">Pressure (kPa)</th>
      </tr></thead><tbody>`;
      result.pressure_bulbs.forEach(pb => {
        html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
          <td style="padding:4px 8px;color:#e5e7eb">${pb.z}</td>
          <td style="padding:4px 8px;color:#9ca3af">${pb.zB}</td>
          <td style="padding:4px 8px;text-align:right;color:#60a5fa">${pb.pressure}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }
    el.innerHTML = html;
  }

  function renderSettlementResults(result) {
    const el = document.getElementById('geo-settlement-results');
    if (!el || result.settlement_mm === undefined) return;
    const s = result.settlement_mm;
    const color = s <= 25 ? '#22c55e' : s <= 50 ? '#f59e0b' : '#ef4444';
    let html = `<div style="text-align:center;margin-bottom:16px">
      <div style="font-size:32px;font-weight:700;color:${color}">${s} mm</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px">Elastic Settlement | ${result.method || 'Schmertmann'}</div>
    </div>`;
    // Settlement bar
    const pct = Math.min(100, s / 100 * 100);
    html += `<div style="background:rgba(255,255,255,0.05);border-radius:4px;height:12px;margin-bottom:12px">
      <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width .3s"></div>
    </div>`;
    html += `<div style="display:flex;justify-content:space-between;font-size:10px;color:#6b7280;margin-bottom:12px">
      <span>0mm (none)</span><span>25mm (limit)</span><span>100mm</span>
    </div>`;
    if (result.settlement_profile?.length) {
      html += `<div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">SETTLEMENT PROFILE</div>`;
      html += drawBarChart(result.settlement_profile.map(p => ({ label: `${p.z}m`, value: p.Iz })), 'Influence Factor Iz', '#60a5fa');
    }
    el.innerHTML = html;
  }

  function renderEarthResults(result) {
    const el = document.getElementById('geo-earth-results');
    if (!el || result.Ka === undefined) return;
    let html = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">`;
    [[`Ka (Active)`, result.Ka?.toFixed(3), '#f59e0b'],
     [`Kp (Passive)`, result.Kp?.toFixed(3), '#22c55e'],
     [`K₀ (At-Rest)`, result.K0?.toFixed(3), '#60a5fa']].forEach(([l, v, c]) => {
      html += `<div style="text-align:center;padding:10px;background:rgba(255,255,255,0.04);border-radius:6px;border:1px solid rgba(255,255,255,0.08)">
        <div style="font-size:18px;font-weight:700;color:${c}">${v}</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px">${l}</div>
      </div>`;
    });
    html += '</div>';
    html += pill('Pa (Active Total Force)', `${result.Pa_kN_m} kN/m`, null);
    html += pill('Pp (Passive Total Force)', `${result.Pp_kN_m} kN/m`, null);
    html += pill('P₀ (At-Rest Total Force)', `${result.P0_kN_m} kN/m`, null);
    if (result.failure_depth > 0) {
      html += pill('Tension Crack Depth', `${result.failure_depth} m`, null);
    }
    if (result.diagram_points?.length) {
      html += `<div style="margin-top:12px;font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">LATERAL PRESSURE DIAGRAM</div>`;
      html += drawBarChart(result.diagram_points.map(p => ({ label: `${p.z}m`, value: p.pressure_kPa })), 'kPa', '#f59e0b');
    }
    el.innerHTML = html;
  }

  function renderPileResults(result) {
    const el = document.getElementById('geo-pile-results');
    if (!el || result.Q_ult_kN === undefined) return;
    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="text-align:center;padding:12px;background:rgba(251,191,36,0.1);border-radius:8px;border:1px solid #fbbf24">
        <div style="font-size:22px;font-weight:700;color:#fbbf24">${result.Q_ult_kN} kN</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">Ultimate Capacity</div>
      </div>
      <div style="text-align:center;padding:12px;background:rgba(34,197,94,0.1);border-radius:8px;border:1px solid #22c55e">
        <div style="font-size:22px;font-weight:700;color:#22c55e">${result.Q_allow_kN} kN</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">Allowable Capacity</div>
      </div>
    </div>`;
    html += pill('Side Friction Q_side', `${result.Q_side_kN} kN`, null);
    html += pill('Tip Resistance Q_tip', `${result.Q_tip_kN} kN`, null);
    html += pill('Method', result.method || 'Alpha method', null);
    html += pill('NAVFAC Reference', result.navfac_table || 'DM 7.02', null);
    el.innerHTML = html;
  }

  function renderSlopeResults(result) {
    const el = document.getElementById('geo-slope-results');
    if (!el) return;
    const fos_f = result.fellenius?.FOS;
    const fos_b = result.bishop?.FOS;
    if (!fos_f && result.FOS === undefined) return;
    const fos = fos_f || result.FOS;
    const color = fos >= 2.0 ? '#22c55e' : fos >= 1.5 ? '#f59e0b' : '#ef4444';
    let html = `<div style="text-align:center;margin-bottom:14px">
      <div style="font-size:36px;font-weight:700;color:${color}">${(fos || 0).toFixed(2)}</div>
      <div style="font-size:12px;color:#9ca3af">Factor of Safety (FoS)</div>
      <div style="font-size:11px;margin-top:4px;color:${color}">${fos >= 1.5 ? '✓ Adequate (FoS ≥ 1.5)' : '✕ Insufficient (FoS < 1.5)'}</div>
    </div>`;
    if (fos_f && fos_b) {
      html += pill('Fellenius (Swedish) FoS', fos_f.toFixed(2), fos_f >= 1.5);
      html += pill('Bishop Simplified FoS', fos_b.toFixed(2), fos_b >= 1.5);
    }
    if (result.fellenius?.critical_slip) {
      const cs = result.fellenius.critical_slip;
      html += pill('Critical Slip Center', `(${cs.center_x?.toFixed(1)}, ${cs.center_y?.toFixed(1)})`, null);
      html += pill('Slip Radius', `${cs.radius?.toFixed(1)} m`, null);
    }
    el.innerHTML = html;
  }

  function renderConsolidationResults(result) {
    const el = document.getElementById('geo-consolidation-results');
    if (!el || result.settlement_mm === undefined) return;
    const s = result.settlement_mm;
    const color = s <= 25 ? '#22c55e' : s <= 75 ? '#f59e0b' : '#ef4444';
    let html = `<div style="text-align:center;margin-bottom:16px">
      <div style="font-size:32px;font-weight:700;color:${color}">${s} mm</div>
      <div style="font-size:12px;color:#9ca3af">Consolidation Settlement | Terzaghi 1D</div>
    </div>`;
    html += pill('Estimated Settlement', `${s} mm`, s <= 25);
    html += pill('Time to 95% Consolidation', `${result.consolidation_time_days?.toLocaleString() || '—'} days`, null);
    html += pill('Layer Thickness', `${result.layer_thickness || '—'} m`, null);
    if (result.settlement_contours?.length) {
      html += `<div style="margin-top:12px;font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">SETTLEMENT VS DEPTH</div>`;
      html += drawBarChart(result.settlement_contours.map(p => ({ label: `${p.z}m`, value: parseFloat((p.settlement * 1000).toFixed(1)) })), 'mm', '#a78bfa');
    }
    el.innerHTML = html;
  }

  // ─── Mini bar chart helper ─────────────────────────────────────────────────
  function drawBarChart(data, label, color) {
    if (!data?.length) return '';
    const max = Math.max(...data.map(d => d.value), 0.001);
    let html = `<div style="display:flex;align-items:flex-end;gap:4px;height:80px;margin-bottom:4px">`;
    data.forEach(d => {
      const pct = Math.max(2, (d.value / max) * 100);
      html += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#9ca3af">${d.value}</div>
        <div style="width:100%;height:${pct}%;background:${color};border-radius:2px 2px 0 0;min-height:2px"></div>
      </div>`;
    });
    html += '</div>';
    html += `<div style="display:flex;gap:4px">`;
    data.forEach(d => {
      html += `<div style="flex:1;text-align:center;font-size:9px;color:#6b7280;overflow:hidden">${d.label}</div>`;
    });
    html += `</div>`;
    html += `<div style="font-size:10px;color:#6b7280;margin-top:4px;text-align:center">${label}</div>`;
    return html;
  }

  // ─── 3D Canvas Visualization ───────────────────────────────────────────────
  function renderViz3D(results) {
    const canvas = document.getElementById('geo-viz-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth || 800;
    canvas.height = 340;
    const W = canvas.width, H = canvas.height;

    stopViz3D();
    drawCrossSection3D(ctx, W, H, results, 0);

    if (viz3DState.rotating) {
      startViz3DRotation(ctx, W, H, results);
    }
  }

  function drawCrossSection3D(ctx, W, H, results, angleOffset) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0d12';
    ctx.fillRect(0, 0, W, H);

    const layers = results?._soilLayers || NYC_DEFAULT_LAYERS;
    const params = results?._parameters || {};
    const B = params.B || 2;
    const D = params.D || 1.5;

    const totalDepth = layers.reduce((m, l) => Math.max(m, l.depthBottom), 0) || 20;
    const horizExtent = B * 8;
    const scale = Math.min((H - 60) / totalDepth, (W - 120) / horizExtent);
    const ox = W / 2; // origin x (center)
    const oy = 30;    // origin y (top)

    // Draw soil layers
    layers.forEach(layer => {
      const y0 = oy + layer.depthTop * scale;
      const y1 = oy + layer.depthBottom * scale;
      const h = Math.max(2, y1 - y0);
      const x0 = ox - horizExtent / 2 * scale;
      const lw = horizExtent * scale;

      ctx.fillStyle = SOIL_COLORS_HEX[layer.type] || '#8B7355';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x0, y0, lw, h);

      // Hatch
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.5;
      for (let x = x0; x < x0 + lw; x += 10) {
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x - 8, y0 + h);
        ctx.stroke();
      }

      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, lw, h);

      // Layer label
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#e5e7eb';
      ctx.font = 'bold 10px system-ui';
      ctx.fillText(layer.name, x0 + 4, Math.min(oy + totalDepth * scale - 4, y0 + h / 2 + 4));
    });

    ctx.globalAlpha = 1;

    // Foundation footprint
    const fy = oy + D * scale;
    const fw = B * scale;
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(ox - fw / 2, fy - 6, fw, 6);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox - fw / 2, fy - 6, fw, 6);
    ctx.fillStyle = '#fff';
    ctx.font = '10px system-ui';
    ctx.fillText(`Foundation B=${B}m`, ox - 30, fy - 9);

    // Pressure bulbs if bearing results
    if (results?.pressure_bulbs?.length) {
      results.pressure_bulbs.forEach((pb, i) => {
        const alpha = 0.6 - i * 0.1;
        const r = (B + pb.z) * scale / 2;
        const cy = fy + pb.z * scale;
        ctx.beginPath();
        ctx.ellipse(ox, cy, r, r * 0.3, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(251,191,36,${Math.max(0.1, alpha)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = `rgba(251,191,36,0.05)`;
        ctx.fill();
      });
    }

    // Earth pressure diagram (active)
    if (results?.diagram_points?.length) {
      const H_wall = params.H_wall || 3;
      const maxP = Math.max(...results.diagram_points.map(p => p.pressure_kPa), 0.1);
      const wallX = ox + B * scale * 4;
      ctx.beginPath();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.moveTo(wallX, oy);
      results.diagram_points.forEach(p => {
        const px = wallX + (p.pressure_kPa / maxP) * 80;
        const py = oy + p.z * scale;
        ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.fillStyle = '#f59e0b';
      ctx.font = '9px system-ui';
      ctx.fillText('Pa', wallX + 85, oy + H_wall * scale / 2);
    }

    // Depth axis
    ctx.fillStyle = '#9ca3af';
    ctx.font = '9px system-ui';
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let d = 0; d <= totalDepth; d += Math.max(1, Math.floor(totalDepth / 5))) {
      const y = oy + d * scale;
      ctx.fillText(`${d}m`, 4, y + 3);
      ctx.beginPath();
      ctx.moveTo(25, y);
      ctx.lineTo(W - 10, y);
      ctx.stroke();
    }

    // Ground surface line
    ctx.strokeStyle = '#65a30d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(30, oy);
    ctx.lineTo(W - 10, oy);
    ctx.stroke();
    ctx.fillStyle = '#65a30d';
    ctx.font = '9px system-ui';
    ctx.fillText('Ground Surface', W - 120, oy - 4);

    // GWT
    const gwDepth = params.groundwater_depth;
    if (gwDepth > 0 && gwDepth <= totalDepth) {
      const gwY = oy + gwDepth * scale;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(30, gwY);
      ctx.lineTo(W - 10, gwY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#3b82f6';
      ctx.font = '9px system-ui';
      ctx.fillText('▼ GWT', W - 60, gwY - 2);
    }
  }

  function stopViz3D() {
    if (viz3DState.rafId) {
      cancelAnimationFrame(viz3DState.rafId);
      viz3DState.rafId = null;
    }
  }

  function startViz3DRotation(ctx, W, H, results) {
    let angle = 0;
    function frame() {
      angle += 0.01;
      drawCrossSection3D(ctx, W, H, results, angle);
      viz3DState.rafId = requestAnimationFrame(frame);
    }
    viz3DState.rafId = requestAnimationFrame(frame);
  }

  // ─── Timeline viewport integration ────────────────────────────────────────
  /**
   * After a geotech run, push the results into the SimulationTimeline
   * so it can animate settlement over time (0-50 years), pressure ramp,
   * or liquefaction sweep in 4 modes: Settlement / Bearing / Lateral / Slope.
   */
  function initGeotechTimeline(results, runType, params) {
    // Attempt to use the existing SimulationTimeline module if available
    if (typeof window.SimulationTimeline === 'undefined') return;

    const settlementMax = results.settlement_mm || 50;
    const q_all = results.q_all || 150;
    const Pa = results.Pa_kN_m || 30;
    const fosV = results.fellenius?.FOS || results.FOS || 1.5;

    // Build timeline frames for 4 geotech modes
    const frames = buildTimelineFrames(settlementMax, q_all, Pa, fosV, params, results);

    window.SimulationTimeline.load('geotech', {
      frames,
      settlement_max_mm: settlementMax,
      bearing: { q_all, q_ult: results.q_ult || 450 },
      lateral: { Pa },
      slope: { FOS: fosV },
      soil_layers: results._soilLayers || NYC_DEFAULT_LAYERS,
    });
  }

  function buildTimelineFrames(settlementMax, q_all, Pa, fosV, params, results) {
    const frames = [];
    const years = 51;
    // Settlement timeline: primary consolidation follows log(1+t) curve
    for (let yr = 0; yr < years; yr++) {
      const progress = Math.log(1 + yr) / Math.log(1 + 50); // 0→1 over 50 years
      const settlement = settlementMax * progress;
      // Bearing capacity degrades slightly (long-term creep 5%)
      const qAllYear = q_all * (1 - 0.05 * yr / 50);
      // Earth pressure increases with year (surcharge buildup 10%)
      const paYear = Pa * (1 + 0.10 * yr / 50);
      // FOS degrades 0-10% over 50 years (material weathering)
      const fosYear = fosV * (1 - 0.10 * yr / 50);

      frames.push({
        year: yr,
        settlement_mm: Math.round(settlement * 10) / 10,
        q_all_kPa: Math.round(qAllYear * 10) / 10,
        Pa_kN_m: Math.round(paYear * 10) / 10,
        FOS: Math.round(fosYear * 100) / 100,
        // Color-mapped soil stress value (0-1)
        soil_stress: Math.min(1, settlement / Math.max(settlementMax, 1)),
      });
    }
    return frames;
  }

  // ─── PDF Export ────────────────────────────────────────────────────────────
  function exportPDF() {
    if (!lastRunResults) return;
    showToast('Geotech PDF export — building report…', 'info');

    // Collect visible results as HTML and trigger print
    const win = window.open('', '_blank', 'width=800,height=1100');
    if (!win) { showToast('Allow popups to export PDF', 'warn'); return; }

    const summaryEl = document.getElementById('geo-summary-content');
    const content = summaryEl ? summaryEl.innerHTML : '<p>No results to export.</p>';

    win.document.write(`<!DOCTYPE html><html><head><title>Atlantist Geotech Report</title>
      <style>body{font-family:system-ui;padding:32px;color:#111}
        h1{font-size:18px;font-weight:700;margin-bottom:4px}
        h2{font-size:13px;font-weight:600;color:#555;margin-bottom:16px}
        .pill{padding:6px 10px;border-left:3px solid #3b82f6;margin-bottom:6px;display:flex;justify-content:space-between}
        .disclaimer{background:#fff8e1;border:1px solid #f59e0b;padding:10px;font-size:11px;margin-top:24px}
      </style></head><body>
      <h1>🌍 Atlantist — Geotechnical Analysis Report</h1>
      <h2>Run: ${new Date().toLocaleString()} | Method: NAVFAC DM-7</h2>
      <hr>
      ${content}
      <div class="disclaimer">
        ⚠️ PROFESSIONAL DISCLAIMER: This report is a design aid. Results are estimates.
        All geotechnical designs must be reviewed by a licensed geotechnical PE.
        Site-specific boring data required for permit submission.
      </div>
      </body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 500);
  }

  // ─── Save run to project ───────────────────────────────────────────────────
  async function saveRun() {
    if (!lastRunResults) return;
    const projectId = window.ATLANTIST?.currentProjectId;
    if (!projectId) {
      showToast('Open a project first to save this run.', 'warn');
      return;
    }
    const params = lastRunResults._parameters || {};
    try {
      const resp = await fetch('/api/geotechnical/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          run_type: lastRunType,
          name: `Geo ${lastRunType} — ${new Date().toLocaleDateString()}`,
          parameters: params,
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      showToast('Geotechnical run saved to project.', 'success');
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    }
  }

  // ─── OpenSees download ─────────────────────────────────────────────────────
  async function downloadOpenSees() {
    if (!lastRunResults) return;
    const params = lastRunResults._parameters || {};

    // Build OpenSees .tcl client-side from known params
    const qs = new URLSearchParams({ run_type: 'opensees', ...params });
    try {
      const resp = await fetch('/api/geotechnical/calculate?' + qs);
      if (!resp.ok) throw new Error(`OpenSees download failed: HTTP ${resp.status}`);
      const data = await resp.json();
      const tcl = data.result?.opensees_input;
      if (!tcl) { showToast('No OpenSees input generated.', 'warn'); return; }
      const blob = new Blob([tcl], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'opensees_model.tcl'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast('OpenSees export failed: ' + err.message, 'error');
    }
  }

  // ─── Toast helper ──────────────────────────────────────────────────────────
  function showToast(msg, type) {
    if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      padding:10px 20px;border-radius:6px;font-size:13px;z-index:9999;
      background:${type === 'error' ? '#7f1d1d' : type === 'warn' ? '#78350f' : '#065f46'};color:#fff`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ─── Event wiring ──────────────────────────────────────────────────────────
  function wire() {
    // Modal open
    const btnOpen = document.getElementById('btn-geotechnical');
    if (btnOpen) btnOpen?.addEventListener('click', open);

    // Modal close
    const btnClose = document.getElementById('geo-modal-close');
    if (btnClose) btnClose?.addEventListener('click', close);

    // Click outside to close
    const overlay = document.getElementById('modal-geotechnical');
    if (overlay) {
      overlay?.addEventListener('click', e => {
        if (e.target === overlay) close();
      });
    }

    // Analysis tabs
    document.querySelectorAll('[data-geo-tab]').forEach(btn => {
      btn?.addEventListener('click', () => selectTab(btn.dataset.geoTab));
    });

    // Result tabs
    document.querySelectorAll('[data-result-tab]').forEach(btn => {
      btn?.addEventListener('click', () => selectResultTab(btn.dataset.resultTab));
    });

    // Add soil layer
    const addLayerBtn = document.getElementById('geo-add-layer');
    if (addLayerBtn) addLayerBtn?.addEventListener('click', addLayer);

    // Run button
    const runBtn = document.getElementById('btn-geo-run');
    if (runBtn) runBtn?.addEventListener('click', runAnalysis);

    // Clear / run again
    const clearBtn = document.getElementById('btn-geo-clear');
    if (clearBtn) clearBtn?.addEventListener('click', resetToInputs);

    const runAgainBtn = document.getElementById('btn-geo-run-again');
    if (runAgainBtn) runAgainBtn?.addEventListener('click', resetToInputs);

    // PDF export
    const pdfBtn = document.getElementById('btn-geo-export-pdf');
    if (pdfBtn) pdfBtn?.addEventListener('click', exportPDF);

    // Save run
    const saveBtn = document.getElementById('btn-geo-save-run');
    if (saveBtn) saveBtn?.addEventListener('click', saveRun);

    // OpenSees download
    const osBtn = document.getElementById('btn-geo-download-opensees');
    if (osBtn) osBtn?.addEventListener('click', downloadOpenSees);

    // Rotate toggle
    const rotBtn = document.getElementById('btn-geo-rotate');
    if (rotBtn) {
      rotBtn?.addEventListener('click', () => {
        viz3DState.rotating = !viz3DState.rotating;
        rotBtn.textContent = viz3DState.rotating ? '⏹ Stop Rotate' : '↻ Toggle Rotate';
        if (viz3DState.rotating && lastRunResults) {
          const canvas = document.getElementById('geo-viz-canvas');
          if (canvas) startViz3DRotation(canvas.getContext('2d'), canvas.offsetWidth || 800, 340, lastRunResults);
        } else {
          stopViz3D();
          if (lastRunResults) {
            const canvas = document.getElementById('geo-viz-canvas');
            if (canvas) drawCrossSection3D(canvas.getContext('2d'), canvas.offsetWidth || 800, 340, lastRunResults, 0);
          }
        }
      });
    }

    // Redraw soil preview when GWT changes
    const gwInput = document.getElementById('geo-gw');
    if (gwInput) gwInput?.addEventListener('input', drawSoilPreview);
  }

  function resetToInputs() {
    document.getElementById('geo-run-state')?.classList.remove('hidden');
    document.getElementById('geo-results-state')?.classList.add('hidden');
    lastRunResults = null;
    lastRunType = null;
    stopViz3D();
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  window.GeoPanel = { open, close, runAnalysis, wire };

  // Auto-wire on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

})();
