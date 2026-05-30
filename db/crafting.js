/**
 * Owns: crafting_things, crafting_recipes, crafting_operations,
 *       crafting_workbenches, crafting_assemblies CRUD.
 * Does NOT own: recipe generation logic (services/crafting-engine.js).
 */
const pool = require('./index');

// ── helpers ─────────────────────────────────────────────────────────────────

function rowToThing(r) {
  return {
    id: r.id, name: r.name, description: r.description,
    properties_json: r.properties_json, source_type: r.source_type,
    source_ref: r.source_ref, created_by: r.created_by,
    project_id: r.project_id, is_assembly: r.is_assembly,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
function rowToRecipe(r) {
  return {
    id: r.id, name: r.name, description: r.description,
    output_thing_id: r.output_thing_id, input_things_json: r.input_things_json,
    operations_json: r.operations_json, total_cost_estimate: r.total_cost_estimate,
    total_time_estimate: r.total_time_estimate, path_rank: r.path_rank,
    recipe_data_json: r.recipe_data_json, created_by: r.created_by,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
function rowToWorkbench(r) {
  return {
    id: r.id, user_id: r.user_id, name: r.name,
    location_json: r.location_json, tools_available: r.tools_available,
    skill_profile: r.skill_profile, budget_range_json: r.budget_range_json,
    time_constraints_json: r.time_constraints_json,
    preferences_json: r.preferences_json, is_active: r.is_active,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
function rowToAssembly(r) {
  return {
    id: r.id, project_id: r.project_id, name: r.name,
    sub_things_json: r.sub_things_json, recipe_graph_json: r.recipe_graph_json,
    total_cost: r.total_cost, total_time: r.total_time,
    shopping_lists_json: r.shopping_lists_json, created_by: r.created_by,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

// ── crafting_things ──────────────────────────────────────────────────────────

async function createThing({ name, description, properties_json, source_type, source_ref, created_by, project_id, is_assembly }) {
  const r = await pool.query(
    `INSERT INTO crafting_things (name, description, properties_json, source_type, source_ref, created_by, project_id, is_assembly)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, description, properties_json || {}, source_type || 'manual', source_ref, created_by, project_id, is_assembly || false]
  );
  return rowToThing(r.rows[0]);
}

async function getThingById(id) {
  const r = await pool.query(`SELECT * FROM crafting_things WHERE id=$1`, [id]);
  return r.rows[0] ? rowToThing(r.rows[0]) : null;
}

async function listThings({ project_id, created_by, source_type, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM crafting_things WHERE 1=1';
  const params = [];
  if (project_id != null) { sql += ' AND project_id=$' + (params.push(project_id) + 1); }
  if (created_by != null) { sql += ' AND created_by=$' + (params.push(created_by) + 1); }
  if (source_type) { sql += ' AND source_type=$' + (params.push(source_type) + 1); }
  sql += ` ORDER BY updated_at DESC LIMIT $${params.push(limit) + 1} OFFSET $${params.push(offset) + 1}`;
  const r = await pool.query(sql, params);
  return r.rows.map(rowToThing);
}

async function updateThing(id, { name, description, properties_json, source_type, source_ref, is_assembly }) {
  const r = await pool.query(
    `UPDATE crafting_things SET name=COALESCE($2,name), description=COALESCE($3,description),
     properties_json=COALESCE($4,properties_json), source_type=COALESCE($5,source_type),
     source_ref=COALESCE($6,source_ref), is_assembly=COALESCE($7,is_assembly),
     updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, name, description, properties_json, source_type, source_ref, is_assembly]
  );
  return r.rows[0] ? rowToThing(r.rows[0]) : null;
}

async function deleteThing(id) {
  await pool.query(`DELETE FROM crafting_things WHERE id=$1`, [id]);
}

// ── crafting_recipes ─────────────────────────────────────────────────────────

async function createRecipe({ name, description, output_thing_id, input_things_json, operations_json, total_cost_estimate, total_time_estimate, path_rank, recipe_data_json, created_by }) {
  const r = await pool.query(
    `INSERT INTO crafting_recipes (name, description, output_thing_id, input_things_json, operations_json,
     total_cost_estimate, total_time_estimate, path_rank, recipe_data_json, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, description, output_thing_id, input_things_json || [], operations_json || [],
     total_cost_estimate || 0, total_time_estimate || 0, path_rank || 0, recipe_data_json || {}, created_by]
  );
  return rowToRecipe(r.rows[0]);
}

async function getRecipeById(id) {
  const r = await pool.query(`SELECT * FROM crafting_recipes WHERE id=$1`, [id]);
  return r.rows[0] ? rowToRecipe(r.rows[0]) : null;
}

async function listRecipes({ output_thing_id, created_by, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM crafting_recipes WHERE 1=1';
  const params = [];
  if (output_thing_id != null) { params.push(output_thing_id); sql += ` AND output_thing_id=$${params.length}`; }
  if (created_by != null) { params.push(created_by); sql += ` AND created_by=$${params.length}`; }
  params.push(limit); sql += ` ORDER BY path_rank ASC, updated_at DESC LIMIT $${params.length}`;
  params.push(offset); sql += ` OFFSET $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows.map(rowToRecipe);
}

async function findRecipesForOutput(outputThingId, limit = 20) {
  const r = await pool.query(
    `SELECT * FROM crafting_recipes WHERE output_thing_id=$1 ORDER BY path_rank ASC LIMIT $2`,
    [outputThingId, limit]
  );
  return r.rows.map(rowToRecipe);
}

async function updateRecipe(id, { name, description, input_things_json, operations_json, total_cost_estimate, total_time_estimate, path_rank, recipe_data_json }) {
  const r = await pool.query(
    `UPDATE crafting_recipes SET name=COALESCE($2,name), description=COALESCE($3,description),
     input_things_json=COALESCE($4,input_things_json), operations_json=COALESCE($5,operations_json),
     total_cost_estimate=COALESCE($6,total_cost_estimate), total_time_estimate=COALESCE($7,total_time_estimate),
     path_rank=COALESCE($8,path_rank), recipe_data_json=COALESCE($9,recipe_data_json),
     updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, name, description, input_things_json, operations_json, total_cost_estimate, total_time_estimate, path_rank, recipe_data_json]
  );
  return r.rows[0] ? rowToRecipe(r.rows[0]) : null;
}

async function rerankRecipes(outputThingId) {
  const r = await pool.query(
    `SELECT id FROM crafting_recipes WHERE output_thing_id=$1 ORDER BY total_cost_estimate ASC, total_time_estimate ASC`,
    [outputThingId]
  );
  const ranks = r.rows.map((row, i) => [row.id, i + 1]);
  for (const [id, rank] of ranks) {
    await pool.query(`UPDATE crafting_recipes SET path_rank=$2, updated_at=NOW() WHERE id=$1`, [id, rank]);
  }
}

async function deleteRecipe(id) {
  await pool.query(`DELETE FROM crafting_recipes WHERE id=$1`, [id]);
}

// ── crafting_operations ───────────────────────────────────────────────────────

async function createOperation({ recipe_id, operation_type, requirements_json, duration_min, skill_level, operation_order }) {
  const r = await pool.query(
    `INSERT INTO crafting_operations (recipe_id, operation_type, requirements_json, duration_min, skill_level, operation_order)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [recipe_id, operation_type, requirements_json || {}, duration_min || 0, skill_level || 1, operation_order || 0]
  );
  return r.rows[0];
}

async function listOperationsByRecipe(recipeId) {
  const r = await pool.query(
    `SELECT * FROM crafting_operations WHERE recipe_id=$1 ORDER BY operation_order ASC`,
    [recipeId]
  );
  return r.rows;
}

async function deleteOperationsByRecipe(recipeId) {
  await pool.query(`DELETE FROM crafting_operations WHERE recipe_id=$1`, [recipeId]);
}

// ── crafting_workbenches ──────────────────────────────────────────────────────

async function createWorkbench({ user_id, name, location_json, tools_available, skill_profile, budget_range_json, time_constraints_json, preferences_json }) {
  // Deactivate any existing active workbench for this user
  await pool.query(`UPDATE crafting_workbenches SET is_active=FALSE WHERE user_id=$1 AND is_active=TRUE`, [user_id]);
  const r = await pool.query(
    `INSERT INTO crafting_workbenches (user_id, name, location_json, tools_available, skill_profile, budget_range_json, time_constraints_json, preferences_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [user_id, name || 'My Workbench', location_json || {}, tools_available || [], skill_profile || 'diy',
     budget_range_json || {}, time_constraints_json || {}, preferences_json || {}]
  );
  return rowToWorkbench(r.rows[0]);
}

async function getWorkbenchById(id) {
  const r = await pool.query(`SELECT * FROM crafting_workbenches WHERE id=$1`, [id]);
  return r.rows[0] ? rowToWorkbench(r.rows[0]) : null;
}

async function getActiveWorkbenchByUser(userId) {
  const r = await pool.query(
    `SELECT * FROM crafting_workbenches WHERE user_id=$1 AND is_active=TRUE`,
    [userId]
  );
  return r.rows[0] ? rowToWorkbench(r.rows[0]) : null;
}

async function listWorkbenchesByUser(userId) {
  const r = await pool.query(
    `SELECT * FROM crafting_workbenches WHERE user_id=$1 ORDER BY is_active DESC, updated_at DESC`,
    [userId]
  );
  return r.rows.map(rowToWorkbench);
}

async function updateWorkbench(id, { name, location_json, tools_available, skill_profile, budget_range_json, time_constraints_json, preferences_json, is_active }) {
  // If setting active, deactivate others for same user
  if (is_active === true) {
    const bench = await getWorkbenchById(id);
    if (bench) await pool.query(`UPDATE crafting_workbenches SET is_active=FALSE WHERE user_id=$1 AND id!=$2`, [bench.user_id, id]);
  }
  const r = await pool.query(
    `UPDATE crafting_workbenches SET name=COALESCE($2,name), location_json=COALESCE($3,location_json),
     tools_available=COALESCE($4,tools_available), skill_profile=COALESCE($5,skill_profile),
     budget_range_json=COALESCE($6,budget_range_json), time_constraints_json=COALESCE($7,time_constraints_json),
     preferences_json=COALESCE($8,preferences_json), is_active=COALESCE($9,is_active),
     updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, name, location_json, tools_available, skill_profile, budget_range_json, time_constraints_json, preferences_json, is_active]
  );
  return r.rows[0] ? rowToWorkbench(r.rows[0]) : null;
}

async function deleteWorkbench(id) {
  await pool.query(`DELETE FROM crafting_workbenches WHERE id=$1`, [id]);
}

// ── crafting_assemblies ───────────────────────────────────────────────────────

async function createAssembly({ project_id, name, sub_things_json, recipe_graph_json, total_cost, total_time, shopping_lists_json, created_by }) {
  const r = await pool.query(
    `INSERT INTO crafting_assemblies (project_id, name, sub_things_json, recipe_graph_json, total_cost, total_time, shopping_lists_json, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [project_id, name, sub_things_json || [], recipe_graph_json || {}, total_cost || 0, total_time || 0, shopping_lists_json || [], created_by]
  );
  return rowToAssembly(r.rows[0]);
}

async function getAssemblyById(id) {
  const r = await pool.query(`SELECT * FROM crafting_assemblies WHERE id=$1`, [id]);
  return r.rows[0] ? rowToAssembly(r.rows[0]) : null;
}

async function listAssemblies({ project_id, created_by, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM crafting_assemblies WHERE 1=1';
  const params = [];
  if (project_id != null) { sql += ' AND project_id=$' + (params.push(project_id) + 1); }
  if (created_by != null) { sql += ' AND created_by=$' + (params.push(created_by) + 1); }
  sql += ` ORDER BY updated_at DESC LIMIT $${params.push(limit) + 1} OFFSET $${params.push(offset) + 1}`;
  const r = await pool.query(sql, params);
  return r.rows.map(rowToAssembly);
}

async function updateAssembly(id, { name, sub_things_json, recipe_graph_json, total_cost, total_time, shopping_lists_json }) {
  const r = await pool.query(
    `UPDATE crafting_assemblies SET name=COALESCE($2,name), sub_things_json=COALESCE($3,sub_things_json),
     recipe_graph_json=COALESCE($4,recipe_graph_json), total_cost=COALESCE($5,total_cost),
     total_time=COALESCE($6,total_time), shopping_lists_json=COALESCE($7,shopping_lists_json),
     updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, name, sub_things_json, recipe_graph_json, total_cost, total_time, shopping_lists_json]
  );
  return r.rows[0] ? rowToAssembly(r.rows[0]) : null;
}

async function deleteAssembly(id) {
  await pool.query(`DELETE FROM crafting_assemblies WHERE id=$1`, [id]);
}

// ── recipe search for workbench context ──────────────────────────────────────

// ── crafting_recognition_logs ─────────────────────────────────────────────────

async function logRecognition({ thing_id, user_id, source_type, raw_properties_json, confidence, status = 'pending' }) {
  const r = await pool.query(
    `INSERT INTO crafting_recognition_logs (thing_id, user_id, source_type, raw_properties_json, confidence, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [thing_id, user_id, source_type, raw_properties_json || {}, confidence || 0.5, status]
  );
  return r.rows[0];
}

async function listRecognitionLogs({ thing_id, user_id, source_type, limit = 50 } = {}) {
  let sql = 'SELECT * FROM crafting_recognition_logs WHERE 1=1';
  const params = [];
  if (thing_id != null) { params.push(thing_id); sql += ` AND thing_id=$${params.length}`; }
  if (user_id != null) { params.push(user_id); sql += ` AND user_id=$${params.length}`; }
  if (source_type) { params.push(source_type); sql += ` AND source_type=$${params.length}`; }
  params.push(limit); sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function deleteRecognitionLogsByThing(thingId) {
  await pool.query(`DELETE FROM crafting_recognition_logs WHERE thing_id=$1`, [thingId]);
}

// ── recipe search for workbench context ──────────────────────────────────────

async function searchRecipesByTool(toolNames, limit = 30) {
  // Find recipes whose operations require tools that overlap with given tool names
  const r = await pool.query(
    `SELECT r.*, o.requirements_json
     FROM crafting_recipes r
     JOIN crafting_operations o ON o.recipe_id = r.id
     WHERE o.requirements_json ? 'tools'
     LIMIT $1`,
    [limit]
  );
  return r.rows.map(rowToRecipe);
}

module.exports = {
  // Things
  createThing, getThingById, listThings, updateThing, deleteThing,
  // Recipes
  createRecipe, getRecipeById, listRecipes, findRecipesForOutput, updateRecipe, rerankRecipes, deleteRecipe,
  // Operations
  createOperation, listOperationsByRecipe, deleteOperationsByRecipe,
  // Workbenches
  createWorkbench, getWorkbenchById, getActiveWorkbenchByUser, listWorkbenchesByUser, updateWorkbench, deleteWorkbench,
  // Assemblies
  createAssembly, getAssemblyById, listAssemblies, updateAssembly, deleteAssembly,
  // Recognition logs
  logRecognition, listRecognitionLogs, deleteRecognitionLogsByThing,
  // Search
  searchRecipesByTool,
};