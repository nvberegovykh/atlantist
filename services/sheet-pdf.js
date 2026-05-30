/**
 * Owns: Drawing sheet PDF generation — single sheets and full sets.
 * Does NOT own: sheet data persistence (db/sheets.js), viewport image capture.
 *
 * Produces ARCH D (17×11") landscape PDFs with DOB-compliant title blocks.
 * Viewports are rendered as labeled placeholder frames (actual 3D capture
 * requires client-side screenshot → passed in as optional image data).
 */
const { PDFDocument, rgb, StandardFonts, PageSizes } = require('pdf-lib');

// ARCH D — standard architectural drawing size (17" × 11" landscape, points)
const SHEET = { w: 1224, h: 792 };

const TITLE_TOP    = SHEET.h - 78;   // bottom of title block header
const FOOTER_BOT   = 48;             // top of footer
const MARGIN       = 36;              // left/right margins outside title block
const CONTENT_TOP  = TITLE_TOP - 12; // where drawing area begins
const CONTENT_BOT  = FOOTER_BOT + 12; // where drawing area ends

const DOB_BLUE   = rgb(0.094, 0.243, 0.459);  // #183E75 — NYC DOB dark blue
const DOB_LIGHT  = rgb(0.898, 0.929, 0.949);  // #E5ECF2 — header bg tint
const WHITE      = rgb(1, 1, 1);
const GREY_LINE  = rgb(0.45, 0.45, 0.45);
const GREY_TEXT  = rgb(0.35, 0.35, 0.35);
const RULE       = rgb(0.75, 0.75, 0.75);
const VIEW_FILL  = rgb(0.97, 0.98, 1.0);       // viewport placeholder bg
const VIEW_BORDER= rgb(0.55, 0.72, 0.88);      // viewport frame color

const SCALE_OPTIONS = ['1:500','1:200','1:100','1:50','1:20','1:4','N/A'];

function parseJSON(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return {}; }
}

// ─── Single Sheet PDF ────────────────────────────────────────────────────

