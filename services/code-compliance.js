/**
 * Code Compliance Engine — DOB/NYC Building Code minimums at every attachment joint.
 * Owns: RED/AMBER/GREEN verdict generation, code reference tooltip generation.
 * Does NOT own: DB persistence (db/attachments.js), overlay rendering (frontend).
 *
 * Red overlay = hard code violation (must fix before export/filing).
 * Amber overlay = constructability warning (valid but unusual — flag for engineer review).
 * Green confirmation = code-compliant and buildable.
 *
 * Code references: NYC BC §28-301.1, IBC 1005.1, ASHRAE 90.1, NFPA 101, etc.
 */
const { getModuleDerived } = require('./module-system');

// ─── DOB/NYC Building Code minimums ─────────────────────────────────────────
// These are hard floors — any value below these is a RED violation in NYC projects.
const DOB_MINIMUMS = {
  doorWidthMin_in:     32,   // NYC BC §28-301.1
  doorWidthMin_mm:     32 * 25.4,
  ceilingHeightMin_ft:  7.5,  // NYC BC habitable minimum
  ceilingHeightMin_mm: 7.5 * 12 * 25.4,
  egressPathMin_in:     36,   // IBC 1005.1 min means of egress width
  egressPathMin_mm:    36 * 25.4,
  stairWidthMin_in:    44,    // IBC 1011.2.1 min stair width
  stairWidthMin_mm:    44 * 25.4,
  railingHeight_in:     42,    // IBC 1012.1 guard height
  railingHeight_mm:     42 * 25.4,
  windowSillHeight_in: 24,    // IBC 1203.4 sill height from floor
  windowSillHeight_mm: 24 * 25.4,
};

// ─── Verdict helpers ───────────────────────────────────────────────────────────
const VERDICT = { RED: 'RED', AMBER: 'AMBER', GREEN: 'GREEN', PENDING: 'PENDING' };

// ─── Door opening validation ───────────────────────────────────────────────────
/**
 * Validate door dimensions at attachment time.
 * Returns { verdict, category, issue_code, message, code_reference, fix_suggestion }
 */
