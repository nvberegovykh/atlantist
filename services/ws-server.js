/**
 * Owns: WebSocket server lifecycle, room subscription management, event broadcasting, presence tracking.
 * Does NOT own: HTTP routing, DB access, DAG solver logic, auth.
 *
 * Architecture: Phase 2.1 used a single shared room. Phase 8 adds named rooms for WebRTC
 * collaboration sessions (Motif-style shared viewport). Room code = 6-char alphanumeric.
 * Phase 35 adds live session channels (live:<session_id>) for real-time multi-user
 * BIM collaboration with ghost cursors, selection echo, and viewport sync at 30Hz.
 *
 * Room message flow:
 *   1. Host creates room → receives room code, clients notified via 'room_created'
 *   2. Client joins via code → server broadcasts 'room_joined' to room peers
 *   3. Camera sync: clients send 'camera_sync' → server relays to room peers
 *   4. PeerJS uses WebSocket for signaling (SDP/ICE) via 'webrtc_signal' messages
 *   5. DataChannel: camera positions, selection highlights, presence
 *
 * Live session flow:
 *   1. Client calls REST /api/live-sessions → gets session_id + share_token
 *   2. Client joins live session via WS 'live.join' with session_id + user context
 *   3. Server subscribes client to 'live:<session_id>' channel, broadcasts participant joined
 *   4. Client sends cursor/viewport/selection at ~30Hz; server debounces and relays
 *   5. On disconnect, server removes client from channel and broadcasts participant left
 */
const { WebSocketServer } = require('ws');
const { upsertViewportState } = require('../db/viewport-states');
const {
  upsertParticipant,
  updateParticipantCursor,
  updateParticipantViewport,
  removeParticipant,
  getSessionById,
} = require('../db/live-sessions');

// ─── User colors ──────────────────────────────────────────────────────────────
// Deterministic palette — assigned by slot index, recycled when slots free.
const USER_COLORS = [
  '#4a90d9', '#e85d4a', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e74c3c', '#3498db',
];

let colorSlot = 0;
// ws → { userId, color, selectedId, authUserId, projectId }
// authUserId is the DB app_users.id (sent by client after auth); projectId is current BIM project
const clientMeta = new Map();

// ─── Collaboration Rooms (Phase 8 — Motif-style WebRTC shared viewport) ─────────
// Map: roomCode (6-char) → { hostWs, peers: Map<ws, {userId, color, selectedId}> }
const rooms = new Map();

// ─── Live Session Channels (Phase 35 — real-time multi-user BIM) ───────────────
// Map: sessionId (int) → { clients: Map<ws, meta>, lastCursorBroadcast: timestamp }
// 30Hz debounce: only relay cursor if >33ms since last broadcast per session
const liveChannels = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Broadcasts a message to all peers in a room (optionally excluding one)
function broadcastToRoom(roomCode, msg, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const [peerWs, meta] of room.peers) {
    if (peerWs !== excludeWs && peerWs.readyState === 1) {
      try { peerWs.send(text); } catch (_) { /* ignore */ }
    }
  }
  // Also send to host
  if (room.hostWs && room.hostWs !== excludeWs && room.hostWs.readyState === 1) {
    try { room.hostWs.send(text); } catch (_) { /* ignore */ }
  }
}

function getRoomPeerCount(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return 0;
  return 1 + room.peers.size; // host + peers
}

// ─── Live Session Channel Helpers ──────────────────────────────────────────
// Broadcast to all clients in a live session channel (optionally excluding one)
function broadcastToLiveChannel(sessionId, msg, excludeWs = null) {
  const channel = liveChannels.get(sessionId);
  if (!channel) return;
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const [peerWs, _pMeta] of channel.clients) {
    if (peerWs !== excludeWs && peerWs.readyState === 1) {
      try { peerWs.send(text); } catch (_) { /* ignore */ }
    }
  }
}

