/**
 * Parses Google Drive Excel (.xlsx) files into structured row arrays.
 * Uses xlsx (SheetJS) to handle multi-sheet workbooks.
 * Each sheet maps to one schedule type.
 */
const XLSX = require('xlsx');
const { detectScheduleType, getDefaultMapping, parseCode } = require('./csi-masterformat');

/**
 * Parse xlsx buffer → array of sheet objects with headers and rows.
 * @param {Buffer} buffer — raw xlsx binary
 * @returns {{ sheets: [{ name, headers, rows, sheetType }] }}
 */
function parseBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true });
  const sheets = workbook.SheetNames.map(name => {
    const ws = workbook.Sheets[name];
    const json = XLSX.utils.sheet_to_json(ws, {
      header: 1,          // raw array-of-arrays
      defval: null,
      raw: false,
    });
    if (!json || json.length === 0) return { name, headers: [], rows: [], sheetType: 'other' };

    // First non-empty row = headers
    let headerRowIdx = 0;
    for (let i = 0; i < json.length; i++) {
      if (json[i] && json[i].some(c => c !== null && c !== undefined && String(c).trim() !== '')) {
        headerRowIdx = i;
        break;
      }
    }
    const rawHeaders = json[headerRowIdx] || [];
    const headers = rawHeaders.map(h => String(h ?? '').trim()).filter(Boolean);
    const dataRows = json.slice(headerRowIdx + 1).filter(row =>
      row && row.some(c => c !== null && c !== undefined && String(c).trim() !== '')
    );

    // Parse values from each row
    const rows = dataRows.map((rawRow, rowIdx) => {
      const obj = {};
      headers.forEach((header, colIdx) => {
        obj[header] = rawRow[colIdx] !== undefined ? rawRow[colIdx] : null;
      });
      return { rowIdx: headerRowIdx + 1 + rowIdx, raw: rawRow, mapped: obj };
    });

    const sheetType = detectScheduleType(name, headers);
    return { name, headers, rows, sheetType };
  });

  return { sheets, workbookName: workbook.name || 'unknown' };
}

/**
 * Apply a column mapping config to a sheet's rows.
 * mapping: { [excel_header]: [atlantist_field] }
 * Returns rows with normalized field names.
 */
function applyMapping(sheet, mapping) {
  const { headers, rows, sheetType } = sheet;
  const defaultMap = getDefaultMapping(sheetType);
  const merged = { ...defaultMap, ...mapping };

  // Build reverse map: atlantist_field → excel_header
  const fieldToHeader = {};
  for (const [excelHeader, field] of Object.entries(merged)) {
    if (!fieldToHeader[field]) fieldToHeader[field] = [];
    fieldToHeader[field].push(excelHeader);
  }

  // Resolve value from any matching header
  function resolveField(row, field) {
    const candidates = fieldToHeader[field] || [];
    for (const h of candidates) {
      const v = row[h];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  }

  return rows.map(({ rowIdx, raw, mapped }) => {
    const r = {
      _rowIdx: rowIdx,
      product_name:   resolveField(mapped, 'product_name')   || String(mapped[headers[0]] || '').trim(),
      manufacturer:   resolveField(mapped, 'manufacturer'),
      model_number:   resolveField(mapped, 'model_number'),
      description:    resolveField(mapped, 'description')     || resolveField(mapped, 'notes'),
      csi_code:       resolveField(mapped, 'csi_code'),
      quantity:       resolveField(mapped, 'quantity'),
      unit:           resolveField(mapped, 'unit'),
      unit_cost:      resolveField(mapped, 'unit_cost'),
      total_cost:     resolveField(mapped, 'total_cost'),
      room_name:      resolveField(mapped, 'room_name'),
      level_name:     resolveField(mapped, 'level_name'),
      location:       resolveField(mapped, 'location'),
      reference_std:  resolveField(mapped, 'reference_std'),
      spec_section:   resolveField(mapped, 'spec_section'),
      schedule_type:  sheetType,
    };
    // Normalize CSI code
    if (r.csi_code) {
      const parsed = parseCode(r.csi_code);
      if (parsed) {
        r.csi_code = parsed.code;
        r._csi_parsed = parsed;
      }
    }
    // Normalize quantity/unit
    if (r.unit === null && r.quantity !== null) {
      r.unit = detectUnit(r.quantity);
    }
    return r;
  });
}

/**
 * Validate parsed rows, returning a validation report.
 */
function validateRows(rows, sheetType) {
  const report = {
    total: rows.length,
    valid: 0,
    warnings: [],
    unmappedColumns: new Set(),
    missingProductName: [],
    duplicates: [],
    validRows: [],
  };

  // Track duplicates by product_name + room combo
  const seen = new Map();

  rows.forEach((r, idx) => {
    const warnings = [];

    if (!r.product_name || String(r.product_name).trim() === '') {
      report.missingProductName.push(idx);
      warnings.push(`Row ${idx + 1}: missing product_name`);
    }

    // Duplicate check
    if (r.product_name && r.room_name) {
      const key = `${String(r.product_name).toLowerCase()}|${String(r.room_name).toLowerCase()}`;
      if (seen.has(key)) {
        warnings.push(`Duplicate: same product_name + room_name as row ${seen.get(key) + 1}`);
        report.duplicates.push({ row: idx + 1, duplicateOf: seen.get(key) + 1 });
      } else {
        seen.set(key, idx);
      }
    }

    if (r.csi_code && r._csi_parsed) {
      // CSI validation
      if (r._csi_parsed.division && (r._csi_parsed.division < 1 || r._csi_parsed.division > 50)) {
        warnings.push(`Row ${idx + 1}: CSI division ${r._csi_parsed.division} out of range (01–50)`);
      }
    }

    if (warnings.length > 0) {
      report.warnings.push(...warnings);
      // Soft warnings (duplicates, CSI range) — include but flag
      const isHardError = warnings.some(w => w.includes('missing product_name'));
      if (!isHardError) {
        report.valid++;
        report.validRows.push(r);
      }
    } else {
      report.valid++;
      report.validRows.push(r);
    }
  });

  return report;
}

/**
 * Detect unit from quantity value heuristically.
 */
function detectUnit(value) {
  if (!value) return null;
  const str = String(value).toLowerCase();
  if (str.includes('cy') || str.includes('cubic')) return 'CY';
  if (str.includes('sf') || str.includes('sqft') || str.includes('sq ft')) return 'SF';
  if (str.includes('lf') || str.includes('linear')) return 'LF';
  if (str.includes('ea') || str.includes('each') || str.includes('unit')) return 'EA';
  if (str.includes('ton')) return 'TN';
  if (str.includes('lb') || str.includes('pound')) return 'LB';
  return null;
}

/**
 * Auto-generate a proposed column mapping from detected headers.
 */
function proposeMapping(headers, sheetType) {
  const defaultMap = getDefaultMapping(sheetType);
  const proposal = {};
  const unmapped = [];

  headers.forEach(header => {
    const h = header.toLowerCase().trim();
    // Try exact/default map
    if (defaultMap[header]) {
      proposal[header] = defaultMap[header];
      return;
    }
    // Fuzzy match
    let matched = false;
    for (const [excelHeader, field] of Object.entries(defaultMap)) {
      const ex = excelHeader.toLowerCase();
      if (h === ex || h.includes(ex) || ex.includes(h)) {
        proposal[header] = field;
        matched = true;
        break;
      }
    }
    if (!matched) unmapped.push(header);
  });

  return { proposal, unmapped };
}

module.exports = {
  parseBuffer,
  applyMapping,
  validateRows,
  detectUnit,
  proposeMapping,
};