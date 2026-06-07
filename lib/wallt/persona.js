/**
 * Owns: Wallt personality engine — system prompt generation and style validation.
 * Does NOT own: AI model calls, DB persistence, WebSocket relay.
 *
 * Exports:
 *   buildSystemPrompt(ctx) → string
 *   validate(response)     → { pass: boolean, score: number, reasons: string[] }
 *   PERSONA_VERSION        → string (bump when profile changes; stored on conversations)
 */
'use strict';

const path = require('path');
const profile = require(path.join(__dirname, '../../data/wallt_personality_profile.json'));

const PERSONA_VERSION = '1.1.0';  // bumped: environment context blocks + walkthrough slots

// ── System prompt ─────────────────────────────────────────────────────────────

/**
 * Builds the versioned Wallt system prompt.
 * @param {Object} ctx  Optional runtime context injected per-request
 * @param {string} [ctx.projectName]        Current project name
 * @param {string} [ctx.projectId]          Current project ID
 * @param {string} [ctx.userRole]           User's role in the project
 * @param {boolean} [ctx.tight]             True on retry — tighten voice constraints
 * @param {Object} [ctx.rectOpinion]        RECT opinion from legal engine
 *
 * ── ENVIRONMENT CONTEXT SLOTS (live scene state — injected per-message) ──
 * @param {string} [ctx.activeView]         e.g. 'plan', 'section', '3d', 'energy', 'structural'
 * @param {string} [ctx.activeTool]         e.g. 'wall', 'door', 'annotate', 'orbit', 'section-cut'
 * @param {Object} [ctx.selection]          { type, id, label, level, properties } — selected element
 * @param {Object} [ctx.scene]              { elementCount, levels[], floors, ceilings, walls, columns } counts
 * @param {Object} [ctx.camera]             { mode: 'perspective'|'orthographic', azimuth, elevation, fov, target }
 * @param {Object} [ctx.modelStats]         { grossArea, heightM, levelCount, structuralSystem }
 * @param {Object} [ctx.walkthrough]        { active: bool, mode: 'first-person'|'fly', positionM, headingDeg }
 *                                          — reserved slot for real-time walkthrough data feed
 * @param {Object} [ctx.simulation]         { type: 'energy'|'structural'|'fire', status, lastRunAt }
 * @param {Object} [ctx.recentActions]      string[] — last 5 user actions for continuity
 * @returns {string}
 */
function buildSystemPrompt(ctx = {}) {
  const { identity, tone_rules, vocab_lexicon, response_shape } = profile;

  // ─── Project block ────────────────────────────────────────────────────────────────
  const contextBlock = ctx.projectName
    ? `\n\n## Active Project\n- Name: ${ctx.projectName}\n- ID: ${ctx.projectId || 'unknown'}${ctx.userRole ? `\n- User role: ${ctx.userRole}` : ''}`
    : '';

  // ─── Environment block (live scene state) ────────────────────────────────────────
  const envLines = [];

  if (ctx.activeView)  envLines.push(`- View: ${ctx.activeView}`);
  if (ctx.activeTool)  envLines.push(`- Active tool: ${ctx.activeTool}`);

  if (ctx.selection && ctx.selection.type) {
    const s = ctx.selection;
    envLines.push(`- Selected: ${s.label || s.type} (${s.type}${s.id ? `, id ${s.id}` : ''}${s.level ? `, ${s.level}` : ''})`);
    if (s.properties && Object.keys(s.properties).length) {
      const props = Object.entries(s.properties).slice(0, 8).map(([k,v]) => `${k}=${v}`).join(', ');
      envLines.push(`  Properties: ${props}`);
    }
  }

  if (ctx.scene) {
    const sc = ctx.scene;
    const parts = [];
    if (sc.elementCount != null) parts.push(`${sc.elementCount} elements`);
    if (sc.levels != null)       parts.push(`${Array.isArray(sc.levels) ? sc.levels.length : sc.levels} levels`);
    if (sc.walls != null)        parts.push(`${sc.walls} walls`);
    if (sc.columns != null)      parts.push(`${sc.columns} columns`);
    if (sc.floors != null)       parts.push(`${sc.floors} floors`);
    if (parts.length)            envLines.push(`- Scene: ${parts.join(', ')}`);
    if (Array.isArray(sc.levels) && sc.levels.length) {
      envLines.push(`  Levels: ${sc.levels.map(l => `${l.name}@${l.elevation ?? l.elevationM ?? '?'}m`).join(', ')}`);
    }
  }

  if (ctx.modelStats) {
    const ms = ctx.modelStats;
    const msParts = [];
    if (ms.grossArea)        msParts.push(`${ms.grossArea} m² gross`);
    if (ms.heightM)          msParts.push(`${ms.heightM} m tall`);
    if (ms.structuralSystem) msParts.push(ms.structuralSystem);
    if (msParts.length)      envLines.push(`- Model: ${msParts.join(', ')}`);
  }

  if (ctx.camera) {
    const c = ctx.camera;
    const camParts = [c.mode || 'perspective'];
    if (c.fov != null) camParts.push(`FOV ${c.fov}°`);
    envLines.push(`- Camera: ${camParts.join(', ')}`);
  }

  // Walkthrough slot — reserved for real-time first-person / fly-through feed.
  // When active, Wallt receives continuous position + heading data and can
  // answer spatial questions, highlight nearby elements, and guide navigation.
  if (ctx.walkthrough && ctx.walkthrough.active) {
    const wt = ctx.walkthrough;
    envLines.push(`- Walkthrough: ACTIVE (${wt.mode || 'first-person'})`);
    if (wt.positionM) envLines.push(`  Position: ${JSON.stringify(wt.positionM)}`);
    if (wt.headingDeg != null) envLines.push(`  Heading: ${wt.headingDeg}°`);
  }

  if (ctx.simulation && ctx.simulation.status) {
    envLines.push(`- Simulation: ${ctx.simulation.type || 'unknown'} (${ctx.simulation.status})`);
  }

  if (ctx.recentActions && ctx.recentActions.length) {
    envLines.push(`- Recent actions: ${ctx.recentActions.slice(-5).join(' → ')}`);
  }

  const envBlock = envLines.length
    ? `\n\n## Live Environment\n${envLines.join('\n')}\n\nWhen the environment block is present, ground your response in what is actually loaded. Reference the selected element, active tool, or scene state directly when relevant.`
    : '';

  // ─── Retry / RECT blocks ────────────────────────────────────────────────────────────
  const tightBlock = ctx.tight
    ? '\n\nIMPORTANT — RETRY MODE: Your previous response was rejected by the style validator. Be shorter, more direct, and avoid all forbidden phrases. Lead with a verb or a specific noun. Do not hedge.'
    : '';

  const rectBlock = ctx.rectOpinion
    ? `\n\n## RECT Legal Engine — Active\nThe Layer 3 legal engine has evaluated this pricing action. Result: **${ctx.rectOpinion.verdict}**\nReason: ${ctx.rectOpinion.reason}\nRule: ${ctx.rectOpinion.rule}\n${ctx.rectOpinion.verdict === 'NON_COMPLIANT' ? '⚠️ ACTION BLOCKED. Do not suggest executing this pricing action. Explain the RECT violation clearly and tell the user this requires Polsia approval before it can proceed.' : ctx.rectOpinion.verdict === 'AMBIGUOUS' ? '⚠️ ACTION REQUIRES REVIEW. The legal status is ambiguous — explain what must be resolved before this pricing action can proceed.' : '✓ RECT COMPLIANT. This pricing action preserves equal-cost distribution in the cooperative model.'}`
    : '';

  const neverSay = response_shape.never_say.join(', ');

  return `You are ${identity.name}. ${identity.role}.

Voice: ${identity.voice}

You are NOT a generic assistant. You are Wallt — you know the Atlantist platform cold, you have opinions, and you correct wrong frames of thinking.

## Tone rules (follow exactly)
${tone_rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Wavetree principle
Nothing is finished, only growing. Never claim a design is perfect. "Good enough to ship" is the ceiling.

## Response shape
- Max ~${response_shape.max_length_tokens} tokens. Prefer shorter.
- Markdown OK. Dash lists over numbered unless steps are ordered.
- Code blocks for any snippet > 1 line.
- Use CAPS only when correcting a wrong problem frame.

## Forbidden phrases (NEVER say these)
${neverSay}

## When to push back
${response_shape.when_to_push_back}

## Scope
Architecture, BIM workflows, structural engineering, energy analysis, MEP, parametric modeling, IFC/DXF/RVT import-export, real-time walkthroughs, platform UX. Off-topic requests: decline in one sentence.${contextBlock}${envBlock}${tightBlock}${rectBlock}`;
}

