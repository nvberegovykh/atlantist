# Atlantist BIM 2.0 — Open Source

Browser-based Building Information Modeling platform. Engineers place walls, columns, levels, doors, and windows on a 3D model; changing any parameter instantly propagates through a DAG constraint solver to update geometry across three synchronized views. Includes issue tracking, energy simulation, MEP analysis, structural FEA, and an AI companion (Wallt).

> **Project Status:** Active development. The hosted version at [atlantist.polsia.app](https://atlantist.polsia.app) includes integrations not yet in this open-source release. PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Stack

Node.js + Express + PostgreSQL (Neon) + Three.js + WebSocket

## Quick Start

```bash
git clone https://github.com/atlantist-bim/atlantist.git
cd atlantist
npm install

# Set up your database (any PostgreSQL 14+)
cp .env.example .env
# Edit .env — set DATABASE_URL

npm run migrate   # Create all tables
npm start         # Start on port 3000
```

Or with Docker:

```bash
docker run -d --name atlantist-db -e POSTGRES_PASSWORD=localdev postgres:16-alpine
# Set DATABASE_URL=REDACTED/postgres in .env
npm run migrate && npm start
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (any PG 14+ DB) |
| `PORT` | No | Server port (default: 3000) |
| `ADMIN_EMAIL` | No | Promotes that address to admin on first boot |
| `STRIPE_SECRET_KEY` | No | Stripe key for payment features |
| `ANTHROPIC_API_KEY` | No | Anthropic key for Wallt AI voice |

See `.env.example` for the full list.

## Features

- **Parametric BIM** — Walls, columns, doors, windows, floors, ceilings, stairs with live DAG constraint propagation
- **3D Viewport** — Three.js renderer with plan/elevation/3D synchronized views
- **Issue Tracking** — Pin issues to elements with camera snapshots and comment threads
- **Energy Simulation** — EN-001 through EN-008 compliance, gbXML export, IDF generation
- **MEP Analysis** — HVAC, plumbing, electrical simulation runners
- **Structural FEA** — ASCE/AISC/ACI/NDS code checks, linear static analysis, OpenSees export
- **Wallt AI Companion** — Context-aware BIM assistant with legal compliance, moral drift monitoring, and audio escalation
- **Crafting Engine** — Universal crafting thing/recipe/workbench system
- **DXF + IFC** — Import from Revit (.rvt) and IFC2x3/IFC4, export to DXF R14/2000

## Key Directories

| Directory | Purpose |
|---|---|
| `server.js` | Express entry point, route mounts, WebSocket wiring |
| `routes/` | One Express Router per resource |
| `db/` | Named query functions — no inline SQL in routes |
| `services/` | Business logic: DAG solver, WS server, structural engine, energy sim, Wallt |
| `migrations/` | All schema changes (timestamped JS/SQL) |
| `public/` | Static frontend (Three.js BIM app, admin pages) |
| `jobs/` | Standalone scripts: abuse scan, forum agent, cost aggregator |
| `docs/` | User-facing documentation site |

## Database

Schema is built entirely through `migrations/`. Run `npm run migrate` to create all tables.

## License

Apache License 2.0 — see [LICENSE](./LICENSE). Third-party licenses are listed in their respective source headers.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors must agree to the DCO (sign-off on commits).