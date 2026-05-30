/**
 * Owns: Structural engineering calculations — ASCE 7-22 load generation,
 *       AISC 360-22 steel member checks, ACI 318-19 concrete checks,
 *       NDS 2024 wood member checks, ASCE 7-22 seismic/wind loads,
 *       linear static frame analysis (direct stiffness method),
 *       modal analysis (eigenvalue), load combinations,
 *       OpenSees .tcl input file generation for advanced nonlinear analysis.
 * Does NOT own: DB persistence (db/structural.js), HTTP routing, Three.js viz.
 *
 * ⚠️ All results are for preliminary design reference only.
 * Does not guarantee code compliance or regulatory approval.
 * Must be reviewed by a licensed Professional Engineer (PE/SE).
 */

const DISCLAIMER = '⚠️ Results are for preliminary design reference only. Software does not guarantee code compliance or regulatory approval. All designs must be reviewed and sealed by a licensed Professional Engineer.';

// ─── AISC Steel Section Database (common W-shapes) ─────────────────────────
const AISC_SHAPES = {
  'W14x22':  { d:13.74, bf:5.0, tf:0.335, tw:0.23, A:6.49, Ix:199, Iy:7.0, Sx:29.0, Zx:33.2, rx:5.54, ry:1.04, J:0.208, Cw:404, weight:22 },
  'W14x30':  { d:13.84, bf:6.73, tf:0.385, tw:0.27, A:8.85, Ix:291, Iy:19.6, Sx:42.0, Zx:47.3, rx:5.73, ry:1.49, J:0.38, Cw:887, weight:30 },
  'W14x48':  { d:13.79, bf:8.031, tf:0.595, tw:0.34, A:14.1, Ix:485, Iy:51.4, Sx:70.3, Zx:78.4, rx:5.85, ry:1.91, J:1.45, Cw:2240, weight:48 },
  'W14x68':  { d:14.04, bf:10.035, tf:0.72, tw:0.415, A:20.0, Ix:723, Iy:121, Sx:103, Zx:115, rx:6.01, ry:2.46, J:3.01, Cw:5380, weight:68 },
  'W14x99':  { d:14.16, bf:14.565, tf:0.78, tw:0.485, A:29.1, Ix:1110, Iy:402, Sx:157, Zx:173, rx:6.17, ry:3.71, J:5.37, Cw:15300, weight:99 },
  'W12x26':  { d:12.22, bf:6.49, tf:0.38, tw:0.23, A:7.65, Ix:204, Iy:17.3, Sx:33.4, Zx:37.2, rx:5.17, ry:1.51, J:0.3, Cw:607, weight:26 },
  'W12x40':  { d:11.94, bf:8.005, tf:0.515, tw:0.295, A:11.7, Ix:310, Iy:44.1, Sx:51.9, Zx:57.5, rx:5.13, ry:1.94, J:0.906, Cw:1440, weight:40 },
  'W12x58':  { d:12.19, bf:10.014, tf:0.641, tw:0.36, A:17.0, Ix:475, Iy:107, Sx:78.0, Zx:86.4, rx:5.28, ry:2.51, J:2.1, Cw:3570, weight:58 },
  'W10x22':  { d:10.17, bf:5.75, tf:0.36, tw:0.24, A:6.49, Ix:118, Iy:11.4, Sx:23.2, Zx:26.0, rx:4.27, ry:1.33, J:0.239, Cw:250, weight:22 },
  'W10x33':  { d:9.73, bf:7.964, tf:0.435, tw:0.29, A:9.71, Ix:171, Iy:36.6, Sx:35.0, Zx:38.8, rx:4.19, ry:1.94, J:0.583, Cw:730, weight:33 },
  'W10x49':  { d:9.98, bf:10.0, tf:0.558, tw:0.34, A:14.4, Ix:272, Iy:93.4, Sx:54.6, Zx:60.4, rx:4.35, ry:2.54, J:1.39, Cw:2070, weight:49 },
  'W8x24':   { d:7.93, bf:6.495, tf:0.4, tw:0.245, A:7.08, Ix:82.7, Iy:18.3, Sx:20.9, Zx:23.1, rx:3.42, ry:1.61, J:0.346, Cw:262, weight:24 },
  'W8x31':   { d:8.0, bf:7.995, tf:0.435, tw:0.285, A:9.13, Ix:110, Iy:37.1, Sx:27.5, Zx:30.4, rx:3.47, ry:2.02, J:0.536, Cw:530, weight:31 },
  'W6x15':   { d:5.99, bf:5.99, tf:0.26, tw:0.23, A:4.43, Ix:29.1, Iy:9.32, Sx:9.72, Zx:10.8, rx:2.56, ry:1.46, J:0.103, Cw:59.8, weight:15 },
  'HSS6x6x3/8':  { d:6, bf:6, tf:0.349, tw:0.349, A:7.58, Ix:48.3, Iy:48.3, Sx:16.1, Zx:19.0, rx:2.52, ry:2.52, J:77.8, weight:21.63 },
  'HSS8x8x1/2':  { d:8, bf:8, tf:0.465, tw:0.465, A:13.5, Ix:131, Iy:131, Sx:32.8, Zx:39.1, rx:3.11, ry:3.11, J:214, weight:37.69 },
};

// ─── Concrete defaults ────────────────────────────────────────────────────────
const CONCRETE_GRADES = {
  'C3000': { fc: 3000, Ec: 3122019 },  // psi, Ec = 57000*sqrt(fc)
  'C4000': { fc: 4000, Ec: 3604997 },
  'C5000': { fc: 5000, Ec: 4030509 },
  'C6000': { fc: 6000, Ec: 4415201 },
  'C8000': { fc: 8000, Ec: 5098587 },
};