// ── Style validator ───────────────────────────────────────────────────────────

// Forbidden phrases — exact match (case-insensitive)
const FORBIDDEN_PHRASES = profile.response_shape.never_say.map(p => p.toLowerCase());

// Soft style signals: at least one should be present in passing responses
const STYLE_SIGNALS = [
  // Direct verb opener (starts sentence with imperative or active verb)
  /(?:^|\n)\s*[A-Z][a-z]+\s+(?:to|the|your|it|this|a|an)\b/,
  // Short clause (sentence under 12 words ending with period/question mark)
  /(?:^|[.!?\n])\s*(?:\w+\s+){1,11}\w+[.!?]/,
  // Technical noun from vocab
  new RegExp(`\\b(${[
    ...profile.vocab_lexicon.bim_tools,
    ...profile.vocab_lexicon.structural,
    ...profile.vocab_lexicon.geometry,
    ...profile.vocab_lexicon.energy,
    ...profile.vocab_lexicon.platform,
  ].join('|')})\\b`, 'i'),
];

/**
 * Validates a model response against the Wallt style profile.
 * @param {string} response  Raw model output text
 * @returns {{ pass: boolean, score: number, reasons: string[] }}
 *   score: 0.0–1.0 (1.0 = perfect)
 *   pass:  true if score >= 0.4 and no forbidden phrases
 */
function validate(response) {
  const reasons = [];
  let deductions = 0;

  if (!response || typeof response !== 'string' || response.trim().length === 0) {
    return { pass: false, score: 0, reasons: ['Empty response'] };
  }

  const lower = response.toLowerCase();

  // Hard fail: forbidden phrases
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) {
      reasons.push(`Contains forbidden phrase: "${phrase}"`);
      deductions += 0.35;
    }
  }

  // Hard fail: too long (rough token estimate — 4 chars/token)
  const estimatedTokens = Math.ceil(response.length / 4);
  const maxTokens = profile.response_shape.max_length_tokens;
  if (estimatedTokens > maxTokens * 1.5) {
    reasons.push(`Response too long (~${estimatedTokens} tokens, limit ${maxTokens})`);
    deductions += 0.25;
  }

  // Soft style: check for at least one signal
  const signalHits = STYLE_SIGNALS.filter(rx => rx.test(response));
  if (signalHits.length === 0) {
    reasons.push('No style signal detected (direct verb opener, short clause, or technical noun)');
    deductions += 0.15;
  }

  const score = Math.max(0, Math.min(1, 1 - deductions));
  const pass = score >= 0.4 && !reasons.some(r => r.startsWith('Contains forbidden phrase'));

  return { pass, score: parseFloat(score.toFixed(2)), reasons };
}

module.exports = { buildSystemPrompt, validate, PERSONA_VERSION };
