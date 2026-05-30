/**
 * Owns: /demo interactive features — guided 5-stage tour, booking CTA modal, live multiplayer presence, mobile camera presets.
 * Does NOT own: Three.js BIM engine, WebSocket server, auth.
 */

// ─── Scroll-reveal ────────────────────────────────────────────────────────────
const revealObs = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
      revealObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });
document.querySelectorAll('.anim-up').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(28px)';
  el.style.transition = 'opacity 0.7s cubic-bezier(0.16,1,0.3,1), transform 0.7s cubic-bezier(0.16,1,0.3,1)';
  revealObs.observe(el);
});

// ─── Analytics ────────────────────────────────────────────────────────────────
function trackEvent(name, props) {
  try {
    if (window.gtag) window.gtag('event', name, props || {});
    if (window.analytics) window.analytics.track(name, props || {});
  } catch (_) {}
}
document.querySelectorAll('a[href*="/app"]').forEach(el => {
  el?.addEventListener('click', () => trackEvent('demo_cta_click', { label: el.textContent.trim() }));
});
const _startTime = Date.now();
window.addEventListener('beforeunload', () => {
  trackEvent('demo_time_on_page', { seconds: Math.round((Date.now() - _startTime) / 1000) });
});

// ─── Tour Stage Data ──────────────────────────────────────────────────────────
// Each stage describes a cinematic camera moment in the model.
const TOUR_STAGES = [
  {
    label: 'Stage 1 of 5 — Walls',
    title: 'Real-time wall collaboration',
    body: 'Camera frames the main facade in 3D. Teammates\' cursors move in real-time. Change a wall type and watch the live presence indicators pulse — collaborators see the update instantly across their viewports.',
    highlight: '.disc-card:nth-child(1)',
    progress: 20,
    // Cinematic camera hint used to position ghost cursor & set scene tone
    cameraNote: 'Framing south facade, eye level. Ghost cursors: Sarah K. on Level 1, Mike R. on structural grid.',
    cursorX: '28%', cursorY: '52%',
    scrollTarget: '#disciplines',
    // Two ghost cursors visible in this stage
    ghostCursors: [
      { x: '22%', y: '48%', name: 'Sarah K.', color: '#7c3aed' },
      { x: '58%', y: '62%', name: 'Mike R.',  color: '#1d5fa6' },
    ],
  },
  {
    label: 'Stage 2 of 5 — Levels',
    title: 'Drag a floor, every element adjusts',
    body: 'Camera tilts up as levels reveal floor-by-floor. Drag Ground Floor elevation from +0 to +12ft — the DAG solver propagates through all 30 columns, 8 walls, and 9 window family instances simultaneously.',
    highlight: '.disc-card:nth-child(2)',
    progress: 40,
    cameraNote: 'Isometric tilt-up. Levels pop in at 0ft, 12ft, 24ft. Constraint solver animation fires on drag.',
    cursorX: '50%', cursorY: '38%',
    scrollTarget: '#disciplines',
    ghostCursors: [
      { x: '46%', y: '35%', name: 'Elena T.', color: '#b45309' },
    ],
  },
  {
    label: 'Stage 3 of 5 — MEP',
    title: 'Clash detection resolves in real-time',
    body: 'Camera moves inside the building. HVAC ducts and sprinkler mains route automatically between structural members. Clash detection highlights 2 conflicts — click to resolve with one adjustment.',
    highlight: '.disc-card:nth-child(3)',
    progress: 60,
    cameraNote: 'Interior camera, ceiling level. Duct runs visible. Two red clash spheres pulse at beam intersections.',
    cursorX: '34%', cursorY: '68%',
    scrollTarget: '#disciplines',
    ghostCursors: [
      { x: '30%', y: '65%', name: 'Dave L.', color: '#059669' },
      { x: '62%', y: '58%', name: 'Sarah K.', color: '#7c3aed' },
    ],
  },
  {
    label: 'Stage 4 of 5 — Energy',
    title: 'EnergyPlus heatmap in under 5 seconds',
    body: 'Switch to energy view. The facade heatmap overlays in warm-to-cool gradient: the east curtain wall hits 9.2 kW peak load. Baseline comparison shows 18% reduction with the low-E glazing spec.',
    highlight: '.energy-card:first-child',
    progress: 80,
    cameraNote: 'Energy heatmap view. Facade faces colored by heat flux. Baseline vs. proposed overlay toggle.',
    cursorX: '52%', cursorY: '72%',
    scrollTarget: '.energy-grid',
    ghostCursors: [],
  },
  {
    label: 'Stage 5 of 5 — DOB Filing',
    title: 'Model data pre-fills the DOB form',
    body: 'Switch to filing view. BIN, occupancy type, egress width, and sprinkler density pull from the model automatically. 6 of 12 items auto-pass on model save — the Submit to DOB button activates when the checklist hits 100%.',
    highlight: '.dob-card',
    progress: 100,
    cameraNote: 'DOB checklist panel. Progress bar animates to 70%. Submit button glows amber — pending 4 items.',
    cursorX: '42%', cursorY: '80%',
    scrollTarget: '.dob-progress',
    ghostCursors: [],
  },
];

