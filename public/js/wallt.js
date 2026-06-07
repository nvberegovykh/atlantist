/**
 * Wallt AI Companion Widget (Phase 34A–34D)
 * Floating chat widget with conversation history, action chips, and WalltBridge dispatch.
 * Phase 34D: action chips rendered below bot messages; WalltBridge.execute() on click.
 */
(function() {
  'use strict';

  // ── Config ───────────────────────────────────────────────
  const API_BASE = '/api/wallt';
  const AVATAR_WALLT = 'W';
  const AVATAR_USER = 'U';

  // ── State ─────────────────────────────────────────────────
  let conversations = [];
  let activeConvId = null;
  let messages = [];
  let isExpanded = false;
  let isTyping = false;
  let isLoggedIn = false; // Set after /auth/me probe on init
  let currentProjectId = null;   // injected from app.js via window.currentProjectId
  let currentProjectName = null; // injected from app.js
  let activeViewId = null;       // current view / tab
  let activeTool = null;         // active tool name

  // ── Voice state ───────────────────────────────────────────
  let voiceEnabled   = false;
  let voiceCharacterId = null;
  let voiceVolume    = 0.8;
  let voices         = [];         // loaded from /api/wallt/voice/catalog
  let currentAudio   = null;        // current Web Audio source node
  let audioContext   = null;        // lazy-initialized AudioContext
  let voiceAvailable  = false;      // ElevenLabs quota/key present

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    injectStyles();
    buildHTML();
    bindEvents();

    // Pull project context from app.js globals (set on /app page load)
    currentProjectId   = window.currentProjectId   || null;
    currentProjectName = window.currentProjectName || currentProjectId ? `#${currentProjectId}` : null;
    activeViewId       = window.currentViewId     || null;
    activeTool         = window.currentToolName   || null;

    // Update project pill in header if we have a project
    updateProjectPill();

    // Probe auth state then load persisted conversations for logged-in users
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (r.ok) {
        const d = await r.json();
        isLoggedIn = d.authenticated === true;
      }
    } catch (_) {}
    if (isLoggedIn) loadConversations();

    // Load voice preferences + catalog
    loadVoiceState();
  }

  function injectStyles() {
    if (document.getElementById('wallt-styles')) return;
    const link = document.createElement('link');
    link.id = 'wallt-styles';
    link.rel = 'stylesheet';
    link.href = '/css/wallt.css';
    document.head.appendChild(link);
  }

  function buildHTML() {
    // Skip — widget HTML is now static in app.html (Phase 34E) so this
    // branch only fires on pages that don't have the static markup.
    if (document.getElementById('wallt-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'wallt-overlay';

    overlay.innerHTML = `
      <div id="wallt-panel" class="collapsed">
        <div id="wallt-header">
          <div id="wallt-avatar">${AVATAR_WALLT}</div>
          <div id="wallt-header-info">
            <div id="wallt-header-name">Wallt</div>
            <div id="wallt-header-sub">AI Companion</div>
          </div>
          <div id="wallt-project-pill" class="wallt-project-pill" style="display:none" title="Current project context">
            <span id="wallt-project-label"></span>
          </div>
          <div id="wallt-header-actions">
            <button class="wallt-icon-btn" id="wallt-voice-toggle" title="Toggle voice (Ctrl+Shift+V)" style="display:none">
              <svg id="wallt-voice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            </button>
            <button class="wallt-icon-btn" id="wallt-new-chat" title="New chat">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
            <button class="wallt-icon-btn" id="wallt-settings-btn" title="Settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
              </svg>
            </button>
            <button class="wallt-icon-btn" id="wallt-collapse" title="Collapse">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 15l-6-6-6 6"/>
              </svg>
            </button>
          </div>
        </div>

        <div id="wallt-conv-selector"></div>

        <div id="wallt-welcome">
          <div id="wallt-welcome-icon">🤖</div>
          <h3>I'm Wallt — Atlantist AI Companion</h3>
          <p>Ask me about zoning, BIM modeling, structural calcs, energy analysis, or anything in your project.</p>
          <div class="wallt-quick-actions">
            <button class="wallt-quick-btn" data-prompt="What are the setback requirements for R5 zones in NYC?">NYC zoning setbacks</button>
            <button class="wallt-quick-btn" data-prompt="How do I add a structural column to Level 2?">Add structural column</button>
            <button class="wallt-quick-btn" data-prompt="Run an energy simulation for this building">Energy simulation</button>
          </div>
        </div>

        <div id="wallt-messages" style="display:none"></div>

        <div id="wallt-typing">
          <div class="wallt-msg-avatar wallt-msg-avatar-wallt" style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#3a6a9a,#5b9bd5);display:flex;align-items:center;justify-content:center;font-size:12px;color:#cfe3f5">${AVATAR_WALLT}</div>
          <div class="wallt-typing-dots"><span></span><span></span><span></span></div>
        </div>

        <div id="wallt-input-area">
          <textarea id="wallt-input" placeholder="Ask Wallt anything…" rows="1"></textarea>
          <button id="wallt-send-btn" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>

        <div class="wallt-tool-attribution">Wallt AI — responses may contain inaccuracies · verify critical data</div>
      </div>

      <button id="wallt-trigger" title="Open Wallt">
        <svg viewBox="0 0 24 24" fill="none" stroke="#5b9bd5" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div id="wallt-badge"></div>
      </button>
    `;

    document.body.appendChild(overlay);
  }

  function bindEvents() {
    document.getElementById('wallt-trigger')?.addEventListener('click', togglePanel)
      || console.warn('[wallt] #wallt-trigger not found — widget not on this page');
    document.getElementById('wallt-collapse')?.addEventListener('click', collapsePanel)
      || console.warn('[wallt] #wallt-collapse not found');
    document.getElementById('wallt-new-chat')?.addEventListener('click', startNewChat)
      || console.warn('[wallt] #wallt-new-chat not found');
    document.getElementById('wallt-send-btn')?.addEventListener('click', sendMessage)
      || console.warn('[wallt] #wallt-send-btn not found');
    document.getElementById('wallt-settings-btn')?.addEventListener('click', openVoicePanel)
      || console.warn('[wallt] #wallt-settings-btn not found');
    document.getElementById('wallt-voice-toggle')?.addEventListener('click', toggleVoice)
      || console.warn('[wallt] #wallt-voice-toggle not found');

    // Ctrl+Shift+V keyboard shortcut — global toggle
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        toggleVoice();
      }
    });

    const input = document.getElementById('wallt-input');
    if (!input) { console.warn('[wallt] #wallt-input not found — cannot bind input events'); }
    else {
      input?.addEventListener('input', autoResize);
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    // Quick action buttons + action chip clicks — both handled in one delegating listener
    const walltPanel = document.getElementById('wallt-panel');
    if (!walltPanel) { console.warn('[wallt] #wallt-panel not found — cannot bind panel events'); }
    else {
      walltPanel?.addEventListener('click', (e) => {
        // Quick action buttons
        const btn = e.target.closest('.wallt-quick-btn');
        if (btn) {
          const prompt = btn.dataset.prompt;
          const inputEl = document.getElementById('wallt-input');
          if (inputEl) inputEl.value = prompt;
          autoResize({ target: inputEl });
          sendMessage();
          return;
        }

        // Phase 34D: action chip clicks → WalltBridge
        const chip = e.target.closest('.wallt-action-chip');
        if (!chip || chip.disabled) return;

        let action;
        try {
          action = JSON.parse(chip.dataset.action || '{}');
        } catch (_) { return; }

        // Confirmation chip: first click shows "Are you sure?" state, second executes
        if (action.needsConfirm && !chip.classList.contains('wallt-action-confirmed')) {
          chip.classList.add('wallt-action-confirmed');
          chip.textContent = '⚠ Confirm — click again';
          return;
        }

        // Disable chip to prevent double-fire
        chip.disabled = true;
        chip.classList.add('wallt-action-executing');
        chip.textContent = 'Working…';

        (async () => {
          const bridge = window.WalltBridge;
          if (!bridge) {
            chip.textContent = action.label || action.type;
            chip.disabled = false;
            return;
          }

          const result = await bridge.execute(action);

          if (result.ok) {
            chip.classList.add('wallt-action-done');
            chip.textContent = `✓ ${result.message}`;

            // Offer undo for spawn actions
            if (action.type === 'spawn_element' && result.spawned && result.spawned.length > 0) {
              const undoBtn = document.createElement('button');
              undoBtn.className = 'wallt-action-chip wallt-action-undo';
              undoBtn.textContent = 'Undo';
              undoBtn?.addEventListener('click', async () => {
                undoBtn.disabled = true;
                undoBtn.textContent = 'Undoing…';
                await bridge.undo(action, result);
                undoBtn.textContent = 'Undone';
              });
              chip.parentElement.appendChild(undoBtn);
            }
          } else {
            chip.classList.add('wallt-action-failed');
            chip.textContent = `✗ ${result.message}`;
            chip.disabled = false;
          }
        })();
      });
    }
  }

  // ── Project pill (Phase 34C) ──────────────────────────────
  function updateProjectPill() {
    const pill = document.getElementById('wallt-project-pill');
    const label = document.getElementById('wallt-project-label');
    if (!pill || !label) return;

    const projectId = window.currentProjectId || currentProjectId;
    const projectName = window.currentProjectName || currentProjectName;

    if (projectId) {
      const display = projectName || `Project #${projectId}`;
      const view = window.currentViewId || activeViewId || '';
      label.textContent = view ? `${display} · ${view}` : display;
      pill.style.display = '';
    } else {
      pill.style.display = 'none';
    }
  }

  // Called by app.js whenever the active project/view/tool changes
  window._walltSetProjectContext = function({ projectId, projectName, viewId, toolName }) {
    currentProjectId   = projectId || currentProjectId;
    currentProjectName = projectName || currentProjectName;
    activeViewId       = viewId    || activeViewId;
    activeTool         = toolName  || activeTool;
    updateProjectPill();
  };

  // ── Panel control ─────────────────────────────────────────
  function togglePanel() {
    isExpanded ? collapsePanel() : expandPanel();
  }

  function expandPanel() {
    const panel = document.getElementById('wallt-panel');
    if (!panel) { console.warn('[wallt] expandPanel: #wallt-panel not found'); return; }
    panel.classList.remove('collapsed');
    panel.classList.add('expanded');
    isExpanded = true;
  }

  function collapsePanel() {
    const panel = document.getElementById('wallt-panel');
    if (!panel) { console.warn('[wallt] collapsePanel: #wallt-panel not found'); return; }
    panel.classList.remove('expanded');
    panel.classList.add('collapsed');
    isExpanded = false;
    closeVoicePanel();
  }

  // ── Conversations ──────────────────────────────────────────
  async function loadConversations() {
    try {
      const res = await fetch(`${API_BASE}/conversations`, { credentials: 'include' });
      if (!res.ok) return;
      let data;
      try { data = await res.json(); } catch {
        console.warn('[Wallt] /conversations non-JSON, skipping load');
        return;
      }
      conversations = data.conversations || [];
      renderConvChips();
    } catch (e) {
      // Not logged in — widget still shows but API calls are gated
    }
  }

  async function startNewChat() {
    const projectId = window.currentProjectId || null;
    try {
      const res = await fetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: 'New Chat', context_project_id: projectId }),
      });
      if (!res.ok) return;
      let data;
      try { data = await res.json(); } catch {
        console.warn('[Wallt] new chat response non-JSON, aborting');
        return;
      }
      conversations.unshift(data.conversation);
      renderConvChips();
      selectConversation(data.conversation.id);
    } catch (e) {
      console.error('[Wallt] new chat error:', e);
    }
  }

  async function selectConversation(convId) {
    activeConvId = convId;
    renderConvChips();

    try {
      const res = await fetch(`${API_BASE}/conversations/${convId}`, { credentials: 'include' });
      if (!res.ok) return;
      let data;
      try { data = await res.json(); } catch {
        console.warn(`[Wallt] /conversations/${convId} non-JSON (${res.status}), skipping`);
        return;
      }
      messages = data.messages || [];
      renderMessages();
    } catch (e) {
      console.error('[Wallt] load conversation error:', e);
    }
  }

  function renderConvChips() {
    const el = document.getElementById('wallt-conv-selector');
    el.innerHTML = conversations.slice(0, 8).map(c => `
      <button class="wallt-conv-chip ${c.id === activeConvId ? 'active' : ''}" data-id="${c.id}">
        ${escapeHtml(c.title || 'Chat')}
      </button>
    `).join('');

    el.querySelectorAll('.wallt-conv-chip').forEach(chip => {
      chip?.addEventListener('click', () => selectConversation(parseInt(chip.dataset.id)));
    });
  }

  // ── Send message ───────────────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById('wallt-input');
    const content = input.value.trim();
    if (!content || isTyping) return;

    input.value = '';
    autoResize({ target: input });

    // Add user message to UI immediately
    addMessageToUI({ role: 'user', content, sources: [], metadata: {}, created_at: new Date().toISOString() });
    showTyping(true);

    // Build project context + live environment snapshot (Phase 35G)
    const projectId = window.currentProjectId || currentProjectId;
    const viewId    = window.currentViewId     || activeViewId;
    const toolName  = window.currentToolName   || activeTool;

    // Collect live scene state from app.js globals.
    // These are populated by app.js whenever selection/scene/camera changes.
    // Graceful fallback: missing globals → empty env (backend ignores undefined slots).
    const env = {
      // View + tool
      activeView: viewId  || undefined,
      activeTool: toolName || undefined,

      // Selected element — app.js sets window._walltSelection on click
      selection: window._walltSelection || undefined,

      // Scene summary — app.js sets window._walltScene on any structural change
      scene: window._walltScene || undefined,

      // Camera state — app.js sets window._walltCamera on OrbitControls change
      camera: window._walltCamera || undefined,

      // Model-level stats — app.js sets window._walltModelStats on load/save
      modelStats: window._walltModelStats || undefined,

      // Walkthrough — reserved; app.js sets window._walltWalkthrough when active
      walkthrough: window._walltWalkthrough || undefined,

      // Active simulation — app.js sets window._walltSimulation on sim run
      simulation: window._walltSimulation || undefined,

      // Last 5 user actions — app.js appends to window._walltRecentActions
      recentActions: Array.isArray(window._walltRecentActions)
        ? window._walltRecentActions.slice(-5)
        : undefined,
    };
    // Strip undefined keys to keep payload lean
    const envClean = Object.fromEntries(Object.entries(env).filter(([,v]) => v !== undefined));

    const projectPayload = projectId
      ? { project_id: projectId, active_view: viewId, active_tool: toolName, env: envClean }
      : (Object.keys(envClean).length ? { env: envClean } : {});

    try {
      let data;

      if (!isLoggedIn) {
        // Anon users — stateless /chat endpoint; messages array is local UI state
        const msgWindow = messages.concat([{ role: 'user', content }]).slice(-20);
        const res = await fetch(`${API_BASE}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ messages: msgWindow, ...projectPayload }),
        });
        showTyping(false);
        if (!res.ok) throw new Error('chat failed');
        try { data = await res.json(); } catch {
          throw new Error('chat returned non-JSON response');
        }
      } else {
        // Logged-in — persist in a conversation thread
        if (!activeConvId) await startNewChat();
        const res = await fetch(`${API_BASE}/conversations/${activeConvId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ content, ...projectPayload }),
        });
        showTyping(false);
        if (!res.ok) throw new Error('send failed');
        try { data = await res.json(); } catch {
          throw new Error('send returned non-JSON response');
        }
      }

      // Phase 34D: tag message with a key for action chip state tracking
      const msgWithKey = { ...data.message, _msgKey: `msg_${Date.now()}` };
      addMessageToUI(msgWithKey);

      // Auto-play voice if enabled (mode: routine / escalation / warning / humor)
      const mode = (msgWithKey.metadata && msgWithKey.metadata.tts_mode) || 'routine';
      speakText(msgWithKey.content, mode);

      // Auto-execute non-destructive actions when user said "do it" / "go ahead"
      const lowerContent = content.toLowerCase().trim();
      const autoExecPrefixes = ['do it', 'go ahead', 'yes do it', 'execute', 'confirm'];
      const isAutoExec = autoExecPrefixes.some(p => lowerContent.startsWith(p) || lowerContent === p);
      if (isAutoExec && window.WalltBridge && msgWithKey.actions) {
        for (const action of msgWithKey.actions) {
          if (!action.needsConfirm) {
            await window.WalltBridge.execute(action);
          }
        }
      }

    } catch (e) {
      showTyping(false);
      addMessageToUI({
        role: 'wallt',
        content: "I'm having trouble connecting right now. Try again in a moment.",
        sources: [],
        actions: [],
        metadata: {},
        created_at: new Date().toISOString(),
      });
    }
  }

  // ── Voice utilities ─────────────────────────────────────────
  async function loadVoiceState() {
    try {
      const res = await fetch(`${API_BASE}/voice/catalog`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data) return;

      voices          = data.voices || [];
      voiceCharacterId = data.selected || null;
      voiceEnabled    = !!data.enabled;
      voiceVolume     = data.volume   || 0.8;
      voiceAvailable  = voices.length > 0;

      // Show voice toggle button if ElevenLabs is configured
      const toggleBtn = document.getElementById('wallt-voice-toggle');
      if (toggleBtn) toggleBtn.style.display = '';
      updateVoiceIcon();
    } catch (_) {}
  }

  function initAudioContext() {
    if (audioContext) return audioContext;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    return audioContext;
  }

  function stopCurrentAudio() {
    if (currentAudio) {
      try { currentAudio.stop(); } catch (_) {}
      currentAudio = null;
    }
  }

  async function speakText(text, mode = 'routine') {
    if (!voiceEnabled || !voiceCharacterId) return;
    if (!voiceAvailable) return; // no ElevenLabs key configured

    stopCurrentAudio();

    // Respect prefers-reduced-motion: still play audio, just no visual pulses
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    try {
      const res = await fetch(`${API_BASE}/voice/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text, mode, voice_id: voiceCharacterId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === 'voice_unavailable' || err.error === 'voice_disabled') return;
        // Other errors: log and degrade
        console.warn('[wallt-voice] speak failed:', err.error || res.status);
        return;
      }

      // Decode audio stream into buffer and play via Web Audio
      const ctx   = initAudioContext();
      const buf   = await res.arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);

      const gainNode = ctx.createGain();
      gainNode.gain.value = voiceVolume;
      gainNode.connect(ctx.destination);

      const source = ctx.createBufferSource();
      source.buffer = audio;

      // Fade-in (50ms) on start, fade-out (100ms) on end
      const now = ctx.currentTime;
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(voiceVolume, now + 0.05);

      // Set fade-out at end
      const dur = audio.duration;
      source.onended = () => {
        gainNode.gain.setValueAtTime(voiceVolume, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
      };

      source.connect(gainNode);
      source.start(0);
      currentAudio = source;
    } catch (err) {
      console.warn('[wallt-voice] playback error:', err.message);
      // Degrade gracefully — text still visible, no audio
    }
  }

  function updateVoiceIcon() {
    const icon = document.getElementById('wallt-voice-icon');
    const toggleBtn = document.getElementById('wallt-voice-toggle');
    if (!icon || !toggleBtn) return;

    if (voiceEnabled && voiceAvailable) {
      icon.style.stroke = '#5b9bd5';
      toggleBtn.title = 'Voice on — click to toggle (Ctrl+Shift+V)';
      toggleBtn.classList.add('voice-active');
    } else if (voiceEnabled && !voiceAvailable) {
      icon.style.stroke = '#8a6a3a'; // amber: configured but unavailable
      toggleBtn.title = 'Voice unavailable — ElevenLabs not configured';
      toggleBtn.classList.remove('voice-active');
    } else {
      icon.style.stroke = '#5b8ab5';
      toggleBtn.title = 'Voice off — click to toggle (Ctrl+Shift+V)';
      toggleBtn.classList.remove('voice-active');
    }
  }

  async function toggleVoice() {
    if (!voiceAvailable) return; // nothing to toggle if no voices loaded

    voiceEnabled = !voiceEnabled;
    updateVoiceIcon();

    // Persist to server
    try {
      await fetch(`${API_BASE}/voice/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          voice_character_id: voiceCharacterId,
          voice_enabled: voiceEnabled,
          voice_volume: voiceVolume,
        }),
      });
    } catch (_) {}

    if (!voiceEnabled) stopCurrentAudio();
  }

  async function openVoicePanel() {
    const panel = document.getElementById('wallt-panel');
    if (!panel) return;

    // If voice panel already open, close it
    const existing = document.getElementById('wallt-voice-panel');
    if (existing) { existing.remove(); return; }

    const voicePanel = document.createElement('div');
    voicePanel.id = 'wallt-voice-panel';

    // Reload to get latest voices + quota
    let catalog, quota;
    try {
      const [catRes, qRes] = await Promise.all([
        fetch(`${API_BASE}/voice/catalog`, { credentials: 'include' }),
        fetch(`${API_BASE}/voice/quota`, { credentials: 'include' }),
      ]);
      catalog = await catRes.json().catch(() => null);
      quota   = await qRes.json().catch(() => null);
    } catch (_) {}

    const quotaHTML = quota && quota.available
      ? `<div class="wallt-voice-quota">${quota.remaining.toLocaleString()} / ${quota.limit.toLocaleString()} chars remaining (${quota.plan})</div>`
      : quota && !quota.available
      ? `<div class="wallt-voice-quota wallt-voice-quota-unavailable">${quota.reason || 'Voice unavailable'}</div>`
      : '';

    const voiceCardsHTML = (catalog?.voices || []).map(v => `
      <div class="wallt-voice-card ${v.voice_id === voiceCharacterId ? 'selected' : ''}" data-voice-id="${v.voice_id}">
        <div class="wallt-voice-card-name">${v.name}</div>
        <div class="wallt-voice-card-desc">${v.description}</div>
      </div>`).join('');

    voicePanel.innerHTML = `
      <div class="wallt-voice-panel-header">
        <span>Voice Character</span>
        <button class="wallt-icon-btn" id="wallt-voice-panel-close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="wallt-voice-toggle-row">
        <span>Enable voice</span>
        <label class="wallt-toggle-switch">
          <input type="checkbox" id="wallt-voice-enabled-cb" ${voiceEnabled ? 'checked' : ''}>
          <span class="wallt-toggle-slider"></span>
        </label>
      </div>
      <div class="wallt-voice-volume-row">
        <span>Volume</span>
        <input type="range" id="wallt-voice-volume" min="0" max="1" step="0.05" value="${voiceVolume}" style="width:120px">
        <span id="wallt-volume-label">${Math.round(voiceVolume * 100)}%</span>
      </div>
      ${quotaHTML}
      <div class="wallt-voice-cards-label">Choose a voice</div>
      <div class="wallt-voice-cards">${voiceCardsHTML}</div>`;

    panel.appendChild(voicePanel);

    // Bind panel close
    document.getElementById('wallt-voice-panel-close')?.addEventListener('click', closeVoicePanel);

    // Voice toggle
    document.getElementById('wallt-voice-enabled-cb')?.addEventListener('change', async (e) => {
      voiceEnabled = e.target.checked;
      updateVoiceIcon();
      try {
        await fetch(`${API_BASE}/voice/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ voice_enabled: voiceEnabled, voice_character_id: voiceCharacterId, voice_volume: voiceVolume }),
        });
      } catch (_) {}
      if (!voiceEnabled) stopCurrentAudio();
    });

    // Volume slider
    document.getElementById('wallt-voice-volume')?.addEventListener('input', async (e) => {
      voiceVolume = parseFloat(e.target.value);
      document.getElementById('wallt-volume-label').textContent = Math.round(voiceVolume * 100) + '%';
      try {
        await fetch(`${API_BASE}/voice/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ voice_enabled: voiceEnabled, voice_character_id: voiceCharacterId, voice_volume: voiceVolume }),
        });
      } catch (_) {}
    });

    // Voice card selection
    voicePanel.querySelectorAll('.wallt-voice-card').forEach(card => {
      card?.addEventListener('click', async () => {
        voiceCharacterId = card.dataset.voiceId;
        voicePanel.querySelectorAll('.wallt-voice-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        try {
          await fetch(`${API_BASE}/voice/preferences`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ voice_character_id: voiceCharacterId, voice_enabled: voiceEnabled, voice_volume: voiceVolume }),
          });
        } catch (_) {}
      });
    });
  }

  function closeVoicePanel() {
    document.getElementById('wallt-voice-panel')?.remove();
  }

  // ── Render messages ───────────────────────────────────────
  function renderMessages() {
    const welcome = document.getElementById('wallt-welcome');
    const msgArea = document.getElementById('wallt-messages');

    if (messages.length === 0) {
      welcome.style.display = '';
      msgArea.style.display = 'none';
    } else {
      welcome.style.display = 'none';
      msgArea.style.display = '';
      msgArea.innerHTML = messages.map(m => buildMsgHTML(m)).join('');
      scrollToBottom();
    }
  }

  function addMessageToUI(msg) {
    const welcome = document.getElementById('wallt-welcome');
    const msgArea = document.getElementById('wallt-messages');

    welcome.style.display = 'none';
    msgArea.style.display = '';

    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildMsgHTML(msg);
    msgArea.appendChild(wrapper.firstElementChild);
    scrollToBottom();
  }

  function buildMsgHTML(msg) {
    const avatar = msg.role === 'user' ? AVATAR_USER : AVATAR_WALLT;
    const avatarStyle = msg.role === 'user'
      ? 'background:#2a4a6a'
      : 'background:linear-gradient(135deg,#3a6a9a,#5b9bd5)';
    const bodyClass = msg.role === 'user' ? 'user' : 'wallt';

    const sourcesHTML = msg.sources && msg.sources.length > 0 ? `
      <div class="wallt-sources">
        <div class="wallt-sources-label">Sources</div>
        ${msg.sources.map(s => `<a class="wallt-source-chip" href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(s)}</a>`).join('')}
      </div>` : '';

    // Phase 34D: action chips
    const actions = msg.actions || msg.actions_json || [];
    const actionsHTML = actions.length > 0 ? buildActionChipsHTML(actions, msg._msgKey) : '';

    return `
      <div class="wallt-msg ${bodyClass}">
        <div class="wallt-msg-avatar" style="${avatarStyle}">${avatar}</div>
        <div class="wallt-msg-body">${renderMarkdown(msg.content)}${sourcesHTML}${actionsHTML}</div>
      </div>`;
  }

  // Build inline action chip row for a bot message
  function buildActionChipsHTML(actions, msgKey) {
    if (!actions || actions.length === 0) return '';

    const chips = actions.map((action, idx) => {
      const key = msgKey ? `${msgKey}_${idx}` : `tmp_${Date.now()}_${idx}`;
      const needsConfirm = action.needsConfirm || action.needs_confirm;
      const confirmClass = needsConfirm ? ' wallt-action-confirm' : '';
      const label = escapeHtml(action.label || action.type);
      const dataAction = escapeHtml(JSON.stringify(action));
      return `<button class="wallt-action-chip${confirmClass}" data-action="${dataAction}" data-key="${escapeHtml(key)}">${label}</button>`;
    }).join('');

    return `<div class="wallt-action-chips">${chips}</div>`;
  }

  // ── Markdown renderer (minimal) ────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/```([\n\r][\r\n\\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
      .replace(/^/g, '')
      .replace(/(<p>)?(#{1,6}\b[^<\n]+)/g, (m, p, t) => {
        const level = t.match(/^#+ /)[0].length;
        return `${p || '<p>'}<strong>${t}</strong>`;
      });
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Typing indicator ──────────────────────────────────────
  function showTyping(show) {
    isTyping = show;
    const el = document.getElementById('wallt-typing');
    el.classList.toggle('visible', show);
    if (show) scrollToBottom();
  }

  // ── Utilities ────────────────────────────────────────────
  function autoResize(e) {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';

    const btn = document.getElementById('wallt-send-btn');
    btn.disabled = !el.value.trim();
  }

  function scrollToBottom() {
    const el = document.getElementById('wallt-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ── Context injection (called by app.js on project/selection change) ──
  window._walltPushContext = async function(snapshot) {
    try {
      await fetch(`${API_BASE}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ project_id: window.currentProjectId || null, snapshot_data: snapshot }),
      });
    } catch (e) {
      // non-critical
    }
  };

  // ── Start ─────────────────────────────────────────────────
  // FIX: defer scripts run after DOM is parsed — DOMContentLoaded may have
  // already fired by the time wallt.js executes. Guard both cases.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already ready — init immediately (covers defer + dynamic-append cases)
    init();
  }
})();