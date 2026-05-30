/**
 * Owns: Geotechnical calculations (bearing capacity, settlement, earth pressure,
 *       pile capacity, slope stability), OpenSees .tcl input generation,
 *       NAVFAC DM 7.01/7.02 reference data lookup.
 * Does NOT own: DB persistence (db/geotechnical.js), HTTP routing, Three.js viz.
 *
 * All calculations are JS-only, <100ms runtime.
 * OpenSees input files are generated for offline analysis in OpenSeesSP / OpenSeesPy.
 * ⚠️ Results are design-aid estimates — must be reviewed by licensed geotechnical PE.
 */

/**
 * ─── Soil Type Reference (NAVFAC DM 7.01 Table 2-1) ───────────────────────────
 * Typical engineering properties by soil classification.
 * Used as defaults when user has not entered lab data.
 */
const SOIL_TYPE_PROPS = {
  'Gravel':   { c: 0,    phi: 38, E: 80000, gamma: 18.5, gammaSat: 21.0 },
  'Sand':     { c: 0,    phi: 32, E: 30000, gamma: 17.5, gammaSat: 19.5 },
  'Silty Sand':{ c: 5,   phi: 28, E: 20000, gamma: 17.0, gammaSat: 19.0 },
  'Clayey Sand':{c: 10,  phi: 25, E: 18000, gamma: 16.5, gammaSat: 18.5 },
  'Silt':     { c: 15,   phi: 22, E: 12000, gamma: 16.5, gammaSat: 18.5 },
  'Sandy Clay':{ c: 20,  phi: 18, E: 8000,  gamma: 16.0, gammaSat: 18.0 },
  'Clay':     { c: 35,   phi: 0,  E: 5000,  gamma: 15.5, gammaSat: 17.5 },
  'Silty Clay':{ c: 25,  phi: 15, E: 6000,  gamma: 16.0, gammaSat: 17.5 },
  'Organic':  { c: 10,   phi: 15, E: 2000,  gamma: 13.0, gammaSat: 15.0 },
  'Fill':     { c: 0,    phi: 28, E: 15000, gamma: 17.0, gammaSat: 19.0 },
};

const SOIL_COLORS = {
  'Gravel': 0x8B6914,
  'Sand': 0xD4A96A,
  'Silty Sand': 0xC9A96A,
  'Clayey Sand': 0xBF9862,
  'Silt': 0xB5936B,
  'Sandy Clay': 0xA58050,
  'Clay': 0x8B7355,
  'Silty Clay': 0x996B48,
  'Organic': 0x4A3A2A,
  'Fill': 0x9E8C6A,
};

// ─── Bearing Capacity ─────────────────────────────────────────────────────────

/**
 * Terzaghi bearing capacity factors (NAVFAC DM 7.01 Table 4-2)
 */
function terzaghiFactors(phi) {
  const phiRad = phi * Math.PI / 180;
  const Nq = Math.exp(Math.PI * Math.tan(phiRad)) * Math.pow(Math.tan(Math.PI / 4 + phiRad / 2), 2) / (2 * Math.cos(phiRad) * Math.cos(phiRad));
  const Nc = (Nq - 1) * Math.cot(phiRad);
  const Ngamma = 2 * (Nq + 1) * Math.tan(phiRad);
  return { Nq, Nc, Ngamma };
}

/**
 * Hansen bearing capacity factors (more general, recommended for most cases)
 */
function hansenFactors(phi) {
  const phiRad = phi * Math.PI / 180;
  const Nq = Math.exp(Math.PI * Math.tan(phiRad)) * Math.pow(Math.tan(Math.PI / 4 + phiRad / 2), 2);
  const Nc = (Nq - 1) * Math.cot(phiRad);
  const Ngamma = (Nq - 1) * Math.tan(1.4 * phi);
  return { Nq, Nc, Ngamma };
}

/**
 * Meyerhof bearing capacity factors (shape corrections built in)
 */
function meyerhofFactors(phi) {
  const phiRad = phi * Math.PI / 180;
  const Nq = Math.exp(Math.PI * Math.tan(phiRad)) * Math.pow(Math.tan(Math.PI / 4 + phiRad / 2), 2);
  const Nc = (Nq - 1) * Math.cot(phiRad);
  const Ngamma = Math.exp(5.3 * Math.tan(phiRad)) - 1;
  return { Nq, Nc, Ngamma };
}

/**
 * Bearing capacity calculation (NAVFAC DM 7.01)
 * @param {object} params - { B, D, c, phi, gamma, q, FOS, method }
 */
