// Owns: drawing_sheets, sheet_viewports, title_blocks queries
// Does NOT own: design book metadata (read-only via db/design-book.js), PDF file storage
const pool = require('./index');

// ── Default DOB sheet index ───────────────────────────────────────────────

const DEFAULT_SHEETS = [
  { sheet_no: 'A-000', sheet_name: 'Cover Sheet', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'A-001', sheet_name: 'Index of Drawings', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'A-100', sheet_name: 'Site Plan', scale: '1:100', orientation: 'landscape' },
  { sheet_no: 'A-101', sheet_name: 'Floor Plan — Level 1', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-102', sheet_name: 'Floor Plan — Level 2', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-103', sheet_name: 'Floor Plan — Level 3', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-200', sheet_name: 'North & South Elevations', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-201', sheet_name: 'East & West Elevations', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-300', sheet_name: 'Building Section A-A', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-301', sheet_name: 'Building Section B-B', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'A-400', sheet_name: 'Door & Window Schedules', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'A-401', sheet_name: 'Finish Schedule', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'A-500', sheet_name: 'Construction Details', scale: '1:20', orientation: 'landscape' },
  { sheet_no: 'EN-001', sheet_name: 'Energy Compliance — Envelope', scale: '1:100', orientation: 'landscape' },
  { sheet_no: 'EN-002', sheet_name: 'Energy Compliance — HVAC', scale: '1:100', orientation: 'landscape' },
  { sheet_no: 'EN-003', sheet_name: 'Energy Compliance — Lighting', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'EN-004', sheet_name: 'Energy Compliance — Equipment', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'EN-005', sheet_name: 'NYECC EN-1 Form', scale: 'N/A', orientation: 'portrait' },
  { sheet_no: 'EN-006', sheet_name: 'NYECC EN-2 Form', scale: 'N/A', orientation: 'portrait' },
  { sheet_no: 'EN-007', sheet_name: 'NYECC EN-3 Form', scale: 'N/A', orientation: 'portrait' },
  { sheet_no: 'EN-008', sheet_name: 'NYECC Summary', scale: 'N/A', orientation: 'landscape' },
  { sheet_no: 'RCP-001', sheet_name: 'Reflected Ceiling Plan', scale: '1:50', orientation: 'landscape' },
  { sheet_no: 'ZD-1', sheet_name: 'Zoning Diagram', scale: '1:200', orientation: 'landscape' },
];

// ── Title Blocks ─────────────────────────────────────────────────────────

async function getTitleBlocks() {
  const r = await pool.query('SELECT * FROM title_blocks ORDER BY name');
  return r.rows;
}

