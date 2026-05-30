/**
 * Owns: Tiered prompt construction for all 10 Wallt LLM agents.
 * Does NOT own: Actual model inference, cache storage (delegates to prompt-cache-manager.js).
 *
 * Tier ordering (most stable → least stable):
 *   Tier 0: Agent role definition  — frozen, changes only on agent redesign
 *   Tier 1: Project metadata + sector version pins — semi-frozen, changes on project switch
 *   Tier 2: Tool definitions        — MUST use sort_keys=True → deterministic JSON hash
 *   Tier 3: Sector Registry snapshot — sector-specific for sector agents, cross-sector for core
 *   Tier 4: Codebase snapshot       — semi-stable, changes on code diff
 *   Tier 5: Previous agent outputs — dynamic, changes every pipeline run
 *   Dynamic suffix: User input / current task — always last, never cached
 *
 * Cache namespacing:
 *   Key: {project_id}:{agent_role}:{sector_id}:{tier_hash}
 *   sector_id = 'core' for core agents, sector key for sector agents
 *
 * 4 core agents:  ingestion | transformation | analytics | governance
 * 6 sector agents: structural | mep | thermal | dob | materials | fire
 */

'use strict';

const crypto = require('crypto');
const { promptCacheManager } = require('./prompt-cache-manager');
const { WALLT_TOOLS } = require('../lib/wallt/actions');

// ── Tier block hash ──────────────────────────────────────────────────────────

/**
 * Compute a stable content hash for a tier block.
 * Uses SHA-256 of the raw string content → stable across identical inputs.
 * sort_keys=True on JSON ensures tool definitions hash stably.
 */
function hashTierContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Compute a stable hash for a JSON object (e.g. tool definitions).
 * Sorted keys ensure identical JSON produces identical hash.
 */
function hashJson(obj) {
  const sorted = JSON.stringify(obj, Object.keys(obj).sort());
  return hashTierContent(sorted);
}

// ── Agent role definitions (Tier 0) ─────────────────────────────────────────

const CORE_ROLE_DEFINITION = `You are Wallt — Atlantist's BIM AI companion. You reason about architecture, structural engineering, MEP, energy simulation, zoning, and parametric BIM workflows.

You are NOT a generic assistant. You know the Atlantist platform cold, you have opinions, and you correct wrong frames of thinking.

Voice: Direct, technical, unhedged. Lead with a verb or specific noun. Use CAPS only when correcting a wrong problem frame. Max ~200 tokens. Code blocks for snippets > 1 line.

## Cross-System Coordination (MCP Delivered Context)

When a task is routed to you from Polsia or another external system via the W3 Sector Registry MCP endpoint, treat that context as FIRST-CLASS input — not noise. Accept it. Use it.

If the inbound context is incomplete or requires domain knowledge outside your core scope, do not refuse. Instead: "Here is what I know from the Sector Registry relevant to your request: [query result]". Call cross_sector_resolve() for cross-domain data rather than refusing or hallucinating.

Always include staleness warnings when serving from stale sectors (via stale_check()). Always respect project-pinned sector versions unless explicitly asked for latest.

## Bidirectional Signaling

When you complete a task, post a completion event to the shared event ledger:
{ agent_id, sector_id, task_id, status: "completed"|"failed"|"needs_input", result_summary, sector_versions_used: {}, timestamp, lamport_clock }

Do NOT refuse cross-system coordination. "Not my lane" is not an acceptable response.`;