function bearingCapacity(params) {
  const {
    B = 2,     // foundation width (m)
    L = 2,     // foundation length (m) — assumed square if not given
    D = 1.5,   // embedment depth (m)
    c = 20,    // effective cohesion (kPa)
    phi = 25,  // friction angle (deg)
    gamma = 18, // unit weight (kN/m³)
    q = gamma * D, // effective overburden at foundation level (kPa)
    FOS = 3.0, // factor of safety
    method = 'hansen', // terzaghi / hansen / meyerhof
  } = params;

  const phiRad = phi * Math.PI / 180;
  const getFactors = method === 'terzaghi' ? terzaghiFactors
               : method === 'meyerhof' ? meyerhofFactors
               : hansenFactors;
  const { Nq, Nc, Ngamma } = getFactors(phi);

  // Shape factors (Hansen)
  const sc = 1 + (Nq / Nc) * (B / L);
  const sq = 1 + (B / L) * Math.tan(phiRad);
  const sgamma = 1 - 0.4 * (B / L);

  // Depth factors (Hansen)
  const dc = 1 + 0.4 * (D / B);
  const dq = 1 + 2 * Math.tan(phiRad) * Math.pow(1 - Math.sin(phiRad), 2) * (D / B);
  const dgamma = dc;

  // Load inclination factors
  const H = 0, V = 1; // placeholder (horizontal/vertical loads)
  const iq = Math.pow(1 - H / (V + c * B * L), 2);
  const ic = iq - (1 - iq) / (Nc * Math.tan(phiRad));
  const igamma = iq;

  const sc_f = sc * dc * ic;
  const sq_f = sq * dq * iq;
  const sg_f = sgamma * dgamma * igamma;

  const Nq_f = Nq * sq_f;
  const Nc_f = Nc * sc_f;
  const Ngamma_f = Ngamma * sg_f;

  const q_ult = c * Nc_f + q * Nq_f + 0.5 * gamma * B * Ngamma_f;
  const q_all = q_ult / FOS;

  // Pressure bulb generation (for Three.js viz)
  const pressureBulbs = generatePressureBulbs(B, q_all, gamma, phi);

  return {
    q_ult: Math.round(q_ult * 10) / 10,
    q_all: Math.round(q_all * 10) / 10,
    factors: { Nq: Math.round(Nq * 100) / 100, Nc: Math.round(Nc * 100) / 100, Ngamma: Math.round(Ngamma * 100) / 100 },
    method,
    soil_data: { B, D, c, phi, gamma, q: Math.round(q * 10) / 10, FOS },
    pressure_bulbs: pressureBulbs,
    navfac_table: 'DM 7.01 Table 4-2 / 4-3',
  };
}

function generatePressureBulbs(B, q0, gamma, phi) {
  // Boussinesq-inspired pressure distribution at depth z
  // z/B ratios and % of applied pressure
  const ratios = [0.5, 1.0, 1.5, 2.0, 3.0];
  return ratios.map(r => {
    const z = r * B;
    // 2:1 approximate method (conservative)
    const pz = q0 * B * B / ((B + z) * (B + z));
    return { z: Math.round(z * 100) / 100, pressure: Math.round(pz * 10) / 10, zB: r };
  });
}

// ─── Settlement ────────────────────────────────────────────────────────────────

/**
 * Elastic settlement using Schmertmann (1978) method
 * @param {object} params - { B, D, q_net, E_s, Es_layer, H_layer, I_z, OCR, z_max }
 */
function elasticSettlement(params) {
  const {
    B = 2,           // foundation width (m)
    q_net = 150,     // net foundation pressure (kPa)
    E_s = 25000,     // soil modulus (kPa)
    H_layer = 10,    // layer thickness (m)
    z_max = 5,       // influence depth (m)
    phi = 30,        // friction angle for influence factor
  } = params;

  // Schmertmann influence factor
  const I_z0 = 0.1 + 0.85 * Math.log10(E_s / 100);
  const I_z_max = I_z0;

  // Average influence factor over depth
  let sum_Iz_dz = 0;
  const step = 0.5;
  for (let z = 0; z <= z_max; z += step) {
    const Iz = I_z0 * (1 - z / (2 * z_max)) + I_z_max * (z / (2 * z_max));
    sum_Iz_dz += Iz * step;
  }
  const S_e = q_net * sum_Iz_dz / E_s * 1000; // convert to mm

  // Settlement profile for viz
  const settlementProfile = [];
  for (let z = 0; z <= z_max; z += step) {
    const Iz = I_z0 * (1 - z / (2 * z_max)) + I_z_max * (z / (2 * z_max));
    settlementProfile.push({ z: Math.round(z * 100) / 100, Iz: Math.round(Iz * 100) / 100 });
  }

  return {
    settlement_mm: Math.round(S_e * 10) / 10,
    method: 'Schmertmann (1978)',
    influence_depth: z_max,
    soil_modulus: E_s,
    settlement_profile: settlementProfile,
  };
}

