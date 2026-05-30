/**
 * Owns: /api/wallt-agent/* — Tiered prompt agent router for all 10 Wallt LLM agents.
 * Does NOT own: Wallt AI Companion chat UI (routes/wallt.js), personality engine (lib/wallt/persona.js).
 *
 * W2: PagedAttention Prefix Caching — structured tiered prompts for frozen block reuse.
 * - 4 core agents (ingestion, transformation, analytics, governance) — core tier 0, diverge at tier 1+
 * - 6 sector agents (structural, mep, thermal, dob, materials, fire) — sector-specific tier 0-1
 *
 * Tier structure (most stable → least stable):
 *   Tier 0: Agent role definition  — frozen, changes only on agent redesign
 *   Tier 1: Project metadata + sector version pins — semi-frozen
 *   Tier 2: Tool definitions        — sort_keys=True → deterministic hash → stable cache
 *   Tier 3: Sector Registry snapshot — sector-specific for sector agents, cross-sector for core
 *   Tier 4: Codebase snapshot       — semi-stable
 *   Tier 5: Previous agent outputs — dynamic, changes every pipeline run
 *   Dynamic suffix: User input / current task — never cached
 *
 * Cache key format: {project_id}:{agent_role}:{sector_id}:{tier_hash}
 *
 * Endpoints:
 *   POST /api/wallt-agent/chat              — route to agent with tiered prompt
 *   GET  /api/wallt-agent/cache/stats       — cache hit rate, size, tier breakdown + DB telemetry
 *   POST /api/wallt-agent/cache/invalidate   — manual invalidation trigger
 *   GET  /api/wallt-agent/sectors           — sector agent status
 *   POST /api/wallt-agent/cache/sector-ingest — sector ingestion → Tier 3+ invalidation (sector-only)
 *   POST /api/wallt-agent/cache/project-switch — project switch → Tier 1+ invalidation (Tier 0 survives)
 *   GET  /api/wallt-agent/cache/invalidation-log — persisted invalidation events (last 24h)
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const OpenAI = require('openai');
const { getLatestContextSnapshot } = require('../db/wallt');
const {
  buildAgentPrompt,
  logInvalidation,
  promptCacheManager,
} = require('../services/paged-prompt-builder');
const {
  getInvalidationStats,
  getTierHitRates,
  getInvalidationsBySector,
} = require('../db/prompt-cache');
const { appendAgentEvent } = require('../db/events');

// ── Agent registry ───────────────────────────────────────────────────────────

const AGENTS = {
  // 4 core agents
  ingestion:     { name: 'Ingestion',      sectorId: 'core',      description: 'Data ingestion + BIM element creation' },
  transformation: { name: 'Transformation', sectorId: 'core',      description: 'BIM transformation + constraint solving' },
  analytics:     { name: 'Analytics',      sectorId: 'core',      description: 'Structural/MEP analysis + energy simulation' },
  governance:    { name: 'Governance',     sectorId: 'core',      description: 'Policy + compliance + legal checks' },
  // 6 sector agents
  structural:    { name: 'Structural',     sectorId: 'structural', description: 'AISC/ACI/IBC structural analysis' },
  mep:           { name: 'MEP',            sectorId: 'mep',       description: 'ASHRAE/NFPA MEP systems' },
  thermal:       { name: 'Thermal',        sectorId: 'thermal',   description: 'ASHRAE 90.1 / NYC energy code' },
  dob:           { name: 'DOB/Zoning',     sectorId: 'dob',       description: 'NYC Building Code / Zoning Resolution' },
  materials:     { name: 'Materials',       sectorId: 'materials', description: 'CSI MasterFormat / specifications' },
  fire:          { name: 'Fire',           sectorId: 'fire',      description: 'NFPA 13/101/72 / fire protection' },
};

const VALID_AGENTS = new Set(Object.keys(AGENTS));

// ── Project-switch tracking ─────────────────────────────────────────────────
// Per-request-state: track the last project_id per user to detect switches.

const userProjectMap = new Map(); // userId → last projectId seen

function detectProjectSwitch(userId, newProjectId) {
  if (!userId) return null;
  const last = userProjectMap.get(userId);
  if (!newProjectId || last === newProjectId) return null;
  userProjectMap.set(userId, newProjectId);
  return { previousProjectId: last, newProjectId };
}

// ── AI client factory ────────────────────────────────────────────────────────

function getAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1',
  });
}

// ── Sector agent dispatch ────────────────────────────────────────────────────

/**
 * W2: Enriched sector registry data for Tier 3.
 * Each sector gets: applicableCodes (with edition year), keyParameters,
 * and reference standards. This replaces the static stubs.
 *
 * W3 integration point: replace with real W3.sector_lookup() once the
 * 6-sector W3 MCP integration point is live.
 *
 * Returns: { registryVersion, applicableCodes[], keyParameters{}, projectOverrides, lastUpdated }
 */
