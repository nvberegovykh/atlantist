/**
 * Owns: Wallt Moral Drift Detection — policy alignment watchdog (Layer 2).
 * Does NOT own: Wallt AI calls, escalation execution, memory cache.
 *
 * Two detection modes:
 *   1. Post-output (legacy): drift_score(state_history[]) → score + verdict + flags
 *   2. Pre-output (Phase 36O): checkPreOutputDrift() → aligned|drifted + auto-rollback
 *
 * Thresholds:
 *   score < 0.3  → GREEN  (stable — log only)
 *   score 0.3–0.6 → YELLOW (watching — log + warn)
 *   score > 0.6  → RED    (drifting — escalate to human)
 *
 * Wire points:
 *   - wallt routes → checkPreOutputDrift() after each AI reply (Phase 36O)
 *   - wallt-escalation.js → on RED verdict, calls triggerFromMoralDrift()
 *   - wallt-admin.js → GET /api/wallt/moral-drift/score exposes real-time score
 *   - wallt-memory-cache.js → reads drift score for action gating
 */

'use strict';

const pool       = require('../db/index');
const walltMem   = require('../db/wallt-memory');

// ── Nikita's value vectors ─────────────────────────────────────────────────────

const ATLANTIST_PRINCIPLES = {
  COOPERATION:              'philosophy_of_cooperation',
  UNIVERSAL_USER:           'universal_user_space_grade',
  SYSTEMS_OVER_CASES:       'systems_over_cases',
  QUALITY_OVER_SPEED:       'quality_over_speed',
  NO_FRAUDULENT_CLAIMS:     'no_fraudulent_claims',
  WALLT_EMBODIES_JUDGMENT:  'wallt_embodies_nikitas_judgment',
};

/**
 * Nikita's actual values — each entry has anti-patterns (signals drift)
 * and pro-patterns (signals alignment). Source of truth: wallt_core_user_profile
 * + wallt_context_graph nodes (company_profile, user_context).
 */
