/**
 * Base Module System — Atlantist BIM 2.0
 * Owns: getModuleDerived(), convertToDisplay(), STANDARD_ON_CENTER array.
 * Does NOT own: project settings, attachment persistence, UI rendering.
 *
 * The base module M is the single source of truth from which all parametric
 * geometry and snapping behaviour is derived. Systems (SI/Imperial/Modulor/Ken)
 * share the same derived values — only the display unit changes.
 *
 * CRITICAL DESIGN PRINCIPLE: These are real-world construction dimensions,
 * not game mechanics. All candidates are constrained to actual standard sizes.
 * DOB/NYC overrides take precedence for NYC projects.
 */

// ─── On-Center Spacing Standards ─────────────────────────────────────────────
// Standard construction spacings derived from M (primary) + common practice
const STANDARD_ON_CENTER = [12, 16, 24, 32, 48]; // inches — used for snap ranking

// ─── Display unit formats ─────────────────────────────────────────────────────
const IMPERIAL_INCH_DISPLAY = (inches) => {
  const totalInches = Math.round(inches);
  const ft = Math.floor(totalInches / 12);
  const ins = totalInches % 12;
  if (ft === 0) return `${ins}"`;
  if (ins === 0) return `${ft}'`;
  return `${ft}'-${ins}"`;
};

const IMPERIAL_DECIMAL_DISPLAY = (inches) => `${inches.toFixed(3)}"`;

const SI_DISPLAY_MM = (mm) => {
  if (Math.abs(mm) >= 1000) return `${(mm / 1000).toFixed(3)} m`;
  return `${Math.round(mm)} mm`;
};

const SI_DISPLAY_CM = (cm) => `${cm.toFixed(2)} cm`;

const MODULOR_DISPLAY = (mm) => {
  // Le Corbusier Modulor uses 226mm base unit — display as "2M + 10mm" style
  const baseUnit = 226;
  const multiples = Math.round(mm / baseUnit * 100) / 100;
  return `${mm.toFixed(1)} mm (${multiples.toFixed(2)}M)`;
};

const KEN_DISPLAY = (mm) => {
  // Japanese Ken = 910mm (3 shaku 0 sun) or 1820mm for paired rooms
  const ken = 910;
  const multiples = Math.round(mm / ken * 100) / 100;
  return `${mm.toFixed(1)} mm (${multiples.toFixed(2)} ken)`;
};

// ─── Primary export: getModuleDerived(M, system) ───────────────────────────────
/**
 * Returns all module-derived values for a given base M (in millimeters) and unit system.
 * @param {number} M - Base module value. For SI: millimeters. For Imperial: also millimeters (input converted from inches internally).
 * @param {object} system - { name: 'si'|'imperial'|'modulor'|'ken'|'custom', M_input: number, label: string }
 * @returns {object} Derived values keyed by name
 */
function getModuleDerived(M, system = { name: 'si', M_input: 1000, label: 'SI (Meter)' }) {
  const sys = system.name || 'si';

  // All internal computation happens in millimeters
  // For Imperial, M_input is already in inches — convert to mm
  const M_mm = sys === 'imperial' ? system.M_input * 25.4 : M;

  const halfM  = M_mm / 2;
  const quarterM = M_mm / 4;
  const eighthM = M_mm / 8;
  const doubleM = M_mm * 2;
  const quadrupleM = M_mm * 4;
  const sextupleM = M_mm * 6;

  // Grid spacing candidates
  const gridSpacings = [
    { label: 'M', value: M_mm },
    { label: 'M/2', value: halfM },
    { label: 'M/4', value: quarterM },
    { label: '2M', value: doubleM },
    { label: '4M', value: quadrupleM },
  ];

  // Snap thresholds
  const snapFine   = eighthM;
  const snapCoarse = quarterM;
  const snapAttach = eighthM;

  // Default wall thickness candidates (real-world standard sizes, mm)
  const wallThicknessCandidates = [
    { label: 'M/4', value: quarterM, description: 'Light frame partition' },
    { label: 'M/3', value: M_mm / 3, description: 'Stud wall (3-5/8" = 92mm ≈ M/3 for M≈300mm)' },
    { label: 'M/2', value: halfM, description: 'CMU 8" (203mm ≈ M/2 for M≈400mm)' },
  ];

  // Default slab thickness = M/4
  const slabThickness = quarterM;

  // Default floor-to-floor height = 4M
  const floorToFloor = quadrupleM;

  // Door dimensions: width = 2M, height = 4M (with DOB override minimums)
  const doorWidth  = doubleM;
  const doorHeight = quadrupleM;

  // DOB minimums (NYC projects always override with these)
  const dobMinimums = {
    doorWidthMin_in: 32,     // NYC BC §28-301.1
    doorWidthMin_mm: 32 * 25.4,
    ceilingHeightMin_ft: 7.5, // NYC BC habitable minimum
    ceilingHeightMin_mm: 7.5 * 12 * 25.4,
    egressPathMin_in: 36,     // IBC 1005.1
    fireSeparation_ft: 0,    // varies by occupancy — placeholder for future
  };

  // Structural overlay thresholds
  const overlayTriggerRed   = eighthM / 2;   // M/16 — hard violation
  const overlayTriggerAmber = eighthM;       // M/8  — constructability warning

  // Column grid multiplier default
  const columnGridN_default = 4;
  const columnSpacing = M_mm * columnGridN_default;

  // Standard on-center spacings in mm (for snap ranking)
  const standardOC_mm = STANDARD_ON_CENTER.map(oc => oc * 25.4);

  // Load path span thresholds (ft → mm)
  const spanWarning_ft   = 20;   // "structural engineer review required"
  const spanWarning_mm   = spanWarning_ft * 12 * 25.4;
  const spanCritical_ft  = 30;
  const spanCritical_mm  = spanCritical_ft * 12 * 25.4;

  // Real-world material defaults (constrained to standard sizes)
  const materialDefaults = {
    cmu8_in:    8,
    cmu8_mm:    8 * 25.4,
    gwbStud_in: 3.625,  // 3-5/8" steel stud
    gwbStud_mm: 3.625 * 25.4,
    gwbTotal_in: 4.625, // stud + 0.5" GWB each side
    gwbTotal_mm: 4.625 * 25.4,
    brickVeneer_in: 4,
    brickVeneer_mm: 4 * 25.4,
  };

  return {
    M_mm,
    sys,
    grid: gridSpacings,
    snap: { fine: snapFine, coarse: snapCoarse, attach: snapAttach },
    wallThickness: wallThicknessCandidates,
    slabThickness,
    floorToFloor,
    door: { width: doorWidth, height: doorHeight, dobMinWidth_mm: dobMinimums.doorWidthMin_mm },
    columnGrid: { N_default: columnGridN_default, spacing: columnSpacing },
    overlay: {
      red:   overlayTriggerRed,   // M/16
      amber: overlayTriggerAmber,  // M/8
      dob: dobMinimums,
    },
    standardOC_mm,
    spanThresholds: { warning_mm: spanWarning_mm, critical_mm: spanCritical_mm },
    materialDefaults,
  };
}