// ─── Tour State ───────────────────────────────────────────────────────────────
let tourStep = 0;
let currentHighlight = null;
let _ghostEls = [];

function clearHighlight() {
  if (currentHighlight) {
    currentHighlight.classList.remove('tour-highlight');
    currentHighlight = null;
  }
}

function clearGhostCursors() {
  _ghostEls.forEach(el => el.remove());
  _ghostEls = [];
}

// Spawns secondary ghost cursors visible through the backdrop
function spawnTourGhostCursors(stage) {
  clearGhostCursors();
  const isMobile = window.innerWidth <= 640;
  if (isMobile) return; // mobile: no secondary cursors (too cramped)
  (stage.ghostCursors || []).forEach(({ x, y, name, color }) => {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:${x};top:${y};pointer-events:none;z-index:509;
      display:flex;align-items:flex-start;gap:5px;
      transition:left 1s cubic-bezier(0.34,1.56,0.64,1),top 1s cubic-bezier(0.34,1.56,0.64,1);`;
    el.innerHTML = `<svg width="16" height="16" viewBox="0 0 22 22" fill="none">
      <path d="M4 2L18 12L11 13L8 20L4 2Z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round" opacity="0.85"/>
    </svg><span style="background:${color};color:#fff;font-family:var(--sans,sans-serif);font-size:10px;font-weight:600;
      padding:2px 7px;border-radius:4px;white-space:nowrap;opacity:0.9;">${name}</span>`;
    document.body.appendChild(el);
    _ghostEls.push(el);
    // Drift subtly
    let drift = setInterval(() => {
      if (!_ghostEls.includes(el)) { clearInterval(drift); return; }
      const cx = parseFloat(el.style.left);
      const cy = parseFloat(el.style.top);
      const nx = Math.max(5, Math.min(90, cx + (Math.random() * 4 - 2)));
      const ny = Math.max(10, Math.min(80, cy + (Math.random() * 3 - 1.5)));
      el.style.left = nx + '%';
      el.style.top = ny + '%';
    }, 2000);
  });
}

// Syncs the 5 dot indicators
function updateDots(idx) {
  document.querySelectorAll('.tour-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === idx);
  });
}

