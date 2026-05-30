#!/usr/bin/env node
// scripts/smoke-test.js
// Owns: HTTP smoke testing of the running server — routes, content-types, static assets
// Does NOT own: syntax validation (see syntax-check.js), database schema, unit tests

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

// Use a random high port to avoid conflicts
const PORT = 9000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const SERVER_START_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 8000;
const WAIT_AFTER_START_MS = 5000;

// Routes to test and their expected properties
const ROUTE_CHECKS = [
  {
    path: '/health',
    expectedStatus: 200,
    expectedContentType: 'application/json',
    bodyContains: 'healthy',
  },
  {
    path: '/',
    expectedStatus: 200,
    expectedContentType: 'text/html',
    bodyContains: ['<!DOCTYPE html>', '<!doctype html>'],
  },
  {
    path: '/app',
    expectedStatus: 200,
    expectedContentType: 'text/html',
    bodyContains: ['<!DOCTYPE html>', '<!doctype html>'],
  },
  {
    path: '/pricing',
    expectedStatus: 200,
    expectedContentType: 'text/html',
    bodyContains: ['Plan', 'pro', 'trial'],
  },
  {
    path: '/subscribe/acknowledge',
    // Renders subscribe-acknowledge.html OR 404 if file absent — either way no 500
    expectedStatus: [200, 404],
    expectedContentType: 'text/html',
  },
  {
    path: '/js/app.js',
    expectedStatus: 200,
    expectedContentType: 'application/javascript',
  },
  {
    path: '/js/mep-panel.js',
    expectedStatus: 200,
    expectedContentType: 'application/javascript',
  },
  // Task 0.6 — smoke test every tab
  {
    path: '/demo/nyc-midrise',
    expectedStatus: 200,
    expectedContentType: 'text/html',
    bodyContains: ['<!DOCTYPE html>', '<!doctype html>'],
  },
  {
    path: '/store/search',
    expectedStatus: 200,
    expectedContentType: 'text/html',
    bodyContains: ['<!DOCTYPE html>', '<!doctype html>'],
  },
  {
    path: '/blog',
    // 301 from legacy hosts (nexaxis/atlantist.polsia.app → atlantist.cloud/blog); 200 on canonical
    expectedStatus: [200, 301],
    expectedContentType: 'text/html',
    bodyContains: ['<!DOCTYPE html>', '<!doctype html>'],
  },
  {
    path: '/docs/features',
    expectedStatus: 200,
    expectedContentType: 'text/html',
    bodyContains: ['<!DOCTYPE html>', '<!doctype html>'],
  },
  {
    path: '/api/catalog/roof-types',
    expectedStatus: 200,
    expectedContentType: 'application/json',
    bodyContains: 'roofTypes',
  },
  // Task #2093700 — regression guard: /api/elements route must exist and route correctly.
  // Accepts 200 (elements returned), 404 (project has no elements), or 401 (auth required —
  // proves the route resolves to auth middleware, not a missing-route 404).
  // The key regression is that the endpoint RESOLVES — any of these statuses confirm routing works.
  {
    path: '/api/elements?project_id=aabbccdd-0001-4000-8000-000000000001',
    expectedStatus: [200, 401, 404],
    expectedContentType: 'application/json',
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}${urlPath}`;
    const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out: ${urlPath}`));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  // Guard: if DATABASE_URL is not set, smoke test requires it to start server
  if (!process.env.DATABASE_URL) {
    console.log('SMOKE TEST SKIPPED: DATABASE_URL not set — cannot start server.');
    console.log('Set DATABASE_URL to run smoke tests locally.');
    console.log('On Render CI, this test runs automatically (DATABASE_URL is always set).');
    process.exit(0);
  }

  let serverProc = null;
  let exitCode = 0;
  const errors = [];

  try {
    console.log(`Starting server on port ${PORT} for smoke test...`);

    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverReady = false;
    let serverOutput = '';

    serverProc.stdout.on('data', (d) => {
      serverOutput += d.toString();
      if (serverOutput.includes('running on port')) serverReady = true;
    });
    serverProc.stderr.on('data', (d) => {
      const line = d.toString();
      // Only log non-trivial errors
      if (!line.includes('DeprecationWarning') && !line.includes('ExperimentalWarning')) {
        process.stderr.write('[server stderr] ' + line);
      }
    });

    // Wait for server to start (with timeout)
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (!serverReady && Date.now() < deadline) {
      await sleep(250);
    }

    if (!serverReady) {
      // Give a bit more time — server output might be buffered
      await sleep(2000);
    }

    if (!serverReady) {
      throw new Error(`Server did not start within ${SERVER_START_TIMEOUT_MS}ms.\nOutput: ${serverOutput}`);
    }

    console.log(`Server started. Running route checks...\n`);

    // Give routes a brief settling period
    await sleep(500);

    // ── Route checks ──────────────────────────────────────────────────────────
    for (const check of ROUTE_CHECKS) {
      let res;
      try {
        res = await get(check.path);
      } catch (err) {
        errors.push(`FAIL ${check.path}: request error — ${err.message}`);
        continue;
      }

      // Status check
      const allowedStatuses = Array.isArray(check.expectedStatus)
        ? check.expectedStatus
        : [check.expectedStatus];

      if (!allowedStatuses.includes(res.status)) {
        errors.push(
          `FAIL ${check.path}: expected status ${allowedStatuses.join('|')}, got ${res.status}`
        );
      } else {
        console.log(`  PASS ${check.path} → ${res.status}`);
      }

      // Content-type check
      if (check.expectedContentType) {
        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (!ct.includes(check.expectedContentType.split('/')[1])) {
          errors.push(
            `FAIL ${check.path}: expected content-type containing '${check.expectedContentType}', got '${ct}'`
          );
        }
      }

      // Body contains check
      if (check.bodyContains) {
        const needles = Array.isArray(check.bodyContains)
          ? check.bodyContains
          : [check.bodyContains];
        const bodyLower = res.body.toLowerCase();
        const found = needles.some((n) => bodyLower.includes(n.toLowerCase()));
        if (!found) {
          errors.push(
            `FAIL ${check.path}: body does not contain any of [${needles.join(', ')}]`
          );
        }
      }
    }

    // ── Static JS file existence check (without DB, via filesystem) ───────────
    const criticalJsFiles = [
      'public/js/app.js',
      'public/js/mep-panel.js',
    ];
    for (const f of criticalJsFiles) {
      const full = path.join(__dirname, '..', f);
      if (!fs.existsSync(full)) {
        errors.push(`FAIL: Critical JS file missing from build: ${f}`);
      }
    }

  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      // Give it a moment to die
      await sleep(500);
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (errors.length > 0) {
    console.error('\nSMOKE TEST FAILURES:');
    for (const e of errors) console.error(`  ${e}`);
    console.error(`\nBUILD GATE FAILED: ${errors.length} smoke test(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nBUILD GATE PASSED: All smoke tests passed.');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('SMOKE TEST FATAL:', err.message);
  process.exit(1);
});