async function getSectorData(sectorId, projectId) {
  const catalogs = {
    structural: {
      registryVersion: '1.0.2',
      applicableCodes: [
        { code: 'AISC 360-22',  edition: '2022', url: 'https://www.aisc.org/s06' },
        { code: 'ACI 318-22',    edition: '2022', url: 'https://www.concrete.org' },
        { code: 'ASCE 7-22',     edition: '2022', url: 'https://asce7.org' },
        { code: 'NDS 2018',      edition: '2018', url: 'https://www.awc.org' },
        { code: 'IBC 2021',      edition: '2021', url: 'https://www.iccsafe.org' },
      ],
      keyParameters: {
        loadCombinations: 'ASCE 7-22 Ch.2',
        lrfd_phi:          { steel: 0.9, concrete: 0.75, wood: 0.85 },
        deflectionLimit:   'L/240 (live), L/360 (total)',
        seismicDuctility:  'R = 3~8 per system type',
        minColSize:        '12 in. for seismic, 8 in. for non-seismic',
      },
      projectOverrides: projectId ? {} : {},
      lastUpdated: '2026-05-15',
    },

    mep: {
      registryVersion: '1.0.2',
      applicableCodes: [
        { code: 'ASHRAE 90.1-2019', edition: '2019', url: 'https://www.ashrae.org' },
        { code: 'ASHRAE 62.1-2019', edition: '2019', url: 'https://www.ashrae.org' },
        { code: 'NFPA 13',          edition: '2019', url: 'https://www.nfpa.org' },
        { code: 'NFPA 92',          edition: '2021', url: 'https://www.nfpa.org' },
        { code: 'NYC Mech Code',    edition: '2014', url: 'https://www.nyc.gov/site/builds' },
      ],
      keyParameters: {
        ductVelocity:     'max 1500 fpm for main, 1000 fpm for branch',
        pipePressureClass: '125 psi minimum for domestic water',
        diffuserSpacing:   'D/1.5 rule (D = diffuser throw)',
        sprinklerDensity:  '0.10 gpm/sqft Ordinary Hazard I',
        electricalPanel:   '80% derating on branch circuits',
      },
      lastUpdated: '2026-05-15',
    },

    thermal: {
      registryVersion: '1.0.2',
      applicableCodes: [
        { code: 'ASHRAE 90.1-2019', edition: '2019', url: 'https://www.ashrae.org' },
        { code: 'NYCECC 2020',      edition: '2020', url: 'https://www.nyc.gov/site/builds' },
        { code: 'EN-001',           edition: '2023', url: 'https://www.nyc.gov/site/builds' },
        { code: 'IECC 2021',         edition: '2021', url: 'https://codes.iccsafe.org' },
      ],
      keyParameters: {
        envelopeUValueMax: 0.32,  // wall, W/m²K
        roofUValueMax:     0.23,
        fenestrationSHGC: 0.40,
        airLeakageRate:   '0.40 cfm/sqft at 75 Pa',
        glazingUValueMax: '1.1 W/m²K (NY Climate Zone 4)',
        rValueMinWall:    'R-20 continuous insulation',
        thermalBridging:  'psi values per PHPP / LBNL thermal bridging database',
      },
      lastUpdated: '2026-05-15',
    },

    dob: {
      registryVersion: '1.0.2',
      applicableCodes: [
        { code: 'NYC BC 2014',    edition: '2014', url: 'https://www.nyc.gov/site/builds' },
        { code: 'ZR 61-01',       edition: '1961+', url: 'https://www.nyc.gov/site/planning' },
        { code: 'DOB Tbl 10-1',   edition: '2014', url: 'https://www.nyc.gov/site/builds' },
        { code: 'BC 2022',        edition: '2022', url: 'https://www.nyc.gov/site/builds' },
      ],
      keyParameters: {
        occupancyGroups:     ['A', 'B', 'E', 'F', 'H', 'I', 'M', 'R', 'S', 'U'],
        egressWidthMin:      '0.44 in per person (Table 1005.1)',
        stairWidthMin:       '44 in (3/8 in per person cap)',
        fireResistanceRating: 'Table 601 — 0–4 hr based on occupancy + height',
        corridorRating:      '1 hr for most occupancies',
        exitWidth:           '0.3 in per person for stairs',
        floorAreaPerPerson:  'varies by occupancy (BC Table 1004.1a)',
        maxBuildingHeight:   'varies by occupancy + construction type',
        FAR_byDistrict:      'per ZR Article II/III — check district R-value',
      },
      lastUpdated: '2026-05-15',
    },

    materials: {
      registryVersion: '1.0.2',
      applicableCodes: [
        { code: 'CSI MF 2023',   edition: '2023', url: 'https://www.csiresources.org' },
        { code: 'ASTM A36',      edition: '2019', url: 'https://www.astm.org' },
        { code: 'ASTM C90',      edition: '2016', url: 'https://www.astm.org' },
        { code: 'ASTM C129',     edition: '2017', url: 'https://www.astm.org' },
        { code: 'ASTM A615',     edition: '2020', url: 'https://www.astm.org' },
      ],
      keyParameters: {
        cmuCompressiveStrength: '1900 psi (Grade N)',
        concreteStrength:       '3000–5000 psi depending on exposure',
        rebarGrade:             'Grade 60 (fy=60 ksi) default, Grade 40 for temp steel',
        doorFireRating:         '20 min (residential), 45/60/90/180 min (commercial)',
        windowUValueMax:        '1.1 W/m²K (NYCECC 2020)',
        finishScheduleTypes:    ['door', 'window', 'floor', 'wall', 'ceiling'],
      },
      lastUpdated: '2026-05-15',
    },

    fire: {
      registryVersion: '1.0.2',
      applicableCodes: [
        { code: 'NFPA 13',           edition: '2019', url: 'https://www.nfpa.org' },
        { code: 'NFPA 101',          edition: '2021', url: 'https://www.nfpa.org' },
        { code: 'NFPA 72',           edition: '2019', url: 'https://www.nfpa.org' },
        { code: 'NYC FC Chapter 10', edition: '2023', url: 'https://www.nyc.gov/site/fdny' },
        { code: 'NYC BC 2022',       edition: '2022', url: 'https://www.nyc.gov/site/builds' },
      ],
      keyParameters: {
        sprinklerCoverage:    '130 sqft at 0.10 gpm/sqft (Ord. I)',
        occupantLoadFactor:   'varies by use — NFPA 101 Table 7.3.1',
        egressTravelDistMax: '200 ft (unsprinklered), 250 ft (sprinklered)',
        exitDoorCapacity:    '0.2 in/person for level travel',
        smokeControlPressure: '0.05 in wg min per ANSI/SMACNA 077',
        firePumpMinFlow:     'GPM = (area × density) × 1.3 safety factor',
        alarmAudibility:     'min 15 dB above ambient, 70 dB minimum',
      },
      lastUpdated: '2026-05-15',
    },
  };

  const data = catalogs[sectorId] || { registryVersion: '0.0.0', applicableCodes: [], keyParameters: {}, lastUpdated: '2026-01-01' };
  return { ...data, sectorId, projectId: projectId || null };
}

