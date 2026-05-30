/**
 * Owns: Wallt WhatsApp scan system prompt — structured JSON output for scan summaries.
 * Does NOT own: LLM calls, DB persistence, auth.
 *
 * Version: SCAN_PROMPT_VERSION — bump when prompt logic changes.
 */
'use strict';

const SCAN_PROMPT_VERSION = '1.0.0';

/**
 * Build the scan system prompt. Messages are passed as user context, not injected here.
 * The model returns structured JSON (summary + important array).
 *
 * @param {Object} [ctx]
 * @param {string} [ctx.userId]
 * @returns {string}
 */
function buildScanPrompt(ctx = {}) {
  const userHint = ctx.userId ? ` (user_id: ${ctx.userId})` : '';
  return `You are Wallt, analyzing a batch of WhatsApp messages for the Atlantist platform${userHint}.
Summarize the key topics, decisions, and action items visible in this batch.
Flag any message that is time-sensitive, requires a response, or contains important business/project information.

**Output format — return valid JSON only, no markdown code fences:**
{
  "summary": "Natural language paragraph (2-4 sentences) summarizing the batch.",
  "important": [
    {
      "chat": "the chat or group name this message appeared in",
      "sender": "contact name or phone",
      "text": "the full message text (up to 500 chars — truncate longer messages)",
      "timestamp": "ISO-8601 timestamp from the original message",
      "reason": "one sentence explaining why this was flagged as important"
    }
  ]
}

**Importance criteria — flag when the message contains:**
- Deadline, due date, or time-sensitive action
- Financial implication (cost, payment, budget, billing)
- A question directed at the user
- Urgent or action-required language (ASAP, please help, blocked, urgent)
- Project-critical information (approvals, change orders, RFIs, inspection results)
- Decisions or commitments being made
- Client or stakeholder communication
- Technical issue requiring response

Return ONLY the JSON object. No preamble, no explanation, no markdown fences.`;
}

/**
 * Parse and validate LLM JSON output. Returns { summary, important } or throws.
 * @param {string} raw  — raw model output
 * @returns {{ summary: string, important: Array }}
 */
function parseScanResponse(raw) {
  let text = raw.trim();
  // Strip code fences if present (some models wrap in ```json)
  const fenceMatch = text.match(/^```(?:json)?\n([\\S\t\n\r ]*?)\n```$/);
  if (fenceMatch) text = fenceMatch[1];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from scan model: ${text.slice(0, 120)}`);
  }

  if (typeof parsed.summary !== 'string' || !parsed.summary.length) {
    throw new Error('scan model returned empty summary');
  }
  if (!Array.isArray(parsed.important)) {
    throw new Error('scan model missing important array');
  }

  // Validate each important item has required fields
  for (const item of parsed.important) {
    if (!item.chat || !item.sender || !item.text || !item.timestamp || !item.reason) {
      throw new Error(`scan model returned malformed important item: ${JSON.stringify(item)}`);
    }
  }

  return parsed;
}

module.exports = { buildScanPrompt, parseScanResponse, SCAN_PROMPT_VERSION };