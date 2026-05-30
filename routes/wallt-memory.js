/**
 * Owns: /api/wallt/memory/* — Wallt Core Memory REST API.
 * Does NOT own: Wallt conversations, AI model calls, personality engine.
 *
 * Two memory layers:
 *   wallt_core_*  (db/wallt-memory.js) — profile, decisions, institutional, conflicts, escalations, skills, audio
 *   wallt_memory  (db/wallt-memory-search.js) — pgvector semantic store with embeddings
 *
 * Endpoints:
 *   GET    /api/wallt/memory/profile         — load user profile to session
 *   PUT    /api/wallt/memory/profile        — update user profile
 *   PATCH  /api/wallt/memory/profile         — patch user profile
 *   GET    /api/wallt/memory/decisions       — decision log (optional ?type=)
 *   POST   /api/wallt/memory/decisions       — log a new decision
 *   PATCH  /api/wallt/memory/decisions/:id/outcome — update decision outcome
 *   GET    /api/wallt/memory/institutional   — all institutional memory
 *   POST   /api/wallt/memory/institutional   — upsert institutional memory
 *   GET    /api/wallt/memory/institutional/:category — category-filtered
 *   GET    /api/wallt/memory/conflicts       — conflict log
 *   POST   /api/wallt/memory/conflicts       — log a conflict
 *   PATCH  /api/wallt/memory/conflicts/:id   — resolve a conflict
 *   GET    /api/wallt/memory/escalations     — escalation log
 *   POST   /api/wallt/memory/escalations      — log escalation to Polsia
 *   PATCH  /api/wallt/memory/escalations/:id — resolve escalation (Polsia only)
 *   GET    /api/wallt/memory/skills           — skill inventory
 *   POST   /api/wallt/memory/skills           — upsert a skill
 *   PATCH  /api/wallt/memory/skills/:id/confirm — confirm skill
 *   PATCH  /api/wallt/memory/skills/:id/invalidate — invalidate skill
 *   GET    /api/wallt/memory/audio           — audio catalog
 *   POST   /api/wallt/memory/audio           — add audio entry
 *   GET    /api/wallt/memory/session-load    — load_to_session: full context for AI
 *   POST   /api/wallt/memory/persist-decision — persist_to_core: write decision
 *   POST   /api/wallt/memory                 — write memory atom (pgvector store)
 *   GET    /api/wallt/memory                 — read memories (context injection)
 *   GET    /api/wallt/memory/:id             — read single memory
 *   DELETE /api/wallt/memory/:id             — delete memory
 *   POST   /api/wallt/memory/search         — semantic search (cosine distance)
 *   POST   /api/wallt/memory/embed          — batch backfill embeddings
 *   GET    /api/wallt/memory/archive         — list archived memories
 *   POST   /api/wallt/memory/:id/restore     — restore from archive
 *   GET    /api/wallt/memory/project/:id    — project-scoped memories
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const walltMem = require('../db/wallt-memory');
const cache = require('../services/wallt-memory-cache');
const walltMemSearch = require('../db/wallt-memory-search');

function resolveUserId(req) {
  return req.user ? req.user.id : null;
}

// ── User Profile ─────────────────────────────────────────────────────────────

router.get('/profile', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ profile: null, cached: false });

    // Check cache first
    const cached = await cache.getCachedUserProfile(userId);
    if (cached) return res.json({ profile: cached, cached: true });

    const profile = await walltMem.getUserProfile(userId);
    if (profile) {
      await cache.cacheUserProfile(userId, profile.profile_json);
    }
    res.json({ profile: profile?.profile_json ?? null, cached: !!cached });
  } catch (err) {
    console.error('[wallt-memory] get profile error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

router.put('/profile', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { profile_json } = req.body;
    if (!profile_json || typeof profile_json !== 'object') {
      return res.status(400).json({ error: 'profile_json object required' });
    }
    const profile = await walltMem.upsertUserProfile(userId, profile_json);
    await cache.cacheUserProfile(userId, profile.profile_json);
    res.json({ profile: profile.profile_json });
  } catch (err) {
    console.error('[wallt-memory] put profile error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.patch('/profile', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { profile_json } = req.body;
    if (!profile_json || typeof profile_json !== 'object') {
      return res.status(400).json({ error: 'profile_json object required' });
    }
    const profile = await walltMem.patchUserProfile(userId, profile_json);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    await cache.cacheUserProfile(userId, profile.profile_json);
    res.json({ profile: profile.profile_json });
  } catch (err) {
    console.error('[wallt-memory] patch profile error:', err.message);
    res.status(500).json({ error: 'Failed to patch profile' });
  }
});

// ── Decision Log ────────────────────────────────────────────────────────────

router.get('/decisions', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ decisions: [] });
    const decisions = await walltMem.getDecisions(userId, {
      decisionType: req.query.type || null,
      limit: parseInt(req.query.limit || '50', 10),
    });
    res.json({ decisions });
  } catch (err) {
    console.error('[wallt-memory] get decisions error:', err.message);
    res.status(500).json({ error: 'Failed to load decisions' });
  }
});

router.post('/decisions', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { decision_key, decision_type, context_json, reasoning_chain, outcome, outcome_note, confidence_score, persist_to_core } = req.body;
    if (!decision_key || !decision_type) {
      return res.status(400).json({ error: 'decision_key and decision_type are required' });
    }
    const decision = await walltMem.logDecision({
      userId, sessionUuid: req.session?.uuid || null,
      decisionKey: decision_key, decisionType: decision_type,
      contextJson: context_json || {}, reasoningChain: reasoning_chain || '',
      outcome: outcome || 'unknown', outcomeNote: outcome_note,
      confidenceScore: confidence_score, persistToCore: persist_to_core ?? false,
    });

    // Invalidate decisions cache so next load gets fresh data
    await cache.invalidateDecisions(userId);

    res.status(201).json({ decision });
  } catch (err) {
    console.error('[wallt-memory] log decision error:', err.message);
    res.status(500).json({ error: 'Failed to log decision' });
  }
});

router.patch('/decisions/:id/outcome', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { outcome, outcome_note } = req.body;
    if (!outcome) return res.status(400).json({ error: 'outcome is required' });
    const decision = await walltMem.updateDecisionOutcome(parseInt(req.params.id), outcome, outcome_note);
    if (!decision) return res.status(404).json({ error: 'Decision not found' });
    await cache.invalidateDecisions(userId);
    res.json({ decision });
  } catch (err) {
    console.error('[wallt-memory] update decision error:', err.message);
    res.status(500).json({ error: 'Failed to update decision' });
  }
});

// ── Institutional Memory ────────────────────────────────────────────────────

router.get('/institutional', optionalAuth, async (req, res) => {
  try {
    const records = await walltMem.getAllInstitutionalMem({ limit: 100 });
    res.json({ records });
  } catch (err) {
    console.error('[wallt-memory] get institutional error:', err.message);
    res.status(500).json({ error: 'Failed to load institutional memory' });
  }
});

router.get('/institutional/:category', optionalAuth, async (req, res) => {
  try {
    const records = await walltMem.getInstitutionalMemByCategory(req.params.category, { limit: 50 });
    res.json({ category: req.params.category, records });
  } catch (err) {
    console.error('[wallt-memory] get institutional category error:', err.message);
    res.status(500).json({ error: 'Failed to load category' });
  }
});

router.post('/institutional', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { category, memory_key, content_md, tags } = req.body;
    if (!category || !memory_key) {
      return res.status(400).json({ error: 'category and memory_key are required' });
    }
    const record = await walltMem.upsertInstitutionalMem(category, memory_key, content_md || '', tags || []);
    // Warm cache
    await cache.cacheInstitutionalMem(category, memory_key, record.content_md, record.tags);
    res.status(201).json({ record });
  } catch (err) {
    console.error('[wallt-memory] upsert institutional error:', err.message);
    res.status(500).json({ error: 'Failed to save institutional memory' });
  }
});

router.get('/institutional/:category/:key', optionalAuth, async (req, res) => {
  try {
    const record = await walltMem.getInstitutionalMem(req.params.category, req.params.key);
    if (!record) return res.status(404).json({ error: 'Not found' });
    // Warm cache
    await cache.cacheInstitutionalMem(record.category, record.memory_key, record.content_md, record.tags);
    res.json({ record });
  } catch (err) {
    console.error('[wallt-memory] get institutional key error:', err.message);
    res.status(500).json({ error: 'Failed to load' });
  }
});

// ── Conflict Log ────────────────────────────────────────────────────────────

router.get('/conflicts', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ conflicts: [] });
    const conflicts = await walltMem.getConflicts(userId, { limit: 30 });
    res.json({ conflicts });
  } catch (err) {
    console.error('[wallt-memory] get conflicts error:', err.message);
    res.status(500).json({ error: 'Failed to load conflicts' });
  }
});

router.post('/conflicts', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { conflict_type, request_summary, wallt_position } = req.body;
    if (!conflict_type || !wallt_position) {
      return res.status(400).json({ error: 'conflict_type and wallt_position are required' });
    }
    const conflict = await walltMem.logConflict({
      userId, sessionUuid: req.session?.uuid || null,
      conflictType: conflict_type,
      requestSummary: request_summary || '',
      walltPosition: wallt_position,
    });
    res.status(201).json({ conflict });
  } catch (err) {
    console.error('[wallt-memory] log conflict error:', err.message);
    res.status(500).json({ error: 'Failed to log conflict' });
  }
});

router.patch('/conflicts/:id', optionalAuth, async (req, res) => {
  try {
    const { resolution, polsia_response } = req.body;
    if (!resolution) return res.status(400).json({ error: 'resolution is required' });
    const conflict = await walltMem.resolveConflict(parseInt(req.params.id), resolution, polsia_response);
    if (!conflict) return res.status(404).json({ error: 'Not found' });
    res.json({ conflict });
  } catch (err) {
    console.error('[wallt-memory] resolve conflict error:', err.message);
    res.status(500).json({ error: 'Failed to resolve conflict' });
  }
});

// ── Escalation Log ─────────────────────────────────────────────────────────

router.get('/escalations', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ escalations: [] });
    const escalations = await walltMem.getEscalations(userId, { limit: 20 });
    res.json({ escalations });
  } catch (err) {
    console.error('[wallt-memory] get escalations error:', err.message);
    res.status(500).json({ error: 'Failed to load escalations' });
  }
});

router.post('/escalations', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { escalation_subject, escalation_body, escalation_reason, priority } = req.body;
    if (!escalation_subject) {
      return res.status(400).json({ error: 'escalation_subject is required' });
    }
    const escalation = await walltMem.logEscalation({
      userId, sessionUuid: req.session?.uuid || null,
      escalationSubject: escalation_subject,
      escalationBody: escalation_body || '',
      escalationReason: escalation_reason || 'policy_boundary',
      priority: priority || 'normal',
    });
    res.status(201).json({ escalation });
  } catch (err) {
    console.error('[wallt-memory] log escalation error:', err.message);
    res.status(500).json({ error: 'Failed to log escalation' });
  }
});

router.patch('/escalations/:id', optionalAuth, async (req, res) => {
  try {
    const { polsia_response } = req.body;
    if (!polsia_response) return res.status(400).json({ error: 'polsia_response is required' });
    const escalation = await walltMem.resolveEscalation(parseInt(req.params.id), polsia_response);
    if (!escalation) return res.status(404).json({ error: 'Not found' });
    res.json({ escalation });
  } catch (err) {
    console.error('[wallt-memory] resolve escalation error:', err.message);
    res.status(500).json({ error: 'Failed to resolve escalation' });
  }
});

// ── Skill Inventory ─────────────────────────────────────────────────────────

router.get('/skills', optionalAuth, async (req, res) => {
  try {
    const domain = req.query.domain || null;
    if (domain) {
      const skills = await walltMem.getSkillsByDomain(domain, { limit: 50 });
      return res.json({ skills });
    }
    const unconfirmed = await walltMem.getUnconfirmedSkills({ limit: 30 });
    res.json({ skills: unconfirmed, filter: 'unconfirmed' });
  } catch (err) {
    console.error('[wallt-memory] get skills error:', err.message);
    res.status(500).json({ error: 'Failed to load skills' });
  }
});

router.post('/skills', optionalAuth, async (req, res) => {
  try {
    const { skill_key, skill_domain, description, confirmation_status, source, confidence_score, metadata_json } = req.body;
    if (!skill_key || !skill_domain) {
      return res.status(400).json({ error: 'skill_key and skill_domain are required' });
    }
    const skill = await walltMem.upsertSkill({
      skillKey: skill_key, skillDomain: skill_domain,
      description: description || '', confirmationStatus: confirmation_status || 'unconfirmed',
      source: source || 'inference', confidenceScore: confidence_score,
      metadataJson: metadata_json || {},
    });
    await cache.cacheSkill(skill_key, skill);
    res.status(201).json({ skill });
  } catch (err) {
    console.error('[wallt-memory] upsert skill error:', err.message);
    res.status(500).json({ error: 'Failed to upsert skill' });
  }
});

router.patch('/skills/:id/confirm', optionalAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // First get the skill key so we can invalidate cache
    const { rows } = await require('../db/index').query(
      `SELECT skill_key FROM wallt_core_skill_inventory WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { skill_key } = rows[0];
    const testResults = req.body.test_results_json || {};
    const skill = await walltMem.confirmSkill(skill_key, testResults);
    if (!skill) return res.status(404).json({ error: 'Not found' });
    await cache.cacheSkill(skill_key, skill);
    res.json({ skill });
  } catch (err) {
    console.error('[wallt-memory] confirm skill error:', err.message);
    res.status(500).json({ error: 'Failed to confirm skill' });
  }
});

router.patch('/skills/:id/invalidate', optionalAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await require('../db/index').query(
      `SELECT skill_key FROM wallt_core_skill_inventory WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { skill_key } = rows[0];
    const reason = req.body.reason || 'unknown';
    const skill = await walltMem.invalidateSkill(skill_key, reason);
    if (!skill) return res.status(404).json({ error: 'Not found' });
    await cache.invalidateSkill(skill_key);
    res.json({ skill });
  } catch (err) {
    console.error('[wallt-memory] invalidate skill error:', err.message);
    res.status(500).json({ error: 'Failed to invalidate skill' });
  }
});

// ── Audio Catalog ───────────────────────────────────────────────────────────

router.get('/audio', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ catalog: [] });
    const entries = await walltMem.getAudioCatalog(userId, { limit: 50 });
    res.json({ catalog: entries });
  } catch (err) {
    console.error('[wallt-memory] get audio error:', err.message);
    res.status(500).json({ error: 'Failed to load audio catalog' });
  }
});

router.post('/audio', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { file_name, file_path, rights_breakdown_json, duration_seconds, sample_rate_hz, format, tags, metadata_json } = req.body;
    if (!file_name || !file_path) {
      return res.status(400).json({ error: 'file_name and file_path are required' });
    }
    const entry = await walltMem.addAudioEntry({
      userId, fileName: file_name, filePath: file_path,
      rightsBreakdownJson: rights_breakdown_json || {},
      durationSeconds: duration_seconds, sampleRateHz: sample_rate_hz,
      format: format || 'wav', tags: tags || [], metadataJson: metadata_json || {},
    });
    res.status(201).json({ entry });
  } catch (err) {
    console.error('[wallt-memory] add audio error:', err.message);
    res.status(500).json({ error: 'Failed to add audio entry' });
  }
});

// ── Session ↔ Core Migration ────────────────────────────────────────────────

// load_to_session: called at conversation init — returns full context for AI injection
router.get('/session-load', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ context: null });

    // Load from cache first
    const cached = await cache.loadToSession(userId);

    // Get profile (cache miss → PostgreSQL)
    const profile = cached?.profile ?? (await walltMem.getUserProfile(userId))?.profile_json ?? null;
    if (profile && !cached?.profile) {
      await cache.cacheUserProfile(userId, profile);
    }

    // Get recent decisions
    const decisions = await walltMem.getRecentDecisions(20);

    // Get institutional memory (hot only)
    const institutional = await walltMem.getAllInstitutionalMem({ limit: 50 });

    // Get unconfirmed skills (needs attention)
    const unconfirmedSkills = await walltMem.getUnconfirmedSkills({ limit: 10 });

    res.json({
      context: {
        profile,
        decisions,
        institutional,
        unconfirmed_skills: unconfirmedSkills,
        loaded_at: new Date().toISOString(),
      },
      cached: !!cached?.profile,
    });
  } catch (err) {
    console.error('[wallt-memory] session-load error:', err.message);
    res.status(500).json({ error: 'Failed to load session context' });
  }
});

// persist_to_core: explicit write — for decisions, conflict outcomes, skill updates
router.post('/persist-decision', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { decision_key, decision_type, context_json, reasoning_chain, outcome, outcome_note, confidence_score } = req.body;

    const decision = await walltMem.logDecision({
      userId, sessionUuid: req.session?.uuid || null,
      decisionKey: decision_key || `wallt:decision:${Date.now()}`,
      decisionType: decision_type || 'general',
      contextJson: context_json || {}, reasoningChain: reasoning_chain || '',
      outcome: outcome || 'unknown', outcomeNote: outcome_note,
      confidenceScore: confidence_score, persistToCore: true,
    });

    // Invalidate cache so session-load picks up fresh data
    await cache.invalidateDecisions(userId);

    res.status(201).json({ decision, persisted: true });
  } catch (err) {
    console.error('[wallt-memory] persist-decision error:', err.message);
    res.status(500).json({ error: 'Failed to persist decision' });
  }
});

// ── wallt_memory — pgvector semantic store ────────────────────────────────────

// POST /api/wallt/memory — write (Wallt logs insights)
router.post('/memory', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const {
      content,
      embedding,          // float[] from OpenAI embedding
      category = 'general',
      confidence = 0.5,
      project_id,
      tags = [],
    } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    if (!content.trim()) {
      return res.status(400).json({ error: 'content cannot be empty' });
    }

    const metadataJson = {
      user_id: userId || null,
      project_id: project_id || null,
      tags,
    };

    const entry = await walltMemSearch.writeMemory({
      content: content.trim(),
      embedding,
      category,
      confidence: Math.min(1, Math.max(0, parseFloat(confidence))),
      metadataJson,
      createdByWallt: true,
    });

    res.status(201).json({ memory: entry });
  } catch (err) {
    console.error('[wallt-memory] write memory error:', err.message);
    res.status(500).json({ error: 'Failed to write memory' });
  }
});

// GET /api/wallt/memory — read (context injection) with optional semantic search
router.get('/memory', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { category, project_id, limit = '100' } = req.query;

    const memories = await walltMemSearch.listMemories({
      userId: userId || null,
      projectId: project_id || null,
      category: category || null,
      limit: parseInt(limit, 10),
    });

    res.json({ memories, count: memories.length });
  } catch (err) {
    console.error('[wallt-memory] read memories error:', err.message);
    res.status(500).json({ error: 'Failed to read memories' });
  }
});

// GET /api/wallt/memory/:id — read single memory by ID
router.get('/memory/:id', optionalAuth, async (req, res) => {
  try {
    const memory = await walltMemSearch.getMemoryById(parseInt(req.params.id));
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    res.json({ memory });
  } catch (err) {
    console.error('[wallt-memory] get memory error:', err.message);
    res.status(500).json({ error: 'Failed to get memory' });
  }
});

// DELETE /api/wallt/memory/:id
router.delete('/memory/:id', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const id = parseInt(req.params.id);
    const memory = await walltMemSearch.getMemoryById(id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    await require('../db/index').query(`DELETE FROM wallt_memory WHERE id = $1`, [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('[wallt-memory] delete memory error:', err.message);
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// POST /api/wallt/memory/search — semantic search (pgvector cosine distance)
router.post('/memory/search', optionalAuth, async (req, res) => {
  try {
    const {
      query_embedding,   // float[] — pre-computed embedding of query text
      query_text,        // fallback: raw text if no embedding provided
      category,
      created_by_wallt,
      project_id,
      limit = 10,
      min_similarity = 0.0,
    } = req.body;

    if (!query_embedding && !query_text) {
      return res.status(400).json({ error: 'query_embedding or query_text required' });
    }

    const results = await walltMemSearch.searchMemories({
      queryEmbedding: query_embedding,
      queryText: query_text,
      category: category || null,
      createdByWallt: created_by_wallt !== undefined ? Boolean(created_by_wallt) : null,
      projectId: project_id || null,
      limit: Math.min(parseInt(limit, 10), 50),
      minSimilarity: parseFloat(min_similarity),
    });

    res.json({ results, count: results.length });
  } catch (err) {
    console.error('[wallt-memory] search error:', err.message);
    res.status(500).json({ error: 'Semantic search failed' });
  }
});

// POST /api/wallt/memory/embed — batch backfill embeddings (Wallt calls after writing)
// Caller embeds content externally then calls this to store the vector
router.post('/memory/embed', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const { memories } = req.body; // [{ id, embedding }]
    if (!Array.isArray(memories) || memories.length === 0) {
      return res.status(400).json({ error: 'memories [{id, embedding}] array required' });
    }
    const updated = [];
    for (const m of memories) {
      if (!m.id || !Array.isArray(m.embedding)) continue;
      const row = await walltMemSearch.updateEmbedding(m.id, m.embedding);
      if (row) updated.push(row.id);
    }
    res.json({ updated: updated.length, ids: updated });
  } catch (err) {
    console.error('[wallt-memory] embed backfill error:', err.message);
    res.status(500).json({ error: 'Failed to store embeddings' });
  }
});

// GET /api/wallt/memory/archive — list archived memories
router.get('/memory/archive', optionalAuth, async (req, res) => {
  try {
    const { limit = '50' } = req.query;
    const { rows } = await require('../db/index').query(
      `SELECT id, source_id, content, category, confidence, archived_at, expires_at, restored
       FROM wallt_memory_archive
       WHERE restored = FALSE
       ORDER BY archived_at DESC LIMIT $1`,
      [parseInt(limit, 10)]
    );
    res.json({ archives: rows, count: rows.length });
  } catch (err) {
    console.error('[wallt-memory] list archive error:', err.message);
    res.status(500).json({ error: 'Failed to list archive' });
  }
});

// POST /api/wallt/memory/:id/restore — restore from archive
router.post('/memory/:id/restore', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const restored = await walltMemSearch.restoreFromArchive(parseInt(req.params.id));
    if (!restored) return res.status(404).json({ error: 'Archive entry not found or already restored' });
    res.json({ restored: true, memory_id: restored.id });
  } catch (err) {
    console.error('[wallt-memory] restore error:', err.message);
    res.status(500).json({ error: 'Failed to restore memory' });
  }
});

// GET /api/wallt/memory/project/:projectId — get recent memories for a project
router.get('/memory/project/:projectId', optionalAuth, async (req, res) => {
  try {
    const { limit = '20' } = req.query;
    const memories = await walltMemSearch.getProjectMemories(req.params.projectId, {
      limit: parseInt(limit, 10),
    });
    res.json({ memories, count: memories.length });
  } catch (err) {
    console.error('[wallt-memory] project memories error:', err.message);
    res.status(500).json({ error: 'Failed to load project memories' });
  }
});

// GET /api/wallt/memory/context-graph — Context Graph node wiring
// Returns all wallt memory formatted for the Polsia context graph system.
// Used by mcp__context_graph__read_context_graph({ node_type: "wallt_memory" })
router.get('/memory/context-graph', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ memories: [], nodes: [], edges: [] });

    // Get recent memories from pgvector store
    const recentMemories = await walltMemSearch.listMemories({ userId, limit: 50 });

    // Get core decisions (persist_to_core only — consequential)
    const decisions = await walltMem.getRecentDecisions(20);

    // Get institutional memory (hot only)
    const institutional = await walltMem.getAllInstitutionalMem({ limit: 30 });

    // Format as context graph nodes
    const nodes = [
      ...recentMemories.map(m => ({
        node_type: 'wallt_memory_atom',
        id: `wallt_mem_${m.id}`,
        content: m.content,
        category: m.category,
        confidence: m.confidence,
        metadata: m.metadata_json,
        created_by_wallt: m.created_by_wallt,
        created_at: m.created_at,
      })),
      ...decisions.map(d => ({
        node_type: 'wallt_core_decision',
        id: `wallt_dec_${d.id}`,
        decision_key: d.decision_key,
        decision_type: d.decision_type,
        reasoning_chain: d.reasoning_chain,
        outcome: d.outcome,
        confidence_score: d.confidence_score,
        persist_to_core: d.persist_to_core,
        created_at: d.created_at,
      })),
      ...institutional.map(i => ({
        node_type: 'wallt_core_institutional',
        id: `wallt_inst_${i.id}`,
        category: i.category,
        memory_key: i.memory_key,
        content_md: i.content_md,
        tags: i.tags,
        is_hot: i.is_hot,
        created_at: i.created_at,
      })),
    ];

    res.json({
      node_type: 'wallt_memory',
      user_id: userId,
      memory_count: recentMemories.length,
      decision_count: decisions.length,
      institutional_count: institutional.length,
      nodes,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[wallt-memory] context-graph error:', err.message);
    res.status(500).json({ error: 'Failed to build context graph data' });
  }
});

module.exports = router;