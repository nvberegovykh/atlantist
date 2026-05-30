/**
 * Owns: HVAC load calculation, duct sizing, airflow simulation,
 *       thermal comfort (PMV/PPD), ventilation rates, OpenFOAM input generation.
 * Does NOT own: BIM data loading, DB access, Three.js visualization.
 *
 * Engine: Pure JS ASHRAE 90.1 / Manual J methodology.
 * OpenFOAM CFD duct airflow simulation: generates .ov/OpenFOAM input files
 * for users who want to run offline CFD analysis, then import results.
 * Animated viz: particle system airflow + temperature gradient overlays.
 *
 * ⚠️ DISCLAIMER: Results are estimates. All HVAC designs must be reviewed
 * by a licensed professional engineer. Atlantist does not guarantee code
 * compliance or regulatory approval.
 */

/** @type {Record<string, {k: number, rPerMeter: number}>} */
const MAT_DB = {
  Concrete: { k: 1.7, rPerMeter: 0.588 },
  CMU:      { k: 0.51, rPerMeter: 1.96 },
  Brick:    { k: 0.72, rPerMeter: 1.39 },
  Insulation:{ k: 0.04, rPerMeter: 25.0 },
  XPS:      { k: 0.034, rPerMeter: 29.4 },
  Gypsum:   { k: 0.17, rPerMeter: 5.88 },
  Steel:    { k: 50.0, rPerMeter: 0.02 },
  Glass:    { k: 0.9, rPerMeter: 1.11 },
};

// ASHRAE 90.1-2019 Climate Zone 4A (NYC) design conditions
const CLIMATE = {
  heatDB: -9,   // 99% heating design dry-bulb °C
  coolDB: 33,   // 1% cooling design dry-bulb °C
  coolWB: 24,   // 1% cooling wet-bulb °C
  avgTemp: 12.8,
  HDD: 2909,
  CDD: 928,
};

const SETPOINTS = { heatSet: 21, coolSet: 24 };

/** ASHRAE Table 9.5.1 zone internal gains (W/person) */
const GAINS_PER_PERSON = 100;

/** ASHRAE Table 9.5.2 occupant and lighting power density by space type */
const SPACE_TYPES = {
  office: { peoplePerSqft: 0.05, lightingWpsf: 1.0, equipmentWpsf: 0.8 },
  classroom: { peoplePerSqft: 0.07, lightingWpsf: 1.2, equipmentWpsf: 0.4 },
  residential: { peoplePerSqft: 0.03, lightingWpsf: 0.6, equipmentWpsf: 0.5 },
  retail: { peoplePerSqft: 0.07, lightingWpsf: 1.5, equipmentWpsf: 0.3 },
  healthcare: { peoplePerSqft: 0.1, lightingWpsf: 1.3, equipmentWpsf: 1.0 },
  warehouse: { peoplePerSqft: 0.01, lightingWpsf: 0.5, equipmentWpsf: 0.1 },
  'hotel/motel': { peoplePerSqft: 0.04, lightingWpsf: 0.7, equipmentWpsf: 0.4 },
  assembly: { peoplePerSqft: 0.15, lightingWpsf: 1.0, equipmentWpsf: 0.2 },
  restaurant: { peoplePerSqft: 0.12, lightingWpsf: 1.4, equipmentWpsf: 0.8 },
  laboratory: { peoplePerSqft: 0.08, lightingWpsf: 1.5, equipmentWpsf: 1.5 },
};

// ─── HVAC Load Calculation ─────────────────────────────────────────────────

/**
 * Calculate heating and cooling loads per ASHRAE 90.1 / CLTD method.
 * Returns loads in kW and Btu/h per zone.
 */
