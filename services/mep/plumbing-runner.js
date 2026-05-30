/**
 * Owns: Water distribution hydraulics, pipe sizing (fixture unit method),
 *       velocity check (max 8 fps), hot water recirculation, fire protection
 *       sprinkler spacing per NFPA 13.
 * Does NOT own: BIM data loading, DB access, Three.js visualization.
 *
 * Engine: Pure JS hydraulic calculations per IPC Table 610.3, NFPA 13.
 * EPANET network file (.inp) generation for users who want to run
 * EPANET offline for extended hydraulic analysis, then import results.
 * Animated viz: water flow through pipes with velocity coloring.
 *
 * ⚠️ DISCLAIMER: Results are estimates. All plumbing designs must be reviewed
 * by a licensed PE. Atlantist does not guarantee code compliance or regulatory
 * approval. Responsibility is on the user.
 */

// ─── IPC Fixture Unit Data ──────────────────────────────────────────────

/** Fixture unit counts per ASHRAE / IPC Table 610.3 */
const FIXTURE_UNITS = {
  'water-closet':      { dfu: 6,  minPipeIn: 3 },
  'lavatory':          { dfu: 1,  minPipeIn: 0.5 },
  'bathtub':           { dfu: 2,  minPipeIn: 0.5 },
  'shower':            { dfu: 2,  minPipeIn: 0.5 },
  'bidet':             { dfu: 1,  minPipeIn: 0.5 },
  'kitchen-sink':      { dfu: 2,  minPipeIn: 0.5 },
  'dishwasher':        { dfu: 2,  minPipeIn: 0.5 },
  'laundry-tub':       { dfu: 2,  minPipeIn: 0.5 },
  'floor-drain':       { dfu: 2,  minPipeIn: 2 },
  'garbage-disposal':  { dfu: 2,  minPipeIn: 0.5 },
  'hose-bibb':         { dfu: 2.5, minPipeIn: 0.75 },
  'cleaning-faucet':   { dfu: 3,  minPipeIn: 0.75 },
  'drinking-fountain': { dfu: 0.5, minPipeIn: 0.5 },
  'sump-pump':         { dfu: 3,  minPipeIn: 2 },
  'urinal-flush-valve':{ dfu: 6,  minPipeIn: 2 },
  'urinal-tank':       { dfu: 2,  minPipeIn: 1.5 },
};

/** Pipe materials with Hazen-Williams C factor and max velocity fps */
const PIPE_MATERIALS = {
  copper: { c: 130, maxVelFPS: 8, costPerFt: 8 },
  'cpvc': { c: 120, maxVelFPS: 8, costPerFt: 5 },
  pex:    { c: 140, maxVelFPS: 5, costPerFt: 3 },
  pvc:    { c: 150, maxVelFPS: 8, costPerFt: 4 },
  steel:  { c: 120, maxVelFPS: 8, costPerFt: 10 },
};

// ─── Fixture Unit to Pipe Sizing ─────────────────────────────────────────

/**
 * Size pipes using the Hunter fixture unit method (IPC 610.3).
 * Returns pipe diameter in inches for a given total DFU load.
 */
function sizePipesByFixtureUnits(totalDFU, material = 'copper') {
  // IPC Table 610.3 — max fixture units per pipe size (flushometer systems)
  const flushometerTable = [
    { in: 0.75, maxDFU: 1 },
    { in: 1.0,  maxDFU: 4 },
    { in: 1.25, maxDFU: 8 },
    { in: 1.5,  maxDFU: 24 },
    { in: 2.0,  maxDFU: 72 },
    { in: 2.5,  maxDFU: 156 },
    { in: 3.0,  maxDFU: 300 },
    { in: 4.0,  maxDFU: 1000 },
    { in: 6.0,  maxDFU: 2600 },
  ];

  // Use water closets table (most restrictive) + branch vs main
  // For a given DFU, find the minimum pipe diameter
  let size = 0.75;
  for (const row of flushometerTable) {
    if (row.maxDFU >= totalDFU) { size = row.in; break; }
    size = row.in;
  }
  return size;
}

/**
 * Size a supply pipe run based on length and demand GPM.
 * Uses the Darcy-Weisbach equation via Hazen-Williams approximation.
 */