// Animates the card out → updates content → animates card in
function setTourStep(idx, direction) {
  const stage = TOUR_STAGES[idx];
  if (!stage) return;
  const caption = document.getElementById('tour-caption');
  if (!caption) return;

  // Cinematic card transition (opacity + translateY)
  caption.classList.add('transitioning');

  setTimeout(() => {
    // Update text content
    const lbl = document.getElementById('tour-stage-label'); if (lbl) lbl.textContent = stage.label;
    const ttl = document.getElementById('tour-title');       if (ttl) ttl.textContent = stage.title;
    const bdy = document.getElementById('tour-body');        if (bdy) bdy.textContent = stage.body;
    const fill = document.getElementById('tour-progress-fill'); if (fill) fill.style.width = stage.progress + '%';
    const cnt = document.getElementById('tour-step-counter'); if (cnt) cnt.textContent = (idx + 1) + ' / ' + TOUR_STAGES.length;
    const nxBtn = document.getElementById('tour-next');      if (nxBtn) nxBtn.textContent = idx < TOUR_STAGES.length - 1 ? 'Next →' : 'Finish ✓';
    const prBtn = document.getElementById('tour-prev');      if (prBtn) prBtn.disabled = idx === 0;

    // Update ghost cursor
    const cursor = document.getElementById('ghost-cursor');
    if (cursor) { cursor.style.left = stage.cursorX; cursor.style.top = stage.cursorY; }

    // Highlight target element
    clearHighlight();
    const el = document.querySelector(stage.highlight);
    if (el) {
      el.classList.add('tour-highlight');
      currentHighlight = el;
      // Smooth scroll to the highlighted element
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (stage.scrollTarget) {
      // Fallback scroll target
      const target = document.querySelector(stage.scrollTarget);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Secondary ghost cursors
    spawnTourGhostCursors(stage);

    // Sync dots
    updateDots(idx);

    tourStep = idx;

    // Fade card back in
    caption.classList.remove('transitioning');
  }, 220); // Matches the CSS transition duration
}

// ─── Tour Lifecycle ───────────────────────────────────────────────────────────
function startTour() {
  trackEvent('tour_started');
  document.getElementById('tour-overlay')?.classList.add('active');
  document.getElementById('ghost-cursor')?.setAttribute('style', 'display:block');
  document.getElementById('btn-replay-tour')?.classList.remove('visible');
  // Scroll to disciplines before showing step 0
  const disc = document.getElementById('disciplines');
  if (disc) disc.scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => setTourStep(0), 700);
}

function endTour() {
  trackEvent('tour_completed', { steps_seen: tourStep + 1 });
  clearHighlight();
  clearGhostCursors();
  document.getElementById('tour-overlay')?.classList.remove('active');
  document.getElementById('ghost-cursor')?.setAttribute('style', 'display:none');
  document.getElementById('btn-replay-tour')?.classList.add('visible');
  localStorage.setItem('atlantist_tour_seen', '1');
  // Show the booking CTA modal
  showBookingModal();
}

function skipToEnd() {
  trackEvent('tour_skip_to_end', { from_step: tourStep + 1 });
  clearHighlight();
  clearGhostCursors();
  document.getElementById('tour-overlay')?.classList.remove('active');
  document.getElementById('ghost-cursor')?.setAttribute('style', 'display:none');
  document.getElementById('btn-replay-tour')?.classList.add('visible');
  localStorage.setItem('atlantist_tour_seen', '1');
  showBookingModal();
}

// ─── Booking Modal ────────────────────────────────────────────────────────────
function showBookingModal() {
  const overlay = document.getElementById('booking-modal-overlay');
  if (overlay) {
    overlay.classList.add('active');
    trackEvent('booking_modal_shown');
  }
}

function hideBookingModal() {
  const overlay = document.getElementById('booking-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ─── Wire Tour Controls ───────────────────────────────────────────────────────
document.getElementById('tour-next')?.addEventListener('click', () => {
  if (tourStep < TOUR_STAGES.length - 1) {
    setTourStep(tourStep + 1, 'forward');
  } else {
    endTour();
  }
});

document.getElementById('tour-prev')?.addEventListener('click', () => {
  if (tourStep > 0) setTourStep(tourStep - 1, 'back');
});

document.getElementById('tour-skip-to-end')?.addEventListener('click', skipToEnd);

document.getElementById('tour-skip-btn')?.addEventListener('click', () => {
  trackEvent('tour_skipped', { at_step: tourStep + 1 });
  endTour();
});

document.getElementById('btn-take-tour')?.addEventListener('click', () => startTour());
document.getElementById('btn-replay-tour')?.addEventListener('click', () => startTour());

// Dot clicks — jump directly to that stage
document.querySelectorAll('.tour-dot').forEach((dot, i) => {
  dot?.addEventListener('click', () => {
    trackEvent('tour_dot_jump', { to_step: i + 1 });
    setTourStep(i);
  });
});

// Booking modal dismiss
const bookingDismiss = document.getElementById('btn-booking-dismiss');
if (bookingDismiss) bookingDismiss?.addEventListener('click', hideBookingModal);

const bookingOverlay = document.getElementById('booking-modal-overlay');
if (bookingOverlay) {
  bookingOverlay?.addEventListener('click', (e) => {
    // Close if clicking backdrop directly
    if (e.target === bookingOverlay) hideBookingModal();
  });
}

const bookingCta = document.getElementById('btn-book-meeting');
if (bookingCta) {
  bookingCta?.addEventListener('click', () => {
    trackEvent('booking_cta_clicked');
  });
}

// ─── Auto-start logic ────────────────────────────────────────────────────────
// First-time visitors get the tour after 1.8s; returning visitors see replay btn.
if (!localStorage.getItem('atlantist_tour_seen')) {
  setTimeout(() => startTour(), 1800);
} else {
  document.getElementById('btn-replay-tour')?.classList.add('visible');
}

// ─── Read-only Multiplayer Live Session ──────────────────────────────────────
const ANON_NAMES = [
  'Architect from Berlin', 'Engineer from Tokyo', 'Designer from London',
  'PM from São Paulo', 'Consultant from Paris', 'Contractor from Dubai',
  'BIM Manager from NYC', 'Intern from Seoul',
];
const CURSOR_COLORS = ['#7c3aed','#059669','#b45309','#1d5fa6','#c026d3','#dc2626'];

let liveSessions = [];
let liveJoined = false;
let idleTimer = null;
let idleSeconds = 0;
const MAX_IDLE_S = 300;

// Simulate fluctuating visitor count
let visitorCount = 3;
setInterval(() => {
  visitorCount = Math.max(2, Math.min(8, visitorCount + (Math.random() > 0.5 ? 1 : -1)));
  const vc = document.getElementById('visitor-count');
  if (vc) vc.textContent = visitorCount;
  const lvc = document.getElementById('live-visitor-count');
  if (lvc) lvc.textContent = visitorCount + ' visitors here';
}, 4000);

function spawnCursorDot(name, color) {
  const area = document.getElementById('cursors-area');
  if (!area) return null;
  const dot = document.createElement('div');
  dot.className = 'live-cursor-dot';
  dot.style.left = (10 + Math.random() * 75) + '%';
  dot.style.top = (10 + Math.random() * 75) + '%';
  dot.innerHTML = '<div style="width:12px;height:12px;border-radius:50%;background:' + color + ';opacity:0.9;"></div>' +
    '<div class="live-cursor-label" style="background:' + color + ';top:14px;left:14px;">' + name.split(' ')[0] + '</div>';
  area.appendChild(dot);
  return dot;
}

function moveCursors() {
  liveSessions.forEach(s => {
    if (!s.dot) return;
    const nx = Math.max(5, Math.min(90, parseFloat(s.dot.style.left) + (Math.random() * 10 - 5)));
    const ny = Math.max(5, Math.min(85, parseFloat(s.dot.style.top) + (Math.random() * 8 - 4)));
    s.dot.style.left = nx + '%';
    s.dot.style.top = ny + '%';
  });
}

function joinLiveSession() {
  if (liveJoined) return;
  liveJoined = true;
  trackEvent('demo_live_session_joined');
  document.getElementById('live-session-bar').style.display = 'none';
  document.getElementById('live-session-panel').classList.add('open');

  const count = Math.floor(Math.random() * 3) + 2;
  for (let i = 0; i < count; i++) {
    const name = ANON_NAMES[Math.floor(Math.random() * ANON_NAMES.length)];
    const color = CURSOR_COLORS[i % CURSOR_COLORS.length];
    const dot = spawnCursorDot(name, color);
    liveSessions.push({ name, color, dot });
  }
  const moveInterval = setInterval(() => {
    if (!liveJoined) { clearInterval(moveInterval); return; }
    moveCursors();
  }, 1200);

  idleSeconds = 0;
  const resetIdle = () => { idleSeconds = 0; };
  document.addEventListener('mousemove', resetIdle);
  document.addEventListener('touchstart', resetIdle);
  idleTimer = setInterval(() => {
    idleSeconds++;
    const notice = document.getElementById('idle-notice');
    if (notice) {
      const remaining = MAX_IDLE_S - idleSeconds;
      if (remaining <= 60) {
        notice.textContent = 'Auto-disconnect in ' + remaining + 's · Move to stay connected';
        notice.style.color = 'var(--amber)';
      }
    }
    if (idleSeconds >= MAX_IDLE_S) leaveLiveSession();
  }, 1000);
}

function leaveLiveSession() {
  liveJoined = false;
  clearInterval(idleTimer);
  liveSessions.forEach(s => { if (s.dot) s.dot.remove(); });
  liveSessions = [];
  document.getElementById('live-session-panel').classList.remove('open');
  document.getElementById('live-session-bar').style.display = '';
  const notice = document.getElementById('idle-notice');
  if (notice) {
    notice.textContent = 'Auto-disconnect after 5 min idle · Read-only — sign up to edit';
    notice.style.color = '';
  }
  trackEvent('demo_live_session_left');
}

document.getElementById('btn-join-live')?.addEventListener('click', joinLiveSession);
document.getElementById('btn-leave-live')?.addEventListener('click', leaveLiveSession);

// ─── Mobile Camera Presets ────────────────────────────────────────────────────
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 768;
if (isMobile) {
  const presetsEl = document.getElementById('mobile-presets');
  if (presetsEl) presetsEl.classList.add('visible');
}

function applyPreset(preset) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('[data-preset="' + preset + '"]');
  if (btn) btn.classList.add('active');
  trackEvent('demo_mobile_preset', { preset });
  window.location.href = '/app?demo=nyc-midrise&cam=' + preset;
}
window.applyPreset = applyPreset;