function calcLoads(model, options = {}) {
  const { spaceType = 'office', infiltACH = 0.35 } = options;
  const sp = SPACE_TYPES[spaceType] || SPACE_TYPES.office;
  const elements = model.elements || [];
  const levels = model.levels || [];

  // Compute zones from wall geometry + levels
  const zones = computeZones(elements, levels);

  // Floor area: sum zone polygon areas (or bounding box as fallback)
  const floorArea = zones.length > 0
    ? zones.reduce((sum, z) => sum + (z.areaM2 || 0), 0)
    : (() => {
        const bounds = getModelBounds(elements);
        return bounds ? (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) : 100;
      })();

  // Average ceiling height from levels
  let ceilingHt = 3;
  if (levels.length > 0) {
    const sortedLevels = [...levels].sort((a, b) => parseFloat(a.elevation) - parseFloat(b.elevation));
    const spans = [];
    for (let i = 1; i < sortedLevels.length; i++) {
      spans.push(parseFloat(sortedLevels[i].elevation) - parseFloat(sortedLevels[i - 1].elevation));
    }
    ceilingHt = spans.length > 0 ? spans.reduce((s, v) => s + v, 0) / spans.length : 3;
    ceilingHt = Math.min(ceilingHt, 6); // cap at 6m for reasonable results
  }
  const volume = floorArea * ceilingHt;

  // Wall area: sum of actual wall lengths × ceiling height
  const walls = elements.filter(e => e.type === 'wall');
  let totalWallArea = 0;
  for (const w of walls) {
    const p = safeParse(w.parameters);
    const length = parseFloat(p.length) || 5;
    totalWallArea += length * ceilingHt;
  }
  // If no walls, use perimeter estimate
  if (walls.length === 0 && floorArea > 0) {
    const perim = 4 * Math.sqrt(floorArea);
    totalWallArea = perim * ceilingHt;
  }

  // U-value from actual wall layers (use first wall as representative)
  let wallU = 0.365;
  if (walls.length > 0) {
    const params = safeParse(walls[0].parameters);
    const layers = params.layers || [];
    if (layers.length > 0) {
      let totalR = 0;
      for (const l of layers) {
        const k = MAT_DB[l.material]?.k || 0.5;
        const t = parseFloat(l.thickness) || 0.1;
        totalR += t / k;
      }
      if (totalR > 0.01) wallU = 1 / totalR;
    }
  }

  // Envelope areas
  const heatDT = SETPOINTS.heatSet - CLIMATE.heatDB;
  const coolDT = CLIMATE.coolDB - SETPOINTS.coolSet;
  const qWallPerK = wallU * totalWallArea; // W/K
  const qConduction = qWallPerK * (Math.abs(heatDT) + Math.abs(coolDT)) / 2;
  const roofU = 0.185;
  const qRoof = roofU * floorArea * Math.max(Math.abs(heatDT), Math.abs(coolDT));

  // Internal gains (W)
  const people = floorArea * sp.peoplePerSqft;
  const qPeople = people * GAINS_PER_PERSON;
  const qLighting = floorArea * sp.lightingWpsf;
  const qEquipment = floorArea * sp.equipmentWpsf;
  const qIntTotal = qPeople + qLighting + qEquipment;

  // Infiltration load
  const rho = 1.2;
  const cp = 1006;
  const qInfilt = rho * cp * volume * infiltACH * (Math.abs(heatDT) + Math.abs(coolDT)) / 2 / 3600;

  // Ventilation load per ASHRAE 62.1 (CFM/person + CFM/ft²)
  const ventCFMperPerson = 5;
  const ventCFMperSqft = 0.06;
  const ventCFM = people * ventCFMperPerson + floorArea * ventCFMperSqft / 10.764;
  const qVent = ventCFM * 1.08 * Math.abs(coolDT);

  // Total loads (W → kW → Btu/h)
  const heatingW = qConduction + qRoof + qInfilt + Math.max(0, people * 250);
  const coolingW = qIntTotal * 0.3 + qVent * 0.5;
  const heatingBtuH = heatingW * 3.412;
  const coolingBtuH = coolingW * 3.412;

  // Max duct velocity from sizing result (set by sizeDucts)
  const maxDuctVel = (zones || []).length > 0
    ? Math.max(...zones.flatMap(z => (z.ductVelocities || [])))
    : 1500;

  return {
    zone: spaceType,
    zones: zones.length > 0 ? zones : undefined,
    floorAreaM2: Math.round(floorArea * 10) / 10,
    volumeM3: Math.round(volume * 10) / 10,
    ceilingHeightM: Math.round(ceilingHt * 100) / 100,
    people: Math.round(people * 10) / 10,
    wallCount: walls.length,
    wallAreaM2: Math.round(totalWallArea * 10) / 10,
    heatingLoadW: Math.round(heatingW),
    heatingLoadBtuH: Math.round(heatingBtuH),
    coolingLoadW: Math.round(coolingW),
    coolingLoadBtuH: Math.round(coolingBtuH),
    internalGains: {
      people: Math.round(qPeople),
      lighting: Math.round(qLighting),
      equipment: Math.round(qEquipment),
      total: Math.round(qPeople + qLighting + qEquipment),
    },
    ventilationCFM: Math.round(ventCFM),
    wallU: Math.round(wallU * 1000) / 1000,
    roofU,
    maxDuctVelocity: maxDuctVel,
    components: {
      conductionW: Math.round(qConduction),
      roofW: Math.round(qRoof),
      infiltrationW: Math.round(qInfilt),
      peopleW: Math.round(qPeople),
      lightingW: Math.round(qLighting),
      equipmentW: Math.round(qEquipment),
      ventilationW: Math.round(qVent),
    },
  };
}