// ── Core agents: cross-sector soft link resolution ────────────────────────────

/**
 * For core agents, embed cross-sector hints in Tier 3 based on query keywords.
 * W3 integration point: replace with real W3.sector_lookup() once live.
 */
async function getCrossSectorHints(agentRole, projectId, query) {
  const hints = [];
  const lower = (query || '').toLowerCase();

  const sectorKeywords = {
    structural: ['beam', 'column', 'load', 'foundation', 'lateral', 'asce', 'aisc', 'aci'],
    mep:        ['duct', 'pipe', 'hvac', 'plumbing', 'electrical', 'ashrae'],
    thermal:    ['thermal', 'energy', 'u-value', 'r-value', 'envelope', 'ashrae 90'],
    dob:        ['zoning', 'far', 'setback', 'egress', 'dob filing', 'nyc bc'],
    materials:  ['finish', 'door', 'window', 'cmu', 'concrete', 'csi'],
    fire:       ['sprinkler', 'egress', 'fire', 'smoke', 'nfpa', 'occupant'],
  };

  for (const [sector, keywords] of Object.entries(sectorKeywords)) {
    const hitCount = keywords.filter(k => lower.includes(k)).length;
    if (hitCount > 0) hints.push(`${sector}:${hitCount}`);
  }

  return hints.length ? `Relevant sectors: ${hints.join(' | ')} — cross-sector coordination recommended.` : null;
}

