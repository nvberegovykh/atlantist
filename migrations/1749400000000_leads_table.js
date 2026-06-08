/**
 * Create leads table for tracking registration + marketing leads.
 * Non-critical — magic link flow must work even if this fails.
 * Using skipTransaction: true so a failure here doesn't abort the whole migration.
 */
'use strict';

module.exports = {
  name: 'leads_table',
  skipTransaction: true,

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id                SERIAL PRIMARY KEY,
        email             VARCHAR(255) NOT NULL UNIQUE,
        source            VARCHAR(100),
        name              VARCHAR(255),
        company           VARCHAR(255),
        phone             VARCHAR(50),
        tier              VARCHAR(50) DEFAULT 'new',
        engagement_score  INTEGER DEFAULT 0,
        consent_given     BOOLEAN DEFAULT FALSE,
        consent_timestamp TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)
    `);
    console.log('[leads_table] leads table created (or already exists)');
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS leads');
  }
};
