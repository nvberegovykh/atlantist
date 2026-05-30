/**
 * Owns: A-400 PDF schedule generation — door, window, room, finish, material.
 * Does NOT own: schedule data queries (db/schedules.js, db/families.js), routing.
 *
 * Produces letter-size PDF schedules in DOB submission format with proper
 * headers, alternating rows, total rows, and door/window tag rendering.
 */
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// Letter size in points (1pt = 1/72 inch)
const PAGE = { w: 612, h: 792 };
const MARGIN = { top: 54, bottom: 54, left: 54, right: 54 };
const HEADER_H = 42;
const FOOTER_H = 30;
const CONTENT_W = PAGE.w - MARGIN.left - MARGIN.right;
const CONTENT_TOP = PAGE.h - MARGIN.top - HEADER_H;
const CONTENT_BOT = MARGIN.bottom + FOOTER_H;

const COLOR = {
  headerBg: rgb(0.094, 0.243, 0.459),
  headerText: rgb(1, 1, 1),
  sectionBg: rgb(0.235, 0.447, 0.686),
  rowAlt: rgb(0.949, 0.957, 0.969),
  rowNormal: rgb(1, 1, 1),
  text: rgb(0.1, 0.1, 0.1),
  subtext: rgb(0.4, 0.4, 0.4),
  border: rgb(0.7, 0.7, 0.7),
  totalBg: rgb(0.88, 0.92, 0.96),
};

function parseJSON(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Generate a PDF schedule by type.
 * @param {string} type - doors|windows|rooms|finishes|materials
 * @param {object} data - { rows, projectName, runDate }
 * @returns {Buffer} PDF bytes
 */
async function generateSchedulePdf(type, data) {
  const { rows = [], projectName = 'Atlantist Project', runDate = new Date().toISOString().slice(0,10) } = data || {};
  const ctx = { projectName, runDate, type };

  let title, subtitle;
  switch (type) {
    case 'doors':
      title = 'A-400 DOOR SCHEDULE';
      subtitle = 'Revit A-400 Door Schedule — Atlantist BIM 2.0';
      break;
    case 'windows':
      title = 'A-400 WINDOW SCHEDULE';
      subtitle = 'Revit A-400 Window Schedule — Atlantist BIM 2.0';
      break;
    case 'rooms':
      title = 'A-400 ROOM SCHEDULE';
      subtitle = 'Room Area and Finish Schedule — Atlantist BIM 2.0';
      break;
    case 'finishes':
      title = 'A-400 FINISH SCHEDULE';
      subtitle = 'Floor / Wall / Ceiling Finish Schedule — Atlantist BIM 2.0';
      break;
    case 'materials':
      title = 'A-500 MATERIAL TAKE-OFF';
      subtitle = 'Aggregate Material Quantities — Atlantist BIM 2.0';
      break;
    default:
      throw new Error('Unknown schedule type: ' + type);
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE.w, PAGE.h]);
  drawPageHeader(page, font, boldFont, ctx, title, subtitle);
  let y = CONTENT_TOP - 16;

  switch (type) {
    case 'doors':
      y = buildDoorTable(page, font, boldFont, rows, y);
      break;
    case 'windows':
      y = buildWindowTable(page, font, boldFont, rows, y);
      break;
    case 'rooms':
      y = buildRoomTable(page, font, boldFont, rows, y);
      break;
    case 'finishes':
      y = buildFinishTable(page, font, boldFont, rows, y);
      break;
    case 'materials':
      y = buildMaterialTable(page, font, boldFont, rows, y);
      break;
  }

  if (y < CONTENT_BOT + 60) {
    page = doc.addPage([PAGE.w, PAGE.h]);
  }
  drawFooter(page, font, ctx);

  return Buffer.from(await doc.save());
}

// ─── Door Schedule ─────────────────────────────────────────────────────────────

