/**
 * Atlantist BIM 2.0 — Live Session Manager (Phase 35)
 * Handles share modal, presence chips, ghost cursors, selection echo, follow mode.
 *
 * Usage:
 *   import { LiveSessionManager } from './live-session-manager.js';
 *   window.liveSession = new LiveSessionManager(wsClient, app);
 *   // Auto-init on load: checks URL for /live/<token> or ?live_token=
 */
export class LiveSessionManager {
  constructor(wsClient, app) {
    this.ws = wsClient;
    this.app = app;
    this.session = null;       // { id, projectId, token, mode, shareUrl }
    this.participants = [];   // [{ userId, isGuest, guestHandle, color }]
    this.ghostCursors = new Map(); // userId → { el, targetX, targetY, color }
    this._ghostFrame = null;
    this._lastCursorEmit = 0;
    this._activeFollowTarget = null;

    this._bindWsCallbacks();
    this._checkUrlForSession();
  }

  // ── URL routing ──────────────────────────────────────────────────────────
  _checkUrlForSession() {
    const path = window.location.pathname;
    const match = path.match(/^\/live\/([a-z0-9]+)$/);
    if (match) {
      const token = match[1];
      this._joinFromToken(token);
    }
  }

  async _joinFromToken(token) {
    try {
      const res = await fetch(`/api/live-sessions/${token}/join`, { credentials: 'include' });
      let data;
      try { data = await res.json(); } catch {
        console.warn(`[live-session] /join returned non-JSON (${res.status})`);
        this._showError('Session not found or expired');
        return;
      }

      if (data.requires_login) {
        // Redirect to app with login prompt
        window.location.href = `/app?live_token=${token}&needs_login=1`;
        return;
      }

      if (!res.ok) {
        this._showError('Session not found or expired');
        return;
      }

      // Navigate to the project and join the live session
      window.location.href = `/app?project_id=${data.project_id}&live_session=${data.session_id}&live_token=${token}`;
    } catch (e) {
      this._showError('Failed to join session');
    }
  }