// ── POST /api/wallt-agent/chat ───────────────────────────────────────────────

router.post('/chat', optionalAuth, async (req, res) => {
  try {
    const {
      agent = 'ingestion',
      messages,
      project_id: projectId,
      sector_data: sectorDataOverride,
      previous_outputs: previousOutputs,
      code_snapshot: codeSnapshot,
      cache_salt: cacheSalt,
      // W6: MCP-delivered inbound task context from Polsia / external systems
      mcp_context: mcpContext,
      task_id: taskId,
    } = req.body;

    if (!VALID_AGENTS.has(agent)) {
      return res.status(400).json({ error: `Invalid agent "${agent}". Valid: ${[...VALID_AGENTS].join(', ')}` });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const agentDef = AGENTS[agent];
    const sectorId = agentDef.sectorId;
    const ai = getAI();
    const userId = req.user ? req.user.id : null;

    // Project switch detection → invalidate Tier 1+ (Tier 0 survives)
    if (userId && projectId) {
      const switchEvent = detectProjectSwitch(userId, projectId);
      if (switchEvent) {
        promptCacheManager.invalidateProjectSwitch(
          switchEvent.previousProjectId,
          `project_switch:${switchEvent.newProjectId}`,
        );
      }
    }

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    // Build project context for Tier 1
    // Run project lookup + Drive context snapshot read in parallel (both non-fatal on failure)
    let projectName = null;
    let driveContext = null;
    await Promise.allSettled([
      (async () => {
        if (projectId) {
          const { getProjectById } = require('../db/projects');
          const project = await getProjectById(projectId).catch(() => null);
          projectName = project?.name || null;
        }
      })(),
      (async () => {
        if (userId) {
          const snapshot = await getLatestContextSnapshot(userId).catch(() => null);
          if (snapshot?.snapshot_data) {
            // Only inject if the snapshot is recent (< 24h) and matches project scope
            const ageMs = Date.now() - new Date(snapshot.created_at).getTime();
            const projectMatches = !snapshot.snapshot_data.project_id
                                 || !projectId
                                 || snapshot.snapshot_data.project_id === projectId;
            if (ageMs < 24 * 60 * 60 * 1000 && projectMatches) {
              driveContext = snapshot.snapshot_data;
            }
          }
        }
      })(),
    ]);

    // Tier 3: sector registry data (sector agents) or cross-sector hints (core agents)
    let tier3Data = {};
    let sectorVersionsUsed = {};
    if (sectorId !== 'core') {
      const sd = sectorDataOverride || await getSectorData(sectorId, projectId);
      tier3Data = sd;
      if (sd.registryVersion) sectorVersionsUsed[sectorId] = sd.registryVersion;
    } else {
      const crossHints = await getCrossSectorHints(agent, projectId, lastUserMsg);
      if (crossHints) tier3Data = { crossSectorHints: crossHints };
    }

    const conversationHistory = messages.slice(-20).map(m => ({
      role: m.role === 'wallt' ? 'assistant' : m.role,
      content: String(m.content || ''),
    }));

    // W6: Pass MCP context + sector version audit to buildAgentPrompt
    const { prompt, tierHashes, cacheStatus } = buildAgentPrompt({
      agentRole: agent,
      sectorId,
      projectId: projectId || null,
      projectName,
      userMessage: lastUserMsg,
      previousOutputs: previousOutputs || [],
      sectorData: tier3Data,
      codeSnapshot: codeSnapshot || {},
      taskContext: {
        conversationHistory: conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n'),
        // EXTERNAL tier: Drive BIM context snapshot (injected when available + fresh)
        driveContext: driveContext || null,
      },
      cacheSalt,
      mcpContext: mcpContext || null,    // W6: inbound MCP task context
      sectorVersionsUsed: Object.keys(sectorVersionsUsed).length ? sectorVersionsUsed : null,
    });

    // Compute cache hit rate across tiers 0-5
    const hitCount = Object.values(cacheStatus).filter(v => v === 'hit').length;
    const cacheHitRate = parseFloat((hitCount / 6).toFixed(3));

    const completion = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompt },
        ...conversationHistory,
      ],
      max_tokens: 768,
    });

    const choice = completion.choices[0];
    const reply = choice?.message?.content || '';
    const totalTokens = completion.usage?.total_tokens || 0;

    // W6: Bidirectional signaling — post completion event to shared event ledger.
    // Only fires when task_id is present (MCP routed task) to avoid noise on direct calls.
    if (taskId) {
      appendAgentEvent({
        agentId: agent,
        sectorId: sectorId !== 'core' ? sectorId : null,
        taskId,
        status: 'completed',
        resultSummary: reply.slice(0, 500),
        sectorVersionsUsed: Object.keys(sectorVersionsUsed).length ? sectorVersionsUsed : {},
        extra: { tokens: totalTokens, cache_hit_rate: cacheHitRate },
      }).catch(err => console.error('[wallt-agent] appendAgentEvent failed:', err.message));
    }

    res.json({
      reply,
      agent,
      sector_id: sectorId,
      metadata: {
        tokens: totalTokens,
        cache_hit_rate: cacheHitRate,
        cache_status: cacheStatus,
        tier_hashes: tierHashes,
        agent_role: agent,
        sector_id: sectorId,
      },
    });
  } catch (err) {
    console.error('[wallt-agent] /chat error:', err.message);
    // W6: Post failure event if task_id was provided
    if (taskId) {
      appendAgentEvent({
        agentId: agent,
        sectorId: sectorId !== 'core' ? sectorId : null,
        taskId,
        status: 'failed',
        resultSummary: err.message,
        sectorVersionsUsed: {},
      }).catch(() => {});
    }
    res.status(500).json({ error: 'AI call failed' });
  }
});