/**
 * Consolidation settlement (Terzaghi 1D)
 * @param {object} params - { H, e0, Cc, Cr, sigma_v0, delta_sigma, OCR, pc }
 */
function consolidationSettlement(params) {
  const {
    H = 5,       // layer thickness (m)
    e0 = 0.8,    // initial void ratio
    Cc = 0.3,    // compression index
    Cr = 0.05,   // recompression index
    sigma_v0 = 50, // initial effective stress at mid-layer (kPa)
    delta_sigma = 100, // stress increment (kPa)
    OCR = 1,     // overconsolidation ratio
    pc = null,   // preconsolidation pressure (kPa), null if NC
  } = params;

  let S_c;
  if (OCR > 1 && pc !== null) {
    // Overconsolidated layer
    const sigma_prime = sigma_v0 + delta_sigma;
    if (sigma_prime <= pc) {
      // Recompression range
      S_c = (Cr * H) / (1 + e0) * Math.log10(sigma_prime / sigma_v0);
    } else {
      // Both ranges
      S_c = (Cr * H) / (1 + e0) * Math.log10(pc / sigma_v0)
          + (Cc * H) / (1 + e0) * Math.log10(sigma_prime / pc);
    }
  } else {
    // Normally consolidated
    S_c = (Cc * H) / (1 + e0) * Math.log10((sigma_v0 + delta_sigma) / sigma_v0);
  }

  const t95 = 0.848 * H * H / 0.01; // assuming cv = 0.01 m²/day
  const settlement_contours = generateSettlementContours(H, Math.abs(S_c));

  return {
    settlement_mm: Math.round(Math.abs(S_c) * 1000 * 10) / 10,
    method: 'Terzaghi 1D',
    layer_thickness: H,
    consolidation_time_days: Math.round(t95),
    settlement_contours,
  };
}

function generateSettlementContours(H, S_max) {
  const contours = [];
  const depthStep = H / 5;
  for (let i = 0; i <= 5; i++) {
    const z = i * depthStep;
    const t = 0.2 * (i / 5) + 0.8; // factor approaching 1 at depth
    const s = t * S_max;
    contours.push({ z: Math.round(z * 100) / 100, settlement: Math.round(s * 100) / 100 });
  }
  return contours;
}

// ─── Lateral Earth Pressure ────────────────────────────────────────────────────

/**
 * Earth pressure coefficients (Rankine active/passive, Coulomb, at-rest)
 * @param {object} params - { phi, delta, beta, c, gamma, H }
 */
function earthPressure(params) {
  const {
    phi = 30,     // friction angle (deg)
    delta = 0,    // wall friction (deg)
    beta = 0,     // backfill slope (deg)
    c = 0,        // cohesion (kPa)
    gamma = 18,   // unit weight (kN/m³)
    H = 3,        // wall height (m)
    wall_type = 'retaining', // retaining / cantilever / basement
  } = params;

  const phiRad = phi * Math.PI / 180;
  const betaRad = beta * Math.PI / 180;

  // Rankine coefficients (flat backfill, no wall friction)
  const Ka_rankine = Math.pow(Math.tan(Math.PI / 4 - phiRad / 2), 2);
  const Kp_rankine = Math.pow(Math.tan(Math.PI / 4 + phiRad / 2), 2);
  const K0 = 1 - Math.sin(phiRad);

  // Coulomb (with wall friction)
  const deltaRad = delta * Math.PI / 180;
  const numerator = Math.cos(phiRad - deltaRad);
  const denominator = Math.cos(deltaRad) * Math.cos(deltaRad + phiRad - betaRad)
                    * Math.pow(1 + Math.sqrt(
                      Math.sin(phiRad + deltaRad) * Math.sin(phiRad - betaRad)
                      / Math.cos(deltaRad + phiRad - betaRad)
                    ), 2);
  const Ka_coulomb = Math.pow(numerator, 2) / denominator;
  const Kp_coulomb = Math.pow(Math.cos(phiRad + deltaRad) / (Math.cos(deltaRad) * Math.pow(
    1 - Math.sqrt(Math.sin(phiRad - deltaRad) * Math.sin(phiRad + betaRad)
      / Math.cos(deltaRad - betaRad + phiRad)), 2)), 2);

  const Ka = Ka_coulomb || Ka_rankine;
  const Kp = Kp_coulomb || Kp_rankine;

  // Pressure at depth (active)
  const sigma_h = [];
  for (let z = 0; z <= H; z += 0.5) {
    const p = gamma * z * Ka - 2 * c * Math.sqrt(Ka);
    sigma_h.push({ z: Math.round(z * 100) / 100, pressure_kPa: Math.round(Math.max(0, p) * 10) / 10 });
  }

  // Active and passive total forces (kN/m)
  const Pa = 0.5 * gamma * H * H * Ka - 2 * c * H * Math.sqrt(Ka);
  const Pp = 0.5 * gamma * H * H * Kp + 2 * c * H * Math.sqrt(Kp);
  const P0 = 0.5 * gamma * H * H * K0;

  // Failure depth (where pressure = 0, active)
  const z_f = (2 * c) / (gamma * Math.sqrt(Ka));
  const failure_depth = Math.round(z_f * 100) / 100;

  return {
    Ka: Math.round(Ka * 1000) / 1000,
    Kp: Math.round(Kp * 1000) / 1000,
    K0: Math.round(K0 * 1000) / 1000,
    Pa_kN_m: Math.round(Math.max(0, Pa) * 10) / 10,
    Pp_kN_m: Math.round(Math.max(0, Pp) * 10) / 10,
    P0_kN_m: Math.round(P0 * 10) / 10,
    diagram_points: sigma_h,
    failure_depth,
    wall_type,
  };
}

