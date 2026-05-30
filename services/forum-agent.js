/**
 * Forum AI Agent — auto-moderation + support responses.
 *
 * - Scans new content for prohibited material (keyword + OpenAI if key present)
 * - Auto-responds to new threads with triage + troubleshooting
 * - Bumps thread status on interaction
 * - Escalates to human support after 2 unresolved AI responses
 *
 * Runs on-demand via an HTTP endpoint (polled by a cron job or manually triggered).
 * Uses OpenAI-compatible API via process.env.OPENAI_API_KEY or Polsia AI proxy.
 */
const { createThread, updateThread, bumpAiResponseCount, logStatusChange, getUnansweredThreads, getEscalatedThreads, createReply, hideReply } = require('../db/forum');

// ─── Moderation patterns ──────────────────────────────────────────────────────
// JavaScript-based keyword scanning — no heavy deps.
// OpenAI is optional (if key present, use GPT for nuance).

const ILLEGAL_PATTERNS = [
  /\b(illicit|drugs?|illegal activity|how to make bomb|how to build weapon)\b/i,
  /\b(child exploit|csam|underage)\b/i,
];

const HATE_PATTERNS = [
  /\b(hate|slur|ethnic slur|racist|sexist|harassment|doxx|doxing)\b/i,
  /\b(threaten|threats? to|kill you|i'll hurt)\b/i,
];

const SPAM_PATTERNS = [
  /^[A-Z]{10,}$/i,
  /https?:\/\/[^\/]{40,}\/[^\/]{20,}/i,
  /\b(buy now|click here|free money|win prize|casino|viagra)\b/i,
  /\b(earn \u00a3|earn \u20ac|make money fast)\b/i,
  /\b(work from home|passive income scam)\b/i,
];

const NSFW_PATTERNS = [
  /\b(nsfw|xxx adult|erotic content|porn|sex tape)\b/i,
];

function moderateContent(text) {
  if (!text) return { safe: true };

  const checks = [
    { label: 'illegal',  patterns: ILLEGAL_PATTERNS },
    { label: 'hate',     patterns: HATE_PATTERNS },
    { label: 'spam',     patterns: SPAM_PATTERNS },
    { label: 'nsfw',     patterns: NSFW_PATTERNS },
  ];

  for (const { label, patterns } of checks) {
    for (const p of patterns) {
      if (p.test(text)) {
        return { safe: false, reason: label, pattern: p.source };
      }
    }
  }
  return { safe: true };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── OpenAI helper (optional) ─────────────────────────────────────────────────

async function aiModerate(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { safe: true };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Flag if this text contains: illegal content, hate speech, harassment, threats, spam, or NSFW material. Reply EXACTLY "SAFE" or "UNSAFE: <reason>". Text: "${text.substring(0, 500)}"`
        }]
      })
    });
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (content.startsWith('UNSAFE')) {
      return { safe: false, reason: content };
    }
    return { safe: true };
  } catch (e) {
    console.warn('[forum-agent] OpenAI moderation failed:', e.message);
    return { safe: true };
  }
}

// ─── AI response generator ─────────────────────────────────────────────────────

const AI_PROMPT_TEMPLATE = `You are Atlantist's community support AI. Atlantist is a browser-based BIM (Building Information Modeling) platform.
Your job is to respond to community forum posts helpfully, technically, and directly. Match Atlantist's brand voice.

Rules:
- Start with acknowledgment of the user's question/issue
- Provide clear troubleshooting steps (be specific to BIM context)
- Reference Atlantist docs at https://atlantist.cloud/docs when relevant
- If you don't know the answer, say so honestly
- Keep response to 2-4 paragraphs
- Never apologize excessively
- Be warm but technical

Thread info:
Category: {category}
Title: {title}
Body: {body}
Author: {author_name}`;

async function generateAIResponse(thread) {
  const key = process.env.OPENAI_API_KEY;
  const prompt = AI_PROMPT_TEMPLATE
    .replace('{category}', thread.category || '')
    .replace('{title}', thread.title || '')
    .replace('{body}', (thread.body || '').substring(0, 1500))
    .replace('{author_name}', thread.author_name || 'there');

  // Fallback: rule-based responses when no OpenAI key
  if (!key) {
    return generateFallbackResponse(thread);
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are Atlantist Community Support. Keep responses under 300 words. Be technical, direct, and helpful.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400,
        temperature: 0.7
      })
    });
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content || generateFallbackResponse(thread);
  } catch (e) {
    console.warn('[forum-agent] OpenAI response failed:', e.message);
    return generateFallbackResponse(thread);
  }
}

function generateFallbackResponse(thread) {
  const cat = thread.category || 'general';
  const title = thread.title || '';

  if (cat === 'issues') {
    return `Thanks for reporting this. Here's how to help us investigate:\n\n` +
           `1. **Share your browser & OS** (e.g., Chrome 124 on Windows 11)\n` +
           `2. **Describe steps to reproduce** — what were you doing when it broke?\n` +
           `3. **Include any error messages** or what you expected vs. saw\n` +
           `\nYou can also open the **History panel** (topbar) to see recent changes that might have caused this. Sharing that diff helps a lot.\n\n` +
           `Our team monitors bug reports daily. We'll reply here or open an internal ticket.`;
  }

  if (cat === 'features') {
    return `Great suggestion. Here's how we evaluate feature requests:\n\n` +
           `1. **Use case** — what problem does this solve for you specifically?\n` +
           `2. **Priority** — is this blocking your work or a nice-to-have?\n` +
           `3. **Similar tools** — have you used this feature somewhere else that works well?\n\n` +
           `Feature requests are reviewed each cycle. The more detail you give, the better we can assess fit.`;
  }

  if (title.toLowerCase().includes('door') || title.toLowerCase().includes('window')) {
    return `For door/window placement in Atlantist:\n\n` +
           `1. **Select the wall** first (click it in the 3D or plan view)\n` +
           `2. Click **+ Door** or **+ Window** in the toolbar\n` +
           `3. Click the wall face — the opening auto-cuts to match the family dimensions\n` +
           `\nIf you're not seeing the opening, check the wall's layer construction in the **Properties panel** — thin structural layers may render the opening invisible.`;
  }

  if (title.toLowerCase().includes('level') || title.toLowerCase().includes('elevation')) {
    return `Level management in Atlantist:\n\n` +
           `1. Open **Levels** from the toolbar (top left)\n` +
           `2. Click **+ Add Level** to insert a floor plane\n` +
           `3. Set the elevation in meters (e.g., 3.000 for a floor 3m above ground)\n\n` +
           `All bound elements (walls, doors, windows, floors) recalculate automatically when level elevation changes — that's the DAG constraint solver at work.`;
  }

  if (title.toLowerCase().includes('energy') || title.toLowerCase().includes('simulation')) {
    return `Energy simulation setup:\n\n` +
           `1. Click **Energy** in the toolbar → select your simulation type\n` +
           `2. Set envelope parameters (U-values, infiltration, internal gains)\n` +
           `3. **Run Simulation** — results include EUI, peak loads, and EN-001 to EN-008 compliance\n\n` +
           `For NYC DOB filing, use the **DOB Package** button to generate the 9-PDF bundle automatically. Check our docs for EN-1 form instructions.`;
  }

  // Default
  return `Thanks for posting. Here's how to get the most out of the community:\n\n` +
         `**For technical questions**: Describe what you were doing when it happened, your browser/OS, and any error messages.\n` +
         `**For bugs**: Check the **What's New** tab in Help — the issue might be a known bug we're tracking.\n` +
         `**For docs**: Full API reference and workflow guides are at https://atlantist.cloud/docs\n\n` +
         `I'll check back on this thread. If you need faster turnaround, email support@atlantist.cloud.`;
}

// ─── Main agent loop ───────────────────────────────────────────────────────────

async function runForumAgent() {
  console.log('[forum-agent] Running...');

  // 1. Scan recent threads for moderation
  const recent = await getUnansweredThreads(10);
  for (const thread of recent) {
    const bodyText = (thread.title || '') + ' ' + (thread.body || '');

    // Keyword check first (fast)
    const keywordResult = moderateContent(bodyText);
    if (!keywordResult.safe) {
      await updateThread(thread.id, { hidden: true, moderation_reason: keywordResult.reason });
      console.log(`[forum-agent] Hidden thread ${thread.id}: ${keywordResult.reason}`);
      continue;
    }

    // OpenAI check (if available)
    const aiResult = await aiModerate(bodyText);
    if (!aiResult.safe) {
      await updateThread(thread.id, { hidden: true, moderation_reason: aiResult.reason });
      console.log(`[forum-agent] Hidden thread ${thread.id} via AI: ${aiResult.reason}`);
      continue;
    }
  }

  // 2. Respond to recent unanswered threads
  for (const thread of recent) {
    // Skip already-responded or team posts or hidden
    if (thread.ai_response_count > 0 || thread.is_team_post || thread.hidden) continue;

    const responseBody = await generateAIResponse(thread);

    // Use system user ID 0 for AI responses (you can change this to a real bot user ID)
    const reply = await createReply({
      thread_id: thread.id,
      parent_id: null,
      body: responseBody,
      author_user_id: 0, // AI agent user
      is_team_post: true  // AI gets the "team" badge visually
    });

    // Bump AI response count (and mark escalated if >= 3)
    const bumped = await bumpAiResponseCount(thread.id);
    await logStatusChange(thread.id, thread.status, 'in_progress', 0, 'AI agent responded');

    console.log(`[forum-agent] Responded to thread ${thread.id} (ai_response_count=${bumped?.ai_response_count})`);
  }

  // 3. Check for escalated threads — notify human support
  const escalated = await getEscalatedThreads();
  if (escalated.length > 0) {
    console.warn(`[forum-agent] Escalated threads: ${escalated.map(t => t.id).join(', ')}`);
    // Log for human review — email/notification would go here
    // (could send via Postmark or create a support ticket)
  }

  console.log(`[forum-agent] Done. Scanned ${recent.length} recent threads.`);
  return { processed: recent.length, escalated: escalated.length };
}

// Run as standalone: node services/forum-agent.js
if (require.main === module) {
  runForumAgent()
    .then(r => { console.log('[forum-agent] Result:', r); process.exit(0); })
    .catch(e => { console.error('[forum-agent] Error:', e); process.exit(1); });
}

module.exports = { runForumAgent, moderateContent, generateAIResponse };