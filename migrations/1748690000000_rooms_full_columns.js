/**
 * Migration: patch rooms, floors, ceilings, projects, app_users
 *
 * Adds all columns used by routes but missing from older DB schema.
 * Also ensures app_users.session_uuid exists (critical for anon auth).
 */
module.exports = {
  name: '1748690000000_rooms_full_columns',
  skipTransaction: true,
  up: async (client) => {
    // ── rooms — add all columns used in INSERT/UPDATE queries
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area_sqm       FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS volume_cum     FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS department     VARCHAR(255)`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor_finish   VARCHAR(255)`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS wall_finish    VARCHAR(255)`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ceiling_finish VARCHAR(255)`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS base_finish    VARCHAR(255)`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS perimeter_m    FLOAT`);

    // ── floors — ensure all columns used in routes/floors.js exist
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS area_sqm      FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS thickness     FLOAT DEFAULT 0.15`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS position_x    FLOAT`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS position_y    FLOAT`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS elevation     FLOAT`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS layers        JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS boundary      JSONB`);

    // ── ceilings — ensure all columns used in routes/ceilings.js exist
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS layers      JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS boundary    JSONB`);
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS thickness   FLOAT DEFAULT 0.1`);

    // ── projects — ensure last_opened_at exists for entry-screen sort
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ`);

    // ── app_users — ensure ALL columns exist (CREATE TABLE IF NOT EXISTS is a no-op on existing tables)
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS session_uuid          VARCHAR(36)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS billing_state         VARCHAR(50) DEFAULT 'beta_free'`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_active           TIMESTAMPTZ DEFAULT NOW()`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS onboarding_checklist  JSONB DEFAULT '{}'`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verified        BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS onboarding_complete   BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS first_name            VARCHAR(255)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS project_type          VARCHAR(100)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role                  VARCHAR(100) DEFAULT 'Architect'`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS specializations       JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS location              VARCHAR(255)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW()`);

    // UNIQUE constraint on session_uuid — safe if already exists
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'app_users_session_uuid_key'
        ) THEN
          ALTER TABLE app_users ADD CONSTRAINT app_users_session_uuid_key UNIQUE (session_uuid);
        END IF;
      END $$
    `);

    await client.query(`UPDATE app_users SET billing_state = 'beta_free' WHERE billing_state IS NULL`);

    console.log('[1748690000000] rooms/floors/ceilings/projects/app_users patched.');
  }
};
