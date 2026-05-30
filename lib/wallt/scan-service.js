/**
 * Owns: WhatsApp scan orchestration — validate → LLM call → store → respond.
 * Does NOT own: HTTP routing, bearer auth, rate limiting, migration.
 */
'use strict';

const OpenAI = require('openai');
const crypto = require('crypto');
const { buildScanPrompt, parseScanResponse } = require('./scan-prompt');
const { saveScanResult } = require('../../db/wallt-scan');

function getAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
}

/**
 * Hash a message body for deduplication. SHA-256, hex, 64 chars.
 * @param {string} text
 * @returns {string}
 */
function hashMessage(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Format messages into a compact block for the LLM context.
 * Truncates each message to 1000 chars to keep token count reasonable.
 * @param {Array<{ chat, sender, text, timestamp }>} messages
 */
function formatMessagesForLLM(messages) {
  return messages
    .map(m => `[${m.timestamp}] ${m.chat} | ${m.sender}: ${(m.text || '').slice(0, 1000)}`)
    .join('\n');
}

/**
 * Process a WhatsApp message batch.
 * Orchestrates: dedup hashes → LLM scan → store result → return structured response.
 *
 * @param {Object} params
 * @param {string} params.userId        — end user UUID
 * @param {Array}  params.messages      — raw messages from scanner
 * @returns {{ summary, important, scanned_at, message_count }}
 */
async function processScan({ userId, messages }) {
  // Compute hashes for dedup (never store raw text)
  const hashes = messages.map(m => hashMessage(m.text || ''));

  // Build scan prompt + user context
  const systemPrompt = buildScanPrompt({ userId });
  const messageBlock = formatMessagesForLLM(messages);

  // Call LLM with structured output request (retry once on malformed output)
  let parsed;
  const ai = getAI();
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const completion = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `WhatsApp messages to analyze:\n${messageBlock}` },
        ],
        max_tokens: 1024,
        temperature: 0.2,
      });

      const raw = completion.choices[0]?.message?.content || '';
      parsed = parseScanResponse(raw);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.warn(`[wallt-scan] LLM attempt ${attempt} failed: ${err.message}`);
    }
  }

  if (lastError) {
    throw new Error(`Scan LLM exhausted retries: ${lastError.message}`);
  }

  // Persist result — important_items is an array, store as JSONB
  const scannedAt = new Date().toISOString();
  await saveScanResult({
    userId,
    summary: parsed.summary,
    importantItems: parsed.important,
    messageCount: messages.length,
    messageHashes: hashes,
    scannedAt,
  });

  return {
    summary: parsed.summary,
    important: parsed.important,
    scanned_at: scannedAt,
    message_count: messages.length,
  };
}

module.exports = { processScan, hashMessage };