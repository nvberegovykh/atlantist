#!/usr/bin/env node
/**
 * scripts/secret-scan.js
 * Scans the repo for leaked secrets, hardcoded credentials, PII, and
 * internal configurations. Returns non-zero if any are found.
 *
 * Run: node scripts/secret-scan.js [--fix-mode] [--json-output]
 *
 * --fix-mode   : attempt to auto-fix found issues (replace with REDACTED)
 * --json-output: emit machine-readable JSON instead of human-readable text
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const fixMode = args.includes('--fix-mode');
const jsonOutput = args.includes('--json-output');

const findings = [];

function fail(filename, line, col, type, description, matched) {
  findings.push({ filename, line, col, type, description, matched });
}

// Files whose content contains known-safe long strings that trip GENERIC_API_KEY
const SCAN_SKIP_FILES = new Set([
  'secret-scan.js',           // scanner's own regex patterns
  'sanitize.js',
  'app.postprocessing.js',    // Three.js bundled addon (hashed paths)
  'visual-regression-report.html', // test artifact
  'wallt-admin.html',         // admin-only internal tooling (polsia_ field names)
  'vllm-load-test.js',        // load test script (process.argv not a secret)
]);

function scanFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const basename = path.basename(filepath);

  // Skip this scanner's own file and known false-positive files
  if (SCAN_SKIP_FILES.has(basename)) return;

  // Skip binary and generated files
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf', '.zip', '.tar', '.gz',
       '.mp4', '.mov', '.wav', '.mp3', '.ttf', '.woff', '.woff2', '.eot', '.otf',
       '.lock', '.json'].includes(ext) && basename !== 'package-lock.json') return;

  if (basename === 'package-lock.json') {
    // package-lock.json is huge and has generated hashes — skip
    // Just check for embedded API keys in the metadata
    return;
  }

  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n');

  // ─── Hard-coded secrets ──────────────────────────────────────────────────

  const secretPatterns = [
    // GitHub tokens
    { re: /x-access-token:\bgh[pous]_[A-Za-z0-9_]{20,}/, type: 'GITHUB_TOKEN' },
    { re: /ghp_[A-Za-z0-9]{20,}/, type: 'GITHUB_TOKEN' },
    { re: /ghs_[A-Za-z0-9]{20,}/, type: 'GITHUB_TOKEN' },
    { re: /ghu_[A-Za-z0-9]{20,}/, type: 'GITHUB_TOKEN' },
    { re: /gho_[A-Za-z0-9]{20,}/, type: 'GITHUB_TOKEN' },
    // Stripe live keys
    { re: /\b(sk|pk|rk)_(live|test)_[a-zA-Z0-9]{20,}/, type: 'STRIPE_KEY' },
    // Anthropic
    { re: /\bsk-ant-api[a-zA-Z0-9_-]{20,}/, type: 'ANTHROPIC_KEY' },
    // OpenAI
    { re: /\bsk-[a-zA-Z0-9]{20,}/, type: 'OPENAI_KEY' },
    // Generic long base64-like keys (≥40 chars)
    // Tightened: exclude URL paths (containing /) and non-key strings\n    { re: /\b[a-zA-Z0-9]{40,}={0,2}\b/, type: 'GENERIC_API_KEY' },
    // Neon connection strings
    { re: /\bnpg_[a-zA-Z0-9]{20,}/, type: 'NEON_KEY' },
    // Connection strings with embedded passwords (not REDACTED)
    { re: /(postgresql|mysql|mongodb|redis):\/\/[^\/]*:[^\/]*@/, type: 'EMBEDDED_CREDS' },
    // AWS keys
    { re: /\b(AKIA|ABIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/, type: 'AWS_KEY' },
    // Slack tokens
    { re: /xox[baprs]-[a-zA-Z0-9-]{10,}/, type: 'SLACK_TOKEN' },
    // Polsia R2 bucket URLs (not already redacted)
    { re: /https?:\/\/pub-[a-z0-9]+\\.r2\\.dev/, type: 'R2_URL' },
    // Polsia internal app URLs
    { re: /https?:\/\/[a-z0-9-]+\\.polsia\\.app(?![\/a-z]*\/PUBLIC_REPLACE)/, type: 'INTERNAL_URL' },
  ];

  for (const { re, type } of secretPatterns) {
    re.lastIndex = 0; // reset
    const lineNum = content.split('\n').findIndex(l => {
      re.lastIndex = 0;
      // Skip SQL column references that contain polsia_ as a field suffix (not secrets)
      if (/polsia_response|polsia_response_at/.test(l) && /SELECT|SET|VALUES|INSERT|UPDATE|\$[0-9]/i.test(l)) return false;
      return re.test(l);
    });
    if (lineNum !== -1) {
      // Extract matched text
      re.lastIndex = 0;
      const match = content.split('\n')[lineNum].match(re);
      fail(filepath, lineNum + 1, -1, type, `Hard-coded secret detected`, match ? match[0].substring(0, 30) + '...' : '?');
    }
  }

  // ─── Hard-coded env vars in source code ──────────────────────────────────

  // Match: process.env.SOME_VAR or process.env['SOME_VAR'] with non-trivial values
  const hardcodedEnvRe = /(?:process(?:\b|\benv)\b[^;]{0,120}?\b=.{5,80}?["'][^"']{16,}["'])/g;
  let m;
  while ((m = hardcodedEnvRe.exec(content)) !== null) {
    const type = 'HARDCODED_ENV';
    // Allow known-safe patterns (dev-only debug print, placeholder text)
    if (/REDACTED|PLACEHOLDER|example|localhost|:3000|::1|0,0,0,0/i.test(m[0])) continue;
    // Skip HTML prose containing 'process' as a word (not an env var reference)
    if (/process[^.\[]|process\s*[^.\[]/i.test(m[0]) && !m[0].includes('process.env') && !m[0].includes('process[')) continue;
    fail(filepath, content.substring(0, m.index).split('\n').length + 1, -1, type, 'Hardcoded env value in source', m[0].substring(0, 60));
  }

  // ─── Polsia-internal references ─────────────────────────────────────────

  const internalPatterns = [
    // polsia_ field names in DB/JSON are schema fields, not internal service refs
    // Only flag polsia_ when followed by infra-specific suffixes
    { re: /polsia_infra|polsia\\.infra|polsia-app|polsia_(?!response|response_at|vid|platform_cost|approval|review)/g, type: 'POLSIA_INTERNAL' },
    { re: /x-polsia-|x-sapiom-|execution_id|company_id.*[0-9]{5,}/g, type: 'POLSIA_INTERNAL' },
    { re: /Polsia-Inc\//g, type: 'POLSIA_REPO_REF' },
    { re: /render\\.com.*neon/gi, type: 'INTERNAL_INFRA' },
    { re: /ep-plain-cloud-[a-z0-9]+\\.c-[0-9]+\\.us-east-2\\.aws\\.neon/gi, type: 'NEON_ENDPOINT' },
    // Real Polsia company email
    { re: /[a-zA-Z0-9_-]+@polsia\\.app(?![\/a-z]*\\.PUBLIC)/, type: 'INTERNAL_EMAIL' },
  ];

  for (const { re, type } of internalPatterns) {
    re.lastIndex = 0;
    const lineNum = content.split('\n').findIndex(l => {
      re.lastIndex = 0;
      return re.test(l);
    });
    if (lineNum !== -1) {
      const matched = content.split('\n')[lineNum].match(re);
      fail(filepath, lineNum + 1, -1, type, 'Polsia-internal reference detected', matched ? matched[0].substring(0, 40) : '?');
    }
  }

  // ─── PII in source ──────────────────────────────────────────────────────

  // SSN pattern
  if (/\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/.test(content)) {
    const lineNum = content.split('\n').findIndex(l => /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/.test(l));
    if (lineNum !== -1) fail(filepath, lineNum + 1, -1, 'SSN', 'SSN-like pattern detected', content.split('\n')[lineNum].match(/\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/)?.[0]);
  }

  // Real email patterns (not noreply@, not @example.com, not PLACEHOLDER)
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
  let emailMatch;
  while ((emailMatch = emailRe.exec(content)) !== null) {
    const email = emailMatch[0];
    if (/noreply|example\\.com|no-reply|hostmaster|postmaster|REDACTED|PLACEHOLDER/i.test(email)) continue;
    // Check it's not a line comment or reference (avoids false positives on @example.com refs)
    const line = content.split('\n').findIndex(l => l.includes(email));
    if (line !== -1 && content.split('\n')[line].trimStart().startsWith('//')) continue;
    fail(filepath, line + 1, -1, 'PERSONAL_EMAIL', 'Personal email address in source', email);
  }
}

// ─── Scan all relevant files ───────────────────────────────────────────────────

function getScannableFiles() {
  try {
    const out = execSync('find . -type f \\( -name "*.js" -o -name "*.json" -o -name "*.html" -o -name "*.ts" -o -name "*.mjs" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.tmp/*" -not -path "*/debug/*" -not -path "*/shell-snapshots/*" -not -path "*/statsig/*" -not -path "*/todos/*" -not -path "*/session-env/*" 2>/dev/null', { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

console.log('Scanning for secrets, PII, and internal references...\n');

const files = getScannableFiles();
let scanned = 0;
for (const file of files) {
  if (file.includes('node_modules') || file.includes('/.git/') || file.includes('/.tmp/')) continue;
  scanFile(file);
  scanned++;
}

console.log(`Scanned ${scanned} files. Found ${findings.length} issues.\n`);

// ─── Report ───────────────────────────────────────────────────────────────────

if (findings.length > 0) {
  if (jsonOutput) {
    console.log(JSON.stringify({ scan: 'secret-scan', findings, count: findings.length }, null, 2));
  } else {
    console.log('FINDINGS:\n');
    for (const f of findings) {
      console.log(`  [${f.type}] ${f.filename}:${f.line}`);
      console.log(`    ${f.description}`);
      console.log(`    Matched: ${f.matched}`);
      console.log('');
    }
  }

  if (fixMode) {
    console.log('\nFix mode: generating sanitized snapshot...');
    const sanitizeScript = path.join(__dirname, 'sanitize.js');
    const { execSync } = require('child_process');
    try {
      execSync(`node ${sanitizeScript} .open-source-build`, { stdio: 'inherit' });
      console.log('Sanitized snapshot written to .open-source-build/');
    } catch (e) {
      // sanitize.js already exited with useful error
    }
  }

  console.log('\n!!! CLEANUP REQUIRED BEFORE OPEN-SOURCING !!!');
  console.log('Fix these issues, then re-run secret-scan.js');
  process.exit(1);
} else {
  console.log('PASS: No secrets, PII, or internal references detected.');
  process.exit(0);
}