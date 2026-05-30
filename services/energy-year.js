/**
 * Owns: Energy year visualization — hourly/hourly-monthly data generation,
 *       peak/worst zone computation, HVAC load curve derivation.
 * Does NOT own: Three.js heatmap rendering, chart drawing, export — those live in the frontend.
 *
 * Produces 8,760 hourly data points from a single simulation result snapshot.
 * Also precomputes monthly, seasonal, and dashboard-summary aggregates.
 */

/**
 * Generate 8,760-hourly data array from simulation results.
 * Uses NYC TMY3 climate patterns for realistic hourly variation.
 *
 * @param {object} simResults — output of runSimulation()
 * @param {object} modelData  — { elements, familyInstances } for geometry context
 * @returns {object} { hourly[], monthly[], seasonal[], dashboard, hvacLoad }
 */
function generateYearData(simResults, modelData) {
  const { elements = [], familyInstances = [] } = modelData || {};

  // ── Derived model params ──────────────────────────────────────────────────
  const walls = elements.filter(e => e.type === 'wall');
  const bounds = getModelBounds(elements);
  const floorAreaM2 = bounds
    ? (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)
    : 100;

  const totalGlazingM2 = simResults.totalGlazingAreaM2 || 0;
  const totalWallM2 = simResults.totalWallAreaM2 || 0;
  const uWall = simResults.avgWallUValue || 0.365;
  const uGlazing = simResults.windowUValue || 2.0;
  const peakHeatKW = simResults.peakHeatingKW || 100;
  const peakCoolKW = simResults.peakCoolingKW || 80;
  const heatingCOP = simResults.heatingCOP || 3.5;
  const coolingCOP = simResults.coolingCOP || 3.2;

  // ── NYC TMY3 typical hourly temperatures (°C) — by month, 24h ─────────────
  const TMY3_HOURLY_TEMP = buildNYCTMY3();

  // ── HVAC schedule (occupancy fraction 0..1 per hour) ─────────────────────
  const HVAC_SCHEDULE = buildHVACSchedule();

  // ── Solar gain variation by month (north/south/east/west/window) ──────────
  const MONTH_SOLAR_MULT = [0.30,0.40,0.55,0.72,0.88,1.0,1.05,0.98,0.82,0.65,0.45,0.32];

  // ── Precompute monthly totals for aggregation ────────────────────────────
  const monthlyKWh = new Array(12).fill(null).map(() => ({ heating: 0, cooling: 0, lighting: 0, equip: 0, dhw: 0 }));

  // ── Run through 8,760 hours ──────────────────────────────────────────────
  const hourly = [];
  let hourIndex = 0;

  for (let month = 0; month < 12; month++) {
    const daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31][month];
    const solarMult = MONTH_SOLAR_MULT[month];

    for (let day = 1; day <= daysInMonth; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const outdoorTemp = TMY3_HOURLY_TEMP[month][hour];
        const occupancy = HVAC_SCHEDULE[hour]; // 0-1

        // ── Heating load ───────────────────────────────────────────────────────
        // Setpoint 21°C; when outdoor < 21, load proportional to delta-T
        const heatDelta = Math.max(0, 21 - outdoorTemp);
        // Occupancy reduces heating (people + equipment add heat)
        const occupancyBenefit = occupancy * (simResults.grossFloorAreaM2 / 10) * 120 / 1000; // kW from people
        const wallUA = uWall * totalWallM2;
        const glazingUA = uGlazing * totalGlazingM2;
        const totalUA = wallUA + glazingUA;
        const heatLoadKW = Math.max(0, totalUA * heatDelta / 1000 - occupancyBenefit * 0.4);
        const heatingKWh = heatLoadKW / 1000; // kWh for this hour

        // ── Cooling load ──────────────────────────────────────────────────────
        // Setpoint 24°C; when outdoor > 24, need cooling
        const coolDelta = Math.max(0, outdoorTemp - 24);
        // Internal gains from occupancy
        const internalGainKW = (simResults.grossFloorAreaM2 / 10) * occupancy * 120 / 1000 +
                               simResults.lightingKWh / 8760 * 0.5 * occupancy +
                               simResults.equipKWh / 8760 * 0.6 * occupancy;
        // Solar gain through glazing (south-west faces get more)
        const glazingArea = totalGlazingM2;
        const solarGainKW = glazingArea * 0.38 * solarMult * 0.6; // 0.38 SHGC, peak 600 W/m²
        const coolLoadKW = Math.max(0, totalUA * coolDelta / 1000 + internalGainKW + solarGainKW);
        const coolingKWh = coolLoadKW / 1000;

        // ── Base loads (constant) ─────────────────────────────────────────────
        const lightingKWh = (simResults.lightingKWh / 8760) * (occupancy > 0.1 ? 1 : 0.05);
        const equipKWh = (simResults.equipKWh / 8760) * (occupancy > 0.1 ? 1 : 0.08);
        const dhwKWh = simResults.dhwKWh / 8760;

        const totalKWh = heatingKWh + coolingKWh + lightingKWh + equipKWh + dhwKWh;

        // ── Indoor temperature estimate (°C) ─────────────────────────────────
        // Simple steady-state: indoor moves toward outdoor + internal gains offset
        const setpoint = outdoorTemp < 18 ? 21 : outdoorTemp > 26 ? 24 : outdoorTemp;
        const indoorTemp = Math.max(18, Math.min(30, setpoint + 1.5 * Math.sin((hour - 8) * Math.PI / 12)));

        // ── Zone label (coarse bucketing) ────────────────────────────────────
        const zoneLabel = heatLoadKW > peakHeatKW * 0.7 ? 'heating_dominant'
                        : coolLoadKW > peakCoolKW * 0.7 ? 'cooling_dominant'
                        : 'mixed';

        hourly.push({
          hourIndex,
          month,        // 0-11
          day,          // 1-31
          hour,         // 0-23
          outdoorTemp: Math.round(outdoorTemp * 10) / 10,
          indoorTemp: Math.round(indoorTemp * 10) / 10,
          heatingKWh: Math.round(heatingKWh * 100) / 100,
          coolingKWh: Math.round(coolingKWh * 100) / 100,
          lightingKWh: Math.round(lightingKWh * 100) / 100,
          equipKWh: Math.round(equipKWh * 100) / 100,
          dhwKWh: Math.round(dhwKWh * 100) / 100,
          totalKWh: Math.round(totalKWh * 100) / 100,
          solarGainKW: Math.round(solarGainKW * 100) / 100,
          zoneLabel,
          occupancy: Math.round(occupancy * 100) / 100,
        });

        // Accumulate monthly
        monthlyKWh[month].heating += heatingKWh;
        monthlyKWh[month].cooling += coolingKWh;
        monthlyKWh[month].lighting += lightingKWh;
        monthlyKWh[month].equip += equipKWh;
        monthlyKWh[month].dhw += dhwKWh;

        hourIndex++;
      }
    }
  }

  // ── Monthly aggregates ────────────────────────────────────────────────────
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthly = monthlyKWh.map((m, i) => ({
    month: i,
    label: monthNames[i],
    days: [31,28,31,30,31,30,31,31,30,31,30,31][i],
    heatingKWh: Math.round(m.heating * 100) / 100,
    coolingKWh: Math.round(m.cooling * 100) / 100,
    lightingKWh: Math.round(m.lighting * 100) / 100,
    equipKWh: Math.round(m.equip * 100) / 100,
    dhwKWh: Math.round(m.dhw * 100) / 100,
    totalKWh: Math.round((m.heating + m.cooling + m.lighting + m.equip + m.dhw) * 100) / 100,
    peakHeatKW: Math.round(peakHeatKW * 100) / 100,
    peakCoolKW: Math.round(peakCoolKW * 100) / 100,
  }));

  // ── Seasonal aggregates ───────────────────────────────────────────────────
  const seasonal = [
    { season: 'Winter', label: 'Dec–Feb', months: [11,0,1], color: '#60a5fa' },
    { season: 'Spring', label: 'Mar–May', months: [2,3,4], color: '#34d399' },
    { season: 'Summer', label: 'Jun–Aug', months: [5,6,7], color: '#f87171' },
    { season: 'Fall',   label: 'Sep–Nov', months: [8,9,10], color: '#fbbf24' },
  ].map(s => {
    const totals = s.months.reduce((acc, mi) => {
      acc.heating += monthly[mi].heatingKWh;
      acc.cooling += monthly[mi].coolingKWh;
      acc.total += monthly[mi].totalKWh;
      return acc;
    }, { heating: 0, cooling: 0, total: 0 });
    return {
      season: s.season,
      label: s.label,
      color: s.color,
      heatingKWh: Math.round(totals.heating * 100) / 100,
      coolingKWh: Math.round(totals.cooling * 100) / 100,
      totalKWh: Math.round(totals.total * 100) / 100,
    };
  });

  // ── Dashboard summary ────────────────────────────────────────────────────
  const totalAnnualKWh = hourly.reduce((s, h) => s + h.totalKWh, 0);
  const peakHourEntry = hourly.reduce((best, h) =>
    (h.totalKWh > best.totalKWh) ? h : best, { totalKWh: -Infinity });

  const peakHeatHourEntry = hourly.reduce((best, h) =>
    (h.heatingKWh > best.heatingKWh) ? h : best, { heatingKWh: -Infinity });

  const peakCoolHourEntry = hourly.reduce((best, h) =>
    (h.coolingKWh > best.coolingKWh) ? h : best, { coolingKWh: -Infinity });

  // Worst zone (highest total energy consumption across year)
  // Simple: use peak heating + cooling months as worst
  const worstMonths = [0, 1, 6, 7]; // Jan, Feb, Jul, Aug
  const worstMonth = worstMonths.reduce((best, mi) =>
    monthly[mi].totalKWh > best.totalKWh ? monthly[mi] : best, { totalKWh: 0 });

  const EUI = (totalAnnualKWh * 3.412) / (simResults.grossFloorAreaFt2 || 1076);

  const heatingMonths = monthly.filter(m => m.heatingKWh > 50);
  const coolingMonths = monthly.filter(m => m.coolingKWh > 50);

  // ── HVAC load curve (24h typical day, peak month July) ──────────────────
  const julyHours = hourly.filter(h => h.month === 6);
  const julyDaily = julyHours.reduce((days, h) => {
    if (!days[h.day]) days[h.day] = [];
    days[h.day].push(h);
    return days;
  }, {});

  // 24h load profile: average across July days
  const hvacLoadCurve = Array.from({ length: 24 }, (_, h) => {
    const vals = Object.values(julyDaily)
      .filter(d => d[h])
      .map(d => ({ heating: d[h].heatingKWh, cooling: d[h].coolingKWh, total: d[h].totalKWh }));
    const avg = vals.length > 0
      ? { heating: vals.reduce((s, v) => s + v.heating, 0) / vals.length,
          cooling: vals.reduce((s, v) => s + v.cooling, 0) / vals.length,
          total: vals.reduce((s, v) => s + v.total, 0) / vals.length }
      : { heating: 0, cooling: 0, total: 0 };
    return { hour: h, label: `${String(h).padStart(2,'0')}:00`,
             heatingKWh: Math.round(avg.heating * 100) / 100,
             coolingKWh: Math.round(avg.cooling * 100) / 100,
             totalKWh: Math.round(avg.total * 100) / 100 };
  });

  // ── Solar gain by orientation (approximated) ─────────────────────────────
  const solarGainByMonth = monthly.map((m, i) => ({
    month: i, label: m.label,
    solarKW: Math.round(solarMultPeak(i) * totalGlazingM2 * 0.38 * 100) / 100,
  }));

  return {
    hourly,       // 8760 entries
    monthly,      // 12 entries
    seasonal,    // 4 entries
    dashboard: {
      totalAnnualKWh: Math.round(totalAnnualKWh * 100) / 100,
      EUI: Math.round(EUI * 10) / 10,
      peakLoadHour: formatDateTime(peakHourEntry),
      peakLoadKW: Math.round(peakHourEntry.totalKWh * 100) / 100,
      peakHeatHour: formatDateTime(peakHeatHourEntry),
      peakHeatKW: Math.round(peakHeatHourEntry.heatingKWh * 100) / 100,
      peakCoolHour: formatDateTime(peakCoolHourEntry),
      peakCoolKW: Math.round(peakCoolHourEntry.coolingKWh * 100) / 100,
      worstMonth: worstMonth.label,
      worstMonthKWh: Math.round(worstMonth.totalKWh * 100) / 100,
      heatingMonths: heatingMonths.length,
      coolingMonths: coolingMonths.length,
      heatingSeason: monthNames[heatingMonths[0]?.month ?? 0] + ' – ' + monthNames[heatingMonths[heatingMonths.length-1]?.month ?? 2],
      coolingSeason: monthNames[coolingMonths[0]?.month ?? 4] + ' – ' + monthNames[coolingMonths[coolingMonths.length-1]?.month ?? 8],
    },
    hvacLoadCurve,
    solarGainByMonth,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildNYCTMY3() {
  // Typical dry-bulb temperatures for each month, each hour (°C)
  // Based on NYC TMY3 typical meteorological year
  return [
    // January: cold, low diurnal swing
    [-3,-4,-5,-5,-6,-6,-6,-5,-4,-3,-1,1,3,5,6,6,5,4,2,0,-1,-2,-3,-3],
    // February
    [-2,-3,-4,-4,-5,-5,-5,-4,-3,-1,1,3,5,6,7,7,6,4,2,1,-1,-2,-2,-2],
    // March: warming, bigger swing
    [2,1,0,-1,-1,-1,-1,0,2,5,8,11,13,15,16,16,15,13,10,7,5,3,2,2],
    // April
    [7,6,4,3,3,2,2,3,5,8,12,15,17,19,20,20,19,17,14,11,8,7,6,6],
    // May
    [12,11,9,8,7,7,7,8,10,13,17,20,22,24,25,25,24,22,19,15,12,11,10,10],
    // June: warm, humid
    [18,17,16,15,15,15,16,17,19,22,25,27,29,30,31,31,30,28,25,22,20,18,17,16],
    // July: hottest
    [22,21,20,19,19,19,20,21,23,26,29,31,33,34,34,34,33,31,28,25,22,21,20,20],
    // August
    [21,21,20,19,19,19,19,20,22,25,28,30,32,33,33,33,32,30,27,24,22,20,19,19],
    // September: cooling
    [17,16,15,14,14,13,13,14,16,19,22,25,27,28,28,28,27,25,22,19,16,14,13,12],
    // October
    [11,10,9,8,8,7,7,8,10,13,16,19,21,22,22,22,21,19,16,13,10,9,8,7],
    // November
    [6,5,4,3,3,3,3,3,5,8,11,14,16,17,17,17,16,14,11,8,6,5,4,4],
    // December: cold
    [0,-1,-2,-2,-3,-3,-4,-4,-3,-1,1,3,5,7,8,8,7,5,3,1,-1,-1,-1,-1],
  ];
}

function buildHVACSchedule() {
  // 24h occupancy factor (0=unoccupied, 1=fully occupied)
  return [
    0.05, // 00:00
    0.03, // 01:00
    0.02, // 02:00
    0.02, // 03:00
    0.02, // 04:00
    0.05, // 05:00
    0.15, // 06:00
    0.40, // 07:00
    0.80, // 08:00
    0.95, // 09:00
    1.00, // 10:00
    1.00, // 11:00
    0.95, // 12:00
    0.90, // 13:00
    0.85, // 14:00
    0.90, // 15:00
    0.95, // 16:00
    1.00, // 17:00
    0.85, // 18:00
    0.60, // 19:00
    0.40, // 20:00
    0.25, // 21:00
    0.15, // 22:00
    0.08, // 23:00
  ];
}

function solarMultPeak(month) {
  // Peak solar irradiance W/m² by month (horizontal surface, NYC)
  const peaks = [200,280,390,510,620,720,780,740,600,450,300,220];
  return peaks[month] / 1000; // return as kW/m² for use × area
}

function formatDateTime(entry) {
  if (!entry || entry.hourIndex === undefined) return 'N/A';
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h = entry.hour;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${monthNames[entry.month]} ${entry.day} ${h12}:00 ${ampm}`;
}

function getModelBounds(elements) {
  if (!elements || elements.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let hasData = false;
  for (const el of elements) {
    if (el.type !== 'wall') continue;
    const params = safeParse(el.parameters);
    const sx = parseFloat(params.startCoord?.x);
    const ex = parseFloat(params.endCoord?.x);
    if (isNaN(sx)) continue;
    hasData = true;
    const sy = parseFloat(params.startCoord?.y);
    const ey = parseFloat(params.endCoord?.y);
    minX = Math.min(minX, sx, ex); maxX = Math.max(maxX, sx, ex);
    minZ = Math.min(minZ, sy, ey); maxZ = Math.max(maxZ, sy, ey);
  }
  return hasData ? { minX, maxX, minZ, maxZ } : null;
}

function safeParse(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

module.exports = { generateYearData };