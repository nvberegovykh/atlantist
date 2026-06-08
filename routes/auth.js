/**
 * Owns: /api/auth/* endpoints — registration, magic link, session management.
 * Does NOT own: Polsia user management, subscription billing.
 */
const router = require('express').Router();
const { getUserByEmail, upsertUser, createAnonymousUser, getUserBySessionUuid, getUserById } = require('../db/users');
const { createSession, getSessionByToken, invalidateSession } = require('../db/auth');
const { getPendingInvitesForEmail } = require('../db/invites');
const { upsertLead } = require('../db/leads');
const { createMagicToken, getMagicTokenData, consumeMagicToken } = require('../db/magic-tokens');
const { getUserRole } = require('../db/roles');
const { canonicalUrl } = require('../lib/canonical-url');
const { rateLimit: _rateLimit } = require('../lib/rate-limit');
const _verifyStep1Limit = _rateLimit({ max: 10, windowSec: 60, keyPrefix: 'rl:verify-step1' });

// ─── In-memory rate limiter for /send-magic-link ─────────────────────────────
// Fallback for environments without Redis. Keyed by normalised email.
// Max 5 requests per email per 15 minutes.
const _magicLinkRateMap = new Map(); // email → { count, resetAt }
const _MAGIC_LINK_MAX    = 5;
const _MAGIC_LINK_WINDOW = 15 * 60 * 1000; // 15 minutes in ms

function _magicLinkRateCheck(email) {
  const now = Date.now();
  const key = email.toLowerCase().trim();
  const entry = _magicLinkRateMap.get(key);
  if (!entry || now >= entry.resetAt) {
    _magicLinkRateMap.set(key, { count: 1, resetAt: now + _MAGIC_LINK_WINDOW });
    return true; // allowed
  }
  if (entry.count >= _MAGIC_LINK_MAX) return false; // blocked
  entry.count++;
  return true; // allowed
}

// ─── Email sending via Polsia proxy ──────────────────────────────────────────

const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Atlantist <noreply@atlantist.cloud>';
const REPLY_TO = 'Atlantist <support@atlantist.cloud>';

// ─── Shared brand email footer ────────────────────────────────────────────────
// Navy background + concentric-ring mark + DM Sans — matches brand tokens.css
const EMAIL_FOOTER = `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:40px;background:#0f1923;border-radius:0 0 8px 8px;">
    <tr>
      <td style="padding:24px 32px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;padding-right:12px;">
              <!-- Atlantist monogram — concentric rings + A mark -->
              <svg width="28" height="28" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                <rect width="64" height="64" rx="10" fill="#1a2e45"/>
                <circle cx="32" cy="33" r="25" fill="none" stroke="#7fb3de" stroke-width="1.2" opacity="0.2"/>
                <circle cx="32" cy="33" r="18" fill="none" stroke="#7fb3de" stroke-width="1.2" opacity="0.38"/>
                <circle cx="32" cy="33" r="11" fill="none" stroke="#7fb3de" stroke-width="1.2" opacity="0.6"/>
                <circle cx="32" cy="33" r="4" fill="#3479c4"/>
                <line x1="18" y1="48" x2="32" y2="14" stroke="#f7f6f3" stroke-width="2.8" stroke-linecap="round"/>
                <line x1="46" y1="48" x2="32" y2="14" stroke="#f7f6f3" stroke-width="2.8" stroke-linecap="round"/>
                <line x1="22" y1="36" x2="42" y2="36" stroke="#f7f6f3" stroke-width="2.8" stroke-linecap="round"/>
              </svg>
            </td>
            <td style="vertical-align:middle;">
              <span style="font-family:'DM Sans',Arial,sans-serif;font-size:16px;font-weight:600;color:#f7f6f3;letter-spacing:-0.3px;">Atlantist</span>
            </td>
          </tr>
        </table>
        <p style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;color:#6b7a8d;margin:12px 0 0;">BIM 2.0 — Browser-based building information modeling<br>
          <a href="https://atlantist.cloud" style="color:#3479c4;text-decoration:none;">atlantist.cloud</a> &nbsp;·&nbsp;
          <a href="mailto:support@atlantist.cloud" style="color:#3479c4;text-decoration:none;">support@atlantist.cloud</a>
        </p>
      </td>
    </tr>
  </table>
`;