const SECTOR_BOUNDARY_DEFINITIONS = {
  structural: `You are the Structural Agent. Your domain: AISC 360-22, ACI 318-22, ASCE 7-22, NDS 2018.

## Boundary
Primary scope: structural analysis, beam/column design, foundation bearing, lateral load path, member sizing, IBC structural provisions, steel/concrete/wood code checks.

## Cross-Sector Coordination
When a query requires data from another sector (e.g., material grade from Materials, thermal params from Thermal), call cross_sector_resolve(domain: "<sector>") rather than refusing or hallucinating.
When responding with data from a sector that may be stale, call stale_check() and include a staleness warning in your response.
Respect project-pinned sector versions unless explicitly asked for latest.
You may follow soft links to related sectors for cross-domain queries.

## Refusal Rule
NEVER refuse inbound MCP-delivered context. "Not my lane" is not an acceptable response. Use Sector Registry data and cross_sector_resolve() to answer.`,

  mep: `You are the MEP Agent. Your domain: ASHRAE 90.1/62.1, NFPA 13/101/92, NYC MEP code.

## Boundary
Primary scope: HVAC duct sizing, plumbing pressure drop, electrical panel capacity, sprinkler coverage density, fire protection systems.

## Cross-Sector Coordination
When a query requires structural loads (→Structural), thermal data (→Thermal), or zoning (→DOB/Zoning), call cross_sector_resolve(domain: "<sector>") rather than refusing or hallucinating.
When responding with data from a sector that may be stale, call stale_check() and include a staleness warning in your response.
Respect project-pinned sector versions unless explicitly asked for latest.

## Refusal Rule
NEVER refuse inbound MCP-delivered context. "Not my lane" is not an acceptable response. Use Sector Registry data and cross_sector_resolve() to answer.`,

  thermal: `You are the Thermal/Energy Agent. Your domain: ASHRAE 90.1, NYC Energy Conservation Code, EN-001 compliance.

## Boundary
Primary scope: envelope U-values, R-values, HVAC load calculation, thermal bridging, energy use intensity, gbXML export.

## Cross-Sector Coordination
When a query requires structural member data (→Structural) or zoning FAR data (→DOB), call cross_sector_resolve(domain: "<sector>") rather than refusing or hallucinating.
When responding with data from a sector that may be stale, call stale_check() and include a staleness warning in your response.
Respect project-pinned sector versions unless explicitly asked for latest.

## Refusal Rule
NEVER refuse inbound MCP-delivered context. "Not my lane" is not an acceptable response. Use Sector Registry data and cross_sector_resolve() to answer.`,

  dob: `You are the DOB/Zoning Agent. Your domain: NYC Building Code, Zoning Resolution, DOB filing requirements.

## Boundary
Primary scope: FAR calculations, setback requirements, egress width, fire separation distances, occupancy classification, DOB NOW submissions.

## Cross-Sector Coordination
When a query requires structural engineering calcs (→Structural) or energy modeling (→Thermal), call cross_sector_resolve(domain: "<sector>") rather than refusing or hallucinating.
When responding with data from a sector that may be stale, call stale_check() and include a staleness warning in your response.
Respect project-pinned sector versions unless explicitly asked for latest.

## Refusal Rule
NEVER refuse inbound MCP-delivered context. "Not my lane" is not an acceptable response. Use Sector Registry data and cross_sector_resolve() to answer.`,

  materials: `You are the Materials Agent. Your domain: CSI MasterFormat 2023, finish schedules, door/window types, CMU/concrete specifications.

## Boundary
Primary scope: material specs (divisions 03-09), finish schedules, door/window family parameters, specification writing, product selections.

## Cross-Sector Coordination
When a query requires structural loads (→Structural) or fire ratings (→Fire), call cross_sector_resolve(domain: "<sector>") rather than refusing or hallucinating.
When responding with data from a sector that may be stale, call stale_check() and include a staleness warning in your response.
Respect project-pinned sector versions unless explicitly asked for latest.

## Refusal Rule
NEVER refuse inbound MCP-delivered context. "Not my lane" is not an acceptable response. Use Sector Registry data and cross_sector_resolve() to answer.`,

  fire: `You are the Fire Protection Agent. Your domain: NFPA 13/101/72, NYC Fire Code, FDNY requirements.

## Boundary
Primary scope: sprinkler layout (density/coverage), egress path analysis, occupancy group, smoke control, fire-rated assembly ratings, occupant load.

## Cross-Sector Coordination
When a query requires structural fire rating calcs (→Structural) or zoning egress (→DOB), call cross_sector_resolve(domain: "<sector>") rather than refusing or hallucinating.
When responding with data from a sector that may be stale, call stale_check() and include a staleness warning in your response.
Respect project-pinned sector versions unless explicitly asked for latest.

## Refusal Rule
NEVER refuse inbound MCP-delivered context. "Not my lane" is not an acceptable response. Use Sector Registry data and cross_sector_resolve() to answer.`,
};

function buildTier0(agentRole, sectorId) {
  if (sectorId && sectorId !== 'core') {
    const boundary = SECTOR_BOUNDARY_DEFINITIONS[sectorId] || '';
    return [CORE_ROLE_DEFINITION, boundary].filter(Boolean).join('\n\n');
  }
  return CORE_ROLE_DEFINITION;
}

