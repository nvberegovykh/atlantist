/**
 * Owns: Universal simulation guardrails — input validation, code compliance checking,
 *       design guidance generation, and code reference lookup for all simulation types.
 * Does NOT own: Simulation engines, DB access, UI rendering, WebSocket broadcast.
 *
 * Core principle: Don't reject bad input — explain WHY it's wrong, WHAT the code
 * requires, and HOW to fix it. Be a helpful co-designer, not a form validator.
 *
 * ⚠️ All results are estimates — licensed professional review required per project.
 */

/** @type {Record<string, {icon: string, color: string}>} */
const SEVERITY_STYLES = {
  CRITICAL: { icon: '🚨', color: '#dc2626', label: 'Critical' },
  WARNING:  { icon: '⚠️',  color: '#d97706', label: 'Warning' },
  INFO:     { icon: 'ℹ️',   color: '#2563eb', label: 'Info' },
};

const DISCLAIMER = 'Results are for reference only — all designs must be reviewed by a licensed professional. Atlantist is a design tool, not a substitute for professional engineering judgment.';

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION RULES PER SIMULATION TYPE
// ═══════════════════════════════════════════════════════════════════════════════

const VALIDATION_RULES = {
  energy: [
    {
      field: 'wallUValue', label: 'Wall U-value', unit: 'W/m²·K',
      min: 0.05, max: 5.0,
      code: 'NYC BC §1103 / NYECC Table C402.1.3 (Climate Zone 4A)',
      codeSection: 'NYC BC §1103',
      hint: 'NYECC 2020 max: 0.365 W/m²·K for above-grade walls. Value of {value} W/m²·K is {exceeds}% over limit.',
      severity: 'WARNING',
    },
    {
      field: 'roofUValue', label: 'Roof U-value', unit: 'W/m²·K',
      min: 0.02, max: 2.0,
      code: 'NYECC Table C402.1.3',
      codeSection: 'NYC BC §1103',
      hint: 'NYECC 2020 max: 0.185 W/m²·K for roof/ceiling assemblies.',
      severity: 'WARNING',
    },
    {
      field: 'windowUValue', label: 'Window U-value', unit: 'W/m²·K',
      min: 0.5, max: 5.0,
      code: 'NYECC Table C402.1.3 / NFRC 100',
      codeSection: 'NYC BC §1103',
      hint: 'NYECC max: 2.0 W/m²·K (double glazed). SHGC must also be ≤ 0.40 for Zone 4A.',
      severity: 'WARNING',
    },
    {
      field: 'windowSHGC', label: 'Window SHGC', unit: '',
      min: 0.0, max: 1.0,
      code: 'NYECC Table C402.1.3',
      codeSection: 'NYC BC §1103',
      hint: 'NYECC 2020 max SHGC: 0.40 for Climate Zone 4A. High-SHGC glazing increases cooling load.',
      severity: 'WARNING',
    },
    {
      field: 'wwr', label: 'Window-to-Wall Ratio', unit: '%',
      min: 0, max: 100,
      code: 'NYC BC §1109 / ASHRAE 90.1 §5.4',
      codeSection: 'NYC BC §1109',
      hint: 'Maximum WWR: 40% without detailed analysis. Your value is {value}%. Oversized glazing dramatically increases heating and cooling loads.',
      severity: 'WARNING',
    },
    {
      field: 'lightingPowerDensity', label: 'Lighting Power Density', unit: 'W/m²',
      min: 0.5, max: 30,
      code: 'NYECC Table C405.3.2(1) / ASHRAE 90.1 Table 9.5.1',
      codeSection: 'NYECC Table C405.3.2(1)',
      hint: 'Office space: max 10.8 W/m². Healthcare: 12.2 W/m². Exceeding increases cooling load and EUI.',
      severity: 'WARNING',
    },
    {
      field: 'infiltrationACH', label: 'Infiltration Rate', unit: 'ACH',
      min: 0, max: 5,
      code: 'ASHRAE 90.1 §5.4.3 / NYECC C402.5',
      codeSection: 'NYECC C402.5',
      hint: 'Best practice ≤ 0.35 ACH. Values above 1.0 ACH severely degrade thermal envelope performance.',
      severity: 'CRITICAL',
    },
    {
      field: 'heatingSetpoint', label: 'Heating Setpoint', unit: '°C',
      min: 10, max: 26,
      code: 'NYC BC §28-310.3 / ASHRAE 90.1 §7.4',
      codeSection: 'NYC BC §28-310.3',
      hint: 'Standard range: 18–21°C. Lower setpoints save heating energy; higher setpoints increase EUI.',
      severity: 'INFO',
    },
    {
      field: 'coolingSetpoint', label: 'Cooling Setpoint', unit: '°C',
      min: 18, max: 30,
      code: 'NYC BC §28-310.3 / ASHRAE 90.1 §7.4',
      codeSection: 'NYC BC §28-310.3',
      hint: 'Standard range: 23–26°C. Higher setpoints save cooling energy.',
      severity: 'INFO',
    },
  ],

  fire: [
    {
      field: 'occupantLoadFactor', label: 'Occupant Load Factor', unit: 'ft²/person',
      min: 3, max: 500,
      code: 'NYC BC §1004.5 / NFPA 101 Table 7.3.1.2',
      codeSection: 'NYC BC §1004.5',
      hint: 'Office: 100 ft²/person. Assembly (standing): 15 ft²/person. Using wrong factor miscalculates egress width.',
      severity: 'CRITICAL',
    },
    {
      field: 'egressWidthPerOccupant', label: 'Egress Width', unit: 'in/person',
      min: 0.15, max: 2.0,
      code: 'NYC BC §1005.1 / NFPA 101 §7.2.2',
      codeSection: 'NYC BC §1005.1',
      hint: 'Min: 0.15 in/person (0.5 in/m for >= 50 occupants). Insufficient width is a CRITICAL code violation.',
      severity: 'CRITICAL',
    },
    {
      field: 'travelDistance', label: 'Max Travel Distance', unit: 'ft',
      min: 20, max: 500,
      code: 'NYC BC §1016.1 / NFPA 101 Table A.7.2',
      codeSection: 'NYC BC §1016.1',
      hint: 'Business occupancy: 100 ft without sprinkler, 200 ft with sprinkler. Exceeding this fails egress.',
      severity: 'CRITICAL',
    },
    {
      field: 'exitAccessTravelDistance', label: 'Exit Access Travel Distance', unit: 'ft',
      min: 0, max: 200,
      code: 'NYC BC §1016.2',
      codeSection: 'NYC BC §1016.2',
      hint: 'Max 75 ft without sprinkler, 125 ft with sprinkler per NYC BC.',
      severity: 'CRITICAL',
    },
    {
      field: 'sprinklerCoverageArea', label: 'Sprinkler Coverage per Head', unit: 'ft²',
      min: 50, max: 225,
      code: 'NFPA 13 §8.6.2.1 / NYC BC §903.3.1',
      codeSection: 'NFPA 13 §8.6.2.1',
      hint: 'Standard coverage: 130–150 ft²/head. Light hazard: max 225 ft². Exceeding fails NFPA 13 coverage.',
      severity: 'CRITICAL',
    },
    {
      field: 'fireResistanceHours', label: 'Fire Resistance Rating', unit: 'hr',
      min: 0, max: 4,
      code: 'NYC BC Table 720-1 / IBC Table 722.6.2',
      codeSection: 'NYC BC Table 720-1',
      hint: 'Type II-B construction: 0hr. Type III-B: 2hr. Type I-A: 3hr. Rating must match construction type.',
      severity: 'WARNING',
    },
    {
      field: 'smokeControlPressure', label: 'Smoke Control Pressure', unit: 'Pa',
      min: 0, max: 100,
      code: 'NFPA 92 §5.2 / NYC BC §909.6',
      codeSection: 'NFPA 92 §5.2',
      hint: 'Stairwell pressurization: 12–50 Pa. Atrium smoke control: 5–25 Pa differential. Check vs HVAC capacity.',
      severity: 'WARNING',
    },
  ],

  geotech: [
    {
      field: 'cohesion', label: 'Cohesion', unit: 'kPa',
      min: 0, max: 1000,
      code: 'NAVFAC DM 7.01 / NYC BC §1803.5.3',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'Typical ranges: Sand/Gravel = 0 kPa. Stiff Clay = 20–75 kPa. Very Stiff Clay = 75–150 kPa. Verify with lab test (UU or CU).',
      severity: 'INFO',
    },
    {
      field: 'frictionAngle', label: 'Friction Angle', unit: '°',
      min: 0, max: 50,
      code: 'NAVFAC DM 7.01 Table 4-2 / NYC BC §1803.5.3',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'Typical ranges: Dense Gravel = 38–45°. Medium Sand = 32–36°. Stiff Clay = 0°. Clay has φ=0 (undrained). Verify with SPT or CU test.',
      severity: 'WARNING',
    },
    {
      field: 'unitWeight', label: 'Unit Weight', unit: 'kN/m³',
      min: 10, max: 25,
      code: 'NAVFAC DM 7.01 Table 2-2',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'Typical ranges: Gravel = 18–19.5 kN/m³. Sand = 17–18.5 kN/m³. Clay = 15–18 kN/m³. Saturated values are higher. Verify with lab.',
      severity: 'INFO',
    },
    {
      field: 'depth', label: 'Layer Depth', unit: 'm',
      min: 0.1, max: 200,
      code: 'NAVFAC DM 7.01 §4.2 / NYC BC §1803.5',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'Layer depths should be geologically reasonable. Check groundwater table and depth-to-bearing stratum.',
      severity: 'WARNING',
    },
    {
      field: 'elasticModulus', label: 'Elastic Modulus', unit: 'kPa',
      min: 500, max: 1000000,
      code: 'NAVFAC DM 7.02 / NYC BC §1803.5.3',
      codeSection: 'NAVFAC DM 7.02',
      hint: 'Typical E ranges: Dense Sand = 60,000–100,000 kPa. Stiff Clay = 15,000–40,000 kPa. Use DMT or PLT for better estimate.',
      severity: 'INFO',
    },
    {
      field: 'modulusE', label: 'Elastic Modulus (ES)', unit: 'kPa',
      min: 500, max: 1000000,
      code: 'NAVFAC DM 7.02 / NYC BC §1803.5.3',
      codeSection: 'NAVFAC DM 7.02',
      hint: 'E from DMT = 2·pm. SPT N > 40 indicates very dense soil (E > 80,000 kPa). Low N values may indicate organic soil.',
      severity: 'INFO',
    },
    {
      field: 'foundationWidth', label: 'Foundation Width', unit: 'm',
      min: 0.3, max: 50,
      code: 'NAVFAC DM 7.01 §4.3 / NYC BC §1804.2',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'Min foundation width per NYC BC §1804.2: 16 in for steel, 12 in for concrete. Width affects bearing capacity.',
      severity: 'INFO',
    },
    {
      field: 'foundationDepth', label: 'Foundation Embedment', unit: 'm',
      min: 0, max: 50,
      code: 'NYC BC §1804.1 / frost depth NYC',
      codeSection: 'NYC BC §1804.1',
      hint: 'NYC frost depth: 32 in (0.81 m) below grade. Footings must extend below frost line to prevent frost heave.',
      severity: 'WARNING',
    },
    {
      field: 'sptBlowcount', label: 'SPT N-value', unit: 'blows/ft',
      min: 0, max: 300,
      code: 'NAVFAC DM 7.01 Table 3-1 / ASTM D1586',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'N < 4: very loose/soft. N 4–10: loose/firm. N 10–30: medium/dense. N > 30: very dense/stiff. N > 50: hard. Very high N may indicate boulder.',
      severity: 'INFO',
    },
    {
      field: 'groundwaterDepth', label: 'Groundwater Depth', unit: 'm',
      min: 0, max: 200,
      code: 'NAVFAC DM 7.01 §3.2 / NYC BC §1803.5',
      codeSection: 'NAVFAC DM 7.01',
      hint: 'Groundwater within 3 m of footing affects bearing, settlement, and lateral earth pressure. Use at least 3 m below surface or field data.',
      severity: 'WARNING',
    },
    {
      field: 'allowableBearingPressure', label: 'Allowable Bearing Pressure', unit: 'kPa',
      min: 10, max: 10000,
      code: 'NAVFAC DM 7.01 §4.3 / NYC BC Table 1804.2',
      codeSection: 'NYC BC Table 1804.2',
      hint: 'NYC BC Table 1804.2 max values by soil type: dense/gravelly sand: 200 kPa; stiff clay: 150 kPa; medium dense sand: 150 kPa. Exceeding requires geotech PE stamp.',
      severity: 'WARNING',
    },
    {
      field: 'settlement', label: 'Settlement Limit', unit: 'mm',
      min: 0, max: 500,
      code: 'NYC BC §1804.3 / NAVFAC DM 7.02',
      codeSection: 'NYC BC §1804.3',
      hint: 'Max total settlement: 25 mm (1 in). Max differential: 19 mm (3/4 in). Surcharge preloading or ground improvement needed if > 25 mm.',
      severity: 'CRITICAL',
    },
  ],

  structural: [
    {
      field: 'slenderness', label: 'Slenderness Ratio', unit: '',
      min: 0, max: 200,
      code: 'AISC 360-22 §E2 / ACI 318-22 §6.6.4.1',
      codeSection: 'AISC 360-22 §E2',
      hint: 'Maximum slenderness for compression members: 200. Values > 200 require a second-order analysis or larger section.',
      severity: 'WARNING',
    },
    {
      field: 'dcr', label: 'Demand/Capacity Ratio', unit: '',
      min: 0, max: 5,
      code: 'AISC 360-22 §B3 / ASCE 7-22 §C2.3',
      codeSection: 'AISC 360-22 §B3',
      hint: 'DCR > 1.0 = overstressed. Target ≤ 0.90 for strength design. Values > 1.0 require section enlargement or higher strength material.',
      severity: 'CRITICAL',
    },
    {
      field: 'lateralDeflection', label: 'Max Lateral Deflection', unit: 'mm',
      min: 0, max: 1000,
      code: 'ASCE 7-22 §12.12 / AISC 341-22 §C2.2',
      codeSection: 'ASCE 7-22 §12.12',
      hint: 'Allowable story drift: Δa = 0.025·hsx (occupancy category II). Approx 50–75 mm for a 3 m story. Exceeding may require braced frames or shear walls.',
      severity: 'WARNING',
    },
    {
      bias: 'min', field: 'rebarCover', label: 'Rebar Cover', unit: 'mm',
      min: 20, max: 100,
      code: 'ACI 318-22 §20.6.1.3 / NYC BC §1907.7',
      codeSection: 'ACI 318-22 §20.6.1.3',
      hint: 'Min cover: Cast-in-place concrete (not exposed): 40 mm. Formed concrete (exposed): 50 mm. Corrosive environments: 65 mm. Insufficient cover causes corrosion.',
      severity: 'CRITICAL',
    },
  ],

  mep_hvac: [
    {
      field: 'ductVelocity', label: 'Duct Velocity', unit: 'fpm',
      min: 0, max: 5000,
      code: 'SMACNA HVAC Systems Ductwork 2018 / ASHRAE 90.1-2019 §6.5',
      codeSection: 'SMACNA Duct Design',
      hint: 'Recommended: 400–1200 fpm (main), 300–800 fpm (branch). >2000 fpm creates noise and pressure loss. High-pressure systems: max 2500 fpm.',
      severity: 'WARNING',
    },
    {
      field: 'coolingAirflow', label: 'Cooling Airflow', unit: 'CFM',
      min: 0, max: 100000,
      code: 'ASHRAE 62.1-2019 §6.2 / NYC Mechanical Code §603',
      codeSection: 'ASHRAE 62.1-2019 §6.2',
      hint: 'Typical office: 1.0–1.5 CFM/ft². Low airflow causes poor mixing, hot spots. High airflow increases fan energy and duct sizing.',
      severity: 'INFO',
    },
    {
      field: 'supplyAirTemp', label: 'Supply Air Temperature', unit: '°F',
      min: 40, max: 65,
      code: 'ASHRAE 90.1-2019 §6.4.1 / NYC Mechanical Code §604',
      codeSection: 'ASHRAE 90.1-2019 §6.4.1',
      hint: 'Min SAT for cooling: 55°F (prevents condensation). Max SAT for heating: 120°F. Lower SAT in summer improves chiller efficiency.',
      severity: 'WARNING',
    },
    {
      field: 'heatingCapacity', label: 'Heating Capacity', unit: 'BTU/hr',
      min: 0, max: 10000000,
      code: 'ASHRAE 90.1-2019 §6.4.2 / NYC BC §1404',
      codeSection: 'ASHRAE 90.1-2019 §6.4.2',
      hint: 'Oversized heating equipment short-cycles, wastes energy, and reduces humidity control. Right-size per Manual J load calculation.',
      severity: 'INFO',
    },
    {
      field: 'coolingCapacity', label: 'Cooling Capacity', unit: 'BTU/hr',
      min: 0, max: 10000000,
      code: 'ASHRAE 90.1-2019 §6.4.2 / NYC BC §1404',
      codeSection: 'ASHRAE 90.1-2019 §6.4.2',
      hint: 'Oversized cooling equipment short-cycles, provides poor dehumidification, wastes energy. Right-size per Manual J load calculation.',
      severity: 'INFO',
    },
  ],

  mep_plumbing: [
    {
      field: 'pipeVelocity', label: 'Water Pipe Velocity', unit: 'fps',
      min: 0, max: 15,
      code: 'IPC §604.8 / NFPA 13 §14.3.1',
      codeSection: 'IPC §604.8',
      hint: 'Max velocity: 8 fps (hot water), 10 fps (cold water). >10 fps causes water hammer, pipe erosion, noise. Fire sprinkler: max 20 fps.',
      severity: 'WARNING',
    },
    {
      field: 'minPipeSize', label: 'Min Pipe Size', unit: 'in',
      min: 0.25, max: 12,
      code: 'IPC Table 610.3 / NYC Plumbing Code §604.2',
      codeSection: 'IPC Table 610.3',
      hint: 'Water closet: min 1 in. Lavatory: min ½ in. Shower: min ½ in. Sizing smaller than code minimum is a violation.',
      severity: 'CRITICAL',
    },
    {
      field: 'fixtureUnitTotal', label: 'Total Fixture Units', unit: 'DFU',
      min: 0, max: 10000,
      code: 'IPC Table 610.3 / NYC Plumbing Code Table 610.3',
      codeSection: 'IPC Table 610.3',
      hint: 'High DFU loads require larger risers and mains. >500 DFU on a single branch may require parallel mains per IPC §610.4.',
      severity: 'INFO',
    },
    {
      field: 'sprinklerSpacing', label: 'Sprinkler Head Spacing', unit: 'ft',
      min: 4, max: 20,
      code: 'NFPA 13 §8.6.2.1 / NYC BC §903.3.1',
      codeSection: 'NFPA 13 §8.6.2.1',
      hint: 'Standard sprinkler spacing: max 225 ft² per head (light hazard). Spacing > 15 ft² above listed coverage requires specific approval.',
      severity: 'CRITICAL',
    },
  ],

  mep_electrical: [
    {
      field: 'conduitFill', label: 'Conduit Fill', unit: '%',
      min: 0, max: 100,
      code: 'NEC Chapter 9 Table 1 / NEC §310.15',
      codeSection: 'NEC Chapter 9',
      hint: 'Max fill: 1 wire = 53%, 2 wires = 31%, 3+ wires = 40%. Overfilling creates heat buildup, derates ampacity, and is a code violation.',
      severity: 'CRITICAL',
    },
    {
      field: 'circuitAmpacity', label: 'Circuit Ampacity', unit: 'A',
      min: 1, max: 1000,
      code: 'NEC Table 310.16 / NEC §240.4',
      codeSection: 'NEC §240.4',
      hint: 'Wire must be rated ≥ circuit breaker. 14 AWG → max 15A. 12 AWG → max 20A. 10 AWG → max 30A. Exceeding ampacity requires larger wire.',
      severity: 'CRITICAL',
    },
    {
      field: 'voltageDrop', label: 'Voltage Drop', unit: '%',
      min: 0, max: 20,
      code: 'NEC §210.19 Informational Note 4 / EGC §311.6',
      codeSection: 'NEC §210.19',
      hint: 'Max total voltage drop: 5% (NEC recommendation). Branch: 3%. Feeder: 2%. >5% causes dimming, motor overheating, reduced equipment life.',
      severity: 'WARNING',
    },
    {
      field: 'panelLoad', label: 'Panel Load', unit: '%',
      min: 0, max: 125,
      code: 'NEC §220.87 / NYC Electrical Code §3.23',
      codeSection: 'NEC §220.87',
      hint: 'Panel loading > 80% of bus rating requires upsizing. >100% creates fire hazard. Consider demand factor and future loads.',
      severity: 'CRITICAL',
    },
    {
      field: 'wireLength', label: 'Wire Run Length', unit: 'ft',
      min: 0, max: 2000,
      code: 'NEC Chapter 9 Table 8 (k=12.9 for copper) / NEC §310.15',
      codeSection: 'NEC Chapter 9',
      hint: 'Long wire runs increase voltage drop. For 120V 20A over 150 ft, use #10 AWG minimum. Use voltage drop calculator (NEC §210.19) for precise sizing.',
      severity: 'WARNING',
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate inputs for a given simulation type.
 * Returns array of issues with field, severity, message, codeSection, hint.
 * @param {string} simType
 * @param {object} inputs — key-value of field → value
 * @returns {Array} issues[]
 */
function validateInputs(simType, inputs = {}) {
  const rules = VALIDATION_RULES[simType] || [];
  const issues = [];

  for (const rule of rules) {
    // Map simType + field to actual input key
    const value = inputs[rule.field];
    if (value === undefined || value === null || value === '') continue;

    const num = parseFloat(value);
    if (isNaN(num)) continue;

    let violation = false;
    let severity = rule.severity;

    if (rule.bias === 'min') {
      // Only flag if below minimum
      if (num < rule.min) violation = true;
    } else {
      if (num < rule.min || num > rule.max) violation = true;
    }

    if (violation) {
      const range = rule.bias === 'min'
        ? `minimum ${rule.min} ${rule.unit}`
        : `${rule.min}–${rule.max} ${rule.unit}`;

      let message = rule.hint
        .replace('{value}', String(value))
        .replace('{exceeds}', ((num - (rule.max * 0.9)) / (rule.max * 0.9) * 100).toFixed(0));

      issues.push({
        field: rule.field,
        label: rule.label,
        unit: rule.unit,
        value,
        severity,
        message: `[${severity}] ${rule.label}: ${message}`,
        codeSection: rule.codeSection,
        code: rule.code,
        hint: rule.hint,
        range,
        fixRequired: severity === 'CRITICAL',
      });
    }
  }

  return issues;
}

/**
 * Deep code compliance scan — structural checks that require model context.
 * Returns array of grouped violations by severity.
 * @param {string} simType
 * @param {object} inputs
 * @param {object} model — { elements, levels, familyInstances }
 * @returns {object} { critical[], warning[], info[] }
 */
function checkCompliance(simType, inputs, model) {
  const result = { critical: [], warning: [], info: [] };

  if (simType === 'energy') {
    checkEnergyCompliance(inputs, model, result);
  } else if (simType === 'fire') {
    checkFireCompliance(inputs, model, result);
  } else if (simType === 'geotech') {
    checkGeotechCompliance(inputs, model, result);
  } else if (simType === 'structural') {
    checkStructuralCompliance(inputs, model, result);
  } else if (simType === 'mep_hvac') {
    checkHVACCompliance(inputs, model, result);
  } else if (simType === 'mep_plumbing') {
    checkPlumbingCompliance(inputs, model, result);
  } else if (simType === 'mep_electrical') {
    checkElectricalCompliance(inputs, model, result);
  }

  return result;
}

function checkEnergyCompliance(inputs, model, result) {
  const walls = (model?.elements || []).filter(e => e.type === 'wall');
  const glazing = (model?.familyInstances || []).filter(f => f.family_type === 'window' || f.type === 'window');
  const levels = (model?.levels || []);

  if (!walls.length) {
    result.warning.push({
      code: 'NYC BC §1101',
      severity: 'WARNING',
      title: 'No walls in model',
      description: 'Energy simulation requires at least one wall. Add walls before running the energy analysis.',
      fix: 'Draw walls using the wall tool in the 3D view before running the simulation.',
    });
  }

  // WWR calculation
  if (inputs.wwr !== undefined && inputs.wwr > 40) {
    result.critical.push({
      code: 'NYC BC §1109',
      severity: 'CRITICAL',
      title: `Window-to-Wall Ratio exceeds 40%`,
      description: `Your WWR of ${inputs.wwr}% exceeds the 40% threshold requiring detailed analysis per NYC BC §1109.`,
      fix: 'Reduce glazing area or use high-performance glazing (U ≤ 1.5 W/m²·K, SHGC ≤ 0.30) to qualify for prescriptive path.',
      reference: 'NYC BC §1109 / ASHRAE 90.1 §5.4',
    });
  }

  // EUI benchmark check
  if (inputs.eui_target !== undefined && inputs.eui_actual !== undefined) {
    if (inputs.eui_actual > inputs.eui_target * 1.2) {
      result.warning.push({
        code: 'NYECC C406',
        severity: 'WARNING',
        title: `EUI exceeds target by >20%`,
        description: `Actual EUI (${inputs.eui_actual.toFixed(1)}) is >20% above target (${inputs.eui_target}). This triggers C406 performance path compliance review.`,
        fix: 'Improve envelope (wall/roof U-values), reduce WWR, upgrade glazing, or add daylight controls.',
        reference: 'NYECC §C406 / ASHRAE 90.1 §5',
      });
    }
  }

  // Building aspect ratio check
  if (walls.length > 0 && levels.length > 0) {
    // Rough footprint estimation
    const bounds = getModelBounds(model?.elements || []);
    if (bounds) {
      const aspect = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) /
        Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) || 1;
      if (aspect > 5) {
        result.info.push({
          code: 'NYECC C402',
          severity: 'INFO',
          title: 'Unusual building aspect ratio',
          description: `Building aspect ratio ~${aspect.toFixed(1)}:1 may indicate modeling inaccuracy. Check that all building geometry is enclosed and no outdoor volumes are included.`,
          fix: 'Verify all walls form a closed boundary and roof/ceiling elements close the building envelope.',
          reference: 'NYECC §C402.1',
        });
      }
    }
  }
}

function checkFireCompliance(inputs, model, result) {
  const occupancy = inputs.occupancy_type || 'office';
  const occupancyParams = OCCUPANCY_PARAMS[occupancy] || OCCUPANCY_PARAMS.office;

  // Occupant load check
  const totalArea = model ? getModelArea(model) : 0;
  if (totalArea > 0) {
    const occupantLoad = totalArea / occupancyParams.olf;
    const reqWidth = occupantLoad * occupancyParams.minEgressWidth;
    if (reqWidth > 60) {
      result.warning.push({
        code: 'NYC BC §1005.1',
        severity: 'WARNING',
        title: 'Large occupant load requires multiple exits',
        description: `Estimated ${occupantLoad.toFixed(0)} occupants (${totalArea.toFixed(0)} ft² ÷ ${occupancyParams.olf} ft²/person) requires multiple exits per NYC BC §1005.2.`,
        fix: 'Ensure at least two remote exits with minimum aggregate width proportional to occupant load.',
        reference: 'NYC BC §1005.1 / NFPA 101 §7.1.2',
      });
    }
  }

  // Sprinkler requirement check
  if (!inputs.sprinklered && occupancyParams.requiresSprinkler) {
    result.critical.push({
      code: 'NYC BC §903.2',
      severity: 'CRITICAL',
      title: `${capitalize(occupancy)} occupancy requires sprinkler system`,
      description: `NY BC §903.2 requires automatic sprinkler protection for ${occupancy} occupancies. No sprinkler system detected.`,
      fix: 'Design NFPA 13 sprinkler system before proceeding. Contact FDNY for system acceptance.',
      reference: 'NYC BC §903.2 / NFPA 13 §8.6',
    });
  }

  // Travel distance check
  if (inputs.travelDistance > occupancyParams.maxTravelDist) {
    result.critical.push({
      code: 'NYC BC §1016.1',
      severity: 'CRITICAL',
      title: `Travel distance ${inputs.travelDistance} ft exceeds ${occupancyParams.maxTravelDist} ft limit`,
      description: `Maximum travel distance for ${occupancy} occupancy: ${occupancyParams.maxTravelDist} ft. Exceeded distance requires additional exits or smoke control.`,
      fix: 'Add intervening smoke control or additional exits to reduce travel distance below limit.',
      reference: 'NYC BC §1016.1',
    });
  }
}

function checkGeotechCompliance(inputs, model, result) {
  if (inputs.cohesion > 0 && inputs.frictionAngle > 0) {
    result.info.push({
      code: 'NAVFAC DM 7.01',
      severity: 'INFO',
      title: 'Mixed soil behavior — use total/effective stress analysis',
      description: "Both cohesion and friction angle specified. For clays with phi>0, use effective stress (c' and phi\") per NAVFAC DM 7.01. For short-term undrained loading, use phi=0 (total stress).",
      fix: 'Run both total stress (φ=0) and effective stress analyses. Compare results; use the more conservative for design.',
      reference: 'NAVFAC DM 7.01 §4.1',
    });
  }

  if (inputs.groundwaterDepth && inputs.foundationDepth) {
    if (inputs.groundwaterDepth < inputs.foundationDepth) {
      result.warning.push({
        code: 'NAVFAC DM 7.01 §3.2',
        severity: 'WARNING',
        title: 'Groundwater within foundation depth',
        description: `Groundwater at ${inputs.groundwaterDepth} m conflicts with foundation depth ${inputs.foundationDepth} m. Buoyancy and seepage forces must be accounted for.`,
        fix: 'Include groundwater in bearing capacity calculation (use γ\\_sat). Add drainage or dewater if needed. Account for hydrostatic uplift on basement slabs.',
        reference: 'NAVFAC DM 7.01 §3.2 / NYC BC §1804.4',
      });
    }
  }

  if (inputs.sptBlowcount && inputs.sptBlowcount > 50) {
    result.info.push({
      code: 'NAVFAC DM 7.01 Table 3-1',
      severity: 'INFO',
      title: 'High SPT N-value indicates very dense or hard stratum',
      description: `SPT N = ${inputs.sptBlowcount} blows/ft is very high. This may indicate dense sandy gravel or rock. Verify layer classification with geologist.`,
      fix: 'Add refusal indicator in boring log. Consider rock socket for piles if N > 100/ft. Confirm with lab testing or geologist.',
      reference: 'NAVFAC DM 7.01 Table 3-1',
    });
  }
}

function checkStructuralCompliance(inputs, model, result) {
  if (inputs.dcr > 1.0) {
    result.critical.push({
      code: 'AISC 360-22 §B3',
      severity: 'CRITICAL',
      title: `Member overstressed — DCR = ${inputs.dcr.toFixed(2)}`,
      description: 'Demand/Capacity ratio exceeds 1.0. Member fails strength requirements. Engineering judgment and redesign required.',
      fix: 'Increase section size, use higher-strength material, add bracing, or redistribute loads.',
      reference: 'AISC 360-22 §B3.1',
    });
  }
  if (inputs.slenderness > 200) {
    result.warning.push({
      code: 'AISC 360-22 §E2',
      severity: 'WARNING',
      title: `Slenderness ${inputs.slenderness} exceeds limit of 200`,
      description: 'Compression member requires second-order analysis per AISC 360-22 §E2. First-order analysis not permitted.',
      fix: 'Enlarge section to reduce slenderness below 200, or perform second-order analysis with P-Delta effects.',
      reference: 'AISC 360-22 §E2',
    });
  }
}

function checkHVACCompliance(inputs, model, result) {
  if (inputs.ductVelocity > 2500) {
    result.warning.push({
      code: 'SMACNA HVAC Duct Design',
      severity: 'WARNING',
      title: `Duct velocity ${inputs.ductVelocity} fpm exceeds 2500 fpm`,
      description: 'High duct velocity causes noise, vibration, and excessive pressure losses. Velocity > 2500 fpm requires special acoustic treatment.',
      fix: 'Increase duct size to reduce velocity to 1200–2000 fpm range. Use duct liner or acoustic attenuators.',
      reference: 'SMACNA HVAC Systems Ductwork 2018 §4',
    });
  }
  if (inputs.buildingArea && inputs.coolingCapacity) {
    const cfmPerSqft = (inputs.coolingAirflow || 0) / inputs.buildingArea;
    if (cfmPerSqft > 2.0) {
      result.warning.push({
        code: 'ASHRAE 62.1-2019 §6.2',
        severity: 'WARNING',
        title: `High airflow: ${cfmPerSqft.toFixed(1)} CFM/ft²`,
        description: 'Typical office: 1.0–1.5 CFM/ft². Excess airflow increases fan energy cost.',
        fix: 'Right-size air handler. Consider VAV system for part-load efficiency.',
        reference: 'ASHRAE 62.1-2019 §6.2',
      });
    }
  }
}

function checkPlumbingCompliance(inputs, model, result) {
  if (inputs.pipeVelocity > 10) {
    result.warning.push({
      code: 'IPC §604.8',
      severity: 'WARNING',
      title: `Pipe velocity ${inputs.pipeVelocity} fps exceeds 10 fps limit`,
      description: 'Excessive velocity causes water hammer, pipe erosion, and noise. Also damages fixtures.',
      fix: 'Increase pipe diameter. Use reducers at intervals. Add water hammer arresters (ANSI A112.26.1).',
      reference: 'IPC §604.8',
    });
  }
  if (inputs.occupancy_type && !['office', 'residential'].includes(inputs.occupancy_type)) {
    result.info.push({
      code: 'NFPA 13 §14.3',
      severity: 'INFO',
      title: 'Non-typical occupancy — verify sprinkler density',
      description: `Occupancy type '${inputs.occupancy_type}' may require higher sprinkler density than light hazard. Check NFPA 13 Chapter 14 for hazard classification.`,
      fix: 'Review NFPA 13 Chapter 14 for commodity class and required sprinkler density (gpm/ft²). Adjust hydraulic calculations.',
      reference: 'NFPA 13 §14',
    });
  }
}

function checkElectricalCompliance(inputs, model, result) {
  if (inputs.conduitFill > 53) {
    result.critical.push({
      code: 'NEC Chapter 9 Table 1',
      severity: 'CRITICAL',
      title: `Conduit fill ${inputs.conduitFill}% exceeds code limits`,
      description: 'NEC Chapter 9 limits fill to 53% for 1 conductor, 31% for 2, 40% for 3 or more. Exceeding creates overheating, derating, and fire hazard.',
      fix: 'Use larger conduit, reduce number of conductors, or use separate conduits. Use wire fill calculation software.',
      reference: 'NEC Chapter 9 Table 1 / NEC §310.15',
    });
  }
  if (inputs.voltageDrop > 5) {
    result.warning.push({
      code: 'NEC §210.19',
      severity: 'WARNING',
      title: `Voltage drop ${inputs.voltageDrop}% exceeds 5% NEC recommendation`,
      description: 'NEC §210.19 informational note recommends ≤5% total drop for efficient operation. >5% causes equipment performance issues.',
      fix: 'Increase wire size, reduce run length, or use higher-voltage distribution (208V vs 120V for motors).',
      reference: 'NEC §210.19 Informational Note 4',
    });
  }
  if (inputs.panelLoad > 80) {
    result.warning.push({
      code: 'NEC §220.87',
      severity: 'WARNING',
      title: `Panel loading at ${inputs.panelLoad}% — consider upsizing`,
      description: 'Standard practice limits panel loading to 80% for future growth and heat dissipation.',
      fix: 'Upsize panel bus or redistribute loads. Consider adding sub-panel for additional circuits.',
      reference: 'NEC §220.87 / NEMA PB 1.1',
    });
  }
}

/**
 * Generate next-steps design guidance based on simulation results.
 * @param {string} simType
 * @param {object} results — raw simulation results
 * @returns {object} { summary, status, nextSteps[] }
 */
function getDesignGuidance(simType, results = {}) {
  const { status = 'MARGINAL', score = 0, violations = [] } = results;

  const statusLower = (status || 'MARGINAL').toLowerCase();

  if (statusLower === 'pass') {
    return {
      summary: 'Design appears to comply with applicable codes and standards.',
      status: 'PASS',
      score: 100,
      nextSteps: [
        { action: 'Proceed to construction documents', priority: 'normal', note: 'Ensure all assumptions are reflected in design drawings.' },
        { action: 'Coordinate with other disciplines', priority: 'normal', note: 'Share design with MEP, structural, and architectural teams for clash detection.' },
        { action: 'Retain PE stamp', priority: 'high', note: 'All final documents must be reviewed and stamped by a licensed PE in the relevant discipline.' },
        ...(violations.length > 0 ? [{
          action: `Review ${violations.length} warning(s) before construction`,
          priority: 'high', note: violations.map(v => v.title).join('. '),
        }] : []),
      ],
      passMessage: 'All code checks passed. Design proceeds to the next phase.',
    };
  }

  if (statusLower === 'fail') {
    return {
      summary: 'Design does not meet code requirements. Revisions required before proceeding.',
      status: 'FAIL',
      score: Math.max(0, 100 - violations.filter(v => v.severity === 'CRITICAL').length * 20),
      nextSteps: violations.filter(v => v.severity === 'CRITICAL').map(v => ({
        action: `Fix: ${v.title}`,
        priority: 'critical',
        note: v.fix || v.description,
        reference: v.code || '',
      })),
      failMessage: `${violations.filter(v => v.severity === 'CRITICAL').length} critical violation(s) must be resolved. ${violations.filter(v => v.severity === 'WARNING').length} warning(s) also noted.`,
    };
  }

  // MARGINAL
  const criticals = violations.filter(v => v.severity === 'CRITICAL');
  const warnings = violations.filter(v => v.severity === 'WARNING');
  return {
    summary: `Design has ${criticals.length} critical issue(s) and ${warnings.length} warning(s) requiring resolution.`,
    status: 'MARGINAL',
    score: Math.max(20, 100 - criticals.length * 30 - warnings.length * 10),
    nextSteps: [
      ...criticals.map(v => ({
        action: `Fix: ${v.title}`,
        priority: 'critical',
        note: v.fix || v.description,
        reference: v.code || '',
      })),
      ...warnings.map(v => ({
        action: `Review: ${v.title}`,
        priority: 'normal',
        note: v.fix || v.description,
        reference: v.code || '',
      })),
    ],
    marginalMessage: `${criticals.length} critical and ${warnings.length} warning(s) remain. Resolve criticals first, then re-run simulation.`,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Get code reference for a specific field.
 * @param {string} simType
 * @param {string} field
 * @returns {object|null}
 */
function getCodeReference(simType, field) {
  const rules = VALIDATION_RULES[simType] || [];
  const rule = rules.find(r => r.field === field);
  if (!rule) return null;
  return {
    codeSection: rule.codeSection,
    code: rule.code,
    range: `${rule.min}–${rule.max} ${rule.unit}`,
    label: rule.label,
    hint: rule.hint,
    severity: rule.severity,
  };
}

/**
 * Render a human-readable compliance summary HTML block.
 * @param {object} compliance — { critical[], warning[], info[] }
 * @param {string} simType
 * @returns {string} HTML
 */
function renderComplianceSummary(compliance, simType) {
  const { critical = [], warning = [], info = [] } = compliance;
  const total = critical.length + warning.length + info.length;
  if (total === 0) return '<div style="color:#16a34a;font-size:12px">✓ No code violations detected for this analysis type.</div>';

  const sevOrder = ['CRITICAL', 'WARNING', 'INFO'];
  const sections = sevOrder.map(sev => {
    const items = compliance[sev.toLowerCase()] || [];
    if (!items.length) return '';
    const style = SEVERITY_STYLES[sev];
    return `
    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:${style.color};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">
        ${style.icon} ${items.length} ${style.label} — ${sev === 'CRITICAL' ? 'must fix before proceeding' : sev === 'WARNING' ? 'review and resolve' : 'informational'}
      </div>
      ${items.map(item => `
        <div style="background:#1a1a2e;border-radius:6px;padding:8px 10px;margin-bottom:4px;border-left:3px solid ${style.color}">
          <div style="font-size:11px;color:#a1a1aa;margin-bottom:2px">${item.code || ''}</div>
          <div style="font-size:12px;font-weight:600;color:#e5e7eb">${item.title}</div>
          <div style="font-size:11px;color:#9ca3af;margin:3px 0 4px">${item.description}</div>
          ${item.fix ? `<div style="font-size:11px;color:#fbbf24"><strong>Fix:</strong> ${item.fix}</div>` : ''}
          ${item.reference ? `<div style="font-size:10px;color:#6b7280;margin-top:2px">Ref: ${item.reference}</div>` : ''}
        </div>
      `).join('')}
    </div>`;
  }).join('');

  return `<div style="font-family:system-ui;padding:12px;background:#0f0f1a;border-radius:8px;border:1px solid #2a2a4a">
    <div style="font-size:12px;font-weight:700;color:#e5e7eb;margin-bottom:8px">🔍 Code Compliance Check — ${capitalize(simType.replace('_', ' '))}</div>
    ${sections}
    <div style="font-size:10px;color:#6b7280;margin-top:8px;border-top:1px solid #2a2a4a;padding-top:6px">${DISCLAIMER}</div>
  </div>`;
}

/**
 * Render a validation issues HTML block for inline form feedback.
 * @param {Array} issues
 * @returns {string} HTML
 */
function renderValidationIssues(issues) {
  if (!issues || issues.length === 0) return '<div style="color:#16a34a;font-size:11px;margin:4px 0">✓ All inputs within acceptable ranges</div>';
  return issues.map(issue => {
    const style = SEVERITY_STYLES[issue.severity] || SEVERITY_STYLES.INFO;
    return `<div style="font-size:11px;color:${style.color};margin:2px 0;border-left:2px solid ${style.color};padding-left:6px">
      <strong>${style.icon} ${issue.label}:</strong> ${issue.message.replace(/^\\[.*?\\]\\s*/, '')}
      <br><span style="color:#9ca3af">Range: ${issue.range} · Code: ${issue.codeSection}</span>
    </div>`;
  }).join('');
}

/**
 * Render design guidance HTML block.
 * @param {object} guidance
 * @returns {string} HTML
 */
function renderDesignGuidance(guidance) {
  const { status = 'MARGINAL', score = 50, nextSteps = [], summary = '', passMessage = '', failMessage = '', marginalMessage = '' } = guidance;
  const statusColor = status === 'PASS' ? '#16a34a' : status === 'FAIL' ? '#dc2626' : '#d97706';
  const statusBg = status === 'PASS' ? '#052e16' : status === 'FAIL' ? '#2a0000' : '#1c1400';

  const msg = status === 'PASS' ? passMessage : status === 'FAIL' ? failMessage : marginalMessage || summary;

  return `<div style="font-family:system-ui;padding:12px;background:${statusBg};border-radius:8px;border:1px solid ${statusColor}">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:20px">${status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️'}</span>
      <div>
        <div style="font-size:13px;font-weight:700;color:${statusColor}">${status} — Score: ${score}/100</div>
        <div style="font-size:11px;color:#9ca3af">${summary}</div>
      </div>
    </div>
    ${msg ? `<div style="font-size:11px;color:#d1d5db;margin-bottom:8px">${msg}</div>` : ''}
    ${nextSteps.length > 0 ? `<div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Next Steps</div>
    <div>${nextSteps.map(step => `<div style="margin-bottom:4px;padding:6px 8px;background:#0f0f1a;border-radius:4px;border-left:2px solid ${step.priority === 'critical' ? '#dc2626' : step.priority === 'high' ? '#d97706' : '#2563eb'}">
      <span style="font-size:10px;color:${step.priority === 'critical' ? '#dc2626' : step.priority === 'high' ? '#d97706' : '#2563eb'};font-weight:600;background:#1a1a2e;padding:1px 4px;border-radius:2px">${step.priority?.toUpperCase()}</span>
      <span style="font-size:11px;color:#e5e7eb;font-weight:600;margin-left:4px">${step.action}</span>
      ${step.note ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px">${step.note}</div>` : ''}
      ${step.reference ? `<div style="font-size:10px;color:#6b7280;margin-top:1px">Ref: ${step.reference}</div>` : ''}
    </div>`).join('')}</div>` : ''}
    <div style="font-size:10px;color:#6b7280;margin-top:8px;border-top:1px solid #2a2a4a;padding-top:6px">${DISCLAIMER}</div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const OCCUPANCY_PARAMS = {
  office:         { olf: 100, minEgressWidth: 0.2, maxTravelDist: 100, requiresSprinkler: true },
  assembly:       { olf: 15,  minEgressWidth: 0.3, maxTravelDist: 75,  requiresSprinkler: true },
  educational:    { olf: 20,  minEgressWidth: 0.2, maxTravelDist: 75,  requiresSprinkler: true },
  mercantile:     { olf: 60,  minEgressWidth: 0.2, maxTravelDist: 100, requiresSprinkler: true },
  industrial:     { olf: 100, minEgressWidth: 0.2, maxTravelDist: 150, requiresSprinkler: true },
  storage:        { olf: 300, minEgressWidth: 0.2, maxTravelDist: 200, requiresSprinkler: false },
  high_storage:   { olf: 200, minEgressWidth: 0.2, maxTravelDist: 125, requiresSprinkler: true },
  residential:    { olf: 200, minEgressWidth: 0.2, maxTravelDist: 125, requiresSprinkler: true },
  hotel:          { olf: 200, minEgressWidth: 0.2, maxTravelDist: 125, requiresSprinkler: true },
  hospital:       { olf: 240, minEgressWidth: 0.2, maxTravelDist: 150, requiresSprinkler: true },
  parking:        { olf: 300, minEgressWidth: 0.2, maxTravelDist: 200, requiresSprinkler: false },
};

function getModelBounds(elements = []) {
  if (!elements.length) return null;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const el of elements) {
    const p = el.parameters || {};
    const x = parseFloat(p.x) || 0;
    const y = parseFloat(p.y) || 0;
    const z = parseFloat(p.z) || 0;
    const w = parseFloat(p.width) || 0;
    const h = parseFloat(p.height) || 0;
    const l = parseFloat(p.length) || 0;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x + (w || l));
    minY = Math.min(minY, y); maxY = Math.max(maxY, y + h);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z + (w || l));
  }
  if (!isFinite(minX)) return null;
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function getModelArea(model = {}) {
  const elements = model?.elements || [];
  let total = 0;
  for (const el of elements) {
    const p = el.parameters || {};
    total += (parseFloat(p.width) || parseFloat(p.length) || 5) *
             (parseFloat(p.height) || 3);
  }
  return total * 10.764; // m² → ft²
}

function capitalize(str) {
  return String(str || '').charAt(0).toUpperCase() + String(str || '').slice(1);
}

module.exports = {
  validateInputs,
  checkCompliance,
  getDesignGuidance,
  getCodeReference,
  renderComplianceSummary,
  renderValidationIssues,
  renderDesignGuidance,
  DISCLAIMER,
  SEVERITY_STYLES,
  VALIDATION_RULES,
};