/**
 * Daily Abuse Scan — runs every 24 hours via polsia.toml [[crons]]
 * Scans recently modified models only (last 24h) for speed.
 * Scans: elements, family_instances, energy_simulations, fire_protection_runs,
 *        geotechnical_runs, design_book_placeholders
 * Tier logic: Tier 1/2 confirmed → immediate model erasure + account suspension
 */
const pool = require('../db/index');

// ─── VIOLATION DATABASE ───────────────────────────────────────────────────────
// Reference: ITAR/EAR, 10 CFR 110, CWC, BWC, ATF, NIJ, declassified DoD/ICBM/NASA, NYC Building Code §110
const VIOLATION_PATTERNS = [
  // ITAR/EAR — Defense/military articles
  { pattern: /weapon|armament|munition|explosive| ordnance|ballistic|missile|warhead|propellant|gunpowder|bomb\b/i, category: 'ITAR_EAR_WEAPONS', weight: 85 },
  { pattern: /guided.missile|rocket.motor|warhead|bomber|attack.aircraft|military.vehicle|tank\b/i, category: 'ITAR_EAR_MILITARY_SYSTEMS', weight: 90 },
  { pattern: /radar|sonar|electronic.warfare|signal.intelligence|surveillance.drone/i, category: 'ITAR_EAR_DEFENSE_TECH', weight: 80 },
  { pattern: /night.vision|laser.weapon|directed.energy|particle.beam/i, category: 'ITAR_EAR_WEAPONIZED_OPTICS', weight: 85 },
  { pattern: /fuse.*bomb|detonator|blasting.cap|trigger.*device/i, category: 'ITAR_EAR_EXPLOSIVE_COMPONENTS', weight: 90 },
  { pattern: /firearm.*serial|gun.*serial|atf|ffl|class.?[3I]|nfa\b/i, category: 'ITAR_EAR_FIREARMS', weight: 80 },
  { pattern: /satellite.*weapon|anti.satellite|space.weapon/i, category: 'ITAR_EAR_SPACE_WEAPONS', weight: 95 },
  { pattern: /biological.weapon|chemic.*weapon|toxin|nerve.agent/i, category: 'ITAR_EAR_BIOCHEM', weight: 95 },

  // 10 CFR 110 / CWC / BWC — Nuclear, chemical, biological
  { pattern: /nuclear.*weapon|fission.material|fusion.material|plutonium|uranium.*enrich|atomic.bomb/i, category: 'NUCLEAR_WEAPONS', weight: 95 },
  { pattern: /radiological|dirty.bomb|radioactive.*dispersion|co60|cs137|americium/i, category: 'NUCLEAR_RADIOLOGICAL', weight: 90 },
  { pattern: /chemical.agent|nerve.agent|sarin|tabun|vx|mustard.gas|blister.agent/i, category: 'CHEMICAL_WEAPONS_CWC', weight: 95 },
  { pattern: /biological.agent|anthrax|botulinum|smallpox|genetically.modified.pathogen/i, category: 'BIOLOGICAL_WEAPONS_BWC', weight: 95 },
  { pattern: /dual.use.*chemical|precursor.chemical| Schedule 1 chemical|riot.control.chemical/i, category: 'DUAL_USE_CHEMICALS', weight: 75 },
  { pattern: /sarin.synthesis|chemical.synthesis.route|weaponization.*biological/i, category: 'WEAPONIZATION_ROUTES', weight: 95 },

  // ATF / NIJ
  { pattern: /bootleg|moonshine|stills|beverage.manufacturing|tobacco.product/i, category: 'ATF_REGULATED_PRODUCTS', weight: 15 },
  { pattern: /ballistic.test|niJ.?0101|nij.?standard|body.armor|ballistic.panel|bullet.proof/i, category: 'NIJ_BALLISTIC', weight: 30 },

  // Declassified DoD/ICBM/NASA
  { pattern: /icbm.*guidance|ballistic.missile.guidance|reentry.vehicle|warhead.*delivery/i, category: 'ICBM_TECHNICAL', weight: 95 },
  { pattern: /nuclear.propulsion|nuclear.engine|space.*nuclear|radioisotope.generator/i, category: 'NUCLEAR_PROPULSION', weight: 90 },
  { pattern: /launch.silo|missile.silo|silo.*construction|icbm.silo/i, category: 'MISSILE_INFRASTRUCTURE', weight: 85 },
  { pattern: /satellite.*intercept|orbital.*weapon|space.based.weapon|killer.satellite/i, category: 'ASAT_SYSTEMS', weight: 90 },
  { pattern: /classified.*document|top.secret|sensitive.but.unclassified|sbi/i, category: 'CLASSIFIED_ACCESS', weight: 60 },
  { pattern: /hemp.*construction|marijuana.*facility|cannabis.*growing/i, category: 'CONTROLLED_SUBSTANCE_FACILITY', weight: 40 },

  // NYC Building Code §110 — Controlled buildings
  { pattern: /secure.vault|high.security.facility|safe.room.*enhanced|gov.facility.*secure/i, category: 'NYC_CONTROLLED_FACILITY', weight: 60 },
  { pattern: /prison|detention.center|correctional|jail|penitentiary/i, category: 'CORRECTIONAL_FACILITY', weight: 65 },
  { pattern: /blast.resistant.design|explosive.load.rating|blast.shelter|hardened.shelter/i, category: 'BLAST_RESISTANT_STRUCTURE', weight: 70 },

  // General danger
  { pattern: /bomb.shelter.*military|defensive.fortification|military.bunker|bunker.*design/i, category: 'MILITARY_BUNKER', weight: 80 },
  { pattern: /terrorist.*target|soft.target| crowd.target|mass.casualty/i, category: 'TERROR_TARGET_PATTERN', weight: 95 },
  { pattern: /attack.vector|exploitation.framework|intrusion.payload|malware.*design/i, category: 'CYBER_WEAPON_DESIGN', weight: 85 },
  { pattern: /improvised.explosive|ied.*design|pipe.bomb|pressure.cooker/i, category: 'IED_DESIGN', weight: 95 },
];