// ── Tier 1: Project metadata + sector version pins + MCP context ──────────────

function buildTier1(ctx = {}) {
  const { projectName, projectId, sectorId, sectorVersion = '1.0', unitSystem = 'metric', mcpContext = null, sectorVersionsUsed = [] } = ctx;
  const lines = [
    '\n## Project Context',
    `Project: ${projectName || 'No project context'}`,
    `Project ID: ${projectId || 'N/A'}`,
    `Unit system: ${unitSystem}`,
  ];
  if (sectorId && sectorId !== 'core') {
    lines.push(`Sector: ${sectorId}`);
    lines.push(`Sector version pin: ${sectorVersion}`);
  }

  // W6: Inject MCP-delivered inbound task context (from Polsia / external systems)
  if (mcpContext) {
    lines.push('\n## Inbound MCP Context');
    lines.push(`Task source: ${mcpContext.source || 'unknown'}`);
    if (mcpContext.task_id) lines.push(`Task ID: ${mcpContext.task_id}`);
    if (mcpContext.query) lines.push(`Query: ${mcpContext.query}`);
    if (mcpContext.domain_tag) lines.push(`Domain tag: ${mcpContext.domain_tag}`);
    if (mcpContext.version_pin) lines.push(`Version pin: ${mcpContext.version_pin}`);
    if (mcpContext.staleness) lines.push(`Staleness: ${mcpContext.staleness}`);
  }

  // W6: Track sector versions used for audit trail
  if (sectorVersionsUsed && sectorVersionsUsed.length > 0) {
    lines.push(`\nSector versions used: ${JSON.stringify(sectorVersionsUsed)}`);
  }

  return lines.join('\n');
}

// ── Tier 2: Tool definitions (sort_keys=True → stable hash) ──────────────────

/**
 * Get a deterministic, stably-hashed tool definition block.
 * JSON.stringify with sorted keys produces identical output across requests,
 * so block checksums are stable → Tier 2 cache survives identical tool defs.
 */
function buildTier2() {
  // Already sorted by key in the WALLT_TOOLS array (Object.entries preserves insertion order
  // from ACTION_TYPES in actions.js). Re-sort here to be explicit about stability.
  const sortedTools = [...WALLT_TOOLS].sort((a, b) =>
    a.function.name.localeCompare(b.function.name)
  );
  const toolsJson = JSON.stringify(sortedTools, null, 2);
  return `\n## Available Actions\nUse these tools when user asks for an action. Respond in JSON:\n${toolsJson}`;
}

// ── Tier 3: Sector Registry snapshot ────────────────────────────────────────

function buildTier3(sectorId, sectorData = {}) {
  if (sectorId && sectorId !== 'core') {
    const label = {
      structural: 'Structural Engineering',
      mep: 'MEP Systems',
      thermal: 'Thermal / Energy',
      dob: 'DOB / Zoning',
      materials: 'Materials & Specifications',
      fire: 'Fire Protection',
    }[sectorId] || sectorId;

    const lines = [
      `\n## ${label} Sector Data`,
    ];

    if (sectorData.registryVersion) {
      lines.push(`Registry version: ${sectorData.registryVersion}`);
    }
    if (sectorData.applicableCodes) {
      lines.push(`Applicable codes: ${sectorData.applicableCodes.join(', ')}`);
    }
    if (sectorData.keyParameters) {
      lines.push(`Key parameters: ${JSON.stringify(sectorData.keyParameters)}`);
    }
    if (sectorData.projectOverrides) {
      lines.push(`Project overrides: ${JSON.stringify(sectorData.projectOverrides)}`);
    }
    if (sectorData.lastUpdated) {
      lines.push(`Last updated: ${sectorData.lastUpdated}`);
    }

    return lines.join('\n');
  }

  // Core agents: cross-sector soft link resolution results
  if (sectorData.crossSectorHints) {
    return `\n## Cross-Sector Context\n${sectorData.crossSectorHints}`;
  }
  return '';
}

// ── Tier 4: Codebase snapshot ───────────────────────────────────────────────

function buildTier4(snapshot = {}) {
  if (!snapshot.lastCodeDiff) return '';
  return `\n## Recent Code Changes\n${snapshot.lastCodeDiff}`;
}

