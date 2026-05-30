# Deploy Gate

Every push to production runs two automated gates before deployment proceeds. A failure in either gate aborts the build with a non-zero exit code, which blocks the Render deploy.

---

## Gate 1: Syntax Check (`npm run build:syntax`)

**Script:** `scripts/syntax-check.js`

Runs `node --check` on every `.js` file under:

- `server.js`
- `migrate.js`
- `public/js/`
- `routes/`
- `db/`
- `migrations/`
- `services/`
- `scripts/`

Any parse error (e.g. unclosed brace, unexpected token, syntax cascade from an incomplete function) causes a non-zero exit. The build stops immediately before the HTTP smoke test runs.

**What this catches:** The class of bugs introduced by `mep-panel.js:297` — a syntax cascade that shipped to production and caused the entire JS bundle to fail at parse time. This gate makes that class of error impossible to ship.

---

## Gate 2: HTTP Smoke Test (`npm run build:smoke`)

**Script:** `scripts/smoke-test.js`

Starts the Express server on a random port (9000–9999), waits for it to bind, then issues HTTP GET requests to each of the following routes:

| Route | Expected Status | Expected Content-Type | Body Check |
|---|---|---|---|
| `/health` | 200 | `application/json` | contains `"healthy"` |
| `/` | 200 | `text/html` | contains `<!DOCTYPE html>` |
| `/app` | 200 | `text/html` | contains `<!DOCTYPE html>` |
| `/subscribe/acknowledge` | 200 or 404 | `text/html` | — |
| `/js/app.js` | 200 | `application/javascript` | — |
| `/js/mep-panel.js` | 200 | `application/javascript` | — |

Any unexpected status code, missing content-type, or absent body marker = gate failure.

**What this catches:**
- A route accidentally removed or broken during refactoring
- A static file missing from the build artifact
- A server startup crash that leaves Express not responding
- Wrong content-type on a JS file (e.g. served as HTML due to a misconfigured static middleware)

**Requires `DATABASE_URL`.** The server needs the database connection to start. On Render CI, `DATABASE_URL` is always injected from the service environment. If `DATABASE_URL` is not set locally, the smoke test exits 0 with a skip message — syntax check still runs.

---

## Full Pipeline

The `build` script in `package.json` runs:

```
npm run migrate && npm run build:verify
```

`build:verify` runs gate 1 then gate 2 in sequence. Gate 1 failure short-circuits; gate 2 never runs.

**Render build command** (set in the Render service settings):

```
npm install && npm run build
```

---

## Running Locally

```bash
# Full gate (requires DATABASE_URL)
npm run build:verify

# Syntax only (no DB needed)
npm run build:syntax

# Smoke only (requires DATABASE_URL)
npm run build:smoke
```

---

## Debugging Gate Failures

### Gate 1 failure: syntax error

The script prints the file path and the Node.js parse error message, e.g.:

```
SYNTAX ERROR: public/js/mep-panel.js
/path/to/mep-panel.js:297
  }
  ^
SyntaxError: Unexpected token '}'
```

Fix: open the file at the reported line and fix the syntax. Then re-run `npm run build:syntax` to confirm clean.

### Gate 2 failure: HTTP smoke test

The script prints each failing check, e.g.:

```
FAIL /js/app.js: expected status 200, got 404
```

Common causes:
- File was deleted or moved from `public/js/`
- Route handler was removed from `server.js`
- Server crashed on startup (check terminal output above the FAIL lines)
- Content-type misconfiguration in static file middleware

Fix: address the root cause, then re-run `npm run build:smoke`.

### Gate 2 failure: server did not start

```
Error: Server did not start within 15000ms
```

Causes:
- `DATABASE_URL` is set but the database is unreachable
- A fatal startup error (check stderr above the timeout line)
- Port conflict (rare; the script picks a random port 9000–9999)

---

## What the Gate Does NOT Cover

- JavaScript runtime errors that only surface at call time (these need unit tests)
- Database query correctness
- Authentication flows
- WebSocket behavior
- Frontend visual regressions (these need E2E tests)

The gate is a **minimum bar**: catches broken builds before they ship. It is not a substitute for a test suite.