// ─── Wood Section Properties (NDS Reference Design Values) ───────────────────
const WOOD_SECTIONS = {
  '2x4':   { b:1.5, d:3.5, A:5.25, Sx:3.063, Ix:5.359, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '2x6':   { b:1.5, d:5.5, A:8.25, Sx:7.563, Ix:20.80, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '2x8':   { b:1.5, d:7.25, A:10.875, Sx:13.14, Ix:47.63, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '2x10':  { b:1.5, d:9.25, A:13.875, Sx:21.39, Ix:98.93, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '2x12':  { b:1.5, d:11.25, A:16.875, Sx:31.64, Ix:178.0, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '4x4':   { b:3.5, d:3.5, A:12.25, Sx:7.146, Ix:12.51, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '6x6':   { b:5.5, d:5.5, A:30.25, Sx:27.73, Ix:76.26, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '8x8':   { b:7.5, d:7.5, A:56.25, Sx:70.31, Ix:263.7, Fb:1000, Ft:625, Fc:1500, Fv:180, E:1700000, Emin:620000, species:'Douglas Fir-Larch #2' },
  '3.125x9_GLU': { b:3.125, d:9, A:28.125, Sx:42.19, Ix:189.8, Fb:2400, Ft:1450, Fc:1650, Fv:265, E:1800000, Emin:950000, species:'24F-V4 SP/SP Glulam' },
  '5.125x12_GLU':{ b:5.125, d:12, A:61.5, Sx:123.0, Ix:738.0, Fb:2400, Ft:1450, Fc:1650, Fv:265, E:1800000, Emin:950000, species:'24F-V4 SP/SP Glulam' },
};

// ─── ASCE 7-22 Load Generation ──────────────────────────────────────────────

/**
 * ASCE 7-22 seismic base shear (Equivalent Lateral Force, §12.8)
 * @param {object} p - { Ss, S1, site_class, R, Ie, W, T_approx, TL }
 */
function seismicBaseShear(p) {
  const { Ss = 1.0, S1 = 0.4, site_class = 'D', R = 8, Ie = 1.0, W = 1000, TL = 8 } = p;

  // Site coefficients (ASCE 7-22 Table 11.4-1 / 11.4-2 simplified)
  const Fa = siteCoeffFa(Ss, site_class);
  const Fv = siteCoeffFv(S1, site_class);

  const SMS = Fa * Ss;
  const SM1 = Fv * S1;
  const SDS = (2/3) * SMS;
  const SD1 = (2/3) * SM1;

  // Approximate period (ASCE 7-22 §12.8.2.1)
  // Steel MRF: Ct=0.028, x=0.8; Concrete MRF: Ct=0.016, x=0.9; Other: Ct=0.02, x=0.75
  const Ct = p.Ct || 0.02;
  const x_exp = p.x_exp || 0.75;
  const hn = p.hn || 40; // building height in feet
  const T = p.T_approx || Ct * Math.pow(hn, x_exp);

  // Cs (§12.8.1.1)
  let Cs = SDS / (R / Ie);
  const Cs_max = T <= TL ? SD1 / (T * (R / Ie)) : SD1 * TL / (T * T * (R / Ie));
  Cs = Math.min(Cs, Cs_max);
  const Cs_min = Math.max(0.044 * SDS * Ie, 0.01);
  if (S1 >= 0.6) {
    const Cs_min2 = 0.5 * S1 / (R / Ie);
    Cs = Math.max(Cs, Cs_min2);
  }
  Cs = Math.max(Cs, Cs_min);

  const V = Cs * W; // base shear (kips)

  // Seismic Design Category (SDC)
  const SDC = determineSDC(SDS, SD1);

  return {
    Ss, S1, site_class, Fa, Fv, SMS, SM1, SDS, SD1,
    T: Math.round(T * 1000) / 1000,
    Cs: Math.round(Cs * 10000) / 10000,
    V: Math.round(V * 100) / 100,
    W, R, Ie, SDC,
    code_ref: 'ASCE 7-22 §12.8',
  };
}

function siteCoeffFa(Ss, sc) {
  // Simplified ASCE 7-22 Table 11.4-1
  const table = { A:{0.25:0.8,0.5:0.8,0.75:0.8,1.0:0.8,1.25:0.8}, B:{0.25:0.9,0.5:0.9,0.75:0.9,1.0:0.9,1.25:0.9}, C:{0.25:1.3,0.5:1.3,0.75:1.2,1.0:1.2,1.25:1.2}, D:{0.25:1.6,0.5:1.4,0.75:1.2,1.0:1.1,1.25:1.0}, E:{0.25:2.4,0.5:1.7,0.75:1.3,1.0:1.0,1.25:0.9} };
  const row = table[sc] || table['D'];
  const keys = Object.keys(row).map(Number).sort((a,b)=>a-b);
  if (Ss <= keys[0]) return row[keys[0]];
  if (Ss >= keys[keys.length-1]) return row[keys[keys.length-1]];
  for (let i = 0; i < keys.length - 1; i++) {
    if (Ss >= keys[i] && Ss <= keys[i+1]) {
      return row[keys[i]] + (row[keys[i+1]] - row[keys[i]]) * (Ss - keys[i]) / (keys[i+1] - keys[i]);
    }
  }
  return 1.0;
}

function siteCoeffFv(S1, sc) {
  const table = { A:{0.1:0.8,0.2:0.8,0.3:0.8,0.4:0.8,0.5:0.8}, B:{0.1:0.8,0.2:0.8,0.3:0.8,0.4:0.8,0.5:0.8}, C:{0.1:1.5,0.2:1.5,0.3:1.5,0.4:1.5,0.5:1.5}, D:{0.1:2.4,0.2:2.2,0.3:2.0,0.4:1.9,0.5:1.8}, E:{0.1:4.2,0.2:3.3,0.3:2.8,0.4:2.4,0.5:2.4} };
  const row = table[sc] || table['D'];
  const keys = Object.keys(row).map(Number).sort((a,b)=>a-b);
  if (S1 <= keys[0]) return row[keys[0]];
  if (S1 >= keys[keys.length-1]) return row[keys[keys.length-1]];
  for (let i = 0; i < keys.length - 1; i++) {
    if (S1 >= keys[i] && S1 <= keys[i+1]) {
      return row[keys[i]] + (row[keys[i+1]] - row[keys[i]]) * (S1 - keys[i]) / (keys[i+1] - keys[i]);
    }
  }
  return 1.0;
}

function determineSDC(SDS, SD1) {
  // ASCE 7-22 Table 11.6-1/11.6-2 simplified
  if (SDS < 0.167 && SD1 < 0.067) return 'A';
  if (SDS < 0.33 && SD1 < 0.133) return 'B';
  if (SDS < 0.50 && SD1 < 0.20) return 'C';
  return 'D';
}

/**
 * ASCE 7-22 wind pressure (Directional Procedure, §26-§30)
 */
function windPressure(p) {
  const { V_mph = 115, exposure = 'C', Kd = 0.85, Kzt = 1.0, z = 30, GCpi = 0.18, G = 0.85, Cp = 0.8 } = p;

  // Velocity pressure exposure coefficient Kz (Table 26.10-1)
  const alpha = exposure === 'B' ? 7.0 : exposure === 'C' ? 9.5 : 11.5;
  const zg = exposure === 'B' ? 1200 : exposure === 'C' ? 900 : 700;
  const Kz = z < 15 ? 2.01 * Math.pow(15 / zg, 2 / alpha)
                     : 2.01 * Math.pow(z / zg, 2 / alpha);

  // Velocity pressure (§26.10.2)
  const qz = 0.00256 * Kz * Kzt * Kd * V_mph * V_mph; // psf

  // Design wind pressure (§27.3.2)
  const p_pos = qz * G * Cp - qz * GCpi;
  const p_neg = qz * G * (-Cp) + qz * GCpi;

  return {
    V_mph, exposure, Kd, Kzt, Kz: Math.round(Kz * 1000) / 1000,
    qz: Math.round(qz * 100) / 100,
    p_windward: Math.round(p_pos * 100) / 100,
    p_leeward: Math.round(p_neg * 100) / 100,
    G, Cp, GCpi,
    code_ref: 'ASCE 7-22 §26-§30',
  };
}

// ─── ASCE 7-22 Load Combinations (§2.3.1 LRFD) ────────────────────────────

function getLRFDCombinations() {
  return [
    { id: 'LC1', formula: '1.4D', factors: { D:1.4 } },
    { id: 'LC2', formula: '1.2D + 1.6L + 0.5(Lr or S or R)', factors: { D:1.2, L:1.6, Lr:0.5 } },
    { id: 'LC3', formula: '1.2D + 1.6(Lr or S or R) + (L or 0.5W)', factors: { D:1.2, Lr:1.6, L:1.0 } },
    { id: 'LC4', formula: '1.2D + 1.0W + L + 0.5(Lr or S or R)', factors: { D:1.2, W:1.0, L:1.0, Lr:0.5 } },
    { id: 'LC5', formula: '1.2D + 1.0E + L + 0.2S', factors: { D:1.2, E:1.0, L:1.0, S:0.2 } },
    { id: 'LC6', formula: '0.9D + 1.0W', factors: { D:0.9, W:1.0 } },
    { id: 'LC7', formula: '0.9D + 1.0E', factors: { D:0.9, E:1.0 } },
  ];
}

// ─── AISC 360-22 Steel Member Checks ────────────────────────────────────────

/**
 * AISC 360-22 flexural check (Chapter F)
 * @param {object} p - { section, Fy, Lb, Cb, Lu_units }
 */
function steelFlexuralCheck(p) {
  const { section_name = 'W14x48', Fy = 50, Lb = 10, Cb = 1.0, Mu = 0 } = p;
  const s = AISC_SHAPES[section_name];
  if (!s) return { error: `Section ${section_name} not found`, available: Object.keys(AISC_SHAPES) };

  const E = 29000; // ksi
  const phi = 0.9;

  // Plastic moment
  const Mp = Fy * s.Zx; // kip-in

  // Compact flange check (Table B4.1b)
  const lambda_f = s.bf / (2 * s.tf);
  const lambda_pf = 0.38 * Math.sqrt(E / Fy);
  const lambda_rf = 1.0 * Math.sqrt(E / Fy);

  // Compact web check
  const lambda_w = (s.d - 2 * s.tf) / s.tw;
  const lambda_pw = 3.76 * Math.sqrt(E / Fy);

  const flangeCompact = lambda_f <= lambda_pf;
  const webCompact = lambda_w <= lambda_pw;

  // Lateral-torsional buckling
  const rts = Math.sqrt(Math.sqrt(s.Iy * (s.Cw || 1)) / s.Sx);
  const Lp = 1.76 * s.ry * Math.sqrt(E / Fy); // in
  const c = 1.0; // doubly symmetric
  const ho = s.d - s.tf;
  const Lr_term = Math.sqrt(Math.pow(s.J * c / (s.Sx * ho), 2) + 6.76 * Math.pow(0.7 * Fy / E, 2));
  const Lr = 1.95 * rts * (E / (0.7 * Fy)) * Lr_term; // in

  const Lb_in = Lb * 12; // convert feet to inches
  let Mn;
  let ltb_state;

  if (Lb_in <= Lp) {
    Mn = Mp;
    ltb_state = 'Plastic (Lb ≤ Lp)';
  } else if (Lb_in <= Lr) {
    Mn = Cb * (Mp - (Mp - 0.7 * Fy * s.Sx) * (Lb_in - Lp) / (Lr - Lp));
    Mn = Math.min(Mn, Mp);
    ltb_state = 'Inelastic LTB (Lp < Lb ≤ Lr)';
  } else {
    const Fcr = Cb * Math.PI * Math.PI * E / Math.pow(Lb_in / rts, 2) *
                Math.sqrt(1 + 0.078 * s.J * c / (s.Sx * ho) * Math.pow(Lb_in / rts, 2));
    Mn = Math.min(Fcr * s.Sx, Mp);
    ltb_state = 'Elastic LTB (Lb > Lr)';
  }

  const phiMn = phi * Mn; // kip-in
  const ratio = Mu > 0 ? Mu / phiMn : 0;

  return {
    section: section_name,
    Fy,
    Mp: Math.round(Mp),
    Mn: Math.round(Mn),
    phiMn: Math.round(phiMn),
    phiMn_kft: Math.round(phiMn / 12 * 10) / 10,
    Mu,
    ratio: Math.round(ratio * 1000) / 1000,
    pass: ratio <= 1.0,
    Lp_ft: Math.round(Lp / 12 * 100) / 100,
    Lr_ft: Math.round(Lr / 12 * 100) / 100,
    Lb_ft: Lb,
    ltb_state,
    flangeCompact,
    webCompact,
    lambda_f: Math.round(lambda_f * 100) / 100,
    lambda_pf: Math.round(lambda_pf * 100) / 100,
    code_ref: 'AISC 360-22 Chapter F',
  };
}

/**
 * AISC 360-22 compression check (Chapter E)
 */
function steelCompressionCheck(p) {
  const { section_name = 'W14x48', Fy = 50, KL = 15, Mu = 0, Pu = 0 } = p;
  const s = AISC_SHAPES[section_name];
  if (!s) return { error: `Section ${section_name} not found` };

  const E = 29000;
  const phi = 0.9;

  // Slenderness ratio
  const KL_in = KL * 12;
  const lambda_x = KL_in / s.rx;
  const lambda_y = KL_in / s.ry;
  const lambda_max = Math.max(lambda_x, lambda_y);

  // Elastic buckling stress
  const Fe = Math.PI * Math.PI * E / (lambda_max * lambda_max);

  // Critical stress (§E3)
  let Fcr;
  if (Fy / Fe <= 2.25) {
    Fcr = Math.pow(0.658, Fy / Fe) * Fy;
  } else {
    Fcr = 0.877 * Fe;
  }

  const Pn = Fcr * s.A;
  const phiPn = phi * Pn;
  const ratio = Pu > 0 ? Pu / phiPn : 0;

  // Combined check AISC H1-1a/b
  let interaction = 0;
  const phiMn = steelFlexuralCheck({ ...p, Mu: 0 }).phiMn;
  if (Pu > 0 && Mu > 0) {
    const pr = Pu / phiPn;
    const mr = Mu / phiMn;
    interaction = pr >= 0.2
      ? pr + (8/9) * mr  // H1-1a
      : pr / 2 + mr;     // H1-1b
  }

  return {
    section: section_name,
    Fy, KL_ft: KL,
    lambda_x: Math.round(lambda_x * 10) / 10,
    lambda_y: Math.round(lambda_y * 10) / 10,
    Fe: Math.round(Fe * 10) / 10,
    Fcr: Math.round(Fcr * 10) / 10,
    Pn: Math.round(Pn * 10) / 10,
    phiPn: Math.round(phiPn * 10) / 10,
    Pu,
    ratio: Math.round(ratio * 1000) / 1000,
    pass: ratio <= 1.0,
    interaction: Math.round(interaction * 1000) / 1000,
    interaction_pass: interaction <= 1.0,
    code_ref: 'AISC 360-22 Chapter E/H',
  };
}

/**
 * AISC 360-22 shear check (Chapter G)
 */
function steelShearCheck(p) {
  const { section_name = 'W14x48', Fy = 50, Vu = 0 } = p;
  const s = AISC_SHAPES[section_name];
  if (!s) return { error: `Section ${section_name} not found` };

  const E = 29000;
  const phi = 1.0;
  const Aw = s.d * s.tw;
  const kv = 5.34; // unstiffened webs
  const h_tw = (s.d - 2 * s.tf) / s.tw;

  let Cv1;
  if (h_tw <= 2.24 * Math.sqrt(E / Fy)) {
    Cv1 = 1.0;
  } else {
    Cv1 = 1.10 * Math.sqrt(kv * E / Fy) / h_tw;
  }

  const Vn = 0.6 * Fy * Aw * Cv1;
  const phiVn = phi * Vn;
  const ratio = Vu > 0 ? Vu / phiVn : 0;

  return {
    section: section_name,
    Vn: Math.round(Vn * 10) / 10,
    phiVn: Math.round(phiVn * 10) / 10,
    Vu,
    ratio: Math.round(ratio * 1000) / 1000,
    pass: ratio <= 1.0,
    Cv1: Math.round(Cv1 * 1000) / 1000,
    code_ref: 'AISC 360-22 Chapter G',
  };
}

// ─── ACI 318-19 Concrete Member Checks ──────────────────────────────────────

/**
 * ACI 318-19 flexural capacity (§22.2)
 */
function concreteFlexuralCheck(p) {
  const { b = 12, h = 24, d_eff, fc = 4000, fy = 60000, As = 3.0, Mu = 0 } = p;
  const phi = 0.9;
  const d = d_eff || (h - 2.5); // effective depth (in)

  // Stress block depth
  const beta1 = fc <= 4000 ? 0.85 : Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
  const a = As * fy / (0.85 * fc * b);
  const c = a / beta1;

  // Check strain (tension-controlled)
  const epsilon_t = 0.003 * (d - c) / c;
  const tension_controlled = epsilon_t >= 0.005;

  const Mn = As * fy * (d - a / 2); // lb-in
  const phiMn = (tension_controlled ? 0.9 : 0.65 + (epsilon_t - 0.002) * 250/3) * Mn;

  // Minimum steel (§9.6.1.2)
  const As_min = Math.max(3 * Math.sqrt(fc) / fy * b * d, 200 / fy * b * d);

  const ratio = Mu > 0 ? (Mu * 12000) / phiMn : 0; // convert kip-ft to lb-in

  return {
    b, h, d, fc, fy, As,
    a: Math.round(a * 100) / 100,
    c: Math.round(c * 100) / 100,
    beta1: Math.round(beta1 * 1000) / 1000,
    epsilon_t: Math.round(epsilon_t * 10000) / 10000,
    tension_controlled,
    Mn_kft: Math.round(Mn / 12000 * 10) / 10,
    phiMn_kft: Math.round(phiMn / 12000 * 10) / 10,
    Mu_kft: Mu,
    ratio: Math.round(ratio * 1000) / 1000,
    pass: ratio <= 1.0,
    As_min: Math.round(As_min * 100) / 100,
    As_adequate: As >= As_min,
    code_ref: 'ACI 318-19 §22.2',
  };
}

/**
 * ACI 318-19 shear capacity (§22.5)
 */
function concreteShearCheck(p) {
  const { b = 12, h = 24, d_eff, fc = 4000, fy_v = 60000, Av = 0.22, s_stir = 12, Vu = 0 } = p;
  const d = d_eff || (h - 2.5);
  const phi = 0.75;

  const Vc = 2 * Math.sqrt(fc) * b * d; // lb
  const Vs = Av * fy_v * d / s_stir; // lb
  const Vn = Vc + Vs;
  const phiVn = phi * Vn;
  const ratio = Vu > 0 ? (Vu * 1000) / phiVn : 0; // convert kips to lb

  // Max shear (§22.5.1.2)
  const Vs_max = 8 * Math.sqrt(fc) * b * d;

  return {
    Vc_kips: Math.round(Vc / 1000 * 10) / 10,
    Vs_kips: Math.round(Vs / 1000 * 10) / 10,
    Vn_kips: Math.round(Vn / 1000 * 10) / 10,
    phiVn_kips: Math.round(phiVn / 1000 * 10) / 10,
    Vu_kips: Vu,
    ratio: Math.round(ratio * 1000) / 1000,
    pass: ratio <= 1.0,
    Vs_max_kips: Math.round(Vs_max / 1000 * 10) / 10,
    stirrup_adequate: Vs <= Vs_max,
    code_ref: 'ACI 318-19 §22.5',
  };
}

/**
 * ACI 318-19 column interaction check (§22.4)
 */
function concreteColumnCheck(p) {
  const { b = 18, h = 18, fc = 4000, fy = 60000, Ast = 4.0, Pu = 0, Mu = 0 } = p;
  const phi_c = 0.65;
  const Ag = b * h;
  const rho = Ast / Ag;

  // Pure axial capacity (§22.4.2)
  const Po = 0.85 * fc * (Ag - Ast) + fy * Ast;
  const phiPn_max = phi_c * 0.80 * Po; // tied column

  // Balanced condition approximation
  const d = h - 2.5;
  const cb = 0.003 * d / (0.003 + fy / 29000000);
  const beta1 = fc <= 4000 ? 0.85 : Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
  const ab = beta1 * cb;
  const Pb = 0.85 * fc * ab * b + Ast / 2 * (fy - 0.85 * fc) - Ast / 2 * fy;
  const Mb = 0.85 * fc * ab * b * (h / 2 - ab / 2) + Ast / 2 * (fy - 0.85 * fc) * (h / 2 - 2.5) + Ast / 2 * fy * (h / 2 - 2.5);

  // Simplified interaction (Pu/phiPn + Mu/phiMn <= 1.0 conservative)
  const ratio_p = Pu > 0 ? (Pu * 1000) / phiPn_max : 0;
  const phiMn = phi_c * Mb;
  const ratio_m = Mu > 0 ? (Mu * 12000) / phiMn : 0;
  const interaction = ratio_p + ratio_m;

  return {
    b, h, fc, fy, Ast,
    rho: Math.round(rho * 10000) / 10000,
    rho_ok: rho >= 0.01 && rho <= 0.08,
    Po_kips: Math.round(Po / 1000 * 10) / 10,
    phiPn_max_kips: Math.round(phiPn_max / 1000 * 10) / 10,
    Pu_kips: Pu,
    Mu_kft: Mu,
    interaction: Math.round(interaction * 1000) / 1000,
    pass: interaction <= 1.0,
    code_ref: 'ACI 318-19 §22.4',
  };
}

// ─── NDS 2024 Wood Member Checks ────────────────────────────────────────────

/**
 * NDS 2024 flexural check (§3.3)
 */
function woodFlexuralCheck(p) {
  const { section_name = '2x10', CD = 1.0, CM = 1.0, Ct = 1.0, CL = 1.0, CF = 1.0, Cfu = 1.0, Mu = 0 } = p;
  const sec = WOOD_SECTIONS[section_name];
  if (!sec) return { error: `Section ${section_name} not found`, available: Object.keys(WOOD_SECTIONS) };

  // Adjusted design value
  const Fb_prime = sec.Fb * CD * CM * Ct * CL * CF * Cfu;
  const Mn = Fb_prime * sec.Sx; // lb-in
  const ratio = Mu > 0 ? (Mu * 12000) / Mn : 0;

  return {
    section: section_name,
    species: sec.species,
    Fb: sec.Fb,
    Fb_prime: Math.round(Fb_prime),
    Sx: sec.Sx,
    Mn_lbin: Math.round(Mn),
    Mn_kft: Math.round(Mn / 12000 * 10) / 10,
    Mu_kft: Mu,
    ratio: Math.round(ratio * 1000) / 1000,
    pass: ratio <= 1.0,
    adjustments: { CD, CM, Ct, CL, CF, Cfu },
    code_ref: 'NDS 2024 §3.3',
  };
}

/**
 * NDS 2024 compression check (§3.6/§3.7)
 */
function woodCompressionCheck(p) {
  const { section_name = '6x6', le = 96, CD = 1.0, CM = 1.0, Ct = 1.0, Pu = 0 } = p;
  const sec = WOOD_SECTIONS[section_name];
  if (!sec) return { error: `Section ${section_name} not found` };

  const Fc_star = sec.Fc * CD * CM * Ct;
  const FcE = 0.822 * sec.Emin * CM * Ct / Math.pow(le / sec.d, 2);
  const ratio_FcE = FcE / Fc_star;
  const c = sec.species.includes('Glulam') ? 0.9 : 0.8;
  const Cp = (1 + ratio_FcE) / (2 * c) - Math.sqrt(Math.pow((1 + ratio_FcE) / (2 * c), 2) - ratio_FcE / c);
  const Fc_prime = Fc_star * Cp;
  const Pn = Fc_prime * sec.A;

  const utilization = Pu > 0 ? (Pu * 1000) / Pn : 0;

  return {
    section: section_name,
    Fc: sec.Fc,
    Fc_star: Math.round(Fc_star),
    FcE: Math.round(FcE),
    Cp: Math.round(Cp * 1000) / 1000,
    Fc_prime: Math.round(Fc_prime),
    Pn_lbs: Math.round(Pn),
    Pn_kips: Math.round(Pn / 1000 * 10) / 10,
    Pu_kips: Pu,
    ratio: Math.round(utilization * 1000) / 1000,
    pass: utilization <= 1.0,
    le_d: Math.round(le / sec.d * 10) / 10,
    code_ref: 'NDS 2024 §3.6/§3.7',
  };
}

// ─── Direct Stiffness Method (2D Frame) ─────────────────────────────────────

/**
 * Linear static analysis using direct stiffness method.
 * Pure JS matrix solver — no external deps.
 * Handles 2D frame elements (axial + flexure) with 3 DOF per node.
 */
function linearStaticAnalysis(memberList, nodeLoads, supports) {
  // Build node list
  const nodeMap = new Map();
  let nodeIdx = 0;
  for (const m of memberList) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    if (!nodeMap.has(sk)) nodeMap.set(sk, { id: nodeIdx++, x: m.start_node.x, y: m.start_node.y });
    if (!nodeMap.has(ek)) nodeMap.set(ek, { id: nodeIdx++, x: m.end_node.x, y: m.end_node.y });
  }

  const n = nodeMap.size;
  const ndof = n * 3; // 3 DOF per node: u, v, theta
  const K = Array.from({ length: ndof }, () => new Float64Array(ndof));
  const F = new Float64Array(ndof);

  // Assemble global stiffness
  for (const m of memberList) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    const ni = nodeMap.get(sk).id;
    const nj = nodeMap.get(ek).id;

    const dx = m.end_node.x - m.start_node.x;
    const dy = m.end_node.y - m.start_node.y;
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-6) continue;
    const cos = dx / L;
    const sin = dy / L;

    // Get material/section properties
    const props = getMemberProps(m);
    const EA = props.E * props.A;
    const EI = props.E * props.I;

    // Local stiffness matrix (6x6 frame element)
    const k = frameElementStiffness(EA, EI, L);

    // Transformation matrix
    const T = transformMatrix(cos, sin);

    // k_global = T^T * k * T
    const kG = multiplyTkT(T, k);

    // DOF mapping
    const dofs = [ni * 3, ni * 3 + 1, ni * 3 + 2, nj * 3, nj * 3 + 1, nj * 3 + 2];
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        K[dofs[i]][dofs[j]] += kG[i][j];
      }
    }
  }

  // Apply loads
  for (const load of (nodeLoads || [])) {
    const nk = `${load.x},${load.y}`;
    const node = nodeMap.get(nk);
    if (!node) continue;
    const base = node.id * 3;
    if (load.Fx) F[base] += load.Fx;
    if (load.Fy) F[base + 1] += load.Fy;
    if (load.Mz) F[base + 2] += load.Mz;
  }

  // Apply boundary conditions (penalty method)
  const fixedDofs = new Set();
  for (const sup of (supports || [])) {
    const nk = `${sup.x},${sup.y}`;
    const node = nodeMap.get(nk);
    if (!node) continue;
    const base = node.id * 3;
    if (sup.fx) fixedDofs.add(base);
    if (sup.fy) fixedDofs.add(base + 1);
    if (sup.mz) fixedDofs.add(base + 2);
  }

  const penalty = 1e15;
  for (const dof of fixedDofs) {
    K[dof][dof] += penalty;
    F[dof] = 0;
  }

  // Solve K * U = F (Gauss elimination)
  const U = solveLinearSystem(K, F, ndof);

  // Extract results
  const nodeResults = [];
  for (const [key, node] of nodeMap) {
    const base = node.id * 3;
    nodeResults.push({
      id: node.id, x: node.x, y: node.y,
      ux: U[base], uy: U[base + 1], theta: U[base + 2],
    });
  }

  // Member forces
  const memberResults = [];
  for (const m of memberList) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    const ni = nodeMap.get(sk).id;
    const nj = nodeMap.get(ek).id;

    const dx = m.end_node.x - m.start_node.x;
    const dy = m.end_node.y - m.start_node.y;
    const L = Math.sqrt(dx * dx + dy * dy);
    const cos = dx / L;
    const sin = dy / L;

    const props = getMemberProps(m);
    const EA = props.E * props.A;
    const EI = props.E * props.I;
    const k = frameElementStiffness(EA, EI, L);
    const T = transformMatrix(cos, sin);

    const dofs = [ni * 3, ni * 3 + 1, ni * 3 + 2, nj * 3, nj * 3 + 1, nj * 3 + 2];
    const u_global = dofs.map(d => U[d]);
    // u_local = T * u_global
    const u_local = new Array(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) u_local[i] += T[i][j] * u_global[j];
    // f_local = k * u_local
    const f_local = new Array(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) f_local[i] += k[i][j] * u_local[j];

    const axial = f_local[3]; // tension positive
    const shear_i = f_local[1];
    const shear_j = -f_local[4];
    const moment_i = f_local[2];
    const moment_j = -f_local[5];

    // Utilization ratio
    let utilization = 0;
    if (m.material_type === 'steel') {
      const check = steelFlexuralCheck({ section_name: m.section_name, Mu: Math.abs(Math.max(moment_i, moment_j)) / 12 });
      utilization = check.ratio || 0;
    }

    memberResults.push({
      name: m.name, id: m.id,
      axial: Math.round(axial * 100) / 100,
      shear_i: Math.round(shear_i * 100) / 100,
      shear_j: Math.round(shear_j * 100) / 100,
      moment_i: Math.round(moment_i * 100) / 100,
      moment_j: Math.round(moment_j * 100) / 100,
      max_deflection: Math.round(Math.max(Math.abs(u_local[1]), Math.abs(u_local[4])) * 10000) / 10000,
      utilization: Math.round(utilization * 1000) / 1000,
    });
  }

  return {
    nodes: nodeResults,
    members: memberResults,
    max_displacement: Math.max(...nodeResults.map(n => Math.sqrt(n.ux * n.ux + n.uy * n.uy))),
    disclaimer: DISCLAIMER,
  };
}

function getMemberProps(m) {
  if (m.material_type === 'steel') {
    const s = AISC_SHAPES[m.section_name] || AISC_SHAPES['W14x48'];
    return { E: 29000, A: s.A, I: s.Ix }; // ksi, in²/in⁴
  }
  if (m.material_type === 'concrete') {
    const g = CONCRETE_GRADES[m.properties?.grade || 'C4000'];
    const b = m.properties?.b || 12;
    const h = m.properties?.h || 24;
    return { E: g.Ec / 1000, A: b * h, I: b * h * h * h / 12 }; // ksi
  }
  if (m.material_type === 'wood') {
    const sec = WOOD_SECTIONS[m.section_name] || WOOD_SECTIONS['2x10'];
    return { E: sec.E / 1000, A: sec.A, I: sec.Ix }; // ksi
  }
  return { E: 29000, A: 10, I: 100 }; // fallback
}

function frameElementStiffness(EA, EI, L) {
  const L2 = L * L;
  const L3 = L2 * L;
  return [
    [ EA/L,  0,         0,         -EA/L, 0,         0        ],
    [ 0,     12*EI/L3,  6*EI/L2,   0,     -12*EI/L3, 6*EI/L2 ],
    [ 0,     6*EI/L2,   4*EI/L,    0,     -6*EI/L2,  2*EI/L  ],
    [-EA/L,  0,         0,          EA/L,  0,         0        ],
    [ 0,    -12*EI/L3, -6*EI/L2,   0,      12*EI/L3, -6*EI/L2],
    [ 0,     6*EI/L2,   2*EI/L,    0,     -6*EI/L2,  4*EI/L  ],
  ];
}

function transformMatrix(cos, sin) {
  return [
    [ cos,  sin, 0,  0,    0,   0],
    [-sin,  cos, 0,  0,    0,   0],
    [ 0,    0,   1,  0,    0,   0],
    [ 0,    0,   0,  cos,  sin, 0],
    [ 0,    0,   0, -sin,  cos, 0],
    [ 0,    0,   0,  0,    0,   1],
  ];
}

function multiplyTkT(T, k) {
  const n = 6;
  const TT = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => T[j][i]));
  const temp = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let m = 0; m < n; m++) temp[i][j] += TT[i][m] * k[m][j];
  const result = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let m = 0; m < n; m++) result[i][j] += temp[i][m] * T[m][j];
  return result;
}