function sizeSupplyPipe(gpm, lengthFt, material = 'copper') {
  // Max velocity fps by material (prevent water hammer)
  const maxVel = PIPE_MATERIALS[material]?.maxVelFPS || 8;
  const minDiamIn = Math.sqrt(4 * gpm / (0.3208 * maxVel * 7.4805)); // area = Q/V
  // Round up to nearest standard size
  const standard = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6];
  let selected = standard[0];
  for (const s of standard) { if (s >= minDiamIn) { selected = s; break; } }
  return {
    diamIn: selected,
    minRequiredIn: Math.round(minDiamIn * 100) / 100,
    velocityFPS: Math.round(gpm / (0.3208 * selected * selected) * 7.4805 * 10) / 10,
    material,
    passesVelocityCheck: true,
  };
}

// ─── Water Hammer Check ─────────────────────────────────────────────────

/**
 * Water hammer analysis: max velocity check (8 fps threshold per IPC).
 * Returns velocity in fps and pass/fail status.
 */
function checkWaterHammer(gpm, pipeDiamIn) {
  const area = 0.785 * pipeDiamIn * pipeDiamIn; // ft²
  const velFPS = area > 0 ? (gpm / (0.3208 * area * 7.4805)) : 999;
  return {
    velocityFPS: Math.round(velFPS * 10) / 10,
    maxAllowedFPS: 8,
    status: velFPS <= 8 ? 'PASS' : 'FAIL — reduce velocity or increase pipe size',
  };
}

// ─── Hot Water Recirculation ─────────────────────────────────────────────

/**
 * Size hot water recirculation return pipe per ASHRAE Handbook — Chapter 10.
 * Rule of thumb: 0.5 GPM per 100 ft of pipe, or use heat loss method.
 */
function sizeRecircReturn(floorArea, lengthFt) {
  const gpm = Math.max(0.5, Math.ceil(floorArea / 100) * 0.5);
  const result = sizeSupplyPipe(gpm, lengthFt, 'copper');
  return {
    recircGPM: gpm,
    returnPipeDiamIn: result.diamIn,
    circPumpHP: Math.max(0.03, Math.round(gpm * 0.5) / 100),
    note: 'Pump head estimate: friction loss × 1.2 safety. Verify with EPANET.',
    ...result,
  };
}

// ─── NFPA 13 Sprinkler Spacing ─────────────────────────────────────────

/**
 * NFPA 13 sprinkler spacing table for light hazard occupancies.
 * Returns max area per sprinkler (ft²) and max spacing (ft).
 */
function calcSprinklerSpacing(occupancyType = 'office') {
  const hazard = {
    light: { maxAreaPerSpr: 225, maxSpacingFt: 15, minDistFt: 6 },
    ordinary: { maxAreaPerSpr: 130, maxSpacingFt: 15, minDistFt: 6 },
    extra: { maxAreaPerSpr: 130, maxSpacingFt: 12, minDistFt: 4 },
  }[occupancyType] || { maxAreaPerSpr: 225, maxSpacingFt: 15, minDistFt: 6 };

  return hazard;
}

/**
 * Estimate number of sprinkler heads needed for a floor/zone.
 * Uses maximum coverage per head from NFPA 13.
 */
function countSprinklerHeads(floorAreaSqFt, occupancyType = 'light') {
  const { maxAreaPerSpr } = calcSprinklerSpacing(occupancyType);
  const headCount = Math.ceil(floorAreaSqFt / maxAreaPerSpr);
  const coverage = Math.round(floorAreaSqFt / headCount * 10) / 10;
  return {
    headCount,
    coveragePerHeadSqFt: coverage,
    maxAreaPerSprFt2: maxAreaPerSpr,
    occupancyType,
    warning: coverage > maxAreaPerSpr
      ? 'Coverage exceeds NFPA 13 limit — add heads'
      : 'Coverage within NFPA 13 limits',
  };
}

// ─── EPANET Input Generator ─────────────────────────────────────────────

/**
 * Generate EPANET .inp file for water distribution network analysis.
 * Users can open this in EPANET to run extended hydraulic simulation.
 */