function leaveLiveSession(ws, sessionId, userId, color) {
  const channel = liveChannels.get(sessionId);
  if (!channel) return;

  channel.clients.delete(ws);

  broadcastToLiveChannel(sessionId, {
    type: 'live.participant_left',
    userId,
    color,
    participantCount: channel.clients.size,
  });

  removeParticipant(sessionId, userId).catch(() => {});

  // Clean up empty channels
  if (channel.clients.size === 0) {
    liveChannels.delete(sessionId);
  }
}

function nextColor() {
  const c = USER_COLORS[colorSlot % USER_COLORS.length];
  colorSlot++;
  return c;
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
// Sends msg (already serialized JSON) to every connected client except `exclude`.
// WARNING: broadcasts to ALL projects. Use broadcastToProject for scoped sends.
function broadcast(msg, exclude = null) {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const [client] of clientMeta) {
    if (client !== exclude && client.readyState === 1 /* OPEN */) {
      try { client.send(text); } catch (_) { /* ignore dead socket */ }
    }
  }
}

// Project-scoped broadcast: only sends to clients in the same project.
// Prevents cross-project WebSocket leaks. Falls back to full broadcast if projectId not set.
function broadcastToProject(projectId, msg, exclude = null) {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const [client, meta] of clientMeta) {
    if (client === exclude || client.readyState !== 1) continue;
    // No projectId registered → global broadcast (legacy fallback)
    if (!meta.projectId) { try { client.send(text); } catch (_) {} continue; }
    // Same project → send
    if (String(meta.projectId) === String(projectId)) {
      try { client.send(text); } catch (_) {}
    }
  }
}

// Sends the current presence list to all connected clients.
function broadcastPresence() {
  const users = [];
  for (const [, meta] of clientMeta) {
    users.push({ userId: meta.userId, color: meta.color, selectedId: meta.selectedId });
  }
  broadcast({ type: 'presence_snapshot', users });
}

// ─── Public broadcast helpers (called from routes after DB writes) ─────────────
function broadcastEvent(event) {
  broadcast({ type: 'model_event', event });
}

function broadcastElementUpdate(payload) {
  broadcast({ type: 'element_updated', payload });
}

function broadcastElementCreated(payload) {
  broadcast({ type: 'element_created', payload });
}

function broadcastElementDeleted(elementId) {
  broadcast({ type: 'element_deleted', elementId });
}

function broadcastLevelUpdate(payload) {
  broadcast({ type: 'level_updated', payload });
}

function broadcastLevelCreated(payload) {
  broadcast({ type: 'level_created', payload });
}

function broadcastLevelDeleted(levelId) {
  broadcast({ type: 'level_deleted', levelId });
}

// ─── DAG cascade broadcast helpers ──────────────────────────────────────────
// Called after async DAG recalc completes — broadcasts updated element list
// to clients in the same project so their 3D view updates in real-time.
// Falls back to global broadcast if projectId not provided.
function broadcastDAGRecalcComplete(projectId, levelId, updatedElements) {
  broadcastToProject(projectId, {
    type: 'dag_recalc_complete',
    levelId,
    updatedElements: updatedElements.map(el => ({
      id: el.id,
      type: el.type,
      computed: el.computed,
    })),
  });
}

// ─── IM data sync broadcast (IM-C) ─────────────────────────────────────────
// Broadcasts IM data change events to same-project clients after server sync.
function broadcastIMUpdate(projectId, event) {
  broadcastToProject(projectId, {
    type: 'im_data_update',
    event: {
      id: event.id,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      event_type: event.event_type,
      after_data: event.after_data,
      triggered_by: event.triggered_by,
      created_at: event.created_at,
    }
  });
}

function broadcastElementUpdate(payload) {
  broadcast({ type: 'element_updated', payload });
}

// ─── Family instance broadcast helpers ────────────────────────────────────
function broadcastFamilyCreated(payload) {
  broadcast({ type: 'family_created', payload });
}

function broadcastFamilyUpdated(payload) {
  broadcast({ type: 'family_updated', payload });
}

function broadcastFamilyDeleted(familyId) {
  broadcast({ type: 'family_deleted', familyId });
}

