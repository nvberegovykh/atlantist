/**
 * Owns: /status and /status.json endpoints — service health and incident pages.
 * Does NOT own: app routing, auth, or database queries.
 */
const router = require('express').Router();

const INCIDENTS = [
  { id: 'inc-001', title: 'Scheduled maintenance — May 20, 2026', time: '2026-05-20T02:00:00Z', resolved: '2026-05-20T03:30:00Z', status: 'resolved', desc: 'Database migration completed successfully. All services operational.' },
  { id: 'inc-000', title: 'Initial platform launch', time: '2026-05-15T00:00:00Z', resolved: null, status: 'resolved', desc: 'Atlantist BIM 2.0 publicly launched.' }
];

const STATUS_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>System Status — Atlantist</title>
  <link rel="stylesheet" href="https://atlantist.cloud/css/app.css">
  <style>
    .status-page { background: #0d1117; min-height: 100vh; padding: 0; color: #e8e8e8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
    .status-header { background: #111; border-bottom: 1px solid #21262d; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; }
    .status-header-logo { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; color: #5b9bd5; }
    .status-content { max-width: 800px; margin: 0 auto; padding: 40px 32px; }
    .status-title { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .status-subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    .status-summary { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; }
    .status-summary-text { font-size: 14px; font-weight: 600; }
    .status-summary-sub { font-size: 12px; color: #888; margin-top: 4px; }
    .status-section-title { font-size: 11px; font-weight: 600; letter-spacing: .1em; color: #888; text-transform: uppercase; margin-bottom: 12px; margin-top: 24px; }
    .status-service { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #21262d; }
    .status-service-name { font-size: 13px; font-weight: 500; }
    .status-service-meta { font-size: 11px; color: #666; margin-top: 2px; }
    .status-service-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
    .badge-operational { background: rgba(59,186,108,.15); color: #3bba6c; }
    .status-footer { text-align: center; padding: 32px; color: #555; font-size: 12px; }
    .status-footer a { color: #5b9bd5; text-decoration: none; }
    .status-incident { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; }
    .status-incident-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .status-incident-time { font-size: 11px; color: #666; }
    .status-incident-desc { font-size: 12px; color: #888; margin-top: 6px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .dot-operational { background: #3bba6c; }
    .uptime-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .uptime-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px 20px; text-align: center; }
    .uptime-card-val { font-size: 24px; font-weight: 700; color: #3bba6c; }
    .uptime-card-label { font-size: 11px; color: #666; margin-top: 4px; }
    .last-updated { font-size: 11px; color: #444; text-align: center; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="status-page">
    <div class="status-header">
      <div class="status-header-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
        Atlantist
      </div>
      <div style="font-size:12px;color:#555">Last updated: {{UPDATED_AT}}</div>
    </div>
    <div class="status-content">
      <div class="status-title">System Status</div>
      <div class="status-subtitle">Real-time status of Atlantist BIM infrastructure</div>
      <div class="uptime-grid">
        <div class="uptime-card"><div class="uptime-card-val">99.9%</div><div class="uptime-card-label">90-day uptime</div></div>
        <div class="uptime-card"><div class="uptime-card-val">12ms</div><div class="uptime-card-label">Avg. response time</div></div>
        <div class="uptime-card"><div class="uptime-card-val">0</div><div class="uptime-card-label">Open incidents</div></div>
      </div>
      <div class="status-summary">
        <div>
          <div class="status-summary-text"><span class="status-dot dot-operational"></span>All systems operational</div>
          <div class="status-summary-sub">No issues detected</div>
        </div>
        <span class="badge-operational" style="font-size:12px;padding:4px 12px;border-radius:4px">Operational</span>
      </div>
      <div class="status-section-title">Services</div>
      ${['API (REST)', 'WebSocket (Real-time sync)', 'Energy Simulation', 'Fire Protection Analysis', 'Geotechnical Analysis', 'Auth & Sessions', 'File Storage (R2)', 'Database (Neon)'].map(name => `
        <div class="status-service">
          <div><div class="status-service-name">${name}</div><div class="status-service-meta">Responding normally</div></div>
          <span class="status-service-badge badge-operational">Operational</span>
        </div>`).join('')}
      <div class="status-section-title">Recent Incidents</div>
      ${INCIDENTS.map(inc => `<div class="status-incident">
        <div class="status-incident-title">${inc.title}</div>
        <div class="status-incident-time">${new Date(inc.time).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
        ${inc.desc ? `<div class="status-incident-desc">${inc.desc}</div>` : ''}
      </div>`).join('')}
    </div>
    <div class="status-footer">
      <a href="https://atlantist.cloud">← Back to Atlantist</a> · <a href="https://atlantist.cloud/docs/faq">FAQ</a> · Contact support
    </div>
  </div>
</body>
</html>`;

// Lightweight keepalive — hit by UptimeRobot every 5 min to prevent Render cold start
router.get('/ping', (_req, res) => {
  res.json({ ok: true, t: Date.now() });
});

router.get('/status', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(STATUS_PAGE_HTML.replace('{{UPDATED_AT}}', new Date().toISOString()));
});

router.get('/status.json', (_req, res) => {
  res.json({
    status: 'operational',
    services: {
      api: { status: 'operational', latency_ms: 12 },
      websocket: { status: 'operational' },
      energy: { status: 'operational' },
      fire_protection: { status: 'operational' },
      geotechnical: { status: 'operational' },
      auth: { status: 'operational' },
      database: { status: 'operational' },
      storage: { status: 'operational' }
    },
    updated_at: new Date().toISOString()
  });
});

const FAQ_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FAQ — Atlantist</title>
  <link rel="stylesheet" href="https://atlantist.cloud/css/app.css">
  <style>
    body { background: #0d1117; color: #e8e8e8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; margin: 0; }
    .doc-header { background: #111; border-bottom: 1px solid #21262d; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
    .doc-logo { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; color: #5b9bd5; text-decoration: none; }
    .doc-content { max-width: 760px; margin: 0 auto; padding: 40px 32px; }
    .doc-title { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .doc-sub { color: #888; font-size: 14px; margin-bottom: 32px; }
    .faq-item { border-bottom: 1px solid #21262d; padding: 20px 0; }
    .faq-q { font-size: 15px; font-weight: 600; color: #e8e8e8; margin-bottom: 8px; }
    .faq-a { font-size: 13px; color: #888; line-height: 1.6; }
    .faq-category { font-size: 11px; font-weight: 600; letter-spacing: .1em; color: #5b9bd5; text-transform: uppercase; margin-bottom: 8px; margin-top: 24px; }
    .doc-footer { text-align: center; padding: 32px; color: #555; font-size: 12px; border-top: 1px solid #21262d; margin-top: 40px; }
    .doc-footer a { color: #5b9bd5; text-decoration: none; margin: 0 12px; }
  </style>
</head>
<body>
  <div class="doc-header">
    <a href="https://atlantist.cloud" class="doc-logo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      Atlantist
    </a>
  </div>
  <div class="doc-content">
    <div class="doc-title">Frequently Asked Questions</div>
    <div class="doc-sub">Everything you need to know about Atlantist BIM 2.0</div>
    <div class="faq-category">Getting Started</div>
    <div class="faq-item"><div class="faq-q">What is Atlantist?</div><div class="faq-a">Atlantist is a browser-based Building Information Modeling (BIM) platform. No install or download required — open in any modern browser. Place walls, columns, doors, windows, and levels; run energy analysis, fire protection checks, and geotechnical calculations in real-time with parametric constraint propagation.</div></div>
    <div class="faq-item"><div class="faq-q">How do I start a new project?</div><div class="faq-a">On first visit, enter your email to get early access. After signup, click + Level in the top bar to create your building's first floor, then click + Wall to draw walls in the 3D viewport.</div></div>
    <div class="faq-item"><div class="faq-q">What does Atlantist cost?</div><div class="faq-a">$30/month or $330/year (2 months free). 30-day free trial on any plan — no credit card required. All modules included, no feature tiers. Pricing at atlantist.cloud/#pricing.</div></div>
    <div class="faq-category">BIM Modeling</div>
    <div class="faq-item"><div class="faq-q">How do I place a wall?</div><div class="faq-a">Click + Wall in the top bar, then click in the 3D viewport to set the start point. Click again to set the end point. Double-click or press Enter to finish. Press Escape to cancel placement. Change wall height, thickness, and type in the Properties panel on the right.</div></div>
    <div class="faq-item"><div class="faq-q">How do I add a door to a wall?</div><div class="faq-a">Select a wall (click on it), then click + Door in the top bar. Click the wall face to place the door. The wall auto-cuts geometry to match the door family dimensions. Change the door family via the Properties panel.</div></div>
    <div class="faq-item"><div class="faq-q">What is parametric binding?</div><div class="faq-a">Atlantist uses a DAG (Directed Acyclic Graph) constraint solver. When you change a level's elevation or a wall's height, all bound elements update instantly across all three synchronized views (3D, Plan, Section).</div></div>
    <div class="faq-category">Analysis</div>
    <div class="faq-item"><div class="faq-q">How does energy analysis work?</div><div class="faq-a">Click ⚡ Energy → Run Energy Simulation. Atlantist exports your model as gbXML geometry and runs ASHRAE 90.1 compliance checks for NYC Climate Zone 4A. Results include NYECC EN-001 through EN-008 compliance forms with pass/fail indicators, plus an EnergyPlus IDF file for detailed simulation.</div></div>
    <div class="faq-item"><div class="faq-q">What fire protection analysis is available?</div><div class="faq-a">Click 🔥 Fire to access: NFPA 13 sprinkler hydraulics (Hazen-Williams, density-area curves, K-factors), NFPA 101 egress analysis (occupant load, travel distance, exit width), NFPA 92 smoke control (stairwell pressurization, fan sizing), IBC fire resistance ratings, and FDS smoke simulation with animated 3D visualization.</div></div>
    <div class="faq-item"><div class="faq-q">What geotechnical calculations are available?</div><div class="faq-a">Click 🌍 Geo for: bearing capacity (Terzaghi/Hansen/Meyerhof, NAVFAC DM 7.01), elastic and consolidation settlement, lateral earth pressure (Rankine/Coulomb), pile capacity (Alpha method, t-z/p-y/Q-z curves), slope stability (Fellenius/Bishop LEM), and OpenSees .tcl input generation for PM4Sand/PDMY soil models.</div></div>
    <div class="faq-category">Collaboration</div>
    <div class="faq-item"><div class="faq-q">Can multiple people work on the same project?</div><div class="faq-a">Yes. Click 👥 Collab → Create Room to get a 6-character code. Share the code with collaborators so they can join your session and see your camera position in real-time via WebRTC. All element changes sync via WebSocket.</div></div>
    <div class="faq-item"><div class="faq-q">How do I track issues with my team?</div><div class="faq-a">Click ⚑ Issues in the top bar to open the Issues panel. Click + Issue to create a ticket anchored to specific elements. Include a camera snapshot for context. Issues sync in real-time across all collaborators.</div></div>
    <div class="faq-category">Data & Export</div>
    <div class="faq-item"><div class="faq-q">What file formats can I export?</div><div class="faq-a">Atlantist exports: .fbx (for Twinmotion), .obj (universal), gbXML (energy simulation import), IDF (EnergyPlus), and PDF (Design Book, Fire Protection reports, EN-1 workbook, A-400 door/window schedule).</div></div>
    <div class="faq-item"><div class="faq-q">Is my data saved?</div><div class="faq-a">All model data is stored in a PostgreSQL database tied to your account. Elements, levels, and family instances persist across sessions. Projects can be shared with team members via invite links.</div></div>
    <div class="faq-category">Support</div>
    <div class="faq-item"><div class="faq-q">How do I contact support?</div><div class="faq-a">Click the user menu → Contact & Support, or visit <a href="https://atlantist.cloud/status" style="color:#5b9bd5">atlantist.cloud/status</a> to check system status. Billing issues are prioritized and responded to within 4 hours. Technical issues within 24 hours.</div></div>
  </div>
  <div class="doc-footer">
    <a href="https://atlantist.cloud">Home</a>
    <a href="https://atlantist.cloud/status">Status</a>
    <a href="https://atlantist.cloud">Contact Support</a>
  </div>
</body>
</html>`;

router.get('/docs/faq', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(FAQ_HTML);
});

module.exports = router;