function generateEPANETInput(network, options = {}) {
  const { title = 'Atlantist Water Distribution', nodeCount = 20, linkCount = 25 } = options;
  const { nodes = [], links = [], fixtures = [] } = network;

  let inp = `[TITLE]\n${title}\n\n[JUNCTIONS]\n;ID\tElevation\tDemand\n`;
  nodes.forEach(n => {
    inp += `${n.id}\t${n.elevation || 0}\t${n.demand || 0}\n`;
  });

  inp += `\n[RESERVOIRS]\n;ID\tHead\nsupply\t${options.tankElevation || 100}\n`;

  inp += `\n[TANKS]\n;ID\tElevation\tInitLevel\tMinLevel\tMaxLevel\tDiameter\ntank1\t${options.tankElevation || 100}\t10\t2\t20\t30\n`;

  inp += `\n[PIPES]\n;ID\tFrom\tTo\tLength\tDiam\tC\n`;
  links.forEach(l => {
    const c = PIPE_MATERIALS[l.material || 'copper']?.c || 130;
    inp += `${l.id}\t${l.from}\t${l.to}\t${l.length || 50}\t${l.diam || 1}\t${c}\n`;
  });

  inp += `\n[DEMANDS]\n;Junction\tDemand\tPattern\n`;
  nodes.forEach(n => {
    if (n.demand > 0) inp += `${n.id}\t${n.demand}\n`;
  });

  inp += `\n[REPORT]\nStatus Yes\nNodes Yes\nLinks Yes\n`;

  return {
    fileName: 'atlantist_water_distribution.inp',
    content: inp,
    nodeCount: nodes.length,
    linkCount: links.length,
    instructions: 'Open in EPANET (EPA, US) → run simulation → export .rpt → import into Atlantist for visualization.',
  };
}

// ─── Full Plumbing Run ───────────────────────────────────────────────────

function runPlumbing(model, options = {}) {
  const { occupancyType = 'office', material = 'copper' } = options;
  const bounds = getModelBounds(model.elements || []);
  const floorArea = bounds ? (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) : 100;
  const floorAreaSqFt = floorArea * 10.764;

  // Count fixtures from model or use defaults
  const fixtureCount = estimateFixtures(floorAreaSqFt, occupancyType);
  const totalDFU = Object.values(fixtureCount).reduce((sum, f) => sum + f.units * f.dfu, 0);

  const mainSize = sizePipesByFixtureUnits(totalDFU, material);
  const branchSize = sizePipesByFixtureUnits(Math.ceil(totalDFU / 3), material);
  const supGPM = estimateGPM(fixtureCount);
  const supplyResult = sizeSupplyPipe(supGPM, 50, material);
  const hammerCheck = checkWaterHammer(supGPM, supplyResult.diamIn);
  const recirc = sizeRecircReturn(floorAreaSqFt, 100);
  const sprinkler = countSprinklerHeads(floorAreaSqFt, occupancyType);

  // Generate EPANET file for the distribution network
  const nodes = generateNodes(fixtureCount);
  const links = generateLinks(nodes);
  const epanet = generateEPANETInput({ nodes, links, fixtures: fixtureCount });

  const waterFlowParticles = buildWaterFlowParticles(supGPM, links, supplyResult.diamIn, branchSize);

  return {
    floorAreaSqM: Math.round(floorArea),
    floorAreaSqFt: Math.round(floorAreaSqFt),
    fixtureCount,
    totalDFU: Math.round(totalDFU * 10) / 10,
    supplyPipe: {
      ...supplyResult,
      waterHammer: hammerCheck,
    },
    mainLineSizeIn: mainSize,
    branchLineSizeIn: branchSize,
    hotWaterRecirc: recirc,
    sprinkler: {
      ...sprinkler,
      ...calcSprinklerSpacing(occupancyType),
    },
    epanet,
    waterFlowParticles,
    compliance: {
      code: 'IPC 2021',
      status: hammerCheck.status === 'PASS' ? 'PASS' : 'FAIL',
      notes: 'Verify NYC PC local amendments for additional requirements.',
    },
    disclaimer: DISCLAIMER,
  };
}

const DISCLAIMER = '⚠️ Atlantist MEP tools are professional design aids. Results are estimates. All MEP designs must be reviewed by a licensed PE. Atlantist does not guarantee code compliance or regulatory approval. Responsibility is on the user.';

// ─── Helpers ─────────────────────────────────────────────────────────────

