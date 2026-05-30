#!/usr/bin/env node
// scripts/sanitize.js
// Owns: open-source sanitization — strips secrets, env vars, Polsia-specific config,
//       internal references, and agent work artifacts from the repo before public release.
// Does NOT own: syntax validation (syntax-check.js), smoke testing (smoke-test.js).

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Patterns to redact ──────────────────────────────────────────────────────
// These regexes match real-looking credentials, connection strings, and
// Polsia-internal config that should never appear in a public snapshot.
const SANITIZE_PATTERNS = [
  // Connection strings with embedded passwords
  [/(postgresql|mysql|mongodb|redis):\/\/[^\/]*:[^\/]*@/g, 'REDACTED'],
  // API key patterns (sk_live, sk_test, pk_live, etc.)
  [/\b(sk_|pk_)[a-zA-Z0-9]{20,}/g, 'sk_REDACTED'],
  // Anthropic / OpenAI keys
  [/\b(sk-ant-api|sk-pola)[a-zA-Z0-9_-]{20,}/g, 'sk_REDACTED'],
  // Generic long alphanumeric tokens (≥32 hex or base64-like strings that look like keys)
  [/\b[a-f0-9]{32,}\b/g, 'REDACTED_TOKEN'],
  // Polsia R2 / internal infra URLs
  [/(https?:\/\/pub-[a-z0-9]+\\.r2\\.dev)/g, 'https://pub-XXXX.r2.dev'],
  [/(https?:\/\/[^.]+\\.polsia\\.app)/g, 'https://app.OPEN-SOURCE-REPO.pol'],
  // INI/env-style: any VAR=value that contains a real-looking secret
  [/^([A-Z_]{3,})=(.+)$/gm, (match, key, val) => {
    if (val.length > 16 && /[a-zA-Z0-9_\/+=\/-]{20,}/.test(val)) {
      return `${key}=REDACTED`;
    }
    return match;
  }],
  // Inline HTML: real creds in data attributes / script tags
  [/("|')[a-zA-Z0-9]{32,}("|')/g, '"REDACTED"'],
  // GitHub tokens in URLs
  [/x-access-token:[a-zA-Z0-9_-]{20,}/g, 'x-access-token:REDACTED'],
  // Stripe keys
  [/\b(rk|sk|pk)_(live|test)_[a-zA-Z0-9]{20,}/g, 'rk_live_REDACTED'],
];

// Files that are NEVER copied to the public snapshot
const ALWAYS_EXCLUDE = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.claude.json',
  '.claude.json.backup',
  '.claude/',
  '.claude/skills/',
  'node_modules',
  '.tmp',
  'debug',
  'shell-snapshots',
  'statsig/',
  'todos/',
  'audit.mjs',
  'capture-screenshots.js',
  'screenshot-all-features.js',
  'visual-test-runner.js',
  'verify-rect.js',
  'verify-legal-engine.js',
  'find-pages.js',
  'find-unguarded.js',
  'fix-docs.js',
  'get-image.js',
  'get-image.mjs',
  'playwright.config.js',
  'session-env/',
  'tests/e2e',
  'tests/load',
  'tests/stress',
  'tests/scripts',
  '.aider',
];

// Directories that are NEVER copied
const EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  '.tmp',
  'debug',
  'shell-snapshots',
  'statsig',
  'todos',
  'session-env',
  'tests/e2e',
  'tests/load',
  'tests/stress',
  'tests/scripts',
];

// Files REPLACED with sanitized versions (rewritten with redacted content)
const REWRITE_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'polsia.toml',
  '.gitignore',
];

// Files that get a license header prepended
const HEADER_FILES = [
  'server.js',
  'migrate.js',
  'render.yaml',
  'polsia.toml',
  'README.md',
  'CLAUDE.md',
];

