/**
 * Overlay Check Service — real-time 3-tier RED/AMBER/GREEN compliance overlays.
 * Owns: overlay verdict generation, volumetric geometry, module-aware thresholds.
 * Does NOT own: DB persistence (db/attachments.js), WebGL rendering (public/js/).
 *
 * Called on every drag frame via requestAnimationFrame. Not persisted to DB.
 * Use /api/overlay-check for drag-time evaluation; use /api/attachments/overlays for
 * batch/deterministic post-placement storage.
 */
const { getModuleDerived } = require('./module-system');
const codeCompliance = require('./code-compliance');
const loadPathService = require('./load-path');

// ─── Overlay scene constants ─────────────────────────────────────────────────
const OVERLAY_OPACITY = {
  RED:   0.35,
  AMBER: 0.25,
  GREEN: 0.15,
};
const CLEARANCE_OPACITY = {
  RED:   0.20,
  AMBER: 0.15,
};
const DELTA_ARROW_THICKNESS = 1.5; // px at default camera

// ─── Verdict aggregation ───────────────────────────────────────────────────────
/**
 * Aggregate per-check results into a single overlay verdict.
 * Returns the WORST verdict (RED > AMBER > GREEN).
 */
function aggregateVerdict(results) {
  let worst = 'GREEN';
  for (const r of results) {
    if (r.verdict === 'RED')   return 'RED';
    if (r.verdict === 'AMBER') worst = 'AMBER';
  }
  return worst;
}

// ─── Clearance violation overlay ─────────────────────────────────────────────
/**
 * Build a volumetric overlay mesh descriptor for a clearance conflict.
 * The overlay is a transparent box placed at the conflicting geometry region.
 * Returns { type, center, size, color, opacity, code_reference, message }
 */
function buildClearanceOverlay(elementA, elementB, minDist_mm, actualDist_mm, is_nyc) {
  const violation_mm = minDist_mm - actualDist_mm;
  const verdicts = [
    { verdict: 'AMBER', issue_code: 'CLEARANCE_PROXIMITY', message: `Elements ${violation_mm.toFixed(0)}mm too close — constructability risk` },
    { verdict: 'RED',   issue_code: 'CLEARANCE_VIOLATION', message: `Clearance violation: ${actualDist_mm.toFixed(0)}mm actual vs ${minDist_mm.toFixed(0)}mm required` },
  ];
  const useRed = actualDist_mm < minDist_mm * 0.5;
  const v = useRed ? verdicts[1] : verdicts[0];

  return {
    type: 'clearance_vol',
    element_ids: [elementA.id, elementB.id],
    center: {
      x: ((elementA.position?.x || 0) + (elementB.position?.x || 0)) / 2,
      y: ((elementA.position?.y || 0) + (elementB.position?.y || 0)) / 2,
      z: ((elementA.position?.z || 0) + (elementB.position?.z || 0)) / 2,
    },
    size: {
      x: violation_mm,
      y: violation_mm,
      z: violation_mm,
    },
    color: useRed ? 0xff4444 : 0xff9900,
    opacity: useRed ? CLEARANCE_OPACITY.RED : CLEARANCE_OPACITY.AMBER,
    verdict: v.verdict,
    category: 'clearance',
    issue_code: v.issue_code,
    message: v.message,
    code_reference: is_nyc ? 'NYC BC §707.3 — fire separation distance' : 'IBC §707 — fire separation',
    fix_suggestion: `Increase separation to at least ${minDist_mm.toFixed(0)} mm`,
  };
}

// ─── Alignment overlay (dashed outline + delta arrow) ────────────────────────
/**
 * Build alignment overlay for elements within snap range but not aligned.
 * Returns dashed outline + delta vector arrow showing direction + magnitude.
 * Threshold = M/16, hint = M/8.
 */