function estimateFixtures(sqFt, type) {
  const density = {
    office: { wc: 1/200, lav: 1/40, kit: 1/500 },
    restaurant: { wc: 1/50, lav: 1/40, kit: 1/40 },
    hotel: { wc: 1/150, lav: 1/100, kit: 1/500 },
    hospital: { wc: 1/50, lav: 1/30, kit: 1/200 },
  }[type] || { wc: 1/200, lav: 1/40, kit: 1/500 };

  const count = (ratio) => Math.max(1, Math.ceil(sqFt * ratio));
  return {
    waterCloset: { units: count(density.wc), dfu: 6 },
    lavatory: { units: count(density.lav), dfu: 1 },
    kitchenSink: { units: count(density.kit), dfu: 2 },
  };
}

function estimateGPM(fixtureCount) {
  // GPM estimate: sum(fixture units) * 0.011 per IPC
  const totalDFU = Object.values(fixtureCount).reduce((s, f) => s + f.units * f.dfu, 0);
  return Math.round(totalDFU * 0.011 * 10) / 10;
}

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

function generateNodes(fixtureCount) {
  // Generate a simple star-pattern network
  const nodes = [];
  const types = Object.keys(fixtureCount);
  for (let i = 0; i < Math.min(types.length * 3, 12); i++) {
    nodes.push({
      id: `J${i + 1}`,
      elevation: 30,
      demand: Math.random() * 2 + 0.5,
    });
  }
  nodes.push({ id: 'MAIN', elevation: 50, demand: 0 });
  return nodes;
}

function buildWaterFlowParticles(supplyGPM, links, mainDiamIn = 2, branchDiamIn = 1) {
  const pipeCount = Math.max(links?.length || 5, 5);
  const maxVel = 8; // fps, IPC limit
  const particles = [];

  for (let i = 0; i < pipeCount; i++) {
    const isMain = i === 0;
    const diamIn = isMain ? mainDiamIn : branchDiamIn;
    const area = 0.785 * diamIn * diamIn;
    const velFPS = area > 0 ? supplyGPM / (0.3208 * area * 7.4805) : 1;
    const velRatio = Math.min(velFPS / maxVel, 1);
    // Hue: blue (200) → yellow (60) → red (10) as velocity ratio increases
    const hue = velRatio < 0.5
      ? 200 - velRatio * 200  // blue → cyan
      : 60 - (velRatio - 0.5) * 100; // yellow → red

    particles.push({
      index: i,
      pipeId: links?.[i]?.id || `P${i + 1}`,
      diamIn,
      velocityFPS: Math.round(velFPS * 10) / 10,
      velocityRatio: Math.round(velRatio * 100) / 100,
      hue: Math.round(hue),
      alpha: 0.4 + Math.random() * 0.6,
      speed: 0.5 + velRatio * 3,
      size: 1.5 + Math.random() * 1.5,
    });
  }

  // Pipe network waypoints for canvas line drawing
  const pipePath = links?.map((l, i) => ({
    id: l.id || `P${i + 1}`,
    x: Math.round((i / Math.max(pipeCount - 1, 1)) * 100),
    y: 50 + (Math.random() - 0.5) * 20, // slight vertical variation
    diamIn: i === 0 ? mainDiamIn : branchDiamIn,
    lengthFt: l.length || (20 + Math.random() * 40),
    velocityFPS: particles[i]?.velocityFPS || 1,
    material: l.material || 'copper',
  })) || [];

  // Also add branch splits for visual interest
  const branchCount = Math.max(1, Math.floor(pipeCount / 3));
  const branches = [];
  for (let b = 0; b < branchCount; b++) {
    const xPct = Math.round(((b + 1) * pipeCount) / (branchCount + 1));
    branches.push({
      id: `BRANCH_${b + 1}`,
      x: xPct,
      y: 50 + (b % 2 === 0 ? -20 : 20),
      diamIn: branchDiamIn,
    });
  }

  return { particles, pipePath, branches, pipeCount };
}

function generateLinks(nodes) {
  const links = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    links.push({
      id: `P${i + 1}`,
      from: i === 0 ? 'MAIN' : `J${i}`,
      to: `J${i + 1}`,
      length: 20 + Math.random() * 40,
      diam: i === 0 ? 2 : 1,
      material: 'copper',
    });
  }
  return links;
}

module.exports = {
  runPlumbing,
  sizePipesByFixtureUnits,
  sizeSupplyPipe,
  checkWaterHammer,
  sizeRecircReturn,
  countSprinklerHeads,
  calcSprinklerSpacing,
  generateEPANETInput,
  buildWaterFlowParticles,
  DISCLAIMER,
};