async function sendMagicLinkEmail(email, token) {
  const magicLink = canonicalUrl(`/auth/verify?token=${token}`);
  const htmlBody = `
  <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f7f6f3;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3;padding:32px 0;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(15,25,35,0.08);">
          <!-- Top accent bar -->
          <tr><td style="height:4px;background:#1d5fa6;"></td></tr>
          <!-- Body -->
          <tr><td style="padding:40px 40px 32px;">
            <h1 style="font-family:'DM Sans',Arial,sans-serif;font-size:22px;font-weight:600;color:#0f1923;margin:0 0 8px;text-align:center;">Your magic link</h1>
            <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#8a8680;text-align:center;margin:0 0 32px;line-height:1.6;">
              Click the button below to sign in to Atlantist. This link expires in 15 minutes.
            </p>
            <div style="text-align:center;margin-bottom:32px;">
              <a href="${magicLink}" style="display:inline-block;background:#1d5fa6;color:#ffffff;text-decoration:none;font-family:'DM Sans',Arial,sans-serif;font-weight:600;font-size:15px;padding:14px 36px;border-radius:6px;letter-spacing:-0.2px;">
                Sign in to Atlantist →
              </a>
            </div>
            <p style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#8a8680;text-align:center;line-height:1.6;margin:0;">
              Didn't request this? Ignore this email — your account is safe.<br>
              Button not working? <span style="word-break:break-all;color:#3d3a35;">${magicLink}</span>
            </p>
          </td></tr>
          <!-- Footer -->
          <tr><td>${EMAIL_FOOTER}</td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>
  `;

  // Try Polsia email proxy first
  if (EMAIL_PROXY_URL) {
    try {
      const resp = await fetch(EMAIL_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: email,
          from: FROM_ADDRESS,
          reply_to: REPLY_TO,
          subject: 'Your Atlantist sign-in link',
          html_body: htmlBody
        })
      });
      if (resp.ok) {
        console.log(`[auth] Magic link email sent to ${email} via proxy`);
        return;
      }
      const errText = await resp.text();
      console.error(`[auth] Email proxy error: ${errText}`);
    } catch (err) {
      console.error(`[auth] Email proxy fetch error:`, err);
    }
  }

  // Resend SDK fallback (set RESEND_API_KEY in Render env to enable)
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: FROM_ADDRESS,
        to: email,
        replyTo: REPLY_TO,
        subject: 'Your Atlantist sign-in link',
        html: htmlBody
      });
      if (error) throw new Error(error.message);
      console.log(`[auth] Magic link email sent to ${email} via Resend`);
      return;
    } catch (err) {
      console.error('[auth] Resend error:', err.message);
    }
  }

  // Dev fallback: log magic link to console
  console.log(`[auth] Magic link for ${email}: ${magicLink}`);
}

// Auth middleware: check session cookie or X-Session-UUID header
function authMiddleware(req, res, next) {
  const sessionToken = req.cookies?.session_token;
  const sessionUuid = req.headers['x-session-uuid'] || req.cookies?.session_uuid;

  if (sessionToken) {
    getSessionByToken(sessionToken).then(async session => {
      if (session) {
        const appRole = await getUserRole(session.user_id);
        req.user = {
          id: session.user_id,
          email: session.email,
          first_name: session.first_name,
          project_type: session.project_type,
          role: session.role,
          specializations: session.specializations,
          location: session.location,
          app_role: appRole,
          session_uuid: null
        };
        next();
      } else {
        res.clearCookie('session_token');
        next();
      }
    }).catch(next);
  } else if (sessionUuid) {
    getUserBySessionUuid(sessionUuid).then(user => {
      if (user) {
        req.user = { id: user.id, session_uuid: sessionUuid, anonymous: true, app_role: 'user' };
        next();
      } else {
        createAnonymousUser(sessionUuid).then(user => {
          req.user = { id: user.id, session_uuid: sessionUuid, anonymous: true, app_role: 'user' };
          next();
        }).catch(next);
      }
    }).catch(next);
  } else {
    req.user = null;
    next();
  }
}