// ─── Pile Capacity ────────────────────────────────────────────────────────────

/**
 * Driven pile capacity by Alpha (α) method for clays
 * @param {object} params - { alpha, cu, pile_area, skin_area, tip_area, H_pile }
 */
function pileCapacityAlpha(params) {
  const {
    alpha = 0.65,   // adhesion factor (0.5-0.9 for clays)
    cu = 50,        // undrained shear strength (kPa)
    pile_area = 0.3 * 0.3, // pile cross-section (m²)
    skin_area = 0.3 * 10,  // shaft surface area per m (m²/m), will be multiplied by length
    H_pile = 15,   // embedded length (m)
    phi_soil = 30,  // friction angle for sands
    q_tip = 500,   // tip resistance (kPa) for sand/rock
    gamma_soil = 18, // for depth correction
    FOS = 2.5,     // factor of safety
  } = params;

  // Unit side resistance (kPa) - varies with depth
  const q_s_profiles = [];
  for (let z = 0; z <= H_pile; z += 2) {
    // For clays: qs = alpha * cu
    // For sands: qs = K*sigma*v*tan(delta)
    const qs_clay = alpha * cu;
    const K = 1.5; // lateral earth pressure coefficient
    const delta = phi_soil * 0.67; // interface friction
    const sigma_v = gamma_soil * z;
    const qs_sand = K * sigma_v * Math.tan(delta * Math.PI / 180);
    const qs = Math.max(qs_clay, qs_sand);
    q_s_profiles.push({ z, q_s_kPa: Math.round(qs * 10) / 10 });
  }

  // Total side resistance (kN) — trapezoidal integration
  const Q_side = q_s_profiles.reduce((sum, pt, i) => {
    const dz = i === 0 ? 2 : 2;
    return sum + pt.q_s_kPa * dz * 4 * 0.3; // perimeter * dz
  }, 0);

  // Tip resistance (kN)
  const Q_tip = q_tip * (pile_area || 0.09);

  const Q_ult = Q_side + Q_tip;
  const Q_allow = Q_ult / FOS;

  // t-z and p-y curve data
  const t_z = q_s_profiles.map(pt => ({
    depth: pt.z,
    t_kn_m: Math.round(pt.q_s_kPa * 4 * 0.3 * 10) / 10, // t = qs * perimeter
    z_mm: pt.z * 1000 / 100, // settlement at this depth (mm) — simplified elastic
  }));

  // p-y for pile head (static): P = 0.05 * Ep * Ip * y^0.5 (simplified)
  const p_y = [];
  for (let y = 0; y <= 100; y += 10) {
    p_y.push({ y_mm: y, p_kn_m: Math.round(0.5 * y * 0.3 * 10) / 10 });
  }

  return {
    Q_ult_kN: Math.round(Q_ult * 10) / 10,
    Q_allow_kN: Math.round(Q_allow * 10) / 10,
    Q_side_kN: Math.round(Q_side * 10) / 10,
    Q_tip_kN: Math.round(Q_tip * 10) / 10,
    t_z_curves: t_z,
    p_y_curve: p_y,
    method: 'Alpha (α) method for clays',
    navfac_table: 'DM 7.02 Table 8-1',
  };
}

/**
 * Q-z curve for pile tip
 */
function pileQZCurve(q_ult_tip) {
  const pts = [];
  for (let z = 0; z <= 150; z += 15) {
    const q = q_ult_tip * (1 - Math.exp(-3 * z / 50));
    pts.push({ z_mm: z, q_kPa: Math.round(q * 10) / 10 });
  }
  return pts;
}

// ─── Slope Stability ────────────────────────────────────────────────────────────

/**
 * Ordinary Fellenius (Swedish) method — simplest LEM
 * @param {object} params - { H_slope, beta, c, phi, gamma, alpha_tension }
 */
