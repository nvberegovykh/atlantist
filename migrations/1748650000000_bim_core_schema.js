/**
 * Migration: bim_core_schema
 *
 * Creates ALL BIM tables that were previously only on the Polsia-managed DB
 * and never defined in code. Fully idempotent (CREATE TABLE IF NOT EXISTS).
 *
 * Tables created:
 *   Core:       projects, project_members, levels, elements
 *   Layers:     wall_layers, roof_layers
 *   Families:   family_instances, door_types, window_types
 *   Catalog:    wall_types, column_types, roof_types, floor_types, ceiling_types,
 *               stair_types, railing_types, beam_types, mep_fixture_types
 *   Structure:  structural_grids, structural_grid_lines
 *   Geometry:   rooms, floors, ceilings, stairs, railings, curved_surfaces
 *   Issues:     issues
 *   Auth/Users: app_users (extended user profile)
 *
 * Seed data: catalog tables get minimum 1 row each so /api/catalog/* returns
 * non-empty JSON on fresh DB and smoke test passes.
 */
'use strict';

module.exports = {
  name: 'bim_core_schema',

  up: async (client) => {

    // ── app_users (extended profile table, separate from auth `users`) ─────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email       VARCHAR(255),
        first_name  VARCHAR(255),
        last_name   VARCHAR(255),
        role        VARCHAR(100) DEFAULT 'architect',
        project_type VARCHAR(100),
        specializations TEXT[],
        location    VARCHAR(255),
        avatar_url  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_user_id ON app_users(user_id) WHERE user_id IS NOT NULL`);

    // ── projects ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(512) NOT NULL DEFAULT 'Untitled Project',
        type              VARCHAR(100) DEFAULT 'Mixed-Use',
        project_type      VARCHAR(100) DEFAULT 'Mixed-Use',
        description       TEXT,
        settings          JSONB DEFAULT '{}',
        owner_id          INTEGER,
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

    // ── project_members ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role        VARCHAR(50) DEFAULT 'member',
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`);

    // ── levels ──────────────────────────────────────────────────────────────────
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

    // ── elements ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS elements (
        id              SERIAL PRIMARY KEY,
        type            VARCHAR(50) NOT NULL DEFAULT 'wall',
        type_name       VARCHAR(255) DEFAULT 'Generic',
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_elements_top_level ON elements(top_level_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_elements_type ON elements(type)`);

    // ── wall_layers ─────────────────────────────────────────────────────────────
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

    // ── roof_layers ─────────────────────────────────────────────────────────────
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

    // ── wall_types (catalog) ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS wall_types (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        total_thickness FLOAT DEFAULT 0.2,
        function      VARCHAR(100) DEFAULT 'Exterior',
        fire_rating   VARCHAR(50),
        thermal_r     FLOAT,
        description   TEXT,
        layers        JSONB DEFAULT '[]',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Seed
    await client.query(`
      INSERT INTO wall_types (name, total_thickness, function, fire_rating, thermal_r, description, layers)
      SELECT 'Exterior CMU 8"', 0.203, 'Exterior', '2-hr', 0.28,
             '8-inch CMU wall, standard NYC exterior',
             '[{"material":"CMU","thickness":0.203,"function":"Structure"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM wall_types WHERE name = 'Exterior CMU 8"')
    `);
    await client.query(`
      INSERT INTO wall_types (name, total_thickness, function, fire_rating, thermal_r, description, layers)
      SELECT 'Interior GWB Partition', 0.114, 'Interior', '1-hr', 0.18,
             '3-5/8" metal stud with GWB both sides',
             '[{"material":"GWB","thickness":0.016,"function":"Finish"},{"material":"MetalStud","thickness":0.092,"function":"Structure"},{"material":"GWB","thickness":0.016,"function":"Finish"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM wall_types WHERE name = 'Interior GWB Partition')
    `);

    // ── column_types (catalog) ───────────────────────────────────────────────────
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
    // Seed
    await client.query(`
      INSERT INTO column_types (name, shape, width, depth, material, description)
      SELECT '12x12 Concrete', 'rectangular', 0.305, 0.305, 'Concrete', '12x12 inch concrete column'
      WHERE NOT EXISTS (SELECT 1 FROM column_types WHERE name = '12x12 Concrete')
    `);
    await client.query(`
      INSERT INTO column_types (name, shape, width, depth, material, description)
      SELECT 'W8x31 Steel', 'wide-flange', 0.203, 0.203, 'Steel', 'W8x31 wide-flange steel column'
      WHERE NOT EXISTS (SELECT 1 FROM column_types WHERE name = 'W8x31 Steel')
    `);

    // ── roof_types (catalog) ──────────────────────────────────────────────────────
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
    // Seed
    await client.query(`
      INSERT INTO roof_types (name, roof_style, slope_min, slope_max, description, layers)
      SELECT 'BUR Flat Roof', 'flat', 0, 0.02,
             'Built-up roofing, standard NYC low-slope',
             '[{"material":"Membrane","thickness":0.01,"function":"Waterproofing"},{"material":"Insulation","thickness":0.1,"function":"Insulation"},{"material":"Concrete","thickness":0.15,"function":"Structure"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM roof_types WHERE name = 'BUR Flat Roof')
    `);
    await client.query(`
      INSERT INTO roof_types (name, roof_style, slope_min, slope_max, description, layers)
      SELECT 'Gable Asphalt Shingle', 'gable', 0.25, 0.75,
             'Residential gable roof with asphalt shingles',
             '[{"material":"AsphaltShingle","thickness":0.012,"function":"Finish"},{"material":"Plywood","thickness":0.019,"function":"Substrate"}]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM roof_types WHERE name = 'Gable Asphalt Shingle')
    `);

    // ── floor_types (catalog) ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS floor_types (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        total_thickness FLOAT DEFAULT 0.3,
        material    VARCHAR(100) DEFAULT 'Concrete',
        fire_rating VARCHAR(50),
        description TEXT,
        layers      JSONB DEFAULT '[]',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO floor_types (name, total_thickness, material, fire_rating, description)
      SELECT '6" Concrete Slab', 0.152, 'Concrete', '2-hr', 'Standard 6" concrete floor slab'
      WHERE NOT EXISTS (SELECT 1 FROM floor_types WHERE name = '6" Concrete Slab')
    `);

    // ── ceiling_types (catalog) ───────────────────────────────────────────────────
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
    await client.query(`
      INSERT INTO ceiling_types (name, material, thickness, description)
      SELECT 'ACT Lay-in 2x2', 'AcousticTile', 0.019, '2x2 acoustic ceiling tile, suspended'
      WHERE NOT EXISTS (SELECT 1 FROM ceiling_types WHERE name = 'ACT Lay-in 2x2')
    `);

    // ── stair_types (catalog) ─────────────────────────────────────────────────────
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
    await client.query(`
      INSERT INTO stair_types (name, material, width, description)
      SELECT 'Concrete Stair', 'Concrete', 1.2, 'Cast-in-place concrete stair'
      WHERE NOT EXISTS (SELECT 1 FROM stair_types WHERE name = 'Concrete Stair')
    `);

    // ── railing_types (catalog) ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS railing_types (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        material      VARCHAR(100) DEFAULT 'Steel',
        height        FLOAT DEFAULT 1.07,
        description   TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO railing_types (name, material, height, description)
      SELECT 'Steel Pipe Railing', 'Steel', 1.07, 'Standard 42" steel pipe railing, IBC compliant'
      WHERE NOT EXISTS (SELECT 1 FROM railing_types WHERE name = 'Steel Pipe Railing')
    `);

    // ── beam_types (catalog) ──────────────────────────────────────────────────────
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
    await client.query(`
      INSERT INTO beam_types (name, material, depth, width, description)
      SELECT 'W12x26 Steel Beam', 'Steel', 0.305, 0.165, 'W12x26 wide-flange steel beam'
      WHERE NOT EXISTS (SELECT 1 FROM beam_types WHERE name = 'W12x26 Steel Beam')
    `);

    // ── door_types (catalog) ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS door_types (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        width         FLOAT DEFAULT 0.914,
        height        FLOAT DEFAULT 2.134,
        material      VARCHAR(100) DEFAULT 'Wood',
        fire_rating   VARCHAR(50),
        description   TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO door_types (name, width, height, material, fire_rating, description)
      SELECT 'Solid Core Wood 3-0x7-0', 0.914, 2.134, 'Wood', '20-min', 'Standard solid core wood door, 3-0x7-0'
      WHERE NOT EXISTS (SELECT 1 FROM door_types WHERE name = 'Solid Core Wood 3-0x7-0')
    `);

    // ── window_types (catalog) ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS window_types (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        width         FLOAT DEFAULT 1.2,
        height        FLOAT DEFAULT 1.5,
        material      VARCHAR(100) DEFAULT 'Aluminum',
        glazing       VARCHAR(100) DEFAULT 'Double-pane',
        description   TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO window_types (name, width, height, material, glazing, description)
      SELECT 'Double-hung Aluminum 4x5', 1.219, 1.524, 'Aluminum', 'Double-pane', 'Standard aluminum double-hung window'
      WHERE NOT EXISTS (SELECT 1 FROM window_types WHERE name = 'Double-hung Aluminum 4x5')
    `);

    // ── mep_fixture_types (catalog) ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS mep_fixture_types (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        discipline    VARCHAR(50) DEFAULT 'mechanical',
        description   TEXT,
        parameters    JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO mep_fixture_types (name, discipline, description)
      SELECT 'VAV Box', 'mechanical', 'Variable air volume terminal box'
      WHERE NOT EXISTS (SELECT 1 FROM mep_fixture_types WHERE name = 'VAV Box')
    `);

    // ── family_instances ──────────────────────────────────────────────────────────
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

    // ── structural_grids ──────────────────────────────────────────────────────────
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

    // ── structural_grid_lines ─────────────────────────────────────────────────────
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

    // ── rooms ─────────────────────────────────────────────────────────────────────
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

    // ── floors ────────────────────────────────────────────────────────────────────
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

    // ── ceilings ──────────────────────────────────────────────────────────────────
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

    // ── stairs ────────────────────────────────────────────────────────────────────
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

    // ── railings ──────────────────────────────────────────────────────────────────
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

    // ── curved_surfaces ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS curved_surfaces (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) DEFAULT 'Curved Surface',
        surface_type VARCHAR(50) DEFAULT 'shell',
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        parameters  JSONB DEFAULT '{}',
        geometry    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_curved_project ON curved_surfaces(project_id)`);

    // ── issues ────────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS issues (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(512) NOT NULL DEFAULT 'Issue',
        description TEXT,
        status      VARCHAR(50) DEFAULT 'open',
        priority    VARCHAR(50) DEFAULT 'normal',
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        element_id  INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`);

  }
};