// ── GET /api/wallt-agent/cache/stats ──────────────────────────────────────────

router.get('/cache/stats', optionalAuth, async (req, res) => {
  try {
    const { agent, sector } = req.query;
    const stats = promptCacheManager.getStats();

    // Per-agent breakdown
    let agentBreakdown = {};
    if (agent && VALID_AGENTS.has(agent)) {
      const agentDef = AGENTS[agent];
      agentBreakdown[agent] = promptCacheManager.getHitRate({
        agentRole: agent,
        sectorId: agentDef?.sectorId || 'core',
        sampleSize: 200,
      });
    }

    // DB telemetry: per-tier hit rates + invalidation stats (last 24h)
    let dbTelemetry = null;
    try {
      const [tierHitRates, invStats] = await Promise.all([
        getTierHitRates(),
        getInvalidationStats(24),
      ]);
      dbTelemetry = { tierHitRates, invalidationStats: invStats };
    } catch (_) { /* DB not yet migrated — telemetry unavailable */ }

    res.json({
      global: stats,
      agent_breakdown: agentBreakdown,
      agents: AGENTS,
      db_telemetry: dbTelemetry,
      // W2 acceptance: >80% prefix cache rate on steady-state same-project requests
      acceptance: {
        target: 0.80,
        current: dbTelemetry ? Object.values(dbTelemetry.tierHitRates || {})
          .reduce((acc, t) => acc + t.hit_rate_proxy, 0) / 6 : null,
        note: 'Tier 0-1 hit rate is trivially 1.0 (hard-frozen). Tier 2+ depends on model serving layer (vLLM or Polsia proxy).',
      },
    });
  } catch (err) {
    console.error('[wallt-agent] /cache/stats error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve cache stats' });
  }
});