// GET /api/auth/me — get current user
// GET /api/auth/db-check — tests each DB step in the verify path; returns pass/fail per step
// Public endpoint, safe to call anytime (read-only probe + cleanup)
router.get('/db-check', async (req, res) => {
  const pool = require('../db/index');
  const results = {};
  try {
    // 1. Can we query app_users?
    const u = await pool.query('SELECT id FROM app_users LIMIT 1');
    results.app_users_query = { ok: true, rows: u.rowCount };
  } catch (e) { results.app_users_query = { ok: false, error: e.message, code: e.code }; }
  try {
    // 2. Can we query auth_sessions?
    const s = await pool.query('SELECT id FROM auth_sessions LIMIT 1');
    results.auth_sessions_query = { ok: true, rows: s.rowCount };
  } catch (e) { results.auth_sessions_query = { ok: false, error: e.message, code: e.code }; }
  try {
    // 3. Can we query magic_tokens?
    const m = await pool.query('SELECT id FROM magic_tokens LIMIT 1');
    results.magic_tokens_query = { ok: true, rows: m.rowCount };
  } catch (e) { results.magic_tokens_query = { ok: false, error: e.message, code: e.code }; }
  try {
    // 4. Can we INSERT into auth_sessions with a fake user_id? (will fail FK — that's expected)
    // Instead test with an existing user id if one exists
    const userRow = await pool.query('SELECT id FROM app_users ORDER BY id LIMIT 1');
    if (userRow.rows.length > 0) {
      const { createSession } = require('../db/auth');
      const sess = await createSession(userRow.rows[0].id);
      // Clean up immediately
      await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1',
        [require('crypto').createHash('sha256').update(sess.token).digest('hex')]);
      results.create_session = { ok: true, user_id: userRow.rows[0].id };
    } else {
      results.create_session = { ok: null, note: 'no users in DB to test with' };
    }
  } catch (e) { results.create_session = { ok: false, error: e.message, code: e.code }; }
  res.json({ status: 'ok', results });
});