function buildAlignmentOverlay(elementObj, targetPos_mm, actualPos_mm, M_mm, is_nyc) {
  const derived = getModuleDerived(M_mm);
  const delta_mm = actualPos_mm - targetPos_mm;
  const absDelta = Math.abs(delta_mm);

  const withinAmber = absDelta <= derived.snap.coarse; // M/4 (advisory range)
  const withinRed   = absDelta >  derived.overlay.red;   // M/16 trigger

  if (!withinRed) return null; // Within tolerance, no overlay needed

  const isAmber = absDelta > derived.overlay.amber && absDelta <= derived.overlay.red;

  return {
    type: 'alignment_off',
    element_id: elementObj.id,
    target_pos: targetPos_mm,
    actual_pos: actualPos_mm,
    delta_mm: delta_mm,
    threshold_mm: derived.overlay.red,
    hint_mm: derived.overlay.snap.coarse,  // M/8 snap hint
    // Arrow direction: negative delta means element is past target
    delta_vector: delta_mm >= 0 ? 1 : -1,
    color: isAmber ? 0xff9900 : 0xff4444,
    opacity: isAmber ? 0.65 : 0.8,
    verdict: isAmber ? 'AMBER' : 'RED',
    category: 'alignment',
    issue_code: isAmber ? 'MISALIGNMENT_WARNING' : 'MISALIGNMENT_VIOLATION',
    message: `Alignment ${absDelta.toFixed(1)} mm off — trigger ${derived.overlay.red.toFixed(1)} mm, hint ${derived.overlay.snap.coarse.toFixed(1)} mm`,
    code_reference: null,
    fix_suggestion: `Snap to nearest grid within ${derived.overlay.snap.coarse.toFixed(1)} mm (M/8)`,
    unit_display: is_nyc ? 'inches' : 'mm',
  };
}

// ─── Structural overlay (span / missing bearing / load path break) ──────────────
/**
 * Build structural overlay for unsupported spans, missing bearing, load path break.
 * type: 'unsupported_span' | 'missing_bearing' | 'load_path_break' | 'no_lateral_system'
 */
function buildStructuralOverlay(issue, element, M_mm, is_nyc) {
  const derived = getModuleDerived(M_mm);

  if (issue.category === 'bearing') {
    return {
      type: 'missing_bearing',
      element_id: element.id,
      color: 0xff4444,
      opacity: 0.40,
      verdict: 'RED',
      category: 'bearing',
      issue_code: 'MISSING_BEARING',
      message: 'No vertical support below — wall cannot float',
      code_reference: 'NYC BC §1804.1 / TMS 602 §3.4 — continuous bearing required',
      fix_suggestion: 'Add continuous footings or foundation wall below this CMU wall',
    };
  }

  if (issue.category === 'span') {
    const isWarning = issue.severity === 'warning';
    return {
      type: isWarning ? 'unsupported_span' : 'unsupported_span_critical',
      element_id: element.id,
      color: isWarning ? 0xff9900 : 0xff4444,
      opacity: isWarning ? 0.30 : 0.45,
      verdict: isWarning ? 'AMBER' : 'RED',
      category: 'structural',
      issue_code: issue.issue_code || 'SPAN_EXCEEDED',
      message: issue.message || `Span exceeds ${(derived.spanThresholds.warning_mm / 25.4 / 12).toFixed(0)}ft — engineer review required`,
      code_reference: 'IBC Chapter 22 / AISC 360-22 — beam design',
      fix_suggestion: 'Reduce span or increase beam depth. Consult structural engineer.',
    };
  }

  if (issue.category === 'load_path') {
    return {
      type: 'load_path_break',
      element_id: element.id,
      color: 0xff4444,
      opacity: 0.40,
      verdict: 'RED',
      category: 'load_path',
      issue_code: 'LOAD_PATH_BREAK',
      message: 'Gravity load cannot trace to footing — structural discontinuity',
      code_reference: 'NYC BC §1804.1 — foundation continuity',
      fix_suggestion: 'Ensure column rests on footing, beam rests on column, slab rests on beam',
    };
  }

  return null;
}

// ─── Lateral system missing overlay ───────────────────────────────────────────
/**
 * For buildings >1 story without shear walls or moment frames.
 * Overlay on entire structure (or specific missing elements).
 */
function buildMissingLateralOverlay(numStories, is_nyc) {
  return {
    type: 'no_lateral_system',
    element_ids: [],  // applies to entire structure
    color: 0xff9900,
    opacity: 0.20,
    verdict: 'AMBER',
    category: 'lateral',
    issue_code: 'MISSING_LATERAL_SYSTEM',
    message: `Building has ${numStories} stories but no lateral load-resisting system detected. Shear walls or moment frames required.`,
    code_reference: 'IBC §2306 — lateral design, NYC BC §1809 — shear wall requirements',
    fix_suggestion: 'Add shear walls or moment frames. Structural engineer must specify location and size.',
  };
}

// ─── Door / window code violation overlay ─────────────────────────────────────
/**
 * Build overlay for DOB clearance minimums (door width, ceiling height, egress).
 */
function buildCodeViolationOverlay(element, issue, is_nyc) {
  const color = issue.verdict === 'RED' ? 0xff4444 : 0xff9900;
  const opacity = issue.verdict === 'RED' ? 0.45 : 0.30;

  return {
    type: 'code_violation',
    element_id: element.id,
    color,
    opacity,
    verdict: issue.verdict,
    category: issue.category,
    issue_code: issue.issue_code,
    message: issue.message,
    code_reference: issue.code_reference,
    fix_suggestion: issue.fix_suggestion,
  };
}