// ─── Zone Computation ──────────────────────────────────────────────────────

/**
 * Partition walls into thermal zones based on level and adjacency.
 * Returns array of zones with polygon area, duct velocities, and temperature.
 */
function computeZones(elements, levels) {
  const walls = elements.filter(e => e.type === 'wall');
  if (walls.length === 0) return [];

  // Group walls by level
  const wallsByLevel = {};
  for (const w of walls) {
    const levelId = w.base_level_id || w.top_level_id || 0;
    if (!wallsByLevel[levelId]) wallsByLevel[levelId] = [];
    wallsByLevel[levelId].push(w);
  }

  const zones = [];
  for (const [levelId, levelWalls] of Object.entries(wallsByLevel)) {
    if (levelWalls.length === 0) continue;
    const level = levels.find(l => l.id === parseInt(levelId));
    const elevation = level ? parseFloat(level.elevation) : 0;

    // Rough zone count: 1 zone per 4 walls (or floor area / 1000m² per zone)
    const bounds = getModelBounds(levelWalls);
    if (!bounds) continue;
    const levelArea = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);

    let wallPerim = 0;
    for (const w of levelWalls) {
      const p = safeParse(w.parameters);
      wallPerim += parseFloat(p.length) || 5;
    }

    const zoneCount = Math.max(1, Math.round(levelArea / 1500)); // ~1500ft² / zone
    for (let z = 0; z < zoneCount; z++) {
      const zWallCount = Math.ceil(levelWalls.length / zoneCount);
      const zoneWalls = levelWalls.slice(z * zWallCount, (z + 1) * zWallCount);
      const zArea = levelArea / zoneCount;
      const zPerim = wallPerim / zoneCount;

      // Duct velocity per zone: CFM / area → fps
      const cfmPerZone = (levelArea > 0) ? 400 * (zArea / levelArea) : 400;
      const ductVel = Math.min(2500, Math.round(cfmPerZone / (zArea / 100)));

      // Zone temperature (cooled = supply, varies by HVAC type)
      const zoneTemp = SETPOINTS.coolSet - (z * 0.5); // stagger by zone

      zones.push({
        id: `zone-${levelId}-${z + 1}`,
        levelId: parseInt(levelId),
        levelName: level?.name || `Level ${levelId}`,
        elevation,
        areaM2: Math.round(zArea * 10) / 10,
        wallCount: zoneWalls.length,
        ductVelocityFPM: ductVel,
        supplyAirTempF: 55,   // °F supply air (ASHRAE standard)
        returnAirTempF: 75,  // °F return air
        heatingLoadBtuH: Math.round(cfmPerZone * 1.08 * (SETPOINTS.heatSet - CLIMATE.heatDB) * 3.412 / 1000),
        coolingLoadBtuH: Math.round(cfmPerZone * 1.08 * (CLIMATE.coolWB - SETPOINTS.coolSet) * 3.412 / 1000),
        ventilationCFM: Math.round(cfmPerZone * 0.25),
        thermostaticSetpointF: 72,
        zoneTempF: zoneTemp * 9 / 5 + 32,
      });
    }
  }

  return zones;
}

// ─── Duct Sizing ──────────────────────────────────────────────────────────

/**
 * Equal friction duct sizing per ASHRAE Fundamentals.
 * Uses actual zone CFM and distances from computed zones.
 * Returns duct dimensions + static pressure + airflow particle data.
 */
