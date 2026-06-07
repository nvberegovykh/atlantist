/**
 * Owns: /api/wallt/* — Wallt AI Companion REST API.
 * Does NOT own: personality engine (lib/wallt/persona.js), action schema (lib/wallt/actions.js).
 * Phase 34C: project context injection, NYC zoning RAG, citation rendering.
 * Phase 34D: OpenAI function-calling → action chips, actions_json persistence, telemetry.
 * Phase 35F: RECT Legal Engine — Layer 3 cooperative pricing compliance checks.
 * Phase 36N: Session Memory — ephemeral Redis store, tool call tracking, abort signals.
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const OpenAI = require('openai');
const pool = require('../db/index');
const {
  createConversation, getConversationById, listConversations,
  archiveConversation, touchConversation,
  createMessage, getMessagesByConversation,
  saveContextSnapshot, getLatestContextSnapshot,
} = require('../db/wallt');
const { upsertDailyCost } = require('../db/cost-ledger');
const { buildSystemPrompt, validate, PERSONA_VERSION } = require('../lib/wallt/persona');
const { searchChunks } = require('../db/wallt-zoning');
const { getModelHistory } = require('../db/events');
const { WALLT_TOOLS, parseToolCalls } = require('../lib/wallt/actions');
const { insertEvent: insertAppEvent } = require('../db/app-events');
const { checkRECT, runLegalCheck } = require('../services/rect-legal-engine');
const escalationService = require('../services/wallt-escalation');
const { legal_compliance_check: checkLegalCompliance } = require('../services/wallt-legal-compliance');
const { getSessionByToken } = require('../db/auth');
const { getUserRole } = require('../db/roles');
const {
  appendToolCall, startToolCall, completeToolCall, abortToolCall,
  checkAbortSignal,
  appendEvent, initSession, extendTTL, wipeSession, storeExists, SESSION_KEY_PREFIX,
} = require('../services/wallt-session-store');

// Cost per 1k tokens (GPT-4o-mini via Polsia proxy) — updated as pricing changes
const COST_PER_1K_TOKENS_USD = 0.00015;

function getAI() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not configured on this server.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
}

function resolveUserId(req) {
  return req.user ? req.user.id : null;
}

// ── NYC Zoning RAG ───────────────────────────────────────────────────────────

// Simple keyword classifier — triggers RAG for zoning questions
const ZONING_TRIGGERS = [
  'far', 'floor area ratio', 'setback', 'setbacks',
  'height limit', 'building height', 'height factor',
  'yard', 'yards', 'rear yard', 'front yard', 'side yard',
  'zoning', 'zoning district', 'zr ', '§23', '§24', '§33', '§35',
  'use group', 'community facility', 'quality housing',
  'dob filing', 'nyc zoning', 'floor area',
];
const ZONING_DISTRICT_RE = /\b(R[1-9]|R10|R11|R12)([A-Z])?\b/;
const DOB_TRIGGERS = ['dob', 'filing', 'dob now', 'department of buildings'];

function isZoningQuestion(text) {
  const lower = text.toLowerCase();
  const hasDistrict = ZONING_DISTRICT_RE.test(text);
  const hasTrigger = ZONING_TRIGGERS.some(t => lower.includes(t));
  const hasDOB = DOB_TRIGGERS.some(t => lower.includes(t));
  return hasDistrict || hasTrigger || hasDOB;
}

// Fallback: embed a query string using OpenAI text-embedding-3-small
async function embedQuery(ai, text) {
  const resp = await ai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 4000),
  });
  return resp.data[0].embedding;
}

// Retrieve top-4 zoning chunks for a query
async function retrieveZoningChunks(ai, query, projectZoningDistrict = null) {
  try {
    const embedding = await embedQuery(ai, query);
    const chunks = await searchChunks(embedding, 4);

    // If project has a known zoning district, boost that district's chunks
    if (projectZoningDistrict && chunks.length < 4) {
      const districtChunks = await searchChunks(embedding, 4);
      // Already in chunks — no extra action needed
    }

    return chunks;
  } catch (err) {
    console.warn('[wallt] RAG embed failed, skipping:', err.message);
    return [];
  }
}

// Extract source URLs from model reply text
function extractCitations(replyText, chunks) {
  const cited = new Set();

  // Always include source_url from retrieved chunks
  for (const chunk of chunks) {
    if (chunk.source_url) cited.add(chunk.source_url);
  }

  // Also scan reply for any nyc.gov URLs
  const urlMatches = replyText.match(/https?:\/\/[^\n\t )]+/g) || [];
  for (const url of urlMatches) {
    if (url.includes('nyc.gov') || url.includes('zr.planning.nyc.gov')) {
      cited.add(url);
    }
  }

  return [...cited];
}

// Format retrieved chunks into RAG context block (≤1500 tokens)
function formatZoningContext(chunks) {
  if (!chunks.length) return '';
  const lines = ['\n## NYC Zoning Resolution Reference'];
  for (const chunk of chunks) {
    lines.push(`\n[${chunk.district} — ${chunk.section}] ${chunk.heading}`);
    lines.push(chunk.text.slice(0, 1500));
    lines.push(`Source: ${chunk.source_url}`);
  }
  return lines.join('\n');
}

// ── Project context ───────────────────────────────────────────────────────────

async function buildProjectContext(projectId) {
  if (!projectId) return null;

  try {
    // Project name and zoning district — address/zoning_district live in settings JSONB
    const projectRes = await pool.query(
      `SELECT name, settings FROM projects WHERE id = $1`,
      [String(projectId)]
    );
    if (!projectRes.rows.length) return null;
    const project = projectRes.rows[0];

    const settings = typeof project.settings === 'string' ? JSON.parse(project.settings) : (project.settings || {});
    const zoningDistrict = settings.zoning_district || null;

    // Level count
    const levelsRes = await pool.query(
      `SELECT COUNT(*) FROM levels WHERE project_id = $1`,
      [String(projectId)]
    );
    const levelCount = parseInt(levelsRes.rows[0].count, 10);

    // Recent element/level edits (last 24h, last 10)
    const recentEventsRes = await pool.query(
      `WITH eligible AS (
        SELECT id FROM elements WHERE project_id = $1
        UNION ALL SELECT id FROM levels WHERE project_id = $1
      )
      SELECT el.event_type, el.entity_type, el.entity_id, el.created_at,
             COALESCE(u.first_name, 'User') AS user_name
      FROM event_ledger el
      LEFT JOIN app_users u ON el.triggered_by = u.id::text OR el.triggered_by = u.session_uuid
      WHERE (el.entity_type = 'element' AND el.entity_id IN (SELECT id FROM eligible))
         OR (el.entity_type = 'level'   AND el.entity_id IN (SELECT id FROM eligible))
      ORDER BY el.created_at DESC
      LIMIT 10`,
      [String(projectId)]
    );
    const recentEvents = recentEventsRes.rows.map(e => ({
      type: e.event_type,
      entity: e.entity_type,
      id: e.entity_id,
      user: e.user_name || 'unknown',
      time: e.created_at,
    }));

    // Collaborators (project_members)
    const membersRes = await pool.query(
      `SELECT u.first_name, pm.role
       FROM project_members pm
       JOIN app_users u ON pm.user_id = u.id
       WHERE pm.project_id = $1`,
      [String(projectId)]
    );
    const collaborators = membersRes.rows.map(m =>
      `${m.first_name || 'User'} (${m.role})`.trim()
    );

    return {
      name: project.name || 'Unnamed Project',
      address: settings.address || null,
      zoning_district: zoningDistrict,
      level_count: levelCount,
      recent_events: recentEvents,
      collaborators,
    };
  } catch (err) {
    console.warn('[wallt] project context error:', err.message);
    return null;
  }
}

function formatProjectContext(ctx) {
  if (!ctx) return '';
  const lines = [
    `\n## Current Project Context`,
    `Project: ${ctx.name}`,
  ];
  if (ctx.address) lines.push(`Address: ${ctx.address}`);
  if (ctx.zoning_district) lines.push(`Zoning District: ${ctx.zoning_district}`);
  if (ctx.level_count !== null) lines.push(`Levels: ${ctx.level_count}`);
  if (ctx.collaborators.length) {
    lines.push(`Collaborators: ${ctx.collaborators.join(', ')}`);
  }
  if (ctx.recent_events.length) {
    lines.push(`Recent changes (last 24h):`);
    for (const ev of ctx.recent_events.slice(0, 10)) {
      lines.push(`  - ${ev.type} on ${ev.entity} by ${ev.user} at ${new Date(ev.time).toLocaleString()}`);
    }
  }
  return lines.join('\n');
}

// ── callWallt — with RAG + project context + function-calling ────────────────

// Keywords that suggest the user wants an action performed (not just info)
const AUTO_EXEC_PREFIXES = ['do it', 'go ahead', 'yes do it', 'execute', 'confirm'];

function wantsAutoExec(userMessage) {
  const lower = userMessage.toLowerCase().trim();
  return AUTO_EXEC_PREFIXES.some(p => lower.startsWith(p) || lower === p);
}

async function callWallt(ai, contextWindow, userMessage, ctx = {}) {
  const { projectContext, projectZoningDistrict, userId, conversationId, driveContext } = ctx;

  // Abort signal check — abort any pending Wallt operation for this conversation
  if (conversationId) {
    const { aborted, reason } = await checkAbortSignal(String(conversationId));
    if (aborted) {
      console.info(`[wallt] Abort signal for conversation ${conversationId}: ${reason}`);
      return {
        reply: 'Operation cancelled by user.',
        totalTokens: 0,
        styleScore: 1,
        sources: [],
        actions: [],
        aborted: true,
      };
    }
  }

  // Build extra system context — merge project context with live environment data
  // ctx.env carries the scene snapshot sent by the frontend on every message
  const env = ctx.env || {};

  // Neural context: fetch pgvector embeddings summary for project (non-fatal, ≤50ms budget)
  let neuralContext = null;
  const neuralProjectId = projectContext?._projectId || ctx.project_id || null;
  if (neuralProjectId && process.env.OPENAI_API_KEY) {
    try {
      // Lazy-load to avoid crash if pgvector not yet migrated
      const { buildProjectContext: buildNeuralCtx } = require('../lib/neural/embeddings');
      neuralContext = await Promise.race([
        buildNeuralCtx(neuralProjectId),
        new Promise(r => setTimeout(() => r(null), 80)), // 80ms timeout
      ]);
    } catch (_) {} // always non-fatal
  }

  const extraCtx = {
    projectName:   projectContext?.name,
    projectId:     projectContext ? String(projectContext._projectId || '') : undefined,
    neuralContext, // pgvector BIM element index (null if unavailable)
    // ── Environment slots (live scene state from frontend) ──
    activeView:    ctx.active_view   || env.activeView   || undefined,
    activeTool:    ctx.active_tool   || env.activeTool   || undefined,
    selection:     env.selection     || undefined,
    scene:         env.scene         || undefined,
    camera:        env.camera        || undefined,
    modelStats:    env.modelStats    || undefined,
    walkthrough:   env.walkthrough   || undefined,  // reserved: real-time walkthrough feed
    simulation:    env.simulation    || undefined,
    recentActions: env.recentActions || undefined,
    // pass through remaining ctx fields (tight, rectOpinion, etc.)
    ...ctx,
  };
  const systemPrompt = buildSystemPrompt(extraCtx);

  // RAG: check if this is a zoning question
  let zoningChunks = [];
  let zoningCtxBlock = '';
  let citations = [];

  if (isZoningQuestion(userMessage)) {
    try {
      zoningChunks = await retrieveZoningChunks(ai, userMessage, projectZoningDistrict || projectContext?.zoning_district);
    } catch (err) {
      console.warn('[wallt] RAG retrieval failed:', err.message);
    }
    if (zoningChunks.length) {
      zoningCtxBlock = formatZoningContext(zoningChunks) + '\n\nYou MUST cite the relevant ZR section and source URL in your response.';
    }
  }

  // Build project context block
  const projectCtxBlock = formatProjectContext(projectContext);

  // Build Drive context block (EXTERNAL tier — injected when snapshot is fresh)
  let driveCtxBlock = '';
  if (driveContext?.summary) {
    const dc = driveContext;
    const lines = ['\n## BIM Assets (Google Drive)'];
    if (dc.summary.primary_model) {
      const pm = dc.summary.primary_model;
      lines.push(`Primary model: ${pm.name} (${pm.size_mb ?? '?'}MB, modified ${pm.modified?.slice(0,10) ?? 'unknown'})`);
    }
    lines.push(`Files: ${dc.summary.rvt_count} RVT, ${dc.summary.rfa_count} RFA, ${dc.summary.schedule_count} schedules`);
    if (dc.files?.rvt?.length) lines.push('RVT: ' + dc.files.rvt.map(f => f.name).join(', '));
    if (dc.files?.schedules?.length) lines.push('Schedules: ' + dc.files.schedules.map(f => f.name).join(', '));
    driveCtxBlock = lines.join('\n');
  }

  // Combine all context into a system-supplement message
  const additionalCtx = [zoningCtxBlock, projectCtxBlock, driveCtxBlock].filter(Boolean).join('\n');
  const combinedContext = [
    ...(additionalCtx
      ? [{ role: 'developer', content: `Additional context:\n${additionalCtx}` }]
      : []),
    ...contextWindow,
  ];

  // Phase 34D: include action tools so the model can propose actions
  const completion = await ai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...combinedContext,
    ],
    tools: WALLT_TOOLS,
    tool_choice: 'auto',
    max_tokens: 768,
  });

  const choice = completion.choices[0];
  let reply = choice?.message?.content || '';
  let totalTokens = completion.usage?.total_tokens || 0;

  // Parse actions from tool_calls
  const permCtx = { userId };
  let actions = parseToolCalls(choice?.message?.tool_calls || [], permCtx);

  // Mark auto-executable actions when user said "do it" / "go ahead"
  const autoExec = wantsAutoExec(userMessage);
  if (autoExec) {
    actions = actions.map(a => ({ ...a, autoExecute: !a.needsConfirm }));
  }

  // Track tool calls in ephemeral session store (conversationId passed via ctx)
  // Append pending events for each tool call; startToolCall when tool executes
  if (conversationId) {
    for (const toolCall of choice?.message?.tool_calls || []) {
      const toolCallId = await appendToolCall(
        conversationId,
        toolCall.function?.name || 'unknown',
        toolCall.function?.arguments || '{}',
        null
      );
      // Attach toolCallId to the action for downstream execution tracking
      const matchedAction = actions.find(a => a.toolCallId === toolCall.id);
      if (matchedAction) matchedAction.sessionToolCallId = toolCallId;
    }
  }

  // If model only used tool calls and returned no text, synthesize a short bridge sentence
  if (!reply.trim() && actions.length > 0) {
    reply = `Done — here${actions.length === 1 ? "'s what I" : "'s what I"} can do:`;
  }

  // Extract citations
  citations = extractCitations(reply, zoningChunks);

  // Style validator
  let validation = validate(reply);

  // Retry once with tightened prompt on style fail (text only, no tools on retry to save tokens)
  if (!validation.pass && reply.trim()) {
    const tightCompletion = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt({ ...extraCtx, tight: true }) },
        ...combinedContext,
      ],
      max_tokens: 512,
    });
    const retryReply = tightCompletion.choices[0]?.message?.content || '';
    const retryValidation = validate(retryReply);
    totalTokens += tightCompletion.usage?.total_tokens || 0;
    if (retryValidation.score >= validation.score) {
      reply = retryReply;
      validation = retryValidation;
    }
  }

  return { reply, totalTokens, styleScore: validation.score, sources: citations, actions };
}

// ── POST /api/wallt/chat ────────────────────────────────────────────────────
router.post('/chat', optionalAuth, async (req, res) => {
  try {
    const { messages, session_id, project_id, active_view, active_tool, env } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userId = resolveUserId(req);
    const ai = getAI();

    const contextWindow = messages.slice(-20).map(m => ({
      role: m.role === 'wallt' ? 'assistant' : m.role,
      content: String(m.content || ''),
    }));

    // Build project context + Drive context in parallel (both non-fatal)
    let projectContext = null;
    let driveContext = null;
    await Promise.allSettled([
      (async () => {
        projectContext = project_id ? await buildProjectContext(project_id) : null;
        if (projectContext) projectContext._projectId = project_id;
      })(),
      (async () => {
        if (userId) {
          const snapshot = await getLatestContextSnapshot(userId).catch(() => null);
          if (snapshot?.snapshot_data) {
            const ageMs = Date.now() - new Date(snapshot.created_at).getTime();
            if (ageMs < 24 * 60 * 60 * 1000) driveContext = snapshot.snapshot_data;
          }
        }
      })(),
    ]);

    // Last user message for RAG classification
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    // Phase 35F: Session memory — init if needed, append user read event, extend TTL
    const convId = session_id || 'anon-' + (req.user?.id || 'guest');
    if (session_id) {
      const exists = await storeExists(SESSION_KEY_PREFIX + session_id);
      if (!exists) await initSession(session_id);
      await appendEvent(session_id, 'read', {
        project_id: project_id || null,
        active_view,
        active_tool,
        message_preview: lastUserMsg.slice(0, 120),
      });
      await extendTTL(session_id);
    }

    // Phase 35F: Pre-detect pricing intent and run RECT check BEFORE callWallt
    // so Wallt's system prompt includes RECT context and can explain the verdict.
    // Keywords that suggest the user is discussing a pricing action.
    const pricingKeywords = ['discount', 'enterprise price', 'free tier', 'pay to win', 'cross-subsidy', 'billing tier', 'feature gate', 'price change', 'cooperative model'];
    const hasPricingIntent = pricingKeywords.some(k => lastUserMsg.toLowerCase().includes(k));
    let rectOpinion = null;
    let rectPreChecked = null; // pre-computed opinion for apply_rect_check actions
    if (hasPricingIntent) {
      try {
        // Try to detect if this looks like an apply_rect_check action proposal
        // Run the RECT check preemptively — if Wallt also proposes it, we already have the result
        rectPreChecked = await runLegalCheck({
          action_type: 'custom_enterprise_price',
          details: { reason: lastUserMsg },
          reason: lastUserMsg,
          userId,
        });
        rectOpinion = rectPreChecked.opinions?.rect || null;
      } catch (_) {}
    }

    const { reply, totalTokens, styleScore, sources, actions } = await callWallt(
      ai, contextWindow, lastUserMsg,
      { projectContext, projectZoningDistrict: projectContext?.zoning_district, userId, rectOpinion, conversationId: session_id, driveContext,
        active_view, active_tool, env: env || {} }
    );

    // Abort signal was triggered — return cancelled response early
    if (reply === 'Operation cancelled by user.') {
      return res.json({
        message: {
          role: 'wallt',
          content: reply,
          sources: [],
          actions: [],
          metadata: { tokens: 0, aborted: true },
        },
      });
    }

    // Session: append AI decision and any proposed actions
    if (session_id) {
      await appendEvent(session_id, 'decision', {
        reply_preview: reply.slice(0, 120),
        style_score: styleScore,
        actions: actions.map(a => a.type),
      });
      await extendTTL(session_id);
    }

    if (userId) {
      const cost = (totalTokens / 1000) * COST_PER_1K_TOKENS_USD;
      const today = new Date().toISOString().slice(0, 10);
      upsertDailyCost({ userId, date: today, apiCost: cost }).catch(() => {});
    }

    // Telemetry — fire-and-forget
    if (actions.length > 0) {
      insertAppEvent({
        event_name: 'action_proposed',
        session_uuid: req.body.session_id || null,
        user_id: userId,
        properties: JSON.stringify({ actions: actions.map(a => a.type), project_id: project_id || null }),
        url: '/api/wallt/chat',
        ip: req.headers['x-forwarded-for'] || req.ip,
      }).catch(() => {});
    }

    // Phase 35F: Run proactive RECT legal check on any apply_rect_check action
    // so Wallt can explain the opinion in its reply before the user clicks the chip.
    const rectActionIdx = actions.findIndex(a => a.type === 'apply_rect_check');
    if (rectActionIdx !== -1) {
      const rectAction = actions[rectActionIdx];
      try {
        const legalResult = await runLegalCheck({
          action_type: rectAction.params?.action_type,
          details: rectAction.params?.details,
          reason: rectAction.params?.reason,
          userId,
        });
        rectOpinion = legalResult.opinions?.rect;
        // Attach opinion to the action so Wallt can reference it in reply text
        actions[rectActionIdx] = {
          ...rectAction,
          legalOpinion: rectOpinion,
          blocked: legalResult.blocked,
          escalation_id: legalResult.escalation_id,
        };
        // If blocked, strip needsConfirm so the block is explained via reply text
        if (legalResult.blocked) {
          actions[rectActionIdx].needsConfirm = false;
          actions[rectActionIdx].autoExecute = false;
        }
      } catch (err) {
        console.warn('[wallt] proactive rect check failed:', err.message);
      }
    }

    // Layer 1: Output coherence check — detect null/empty responses
    const { checkOutputCoherence } = require('../services/wallt-auto-recovery');
    const { coherent, reason: incoherenceReason } = checkOutputCoherence(reply);
    if (!coherent) {
      console.warn('[wallt] incoherent output detected:', incoherenceReason, '— triggering recovery');
      const { runHealthCheck } = require('../services/wallt-auto-recovery');
      runHealthCheck({
        userId,
        sessionUuid: session_id || null,
        conversationId: session_id ? parseInt(session_id) : null,
      }).catch(e => console.error('[wallt] coherence-triggered recovery failed:', e.message));
    }

    // Phase 36O: Pre-output moral drift check (Layer 2 — value alignment with Nikita's actual values).
    // Run AFTER callWallt() but BEFORE returning reply to client.
    // Triggers auto-rollback if 3 consecutive outputs contradict documented Nikita values.
    let driftResult = null;
    if (reply && session_id) {
      const { checkPreOutputDrift } = require('../services/wallt-moral-drift');
      driftResult = await checkPreOutputDrift({
        output: reply,
        sessionUuid: session_id,
        userId,
        projectId: project_id || null,
      }).catch(e => {
        console.warn('[wallt] pre-output drift check failed:', e.message);
        return null;
      });

      // Auto-rollback: replace reply with last aligned response if drift was confirmed
      if (driftResult && !driftResult.aligned && driftResult.rolledBack && driftResult.rollbackContent) {
        console.info(`[wallt] Auto-rollback applied for session ${session_id} — drift detected`);
        reply = driftResult.rollbackContent;
      }
    }

    // Phase 36P: Layer 3 Legal Compliance — check any actions for legal implications.
    // Triggered for proposed actions and on moral drift to catch legal violations.
    let legalResult = null;
    if (actions && actions.length > 0) {
      const actionTypes = actions.map(a => a.type).join(',');
      try {
        legalResult = await checkLegalCompliance({
          action_type: 'action_evaluation',
          details: { proposed_actions: actionTypes, actions },
          reason: `Proposed Wallt actions: ${actionTypes}`,
          request_text: lastUserMsg,
        }, { userId, projectId: project_id || null });
      } catch (err) {
        console.warn('[wallt] legal compliance check failed:', err.message);
      }
    }

    // Legal check on drift output (Phase 36P: Layer 2 → Layer 3 trigger)
    if (driftResult && !driftResult.aligned && reply) {
      try {
        const driftLegalResult = await checkLegalCompliance({
          action_type: 'output_evaluation',
          details: { drift_output: reply.slice(0, 500) },
          reason: 'Drifted output — legal compliance check triggered',
          request_text: reply,
        }, { userId });
        if (driftLegalResult.blocked) {
          // Critical: drift + legal violation = escalate with legal context
          console.warn(`[wallt] DRIFT + LEGAL VIOLATION for session ${session_id}`);
          legalResult = driftLegalResult;
        }
      } catch (err) {
        console.warn('[wallt] legal drift check failed:', err.message);
      }
    }

    res.json({
      message: {
        role: 'wallt',
        content: reply,
        sources,
        actions: actions || [],
        metadata: {
          tokens: totalTokens,
          style_score: styleScore,
          persona_version: PERSONA_VERSION,
          project_id: project_id || null,
          active_view: active_view || null,
          active_tool: active_tool || null,
          rect_opinion: rectOpinion, // Phase 35F: RECT opinion on apply_rect_check action
          rect_compliance: rectOpinion ? (rectOpinion.verdict === 'COMPLIANT' ? 'RECT_COMPLIANT' : 'RECT_NON_COMPLIANT') : null, // explicit label per task #1999141
          coherence_check: coherent ? 'PASS' : 'FAIL',
          drift_check: driftResult ? {
            verdict: driftResult.verdict,
            aligned: driftResult.aligned,
            rolled_back: driftResult.rolledBack || false,
            event_id: driftResult.eventId || null,
            drifted_from: driftResult.driftDetails
              ? driftResult.driftDetails.filter(d => d.matchType === 'anti').map(d => d.principle)
              : null,
            escalated: driftResult.escalated || false,
          } : null,
          legal_check: legalResult ? {
            verdict: legalResult.verdict,
            blocked: legalResult.blocked,
            reason: legalResult.reason,
            escalation_id: legalResult.escalation_id,
            categories_checked: legalResult.opinions ? Object.keys(legalResult.opinions) : null,
            gaps: legalResult.gaps?.length ? legalResult.gaps : null,
          } : null, // Phase 36P: Layer 3 legal compliance check result
        },
      },
    });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') {
      console.warn('[wallt] /chat: OPENAI_API_KEY not set — returning 503');
      return res.status(503).json({ error: 'AI not configured', detail: 'Set OPENAI_API_KEY on the server.' });
    }
    console.error('[wallt] /chat error:', err.message);
    res.status(500).json({ error: 'AI call failed' });
  }
});

// ── GET /api/wallt/conversations ───────────────────────────────────────────
router.get('/conversations', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ conversations: [] });
    const convs = await listConversations(userId, 20);
    res.json({ conversations: convs });
  } catch (err) {
    console.error('[wallt] list error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// ── POST /api/wallt/conversations ─────────────────────────────────────────────
router.post('/conversations', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Login required to save conversations' });
    const { context_project_id, context_metadata, title } = req.body;
    const conv = await createConversation(userId, context_project_id || null, context_metadata || {}, PERSONA_VERSION);
    res.status(201).json({ conversation: conv });
  } catch (err) {
    console.error('[wallt] create error:', err.message);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ── GET /api/wallt/conversations/:id ─────────────────────────────────────────
router.get('/conversations/:id', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const conv = await getConversationById(parseInt(req.params.id));
    if (!conv || conv.user_id !== userId) return res.status(404).json({ error: 'Not found' });
    const messages = await getMessagesByConversation(conv.id, 200);
    res.json({ conversation: conv, messages });
  } catch (err) {
    console.error('[wallt] get error:', err.message);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// ── DELETE /api/wallt/conversations/:id ────────────────────────────────────
router.delete('/conversations/:id', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const result = await archiveConversation(parseInt(req.params.id), userId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    // Phase 35F: Wipe ephemeral session on conversation close
    await wipeSession(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[wallt] archive error:', err.message);
    res.status(500).json({ error: 'Failed to archive conversation' });
  }
});

// ── POST /api/wallt/conversations/:id/messages ─────────────────────────────
router.post('/conversations/:id/messages', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const convId = parseInt(req.params.id);
    const conv = await getConversationById(convId);
    if (!conv || conv.user_id !== userId) return res.status(404).json({ error: 'Not found' });

    const { content, project_id, active_view, active_tool, env } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message content is required' });

    // Phase 35F: Session memory — init, append user read, extend TTL
    await initSession(String(convId));
    await appendEvent(String(convId), 'read', {
      project_id: project_id || null,
      active_view,
      active_tool,
      message_preview: content.trim().slice(0, 120),
    });
    await extendTTL(String(convId));

    await createMessage(convId, 'user', content.trim(), [], {});

    const history = await getMessagesByConversation(convId, 40);
    const window = history.slice(-20).map(m => ({
      role: m.role === 'wallt' ? 'assistant' : m.role,
      content: m.content,
    }));

    const ai = getAI();

    // Project context from conv or request
    const effectiveProjectId = project_id || conv.context_project_id;
    const projectContext = effectiveProjectId ? await buildProjectContext(effectiveProjectId) : null;
    if (projectContext) projectContext._projectId = effectiveProjectId;

    const { reply, totalTokens, styleScore, sources, actions } = await callWallt(
      ai, window, content.trim(),
      { projectContext, projectZoningDistrict: projectContext?.zoning_district, userId, conversationId: String(convId),
        active_view, active_tool, env: env || {} }
    );

    // Abort signal was triggered — return cancelled response without persisting message
    if (reply === 'Operation cancelled by user.') {
      return res.status(202).json({
        message: {
          role: 'wallt',
          content: reply,
          sources: [],
          actions: [],
          metadata: { tokens: 0, aborted: true },
        },
      });
    }

    const msg = await createMessage(convId, 'wallt', reply, sources,
      { tokens: totalTokens, persona_version: PERSONA_VERSION, project_id: effectiveProjectId }, styleScore, actions);
    await touchConversation(convId);

    // Phase 35F: Session memory — append AI decision
    await appendEvent(String(convId), 'decision', {
      reply_preview: reply.slice(0, 120),
      style_score: styleScore,
      actions: (actions || []).map(a => a.type),
    });
    await extendTTL(String(convId));

    if (userId) {
      const cost = (totalTokens / 1000) * COST_PER_1K_TOKENS_USD;
      const today = new Date().toISOString().slice(0, 10);
      upsertDailyCost({ userId, date: today, apiCost: cost }).catch(() => {});
    }

    // Phase 36P: Layer 3 legal compliance check on proposed actions
    let legalResultConv = null;
    if (actions && actions.length > 0) {
      try {
        const actionTypes = actions.map(a => a.type).join(',');
        legalResultConv = await checkLegalCompliance({
          action_type: 'action_evaluation',
          details: { proposed_actions: actionTypes, actions },
          reason: `Proposed Wallt actions: ${actionTypes}`,
          request_text: content.trim(),
        }, { userId, projectId: effectiveProjectId ? String(effectiveProjectId) : null });
      } catch (err) {
        console.warn('[wallt] legal compliance check failed (conversations):', err.message);
      }
    }

    // Telemetry — fire-and-forget
    if (actions && actions.length > 0) {
      insertAppEvent({
        event_name: 'action_proposed',
        session_uuid: null,
        user_id: userId,
        properties: JSON.stringify({ actions: actions.map(a => a.type), project_id: effectiveProjectId }),
        url: `/api/wallt/conversations/${convId}/messages`,
        ip: req.headers['x-forwarded-for'] || req.ip,
      }).catch(() => {});
    }

    res.status(201).json({
      message: {
        ...msg, sources, actions: actions || [],
        metadata: {
          project_id: effectiveProjectId, active_view, active_tool,
          legal_check: legalResultConv ? {
            verdict: legalResultConv.verdict,
            blocked: legalResultConv.blocked,
            reason: legalResultConv.reason,
            escalation_id: legalResultConv.escalation_id,
            categories_checked: legalResultConv.opinions ? Object.keys(legalResultConv.opinions) : null,
            gaps: legalResultConv.gaps?.length ? legalResultConv.gaps : null,
          } : null,
        },
      },
    });
  } catch (err) {
    console.error('[wallt] send error:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/wallt/context ──────────────────────────────────────────────────
router.get('/context', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ context: null });
    const snapshot = await getLatestContextSnapshot(userId);
    res.json({ context: snapshot ? snapshot.snapshot_data : null });
  } catch (err) {
    console.error('[wallt] context error:', err.message);
    res.status(500).json({ error: 'Failed to load context' });
  }
});

// ── POST /api/wallt/context ─────────────────────────────────────────────────
router.post('/context', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { project_id, snapshot_data } = req.body;
    if (!snapshot_data) return res.status(400).json({ error: 'snapshot_data is required' });
    const result = await saveContextSnapshot(userId, project_id || null, snapshot_data);
    res.status(201).json({ ok: true, snapshot_id: result.id });
  } catch (err) {
    console.error('[wallt] save context error:', err.message);
    res.status(500).json({ error: 'Failed to save context' });
  }
});

// ── GET /api/wallt/project-context/:id ────────────────────────────────────
// Utility endpoint: returns project context for a given project ID (for debugging/UI)
router.get('/project-context/:id', optionalAuth, async (req, res) => {
  try {
    const ctx = await buildProjectContext(parseInt(req.params.id));
    res.json({ context: ctx });
  } catch (err) {
    console.error('[wallt] project-context error:', err.message);
    res.status(500).json({ error: 'Failed to load project context' });
  }
});

// ── POST /api/wallt/legal-engine ──────────────────────────────────────────
// Phase 35F: Layer 3 Legal Engine — RECT + full law category opinions
// Runs all category checks (criminal/civil/IP/privacy/sanctions/tax/contract/rect)
// on a pricing action before execution.
// On NON_COMPLIANT or AMBIGUOUS in any category: blocks action, escalates to Polsia.
router.post('/legal-engine', optionalAuth, async (req, res) => {
  try {
    const { action_type, details, reason } = req.body;
    if (!action_type || !details || !reason) {
      return res.status(400).json({
        error: 'action_type, details, and reason are required',
        overall_verdict: 'NON_COMPLIANT',
        blocked: true,
        opinions: {
          rect: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          criminal: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          civil: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          ip: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          privacy: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          sanctions: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          tax: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          contract: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
        },
      });
    }

    const userId = resolveUserId(req);
    const result = await runLegalCheck({ action_type, details, reason, userId });

    if (result.blocked) {
      sendLegalEscalation({ ...result, action_type, details, reason, userId }).catch(err => {
        console.error('[wallt] legal escalation failed:', err.message);
      });
    }

    res.json({
      overall_verdict: result.overall_verdict,
      blocked: result.blocked,
      escalation_id: result.escalation_id,
      rect_compliance: result.opinions.rect.verdict === 'COMPLIANT' ? 'RECT_COMPLIANT' : 'RECT_NON_COMPLIANT',
      opinions: result.opinions,
    });
  } catch (err) {
    console.error('[wallt] /legal-engine error:', err.message);
    res.status(500).json({
      error: 'Legal engine check failed',
      overall_verdict: 'NON_COMPLIANT',
      blocked: true,
      rect_compliance: 'RECT_NON_COMPLIANT',
      opinions: {
        rect: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        criminal: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        civil: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        ip: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        privacy: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        sanctions: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        tax: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        contract: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
      },
    });
  }
});

// ── POST /api/wallt/legal-engine/rect ─────────────────────────────────────
// Phase 35F: Proactive RECT compliance check — full legal opinion set.
// Used by WalltBridge (apply_rect_check action) and by billing/admin flows
// before committing pricing changes. Blocked=true means action is halted
// pending Polsia approval.
router.post('/legal-engine/rect', optionalAuth, async (req, res) => {
  try {
    const { action_type, details, reason } = req.body;
    const userId = resolveUserId(req);

    if (!action_type || !details || !reason) {
      return res.status(400).json({
        error: 'Missing required fields: action_type, details, reason',
        blocked: true,
        opinions: {
          rect: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          criminal: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          civil: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          ip: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          privacy: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          sanctions: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          tax: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
          contract: { verdict: 'NON_COMPLIANT', reason: 'Missing required fields', rule: 'missing_fields', blocked: true },
        },
      });
    }

    const result = await runLegalCheck({ action_type, details, reason, userId });

    if (result.blocked) {
      sendLegalEscalation({ ...result, action_type, details, reason, userId }).catch(err => {
        console.error('[wallt] rect escalation failed:', err.message);
      });
    }

    res.json({
      overall_verdict: result.overall_verdict,
      blocked: result.blocked,
      escalation_id: result.escalation_id,
      rect_compliance: result.opinions.rect.verdict === 'COMPLIANT' ? 'RECT_COMPLIANT' : 'RECT_NON_COMPLIANT',
      opinions: result.opinions,
    });
  } catch (err) {
    console.error('[wallt] /legal-engine/rect error:', err.message);
    res.status(500).json({
      error: 'RECT legal check failed',
      blocked: true,
      rect_compliance: 'RECT_NON_COMPLIANT',
      opinions: {
        rect: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        criminal: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        civil: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        ip: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        privacy: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        sanctions: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        tax: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
        contract: { verdict: 'NON_COMPLIANT', reason: err.message, rule: 'engine_error', blocked: true },
      },
    });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function sendLegalEscalation({ opinions, overall_verdict, escalation_id, action_type, details, reason, userId }) {
  const badCategories = Object.entries(opinions)
    .filter(([, o]) => o.verdict === 'NON_COMPLIANT' || o.verdict === 'AMBIGUOUS')
    .map(([cat, o]) => ({ category: cat, reason: o.reason, rule: o.rule }));

  await pool.query(
    `INSERT INTO app_events (event_name, user_id, properties, url, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      'legal_escalation',
      userId,
      JSON.stringify({
        escalation_id,
        overall_verdict,
        action_type,
        details,
        reason,
        bad_categories: badCategories,
        escalated_at: new Date().toISOString(),
        requires_polsia_approval: true,
      }),
      '/api/wallt/legal-engine',
      '0.0.0.0',
    ]
  ).catch(() => {});
}

// ── POST /api/wallt/escalate — create escalation (human-in-loop trigger) ─────
router.post('/escalate', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { escalation_type, trigger_source, reason, context, wallt_recommendation, priority } = req.body;
    if (!escalation_type || !reason) {
      return res.status(400).json({
        error: 'escalation_type and reason are required',
        hint: 'escalation_type must be one of: moral_drift, legal_uncertainty, autonomous_action, user_request, auto_recovery',
      });
    }
    const validTypes = ['moral_drift', 'legal_uncertainty', 'autonomous_action', 'user_request', 'auto_recovery'];
    if (!validTypes.includes(escalation_type)) {
      return res.status(400).json({ error: `invalid escalation_type "${escalation_type}"` });
    }
    const escalation = await escalationService.createEscalation({
      escalation_type,
      trigger_source: trigger_source || 'wallt:user',
      reason,
      context: context || {},
      wallt_recommendation: wallt_recommendation || null,
      userId,
      sessionUuid: req.session?.uuid || null,
      priority: priority || 'normal',
    });
    res.status(201).json({ escalation, message: 'Escalation created. Human review pending.' });
  } catch (err) {
    console.error('[wallt] escalate error:', err.message);
    res.status(500).json({ error: 'Failed to create escalation' });
  }
});

// ── GET /api/wallt/escalate — list escalations (admin sees all; users see own) ─
router.get('/escalate', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { status, escalation_type, trigger_source, limit } = req.query;
    const escalations = await escalationService.getPendingEscalations({
      escalation_type: escalation_type || null,
      trigger_source: trigger_source || null,
      limit: Math.min(parseInt(limit, 10) || 20, 100),
    });
    const visible = escalations.filter(e => e.user_id === userId || e.user_id === null);
    res.json({ escalations: visible, count: visible.length });
  } catch (err) {
    console.error('[wallt] list escalations error:', err.message);
    res.status(500).json({ error: 'Failed to load escalations' });
  }
});

// ── PATCH /api/wallt/escalate/:id — resolve escalation (admin only) ─────────
router.patch('/escalate/:id', optionalAuth, async (req, res) => {
  try {
    const token = req.cookies?.session_token;
    if (!token) return res.status(401).json({ error: 'Login required' });
    const session = await getSessionByToken(token);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { response, resolution_action } = req.body;
    if (!response) return res.status(400).json({ error: 'response is required' });
    const validActions = ['approved', 'denied', 'modified', 'pending'];
    if (resolution_action && !validActions.includes(resolution_action)) {
      return res.status(400).json({ error: `resolution_action must be one of: ${validActions.join(', ')}` });
    }
    const escalation = await escalationService.resolveEscalation(
      parseInt(req.params.id), response, session.user_id, resolution_action || 'approved'
    );
    if (!escalation) return res.status(404).json({ error: 'Escalation not found' });
    res.json({ escalation });
  } catch (err) {
    console.error('[wallt] resolve escalation error:', err.message);
    res.status(500).json({ error: 'Failed to resolve escalation' });
  }
});

// ── Health check loop (Layer 1 Auto-Recovery) ─────────────────────────────
// Runs every 30 seconds during active Wallt sessions.
// Checks: response latency (5s threshold), execution timeout (30s),
// memory pressure, output coherence. Max 3 recoveries per session.
// Only starts the loop if HEALTH_CHECK_INTERVAL_MS > 0 (disabled if 0 or negative).

const { runHealthCheck, HEALTH_CHECK_INTERVAL_MS } = (() => {
  try { return require('../services/wallt-auto-recovery'); } catch (_) { return {}; }
})();

let _healthLoopTimer = null;

function startHealthCheckLoop() {
  if (_healthLoopTimer) return; // already running
  const interval = HEALTH_CHECK_INTERVAL_MS || 30000;
  _healthLoopTimer = setInterval(async () => {
    try {
      const { getWalltState } = require('../services/wallt-auto-recovery');
      const state = getWalltState();
      // Skip check if Wallt is OFFLINE (requires admin manual override)
      if (state.status === 'OFFLINE') return;
      await runHealthCheck({}).catch(e => {
        console.error('[wallt] health-check-loop error:', e.message);
      });
    } catch (_) {}
  }, interval);
  console.log(`[wallt] Health check loop started — every ${interval}ms`);
}

function stopHealthCheckLoop() {
  if (_healthLoopTimer) {
    clearInterval(_healthLoopTimer);
    _healthLoopTimer = null;
    console.log('[wallt] Health check loop stopped');
  }
}

// Start the loop when this module is loaded
startHealthCheckLoop();

module.exports = router;