// ─── Green flash overlay (brief confirmation) ──────────────────────────────────
/**
 * Green flash on successful attachment placement.
 * Returns a brief overlay that auto-dismisses after ~1.5s.
 */
function buildGreenConfirmOverlay(element, connectionCode) {
  return {
    type: 'green_confirm',
    element_id: element.id,
    color: 0x22cc66,
    opacity: 0.20,
    verdict: 'GREEN',
    category: 'confirm',
    issue_code: null,
    message: `Code-compliant attachment (${connectionCode})`,
    code_reference: null,
    fix_suggestion: null,
    auto_dismiss_ms: 1500,
  };
}

// ─── Main real-time overlay evaluator ─────────────────────────────────────────
/**
 * Evaluate all overlays for a set of elements in real-time.
 * Called from the API on drag frames — must be fast.
 *
 * @param {Array} elements - All project elements
 * @param {object} moduleProject - { M_value, system_name, is_nyc }
 * @param {object} options - { includeGreen, includeAmber, draggingId }
 * @returns {Array} overlay descriptors for rendering
 */
function evaluateOverlays(elements, moduleProject, options = {}) {
  const {
    includeGreen = false,
    includeAmber = true,
    draggingId = null,
  } = options;

  const M_mm = moduleProject?.M_value || 1000;
  const is_nyc = moduleProject?.is_nyc || false;
  const derived = getModuleDerived(M_mm);
  const overlays = [];

  // ── 1. Load path validation ──────────────────────────────────────────────
  const edges = loadPathService.buildLoadPathEdges(elements);
  const missingSupport = loadPathService.detectMissingSupport(elements, edges, M_mm);
  const lateralCheck = loadPathService.detectLateralSystem(elements, M_mm);

  // Missing lateral system
  if (lateralCheck.missingSystem) {
    overlays.push(buildMissingLateralOverlay(lateralCheck.numStories, is_nyc));
  }

  // Missing support
  for (const { element } of missingSupport) {
    overlays.push(buildStructuralOverlay(
      { category: 'bearing', message: 'No structural support detected below' },
      element, M_mm, is_nyc
    ));
  }

  // ── 2. CMU bearing check ──────────────────────────────────────────────────
  const cmuWalls = elements.filter(e => {
    const t = (e.type_name || '').toLowerCase();
    return e.type === 'wall' && (t.includes('cmu') || t.includes('masonry') || e.parameters?.wall_type?.toLowerCase()?.includes('cmu'));
  });
  for (const wall of cmuWalls) {
    const bearingResult = codeCompliance.validateCMUWallBearing(wall, elements);
    if (bearingResult.verdict === 'RED') {
      overlays.push(buildStructuralOverlay(bearingResult, wall, M_mm, is_nyc));
    }
  }

  // ── 3. Door / window clearance ────────────────────────────────────────────
  const doorWindowTypes = new Set(['door', 'window', 'family_instance']);
  const familyInstances = elements.filter(e => doorWindowTypes.has(e.type) || doorWindowTypes.has(e.type_name));

  for (const fi of familyInstances) {
    const params = fi.parameters || {};
    const width_mm = params.width_mm || params.width * 25.4 || 0;

    if (width_mm > 0) {
      const doorResult = codeCompliance.validateDoorWidth(width_mm, is_nyc, M_mm);
      if (doorResult.verdict !== 'GREEN' || includeGreen) {
        overlays.push(buildCodeViolationOverlay(fi, doorResult, is_nyc));
      }
    }

    // Sill height for windows
    if (params.sill_height_mm) {
      const sillResult = codeCompliance.validateCeilingHeight(params.sill_height_mm, is_nyc);
      if (sillResult.verdict === 'RED') {
        overlays.push(buildCodeViolationOverlay(fi, sillResult, is_nyc));
      }
    }
  }

  // ── 4. Wall structural checks (header span) ──────────────────────────────
  const walls = elements.filter(e => e.type === 'wall');
  for (const wall of walls) {
    const wallType = wall.parameters?.wall_type || '';
    const isLoadBearing = wallType.toLowerCase().includes('load_bearing') ||
                          wallType.toLowerCase().includes('bearing') ||
                          wall.parameters?.load_bearing === true;

    // Find door openings in this wall and check header requirements
    for (const fi of familyInstances) {
      if (fi.host_wall_id !== wall.id) continue;
      const doorWidth = fi.parameters?.width_mm || fi.parameters?.width * 25.4 || 0;
      if (doorWidth > 0) {
        const headerResult = codeCompliance.validateHeaderRequired(wall, doorWidth, M_mm);
        if (headerResult.verdict !== 'GREEN' || includeGreen) {
          overlays.push(buildCodeViolationOverlay(wall, headerResult, is_nyc));
        }
      }
    }
  }

  // ── 5. Clearance between elements ──────────────────────────────────────────
  // Check walls vs walls, columns vs columns for proximity conflicts
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const elA = elements[i];
      const elB = elements[j];

      // Simple bounding box proximity check (avoid double-counting walls)
      if (elA.type === 'wall' && elB.type === 'wall') continue;

      const posA = elA.position || {};
      const posB = elB.position || {};
      const dx = Math.abs((posA.x || 0) - (posB.x || 0));
      const dy = Math.abs((posA.y || 0) - (posB.y || 0));
      const dz = Math.abs((posA.z || 0) - (posB.z || 0));

      // Perpendicular check — elements in same horizontal plane but too close
      if (Math.abs(dy) < 100) { // same level (±100mm)
        const minSep = derived.snap.attach; // M/8
        const actualDist = Math.sqrt(dx * dx + dz * dz);
        if (actualDist < minSep && actualDist > 1) {
          overlays.push(buildClearanceOverlay(elA, elB, minSep, actualDist, is_nyc));
        }
      }
    }
  }

  // ── 6. Filter by verdict ───────────────────────────────────────────────────
  let filtered = overlays;
  if (!includeGreen) {
    filtered = filtered.filter(o => o.verdict !== 'GREEN');
  }
  if (!includeAmber) {
    filtered = filtered.filter(o => o.verdict === 'RED');
  }

  return filtered;
}

