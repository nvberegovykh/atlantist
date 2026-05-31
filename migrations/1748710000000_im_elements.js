/**
 * Migration: im_elements
 * Creates the IM (Information Modeling) tables referenced by db/im-elements.js:
 *   - im_element_types
 *   - im_type_properties
 *   - im_element_instances
 *   - im_constraints
 * Fully idempotent — CREATE TABLE IF NOT EXISTS throughout.
 */
'use strict';

module.exports = {
  name: 'im_elements',
  skipTransaction: true,

  up: async (client) => {

    // ── im_element_types ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS im_element_types (
        id                          SERIAL PRIMARY KEY,
        project_id                  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        parent_type_id              INTEGER REFERENCES im_element_types(id) ON DELETE SET NULL,
        element_category            VARCHAR(100) NOT NULL DEFAULT 'generic',
        type_name                   VARCHAR(255) NOT NULL DEFAULT 'Generic Type',
        classification_csi          VARCHAR(100),
        classification_omniclass    VARCHAR(100),
        material_id                 INTEGER,
        material_grade              VARCHAR(100),
        material_finish             VARCHAR(100),
        material_fire_rating        VARCHAR(50),
        material_thermal_conductivity FLOAT,
        structural_section          VARCHAR(100),
        aisc_table_ref              VARCHAR(100),
        d_mm                        FLOAT,
        b_f_mm                      FLOAT,
        t_f_mm                      FLOAT,
        t_w_mm                      FLOAT,
        weight_plf                  FLOAT,
        connection_type             VARCHAR(100),
        connection_plate            VARCHAR(100),
        bolt_spec                   VARCHAR(100),
        weld_type                   VARCHAR(100),
        cost_per_unit               FLOAT,
        cost_unit                   VARCHAR(50),
        vendor                      VARCHAR(255),
        lead_time_days              INTEGER DEFAULT 0,
        occupancy_classification    VARCHAR(100),
        fire_separation_distance    FLOAT,
        assembly_rating             VARCHAR(50),
        properties_json             JSONB DEFAULT '{}',
        created_at                  TIMESTAMPTZ DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_types_project ON im_element_types(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_types_category ON im_element_types(element_category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_types_parent ON im_element_types(parent_type_id) WHERE parent_type_id IS NOT NULL`);

    // ── im_type_properties ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS im_type_properties (
        id              SERIAL PRIMARY KEY,
        type_id         INTEGER NOT NULL REFERENCES im_element_types(id) ON DELETE CASCADE,
        property_key    VARCHAR(255) NOT NULL,
        property_value  JSONB DEFAULT 'null',
        override_flag   BOOLEAN DEFAULT FALSE,
        formula         TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(type_id, property_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_type_props_type ON im_type_properties(type_id)`);

    // ── im_element_instances ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS im_element_instances (
        id              SERIAL PRIMARY KEY,
        element_id      INTEGER NOT NULL UNIQUE REFERENCES elements(id) ON DELETE CASCADE,
        type_id         INTEGER REFERENCES im_element_types(id) ON DELETE SET NULL,
        override_values JSONB DEFAULT '{}',
        overridden_keys TEXT[] DEFAULT '{}',
        status          VARCHAR(50) DEFAULT 'design',
        quantity        FLOAT DEFAULT 1,
        markup_pct      FLOAT DEFAULT 0,
        markup_reason   TEXT,
        instance_cost   FLOAT,
        host_element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        host_face_u     FLOAT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_instances_type ON im_element_instances(type_id) WHERE type_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_instances_host ON im_element_instances(host_element_id) WHERE host_element_id IS NOT NULL`);

    // ── im_constraints ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS im_constraints (
        id                    SERIAL PRIMARY KEY,
        element_id            INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        constraint_key        VARCHAR(255) NOT NULL,
        constraint_category   VARCHAR(100),
        formula_expression    TEXT,
        bound_value           JSONB DEFAULT 'null',
        unit                  VARCHAR(50),
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(element_id, constraint_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_constraints_element ON im_constraints(element_id)`);

    console.log('[im_elements] IM tables created: im_element_types, im_type_properties, im_element_instances, im_constraints.');
  }
};
