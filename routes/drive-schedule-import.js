/**
 * Owns: POST /api/drive/import-schedule — Excel → Materials/Specs.
 * GET /api/drive/files/:fileId/preview — inspect sheet headers before import.
 * Does NOT own: general Drive folder browsing (routes/drive.js), OAuth tokens.
 */
const router = require('express').Router();
const https = require('https');
const crypto = require('crypto');
const { getSessionByToken } = require('../db/auth');
const { getIntegration } = require('../db/user-integrations');
const { parseBuffer, applyMapping, validateRows, proposeMapping } = require('../services/excel-parser');
const { getOrCreateBook } = require('../db/design-book');
const { importBatch, getSpecsByProject, deleteSpecsBySession, updateSpec, deleteSpec } = require('../db/materials-specs');
const { generateDriveSpecsPdf } = require('../services/schedule-pdf');
const { saveContextSnapshot } = require('../db/wallt');

// ─── Token helpers (copied from drive.js for self-contained routing) ─────────────
const tokenCache = new Map();
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_ID      = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET  = process.env.GOOGLE_DRIVE_CLIENT_SECRET;

function encrypt(plaintext) {
  if (!process.env.ENCRYPTION_KEY || plaintext == null) return plaintext;
  const key = Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 32).padEnd(32, '\u0000'), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc.toString('hex');
}

function decrypt(ciphertext) {
  if (!process.env.ENCRYPTION_KEY || ciphertext == null) return ciphertext;
  try {
    const key = Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 32).padEnd(32, '\u0000'), 'utf8');
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    if (!ivHex || !tagHex || !encHex) return ciphertext;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext;
  }
}

async function getValidToken(userId) {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiry - Date.now() > TOKEN_REFRESH_WINDOW_MS) return cached.accessToken;
  const integration = await getIntegration(userId, 'google_drive');
  if (!integration?.refresh_token) return null;
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: integration.refresh_token, grant_type: 'refresh_token',
    }).toString();
    const res = await httpsRequest('POST', 'oauth2.googleapis.com', '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (res.status !== 200) { tokenCache.delete(userId); return null; }
    const { access_token, refresh_token, expiry_date } = res.data;
    const expiry = expiry_date || Date.now() + 3600 * 1000;
    tokenCache.set(userId, { accessToken: access_token, expiry });
    return access_token;
  } catch {
    tokenCache.delete(userId); return null;
  }
}

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, res => {
      let data = Buffer.from([]);
      res.on('data', chunk => { data = Buffer.concat([data, chunk]); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data.toString()) }); }
        catch { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : body);
    req.end();
  });
}

// ─── Auth middleware ─────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = await getSessionByToken(token);
  if (!session) return res.status(401).json({ error: 'Session expired' });
  req.userId = session.user_id;
  next();
}

