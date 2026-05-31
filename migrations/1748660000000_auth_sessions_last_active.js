/**
 * Migration: auth_sessions_last_active
 * Adds last_active column to auth_sessions table (was missing from initial schema).
 */
module.exports = {
  name: 'auth_sessions_last_active',
  skipTransaction: true,
  up: async (client) => {
    await client.query(`
      ALTER TABLE auth_sessions
      ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ DEFAULT NOW()
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_last_active
      ON auth_sessions(last_active DESC)
    `);
  }
};
