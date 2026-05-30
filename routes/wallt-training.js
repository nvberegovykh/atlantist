/**
 * Owns: /api/wallt/training/* — Nikita's Personal Training Room.
 * Does NOT own: Wallt main chat (routes/wallt.js), personality engine.
 *
 * Five control modes:
 *   1. Scope Config   — spending limits, vendor lists, escalation thresholds, capability flags
 *   2. Direct Training — private 1:1 chat with Wallt, full transcript logged
 *   3. Emergency Stop  — immediate Wallt halt (kill switch)
 *   4. State Recovery  — restore from checkpoints
 *   5. Env Monitor     — live telemetry of Wallt runtime
 *
 * All data is scoped to the authenticated owner only.
 * Auth: authMiddleware middleware (first user = owner for single-user deploys).
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const OpenAI = require('openai');
const {
  getScopeConfig, upsertScopeConfig, listScopeConfigs, getScopeHistory,
  getActiveMemory, upsertMemory, deactivateMemory, listMemoryKeys,
  startTrainingSession, endTrainingSession, addTrainingTurn, getSessionTranscript, listTrainingSessions, getOpenSession,
  logKillSwitchStop, logKillSwitchResume, getKillSwitchHistory, isWalltFrozen, getWalltFrozenState,
  createCheckpoint, listCheckpoints, getCheckpointById, deleteCheckpoint,
  logBoundaryEvent, listBoundaryEvents, resolveBoundaryEvent,
  getTrainingStats,
} = require('../db/wallt-training');
const { buildSystemPrompt, validate, PERSONA_VERSION } = require('../lib/wallt/persona');
const { WALLT_TOOLS, parseToolCalls } = require('../lib/wallt/actions');

function getAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
}

// Read scope config from DB and merge into training memory block
async function buildTrainingSystemSupplement(ownerUserId) {
  const [configs, memory] = await Promise.all([
    listScopeConfigs(ownerUserId),
    getActiveMemory(ownerUserId),
  ]);

  const lines = [];

  if (configs.length) {
    lines.push('\n## Nikita Scope Configuration (Training Room — immediate effect)');
    for (const c of configs) {
      const key = c.config_key.replace(/_/g, ' ');
      lines.push(`**${key}**: ${JSON.stringify(c.config_value)}`);
    }
  }

  if (memory.length) {
    lines.push('\n## Wallt Training Memory (authoritative rules from Nikita)');
    for (const m of memory) {
      const key = m.memory_key.replace(/_/g, ' ');
      lines.push(`**${key}** [${m.confidence}]: ${JSON.stringify(m.memory_value)}`);
    }
  }

  return lines.join('\n');
}

// Also expose the merged block for Mode 5 telemetry
async function getWalltRuntimeContext(ownerUserId) {
  const [configs, memory, frozen, recentBoundary] = await Promise.all([
    listScopeConfigs(ownerUserId),
    getActiveMemory(ownerUserId),
    getWalltFrozenState(ownerUserId),
    listBoundaryEvents(ownerUserId, 10),
  ]);

  const scopeMap = {};
  for (const c of configs) scopeMap[c.config_key] = c.config_value;

  return {
    is_frozen: !!frozen,
    freeze_details: frozen || null,
    scope_configs: scopeMap,
    active_memory_count: memory.length,
    memory_entries: memory.map(m => ({ key: m.memory_key, value: m.memory_value, confidence: m.confidence })),
    recent_boundary_events: recentBoundary.slice(0, 5),
  };
}

// ── GET /api/wallt/training — dashboard data ─────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const [frozen, stats, scopes, checkpoints] = await Promise.all([
      isWalltFrozen(ownerId),
      getTrainingStats(ownerId),
      listScopeConfigs(ownerId),
      listCheckpoints(ownerId, 5),
    ]);
    res.json({
      is_frozen: !!frozen,
      freeze_id: frozen?.id || null,
      stats,
      scope_keys: [...new Set(scopes.map(s => s.config_key))],
      recent_checkpoints: checkpoints,
    });
  } catch (err) {
    console.error('[wallt-training] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to load training room' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MODE 1 — Scope Configuration
// GET /api/wallt/training/scope          → list current config
// PUT /api/wallt/training/scope          → upsert config (reason required)
// GET /api/wallt/training/scope/:key    → current value + history
// GET /api/wallt/training/scope/:key/history → change history
// ══════════════════════════════════════════════════════════════════════════════

router.get('/scope', authMiddleware, async (req, res) => {
  try {
    const configs = await listScopeConfigs(req.user.id);
    res.json({ configs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/scope/:key', authMiddleware, async (req, res) => {
  try {
    const current = await getScopeConfig(req.user.id, req.params.key);
    const history = await getScopeHistory(req.user.id, req.params.key);
    res.json({ current, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/scope/:key/history', authMiddleware, async (req, res) => {
  try {
    const history = await getScopeHistory(req.user.id, req.params.key, 50);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/scope', authMiddleware, async (req, res) => {
  try {
    const { config_key, config_value, reason } = req.body;
    if (!config_key) return res.status(400).json({ error: 'config_key is required' });
    if (config_value === undefined) return res.status(400).json({ error: 'config_value is required' });

    // Get previous value for audit
    const prev = await getScopeConfig(req.user.id, config_key);
    const audit_note = reason || (prev ? `Updated from ${JSON.stringify(prev.config_value)}` : 'Initial config');

    const result = await upsertScopeConfig(
      req.user.id, config_key,
      typeof config_value === 'string' ? config_value : config_value,
      audit_note
    );

    // Also create a checkpoint so we can rollback
    await createCheckpoint(req.user.id, 'manual', `Pre-${config_key} snapshot`,
      JSON.stringify({ key: config_key, previous_value: prev?.config_value }),
      PERSONA_VERSION);

    res.json({ ok: true, id: result.id, changed_at: result.created_at, reason: audit_note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MODE 2 — Direct Training Chat
// GET  /api/wallt/training/chat          → list sessions
// POST /api/wallt/training/chat          → start new session
// GET  /api/wallt/training/chat/current → get/resume open session
// POST /api/wallt/training/chat/send    → send message in session
// POST /api/wallt/training/chat/close   → end session
// GET  /api/wallt/training/chat/:id      → load session transcript
// ══════════════════════════════════════════════════════════════════════════════

router.get('/chat', authMiddleware, async (req, res) => {
  try {
    const sessions = await listTrainingSessions(req.user.id, 30);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chat', authMiddleware, async (req, res) => {
  try {
    // Close any open session first
    const open = await getOpenSession(req.user.id);
    if (open) await endTrainingSession(open.id, 'Auto-closed — new session started', null);

    const session = await startTrainingSession(req.user.id);
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chat/current', authMiddleware, async (req, res) => {
  try {
    const open = await getOpenSession(req.user.id);
    if (!open) return res.json({ session: null, transcript: [] });

    const transcript = await getSessionTranscript(open.id);
    res.json({ session: open, transcript });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chat/send', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });

    const session = await getOpenSession(req.user.id);
    if (!session) {
      // Auto-start a session
      const newSession = await startTrainingSession(req.user.id);
      return await handleSend(req, res, newSession.id, content.trim());
    }

    await handleSend(req, res, session.id, content.trim());
  } catch (err) {
    console.error('[wallt-training] chat send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleSend(req, res, sessionId, content) {
  const transcript = await getSessionTranscript(sessionId);
  const turnIndex = transcript.length;

  // Log Nikita's message
  await addTrainingTurn(sessionId, turnIndex, 'nikita', content, false);

  // Build training context: scope config + memory + conversation history
  const supplement = await buildTrainingSystemSupplement(req.user.id);

  const historyWindow = transcript.slice(-20).map(t => ({
    role: t.role === 'nikita' ? 'user' : 'assistant',
    content: t.content,
  }));

  const ai = getAI();
  const systemPrompt = buildSystemPrompt({});

  const systemSupplement = supplement
    ? `You are in Nikita's Personal Training Room. These are NIKITA'S AUTHORITATIVE INSTRUCTIONS — they override everything else.\n\n${supplement}\n\nYou are speaking with Nikita. He is training you. Be direct, accept corrections, report concerns.`
    : `You are in Nikita's Personal Training Room. He is training you. Accept behavioral corrections immediately.`;

  const completion = await ai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: systemSupplement },
      ...historyWindow,
      { role: 'user', content },
    ],
    tools: WALLT_TOOLS,
    tool_choice: 'auto',
    max_tokens: 768,
  });

  const choice = completion.choices[0];
  const walltReply = choice?.message?.content || '';
  const actions = parseToolCalls(choice?.message?.tool_calls || [], { userId: req.user.id });

  // Log Wallt's response
  const replyTurnIndex = transcript.length + 1;
  await addTrainingTurn(sessionId, replyTurnIndex, 'wallt', walltReply, false);

  // Check if Nikita gave a behavioral correction (keyword-based heuristic)
  const correctionSignals = ['stop doing', 'when y happens', "don't do", 'never do', 'do not do', 'instead do', 'always do', 'never say', 'you were wrong', 'wallt stop', 'wallt,'];
  const isCorrection = correctionSignals.some(s => content.toLowerCase().includes(s));
  let memoryKey = null;

  if (isCorrection && walltReply) {
    // Capture correction in training memory
    memoryKey = `behavior_${Date.now()}`;
    await upsertMemory(req.user.id, memoryKey, {
      type: 'behavioral_correction',
      from_nikita: content.slice(0, 300),
      wallt_response: walltReply.slice(0, 200),
    }, 'training', 'high');
  }

  res.json({
    turn_index: replyTurnIndex,
    wallt_reply: walltReply,
    actions,
    memory_updated: isCorrection,
    memory_key: memoryKey,
  });
}

router.post('/chat/close', authMiddleware, async (req, res) => {
  try {
    const { summary, topics } = req.body;
    const open = await getOpenSession(req.user.id);
    if (!open) return res.json({ ok: true, message: 'No open session' });

    await endTrainingSession(open.id, summary || null, topics || null);
    res.json({ ok: true, session_id: open.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chat/:id', authMiddleware, async (req, res) => {
  try {
    const transcript = await getSessionTranscript(parseInt(req.params.id));
    res.json({ transcript });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MODE 3 — Emergency Stop (Kill Switch)
// POST /api/wallt/training/kill          → stop Wallt immediately
// POST /api/willt/training/kill/resume   → resume Wallt
// GET  /api/wallt/training/kill          → get current frozen state
// GET  /api/wallt/training/kill/history → stop/resume history
// ══════════════════════════════════════════════════════════════════════════════

router.get('/kill', authMiddleware, async (req, res) => {
  try {
    const frozen = await getWalltFrozenState(req.user.id);
    res.json({ is_frozen: !!frozen, frozen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/kill', authMiddleware, async (req, res) => {
  try {
    const { reason, create_checkpoint } = req.body;

    // Pre-kill checkpoint if requested
    let snapshotId = null;
    if (create_checkpoint !== false) {
      const ckpt = await createCheckpoint(req.user.id, 'pre_kill', 'Pre-emergency-stop snapshot', {
        stopped_by: 'manual_kill_switch',
        reason: reason || null,
        stopped_at: new Date().toISOString(),
      }, PERSONA_VERSION);
      snapshotId = ckpt.id;
    }

    const stop = await logKillSwitchStop(req.user.id, reason || null, snapshotId);

    // Log boundary event
    await logBoundaryEvent(req.user.id, 'kill_switch_activated', reason || 'Emergency stop triggered', 'high');

    res.json({ ok: true, stop_id: stop.id, checkpoint_id: snapshotId, stopped_at: stop.stopped_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/kill/resume', authMiddleware, async (req, res) => {
  try {
    const { how, notes, restore_checkpoint_id } = req.body;

    const frozen = await getWalltFrozenState(req.user.id);
    if (!frozen) return res.status(400).json({ error: 'Wallt is not stopped' });

    await logKillSwitchResume(frozen.id, how || 'manual_resume', notes || null);

    // Optionally restore from a checkpoint
    if (restore_checkpoint_id) {
      const ckpt = await getCheckpointById(restore_checkpoint_id);
      if (ckpt) {
        await createCheckpoint(req.user.id, 'restore', `Post-resume from checkpoint ${restore_checkpoint_id}`, ckpt.checkpoint_data, PERSONA_VERSION);
      }
    }

    await logBoundaryEvent(req.user.id, 'wallt_resumed', `Resumed via ${how || 'manual'}`, 'low');

    res.json({ ok: true, resumed_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/kill/history', authMiddleware, async (req, res) => {
  try {
    const history = await getKillSwitchHistory(req.user.id, 20);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MODE 4 — State Recovery
// GET  /api/wallt/training/recovery/checkpoints  → list all checkpoints
// POST /api/wallt/training/recovery/checkpoint   → create manual checkpoint
// GET  /api/wallt/training/recovery/checkpoint/:id → get checkpoint data
// POST /api/wallt/training/recovery/restore/:id   → restore from checkpoint
// DELETE /api/wallt/training/recovery/checkpoint/:id → delete checkpoint
// ══════════════════════════════════════════════════════════════════════════════

router.get('/recovery/checkpoints', authMiddleware, async (req, res) => {
  try {
    const checkpoints = await listCheckpoints(req.user.id, 30);
    res.json({ checkpoints });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery/checkpoint', authMiddleware, async (req, res) => {
  try {
    const { label, snapshot_data } = req.body;
    if (!snapshot_data) return res.status(400).json({ error: 'snapshot_data required' });

    const ckpt = await createCheckpoint(req.user.id, 'manual', label || 'Manual checkpoint', snapshot_data, PERSONA_VERSION);
    res.status(201).json({ checkpoint: ckpt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recovery/checkpoint/:id', authMiddleware, async (req, res) => {
  try {
    const ckpt = await getCheckpointById(parseInt(req.params.id));
    if (!ckpt || ckpt.owner_user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    res.json({ checkpoint: ckpt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery/restore/:id', authMiddleware, async (req, res) => {
  try {
    const ckpt = await getCheckpointById(parseInt(req.params.id));
    if (!ckpt || ckpt.owner_user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

    // Mark as restored and create a post-restore snapshot
    await createCheckpoint(req.user.id, 'restore', `Restored from checkpoint ${ckpt.id}`, ckpt.checkpoint_data, PERSONA_VERSION);
    res.json({ ok: true, restored_from: ckpt.id, checkpoint_type: ckpt.checkpoint_type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recovery/checkpoint/:id', authMiddleware, async (req, res) => {
  try {
    const deleted = await deleteCheckpoint(req.user.id, parseInt(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MODE 5 — Environment Boundary Monitor
// GET /api/wallt/training/monitor  → live telemetry
// GET /api/wallt/training/monitor/boundary  → boundary events
// POST /api/wallt/training/monitor/boundary → log a boundary event manually
// POST /api/wallt/training/monitor/boundary/:id/resolve → resolve event
// ══════════════════════════════════════════════════════════════════════════════

router.get('/monitor', authMiddleware, async (req, res) => {
  try {
    const runtime = await getWalltRuntimeContext(req.user.id);
    const stats = await getTrainingStats(req.user.id);
    res.json({ ...runtime, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/monitor/boundary', authMiddleware, async (req, res) => {
  try {
    const events = await listBoundaryEvents(req.user.id, 50);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/monitor/boundary', authMiddleware, async (req, res) => {
  try {
    const { event_type, description, severity } = req.body;
    if (!event_type) return res.status(400).json({ error: 'event_type required' });

    const event = await logBoundaryEvent(
      req.user.id, event_type, description || null, severity || 'low'
    );
    res.status(201).json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/monitor/boundary/:id/resolve', authMiddleware, async (req, res) => {
  try {
    const { notes } = req.body;
    await resolveBoundaryEvent(req.user.id, parseInt(req.params.id), notes || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Memory management ────────────────────────────────────────────────────────
// GET    /api/wallt/training/memory  → list active memory keys
// POST   /api/wallt/training/memory  → upsert a memory entry
// DELETE /api/wallt/training/memory/:key → deactivate a memory key

router.get('/memory', authMiddleware, async (req, res) => {
  try {
    const entries = await listMemoryKeys(req.user.id);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memory', authMiddleware, async (req, res) => {
  try {
    const { memory_key, memory_value, source, confidence } = req.body;
    if (!memory_key || memory_value === undefined) {
      return res.status(400).json({ error: 'memory_key and memory_value required' });
    }
    const result = await upsertMemory(req.user.id, memory_key, memory_value, source || 'training', confidence || 'high');
    res.json({ ok: true, id: result.id, updated_at: result.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/memory/:key', authMiddleware, async (req, res) => {
  try {
    await deactivateMemory(req.user.id, req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;