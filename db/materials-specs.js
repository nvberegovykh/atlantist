/**
 * Owns: materials_specs table — imported Excel schedule rows.
 * Does NOT own: design_book_placeholders (foreign key only), project data.
 */
const pool = require('./index');

function parseCsiCode(code) {
  if (!code) return { division: null, section: null, full: null };
  const cleaned = String(code).replace(/[\n\r\t]+/g, ' ').trim();
  const parts = cleaned.split(/\/|\n|-|\t/);
  const primary = parts[0].replace(/[^0-9 ]/g, '').trim();
  const digits = primary.replace(/\b0+/g, s => s).trim();
  let division = null, section = null;
  if (digits.length >= 2) {
    division = parseInt(digits.slice(0, 2), 10);
  }
  if (digits.length >= 5) {
    section = digits.slice(0, 7);
  }
  return { division, section, full: cleaned };
}

function parseQuantity(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[,$\n\r]/g, ''));
  return isNaN(n) ? null : n;
}

async function upsertSpec(projectId, data) {
  const csi = parseCsiCode(data.csi_code || data.csi_section);
  const qty = parseQuantity(data.quantity);
  const unitCost = parseQuantity(data.unit_cost);
  const totalCost = data.total_cost !== undefined
    ? parseQuantity(data.total_cost)
    : (qty && unitCost ? parseFloat((qty * unitCost).toFixed(2)) : null);

  return pool.query(
    `INSERT INTO materials_specs
      (project_id, design_book_id, csi_division, csi_section, csi_code,
       product_name, manufacturer, model_number, description,
       quantity, unit, unit_cost, total_cost,
       schedule_type, source_file, source_file_id, source_sheet, source_row,
       room_name, level_name, location, reference_std, spec_section,
       placeholder_id, column_mapping, import_session_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING *`,
    [
      projectId,
      data.design_book_id || null,
      csi.division,
      csi.section,
      csi.full,
      data.product_name,
      data.manufacturer || null,
      data.model_number || null,
      data.description || null,
      qty,
      data.unit || null,
      unitCost,
      totalCost,
      data.schedule_type || 'other',
      data.source_file || null,
      data.source_file_id || null,
      data.source_sheet || null,
      data.source_row || null,
      data.room_name || null,
      data.level_name || null,
      data.location || null,
      data.reference_std || null,
      data.spec_section || null,
      data.placeholder_id || null,
      JSON.stringify(data.column_mapping || {}),
      data.import_session_id,
      data.created_by || null,
    ]
  );
}

async function importBatch(projectId, specs) {
  if (!specs || specs.length === 0) return { imported: 0 };
  const results = [];
  for (const spec of specs) {
    try {
      const row = await upsertSpec(projectId, spec);
      results.push({ status: 'success', id: row.rows[0].id });
    } catch (err) {
      results.push({ status: 'error', error: err.message, data: spec });
    }
  }
  return results;
}

async function getSpecsByProject(projectId, { scheduleType, division, limit } = {}) {
  const conditions = ['project_id = $1'];
  const params = [projectId];
  let idx = 2;
  if (scheduleType) { conditions.push(`schedule_type = $${idx++}`); params.push(scheduleType); }
  if (division) { conditions.push(`csi_division = $${idx++}`); params.push(parseInt(division, 10)); }
  const rows = await pool.query(
    `SELECT ms.*, dbp.title as placeholder_title, dbp.status as placeholder_status
     FROM materials_specs ms
     LEFT JOIN design_book_placeholders dbp ON ms.placeholder_id = dbp.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ms.csi_division, ms.csi_section, ms.product_name
     LIMIT $${idx}${limit ? '' : ' OFFSET 0'}`,
    limit ? [...params, limit] : params
  );
  return rows.rows;
}

async function getSpecsByBook(designBookId) {
  const rows = await pool.query(
    `SELECT * FROM materials_specs WHERE design_book_id = $1 ORDER BY csi_division, csi_section`,
    [designBookId]
  );
  return rows.rows;
}

async function deleteSpecsBySession(projectId, importSessionId) {
  const r = await pool.query(
    `DELETE FROM materials_specs WHERE project_id = $1 AND import_session_id = $2 RETURNING id`,
    [projectId, importSessionId]
  );
  return r.rowCount;
}

async function updateSpec(specId, data) {
  const csi = parseCsiCode(data.csi_code || null);
  const qty = parseQuantity(data.quantity);
  const unitCost = parseQuantity(data.unit_cost);
  const totalCost = data.total_cost !== undefined
    ? parseQuantity(data.total_cost)
    : (qty && unitCost ? parseFloat((qty * unitCost).toFixed(2)) : null);

  const fields = [
    'product_name = $2', 'manufacturer = $3', 'model_number = $4',
    'description = $5', 'quantity = $6', 'unit = $7',
    'unit_cost = $8', 'total_cost = $9', 'csi_code = $10',
    'csi_division = $11', 'csi_section = $12', 'room_name = $13',
    'level_name = $14', 'location = $15', 'reference_std = $16',
    'spec_section = $17', 'schedule_type = $18',
  ];
  const values = [
    data.product_name, data.manufacturer || null, data.model_number || null,
    data.description || null, qty, data.unit || null,
    unitCost, totalCost, csi.full,
    csi.division, csi.section,
    data.room_name || null, data.level_name || null, data.location || null,
    data.reference_std || null, data.spec_section || null,
    data.schedule_type || 'other',
  ];
  const r = await pool.query(
    `UPDATE materials_specs SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [specId, ...values]
  );
  return r.rows[0] || null;
}

async function deleteSpec(specId) {
  const r = await pool.query(
    `DELETE FROM materials_specs WHERE id = $1 RETURNING id`, [specId]
  );
  return r.rowCount > 0;
}

module.exports = {
  parseCsiCode,
  upsertSpec,
  importBatch,
  getSpecsByProject,
  getSpecsByBook,
  deleteSpecsBySession,
  updateSpec,
  deleteSpec,
};