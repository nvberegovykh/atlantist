/**
 * Migration: patch rooms table with all columns used by routes/rooms.js
 * and fix rooms.project_id to support VARCHAR project IDs (UUID-style projects).
 *
 * Also patches floors and ceilings with missing columns.
 */
exports.up = async (client) => {
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

  // ── app_users — ensure billing_state default exists  
  await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS billing_state VARCHAR(50) DEFAULT 'beta_free'`);
  await client.query(`UPDATE app_users SET billing_state = 'beta_free' WHERE billing_state IS NULL`);
};

exports.config = { transaction: false };