// ─── Issue broadcast helpers ───────────────────────────────────────────────
function broadcastIssueCreated(payload) {
  broadcast({ type: 'issue_created', payload });
}

function broadcastIssueStatusChanged(payload) {
  broadcast({ type: 'issue_status_changed', payload });
}

function broadcastIssueComment(payload) {
  broadcast({ type: 'issue_comment', payload });
}

function broadcastIssueDeleted(issueId) {
  broadcast({ type: 'issue_deleted', issueId });
}

// ─── Annotation broadcast helpers (Phase 4.2) ────────────────────────────────
function broadcastAnnotationCreated(annotation) {
  broadcast({ type: 'annotation_created', annotation });
}

function broadcastAnnotationUpdated(annotation) {
  broadcast({ type: 'annotation_updated', annotation });
}

function broadcastAnnotationDeleted(annotationId) {
  broadcast({ type: 'annotation_deleted', annotationId });
}

// ─── Stair + Railing broadcast helpers (Phase 3.4) ─────────────────────────
function broadcastStairCreated(payload) {
  broadcast({ type: 'stair.created', payload });
}
function broadcastStairUpdated(payload) {
  broadcast({ type: 'stair.updated', payload });
}
function broadcastStairDeleted(payload) {
  broadcast({ type: 'stair.deleted', payload });
}
function broadcastRailingCreated(payload) {
  broadcast({ type: 'railing.created', payload });
}
function broadcastRailingUpdated(payload) {
  broadcast({ type: 'railing.updated', payload });
}
function broadcastRailingDeleted(payload) {
  broadcast({ type: 'railing.deleted', payload });
}

// ─── Floor + Ceiling broadcast helpers (Phase 3.2) ──────────────────────────
function broadcastFloorCreated(payload) {
  broadcast({ type: 'floor.created', payload });
}
function broadcastFloorUpdated(payload) {
  broadcast({ type: 'floor.updated', payload });
}
function broadcastFloorDeleted(payload) {
  broadcast({ type: 'floor.deleted', payload });
}
function broadcastCeilingCreated(payload) {
  broadcast({ type: 'ceiling.created', payload });
}
function broadcastCeilingUpdated(payload) {
  broadcast({ type: 'ceiling.updated', payload });
}
function broadcastCeilingDeleted(payload) {
  broadcast({ type: 'ceiling.deleted', payload });
}

// ─── Curved Surface broadcast helpers (Phase 22) ──────────────────────────────
function broadcastCurvedSurfaceCreated(payload) {
  broadcast({ type: 'curved_surface.created', payload });
}
function broadcastCurvedSurfaceUpdated(payload) {
  broadcast({ type: 'curved_surface.updated', payload });
}
function broadcastCurvedSurfaceDeleted(payload) {
  broadcast({ type: 'curved_surface.deleted', payload });
}

// ─── Grid + Room broadcast helpers (Phase 3.3) ───────────────────────────────
function broadcastGridCreated(payload) {
  broadcast({ type: 'grid.created', payload });
}
function broadcastGridUpdated(payload) {
  broadcast({ type: 'grid.updated', payload });
}
function broadcastGridDeleted(payload) {
  broadcast({ type: 'grid.deleted', payload });
}
function broadcastRoomCreated(payload) {
  broadcast({ type: 'room.created', payload });
}
function broadcastRoomUpdated(payload) {
  broadcast({ type: 'room.updated', payload });
}
function broadcastRoomDeleted(payload) {
  broadcast({ type: 'room.deleted', payload });
}

// ─── Forum broadcast helpers (Phase 25) ────────────────────────────────────────
function broadcastForumThreadCreated(thread) {
  broadcast({ type: 'forum.thread_created', thread });
}
function broadcastForumThreadUpdated(thread) {
  broadcast({ type: 'forum.thread_updated', thread });
}
function broadcastForumReplyCreated(reply) {
  broadcast({ type: 'forum.reply_created', reply });
}
function broadcastForumStatusChanged(threadId, status) {
  broadcast({ type: 'forum.status_changed', threadId, status });
}