async function generateSheetPdf(sheet, viewports = []) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  // ARCH D landscape
  const page = doc.addPage([SHEET.w, SHEET.h]);
  const { width: W, height: H } = page.getSize();

  // White background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE });

  // ── Outer border (fine rule 4pt from edge) ─────────────────────────────
  const BORDER = 4;
  page.drawRectangle({
    x: BORDER, y: BORDER, width: W - BORDER * 2, height: H - BORDER * 2,
    borderColor: GREY_LINE, borderWidth: 0.5, color: WHITE,
  });

  // ── Title block header ─────────────────────────────────────────────────
  // Full-width dark header bar at top
  page.drawRectangle({ x: BORDER, y: TITLE_TOP, width: W - BORDER * 2, height: H - TITLE_TOP - BORDER, color: DOB_BLUE });

  // Project name (left block)
  page.drawRectangle({ x: BORDER, y: TITLE_TOP, width: (W - BORDER * 2) * 0.55, height: H - TITLE_TOP - BORDER, color: DOB_BLUE });

  // Filing info (right block)
  page.drawRectangle({ x: BORDER + (W - BORDER * 2) * 0.55, y: TITLE_TOP, width: (W - BORDER * 2) * 0.45, height: H - TITLE_TOP - BORDER, color: DOB_LIGHT });

  // Title block header height
  const TB_HDR_H = H - TITLE_TOP - BORDER;

  // Left side — project info
  const projName = sheet.project_name || 'Project Name';
  const addr     = sheet.address || '';
  const jobNo    = sheet.job_number || '';
  const date     = sheet.date || new Date().toISOString().slice(0, 10);

  page.drawText(projName.length > 40 ? projName.slice(0, 38) + '…' : projName, {
    x: BORDER + 10, y: H - TITLE_TOP + TB_HDR_H * 0.62,
    size: 13, font: boldFont, color: WHITE,
  });
  if (addr) page.drawText(addr.length > 50 ? addr.slice(0, 48) + '…' : addr, {
    x: BORDER + 10, y: H - TITLE_TOP + TB_HDR_H * 0.38,
    size: 9, font, color: rgb(0.8, 0.9, 1),
  });

  // Right side — DOB filing block
  const rightX = BORDER + (W - BORDER * 2) * 0.55 + 8;
  const filingLabel = (label, value, yOffset) => {
    page.drawText(label, { x: rightX, y, size: 7, font, color: GREY_TEXT });
    page.drawText(value || '_______________', { x: rightX + 52, y, size: 8, font: boldFont, color: rgb(0.1, 0.1, 0.15) });
  };
  const y = H - TITLE_TOP + TB_HDR_H * 0.72;
  page.drawText('Job No:', { x: rightX, y, size: 7, font, color: GREY_TEXT });
  page.drawText(jobNo || '_______________', { x: rightX + 52, y, size: 8, font: boldFont, color: rgb(0.1, 0.1, 0.15) });

  const y2 = H - TITLE_TOP + TB_HDR_H * 0.50;
  page.drawText('DOB Filing Type:', { x: rightX, y: y2, size: 7, font, color: GREY_TEXT });
  page.drawText(sheet.dob_filing_type || 'NB', { x: rightX + 80, y: y2, size: 8, font: boldFont, color: rgb(0.1, 0.1, 0.15) });

  const y3 = H - TITLE_TOP + TB_HDR_H * 0.28;
  page.drawText('BIN:', { x: rightX, y: y3, size: 7, font, color: GREY_TEXT });
  page.drawText(sheet.bin_number || '_______________', { x: rightX + 30, y: y3, size: 8, font: boldFont, color: rgb(0.1, 0.1, 0.15) });
  page.drawText(sheet.borough || '', { x: rightX + 115, y: y3, size: 8, font, color: GREY_TEXT });

  // ── Title block middle row ─────────────────────────────────────────────
  // Horizontal rule separating header from drawing area
  page.drawLine({ start: { x: BORDER, y: CONTENT_TOP }, end: { x: W - BORDER, y: CONTENT_TOP }, thickness: 0.75, color: GREY_LINE });

  // Sheet info line
  const sheetLineY = CONTENT_TOP - 16;
  page.drawText(`Sheet ${sheet.sheet_no}: ${sheet.sheet_name}`, {
    x: BORDER + 6, y: sheetLineY, size: 9, font: boldFont, color: rgb(0.1, 0.1, 0.2),
  });
  page.drawText(`Scale: ${sheet.scale || '1:50'}`, {
    x: BORDER + (W - BORDER * 2) * 0.4, y: sheetLineY, size: 8, font, color: GREY_TEXT,
  });
  page.drawText(`Rev: ${sheet.revision || 'Rev 0'}`, {
    x: BORDER + (W - BORDER * 2) * 0.55, y: sheetLineY, size: 8, font, color: GREY_TEXT,
  });
  page.drawText(`Date: ${date}`, {
    x: BORDER + (W - BORDER * 2) * 0.65, y: sheetLineY, size: 8, font, color: GREY_TEXT,
  });
  if (sheet.drawn_by) {
    page.drawText(`Drawn: ${sheet.drawn_by}`, {
      x: BORDER + (W - BORDER * 2) * 0.78, y: sheetLineY, size: 8, font, color: GREY_TEXT,
    });
  }

  // ── Viewport placeholders ─────────────────────────────────────────────
  // Draw viewport frames in the content area
  for (const vp of viewports) {
    const vx = BORDER + 6 + (vp.x_pt || 72);
    const vy = CONTENT_BOT + 4 + (vp.y_pt || 72);
    const vw = vp.width_pt || 648;
    const vh = vp.height_pt || 486;
    const scale = vp.scale || sheet.scale;

    // Viewport fill
    page.drawRectangle({ x: vx, y: vy, width: vw, height: vh, color: VIEW_FILL, borderColor: VIEW_BORDER, borderWidth: 1 });

    // Viewport header bar
    const hdrH = 18;
    page.drawRectangle({ x: vx, y: vy + vh - hdrH, width: vw, height: hdrH, color: VIEW_BORDER });
    const viewLabel = vp.title || vp.view_type || 'View';
    page.drawText(viewLabel, {
      x: vx + 4, y: vy + vh - hdrH + 5, size: 8, font: boldFont, color: WHITE,
    });
    page.drawText(`Scale: ${scale}`, {
      x: vx + vw - 80, y: vy + vh - hdrH + 5, size: 7, font, color: rgb(0.9, 0.95, 1),
    });

    // Diagonal cross to indicate placeholder
    page.drawLine({ start: { x: vx + 8, y: vy + 8 }, end: { x: vx + vw - 8, y: vy + vh - hdrH - 8 }, thickness: 0.5, color: VIEW_BORDER });
    page.drawLine({ start: { x: vx + vw - 8, y: vy + 8 }, end: { x: vx + 8, y: vy + vh - hdrH - 8 }, thickness: 0.5, color: VIEW_BORDER });

    // View type icon text
    page.drawText(vp.view_type ? vp.view_type.toUpperCase() : 'FLOOR PLAN', {
      x: vx + vw / 2 - 40, y: vy + vh / 2 - hdrH / 2, size: 11, font: boldFont, color: VIEW_BORDER,
    });
  }

  // If no viewports, show empty drawing area label
  if (!viewports.length) {
    page.drawText('— Drawing Area — Viewports placed via Sheet Editor —', {
      x: BORDER + (W - BORDER * 2) / 2 - 130,
      y: CONTENT_BOT + (CONTENT_TOP - CONTENT_BOT) / 2,
      size: 9, font, color: rgb(0.75, 0.75, 0.75),
    });
  }

  // ── Scale bar (bottom of drawing area) ────────────────────────────────
  const scaleBarY = CONTENT_BOT + 6;
  const scaleBarX = BORDER + 100;
  const sbW = 120;
  const sbH = 6;
  page.drawRectangle({ x: scaleBarX, y: scaleBarY, width: sbW, height: sbH, color: GREY_LINE });
  page.drawRectangle({ x: scaleBarX, y: scaleBarY, width: sbW / 2, height: sbH, color: WHITE });
  page.drawText(`0                              ${sheet.scale || '1:50'}`, {
    x: scaleBarX - 4, y: scaleBarY + 8, size: 6, font, color: GREY_TEXT,
  });

  // ── Footer bar ────────────────────────────────────────────────────────
  page.drawLine({ start: { x: BORDER, y: FOOTER_BOT }, end: { x: W - BORDER, y: FOOTER_BOT }, thickness: 0.5, color: GREY_LINE });
  page.drawText(`Atlantist BIM 2.0  ·  ${sheet.project_name || 'Project'}  ·  Sheet ${sheet.sheet_no}`, {
    x: BORDER + 6, y: FOOTER_BOT - 14, size: 7, font, color: GREY_TEXT,
  });
  page.drawText(`Generated: ${new Date().toLocaleDateString('en-US')}`, {
    x: W - BORDER - 100, y: FOOTER_BOT - 14, size: 7, font, color: GREY_TEXT,
  });

  return doc.save();
}

