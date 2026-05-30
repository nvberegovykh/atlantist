/**
 * Owns: ban consequence execution and false-flag compensation logic.
 * Called by admin decide route (routes/abuse.js) on Uphold/Dismiss decisions.
 * Does NOT own: Stripe webhook handling, session auth, route definitions.
 */
'use strict';

const {
  insertBannedModel,
  hardDeleteProject,
  setAccountStatus,
  invalidateAllSessions,
  getStripeCustomerId
} = require('../db/ban-engine');

const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
const EMAIL_FROM = 'Atlantist <noreply@atlantist.cloud>';
const SUPPORT_EMAIL = 'support@atlantist.cloud';

// ─── Email helper ─────────────────────────────────────────────────────────────
// Fire-and-forget: logs on failure, never throws.
async function sendEmail({ to, subject, html }) {
  if (!EMAIL_PROXY_URL) {
    console.warn('[ban-engine] EMAIL_PROXY_URL not set — skipping email to', to);
    return;
  }
  try {
    const res = await fetch(EMAIL_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html })
    });
    if (!res.ok) {
      console.error('[ban-engine] Email send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[ban-engine] Email send error:', err.message);
  }
}

// ─── applyBanConsequences ─────────────────────────────────────────────────────
/**
 * Called when an admin upholds a user-filed abuse report.
 * 1. Writes banned_models sentinel row.
 * 2. Hard-deletes the project and all children.
 * 3. Sets owner account to grace_export_only for 30 days.
 * 4. Emails the owner: ban notice.
 */
async function applyBanConsequences(project_id, owner_user_id, { decided_by, report_id, owner_email, notes } = {}) {
  // 1. Sentinel row — legal hold audit trail
  await insertBannedModel({
    model_id: String(project_id),
    owner_user_id: owner_user_id ? String(owner_user_id) : null,
    decided_by: decided_by ? String(decided_by) : null,
    report_id: report_id || null,
    notes: notes || null
  });

  // 2. Hard-delete project and all children
  try {
    await hardDeleteProject(project_id);
  } catch (err) {
    // Log but don't abort — sentinel row is already written
    console.error('[ban-engine] hardDeleteProject failed for', project_id, err.message);
  }

  // 3. Grace export-only window: 30 days
  const graceExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await setAccountStatus(owner_user_id, 'grace_export_only', graceExpires);

  // 4. Email — ban notice
  if (owner_email) {
    await sendEmail({
      to: owner_email,
      subject: 'Important: Your Atlantist project has been removed',
      html: `
        <p>Hi,</p>
        <p>Following a review of a report filed against one of your projects, the Atlantist Trust & Safety team has determined that the project violated our <a href="https://atlantist.cloud/legal/terms#acceptable-use">Acceptable Use & Safety</a> policy. The project has been permanently removed.</p>
        <p><strong>What this means for your account:</strong></p>
        <ul>
          <li>You have <strong>30 days</strong> (until ${graceExpires.toDateString()}) to export your remaining projects (IFC, PDF, DXF, CSV).</li>
          <li>You cannot create new projects or edit existing ones during this period.</li>
          <li>After 30 days, your account will be suspended.</li>
        </ul>
        <p>If you believe this decision was made in error, you may appeal within 14 days by emailing <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with your account email, project details, and a description of the intended use.</p>
        <p>— The Atlantist Trust & Safety Team</p>
      `
    });
  }

  console.log(`[ban-engine] applyBanConsequences complete: project=${project_id} owner=${owner_user_id} grace_until=${graceExpires.toISOString()}`);
  return { grace_expires_at: graceExpires };
}

// ─── scheduleSuspensionReminders ─────────────────────────────────────────────
/**
 * Sends 7-day and 1-day reminders to a user in grace mode.
 * Called by the grace-expiry cron job when checking upcoming expirations.
 */
async function sendGraceReminder(owner_email, grace_expires_at, days_remaining) {
  if (!owner_email) return;
  const label = days_remaining === 7 ? '7 days' : '1 day';
  await sendEmail({
    to: owner_email,
    subject: `Reminder: Your Atlantist account will be suspended in ${label}`,
    html: `
      <p>Hi,</p>
      <p>This is a reminder that your Atlantist account grace period ends in <strong>${label}</strong> (${new Date(grace_expires_at).toDateString()}).</p>
      <p>Please export any remaining projects before then. After suspension, your account and data will no longer be accessible.</p>
      <p>To export a project: open it in Atlantist → Render menu → Export (IFC / PDF / DXF / CSV).</p>
      <p>Questions? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
      <p>— The Atlantist Team</p>
    `
  });
}