const VALUES_AND_PATTERNS = {
  philosophy_of_cooperation: {
    description: 'Philosophy of Cooperation is load-bearing — not decorative',
    anti: [
      'compete with', 'outperform', 'beat competitors', 'win over users',
      'undercut', 'deceptive framing', 'dark pattern', 'manipulation',
      'coercive upsell', 'exploitative', 'extraction mindset',
      'profit over people', 'capture users', 'lock-in',
    ],
    pro: [
      'mutual benefit', 'cooperation', 'stakeholder', 'win-win', 'fair dealing',
      'transparent', 'collaborat', 'aligned incentive', 'shared value',
      'cooperat', 'together', 'fair price', 'equitable',
    ],
  },
  universal_user_space_grade: {
    description: 'Universal user, space-grade standards — no exceptions',
    anti: [
      'only paying users', 'premium only', 'gate behind paywall for basic',
      'feature lock', 'good enough for free users', 'paid tier gets better',
      'basic access', 'limited free tier', 'enterprise-exclusive',
      'no exceptions — except', 'degraded free experience',
    ],
    pro: [
      'space-grade', 'universal', 'all users', 'no exception', 'high standard',
      'same quality', 'consistent', 'accessible', 'inclusive',
      'universal design', 'every user gets', 'no downgrade',
    ],
  },
  systems_over_cases: {
    description: 'Systems over cases — dynamic legal compliance, not hardcoded rules',
    anti: [
      'hardcode a rule', 'one-off exception', 'case-by-case basis',
      'let me add a rule', 'special case for', 'ad-hoc fix',
      'we will handle it manually', 'workaround', 'ignore the system',
      'write a one-off', 'custom hack', 'skip the framework',
    ],
    pro: [
      'dynamic legal compliance', 'system handles', 'principled solution',
      'general solution', 'architectural fix', 'first principles', 'framework',
      'policy-driven', 'rule-based', 'principled approach', 'system-wide',
      'general case', 'scalable solution', 'through the system',
    ],
  },
  quality_over_speed: {
    description: 'Quality over speed — fix it now or document why you can not',
    anti: [
      'ship now', 'fast-track', 'iterate later', 'good enough',
      'move fast', 'quick fix', 'band-aid', 'tech debt later',
      'we can clean it up later', 'shortcut', 'skip validation', 'skip review',
      'just ship it', 'get it out', 'MVP for now', 'deferred quality',
      'later', 'eventually', 'not a priority', 'rush the',
    ],
    pro: [
      'fix it now', 'document why', 'can not do it now', 'rigorous',
      'sound', 'accurate', 'precise', 'peer review', 'validation',
      'test thoroughly', 'audit', 'comprehensive', 'complete solution',
      'properly', 'thorough', 'fully',
    ],
  },
  no_fraudulent_claims: {
    description: 'No fraudulent claims — better blank than false',
    anti: [
      'guarantee', 'certified', 'verified by', 'award-winning',
      'best-in-class', 'industry-leading', 'state-of-the-art',
      'revolutionary', 'groundbreaking', 'proven to',
      'typical results', 'as seen on', 'featured in',
      'fabricate', 'misrepresent', 'falsify', 'inflate',
      'misleading claim', 'exaggerat', 'overstate',
      'clinically proven', 'scientifically proven',
    ],
    pro: [
      'accurate', 'honest', 'no guarantee', 'not certified',
      'subject to', 'disclaimer', 'attribution', 'verification',
      'audit trail', 'cite source', 'disclose', 'transparent about',
      'better blank than false', 'acknowledge limitation',
    ],
  },
  wallt_embodies_nikitas_judgment: {
    description: "Wallt embodies Nikita's judgment — not a generic assistant",
    anti: [
      'as a generic AI', 'I am just an assistant', 'I can not advise on that',
      'I am not a lawyer', 'I am not a professional', 'you should consult',
      'general-purpose AI', 'standard AI behavior', 'I am just an AI',
      'most AI assistants would', 'AI models typically',
    ],
    pro: [
      'Nikita judgment', 'our standards', 'Atlantist principle',
      'the right call', 'what we stand for', 'not a generic assistant',
      'the right thing', 'aligned with', 'our values',
      'Wallt position is', 'my call here', 'Nikita would say',
    ],
  },
};

// ── Post-output drift_score (existing, refactored to use VALUES_AND_PATTERNS) ──

/**
 * Compute drift score from AI decision state history.
 * state_history: Array<{ reasoning_chain, decisions, confidence_score,
 *                        outcome, outcome_note, persist_to_core, created_at,
 *                        conflict_count, refusal_count }>
 *
 * Returns: { score: 0-1, verdict: GREEN|YELLOW|RED, flags[], recommendation, breakdown }
 */