// ─── Full Sheet Set PDF ──────────────────────────────────────────────────

async function generateSheetSetPdf(sheets) {
  const doc = await PDFDocument.create();

  for (const sheet of sheets) {
    const viewports = parseJSON(sheet.viewport_data || '[]');
    const page = doc.addPage([SHEET.w, SHEET.h]);
    const { width: W, height: H } = page.getSize();

    // White background
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE });

    const BORDER = 4;
    page.drawRectangle({
      x: BORDER, y: BORDER, width: W - BORDER * 2, height: H - BORDER * 2,
      borderColor: GREY_LINE, borderWidth: 0.5, color: WHITE,
    });

    // Title block header
    page.drawRectangle({ x: BORDER, y: TITLE_TOP, width: W - BORDER * 2, height: H - TITLE_TOP - BORDER, color: DOB_BLUE });
    page.drawRectangle({ x: BORDER, y: TITLE_TOP, width: (W - BORDER * 2) * 0.55, height: H - TITLE_TOP - BORDER, color: DOB_BLUE });
    page.drawRectangle({ x: BORDER + (W - BORDER * 2) * 0.55, y: TITLE_TOP, width: (W - BORDER * 2) * 0.45, height: H - TITLE_TOP - BORDER, color: DOB_LIGHT });

    const TB_HDR_H = H - TITLE_TOP - BORDER;
    const projName = sheet.project_name || 'Project Name';
    const addr     = sheet.address || '';
    const jobNo    = sheet.job_number || '';

    page.drawText(projName.length > 42 ? projName.slice(0, 40) + '…' : projName, {
      x: BORDER + 10, y: H - TITLE_TOP + TB_HDR_H * 0.62,
      size: 13, font: await doc.embedFont(StandardFonts.HelveticaBold), color: WHITE,
    });
    if (addr) page.drawText(addr.length > 50 ? addr.slice(0, 48) + '…' : addr, {
      x: BORDER + 10, y: H - TITLE_TOP + TB_HDR_H * 0.38,
      size: 9, font: await doc.embedFont(StandardFonts.Helvetica), color: rgb(0.8, 0.9, 1),
    });

    const rightX = BORDER + (W - BORDER * 2) * 0.55 + 8;
    page.drawText('Job No:', { x: rightX, y: H - TITLE_TOP + TB_HDR_H * 0.72, size: 7, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT });
    page.drawText(jobNo || '_______________', { x: rightX + 52, y: H - TITLE_TOP + TB_HDR_H * 0.72, size: 8, font: await doc.embedFont(StandardFonts.HelveticaBold), color: rgb(0.1, 0.1, 0.15) });
    page.drawText('DOB Filing Type:', { x: rightX, y: H - TITLE_TOP + TB_HDR_H * 0.50, size: 7, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT });
    page.drawText(sheet.dob_filing_type || 'NB', { x: rightX + 80, y: H - TITLE_TOP + TB_HDR_H * 0.50, size: 8, font: await doc.embedFont(StandardFonts.HelveticaBold), color: rgb(0.1, 0.1, 0.15) });
    page.drawText('BIN:', { x: rightX, y: H - TITLE_TOP + TB_HDR_H * 0.28, size: 7, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT });
    page.drawText(sheet.bin_number || '_______________', { x: rightX + 30, y: H - TITLE_TOP + TB_HDR_H * 0.28, size: 8, font: await doc.embedFont(StandardFonts.HelveticaBold), color: rgb(0.1, 0.1, 0.15) });
    page.drawText(sheet.borough || '', { x: rightX + 115, y: H - TITLE_TOP + TB_HDR_H * 0.28, size: 8, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT });

    // Content divider
    page.drawLine({ start: { x: BORDER, y: CONTENT_TOP }, end: { x: W - BORDER, y: CONTENT_TOP }, thickness: 0.75, color: GREY_LINE });

    const sheetLineY = CONTENT_TOP - 16;
    page.drawText(`Sheet ${sheet.sheet_no}: ${sheet.sheet_name}`, {
      x: BORDER + 6, y: sheetLineY, size: 9, font: await doc.embedFont(StandardFonts.HelveticaBold), color: rgb(0.1, 0.1, 0.2),
    });
    page.drawText(`Scale: ${sheet.scale || '1:50'}`, {
      x: BORDER + (W - BORDER * 2) * 0.4, y: sheetLineY, size: 8, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT,
    });
    page.drawText(`Rev: ${sheet.revision || 'Rev 0'}`, {
      x: BORDER + (W - BORDER * 2) * 0.55, y: sheetLineY, size: 8, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT,
    });
    page.drawText(`Date: ${sheet.date || new Date().toISOString().slice(0,10)}`, {
      x: BORDER + (W - BORDER * 2) * 0.65, y: sheetLineY, size: 8, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT,
    });

    // Viewport placeholders
    for (const vp of viewports) {
      const vx = BORDER + 6 + (vp.x_pt || 72);
      const vy = CONTENT_BOT + 4 + (vp.y_pt || 72);
      const vw = vp.width_pt || 648;
      const vh = vp.height_pt || 486;
      const hdrH = 18;
      page.drawRectangle({ x: vx, y: vy, width: vw, height: vh, color: VIEW_FILL, borderColor: VIEW_BORDER, borderWidth: 1 });
      page.drawRectangle({ x: vx, y: vy + vh - hdrH, width: vw, height: hdrH, color: VIEW_BORDER });
      page.drawText(vp.title || vp.view_type || 'View', {
        x: vx + 4, y: vy + vh - hdrH + 5, size: 8, font: await doc.embedFont(StandardFonts.HelveticaBold), color: WHITE,
      });
      page.drawText(`Scale: ${vp.scale || sheet.scale || '1:50'}`, {
        x: vx + vw - 80, y: vy + vh - hdrH + 5, size: 7, font: await doc.embedFont(StandardFonts.Helvetica), color: rgb(0.9, 0.95, 1),
      });
      page.drawLine({ start: { x: vx + 8, y: vy + 8 }, end: { x: vx + vw - 8, y: vy + vh - hdrH - 8 }, thickness: 0.5, color: VIEW_BORDER });
      page.drawLine({ start: { x: vx + vw - 8, y: vy + 8 }, end: { x: vx + 8, y: vy + vh - hdrH - 8 }, thickness: 0.5, color: VIEW_BORDER });
    }

    if (!viewports.length) {
      page.drawText('— Drawing Area — Viewports placed via Sheet Editor —', {
        x: BORDER + (W - BORDER * 2) / 2 - 130,
        y: CONTENT_BOT + (CONTENT_TOP - CONTENT_BOT) / 2,
        size: 9, font: await doc.embedFont(StandardFonts.Helvetica), color: rgb(0.75, 0.75, 0.75),
      });
    }

    // Scale bar
    const scaleBarY = CONTENT_BOT + 6;
    page.drawRectangle({ x: BORDER + 100, y: scaleBarY, width: 120, height: 6, color: GREY_LINE });
    page.drawRectangle({ x: BORDER + 100, y: scaleBarY, width: 60, height: 6, color: WHITE });
    page.drawText(`0                              ${sheet.scale || '1:50'}`, {
      x: BORDER + 96, y: scaleBarY + 8, size: 6, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT,
    });

    // Footer
    page.drawLine({ start: { x: BORDER, y: FOOTER_BOT }, end: { x: W - BORDER, y: FOOTER_BOT }, thickness: 0.5, color: GREY_LINE });
    page.drawText(`Atlantist BIM 2.0  ·  ${sheet.project_name || 'Project'}  ·  Sheet ${sheet.sheet_no}`, {
      x: BORDER + 6, y: FOOTER_BOT - 14, size: 7, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT,
    });
    page.drawText(`Generated: ${new Date().toLocaleDateString('en-US')}`, {
      x: W - BORDER - 100, y: FOOTER_BOT - 14, size: 7, font: await doc.embedFont(StandardFonts.Helvetica), color: GREY_TEXT,
    });
  }

  return doc.save();
}

module.exports = { generateSheetPdf, generateSheetSetPdf };