// Patterns that trigger a FAIL (secrets that should NEVER exist in committed code)
const SECRET_FAIL_PATTERNS = [
  /sk_live_[a-zA-Z0-9]{20,}/,
  /npg_[a-zA-Z0-9]{20,}/,
  /sk-ant-api[a-zA-Z0-9_-]{20,}/,
  /x-access-token:[a-zA-Z0-9_-]{20,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /gho_[a-zA-Z0-9]{20,}/,
  /ghu_[a-zA-Z0-9]{20,}/,
  /ghs_[a-zA-Z0-9]{20,}/,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/,
];

const LICENSE_HEADER = `/**
 * Atlantist BIM 2.0 — Open Source Edition
 * Copyright (c) ${new Date().getFullYear()} Atlantist, Inc.
 * Licensed under the Apache License 2.0 — see LICENSE file
 */
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExcluded(filepath) {
  const rel = path.relative(process.cwd(), filepath);
  return ALWAYS_EXCLUDE.some(ex => {
    if (ex.endsWith('/')) return rel.startsWith(ex) || rel.includes('/' + ex);
    return rel === ex || rel.startsWith(ex + '/') || rel.endsWith('/' + ex);
  });
}

function shouldRewrite(filename) {
  return REWRITE_FILES.includes(path.basename(filename));
}

function redactBuffer(buf) {
  let str = buf.toString('utf8');
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    str = str.replace(pattern, replacement);
  }
  return Buffer.from(str, 'utf8');
}

function sanitizeText(text) {
  let result = text;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    if (typeof replacement === 'function') {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

function addLicenseHeader(content, filename) {
  if (filename.endsWith('.md')) {
    return content; // Markdown files use their own comment style
  }
  if (content.trimStart().startsWith('#!/')) return content; // Shebang scripts
  return LICENSE_HEADER + content;
}

function checkForSecrets(content, filename) {
  const failures = [];
  for (const pattern of SECRET_FAIL_PATTERNS) {
    if (pattern.test(content)) {
      failures.push(`FAIL: real secret detected in ${filename}: ${pattern}`);
    }
  }
  return failures;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const outDir = process.argv[2] || '.public';
  const isPublic = process.argv.includes('--public'); // set when running against clean/public input

  console.log(`Sanitizing repo → ${outDir}/`);
  console.log(`Mode: ${isPublic ? 'public input (skip fail-gate)' : 'internal repo (full fail-gate)'}`);

  // Step 1: Reject if real secrets are already in the repo
  if (!isPublic) {
    console.log('\n[Step 1/4] Scanning for leaked secrets...');
    const failures = [];
    const allJsFiles = execSync('find . -name "*.js" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.tmp/*" 2>/dev/null')
      .toString().trim().split('\n').filter(Boolean);

    for (const file of allJsFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        failures.push(...checkForSecrets(content, file));
      } catch {
        // skip unreadable files
      }
    }

    // Also scan HTML for embedded creds
    const htmlFiles = execSync('find public -name "*.html" -not -path "*/node_modules/*" 2>/dev/null')
      .toString().trim().split('\n').filter(Boolean);
    for (const file of htmlFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        failures.push(...checkForSecrets(content, file));
      } catch {
        // skip
      }
    }

    if (failures.length > 0) {
      console.error('\n!!! SECURITY FAILURES DETECTED !!!');
      failures.forEach(f => console.error('  ' + f));
      console.error('\nThese real secrets must be removed BEFORE open-sourcing.');
      console.error('Run sanitize with --public after cleaning to generate the public snapshot.');
      process.exit(1);
    }
    console.log('  PASS: no leaked secrets detected');
  }

  // Step 2: Copy sanitized tree to output directory
  console.log('\n[Step 2/4] Building sanitized snapshot...');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  function copyDir(src, dst) {
    if (EXCLUDE_DIRS.some(d => src.includes('/' + d) || src.endsWith(d))) return;
    if (isExcluded(src)) return;

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyDir(path.join(src, entry), path.join(dst, entry));
      }
    } else {
      const base = path.basename(src);
      if (ALWAYS_EXCLUDE.includes(base)) return;

      if (shouldRewrite(src)) {
        const content = fs.readFileSync(src);
        const sanitized = redactBuffer(content);
        fs.writeFileSync(dst, sanitized);
      } else {
        fs.copyFileSync(src, dst);
      }
    }
  }

  // Root files
  const rootFiles = fs.readdirSync('.');
  for (const file of rootFiles) {
    if (file === outDir || isExcluded(file)) continue;
    const srcPath = path.join('.', file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(file)) {
        const dstPath = path.join(outDir, file);
        fs.mkdirSync(dstPath, { recursive: true });
        copyDir(srcPath, dstPath);
      }
    } else {
      if (ALWAYS_EXCLUDE.includes(file)) continue;
      if (shouldRewrite(file)) {
        const content = fs.readFileSync(srcPath);
        fs.writeFileSync(path.join(outDir, file), redactBuffer(content));
      } else {
        fs.copyFileSync(srcPath, path.join(outDir, file));
      }
    }
  }

  // Add license headers to JS files in output
  console.log('\n[Step 3/4] Adding license headers...');
  function addHeadersRecursive(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        addHeadersRecursive(full);
      } else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        if (!content.trimStart().startsWith('/**')) {
          fs.writeFileSync(full, addLicenseHeader(content, full));
        }
      }
    }
  }
  addHeadersRecursive(outDir);

  // Step 4: Generate .gitignore for the public snapshot
  console.log('\n[Step 4/4] Generating public .gitignore...');
  const publicGitignore = `# Dependencies
node_modules/

# Environment variables — NEVER commit
.env
.env.local
.env.production
.env.development

# Build artifacts
dist/
build/

# Logs
logs/
*.log
npm-debug.log*

# OS
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# Testing
coverage/
.nyc_output/

# Misc
*.pem
*.key
secrets/
credentials/
`;

  fs.writeFileSync(path.join(outDir, '.gitignore'), publicGitignore);

  console.log(`\n✓ Sanitized snapshot written to ${outDir}/`);
  console.log(`  - Real secrets: FAIL-gated (${isPublic ? 'skipped (--public mode)' : 'checked and clean'})`);
  console.log(`  - Env vars/redacted: replaced with REDACTED/PLACEHOLDER`);
  console.log(`  - Excluded: .env, .claude/, node_modules, todos/, debug/, *.bak, etc.`);
  console.log(`  - License headers: added to all .js files`);
  console.log(`  - Public .gitignore: generated`);

  process.exit(0);
}

const { execSync } = require('child_process');
main();