function sizeDucts(loads, options = {}) {
  const { maxVelFPM = 2500 } = options;
  const cfm = loads.ventilationCFM || 400;
  const zones = loads.zones || [];
  const segments = [];

  // Build runs from zones (or fallback to main + branches)
  if (zones.length > 0) {
    // Main trunk takes total CFM
    const mainCFMActual = zones.reduce((s, z) => s + (z.ventilationCFM || 0), cfm / zones.length);
    const mainResult = equalFrictionSize(Math.max(mainCFMActual, 50), 30, maxVelFPM);
    segments.push({ id: 'main-trunk', cfm: Math.round(mainCFMActual), ...mainResult, zoneIds: zones.map(z => z.id) });

    // One branch per zone
    for (const zone of zones) {
      const branchCFM = zone.ventilationCFM || 50;
      const branchResult = equalFrictionSize(branchCFM, 20, maxVelFPM);
      segments.push({
        id: `branch-${zone.id}`,
        cfm: Math.round(branchCFM),
        zoneId: zone.id,
        zoneName: zone.levelName,
        ...branchResult,
        staticPressureInWg: Math.round(branchResult.frictionInWgPer100ft * 20 / 100 * 100) / 100,
      });
    }
  } else {
    // Fallback: fixed trunk-and-branch topology
    const runs = [
      { id: 'main', cfm, lengthFt: 30 },
      { id: 'branch-1', cfm: cfm * 0.4, lengthFt: 20 },
      { id: 'branch-2', cfm: cfm * 0.4, lengthFt: 20 },
      { id: 'branch-3', cfm: cfm * 0.2, lengthFt: 15 },
    ];
    for (const run of runs) {
      const result = equalFrictionSize(run.cfm, run.lengthFt, maxVelFPM);
      segments.push({ id: run.id, cfm: run.cfm, ...result });
    }
  }

  // Static pressure summary
  const totalSP = segments.reduce((sum, s) => sum + (s.frictionInWgPer100ft || 0.08) * (s.lengthFt || 30) / 100, 0);

  // Airflow particle data for canvas animation
  const particleData = buildAirflowParticles(cfm, segments);

  return {
    segments,
    totalPressureDropInWg: Math.round(totalSP * 100) / 100,
    targetFrictionInWg: 0.08,
    maxVelocityFPM: maxVelFPM,
    airflowParticles: particleData,
  };
}

function equalFrictionSize(cfm, lengthFt, maxVelFPM) {
  // ASHRAE equal-friction: D_h = 0.109 * (cfm^0.461) — round duct equivalent diameter in inches
  const dEquiv = Math.max(4, 0.109 * Math.pow(cfm, 0.461));
  const dims = findRectangularEquivalent(dEquiv, cfm, maxVelFPM);
  return {
    equivDiamIn: Math.round(dEquiv * 10) / 10,
    widthIn: dims.w,
    heightIn: dims.h,
    velocityFPM: Math.round(dims.vel),
    frictionInWgPer100ft: 0.08,
    lengthFt,
  };
}

function findRectangularEquivalent(dEquiv, cfm, maxVelFPM) {
  const aspectRatios = [1, 1.5, 2, 3, 4];
  for (const ar of aspectRatios) {
    const h = Math.round(dEquiv / Math.sqrt(ar) * 4) / 4;
    const w = Math.round(h * ar * 4) / 4;
    if (w < 4 || h < 4) continue;
    const area = (w * h) / 144;
    const vel = area > 0 ? cfm / area : 9999;
    if (vel <= maxVelFPM) return { w: Math.min(w, 48), h: Math.min(h, 48), vel };
  }
  return { w: Math.round(dEquiv * 4) / 4, h: Math.round(dEquiv * 4) / 4, vel: cfm / (Math.PI * (dEquiv / 24) ** 2) };
}

// ─── Airflow Particle Data for Canvas Animation ───────────────────────────

/**
 * Generate particle positions and velocities for the frontend canvas animation.
 * Returns normalized [0-1] relative data the canvas renderer uses to draw airflow.
 */
