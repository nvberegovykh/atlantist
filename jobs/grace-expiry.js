/**
 * grace-expiry.js — Processes grace period expirations and reminder emails.
 *
 * Runs daily (declared in polsia.toml):
 *   1. Sends 7-day reminder to users whose grace expires in 6-8 days.
 *   2. Sends 1-day reminder to users whose grace expires in 0-2 days.
 *   3. Suspends users whose grace_expires_at has passed.
 */
'use strict';

require('dotenv').config();
const pool = require('../db/index');
const { getExpiredGraceUsers } = require('../db/ban-engine');
const { executeSuspension, sendGraceReminder } = require('../services/ban-engine');

async function run() {
  console.log('[grace-expiry] Starting grace expiry job', new Date().toISOString());

  // ─── 1. Users to suspend (grace expired) ──────────────────────────────────
  let suspended = 0;
  try {
    const expired = await getExpiredGraceUsers();
    for (const user of expired) {
      try {
        await executeSuspension(user.id, user.email);
        suspended++;
      } catch (err) {
        console.error(`[grace-expiry] executeSuspension failed for user ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[grace-expiry] getExpiredGraceUsers error:', err.message);
  }

  // ─── 2. 7-day reminder ────────────────────────────────────────────────────
  let reminded7 = 0;
  try {
    const res = await pool.query(
      `SELECT id, email, grace_expires_at FROM app_users
       WHERE account_status = 'grace_export_only'
         AND grace_expires_at BETWEEN NOW() + INTERVAL '6 days' AND NOW() + INTERVAL '8 days'`
    );
    for (const user of res.rows) {
      try {
        await sendGraceReminder(user.email, user.grace_expires_at, 7);
        reminded7++;
      } catch (err) {
        console.error(`[grace-expiry] 7-day reminder failed for user ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[grace-expiry] 7-day reminder query error:', err.message);
  }

  // ─── 3. 1-day reminder ────────────────────────────────────────────────────
  let reminded1 = 0;
  try {
    const res = await pool.query(
      `SELECT id, email, grace_expires_at FROM app_users
       WHERE account_status = 'grace_export_only'
         AND grace_expires_at BETWEEN NOW() AND NOW() + INTERVAL '2 days'`
    );
    for (const user of res.rows) {
      try {
        await sendGraceReminder(user.email, user.grace_expires_at, 1);
        reminded1++;
      } catch (err) {
        console.error(`[grace-expiry] 1-day reminder failed for user ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[grace-expiry] 1-day reminder query error:', err.message);
  }

  console.log(`[grace-expiry] Done. suspended=${suspended} reminded_7d=${reminded7} reminded_1d=${reminded1}`);
  await pool.end();
}

run().catch(err => {
  console.error('[grace-expiry] Fatal error:', err);
  process.exit(1);
});