  // ── Share flow ───────────────────────────────────────────────────────────
  async createShareSession(mode = 'view', ttlHours = 24) {
    const projectId = this.app.currentProjectId;
    if (!projectId) return;

    try {
      const res = await fetch('/api/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ project_id: projectId, mode, ttl_hours: ttlHours }),
      });
      if (!res.ok) {
        let msg = 'Failed to create session';
        try { msg = (await res.json()).error || msg; } catch { msg = `HTTP ${res.status}`; }
        this._showError(msg);
        return;
      }
      let data;
      try { data = await res.json(); } catch {
        this._showError('Invalid server response');
        return;
      }

      this.session = data;
      this.openShareModal(data);
    } catch (e) {
      this._showError('Failed to create share link');
    }
  }

  async joinShareSession(token) {
    try {
      const res = await fetch(`/api/live-sessions/${token}/join`, { credentials: 'include' });
      if (!res.ok) {
        let msg = 'Failed to join';
        try { msg = (await res.json()).error || msg; } catch { msg = `HTTP ${res.status}`; }
        this._showError(msg);
        return;
      }
      let data;
      try { data = await res.json(); } catch {
        this._showError('Invalid server response');
        return;
      }
      if (data.requires_login) { window.location.href = `/app?live_token=${token}&needs_login=1`; return; }

      this.session = {
        id: data.session_id,
        projectId: data.project_id,
        token,
        mode: data.mode,
      };

      // Open the project and join the live session channel
      if (this.app.loadProject) {
        await this.app.loadProject(data.project_id);
      }

      this._joinLiveChannel(data);
    } catch (e) {
      this._showError('Failed to join session');
    }
  }

  _joinLiveChannel(data) {
    this.ws.joinLiveSession(data.session_id, data.user_id, {
      isGuest: data.is_guest,
      guestHandle: data.guest_handle,
      color: data.color,
    });
    this._renderPresenceChips();
    if (data.is_guest) this._showGuestBanner(data.guest_handle);
  }

  // ── Share Modal ──────────────────────────────────────────────────────────
  openShareModal(session) {
    // Remove existing modal
    this._removeShareModal();

    const modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
      background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;
      animation:fadeIn 0.15s ease-out;
    `;
    modal.innerHTML = `
      <div style="
        background:var(--bg-panel,#1a2530);border:1px solid var(--border,#334155);
        border-radius:14px;padding:28px;width:440px;max-width:90vw;
        box-shadow:0 24px 80px rgba(0,0,0,0.5);
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <h2 style="margin:0;font-size:18px;font-weight:700;color:var(--text,#e8e4dc)">Share Live Session</h2>
          <button id="share-modal-close" style="
            background:none;border:none;color:var(--text-muted,#7a8ba3);cursor:pointer;
            font-size:22px;line-height:1;padding:4px 8px;border-radius:6px;
          ">×</button>
        </div>

        <!-- Mode toggle -->
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <label style="flex:1;cursor:pointer">
            <input type="radio" name="share-mode" value="view" ${session?.mode !== 'edit' ? 'checked' : ''} style="margin-right:6px">
            <span style="font-size:13px;color:var(--text,#e8e4dc)">👁 View only</span>
            <div style="font-size:11px;color:var(--text-muted,#7a8ba3)">Guests can watch live</div>
          </label>
          <label style="flex:1;cursor:pointer">
            <input type="radio" name="share-mode" value="edit" ${session?.mode === 'edit' ? 'checked' : ''} style="margin-right:6px">
            <span style="font-size:13px;color:var(--text,#e8e4dc)">✏️ Collaborate</span>
            <div style="font-size:11px;color:var(--text-muted,#7a8ba3)">Allow edits (login required)</div>
          </label>
        </div>

        <!-- Expiry -->
        <div style="margin-bottom:16px">
          <label style="font-size:12px;color:var(--text-muted,#7a8ba3);display:block;margin-bottom:6px">Session expires</label>
          <select id="share-ttl" style="width:100%;padding:8px 12px;background:var(--bg-viewport,#0f1923);border:1px solid var(--border,#334155);border-radius:8px;color:var(--text,#e8e4dc);font-size:13px">
            <option value="1">1 hour</option>
            <option value="24" selected>24 hours</option>
            <option value="168">7 days</option>
          </select>
        </div>

        <!-- Link display -->
        <div style="margin-bottom:12px">
          <label style="font-size:12px;color:var(--text-muted,#7a8ba3);display:block;margin-bottom:6px">Share link</label>
          <div style="display:flex;gap:8px">
            <input id="share-url" readonly style="
              flex:1;padding:10px 12px;background:var(--bg-viewport,#0f1923);
              border:1px solid var(--border,#334155);border-radius:8px;
              color:var(--text,#e8e4dc);font-size:13px;font-family:monospace;
            " value="${session ? window.location.origin + session.share_url : ''}">
            <button id="share-copy" style="
              padding:10px 16px;background:var(--accent,#1d5fa6);border:none;
              border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;
            ">Copy</button>
          </div>
        </div>

        <div style="font-size:12px;color:var(--text-muted,#7a8ba3);margin-bottom:20px">
          Anyone with this link can view the model live. No account required for view mode.
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:8px">
          <button id="share-update-btn" style="
            flex:1;padding:10px;background:var(--accent,#1d5fa6);border:none;
            border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;
          ">Update Link</button>
          <button id="share-close-btn" style="
            flex:1;padding:10px;background:var(--bg-viewport,#0f1923);border:1px solid var(--border,#334155);
            border-radius:8px;color:var(--text,#e8e4dc);font-size:13px;cursor:pointer;
          ">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#share-modal-close').onclick = () => this._removeShareModal();
    modal.querySelector('#share-close-btn').onclick = () => this._removeShareModal();
    modal.querySelector('#share-copy').onclick = () => {
      const input = modal.querySelector('#share-url');
      navigator.clipboard.writeText(input.value).then(() => {
        const btn = modal.querySelector('#share-copy');
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    };
    modal.querySelector('#share-update-btn').onclick = () => {
      const mode = modal.querySelector('input[name="share-mode"]:checked').value;
      const ttl = parseInt(modal.querySelector('#share-ttl').value, 10);
      this.createShareSession(mode, ttl);
    };
    modal.onclick = (e) => { if (e.target === modal) this._removeShareModal(); };
  }

  _removeShareModal() {
    const m = document.getElementById('share-modal');
    if (m) m.remove();
  }

  // ── Presence Chips ───────────────────────────────────────────────────────
  _renderPresenceChips() {
    let container = document.getElementById('live-presence-bar');
    if (!container) {
      container = document.createElement('div');
      container.id = 'live-presence-bar';
      container.style.cssText = `
        display:flex;align-items:center;gap:6px;padding:0 8px;
        font-size:12px;color:var(--text,#e8e4dc);
      `;
      // Insert after the project name area in the toolbar
      const projName = document.getElementById('detail-project-name')?.parentElement?.parentElement;
      if (projName) projName.insertAdjacentElement('afterend', container);
    }

    container.innerHTML = '';
    for (const p of this.participants) {
      const chip = document.createElement('div');
      chip.style.cssText = `
        display:flex;align-items:center;gap:5px;padding:4px 10px 4px 4px;
        background:var(--bg-viewport,#0f1923);border:1.5px solid ${p.color};
        border-radius:20px;cursor:pointer;font-size:12px;transition:transform 0.15s;
      `;
      chip.title = p.isGuest ? `${p.guestHandle} (Guest)` : p.userId;
      chip.innerHTML = `
        <div style="width:20px;height:20px;border-radius:50%;background:${p.color};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0">
          ${p.isGuest ? p.guestHandle?.slice(-2) || '?' : (p.userId?.slice(0, 2) || '?')}
        </div>
        <span style="color:var(--text,#e8e4dc)">${p.isGuest ? p.guestHandle : (p.userId?.slice(0, 8) || 'Participant')}</span>
      `;
      chip.onclick = () => this._onChipClick(p);
      container.appendChild(chip);
    }
  }

  _onChipClick(participant) {
    if (this._activeFollowTarget === participant.userId) {
      // Unfollow
      this.ws.followLiveParticipant(null);
      this._activeFollowTarget = null;
    } else {
      // Follow this participant
      this.ws.followLiveParticipant(participant.userId);
      this._activeFollowTarget = participant.userId;
    }
  }

  // ── Ghost Cursors ────────────────────────────────────────────────────────
  _renderGhostCursor(userId, color, handle, x, y) {
    let el = this.ghostCursors.get(userId);
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = `
        position:fixed;pointer-events:none;z-index:9998;
        transition:left 0.05s linear, top 0.05s linear;
        will-change:left,top;
      `;
      el.innerHTML = `
        <svg width="20" height="24" viewBox="0 0 20 24" fill="none">
          <path d="M4 1L17 10L10 12L7 20L4 1Z" fill="${color}" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
        <div style="
          margin-top:2px;padding:2px 7px;background:${color};
          border-radius:10px;font-size:11px;font-weight:600;color:#fff;
          white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;
          display:inline-block;
        ">${handle || userId?.slice(0, 8) || 'User'}</div>
      `;
      document.body.appendChild(el);
      this.ghostCursors.set(userId, el);
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  _removeGhostCursor(userId) {
    const el = this.ghostCursors.get(userId);
    if (el) { el.remove(); this.ghostCursors.delete(userId); }
  }

  _animateGhostCursors() {
    // Smooth interpolation via rAF is handled by CSS transition
    this._ghostFrame = requestAnimationFrame(() => this._animateGhostCursors());
  }

  // ── Selection Echo ────────────────────────────────────────────────────────
  _applySelectionEcho(userId, color, elementId) {
    // Highlight the element in 3D view with the participant's color
    if (this.app.highlightElementWithColor) {
      this.app.highlightElementWithColor(elementId, color, userId);
    }
  }

  _removeSelectionEcho(userId) {
    if (this.app.clearHighlight) {
      this.app.clearHighlight(userId);
    }
  }

  // ── Guest Banner ─────────────────────────────────────────────────────────
  _showGuestBanner(handle) {
    if (document.getElementById('guest-live-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'guest-live-banner';
    banner.style.cssText = `
      position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
      background:var(--accent,#1d5fa6);color:#fff;padding:10px 20px;
      border-radius:12px;font-size:13px;font-weight:500;z-index:9999;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);display:flex;align-items:center;gap:12px;
    `;
    banner.innerHTML = `
      <span>👤 <strong>${handle}</strong> — viewing live session (view-only)</span>
      <button onclick="window.liveSession&&window.liveSession._showSignUp()" style="
        background:#fff;color:var(--accent,#1d5fa6);border:none;padding:5px 12px;
        border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;
      ">Sign up to collaborate →</button>
    `;
    document.body.appendChild(banner);
  }

  _hideGuestBanner() {
    const b = document.getElementById('guest-live-banner');
    if (b) b.remove();
  }

  _showSignUp() {
    window.location.href = '/app?signup=1';
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  _showError(msg) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;top:20px;left:50%;transform:translateX(-50%);
      background:#e74c3c;color:#fff;padding:10px 20px;border-radius:8px;
      font-size:13px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ── WS Callbacks ─────────────────────────────────────────────────────────
  _bindWsCallbacks() {
    this.ws.onLiveJoined = (sessionId, participants, myColor, myUserId) => {
      this.participants = participants;
      this._renderPresenceChips();
      this._animateGhostCursors();

      // If we're following someone, resume that follow
      if (this._activeFollowTarget) {
        this.ws.followLiveParticipant(this._activeFollowTarget);
      }
    };

    this.ws.onLiveParticipantJoined = (userId, isGuest, guestHandle, color) => {
      this.participants.push({ userId, isGuest, guestHandle, color });
      this._renderPresenceChips();

      // Show join toast
      this._showToast(`${guestHandle || userId} joined the session`);
    };

    this.ws.onLiveParticipantLeft = (userId, color, count) => {
      this.participants = this.participants.filter(p => p.userId !== userId);
      this._removeGhostCursor(userId);
      this._removeSelectionEcho(userId);
      this._renderPresenceChips();
    };

    this.ws.onLiveCursor = (userId, color, handle, x, y, viewType) => {
      // Transform cursor to screen space
      const screenPos = this._projectToScreen(x, y, viewType);
      if (screenPos) {
        this._renderGhostCursor(userId, color, handle, screenPos.x, screenPos.y);
      }

      // If following this participant, sync their viewport
      if (this._activeFollowTarget === userId && screenPos) {
        this._syncToViewport(x, y, viewType);
      }
    };

    this.ws.onLiveViewport = (userId, color, viewportState) => {
      // Follow mode: sync camera
      if (this._activeFollowTarget === userId) {
        this._applyViewportState(viewportState);
      }
    };

    this.ws.onLiveSelection = (userId, color, handle, elementId) => {
      this._applySelectionEcho(userId, color, elementId);
    };

    this.ws.onLiveFollowUpdate = (userId, targetUserId) => {
      if (targetUserId && this._activeFollowTarget !== userId) {
        this._showToast(`${userId?.slice(0, 8)} is following ${targetUserId?.slice(0, 8)}`);
      }
    };

    this.ws.onLiveDisconnected = () => {
      // Cleanup UI
      for (const [uid] of this.ghostCursors) this._removeGhostCursor(uid);
      this._removeGuestBanner();
    };
  }

  // ── Cursor projection ────────────────────────────────────────────────────
  _projectToScreen(x, y, viewType) {
    // x/y are relative viewport coordinates (0-1 normalized or world units)
    // We use the 3D canvas to project world position to screen
    const canvas = this.app.canvas3d || document.querySelector('canvas');
    if (!canvas) return null;

    // If values are normalized 0-1, scale to canvas size
    if (x <= 1 && y <= 1) {
      return { x: x * canvas.offsetWidth, y: y * canvas.offsetHeight };
    }

    // World coordinates — need to project through camera
    if (this.app.projectWorldToScreen) {
      return this.app.projectWorldToScreen(x, y, viewType);
    }

    // Fallback: rough heuristic based on canvas position
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y };
  }

  _syncToViewport(worldX, worldY, viewType) {
    if (this.app.syncFollowCamera) {
      this.app.syncFollowCamera(worldX, worldY, viewType);
    }
  }

  _applyViewportState(state) {
    if (this.app.applyRemoteViewport) {
      this.app.applyRemoteViewport(state);
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  _showToast(msg) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:var(--bg-panel,#1a2530);border:1px solid var(--border,#334155);
      color:var(--text,#e8e4dc);padding:8px 16px;border-radius:8px;
      font-size:12px;z-index:9998;animation:slideUp 0.2s ease-out;
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ── Expose to global for toolbar button ──────────────────────────────────
  openModal() { this.createShareSession('view', 24); }
}