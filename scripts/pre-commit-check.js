#!/usr/bin/env node
/**
 * Pre-commit secret scanner. Run via: node scripts/pre-commit-check.js
 * Install as git hook: cp scripts/pre-commit-check.js .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
 */
const { execSync } = require('child_process');
const patterns = [
  { re: /sk_live_[A-Za-z0-9]{24,}/, label: 'Stripe live secret key' },
  { re: /rnd_[A-Za-z0-9]{30,}/, label: 'Render API key' },
  { re: /ghp_[A-Za-z0-9]{36}/, label: 'GitHub PAT' },
  { re: /ENCRYPTION_KEY\s*=\s*[a-fA-F0-9]{64}/, label: 'Hardcoded encryption key' },
  { re: /[0-9]{3}-[0-9]{2}-[0-9]{4}/, label: 'SSN pattern' },
  { re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, label: 'Private key' },
  { re: /acct_[A-Za-z0-9]{16}/, label: 'Stripe account ID (may be private)' },
];

const staged = execSync('git diff --cached --name-only').toString().trim().split('\n').filter(Boolean);
let found = [];
for (const file of staged) {
  if (file.startsWith('node_modules') || !file.match(/\.(js|ts|json|yaml|yml|env|html)$/)) continue;
  try {
    const content = execSync(`git show :${file}`).toString();
    for (const { re, label } of patterns) {
      if (re.test(content)) found.push(`${file}: ${label}`);
    }
  } catch {}
}
if (found.length) {
  console.error('\n🚫 SECRET SCAN FAILED — potential secrets detected:\n');
  found.forEach(f => console.error('  ❌', f));
  console.error('\nRemove secrets before committing. Use env vars instead.\n');
  process.exit(1);
}
console.log('✅ Secret scan passed.');