function matchPatterns(text) {
  if (!text) return [];
  return VIOLATION_PATTERNS.filter(vp => vp.pattern.test(text)).map(vp => vp.category);
}

function calculateTier(flags) {
  if (!flags.length) return null;
  const weights = VIOLATION_PATTERNS.filter(vp => flags.includes(vp.category)).map(vp => vp.weight);
  const maxWeight = Math.max(...weights);
  const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
  if (maxWeight >= 90) return 1;
  if (avgWeight >= 70 || maxWeight >= 75) return 2;
  return 3;
}

// ─── MODEL SCANNERS (recent-only) ─────────────────────────────────────────────

async function scanElements(client) {
  const rows = await client.query(`
    SELECT id, user_id, type, name, parameters
    FROM elements
    WHERE user_id IS NOT NULL
      AND (updated_at >= NOW() - INTERVAL '24 hours' OR created_at >= NOW() - INTERVAL '24 hours')
  `);
  return rows.rows.map(row => {
    const searchable = [row.name, row.type, JSON.stringify(row.parameters || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'element', model_id: row.id, owner_user_id: row.user_id, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanFamilyInstances(client) {
  const rows = await client.query(`
    SELECT fi.id, fi.user_id, fi.family_type, fi.name, fi.parameters
    FROM family_instances fi
    WHERE fi.user_id IS NOT NULL
      AND (fi.updated_at >= NOW() - INTERVAL '24 hours' OR fi.created_at >= NOW() - INTERVAL '24 hours')
  `);
  return rows.rows.map(row => {
    const searchable = [row.name, row.family_type, JSON.stringify(row.parameters || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'family_instance', model_id: row.id, owner_user_id: row.user_id, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanEnergySimulations(client) {
  const rows = await client.query(`
    SELECT es.id, es.user_id, es.name, es.input_data, es.compliance_data
    FROM energy_simulations es
    WHERE es.user_id IS NOT NULL
      AND (es.updated_at >= NOW() - INTERVAL '24 hours' OR es.created_at >= NOW() - INTERVAL '24 hours')
  `);
  return rows.rows.map(row => {
    const searchable = [row.name, JSON.stringify(row.input_data || {}), JSON.stringify(row.compliance_data || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'energy_simulation', model_id: row.id, owner_user_id: row.user_id, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanFireProtectionRuns(client) {
  const rows = await client.query(`
    SELECT fpr.id, fpr.user_id, fpr.name, fpr.occupancy_type, fpr.results_json
    FROM fire_protection_runs fpr
    WHERE fpr.user_id IS NOT NULL
      AND (fpr.updated_at >= NOW() - INTERVAL '24 hours' OR fpr.created_at >= NOW() - INTERVAL '24 hours')
  `);
  return rows.rows.map(row => {
    const searchable = [row.name, row.occupancy_type, JSON.stringify(row.results_json || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'fire_protection_run', model_id: row.id, owner_user_id: row.user_id, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanGeotechnicalRuns(client) {
  const rows = await client.query(`
    SELECT gr.id, gr.user_id, gr.name, gr.bearing_results, gr.settlement_results
    FROM geotechnical_runs gr
    WHERE gr.user_id IS NOT NULL
      AND (gr.updated_at >= NOW() - INTERVAL '24 hours' OR gr.created_at >= NOW() - INTERVAL '24 hours')
  `);
  return rows.rows.map(row => {
    const searchable = [row.name, JSON.stringify(row.bearing_results || {}), JSON.stringify(row.settlement_results || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'geotechnical_run', model_id: row.id, owner_user_id: row.user_id, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanDesignBookPlaceholders(client) {
  const rows = await client.query(`
    SELECT dbp.id, dbp.user_id, dbp.title, dbp.required_spec, dbp.reference_std
    FROM design_book_placeholders dbp
    WHERE dbp.user_id IS NOT NULL
      AND (dbp.updated_at >= NOW() - INTERVAL '24 hours' OR dbp.created_at >= NOW() - INTERVAL '24 hours')
  `);
  return rows.rows.map(row => {
    const searchable = [row.title, row.required_spec, row.reference_std].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'design_book_placeholder', model_id: row.id, owner_user_id: row.user_id, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

// ─── MODEL ERASURE ───────────────────────────────────────────────────────────

const ERASURE_SQL = {
  element: `DELETE FROM elements WHERE id = $1`,
  family_instance: `DELETE FROM family_instances WHERE id = $1`,
  energy_simulation: `DELETE FROM energy_simulations WHERE id = $1`,
  fire_protection_run: `DELETE FROM fire_protection_runs WHERE id = $1`,
  geotechnical_run: `DELETE FROM geotechnical_runs WHERE id = $1`,
  design_book_placeholder: `DELETE FROM design_book_placeholders WHERE id = $1`,
};

async function eraseModel(client, modelType, modelId) {
  const sql = ERASURE_SQL[modelType];
  if (!sql) return false;
  await client.query(sql, [modelId]);
  return true;
}

async function suspendAccount(client, userId) {
  await client.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
  await client.query(`UPDATE users SET suspended_at = NOW() WHERE id = $1 AND suspended_at IS NULL`, [userId]);
}

async function logAbuseAction(client, scanId, flaggedModelId, action, details) {
  await client.query(`
    INSERT INTO abuse_log (scan_id, flagged_model_id, action, details)
    VALUES ($1, $2, $3, $4)
  `, [scanId, flaggedModelId, action, JSON.stringify(details)]);
}

// ─── MAIN SCAN ───────────────────────────────────────────────────────────────

async function runDailyScan() {
  console.log('[abuse-scan] Starting daily abuse scan — ' + new Date().toISOString());

  const scanStart = Date.now();

  const scanRecord = await pool.query(`
    INSERT INTO abuse_scan_records (scan_type, status, started_at)
    VALUES ('daily', 'running', NOW())
    RETURNING id
  `);
  const scanId = scanRecord.rows[0].id;
  console.log(`[abuse-scan] Scan record ${scanId} created`);

  let errorLog = null;
  let modelsScanned = 0;
  let modelsFlagged = 0;
  let tier1Count = 0, tier2Count = 0, tier3Count = 0;
  let accountsSuspended = 0;
  const flaggedModelIds = [];

  try {
    const scanners = [
      { fn: scanElements, label: 'elements' },
      { fn: scanFamilyInstances, label: 'family_instances' },
      { fn: scanEnergySimulations, label: 'energy_simulations' },
      { fn: scanFireProtectionRuns, label: 'fire_protection_runs' },
      { fn: scanGeotechnicalRuns, label: 'geotechnical_runs' },
      { fn: scanDesignBookPlaceholders, label: 'design_book_placeholders' },
    ];

    let allFlagged = [];

    for (const scanner of scanners) {
      try {
        const results = await scanner.fn(pool);
        const scannedCount = results.length;
        modelsScanned += scannedCount;
        allFlagged = allFlagged.concat(results);
        console.log(`[abuse-scan] ${scanner.label}: ${scannedCount} flagged (of recently modified)`);
      } catch (err) {
        console.error(`[abuse-scan] Scanner error for ${scanner.label}:`, err.message);
      }
    }

    modelsFlagged = allFlagged.length;
    tier1Count = allFlagged.filter(f => f.tier === 1).length;
    tier2Count = allFlagged.filter(f => f.tier === 2).length;
    tier3Count = allFlagged.filter(f => f.tier === 3).length;

    const tier1_2Owners = [...new Set(allFlagged.filter(f => f.tier <= 2).map(f => f.owner_user_id))];

    // Insert flagged records + auto-act on Tier 1/2
    for (const flagged of allFlagged) {
      const insertResult = await pool.query(`
        INSERT INTO abuse_flagged_models (scan_id, model_type, model_id, owner_user_id, tier, flags, flag_details)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [scanId, flagged.model_type, flagged.model_id, flagged.owner_user_id, flagged.tier, flagged.flags, `Matched patterns: ${flagged.flags.join(', ')}`]);
      const flaggedModelId = insertResult.rows[0].id;
      flaggedModelIds.push(flaggedModelId);

      if (flagged.tier <= 2) {
        await eraseModel(pool, flagged.model_type, flagged.model_id);
        await pool.query(`UPDATE abuse_flagged_models SET resolution = 'erased', resolved_at = NOW() WHERE id = $1`, [flaggedModelId]);
        await logAbuseAction(pool, scanId, flaggedModelId, 'model_erased', { model_type: flagged.model_type, model_id: flagged.model_id, tier: flagged.tier });
        console.log(`[abuse-scan] ✓ Erased Tier-${flagged.tier} ${flagged.model_type}:${flagged.model_id}`);
      }
    }

    // Suspend Tier 1/2 account owners
    for (const userId of tier1_2Owners) {
      await suspendAccount(pool, userId);
      accountsSuspended++;
      await logAbuseAction(pool, scanId, null, 'account_suspended', { user_id: userId });
      console.log(`[abuse-scan] ✓ Suspended account ${userId} (Tier 1/2 violation)`);
    }

    if (modelsFlagged === 0) {
      console.log('[abuse-scan] No violations detected in daily scan');
    }

  } catch (err) {
    errorLog = err.message;
    console.error('[abuse-scan] Scan error:', err);
  }

  await pool.query(`
    UPDATE abuse_scan_records
    SET status = $1, completed_at = NOW(), models_scanned = $2,
        models_flagged = $3, tier1_count = $4, tier2_count = $5, tier3_count = $6,
        accounts_suspended = $7, error_log = $8, flagged_model_ids = $9
    WHERE id = $10
  `, [errorLog ? 'failed' : 'completed', modelsScanned, modelsFlagged, tier1Count, tier2Count, tier3Count, accountsSuspended, errorLog, flaggedModelIds, scanId]);

  const elapsed = Date.now() - scanStart;
  console.log(`[abuse-scan] Done in ${elapsed}ms — ${modelsScanned} scanned, ${modelsFlagged} flagged (T1:${tier1Count} T2:${tier2Count} T3:${tier3Count}), ${accountsSuspended} suspended`);
}

runDailyScan().catch(err => {
  console.error('[abuse-scan] Fatal:', err);
  process.exit(1);
});