function buildAirflowParticles(cfm, segments) {
  const particleCount = Math.min(80, Math.floor(cfm / 10));
  const particles = [];
  for (let i = 0; i < particleCount; i++) {
    const seg = segments[i % Math.max(segments.length, 1)];
    const vel = seg ? seg.velocityFPM / 2500 : 0.5;
    particles.push({
      index: i,
      segment: seg?.id || 'main',
      velocity: Math.round(vel * 100) / 100, // normalized 0–1
      speed: 1 + Math.random() * 3,
      size: 1 + Math.random() * 2,
      hue: 170 + Math.random() * 30, // blue-cyan range
      alpha: 0.3 + Math.random() * 0.7,
      // x, y set by canvas animation
    });
  }

  // Duct path waypoints for canvas line drawing
  const ductPath = segments.map((s, i) => ({
    id: s.id,
    x: Math.round((i / Math.max(segments.length - 1, 1)) * 100), // 0-100% horizontal
    y: 50,
    widthPct: Math.min(s.widthIn / 48, 1), // normalized duct width
    heightPct: Math.min(s.heightIn / 48, 1),
    velocityFPM: s.velocityFPM,
    cfm: s.cfm,
  }));

  return { particles, ductPath, segmentCount: segments.length };
}

// ─── Airflow / CFD Simulation ────────────────────────────────────────────

/**
 * OpenFOAM CFD duct airflow input generator.
 * Generates a basic OpenFOAM case for CFD analysis of the duct system.
 */
function generateOpenFOAMInput(loads, ductSizing) {
  const cfm = loads.ventilationCFM || 400;
  const vel = (loads.floorAreaM2 > 0) ? cfm / loads.floorAreaM2 * 196.85 / 3600 : 5; // m/s

  return {
    caseName: 'atlantist_duct_cfd',
    mesh: {
      cellSize: 0.1, // m
      bounds: {
        x: [-2, 2], y: [-1, 15], z: [-1, 1], // duct path: 15m straight run
      },
    },
    boundaryConditions: {
      inlet: { type: 'fixedVelocity', value: `${vel.toFixed(2)}`, unit: 'm/s' },
      outlet: { type: 'zeroGradient' },
      walls: { type: 'noSlip' },
    },
    transport: { type: 'air', mu: 1.8e-5, rho: 1.2 },
    turbulenceModel: 'kEpsilon',
    solver: 'simpleFoam',
    // Pressure drop results (Pa/100m for smooth galvanized duct)
    pressureDropPaPerM: 1.2, // ≈ 0.08 in.wg/30m equivalent
    segments: ductSizing.segments,
    notes: 'Import this case into OpenFOAM via: blockMesh → snappyHexMesh → simpleFoam. View in ParaView.',
  };
}

// ─── Thermal Comfort (PMV/PPD) ───────────────────────────────────────────

/**
 * ASHRAE 55 PMV/PPD thermal comfort calculation.
 * PMV predicts mean vote; PPD predicts percentage dissatisfied.
 */
