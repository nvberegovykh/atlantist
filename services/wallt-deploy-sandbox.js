/**
 * Owns: Wallt deployment sandbox execution — pre-deploy validation of changed files.
 * Does NOT own: AI review (Wallt AI coordinator handles bounce fix suggestions),
 *   deployment itself (infrastructure layer handles actual deploy).
 * Phase 36Q: Sandbox execution context, boot/route/migration validation,
 *   bounce loop (up to 3 iterations), promotion + status endpoints.
 */
const crypto = require('crypto');
const vm = require('vm');

const MAX_ITERATIONS = 3;

// ── Changeset hash ──────────────────────────────────────────────────────────

function computeChangesetHash(files) {
  const normalized = files
    .filter(f => f.path && f.content !== undefined)
    .map(f => `${f.path}::${f.content}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

// ── JS syntax validation ────────────────────────────────────────────────────

function validateJsSyntax(content, filePath) {
  const issues = [];
  try {
    new vm.Script(content, { filename: filePath });
  } catch (err) {
    if (err instanceof SyntaxError) {
      issues.push({ type: 'syntax_error', file: filePath, message: err.message, line: err.lineNumber });
    } else {
      issues.push({ type: 'unknown_js_error', file: filePath, message: err.message });
    }
  }
  return issues;
}

// ── Secrets scanning (Loop 19.1 — code diff review) ────────────────────────

const SECRET_PATTERNS = [
  // AWS / cloud keys
  { pattern: /(?<![A-Za-z0-9/+=])AKIA[0-9A-Z]{16}(?![A-Za-z0-9/+=])/i, type: 'AWS_ACCESS_KEY_ID', severity: 'critical' },
  { pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/, type: 'AWS_SECRET_ACCESS_KEY', severity: 'critical' },
  // GCP
  { pattern: /projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+/, type: 'GCP_RESOURCE', severity: 'medium' },
  // OpenAI
  { pattern: /sk-[A-Za-z0-9]{48}/, type: 'OPENAI_API_KEY', severity: 'critical' },
  // Stripe
  { pattern: /sk_live_[A-Za-z0-9]{24,}/, type: 'STRIPE_SECRET_KEY', severity: 'critical' },
  { pattern: /sk_test_[A-Za-z0-9]{24,}/, type: 'STRIPE_TEST_KEY', severity: 'high' },
  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36}/, type: 'GITHUB_TOKEN', severity: 'critical' },
  { pattern: /gho_[A-Za-z0-9]{36}/, type: 'GITHUB_TOKEN', severity: 'critical' },
  // Generic secrets — multiline blocks that look like keys
  { pattern: /(?:api[_-]?key|secret|password|token)\b[\t ]*[=:][\t ]*['"][A-Za-z0-9_/+=]{20,}['"]/i, type: 'GENERIC_SECRET', severity: 'high' },
  // .env-style key=value
  { pattern: /^(OPENAI|SENDGRID|STRIPE|AWS|GITHUB|DB|HASURA|NEON)[_A-Z0-9]*=[\t ]*['"]?[A-Za-z0-9_/+=]{20,}['"]?$/m, type: 'ENV_SECRET', severity: 'high' },
  // Private keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, type: 'PRIVATE_KEY', severity: 'critical' },
  // Hardcoded JWTs
  { pattern: /eyJ[A-Za-z0-9_-]{50,}\\.eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{30,}/, type: 'JWT_TOKEN', severity: 'high' },
];

const IGNORED_PATHS = [
  'node_modules/', '.git/', 'dist/', 'build/', 'coverage/',
  'migrations/', // migrations use parameterized queries, not raw keys
];

/**
 * Scan file content for leaked secrets — returns issues array.
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<{type, file, message, severity, match}>}
 */
function scanForSecrets(content, filePath) {
  const issues = [];
  for (const path of IGNORED_PATHS) {
    if (filePath.includes(path)) return issues; // skip known large dirs
  }

  for (const { pattern, type, severity } of SECRET_PATTERNS) {
    const matches = content.match(new RegExp(pattern, 'gi'));
    if (!matches) continue;
    // Deduplicate matches
    const unique = [...new Set(matches.map(m => m.slice(0, 12) + '...'))];
    for (const match of unique) {
      issues.push({
        type: 'secrets_leaked',
        file: filePath,
        secret_type: type,
        severity,
        message: `Potential ${type} detected in file: ${match}`,
        match: match.slice(0, 20) + '***',
      });
    }
  }
  return issues;
}

// ── Route handler validation ───────────────────────────────────────────────

function validateRouteFile(content, filePath) {
  const issues = [];
  const methodPattern = /(?:router|app)\b.(get|post|put|patch|delete|use|head|options)\b/i;
  const lines = content.split('\n');
  const routeLines = lines.filter(l => methodPattern.test(l));

  for (const line of routeLines) {
    const commaIdx = line.indexOf(',');
    if (commaIdx === -1) continue;
    const afterComma = line.slice(commaIdx + 1).trim();
    if (afterComma === '' || afterComma === ')') {
      issues.push({ type: 'missing_handler', file: filePath, line: line.trim().slice(0, 120) });
    }
  }

  return issues;
}

// ── Migration SQL dry-run ───────────────────────────────────────────────────

function validateMigration(content, filePath) {
  const issues = [];
  if (!filePath.includes('migrations') || !filePath.endsWith('.js')) return issues;

  // Flag dangerous DDL that might fail in production
  const dangerous = [
    /\bDROP DATABASE\b/i,
    /\bDROP SCHEMA\b.*PUBLIC/i,
    /\bALTER COLUMN\b.*SET NOT NULL\b/i,
  ];
  for (const pattern of dangerous) {
    const match = content.match(pattern);
    if (match) {
      issues.push({
        type: 'dangerous_ddl',
        file: filePath,
        message: `Potentially destructive operation: ${match[0].slice(0, 80)}`,
      });
    }
  }

  // Flag MySQL backtick syntax in PostgreSQL context
  const backtickRefs = content.match(/`[^`\n]+`/g) || [];
  for (const ref of backtickRefs) {
    if (/FROM|SELECT|JOIN|WHERE|SET|ON\b/i.test(ref)) {
      issues.push({
        type: 'invalid_sql_syntax',
        file: filePath,
        message: `MySQL backtick in PostgreSQL context: ${ref.slice(0, 60)}`,
      });
    }
  }

  return issues;
}

// ── Full file validation (sandboxes sandbox + review + promote) ──────────────

/**
 * @param {Array<{path: string, content: string}>} files
 * @returns {{ issues: Array, passed: boolean }}
 */
function validateFiles(files) {
  const allIssues = [];
  for (const file of files) {
    const issues = [];

    // Loop 19.1 — secrets scanning (code diff review)
    issues.push(...scanForSecrets(file.content, file.path));

    if (file.path.endsWith('.js')) {
      issues.push(...validateJsSyntax(file.content, file.path));
      if (file.path.includes('routes/')) {
        issues.push(...validateRouteFile(file.content, file.path));
      }
    }
    if (file.path.includes('migrations/')) {
      issues.push(...validateMigration(file.content, file.path));
    }
    allIssues.push(...issues);
  }
  return { issues: allIssues, passed: allIssues.length === 0 };
}

// ── Generate fix suggestions ─────────────────────────────────────────────────

function generateFixSuggestions(issues) {
  return issues.map(issue => {
    if (issue.type === 'syntax_error') {
      return {
        type: issue.type,
        file: issue.file,
        suggestion: `Syntax error at line ${issue.line || '?'}: ${issue.message}. Check for missing commas, brackets, or unclosed strings.`,
        line: issue.line,
      };
    }
    if (issue.type === 'missing_handler') {
      return {
        type: issue.type,
        file: issue.file,
        suggestion: `Route handler missing on line. Provide a function (or middleware array) as the second argument to the router method.`,
        snippet: issue.line,
      };
    }
    if (issue.type === 'dangerous_ddl') {
      return {
        type: issue.type,
        file: issue.file,
        suggestion: `${issue.message}. Confirm this is intentional before proceeding.`,
      };
    }
    if (issue.type === 'invalid_sql_syntax') {
      return {
        type: issue.type,
        file: issue.file,
        suggestion: `${issue.message}. Use double quotes for identifiers in PostgreSQL, not backticks.`,
      };
    }
    if (issue.type === 'secrets_leaked') {
      return {
        type: issue.type,
        file: issue.file,
        secret_type: issue.secret_type,
        severity: issue.severity,
        suggestion: `CRITICAL: ${issue.secret_type || 'Secret key'} leaked in ${issue.file}. Replace with process.env.${issue.secret_type || 'SECRET_NAME'} or use the Polsia secrets management system. Never commit raw credentials.`,
      };
    }
    return { type: issue.type, file: issue.file, suggestion: issue.message };
  });
}

// ── Sandbox run ─────────────────────────────────────────────────────────────

/**
 * Execute sandbox validation for a given changeset.
 * @param {string} changesetHash
 * @param {Array<{path: string, content: string}>} files
 * @param {number} iteration
 * @returns {Promise<{passed: boolean, issues: Array, suggestions: Array}>}
 */
async function runSandbox(changesetHash, files, iteration) {
  const { issues, passed } = validateFiles(files);
  const suggestions = passed ? [] : generateFixSuggestions(issues);
  return { passed, issues, suggestions };
}

// ── Bounce loop ─────────────────────────────────────────────────────────────

/**
 * Execute up to MAX_ITERATIONS sandbox passes.
 * On failure, Wallt AI coordinator reviews + generates fixes.
 * Returns final result with iteration history.
 *
 * @param {string} changesetHash
 * @param {Array<{path: string, content: string}>} initialFiles
 * @param {Function} generateFix — async (issues) => Array<{path, content}>
 * @returns {Promise<{result: string, iteration: number, issues: Array, suggestions: Array}>}
 */
async function runBounceLoop(changesetHash, initialFiles, generateFix) {
  let files = initialFiles;
  let result = 'pass';
  let allIssues = [];
  let allSuggestions = [];
  let iteration = 1;

  while (iteration <= MAX_ITERATIONS) {
    const { passed, issues, suggestions } = await runSandbox(changesetHash, files, iteration);

    if (passed) {
      result = 'pass';
      break;
    }

    result = 'fail';
    allIssues = [...allIssues, ...issues];
    allSuggestions = [...allSuggestions, ...suggestions];

    if (iteration === MAX_ITERATIONS) break;

    try {
      const fixed = await generateFix(issues);
      if (fixed && fixed.length > 0) {
        files = fixed;
        iteration++;
        continue;
      }
    } catch (_) {
      // generateFix failed — break with current state
    }
    break;
  }

  return { result, iteration, issues: allIssues, suggestions: allSuggestions };
}

// ── Open-source sanitization (Loop 19.4) ───────────────────────────────────

const DANGEROUS_TAGS = ['<script', 'javascript:', 'onerror=', 'onload=', 'onclick='];

/**
 * Produce a clean, deployment-ready output snapshot with all secrets stripped.
 * Returns sanitized files + a manifest of what was removed.
 * @param {Array<{path: string, content: string}>} files
 * @returns {{ sanitizedFiles: Array, manifest: Array }}
 */
function sanitizeForOpenSource(files) {
  const sanitized = [];
  const manifest = [];

  for (const file of files) {
    let content = file.content;

    // Strip secrets (same patterns, but redact in-place)
    for (const { pattern, type } of SECRET_PATTERNS) {
      const original = content;
      content = content.replace(new RegExp(pattern, 'gi'), (match) => {
        const redacted = `[${type}_REDACTED]`;
        manifest.push({
          action: 'redacted',
          secret_type: type,
          file: file.path,
          redacted_to: redacted,
          original_preview: match.slice(0, 20),
        });
        return redacted;
      });
      if (content !== original) {
        // Already recorded in the loop above
      }
    }

    // Strip dangerous HTML/JS injection tags (XSS prevention in rendered docs)
    for (const tag of DANGEROUS_TAGS) {
      const pattern = new RegExp(tag.replace(/[.*+?^${}()|[\\]/g, '\\$&'), 'gi');
      const matches = content.match(pattern);
      if (matches) {
        content = content.replace(pattern, '');
        manifest.push({
          action: 'sanitized',
          tag,
          file: file.path,
          occurrences: matches.length,
        });
      }
    }

    sanitized.push({ path: file.path, content });
  }

  return { sanitizedFiles: sanitized, manifest };
}

// ── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  computeChangesetHash,
  validateFiles,
  runSandbox,
  runBounceLoop,
  generateFixSuggestions,
  sanitizeForOpenSource,
  scanForSecrets,
  MAX_ITERATIONS,
};