// ─── Server setup ─────────────────────────────────────────────────────────────
function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const userId = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const color = nextColor();
    clientMeta.set(ws, { userId, color, selectedId: null });

    // Send welcome: assign identity + full presence snapshot
    ws.send(JSON.stringify({ type: 'welcome', userId, color }));
    broadcastPresence();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'cursor_move') {
        // Relay cursor position to all others — don't store, high-frequency
        broadcast({ type: 'cursor_move', userId, color, position: msg.position }, ws);
        return;
      }

      if (msg.type === 'selection_change') {
        // Store and broadcast selection
        const meta = clientMeta.get(ws);
        if (meta) meta.selectedId = msg.selectedId;
        broadcast({ type: 'selection_change', userId, color, selectedId: msg.selectedId }, ws);
        return;
      }

      // Group rotation — relay to all other clients so collaborators see it live
      if (msg.type === 'group_rotation') {
        broadcast({ type: 'group_rotation', userId, elementIds: msg.elementIds, pivot: msg.pivot, angleRad: msg.angleRad }, ws);
        return;
      }

      // ── Phase 8: Collaboration room messages ─────────────────────────────────
      if (msg.type === 'create_room') {
        const meta = clientMeta.get(ws);
        if (!meta) return;
        let code = generateRoomCode();
        while (rooms.has(code)) code = generateRoomCode();
        rooms.set(code, { hostWs: ws, peers: new Map(), createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'room_created', roomCode: code }));
        return;
      }

      if (msg.type === 'join_room') {
        const meta = clientMeta.get(ws);
        if (!meta || !msg.roomCode) return;
        const code = msg.roomCode.toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'room_error', error: 'Room not found' }));
          return;
        }
        // Add to room peer list
        room.peers.set(ws, { userId, color, selectedId: null });
        // Notify host about new peer
        ws.send(JSON.stringify({ type: 'room_joined', roomCode: code }));
        if (room.hostWs && room.hostWs.readyState === 1) {
          room.hostWs.send(JSON.stringify({
            type: 'room_peer_joined', peerId: userId, peerColor: color, peerCount: getRoomPeerCount(code)
          }));
        }
        // Notify all other peers
        broadcastToRoom(code, { type: 'room_peer_joined', peerId: userId, peerColor: color, peerCount: getRoomPeerCount(code) }, ws);
        return;
      }

      if (msg.type === 'leave_room') {
        const meta = clientMeta.get(ws);
        if (!meta) return;
        // Find which room this ws is in
        for (const [code, room] of rooms) {
          if (room.hostWs === ws) {
            // Host leaving — close the room
            broadcastToRoom(code, { type: 'room_closed', reason: 'Host left' });
            rooms.delete(code);
            break;
          }
          if (room.peers.has(ws)) {
            room.peers.delete(ws);
            broadcastToRoom(code, { type: 'room_peer_left', peerId: userId, peerCount: getRoomPeerCount(code) }, ws);
            break;
          }
        }
        return;
      }

      if (msg.type === 'camera_sync') {
        // Relay camera position to all room peers at ~2-5 Hz
        if (!msg.roomCode) return;
        broadcastToRoom(msg.roomCode, {
          type: 'camera_sync', peerId: userId, peerColor: color,
          position: msg.position, target: msg.target, up: msg.up
        }, ws);
        return;
      }

      if (msg.type === 'webrtc_signal') {
        // Relay WebRTC signaling messages between room members
        if (!msg.roomCode || !msg.targetPeerId) return;
        const room = rooms.get(msg.roomCode);
        if (!room) return;
        const signal = { type: 'webrtc_signal', fromPeerId: userId, signal: msg.signal };
        // Send to specific peer
        for (const [peerWs, peerMeta] of room.peers) {
          if (peerMeta.userId === msg.targetPeerId && peerWs.readyState === 1) {
            peerWs.send(JSON.stringify(signal));
            return;
          }
        }
        // Send to host if targeting host
        if (room.hostWs && room.hostWs !== ws && userId !== msg.targetPeerId) {
          room.hostWs.send(JSON.stringify(signal));
        }
        return;
      }

      if (msg.type === 'room_sync') {
        // Request full room state sync (camera, peers) from host
        if (!msg.roomCode) return;
        const room = rooms.get(msg.roomCode);
        if (!room || room.hostWs !== ws) return;
        // Send current peer list to the requester
        const peers = [];
        for (const [peerWs, peerMeta] of room.peers) {
          peers.push({ userId: peerMeta.userId, color: peerMeta.color });
        }
        ws.send(JSON.stringify({ type: 'room_state', roomCode: msg.roomCode, peers }));
        return;
      }

      // ── Phase 24: Cross-device viewport handoff ──────────────────────────────
      // Client identifies its auth user + current project so we can target sibling sessions
      if (msg.type === 'viewport.identify') {
        const meta = clientMeta.get(ws);
        if (meta) {
          meta.authUserId = msg.authUserId || null;
          meta.projectId = msg.projectId || null;
        }
        return;
      }

      // Client pushes current viewport state → persist to DB + relay to sibling sessions
      if (msg.type === 'viewport.push') {
        const meta = clientMeta.get(ws);
        if (!meta || !msg.state) return;

        // Persist to DB (fire-and-forget; non-blocking for WS latency)
        if (meta.authUserId && meta.projectId) {
          upsertViewportState(meta.authUserId, meta.projectId, msg.state).catch(() => {});
        }

        // Relay to all other sessions of the same authenticated user on the same project
        // so a second device connected simultaneously sees a "Continue here" prompt
        if (meta.authUserId && meta.projectId) {
          const stateMsg = JSON.stringify({
            type: 'viewport.sibling_state',
            state: msg.state,
            fromSessionId: userId,
          });
          for (const [peerWs, peerMeta] of clientMeta) {
            if (
              peerWs !== ws &&
              peerMeta.authUserId === meta.authUserId &&
              peerMeta.projectId === meta.projectId &&
              peerWs.readyState === 1
            ) {
              try { peerWs.send(stateMsg); } catch (_) {}
            }
          }
        }
        return;
      }

      // Client requests live state pull from sibling session (stretch: live handoff pill)
      if (msg.type === 'viewport.pull_request') {
        const meta = clientMeta.get(ws);
        if (!meta || !meta.authUserId || !meta.projectId) return;

        // Ask sibling sessions to send their current state back to the requester
        const pullMsg = JSON.stringify({
          type: 'viewport.pull_requested',
          requestingSessionId: userId,
        });
        for (const [peerWs, peerMeta] of clientMeta) {
          if (
            peerWs !== ws &&
            peerMeta.authUserId === meta.authUserId &&
            peerMeta.projectId === meta.projectId &&
            peerWs.readyState === 1
          ) {
            try { peerWs.send(pullMsg); } catch (_) {}
          }
        }
        return;
      }

      // Sibling responds to pull request — relay its current state to the requester
      if (msg.type === 'viewport.pull_response') {
        if (!msg.targetSessionId || !msg.state) return;
        // Find the requesting session by userId
        for (const [peerWs, peerMeta] of clientMeta) {
          if (peerMeta.userId === msg.targetSessionId && peerWs.readyState === 1) {
            try {
              peerWs.send(JSON.stringify({
                type: 'viewport.sibling_state',
                state: msg.state,
                fromSessionId: userId,
              }));
            } catch (_) {}
            break;
          }
        }
        return;
      }

      // ── Phase 35: Live Session Channels ─────────────────────────────────────
      // Client joins a live session channel (live:<session_id>)
      if (msg.type === 'live.join') {
        const meta = clientMeta.get(ws);
        if (!msg.sessionId || !msg.userId) return;

        const sessionId = parseInt(msg.sessionId, 10);
        if (!liveChannels.has(sessionId)) {
          liveChannels.set(sessionId, { clients: new Map(), lastCursorBroadcast: 0 });
        }
        const channel = liveChannels.get(sessionId);

        // Store session context on the ws meta
        meta.liveSessionId = sessionId;
        meta.liveUserId = msg.userId;
        meta.liveIsGuest = msg.isGuest || false;
        meta.liveGuestHandle = msg.guestHandle || null;
        meta.liveColor = msg.color || '#4a90d9';
        meta.liveCursorX = null;
        meta.liveCursorY = null;

        channel.clients.set(ws, {
          userId: msg.userId,
          isGuest: msg.isGuest || false,
          guestHandle: msg.guestHandle || null,
          color: msg.color || '#4a90d9',
          cursorX: null,
          cursorY: null,
          selectionId: null,
          followTarget: null, // userId of followed participant
        });

        // Persist participant to DB (fire-and-forget)
        upsertParticipant({
          sessionId,
          userId: msg.userId,
          isGuest: msg.isGuest || false,
          guestHandle: msg.guestHandle || null,
          color: msg.color || '#4a90d9',
        }).catch(() => {});

        // Build participant list for the join acknowledgement
        const participants = [];
        for (const [, pMeta] of channel.clients) {
          participants.push({
            userId: pMeta.userId,
            isGuest: pMeta.isGuest,
            guestHandle: pMeta.guestHandle,
            color: pMeta.color,
          });
        }

        ws.send(JSON.stringify({
          type: 'live.joined',
          sessionId,
          participants,
          myColor: meta.liveColor,
          myUserId: msg.userId,
        }));

        // Broadcast participant joined to others in the channel
        broadcastToLiveChannel(sessionId, {
          type: 'live.participant_joined',
          userId: msg.userId,
          isGuest: msg.isGuest || false,
          guestHandle: msg.guestHandle || null,
          color: msg.color || '#4a90d9',
        }, ws);

        return;
      }

      // Client sends cursor position — 30Hz debounce
      if (msg.type === 'live.cursor') {
        const meta = clientMeta.get(ws);
        if (!meta.liveSessionId || !ws._ws || ws._ws.readyState !== 1) return;
        const channel = liveChannels.get(meta.liveSessionId);
        if (!channel) return;

        // 30Hz = 33ms minimum between broadcasts
        const now = Date.now();
        if (now - channel.lastCursorBroadcast < 33) return;
        channel.lastCursorBroadcast = now;

        const pMeta = channel.clients.get(ws);
        if (pMeta) {
          pMeta.cursorX = msg.x;
          pMeta.cursorY = msg.y;
        }

        broadcastToLiveChannel(meta.liveSessionId, {
          type: 'live.cursor',
          userId: meta.liveUserId,
          color: meta.liveColor,
          guestHandle: meta.liveGuestHandle,
          x: msg.x,
          y: msg.y,
          viewType: msg.viewType, // '3d' | 'plan' | 'section'
        }, ws);

        // Persist cursor to DB every ~5s (batch updates)
        if (!channel._lastCursorPersist || now - channel._lastCursorPersist > 5000) {
          channel._lastCursorPersist = now;
          updateParticipantCursor(meta.liveSessionId, meta.liveUserId, msg.x, msg.y).catch(() => {});
        }
        return;
      }

      // Client sends viewport state update
      if (msg.type === 'live.viewport') {
        const meta = clientMeta.get(ws);
        if (!meta.liveSessionId || !msg.state) return;

        broadcastToLiveChannel(meta.liveSessionId, {
          type: 'live.viewport',
          userId: meta.liveUserId,
          color: meta.liveColor,
          viewportState: msg.state,
        }, ws);

        updateParticipantViewport(meta.liveSessionId, meta.liveUserId, msg.state).catch(() => {});
        return;
      }

      // Client sends selection change
      if (msg.type === 'live.selection') {
        const meta = clientMeta.get(ws);
        if (!meta.liveSessionId) return;
        const channel = liveChannels.get(meta.liveSessionId);
        if (!channel) return;

        const pMeta = channel.clients.get(ws);
        if (pMeta) pMeta.selectionId = msg.elementId;

        broadcastToLiveChannel(meta.liveSessionId, {
          type: 'live.selection',
          userId: meta.liveUserId,
          color: meta.liveColor,
          guestHandle: meta.liveGuestHandle,
          elementId: msg.elementId,
        }, ws);
        return;
      }

      // Client requests to follow another participant's viewport
      if (msg.type === 'live.follow') {
        const meta = clientMeta.get(ws);
        if (!meta.liveSessionId) return;
        const channel = liveChannels.get(meta.liveSessionId);
        if (!channel) return;

        const pMeta = channel.clients.get(ws);
        if (pMeta) pMeta.followTarget = msg.targetUserId || null;

        broadcastToLiveChannel(meta.liveSessionId, {
          type: 'live.follow_update',
          userId: meta.liveUserId,
          targetUserId: msg.targetUserId,
        }, ws);
        return;
      }

      // Client leaves a live session
      if (msg.type === 'live.leave') {
        const meta = clientMeta.get(ws);
        if (!meta.liveSessionId) return;

        const sessionId = meta.liveSessionId;
        const userId = meta.liveUserId;
        const color = meta.liveColor;

        leaveLiveSession(ws, sessionId, userId, color);
        meta.liveSessionId = null;
        meta.liveUserId = null;
        return;
      }
    });

    ws.on('close', () => {
      // Clean up live session if joined
      const meta = clientMeta.get(ws);
      if (meta && meta.liveSessionId) {
        leaveLiveSession(ws, meta.liveSessionId, meta.liveUserId, meta.liveColor);
      }
      clientMeta.delete(ws);
      broadcastPresence();

      // Clean up collaboration rooms (Phase 8)
      for (const [code, room] of rooms) {
        if (room.hostWs === ws) {
          broadcastToRoom(code, { type: 'room_closed', reason: 'Host disconnected' });
          rooms.delete(code);
        } else if (room.peers.has(ws)) {
          const meta = room.peers.get(ws);
          room.peers.delete(ws);
          broadcastToRoom(code, { type: 'room_peer_left', peerId: meta.userId, peerCount: getRoomPeerCount(code) }, ws);
        }
      }
    });

    ws.on('error', () => {
      clientMeta.delete(ws);
    });
  });

  console.log('[ws] WebSocket server attached at /ws');
  return wss;
}

