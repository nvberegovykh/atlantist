#!/usr/bin/env node
const fs = require('fs');
let content = fs.readFileSync('CLAUDE.md', 'utf8');

// 1. Update directory map to add wallt-landing.js
content = content.replace(
  'sourcing.js` (Recipe Graph Solver + Sourcing Engine: retail/secondary/fabrication search, thing sourcing, modification recipes, assembly optimization)',
  'sourcing.js` (Recipe Graph Solver + Sourcing Engine), `wallt-landing.js` (`/wallt` public landing page)'
);

// 2. Drop oldest recent changes entry and prepend Wallt entry
content = content.replace(
  '- 2026-05-26 Remove pricing calculator from landing — Replaced interactive cost estimator (5 sliders + live $X output) with clean "Smart pricing that adjusts automatically" card. Three bullet points, formula link to `/pricing`. Removed all calculator CSS/JS. Updated FAQ. SW cache v27.\n',
  ''
);

content = content.replace(
  '- 2026-05-26 Phase 33C:',
  '- 2026-05-27 Phase 34A: Wallt AI Companion — Phase 34A scaffold deployed. `wallt_conversations`, `wallt_messages`, `wallt_context_snapshots` tables. `db/wallt.js` (CRUD). `routes/wallt.js` (`/api/wallt/*`: conversations, messages, context). Floating chat widget (bottom-right, dark cinematic, expand/collapse, conversation chips, markdown rendering, typing indicator). `/wallt` public landing page with demo chat. Widget injected into `app.html`. No AI calls yet — Phase 34B hooks in here.\n- 2026-05-26 Phase 33C:'
);

fs.writeFileSync('CLAUDE.md', content);
console.log('Done. Lines:', content.split('\n').length);