async function createTitleBlock(data) {
  const r = await pool.query(
    `INSERT INTO title_blocks (name, template, width_pt, height_pt, header_data, footer_data)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      data.name,
      data.template || 'dob_arch_d',
      data.width_pt || 1728,
      data.height_pt || 11136,
      JSON.stringify(data.header_data || {}),
      JSON.stringify(data.footer_data || {}),
    ]
  );
  return r.rows[0];
}

async function updateTitleBlock(id, fields) {
  const allowed = ['name', 'template', 'width_pt', 'height_pt', 'header_data', 'footer_data'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE title_blocks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0];
}

// ── Drawing Sheets ────────────────────────────────────────────────────────

async function getSheetsByBook(designBookId) {
  const r = await pool.query(
    'SELECT * FROM drawing_sheets WHERE design_book_id = $1 ORDER BY display_order, sheet_no',
    [designBookId]
  );
  return r.rows;
}

async function getSheetById(id) {
  const r = await pool.query('SELECT * FROM drawing_sheets WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function upsertSheet(designBookId, data) {
  const r = await pool.query(
    `INSERT INTO drawing_sheets
       (design_book_id, sheet_no, sheet_name, scale, orientation, title_block_id,
        project_name, address, job_number, dob_filing_type, bin_number, borough,
        revision, date, drawn_by, checked_by, approved_by, stamp_box,
        viewport_data, display_order, include_in_set)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (design_book_id, sheet_no)
     DO UPDATE SET
       sheet_name = EXCLUDED.sheet_name,
       scale = EXCLUDED.scale,
       orientation = EXCLUDED.orientation,
       title_block_id = EXCLUDED.title_block_id,
       project_name = EXCLUDED.project_name,
       address = EXCLUDED.address,
       job_number = EXCLUDED.job_number,
       dob_filing_type = EXCLUDED.dob_filing_type,
       bin_number = EXCLUDED.bin_number,
       borough = EXCLUDED.borough,
       revision = EXCLUDED.revision,
       date = EXCLUDED.date,
       drawn_by = EXCLUDED.drawn_by,
       checked_by = EXCLUDED.checked_by,
       approved_by = EXCLUDED.approved_by,
       stamp_box = EXCLUDED.stamp_box,
       viewport_data = EXCLUDED.viewport_data,
       display_order = EXCLUDED.display_order,
       include_in_set = EXCLUDED.include_in_set,
       updated_at = NOW()
     RETURNING *`,
    [
      designBookId,
      data.sheet_no,
      data.sheet_name,
      data.scale || '1:50',
      data.orientation || 'landscape',
      data.title_block_id || null,
      data.project_name || null,
      data.address || null,
      data.job_number || null,
      data.dob_filing_type || 'NB',
      data.bin_number || null,
      data.borough || null,
      data.revision || 'Rev 0',
      data.date || new Date().toISOString().slice(0, 10),
      data.drawn_by || null,
      data.checked_by || null,
      data.approved_by || null,
      JSON.stringify(data.stamp_box || {}),
      JSON.stringify(data.viewport_data || []),
      data.display_order || 0,
      data.include_in_set !== undefined ? data.include_in_set : true,
    ]
  );
  return r.rows[0];
}

async function updateSheet(id, fields) {
  const allowed = [
    'sheet_name','scale','orientation','title_block_id',
    'project_name','address','job_number','dob_filing_type','bin_number','borough',
    'revision','date','drawn_by','checked_by','approved_by','stamp_box',
    'viewport_data','display_order','include_in_set',
    'level_id','base_elevation','elevation_offset','sheet_type'
  ];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE drawing_sheets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function deleteSheet(id) {
  await pool.query('DELETE FROM drawing_sheets WHERE id = $1', [id]);
}

async function initDefaultSheets(designBookId, projectName, address) {
  const results = [];
  for (let i = 0; i < DEFAULT_SHEETS.length; i++) {
    const def = DEFAULT_SHEETS[i];
    const sheet = await upsertSheet(designBookId, {
      ...def,
      project_name: projectName || 'Project Name',
      address: address || '',
      display_order: i,
    });
    results.push(sheet);
  }
  return results;
}

// ── Sheet Viewports ──────────────────────────────────────────────────────

async function getViewportsBySheet(sheetId) {
  const r = await pool.query(
    'SELECT * FROM sheet_viewports WHERE sheet_id = $1 ORDER BY id',
    [sheetId]
  );
  return r.rows;
}

async function createViewport(sheetId, data) {
  const r = await pool.query(
    `INSERT INTO sheet_viewports
       (sheet_id, view_id, view_type, title, x_pt, y_pt, width_pt, height_pt, scale, rotation_deg, camera_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      sheetId,
      data.view_id,
      data.view_type || 'floor_plan',
      data.title || null,
      data.x_pt || 72,
      data.y_pt || 72,
      data.width_pt || 648,
      data.height_pt || 486,
      data.scale || null,
      data.rotation_deg || 0,
      JSON.stringify(data.camera_data || {}),
    ]
  );
  return r.rows[0];
}

