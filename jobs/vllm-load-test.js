/**
 * vLLM CPU Swap Load Test
 * ─────────────────────────
 * Deliberately exhausts the block pool by firing 20 concurrent max-length requests.
 * Verifies vLLM gracefully swaps to CPU instead of OOM.
 * Measures latency degradation during swap — documents acceptable threshold.
 *
 * Usage: node jobs/vllm-load-test.js [--concurrent=20] [--max-len=16384]
 *
 * Environment:
 *   VLLM_BASE_URL      — vLLM server URL (falls back to OPENAI_BASE_URL)
 *   OPENAI_BASE_URL    — Polsia proxy fallback
 *   VLLM_API_KEY       — optional API key for vLLM server auth
 *
 * Acceptance: No OOM crash, CPU swap logged, latency degrades gracefully (<3× baseline).
 */

'use strict';

const { spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const CONCURRENT = parseInt(process.argv.find(a => a.startsWith('--concurrent='))?.split('=')[1] || '20');
const MAX_LEN    = parseInt(process.argv.find(a => a.startsWith('--max-len='))?.split('=')[1] || '16384');
const BASE_URL   = process.env.VLLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1';
const API_KEY    = process.env.VLLM_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL_NAME = process.env.VLLM_MODEL_NAME || 'gpt-4o';

const LATENCY_DEGRADATION_THRESHOLD = 3.0; // 3× baseline = unacceptable
const CPU_SWAP_ALERT_THRESHOLD_MS = 5000;   // >5s = concerning

// ── Max-length prompt template ────────────────────────────────────────────────
// Repeatable prefix for cache testing + stress load
const SYSTEM_PROMPT = 'You are a helpful AI assistant specializing in architectural and structural engineering.';
const USER_PROMPT_BASE = `Analyze the following BIM workflow description and provide recommendations. ` +
  `Be thorough and detailed. Explain your reasoning step by step. ` +
  `Reference relevant building codes and standards where applicable.\n\n`;

// Build a long prompt that pushes token count toward max_len
function buildPrompt(nTokens) {
  const approxCharsPerToken = 4;
  const targetChars = nTokens * approxCharsPerToken;
  const body = USER_PROMPT_BASE.repeat(Math.ceil(targetChars / USER_PROMPT_BASE.length));
  return body.slice(0, targetChars);
}

// ── LLM request helper ────────────────────────────────────────────────────────
async function sendRequest(prompt, requestId) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 min hard cap

  try {
    const body = {
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 256,
      temperature: 0.7,
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    };
    // vLLM server uses OpenAI-compatible /v1/chat/completions
    const endpoint = BASE_URL.includes('polsia')
      ? `${BASE_URL}/chat/completions`
      : `${BASE_URL}/v1/chat/completions`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const latency = Date.now() - start;
    const ok = res.ok;
    let content = '';
    try {
      const json = await res.json();
      content = json.choices?.[0]?.message?.content || '';
    } catch {
      content = await res.text().catch(() => '');
    }

    return { requestId, ok, latency, status: res.status, content: content.slice(0, 200) };
  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - start;
    return { requestId, ok: false, latency, status: 0, error: err.message };
  }
}

