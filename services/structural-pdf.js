/**
 * Owns: Structural analysis PDF report generation — DCR table, seismic summary,
 *       code compliance checks, member results, PE disclaimer.
 * Does NOT own: Three.js rendering, database access, analysis engine.
 */
const { PDFDocument, rgb, StandardFonts, PageSizes } = require('pdf-lib');

const DISCLAIMER = '⚠️ Results are for preliminary design reference only. Software does not guarantee code compliance or regulatory approval. All designs must be reviewed and sealed by a licensed Professional Engineer (PE/SE). Standards: ASCE 7-22, AISC 360-22, ACI 318-22, NDS 2018.';

async function generateStructuralPDF(run, projectName = 'Atlantist BIM Project') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageW = PageSizes.Letter[0];
  const margin = 50;

  // Parse stored JSON results
  let memberResults = { members: [], nodes: [] };
  let codeChecks = {};
  let seismicResults = null;
  let vizData = null;

  try {
    if (run.member_results) memberResults = JSON.parse(run.member_results);
    if (run.code_checks) codeChecks = JSON.parse(run.code_checks);
    if (run.seismic_results) seismicResults = JSON.parse(run.seismic_results);
    if (run.viz_data) vizData = JSON.parse(run.viz_data);
  } catch (_) {}

  const members = memberResults.members || [];
  const nodes = memberResults.nodes || [];

  // ── Page 1: Cover ──────────────────────────────────────────────────────────
  let page = doc.addPage();
  let y = page.getHeight() - margin;

  const drawText = (txt, x, yy, size = 10, fontToUse = font, color = rgb(0, 0, 0)) => {
    page.drawText(txt, { x, y: yy, size, font: fontToUse, color });
  };

  const drawRect = (x1, y1, w, h, color) => {
    page.drawRectangle({ x: x1, y: y1, width: w, height: h, color });
  };

  // Header bar
  drawRect(0, page.getHeight() - 80, pageW, 80, rgb(0.08, 0.11, 0.18));
  drawText('ATLANTIST BIM', margin, y - 20, 18, boldFont, rgb(0.75, 0.52, 0.99));
  drawText('Structural Engineering Analysis Report', margin, y - 40, 11, font, rgb(0.55, 0.55, 0.65));
  y -= 100;

  drawText('Structural Analysis Report', margin, y, 22, boldFont);
  y -= 28;
  drawText(`Project: ${projectName}`, margin, y, 12, boldFont);
  y -= 18;
  drawText(`Run #${run.id} — ${run.analysis_type?.replace(/_/g, ' ').toUpperCase() || 'STRUCTURAL ANALYSIS'}`, margin, y, 10);
  y -= 16;
  drawText(`Generated: ${new Date().toLocaleString()}`, margin, y, 9, font, rgb(0.5, 0.5, 0.5));
  y -= 30;

  // Disclaimer box
  drawRect(margin, y - 50, pageW - 2 * margin, 50, rgb(1, 0.94, 0.82));
  drawText('⚠ PRELIMINARY DESIGN REFERENCE ONLY', margin + 8, y - 16, 9, boldFont, rgb(0.75, 0.55, 0));
  drawText(DISCLAIMER, margin + 8, y - 30, 8, font, rgb(0.4, 0.3, 0.1));
  y -= 65;

  // Codes implemented
  drawText('Implemented Codes:', margin, y, 10, boldFont);
  y -= 14;
  const codes = ['ASCE 7-22 (Seismic/Wind)', 'AISC 360-22 (Steel)', 'ACI 318-22 (Concrete)', 'NDS 2018 (Wood)'];
  codes.forEach((c, i) => {
    drawText('• ' + c, margin + 10, y - i * 13, 9);
  });
  y -= 13 * codes.length + 20;

  // ── Page 2: Seismic Summary ───────────────────────────────────────────────
  page = doc.addPage();
  y = page.getHeight() - margin;

  drawRect(0, page.getHeight() - 50, pageW, 50, rgb(0.08, 0.11, 0.18));
  drawText('ATLANTIST BIM — Structural Analysis Report', margin, y - 22, 11, boldFont, rgb(0.75, 0.52, 0.99));
  drawText(`Run #${run.id}`, pageW - margin - 60, y - 22, 9, font, rgb(0.55, 0.55, 0.55));
  y -= 70;

  if (seismicResults) {
    drawText('Seismic Base Shear — ASCE 7-22 §12.8', margin, y, 13, boldFont);
    y -= 22;

    const seismicRows = [
      ['Spectral Accel Ss (g)', seismicResults.Ss?.toFixed(3)],
      ['Spectral Accel S1 (g)', seismicResults.S1?.toFixed(3)],
      ['Site Class', seismicResults.site_class || 'D'],
      ['Design Spectral SDS', seismicResults.SDS?.toFixed(3)],
      ['Design Spectral SD1', seismicResults.SD1?.toFixed(3)],
      ['Approx. Period T (s)', seismicResults.T?.toFixed(3)],
      ['Seismic Coeff Cs', seismicResults.Cs?.toFixed(4)],
      ['Base Shear V (kips)', seismicResults.V?.toFixed(0)],
      ['Building Weight W (kips)', seismicResults.W?.toFixed(0)],
      ['R Factor', seismicResults.R],
      ['Importance Factor Ie', seismicResults.Ie],
      ['Seismic Design Category', seismicResults.SDC || '—'],
    ];
    seismicRows.forEach(([label, val], i) => {
      if (i % 2 === 0) drawRect(margin, y - 14, pageW - 2 * margin, 16, rgb(0.96, 0.96, 0.98));
      drawText(label, margin + 6, y - 10, 9);
      drawText(String(val || '—'), margin + 220, y - 10, 9, boldFont);
      y -= 16;
    });
    y -= 12;
  }

  // LRFD Load Combinations
  drawText('Active Load Combinations (ASCE 7-22 §2.3.1)', margin, y, 12, boldFont);
  y -= 18;
  const combos = [
    ['LC1', '1.4D'], ['LC2', '1.2D + 1.6L + 0.5(Lr or S or R)'],
    ['LC3', '1.2D + 1.6(Lr or S or R) + L'], ['LC4', '1.2D + 1.0W + L + 0.5(Lr or S or R)'],
    ['LC5', '1.2D + 1.0E + L + 0.2S'], ['LC6', '0.9D + 1.0W'],
    ['LC7', '0.9D + 1.0E'],
  ];
  combos.forEach(([id, formula], i) => {
    if (i % 2 === 0) drawRect(margin, y - 14, pageW - 2 * margin, 16, rgb(0.96, 0.96, 0.98));
    drawText(id, margin + 6, y - 10, 9, boldFont, rgb(0.55, 0.32, 0.99));
    drawText(formula, margin + 50, y - 10, 9);
    y -= 16;
  });

  // ── Page 3: DCR Table ─────────────────────────────────────────────────────
  page = doc.addPage();
  y = page.getHeight() - margin;

  drawRect(0, page.getHeight() - 50, pageW, 50, rgb(0.08, 0.11, 0.18));
  drawText('ATLANTIST BIM — Structural Analysis Report', margin, y - 22, 11, boldFont, rgb(0.75, 0.52, 0.99));
  drawText(`Run #${run.id}`, pageW - margin - 60, y - 22, 9, font, rgb(0.55, 0.55, 0.55));
  y -= 70;

  drawText('Code Compliance — DCR Summary', margin, y, 13, boldFont);
  y -= 20;

  // Table header
  const colWidths = [160, 80, 70, 70, 60];
  const headers = ['Member', 'Check', 'DCR', 'Code Ref', 'Status'];
  const colX = [margin];
  for (let i = 0; i < colWidths.length - 1; i++) colX.push(colX[i] + colWidths[i]);

  drawRect(margin, y - 16, pageW - 2 * margin, 16, rgb(0.08, 0.11, 0.18));
  headers.forEach((h, i) => drawText(h, colX[i] + 4, y - 11, 8, boldFont, rgb(1, 1, 1)));
  y -= 20;

  let passCount = 0, failCount = 0;
  for (const [name, checks] of Object.entries(codeChecks)) {
    if (!checks) continue;
    for (const [checkType, check] of Object.entries(checks)) {
      if (checkType === 'error' || !check) continue;
      const ratio = check.ratio;
      const pass = check.pass;
      if (pass) passCount++; else failCount++;

      const rowH = 14;
      if (y - rowH < margin) { page = doc.addPage(); y = page.getHeight() - margin; }

      if (pass === false) drawRect(margin, y - rowH, pageW - 2 * margin, rowH, rgb(1, 0.93, 0.93));
      else if (pass === true) drawRect(margin, y - rowH, pageW - 2 * margin, rowH, rgb(0.93, 1, 0.93));

      const dcrStr = typeof ratio === 'number' ? ratio.toFixed(3) : '—';
      const statusStr = pass === false ? 'FAIL' : pass === true ? 'PASS' : 'N/A';
      const rowVals = [name, checkType, dcrStr, check.code_ref || '—', statusStr];

      rowVals.forEach((val, i) => {
        let color = rgb(0, 0, 0);
        if (i === 2 && ratio !== undefined) color = ratio > 1 ? rgb(0.8, 0, 0) : ratio > 0.85 ? rgb(0.7, 0.4, 0) : rgb(0, 0.4, 0);
        if (i === 4) color = pass === false ? rgb(0.8, 0, 0) : pass === true ? rgb(0, 0.5, 0) : rgb(0.5, 0.5, 0.5);
        drawText(String(val).slice(0, 30), colX[i] + 4, y - 10, 7.5, i === 0 ? boldFont : font, color);
      });
      y -= rowH;
    }
  }

  y -= 8;
  // Summary
  drawText(`Summary: ${passCount} PASS / ${failCount} FAIL`, margin, y, 11, boldFont, rgb(0.2, 0.2, 0.2));

  // ── Page 4: Member Results ─────────────────────────────────────────────────
  if (members.length > 0) {
    page = doc.addPage();
    y = page.getHeight() - margin;

    drawRect(0, page.getHeight() - 50, pageW, 50, rgb(0.08, 0.11, 0.18));
    drawText('ATLANTIST BIM — Structural Analysis Report', margin, y - 22, 11, boldFont, rgb(0.75, 0.52, 0.99));
    drawText(`Run #${run.id}`, pageW - margin - 60, y - 22, 9, font, rgb(0.55, 0.55, 0.55));
    y -= 70;

    drawText('Member Forces — Linear Static Analysis', margin, y, 13, boldFont);
    y -= 20;

    const mColWidths = [120, 80, 80, 80, 80];
    const mHeaders = ['Member', 'Axial (k)', 'Shear-i (k)', 'Moment-i (k-ft)', 'Max Defl (in)'];
    const mColX = [margin];
    for (let i = 0; i < mColWidths.length - 1; i++) mColX.push(mColX[i] + mColWidths[i]);

    drawRect(margin, y - 16, pageW - 2 * margin, 16, rgb(0.08, 0.11, 0.18));
    mHeaders.forEach((h, i) => drawText(h, mColX[i] + 4, y - 11, 8, boldFont, rgb(1, 1, 1)));
    y -= 20;

    members.forEach((m, i) => {
      const rowH = 14;
      if (y - rowH < margin) { page = doc.addPage(); y = page.getHeight() - margin; }
      if (i % 2 === 0) drawRect(margin, y - rowH, pageW - 2 * margin, rowH, rgb(0.97, 0.97, 0.98));

      const vals = [
        m.name || `Member ${m.id}`,
        (m.axial || 0).toFixed(2),
        (m.shear_i || 0).toFixed(2),
        (m.moment_i || 0).toFixed(2),
        (m.max_deflection || 0).toFixed(4),
      ];
      vals.forEach((val, i) => drawText(val, mColX[i] + 4, y - 10, 7.5, i === 0 ? boldFont : font));
      y -= rowH;
    });
  }

  // ── Final Page: Disclaimer ──────────────────────────────────────────────────
  page = doc.addPage();
  y = page.getHeight() - margin;
  drawRect(0, page.getHeight() - 50, pageW, 50, rgb(0.08, 0.11, 0.18));
  drawText('ATLANTIST BIM — Structural Analysis Report', margin, y - 22, 11, boldFont, rgb(0.75, 0.52, 0.99));
  y -= 70;

  drawText('Professional Engineer Review Required', margin, y, 14, boldFont);
  y -= 20;

  const disclaimerLines = [
    'This report was generated by Atlantist BIM software and contains results from structural',
    'analysis using the following standards:',
    '',
    '  • ASCE 7-22 — Minimum Design Loads and Associated Criteria for Buildings',
    '  • AISC 360-22 — Specification for Structural Steel Buildings',
    '  • ACI 318-22 — Building Code Requirements for Structural Concrete',
    '  • NDS 2018 — National Design Specification for Wood Construction',
    '',
    'Results in this report are PRELIMINARY DESIGN REFERENCE ONLY.',
    'They do not guarantee code compliance or regulatory approval.',
    '',
    'ALL DESIGNS MUST BE REVIEWED AND SEALED BY A LICENSED PROFESSIONAL ENGINEER (PE/SE)',
    'before use in construction, permit applications, or regulatory submissions.',
    '',
    'The analysis assumes材料的 properties and loading conditions as input by the user.',
    'Actual conditions on-site may differ. Verify all assumptions with a licensed PE.',
    '',
    `Atlantist BIM — Structural Engineering Report — Run #${run.id}`,
    `Generated: ${new Date().toISOString()}`,
  ];

  disclaimerLines.forEach(line => {
    if (y < margin + 20) { page = doc.addPage(); y = page.getHeight() - margin; }
    drawText(line, margin, y, 9);
    y -= 13;
  });

  return doc.save();
}

module.exports = { generateStructuralPDF, DISCLAIMER };