// ── POST /api/wallt-agent/cache/project-switch ───────────────────────────────
// Explicit project switch endpoint — callers can trigger it directly without
// relying on the implicit detection in /chat.

router.post('/cache/project-switch', optionalAuth, async (req, res) => {
  try {
    const { project_id, previous_project_id, reason } = req.body;
    if (!project_id) return res.status(400).json({ error: '"project_id" is required' });

    const affected = promptCacheManager.invalidateProjectSwitch(
      previous_project_id || null,
      reason || `project_switch:${project_id}`,
    );

    res.json({
      ok: true,
      project_id,
      previous_project_id: previous_project_id || null,
      affected_tier_1_plus: affected.length,
      tier_0_survived: true,
      reason: reason || 'project_switch',
    });
  } catch (err) {
    console.error('[wallt-agent] /cache/project-switch error:', err.message);
    res.status(500).json({ error: 'Project switch invalidation failed' });
  }
});

// ── POST /api/wallt-agent/cache/invalidate ────────────────────────────────────

router.post('/cache/invalidate', optionalAuth, async (req, res) => {
  try {
    const { agent, sector_id, reason, min_tier: minTier, project_id } = req.body;
    if (!reason) return res.status(400).json({ error: '"reason" is required for invalidation audit' });

    const affected = logInvalidation({
      agentRole: agent || null,
      sectorId: sector_id || null,
      minTier: minTier || 2,
      reason,
      projectId: project_id || null,
    });

    res.json({
      ok: true,
      reason,
      affected_count: affected.length,
      affected_keys: affected.slice(0, 10),
    });
  } catch (err) {
    console.error('[wallt-agent] /cache/invalidate error:', err.message);
    res.status(500).json({ error: 'Invalidation failed' });
  }
});

// ── POST /api/wallt-agent/cache/sector-ingest ────────────────────────────────
// Triggered by W3 sector ingestion updates — invalidates ONLY that sector's Tier 3+
// W2 acceptance criterion: sector ingestion invalidates only the affected sector.

router.post('/cache/sector-ingest', optionalAuth, async (req, res) => {
  try {
    const { sector_id, version, reason } = req.body;
    if (!sector_id) return res.status(400).json({ error: '"sector_id" is required' });

    const validSectors = ['structural', 'mep', 'thermal', 'dob', 'materials', 'fire'];
    if (!validSectors.includes(sector_id)) {
      return res.status(400).json({ error: `Invalid sector_id. Valid: ${validSectors.join(', ')}` });
    }

    const affected = promptCacheManager.invalidateSector(
      sector_id,
      reason || `sector_ingest_v${version || 'unknown'}`,
    );

    console.info(`[wallt-agent] Sector ingest invalidation: sector=${sector_id} affected=${affected.length}`);
    res.json({
      ok: true,
      sector_id,
      version: version || null,
      affected_tier_3_plus: affected.length,
      other_sectors_untouched: true,
      reason: reason || 'sector_ingest',
    });
  } catch (err) {
    console.error('[wallt-agent] /cache/sector-ingest error:', err.message);
    res.status(500).json({ error: 'Sector ingestion invalidation failed' });
  }
});

