/**
 * Owns: Conduit fill calculations (NEC Chapter 9), wire ampacity (NEC Table 310.16),
 *       panel load calculations, voltage drop analysis.
 * Does NOT own: BIM data loading, DB access, Three.js visualization.
 *
 * Engine: Pure JS NEC reference-lookup calculations.
 * Formula-based only — NEC ampacity tables are lookup-only (no binary solvers needed).
 * Animated viz: circuit load bars + voltage drop color maps.
 *
 * ⚠️ DISCLAIMER: Results are estimates. All electrical designs must be reviewed
 * by a licensed PE. Atlantist does not guarantee code compliance or regulatory
 * approval. Responsibility is on the user.
 */

// ─── NEC Wire Ampacity Tables ───────────────────────────────────────────

/** NEC Table 310.16: Allowable ampacities of insulated conductors (copper, 60°C/75°C/90°C).
 *  Key: AWG → [60°C, 75°C, 90°C] */
const AMPACITY_COPPER_60_75_90 = {
  18: [null, 14, 18],
  16: [null, 18, 24],
  14: [15, 20, 25],
  12: [20, 25, 30],
  10: [30, 35, 40],
  8:  [40, 50, 55],
  6:  [55, 65, 75],
  4:  [70, 85, 95],
  3:  [85, 100, 115],
  2:  [95, 115, 130],
  1:  [110, 130, 145],
  '1/0': [125, 150, 170],
  '2/0': [145, 175, 195],
  '3/0': [165, 200, 225],
  '4/0': [195, 230, 260],
  250: [215, 255, 290],
  300: [240, 285, 320],
  350: [260, 310, 350],
  400: [280, 335, 380],
  500: [320, 380, 430],
  600: [350, 420, 475],
  750: [400, 480, 545],
  1000:[455, 545, 615],
};

/** Temperature rating columns (NEC 110.14) */
const TEMP_RATINGS = { 60: '60°C', 75: '75°C', 90: '90°C' };

/** Common wire types */
const WIRE_TYPES = {
  THHN: { rating: 90, uses: ['dry locations', 'conduit'] },
  THWN: { rating: 75, uses: ['wet/dry locations', 'conduit'] },
  XHHW: { rating: 90, uses: ['wet locations', 'conduit'] },
  UF: { rating: 60, uses: ['underground', 'direct burial'] },
  NM: { rating: 60, uses: ['residential branch circuits'] },
  MC: { rating: 75, uses: ['industrial', 'cable tray'] },
};

// ─── Conduit Fill (NEC Chapter 9) ────────────────────────────────────────

/** NEC Chapter 9: Conduit fill percentages */
const CONDUIT_FILL = {
  1:    { fills: [53, 100, 100] },   // 1 conductor: 53%, 100%, 100%
  2:    { fills: [31, 100, 100] },
  '3+': { fills: [40, 100, 100] },
};

/** Conduit trade sizes and their internal areas (in²) */
const CONDUIT_AREAS = {
  emt: {
    0.5: 0.122, 0.75: 0.213, 1: 0.346, 1.25: 0.598, 1.5: 0.814,
    2: 1.342, 2.5: 2.343, 3: 3.538, 3.5: 4.618, 4: 5.901,
  },
  pvc: {
    0.5: 0.127, 0.75: 0.226, 1: 0.376, 1.25: 0.655, 1.5: 0.889,
    2: 1.452, 2.5: 2.464, 3: 3.702, 3.5: 4.862, 4: 6.219,
  },
};

// ─── Ampacity Calculation ───────────────────────────────────────────────

/**
 * Look up NEC Table 310.16 ampacity for copper wire.
 * @param {number} awg — wire gauge (14, 12, 10, 8, etc.)
 * @param {number} tempCol — temperature rating: 60, 75, or 90
 * @returns {number} ampacity in amps
 */
