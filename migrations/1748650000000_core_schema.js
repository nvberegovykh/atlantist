/**
 * Migration: core_schema
 *
 * Creates ALL application tables that were on the old Polsia DB but never
 * defined in code. Fully idempotent — CREATE TABLE IF NOT EXISTS throughout.
 *
 * Order matters for FK dependencies:
 *   1. app_users (standalone — session-based, no FK to `users`)
 *   2. auth_sessions → app_users
 *   3. projects → app_users (owner_id)
 *   4. project_members → projects, app_users
 *   5. levels → projects
 *   6. elements → projects, levels
 *   7. wall_layers, roof_layers → elements
 *   8. Catalog tables (no FKs)
 *   9. family_instances → elements
 *  10. Geometry: rooms, floors, ceilings, stairs, railings, curved_surfaces → projects/levels
 *  11. Structural: grids, grid_lines, members, analysis_runs → projects/elements
 *  12. MEP: mep_elements, mep_simulation_runs → projects/levels
 *  13. Energy: energy_simulations → projects
 *  14. Runtime: annotations, dag_edges, event_ledger, viewport_states,
 *               app_events, user_integrations → projects/app_users/elements
 *  15. Issues → projects/elements/app_users
 *  16. Demo seed data
 */
'use strict';

module.exports = {
  name: 'core_schema',

  up: async (client) => {

    // ── 1. app_users — primary user table (session-based, no FK to `users`) ───
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id                    SERIAL PRIMARY KEY,
        session_uuid          VARCHAR(36) UNIQUE,
        email                 VARCHAR(255),
        first_name            VARCHAR(255),
        project_type          VARCHAR(100),
        role                  VARCHAR(100) DEFAULT 'Architect',
        specializations       JSONB DEFAULT '[]',
        location              VARCHAR(255),
        email_verified        BOOLEAN DEFAULT FALSE,
        onboarding_complete   BOOLEAN DEFAULT FALSE,
        onboarding_checklist  JSONB DEFAULT '{}',
        billing_state         VARCHAR(50) DEFAULT 'beta_free', -- dev: all users free until release
        last_active           TIMESTAMPTZ DEFAULT NOW(),
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email) WHERE email IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_users_last_active ON app_users(last_active DESC)`);

    // ── 2. auth_sessions → app_users ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        token_hash  VARCHAR(512) NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add last_active defensively — table may already exist without it
    await client.query(`ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ DEFAULT NOW()`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)`);

    // ── email_verification_tokens ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        token       VARCHAR(512) NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
        used        BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── magic_tokens ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS magic_tokens (
        id           SERIAL PRIMARY KEY,
        email        VARCHAR(255) NOT NULL,
        token        VARCHAR(512) NOT NULL,
        session_uuid VARCHAR(36),
        expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
        used         BOOLEAN DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_tokens_token ON magic_tokens(token)`);

    // ── app_roles ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_roles (
        id      SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
        role    VARCHAR(50) NOT NULL DEFAULT 'user'
      )
    `);

    // ── 3. projects → app_users ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(512) NOT NULL DEFAULT 'Untitled Project',
        type              VARCHAR(100) DEFAULT 'Mixed-Use',
        project_type      VARCHAR(100) DEFAULT 'Mixed-Use',
        description       TEXT,
        settings          JSONB DEFAULT '{}',
        owner_id          INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        is_template       BOOLEAN DEFAULT FALSE,
        is_demo           BOOLEAN DEFAULT FALSE,
        demo_slug         VARCHAR(255),
        archived          BOOLEAN DEFAULT FALSE,
        filing_status     VARCHAR(100),
        inspector_notes   TEXT,
        seismic_category  VARCHAR(50),
        building_code     VARCHAR(100),
        jurisdiction      VARCHAR(255),
        last_opened_at    TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_demo_slug ON projects(demo_slug) WHERE demo_slug IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id) WHERE owner_id IS NOT NULL`);

    // ── 4. project_members → projects, app_users ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        role        VARCHAR(50) DEFAULT 'member',
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`);

    // ── invites ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email       VARCHAR(255) NOT NULL,
        role        VARCHAR(50) DEFAULT 'member',
        token       VARCHAR(512) NOT NULL,
        accepted    BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token ON invites(token)`);

    // ── 5. levels → projects ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS levels (
        id                  SERIAL PRIMARY KEY,
        name                VARCHAR(255) NOT NULL DEFAULT 'Level 1',
        elevation           FLOAT NOT NULL DEFAULT 0,
        is_building_storey  BOOLEAN DEFAULT TRUE,
        phase               VARCHAR(100) DEFAULT 'New Construction',
        project_id          INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_levels_project ON levels(project_id)`);

    // ── 6. elements → projects, levels ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS elements (
        id              SERIAL PRIMARY KEY,
        type            VARCHAR(50) NOT NULL DEFAULT 'wall',
        type_name       VARCHAR(255) DEFAULT 'Generic',
        name            VARCHAR(255),
        parameters      JSONB DEFAULT '{}',
        computed        JSONB DEFAULT '{}',
        base_level_id   INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        top_level_id    INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        ifc_global_id   VARCHAR(255),
        ifc_entity_id   VARCHAR(255),
        ifc_type        VARCHAR(100),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_elements_project ON elements(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_elements_base_level ON elements(base_level_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_elements_type ON elements(type)`);

    // ── 7. wall_layers, roof_layers → elements ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS wall_layers (
        id                      SERIAL PRIMARY KEY,
        element_id              INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        layer_order             INTEGER NOT NULL DEFAULT 0,
        material                VARCHAR(255) DEFAULT 'Concrete',
        thickness               FLOAT DEFAULT 0.2,
        function                VARCHAR(100) DEFAULT 'Structure',
        thickness_before_drawing BOOLEAN DEFAULT FALSE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wall_layers_element ON wall_layers(element_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS roof_layers (
        id                      SERIAL PRIMARY KEY,
        element_id              INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        layer_order             INTEGER NOT NULL DEFAULT 0,
        material                VARCHAR(255) DEFAULT 'Concrete',
        thickness               FLOAT DEFAULT 0.1,
        function                VARCHAR(100) DEFAULT 'Structure',
        thickness_before_drawing BOOLEAN DEFAULT FALSE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_roof_layers_element ON roof_layers(element_id)`);

    // ── floor_layers, ceiling_layers ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS floor_layers (
        id          SERIAL PRIMARY KEY,
        element_id  INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        layer_order INTEGER NOT NULL DEFAULT 0,
        material    VARCHAR(255) DEFAULT 'Concrete',
        thickness   FLOAT DEFAULT 0.15,
        function    VARCHAR(100) DEFAULT 'Structure'
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ceiling_layers (
        id          SERIAL PRIMARY KEY,
        element_id  INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        layer_order INTEGER NOT NULL DEFAULT 0,
        material    VARCHAR(255) DEFAULT 'GWB',
        thickness   FLOAT DEFAULT 0.016,
        function    VARCHAR(100) DEFAULT 'Finish'
      )
    `);

    // ── 8. Catalog tables (no FK dependencies) ────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS wall_types (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(255) NOT NULL,
        total_thickness FLOAT DEFAULT 0.2,
        function        VARCHAR(100) DEFAULT 'Exterior',
        fire_rating     VARCHAR(50),
        thermal_r       FLOAT,
        description     TEXT,
        layers          JSONB DEFAULT '[]',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO wall_types (name, total_thickness, function, fire_rating, thermal_r, description, layers)
      SELECT 'Exterior CMU 8"', 0.203, 'Exterior', '2-hr', 0.28, '8-inch CMU wall',
             '[{"material":"CMU","thickness":0.203,"function":"Structure"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM wall_types WHERE name = 'Exterior CMU 8"')`);
    await client.query(`INSERT INTO wall_types (name, total_thickness, function, fire_rating, thermal_r, description, layers)
      SELECT 'Interior GWB Partition', 0.114, 'Interior', '1-hr', 0.18, '3-5/8" metal stud + GWB',
             '[{"material":"GWB","thickness":0.016,"function":"Finish"},{"material":"MetalStud","thickness":0.092,"function":"Structure"},{"material":"GWB","thickness":0.016,"function":"Finish"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM wall_types WHERE name = 'Interior GWB Partition')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS column_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        shape       VARCHAR(50) DEFAULT 'rectangular',
        width       FLOAT DEFAULT 0.3,
        depth       FLOAT DEFAULT 0.3,
        material    VARCHAR(100) DEFAULT 'Concrete',
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO column_types (name, shape, width, depth, material, description)
      SELECT '12x12 Concrete', 'rectangular', 0.305, 0.305, 'Concrete', '12x12 inch concrete column'
      WHERE NOT EXISTS (SELECT 1 FROM column_types WHERE name = '12x12 Concrete')`);
    await client.query(`INSERT INTO column_types (name, shape, width, depth, material, description)
      SELECT 'W14x48 Steel', 'wide-flange', 0.360, 0.203, 'Steel', 'W14x48 wide-flange column'
      WHERE NOT EXISTS (SELECT 1 FROM column_types WHERE name = 'W14x48 Steel')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS roof_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        roof_style  VARCHAR(100) DEFAULT 'flat',
        slope_min   FLOAT DEFAULT 0,
        slope_max   FLOAT DEFAULT 0.5,
        description TEXT,
        layers      JSONB DEFAULT '[]',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO roof_types (name, roof_style, slope_min, slope_max, description, layers)
      SELECT 'BUR Flat Roof', 'flat', 0, 0.02, 'Built-up roofing, standard NYC low-slope',
             '[{"material":"Membrane","thickness":0.01,"function":"Waterproofing"},{"material":"Insulation","thickness":0.1,"function":"Insulation"},{"material":"Concrete","thickness":0.15,"function":"Structure"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM roof_types WHERE name = 'BUR Flat Roof')`);
    await client.query(`INSERT INTO roof_types (name, roof_style, slope_min, slope_max, description, layers)
      SELECT 'Gable Asphalt Shingle', 'gable', 0.25, 0.75, 'Residential gable with asphalt shingles',
             '[{"material":"AsphaltShingle","thickness":0.012,"function":"Finish"},{"material":"Plywood","thickness":0.019,"function":"Substrate"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM roof_types WHERE name = 'Gable Asphalt Shingle')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS floor_types (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(255) NOT NULL,
        total_thickness FLOAT DEFAULT 0.3,
        material        VARCHAR(100) DEFAULT 'Concrete',
        fire_rating     VARCHAR(50),
        description     TEXT,
        layers          JSONB DEFAULT '[]',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO floor_types (name, total_thickness, material, fire_rating, description)
      SELECT '6" Concrete Slab', 0.152, 'Concrete', '2-hr', 'Standard 6" concrete slab'
      WHERE NOT EXISTS (SELECT 1 FROM floor_types WHERE name = '6" Concrete Slab')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ceiling_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        material    VARCHAR(100) DEFAULT 'GWB',
        thickness   FLOAT DEFAULT 0.016,
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO ceiling_types (name, material, thickness, description)
      SELECT 'ACT Lay-in 2x2', 'AcousticTile', 0.019, '2x2 acoustic ceiling tile'
      WHERE NOT EXISTS (SELECT 1 FROM ceiling_types WHERE name = 'ACT Lay-in 2x2')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stair_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        material    VARCHAR(100) DEFAULT 'Concrete',
        width       FLOAT DEFAULT 1.2,
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO stair_types (name, material, width, description)
      SELECT 'Concrete Stair', 'Concrete', 1.2, 'Cast-in-place concrete stair'
      WHERE NOT EXISTS (SELECT 1 FROM stair_types WHERE name = 'Concrete Stair')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS railing_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        material    VARCHAR(100) DEFAULT 'Steel',
        height      FLOAT DEFAULT 1.07,
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO railing_types (name, material, height, description)
      SELECT 'Steel Pipe Railing', 'Steel', 1.07, '42" steel pipe railing, IBC compliant'
      WHERE NOT EXISTS (SELECT 1 FROM railing_types WHERE name = 'Steel Pipe Railing')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS beam_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        material    VARCHAR(100) DEFAULT 'Steel',
        depth       FLOAT DEFAULT 0.25,
        width       FLOAT DEFAULT 0.1,
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO beam_types (name, material, depth, width, description)
      SELECT 'W12x26 Steel Beam', 'Steel', 0.305, 0.165, 'W12x26 wide-flange beam'
      WHERE NOT EXISTS (SELECT 1 FROM beam_types WHERE name = 'W12x26 Steel Beam')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS door_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        width       FLOAT DEFAULT 0.914,
        height      FLOAT DEFAULT 2.134,
        material    VARCHAR(100) DEFAULT 'Wood',
        fire_rating VARCHAR(50),
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO door_types (name, width, height, material, fire_rating, description)
      SELECT 'Solid Core Wood 3-0x7-0', 0.914, 2.134, 'Wood', '20-min', 'Standard solid core wood door'
      WHERE NOT EXISTS (SELECT 1 FROM door_types WHERE name = 'Solid Core Wood 3-0x7-0')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS window_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        width       FLOAT DEFAULT 1.2,
        height      FLOAT DEFAULT 1.5,
        material    VARCHAR(100) DEFAULT 'Aluminum',
        glazing     VARCHAR(100) DEFAULT 'Double-pane',
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO window_types (name, width, height, material, glazing, description)
      SELECT 'Double-hung Aluminum 4x5', 1.219, 1.524, 'Aluminum', 'Double-pane', 'Aluminum double-hung window'
      WHERE NOT EXISTS (SELECT 1 FROM window_types WHERE name = 'Double-hung Aluminum 4x5')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mep_fixture_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        discipline  VARCHAR(50) DEFAULT 'mechanical',
        description TEXT,
        parameters  JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO mep_fixture_types (name, discipline, description)
      SELECT 'VAV Box', 'mechanical', 'Variable air volume terminal box'
      WHERE NOT EXISTS (SELECT 1 FROM mep_fixture_types WHERE name = 'VAV Box')`);

    // ── 9. family_instances → elements ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS family_instances (
        id              SERIAL PRIMARY KEY,
        family_type     VARCHAR(50) NOT NULL DEFAULT 'door',
        type_name       VARCHAR(255) DEFAULT 'Generic',
        host_wall_id    INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        host_face_u     FLOAT DEFAULT 0.5,
        mark            VARCHAR(50),
        parameters      JSONB DEFAULT '{}',
        computed        JSONB DEFAULT '{}',
        ifc_global_id   VARCHAR(255),
        ifc_entity_id   VARCHAR(255),
        ifc_type        VARCHAR(100),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_family_inst_wall ON family_instances(host_wall_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_family_inst_type ON family_instances(family_type)`);

    // ── 10. Geometry tables → projects, levels ────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) DEFAULT 'Room',
        number      VARCHAR(50),
        area        FLOAT,
        volume      FLOAT,
        level_id    INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        parameters  JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rooms_project ON rooms(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS floors (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) DEFAULT 'Floor',
        type_name   VARCHAR(255),
        level_id    INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        parameters  JSONB DEFAULT '{}',
        computed    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_floors_project ON floors(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ceilings (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) DEFAULT 'Ceiling',
        type_name   VARCHAR(255),
        level_id    INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        height      FLOAT DEFAULT 2.7,
        parameters  JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ceilings_project ON ceilings(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stairs (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(255) DEFAULT 'Stair',
        stair_type        VARCHAR(50) DEFAULT 'straight',
        base_level_id     INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        top_level_id      INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        width             FLOAT DEFAULT 1.2,
        number_of_risers  INTEGER DEFAULT 12,
        number_of_treads  INTEGER DEFAULT 11,
        tread_depth       FLOAT DEFAULT 0.28,
        landing_width     FLOAT DEFAULT 1.2,
        flight_count      INTEGER DEFAULT 1,
        position_x        FLOAT DEFAULT 0,
        position_y        FLOAT DEFAULT 0,
        rotation_degrees  FLOAT DEFAULT 0,
        material          VARCHAR(100) DEFAULT 'Concrete',
        total_rise        FLOAT DEFAULT 3.0,
        riser_height      FLOAT DEFAULT 0.178,
        going             FLOAT DEFAULT 0.28,
        slope_degrees     FLOAT DEFAULT 32,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stairs_project ON stairs(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS railings (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(255) DEFAULT 'Railing',
        host_stair_id     INTEGER REFERENCES stairs(id) ON DELETE CASCADE,
        project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        railing_type      VARCHAR(50) DEFAULT 'pipe',
        height            FLOAT DEFAULT 1.07,
        top_rail_width    FLOAT DEFAULT 0.05,
        baluster_spacing  FLOAT DEFAULT 0.1,
        glass_thickness   FLOAT,
        side              VARCHAR(10) DEFAULT 'both',
        material          VARCHAR(100) DEFAULT 'Steel',
        glass_finish      VARCHAR(100),
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_railings_project ON railings(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS curved_surfaces (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(255) DEFAULT 'Curved Surface',
        surface_type VARCHAR(50) DEFAULT 'shell',
        project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        parameters   JSONB DEFAULT '{}',
        geometry     JSONB DEFAULT '{}',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_curved_project ON curved_surfaces(project_id)`);

    // ── 11. Structural ────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS structural_grids (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(255) DEFAULT 'Grid A',
        system_type     VARCHAR(50) DEFAULT 'rectangular',
        origin_x        FLOAT DEFAULT 0,
        origin_z        FLOAT DEFAULT 0,
        spacing_x       FLOAT DEFAULT 5,
        spacing_z       FLOAT DEFAULT 5,
        bubble_visible  BOOLEAN DEFAULT TRUE,
        project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_struct_grids_project ON structural_grids(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS structural_grid_lines (
        id          SERIAL PRIMARY KEY,
        grid_id     INTEGER NOT NULL REFERENCES structural_grids(id) ON DELETE CASCADE,
        axis        VARCHAR(1) DEFAULT 'X',
        label       VARCHAR(50),
        coordinate  FLOAT DEFAULT 0,
        bubble_end_a BOOLEAN DEFAULT TRUE,
        bubble_end_b BOOLEAN DEFAULT FALSE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_grid_lines_grid ON structural_grid_lines(grid_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS structural_members (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        name        VARCHAR(255) DEFAULT 'Member',
        member_type VARCHAR(50) DEFAULT 'beam',
        section     VARCHAR(100),
        material    VARCHAR(100) DEFAULT 'Steel',
        start_node  JSONB DEFAULT '{}',
        end_node    JSONB DEFAULT '{}',
        parameters  JSONB DEFAULT '{}',
        element_id  INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_struct_members_project ON structural_members(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS structural_analysis_runs (
        id              SERIAL PRIMARY KEY,
        project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        member_results  JSONB DEFAULT '{}',
        code_checks     JSONB DEFAULT '{}',
        status          VARCHAR(50) DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_struct_runs_project ON structural_analysis_runs(project_id)`);

    // ── 12. MEP ───────────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS mep_elements (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        discipline  VARCHAR(50) DEFAULT 'mechanical',
        type_name   VARCHAR(255),
        level_id    INTEGER REFERENCES levels(id) ON DELETE SET NULL,
        parameters  JSONB DEFAULT '{}',
        geometry    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mep_elements_project ON mep_elements(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mep_simulation_runs (
        id                  SERIAL PRIMARY KEY,
        project_id          INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        hvac_results        JSONB DEFAULT '{}',
        plumbing_results    JSONB DEFAULT '{}',
        electrical_results  JSONB DEFAULT '{}',
        status              VARCHAR(50) DEFAULT 'pending',
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mep_runs_project ON mep_simulation_runs(project_id)`);

    // ── 13. Energy ────────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS energy_simulations (
        id                SERIAL PRIMARY KEY,
        project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        model_snapshot    JSONB DEFAULT '{}',
        gbxml             TEXT,
        idf_text          TEXT,
        results           JSONB DEFAULT '{}',
        compliance        JSONB DEFAULT '{}',
        status            VARCHAR(50) DEFAULT 'pending',
        en1_workbook_data JSONB DEFAULT '{}',
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_energy_sim_project ON energy_simulations(project_id)`);

    // ── 14. Runtime tables ────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS annotations (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        element_id  INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        user_id     INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        type        VARCHAR(50) DEFAULT 'note',
        content     TEXT DEFAULT '',
        position    JSONB DEFAULT '{}',
        resolved    BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dag_edges (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        from_id     INTEGER REFERENCES elements(id) ON DELETE CASCADE,
        to_id       INTEGER REFERENCES elements(id) ON DELETE CASCADE,
        edge_type   VARCHAR(50) DEFAULT 'constraint',
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dag_edges_project ON dag_edges(project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_ledger (
        id          BIGSERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        event_type  VARCHAR(100) NOT NULL,
        entity_type VARCHAR(100),
        entity_id   INTEGER,
        payload     JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_ledger_project ON event_ledger(project_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_events (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        event_type  VARCHAR(100) NOT NULL,
        payload     JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_events_user ON app_events(user_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_integrations (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        provider      VARCHAR(100) NOT NULL,
        token         TEXT,
        refresh_token TEXT,
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, provider)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS viewport_states (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        state       JSONB DEFAULT '{}',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, project_id)
      )
    `);

    // ── 15. Issues ────────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS issues (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(512) NOT NULL DEFAULT 'Issue',
        description TEXT,
        status      VARCHAR(50) DEFAULT 'open',
        priority    VARCHAR(50) DEFAULT 'normal',
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        element_id  INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        created_by  INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        assigned_to INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id)`);

    // ── 16. Demo project seed ─────────────────────────────────────────────────
    await client.query(`
      INSERT INTO projects (
        name, type, project_type, description, demo_slug, is_demo,
        is_template, archived, settings, created_at, updated_at
      )
      SELECT
        '425 W 34th St — 10-Story NYC Mid-Rise',
        'Commercial', 'Commercial',
        'A pre-loaded 10-story Manhattan mid-rise BIM project demonstrating architecture, structure, MEP, energy analysis, and DOB filing.',
        'nyc-midrise', TRUE, FALSE, FALSE,
        '{"level_count":10,"typical_floor_height":3.658,"construction_type":"Steel Frame"}'::jsonb,
        NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM projects WHERE demo_slug = 'nyc-midrise')
    `);

  }
};
