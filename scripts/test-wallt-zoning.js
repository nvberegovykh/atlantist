#!/usr/bin/env node
/**
 * test-wallt-zoning.js — Phase 34C eval runner
 * Hits the live /api/wallt/chat endpoint and asserts cited ZR sections appear.
 *
 * Usage: node scripts/test-wallt-zoning.js [--url http://localhost:3000]
 * Requires: OPENAI_API_KEY, OPENAI_BASE_URL env vars
 *
 * Exits 0 on all pass, exits 1 on any failure.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const API_BASE = process.env.APP_URL || 'https://atlantist.cloud';
const EVAL_FILE = path.join(__dirname, '../tests/wallt-zoning-eval.json');
const AI_MODEL = 'gpt-4o-mini';

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = mod.request(url, opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ raw: data, statusCode: res.statusCode }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Simple embedding via OpenAI ──────────────────────────────────────────────
function getAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'task',
    baseURL: process.env.OPENAI_BASE_URL || 'https://ai.polsia.com/v1',
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const evalData = JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8'));
  const pairs = evalData.pairs;

  console.log(`\n=== Wallt NYC Zoning Eval — ${pairs.length} pairs ===\n`);

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const pair of pairs) {
    process.stdout.write(`[${pair.id}/${pairs.length}] ${pair.question.slice(0, 60)}... `);

    try {
      const ai = getAI();
      // Embed query for RAG classification
      const embedResp = await ai.embeddings.create({
        model: 'text-embedding-3-small',
        input: pair.question.slice(0, 4000),
      });
      const queryEmbedding = embedResp.data[0].embedding;

      // Call the /api/wallt/chat endpoint
      const response = await request('POST', '/api/wallt/chat', {
        messages: [{ role: 'user', content: pair.question }],
        session_id: `eval-${pair.id}`,
      });

      const reply = response.message?.content || '';
      const sources = response.message?.sources || [];

      // Check 1: expected answer keywords appear in reply
      const keywordsOk = pair.expected_answer_contains.every(kw => {
        const found = reply.includes(kw);
        if (!found) console.log(`\n    ✗ missing keyword: "${kw}"`);
        return found;
      });

      // Check 2: required ZR section appears in reply
      const sectionOk = reply.includes(pair.required_zr_section);

      // Check 3: citation source present (nyc.gov ZR URL in sources)
      const citationOk = sources.some(s => s.includes('zr.planning.nyc.gov')) ||
                         reply.includes('zr.planning.nyc.gov') ||
                         reply.includes('nyc.gov');

      const ok = keywordsOk && sectionOk && citationOk;

      if (ok) {
        console.log('PASS ✓');
        passed++;
      } else {
        console.log(`FAIL ✗`);
        console.log(`  keywords: ${keywordsOk ? '✓' : '✗'} | section ${pair.required_zr_section}: ${sectionOk ? '✓' : '✗'} | citation: ${citationOk ? '✓' : '✗'}`);
        failed++;
      }

      results.push({
        id: pair.id,
        question: pair.question,
        passed: ok,
        keywords_ok: keywordsOk,
        section_ok: sectionOk,
        citation_ok: citationOk,
        reply_snippet: reply.slice(0, 200),
        sources: sources.slice(0, 3),
      });

      // Brief pause to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({ id: pair.id, question: pair.question, passed: false, error: err.message });
      failed++;
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Passed: ${passed}/${pairs.length}`);
  console.log(`Failed: ${failed}/${pairs.length}`);

  if (failed > 0) {
    console.log('\nFailed cases:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  #${r.id}: ${r.question.slice(0, 80)}`);
      if (r.error) console.log(`    Error: ${r.error}`);
    });
  }

  // Exit code: 0 = all pass, 1 = any failure
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});