function lookupAmpacity(awg, tempCol = 75) {
  const row = AMPACITY_COPPER_60_75_90[awg];
  if (!row) return null;
  if (tempCol === 60) return row[0] ?? row[1];
  if (tempCol === 90) return row[2] ?? row[1];
  return row[1] ?? row[0] ?? null;
}

/**
 * Adjust ampacity for ambient temperature (NEC Table 310.15(B)(1)).
 * @param {number} ampacity — base ampacity
 * @param {number} tempF — ambient temperature in °F
 * @param {number} wireTempRating — wire temperature rating (60/75/90)
 */
function adjustForTemperature(ampacity, tempF, wireTempRating = 75) {
  const correctionFactor = tempCorrectionFactor(tempF, wireTempRating);
  return Math.round(ampacity * correctionFactor);
}

function tempCorrectionFactor(tempF, wireTempRating) {
  // NEC Table 310.15(B)(1) ambient correction factors
  if (wireTempRating === 60) {
    if (tempF <= 140) return 1.0;
    if (tempF <= 158) return 0.91;
    if (tempF <= 176) return 0.82;
    if (tempF <= 194) return 0.71;
    if (tempF <= 212) return 0.58;
    return 0.41;
  }
  if (wireTempRating === 75) {
    if (tempF <= 140) return 1.0;
    if (tempF <= 158) return 0.92;
    if (tempF <= 176) return 0.83;
    if (tempF <= 194) return 0.74;
    if (tempF <= 212) return 0.67;
    if (tempF <= 227) return 0.58;
    return 0.47;
  }
  // 90°C
  if (tempF <= 140) return 1.0;
  if (tempF <= 158) return 0.91;
  if (tempF <= 176) return 0.82;
  if (tempF <= 194) return 0.73;
  if (tempF <= 212) return 0.71;
  if (tempF <= 227) return 0.62;
  return 0.51;
}

/**
 * Calculate voltage drop (NEC recommends ≤3% for branch, ≤5% for feeder).
 * V_drop = (2 * K * I * L) / CM — K=12.9 for copper, I=amps, L=length ft, CM=circular mils
 */
function calcVoltageDrop(amps, lengthFt, wireAWG, phase = 'single') {
  const cm = wireToCircularMils(wireAWG);
  const k = 12.9; // ohm-cmil/ft for copper
  const multiplier = phase === 'single' ? 2 : 1.732;
  const vDrop = (multiplier * k * amps * lengthFt) / cm;

  return {
    voltsDropped: Math.round(vDrop * 100) / 100,
    percentDrop: Math.round((vDrop / 240) * 100 * 10) / 10, // assume 240V for single-phase
    pass3pct: vDrop / 240 <= 0.03,
    pass5pct: vDrop / 240 <= 0.05,
    note: 'NEC recommends ≤3% branch, ≤5% feeder. Results are estimates.',
  };
}

function wireToCircularMils(awg) {
  const cm = {
    14: 4110, 12: 6530, 10: 10380, 8: 16510, 6: 26240,
    4: 41740, 3: 52620, 2: 66360, 1: 83690,
    '1/0': 105600, '2/0': 133100, '3/0': 167800, '4/0': 211600,
    250: 250000, 300: 300000, 350: 350000, 400: 400000,
    500: 500000, 600: 600000, 750: 750000, 1000: 1000000,
  };
  return cm[awg] || 0;
}

/**
 * Select minimum wire size for a given load.
 * @param {number} amps — load current in amps
 * @param {number} lengthFt — circuit length in feet
 * @param {number} maxVDropPct — maximum allowed voltage drop (0.03 = 3%)
 */