function buildDoorTable(page, font, boldFont, rows, y) {
  const cols = ['Mark', 'Type', 'Width', 'Height', 'Material', 'Fire Rating', 'Hand', 'Wall', 'Level'];
  const colW = [50, 110, 50, 50, 65, 60, 40, 65, 60];
  y = drawTableHeader(page, boldFont, y, cols, colW);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    y = drawTableRow(page, font, boldFont, y, [
      row.mark || '',
      row.type_name || '',
      row.width ? `${row.width} mm` : '',
      row.height ? `${row.height} mm` : '',
      row.material || '',
      row.fire_rating || '',
      row.hand || '',
      row.wall_host_type || '',
      row.level_name || '',
    ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);
    if (y < CONTENT_BOT + 30) {
      addContinuationHeader(page, font, boldFont, 'A-400 DOOR SCHEDULE — CONTINUED');
      y = CONTENT_TOP - 16;
    }
  }

  // Total row
  const countMap = {};
  rows.forEach(r => { countMap[r.type_name || 'Unknown'] = (countMap[r.type_name || 'Unknown'] || 0) + 1; });
  const totalText = `${rows.length} doors total: ${Object.entries(countMap).map(([k, v]) => `${v}× ${k}`).join(', ')}`;
  y -= 4;
  page.drawRectangle({ x: MARGIN.left, y: y - 16, width: CONTENT_W, height: 20, color: COLOR.totalBg });
  page.drawText(totalText, { x: MARGIN.left + 6, y: y - 12, size: 8, font: boldFont, color: COLOR.text });
  y -= 22;
  return y;
}

// ─── Window Schedule ───────────────────────────────────────────────────────────

function buildWindowTable(page, font, boldFont, rows, y) {
  const cols = ['Mark', 'Type', 'Width', 'Height', 'Sill Ht', 'Glazing', 'Material', 'Wall', 'Level'];
  const colW = [50, 90, 50, 50, 50, 55, 65, 65, 55];
  y = drawTableHeader(page, boldFont, y, cols, colW);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    y = drawTableRow(page, font, boldFont, y, [
      row.mark || '',
      row.type_name || '',
      row.width ? `${row.width} mm` : '',
      row.height ? `${row.height} mm` : '',
      row.sill_height ? `${row.sill_height} mm` : '',
      row.glazing || '',
      row.material || '',
      row.wall_host_type || '',
      row.level_name || '',
    ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);
    if (y < CONTENT_BOT + 30) {
      addContinuationHeader(page, font, boldFont, 'A-400 WINDOW SCHEDULE — CONTINUED');
      y = CONTENT_TOP - 16;
    }
  }

  const countMap = {};
  rows.forEach(r => { countMap[r.type_name || 'Unknown'] = (countMap[r.type_name || 'Unknown'] || 0) + 1; });
  const totalText = `${rows.length} windows total: ${Object.entries(countMap).map(([k, v]) => `${v}× ${k}`).join(', ')}`;
  y -= 4;
  page.drawRectangle({ x: MARGIN.left, y: y - 16, width: CONTENT_W, height: 20, color: COLOR.totalBg });
  page.drawText(totalText, { x: MARGIN.left + 6, y: y - 12, size: 8, font: boldFont, color: COLOR.text });
  y -= 22;
  return y;
}

// ─── Room Schedule ─────────────────────────────────────────────────────────────

function buildRoomTable(page, font, boldFont, rows, y) {
  const cols = ['Level', 'No.', 'Name', 'Area (m²)', 'Volume (m³)', 'Floor Finish', 'Ceiling Finish', 'Dept.'];
  const colW = [75, 40, 90, 55, 60, 80, 80, 55];
  y = drawTableHeader(page, boldFont, y, cols, colW);

  let levelGroup = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Level sub-header when level changes
    if (row.level_name !== levelGroup) {
      levelGroup = row.level_name;
      page.drawRectangle({ x: MARGIN.left, y: y - 14, width: CONTENT_W, height: 14, color: COLOR.sectionBg });
      page.drawText(`LEVEL: ${levelGroup || '—'}`, { x: MARGIN.left + 4, y: y - 10, size: 8, font: boldFont, color: COLOR.headerText });
      y -= 14;
    }

    y = drawTableRow(page, font, boldFont, y, [
      row.level_name || '',
      row.room_number || '',
      row.room_name || '',
      row.area_sqm ? Number(row.area_sqm).toFixed(1) : '',
      row.volume_cum ? Number(row.volume_cum).toFixed(1) : '',
      row.floor_finish || '',
      row.ceiling_finish || '',
      row.department || '',
    ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);

    if (y < CONTENT_BOT + 30) {
      addContinuationHeader(page, font, boldFont, 'A-400 ROOM SCHEDULE — CONTINUED');
      y = CONTENT_TOP - 16;
    }
  }

  const totalArea = rows.reduce((s, r) => s + (Number(r.area_sqm) || 0), 0);
  y -= 4;
  page.drawRectangle({ x: MARGIN.left, y: y - 16, width: CONTENT_W, height: 20, color: COLOR.totalBg });
  page.drawText(`${rows.length} rooms · Total area: ${totalArea.toFixed(1)} m²`, { x: MARGIN.left + 6, y: y - 12, size: 8, font: boldFont, color: COLOR.text });
  y -= 22;
  return y;
}

