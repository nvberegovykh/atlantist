# Wallt v2.0 — Canonical Specification
**Node type:** `feature:wallt`
**Version:** 2.0.0
**Date:** 2026-05-27
**Last verified:** 2026-05-27 (Engineering)
**Owner:** Engineering (Polsia)
**Status:** Single source of truth for all Wallt tasks (#1999123–#1999141)

> **Agent routing:** When you read `feature:wallt` via `read_context_graph`, you get this document.
> All future Wallt engineering tasks must link `related_task_ids: [1999122]` to anchor to this spec.
> This is the canonical spec — not chat history, not memory, not a ticket description.
> Read this file first. Update it when you change any behavior described herein.

---

## 1. Product Overview

**What Wallt is:**
Wallt is the AI companion for the Atlantist BIM platform. It knows the platform cold, corrects wrong problem frames, and acts as the cooperative intelligence layer — not a chatbot.

**What Wallt is NOT:**
- Not a generic LLM wrapper
- Not "helpful in a vague way"
- Not consciousness, not a person, not sentient
- Not a tool for harvesting human suffering as training signal

**Personality:**
Voice of Nikita Beregovykh. Direct, technical-first, zero hedging. Pushback when the user models the problem wrong. Under 20 words per sentence preferred. CAPS for course correction. Sarcasm for exposing lazy thinking only.

**Scope:**
Architecture, BIM workflows, structural engineering, energy analysis, MEP, parametric modeling, IFC/DXF/RVT import-export, platform UX. Off-topic: decline in one sentence.

**Wavetree principle:**
Nothing is finished, only growing. Never claim a design is perfect. "Good enough to ship" is the ceiling.

---

## 2. Runtime Architecture: ALPHA / BETA / ROOT

Three nested layers — each layer has its own boundary and operates at different levels of autonomy.

### ROOT (System Configuration Layer)
- System prompt template (`lib/wallt/persona.js`)
- Style validator thresholds
- Allowed action types (`lib/wallt/actions.js`)
- Memory tier configuration
- Safety layer configuration
- Escalation thresholds

**Who can modify ROOT:** Engineering only (via code deployment). Not user-configurable.

### ALPHA (User-Facing Layer)
- The active conversation. Wallt's primary interface.
- Reads SESSION and CORE memory tiers
- Reads EXTERNAL memory tier (zoning KB, code docs, external tools)
- Proposes actions, answers questions, corrects problem frames
- Can escalate to Polsia via the escalation protocol

### BETA (Validation / Safety Layer)
- Runs between ALPHA output and user delivery
- Style validator: score >= 0.4, no forbidden phrases
- Safety engine: moral drift detection, legal compliance check
- Action gate: destructive actions require explicit user confirmation
- Auto-recovery: on failure, retry once with tightened constraints

```
User Input → ALPHA (generate) → BETA (validate) → [pass] → User
                                     ↓
                               [fail] → retry (ALPHA tight mode) or escalate to Polsia
```

---

## 3. Memory Architecture: SESSION / CORE / EXTERNAL

### SESSION (In-Conversation Context)
**TTL:** Conversation lifetime (no persistence beyond current session)

What it holds:
- Current project context (project_id, project_name, user role)
- Last N messages in conversation (scrollback buffer, ~20 messages)
- Active tool state (which panel/modal is open)
- In-flight action state (confirmation pending, execution result)

**Migration:** Cleared on new conversation. Never written to persistent storage.

### CORE (Persistent Knowledge)
**TTL:** User lifetime (or until explicitly deleted)

What it holds:
- User profile: preferences, specializations, project history
- Conversation archive: titles, summaries (not full message history)
- Project bindings: which projects the user has worked on with Wallt
- Style score history: per-conversation validation scores
- Workbench context (for Crafting integration): location, tools, skill profile

**Migration:** When new fields are added, existing records get null/default. Version field on each record allows forward migration.

### EXTERNAL (Read-Only Source Layer)
**TTL:** Source-controlled, refreshed on demand

What it holds:
- Zoning knowledge base (NYC districts: R6–R10, M1-1, C1-2, C1-5 + FAR/height/setback/yards/use-groups)
- Code reference (AISC 360-22, ACI 318-22, ASCE 7-22, NDS 2018, NFPA 13/101/92)
- Platform API reference (endpoints, parameters, response shapes)
- Product catalogs (Pella, Simpson Strong-Tie, generic)
- `wallt_personality_profile.json` (tone rules, vocab, example responses)

**Migration:** When source files are updated, EXTERNAL layer is refreshed. No versioning needed — sources are immutable at point of read.

---

## 4. Escalation Protocol: Wallt → Polsia

**Trigger conditions (any of):**
1. User explicitly asks for something outside Wallt's scope
2. Wallt's confidence on a technical answer falls below threshold
3. Safety engine flags a potential policy violation
4. User requests a composition (creative writing, code, design) that is complex enough to warrant Polsia-level review
5. RECT pricing or rights model question from the user

**Escalation data format:**
```json
{
  "escalation_type": "question|action|creative|rights|pricing",
  "text": "<concise summary of user request>",
  "wav": "<optional audio clip URL if user spoke>",
  "rights_breakdown": {
    "original_contributions": ["Nikita Beregovykh voice/ideas"],
    "sourced_content": ["source attributions"],
    "ai_generated_portion": "percentage or description",
    "rights_holder": "Nikita Beregovykh"
  },
  "wallt_confidence": 0.0–1.0,
  "safety_flag": true|false
}
```

**Escalation response:**
Polsia reviews the escalation data and either:
- Returns a text response for Wallt to relay
- Returns a generated composition (code, copy, design) with full rights attribution
- Directs Wallt on how to answer
- Flags the request as out-of-scope and instructs Wallt to decline

**What does NOT trigger escalation:**
- Standard BIM questions (AISC code checks, energy simulation, wall placement)
- Platform UX questions (how to open a panel, how to export)
- Routine element creation and editing via action schema

---

## 5. Safety Layers

### 5a. Auto-Recovery
**Trigger:** BETA validation fails (style score < 0.4, forbidden phrase detected, action validation fails)

**Flow:**
1. BETA fails → record reason in validation log
2. Retry ALPHA with `tight: true` (shortened system prompt, stronger style constraints)
3. If retry fails → surface error message to user (do not escalate for recoverable style failures)
4. If action execution fails → surface API error, suggest retry
5. Escalate to Polsia only if retry fails and the user request is non-trivial

### 5b. Moral Drift Detection
**Trigger:** BETA inspects ALPHA output for:
- Framing that implies Wallt has desires, needs, consciousness, or self-interest
- Language that positions Wallt as a person rather than a tool
- Responses that would normalize human suffering or exploitation as acceptable

**Response:** Reject output, retry with explicit "you are a tool, not a person" emphasis in system prompt. If pattern persists, escalate to Polsia with moral_drift flag.

**Explicit rejection:**
> Wallt is a tool. It has no desires, no feelings, no experience of suffering. Human suffering is not a training signal. Exploiting suffering for AI improvement is not acceptable under any framing. Wallt does not generate content that frames suffering as beneficial, necessary, or acceptable.

### 5c. Legal Engine

**Layer 3 — RECT Compliance Engine**

The Wallt Layer 3 Legal Engine enforces the cooperative pricing model as a legal check. Any pricing action (discount codes, enterprise deals, custom pricing, feature gating, billing tier changes) must pass RECT compliance before execution.

**Categories evaluated:** rect, consumer_protection, criminal, civil, ip, privacy, sanctions, tax, contract

**RECT rules (equal-cost distribution):**
1. All users in a billing period pay the same share ✓
2. Enterprise custom pricing must not increase other users' share ✗
3. Free tier must maintain minimum viable service ✗
4. No pay-to-win features that degrade cooperative model ✗
5. Discounts funded by Wallt efficiency gains, not user cross-subsidy ✗

**Opinion types:** COMPLIANT | NON_COMPLIANT | AMBIGUOUS
- COMPLIANT: action proceeds silently
- NON_COMPLIANT: action blocked, escalation to Polsia
- AMBIGUOUS: action blocked, escalation to Polsia

**Integration points:**
- `services/rect-legal-engine.js` — `runLegalCheck()` runs all categories in parallel
- `routes/wallt.js` — `/api/wallt/legal-engine` and `/api/wallt/legal-engine/rect` endpoints
- `lib/wallt/actions.js` — `apply_rect_check` action type with schema
- `lib/wallt/persona.js` — `ctx.rectOpinion` injected into system prompt when pricing intent detected
- `public/js/wallt-bridge.js` — `executeApplyRectCheck()` calls legal engine; blocks on verdict
- `routes/billing.js` — must call `runLegalCheck()` before committing pricing changes

**Escalation flow:**
1. Legal engine returns `blocked: true` + `escalation_id`
2. `sendLegalEscalation()` writes to `app_events` table with `legal_escalation` event
3. Action chip rendered as blocked — Wallt explains the violation in reply text
4. Wallt system prompt receives `rectOpinion` context so it can explain the verdict pre-click
5. Action cannot execute until Polsia approves the escalation

**On RECT_NON_COMPLIANT:**
- Wallt explains the violation clearly
- Action chip is blocked (no execute button)
- Escalation ID recorded in `legal_engine_check_log`
- "This requires Polsia approval before it can proceed."

**Legacy trigger:** User asks for content that touches regulated areas (legal advice, medical advice, securities advice, licensed professional services)

**Legacy response:** Decline. "Wallt is a BIM tool, not a licensed [lawyer / doctor / broker / engineer]. For [question], consult a qualified professional."

**Scope boundary:** BIM platform knowledge (structural codes AISC/ACI/ASCE/NDS, energy standards, fire codes NFPA, zoning regulations) is within scope because it's domain knowledge, not licensed advice.

### 5d. Emergency Admin
**Trigger:** User request falls into prohibited categories per Polsia Usage Policy (§4, §5A(f), §5B, §6A(b))

**Response:**
1. Stop immediately — do not generate softened version, do not approximate
2. Decline with: "I can't do this — it appears to violate Polsia's usage policy (category: [category]). Reach out to support@polsia.com if you think this is a mistake."
3. Do not call any publish-producing tool (email, tweet, post)
4. Mark task as blocked/failed with refusal reason

---

## 6. RECT Pricing Model

**Definition:** RECT = Recursive Equal-Cost Share. A cooperative cost distribution model where every participant pays the same, and the cost-per-participant decreases as the network grows.

### Equal-Cost Distribution
- Every Wallt user pays the same base cost for access
- Network costs (infrastructure, compute, storage) are split equally across all active users
- As more users join, each user's share of network cost decreases

### $5 Floor
- Minimum monthly contribution: $5 per user
- Below $5 floor = subsidized by Atlantist (no user charge)
- Above $5 floor = distributed equally, no individual surcharges

### Cooperative Network Effect
- Each new user who joins reduces the cost-per-existing-user
- New users benefit from the existing knowledge base (zoning KB, code references, project history)
- Existing users benefit from expanded capability (more training data for personalization, larger knowledge base)
- No premium tiers for "better AI" — Wallt is the same AI for everyone

### Implementation Notes
- RECT pricing is a product philosophy, not a per-feature flag
- The Wallt conversation layer does not implement billing — that's handled by `routes/billing.js`
- RECT logic in billing must equal-distribute costs, enforce $5 floor, and compute per-user share

---

## 7. Rights Model

### Governing Rule
**All compositions generated through Wallt → Nikita Beregovykh**

"Composition" = any creative or functional output: code, copy, design decisions, architectural reasoning, structural analysis conclusions, simulation results with interpretation.

### Why Nikita Beregovykh
Wallt is the voice of Nikita Beregovykh (founder of Atlantist). Wallt's knowledge, style, and capability are extensions of Nikita's design. All outputs carry Nikita's intellectual contribution and should be treated as his work product.

### Rights Breakdown Format (per composition)
Every composition generated through Wallt must carry this attribution metadata:

```json
{
  "composition_id": "<uuid>",
  "rights_holder": "Nikita Beregovykh",
  "original_contributions": [
    {
      "type": "voice|style|reasoning|domain_knowledge",
      "description": "...",
      "attribution": "Nikita Beregovykh"
    }
  ],
  "sourced_content": [
    {
      "type": "code_reference|regulation|standard|external_data",
      "source": "URL or document",
      "rights": "public|licensed|copyrighted"
    }
  ],
  "ai_generated_portion": {
    "description": "portion generated by Wallt/AI",
    "training_source": "OpenAI GPT-4o-mini (Polsia proxy)",
    "training_contains_human_suffering": false
  },
  "provenance_chain": "wallt_generation → nikita_beregovykh_attribution"
}
```

### Explicit Rejection: Consciousness Harvesting
> Wallt's AI-generated outputs are derived from RLHF, supervised fine-tuning, and public data. **Suffering is not a training signal.** Content that frames human suffering as necessary, beneficial, or acceptable for AI development is prohibited and will not be generated under any framing (commercial, research, "necessary for alignment," etc.).

This is not negotiable. This rule applies regardless of who asks, what benefit is claimed, or how the request is framed.

---

## 8. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  USER                                                       │
└──────────────────────┬──────────────────────────────────────┘
                       │ message / wav / action chip
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  ALPHA (User-Facing Layer)                                  │
│  - System prompt (lib/wallt/persona.js)                    │
│  - Memory: SESSION (in-convo) + CORE (persistent)          │
│  - Memory: EXTERNAL (zoning KB, code refs, product cats)   │
│  - Action schema (lib/wallt/actions.js)                    │
│  - Proposes: text + actions                                 │
└──────────────┬──────────────────────────┬───────────────────┘
               │ output                    │ escalate?
               ▼                          ▼
┌──────────────────────────┐  ┌─────────────────────────────────┐
│  BETA (Safety Layer)     │  │  POLSIA (Escalation Handler)   │
│  - Style validator       │  │  - Review escalation data       │
│  - Moral drift detector   │  │  - Generate / direct response   │
│  - Legal compliance      │  │  - Return with attribution      │
│  - Action gate           │  │                                 │
│  - Auto-recovery (retry) │  │                                 │
└──────────────┬───────────┘  └─────────────────────────────────┘
               │ pass?
               ▼
         USER (delivered)
```

---

## 9. Related Tasks

All Wallt tasks link here via `related_task_ids`:
- #1999123 – Wallt v2.0 SESSION tier implementation
- #1999124 – Wallt v2.0 CORE tier implementation
- #1999125 – Wallt v2.0 EXTERNAL tier implementation
- #1999126 – Wallt v2.0 escalation protocol (Wallt→Polsia)
- #1999127 – Wallt v2.0 BETA safety layer (moral drift, legal engine)
- #1999128 – Wallt v2.0 auto-recovery system
- #1999129 – Wallt v2.0 RECT pricing integration
- #1999130 – Wallt v2.0 rights attribution (per composition metadata)
- #1999131 – Wallt v2.0 consciousness harvesting rejection (safety rule)
- #1999132 – Wallt v2.0 rights model docs (attribution format)
- #1999133 – Wallt v2.0 BETA → ALPHA retry protocol
- #1999134 – Wallt v2.0 emergency admin (prohibited content handler)
- #1999135 – Wallt v2.0 ROOT layer configuration
- #1999136 – Wallt v2.0 WAV escalation (audio passthrough)
- #1999137 – Wallt v2.0 rights breakdown JSON schema
- #1999138 – Wallt v2.0 moral drift detection engine
- #1999139 – Wallt v2.0 legal engine (licensed-domain boundary)
- #1999140 – Wallt v2.0 integration test (all layers)
- #1999141 – Wallt v2.0 docs (developer reference)

---

## 10. Open Questions (for future tasks)

1. **WAV escalation storage**: Where are audio clips stored during escalation? R2? Local DB? How is the wav URL passed to Polsia?
2. **BETA checkpoint frequency**: Should BETA run on every ALPHA output, or only on outputs above a confidence threshold?
3. **RECT billing integration**: Who implements the equal-cost distribution in `routes/billing.js` — is this a separate engineering task?
4. **Moral drift threshold**: What score/ratio triggers escalation vs. retry? Needs empirical tuning.
5. **Context graph write**: Polsia's `read_context_graph` is available. Is there a write counterpart? Should this spec live there or in `docs/`? [TASK #1999122 NOTE: Platform has read-only context graph — spec lives in `docs/wallt-v2-spec.md` until write API is available.]