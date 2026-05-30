/**
 * Owns: MEP modal UI — discipline tabs, run dispatch, result rendering,
 *       animated flow visualization (canvas), codes/schedule display.
 * Does NOT own: calculation logic (services/mep/*), API routes, DB access.
 *
 * Runs as a non-module script; attaches MEPPanel to window for app.js to call.
 */
(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let activeTab = 'hvac';
  let lastHVACResults = null;
  let lastPlumbResults = null;
  let lastElecResults = null;
  let animFrames = [];

  // ─── Modal ─────────────────────────────────────────────────────────────────
  function open() {
    document.getElementById('modal-mep').classList.remove('hidden');
    renderTab('hvac');
    loadHistory();
    loadCodes();
    loadSchedule();
    checkDesignBookStatus();
  }

  function close() {
    document.getElementById('modal-mep').classList.add('hidden');
    cancelAnimations();
  }

  // ─── Tab management ─────────────────────────────────────────────────────────
  function renderTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.mep-discipline-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.mep-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    const panel = document.getElementById('mep-panel-' + tab);
    if (panel) panel.classList.remove('hidden');
  }

  // ─── Run handlers ──────────────────────────────────────────────────────────
  async function runFire() {
    if (!checkDisclaimer('fire')) return;
    setLoading('mep-fire-results', 'Running fire protection analysis…');
    try {
      const resp = await fetch('/api/fire-protection/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          occupancy_type: document.getElementById('mep-fire-occ')?.value || 'office',
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      renderFireResults(data);
    } catch (err) {
      showError('mep-fire-results', err.message);
    }
  }

  async function runFDS() {
    if (!checkDisclaimer('fire')) return;
    const fdsSection = document.getElementById('mep-fire-fds-section');
    if (fdsSection) fdsSection.classList.remove('hidden');
    setLoading('mep-fire-results', 'Running FDS simulation…');
    try {
      const resp = await fetch('/api/fire-protection/fds/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hrr_peak_kw: parseFloat(document.getElementById('mep-fire-hrr')?.value) || 3000,
          growth_alpha: parseFloat(document.getElementById('mep-fire-growth')?.value) || 0.12,
          simulation_time_s: 300,
          occupancy_type: document.getElementById('mep-fire-occ')?.value || 'office',
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      renderFDSResults(data);
    } catch (err) {
      showError('mep-fire-results', err.message);
    }
  }

  async function runHVAC() {
    if (!checkDisclaimer('hvac')) return;
    setLoading('mep-hvac-results', 'Running HVAC simulation…');
    try {
      const resp = await fetch('/api/mep/run-hvac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceType: document.getElementById('mep-hvac-space').value,
          infiltACH: parseFloat(document.getElementById('mep-hvac-infil').value),
          disclaimerAccepted: true,
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      lastHVACResults = data.result;
      renderHVACResults(data.result, data.disclaimer);
      loadHistory();
    } catch (err) {
      showError('mep-hvac-results', err.message);
    }
  }

  async function runPlumbing() {
    if (!checkDisclaimer('plumbing')) return;
    setLoading('mep-plumb-results', 'Running plumbing simulation…');
    try {
      const resp = await fetch('/api/mep/run-plumbing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          occupancyType: document.getElementById('mep-plumb-occ').value,
          material: document.getElementById('mep-plumb-mat').value,
          disclaimerAccepted: true,
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      lastPlumbResults = data.result;
      renderPlumbingResults(data.result, data.disclaimer);
      loadHistory();
    } catch (err) {
      showError('mep-plumb-results', err.message);
    }
  }

  async function runElectrical() {
    if (!checkDisclaimer('electrical')) return;
    setLoading('mep-elec-results', 'Running electrical simulation…');
    try {
      const resp = await fetch('/api/mep/run-electrical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voltage: parseInt(document.getElementById('mep-elec-voltage').value),
          phase: document.getElementById('mep-elec-phase').value,
          ambientTempF: parseInt(document.getElementById('mep-elec-temp').value),
          disclaimerAccepted: true,
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      lastElecResults = data.result;
      renderElectricalResults(data.result, data.disclaimer);
      loadHistory();
    } catch (err) {
      showError('mep-elec-results', err.message);
    }
  }

  // ─── Result Renderers ──────────────────────────────────────────────────────

  function renderHVACResults(r, disclaimer) {
    const div = document.getElementById('mep-hvac-results');
    const compliance = r.compliance || {};
    const compBadge = compliance.status === 'PASS'
      ? '<span style="background:#065f46;color:#a7f3d0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>'
      : '<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';

    const ductSegs = (r.ductSizing?.segments || []).map(s =>
      `<tr><td>${s.id}</td><td>${s.cfm} CFM</td><td>${s.widthIn}" × ${s.heightIn}"</td><td>${s.velocityFPM} FPM</td><td>${s.frictionInWgPer100ft}" wg/100ft</td></tr>`
    ).join('');

    div.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">HEATING LOAD</div>
          <div style="font-size:22px;font-weight:700">${r.heatingLoadBtuH?.toLocaleString() || '—'} <span style="font-size:12px;color:var(--text-muted)">Btu/h</span></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${r.heatingLoadW?.toLocaleString() || '—'} W</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">COOLING LOAD</div>
          <div style="font-size:22px;font-weight:700">${r.coolingLoadBtuH?.toLocaleString() || '—'} <span style="font-size:12px;color:var(--text-muted)">Btu/h</span></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${r.coolingLoadW?.toLocaleString() || '—'} W</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">FLOOR AREA</div>
          <div style="font-size:18px;font-weight:600">${r.floorAreaM2?.toLocaleString() || '—'} <span style="font-size:12px">m²</span></div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">OCCUPANTS</div>
          <div style="font-size:18px;font-weight:600">${Math.round(r.people || 0)}</div>
        </div>
      </div>
      <div style="margin-bottom:12px">${compBadge} <span style="font-size:11px;color:var(--text-muted)">${compliance.code} · Zone ${r.zone || '—'} · EUI ${compliance.euiBtuSqftYr || '—'} Btu/ft²/yr (limit ${compliance.limit})</span></div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Ventilation CFM</div>
          <div style="font-size:16px;font-weight:600">${r.ventilationCFM || '—'}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Wall U-value</div>
          <div style="font-size:16px;font-weight:600">${r.wallU || '—'} W/m²K</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">PMV / PPD</div>
          <div style="font-size:16px;font-weight:600">${r.comfort?.pmv || '—'} / ${r.comfort?.ppd || '—'}%</div>
        </div>
      </div>

      <!-- Duct sizing table -->
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">DUCT SIZING — Equal Friction Method</div>
      <table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:12px">
        <tr style="background:var(--surface)"><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Run</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">CFM</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Size</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Velocity</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Friction</th></tr>
        ${ductSegs || '<tr><td colspan="5" style="color:var(--text-muted)">—</td></tr>'}
      </table>

      <!-- Animated airflow canvas -->
      <div style="margin-top:12px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">🌬️ AIRFLOW SIMULATION</div>
        <canvas id="mep-hvac-canvas" width="680" height="100" style="border-radius:8px;border:1px solid var(--border);background:#0d0d0d;display:block;width:100%"></canvas>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Particle velocity → duct pressure drop visualization</div>
      </div>

      <!-- OpenFOAM export -->
      ${r.openfoam ? `<div style="margin-top:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:11px">
        <div style="font-weight:600;margin-bottom:4px">OpenFOAM CFD Case</div>
        <div>${r.openfoam.notes || ''} — ${r.openfoam.segments?.length || 0} duct segments · ${r.openfoam.pressureDropPaPerM || 1.2} Pa/m friction</div>
        <div style="color:var(--text-muted);margin-top:4px">Run: blockMesh → snappyHexMesh → simpleFoam → ParaView</div>
      </div>` : ''}

      <div style="margin-top:12px;font-size:10px;color:var(--text-muted)">${disclaimer || ''}</div>
    `;
    div.classList.remove('hidden');
    animateAirflow('mep-hvac-canvas', r.ventilationCFM || 400);
    loadMEPGuardrails('mep_hvac', {
      ductVelocity: r.maxDuctVelocity || 0,
      coolingCapacity: r.coolingLoadBtuH || 0,
    });
  }

  // ─── SMACNA Rules for HVAC Results ─────────────────────────────────────────────

  function renderHVACResults(r, disclaimer) {
    const div = document.getElementById('mep-hvac-results');
    const compliance = r.compliance || {};
    const compBadge = compliance.status === 'PASS'
      ? '<span style="background:#065f46;color:#a7f3d0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>'
      : '<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';

    const ductSegs = (r.ductSizing?.segments || []).map(s => {
      const vel = s.velocityFPM || 0;
      const velColor = vel > 2500 ? '#e84855' : vel > 1200 ? '#f59e0b' : '#3bba6c';
      const velNote = vel > 2500 ? 'EXCEEDS SMACNA HIGH PRESSURE' : vel > 1200 ? 'BRANCH MAX OK' : 'LOW VELOCITY OK';
      return `<tr>
        <td style="padding:5px 8px">${s.id}</td>
        <td style="padding:5px 8px">${s.cfm} CFM</td>
        <td style="padding:5px 8px">${s.widthIn}" × ${s.heightIn}"</td>
        <td style="padding:5px 8px;color:${velColor}">${vel} FPM</td>
        <td style="padding:5px 8px">${s.frictionInWgPer100ft || 0.08}" wg/100ft</td>
        <td style="padding:5px 8px;font-size:10px;color:${velColor}">${velNote}</td>
      </tr>`;
    }).join('');

    // Psychrometric summary
    const psych = `
<div style="margin-top:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:11px">
  <div style="font-weight:600;margin-bottom:6px">ASHRAE Psychrometric — Climate Zone 4A (NYC)</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
    <div><div style="color:var(--text-muted)">99% Heat DB</div><div style="font-weight:600">-9°C</div></div>
    <div><div style="color:var(--text-muted)">1% Cool DB</div><div style="font-weight:600">33°C</div></div>
    <div><div style="color:var(--text-muted)">1% Cool WB</div><div style="font-weight:600">24°C</div></div>
    <div><div style="color:var(--text-muted)">Supply Air</div><div style="font-weight:600">13°C (55°F)</div></div>
  </div>
</div>`;

    // SMACNA rules section
    const smacnaRules = `
<div style="margin-top:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:11px">
  <div style="font-weight:600;margin-bottom:6px;color:#5b9bd5">SMACNA HVAC Duct Design Rules</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div style="padding:6px;background:#111;border-radius:4px">
      <div style="color:var(--text-muted)">Main Trunk Max Velocity</div>
      <div style="font-weight:600">1200 FPM (Low Pressure)</div>
    </div>
    <div style="padding:6px;background:#111;border-radius:4px">
      <div style="color:var(--text-muted)">Branch Max Velocity</div>
      <div style="font-weight:600">800 FPM (Low Pressure)</div>
    </div>
    <div style="padding:6px;background:#111;border-radius:4px">
      <div style="color:var(--text-muted)">High Pressure Max</div>
      <div style="font-weight:600">2500 FPM</div>
    </div>
    <div style="padding:6px;background:#111;border-radius:4px">
      <div style="color:var(--text-muted)">Noise Rating (Offices)</div>
      <div style="font-weight:600">NC 35 or below</div>
    </div>
  </div>
  <div style="margin-top:8px;font-size:10px;color:var(--text-muted)">
    ⚠️ All velocities > 1200 FPM should be confirmed as medium/high pressure systems per SMACNA.
  </div>
</div>`;

    div.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">HEATING LOAD</div>
          <div style="font-size:22px;font-weight:700">${r.heatingLoadBtuH?.toLocaleString() || '—'} <span style="font-size:12px;color:var(--text-muted)">Btu/h</span></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${r.heatingLoadW?.toLocaleString() || '—'} W</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">COOLING LOAD</div>
          <div style="font-size:22px;font-weight:700">${r.coolingLoadBtuH?.toLocaleString() || '—'} <span style="font-size:12px;color:var(--text-muted)">Btu/h</span></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${r.coolingLoadW?.toLocaleString() || '—'} W</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">FLOOR AREA</div>
          <div style="font-size:18px;font-weight:600">${r.floorAreaM2?.toLocaleString() || '—'} <span style="font-size:12px">m²</span></div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">OCCUPANTS</div>
          <div style="font-size:18px;font-weight:600">${Math.round(r.people || 0)}</div>
        </div>
      </div>
      <div style="margin-bottom:12px">${compBadge} <span style="font-size:11px;color:var(--text-muted)">${compliance.code || 'ASHRAE 90.1'} · Zone ${r.zone || '—'} · EUI ${compliance.euiBtuSqftYr || '—'} Btu/ft²/yr (limit ${compliance.limit || 250})</span></div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Ventilation CFM</div>
          <div style="font-size:16px;font-weight:600">${r.ventilationCFM || '—'}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Wall U-value</div>
          <div style="font-size:16px;font-weight:600">${r.wallU || '—'} W/m²K</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">PMV / PPD</div>
          <div style="font-size:16px;font-weight:600">${r.comfort?.pmv || '—'} / ${r.comfort?.ppd || '—'}%</div>
        </div>
      </div>

      ${psych}

      <!-- Duct sizing table with SMACNA velocity check -->
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;margin-top:12px">DUCT SIZING — Equal Friction Method (ASHRAE)</div>
      <table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:8px">
        <tr style="background:var(--surface)">
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Run</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">CFM</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Size</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Velocity</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Friction</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">SMACNA Check</th>
        </tr>
        ${ductSegs || '<tr><td colspan="6" style="color:var(--text-muted)">—</td></tr>'}
      </table>

      ${smacnaRules}

      <!-- Animated airflow canvas -->
      <div style="margin-top:12px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">🌬️ AIRFLOW SIMULATION</div>
        <canvas id="mep-hvac-canvas" width="680" height="100" style="border-radius:8px;border:1px solid var(--border);background:#0d0d0d;display:block;width:100%"></canvas>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Particle velocity → duct pressure drop visualization</div>
      </div>

      <!-- OpenFOAM export -->
      ${r.openfoam ? `<div style="margin-top:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:11px">
        <div style="font-weight:600;margin-bottom:4px">OpenFOAM CFD Case</div>
        <div>${r.openfoam.notes || ''} — ${r.openfoam.segments?.length || 0} duct segments · ${r.openfoam.pressureDropPaPerM || 1.2} Pa/m friction</div>
        <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center">
          <button onclick="window.downloadOpenFOAM()" style="background:#1d4ed8;color:#fff;border:none;border-radius:5px;padding:6px 14px;font-size:11px;cursor:pointer;font-weight:600">⬇ Download OpenFOAM Case</button>
          <span style="color:var(--text-muted)">blockMesh → snappyHexMesh → simpleFoam → ParaView</span>
        </div>
      </div>` : ''}

      <div style="margin-top:12px;font-size:10px;color:var(--text-muted)">${disclaimer || ''}</div>
    `;
    div.classList.remove('hidden');
    animateAirflow('mep-hvac-canvas', r.ventilationCFM || 400);
    loadMEPGuardrails('mep_hvac', {
      ductVelocity: r.maxDuctVelocity || 0,
      coolingCapacity: r.coolingLoadBtuH || 0,
    });
  }
  async function loadMEPGuardrails(simType, inputs) {
    const panel = document.getElementById('mep-guardrails-panel');
    const htmlEl = document.getElementById('mep-guardrails-html');
    const designEl = document.getElementById('mep-guardrails-design');
    if (!panel || !htmlEl || !designEl) return;
    try {
      const resp = await fetch('/api/guardrails/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simType, inputs }),
      });
      if (!resp.ok) { panel.style.display = 'none'; return; }
      const data = await resp.json();
      panel.style.display = data.valid ? 'none' : 'block';
      htmlEl.innerHTML = data.validationHtml || '';
      designEl.innerHTML = data.guidanceHtml || '';
    } catch (_) {
      panel.style.display = 'none';
    }
  }

  function renderPlumbingResults(r, disclaimer) {
    const div = document.getElementById('mep-plumb-results');
    const hammer = r.supplyPipe?.waterHammer || {};
    const hammerBadge = hammer.status === 'PASS'
      ? '<span style="background:#065f46;color:#a7f3d0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>'
      : '<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';

    const fixtureRows = Object.entries(r.fixtureCount || {}).map(([k, v]) =>
      `<tr><td style="padding:5px 8px">${k.replace(/-/g,' ')}</td><td style="padding:5px 8px">${v.units}</td><td style="padding:5px 8px">${v.dfu} DFU</td><td style="padding:5px 8px">${v.units * v.dfu} total</td></tr>`
    ).join('');

    div.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">TOTAL FIXTURE UNITS</div>
          <div style="font-size:22px;font-weight:700">${r.totalDFU || '—'}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">DFU (Hunter method)</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">SUPPLY GPM</div>
          <div style="font-size:22px;font-weight:700">${r.supplyPipe?.velocityFPS ? (r.supplyPipe?.velocityFPS / 0.3208 / (Math.PI * r.supplyPipe.diamIn ** 2) * 0.01).toFixed(1) : '—'}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${r.supplyPipe?.diamIn || '—'}″ pipe</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">SPRINKLER HEADS</div>
          <div style="font-size:18px;font-weight:600">${r.sprinkler?.headCount || '—'}</div>
          <div style="font-size:11px;color:var(--text-muted)">${r.sprinkler?.warning || 'NFPA 13 compliant'}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">WATER HAMMER</div>
          ${hammerBadge}
          <div style="font-size:11px;margin-top:4px">${hammer.velocityFPS || '—'} fps (limit 8 fps)</div>
        </div>
      </div>
      <div style="margin-bottom:12px">${hammerBadge} Water hammer check · Supply pipe: ${r.mainLineSizeIn || '—'}″ main / ${r.branchLineSizeIn || '—'}″ branch</div>

      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">FIXTURE COUNT</div>
      <table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:12px">
        <tr style="background:var(--surface)"><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Fixture</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Units</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">DFU/Unit</th><th style="padding:6px 8px;text-align:left;color:var(--text-muted)">Total DFU</th></tr>
        ${fixtureRows || '<tr><td colspan="4" style="color:var(--text-muted)">—</td></tr>'}
      </table>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Recirc Return Pipe</div>
          <div style="font-size:16px;font-weight:600">${r.hotWaterRecirc?.returnPipeDiamIn || '—'}″</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Recirc GPM</div>
          <div style="font-size:16px;font-weight:600">${r.hotWaterRecirc?.recircGPM || '—'}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Sprinkler Coverage</div>
          <div style="font-size:16px;font-weight:600">${r.sprinkler?.coveragePerHeadSqFt || '—'} ft²/head</div>
        </div>
      </div>

      <!-- Animated water flow canvas -->
      <div style="margin-top:12px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">💧 WATER FLOW SIMULATION</div>
        <canvas id="mep-plumb-canvas" width="680" height="100" style="border-radius:8px;border:1px solid var(--border);background:#0d0d0d;display:block;width:100%"></canvas>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Water velocity coloring — blue (slow) → yellow (fast) → red (over 8 fps)</div>
      </div>

      <!-- EPANET export + download -->
      ${r.epanet ? `<div style="margin-top:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:11px">
        <div style="font-weight:600;margin-bottom:6px">EPANET Network (.inp)</div>
        <div style="margin-bottom:6px">${r.epanet.nodeCount || 0} nodes · ${r.epanet.linkCount || 0} pipes · ${r.epanet.fileName || 'network.inp'}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button id="epanet-dl-btn" onclick="downloadPlumbingEpanet()" style="background:#1d4ed8;color:#fff;border:none;border-radius:5px;padding:6px 14px;font-size:11px;cursor:pointer;font-weight:600">⬇ Download .inp</button>
          <span style="color:var(--text-muted)">Open in EPANET (EPA, US) → simulate → export .rpt</span>
        </div>
        <div style="margin-top:10px;padding:8px;background:#0d0d0d;border-radius:5px">
          <div style="font-size:10px;font-weight:600;margin-bottom:4px;color:var(--text-muted)">IMPORT EPANET .rpt RESULTS</div>
          <textarea id="epanet-rpt-input" placeholder="Paste EPANET .rpt file content here…" style="width:100%;min-height:60px;background:#111;border:1px solid #333;color:#ccc;font-family:monospace;font-size:10px;padding:6px;border-radius:4px;resize:vertical;box-sizing:border-box"></textarea>
          <button id="epanet-import-btn" onclick="importPlumbingEpanet()" style="margin-top:6px;background:#065f46;color:#a7f3d0;border:none;border-radius:5px;padding:5px 12px;font-size:11px;cursor:pointer">Import .rpt Results</button>
          <div id="epanet-import-status" style="margin-top:4px;font-size:10px"></div>
        </div>
        <!-- EPANET imported results -->
        <div id="epanet-results-section" style="margin-top:10px;display:none">
          <div style="font-size:10px;font-weight:600;color:var(--text-muted);margin-bottom:6px">EPANET SIMULATION RESULTS</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
            <div style="background:#111;border-radius:5px;padding:8px;text-align:center">
              <div style="font-size:9px;color:var(--text-muted)">Max Velocity</div>
              <div id="epanet-max-vel" style="font-size:14px;font-weight:700">—</div>
              <div style="font-size:9px;color:var(--text-muted)">fps</div>
            </div>
            <div style="background:#111;border-radius:5px;padding:8px;text-align:center">
              <div style="font-size:9px;color:var(--text-muted)">Avg Velocity</div>
              <div id="epanet-avg-vel" style="font-size:14px;font-weight:700">—</div>
              <div style="font-size:9px;color:var(--text-muted)">fps</div>
            </div>
            <div style="background:#111;border-radius:5px;padding:8px;text-align:center">
              <div style="font-size:9px;color:var(--text-muted)">Nodes Analyzed</div>
              <div id="epanet-node-count" style="font-size:14px;font-weight:700">—</div>
            </div>
          </div>
          <div id="epanet-vel-summary" style="font-size:10px"></div>
        </div>
      </div>` : ''}

      <div style="margin-top:12px;font-size:10px;color:var(--text-muted)">${disclaimer || ''}</div>
    `;
    div.classList.remove('hidden');
    const gpm = Object.values(r.fixtureCount || {}).reduce((s, f) => s + f.units * f.dfu, 0) * 0.011;
    animateWaterFlow('mep-plumb-canvas', r.waterFlowParticles || gpm || 2);
    loadMEPGuardrails('mep_plumbing', {
      pipeVelocity: r.supplyPipe?.velocityFPS || 0,
      sprinklerSpacing: r.sprinkler?.coveragePerHeadSqFt || 0,
    });
  }

  // renderElectricalResults (enhanced) lives below after runAll / download helpers

  // ─── Codes / Schedule ───────────────────────────────────────────────────────
  async function loadCodes() {
    try {
      const resp = await fetch('/api/mep/codes/reference');
      const data = await resp.json();
      if (!data.codes) return;
      const rows = data.codes.map(c => `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;font-weight:600">${c.name}</td>
          <td style="padding:6px 8px;color:var(--text-muted)">${c.edition}</td>
          <td style="padding:6px 8px">${c.description}</td>
          <td style="padding:6px 8px"><span style="background:var(--accent);color:white;border-radius:4px;padding:1px 6px;font-size:10px">${c.applicability}</span></td>
        </tr>`).join('');
      document.getElementById('mep-codes-table').innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <tr style="background:var(--surface)"><th style="padding:6px 8px;text-align:left">Code</th><th style="padding:6px 8px;text-align:left">Edition</th><th style="padding:6px 8px;text-align:left">Description</th><th style="padding:6px 8px;text-align:left">Applies To</th></tr>
          ${rows}
        </table>`;
    } catch (e) { /* silent */ }
  }

  async function loadSchedule() {
    try {
      const resp = await fetch('/api/mep/schedule');
      const data = await resp.json();
      if (!data.schedule) return;
      const s = data.schedule;
      const html = `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">🅰️ HVAC</div>
            <div style="font-size:12px;margin-bottom:4px">Walls: <strong>${s.hvac?.totalWalls || '—'}</strong></div>
            <div style="font-size:12px;margin-bottom:4px">Zones: <strong>${s.hvac?.totalZones || '—'}</strong></div>
            <div style="font-size:12px;margin-bottom:4px">Duct runs: <strong>${s.hvac?.estimatedDuctRuns || '—'}</strong></div>
            <div style="font-size:12px">Diffusers: <strong>${s.hvac?.supplyDiffusers || '—'}</strong></div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">🅱️ Plumbing</div>
            <div style="font-size:12px;margin-bottom:4px">Walls: <strong>${s.plumbing?.totalWalls || '—'}</strong></div>
            <div style="font-size:12px;margin-bottom:4px">Fixtures: <strong>${s.plumbing?.estimatedFixtures || '—'}</strong></div>
            <div style="font-size:12px">Pipe runs: <strong>${s.plumbing?.estimatedPipeRuns || '—'}</strong></div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">⚡ Electrical</div>
            <div style="font-size:12px;margin-bottom:4px">Walls: <strong>${s.electrical?.totalWalls || '—'}</strong></div>
            <div style="font-size:12px;margin-bottom:4px">Circuits: <strong>${s.electrical?.estimatedCircuits || '—'}</strong></div>
            <div style="font-size:12px;margin-bottom:4px">Outlets: <strong>${s.electrical?.estimatedOutlets || '—'}</strong></div>
            <div style="font-size:12px">Switches: <strong>${s.electrical?.estimatedSwitches || '—'}</strong></div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-muted)">Auto-populated from model walls and family instances. Update model to refresh counts.</div>`;
      document.getElementById('mep-schedule-table').innerHTML = html;
    } catch (e) { /* silent */ }
  }

  async function loadHistory() {
    try {
      const resp = await fetch('/api/mep/history');
      const data = await resp.json();
      const items = (data.history || []).slice(0, 10);
      if (items.length === 0) {
        document.getElementById('mep-history-list').innerHTML = '<span style="color:var(--text-muted)">No simulations yet.</span>';
        return;
      }
      const rows = items.map(h => {
        const discBadge = { hvac: '🅰️', plumbing: '🅱️', electrical: '⚡' };
        const date = new Date(h.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const results = h.hvac_results || h.plumbing_results || h.electrical_results || {};
        const status = h.status === 'completed'
          ? '<span style="color:#3bba6c;font-size:10px">✓</span>'
          : h.status === 'failed'
          ? '<span style="color:#e84855;font-size:10px">✕</span>'
          : '<span style="color:#f59e0b;font-size:10px">◐</span>';
        return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
          <span>${discBadge[h.discipline] || '📊'} ${h.discipline?.toUpperCase() || 'MEP'}</span>
          <span style="color:var(--text-muted);font-size:10px">${date}</span>
          <span>${status}</span>
        </div>`;
      }).join('');
      document.getElementById('mep-history-list').innerHTML = rows;
    } catch (e) { /* silent */ }
  }

  // ─── Animated Canvas Visualizations ───────────────────────────────────────

  function animateAirflow(canvasId, cfm) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    cancelAnimationFrame(animFrames.find(f => f.id === canvasId)?.raf);
    const ctx = canvas.getContext('2d');
    const particles = [];
    const count = Math.min(80, Math.floor(cfm / 10));
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        speed: 1 + Math.random() * 3,
        size: 1 + Math.random() * 2,
        alpha: 0.3 + Math.random() * 0.7,
        hue: 180 + Math.random() * 40,
      });
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw duct outline
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(20, 15, canvas.width - 40, canvas.height - 30);
      ctx.setLineDash([]);

      for (const p of particles) {
        p.x += p.speed * 2;
        if (p.x > canvas.width + 5) { p.x = -5; p.y = Math.random() * canvas.height; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},80%,65%,${p.alpha})`;
        ctx.fill();
      }
      animFrames = [{ id: canvasId, raf: requestAnimationFrame(draw) }];
    }
    draw();
  }

  /**
   * Animate water flow through pipe network.
   * Uses waterFlowParticles data (from plumbing runner) when available:
   *   - Draws main + branch pipes as lines
   *   - Animates particles with velocity-colored hues (blue=slow, yellow=caution, red=over 8fps)
   * Falls back to generic particle flow if no particle data provided.
   */
  function animateWaterFlow(canvasId, gpmOrData) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    cancelAnimationFrame(animFrames.find(f => f.id === canvasId)?.raf);
    const ctx = canvas.getContext('2d');

    // Accept either raw gpm number (legacy) or waterFlowParticles object
    const particleData = (gpmOrData && typeof gpmOrData === 'object') ? gpmOrData : null;
    const particles = particleData?.particles || [];
    const pipePath = particleData?.pipePath || [];
    const branches = particleData?.branches || [];
    const gpm = (gpmOrData && typeof gpmOrData === 'number') ? gpmOrData : 2;

    let state = {
      mainParticles: [],
      branchParticles: [],
      phase: 0,
    };

    function init() {
      // Main pipe particles
      const mainCount = Math.min(40, Math.max(particles.length, Math.floor(gpm * 4)));
      state.mainParticles = [];
      for (let i = 0; i < mainCount; i++) {
        const p = particles[i] || {};
        const speed = (p.speed || (0.5 + gpm * 0.1)) * 0.8;
        state.mainParticles.push({
          x: (i / mainCount) * canvas.width,
          y: canvas.height / 2,
          speed,
          hue: p.hue || 200,
          alpha: p.alpha || 0.6,
          size: p.size || 2,
        });
      }
      // Branch particles
      const branchCount = Math.min(20, Math.floor(mainCount / 2));
      state.branchParticles = [];
      for (let i = 0; i < branchCount; i++) {
        state.branchParticles.push({
          x: canvas.width * 0.25 + Math.random() * canvas.width * 0.5,
          y: canvas.height / 2,
          speed: 0.3 + Math.random() * 1.5,
          hue: 180 + Math.random() * 20,
          alpha: 0.4 + Math.random() * 0.4,
          size: 1.5,
          branchY: canvas.height / 2 + (i % 2 === 0 ? -canvas.height * 0.3 : canvas.height * 0.3),
        });
      }
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw pipe network
      const cw = canvas.width;
      const ch = canvas.height;

      // Main pipe (thick line across middle)
      const mainLineY = ch / 2;
      const pipeWidth = 4;
      ctx.strokeStyle = '#2a4a6b';
      ctx.lineWidth = pipeWidth * 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(10, mainLineY);
      ctx.lineTo(cw - 10, mainLineY);
      ctx.stroke();

      // Branch pipes
      if (pipePath.length > 1) {
        pipePath.forEach((segment, i) => {
          if (i > 0) {
            const x1 = (i - 1) / Math.max(pipePath.length - 1, 1) * cw;
            const x2 = i / Math.max(pipePath.length - 1, 1) * cw;
            ctx.strokeStyle = '#1e3a5a';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x1, mainLineY);
            ctx.lineTo(x2, mainLineY);
            ctx.stroke();
          }
        });
      }

      // Branch splits
      branches.forEach((b) => {
        const x = (b.x / 100) * cw;
        ctx.strokeStyle = '#1a3a5a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, mainLineY);
        ctx.lineTo(x, mainLineY + (b.y > 50 ? -ch * 0.25 : ch * 0.25));
        ctx.stroke();
        // Branch end cap
        ctx.strokeStyle = '#1a3a5a';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x - 4, mainLineY + (b.y > 50 ? -ch * 0.25 + 2 : ch * 0.25 - 2));
        ctx.lineTo(x + 4, mainLineY + (b.y > 50 ? -ch * 0.25 + 2 : ch * 0.25 - 2));
        ctx.stroke();
      });

      // Velocity legend: draw colored dots showing the velocity color scale
      const legendX = cw - 80;
      const grad = ctx.createLinearGradient(legendX, 0, legendX, 40);
      grad.addColorStop(0, 'hsl(200,80%,60%)');    // blue = slow
      grad.addColorStop(0.5, 'hsl(60,80%,60%)');   // yellow = 4fps
      grad.addColorStop(1, 'hsl(10,80%,60%)');     // red = 8fps+
      ctx.fillStyle = grad;
      ctx.fillRect(legendX, 8, 8, 40);
      ctx.fillStyle = '#666';
      ctx.font = '9px monospace';
      ctx.fillText('0', legendX + 12, 16);
      ctx.fillText('4', legendX + 12, 30);
      ctx.fillText('8+', legendX + 12, 50);

      // Animate main particles along main pipe
      state.mainParticles.forEach((p) => {
        p.x += p.speed;
        if (p.x > cw + 5) p.x = -5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},80%,60%,${p.alpha})`;
        ctx.fill();
      });

      // Animate branch particles (up/down along branches)
      state.branchParticles.forEach((p) => {
        p.y += p.speed * (p.branchY > canvas.height / 2 ? 1 : -1);
        if (Math.abs(p.y - p.branchY) < 1) p.speed = -p.speed;
        if (p.y > canvas.height / 2 + 20 || p.y < canvas.height / 2 - 20) p.speed = -p.speed;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},80%,55%,${p.alpha})`;
        ctx.fill();
      });

      // Pipe label
      ctx.fillStyle = '#666';
      ctx.font = '9px monospace';
      ctx.fillText('MAIN', 12, 12);
      ctx.fillText('BRANCHES', cw - 150, 12);

      animFrames = [{ id: canvasId, raf: requestAnimationFrame(draw) }];
    }

    init();
    draw();
  }

  function animateCircuitLoads(canvasId, amps, panelAmps) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    cancelAnimationFrame(animFrames.find(f => f.id === canvasId)?.raf);
    const ctx = canvas.getContext('2d');
    const numBars = 8;
    const barW = (canvas.width - 20) / numBars - 4;
    const loads = Array.from({ length: numBars }, (_, i) => {
      const pct = 0.3 + Math.random() * 0.7;
      const a = amps * pct / numBars;
      return { amps: a, pct, rating: panelAmps / numBars };
    });

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      loads.forEach((l, i) => {
        const x = 10 + i * (barW + 4);
        const fillPct = (l.amps / l.rating);
        const color = fillPct > 1 ? '#e84855' : fillPct > 0.8 ? '#f59e0b' : '#3bba6c';
        const barH = Math.min(fillPct, 1) * (canvas.height - 20);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(x, 0, barW, canvas.height);
        ctx.fillStyle = color;
        ctx.fillRect(x, canvas.height - barH, barW, barH);
        ctx.fillStyle = '#666';
        ctx.font = '10px monospace';
        ctx.fillText(`${Math.round(l.amps)}A`, x + 2, canvas.height - 4);
      });
      animFrames = [{ id: canvasId, raf: requestAnimationFrame(draw) }];
    }
    draw();
  }

  function cancelAnimations() {
    animFrames.forEach(f => cancelAnimationFrame(f.raf));
    animFrames = [];
  }

  // ─── Fire Protection Results Renderer ─────────────────────────────────────

  function renderFireResults(data) {
    const div = document.getElementById('mep-fire-results');
    const sprinkler = data.sprinkler_results || {};
    const egress = data.egress_results || {};
    const smoke = data.smoke_results || {};
    const resistance = data.resistance_results || {};
    const fdny = data.fdny_results || {};

    const sprinklerBadge = sprinkler.status === 'PASS'
      ? '<span style="background:#065f46;color:#a7f3d0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>'
      : '<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';

    const egressBadge = egress.status === 'PASS'
      ? '<span style="background:#065f46;color:#a7f3d0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>'
      : '<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';

    div.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">SPRINKLER SYSTEM</div>
          ${sprinklerBadge}
          <div style="font-size:11px;margin-top:4px">${sprinkler.system_type || 'Wet pipe'} · k-factor ${sprinkler.k_factor || '—'}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">EGRESS / OCCUPANT LOAD</div>
          ${egressBadge}
          <div style="font-size:11px;margin-top:4px">${egress.occupant_load_per_floor || '—'} occupants · ${egress.exits_provided || '—'} exits</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">MIN EXIT WIDTH</div>
          <div style="font-size:18px;font-weight:600">${egress.required_exit_width_in || '—'} <span style="font-size:12px;color:var(--text-muted)">in aggregate</span></div>
          <div style="font-size:11px;color:var(--text-muted)">NFPA 101 Table 7.2.2.1</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">TRAVEL DISTANCE</div>
          <div style="font-size:18px;font-weight:600">${egress.travel_distance_ft || '—'} <span style="font-size:12px;color:var(--text-muted)">ft (max 200 ft)</span></div>
          <div style="font-size:11px;color:var(--text-muted)">Per NFPA 101 §7.6</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Sprinkler Heads</div>
          <div style="font-size:16px;font-weight:600">${sprinkler.head_count || '—'}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Hazard Type</div>
          <div style="font-size:16px;font-weight:600">${sprinkler.hazard_type || 'Light'}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Standpipe</div>
          <div style="font-size:16px;font-weight:600">${fdny.standpipe_needed ? 'Required' : 'N/A'}</div>
        </div>
      </div>

      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">🔥 FIRE RESISTANCE & SMOKE CONTROL</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px;font-size:11px">
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Fire Rating</div><div style="font-weight:600">${resistance.required_fire_rating_hours || '2'} hr</div></div>
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Smoke Control</div><div style="font-weight:600">${smoke.smoke_control_needed ? 'Required' : 'Not required'}</div></div>
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Stair Pressurization</div><div style="font-weight:600">${smoke.stair_pressurization_pa || '—'} Pa</div></div>
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">NYC FDNY</div><div style="font-weight:600">${fdny.nyc_filing_required ? 'Filing required' : 'Consult AHJ'}</div></div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px">
        <button onclick="downloadFireFDS()" style="background:#1d4ed8;color:#fff;border:none;border-radius:5px;padding:6px 14px;font-size:11px;cursor:pointer;font-weight:600">⬇ Download FDS File</button>
        <button onclick="runFireFDSInline()" style="background:#b91c1c;color:#fff;border:none;border-radius:5px;padding:6px 14px;font-size:11px;cursor:pointer;font-weight:600">▶ Run FDS Sim</button>
      </div>

      <div style="margin-top:12px;font-size:10px;color:var(--text-muted)">⚠️ All fire protection designs must be reviewed and stamped by a licensed fire protection engineer.</div>
    `;
    div.classList.remove('hidden');
  }

  function renderFDSResults(data) {
    const f = data.fds || {};
    const smokeLayer = f.smoke_layer_height_m || '—';
    const ceilingTemp = f.ceiling_temperature_rise_c || '—';
    const actTime = f.sprinkler_activation_time_s || '—';
    const vis = f.visibility_m || '—';

    document.getElementById('fds-smoke-height') && (document.getElementById('fds-smoke-height').textContent = smokeLayer !== '—' ? smokeLayer.toFixed(2) : '—');
    document.getElementById('fds-ceiling-temp') && (document.getElementById('fds-ceiling-temp').textContent = ceilingTemp !== '—' ? ceilingTemp.toFixed(1) : '—');
    document.getElementById('fds-sprinkler-act') && (document.getElementById('fds-sprinkler-act').textContent = actTime !== '—' ? actTime.toFixed(0) : '—');
    document.getElementById('fds-visibility') && (document.getElementById('fds-visibility').textContent = vis !== '—' ? vis.toFixed(1) : '—');

    animateFireCurve('mep-fire-canvas', f.hrr_time_series || [], f.sprinkler_activation_time_s || null);
    const section = document.getElementById('mep-fire-fds-section');
    if (section) section.classList.remove('hidden');
  }

  function animateFireCurve(canvasId, hrrSeries, sprinklerTime) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    cancelAnimationFrame(animFrames.find(f => f.id === canvasId)?.raf);
    const ctx = canvas.getContext('2d');
    const peaks = hrrSeries?.length ? hrrSeries : [0, 500, 1000, 2000, 3000, 2950, 500, 100];

    let phase = 0;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const w = canvas.width, h = canvas.height;

      // Background
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = (i / 4) * h;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Fire HRR curve (orange line)
      ctx.beginPath();
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      peaks.forEach((v, i) => {
        const x = (i / Math.max(peaks.length - 1, 1)) * w;
        const y = h - (Math.min(v, 3000) / 3000) * (h - 10);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Sprinkler activation marker (red vertical)
      if (sprinklerTime) {
        const sp = (sprinklerTime / 300) * w;
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(sp, 0);
        ctx.lineTo(sp, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ef4444';
        ctx.font = '9px monospace';
        ctx.fillText(`⚡ ${sprinklerTime.toFixed(0)}s`, sp + 4, 14);
      }

      // Labels
      ctx.fillStyle = '#666';
      ctx.font = '9px monospace';
      ctx.fillText('HRR (kW)', 8, 12);
      ctx.fillText('t (s)', w - 30, h - 4);

      animFrames = [{ id: canvasId, raf: requestAnimationFrame(draw) }];
    }
    draw();
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  function checkDisclaimer(discipline) {
    const checkboxId = `mep-${discipline}-disclaimer`;
    const checked = document.getElementById(checkboxId)?.checked;
    if (!checked) {
      alert('Please accept the professional disclaimer before running MEP simulations.');
      return false;
    }
    return true;
  }

  function setLoading(targetId, msg) {
    const el = document.getElementById(targetId);
    if (el) { el.innerHTML = `<div style="padding:12px;color:var(--text-muted)">${msg}</div>`; el.classList.remove('hidden'); }
  }

  function showError(targetId, msg) {
    const el = document.getElementById(targetId);
    if (el) { el.innerHTML = `<div style="padding:10px;background:rgba(232,72,85,0.15);border:1px solid rgba(232,72,85,0.4);border-radius:6px;color:#e84855;font-size:12px">⚠️ ${msg}</div>`; el.classList.remove('hidden'); }
  }

  // ─── EPANET file download / .rpt import (window-level for onclick) ──────

  let lastPlumbingSimId = null;

  window.downloadPlumbingEpanet = async function () {
    // Try to get the most recent plumbing simulation ID from the history list
    try {
      const resp = await fetch('/api/mep/history?limit=1&projectId=1');
      const data = await resp.json();
      const latest = data.history?.find(h => h.discipline === 'plumbing');
      const simId = latest?.id;
      if (!simId) { alert('Run a plumbing simulation first before downloading EPANET file.'); return; }
      const dlResp = await fetch(`/api/mep/epanet-download/${simId}`);
      if (!dlResp.ok) throw new Error((await dlResp.json()).error || 'Download failed');
      const blob = await dlResp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'atlantist_water_distribution.inp';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Download failed: ' + err.message);
    }
  };

  window.importPlumbingEpanet = async function () {
    const rptContent = document.getElementById('epanet-rpt-input')?.value?.trim();
    if (!rptContent) { alert('Paste EPANET .rpt content first.'); return; }
    const statusEl = document.getElementById('epanet-import-status');
    statusEl.textContent = 'Parsing…';
    try {
      // Find latest plumbing sim ID
      const histResp = await fetch('/api/mep/history?limit=1&projectId=1');
      if (!histResp.ok) { statusEl.textContent = 'Failed to load history'; return; }
      const hist = await histResp.json();
      const latest = hist.history?.find(h => h.discipline === 'plumbing');
      const runId = latest?.id;
      const resp = await fetch('/api/mep/epanet-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, rptContent }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      const parsed = data.parsed || {};
      const vs = parsed.velocityStats || {};
      const ps = parsed.pressureStats || {};
      document.getElementById('epanet-max-vel').textContent = vs.max?.toFixed(2) || '—';
      document.getElementById('epanet-avg-vel').textContent = vs.avg?.toFixed(2) || '—';
      document.getElementById('epanet-node-count').textContent = parsed.nodes?.length || '—';
      const velSummary = vs.exceeding8fps > 0
        ? `<span style="color:#e84855">⚠️ ${vs.exceeding8fps} pipe(s) exceed 8 fps velocity limit</span>`
        : `<span style="color:#3bba6c">✓ All velocities within IPC 8 fps limit</span>`;
      document.getElementById('epanet-vel-summary').innerHTML = velSummary;
      document.getElementById('epanet-results-section').style.display = 'block';
      statusEl.textContent = `✓ Imported ${parsed.nodes?.length || 0} nodes, ${parsed.links?.length || 0} links. Status: ${parsed.status || 'UNKNOWN'}`;
      // Re-run canvas animation with imported max velocity
      if (parsed.velocityStats?.max) {
        animateWaterFlow('mep-plumb-canvas', parsed.velocityStats.max);
      }
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    }
  };

// ─── Event wiring ───────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('mep-modal-close')?.addEventListener('click', close);
    document.getElementById('modal-mep')?.addEventListener('click', e => { if (e.target.id === 'modal-mep') close(); });

    // Tab switching
    document.querySelectorAll('.mep-tab').forEach(btn => {
      btn?.addEventListener('click', () => renderTab(btn.dataset.tab));
    });

    // Run buttons
    document.getElementById('mep-run-hvac')?.addEventListener('click', runHVAC);
    document.getElementById('mep-run-plumbing')?.addEventListener('click', runPlumbing);
    document.getElementById('mep-run-electrical')?.addEventListener('click', runElectrical);
    document.getElementById('mep-run-fire')?.addEventListener('click', runFire);
    document.getElementById('mep-run-fds')?.addEventListener('click', runFDS);

    // Run All MEP
    document.getElementById('mep-run-all')?.addEventListener('click', runAll);

    // Export MEP schedule PDF
    document.getElementById('mep-export-all')?.addEventListener('click', () => {
      window.exportMEPSchedulePDF();
    });

    // OpenFOAM download
    document.getElementById('mep-dl-openfoam')?.addEventListener('click', () => {
      window.downloadOpenFOAM();
    });

    // EPANET download (reuses existing plumbing download)
    document.getElementById('mep-dl-epanet')?.addEventListener('click', () => {
      window.downloadPlumbingEpanet();
    });

    // Design Book push
    document.getElementById('mep-push-design-book')?.addEventListener('click', pushToDesignBook);

    // Open MEP modal from toolbar
    const btnMEP = document.getElementById('btn-mep');
    if (btnMEP) btnMEP?.addEventListener('click', open);
  });

  // ─── Run All MEP Simulations ───────────────────────────────────────────────────

  async function runAll() {
    if (!checkDisclaimer('hvac')) return;
    const progress = document.getElementById('mep-all-progress');
    const resultsDiv = document.getElementById('mep-all-results');
    progress.textContent = 'Running HVAC, Plumbing, and Electrical simultaneously…';
    resultsDiv.style.display = 'none';

    try {
      const resp = await fetch('/api/mep/run-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceType: document.getElementById('mep-all-space')?.value || 'office',
          occupancyType: document.getElementById('mep-all-occ')?.value || 'office',
          material: document.getElementById('mep-all-mat')?.value || 'copper',
          disclaimerAccepted: true,
          voltage: 208,
          phase: '3phase',
          infiltACH: 0.35,
          ambientTempF: 86,
        }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();

      // Show results in summary cards
      const hvac = data.hvac || {};
      const plumb = data.plumbing || {};
      const elec = data.electrical || {};

      document.getElementById('mep-all-hvac-status').textContent = (hvac.compliance?.status === 'PASS') ? '✓ PASS' : '✕ FAIL';
      document.getElementById('mep-all-hvac-status').style.color = hvac.compliance?.status === 'PASS' ? '#3bba6c' : '#e84855';
      document.getElementById('mep-all-hvac-val').textContent = `${(hvac.heatingLoadBtuH / 1000).toFixed(1)}k Btu/h`;
      document.getElementById('mep-all-hvac-comp').textContent = `EUI ${hvac.compliance?.euiBtuSqftYr || '—'} Btu/ft²`;

      document.getElementById('mep-all-plumb-status').textContent = plumb.supplyPipe?.waterHammer?.status === 'PASS' ? '✓ PASS' : '✕ FAIL';
      document.getElementById('mep-all-plumb-status').style.color = plumb.supplyPipe?.waterHammer?.status === 'PASS' ? '#3bba6c' : '#e84855';
      document.getElementById('mep-all-plumb-val').textContent = `${plumb.totalDFU || '—'} DFU`;
      document.getElementById('mep-all-plumb-comp').textContent = `${plumb.sprinkler?.headCount || '—'} sprinkler heads`;

      document.getElementById('mep-all-elec-status').textContent = elec.compliance?.status === 'PASS' ? '✓ PASS' : '✕ FAIL';
      document.getElementById('mep-all-elec-status').style.color = elec.compliance?.status === 'PASS' ? '#3bba6c' : '#e84855';
      document.getElementById('mep-all-elec-val').textContent = `${elec.panel?.totalKW || '—'} kW`;
      document.getElementById('mep-all-elec-comp').textContent = `#${elec.wiring?.awg || '—'} AWG · ${elec.conduit?.size || '—'}″ EMT`;

      progress.textContent = `✓ Completed in ${data.id ? '' : '—'}`;
      resultsDiv.style.display = 'block';

      // Store latest run ID for downloads
      lastAllRunId = data.id;
      lastHVACResults = hvac;
      lastPlumbResults = plumb;
      lastElecResults = elec;

      loadHistory();
      checkDesignBookStatus();
    } catch (err) {
      progress.textContent = 'Error: ' + err.message;
    }
  }

  let lastAllRunId = null;

  // OpenFOAM download
  window.downloadOpenFOAM = async function () {
    try {
      // Find a simulation with HVAC results
      const resp = await fetch('/api/mep/history?limit=10&projectId=1');
      const data = await resp.json();
      const hvacSim = data.history?.find(h => h.hvac_results?.openfoam);
      const simId = hvacSim?.id || lastAllRunId;
      if (!simId) { alert('Run an HVAC simulation first.'); return; }
      const dlResp = await fetch(`/api/mep/openfoam-download/${simId}`);
      if (!dlResp.ok) throw new Error((await dlResp.json()).error || 'Download failed');
      const blob = await dlResp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `atlantist_openfoam_${simId}.txt`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert('OpenFOAM download failed: ' + err.message); }
  };

  // MEP schedule PDF export
  window.exportMEPSchedulePDF = async function () {
    try {
      window.open('/api/mep/schedule-pdf/1', '_blank');
    } catch (err) { alert('Export failed: ' + err.message); }
  };

  // ─── Enhanced Electrical Results ──────────────────────────────────────────────

  function renderElectricalResults(r, disclaimer) {
    const div = document.getElementById('mep-elec-results');
    const wiring = r.wiring || {};
    const necAmpTable = `
<table style="width:100%;font-size:10px;border-collapse:collapse;margin-bottom:8px">
<tr style="background:#222"><th style="padding:4px 6px;text-align:left;color:#fff">AWG</th><th style="padding:4px 6px;color:#fff">60°C (NM)</th><th style="padding:4px 6px;color:#fff">75°C (THHN)</th><th style="padding:4px 6px;color:#fff">90°C (XHHW)</th></tr>
${[[14,15,20,25],[12,20,25,30],[10,30,35,40],[8,40,50,55],[6,55,65,75],[4,70,85,95],[2,95,115,130]].map(row =>
`<tr style="border-bottom:1px solid #333"><td style="padding:4px 6px;font-weight:600">#${row[0]}</td>
<td style="padding:4px 6px;color:${wiring.awg == row[0]?'#3bba6c':'inherit'};${row[1]===null?'opacity:0.4':''}">${row[1]===null?'—':row[1]+'A'}</td>
<td style="padding:4px 6px;color:${wiring.awg == row[0]?'#3bba6c':'inherit'}">${row[2]+'A'}</td>
<td style="padding:4px 6px;color:${wiring.awg == row[0]?'#3bba6c':'inherit'}">${row[3]+'A'}</td></tr>`).join('')}
</table>`;

    const passBadge = wiring.pass !== false && (r.conduit?.fillPct || 0) <= 40
      ? '<span style="background:#065f46;color:#a7f3d0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>'
      : '<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';

    // Voltage drop analysis
    const vdSection = wiring.percentDrop !== undefined ? `
<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;font-size:11px">
<div style="font-weight:600;margin-bottom:6px">NEC §210.19 Voltage Drop Analysis</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
  <div><div style="color:var(--text-muted)">At 100 ft</div><div style="font-weight:600">${wiring.voltsDropped || '—'} V (${wiring.percentDrop || '—'}%)</div></div>
  <div><div style="color:var(--text-muted)">NEC Limit</div><div style="font-weight:600">3% branch / 5% feeder</div></div>
  <div><div style="color:var(--text-muted)">Status</div><div>${(wiring.pass3pct) ? '<span style="color:#3bba6c">✓ Within 3%</span>' : '<span style="color:#f59e0b">⚠ Exceeds 3% — consider upsizing</span>'}</div></div>
</div>
</div>` : '';

    div.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">PANEL SIZE</div>
          <div style="font-size:22px;font-weight:700">${r.panel?.recommendedPanelAmps || '—'} <span style="font-size:12px">A</span></div>
          <div style="font-size:11px;color:var(--text-muted)">${r.panel?.voltage || '—'}V ${r.panel?.phase || '—'}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">TOTAL LOAD</div>
          <div style="font-size:22px;font-weight:700">${r.panel?.totalKW || '—'} <span style="font-size:12px">kW</span></div>
          <div style="font-size:11px;color:var(--text-muted)">${r.panel?.calculatedAmps || '—'} A calculated</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">WIRE SIZE (100 FT)</div>
          <div style="font-size:18px;font-weight:600">#${wiring.awg || '—'} AWG</div>
          <div style="font-size:11px;color:var(--text-muted)">${wiring.ampacity || '—'}A ampacity · ${r.conduit?.type || 'EMT'} ${r.conduit?.size || '—'}″</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">VOLTAGE DROP</div>
          ${passBadge}
          <div style="font-size:11px;margin-top:4px">${wiring.percentDrop || '—'}% at 100 ft</div>
        </div>
      </div>

      ${vdSection}

      <div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">NEC Table 310.16 — Copper Wire Ampacity</div>
        ${necAmpTable}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Conduit Size</div>
          <div style="font-size:16px;font-weight:600">${r.conduit?.type || 'EMT'} ${r.conduit?.size || '—'}"</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Conduit Fill</div>
          <div style="font-size:16px;font-weight:600">${r.conduit?.fillPct || '—'}%</div>
          <div style="font-size:9px;color:var(--text-muted)">NEC Ch.9 limit: 40%</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted)">Service Entrance</div>
          <div style="font-size:16px;font-weight:600">#${r.serviceEntrance?.recommendedAWG || '—'}</div>
          <div style="font-size:9px;color:var(--text-muted)">${r.serviceEntrance?.recommendedAmpacity || '—'}A ampacity</div>
        </div>
      </div>

      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">LOAD BREAKDOWN (NEC 220.87)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px;font-size:11px">
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Lighting</div><div style="font-weight:600">${r.panel?.generalLightingKW || '—'} kW</div></div>
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Receptacle</div><div style="font-weight:600">${r.panel?.receptacleKW || '—'} kW</div></div>
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Equipment</div><div style="font-weight:600">${r.panel?.equipmentKW || '—'} kW</div></div>
        <div style="background:#1a1a1a;border-radius:6px;padding:8px"><div style="color:var(--text-muted)">Motors</div><div style="font-weight:600">${r.panel?.motorKW || '—'} kW</div></div>
      </div>

      <!-- Load balance tip -->
      <div style="padding:8px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:6px;font-size:10px;color:var(--text-muted);margin-bottom:12px">
        💡 Load Balance Tip: Balance phases within 10% to avoid neutral current and reduce transformer heating.
        Panel recommendation: ${r.panel?.recommendedPanelAmps || '—'}A at ${r.panel?.voltage || '—'}V ${r.panel?.phase || '—'}.
        ${r.compliance?.notes || ''}
      </div>

      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">⚡ CIRCUIT LOAD VISUALIZATION</div>
      <canvas id="mep-elec-canvas" width="680" height="80" style="border-radius:8px;border:1px solid var(--border);background:#0d0d0d;display:block;width:100%;margin-bottom:8px"></canvas>
      <div style="font-size:10px;color:var(--text-muted);margin-bottom:12px">Load bars by circuit — green (≤80%), yellow (80-100%), red (>100% of breaker rating)</div>

      <div style="margin-top:12px;font-size:10px;color:var(--text-muted)">${disclaimer || ''}</div>
    `;
    div.classList.remove('hidden');
    animateCircuitLoads('mep-elec-canvas', r.panel?.calculatedAmps || 50, r.panel?.recommendedPanelAmps || 100);
    loadMEPGuardrails('mep_electrical', {
      conduitFill: r.conduit?.fillPct || 0,
      voltageDrop: r.voltageDrop || 0,
      panelLoad: r.panelLoad || 0,
      circuitAmpacity: r.panel?.calculatedAmps || 0,
    });
  }

  // ─── Push to Design Book ─────────────────────────────────────────────────────

  async function checkDesignBookStatus() {
    try {
      const resp = await fetch('/api/mep/design-book-status?projectId=1');
      if (!resp.ok) return;
      const data = await resp.json();
      const statusEl = document.getElementById('mep-design-book-status');
      if (!statusEl) return;
      if (data.pushed) {
        statusEl.innerHTML = `<span style="color:#3bba6c">✓ ${data.mepPlaceholders.length} MEP sheets in Design Book</span>`;
      } else {
        statusEl.innerHTML = '<span style="color:var(--text-muted)">Run simulations first</span>';
      }
    } catch (_) { /* silent */ }
  }

  async function pushToDesignBook() {
    const btn = document.getElementById('mep-push-design-book');
    const statusEl = document.getElementById('mep-design-book-status');
    if (!btn || !statusEl) return;
    btn.disabled = true;
    statusEl.textContent = 'Pushing…';
    try {
      const resp = await fetch('/api/mep/push-to-design-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 1 }),
      });
      if (!resp.ok) { const text = await resp.text().catch(() => ''); throw new Error(text.slice(0,200) || `HTTP ${resp.status}`); }
      const data = await resp.json();
      statusEl.innerHTML = `<span style="color:#3bba6c">✓ ${data.placeholdersCreated} sheets · ${data.productsCreated} products → Design Book</span>`;
    } catch (err) {
      statusEl.innerHTML = `<span style="color:#e84855">⚠️ ${err.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ─── Window-level helpers for fire protection ──────────────────────────────
  window.runFireFDSInline = runFDS;

  window.downloadFireFDS = async function () {
    try {
      const resp = await fetch('/api/fire-protection/fds/export');
      if (!resp.ok) throw new Error('FDS export failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `atlantist_fds_${Date.now()}.fds`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('FDS download failed: ' + err.message);
    }
  };

  // Expose for app.js
  window.MEPPanel = { open, close };
})();