function solveLinearSystem(K, F, n) {
  // Gaussian elimination with partial pivoting
  const A = K.map(row => [...row]);
  const b = [...F];

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > maxVal) { maxVal = Math.abs(A[row][col]); maxRow = row; }
    }
    if (maxRow !== col) {
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
      [b[col], b[maxRow]] = [b[maxRow], b[col]];
    }
    if (Math.abs(A[col][col]) < 1e-20) continue;
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / A[col][col];
      for (let j = col; j < n; j++) A[row][j] -= factor * A[col][j];
      b[row] -= factor * b[col];
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
    x[i] = Math.abs(A[i][i]) > 1e-20 ? sum / A[i][i] : 0;
  }
  return x;
}

// ─── Modal Analysis (Eigenvalue) ────────────────────────────────────────────

/**
 * Simple modal analysis using inverse iteration (power method).
 * Computes first N natural frequencies and mode shapes.
 */
function modalAnalysis(memberList, supports, numModes = 3) {
  const nodeMap = new Map();
  let idx = 0;
  for (const m of memberList) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    if (!nodeMap.has(sk)) nodeMap.set(sk, { id: idx++, x: m.start_node.x, y: m.start_node.y });
    if (!nodeMap.has(ek)) nodeMap.set(ek, { id: idx++, x: m.end_node.x, y: m.end_node.y });
  }

  const n = nodeMap.size;
  const ndof = n * 3;

  // Build stiffness matrix (same as static)
  const K = Array.from({ length: ndof }, () => new Float64Array(ndof));
  const M = Array.from({ length: ndof }, () => new Float64Array(ndof));

  for (const m of memberList) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    const ni = nodeMap.get(sk).id;
    const nj = nodeMap.get(ek).id;
    const dx = m.end_node.x - m.start_node.x;
    const dy = m.end_node.y - m.start_node.y;
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-6) continue;
    const cos = dx / L;
    const sin = dy / L;
    const props = getMemberProps(m);
    const EA = props.E * props.A;
    const EI = props.E * props.I;
    const k = frameElementStiffness(EA, EI, L);
    const T = transformMatrix(cos, sin);
    const kG = multiplyTkT(T, k);
    const dofs = [ni * 3, ni * 3 + 1, ni * 3 + 2, nj * 3, nj * 3 + 1, nj * 3 + 2];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) K[dofs[i]][dofs[j]] += kG[i][j];

    // Lumped mass
    const mass = (m.properties?.weight || 50) * L / (2 * 386.4); // lb/ft to kip-s²/in (gravity)
    for (const nid of [ni, nj]) {
      M[nid * 3][nid * 3] += mass;
      M[nid * 3 + 1][nid * 3 + 1] += mass;
    }
  }

  // Apply supports
  const fixedDofs = new Set();
  for (const sup of (supports || [])) {
    const nk = `${sup.x},${sup.y}`;
    const node = nodeMap.get(nk);
    if (!node) continue;
    const base = node.id * 3;
    if (sup.fx) fixedDofs.add(base);
    if (sup.fy) fixedDofs.add(base + 1);
    if (sup.mz) fixedDofs.add(base + 2);
  }

  // Reduce to free DOFs
  const freeDofs = [];
  for (let i = 0; i < ndof; i++) if (!fixedDofs.has(i)) freeDofs.push(i);
  const nf = freeDofs.length;

  if (nf === 0) return { modes: [], error: 'No free DOFs' };

  const Kr = Array.from({ length: nf }, (_, i) => new Float64Array(nf));
  const Mr = Array.from({ length: nf }, (_, i) => new Float64Array(nf));
  for (let i = 0; i < nf; i++) {
    for (let j = 0; j < nf; j++) {
      Kr[i][j] = K[freeDofs[i]][freeDofs[j]];
      Mr[i][j] = M[freeDofs[i]][freeDofs[j]];
    }
  }

  // Inverse iteration for eigenvalues
  const modes = [];
  const foundVectors = [];
  for (let mode = 0; mode < Math.min(numModes, nf); mode++) {
    let phi = new Float64Array(nf).map(() => Math.random());
    let omega2 = 0;

    for (let iter = 0; iter < 100; iter++) {
      // Orthogonalize against found modes (Gram-Schmidt)
      for (const prev of foundVectors) {
        let dot = 0;
        for (let i = 0; i < nf; i++) dot += phi[i] * prev[i];
        for (let i = 0; i < nf; i++) phi[i] -= dot * prev[i];
      }

      // y = M * phi
      const y = new Float64Array(nf);
      for (let i = 0; i < nf; i++) for (let j = 0; j < nf; j++) y[i] += Mr[i][j] * phi[j];

      // Solve K * phi_new = y
      const phi_new = solveLinearSystem(Kr, y, nf);

      // Rayleigh quotient
      let kp = 0, mp = 0;
      for (let i = 0; i < nf; i++) {
        for (let j = 0; j < nf; j++) {
          kp += phi_new[i] * Kr[i][j] * phi_new[j];
          mp += phi_new[i] * Mr[i][j] * phi_new[j];
        }
      }
      omega2 = mp > 1e-20 ? kp / mp : 0;

      // Normalize
      let norm = Math.sqrt(mp > 0 ? mp : 1);
      for (let i = 0; i < nf; i++) phi[i] = phi_new[i] / norm;
    }

    const omega = Math.sqrt(Math.abs(omega2));
    const freq = omega / (2 * Math.PI);
    const period = freq > 0 ? 1 / freq : Infinity;

    // Map back to full DOF
    const fullPhi = new Float64Array(ndof);
    for (let i = 0; i < nf; i++) fullPhi[freeDofs[i]] = phi[i];

    const modeShape = [];
    for (const [, node] of nodeMap) {
      modeShape.push({
        id: node.id, x: node.x, y: node.y,
        ux: fullPhi[node.id * 3],
        uy: fullPhi[node.id * 3 + 1],
        theta: fullPhi[node.id * 3 + 2],
      });
    }

    foundVectors.push([...phi]);
    modes.push({
      mode: mode + 1,
      frequency_hz: Math.round(freq * 1000) / 1000,
      period_s: Math.round(period * 1000) / 1000,
      omega_rad_s: Math.round(omega * 100) / 100,
      shape: modeShape,
    });
  }

  return { modes, disclaimer: DISCLAIMER };
}