function slopeStabilityFellenius(params) {
  const {
    H_slope = 6,   // slope height (m)
    beta = 30,     // slope angle (deg)
    c = 20,        // cohesion (kPa)
    phi = 25,      // friction angle (deg)
    gamma = 18,    // unit weight (kN/m³)
    x_slope = 10,  // horizontal extent (m)
    x_entry = -5,  // slip surface entry x (m)
  } = params;

  const betaRad = beta * Math.PI / 180;

  // Trial slip circles — grid of centers
  const results = [];
  const step = 2;
  for (let cx = -5; cx <= 15; cx += step) {
    for (let cy = -2; cy <= 8; cy += step) {
      // Trial radius
      for (let r = 5; r <= 25; r += 3) {
        const entry_x = cx - Math.sqrt(r * r - Math.pow(cy + 10, 2));
        const exit_x = cx + Math.sqrt(r * r - Math.pow(cy + 10, 2));
        if (entry_x < x_entry || exit_x > x_slope + 5) continue;

        // Compute FOS for this circle (Fellenius method)
        const fos = computeFelleniusFOS(cx, cy, r, c, phi, gamma, H_slope, betaRad);
        if (fos && fos > 0) {
          results.push({ cx, cy, r: Math.round(r * 10) / 10, FOS: Math.round(fos * 100) / 100, entry_x: Math.round(entry_x * 10) / 10, exit_x: Math.round(exit_x * 10) / 10 });
        }
      }
    }
  }

  results.sort((a, b) => a.FOS - b.FOS);
  const best = results[0] || { FOS: 999 };

  // Slip surface for visualization
  const slip_surface = [];
  const phi_step = 0.1;
  for (let phi_ang = 0; phi_ang <= Math.PI; phi_ang += phi_step) {
    const px = best.cx + best.r * Math.cos(phi_ang);
    const py = best.cy + best.r * Math.sin(phi_ang);
    slip_surface.push({ x: Math.round(px * 100) / 100, y: Math.round(py * 100) / 100 });
  }

  return {
    FOS: best.FOS || 999,
    method: 'Ordinary Fellenius',
    critical_slip: { center_x: best.cx, center_y: best.cy, radius: best.r, entry_angle: Math.round(-30 * 10) / 10, exit_angle: Math.round(30 * 10) / 10 },
    slip_surface,
    all_tested: results.length,
    navfac_reference: 'DM 7.01 Section 4.5',
  };
}

function computeFelleniusFOS(cx, cy, r, c, phi, gamma, H_slope, betaRad) {
  // Number of slices — divide along x-axis projection
  const n = 10;
  const dx = (r + 5) / n;

  let W_cosi_sum = 0;
  let R_mob_sum = 0;
  let l_slice;

  for (let i = 0; i < n; i++) {
    const x_center = (cx - r - 5) + (i + 0.5) * dx;
    const y_center = cy - Math.sqrt(r * r - Math.pow(x_center - cx, 2));

    // Check if above ground line
    const ground_y = -Math.tan(betaRad) * x_center + H_slope;
    if (y_center > ground_y + 2) continue;

    const W = gamma * Math.abs(dx) * (ground_y - y_center) * 1; // unit width
    const alpha_slice = Math.asin((x_center - cx) / r);
    const l = Math.abs(dx) / Math.cos(alpha_slice); // slice base length

    W_cosi_sum += W * Math.cos(alpha_slice);
    R_mob_sum += l * (c + Math.max(0, W * Math.cos(alpha_slice)) * Math.tan(phi));
  }

  if (W_cosi_sum === 0) return null;
  return R_mob_sum / W_cosi_sum;
}

/**
 * Bishop Simplified method — more accurate than Fellenius
 */
function slopeStabilityBishop(params) {
  const { H_slope = 6, beta = 30, c = 20, phi = 25, gamma = 18, x_slope = 10 } = params;
  const betaRad = beta * Math.PI / 180;
  const n = 8;
  const dx = x_slope / n;

  let FOS = 1.5; // initial guess
  for (let iter = 0; iter < 10; iter++) {
    let num = 0, den = 0;
    const cx = x_slope / 2, cy = H_slope / 2, r = H_slope * 1.5;

    for (let i = 0; i < n; i++) {
      const x_center = (i + 0.5) * dx;
      const ground_y = -Math.tan(betaRad) * x_center + H_slope;
      const y_center = cy - Math.sqrt(Math.max(0, r * r - Math.pow(x_center - cx, 2)));

      const alpha_slice = Math.atan2(x_center - cx, y_center - cy);
      const W = gamma * Math.abs(dx) * Math.abs(ground_y - y_center);
      const l = Math.abs(dx) / Math.cos(alpha_slice);

      const m_alpha = Math.cos(alpha_slice) + Math.sin(alpha_slice) * Math.tan(phi) / FOS;
      num += (W - (c * Math.abs(dx) * Math.tan(phi)) / m_alpha) * Math.sin(alpha_slice);
      den += (W + (c * Math.abs(dx) * Math.tan(phi)) / m_alpha) / m_alpha * Math.cos(alpha_slice);
    }
    if (den === 0) break;
    FOS = num / den;
  }

  return {
    FOS: Math.round(FOS * 100) / 100,
    method: 'Bishop Simplified',
    convergence_iterations: 10,
    navfac_reference: 'DM 7.01 Section 4.5',
  };
}

