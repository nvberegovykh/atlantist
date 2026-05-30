/**
 * SimulationTimeline — Unified timeline viewport for all sim types
 * Replaces per-sim bespoke timeline players (energy yearviz, fire FDS, structural, etc.)
 *
 * simType: 'energy' | 'fire' | 'structural' | 'mep' | 'geotech'
 * results:  { hourly?, modes?, dashboard?, ... } — type varies by simType
 */

import * as THREE from 'three';

// ─── State ───────────────────────────────────────────────────────────────────
let simType = null;
let results = null;
let currentTimeIndex = 0;
let isPlaying = false;
let playbackInterval = null;
let playbackSpeed = 1.0;
let activeMode = null;
let activeSort = null;
let recordingState = null; // null | 'recording' | 'paused'

// Three.js mini renderer
let miniRenderer = null;
let miniScene = null;
let miniCamera = null;
let wallMeshesMini = [];
let wallMaterials = [];
let animFrameId = null;

// MediaRecorder
let mediaRecorder = null;
let recordedChunks = [];

// Current sort data
let sortData = [];

// ─── Config ──────────────────────────────────────────────────────────────────
const LEGEND_CONFIG = {
  energy: {
    temp:   { label: 'Temperature',   min: '−10°C', max: '35°C',   gradient: 'linear-gradient(90deg, #60a5fa, #fafafa, #f97316, #ef4444)' },
    load:   { label: 'HVAC Load',      min: '0 kW',  max: 'max kW', gradient: 'linear-gradient(90deg, #60a5fa, #f97316)' },
    solar:  { label: 'Solar Gain',     min: '0 Wh/m²','max':'1000 Wh/m²', gradient: 'linear-gradient(90deg, #1a1a1a, #fbbf24)' },
  },
  fire: {
    smoke:    { label: 'Smoke Density', min: '0%', max: '100%',   gradient: 'linear-gradient(90deg, transparent, #6b7280, #1f2937)' },
    temp:     { label: 'Temperature',   min: '0°C', max: '200°C', gradient: 'linear-gradient(90deg, #60a5fa, #f97316, #ef4444)' },
    pressure: { label: 'Pressure',       min: 'Low', max: 'High',  gradient: 'linear-gradient(90deg, #60a5fa, #ef4444)' },
    egress:   { label: 'Egress Load',  min: '0', max: 'Limit',   gradient: 'linear-gradient(90deg, #22c55e, #f59e0b, #ef4444)' },
  },
  structural: {
    dc:      { label: 'D/C Ratio',      min: '0%', max: '100%',   gradient: 'linear-gradient(90deg, #22c55e, #eab308, #ef4444)' },
    defl:    { label: 'Deflection',     min: '0mm', max: 'L/360', gradient: 'linear-gradient(90deg, #60a5fa, #ef4444)' },
    drift:   { label: 'Story Drift',    min: '0%', max: '1.5%',  gradient: 'linear-gradient(90deg, #22c55e, #f59e0b, #ef4444)' },
  },
  mip: {
    flow:    { label: 'Flow Rate',      min: '0 L/s', max: 'max', gradient: 'linear-gradient(90deg, #60a5fa, #f97316)' },
    pressure:{ label: 'Pressure ΔP',    min: '0 Pa', max: 'max',   gradient: 'linear-gradient(90deg, #60a5fa, #ef4444)' },
    air:     { label: 'Air Change',     min: '0 ACH', max: '10 ACH', gradient: 'linear-gradient(90deg, #22c55e, #ef4444)' },
  },
  geotech: {
    settlement: { label: 'Settlement', min: '0mm', max: '100mm', gradient: 'linear-gradient(90deg, #22c55e, #eab308, #ef4444)' },
    fos:         { label: 'Factor of Safety', min: '<1.5', max: '>2.0', gradient: 'linear-gradient(90deg, #ef4444, #eab308, #22c55e)' },
    lateral:     { label: 'Lateral Defl', min: '0mm', max: 'limit', gradient: 'linear-gradient(90deg, #60a5fa, #ef4444)' },
  },
};