function selectWireSize(amps, lengthFt, maxVDropPct = 0.03) {
  const awgs = [14, 12, 10, 8, 6, 4, 3, 2, 1, '1/0', '2/0', '3/0', '4/0'];
  const ampLimits = [20, 25, 35, 50, 65, 85, 100, 115, 130, 150, 175, 200, 230];
  const maxV = 240;
  const k = 12.9;

  for (let i = 0; i < awgs.length; i++) {
    const ampCap = ampLimits[i];
    const cm = wireToCircularMils(awgs[i]);
    const vDrop = (2 * k * amps * lengthFt) / cm;
    const pct = vDrop / maxV;
    if (ampCap >= amps && pct <= maxVDropPct) {
      const vd = calcVoltageDrop(amps, lengthFt, awgs[i]);
      return { awg: awgs[i], ampacity: ampCap, ...vd };
    }
  }
  return null; // needs larger than 4/0
}

/**
 * Calculate conduit fill for a set of conductors.
 * Returns conduit size recommendation and fill %.
 */
function calcConduitFill(conductors, conduitType = 'emt') {
  // Each conductor: { awg, quantity }
  const table = CONDUIT_AREAS[conduitType];
  if (!table) return { error: 'Unknown conduit type' };

  // Wire area: NM/cable approx circular mils → area in²
  // Quick approx: each wire occupies area proportional to (AWG/40)^2 * 0.1 in²
  const totalArea = conductors.reduce((sum, c) => {
    const wireArea = awgToAreaIn2(c.awg);
    return sum + wireArea * (c.quantity || 1);
  }, 0);

  // Find smallest conduit where fill ≤ allowed %
  const sizes = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (const size of sizes) {
    const fillCap = table[size];
    const conductorCount = conductors.reduce((s, c) => s + (c.quantity || 1), 0);
    let maxFill;
    if (conductorCount === 1) maxFill = 0.53;
    else if (conductorCount === 2) maxFill = 0.31;
    else maxFill = 0.40;

    if (totalArea / fillCap <= maxFill) {
      const fillPct = Math.round((totalArea / fillCap) * 100);
      return {
        tradeSize: size,
        totalAreaIn2: Math.round(totalArea * 1000) / 1000,
        fillPct,
        note: fillPct > 40
          ? 'Conduit fill exceeds NEC Chapter 9 limit for 3+ conductors'
          : 'Fill within NEC limits',
      };
    }
  }
  return { error: 'Circuit requires conduit larger than 4"' };
}

function awgToAreaIn2(awg) {
  const areas = {
    14: 0.0104, 12: 0.0133, 10: 0.0211, 8: 0.0366, 6: 0.0507,
    4: 0.0824, 3: 0.0973, 2: 0.115, 1: 0.156,
    '1/0': 0.186, '2/0': 0.216, '3/0': 0.252, '4/0': 0.292,
  };
  return areas[awg] || 0.01;
}

/**
 * Panel load calculation (NEC 220.87 optional method).
 * Sum connected loads, apply demand factor, calculate service size.
 */
function calcPanelLoad(loads, options = {}) {
  const { voltage = 208, phase = '3phase' } = options;
  const { lightingKW = 0, receptacleKW = 0, motorHP = 0, equipmentKW = 0 } = loads;

  // Demand factors per NEC Table 220.42/44
  const generalLighting = lightingKW * 0.5;       // 50% demand factor
  const receptacle = Math.min(receptacleKW, 10) * 0.5 + Math.max(0, receptacleKW - 10) * 0.25;
  const motorFS = motorHP * 0.746 / 0.85;           // full-load current, 85% efficiency
  const equipment = equipmentKW * 0.8;             // 80% demand factor for large equipment

  const totalKW = generalLighting + receptacle + equipment;
  const amps = phase === '3phase'
    ? (totalKW * 1000) / (voltage * 1.732)
    : (totalKW * 1000) / voltage;

  // Standard panel sizes
  const standardAmps = [100, 200, 225, 400, 600];
  const selectedPanel = standardAmps.find(a => a >= amps * 1.25) || 800;

  return {
    generalLightingKW: Math.round(generalLighting * 10) / 10,
    receptacleKW: Math.round(receptacle * 10) / 10,
    motorKW: Math.round(motorFS * 10) / 10,
    equipmentKW: Math.round(equipment * 10) / 10,
    totalKW: Math.round(totalKW * 10) / 10,
    calculatedAmps: Math.round(amps),
    recommendedPanelAmps: selectedPanel,
    voltage,
    phase,
    loadBalanceTip: 'Balance phases within 10% to avoid neutral current.',
  };
}