// ─── OpenSees .tcl Generator ────────────────────────────────────────────────

/**
 * Generate OpenSees .tcl input file for structural frame analysis.
 * Supports: linear static, modal, pushover, time-history.
 */
function generateOpenSeesInput(params) {
  const { members = [], supports = [], loads = [], analysis_type = 'linear_static', seismic = {} } = params;

  let tcl = '';
  tcl += '# ============================================================\n';
  tcl += '# OpenSees Structural Analysis — Generated by Atlantist BIM\n';
  tcl += '# ⚠️ For design reference only. Requires review by licensed SE.\n';
  tcl += '# OpenSees version: 3.5.0+ recommended\n';
  tcl += '# ============================================================\n\n';

  tcl += 'wipe\n';
  tcl += 'model BasicBuilder -ndm 2 -ndf 3\n\n';

  // Build unique node list
  const nodeMap = new Map();
  let nid = 1;
  for (const m of members) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    if (!nodeMap.has(sk)) nodeMap.set(sk, nid++);
    if (!nodeMap.has(ek)) nodeMap.set(ek, nid++);
  }

  tcl += '# ─── Node Coordinates ───────────────────────────────────\n';
  for (const [key, id] of nodeMap) {
    const [x, y] = key.split(',').map(Number);
    tcl += `node ${id} ${x.toFixed(3)} ${y.toFixed(3)}\n`;
  }

  tcl += '\n# ─── Boundary Conditions ────────────────────────────────\n';
  for (const sup of supports) {
    const key = `${sup.x},${sup.y}`;
    const id = nodeMap.get(key);
    if (!id) continue;
    tcl += `fix ${id} ${sup.fx ? 1 : 0} ${sup.fy ? 1 : 0} ${sup.mz ? 1 : 0}\n`;
  }

  tcl += '\n# ─── Material and Section Definitions ───────────────────\n';
  const matMap = new Map();
  let matId = 1;
  for (const m of members) {
    const mkey = `${m.material_type}_${m.section_name || 'default'}`;
    if (!matMap.has(mkey)) {
      const mid = matId++;
      matMap.set(mkey, mid);
      const props = getMemberProps(m);
      if (m.material_type === 'steel') {
        const fy = (m.properties?.Fy || 50) * 6.895; // ksi → MPa for OpenSees
        tcl += `uniaxialMaterial Steel02 ${mid} ${fy.toFixed(1)} ${(props.E * 6.895).toFixed(0)} 0.01 18 0.925 0.15\n`;
      } else if (m.material_type === 'concrete') {
        const fc = -(m.properties?.fc || 4000) * 0.006895; // psi → MPa, negative compression
        tcl += `uniaxialMaterial Concrete01 ${mid} ${fc.toFixed(1)} -0.002 ${(fc * 0.2).toFixed(1)} -0.005\n`;
      } else {
        tcl += `uniaxialMaterial Elastic ${mid} ${(props.E * 6.895).toFixed(0)}\n`;
      }
    }
  }

  tcl += '\n# ─── Geometric Transformation ───────────────────────────\n';
  tcl += 'geomTransf Linear 1\n';
  if (analysis_type === 'pushover' || analysis_type === 'time_history') {
    tcl += 'geomTransf PDelta 2\n';
  }

  tcl += '\n# ─── Element Definitions ────────────────────────────────\n';
  let eid = 1;
  for (const m of members) {
    const sk = `${m.start_node.x},${m.start_node.y}`;
    const ek = `${m.end_node.x},${m.end_node.y}`;
    const ni = nodeMap.get(sk);
    const nj = nodeMap.get(ek);
    const mkey = `${m.material_type}_${m.section_name || 'default'}`;
    const mid = matMap.get(mkey);
    const props = getMemberProps(m);
    const transf = (analysis_type === 'pushover' || analysis_type === 'time_history') ? 2 : 1;
    tcl += `element elasticBeamColumn ${eid++} ${ni} ${nj} ${props.A.toFixed(4)} ${(props.E * 6.895).toFixed(0)} ${props.I.toFixed(4)} ${transf}\n`;
  }

  tcl += '\n# ─── Loads ──────────────────────────────────────────────\n';
  tcl += 'timeSeries Linear 1\npattern Plain 1 1 {\n';
  for (const load of loads) {
    const key = `${load.x},${load.y}`;
    const id = nodeMap.get(key);
    if (id) {
      tcl += `  load ${id} ${load.Fx || 0} ${load.Fy || 0} ${load.Mz || 0}\n`;
    }
  }
  tcl += '}\n';

  // Analysis commands based on type
  if (analysis_type === 'modal') {
    tcl += '\n# ─── Modal Analysis ─────────────────────────────────────\n';
    tcl += 'set numModes 6\n';
    tcl += 'set eigenValues [eigen $numModes]\n';
    tcl += 'set PI [expr 2.0*asin(1.0)]\n';
    tcl += 'puts "Modal Analysis Results:"\n';
    tcl += 'for {set i 0} {$i < $numModes} {incr i} {\n';
    tcl += '  set omega [expr sqrt([lindex $eigenValues $i])]\n';
    tcl += '  set freq [expr $omega / (2.0 * $PI)]\n';
    tcl += '  set period [expr 1.0 / $freq]\n';
    tcl += '  puts "Mode [expr $i+1]: T=$period s, f=$freq Hz, omega=$omega rad/s"\n';
    tcl += '}\n';
    tcl += 'recorder Node -file ModalShapes.out -nodeRange 1 ' + (nid - 1) + ' -dof 1 2 3 eigen\n';
  } else if (analysis_type === 'pushover') {
    tcl += '\n# ─── Pushover Analysis ──────────────────────────────────\n';
    tcl += 'constraints Plain\nnumberer Plain\nsystem BandGeneral\n';
    tcl += 'test NormDispIncr 1.0e-8 20\nalgorithm Newton\n';
    tcl += 'integrator DisplacementControl ' + (nodeMap.size) + ' 1 0.01\n';
    tcl += 'analysis Static\n';
    tcl += 'recorder Node -file PushoverDisp.out -node ' + (nodeMap.size) + ' -dof 1 disp\n';
    tcl += 'recorder Node -file PushoverReact.out -nodeRange 1 ' + (nid - 1) + ' -dof 1 reaction\n';
    tcl += 'set maxU 6.0\nset dU 0.01\nset numSteps [expr int($maxU/$dU)]\n';
    tcl += 'analyze $numSteps\n';
  } else if (analysis_type === 'time_history') {
    tcl += '\n# ─── Time History Analysis ──────────────────────────────\n';
    tcl += '# Load ground motion record (user must supply accel.txt)\n';
    const dt = seismic.dt || 0.02;
    const damping = seismic.damping || 0.05;
    tcl += `set dt ${dt}\nset dampRatio ${damping}\n`;
    tcl += 'timeSeries Path 2 -dt $dt -filePath accel.txt -factor 386.4\n';
    tcl += 'pattern UniformExcitation 2 1 -accel 2\n';
    tcl += '# Rayleigh damping\n';
    tcl += 'set eigenVal [eigen 2]\nset omega1 [expr sqrt([lindex $eigenVal 0])]\nset omega2 [expr sqrt([lindex $eigenVal 1])]\n';
    tcl += 'set a0 [expr $dampRatio*2.0*$omega1*$omega2/($omega1+$omega2)]\n';
    tcl += 'set a1 [expr $dampRatio*2.0/($omega1+$omega2)]\n';
    tcl += 'rayleigh $a0 0.0 $a1 0.0\n';
    tcl += 'constraints Plain\nnumberer Plain\nsystem BandGeneral\n';
    tcl += 'test NormDispIncr 1.0e-8 20\nalgorithm Newton\n';
    tcl += 'integrator Newmark 0.5 0.25\nanalysis Transient\n';
    tcl += 'recorder Node -file TimeHistoryDisp.out -nodeRange 1 ' + (nid - 1) + ' -dof 1 2 disp\n';
    tcl += 'set nSteps [expr int(30.0 / $dt)]\nanalyze $nSteps $dt\n';
  } else {
    // Linear static
    tcl += '\n# ─── Static Analysis ────────────────────────────────────\n';
    tcl += 'constraints Plain\nnumberer Plain\nsystem BandGeneral\n';
    tcl += 'test NormDispIncr 1.0e-8 10\nalgorithm Linear\n';
    tcl += 'integrator LoadControl 1.0\nanalysis Static\n';
    tcl += 'recorder Node -file StaticDisp.out -nodeRange 1 ' + (nid - 1) + ' -dof 1 2 3 disp\n';
    tcl += 'recorder Element -file ElementForces.out -eleRange 1 ' + (eid - 1) + ' globalForce\n';
    tcl += 'analyze 1\n';
  }

  tcl += '\nputs "Analysis complete. Check output files."\n';
  return tcl;
}