async function updateViewport(id, fields) {
  const allowed = ['view_id','view_type','title','x_pt','y_pt','width_pt','height_pt','scale','rotation_deg','camera_data'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE sheet_viewports SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function deleteViewport(id) {
  await pool.query('DELETE FROM sheet_viewports WHERE id = $1', [id]);
}

// ── Auto Align Floors ──────────────────────────────────────────────────────────
// Binds drawing sheets to BIM levels and synchronizes elevation offsets so all
// elevation-view sheets for the same level share the same elevation baseline.
// Returns: list of updated sheets with their level bindings and computed offsets.

async function alignFloorSheets(designBookId) {
  // Fetch all levels for this project (via the design book's project_id)
  const bookRows = await pool.query(
    'SELECT project_id FROM design_books WHERE id = $1', [designBookId]
  );
  if (!bookRows.rows.length) return [];

  const projectId = bookRows.rows[0].project_id;
  const levels = await pool.query(
    `SELECT id, name, elevation FROM levels
     WHERE project_id = $1 AND is_building_storey = TRUE
     ORDER BY elevation ASC`,
    [projectId]
  );

  // Fetch all sheets for this book
  const sheets = await pool.query(
    `SELECT id, sheet_no, sheet_name, sheet_type, level_id, base_elevation
     FROM drawing_sheets WHERE design_book_id = $1 ORDER BY sheet_no`,
    [designBookId]
  );

  const updated = [];

  for (const sheet of sheets.rows) {
    let newLevelId = null;
    let newBaseElevation = 0;

    // Try to match sheet to a level based on naming conventions
    // e.g. "A-101 — Floor Plan — Level 1" → matches Level 1
    //      "A-200" elevation → match by compass direction or default first level
    const name = (sheet.sheet_name || '').toLowerCase();
    const sheetNo = (sheet.sheet_no || '').toUpperCase();

    for (const level of levels.rows) {
      const levelName = (level.name || '').toLowerCase();
      // Match patterns: "Level 1", "Level 1 Elevation", "L1"
      const levelNumMatch = level.name ? level.name.match(/level[\/\b ]*([0-9]+)/i) : null;
      const levelDigit = level.name ? level.name.match(/\b([0-9]+)\b/) : null;

      if (name.includes(levelName) ||
          (levelDigit && name.includes(levelDigit[1])) ||
          (levelNumMatch && name.includes(levelNumMatch[2]))) {
        newLevelId = level.id;
        newBaseElevation = level.elevation;
        break;
      }
    }

    // Elevation sheets — bind to first level if no specific match
    if (!newLevelId && (sheet.sheet_type === 'elevation' || sheetNo.startsWith('A-2'))) {
      if (levels.rows.length > 0) {
        newLevelId = levels.rows[0].id;
        newBaseElevation = levels.rows[0].elevation;
      }
    }

    if (newLevelId !== null && (newLevelId !== sheet.level_id || Math.abs(newBaseElevation - (sheet.base_elevation || 0)) > 0.001)) {
      await pool.query(
        `UPDATE drawing_sheets SET level_id = $1, base_elevation = $2, updated_at = NOW() WHERE id = $3`,
        [newLevelId, newBaseElevation, sheet.id]
      );
      updated.push({
        sheet_id: sheet.id,
        sheet_no: sheet.sheet_no,
        level_id: newLevelId,
        level_name: levels.rows.find(l => l.id === newLevelId)?.name,
        base_elevation: newBaseElevation,
      });
    }
  }

  // Sync elevation_offset for all sheets bound to same level = base_elevation
  // (elevation_offset is relative to base_elevation — currently set to 0 = aligned)
  for (const lvl of levels.rows) {
    await pool.query(
      `UPDATE drawing_sheets SET elevation_offset = 0, updated_at = NOW()
       WHERE design_book_id = $1 AND level_id = $2 AND elevation_offset IS NULL`,
      [designBookId, lvl.id]
    );
  }

  return updated;
}

// Get sheets by level (elevation view sheets for a given level)
async function getSheetsByLevel(designBookId, levelId) {
  const r = await pool.query(
    `SELECT * FROM drawing_sheets
     WHERE design_book_id = $1 AND level_id = $2
     ORDER BY display_order, sheet_no`,
    [designBookId, levelId]
  );
  return r.rows;
}

module.exports = {
  DEFAULT_SHEETS,
  getTitleBlocks, createTitleBlock, updateTitleBlock,
  getSheetsByBook, getSheetById, upsertSheet, updateSheet, deleteSheet, initDefaultSheets,
  getViewportsBySheet, createViewport, updateViewport, deleteViewport,
  alignFloorSheets, getSheetsByLevel,
};