// ─── Finish Schedule ────────────────────────────────────────────────────────────

function buildFinishTable(page, font, boldFont, rows, y) {
  const cols = ['Level', 'No.', 'Room', 'Floor Finish', 'Wall Finish', 'Ceiling Finish', 'Base'];
  const colW = [75, 40, 90, 90, 90, 90, 62];
  y = drawTableHeader(page, boldFont, y, cols, colW);

  let lastLevel = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.level_name !== lastLevel) {
      lastLevel = row.level_name;
      page.drawRectangle({ x: MARGIN.left, y: y - 14, width: CONTENT_W, height: 14, color: COLOR.sectionBg });
      page.drawText(`LEVEL: ${lastLevel || '—'}`, { x: MARGIN.left + 4, y: y - 10, size: 8, font: boldFont, color: COLOR.headerText });
      y -= 14;
    }

    y = drawTableRow(page, font, boldFont, y, [
      row.level_name || '',
      row.room_number || '',
      row.room_name || '',
      row.floor_finish || '',
      row.wall_finish || '',
      row.ceiling_finish || '',
      row.base_finish || '',
    ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);

    if (y < CONTENT_BOT + 30) {
      addContinuationHeader(page, font, boldFont, 'A-400 FINISH SCHEDULE — CONTINUED');
      y = CONTENT_TOP - 16;
    }
  }

  y -= 4;
  page.drawRectangle({ x: MARGIN.left, y: y - 16, width: CONTENT_W, height: 20, color: COLOR.totalBg });
  page.drawText(`${rows.length} rooms with finishes`, { x: MARGIN.left + 6, y: y - 12, size: 8, font: boldFont, color: COLOR.text });
  y -= 22;
  return y;
}

// ─── Material Takeoff ───────────────────────────────────────────────────────────