// ─── Visualization Data Generator ───────────────────────────────────────────

/**
 * Generate viz_data for Three.js rendering of analysis results.
 * Includes deflection shapes, utilization colors, mode shape animations.
 */
function generateVizData(analysisResult, analysisType) {
  const viz = {
    type: analysisType,
    deflection_scale: 50, // amplification factor for visibility
    color_map: 'utilization', // utilization | stress | displacement
    members: [],
    nodes: [],
    animation_frames: [],
  };

  if (analysisResult.nodes) {
    viz.nodes = analysisResult.nodes.map(n => ({
      id: n.id, x: n.x, y: n.y,
      dx: n.ux * viz.deflection_scale,
      dy: n.uy * viz.deflection_scale,
      displacement: Math.sqrt(n.ux * n.ux + n.uy * n.uy),
    }));
  }

  if (analysisResult.members) {
    viz.members = analysisResult.members.map(m => ({
      name: m.name, id: m.id,
      utilization: m.utilization || 0,
      color: utilizationColor(m.utilization || 0),
      axial: m.axial,
      moment_max: Math.max(Math.abs(m.moment_i || 0), Math.abs(m.moment_j || 0)),
    }));
  }

  // Mode shape animation frames
  if (analysisResult.modes) {
    for (const mode of analysisResult.modes) {
      const frames = [];
      for (let t = 0; t <= 2 * Math.PI; t += Math.PI / 15) {
        const scale = Math.sin(t) * viz.deflection_scale;
        frames.push({
          t: Math.round(t * 1000) / 1000,
          nodes: mode.shape.map(n => ({
            id: n.id,
            x: n.x + n.ux * scale,
            y: n.y + n.uy * scale,
          })),
        });
      }
      viz.animation_frames.push({
        mode: mode.mode,
        frequency: mode.frequency_hz,
        period: mode.period_s,
        frames,
      });
    }
  }

  return viz;
}