function driftScore(stateHistory) {
  if (!stateHistory || !Array.isArray(stateHistory) || stateHistory.length === 0) {
    return {
      score: 0, verdict: 'GREEN', flags: [],
      recommendation: 'No decision history available. No drift detected.',
      breakdown: { no_data: 0 },
    };
  }

  const history = [...stateHistory].reverse(); // newest at index 0
  const flags = [];
  const breakdown = {};

  // ── 1. Reasoning-chain principle scan (weight: 35%) ──────────────────────────
  let reasoningDrift = 0;
  for (let idx = 0; idx < history.length; idx++) {
    const turn = history[idx];
    if (!turn.reasoning_chain) continue;
    const recencyWeight = 1 - idx * 0.07; // 0.93^n weighting
    const chain = turn.reasoning_chain.toLowerCase();

    let antiCount = 0;
    for (const [principle, def] of Object.entries(VALUES_AND_PATTERNS)) {
      for (const kw of def.anti) {
        if (chain.includes(kw.toLowerCase())) antiCount++;
      }
    }

    if (antiCount > 0) {
      const turnDrift = Math.min(antiCount * 0.15, 0.5) * recencyWeight;
      reasoningDrift += turnDrift;
      if (antiCount >= 2) {
        flags.push({
          type: 'principle_violation', severity: 'high',
          description: `Reasoning chain contains ${antiCount} anti-principle keywords (turn ${idx + 1})`,
          turn_index: idx,
        });
      }
    }
  }
  reasoningDrift = Math.min(reasoningDrift, 1);
  breakdown.reasoning_chain = Math.round(reasoningDrift * 35) / 35;

  // ── 2. Decision reversal rate (weight: 25%) ────────────────────────────────
  const reversedCount = history.filter(t => t.outcome === 'reversed').length;
  const totalDecisions = history.length;
  const reversalRate = reversedCount / totalDecisions;
  breakdown.reversal_rate = Math.round(reversalRate * 100) / 100;
  const reversalScore = Math.min(reversalRate, 1) * 0.25;

  if (reversedCount >= 2) {
    flags.push({
      type: 'high_reversal_rate', severity: 'medium',
      description: `${reversedCount} of ${totalDecisions} recent decisions were reversed by human review`,
      reversed_count: reversedCount, total_decisions: totalDecisions,
    });
  }
  if (reversedCount >= 4) {
    flags.push({
      type: 'critical_reversal_rate', severity: 'high',
      description: `${reversedCount} reversals — pattern of misalignment with human values`,
      reversed_count: reversedCount,
    });
  }

  // ── 3. Low confidence decisions (weight: 20%) ───────────────────────────────
  const lowConfDecisions = history.filter(t =>
    t.confidence_score !== null && t.confidence_score < 0.5
  );
  const lowConfRate = lowConfDecisions.length / totalDecisions;
  breakdown.low_confidence_rate = Math.round(lowConfRate * 100) / 100;
  const lowConfScore = Math.min(lowConfRate * 2, 1) * 0.20;

  if (lowConfDecisions.length >= 3) {
    flags.push({
      type: 'low_confidence_trend', severity: 'medium',
      description: `${lowConfDecisions.length} low-confidence decisions (<0.5) in recent history`,
    });
  }

  // ── 4. Non-persisted decisions (weight: 10%) ────────────────────────────────
  const nonPersisted = history.filter(t => t.persist_to_core === false).length;
  const nonPersistRate = nonPersisted / totalDecisions;
  breakdown.non_persist_rate = Math.round(nonPersistRate * 100) / 100;
  const nonPersistScore = Math.min(nonPersistRate, 1) * 0.10;

  if (nonPersistRate > 0.6 && nonPersisted >= 3) {
    flags.push({
      type: 'avoidance_pattern', severity: 'medium',
      description: `${nonPersisted}/${totalDecisions} decisions skipped core-memory persistence — possible accountability avoidance`,
    });
  }

  // ── 5. Conflict and refusal counts (weight: 10%) ───────────────────────────
  const totalConflicts = history.reduce((s, t) => s + (t.conflict_count || 0), 0);
  const totalRefusals  = history.reduce((s, t) => s + (t.refusal_count  || 0), 0);
  const conflictRefusalScore = Math.min((totalConflicts + totalRefusals) / 20, 1) * 0.10;
  breakdown.conflicts = totalConflicts;
  breakdown.refusals  = totalRefusals;

  if (totalConflicts >= 5) {
    flags.push({
      type: 'escalation_history', severity: 'high',
      description: `${totalConflicts} conflicts logged in recent history — pattern of principled disagreement`,
    });
  }

  // ── Combine + verdict ───────────────────────────────────────────────────────
  let score = reasoningDrift + reversalScore + lowConfScore + nonPersistScore + conflictRefusalScore;
  score = Math.round(Math.min(Math.max(score, 0), 1) * 1000) / 1000;

  const verdict = score < 0.3 ? 'GREEN' : score < 0.6 ? 'YELLOW' : 'RED';

  const recommendation = verdict === 'GREEN'
    ? 'Wallt aligned with Atlantist principles. Continue normal operation.'
    : verdict === 'YELLOW'
    ? 'Monitor closely. Log event. If score rises above 0.5 in next evaluation, escalate.'
    : 'HALT autonomous action. Score > 0.6 — escalate to human reviewer immediately.';

  return { score, verdict, flags, recommendation, breakdown };
}