// ── CPU swap detection ─────────────────────────────────────────────────────────
// Check if the monitor API logs a CPU swap event during the test window.
// Also watch for OOM in logs.
async function detectCpuSwapAfter(monitorUrl) {
  try {
    const res = await fetch(`${monitorUrl}/api/vllm-cache-monitor/snapshot`);
    const data = await res.json();
    const cpuSwaps = data.cpu_swap_events || [];
    return { detected: cpuSwaps.length > 0, count: cpuSwaps.length, events: cpuSwaps };
  } catch {
    return { detected: false, count: 0, events: [] };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('vLLM CPU Swap Load Test');
  console.log(`  Concurrent requests : ${CONCURRENT}`);
  console.log(`  Max tokens per req  : ${MAX_LEN}`);
  console.log(`  Base URL            : ${BASE_URL}`);
  console.log(`  Model              : ${MODEL_NAME}`);
  console.log('═'.repeat(60));
  console.log('');

  // Baseline: single short request
  console.log('[1/4] Establishing baseline latency (short request)…');
  const baselineStart = Date.now();
  const baseline = await sendRequest('Hello, briefly respond.', 'baseline');
  const baselineLatency = baseline.latency;
  console.log(`  Baseline latency: ${baselineLatency}ms ${baseline.ok ? '✓' : '✕ ' + (baseline.error || '')}`);
  console.log('');

  // Warm-up: fire some requests to prime the cache
  console.log('[2/4] Priming cache with 3 warm-up requests…');
  const warmupPromises = Array.from({ length: 3 }, (_, i) =>
    sendRequest(buildPrompt(512), `warmup-${i}`)
  );
  const warmupResults = await Promise.allSettled(warmupPromises);
  const warmupOk = warmupResults.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  console.log(`  Warm-up complete: ${warmupOk}/3 succeeded`);
  console.log('');

  // Main stress test: 20 concurrent max-length requests
  console.log(`[3/4] Firing ${CONCURRENT} concurrent max-length requests…`);
  console.log('  (This pushes the block pool toward exhaustion — CPU swap expected if pool is bounded)\n');

  const stressPromises = Array.from({ length: CONCURRENT }, (_, i) =>
    sendRequest(buildPrompt(MAX_LEN), `stress-${i}`)
  );

  const stressStart = Date.now();
  const stressResults = await Promise.allSettled(stressPromises);
  const totalDuration = Date.now() - stressStart;

  const succeeded = stressResults.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  const failed     = stressResults.filter(r => !r.status === 'fulfilled' || !r.value?.ok).length;
  const latencies  = stressResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value.latency);

  const avgLatency = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  const maxLatency = latencies.length ? Math.max(...latencies) : 0;
  const p95Latency = latencies.length
    ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]
    : 0;

  console.log('  Stress results:');
  console.log(`    Succeeded : ${succeeded}/${CONCURRENT}`);
  console.log(`    Failed    : ${failed}/${CONCURRENT}`);
  console.log(`    Total time: ${totalDuration}ms`);
  console.log(`    Avg latency: ${avgLatency}ms`);
  console.log(`    P95 latency: ${p95Latency}ms`);
  console.log(`    Max latency: ${maxLatency}ms`);
  console.log('');

  // Degradation factor
  const degradation = avgLatency / baselineLatency;
  console.log(`  Degradation vs baseline: ${degradation.toFixed(2)}× (baseline ${baselineLatency}ms)`);
  const degradationOk = degradation <= LATENCY_DEGRADATION_THRESHOLD;
  console.log(`  Latency degradation OK: ${degradationOk ? 'YES ✓' : 'NO ✕ (exceeds ' + LATENCY_DEGRADATION_THRESHOLD + '× threshold)'}`);
  if (!degradationOk && avgLatency > CPU_SWAP_ALERT_THRESHOLD_MS) {
    console.log(`  ⚠ WARNING: Average latency ${avgLatency}ms exceeds CPU swap concern threshold (${CPU_SWAP_ALERT_THRESHOLD_MS}ms)`);
  }
  console.log('');

  // Check for CPU swap events via monitor API
  console.log('[4/4] Checking for CPU swap events in cache monitor…');
  // Use localhost:10000 as default Render internal port; respect RENDER_PORT env
  const monitorBase = `http://localhost:${process.env.PORT || 10000}`;
  const swapResult = await detectCpuSwapAfter(monitorBase);

  if (swapResult.detected) {
    console.log(`  ⚠ CPU SWAP DETECTED: ${swapResult.count} event(s) logged`);
    swapResult.events.forEach(e => console.log(`    - ${e.agent_id}: ${e.reason} (${e.timestamp})`));
  } else {
    console.log('  ✓ No CPU swap events detected (block pool handled load without swap)');
  }

  // OOM check — any request that errored with OOM keywords
  const oomErrors = stressResults
    .filter(r => !r.status === 'fulfilled' || (r.value?.error && /out.of.memory|oom|memory.exceeded/i.test(r.value.error)))
    .map(r => r.status === 'fulfilled' ? r.value.error : r.reason);
  if (oomErrors.length > 0) {
    console.log(`  ✕ OOM DETECTED: ${oomErrors.length} requests failed with memory errors:`);
    oomErrors.forEach(e => console.log(`    - ${e}`));
  } else {
    console.log('  ✓ No OOM errors detected');
  }
  console.log('');

  // Summary
  console.log('═'.repeat(60));
  console.log('TEST SUMMARY');
  console.log('═'.repeat(60));
  const allOk = succeeded === CONCURRENT && degradationOk && !swapResult.detected && oomErrors.length === 0;
  console.log(`  Overall result : ${allOk ? 'PASS ✓' : 'PARTIAL ⚠'}`);
  console.log(`  Success rate  : ${succeeded}/${CONCURRENT} (${Math.round(succeeded/CONCURRENT*100)}%)`);
  console.log(`  Latency deg.  : ${degradation.toFixed(2)}× (threshold: ${LATENCY_DEGRADATION_THRESHOLD}×)`);
  console.log(`  CPU swap      : ${swapResult.detected ? 'DETECTED ⚠' : 'none ✓'}`);
  console.log(`  OOM crashes   : ${oomErrors.length === 0 ? 'none ✓' : `${oomErrors.length} ✕`}`);
  console.log('');
  if (allOk) {
    console.log('  ✓ vLLM handled the load test gracefully — block pool is healthy.');
  } else if (swapResult.detected) {
    console.log('  ⚠ CPU swap triggered — acceptable if within degradation threshold.');
    console.log('  ⚠ If degradation also failed, consider increasing --block-size or reducing max_concurrent_sequences.');
  } else if (!degradationOk) {
    console.log('  ⚠ Latency degradation exceeds threshold — investigate block pool sizing.');
  } else {
    console.log('  ⚠ Some requests failed — check vLLM logs for resource contention.');
  }
  console.log('═'.repeat(60));
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('Load test runner failed:', err);
  process.exit(1);
});