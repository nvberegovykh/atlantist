/**
 * Migration: patch_missing_columns
 *
 * Adds columns that exist in the codebase but were missing from the old Polsia DB schema.
 * All statements use ADD COLUMN IF NOT EXISTS — safe to run multiple times.
 */
'use strict';

module.exports = {
  name: 'patch_missing_columns',
  skipTransaction: true,

  up: async (client) => {

    // ── floors — db/floors.js uses base_level_id, top_level_id, area_sqm, thickness, position_x/y, elevation
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS base_level_id INTEGER REFERENCES levels(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS top_level_id  INTEGER REFERENCES levels(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS area_sqm      FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS thickness     FLOAT DEFAULT 0.2`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS position_x    FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS position_y    FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS elevation     FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE floors ADD COLUMN IF NOT EXISTS computed      JSONB DEFAULT '{}'`);

    // ── ceilings — db/ceilings.js uses host_level_id, room_id, elevation_offset, ceiling_type, slope_direction
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS host_level_id    INTEGER REFERENCES levels(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS room_id          INTEGER`);
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS elevation_offset FLOAT DEFAULT 2.7`);
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS ceiling_type     VARCHAR(50) DEFAULT 'flat'`);
    await client.query(`ALTER TABLE ceilings ADD COLUMN IF NOT EXISTS slope_direction  VARCHAR(50)`);

    // ── rooms — ensure area, volume present
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area   FLOAT DEFAULT 0`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS volume FLOAT DEFAULT 0`);

    // ── curved_surfaces — db/curved-surfaces.js uses base_level_id, top_level_id, geometry
    await client.query(`ALTER TABLE curved_surfaces ADD COLUMN IF NOT EXISTS base_level_id INTEGER REFERENCES levels(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE curved_surfaces ADD COLUMN IF NOT EXISTS top_level_id  INTEGER REFERENCES levels(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE curved_surfaces ADD COLUMN IF NOT EXISTS geometry      JSONB DEFAULT '{}'`);

    // ── stairs — db/stairs.js uses base_level_id, top_level_id
    await client.query(`ALTER TABLE stairs ADD COLUMN IF NOT EXISTS base_level_id INTEGER REFERENCES levels(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE stairs ADD COLUMN IF NOT EXISTS top_level_id  INTEGER REFERENCES levels(id) ON DELETE SET NULL`);

    // ── elements — ensure ifc columns exist (used in RVT import)
    await client.query(`ALTER TABLE elements ADD COLUMN IF NOT EXISTS ifc_global_id  VARCHAR(255)`);
    await client.query(`ALTER TABLE elements ADD COLUMN IF NOT EXISTS ifc_entity_id  VARCHAR(255)`);
    await client.query(`ALTER TABLE elements ADD COLUMN IF NOT EXISTS ifc_type       VARCHAR(100)`);
    await client.query(`ALTER TABLE elements ADD COLUMN IF NOT EXISTS name           VARCHAR(255)`);

    // ── levels — ensure columns used in BIM exist
    await client.query(`ALTER TABLE levels ADD COLUMN IF NOT EXISTS is_building_storey BOOLEAN DEFAULT TRUE`);
    await client.query(`ALTER TABLE levels ADD COLUMN IF NOT EXISTS computed            JSONB DEFAULT '{}'`);

    // ── projects — ensure last_opened_at exists (used in touch endpoint)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ`);

    // ── app_users — ensure all columns exist
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS specializations      JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS location             VARCHAR(255)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS first_name           VARCHAR(255)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS project_type         VARCHAR(100)`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role                 VARCHAR(100) DEFAULT 'Architect'`);
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW()`);

    console.log('[patch_missing_columns] All column patches applied.');
  }
};