function validateDoorWidth(width_mm, is_nyc = false, M_mm = 1000) {
  const minWidth = is_nyc ? DOB_MINIMUMS.doorWidthMin_mm : DOB_MINIMUMS.doorWidthMin_in * 25.4 * 0.9; // 90% for non-NYC

  if (width_mm < minWidth) {
    return {
      verdict: VERDICT.RED,
      category: 'clearance',
      issue_code: 'DOOR_WIDTH_VIOLATION',
      message: `Door width ${(width_mm / 25.4).toFixed(1)}" is below minimum ${(minWidth / 25.4).toFixed(0)}"`,
      code_reference: is_nyc ? 'NYC BC §28-301.1 — min door width 32 inches' : 'IBC §1003.3 — min door width 32 inches',
      fix_suggestion: `Increase door width to at least ${(minWidth / 25.4).toFixed(0)}" (${minWidth.toFixed(0)} mm)`,
    };
  }

  // Check against M-derived standard
  const derived = getModuleDerived(M_mm);
  if (Math.abs(width_mm - derived.door.width) > derived.overlay.amber) {
    return {
      verdict: VERDICT.AMBER,
      category: 'clearance',
      issue_code: 'DOOR_WIDTH_UNUSUAL',
      message: `Door width ${(width_mm / 25.4).toFixed(1)}" deviates from module standard ${(derived.door.width / 25.4).toFixed(1)}" by more than M/8`,
      code_reference: null,
      fix_suggestion: `Consider using standard door width: ${(derived.door.width / 25.4).toFixed(0)}" (2M)`,
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'clearance',
    issue_code: null,
    message: 'Door width is code-compliant and within module standard',
    code_reference: 'NYC BC §28-301.1 / IBC §1003.3',
    fix_suggestion: null,
  };
}

// ─── CMU wall bearing check ───────────────────────────────────────────────────
/**
 * CMU wall requires continuous footing/foundation below.
 * Returns RED if wall has no vertical support below.
 */
function validateCMUWallBearing(wallElement, allElements) {
  // Check if any element is directly below (within M/4 in XZ plane, lower in Y)
  const wallX = wallElement.position?.x || 0;
  const wallZ = wallElement.position?.z || 0;
  const wallBase = wallElement.position?.base_elevation || 0;
  const M_mm = wallElement.M_mm || 1000;
  const derived = getModuleDerived(M_mm);

  let hasSupport = false;
  for (const el of allElements) {
    if (el.type === 'footing' || el.type === 'foundation' || el.type === 'slab') {
      const elTop = el.position?.elevation || 0;
      if (elTop <= wallBase && elTop >= wallBase - 500) { // within 500mm below
        const elX = el.position?.x || 0;
        const elZ = el.position?.z || 0;
        const dx = Math.abs(elX - wallX);
        const dz = Math.abs(elZ - wallZ);
        if (dx <= derived.snap.coarse && dz <= derived.snap.coarse) {
          hasSupport = true;
          break;
        }
      }
    }
  }

  if (!hasSupport) {
    return {
      verdict: VERDICT.RED,
      category: 'bearing',
      issue_code: 'MISSING_BEARING',
      message: 'CMU wall has no vertical support below — wall cannot float',
      code_reference: 'NYC BC §1804.1 / TMS 602-16 §3.4 — CMU requires continuous bearing on foundation',
      fix_suggestion: 'Add continuous footings or foundation wall below this CMU wall',
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'bearing',
    issue_code: null,
    message: 'CMU wall has verified bearing support',
    code_reference: 'NYC BC §1804.1',
    fix_suggestion: null,
  };
}

// ─── Ceiling height validation ───────────────────────────────────────────────
function validateCeilingHeight(floorToCeiling_mm, is_nyc = false) {
  const minHeight = is_nyc ? DOB_MINIMUMS.ceilingHeightMin_mm : 2286; // 7'-6" = 2286mm, 7'-0" = 2134mm non-NYC

  if (floorToCeiling_mm < minHeight) {
    return {
      verdict: VERDICT.RED,
      category: 'clearance',
      issue_code: 'CEILING_HEIGHT_VIOLATION',
      message: `Ceiling height ${(floorToCeiling_mm / 25.4).toFixed(1)}" is below minimum ${(minHeight / 25.4).toFixed(1)}"`,
      code_reference: is_nyc ? "NYC BC §1203.2 — habitable room min ceiling height 7'-6\"" : "IBC §1203.2 — min ceiling height 7ft",
      fix_suggestion: `Raise ceiling to at least ${(minHeight / 25.4).toFixed(0)}" (${minHeight.toFixed(0)} mm)`,
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'clearance',
    issue_code: null,
    message: 'Ceiling height meets code requirements',
    code_reference: 'NYC BC §1203.2 / IBC §1203.2',
    fix_suggestion: null,
  };
}

// ─── Egress path width validation ─────────────────────────────────────────────
function validateEgressWidth(pathWidth_mm, occupancyType = 'B', is_nyc = false) {
  const minWidth = is_nyc ? DOB_MINIMUMS.egressPathMin_mm : DOB_MINIMUMS.egressPathMin_in * 25.4;

  if (pathWidth_mm < minWidth) {
    return {
      verdict: VERDICT.RED,
      category: 'egress',
      issue_code: 'EGRESS_WIDTH_VIOLATION',
      message: `Egress path width ${(pathWidth_mm / 25.4).toFixed(1)}" is below minimum ${(minWidth / 25.4).toFixed(0)}"`,
      code_reference: is_nyc ? 'NYC BC §1005.1 — means of egress min width 36 inches' : 'IBC §1005.1 — min egress width per occupant load',
      fix_suggestion: `Widen egress path to at least ${(minWidth / 25.4).toFixed(0)}" (${minWidth.toFixed(0)} mm)`,
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'egress',
    issue_code: null,
    message: 'Egress path width meets code requirements',
    code_reference: 'NYC BC §1005.1 / IBC §1005.1',
    fix_suggestion: null,
  };
}

// ─── Fire separation distance ────────────────────────────────────────────────
function validateFireSeparation(elementA, elementB, minDistance_mm, is_nyc = false) {
  const dx = Math.abs((elementA.position?.x || 0) - (elementB.position?.x || 0));
  const dy = Math.abs((elementA.position?.y || 0) - (elementB.position?.y || 0));
  const dz = Math.abs((elementA.position?.z || 0) - (elementB.position?.z || 0));
  const actualDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (actualDist < minDistance_mm) {
    return {
      verdict: VERDICT.RED,
      category: 'fire',
      issue_code: 'FIRE_SEPARATION_VIOLATION',
      message: `Fire separation distance ${actualDist.toFixed(0)} mm is below minimum ${minDistance_mm} mm`,
      code_reference: 'NYC BC §707.3 / NFPA 101 §8.7 — fire separation distance',
      fix_suggestion: `Increase separation to at least ${minDistance_mm} mm or add rated assembly between elements`,
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'fire',
    issue_code: null,
    message: 'Fire separation meets code requirements',
    code_reference: 'NYC BC §707.3 / NFPA 101',
    fix_suggestion: null,
  };
}

// ─── Span check — unsupported span warning ───────────────────────────────────
function validateSpan(clearSpan_mm, M_mm = 1000, is_nyc = false) {
  const derived = getModuleDerived(M_mm);

  if (clearSpan_mm > derived.spanThresholds.critical_mm) {
    return {
      verdict: VERDICT.RED,
      category: 'structural',
      issue_code: 'SPAN_CRITICAL',
      message: `Clear span ${(clearSpan_mm / 25.4 / 12).toFixed(1)} ft exceeds 30ft critical threshold — structural engineer review required`,
      code_reference: 'AISC 360-22 / IBC Chapter 22 — beam and column design',
      fix_suggestion: 'Reduce span or increase beam depth. Consult structural engineer.',
    };
  }

  if (clearSpan_mm > derived.spanThresholds.warning_mm) {
    return {
      verdict: VERDICT.AMBER,
      category: 'structural',
      issue_code: 'SPAN_EXCEEDS_20FT',
      message: `Clear span ${(clearSpan_mm / 25.4 / 12).toFixed(1)} ft exceeds 20ft — structural engineer review required`,
      code_reference: 'IBC Chapter 22 — beam design required',
      fix_suggestion: 'Have a structural engineer verify beam size and connection design for this span',
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'structural',
    issue_code: null,
    message: `Clear span within limits (${(clearSpan_mm / 25.4 / 12).toFixed(2)} ft)`,
    code_reference: null,
    fix_suggestion: null,
  };
}

// ─── Header required check (for door/window in wall) ──────────────────────────
/**
 * Structural header span check per IBC / NYC BC.
 * Load-bearing walls: header required for openings > 4'-0" per IBC Table 2308.5.1.
 * Non-load-bearing: header not structurally required but fire/acoustic continuity needed.
 * This check flags doors exceeding structural header span limits — requires lintel/beam above.
 */
function validateHeaderRequired(hostWall, openingWidth_mm, M_mm = 1000) {
  // IBC Table 2308.5.1: max opening span without header for load-bearing walls
  // 2x4 @ 16"oc: 6'-0" max, 2x6 @ 16"oc: 9'-0" max (conventional light-frame)
  // For masonry: header required for all openings in load-bearing walls
  const wallType = hostWall?.parameters?.wall_type || hostWall?.type_name || '';
  // hostWall.parameters.load_bearing OR wallType string check (no undefined hostType)
  const isLoadBearing = hostWall?.parameters?.load_bearing === true ||
    wallType.toLowerCase().includes('load_bearing') ||
    wallType.toLowerCase().includes('masonry') ||
    wallType.toLowerCase().includes('bearing');
  const isMasonry = wallType.toLowerCase().includes('cmu') || wallType.toLowerCase().includes('masonry');

  // Light-frame header span limits (IBC Table 2308.5.1)
  const MAX_OPENING_2X4 = 72; // 6'-0" in inches (inches for easier comparison)
  const MAX_OPENING_2X6 = 108; // 9'-0" in inches
  const MAX_OPENING_2X8 = 132; // 11'-0" in inches
  const opening_in = openingWidth_mm / 25.4;

  if (isMasonry) {
    // CMU walls always require structural header/lintel over openings
    return {
      verdict: VERDICT.RED,
      category: 'structural',
      issue_code: 'CMU_HEADER_REQUIRED',
      message: `CMU wall opening ${opening_in.toFixed(1)}" requires structural lintel/header — TMS 602 §3.3B requires lintels for all openings in load-bearing masonry`,
      code_reference: 'TMS 602 §3.3B / NYC BC §2104.3 — masonry lintels',
      fix_suggestion: `Design masonry lintel spanning ${(opening_in + 8).toFixed(0)}" (opening + 8" bearing each side) — verify by structural calc`,
    };
  }

  if (isLoadBearing) {
    if (opening_in > MAX_OPENING_2X4) {
      return {
        verdict: VERDICT.AMBER,
        category: 'structural',
        issue_code: 'HEADER_SPAN_EXCEEDED',
        message: `Opening ${opening_in.toFixed(1)}" exceeds light-frame header span limit 6'-0" (2x4) — header required`,
        code_reference: 'IBC Table 2308.5.1 / NYC BC §2308.5.1 — header spans for load-bearing walls',
        fix_suggestion: `Use 2x6 header spanning ${(opening_in + 16).toFixed(0)}" (9'-0" max) or 2x8 for larger spans. Verify by structural calcs.`,
      };
    }
    return {
      verdict: VERDICT.GREEN,
      category: 'structural',
      issue_code: null,
      message: `Opening within 2x4 header span limit (6'-0") — no structural header required for non-masonry load-bearing`,
      code_reference: 'IBC Table 2308.5.1',
      fix_suggestion: null,
    };
  }

  // Non-load-bearing: no structural header required, but flag wide openings
  if (opening_in > 48) { // > 4'-0"
    return {
      verdict: VERDICT.AMBER,
      category: 'structural',
      issue_code: 'NONBEARING_WIDE_OPENING',
      message: `Non-load-bearing wall opening ${opening_in.toFixed(1)}" — header recommended for stiffness and crack control, though not structurally required`,
      code_reference: 'IBC §2308.5.1 (commentary) — header recommended for openings > 4ft in nonbearing walls',
      fix_suggestion: 'Add single stud header or 2x4 header for stiffness; not a code violation if non-load-bearing',
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'structural',
    issue_code: null,
    message: 'Non-load-bearing wall: no structural header required',
    code_reference: null,
    fix_suggestion: null,
  };
}

// ─── Slab-to-beam composite check ─────────────────────────────────────────────
/**
 * Validate shear stud requirements for composite slab-beam connections.
 */
function validateSlabBeamConnection(connectionMetadata = {}, M_mm = 1000) {
  const { shear_stud_dia_mm, shear_stud_count, composite, slab_depth_mm } = connectionMetadata;

  if (composite === false) {
    return {
      verdict: VERDICT.GREEN,
      category: 'structural',
      issue_code: null,
      message: 'Non-composite slab-beam: shear studs not required',
      code_reference: null,
      fix_suggestion: null,
    };
  }

  if (!shear_stud_dia_mm) {
    return {
      verdict: VERDICT.RED,
      category: 'structural',
      issue_code: 'MISSING_SHEAR_STUDS',
      message: 'Composite slab-beam connection lacks shear stud specification — AISC I3.2 requires shear studs for composite action',
      code_reference: 'AISC 360-22 §I3.2 / IBC Chapter 22 — composite beam design',
      fix_suggestion: 'Specify shear studs: 13mm min dia, 2 per rib at max 24" oc, minimum 2 studs per beam',
    };
  }

  if (shear_stud_dia_mm < 13) {
    return {
      verdict: VERDICT.RED,
      category: 'structural',
      issue_code: 'SHEAR_STUD_SIZE_VIOLATION',
      message: `Shear stud diameter ${shear_stud_dia_mm}mm below AISC minimum 13mm — cannot achieve required shear capacity`,
      code_reference: 'AISC 360-22 §I3.2(a) — shear stud diameter min 13mm',
      fix_suggestion: 'Increase shear stud diameter to at least 13mm, preferably 16mm or 19mm for deeper decks',
    };
  }

  if (!shear_stud_count || shear_stud_count < 2) {
    return {
      verdict: VERDICT.AMBER,
      category: 'structural',
      issue_code: 'INSUFFICIENT_SHEAR_STUDS',
      message: `Only ${shear_stud_count || 0} shear studs specified — minimum 2 studs per beam rib for composite action`,
      code_reference: 'AISC 360-22 §I3.2(c) — shear stud spacing and quantity',
      fix_suggestion: 'Add at least 2 studs per beam at locations of maximum moment',
    };
  }

  return {
    verdict: VERDICT.GREEN,
    category: 'structural',
    issue_code: null,
    message: 'Shear stud specification meets AISC composite connection requirements',
    code_reference: 'AISC 360-22 §I3.2',
    fix_suggestion: null,
  };
}

// ─── Batch overlay generation ─────────────────────────────────────────────────
/**
 * Given an attachment constraint + element data, run all applicable checks and
 * return array of overlay records.
 */
function checkAttachment(constraint, hostElement, attachedElement, allElements, moduleProject) {
  const { M_value, system_name, is_nyc } = moduleProject || {};
  const M_mm = M_value || 1000;
  const derived = getModuleDerived(M_mm);
  const results = [];

  const connectionType = constraint.connection_type_code;

  switch (connectionType) {
    case 'door_in_wall': {
      const doorWidth = attachedElement.parameters?.width_mm || attachedElement.parameters?.width * 25.4 || 0;
      results.push(validateDoorWidth(doorWidth, is_nyc, M_mm));
      if (doorWidth > M_mm / 2) {
        results.push(validateHeaderRequired(hostElement, doorWidth, M_mm));
      }
      break;
    }
    case 'window_in_wall': {
      const windowWidth = attachedElement.parameters?.width_mm || 0;
      const sillHeight = attachedElement.parameters?.sill_height_mm || 0;
      if (sillHeight > 0 && sillHeight < DOB_MINIMUMS.windowSillHeight_mm) {
        results.push({
          verdict: VERDICT.RED,
          category: 'clearance',
          issue_code: 'WINDOW_SILL_HEIGHT_VIOLATION',
          message: `Window sill height ${(sillHeight / 25.4).toFixed(1)}" is below minimum ${(DOB_MINIMUMS.windowSillHeight_mm / 25.4).toFixed(0)}"`,
          code_reference: 'NYC BC §1203.4 — window sill height',
          fix_suggestion: `Raise sill to at least ${(DOB_MINIMUMS.windowSillHeight_mm / 25.4).toFixed(0)}"`,
        });
      }
      results.push(validateDoorWidth(windowWidth, is_nyc, M_mm)); // reuse door width check
      break;
    }
    case 'cmu_wall_to_foundation': {
      results.push(validateCMUWallBearing(hostElement, allElements));
      break;
    }
    case 'stair_to_floor': {
      // Stair width check
      const stairWidth = attachedElement.parameters?.width_mm || 0;
      if (stairWidth < DOB_MINIMUMS.stairWidthMin_mm) {
        results.push({
          verdict: VERDICT.RED,
          category: 'clearance',
          issue_code: 'STAIR_WIDTH_VIOLATION',
          message: `Stair width ${(stairWidth / 25.4).toFixed(1)}" is below minimum ${(DOB_MINIMUMS.stairWidthMin_mm / 25.4).toFixed(0)}"`,
          code_reference: 'IBC §1011.2.1 — min stair width 44 inches',
          fix_suggestion: `Increase stair width to at least ${(DOB_MINIMUMS.stairWidthMin_mm / 25.4).toFixed(0)}"`,
        });
      }
      break;
    }
  }

  // Always check: misalignment overlay (M/16 trigger)
  const misalignment = constraint.offset_x !== undefined ? Math.abs(constraint.offset_x) : 0;
  if (misalignment > derived.overlay.red) {
    results.push({
      verdict: VERDICT.RED,
      category: 'clearance',
      issue_code: 'MISALIGNMENT_VIOLATION',
      message: `Element misalignment ${misalignment.toFixed(1)} mm exceeds M/16 (${(derived.overlay.red).toFixed(1)} mm) tolerance`,
      code_reference: null,
      fix_suggestion: `Snap to nearest module grid — within ${(derived.overlay.red).toFixed(1)} mm`,
    });
  } else if (misalignment > derived.overlay.amber) {
    results.push({
      verdict: VERDICT.AMBER,
      category: 'clearance',
      issue_code: 'MISALIGNMENT_WARNING',
      message: `Element misalignment ${misalignment.toFixed(1)} mm exceeds M/8 (${(derived.overlay.amber).toFixed(1)} mm) — close but not snapped`,
      code_reference: null,
      fix_suggestion: `Adjust to snap within ${(derived.overlay.amber).toFixed(1)} mm of module grid`,
    });
  }

  return results;
}

module.exports = {
  VERDICT,
  DOB_MINIMUMS,
  validateDoorWidth,
  validateCMUWallBearing,
  validateCeilingHeight,
  validateEgressWidth,
  validateFireSeparation,
  validateSpan,
  validateHeaderRequired,
  validateSlabBeamConnection,
  checkAttachment,
};