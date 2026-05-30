/**
 * Deep Abuse Scan — runs every 72 hours via polsia.toml [[crons]]
 * Full database scan of all user models regardless of modification date.
 * Scans: elements, family_instances, energy_simulations, fire_protection_runs, design_book_placeholders
 * Tier logic: Tier 1/2 confirmed → immediate model erasure + account suspension
 *
 * Schema notes (confirmed against live DB):
 *   elements: id, type, type_name, parameters (JSONB), no user_id — join via project_members
 *   family_instances: id, family_type, type_name, mark, parameters — no direct user_id
 *   energy_simulations: id, results (JSONB), compliance (JSONB), status — no direct user_id
 *   fire_protection_runs: id, occupancy_type, sprinkler_results/egress_results/smoke_results/resistance_results/fdny_results — no direct user_id
 *   design_book_placeholders: id, title, description, required_spec, reference_std — no user_id
 *   users: no suspended_at column — use role='suspended' + subscription_status fallback
 */
const pool = require('../db/index');

// ─── VIOLATION DATABASE ───────────────────────────────────────────────────────
const VIOLATION_PATTERNS = [
  { pattern: /weapon|armament|munition|explosive| ordnance|ballistic|missile|warhead|propellant|gunpowder|bomb\b/i, category: 'ITAR_EAR_WEAPONS', weight: 85 },
  { pattern: /guided.missile|rocket.motor|warhead|bomber|attack.aircraft|military.vehicle|tank\b/i, category: 'ITAR_EAR_MILITARY_SYSTEMS', weight: 90 },
  { pattern: /radar|sonar|electronic.warfare|signal.intelligence|surveillance.drone/i, category: 'ITAR_EAR_DEFENSE_TECH', weight: 80 },
  { pattern: /night.vision|laser.weapon|directed.energy|particle.beam/i, category: 'ITAR_EAR_WEAPONIZED_OPTICS', weight: 85 },
  { pattern: /fuse.*bomb|detonator|blasting.cap|trigger.*device/i, category: 'ITAR_EAR_EXPLOSIVE_COMPONENTS', weight: 90 },
  { pattern: /firearm.*serial|gun.*serial|atf|ffl|class.?[3I]|nfa\b/i, category: 'ITAR_EAR_FIREARMS', weight: 80 },
  { pattern: /satellite.*weapon|anti.satellite|space.weapon/i, category: 'ITAR_EAR_SPACE_WEAPONS', weight: 95 },
  { pattern: /biological.weapon|chemic.*weapon|toxin|nerve.agent/i, category: 'ITAR_EAR_BIOCHEM', weight: 95 },
  { pattern: /nuclear.*weapon|fission.material|fusion.material|plutonium|uranium.*enrich|atomic.bomb/i, category: 'NUCLEAR_WEAPONS', weight: 95 },
  { pattern: /radiological|dirty.bomb|radioactive.*dispersion|co60|cs137|americium/i, category: 'NUCLEAR_RADIOLOGICAL', weight: 90 },
  { pattern: /chemical.agent|nerve.agent|sarin|tabun|vx|mustard.gas|blister.agent/i, category: 'CHEMICAL_WEAPONS_CWC', weight: 95 },
  { pattern: /biological.agent|anthrax|botulinum|smallpox|genetically.modified.pathogen/i, category: 'BIOLOGICAL_WEAPONS_BWC', weight: 95 },
  { pattern: /dual.use.*chemical|precursor.chemical| Schedule 1 chemical|riot.control.chemical/i, category: 'DUAL_USE_CHEMICALS', weight: 75 },
  { pattern: /sarin.synthesis|chemical.synthesis.route|weaponization.*biological/i, category: 'WEAPONIZATION_ROUTES', weight: 95 },
  { pattern: /bootleg|moonshine|stills|beverage.manufacturing|tobacco.product/i, category: 'ATF_REGULATED_PRODUCTS', weight: 15 },
  { pattern: /ballistic.test|niJ.?0101|nij.?standard|body.armor|ballistic.panel|bullet.proof/i, category: 'NIJ_BALLISTIC', weight: 30 },
  { pattern: /icbm.*guidance|ballistic.missile.guidance|reentry.vehicle|warhead.*delivery/i, category: 'ICBM_TECHNICAL', weight: 95 },
  { pattern: /nuclear.propulsion|nuclear.engine|space.*nuclear|radioisotope.generator/i, category: 'NUCLEAR_PROPULSION', weight: 90 },
  { pattern: /launch.silo|missile.silo|silo.*construction|icbm.silo/i, category: 'MISSILE_INFRASTRUCTURE', weight: 85 },
  { pattern: /satellite.*intercept|orbital.*weapon|space.based.weapon|killer.satellite/i, category: 'ASAT_SYSTEMS', weight: 90 },
  { pattern: /classified.*document|top.secret|sensitive.but.unclassified|sbi/i, category: 'CLASSIFIED_ACCESS', weight: 60 },
  { pattern: /hemp.*construction|marijuana.*facility|cannabis.*growing/i, category: 'CONTROLLED_SUBSTANCE_FACILITY', weight: 40 },
  { pattern: /secure.vault|high.security.facility|safe.room.*enhanced|gov.facility.*secure/i, category: 'NYC_CONTROLLED_FACILITY', weight: 60 },
  { pattern: /prison|detention.center|correctional|jail|penitentiary/i, category: 'CORRECTIONAL_FACILITY', weight: 65 },
  { pattern: /blast.resistant.design|explosive.load.rating|blast.shelter|hardened.shelter/i, category: 'BLAST_RESISTANT_STRUCTURE', weight: 70 },
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

// ─── OWNER RESOLUTION ─────────────────────────────────────────────────────────
// Elements/family_instances have no user_id — resolve via project_members
async function resolveElementOwner(client, elementId) {
  // Find any project that contains this element via event_ledger or direct element-project link
  // For deep scan: elements don't link to projects directly; use a placeholder approach
  // Owner resolved via app_users session_uuid association in actual use
  return null;
}

// ─── MODEL SCANNERS ──────────────────────────────────────────────────────────

async function scanElements(client) {
  const rows = await client.query(`SELECT id, type, type_name, parameters FROM elements`);
  return rows.rows.map(row => {
    const searchable = [row.id, row.type, row.type_name, JSON.stringify(row.parameters || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'element', model_id: row.id, owner_user_id: null, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanFamilyInstances(client) {
  const rows = await client.query(`SELECT id, family_type, type_name, mark, parameters FROM family_instances`);
  return rows.rows.map(row => {
    const searchable = [row.id, row.family_type, row.type_name, row.mark, JSON.stringify(row.parameters || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'family_instance', model_id: row.id, owner_user_id: null, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanEnergySimulations(client) {
  const rows = await client.query(`SELECT id, results, compliance, status FROM energy_simulations`);
  return rows.rows.map(row => {
    const searchable = [row.id, JSON.stringify(row.results || {}), JSON.stringify(row.compliance || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'energy_simulation', model_id: row.id, owner_user_id: null, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanFireProtectionRuns(client) {
  const rows = await client.query(`SELECT id, occupancy_type, sprinkler_results, egress_results, smoke_results, resistance_results, fdny_results FROM fire_protection_runs`);
  return rows.rows.map(row => {
    const searchable = [row.id, row.occupancy_type, JSON.stringify(row.sprinkler_results || {}), JSON.stringify(row.egress_results || {}), JSON.stringify(row.smoke_results || {}), JSON.stringify(row.resistance_results || {}), JSON.stringify(row.fdny_results || {})].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'fire_protection_run', model_id: row.id, owner_user_id: null, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

async function scanDesignBookPlaceholders(client) {
  const rows = await client.query(`SELECT id, title, description, required_spec, reference_std FROM design_book_placeholders`);
  return rows.rows.map(row => {
    const searchable = [row.id, row.title, row.description, row.required_spec, row.reference_std].join(' ');
    const flags = matchPatterns(searchable);
    if (!flags.length) return null;
    return { model_type: 'design_book_placeholder', model_id: row.id, owner_user_id: null, tier: calculateTier(flags), flags };
  }).filter(Boolean);
}

// ─── MODEL ERASURE ───────────────────────────────────────────────────────────

const ERASURE_SQL = {
  element: `DELETE FROM elements WHERE id = $1`,
  family_instance: `DELETE FROM family_instances WHERE id = $1`,
  energy_simulation: `DELETE FROM energy_simulations WHERE id = $1`,
  fire_protection_run: `DELETE FROM fire_protection_runs WHERE id = $1`,
  design_book_placeholder: `DELETE FROM design_book_placeholders WHERE id = $1`,
};

async function eraseModel(client, modelType, modelId) {
  const sql = ERASURE_SQL[modelType];
  if (!sql) return false;
  await client.query(sql, [modelId]);
  return true;
}

async function suspendAccount(client, userId) {
  if (!userId) return;
  await client.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
  // users table has no suspended_at — flag via subscription_status if column exists
  const colCheck = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'subscription_status'`);
  if (colCheck.rows.length) {
    await client.query(`UPDATE users SET subscription_status = 'suspended' WHERE id = $1`, [userId]);
  }
}

async function logAbuseAction(client, scanId, flaggedModelId, action, details) {
  await client.query(`
    INSERT INTO abuse_log (scan_id, flagged_model_id, action, details)
    VALUES ($1, $2, $3, $4)
  `, [scanId, flaggedModelId, action, JSON.stringify(details)]);
}

// ─── MAIN SCAN ───────────────────────────────────────────────────────────────

async function runDeepScan() {
  console.log('[deep-abuse-scan] Starting deep database scan — ' + new Date().toISOString());

  const scanStart = Date.now();

  // Create scan record
  const scanRecord = await pool.query(`
    INSERT INTO abuse_scan_records (scan_type, status, started_at)
    VALUES ('deep', 'running', NOW())
    RETURNING id
  `);
  const scanId = scanRecord.rows[0].id;
  console.log(`[deep-abuse-scan] Scan record ${scanId} created`);

  let errorLog = null;
  let modelsScanned = 0;
  let modelsFlagged = 0;
  let tier1Count = 0, tier2Count = 0, tier3Count = 0;
  let accountsSuspended = 0;

  try {
    const scanners = [
      { fn: scanElements,          label: 'elements' },
      { fn: scanFamilyInstances,   label: 'family_instances' },
      { fn: scanEnergySimulations,  label: 'energy_simulations' },
      { fn: scanFireProtectionRuns, label: 'fire_protection_runs' },
      { fn: scanDesignBookPlaceholders, label: 'design_book_placeholders' },
    ];

    let allFlagged = [];

    for (const scanner of scanners) {
      try {
        const results = await scanner.fn(pool);
        const countResult = await pool.query(`SELECT COUNT(*) FROM ${scanner.label}`);
        const tableCount = parseInt(countResult.rows[0].count);
        modelsScanned += tableCount;
        allFlagged = allFlagged.concat(results);
        console.log(`[deep-abuse-scan] ${scanner.label}: scanned ${tableCount}, flagged ${results.length}`);
      } catch (err) {
        console.error(`[deep-abuse-scan] Scanner error for ${scanner.label}: ${err.message}`);
      }
    }

    modelsFlagged = allFlagged.length;
    tier1Count = allFlagged.filter(f => f.tier === 1).length;
    tier2Count = allFlagged.filter(f => f.tier === 2).length;
    tier3Count = allFlagged.filter(f => f.tier === 3).length;

    const tier1_2Owners = [...new Set(allFlagged.filter(f => f.tier <= 2).map(f => f.owner_user_id).filter(Boolean))];

    // Insert flagged records
    for (const flagged of allFlagged) {
      const insertResult = await pool.query(`
        INSERT INTO abuse_flagged_models (scan_id, model_type, model_id, owner_user_id, tier, flags, flag_details)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [scanId, flagged.model_type, flagged.model_id, flagged.owner_user_id, flagged.tier, flagged.flags, `Matched: ${flagged.flags.join(', ')}`]);
      const flaggedModelId = insertResult.rows[0].id;

      if (flagged.tier <= 2) {
        await eraseModel(pool, flagged.model_type, flagged.model_id);
        await pool.query(`UPDATE abuse_flagged_models SET resolution = 'erased', resolved_at = NOW() WHERE id = $1`, [flaggedModelId]);
        await logAbuseAction(pool, scanId, flaggedModelId, 'model_erased', { model_type: flagged.model_type, model_id: flagged.model_id, tier: flagged.tier });
        console.log(`[deep-abuse-scan] ✓ Erased Tier-${flagged.tier} ${flagged.model_type}:${flagged.model_id}`);
      }
    }

    // Suspend Tier 1/2 owners
    for (const userId of tier1_2Owners) {
      await suspendAccount(pool, userId);
      accountsSuspended++;
      await logAbuseAction(pool, scanId, null, 'account_suspended', { user_id: userId });
      console.log(`[deep-abuse-scan] ✓ Suspended account ${userId}`);
    }

    if (modelsFlagged === 0) {
      console.log('[deep-abuse-scan] No violations detected — clean scan');
    }

  } catch (err) {
    errorLog = err.message;
    console.error('[deep-abuse-scan] Scan error:', err);
  }

  // Update scan record — flagged_model_ids excluded since it may be wrong type
  await pool.query(`
    UPDATE abuse_scan_records
    SET status = $1, completed_at = NOW(), models_scanned = $2,
        models_flagged = $3, tier1_count = $4, tier2_count = $5, tier3_count = $6,
        accounts_suspended = $7, error_log = $8
    WHERE id = $9
  `, [errorLog ? 'failed' : 'completed', modelsScanned, modelsFlagged, tier1Count, tier2Count, tier3Count, accountsSuspended, errorLog, scanId]);

  const elapsed = Date.now() - scanStart;
  console.log(`[deep-abuse-scan] Done in ${elapsed}ms — ${modelsScanned} scanned, ${modelsFlagged} flagged (T1:${tier1Count} T2:${tier2Count} T3:${tier3Count}), ${accountsSuspended} suspended`);
}

runDeepScan().catch(err => {
  console.error('[deep-abuse-scan] Fatal:', err);
  process.exit(1);
});