// ─── Per-attachment quick check ───────────────────────────────────────────────
/**
 * Fast check for a single element being placed/dragged.
 * Called on every drag frame — lightweight.
 */
function quickCheck(element, hostElement, allElements, moduleProject) {
  const M_mm = moduleProject?.M_value || 1000;
  const is_nyc = moduleProject?.is_nyc || false;

  const results = [];

  // 1. Misalignment check
  if (element.dragging && hostElement) {
    const targetX = hostElement.position?.x || 0;
    const actualX = element.position?.x || 0;
    const delta = actualX - targetX;
    const absDelta = Math.abs(delta);

    const derived = getModuleDerived(M_mm);
    if (absDelta > derived.overlay.red) {
      results.push({
        verdict: 'RED',
        category: 'alignment',
        issue_code: 'MISALIGNMENT_VIOLATION',
        message: `Offset ${absDelta.toFixed(0)}mm exceeds M/16 (${derived.overlay.red.toFixed(0)}mm)`,
        code_reference: null,
        fix_suggestion: `Snap within ${derived.overlay.snap.coarse.toFixed(0)}mm (M/8)`,
        overlay_type: 'alignment_off',
        element_id: element.id,
        delta_mm: delta,
        target_mm: targetX,
        actual_mm: actualX,
      });
    } else if (absDelta > derived.overlay.amber) {
      results.push({
        verdict: 'AMBER',
        category: 'alignment',
        issue_code: 'MISALIGNMENT_WARNING',
        message: `Offset ${absDelta.toFixed(0)}mm close to limit — consider snapping`,
        code_reference: null,
        fix_suggestion: `Snap within ${derived.overlay.snap.coarse.toFixed(0)}mm`,
        overlay_type: 'alignment_off',
        element_id: element.id,
        delta_mm: delta,
        target_mm: targetX,
        actual_mm: actualX,
      });
    }
  }

  // 2. Door/window width check
  const params = element.parameters || {};
  if ((element.type === 'door' || element.type === 'window' || element.type_name === 'door' || element.type_name === 'window') && params.width_mm) {
    const widthResult = codeCompliance.validateDoorWidth(params.width_mm, is_nyc, M_mm);
    if (widthResult.verdict !== 'GREEN') {
      results.push({ ...widthResult, overlay_type: 'code_violation', element_id: element.id });
    }
  }

  // 3. CMU bearing check
  if (element.type === 'wall') {
    const t = (element.type_name || '').toLowerCase();
    if (t.includes('cmu') || t.includes('masonry')) {
      const bearingResult = codeCompliance.validateCMUWallBearing(element, allElements);
      results.push({ ...bearingResult, overlay_type: 'missing_bearing', element_id: element.id });
    }
  }

  return results;
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  aggregateVerdict,
  buildClearanceOverlay,
  buildAlignmentOverlay,
  buildStructuralOverlay,
  buildMissingLateralOverlay,
  buildCodeViolationOverlay,
  buildGreenConfirmOverlay,
  evaluateOverlays,
  quickCheck,
  OVERLAY_OPACITY,
};