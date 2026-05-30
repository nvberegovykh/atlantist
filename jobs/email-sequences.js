/**
 * Email sequences — runs daily via polsia.toml [[crons]]
 * Sends: welcome (on signup), inactive (7-day no login), billing (3-day before renewal)
 */
const pool = require('../db/index');
const { getInactiveLeads, getBillingRenewalLeads, verifyLead } = require('../db/leads');

const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Atlantist <noreply@atlantist.cloud>';
const REPLY_TO = 'Atlantist <support@atlantist.cloud>';

async function sendEmail(to, subject, htmlBody) {
  if (EMAIL_PROXY_URL) {
    try {
      const resp = await fetch(EMAIL_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, from: FROM_ADDRESS, reply_to: REPLY_TO, subject, html_body: htmlBody })
      });
      if (resp.ok) { console.log(`[email-seq] Sent ${subject} to ${to}`); return true; }
      console.error(`[email-seq] Proxy error for ${to}: ${await resp.text()}`);
    } catch (err) { console.error(`[email-seq] Fetch error for ${to}:`, err); }
  } else {
    console.log(`[email-seq] Would send "${subject}" to ${to}`);
  }
  return false;
}

// ─── WELCOME EMAIL ────────────────────────────────────────────────────────────
async function sendWelcomeEmail(email, firstName) {
  const name = firstName || 'there';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 32px;">
        <div style="font-size: 24px; font-weight: 700; color: #4a7dbd; letter-spacing: -0.5px;">⚡ Atlantist</div>
      </div>
      <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Start here — your first project</h1>
      <p style="font-size: 14px; color: #666; line-height: 1.6;">Welcome, ${name}. Atlantist is a browser-based BIM platform — no install, no downloads, fully collaborative.</p>
      <div style="margin: 28px 0;">
        <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin-bottom:12px">
          <div style="font-weight:600;margin-bottom:4px">🧱 Try placing your first wall</div>
          <div style="font-size:13px;color:#666">Click + Wall in the top bar, then click the 3D viewport to draw</div>
        </div>
        <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin-bottom:12px">
          <div style="font-weight:600;margin-bottom:4px">🚪 Add doors to your walls</div>
          <div style="font-size:13px;color:#666">Select a wall, click + Door, then click the wall face to place</div>
        </div>
        <div style="background:#f8f9fa;border-radius:8px;padding:20px">
          <div style="font-weight:600;margin-bottom:4px">⚡ Run energy analysis</div>
          <div style="font-size:13px;color:#666">Click ⚡ Energy → Run Energy Simulation for NYECC compliance</div>
        </div>
      </div>
      <p style="font-size: 13px; color: #888; text-align: center;">
        Questions? Reply to this email or visit <a href="https://atlantist.cloud/docs/faq" style="color:#4a7dbd">atlantist.cloud/docs/faq</a>
      </p>
    </div>
  `;
  return sendEmail(email, 'Start here — your first project in Atlantist', html);
}

// ─── INACTIVE EMAIL ────────────────────────────────────────────────────────────
async function sendInactiveEmail(email, projectType) {
  const featureTips = {
    'Arch': 'The <strong>A-400 Schedule</strong> auto-populates from placed doors and windows — ready to export for your drawings.',
    'Struct': 'The <strong>Geotechnical</strong> module runs bearing capacity (Terzaghi/Hansen/Meyerhof), settlement analysis, and OpenSees export.',
    'MEP': 'The <strong>Energy Analysis</strong> tab exports gbXML and IDF files for your simulation engine.',
    'Mixed': 'Try the <strong>Fire Protection</strong> module — NFPA 13 sprinkler hydraulics, NFPA 101 egress analysis, and FDS smoke simulation.'
  };
  const tip = featureTips[projectType] || featureTips['Mixed'];

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 32px;">
        <div style="font-size: 24px; font-weight: 700; color: #4a7dbd; letter-spacing: -0.5px;">⚡ Atlantist</div>
      </div>
      <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Miss us? One feature you haven't tried yet</h1>
      <div style="background:#f8f9fa;border-radius:8px;padding:24px;margin:24px 0">
        ${tip}
      </div>
      <div style="text-align: center; margin-top: 24px;">
        <a href="https://atlantist.cloud" style="display: inline-block; background: #4a7dbd; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 6px;">Open Atlantist →</a>
      </div>
      <p style="font-size: 12px; color: #aaa; text-align: center; margin-top: 24px;">No longer want these emails? <a href="mailto:noreply@atlantist.cloud?subject=Unsubscribe" style="color:#aaa">Unsubscribe</a></p>
    </div>
  `;
  return sendEmail(email, 'Miss us? One feature you haven\u2019t tried yet', html);
}

// ─── BILLING RENEWAL EMAIL ────────────────────────────────────────────────────
async function sendBillingRenewalEmail(email, periodEnd) {
  const days = Math.ceil((new Date(periodEnd) - new Date()) / (1000 * 60 * 60 * 24));
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 32px;">
        <div style="font-size: 24px; font-weight: 700; color: #4a7dbd; letter-spacing: -0.5px;">⚡ Atlantist</div>
      </div>
      <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Your Atlantist subscription renews in ${days} day${days !== 1 ? 's' : ''}</h1>
      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Your subscription will renew automatically. To manage your plan, update payment info, or cancel, use the link below.
      </p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="https://billing.stripe.com" style="display: inline-block; background: #4a7dbd; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 6px;">Manage Subscription →</a>
      </div>
      <p style="font-size: 12px; color: #aaa; text-align: center;">
        Questions? Reply to this email or visit <a href="https://atlantist.cloud/docs/faq" style="color:#aaa">atlantist.cloud/docs/faq</a>
      </p>
    </div>
  `;
  return sendEmail(email, 'Your Atlantist subscription renews in 3 days', html);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('[email-seq] Starting email sequence job');

  // 1. Welcome emails — triggered from auth on signup (no batch needed here)
  // 2. Inactive emails (7-day no login)
  const inactiveLeads = await getInactiveLeads();
  for (const lead of inactiveLeads) {
    await sendInactiveEmail(lead.email, lead.project_type);
    console.log(`[email-seq] Sent inactive email to ${lead.email}`);
  }

  // 3. Billing renewal emails (3 days before)
  const billingLeads = await getBillingRenewalLeads();
  for (const lead of billingLeads) {
    if (lead.billing_period_end) {
      await sendBillingRenewalEmail(lead.email, lead.billing_period_end);
      console.log(`[email-seq] Sent billing renewal email to ${lead.email}`);
    }
  }

  console.log(`[email-seq] Done — ${inactiveLeads.length} inactive, ${billingLeads.length} billing`);
}

run().catch(err => { console.error('[email-seq] Job failed:', err); process.exit(1); });