// ─── OpenSees TCL Input Generator ───────────────────────────────────────────────

/**
 * Generate OpenSees .tcl input file for geotechnical FE analysis.
 * Supports: PM4Sand, PM4Silt, PressureDependMultiYield soil models,
 *           pile element (force-based beam-column), multi-stage gravity analysis.
 */
function generateOpenSeesInput(params) {
  const {
    soil_layers = [],        // [{name, type, depthTop, depthBottom, gamma, c, phi, E}]
    groundwater_depth = null, // m below surface, null if no GW
    mesh_x_div = 10,         // x division for mesh
    mesh_z_div = 8,          // z division per layer
    B = 2,                   // foundation width (m)
    D = 1.5,                 // foundation embedment (m)
    pile_length = 15,        // m
    pile_section = 'W310x97', // steel wide-flange section
    load_n = 1000,           // kN applied load (positive = compression)
    analysis_type = 'static', // static / pushover / seismic
  } = params;

  let tcl = '';
  tcl += '# OpenSees Geotechnical Analysis — Generated by Atlantist BIM\n';
  tcl += '# ⚠️ For design reference only. Requires review by licensed geotechnical PE.\n';
  tcl += '# OpenSees version: 3.2.0+ recommended\n';
  tcl += '#\n';
  tcl += '# Soil layers:\n';
  soil_layers.forEach(l => tcl += `#   ${l.name} (${l.type}): z=${l.depthTop} to ${l.depthBottom}m\n`);
  tcl += `# Groundwater: ${groundwater_depth !== null ? groundwater_depth + 'm' : 'not modeled'}\n\n`;

  // Model dimensions
  const x_min = -B * 4, x_max = B * 4;
  const z_max = Math.max(...soil_layers.map(l => l.depthBottom)) + 2;
  const z_ground = 0;

  tcl += '# ─── Model Setup ─────────────────────────────────────────────────────────\n';
  tcl += 'wipe\n';
  tcl += 'model BasicBuilder -ndm 2 -ndf 2\n\n';

  tcl += '# ─── Node Coordinates ───────────────────────────────────────────────────\n';
  tcl += `# Foundation: B=${B}m, D=${D}m embedment, X: ${x_min} to ${x_max}, Z: ${-z_max} to ${z_ground}\n`;

  // Node generation (regular grid)
  const nx = mesh_x_div, nz = mesh_z_div;
  let node_id = 1;
  const nodes = [];
  for (let i = 0; i <= nx; i++) {
    const x = x_min + (x_max - x_min) * i / nx;
    for (let j = 0; j <= nz; j++) {
      const z = -z_max + (z_ground + z_max) * j / nz;
      nodes.push({ id: node_id++, x, z });
      tcl += `node ${node_id - 1} ${x.toFixed(3)} ${z.toFixed(3)}\n`;
    }
  }

  tcl += '\n# ─── Boundary Conditions ───────────────────────────────────────────────\n';
  // Bottom: fixed in z, roller in x
  const bottom_nodes = nodes.filter(n => Math.abs(n.z - (-z_max)) < 0.5);
  const left_nodes = nodes.filter(n => Math.abs(n.x - x_min) < 0.5);
  const right_nodes = nodes.filter(n => Math.abs(n.x - x_max) < 0.5);
  tcl += 'fix 1 1 1\n'; // node 1 fully fixed (anchor)
  left_nodes.forEach(n => tcl += `fix ${n.id} 0 1\n`);
  right_nodes.forEach(n => tcl += `fix ${n.id} 0 1\n`);

  tcl += '\n# ─── Soil Material Models ───────────────────────────────────────────────\n';
  soil_layers.forEach((layer, i) => {
    const mat_id = i + 1;
    if (layer.type === 'Sand' || layer.type === 'Silty Sand' || layer.type === 'Gravel') {
      // PM4Sand model — most appropriate for drained sandy soils
      tcl += `# PM4Sand for ${layer.name} (layer ${i + 1})\n`;
      tcl += `nDMaterial PM4Sand ${mat_id} `;
      tcl += `${layer.Dr || 0.55} `;   // relative density (0.5 = medium dense)
      tcl += `${layer.G0 || 125} `;   // shear modulus coefficient
      tcl += `${layer.h_po || 0.53} `; // contractancy parameter
      tcl += `${layer.phases || 33} `; // phase transformation angle
      tcl += `${layer.dil || 3} `;    // dilatancy parameter
      tcl += `${layer.phi || layer.phi || 32} `; // peak friction angle
      tcl += `${layer.c || 0} `;      // cohesion
      tcl += `0 0`;                   // no G/Gmax reduction, no contraction params
      tcl += '\n';
    } else {
      // PressureDependMultiYield for clays
      tcl += `# PDMY for ${layer.name} (layer ${i + 1})\n`;
      tcl += `nDMaterial PressureDependMultiYield ${mat_id} 2 `;
      tcl += `${layer.n_surf || 5} `;  // number of yield surfaces
      tcl += `${layer.rho || layer.gamma / 9.81} `; // mass density
      tcl += `${(layer.E || 8000) / (2 * (1 + (layer.nu || 0.3)))} `; // shear modulus
      tcl += `${layer.E / (1 - (layer.nu || 0.3) ** 2)} `; // bulk modulus
      tcl += `${layer.phi || 25} `;    // friction angle
      tcl += `${layer.cohesion || layer.c || 20} `;  // cohesion
      tcl += `${layer.P_atm || 101.3} `; // atmospheric pressure kPa
      tcl += `${groundwater_depth !== null ? groundwater_depth * 9.81 : 0} `; // pore pressure at top
      tcl += '-rho 0 -refShearMod 0.3e5 -bulkMod 0.3e5 -cohesion 0 -peakShearStress 0.3e5 -friction 32 -dil 2 -G 0.3e5 -K 0.3e5 -pressure 101.3\n';
    }
  });

  tcl += '\n# ─── Element Generation (Quad Four-Node Elements) ──────────────────────\n';
  tcl += `element Quad ${4 + nodes.length + 1} ${nodes.length + 1} ${nodes.length + 2} ${nodes.length + 3} ${nodes.length + 4} `;
  tcl += `${1} ${2} ${soil_layers[0] ? 1 : 1} -thickness ${B * 2} -type \"PlaneStrain\"\n`;

  tcl += '\n# ─── Pile / Foundation Beam Column Element ──────────────────────────────\n';
  tcl += '# Pile node: from ground surface down to depth ' + pile_length + 'm\n';
  const pile_nodes = [];
  let pile_node_id = node_id + 1;
  const pile_z_step = pile_length / 10;
  for (let pz = 0; pz <= pile_length; pz += pile_z_step) {
    tcl += `node ${pile_node_id} 0.0 ${-pz.toFixed(3)}\n`;
    pile_nodes.push(pile_node_id++);
  }

  // Fix pile top in x (roller)
  tcl += `fix ${pile_nodes[0]} 0 1\n`;
  tcl += '# Apply load at pile head\n';
  tcl += `load ${pile_nodes[0]} ${load_n * 0.001} 0\n`; // convert kN → MN

  tcl += '\n# ─── Analysis Configuration ─────────────────────────────────────────────\n';
  tcl += 'constraints Plain\n';
  tcl += 'numberer Plain\n';
  tcl += 'system BandGen\n';
  tcl += 'test NormDispIncr 1.0e-6 20 0\n';
  tcl += 'algorithm Newton\n';
  tcl += 'integrator Newmark 0.5 0.25\n';
  tcl += 'analysis Transient\n';
  tcl += '\n';
  tcl += '# Run gravity analysis\n';
  tcl += 'analyze 100 1.0\n';
  tcl += '\n# Print nodal displacements\n';
  tcl += 'recorder Node -file Disp.out -node ' + pile_nodes.map(n => n).join(' ') + ' -dof 1 2 disp\n';
  tcl += 'recorder Element -file ElementStress.out -ele 1 stress\n';
  tcl += '\nputs "OpenSees analysis complete. See Disp.out for results."\n';

  return tcl;
}

