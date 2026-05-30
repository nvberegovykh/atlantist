/**
 * Owns: all DB queries for subscriptions table.
 * Does NOT own: Stripe API calls, webhook signing, subscription lifecycle logic.
 */
const pool = require('./index');

async function getSubscriptionByUserId(userId) {
  const res = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function getSubscriptionByCustomerId(customerId) {
  const res = await pool.query(
    `SELECT * FROM subscriptions WHERE stripe_customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  return res.rows[0] || null;
}

async function getSubscriptionByStripeSubId(stripeSubId) {
  const res = await pool.query(
    `SELECT * FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [stripeSubId]
  );
  return res.rows[0] || null;
}

async function upsertSubscription(data) {
  const { user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, status } = data;
  const res = await pool.query(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id    = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
       stripe_price_id       = EXCLUDED.stripe_price_id,
       plan                  = EXCLUDED.plan,
       status                = EXCLUDED.status,
       updated_at            = NOW()
     WHERE subscriptions.user_id = $1
     RETURNING *`,
    [user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan || 'monthly', status || 'active']
  );
  return res.rows[0];
}

async function updateSubscriptionStatus(userId, status, extra = {}) {
  const fields = ['status = $2', 'updated_at = NOW()'];
  const values = [userId, status];
  let idx = 3;

  if (extra.current_period_start) { fields.push(`current_period_start = $${idx++}`); values.push(extra.current_period_start); }
  if (extra.current_period_end)   { fields.push(`current_period_end   = $${idx++}`); values.push(extra.current_period_end); }
  if (extra.trial_end)            { fields.push(`trial_end = $${idx++}`); values.push(extra.trial_end); }
  if (extra.cancelled_at)        { fields.push(`cancelled_at = $${idx++}`); values.push(extra.cancelled_at); }
  if (extra.frozen_at)           { fields.push(`frozen_at = $${idx++}`); values.push(extra.frozen_at); }
  if (extra.scheduled_delete_at) { fields.push(`scheduled_delete_at = $${idx++}`); values.push(extra.scheduled_delete_at); }
  if (extra.cancel_at_period_end !== undefined) { fields.push(`cancel_at_period_end = $${idx++}`); values.push(extra.cancel_at_period_end); }
  if (extra.stripe_customer_id)  { fields.push(`stripe_customer_id = $${idx++}`); values.push(extra.stripe_customer_id); }
  if (extra.stripe_subscription_id) { fields.push(`stripe_subscription_id = $${idx++}`); values.push(extra.stripe_subscription_id); }
  if (extra.stripe_price_id)     { fields.push(`stripe_price_id = $${idx++}`); values.push(extra.stripe_price_id); }

  values.push(userId);
  const res = await pool.query(
    `UPDATE subscriptions SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function freezeSubscription(userId) {
  const scheduledDeleteAt = new Date();
  scheduledDeleteAt.setFullYear(scheduledDeleteAt.getFullYear() + 1);
  const res = await pool.query(
    `UPDATE subscriptions SET
       status = 'frozen',
       frozen_at = NOW(),
       scheduled_delete_at = $2,
       updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId, scheduledDeleteAt]
  );
  return res.rows[0] || null;
}

async function getSubscriptionCounts() {
  const res = await pool.query(`
    SELECT status, COUNT(*) as count FROM subscriptions GROUP BY status
  `);
  return res.rows;
}

async function getActiveSubscriberCount() {
  const res = await pool.query(`
    SELECT COUNT(*) FROM subscriptions WHERE status IN ('active', 'trialing')
  `);
  return parseInt(res.rows[0].count, 10);
}

async function reactivateSubscriptionByUserId(userId) {
  const res = await pool.query(
    `UPDATE subscriptions SET status = 'active', frozen_at = NULL, scheduled_delete_at = NULL, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
    [userId]
  );
  return res.rows[0] || null;
}

module.exports = {
  getSubscriptionByUserId,
  getSubscriptionByCustomerId,
  getSubscriptionByStripeSubId,
  upsertSubscription,
  updateSubscriptionStatus,
  freezeSubscription,
  getSubscriptionCounts,
  getActiveSubscriberCount,
  reactivateSubscriptionByUserId
};