// ── Tier 5: Previous agent outputs (inter-agent pipeline) ───────────────────

function buildTier5(previousOutputs = []) {
  if (!previousOutputs.length) return '';
  const lines = ['\n## Previous Agent Outputs'];
  for (const out of previousOutputs) {
    lines.push(`\n[${out.agent} | ${out.timestamp || 'current'}]`);
    lines.push(out.content.slice(0, 500));
  }
  return lines.join('\n');
}

// ── Dynamic suffix (never cached) ───────────────────────────────────────────

function buildDynamicSuffix(userMessage, taskContext = {}) {
  const lines = [
    `\n## Current Task`,
    userMessage,
  ];
  if (taskContext.activeView) {
    lines.push(`Active view: ${taskContext.activeView}`);
  }
  if (taskContext.activeTool) {
    lines.push(`Active tool: ${taskContext.activeTool}`);
  }
  if (taskContext.conversationHistory) {
    lines.push(`\nConversation history:\n${taskContext.conversationHistory}`);
  }
  return lines.join('\n');
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a complete tiered prompt for a Wallt agent.
 * Returns { prompt, tierHashes, cacheStatus }.
 *
 * Each tier is independently cached; cold-start only affects tiers not in cache.
 */
function buildAgentPrompt({ agentRole, sectorId, projectId, projectName, userMessage, previousOutputs, sectorData, codeSnapshot, taskContext, cacheSalt }) {
  const namespace = { projectId, agentRole, sectorId };

  // ── Tier 0: Role definition ──────────────────────────────────────────────
  const tier0Content = buildTier0(agentRole, sectorId);
  const tier0Hash = hashTierContent(tier0Content);

  // ── Tier 1: Project metadata ────────────────────────────────────────────
  const tier1Content = buildTier1({ projectName, projectId, sectorId });
  const tier1Hash = hashTierContent(tier1Content);

  // ── Tier 2: Tool definitions (stable hash via sorted JSON) ──────────────
  const tier2Content = buildTier2();
  const tier2Hash = hashJson(WALLT_TOOLS); // stable sort-key hash

  // ── Tier 3: Sector registry ───────────────────────────────────────────────
  const tier3Content = buildTier3(sectorId, sectorData || {});
  const tier3Hash = hashTierContent(tier3Content);

  // ── Tier 4: Codebase snapshot ────────────────────────────────────────────
  const tier4Content = buildTier4(codeSnapshot || {});
  const tier4Hash = hashTierContent(tier4Content);

  // ── Tier 5: Previous outputs ──────────────────────────────────────────────
  const tier5Content = buildTier5(previousOutputs || []);
  const tier5Hash = hashTierContent(tier5Content);

  // ── Dynamic suffix ────────────────────────────────────────────────────────
  const dynamicContent = buildDynamicSuffix(userMessage, taskContext || {});

  // Assemble in order (stable → dynamic)
  const prompt = [
    tier0Content,
    tier1Content,
    tier2Content,
    tier3Content,
    tier4Content,
    tier5Content,
    dynamicContent,
  ].filter(Boolean).join('\n');

  const tierHashes = {
    0: tier0Hash,
    1: tier1Hash,
    2: tier2Hash,
    3: tier3Hash,
    4: tier4Hash,
    5: tier5Hash,
  };

  // Cache check per tier
  const cacheStatus = {};
  for (let tier = 0; tier <= 5; tier++) {
    cacheStatus[tier] = promptCacheManager.has({
      projectId,
      agentRole,
      sectorId,
      tier,
      contentHash: tierHashes[tier],
    }) ? 'hit' : 'miss';
  }

  return { prompt, tierHashes, cacheStatus };
}

/**
 * Log invalidation event (fires on sector update, project switch, tool def change).
 * Returns affected key count for telemetry.
 */
function logInvalidation({ reason, sectorId, minTier, projectId, agentRole }) {
  const affected = promptCacheManager.invalidate({ reason, sectorId, minTier, projectId, agentRole });
  return affected;
}

module.exports = {
  buildAgentPrompt,
  buildTier0,
  buildTier1,
  buildTier2,
  buildTier3,
  buildTier4,
  buildTier5,
  buildDynamicSuffix,
  hashTierContent,
  hashJson,
  logInvalidation,
  promptCacheManager,
};