function buildMaterialTable(page, font, boldFont, data, y) {
  const { wall_materials = [], doors = [], windows = [] } = typeof data === 'object' && !Array.isArray(data) ? data : { wall_materials: [], doors: [], windows: [] };

  if (wall_materials.length > 0) {
    page.drawRectangle({ x: MARGIN.left, y: y - 18, width: CONTENT_W, height: 18, color: COLOR.sectionBg });
    page.drawText('WALL MATERIALS', { x: MARGIN.left + 4, y: y - 13, size: 9, font: boldFont, color: COLOR.headerText });
    y -= 20;

    const cols = ['Material', 'Function', 'Walls', 'Area (m²)', 'Volume (m³)'];
    const colW = [130, 100, 60, 90, 90];
    y = drawTableHeader(page, boldFont, y, cols, colW);

    for (let i = 0; i < wall_materials.length; i++) {
      const r = wall_materials[i];
      y = drawTableRow(page, font, boldFont, y, [
        r.material || '',
        r.function || '',
        String(r.wall_count || 0),
        r.total_area_sqm ? Number(r.total_area_sqm).toFixed(1) : '—',
        r.total_volume_cum ? Number(r.total_volume_cum).toFixed(2) : '—',
      ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);
    }
    y -= 8;
  }

  if (doors.length > 0) {
    page.drawRectangle({ x: MARGIN.left, y: y - 18, width: CONTENT_W, height: 18, color: COLOR.sectionBg });
    page.drawText('DOOR COUNT BY TYPE', { x: MARGIN.left + 4, y: y - 13, size: 9, font: boldFont, color: COLOR.headerText });
    y -= 20;

    const cols = ['Type', 'Count', 'Material'];
    const colW = [200, 100, 200];
    y = drawTableHeader(page, boldFont, y, cols, colW);

    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      y = drawTableRow(page, font, boldFont, y, [
        d.material || d.type_name || '',
        String(d.count || 0),
        '',
      ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);
    }
    y -= 8;
  }

  if (windows.length > 0) {
    page.drawRectangle({ x: MARGIN.left, y: y - 18, width: CONTENT_W, height: 18, color: COLOR.sectionBg });
    page.drawText('WINDOW COUNT BY TYPE', { x: MARGIN.left + 4, y: y - 13, size: 9, font: boldFont, color: COLOR.headerText });
    y -= 20;

    const cols = ['Type', 'Count', 'Material'];
    const colW = [200, 100, 200];
    y = drawTableHeader(page, boldFont, y, cols, colW);

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      y = drawTableRow(page, font, boldFont, y, [
        w.material || w.type_name || '',
        String(w.count || 0),
        '',
      ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);
    }
    y -= 8;
  }

  return y;
}

// ─── Drawing helpers ───────────────────────────────────────────────────────────

function drawPageHeader(page, font, boldFont, ctx, title, subtitle) {
  page.drawRectangle({ x: 0, y: PAGE.h - MARGIN.top - HEADER_H, width: PAGE.w, height: HEADER_H, color: COLOR.headerBg });

  page.drawText(ctx.projectName, {
    x: MARGIN.left, y: PAGE.h - MARGIN.top - 18,
    size: 11, font: boldFont, color: COLOR.headerText,
  });
  page.drawText(`Schedule: ${title} · ${ctx.runDate}`, {
    x: MARGIN.left, y: PAGE.h - MARGIN.top - 30,
    size: 8, font, color: rgb(0.75, 0.82, 0.9),
  });

  const titleW = boldFont.widthOfTextAtSize(title, 13);
  page.drawText(title, {
    x: PAGE.w - MARGIN.right - titleW, y: PAGE.h - MARGIN.top - 20,
    size: 13, font: boldFont, color: COLOR.headerText,
  });
  const subW = font.widthOfTextAtSize(subtitle || '', 8);
  page.drawText(subtitle || '', {
    x: PAGE.w - MARGIN.right - subW, y: PAGE.h - MARGIN.top - 32,
    size: 8, font, color: rgb(0.75, 0.82, 0.9),
  });
}

function drawFooter(page, font, ctx) {
  const y = MARGIN.bottom;
  page.drawLine({
    start: { x: MARGIN.left, y: y + 18 },
    end: { x: PAGE.w - MARGIN.right, y: y + 18 },
    thickness: 0.5, color: COLOR.border,
  });
  page.drawText(`Atlantist BIM 2.0 · ${ctx.projectName} · Generated ${ctx.runDate} · ${title}`, {
    x: MARGIN.left, y: y + 6, size: 7, font, color: COLOR.subtext,
  });
}

function drawTableHeader(page, boldFont, y, cols, widths) {
  const rowH = 18;
  page.drawRectangle({ x: MARGIN.left, y: y - rowH, width: CONTENT_W, height: rowH, color: COLOR.headerBg });
  let x = MARGIN.left + 4;
  for (let i = 0; i < cols.length; i++) {
    page.drawText(cols[i], { x, y: y - 13, size: 8, font: boldFont, color: COLOR.headerText });
    x += widths[i] || 80;
  }
  return y - rowH;
}

function drawTableRow(page, font, boldFont, y, cols, widths, bg) {
  const rowH = 16;
  page.drawRectangle({ x: MARGIN.left, y: y - rowH, width: CONTENT_W, height: rowH, color: bg, borderColor: COLOR.border, borderWidth: 0.2 });
  let x = MARGIN.left + 4;
  for (let i = 0; i < cols.length; i++) {
    page.drawText(String(cols[i] || '').slice(0, 40), { x, y: y - 12, size: 7.5, font, color: COLOR.text });
    x += widths[i] || 80;
  }
  return y - rowH;
}

function addContinuationHeader(page, font, boldFont, label) {
  // Add a new page with continuation header
  const newPage = page.doc.addPage([PAGE.w, PAGE.h]);
  newPage.drawRectangle({ x: 0, y: PAGE.h - MARGIN.top - 30, width: PAGE.w, height: 30, color: COLOR.sectionBg });
  newPage.drawText(label, { x: MARGIN.left, y: PAGE.h - MARGIN.top - 22, size: 10, font: boldFont, color: COLOR.headerText });
}

/**
 * Generate a PDF from imported Drive materials/specs rows.
 * @param {Array} specs — rows from materials_specs table
 * @param {object} opts — { projectName, scheduleType, runDate }
 * @returns {Buffer} PDF bytes
 */
async function generateDriveSpecsPdf(specs, opts = {}) {
  const { projectName = 'Atlantist Project', scheduleType = 'finish', runDate = new Date().toISOString().slice(0,10) } = opts;
  const type = scheduleType;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE.w, PAGE.h]);
  const title = 'A-400 MATERIALS / FINISH SCHEDULE';
  const subtitle = `${scheduleType} specs — Atlantist BIM 2.0`;

  drawPageHeader(page, font, boldFont, { projectName, runDate, type }, title, subtitle);
  let y = CONTENT_TOP - 16;

  // Columns: CSI | Product | Manufacturer | Model | Finish | Qty | Unit | Unit Cost | Total | Room | Level
  const cols = ['CSI', 'Product / Description', 'Mfg', 'Model', 'Qty', 'Unit', 'Unit$', 'Total$', 'Room'];
  const colW = [52, 120, 65, 60, 32, 32, 50, 50, 85];

  y = drawTableHeader(page, boldFont, y, cols, colW);

  let lastCsiDivision = null;
  for (let i = 0; i < specs.length; i++) {
    const row = specs[i];

    // CSI division group header
    const div = row.csi_division;
    if (div !== null && div !== lastCsiDivision) {
      lastCsiDivision = div;
      page.drawRectangle({ x: MARGIN.left, y: y - 14, width: CONTENT_W, height: 14, color: COLOR.sectionBg });
      page.drawText(`DIVISION ${String(div).padStart(2,'0')} — ${getDivisionName(div)}`, {
        x: MARGIN.left + 4, y: y - 10, size: 8, font: boldFont, color: COLOR.headerText
      });
      y -= 16;
      // Re-draw header under group header
      y = drawTableHeader(page, boldFont, y, cols, colW);
    }

    y = drawTableRow(page, font, boldFont, y, [
      row.csi_code || '',
      (row.product_name || '').slice(0, 28),
      (row.manufacturer || '').slice(0, 15),
      (row.model_number || '').slice(0, 12),
      row.quantity != null ? String(row.quantity) : '',
      row.unit || '',
      row.unit_cost != null ? formatCurrency(row.unit_cost) : '',
      row.total_cost != null ? formatCurrency(row.total_cost) : '',
      (row.room_name || '').slice(0, 18),
    ], colW, i % 2 === 0 ? COLOR.rowNormal : COLOR.rowAlt);

    if (y < CONTENT_BOT + 30) {
      const contPage = doc.addPage([PAGE.w, PAGE.h]);
      contPage.drawRectangle({ x: 0, y: PAGE.h - MARGIN.top - 30, width: PAGE.w, height: 30, color: COLOR.sectionBg });
      contPage.drawText('A-400 MATERIALS SCHEDULE — CONTINUED', {
        x: MARGIN.left, y: PAGE.h - MARGIN.top - 22, size: 10, font: boldFont, color: COLOR.headerText
      });
      page = contPage;
      y = CONTENT_TOP - 16;
      y = drawTableHeader(page, boldFont, y, cols, colW);
    }
  }

  // Total row
  const totalCost = specs.reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);
  y -= 4;
  page.drawRectangle({ x: MARGIN.left, y: y - 16, width: CONTENT_W, height: 20, color: COLOR.totalBg });
  page.drawText(`${specs.length} items  ·  Total: ${formatCurrency(totalCost)}  (tax-inclusive base)`, {
    x: MARGIN.left + 6, y: y - 12, size: 8, font: boldFont, color: COLOR.text
  });
  y -= 22;

  drawFooter(page, font, { projectName, runDate, type });

  return Buffer.from(await doc.save());
}

function getDivisionName(div) {
  const names = {
    1:'General Requirements', 2:'Existing Conditions', 3:'Concrete', 4:'Masonry',
    5:'Metals', 6:'Wood & Plastics', 7:'Thermal & Moisture', 8:'Openings',
    9:'Finishes', 10:'Specialties', 11:'Equipment', 12:'Furnishings',
    13:'Special Construction', 14:'Conveying', 21:'Fire Suppression',
    22:'Plumbing', 23:'HVAC', 26:'Electrical', 27:'Communications', 28:'Security',
  };
  return names[div] || `Division ${div}`;
}

function formatCurrency(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { generateSchedulePdf, generateDriveSpecsPdf };