// ─── executeSuspension ────────────────────────────────────────────────────────
/**
 * Called by the grace-expiry cron when a user's grace window has elapsed.
 * 1. Sets account_status = 'suspended'.
 * 2. Force-logs out all sessions.
 * 3. Cancels Stripe subscription (no refund).
 * 4. Emails suspension confirmation.
 */
async function executeSuspension(user_id, owner_email) {
  // 1. Mark suspended
  await setAccountStatus(user_id, 'suspended', null);

  // 2. Invalidate sessions
  try {
    await invalidateAllSessions(user_id);
  } catch (err) {
    console.error('[ban-engine] invalidateAllSessions failed for', user_id, err.message);
  }

  // 3. Cancel Stripe subscription
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (STRIPE_SECRET_KEY) {
    try {
      const stripeMeta = await getStripeCustomerId(user_id);
      if (stripeMeta?.stripe_subscription_id) {
        const Stripe = require('stripe');
        const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
        await stripe.subscriptions.cancel(stripeMeta.stripe_subscription_id, {
          // No prorate — no refund per policy
          prorate: false
        });
        console.log('[ban-engine] Stripe sub cancelled for user', user_id);
      }
    } catch (stripeErr) {
      // Non-fatal — account is already suspended locally
      console.error('[ban-engine] Stripe cancellation failed for', user_id, stripeErr.message);
    }
  }

  // 4. Suspension confirmation email
  if (owner_email) {
    await sendEmail({
      to: owner_email,
      subject: 'Your Atlantist account has been suspended',
      html: `
        <p>Hi,</p>
        <p>Your Atlantist account has been suspended following the expiration of your 30-day export grace period.</p>
        <p>Your data has been retained for the legally required period. If you have questions, contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
        <p>— The Atlantist Trust & Safety Team</p>
      `
    });
  }

  console.log(`[ban-engine] executeSuspension complete for user=${user_id}`);
}

// ─── issueFalseFlagCompensation ───────────────────────────────────────────────
/**
 * Called when an admin dismisses a user-filed report (false flag).
 * 1. Creates a Stripe coupon: 50% off for 3 months, applied to owner's subscription.
 * 2. Emails the owner with an apology and credit confirmation.
 */
async function issueFalseFlagCompensation(reporter_user_id, owner_user_id, { owner_email, project_name } = {}) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    console.warn('[ban-engine] STRIPE_SECRET_KEY not set — skipping coupon issuance');
    return;
  }

  const stripeMeta = await getStripeCustomerId(owner_user_id);
  if (!stripeMeta?.stripe_customer_id) {
    console.warn('[ban-engine] Owner has no Stripe customer — skipping coupon for user', owner_user_id);
    return;
  }

  const Stripe = require('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

  // Unique coupon id to avoid conflicts
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const couponId = `falseflag_${rand}`;

  const coupon = await stripe.coupons.create({
    id: couponId,
    percent_off: 50,
    duration: 'repeating',
    duration_in_months: 3,
    name: 'False Report Compensation — 50% off × 3 mo',
    metadata: {
      reporter_user_id: String(reporter_user_id),
      owner_user_id: String(owner_user_id)
    }
  });

  // Apply coupon to customer — redeems on next invoice
  await stripe.customers.update(stripeMeta.stripe_customer_id, { coupon: coupon.id });

  // Email owner
  if (owner_email) {
    await sendEmail({
      to: owner_email,
      subject: 'Atlantist: Your project was cleared — 50% credit applied',
      html: `
        <p>Hi,</p>
        <p>We reviewed the report filed against${project_name ? ` <strong>${project_name}</strong>` : ' your project'} and determined it did not violate our Acceptable Use & Safety policy. The project lock has been removed.</p>
        <p>As an apology for the inconvenience, we have applied a <strong>50% discount to your next 3 billing cycles</strong>. This will appear automatically on your upcoming invoices.</p>
        <p>Thank you for your patience. If you have any questions, contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
        <p>— The Atlantist Team</p>
      `
    });
  }

  console.log(`[ban-engine] issueFalseFlagCompensation complete: coupon=${couponId} owner=${owner_user_id}`);
  return { coupon_id: couponId };
}

module.exports = {
  applyBanConsequences,
  sendGraceReminder,
  executeSuspension,
  issueFalseFlagCompensation
};