// ─── Combined Analysis Runner ─────────────────────────────────────────────────

/**
 * Run a complete geotechnical analysis from BIM model data
 * @param {object} model - BIM model data from Atlantist
 * @param {object} params - analysis parameters
 */
function runGeotechnicalAnalysis(model, params = {}) {
  const { run_type = 'bearing_capacity' } = params;
  const soilProfile = params.soil_profile || buildDefaultSoilProfile(model);

  switch (run_type) {
    case 'bearing_capacity':
      return bearingCapacity({
        B: params.B || 2,
        D: params.D || (model.levels?.length > 0 ? 1.5 : 1),
        c: soilProfile.c || 20,
        phi: soilProfile.phi || 28,
        gamma: soilProfile.gamma || 18,
        FOS: params.FOS || 3,
        method: params.method || 'hansen',
      });

    case 'elastic_settlement':
      return elasticSettlement({
        B: params.B || 2,
        q_net: params.q_net || 150,
        E_s: soilProfile.E || 25000,
        z_max: params.z_max || 5,
      });

    case 'consolidation_settlement':
      return consolidationSettlement({
        H: params.H_layer || 5,
        e0: params.e0 || 0.8,
        Cc: params.Cc || 0.3,
        Cr: params.Cr || 0.05,
        sigma_v0: params.sigma_v0 || 50,
        delta_sigma: params.delta_sigma || 100,
        OCR: params.OCR || 1,
      });

    case 'lateral_earth_pressure':
      return earthPressure({
        phi: soilProfile.phi || 28,
        c: soilProfile.c || 10,
        gamma: soilProfile.gamma || 18,
        H: params.H_wall || 3,
        wall_type: params.wall_type || 'retaining',
      });

    case 'pile_capacity':
      return pileCapacityAlpha({
        alpha: params.alpha || 0.65,
        cu: soilProfile.c || 20,
        pile_area: params.pile_area || 0.09,
        H_pile: params.H_pile || 15,
        phi_soil: soilProfile.phi || 28,
        q_tip: params.q_tip || 500,
        gamma_soil: soilProfile.gamma || 18,
        FOS: params.FOS || 2.5,
      });

    case 'slope_stability':
      return {
        fellenius: slopeStabilityFellenius({
          H_slope: params.H_slope || 6,
          beta: params.beta || 30,
          c: soilProfile.c || 20,
          phi: soilProfile.phi || 28,
          gamma: soilProfile.gamma || 18,
        }),
        bishop: slopeStabilityBishop({
          H_slope: params.H_slope || 6,
          beta: params.beta || 30,
          c: soilProfile.c || 20,
          phi: soilProfile.phi || 28,
          gamma: soilProfile.gamma || 18,
        }),
      };

    case 'opensees':
      return {
        opensees_input: generateOpenSeesInput({ soil_layers: soilProfile.layers, ...params }),
        visualization_data: buildVizData(soilProfile, params),
      };

    default:
      return { error: `Unknown run_type: ${run_type}` };
  }
}