const SORT_OPTIONS = {
  energy: [
    { key: 'peak',       label: 'Peak Load ↓' },
    { key: 'month',      label: 'Month ↓' },
    { key: 'dayOfWeek',  label: 'Day of Week ↓' },
    { key: 'orientation',label: 'Orientation ↓' },
  ],
  fire: [
    { key: 'critical',  label: 'Most Critical ↓' },
    { key: 'floor',      label: 'Floor ↓' },
    { key: 'compartment',label: 'Compartment ↓' },
    { key: 'activation', label: 'Time to Activation ↓' },
  ],
  structural: [
    { key: 'dc',         label: 'D/C Ratio ↓' },
    { key: 'story',      label: 'Story ↓' },
    { key: 'elementType',label: 'Element Type ↓' },
    { key: 'loadCase',   label: 'Load Case ↓' },
  ],
  mip: [
    { key: 'demand',     label: 'Peak Demand ↓' },
    { key: 'system',     label: 'System ↓' },
    { key: 'zone',       label: 'Zone ↓' },
    { key: 'efficiency', label: 'Efficiency ↓' },
  ],
  geotech: [
    { key: 'fos',        label: 'FoS ↓' },
    { key: 'settlement', label: 'Settlement ↓' },
    { key: 'depth',      label: 'Depth ↓' },
  ],
};

const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0];

// ─── Color Utilities ─────────────────────────────────────────────────────────
function tempToColor(tempC) {
  const t = Math.max(0, Math.min(1, (tempC + 10) / 45));
  if (t < 0.4) {
    return new THREE.Color(0, Math.round(100 + 100 * (t / 0.4)), 255);
  } else if (t < 0.7) {
    const r = Math.round(250 * ((t - 0.4) / 0.3));
    const g = Math.round(200 + 30 * ((t - 0.4) / 0.3));
    return new THREE.Color(r, g, 0);
  } else {
    return new THREE.Color(255, Math.round(230 - 180 * ((t - 0.7) / 0.3)), 0);
  }
}

function loadToColor(heatingKW, coolingKW, maxKW) {
  const total = heatingKW + coolingKW;
  const ratio = Math.min(1, total / Math.max(maxKW, 1));
  if (coolingKW > heatingKW) {
    return new THREE.Color(0, Math.round(80 * (1 - ratio)), Math.round(100 + 155 * ratio));
  } else {
    return new THREE.Color(Math.round(100 + 155 * ratio), Math.round(80 * (1 - ratio)), 0);
  }
}

function solarToColor(solarKW, maxKW) {
  const ratio = Math.min(1, solarKW / Math.max(maxKW, 0.1));
  return new THREE.Color(Math.round(250 * ratio), Math.round(200 * ratio), 0);
}

// ─── Persistence ─────────────────────────────────────────────────────────────
function savePrefs() {
  if (!simType) return;
  localStorage.setItem(`stvp_${simType}_mode`, activeMode || '');
  localStorage.setItem(`stvp_${simType}_sort`, activeSort || '');
  localStorage.setItem(`stvp_${simType}_speed`, String(playbackSpeed));
}

function loadPrefs() {
  if (!simType) return '';
  return {
    mode: localStorage.getItem(`stvp_${simType}_mode`) || '',
    sort: localStorage.getItem(`stvp_${simType}_sort`) || '',
    speed: parseFloat(localStorage.getItem(`stvp_${simType}_speed`) || '1'),
  };
}

// ─── Three.js Mini Renderer ─────────────────────────────────────────────────
function initMiniRenderer(canvasId) {
  const canvas = document.getElementById(canvasId);
  // Reuse existing renderer if already bound to the same canvas — prevents WebGL context leak
  if (!canvas || (miniRenderer && miniRenderer.domElement === canvas)) return;

  miniScene = new THREE.Scene();
  miniScene.background = new THREE.Color(0x0d0d0f);

  miniCamera = new THREE.PerspectiveCamera(45, canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1, 500);
  miniCamera.position.set(12, 8, 12);
  miniCamera.lookAt(5, 2, 5);

  miniRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  miniRenderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  miniRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const grid = new THREE.GridHelper(20, 20, 0x222222, 0x1a1a1a);
  grid.material.opacity = 0.4;
  grid.material.transparent = true;
  miniScene.add(grid);

  animateMiniRenderer();
}

function animateMiniRenderer() {
  if (!miniRenderer || !miniScene || !miniCamera) return;
  animFrameId = requestAnimationFrame(animateMiniRenderer);
  miniRenderer.render(miniScene, miniCamera);
}

