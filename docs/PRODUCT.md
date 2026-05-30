# Atlantist — Product

## ICP

Small AEC teams of **2–15 people** in early schematic design. Architects and structural engineers collaborating on a building model for the first time — before BIM software is fully justified, before a project manager signs off on a $5,000/year seat.

The wedge: a BIM tool that pays for itself in the first project.

## What We Build

A browser-based BIM platform where changing a wall's height instantly updates all three views via a DAG constraint solver. Door placement auto-cuts wall geometry. Issue pins live on the 3D model. A-400 schedules auto-populate from placed families. Energy simulation runs against the same model. MEP routes draft in context. Wallt, an AI companion, answers site-specific code questions and helps coordinate with the engineering team.

## Explicitly Out of Scope

- **Revit plugin** — Atlantist is a standalone web app, not an add-in.
- **Full BIM execution plan (BEP)** — document management and project setup workflows.
- **Multi-floor coordination** — level management exists; federated multi-story coordination does not.
- **Real-time multiplayer sync** — live sessions exist; Google Docs-style simultaneous editing does not.
- **Mobile** — web apps only; iOS/Android native apps are not planned.
- **On-premise deployment** — cloud-only, Neon Postgres on Render.
- **Python ML** — forecasting uses JavaScript statistical methods (moving averages, linear regression); no PyTorch, TensorFlow, or standalone Python services.