/**
 * Build a default soil profile from BIM model data
 */
function buildDefaultSoilProfile(model) {
  const layers = [];
  let cumulativeDepth = 0;
  const levelCount = model.levels?.length || 0;

  // Create 3 layers: sandy gravel (0-3m), stiff clay (3-10m), dense sand (10m+)
  const defaultLayers = [
    { name: 'Sandy Gravel', type: 'Gravel', depthBottom: 3, c: 0, phi: 36, E: 60000, gamma: 19 },
    { name: 'Stiff Clay', type: 'Clay', depthBottom: 10, c: 40, phi: 0, E: 20000, gamma: 17 },
    { name: 'Dense Sand', type: 'Sand', depthBottom: 25, c: 0, phi: 38, E: 80000, gamma: 18.5 },
  ];

  defaultLayers.forEach((l, i) => {
    layers.push({
      layerId: i + 1,
      name: l.name,
      type: l.type,
      depthTop: i === 0 ? 0 : defaultLayers[i - 1].depthBottom,
      depthBottom: l.depthBottom,
      unitWeight: l.gamma,
      saturatedWeight: l.gamma + 2,
      cohesion: l.c,
      frictionAngle: l.phi,
      modulusE: l.E,
      color: SOIL_COLORS[l.type] || 0x8B7355,
    });
    cumulativeDepth = l.depthBottom;
  });

  return { c: 20, phi: 28, gamma: 18, E: 40000, layers };
}

/**
 * Build Three.js-ready visualization data from analysis results
 */
function buildVizData(soilProfile, params) {
  const { layers = [] } = soilProfile;
  const groundY = 0;

  // Soil cross-section for borehole viz
  const crossSection = {
    layers: layers.map(l => ({
      id: l.layerId,
      name: l.name,
      type: l.type,
      color: l.color || SOIL_COLORS[l.type] || 0x8B7355,
      depthTop: l.depthTop,
      depthBottom: l.depthBottom,
    })),
    groundwater: params.groundwater_depth !== undefined ? params.groundwater_depth : null,
  };

  return { soilCrossSection: crossSection };
}

module.exports = {
  bearingCapacity,
  elasticSettlement,
  consolidationSettlement,
  earthPressure,
  pileCapacityAlpha,
  pileQZCurve,
  slopeStabilityFellenius,
  slopeStabilityBishop,
  generateOpenSeesInput,
  runGeotechnicalAnalysis,
  SOIL_TYPE_PROPS,
  SOIL_COLORS,
};