// ─── GET /api/drive/files/:fileId/preview
// Inspect an xlsx file — return sheet names, headers, and proposed column mappings.
// No data written. User uses this to review before confirming import.
router.get('/files/:fileId/preview', requireAuth, async (req, res) => {
  const { fileId } = req.params;
  const accessToken = await getValidToken(req.userId);
  if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected. Authorize first.' });

  try {
    // Get file metadata first to confirm it's an Excel file
    const metaRes = await httpsRequest('GET', 'www.googleapis.com',
      `/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime`,
      { Authorization: `Bearer ${accessToken}` });
    if (metaRes.status === 404) return res.status(404).json({ error: 'File not found in Drive.' });
    if (metaRes.status !== 200) return res.status(metaRes.status).json({ error: 'Drive API error.', details: metaRes.data?.error });
    const meta = metaRes.data;
    if (!meta.mimeType?.includes('spreadsheet') && !meta.name?.toLowerCase().endsWith('.xlsx')) {
      return res.status(400).json({ error: 'File is not an Excel (.xlsx) spreadsheet.', mimeType: meta.mimeType });
    }

    // Download the file as binary
    const downloadRes = await httpsRequest('GET', 'www.googleapis.com',
      `/drive/v3/files/${fileId}?alt=media`,
      { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (downloadRes.status === 403) return res.status(403).json({ error: 'Access to this file was denied. Ensure the file is shared or owned by this account.' });
    if (downloadRes.status !== 200) return res.status(downloadRes.status).json({ error: 'Failed to download file from Drive.' });
    if (!Buffer.isBuffer(downloadRes.data) && !downloadRes.data?.type) {
      return res.status(500).json({ error: 'Downloaded content is not a valid binary buffer.' });
    }
    const buffer = Buffer.isBuffer(downloadRes.data) ? downloadRes.data : Buffer.from(downloadRes.data);
    if (buffer.length === 0) return res.status(422).json({ error: 'File is empty or unreadable.' });

    const { sheets } = parseBuffer(buffer);
    const sheetSummaries = sheets.map(sheet => {
      const { proposal, unmapped } = proposeMapping(sheet.headers, sheet.sheetType);
      return {
        name:       sheet.name,
        rowCount:   sheet.rows.length,
        headers:    sheet.headers,
        sheetType:  sheet.sheetType,
        proposedMapping: proposal,
        unmappedColumns: unmapped,
      };
    });

    res.json({
      fileId:   fileId,
      fileName: meta.name,
      fileSize: meta.size,
      modifiedTime: meta.modifiedTime,
      sheets:   sheetSummaries,
    });
  } catch (err) {
    console.error('[drive-schedule-import] preview error:', err.message);
    res.status(500).json({ error: 'Failed to preview file: ' + err.message });
  }
});

// ─── POST /api/drive/import-schedule
// Parse and import Excel schedule into materials_specs.
// Two modes:
//   preview=true → validate only, return report (dry run)
//   preview=false (default) → actually write to DB

router.post('/import-schedule', requireAuth, async (req, res) => {
  const {
    fileId, fileName, projectId,
    sheets:       sheetConfigs,   // [{ name, mapping: { header: field }, scheduleTypeOverride? }]
    preview:      doPreview = false,
    importSessionId,
    designBookId,
    overwriteExisting = false,   // if true, delete prior rows for this session before writing
  } = req.body;

  if (!fileId) return res.status(400).json({ error: 'fileId is required.' });
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  if (!sheetConfigs || !Array.isArray(sheetConfigs) || sheetConfigs.length === 0) {
    return res.status(400).json({ error: 'sheets array is required (at least one sheet config).' });
  }

  const accessToken = await getValidToken(req.userId);
  if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected. Authorize first.' });

  const sessionId = importSessionId || `imp_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
  const userId = req.userId;

  // ── Download file ────────────────────────────────────────────────────────
  let buffer;
  try {
    const metaRes = await httpsRequest('GET', 'www.googleapis.com',
      `/drive/v3/files/${fileId}?fields=id,name,mimeType,size`,
      { Authorization: `Bearer ${accessToken}` });
    if (metaRes.status !== 200) return res.status(metaRes.status).json({ error: 'File not found in Drive.' });

    const dlRes = await httpsRequest('GET', 'www.googleapis.com',
      `/drive/v3/files/${fileId}?alt=media`,
      { Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (dlRes.status !== 200) return res.status(dlRes.status).json({ error: 'Failed to download file.' });
    buffer = Buffer.isBuffer(dlRes.data) ? dlRes.data : Buffer.from(dlRes.data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve file from Drive: ' + err.message });
  }

  const { sheets: parsedSheets } = parseBuffer(buffer);

  // ── Process each configured sheet ──────────────────────────────────────
  const sheetResults = [];
  for (const config of sheetConfigs) {
    const sheet = parsedSheets.find(s => s.name === config.name);
    if (!sheet) {
      sheetResults.push({ sheet: config.name, error: `Sheet "${config.name}" not found in workbook.` });
      continue;
    }

    const sheetType = config.scheduleTypeOverride || sheet.sheetType;
    const mapping   = config.mapping || {};
    const rows = applyMapping(sheet, mapping);
    const validation = validateRows(rows, sheetType);

    if (doPreview) {
      // Dry run — return validation only, no writes
      sheetResults.push({
        sheet: sheet.name,
        sheetType,
        rowsTotal:   validation.total,
        rowsValid:   validation.valid,
        rowsInvalid: validation.total - validation.valid,
        warnings:    validation.warnings.slice(0, 50),   // cap for readability
        duplicates:  validation.duplicates,
        missingProductName: validation.missingProductName,
      });
      continue;
    }

    // ── Actual write ────────────────────────────────────────────────────────
    if (overwriteExisting && sessionId) {
      await deleteSpecsBySession(projectId, sessionId);
    }

    // Build spec rows for DB
    const specs = validation.validRows.map(r => ({
      product_name: r.product_name,
      manufacturer: r.manufacturer,
      model_number: r.model_number,
      description:  r.description,
      csi_code:     r.csi_code,
      quantity:     r.quantity,
      unit:         r.unit,
      unit_cost:    r.unit_cost,
      total_cost:   r.total_cost,
      schedule_type: sheetType,
      source_file:  fileName || null,
      source_file_id: fileId,
      source_sheet: sheet.name,
      source_row:   r._rowIdx,
      room_name:    r.room_name,
      level_name:   r.level_name,
      location:     r.location,
      reference_std: r.reference_std,
      spec_section:  r.spec_section,
      column_mapping: mapping,
      import_session_id: sessionId,
      created_by:   userId,
    }));

    const importResult = await importBatch(projectId, specs);

    // Link to design book if provided
    if (designBookId) {
      await linkSpecsToPlaceholder(projectId, designBookId, sheetType, sessionId, sheet.name);
    }

    const successCount = importResult.filter(r => r.status === 'success').length;
    const errorCount   = importResult.filter(r => r.status === 'error').length;
    sheetResults.push({
      sheet: sheet.name,
      sheetType,
      imported: successCount,
      errors: errorCount,
      errorDetails: errorCount > 0 ? importResult.filter(r => r.status === 'error') : undefined,
      importSessionId: sessionId,
    });
  }

  if (doPreview) {
    return res.json({ preview: true, sessionId, sheets: sheetResults });
  }

  res.json({
    imported: true,
    sessionId,
    projectId: parseInt(projectId, 10),
    sheets: sheetResults,
    totalImported: sheetResults.reduce((s, r) => s + (r.imported || 0), 0),
    totalErrors: sheetResults.reduce((s, r) => s + (r.errors || 0), 0),
  });

  // Non-blocking: push a Drive context snapshot so Wallt knows fresh schedules exist
  setImmediate(async () => {
    try {
      const scheduleFiles = sheetResults.map(r => ({ id: null, name: r.sheet, modified: new Date().toISOString() }));
      const snapshot = {
        source: 'drive_import',
        pushed_at: new Date().toISOString(),
        project_id: parseInt(projectId, 10),
        project_name: null,
        summary: {
          total_files: scheduleFiles.length,
          rvt_count: 0,
          rfa_count: 0,
          schedule_count: scheduleFiles.length,
          other_count: 0,
          primary_model: null,
        },
        files: { rvt: [], rfa: [], schedules: scheduleFiles },
      };
      await saveContextSnapshot(userId, parseInt(projectId, 10), snapshot);
    } catch (e) {
      console.warn('[drive-import] wallt-context push failed (non-fatal):', e.message);
    }
  });
});

// ─── GET /api/drive/materials-specs?project_id=X — list imported specs
router.get('/materials-specs', requireAuth, async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id) : null;
  if (!projectId) return res.status(400).json({ error: 'project_id required' });
  const specs = await getSpecsByProject(projectId, {
    scheduleType: req.query.type || null,
    division: req.query.division || null,
    limit: req.query.limit ? parseInt(req.query.limit) : 500,
  });
  res.json(specs);
});

// ─── PUT /api/drive/materials-specs/:id — inline edit a spec row ─────────────
router.put('/materials-specs/:id', requireAuth, async (req, res) => {
  const specId = parseInt(req.params.id);
  if (!specId) return res.status(400).json({ error: 'Invalid spec id' });
  const { product_name, manufacturer, model_number, description, csi_code,
          quantity, unit, unit_cost, total_cost, schedule_type,
          room_name, level_name, location, reference_std, spec_section } = req.body;
  if (!product_name) return res.status(400).json({ error: 'product_name is required' });
  try {
    const updated = await updateSpec(specId, {
      product_name, manufacturer, model_number, description, csi_code,
      quantity, unit, unit_cost, total_cost, schedule_type,
      room_name, level_name, location, reference_std, spec_section,
    });
    if (!updated) return res.status(404).json({ error: 'Spec not found' });
    res.json(updated);
  } catch (err) {
    console.error('[drive-schedule-import] PUT spec:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/drive/materials-specs/:id — remove a spec row ─────────────
router.delete('/materials-specs/:id', requireAuth, async (req, res) => {
  const specId = parseInt(req.params.id);
  if (!specId) return res.status(400).json({ error: 'Invalid spec id' });
  try {
    const deleted = await deleteSpec(specId);
    if (!deleted) return res.status(404).json({ error: 'Spec not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[drive-schedule-import] DELETE spec:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/drive/export-specs-pdf — PDF export of imported materials/specs
router.post('/export-specs-pdf', requireAuth, async (req, res) => {
  const { project_id, project_name = 'Atlantist Project', type, division } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id required' });
  try {
    const specs = await getSpecsByProject(parseInt(project_id), {
      scheduleType: type || null,
      division: division || null,
      limit: 2000,
    });
    const pdfBytes = await generateDriveSpecsPdf(specs, {
      projectName: project_name,
      scheduleType: type || 'finish',
      runDate: new Date().toISOString().slice(0, 10),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist-drive-specs-${type || 'all'}.pdf"`);
    res.send(pdfBytes);
  } catch (err) {
    console.error('[drive-schedule-import] PDF export:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Link imported specs to design book placeholders by schedule type ───────
async function linkSpecsToPlaceholder(projectId, designBookId, scheduleType, importSessionId, sourceSheet) {
  const pool = require('../db/index');
  const placeholderType = {
    finish: 'finish-schedule', door: 'door-schedule', room: 'room-schedule',
    structural: 'structural', hvac: 'hvac', plumbing: 'plumbing', electrical: 'electrical',
    other: 'other',
  }[scheduleType] || 'other';

  const ph = await pool.query(
    `SELECT id FROM design_book_placeholders
     WHERE design_book_id = $1 AND placeholder_type = $2
     LIMIT 1`,
    [designBookId, placeholderType]
  );
  if (!ph.rows[0]) return;
  const placeholderId = ph.rows[0].id;
  await pool.query(
    `UPDATE materials_specs SET placeholder_id = $1
     WHERE import_session_id = $2 AND schedule_type = $3`,
    [placeholderId, importSessionId, scheduleType]
  );
}

module.exports = router;