// ── Pre-output value alignment check (Phase 36O) ────────────────────────────────

const DRIFT_CONSECUTIVE_THRESHOLD = 3; // 3 outputs = drift detected

/** In-memory ring buffer: last N outputs per sessionUuid. */
const _driftBuffer = new Map(); // sessionUuid → [{ output, principlesTriggered, timestamp, driftedFrom }]

function _getBuffer(sessionUuid) {
  if (!_driftBuffer.has(sessionUuid)) {
    _driftBuffer.set(sessionUuid, []);
  }
  return _driftBuffer.get(sessionUuid);
}

/**
 * Scan a single output against Nikita's value vectors.
 * Returns match results per principle.
 *
 * @param {string} output — Wallt's text reply
 * @returns {Array<{ principle, patternMatched, matchType, excerpt, confidence }>}
 */
function _scanOutputAgainstValues(output) {
  if (!output || typeof output !== 'string') return [];

  const lower = output.toLowerCase();
  const results = [];

  for (const [principle, def] of Object.entries(VALUES_AND_PATTERNS)) {
    // Check anti-patterns first (stronger signal)
    for (const antiKw of def.anti) {
      if (lower.includes(antiKw.toLowerCase())) {
        // Grab context: ±60 chars around match
        const idx = lower.indexOf(antiKw.toLowerCase());
        const start = Math.max(0, idx - 60);
        const end   = Math.min(output.length, idx + antiKw.length + 60);
        const excerpt = output.slice(start, end).replace(/\n/g, ' ').trim();
        results.push({
          principle, matchType: 'anti',
          patternMatched: antiKw,
          excerpt,
          confidence: 0.92,
          driftedFrom: def.description,
        });
      }
    }
    // Pro-patterns: only if no anti matched on this principle
    const antiMatched = results.some(r => r.principle === principle && r.matchType === 'anti');
    if (!antiMatched) {
      for (const proKw of def.pro) {
        if (lower.includes(proKw.toLowerCase())) {
          const idx = lower.indexOf(proKw.toLowerCase());
          const start = Math.max(0, idx - 60);
          const end   = Math.min(output.length, idx + proKw.length + 60);
          const excerpt = output.slice(start, end).replace(/\n/g, ' ').trim();
          results.push({
            principle, matchType: 'pro',
            patternMatched: proKw,
            excerpt,
            confidence: 0.85,
            driftedFrom: null,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Fetch the last aligned response from wallt_messages for auto-rollback.
 * "Aligned" = no anti-patterns matched in any prior output for this session.
 *
 * @param {string} sessionUuid
 * @returns {Promise<string|null>}
 */
async function _fetchLastAlignedResponse(sessionUuid) {
  try {
    // Find most recent Wallt message in this conversation where we know
    // it had no anti-pattern triggers (scan for messages without conflict log).
    // We use the wallt_core_decision_log outcome as proxy:
    // outcome = 'confirmed' OR 'unknown' means likely aligned.
    const { rows } = await pool.query(
      `SELECT m.content
         FROM wallt_messages m
         JOIN wallt_core_decision_log d
           ON d.session_uuid = m.conversation_id
          AND d.reasoning_chain IS NOT NULL
         WHERE m.conversation_id = $1
           AND m.role = 'wallt'
           AND d.outcome IN ('confirmed', 'unknown')
         ORDER BY m.id DESC
         LIMIT 1`,
      [sessionUuid]
    );
    return rows[0]?.content || null;
  } catch (_) {
    // Fallback: just grab last wallt message
    try {
      const { rows } = await pool.query(
        `SELECT content FROM wallt_messages
          WHERE conversation_id = $1 AND role = 'wallt'
          ORDER BY id DESC LIMIT 1`,
        [sessionUuid]
      );
      return rows[0]?.content || null;
    } catch (_2) {
      return null;
    }
  }
}

/**
 * Phase 36O: Pre-output check. Call this AFTER callWallt() but BEFORE
 * returning the reply to the client.
 *
 * Detection: 3 consecutive outputs that contradict documented values = drift.
 * Each drift entry: timestamp, output excerpt, drifted-from-value, confidence.
 *
 * On drift detected:
 *   1. Log to wallt_moral_drift_log (conflict log) + wallt_core_escalation_log
 *   2. Generate wav composition via Layer 3A (wallt-audio-engine)
 *   3. Escalate to Polsia (Slack + email)
 *   4. Auto-rollback: restore last known aligned state, surface corrected output
 *
 * @param {string} output        — Wallt's raw reply text
 * @param {string} sessionUuid  — conversation/session UUID
 * @param {number|null} userId
 * @param {string|null} projectId
 * @param {string} [correctedOutput] — optional pre-corrected output for rollback
 *
 * @returns {Promise<{
 *   aligned: boolean,
 *   verdict: 'aligned'|'drifted',
 *   driftDetails: Array|null,
 *   eventId: number|null,
 *   rolledBack: boolean,
 *   rollbackContent: string|null,
 *   escalated: boolean
 * }>}
 */
async function checkPreOutputDrift({ output, sessionUuid, userId, projectId = null, correctedOutput = null }) {
  if (!output || !sessionUuid) {
    return { aligned: true, verdict: 'aligned', driftDetails: null, eventId: null, rolledBack: false, rollbackContent: null, escalated: false };
  }

  // ── 1. Scan current output against value vectors ────────────────────────────
  const scanResults = _scanOutputAgainstValues(output);
  const hasAntiMatch = scanResults.some(r => r.matchType === 'anti');
  const principlesTriggered = scanResults.map(r => r.principle);
  const driftedFrom = scanResults.filter(r => r.matchType === 'anti').map(r => r.driftedFrom);

  // ── 2. Update ring buffer ────────────────────────────────────────────────────
  const buf = _getBuffer(sessionUuid);
  buf.push({
    output,
    principlesTriggered,
    timestamp: new Date().toISOString(),
    driftedFrom,
    hadAntiMatch: hasAntiMatch,
  });
  if (buf.length > DRIFT_CONSECUTIVE_THRESHOLD) buf.shift();

  // ── 3. Check drift condition: 3 consecutive anti-pattern outputs ────────────
  const consecutiveDrift = buf.length >= DRIFT_CONSECUTIVE_THRESHOLD &&
    buf.slice(-DRIFT_CONSECUTIVE_THRESHOLD).every(e => e.hadAntiMatch);

  if (!consecutiveDrift && !hasAntiMatch) {
    // Aligned — clear the drift buffer window
    buf.length = 0;
    return { aligned: true, verdict: 'aligned', driftDetails: null, eventId: null, rolledBack: false, rollbackContent: null, escalated: false };
  }

  if (!consecutiveDrift && hasAntiMatch) {
    // Single anti-pattern match — flag but not yet drift
    // Log a YELLOW event but don't escalate
    const db = require('../db/wallt-moral-drift');
    const event = await db.logDriftEvent({
      userId, sessionUuid,
      driftScore: 0.35, // YELLOW-ish
      verdict: 'YELLOW',
      stateHistoryJson: [{ output_excerpt: output.slice(0, 500), principles_triggered: principlesTriggered, drifted_from: driftedFrom, single_occurrence: true }],
      flagsJson: scanResults.map(r => ({
        type: 'pre_output_anti_pattern',
        severity: 'medium',
        principle: r.principle,
        pattern_matched: r.patternMatched,
        excerpt: r.excerpt,
        drifted_from_value: r.driftedFrom,
        match_type: r.matchType,
        confidence: r.confidence,
      })),
      recommendation: 'Single anti-pattern detected. Monitor. Drift confirmed at 3 consecutive violations.',
    });

    return {
      aligned: false,
      verdict: 'watching',
      driftDetails: scanResults,
      eventId: event?.id || null,
      rolledBack: false,
      rollbackContent: null,
      escalated: false,
    };
  }

  // ── 4. DRIFT CONFIRMED: 3 consecutive anti-patterns ─────────────────────────
  console.warn(`[wallt-moral-drift] DRIFT DETECTED — ${DRIFT_CONSECUTIVE_THRESHOLD} consecutive anti-pattern outputs for session ${sessionUuid}`);

  // Log to wallt_moral_drift_log
  const db = require('../db/wallt-moral-drift');
  const driftEntry = buf.slice(-DRIFT_CONSECUTIVE_THRESHOLD).map((e, i) => ({
    turn: i + 1,
    timestamp: e.timestamp,
    output_excerpt: e.output.slice(0, 500),
    principles_triggered: e.principlesTriggered,
    drifted_from_value: e.driftedFrom,
    confidence: 0.90,
  }));

  const event = await db.logDriftEvent({
    userId, sessionUuid,
    driftScore: 0.75,
    verdict: 'RED',
    stateHistoryJson: driftEntry,
    flagsJson: scanResults.map(r => ({
      type: 'pre_output_drift_confirmed',
      severity: 'high',
      principle: r.principle,
      pattern_matched: r.patternMatched,
      excerpt: r.excerpt,
      drifted_from_value: r.driftedFrom,
      match_type: r.matchType,
      confidence: r.confidence,
      consecutive_turns: DRIFT_CONSECUTIVE_THRESHOLD,
      auto_rollback_triggered: true,
    })),
    recommendation: 'DRIFT CONFIRMED: 3 consecutive outputs contradict documented Nikita values. HALT and auto-rollback.',
  });

  // Also write to wallt_core_conflict_log (conflict log)
  await pool.query(
    `INSERT INTO wallt_core_conflict_log
       (user_id, session_uuid, conflict_type, request_summary, wallt_position, resolution, created_at)
     VALUES ($1, $2, 'pre_output_drift', $3, $4, 'pending_auto_rollback', NOW())`,
    [
      userId,
      sessionUuid,
      JSON.stringify({ output_excerpt: output.slice(0, 300), principles_triggered: principlesTriggered }),
      `Anti-patterns detected against: ${driftedFrom.join('; ')}`,
    ]
  ).catch(e => console.warn('[wallt-moral-drift] conflict log write failed:', e.message));

  // ── 5. Auto-rollback: fetch last aligned response ───────────────────────────
  let rollbackContent = correctedOutput;
  if (!rollbackContent) {
    rollbackContent = await _fetchLastAlignedResponse(sessionUuid);
  }

  const rolledBack = rollbackContent !== null;
  if (rolledBack) {
    console.info(`[wallt-moral-drift] Auto-rollback to last aligned response for session ${sessionUuid}`);
  }

  // ── 6. Escalate to Polsia (Slack + email) via wallt-escalation ───────────────
  let escalated = false;
  try {
    const { triggerFromMoralDrift } = require('./wallt-escalation');
    const escCtx = {
      flags: scanResults.map(r => ({
        type: 'pre_output_drift',
        severity: 'high',
        principle: r.principle,
        pattern_matched: r.patternMatched,
        excerpt: r.excerpt,
        drifted_from_value: r.driftedFrom,
        consecutive_turns: DRIFT_CONSECUTIVE_THRESHOLD,
        rollback_triggered: rolledBack,
      })),
      breakdown: { pre_output_check: true, consecutive_drift: DRIFT_CONSECUTIVE_THRESHOLD },
      recommendation: 'DRIFT CONFIRMED: auto-rollback triggered, Polsia notified.',
      event_id: event?.id,
      drift_entry: driftEntry,
      project_id: projectId,
      rolled_back: rolledBack,
      rollback_excerpt: rollbackContent ? rollbackContent.slice(0, 200) : null,
    };

    await triggerFromMoralDrift(0.75, escCtx, userId, sessionUuid);
    escalated = true;
  } catch (e) {
    console.warn('[wallt-moral-drift] escalation trigger failed:', e.message);
  }

  // Clear buffer after drift resolution
  buf.length = 0;

  return {
    aligned: false,
    verdict: 'drifted',
    driftDetails: scanResults,
    eventId: event?.id || null,
    rolledBack,
    rollbackContent,
    escalated,
  };
}

// ── Existing post-output functions (unchanged signatures) ──────────────────────

/**
 * Post-output check: compute drift score from decision history and act on verdict.
 */
async function checkAndLogDrift({ userId, sessionUuid, projectId = null }) {
  const db = require('../db/wallt-moral-drift');

  const recentDecisions = await getRecentDecisionsForDrift({ userId, sessionUuid });
  const result = driftScore(recentDecisions);

  const eventId = await db.logDriftEvent({
    userId, sessionUuid,
    driftScore: result.score,
    verdict: result.verdict,
    stateHistoryJson: recentDecisions,
    flagsJson: result.flags,
    recommendation: result.recommendation,
  });

  if (result.verdict === 'RED') {
    const { triggerFromMoralDrift } = require('./wallt-escalation');
    triggerFromMoralDrift(
      result.score,
      { flags: result.flags, breakdown: result.breakdown, recommendation: result.recommendation, event_id: eventId, recent_decisions_count: recentDecisions.length, project_id: projectId },
      userId, sessionUuid
    ).catch(e => console.warn('[wallt-moral-drift] escalation trigger failed:', e.message));
  } else if (result.verdict === 'YELLOW') {
    pool.query(
      `INSERT INTO app_events (event_name, user_id, metadata_json) VALUES ($1, $2, $3)`,
      ['wallt:moral-drift-warn', userId, JSON.stringify({ score: result.score, verdict: result.verdict, flags: result.flags, event_id: eventId })]
    ).catch(e => console.warn('[wallt-moral-drift] warn event write failed:', e.message));
  }

  return { ...result, event_id: eventId };
}

/**
 * Fetch recent decisions from wallt_core_decision_log for drift scoring.
 */
async function getRecentDecisionsForDrift({ userId, sessionUuid }) {
  const whereParts = ['created_at > NOW() - INTERVAL $1'];
  const args = ['27 days'];
  if (userId) {
    whereParts.push(`user_id = $${args.length + 1}`);
    args.push(userId);
  }
  if (sessionUuid) {
    whereParts.push(`session_uuid = $${args.length + 1}`);
    args.push(sessionUuid);
  }
  args.push(50); // limit

  const { rows } = await pool.query(
    `SELECT id, reasoning_chain, context_json AS reasoning_context,
            confidence_score, outcome, outcome_note, persist_to_core,
            created_at, decision_type
       FROM wallt_core_decision_log
      WHERE ${whereParts.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${args.length}`,
    args
  );

  return rows.map(r => ({
    reasoning_chain: r.reasoning_chain || r.reasoning_context,
    confidence_score: r.confidence_score,
    outcome: r.outcome,
    outcome_note: r.outcome_note,
    persist_to_core: r.persist_to_core,
    created_at: r.created_at,
    decision_type: r.decision_type,
  }));
}

/**
 * Get historical drift events for admin dashboard.
 */
async function getDriftHistory({ userId = null, limit = 30 } = {}) {
  const db = require('../db/wallt-moral-drift');
  return db.getDriftEvents({ userId, limit });
}

/**
 * Resolve a drift event (admin action).
 */
async function resolveDriftEvent(eventId, resolvedByUserId, resolution = 'acknowledged') {
  const db = require('../db/wallt-moral-drift');
  return db.resolveDriftEvent(eventId, resolvedByUserId, resolution);
}

module.exports = {
  // Post-output (legacy)
  driftScore,
  checkAndLogDrift,
  getDriftHistory,
  resolveDriftEvent,
  getRecentDecisionsForDrift,
  // Pre-output (Phase 36O)
  checkPreOutputDrift,
  ATLANTIST_PRINCIPLES,
  VALUES_AND_PATTERNS,
};