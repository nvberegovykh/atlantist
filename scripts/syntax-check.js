#!/usr/bin/env node
// scripts/syntax-check.js
// Owns: syntax validation of every JS file under public/js, routes/, db/, migrations/, server.js
// Does NOT own: runtime correctness, integration testing (see smoke-test.js)

'use strict';

const { execFileSync } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');

const TARGETS = [
  'server.js',
  'migrate.js',
  'public/js',
  'routes',
  'db',
  'migrations',
  'services',
  'scripts',
  'jobs',
  'lib',
];

let failed = 0;
let checked = 0;

function getJsFiles(target) {
  try {
    // Use find to list all .js files under target
    const out = execSync(
      `find ${target} -name '*.js' -not -path '*/node_modules/*' 2>/dev/null || true`,
      { encoding: 'utf8' }
    ).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function checkFile(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked++;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : String(err);
    console.error(`SYNTAX ERROR: ${file}`);
    console.error(stderr.trim());
    failed++;
    checked++;
  }
}

// If a single-file target exists directly, check it
for (const target of TARGETS) {
  if (target.endsWith('.js')) {
    const fs = require('fs');
    if (fs.existsSync(target)) {
      checkFile(target);
    }
  } else {
    const fs = require('fs');
    if (fs.existsSync(target)) {
      const files = getJsFiles(target);
      for (const f of files) {
        // Skip this script itself to avoid infinite loop concerns
        if (path.resolve(f) === path.resolve(__filename)) continue;
        checkFile(f);
      }
    }
  }
}

console.log(`\nSyntax check: ${checked} files checked, ${failed} failed.`);

if (failed > 0) {
  console.error(`\nBUILD GATE FAILED: ${failed} file(s) have syntax errors. Fix before deploying.`);
  process.exit(1);
} else {
  console.log('BUILD GATE PASSED: All files are syntactically valid.');
  process.exit(0);
}