// ─── Full Electrical Run ───────────────────────────────────────────────

function runElectrical(model, options = {}) {
  const { voltage = 208, phase = '3phase', ambientTempF = 90 } = options;
  const bounds = getModelBounds(model.elements || []);
  const floorArea = bounds ? (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) : 100;
  const floorAreaSqft = floorArea * 10.764;

  // Typical office electrical loads per NEC
  const lightingKW = floorAreaSqft * 1.3 / 1000;  // 1.3 W/sqft
  const receptacleKW = floorAreaSqft * 1.5 / 1000; // 1.5 W/sqft for receptacles
  const motorHP = 0;                               // default — user can override
  const equipmentKW = 0;

  const panel = calcPanelLoad({ lightingKW, receptacleKW, motorHP, equipmentKW }, { voltage, phase });
  const wiring = selectWireSize(panel.calculatedAmps, 100, 0.03);

  // Conduit fill for typical branch circuit: 3 #12 (phase, neutral, ground) + 1 spare
  const conduitFill = calcConduitFill([
    { awg: wiring?.awg || 12, quantity: 3 },
    { awg: 12, quantity: 1 }, // spare
  ], 'emt');

  // Service entrance check
  const serviceAmps = panel.recommendedPanelAmps;
  const serviceWire = selectWireSize(serviceAmps * 0.8, 50, 0.02);

  return {
    panel,
    wiring: wiring ? {
      awg: wiring.awg,
      ampacity: wiring.ampacity,
      voltageDropPct: wiring.percentDrop,
      pass: wiring.pass3pct,
    } : null,
    conduit: {
      type: 'EMT',
      size: conduitFill.tradeSize || conduitFill.error,
      fillPct: conduitFill.fillPct || null,
    },
    serviceEntrance: {
      calculatedAmps: Math.round(serviceAmps * 0.8),
      recommendedAWG: serviceWire?.awg || '3/0',
      recommendedAmpacity: serviceWire?.ampacity || 200,
    },
    wireTypes: WIRE_TYPES,
    compliance: {
      code: 'NEC 2023',
      status: (wiring?.pass ?? true) && (conduitFill.fillPct <= 40) ? 'PASS' : 'FAIL',
      notes: 'Verify with local AHJ. NYC requires AFCI protection for many circuits.',
    },
    disclaimer: DISCLAIMER,
  };
}

const DISCLAIMER = '⚠️ Atlantist MEP tools are professional design aids. Results are estimates. All MEP designs must be reviewed by a licensed PE. Atlantist does not guarantee code compliance or regulatory approval. Responsibility is on the user.';

// ─── Helpers ─────────────────────────────────────────────────────────────

function getModelBounds(elements) {
  if (!elements || elements.length === 0) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const el of elements) {
    const p = safeParse(el.parameters);
    const x = parseFloat(p.x) || 0, z = parseFloat(p.z) || 0;
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x + (parseFloat(p.length) || 5));
    maxZ = Math.max(maxZ, z + (parseFloat(p.length) || 5));
  }
  return { minX, minZ, maxX, maxZ };
}

function safeParse(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return {}; }
}

module.exports = {
  runElectrical,
  lookupAmpacity,
  adjustForTemperature,
  calcVoltageDrop,
  selectWireSize,
  calcConduitFill,
  calcPanelLoad,
  AMPACITY_COPPER_60_75_90,
  WIRE_TYPES,
  DISCLAIMER,
};