function buildMiniWalls(globalState) {
  if (!miniScene) return;
  wallMeshesMini.forEach(m => miniScene.remove(m));
  wallMeshesMini = [];

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7, side: THREE.DoubleSide });
  if (!globalState?.elements) return;

  for (const el of globalState.elements) {
    if (el.type !== 'wall') continue;
    const params = safeParse(el.parameters);
    const computed = safeParse(el.computed);

    const sx = parseFloat(params.startCoord?.x || 0);
    const sy = parseFloat(params.startCoord?.y || 0);
    const ex = parseFloat(params.endCoord?.x || sx + 5);
    const ey = parseFloat(params.endCoord?.y || sy);
    const baseElev = parseFloat(el.base_level_elevation || 0);
    const height = parseFloat(computed.height || params.height || 3);
    const thickness = parseFloat(computed.thickness || params.thickness || 0.2);

    const dx = ex - sx, dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy) || 5;
    const angle = Math.atan2(dy, dx);
    const cx = (sx + ex) / 2;
    const cz = (sy + ey) / 2;

    const geo = new THREE.BoxGeometry(len, height, thickness);
    const mat = wallMat.clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, baseElev + height / 2, cz);
    mesh.rotation.y = -angle;
    mesh.userData = { elementId: el.id, originalColor: new THREE.Color(0x334155) };
    miniScene.add(mesh);
    wallMeshesMini.push(mesh);

    if (globalState.levels) {
      for (const level of globalState.levels) {
        const lg = new THREE.PlaneGeometry(30, 30);
        const lm = new THREE.MeshBasicMaterial({ color: 0x3a3a3a, side: THREE.DoubleSide, transparent: true, opacity: 0.15 });
        const lp = new THREE.Mesh(lg, lm);
        lp.rotation.x = -Math.PI / 2;
        lp.position.y = parseFloat(level.elevation || 0);
        miniScene.add(lp);
      }
    }
  }
}

function applyHeatmap(entry) {
  if (!results || !results.hourly) return;
  const maxKW = Math.max(...results.hourly.map(h => h.heatingKWh + h.coolingKWh), 1);
  const maxSolar = Math.max(...results.hourly.map(h => h.solarGainKW), 0.1);

  for (const mesh of wallMeshesMini) {
    if (!mesh.material) continue;
    let color;
    if (activeMode === 'temp') {
      const baseTemp = entry?.outdoorTemp || 20;
      const indoor = Math.max(18, Math.min(30, baseTemp + 2 + ((entry?.heatingKWh || 0) > (entry?.coolingKWh || 0) ? 1.5 : 0)));
      color = tempToColor(indoor);
    } else if (activeMode === 'load') {
      color = loadToColor(entry?.heatingKWh || 0, entry?.coolingKWh || 0, maxKW);
    } else {
      color = solarToColor(entry?.solarGainKW || 0, maxSolar);
    }
    const orig = mesh.userData.originalColor || new THREE.Color(0x334155);
    mesh.material.color.lerpColors(color, orig, 0.4);
    mesh.material.needsUpdate = true;
  }
}