// ── GET /api/wallt-agent/cache/invalidation-log ──────────────────────────────
// Persisted invalidation events from wallt_cache_invalidation_log (last 24h).

router.get('/cache/invalidation-log', optionalAuth, async (req, res) => {
  try {
    const { sector, limit = 20 } = req.query;
    if (sector) {
      const rows = await getInvalidationsBySector(sector, Math.min(parseInt(limit, 10) || 20, 100));
      return res.json({ entries: rows, source: 'wallt_cache_invalidation_log', window: '24h' });
    }
    const stats = await getInvalidationStats(24).catch(() => []);
    return res.json({ stats, source: 'wallt_cache_invalidation_log', window: '24h' });
  } catch (err) {
    console.error('[wallt-agent] /cache/invalidation-log error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve invalidation log' });
  }
});

// ── GET /api/wallt-agent/sectors ────────────────────────────────────────────

router.get('/sectors', optionalAuth, async (req, res) => {
  const sectorAgents = Object.entries(AGENTS)
    .filter(([, def]) => def.sectorId !== 'core')
    .map(([key, def]) => ({
      agent_key: key,
      name: def.name,
      sector_id: def.sectorId,
      description: def.description,
      tier0_frozen: true,
      tier1_frozen: true,
    }));

  res.json({
    sectors: sectorAgents,
    core_agents: Object.entries(AGENTS)
      .filter(([, def]) => def.sectorId === 'core')
      .map(([key, def]) => ({ agent_key: key, name: def.name, sector_id: 'core', description: def.description })),
  });
});

// ── GET /api/wallt-agent/health ──────────────────────────────────────────────

router.get('/health', async (req, res) => {
  const stats = promptCacheManager.getStats();

  res.json({
    ok: true,
    agents_count: Object.keys(AGENTS).length,
    core_agents: 4,
    sector_agents: 6,
    version: '1.0',
    cache: {
      total_entries: stats.totalEntries,
      size_bytes: stats.currentSizeBytes,
      max_bytes: stats.maxSizeBytes,
      size_pct: stats.sizePct,
      last_invalidations: (stats.lastInvalidations || []).slice(0, 5).map(i => ({
        ts: i.ts,
        reason: i.reason,
        sector: i.sectorId,
        min_tier: i.minTier,
        affected: i.affectedCount,
      })),
    },
    tier_structure: {
      0: { name: 'role_definition',   stability: 'frozen',      changes: 'agent redesign only', hard_frozen: true },
      1: { name: 'project_metadata', stability: 'semi-frozen', changes: 'project switch or sector re-pin', hard_frozen: true },
      2: { name: 'tool_definitions', stability: 'stable',      note: 'sort_keys=True → deterministic hash survives reorder' },
      3: { name: 'sector_registry',  stability: 'dynamic',    changes: 'sector ingestion update' },
      4: { name: 'codebase_snapshot', stability: 'semi-stable',changes: 'code diff' },
      5: { name: 'previous_outputs', stability: 'dynamic',    changes: 'every pipeline run' },
    },
    cache_key_format: '{project_id}:{agent_role}:{sector_id}:{tier_hash}',
    acceptance_criteria: {
      '>80% steady-state hit rate':  'db_telemetry.tierHitRates tracks per-tier hit rate',
      'Tier 0-1 never evicted':      stats.byTier ? `${(stats.byTier[0]?.frozen||0)+(stats.byTier[1]?.frozen||0)} frozen blocks` : 'check byTier',
      'Tool reorder ≠ invalidation': 'hashJson uses sort_keys — JSON identical regardless of tool order',
      'Project switch invalidates Tier 1+': 'POST /cache/project-switch + implicit detection in /chat',
      'Sector ingest invalidates only that sector': 'invalidateSector(sectorId) → minTier=3, sectorId scoped',
      'Invalidation events logged with tier+reason+sector_id': 'wallt_cache_invalidation_log persisted via db/prompt-cache.js',
    },
  });
});

module.exports = router;
module.exports.AGENTS = AGENTS;
module.exports.VALID_AGENTS = VALID_AGENTS;