// GET /api/auth/health — public, no auth required
// Returns email delivery config status so ops can verify magic link is wired up.
router.get('/health', (req, res) => {
  res.json({
    email_proxy: !!(process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL),
    resend:      !!process.env.RESEND_API_KEY,
    from:        process.env.EMAIL_FROM || 'Atlantist <noreply@atlantist.cloud> (default)',
    status:      'ok',
  });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ authenticated: false, user: null });
    }
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.json({ authenticated: false, user: null });
    }
    const appRole = req.user.app_role || await getUserRole(user.id);
    res.json({
      authenticated: !user.anonymous,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        project_type: user.project_type,
        role: user.role,
        specializations: user.specializations,
        location: user.location,
        onboarding_complete: user.onboarding_complete,
        onboarding_checklist: user.onboarding_checklist,
        anonymous: user.anonymous,
        app_role: appRole
      }
    });
  } catch (err) {
    console.error('[auth] GET /me', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/verify-step1 — Verify magic link token, return pending profile
// NOTE: Does NOT consume the token — only validates it's valid and not expired.
// The token is consumed in complete-signup when the user actually signs up.
// This allows verify-step1 to be called after the user clicks the magic link
// (which marks the token as used), while still allowing complete-signup to work.
// Rate-limited: 10 req/min per IP (stricter than mount-level authRateLimit).
router.post('/verify-step1', _verifyStep1Limit, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }
    const data = await getMagicTokenData(token);
    if (!data) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }
    const existingUser = await getUserByEmail(data.email);
    res.json({
      email: data.email,
      user_exists: !!existingUser,
      first_name: existingUser?.first_name || null
    });
  } catch (err) {
    console.error('[auth] POST /verify-step1', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/init — Initialize anonymous session (creates user record if needed)
// Hardened: returns 503 with retryable:true on DB errors so frontend shows retry state.
router.post('/init', async (req, res) => {
  try {
    const raw = req.body?.session_uuid;
    // Defensive: coerce to string, strip whitespace, reject empty/invalid
    const session_uuid = typeof raw === 'string' && raw.trim().length >= 10
      ? raw.trim()
      : null;
    if (!session_uuid) {
      return res.status(400).json({ error: 'session_uuid must be a non-empty string ≥10 chars' });
    }
    let user = await getUserBySessionUuid(session_uuid);
    if (!user) {
      user = await createAnonymousUser(session_uuid);
    }
    // Set httpOnly cookie for server-side session persistence.
    // The frontend JS reads the JSON token; the cookie ensures subsequent
    // server-side requests are recognised without the X-Session-UUID header.
    res.cookie('session_uuid', user.session_uuid, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    res.json({ user_id: user.id, session_uuid: user.session_uuid });
  } catch (err) {
    console.error('[auth] POST /init error:', err.message);
    // Return 503 so the frontend can show a retry/degraded state instead of spinning forever
    res.status(503).json({ error: 'auth_init_unavailable', message: err.message, retryable: true });
  }
});

// POST /api/auth/send-magic-link — Step 1 of 3-step signup
// Rate-limited: max 5 requests per email per 15 minutes (in-memory fallback).
router.post('/send-magic-link', async (req, res) => {
  try {
    const { email, session_uuid } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }

    // Rate limit check
    if (!_magicLinkRateCheck(email)) {
      res.set('Retry-After', String(Math.ceil(_MAGIC_LINK_WINDOW / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
    }

    // Store token in DB (persistent, multi-instance safe)
    const token = await createMagicToken(email, session_uuid);

    // Send actual email
    await sendMagicLinkEmail(email, token);

    // Track lead from registration (non-blocking — leads table may not exist in all envs)
    try { await upsertLead({ email, source: 'registration' }); } catch (leadErr) {
      console.warn('[auth] upsertLead skipped:', leadErr.message);
    }

    res.json({
      success: true,
      message: 'Magic link sent',
      // Include token in response for development/testing
      dev_token: process.env.NODE_ENV !== 'production' ? token : undefined
    });
  } catch (err) {
    console.error('[auth] POST /send-magic-link', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Welcome email (sent after signup completes) ──────────────────────────────
async function sendWelcomeEmail(email, firstName) {
  const name = firstName || 'there';
  const htmlBody = `
  <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f7f6f3;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3;padding:32px 0;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(15,25,35,0.08);">
          <tr><td style="height:4px;background:#1d5fa6;"></td></tr>
          <tr><td style="padding:40px 40px 32px;">
            <h1 style="font-family:'DM Sans',Arial,sans-serif;font-size:22px;font-weight:600;color:#0f1923;margin:0 0 8px;">Welcome, ${name}</h1>
            <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#8a8680;line-height:1.6;margin:0 0 28px;">
              Atlantist is a browser-based BIM platform — no install, no downloads, fully collaborative. Here's where to start.
            </p>
            <!-- Step cards -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
              <tr><td style="background:#f7f6f3;border-radius:6px;padding:16px 20px;border-left:3px solid #1d5fa6;margin-bottom:10px;">
                <div style="font-family:'DM Sans',Arial,sans-serif;font-weight:600;font-size:14px;color:#0f1923;margin-bottom:4px;">Place your first wall</div>
                <div style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a8680;">Click + Wall in the top bar, then click the 3D viewport to draw.</div>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
              <tr><td style="background:#f7f6f3;border-radius:6px;padding:16px 20px;border-left:3px solid #1d5fa6;">
                <div style="font-family:'DM Sans',Arial,sans-serif;font-weight:600;font-size:14px;color:#0f1923;margin-bottom:4px;">Add doors and windows</div>
                <div style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a8680;">Select a wall, click + Door or + Window, then click the wall face.</div>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr><td style="background:#f7f6f3;border-radius:6px;padding:16px 20px;border-left:3px solid #1d5fa6;">
                <div style="font-family:'DM Sans',Arial,sans-serif;font-weight:600;font-size:14px;color:#0f1923;margin-bottom:4px;">Run energy analysis</div>
                <div style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a8680;">Click Energy in the toolbar → Run Simulation for NYECC compliance.</div>
              </td></tr>
            </table>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="https://atlantist.cloud" style="display:inline-block;background:#1d5fa6;color:#ffffff;text-decoration:none;font-family:'DM Sans',Arial,sans-serif;font-weight:600;font-size:15px;padding:14px 36px;border-radius:6px;">
                Open Atlantist →
              </a>
            </div>
            <p style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#8a8680;text-align:center;margin:0;">
              Questions? Reply to this email or visit <a href="https://atlantist.cloud/docs" style="color:#1d5fa6;text-decoration:none;">our docs</a>.
            </p>
          </td></tr>
          <tr><td>${EMAIL_FOOTER}</td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>
  `;
  if (EMAIL_PROXY_URL) {
    try {
      await fetch(EMAIL_PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: email, from: FROM_ADDRESS, reply_to: REPLY_TO, subject: `Welcome to Atlantist, ${name}`, html_body: htmlBody }) });
      console.log(`[auth] Welcome email sent to ${email}`);
    } catch (err) { console.error(`[auth] Welcome email failed:`, err); }
  }
}

// POST /api/auth/complete-signup — Step 3: complete registration
router.post('/complete-signup', async (req, res) => {
  try {
    const { token, session_uuid, first_name, project_type, role = 'Architect', specializations = [], location } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }

    const data = await getMagicTokenData(token);
    if (!data) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Create or update user
    let user = await upsertUser({
      session_uuid: session_uuid || data.session_uuid,
      email: data.email,
      first_name,
      project_type,
      role,
      specializations,
      location
    });

    // Create session
    const { session, token: sessionToken } = await createSession(user.id);

    // Mark magic token as used
    await consumeMagicToken(token);

    // Get pending invites for this email
    const pendingInvites = await getPendingInvitesForEmail(data.email);

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email, user.first_name);

    // Set session cookie
    res.cookie('session_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        project_type: user.project_type,
        role: user.role,
        specializations: user.specializations,
        location: user.location,
        onboarding_complete: user.onboarding_complete
      },
      pending_invites: pendingInvites.length > 0 ? pendingInvites : undefined
    });
  } catch (err) {
    console.error('[auth] POST /complete-signup', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/verify — Magic link browser redirect (no auth middleware — public)
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.redirect('/');
    }

    const data = await getMagicTokenData(token);
    if (!data) {
      // Token invalid or expired — redirect to app with error
      return res.redirect('/?magic_error=expired');
    }

    // Auto-create account on first magic link use (no profile step required).
    // If user already exists this is a no-op (upsertUser is idempotent).
    let autoUser = await getUserByEmail(data.email);
    if (!autoUser) {
      autoUser = await upsertUser({
        session_uuid: data.session_uuid || null,
        email: data.email,
        first_name: null,
        project_type: null,
        role: 'Architect',
        specializations: [],
        location: null
      });
      console.log(`[auth] Auto-created account for ${data.email}`);
    }

    // Create session immediately
    const { token: sessionToken } = await createSession(autoUser.id);

    // Mark magic token as used
    await consumeMagicToken(token);

    // Set httpOnly session cookie — JS cannot read this (secure by default)
    res.cookie('session_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    // Also set pending_magic_token as httpOnly so it is NOT readable by JS
    // (the frontend will detect the session cookie and log the user in directly)
    res.cookie('pending_magic_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000 // 15 minutes
    });

    // Redirect to app — session cookie is set, user is logged in
    // Support ?next= forwarding from login page
    const nextParam = req.query.next;
    const safeNext = (nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')) ? nextParam : '/app';
    res.redirect(302, safeNext);
  } catch (err) {
    console.error('[auth] GET /verify', err);
    // Include error code in redirect so we can diagnose from browser URL bar
    const code = err.code || err.name || 'unknown';
    res.redirect(`/?magic_error=server_error&ecode=${encodeURIComponent(code)}`);
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const sessionToken = req.cookies?.session_token;
    if (sessionToken) {
      await invalidateSession(sessionToken);
      res.clearCookie('session_token');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[auth] POST /logout', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/invite/:token — Get invite details (public endpoint)
router.get('/invite/:token', async (req, res) => {
  try {
    const { getInviteByToken } = require('../db/invites');
    const invite = await getInviteByToken(req.params.token);
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found or expired' });
    }
    res.json({
      project_name: invite.project_name,
      invited_by_name: invite.invited_by_name,
      role: invite.role,
      expires_at: invite.expires_at
    });
  } catch (err) {
    console.error('[auth] GET /invite/:token', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/grant-admin — Promote a user to admin (protected by ADMIN_SECRET env var)
router.post('/grant-admin', async (req, res) => {
  try {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.headers['x-admin-secret'] !== secret) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { user_id, email } = req.body;
    if (!user_id && !email) {
      return res.status(400).json({ error: 'user_id or email required' });
    }
    const { getUserById, getUserByEmail } = require('../db/users');
    const { setUserRole } = require('../db/roles');
    let user;
    if (user_id) {
      user = await getUserById(user_id);
    } else {
      user = await getUserByEmail(email);
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await setUserRole(user.id, 'admin');
    res.json({ success: true, user_id: user.id, role: 'admin' });
  } catch (err) {
    console.error('[auth] POST /grant-admin', err);
    res.status(500).json({ error: err.message });
  }
});

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.app_role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ─── Password Reset ───────────────────────────────────────────────────────────
async function sendPasswordResetEmail(email, token) {
  const resetLink = canonicalUrl(`/auth/reset-password?token=${token}`);
  const htmlBody = `
  <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f7f6f3;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3;padding:32px 0;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(15,25,35,0.08);">
          <tr><td style="height:4px;background:#1d5fa6;"></td></tr>
          <tr><td style="padding:40px 40px 32px;">
            <h1 style="font-family:'DM Sans',Arial,sans-serif;font-size:22px;font-weight:600;color:#0f1923;margin:0 0 8px;text-align:center;">Reset your password</h1>
            <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#8a8680;text-align:center;margin:0 0 32px;line-height:1.6;">
              Click the button below to set a new password for your Atlantist account. This link expires in 15 minutes.
            </p>
            <div style="text-align:center;margin-bottom:32px;">
              <a href="${resetLink}" style="display:inline-block;background:#1d5fa6;color:#ffffff;text-decoration:none;font-family:'DM Sans',Arial,sans-serif;font-weight:600;font-size:15px;padding:14px 36px;border-radius:6px;letter-spacing:-0.2px;">
                Reset password →
              </a>
            </div>
            <p style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#8a8680;text-align:center;line-height:1.6;margin:0;">
              Didn't request this? Ignore this email — your account is safe.<br>
              Button not working? <span style="word-break:break-all;color:#3d3a35;">${resetLink}</span>
            </p>
          </td></tr>
          <tr><td>${EMAIL_FOOTER}</td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>
  `;

  if (EMAIL_PROXY_URL) {
    try {
      const resp = await fetch(EMAIL_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: email,
          from: FROM_ADDRESS,
          reply_to: REPLY_TO,
          subject: 'Reset your Atlantist password',
          html_body: htmlBody
        })
      });
      if (resp.ok) {
        console.log(`[auth] Password reset email sent to ${email}`);
        return;
      }
      console.error(`[auth] Email proxy error: ${await resp.text()}`);
    } catch (err) {
      console.error(`[auth] Email proxy fetch error:`, err);
    }
  }
  console.log(`[auth] Password reset for ${email}: ${resetLink}`);
}

// POST /api/auth/send-password-reset — Request a password reset email
router.post('/send-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }
    const user = await getUserByEmail(email);
    if (!user) {
      // Don't reveal whether account exists
      return res.json({ success: true, message: 'If that email is registered, a reset link was sent.' });
    }
    // Reuse magic token mechanism for reset tokens (15-min TTL, single use)
    const { createMagicToken } = require('../db/magic-tokens');
    const token = await createMagicToken(email);
    await sendPasswordResetEmail(email, token);
    res.json({
      success: true,
      dev_token: process.env.NODE_ENV !== 'production' ? token : undefined
    });
  } catch (err) {
    console.error('[auth] POST /send-password-reset', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/reset-password — Magic-style sign-in via password-reset token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, session_uuid } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }

    const data = await getMagicTokenData(token);
    if (!data) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const user = await getUserByEmail(data.email);
    if (!user) {
      return res.status(400).json({ error: 'No account for this email' });
    }

    // Create session
    const { session, token: sessionToken } = await createSession(user.id);
    await consumeMagicToken(token);

    res.cookie('session_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({ success: true, user: { id: user.id, email: user.email, first_name: user.first_name } });
  } catch (err) {
    console.error('[auth] POST /reset-password', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.adminMiddleware = adminMiddleware;
module.exports.optionalAuth = authMiddleware; // attaches req.user if session present, allows anonymous