function safeParse(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

// ─── Time Display ─────────────────────────────────────────────────────────────
function getTimeLabel(timeIndex) {
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (simType === 'fire') {
    const mins = Math.floor(timeIndex / 60);
    const secs = timeIndex % 60;
    return `t = ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  if (simType === 'structural') {
    return `Mode ${timeIndex + 1}  |  T = ${((timeIndex + 1) * 0.1).toFixed(2)}s`;
  }
  if (!results?.hourly?.[timeIndex]) return `Hour ${timeIndex} of 8760`;
  const e = results.hourly[timeIndex];
  const h = e.hour;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `Hour ${timeIndex}, 8,760  |  ${monthNames[e.month]} ${e.day}, ${h12}:00 ${ampm}`;
}

// ─── Render: Legend ──────────────────────────────────────────────────────────
function renderLegend() {
  const container = document.getElementById('stvp-legend');
  if (!container) return;
  const cfg = LEGEND_CONFIG[simType]?.[activeMode] || { label: activeMode, min: '', max: '', gradient: 'linear-gradient(90deg,#333,#fff)' };

  container.innerHTML = `
    <div class="stvp-legend-label">${cfg.label}</div>
    <div class="stvp-legend-bar" style="background:${cfg.gradient}"></div>
    <div class="stvp-legend-range"><span>${cfg.min}</span><span>${cfg.max}</span></div>
  `;

  // Current value triangle
  const indicator = document.getElementById('stvp-legend-indicator');
  if (indicator && results?.hourly?.[currentTimeIndex]) {
    const entry = results.hourly[currentTimeIndex];
    let pct = 0.5;
    if (activeMode === 'temp') pct = Math.max(0, Math.min(1, (tempValue(entry) + 10) / 45));
    if (activeMode === 'load') pct = Math.min(1, (entry.heatingKWh + entry.coolingKWh) / Math.max(maxKW(), 1));
    indicator.style.left = `calc(${pct * 100}% - 5px)`;
  }
}

function tempValue(entry) {
  return Math.max(18, Math.min(30, (entry?.outdoorTemp || 20) + 2));
}

function maxKW() {
  return results?.hourly ? Math.max(...results.hourly.map(h => h.heatingKWh + h.coolingKWh), 1) : 100;
}

// ─── Render: Timeline Controls ───────────────────────────────────────────────
function renderTimeline() {
  const slider = document.getElementById('stvp-slider');
  const timeLabel = document.getElementById('stvp-time-label');
  const recDot = document.getElementById('stvp-rec-dot');
  const recText = document.getElementById('stvp-rec-text');

  if (slider) {
    const max = simType === 'fire' ? 600 : simType === 'structural' ? 20 : 8759;
    slider.min = 0;
    slider.max = max;
    slider.value = currentTimeIndex;

    const fillPct = max > 0 ? (currentTimeIndex / max) * 100 : 0;
    slider.style.background = `linear-gradient(to right, #3b82f6 ${fillPct}%, #27272a ${fillPct}%)`;
  }

  if (timeLabel) timeLabel.textContent = getTimeLabel(currentTimeIndex);

  const isRec = recordingState === 'recording';
  if (recDot) recDot.style.opacity = isRec ? '1' : '0';
  if (recText) recText.style.display = isRec ? 'inline' : 'none';

  const playBtn = document.getElementById('stvp-play-btn');
  if (playBtn) playBtn.textContent = isPlaying ? '⏸' : '▶';
}

// ─── Render: Mode Pills ──────────────────────────────────────────────────────
function renderModePills() {
  const container = document.getElementById('stvp-mode-pills');
  if (!container) return;

  const modes = results?.modes || getDefaultModes();
  container.innerHTML = modes.map(m => `
    <button class="stvp-mode-pill ${m === activeMode ? 'active' : ''}" data-mode="${m}">${m}</button>
  `).join('');
}

function getDefaultModes() {
  if (simType === 'energy') return ['temp', 'load', 'solar'];
  if (simType === 'fire')   return ['smoke', 'temp', 'pressure', 'egress'];
  if (simType === 'structural') return ['dc', 'defl', 'drift'];
  if (simType === 'mip')    return ['flow', 'pressure', 'air'];
  if (simType === 'geotech') return ['settlement', 'fos', 'lateral'];
  return [];
}

// ─── Render: Sort Bar ────────────────────────────────────────────────────────
function renderSortBar() {
  const container = document.getElementById('stvp-sort-bar');
  if (!container) return;
  const options = SORT_OPTIONS[simType] || [];
  container.innerHTML = options.map(o => `
    <button class="stvp-sort-pill ${o.key === activeSort ? 'active' : ''}" data-sort="${o.key}">${o.label}</button>
  `).join('');
}

// ─── Render: Speed Pills ────────────────────────────────────────────────────
function renderSpeedPills() {
  const container = document.getElementById('stvp-speed-pills');
  if (!container) return;
  container.innerHTML = SPEEDS.map(s => `
    <button class="stvp-speed-pill ${s === playbackSpeed ? 'active' : ''}" data-speed="${s}">${s}×</button>
  `).join('');
}

// ─── Playback State Machine ───────────────────────────────────────────────────
function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;
  renderTimeline();

  const intervalMs = simType === 'fire' ? 1000 : simType === 'structural' ? 500 : 80;
  playbackInterval = setInterval(() => {
    const max = simType === 'fire' ? 600 : simType === 'structural' ? 20 : 8759;
    const next = (currentTimeIndex + 1) % (max + 1);
    updateTimeIndex(next);
    if (next === 0) stopPlayback();
  }, intervalMs / playbackSpeed);
}

function stopPlayback() {
  isPlaying = false;
  if (playbackInterval) clearInterval(playbackInterval);
  playbackInterval = null;
  renderTimeline();
}

function resetPlayback() {
  stopPlayback();
  updateTimeIndex(0);
}

function stepBackward() {
  stopPlayback();
  const max = simType === 'fire' ? 600 : simType === 'structural' ? 20 : 8759;
  updateTimeIndex(Math.max(0, currentTimeIndex - 1));
}

function stepForward() {
  stopPlayback();
  const max = simType === 'fire' ? 600 : simType === 'structural' ? 20 : 8759;
  updateTimeIndex(Math.min(max, currentTimeIndex + 1));
}

function updateTimeIndex(idx) {
  currentTimeIndex = idx;
  renderTimeline();

  if (results?.hourly?.[idx]) {
    applyHeatmap(results.hourly[idx]);
    renderLegend();
  }
}

// ─── Download / Export ───────────────────────────────────────────────────────
async function exportCSV() {
  if (!results) return;
  const rows = [['timestamp', 'value']];

  if (results.hourly) {
    results.hourly.forEach((h, i) => {
      rows.push([i, JSON.stringify(h)]);
    });
  }

  const csv = rows.map(r => r.join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `${simType}-timeline.csv`);
}

async function exportMP4(canvasId, durationHours = 168) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !miniRenderer) return;

  recordingState = 'recording';
  renderTimeline();

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
  const stream = canvas.captureStream(20);
  mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000 });
  recordedChunks = [];

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    downloadBlob(blob, `${simType}-timeline.webm`);
    recordingState = null;
    renderTimeline();
  };

  mediaRecorder.start();

  const startHour = currentTimeIndex;
  const endHour = Math.min(startHour + durationHours, 8759);
  let h = startHour;

  const recordFrame = () => {
    updateTimeIndex(h);
    if (miniRenderer && miniScene && miniCamera) miniRenderer.render(miniScene, miniCamera);
    h++;
    if (h < endHour && recordingState === 'recording') {
      setTimeout(recordFrame, 50);
    } else {
      setTimeout(() => mediaRecorder?.stop(), 500);
    }
  };
  recordFrame();
}

