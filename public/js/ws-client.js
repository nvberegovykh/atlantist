/**
 * Atlantist BIM 2.0 — WebSocket client
 * Handles real-time multi-user sync and presence for the BIM viewer.
 *
 * Phase 34: Offline hardening — exponential backoff reconnect, IndexedDB
 * edit queue, replay-with-conflict-detection on reconnect.
 *
 * Exports a single `wsClient` object consumed by app.js.
 * Callback hooks let app.js stay authoritative over state.
 */
import {
  enqueue as _queueEnqueue,
  dequeueAll as _queueDequeueAll,
  pendingCount as _queuePendingCount,
  expireOld as _queueExpireOld,
  isNearCap as _queueIsNearCap,
  MAX_BYTES,
  WARN_BYTES,
} from './offline-queue.js';

export const wsClient = {
  socket: null,
  myUserId: null,
  myColor: null,

  // ── Phase 34: Exponential backoff reconnect ────────────────────────────────
  // Sequence: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s… (caps at 30s, retries forever)
  _reconnectDelay: 1000,
  _baseDelay: 1000,
  _maxDelay: 30000,
  _reconnectTimer: null,
  _intentionalClose: false,
  _reconnectCount: 0,

  // ── BUG-WS: Badge only after 30s of exhausted retries ───────────────────
  // Timestamp of first connection failure in the current cycle
  _firstFailureAt: null,
  // setTimeout handle for the badge-show timer
  _badgeTimer: null,
  _badgeTimerDelay: 30000, // show badge after 30s of retries

  // ── Phase 34: Offline edit queue ───────────────────────────────────────────
  // Current project for queue operations
  _currentProjectId: null,
  // Callback: app.js sets this to show the conflict resolution modal
  onConflict: null,
  // Callback: app.js sets this to update the presence bar connection dot
  onConnectionStateChange: null,
  // Callback: app.js sets this to show queue size warnings
  onQueueWarning: null,
  // Callback: app.js sets this when offline edits are about to replay
  onReplayStart: null,
  // Callback: app.js sets this when offline edits finish replaying
  onReplayDone: null,
  // Callback: app.js sets this when IM data change is received from another client
  onIMUpdate: null,

  // Callbacks — set by app.js before connect()
  onElementCreated: null,
  onElementUpdated: null,
  onElementDeleted: null,
  onLevelUpdated: null,
  onLevelCreated: null,
  onLevelDeleted: null,
  onPresenceSnapshot: null,
  onRemoteSelection: null,
  onRemoteCursor: null,
  // Phase 2.2 — Issue tracking
  onIssueCreated: null,
  onIssueStatusChanged: null,
  onIssueComment: null,
  onIssueDeleted: null,
  // Phase 3.1 — Doors + Windows
  onFamilyCreated: null,
  onFamilyUpdated: null,
  onFamilyDeleted: null,
  // Phase 8 — Collaboration
  onRoomCreated: null,      // (roomCode) — we created a room
  onRoomJoined: null,       // (roomCode) — we joined a room
  onRoomError: null,        // (error) — room join/create failed
  onRoomPeerJoined: null,   // (peerId, peerColor, peerCount)
  onRoomPeerLeft: null,     // (peerId, peerCount)
  onRoomClosed: null,       // (reason)
  onRoomState: null,        // ({ roomCode, peers })
  onCameraSync: null,       // (peerId, peerColor, cameraData)
  onWebRTCSignal: null,     // (fromPeerId, signal) — for PeerJS signaling
  // Phase 4.2 — Annotations
  onAnnotationCreated: null,   // (annotation)
  onAnnotationUpdated: null,   // (annotation)
  onAnnotationDeleted: null,   // (annotationId)
  // Phase 3.4 — Stairs + Railings
  onStairCreated: null,   // (stair)
  onStairUpdated: null,   // (stair)
  onStairDeleted: null,   // ({ id })
  onRailingCreated: null, // (railing)
  onRailingUpdated: null, // (railing)
  onRailingDeleted: null, // ({ id })
  // Phase 3.3 — Grids + Rooms (BIM entities, not collab rooms)
  onGridCreated: null,    // (grid)
  onGridUpdated: null,    // (grid)
  onGridDeleted: null,    // ({ id })
  onRoomCreated: null,    // (room) — BIM room entity, not collab room
  onRoomUpdated: null,    // (room)
  onRoomDeleted: null,    // ({ id })
  // Phase 3.2 — Floors + Ceilings
  onFloorCreated: null,    // (floor)
  onFloorUpdated: null,    // (floor)
  onFloorDeleted: null,    // ({ id })
  onCeilingCreated: null,  // (ceiling)
  onCeilingUpdated: null,  // (ceiling)
  onCeilingDeleted: null,  // ({ id })
  // Phase 25 — Forum
  onForumThreadCreated: null, // (thread)
  onForumReplyCreated: null,  // (reply)
  onForumStatusChanged: null, // (threadId, status)
  // Group rotation — live sync for collaborators
  onGroupRotation: null, // (elementIds, pivot, angleRad)
  // Phase 34: Server event callback during offline replay (rebasing local state)
  onServerEvent: null,   // (event) — called for each server-side event during replay

  // Phase 24: Cross-device viewport handoff
  // (state) — received live state from sibling session of the same user
  onViewportSiblingState: null,
  // () — sibling session requests our current state (respond with pull_response)
  onViewportPullRequested: null,

  // ── Phase 35: Live Session (multi-user collaboration)
  // () — successfully joined a live session
  onLiveJoined: null,         // (sessionId, participants, myColor, myUserId)
  // (userId, isGuest, guestHandle, color) — another participant joined
  onLiveParticipantJoined: null,
  // (userId, color, count) — participant left
  onLiveParticipantLeft: null,
  // (userId, color, x, y, viewType) — ghost cursor moved
  onLiveCursor: null,
  // (userId, color, viewportState) — another participant's viewport changed
  onLiveViewport: null,
  // (userId, color, elementId) — another participant selected an element
  onLiveSelection: null,
  // (userId, targetUserId) — follow mode changed
  onLiveFollowUpdate: null,
  // () — lost connection to live session (cleanup UI)
  onLiveDisconnected: null,

  // Current live session state
  _liveSession: null,  // { sessionId, userId, color, isGuest, guestHandle }
  _liveDebounceCursor: 0,

  // Sets the current project context for queue operations
  setProject(projectId) {
    this._currentProjectId = projectId;
  },

  // BUG-WS: Initialize visibility-change handler to reset backoff on tab focus
  init() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this._connState === 'reconnecting') {
        // Tab became active while still in retry window — reset backoff and retry now
        this._intentionalClose = false;
        clearTimeout(this._reconnectTimer);
        this._reconnectDelay = this._baseDelay;
        this._reconnectCount = 0;
        this._firstFailureAt = null;
        clearTimeout(this._badgeTimer);
        this._badgeTimer = null;
        this.connect();
      }
    });
  },

  connect() {
    if (!this._intentionalClose) {
      this._setConnState('connecting');
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    try {
      this.socket = new WebSocket(url);
    } catch (e) {
      console.warn('[ws] Could not create WebSocket:', e.message);
      // BUG-WS: Use 'reconnecting' so badge stays hidden during backoff retries.
      // _scheduleReconnect() sets _firstFailureAt and _badgeTimer; after 30s the
      // timer fires and transitions to 'offline', which is when badge appears.
      this._setConnState('reconnecting');
      this._scheduleReconnect();
      return;
    }

    // BUG-R6: If the server doesn't complete the WS upgrade within 5s (e.g. Render
    // proxy terminates the long-poll before upgrade completes), transition to offline
    // so the UI doesn't show a stuck "connecting" badge forever. The reconnect
    // scheduler will retry.
    const connectTimeout = setTimeout(() => {
      if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
        console.warn('[ws] Connection timed out — transitioning to offline');
        this.socket.close();
        // BUG-WS: 'reconnecting' instead of 'offline' — badge only shows after 30s
        this._setConnState('reconnecting');
        this._scheduleReconnect();
      }
    }, 5000);

    this.socket?.addEventListener('open', () => {
      clearTimeout(connectTimeout);
      console.log('[ws] Connected');
      this._reconnectDelay = this._baseDelay;
      this._reconnectCount = 0;
      this._lastConnectedAt = Date.now();
      // BUG-WS: Reset all failure tracking on successful connect
      this._firstFailureAt = null;
      clearTimeout(this._badgeTimer);
      this._badgeTimer = null;
      this._setConnState('connected');
      this._nextReconnectAt = null;
      this._expireOldQueue();
      this._replayOfflineEdits();
    });

    this.socket?.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this._handleMessage(msg);
    });

    this.socket?.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      if (!this._intentionalClose) {
        console.warn('[ws] Disconnected — scheduling reconnect...');
        this._setConnState('reconnecting');
        this._scheduleReconnect();
      }
    });

    this.socket?.addEventListener('error', () => {
      // error fires before close; close handler will reconnect
    });
  },

  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._badgeTimer);
    this._firstFailureAt = null;
    this._setConnState('offline');
    if (this.socket) this.socket.close();
    this.socket = null;
  },

  // Allow user to manually resume after going offline
  resumeReconnecting() {
    if (this._connState !== 'offline') return;
    this._intentionalClose = false;
    this._reconnectDelay = this._baseDelay;
    this._reconnectCount = 0;
    // BUG-WS: Reset all failure tracking so fresh 30s retry window
    this._firstFailureAt = null;
    clearTimeout(this._badgeTimer);
    this._badgeTimer = null;
    this._setConnState('reconnecting');
    this.connect();
  },

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._badgeTimer);

    // Record first failure timestamp on the first retry scheduling
    if (this._firstFailureAt === null) {
      this._firstFailureAt = Date.now();
      // Schedule the badge to show after 30s of total retries exhausted
      this._badgeTimer = setTimeout(() => {
        // Badge timer fired — all backoff retries exhausted, transition to offline
        this._setConnState('offline');
      }, this._badgeTimerDelay);
    }

    this._reconnectCount++;
    // 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s…
    const delay = Math.min(this._reconnectDelay, this._maxDelay);
    this._nextReconnectAt = Date.now() + delay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);

    this._reconnectTimer = setTimeout(() => {
      this._nextReconnectAt = null;
      this.connect();
    }, delay);
  },

  _setConnState(state) {
    this._connState = state;
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange(state, this._nextReconnectAt);
    }
  },

  // Expire queue entries older than 5 minutes when we reconnect
  async _expireOldQueue() {
    if (!this._currentProjectId) return;
    try {
      await _queueExpireOld(this._currentProjectId);
    } catch (e) {
      console.warn('[ws] _expireOldQueue failed:', e);
    }
  },

  // ── Phase 34+17.3: Replay with Lamport clock conflict resolution ─────────────
  async _replayOfflineEdits() {
    if (!this._currentProjectId) return;
    const count = await _queuePendingCount(this._currentProjectId);
    if (count === 0) return;

    if (this.onReplayStart) this.onReplayStart(count);

    // Step 1: Fetch server-side events that happened while we were offline.
    // Server returns events ordered by (created_at, lamport_clock) — the total order.
    const since = this._lastConnectedAt ? new Date(this._lastConnectedAt).toISOString() : null;

    let serverEvents = [];
    try {
      const res = await fetch(`/api/events/sync?project_id=${this._currentProjectId}${since ? `&since=${encodeURIComponent(since)}` : ''}`, {
        credentials: 'include',
      });
      if (res.ok) {
        let data;
        try { data = await res.json(); } catch {
          console.warn('[ws] /events/sync non-JSON, skipping');
          return;
        }
        serverEvents = data.events || [];
      }
    } catch (e) {
      console.warn('[ws] Failed to fetch server events for replay:', e);
    }

    // Build a conflict map: entity → latest server event (highest clock)
    // Loop 17.3: Lamport clock ordering — concurrent edits from different
    // clients to the same entity are ordered by clock value. The server event
    // already carries the authoritative clock, so we compare.
    const serverByEntity = new Map();
    for (const evt of serverEvents) {
      const key = `${evt.entity_type}:${evt.entity_id}`;
      const existing = serverByEntity.get(key);
      if (!existing || (evt.lamport_clock && (!existing.lamport_clock || evt.lamport_clock > existing.lamport_clock))) {
        serverByEntity.set(key, evt);
      }
    }

    // Step 2: Apply server events first (rebases local state)
    for (const evt of serverEvents) {
      if (this.onServerEvent) this.onServerEvent(evt);
    }

    // Step 3: Replay queued local edits with clock-based conflict detection
    const queued = await _queueDequeueAll(this._currentProjectId);
    const applied = [];
    const conflictEdits = [];

    for (const entry of queued) {
      const entityId = entry.payload._entityId || entry.payload.id;
      const entityType = entry.payload._entityType || entry.payload.entity_type;
      if (!entityId || !entityType) { applied.push(entry); continue; }

      const key = `${entityType}:${entityId}`;
      const serverEvt = serverByEntity.get(key);

      if (!serverEvt) {
        // No concurrent edit — safe to apply
        applied.push(entry);
      } else {
        // Concurrent edit detected. Compare Lamport clocks:
        // - If local edit has no clock OR local clock < server clock: server wins (our edit is older)
        // - If local clock > server clock: local wins (our edit is newer in total order)
        const localClock = entry.payload._lamportClock || 0;
        const serverClock = serverEvt.lamport_clock || 0;

        if (localClock > serverClock) {
          // Local edit is causally newer — apply it and flag the conflict for awareness
          applied.push(entry);
          conflictEdits.push({ entry, serverEvent: serverEvt });
        }
        // else: server's edit has higher/equal clock — it came after ours, skip local
      }
    }

    // Step 4: Handle conflicts with user (present as informational, not blocking)
    if (conflictEdits.length > 0 && this.onConflict) {
      const result = await this.onConflict(conflictEdits.map(ce => ({
        local: ce.entry.payload,
        server: ce.serverEvent.after_data || ce.serverEvent.payload,
        serverUser: ce.serverEvent.triggered_by || 'another user',
        entityId: ce.entry.payload._entityId || ce.entry.payload.id,
        entityType: ce.entry.payload._entityType || ce.entry.payload.entity_type,
        localClock: ce.entry.payload._lamportClock || 0,
        serverClock: ce.serverEvent.lamport_clock || 0,
      })));

      if (result.action === 'keep_local') {
        applied.push(...conflictEdits.map(ce => ce.entry));
      }
    }

    // Step 5: Replay all non-conflicting local edits via REST
    for (const entry of applied) {
      await this._sendOfflineEdit(entry.payload);
    }

    // Step 6: Log replay
    this._send({
      type: 'offline_replay',
      project_id: this._currentProjectId,
      applied_count: applied.length,
      conflict_count: conflictEdits.length,
    });

    if (this.onReplayDone) this.onReplayDone({ applied: applied.length, conflicts: conflictEdits.length });
  },

  // Sends a single offline edit via REST API (not WS — the server has no handler for these).
  // Queued edits carry _editType + _entityId so we know which endpoint to call.
  async _sendOfflineEdit(payload) {
    const type = payload._editType;
    const entityId = payload._entityId;
    if (!type || !entityId) return;

    try {
      if (type === 'element_update' || type === 'group_rotation') {
        const params = payload.parameters || {};
        await fetch(`/api/elements/${entityId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parameters: params }),
          credentials: 'include',
        });
      } else if (type === 'element_create') {
        await fetch('/api/elements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload._createData || payload),
          credentials: 'include',
        });
      } else if (type === 'element_delete') {
        await fetch(`/api/elements/${entityId}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      }
    } catch (e) {
      console.warn('[ws] offline edit send failed:', e);
    }
  },

  // ── Phase 34: Queueing while offline ────────────────────────────────────────
  async queueEdit(editPayload) {
    if (!this._currentProjectId) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // We are offline — enqueue the edit
      const result = await _queueEnqueue(this._currentProjectId, editPayload);
      if (!result.ok) {
        if (result.reason === 'queue_full') {
          if (this.onQueueWarning) this.onQueueWarning({ type: 'full', message: 'Offline edit queue is full. Connect to the network to continue editing.' });
        }
        return result;
      }
      if (result.warn) {
        const sizePct = Math.round((result.size / MAX_BYTES) * 100);
        if (this.onQueueWarning) this.onQueueWarning({ type: 'warn', message: `Offline queue is ${sizePct}% full (${Math.round(result.size / 1024)}KB / 10MB)`, size: result.size });
      }
      return result;
    }
    return { ok: true, queued: false }; // connected — normal send path
  },

  // ─── Outgoing ──────────────────────────────────────────────────────────────
  // Small in-memory queue for messages sent before socket opens (brief handshake window)
  _queue: [],

  _send(msg) {
    const text = JSON.stringify(msg);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text);
    } else {
      this._queue.push(text);
    }
  },

  // Wrap sendSelectionChange / sendGroupRotation / sendCursorPosition to also queue when offline
  // The public send* methods below all route through _queueOrSend
  _queueOrSend(msg) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      // Offline — queue as an offline edit with metadata for replay
      let entityType = null;
      if (msg.type === 'element_update' || msg.type === 'element_delete') entityType = 'element';
      else if (msg.type === 'level_update' || msg.type === 'level_delete') entityType = 'level';
      else if (msg.type === 'family_update' || msg.type === 'family_delete') entityType = 'family';

      const editPayload = {
        _editType: msg.type,
        _entityType: entityType,
        _entityId: msg.selectedId || (Array.isArray(msg.elementIds) ? msg.elementIds[0] : null),
        ...msg,
      };
      this.queueEdit(editPayload);
    }
  },

  _flushQueue() {
    while (this._queue.length && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(this._queue.shift());
    }
  },

  sendSelectionChange(selectedId) {
    this._send({ type: 'selection_change', selectedId });
  },

  // Broadcast a group rotation so collaborators see it live
  sendGroupRotation(elementIds, pivot, angleRad) {
    this._send({ type: 'group_rotation', elementIds, pivot, angleRad });
  },

  // Throttled cursor send — called on mousemove in the 3D viewport
  _lastCursorSend: 0,
  sendCursorPosition(position) {
    const now = Date.now();
    // Throttle to ~20 Hz to keep bandwidth sane
    if (now - this._lastCursorSend < 50) return;
    this._lastCursorSend = now;
    this._send({ type: 'cursor_move', position });
  },

  // ── Phase 8: Collaboration room methods ─────────────────────────────────────
  createRoom() {
    this._send({ type: 'create_room' });
  },

  joinRoom(roomCode) {
    if (!roomCode) return;
    this._send({ type: 'join_room', roomCode: roomCode.toUpperCase() });
  },

  leaveRoom() {
    if (!this.currentRoom) return;
    this._send({ type: 'leave_room' });
    this.currentRoom = null;
  },

  // Throttled camera sync — send at ~3 Hz (every 333ms) to room peers
  sendCameraSync(cameraData) {
    if (!this.currentRoom) return;
    const now = Date.now();
    if (now - (this._lastCameraSend || 0) < 333) return;
    this._lastCameraSend = now;
    this._send({ type: 'camera_sync', roomCode: this.currentRoom.code, ...cameraData });
  },

  // Send WebRTC signaling message to a specific peer (via server relay)
  sendWebRTCSignal(targetPeerId, signal) {
    if (!this.currentRoom) return;
    this._send({ type: 'webrtc_signal', roomCode: this.currentRoom.code, targetPeerId, signal });
  },

  // Request full room state (peer list) from host
  requestRoomSync() {
    if (!this.currentRoom) return;
    this._send({ type: 'room_sync', roomCode: this.currentRoom.code });
  },

  // ── Phase 24: Cross-device viewport handoff ──────────────────────────────
  // Identify this session to the server so it can route sibling messages
  identifyViewportSession(authUserId, projectId) {
    this._send({ type: 'viewport.identify', authUserId, projectId });
  },

  // Push current viewport state — debounced by viewport-manager.js (500ms)
  pushViewportState(state) {
    this._send({ type: 'viewport.push', state });
  },

  // Request live state from any sibling session of the same user on this project
  requestViewportPull() {
    this._send({ type: 'viewport.pull_request' });
  },

  // Respond to a pull request from another of our sessions
  respondViewportPull(targetSessionId, state) {
    this._send({ type: 'viewport.pull_response', targetSessionId, state });
  },

  // ── Phase 35: Live Session Methods ─────────────────────────────────────────
  // Join a live session channel (after getting sessionId from REST API)
  joinLiveSession(sessionId, userId, { isGuest = false, guestHandle = null, color = '#4a90d9' } = {}) {
    this._liveSession = { sessionId, userId, color, isGuest, guestHandle };
    this._send({ type: 'live.join', sessionId, userId, isGuest, guestHandle, color });
  },

  // Leave the current live session
  leaveLiveSession() {
    if (!this._liveSession) return;
    this._send({ type: 'live.leave' });
    this._liveSession = null;
  },

  // Send cursor position (throttled to ~30Hz client-side)
  sendLiveCursor(x, y, viewType = '3d') {
    if (!this._liveSession) return;
    const now = Date.now();
    if (now - this._liveDebounceCursor < 33) return;
    this._liveDebounceCursor = now;
    this._send({ type: 'live.cursor', x, y, viewType });
  },

  // Send current viewport state
  sendLiveViewport(state) {
    if (!this._liveSession) return;
    this._send({ type: 'live.viewport', state });
  },

  // Send current selection
  sendLiveSelection(elementId) {
    if (!this._liveSession) return;
    this._send({ type: 'live.selection', elementId });
  },

  // Follow another participant (pass null to unfollow)
  followLiveParticipant(targetUserId) {
    if (!this._liveSession) return;
    this._send({ type: 'live.follow', targetUserId });
  },

  // ─── Incoming ──────────────────────────────────────────────────────────────
  _handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.myUserId = msg.userId;
        this.myColor = msg.color;
        // Inject CSS variable for local user color
        document.documentElement.style.setProperty('--my-color', msg.color);
        this._updateMyAvatar(msg.color);
        console.log(`[ws] Assigned userId=${msg.userId} color=${msg.color}`);
        break;

      case 'presence_snapshot':
        if (this.onPresenceSnapshot) this.onPresenceSnapshot(msg.users);
        break;

      case 'selection_change':
        // Ignore echoes of our own selection
        if (msg.userId === this.myUserId) return;
        if (this.onRemoteSelection) this.onRemoteSelection(msg.userId, msg.color, msg.selectedId);
        break;

      case 'cursor_move':
        if (msg.userId === this.myUserId) return;
        if (this.onRemoteCursor) this.onRemoteCursor(msg.userId, msg.color, msg.position);
        break;

      case 'element_created':
        if (this.onElementCreated) this.onElementCreated(msg.payload);
        break;

      case 'element_updated':
        if (this.onElementUpdated) this.onElementUpdated(msg.payload);
        break;

      case 'element_deleted':
        if (this.onElementDeleted) this.onElementDeleted(msg.elementId);
        break;

      case 'level_updated':
        if (this.onLevelUpdated) this.onLevelUpdated(msg.payload);
        break;

      case 'level_created':
        if (this.onLevelCreated) this.onLevelCreated(msg.payload);
        break;

      case 'level_deleted':
        if (this.onLevelDeleted) this.onLevelDeleted(msg.levelId);
        break;

      case 'im_data_update':
        if (this.onIMUpdate) this.onIMUpdate(msg.event);
        break;

      case 'issue_created':
        if (this.onIssueCreated) this.onIssueCreated(msg.payload);
        break;

      case 'issue_status_changed':
        if (this.onIssueStatusChanged) this.onIssueStatusChanged(msg.payload);
        break;

      case 'issue_comment':
        if (this.onIssueComment) this.onIssueComment(msg.payload);
        break;

      case 'issue_deleted':
        if (this.onIssueDeleted) this.onIssueDeleted(msg.issueId);
        break;

      // Phase 3.1 — Doors + Windows
      case 'family_created':
        if (this.onFamilyCreated) this.onFamilyCreated(msg.payload);
        break;

      case 'family_updated':
        if (this.onFamilyUpdated) this.onFamilyUpdated(msg.payload);
        break;

      case 'family_deleted':
        if (this.onFamilyDeleted) this.onFamilyDeleted(msg.familyId);
        break;

      // Phase 4.2 — Annotations (real-time sync)
      case 'annotation_created':
        if (this.onAnnotationCreated) this.onAnnotationCreated(msg.annotation);
        break;

      case 'annotation_updated':
        if (this.onAnnotationUpdated) this.onAnnotationUpdated(msg.annotation);
        break;

      case 'annotation_deleted':
        if (this.onAnnotationDeleted) this.onAnnotationDeleted(msg.annotationId);
        break;

      // Phase 3.4 — Stairs + Railings
      case 'stair.created':
        if (this.onStairCreated) this.onStairCreated(msg.payload);
        break;
      case 'stair.updated':
        if (this.onStairUpdated) this.onStairUpdated(msg.payload);
        break;
      case 'stair.deleted':
        if (this.onStairDeleted) this.onStairDeleted(msg.payload);
        break;
      case 'railing.created':
        if (this.onRailingCreated) this.onRailingCreated(msg.payload);
        break;
      case 'railing.updated':
        if (this.onRailingUpdated) this.onRailingUpdated(msg.payload);
        break;
      case 'railing.deleted':
        if (this.onRailingDeleted) this.onRailingDeleted(msg.payload);
        break;

      // Phase 3.3 — Grids
      case 'grid.created':
        if (this.onGridCreated) this.onGridCreated(msg.payload);
        break;
      case 'grid.updated':
        if (this.onGridUpdated) this.onGridUpdated(msg.payload);
        break;
      case 'grid.deleted':
        if (this.onGridDeleted) this.onGridDeleted(msg.payload);
        break;

      // Phase 3.3 — Rooms
      case 'room.created':
        if (this.onRoomCreated) this.onRoomCreated(msg.payload);
        break;
      case 'room.updated':
        if (this.onRoomUpdated) this.onRoomUpdated(msg.payload);
        break;
      case 'room.deleted':
        if (this.onRoomDeleted) this.onRoomDeleted(msg.payload);
        break;

      // Phase 3.2 — Floors + Ceilings
      case 'floor.created':
        if (this.onFloorCreated) this.onFloorCreated(msg.payload);
        break;
      case 'floor.updated':
        if (this.onFloorUpdated) this.onFloorUpdated(msg.payload);
        break;
      case 'floor.deleted':
        if (this.onFloorDeleted) this.onFloorDeleted(msg.payload);
        break;
      case 'ceiling.created':
        if (this.onCeilingCreated) this.onCeilingCreated(msg.payload);
        break;
      case 'ceiling.updated':
        if (this.onCeilingUpdated) this.onCeilingUpdated(msg.payload);
        break;
      case 'ceiling.deleted':
        if (this.onCeilingDeleted) this.onCeilingDeleted(msg.payload);
        break;

      // Phase 22 — Curved Surfaces
      case 'curved_surface.created':
        if (this.onCurvedSurfaceCreated) this.onCurvedSurfaceCreated(msg.payload);
        break;
      case 'curved_surface.updated':
        if (this.onCurvedSurfaceUpdated) this.onCurvedSurfaceUpdated(msg.payload);
        break;
      case 'curved_surface.deleted':
        if (this.onCurvedSurfaceDeleted) this.onCurvedSurfaceDeleted(msg.payload);
        break;

      // Phase 8 — Collaboration rooms (Motif WebRTC shared viewport)
      case 'room_created':
        this.currentRoom = { code: msg.roomCode, isHost: true, peers: new Map() };
        if (this.onRoomCreated) this.onRoomCreated(msg.roomCode);
        break;

      case 'room_joined':
        this.currentRoom = { code: msg.roomCode, isHost: false, peers: new Map() };
        if (this.onRoomJoined) this.onRoomJoined(msg.roomCode);
        break;

      case 'room_error':
        if (this.onRoomError) this.onRoomError(msg.error);
        break;

      case 'room_peer_joined':
        if (this.currentRoom) this.currentRoom.peers.set(msg.peerId, { color: msg.peerColor });
        if (this.onRoomPeerJoined) this.onRoomPeerJoined(msg.peerId, msg.peerColor, msg.peerCount);
        break;

      case 'room_peer_left':
        if (this.currentRoom) this.currentRoom.peers.delete(msg.peerId);
        if (this.onRoomPeerLeft) this.onRoomPeerLeft(msg.peerId, msg.peerCount);
        break;

      case 'room_closed':
        this.currentRoom = null;
        if (this.onRoomClosed) this.onRoomClosed(msg.reason);
        break;

      case 'room_state':
        if (this.onRoomState) this.onRoomState({ roomCode: msg.roomCode, peers: msg.peers });
        break;

      case 'camera_sync':
        if (msg.peerId === this.myUserId) return;
        if (this.onCameraSync) this.onCameraSync(msg.peerId, msg.peerColor, {
          position: msg.position, target: msg.target, up: msg.up
        });
        break;

      case 'webrtc_signal':
        if (this.onWebRTCSignal) this.onWebRTCSignal(msg.fromPeerId, msg.signal);
        break;

      // Phase 25 — Forum
      case 'forum.thread_created':
        if (this.onForumThreadCreated) this.onForumThreadCreated(msg.thread);
        break;
      case 'forum.thread_updated':
        if (this.onForumStatusChanged) this.onForumStatusChanged(msg.threadId, msg.status);
        break;
      case 'forum.reply_created':
        if (this.onForumReplyCreated) this.onForumReplyCreated(msg.reply);
        break;
      case 'forum.status_changed':
        if (this.onForumStatusChanged) this.onForumStatusChanged(msg.threadId, msg.status);
        break;

      // Group rotation — live collaborator sync
      case 'group_rotation':
        if (this.onGroupRotation) this.onGroupRotation(msg.elementIds, msg.pivot, msg.angleRad);
        break;

      // Phase 24 — Cross-device viewport handoff
      case 'viewport.sibling_state':
        if (this.onViewportSiblingState) this.onViewportSiblingState(msg.state, msg.fromSessionId);
        break;

      case 'viewport.pull_requested':
        // Another of our sessions wants our current state
        if (this.onViewportPullRequested) this.onViewportPullRequested(msg.requestingSessionId);
        break;

      // ── Phase 35: Live Session Messages ──────────────────────────────────
      case 'live.joined':
        if (this.onLiveJoined) this.onLiveJoined(msg.sessionId, msg.participants, msg.myColor, msg.myUserId);
        break;

      case 'live.participant_joined':
        if (this.onLiveParticipantJoined) this.onLiveParticipantJoined(msg.userId, msg.isGuest, msg.guestHandle, msg.color);
        break;

      case 'live.participant_left':
        if (this.onLiveParticipantLeft) this.onLiveParticipantLeft(msg.userId, msg.color, msg.participantCount);
        break;

      case 'live.cursor':
        if (this.onLiveCursor) this.onLiveCursor(msg.userId, msg.color, msg.guestHandle, msg.x, msg.y, msg.viewType);
        break;

      case 'live.viewport':
        if (this.onLiveViewport) this.onLiveViewport(msg.userId, msg.color, msg.viewportState);
        break;

      case 'live.selection':
        if (msg.userId === this.myUserId) return;
        if (this.onLiveSelection) this.onLiveSelection(msg.userId, msg.color, msg.guestHandle, msg.elementId);
        break;

      case 'live.follow_update':
        if (this.onLiveFollowUpdate) this.onLiveFollowUpdate(msg.userId, msg.targetUserId);
        break;
    }
  },

  _updateMyAvatar(color) {
    const dot = document.getElementById('my-presence-dot');
    if (dot) dot.style.background = color;
  },
};
