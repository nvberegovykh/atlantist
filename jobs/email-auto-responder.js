/**
 * Email auto-responder — polls Polsia inbox for new emails forwarded from IONOS
 * to atlantist@polsia.com, auto-responds with Atlantist context, marks read.
 * Runs via polsia.toml [[crons]]. Guard: POLSIA_IN_PROCESS_CRONS_ENABLED must be 'true'.
 */
if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
  console.log('[auto-responder] Disabled — POLSIA_IN_PROCESS_CRONS_ENABLED is not "true"');
  process.exit(0);
}

const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Atlantist <noreply@atlantist.cloud>';
const REPLY_TO = 'Atlantist <support@atlantist.cloud>';

const INBOX_POLL_INTERVAL = process.env.AUTO_RESPONDER_INTERVAL_MS || 60000; // default 1 minute
const RESPONDED_TTL_MS = 24 * 60 * 60 * 1000; // don't re-respond within 24h

const seenEmails = new Set();

async function sendAutoResponse(toEmail, subject, inReplyTo) {
  const name = toEmail.split('@')[0];
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 32px;">
        <div style="font-size: 24px; font-weight: 700; color: #4a7dbd; letter-spacing: -0.5px;">⚡ Atlantist</div>
      </div>
      <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Thanks for reaching out</h1>
      <p style="font-size: 14px; color: #666; line-height: 1.65; margin-bottom: 20px;">
        Hi${name ? ', ' + name : ''} — we received your message and a member of the team will get back to you shortly.
      </p>
      <p style="font-size: 14px; color: #666; line-height: 1.65; margin-bottom: 20px;">
        While you wait, here's a quick overview of what Atlantist does:
      </p>
      <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin:20px 0">
        <div style="font-weight:600;margin-bottom:8px">Atlantist — Browser-Based BIM</div>
        <div style="font-size:13px;color:#666;margin-bottom:8px">Professional Building Information Modeling in your browser. No install or plugins required.</div>
        <div style="font-size:12px;color:#888;margin-top:12px;padding-top:12px;border-top:1px solid #eee">
          <strong>Features:</strong> Parametric 3D walls/columns/doors/windows · Energy analysis (EN-001 to EN-008) · Fire protection (NFPA 13/101/92, FDS) · Geotechnical (Terzaghi, settlement, OpenSees) · Design Book · Real-time collaboration · AI renders<br>
          <strong>Pricing:</strong> $30/month or $330/year — 30-day free trial · <a href="https://atlantist.cloud/#pricing" style="color:#4a7dbd">See plans →</a>
        </div>
      </div>
      <p style="font-size: 12px; color: #aaa; text-align: center; margin-top: 24px;">
        Questions? Email us directly at <a href="mailto:support@atlantist.cloud" style="color:#aaa">support@atlantist.cloud</a>
      </p>
    </div>
  `;

  if (EMAIL_PROXY_URL) {
    try {
      const resp = await fetch(EMAIL_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toEmail,
          from: FROM_ADDRESS,
          reply_to: REPLY_TO,
          subject: 'Re: ' + subject,
          in_reply_to: inReplyTo,
          html_body: htmlBody
        })
      });
      if (resp.ok) {
        console.log(`[auto-responder] Sent response to ${toEmail}`);
        return true;
      }
      console.error(`[auto-responder] Proxy error: ${await resp.text()}`);
    } catch (err) {
      console.error(`[auto-responder] Fetch error:`, err);
    }
  } else {
    console.log(`[auto-responder] Would respond to ${toEmail} re: "${subject}"`);
  }
  return false;
}

async function pollInbox() {
  // Use Polsia email proxy to check inbox for forwarded emails
  if (!EMAIL_PROXY_URL) {
    console.log('[auto-responder] No EMAIL_PROXY_URL — skipping poll');
    return;
  }

  try {
    // The Polsia email proxy exposes inbox via GET /inbox or similar
    // Check for forwarded emails from IONOS → atlantist@polsia.com
    const resp = await fetch(EMAIL_PROXY_URL + '/inbox', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!resp.ok) {
      console.log(`[auto-responder] Inbox poll returned ${resp.status}`);
      return;
    }

    const inbox = await resp.json();
    const emails = Array.isArray(inbox) ? inbox : (inbox.emails || []);

    if (emails.length === 0) {
      console.log('[auto-responder] No new emails in inbox');
      return;
    }

    let responded = 0;
    for (const email of emails) {
      if (!email.id || seenEmails.has(email.id)) continue;

      // Only respond to unread emails
      if (email.read || email.seen) continue;

      // Respond and mark as read
      const sent = await sendAutoResponse(email.from || email.reply_to || 'unknown', email.subject || '(no subject)', email.message_id || email.id);
      if (sent) {
        seenEmails.add(email.id);
        // Mark as read via proxy
        await fetch(EMAIL_PROXY_URL + '/inbox/' + email.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read: true })
        }).catch(err => console.warn('[auto-responder] Failed to mark read:', err.message));
        responded++;
      }
    }

    if (responded > 0) {
      console.log(`[auto-responder] Responded to ${responded} email(s)`);
    }

  } catch (err) {
    console.error('[auto-responder] Poll error:', err);
  }
}

// Cleanup old entries from seenEmails set every 6h
setInterval(() => {
  // Reset every 6h — IDs older than 24h are fine to re-process
  seenEmails.clear();
}, 6 * 60 * 60 * 1000);

async function run() {
  console.log('[auto-responder] Starting — polling every ' + (INBOX_POLL_INTERVAL / 1000) + 's');
  await pollInbox();
}

run().catch(err => { console.error('[auto-responder] Fatal:', err); process.exit(1); });