async function exportGIF(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !miniRenderer) return;
  if (typeof GIF === 'undefined') {
    toast('GIF export requires GIF.js library', 'error');
    return;
  }

  recordingState = 'recording';
  renderTimeline();

  const frames = [];
  const totalHours = 8760;
  const step = Math.floor(totalHours / 48);

  for (let i = 0; i < 48; i++) {
    const hIdx = i * step;
    updateTimeIndex(hIdx);
    if (miniRenderer && miniScene && miniCamera) miniRenderer.render(miniScene, miniCamera);
    await new Promise(r => setTimeout(r, 150));
    frames.push(canvas.toDataURL('image/png'));
    document.getElementById('stvp-export-status').textContent = `Capturing ${i + 1}/48…`;
  }

  // Encode GIF
  const gif = new GIF({ workers: 2, quality: 10, width: canvas.width || 400, height: canvas.height || 300 });
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = canvas.width || 400;
  tmpCanvas.height = canvas.height || 300;
  const ctx = tmpCanvas.getContext('2d');

  for (const src of frames) {
    const img = new Image();
    await new Promise(res => { img.onload = res; img.src = src; });
    ctx.drawImage(img, 0, 0);
    gif.addFrame(ctx, { copy: true, delay: 150 });
  }

  gif.on('finished', blob => {
    downloadBlob(blob, `${simType}-timeline.gif`);
    recordingState = null;
    document.getElementById('stvp-export-status').textContent = '';
    renderTimeline();
  });
  gif.render();
}