module.exports = {
  attach,
  broadcast,
  broadcastToProject,
  broadcastEvent,
  broadcastDAGRecalcComplete,
  broadcastIMUpdate,
  broadcastElementUpdate,
  broadcastElementCreated,
  broadcastElementDeleted,
  broadcastLevelUpdate,
  broadcastLevelCreated,
  broadcastLevelDeleted,
  broadcastFamilyCreated,
  broadcastFamilyUpdated,
  broadcastFamilyDeleted,
  broadcastIssueCreated,
  broadcastIssueStatusChanged,
  broadcastIssueComment,
  broadcastIssueDeleted,
  broadcastAnnotationCreated,
  broadcastAnnotationUpdated,
  broadcastAnnotationDeleted,
  broadcastStairCreated,
  broadcastStairUpdated,
  broadcastStairDeleted,
  broadcastRailingCreated,
  broadcastRailingUpdated,
  broadcastRailingDeleted,
  broadcastGridCreated,
  broadcastGridUpdated,
  broadcastGridDeleted,
  broadcastRoomCreated,
  broadcastRoomUpdated,
  broadcastRoomDeleted,
  broadcastFloorCreated,
  broadcastFloorUpdated,
  broadcastFloorDeleted,
  broadcastCeilingCreated,
  broadcastCeilingUpdated,
  broadcastCeilingDeleted,
  broadcastCurvedSurfaceCreated,
  broadcastCurvedSurfaceUpdated,
  broadcastCurvedSurfaceDeleted,
  broadcastForumThreadCreated,
  broadcastForumThreadUpdated,
  broadcastForumReplyCreated,
  broadcastForumStatusChanged,
};