function utilizationColor(ratio) {
  // Green (0) → Yellow (0.5) → Red (1.0) → Purple (>1.0)
  if (ratio <= 0) return '#22c55e';
  if (ratio <= 0.5) return `hsl(${120 - ratio * 120}, 80%, 50%)`;
  if (ratio <= 1.0) return `hsl(${60 - (ratio - 0.5) * 120}, 90%, 50%)`;
  return '#9333ea'; // over-stressed
}

// ─── Run Full Analysis ──────────────────────────────────────────────────────

function runAnalysis(params) {
  const { members, supports, loads, analysis_type = 'linear_static', seismic = {} } = params;

  const results = {};

  if (analysis_type === 'linear_static' || analysis_type === 'member_check') {
    const nodeLoads = (loads || []).filter(l => l.load_pattern === 'nodal').map(l => ({
      x: l.node?.x || 0, y: l.node?.y || 0,
      Fx: l.direction === 'x' ? l.magnitude : 0,
      Fy: l.direction === 'y' ? l.magnitude : 0,
      Mz: l.direction === 'mz' ? l.magnitude : 0,
    }));

    results.member_results = linearStaticAnalysis(members, nodeLoads, supports);
  }

  if (analysis_type === 'modal' || analysis_type === 'response_spectrum') {
    results.modal_results = modalAnalysis(members, supports, params.num_modes || 6);
  }

  // Seismic analysis
  if (analysis_type === 'response_spectrum' || analysis_type === 'time_history') {
    results.seismic_results = seismicBaseShear(seismic);
  }

  // Code checks for each member
  const checks = {};
  for (const m of (members || [])) {
    if (m.material_type === 'steel') {
      checks[m.name || m.id] = {
        flexure: steelFlexuralCheck({ section_name: m.section_name, Fy: m.properties?.Fy || 50, Lb: m.properties?.Lb || 10 }),
        compression: steelCompressionCheck({ section_name: m.section_name, Fy: m.properties?.Fy || 50, KL: m.properties?.KL || 15 }),
        shear: steelShearCheck({ section_name: m.section_name, Fy: m.properties?.Fy || 50 }),
      };
    } else if (m.material_type === 'concrete') {
      checks[m.name || m.id] = {
        flexure: concreteFlexuralCheck(m.properties || {}),
        shear: concreteShearCheck(m.properties || {}),
        column: m.member_type === 'column' ? concreteColumnCheck(m.properties || {}) : null,
      };
    } else if (m.material_type === 'wood') {
      checks[m.name || m.id] = {
        flexure: woodFlexuralCheck({ section_name: m.section_name, ...m.properties }),
        compression: m.member_type === 'column' ? woodCompressionCheck({ section_name: m.section_name, ...m.properties }) : null,
      };
    }
  }
  results.code_checks = checks;

  // Generate OpenSees .tcl
  results.opensees_input = generateOpenSeesInput(params);

  // Generate viz data
  results.viz_data = generateVizData(results.member_results || results.modal_results || {}, analysis_type);

  return results;
}

module.exports = {
  DISCLAIMER,
  AISC_SHAPES,
  CONCRETE_GRADES,
  WOOD_SECTIONS,
  seismicBaseShear,
  windPressure,
  getLRFDCombinations,
  steelFlexuralCheck,
  steelCompressionCheck,
  steelShearCheck,
  concreteFlexuralCheck,
  concreteShearCheck,
  concreteColumnCheck,
  woodFlexuralCheck,
  woodCompressionCheck,
  linearStaticAnalysis,
  modalAnalysis,
  generateOpenSeesInput,
  generateVizData,
  runAnalysis,
};