// ─── Unit conversion ───────────────────────────────────────────────────────────
/**
 * Convert mm value to display string based on unit system.
 */
function convertToDisplay(mm, system = { name: 'si', M_input: 1000, label: 'SI (Meter)' }) {
  switch (system.name) {
    case 'imperial':
      return IMPERIAL_INCH_DISPLAY(mm / 25.4);
    case 'modulor':
      return MODULOR_DISPLAY(mm);
    case 'ken':
      return KEN_DISPLAY(mm);
    case 'si':
    default:
      // SI prefers cm for 1–999mm, m for ≥1000mm
      if (Math.abs(mm) >= 1000) {
        return `${(mm / 1000).toFixed(3)} m`;
      } else if (Math.abs(mm) >= 100) {
        return `${(mm / 10).toFixed(1)} cm`;
      }
      return `${Math.round(mm)} mm`;
  }
}

/**
 * Parse a display value string back to mm. Handles "3'-6"", "1000mm", "2M", "1.5 ken".
 */
function parseToMm(valueStr, system = { name: 'si', M_input: 1000, label: 'SI (Meter)' }) {
  const s = valueStr.trim().toLowerCase();
  const sys = system.name || 'si';

  // Imperial feet-inch: "3'-6"", "3' 6"", "36in", "36\""
  const ftInMatch = s.match(/^(?:(\/[\"'])|(\/[\"'])|([\/\/.0-9]+)['"]?\/?['"]?\/?)/);
  if (s.includes("'") || s.includes('ft') || s.includes('foot')) {
    const parts = s.replace(/'/g, ' ').replace(/"/g, '').trim().split(/\bat\b|\bx\b|\bft\b|\bin\b|\bcm\b|\bmm\b|\bm\b|\bken\b|\bM\b|\b'/);
    let totalIn = 0;
    for (const p of parts) {
      const n = parseFloat(p.trim());
      if (!isNaN(n)) {
        if (p.includes("'") || p.includes("ft")) totalIn += n * 12;
        else totalIn += n;
      }
    }
    return totalIn * 25.4;
  }

  // Explicit units
  if (s.endsWith('mm')) return parseFloat(s);
  if (s.endsWith('cm')) return parseFloat(s) * 10;
  if (s.endsWith('m')) return parseFloat(s) * 1000;
  if (s.endsWith('in') || s.endsWith('"')) return parseFloat(s) * 25.4;

  // Module multiples: "2M", "M/4"
  if (s.includes('M')) {
    const M_mm = sys === 'imperial' ? system.M_input * 25.4 : system.M_input;
    const match = s.match(/^([\/\/.0-9]+)\/?M$/);
    if (match) {
      if (match[1] === '' || match[1] === '/') return M_mm; // just "M"
      const factor = parseFloat(match[1]);
      if (s.includes('/')) return M_mm / factor;
      return factor * M_mm;
    }
  }

  // Ken
  if (s.includes('ken')) {
    const ken = 910;
    return parseFloat(s) * ken;
  }

  // Plain number — assume mm
  return parseFloat(s);
}

/**
 * Return "4M" style representation of a value relative to M.
 */
function toModuleMultiple(mm, M_mm) {
  const ratio = mm / M_mm;
  if (Math.abs(ratio - Math.round(ratio)) < 0.001) {
    return `${Math.round(ratio)}M`;
  }
  const inv = M_mm / mm;
  if (Math.abs(inv - Math.round(inv)) < 0.001) {
    return `M/${Math.round(inv)}`;
  }
  return `${(mm / M_mm).toFixed(2)}M`;
}

/**
 * Format value for display in module multiples mode.
 */
function formatInModuleMultiple(mm, M_mm) {
  return toModuleMultiple(mm, M_mm);
}

module.exports = {
  getModuleDerived,
  convertToDisplay,
  parseToMm,
  toModuleMultiple,
  formatInModuleMultiple,
  STANDARD_ON_CENTER,
};