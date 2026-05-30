/**
 * db/app-events.js — Owns: write-only telemetry for frontend app_events table.
 * Does NOT own: analytics queries (admin only), user sessions, or billing.
 */

const pool = require('./index');

/**
 * Insert a single event row. Fire-and-forget — errors are swallowed so event
 * logging never breaks product flows.
 */
async function insertEvent({ event_name, session_uuid, user_id, properties, url, referrer, user_agent, ip }) {
  try {
    await pool.query(
      `INSERT INTO app_events (event_name, session_uuid, user_id, properties, url, referrer, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet)`,
      [
        event_name,
        session_uuid || null,
        user_id || null,
        JSON.stringify(properties || {}),
        url || null,
        referrer || null,
        user_agent || null,
        ip || null,
      ]
    );
  } catch (_) {
    // Non-fatal — telemetry must not break product flows
  }
}

module.exports = { insertEvent };