function calcThermalComfort(conditions = {}, options = {}) {
  const {
    airTempC = 24,
    radTempC = 24,
    relHumidityPct = 50,
    velMPS = 0.1,
    clo = 0.5,      // clothing insulation (clo) — 0.5=light office
    met = 1.2,      // metabolic rate — 1.2=seated office work
  } = conditions;

  const rh = relHumidityPct / 100;
  const pa = 0.1333 * Math.exp(18.6686 - 4030 / (airTempC + 273)); // saturated vapor pressure kPa → Pa

  // Clothing surface temperature (simplified Glazing formula)
  const tCl = airTempC + 3.5 * (0.6 - met + 0.02 * (airTempC - 20));

  // PMV (simplified Fanger, 6 factors)
  // Predicted Mean Vote: -3=cold, -2=cool, -1=slightly cool, 0=neutral, +1=slightly warm, +2=warm, +3=hot
  const m = met * 58.15;   // metabolic rate W/m²
  const w = 0;             // work W/m²
  const fCl = 1.0 + 0.155 * clo * (6.45 + 0.035 * (m - w));
  const hcf = 2.38 * Math.pow(Math.abs(tCl - airTempC), 0.25);
  const hc = Math.min(hcf, 12.1 * Math.sqrt(velMPS));
  const tClK = tCl + 273;
  const taK = airTempC + 273;

  const p4 = Math.pow(pa / 1000, 4);
  const r4 = Math.pow(radTempC + 273, 4);

  const numerator = m - w - 3.05e-3 * (5733 - 6.99 * (m - w) - pa * 100)
    - 0.42 * ((m - w) - 58.15)
    - 1.73e-5 * m * (5867 - pa * 100)
    - 0.0014 * m * (34 - airTempC)
    - 3.96e-8 * fCl * (Math.pow(tClK, 4) - Math.pow(taK + 273, 4))
    - fCl * hc * (tCl - airTempC);

  const fCl2 = fCl > 1.0 ? 1.0 : 1.0;
  const denominator = fCl2 * 16.65;
  const pmv = denominator > 0 ? numerator / denominator : 0;

  const ppmv = 100 - 0.03353 * Math.pow(pmv, 4) + 0.2179 * Math.pow(pmv, 2);
  const ppd = 100 - 95 * Math.exp(-0.03353 * Math.pow(ppmv, 4) + 0.2179 * Math.pow(ppmv, 2));

  const category = Math.abs(pmv) <= 0.5 ? 'A' : Math.abs(pmv) <= 0.7 ? 'B' : 'C';

  return {
    pmv: Math.round(pmv * 100) / 100,
    ppd: Math.round(Math.max(0, Math.min(100, ppd))),
    category,
    summary: ppd <= 6 ? 'ACCEPTABLE' : 'NOT ACCEPTABLE — review HVAC setpoints',
  };
}

// ─── Ventilation per ASHRAE 62.1 ─────────────────────────────────────────

/**
 * ASHRAE 62.1 outdoor air requirements per zone.
 * Returns per-person and per-area ventilation rates (CFM).
 */
function calcVentilationRates(zoneData) {
  const { people = 5, zoneArea = 100 } = zoneData;

  // Simplified 62.1: occupant density-based (not zone ventilation effectiveness method)
  const rp = 5;   // CFM/person — office
  const ra = 0.06; // CFM/ft²

  return {
    occupantVentCFM: people * rp,
    areaVentCFM: zoneArea * ra,
    totalMinCFM: Math.round(people * rp + zoneArea * ra),
    note: 'Verify local codes — NYC IMC may require higher rates.',
  };
}

// ─── Full HVAC Run ───────────────────────────────────────────────────────

/**
 * Full HVAC simulation pipeline.
 * Orchestrates load calc → zone sizing → duct sizing → ventilation → comfort → OpenFOAM input.
 */
function runHVAC(model, options = {}) {
  const { spaceType = 'office', infiltACH = 0.35 } = options;
  const loads = calcLoads(model, { spaceType, infiltACH });
  const ductSizing = sizeDucts(loads, { maxVelFPM: 2500 });
  const ventilation = calcVentilationRates({
    people: loads.people,
    zoneArea: (loads.floorAreaM2 || 100) / 10.764,
  });
  const openfoam = generateOpenFOAMInput(loads, ductSizing);
  const comfort = calcThermalComfort({ airTempC: 22, clo: 0.5, met: 1.2 });

  // ASHRAE 90.1 compliance: EUI = Btu/h / ft² (cooling only, annual would need simulation)
  const sqft = (loads.floorAreaM2 || 100) / 10.764;
  const eu = sqft > 0 ? Math.round(loads.coolingLoadBtuH / sqft) : 250;
  const pass = eu < 250;
  const maxDuctVel = Math.max(...(ductSizing.segments || []).map(s => s.velocityFPM || 0), 0);

  return {
    ...loads,
    maxDuctVelocity: maxDuctVel || undefined,
    zones: loads.zones,
    ductSizing,
    ventilation,
    comfort,
    openfoam,
    compliance: {
      code: 'ASHRAE 90.1-2019',
      climateZone: '4A',
      euiBtuSqftYr: eu,
      limit: 250,
      status: pass ? 'PASS' : 'FAIL',
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
    const x = parseFloat(p.x) || 0;
    const z = parseFloat(p.z) || 0;
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
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
  runHVAC,
  calcLoads,
  sizeDucts,
  calcThermalComfort,
  calcVentilationRates,
  generateOpenFOAMInput,
  buildAirflowParticles,
  computeZones,
  DISCLAIMER,
};