# Contributing to Atlantist BIM 2.0

Thank you for your interest in contributing. This document covers development setup, architectural rules, and contribution process.

## Development Setup

```bash
git clone https://github.com/atlantist-bim/atlantist.git
cd atlantist
npm install
cp .env.example .env    # Edit: set DATABASE_URL to a local PG instance
npm run migrate          # Create all tables
npm start                # Start server on :3000
npm run test             # Run unit + integration tests
```

For interactive smoke tests:

```bash
npm run test:e2e         # Requires Playwright (npx playwright install)
```

## Architecture Rules (Enforced by CI)

These are not stylistic preferences — they are the contract that allows autonomous agents to work reliably in this codebase. PRs violating them will not be merged.

| Rule | Max | Reason |
|---|---|---|
| `server.js` / `index.js` line count | 300 | Prevents god-files; forces route extraction |
| Database access | `db/*.js` only | Prevents query sprawl; enables caching |
| DDL (CREATE/ALTER/DROP) | `migrations/` only | Keeps schema changes auditable |
| In-process schedulers | Guarded by `POLSIA_IN_PROCESS_CRONS_ENABLED` + `polsia.toml` | Portable to new infra |
| Tests for new routes | Required | PRs without tests for new endpoints may be closed |

**Enforced by:** `npm run guard` (CI gate on every PR).

## Pull Request Process

1. **Fork** the repo and create a branch: `feat/my-feature` or `fix/bug-description`
2. **Sign your commits**: `git commit -s -m "fix: resolve X"` (DCO requirement)
3. **Run the guard**: `npm run guard` locally — must pass before pushing
4. **Open a PR**: describe what changed, why, and how to test
5. **CI must pass**: secret scan → syntax check → architecture rules → smoke test
6. **On merge to main**: CI automatically sanitizes and pushes a clean snapshot to the public repo at `github.com/atlantist-bim/atlantist`. No manual steps required.

### CI Gates (enforced on every push and PR)

| Gate | What it checks | Fails on |
|---|---|---|
| `secret-scan` | No API keys, PII, or internal references in committed code | Any secret or Polsia-internal reference |
| `lint` | ESLint + architecture rules | `server.js > 300 lines`, raw SQL outside `db/`, DDL in runtime |
| `smoke-test` | `/health`, static assets, JS serving | Server fails to start or any health check returns non-200 |
| `publish-open-source` | Runs after all above pass | Only if `PUBLISH_REPO_TOKEN` secret is missing or sanitization fails |

### Secrets Required for CI

CI requires one secret to auto-publish to the public repo:
- **`PUBLISH_REPO_TOKEN`** — Fine-grained GitHub PAT scoped to `atlantist-bim/atlantist` with `contents:write` permission. Set in: repo Settings → Secrets → Actions → `PUBLISH_REPO_TOKEN`. Without it, the publish step exits with a clear error; CI itself still passes.

Branch conventions:
- `main` — stable, always deployable
- `feat/` — feature work
- `fix/` — bug fixes
- `docs/` — documentation only

## Scope of Contributions Accepted

### Welcome
- New route handlers for missing endpoints
- Bug fixes with regression tests
- Performance improvements with benchmarks
- Test coverage improvements
- Documentation corrections and additions
- New migration files for schema changes

### Not Accepted
- New in-process schedulers without discussion (open an issue first)
- Changes to the architecture rules without RFC
- Features that require proprietary or paid external services (use optional env vars)
- Breaking changes to the public API without a deprecation cycle

## Reporting Security Issues

Do **not** open a public GitHub issue for security vulnerabilities. Email `security@atlantist.io` with details. We aim to respond within 48 hours and publish a fix within 7 days for critical issues.

## Code of Conduct

Be constructive and respectful. We don't tolerate harassment. Violations result in bans without appeal.

## License

By contributing, you agree your work will be licensed under the Apache License 2.0 (see [LICENSE](./LICENSE)).
## Contributor Program — Points & Profit Shares

Atlantist is a community-owned BIM platform. Contributors earn points that convert to profit shares.

### Point system
- Merged PR: 50 points
- Closed issue (with fix): 20 points
- Commit to main: 10 points/commit
- Exceptional contributions: manual bonus (at maintainer discretion)

### How to join the contributor program
1. Register at https://atlantist.cloud/contribute to connect your GitHub account
2. Complete identity verification
3. Sign the Contributor Agreement
4. Set up Stripe for payouts

Points are automatically scored after each merge. View your balance and rank on the [contributor leaderboard](https://atlantist.cloud/contribute).

## Questions
Open an issue or email support@atlantist.cloud

## Information Security and Confidentiality

By contributing to this repository, you agree to:

- **Not disclose** repository contents, architecture, implementation details, or roadmap to unauthorized parties
- **Not share** code, queries, or discussions from this repository through any AI assistant, public forum, or external service without explicit approval from the repository owner
- **Conduct all development discussions** exclusively through:
  - GitHub Issues and Pull Requests within this repository
  - Direct private channels designated by @nvberegovykh
- **Report any suspected data leak** immediately to security@atlantist.cloud

Access to this repository does not grant permission to discuss its contents publicly. Violation of this policy may result in removal of repository access and, where applicable, legal remedies under the Contributor Agreement.

## Security setup (required for contributors)
Install the pre-commit secret scanner:
```
cp scripts/pre-commit-check.js .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```
This prevents accidentally committing API keys, SSNs, or other sensitive data.