async function exportPDF() {
  toast('PDF export coming soon', 'info');
  recordingState = null;
  renderTimeline();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function toast(msg, type = 'info', duration = 2500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ─── Settings Dropdown ───────────────────────────────────────────────────────
function toggleSettings() {
  const menu = document.getElementById('stvp-settings-menu');
  if (!menu) return;
  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
}

function closeSettings() {
  const menu = document.getElementById('stvp-settings-menu');
  if (menu) menu.style.display = 'none';
}

// ─── Sorting ─────────────────────────────────────────────────────────────────
function applySort(sortKey) {
  activeSort = sortKey;
  savePrefs();
  renderSortBar();
}

function getSortedData() {
  if (!results) return [];
  if (simType === 'energy' && results.hourly) {
    if (activeSort === 'peak') {
      return [...results.hourly].sort((a, b) => (b.heatingKWh + b.coolingKWh) - (a.heatingKWh + a.coolingKWh));
    }
    if (activeSort === 'month') {
      return [...results.hourly].sort((a, b) => a.month - b.month || a.day - b.day);
    }
  }
  return results.hourly || [];
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────
function wireEvents() {
  document.getElementById('stvp-play-btn')?.addEventListener('click', () => {
    if (isPlaying) stopPlayback(); else startPlayback();
  });
  document.getElementById('stvp-step-back')?.addEventListener('click', stepBackward);
  document.getElementById('stvp-step-forward')?.addEventListener('click', stepForward);
  document.getElementById('stvp-reset-btn')?.addEventListener('click', resetPlayback);
  document.getElementById('stvp-slider')?.addEventListener('input', e => {
    stopPlayback();
    updateTimeIndex(parseInt(e.target.value));
  });
  document.getElementById('stvp-settings-btn')?.addEventListener('click', toggleSettings);

  // Mode pills
  document.getElementById('stvp-mode-pills')?.addEventListener('click', e => {
    if (e.target.classList.contains('stvp-mode-pill')) {
      activeMode = e.target.dataset.mode;
      savePrefs();
      renderModePills();
      renderLegend();
      applyHeatmap(results?.hourly?.[currentTimeIndex]);
    }
  });

  // Sort pills
  document.getElementById('stvp-sort-bar')?.addEventListener('click', e => {
    if (e.target.classList.contains('stvp-sort-pill')) {
      applySort(e.target.dataset.sort);
    }
  });

  // Speed pills
  document.getElementById('stvp-speed-pills')?.addEventListener('click', e => {
    if (e.target.classList.contains('stvp-speed-pill')) {
      playbackSpeed = parseFloat(e.target.dataset.speed);
      savePrefs();
      renderSpeedPills();
    }
  });

  // Settings menu items
  document.querySelectorAll('[data-export]').forEach(el => {
    el?.addEventListener('click', e => {
      e.stopPropagation();
      closeSettings();
      const fmt = el.dataset.export;
      if (fmt === 'mp4') exportMP4('stvp-canvas');
      else if (fmt === 'gif') exportGIF('stvp-canvas');
      else if (fmt === 'csv') exportCSV();
      else if (fmt === 'pdf') exportPDF();
    });
  });

  // Spacebar play/pause
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      if (isPlaying) stopPlayback(); else startPlayback();
    }
    if (e.code === 'ArrowLeft') { stopPlayback(); stepBackward(); }
    if (e.code === 'ArrowRight') { stopPlayback(); stepForward(); }
    if (e.code === 'Escape') closeSettings();
  });

  // Close settings on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#stvp-settings-btn') && !e.target.closest('#stvp-settings-menu')) {
      closeSettings();
    }
  });
}

// ─── Main Init ───────────────────────────────────────────────────────────────
export function initSimulationTimeline(type, data, canvasId, globalState) {
  simType = type;
  results = data;

  const prefs = loadPrefs();
  activeMode = prefs.mode || getDefaultModes()[0] || 'temp';
  activeSort = prefs.sort || SORT_OPTIONS[type]?.[0]?.key || '';
  playbackSpeed = prefs.speed || 1.0;

  // Build mini Three.js scene
  if (canvasId) {
    initMiniRenderer(canvasId);
    buildMiniWalls(globalState);
    applyHeatmap(results?.hourly?.[0]);
  }

  renderModePills();
  renderSpeedPills();
  renderSortBar();
  renderLegend();
  renderTimeline();
  wireEvents();
}

// ─── Expose for external use ─────────────────────────────────────────────────
export function setResults(data) { results = data; }
export function setActiveMode(mode) {
  activeMode = mode;
  savePrefs();
  renderModePills();
  renderLegend();
}
export function getCurrentTimeIndex() { return currentTimeIndex; }
export function destroyTimeline() {
  stopPlayback();
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (miniRenderer) {
    try { miniRenderer.dispose(); } catch (_) {}
    try { miniRenderer.forceContextLoss(); } catch (_) {}
    miniRenderer = null;
  }
  miniScene = null;
  miniCamera = null;
  wallMeshesMini = [];
}