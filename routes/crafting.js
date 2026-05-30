/**
 * Owns: /api/crafting/* — Universal Crafting Engine REST API.
 * Does NOT own: recipe generation logic (services/crafting-engine.js).
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const {
  createThing, getThingById, listThings, updateThing, deleteThing,
  createRecipe, getRecipeById, listRecipes, findRecipesForOutput, updateRecipe, deleteRecipe,
  createOperation, listOperationsByRecipe, deleteOperationsByRecipe,
  createWorkbench, getWorkbenchById, getActiveWorkbenchByUser, listWorkbenchesByUser, updateWorkbench, deleteWorkbench,
  createAssembly, getAssemblyById, listAssemblies, updateAssembly, deleteAssembly,
} = require('../db/crafting');
const { generateRecipePaths, buildAssemblyGraph, sortAssemblyOperations, deduplicateTools, buildShoppingLists } = require('../services/crafting-engine');

// ── helpers ──────────────────────────────────────────────────────────────────

function parseBody(req, fields) {
  const out = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) out[f] = req.body[f];
  }
  return out;
}

function requireOwner(res, row, userId) {
  if (!row || row.created_by !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// ── Things ────────────────────────────────────────────────────────────────────

// GET /api/crafting/things
router.get('/things', authMiddleware, async (req, res) => {
  try {
    const { project_id, source_type, limit = 50, offset = 0 } = req.query;
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const things = await listThings({
      project_id: project_id ? parseInt(project_id) : undefined,
      source_type,
      created_by: req.user.id,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json({ things });
  } catch (err) {
    console.error('[crafting] listThings:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to list things: ' + err.message });
  }
});

// GET /api/crafting/things/:id
router.get('/things/:id', authMiddleware, async (req, res) => {
  try {
    const thing = await getThingById(parseInt(req.params.id));
    if (!thing) return res.status(404).json({ error: 'Thing not found' });
    res.json({ thing });
  } catch (err) {
    console.error('[crafting] getThing:', err.message);
    res.status(500).json({ error: 'Failed to get thing' });
  }
});

// POST /api/crafting/things
router.post('/things', authMiddleware, async (req, res) => {
  try {
    const { name, description, properties_json, source_type, source_ref, project_id, is_assembly } =
      parseBody(req, ['name', 'description', 'properties_json', 'source_type', 'source_ref', 'project_id', 'is_assembly']);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const thing = await createThing({
      name, description, properties_json, source_type, source_ref,
      created_by: req.user?.id, project_id: project_id ? parseInt(project_id) : null,
      is_assembly: is_assembly || false,
    });
    res.status(201).json({ thing });
  } catch (err) {
    console.error('[crafting] createThing:', err.message);
    res.status(500).json({ error: 'Failed to create thing' });
  }
});

// PATCH /api/crafting/things/:id
router.patch('/things/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getThingById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Thing not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    const thing = await updateThing(parseInt(req.params.id), parseBody(req, [
      'name', 'description', 'properties_json', 'source_type', 'source_ref', 'is_assembly'
    ]));
    res.json({ thing });
  } catch (err) {
    console.error('[crafting] updateThing:', err.message);
    res.status(500).json({ error: 'Failed to update thing' });
  }
});

// DELETE /api/crafting/things/:id
router.delete('/things/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getThingById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Thing not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    await deleteThing(parseInt(req.params.id));
    res.json({ deleted: true });
  } catch (err) {
    console.error('[crafting] deleteThing:', err.message);
    res.status(500).json({ error: 'Failed to delete thing' });
  }
});

// ── Recipes ───────────────────────────────────────────────────────────────────

// GET /api/crafting/recipes
router.get('/recipes', authMiddleware, async (req, res) => {
  try {
    const { output_thing_id, limit = 50, offset = 0 } = req.query;
    const recipes = await listRecipes({
      output_thing_id: output_thing_id ? parseInt(output_thing_id) : undefined,
      created_by: req.user?.id,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json({ recipes });
  } catch (err) {
    console.error('[crafting] listRecipes:', err.message);
    res.status(500).json({ error: 'Failed to list recipes' });
  }
});

// GET /api/crafting/recipes/:id
router.get('/recipes/:id', authMiddleware, async (req, res) => {
  try {
    const recipe = await getRecipeById(parseInt(req.params.id));
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    const operations = await listOperationsByRecipe(recipe.id);
    res.json({ recipe, operations });
  } catch (err) {
    console.error('[crafting] getRecipe:', err.message);
    res.status(500).json({ error: 'Failed to get recipe' });
  }
});

// POST /api/crafting/recipes
router.post('/recipes', authMiddleware, async (req, res) => {
  try {
    const { name, description, output_thing_id, input_things_json, operations_json,
            total_cost_estimate, total_time_estimate, path_rank, recipe_data_json } =
      parseBody(req, ['name', 'description', 'output_thing_id', 'input_things_json', 'operations_json',
                      'total_cost_estimate', 'total_time_estimate', 'path_rank', 'recipe_data_json']);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const recipe = await createRecipe({
      name, description,
      output_thing_id: output_thing_id ? parseInt(output_thing_id) : null,
      input_things_json, operations_json,
      total_cost_estimate: total_cost_estimate ? parseFloat(total_cost_estimate) : 0,
      total_time_estimate: total_time_estimate ? parseInt(total_time_estimate) : 0,
      path_rank: path_rank ? parseInt(path_rank) : 0,
      recipe_data_json,
      created_by: req.user?.id,
    });
    // Create operation records for each operation in the recipe
    if (operations_json && Array.isArray(operations_json)) {
      for (const op of operations_json) {
        await createOperation({
          recipe_id: recipe.id,
          operation_type: op.type,
          requirements_json: op.requirements || {},
          duration_min: op.duration_min || 0,
          skill_level: op.skill_level || 1,
          operation_order: op.order || 0,
        });
      }
    }
    res.status(201).json({ recipe });
  } catch (err) {
    console.error('[crafting] createRecipe:', err.message);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

// PATCH /api/crafting/recipes/:id
router.patch('/recipes/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getRecipeById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Recipe not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    const recipe = await updateRecipe(parseInt(req.params.id), parseBody(req, [
      'name', 'description', 'input_things_json', 'operations_json',
      'total_cost_estimate', 'total_time_estimate', 'path_rank', 'recipe_data_json'
    ]));
    // If operations_json changed, replace operations
    if (req.body.operations_json) {
      await deleteOperationsByRecipe(recipe.id);
      for (const op of req.body.operations_json) {
        await createOperation({
          recipe_id: recipe.id,
          operation_type: op.type,
          requirements_json: op.requirements || {},
          duration_min: op.duration_min || 0,
          skill_level: op.skill_level || 1,
          operation_order: op.order || 0,
        });
      }
    }
    res.json({ recipe });
  } catch (err) {
    console.error('[crafting] updateRecipe:', err.message);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// DELETE /api/crafting/recipes/:id
router.delete('/recipes/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getRecipeById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Recipe not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    await deleteRecipe(parseInt(req.params.id));
    res.json({ deleted: true });
  } catch (err) {
    console.error('[crafting] deleteRecipe:', err.message);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

// GET /api/crafting/paths/:outputThingId
// Generate viable recipe paths for a Thing given the user's Workbench context.
router.get('/paths/:outputThingId', authMiddleware, async (req, res) => {
  try {
    const outputThingId = parseInt(req.params.outputThingId);
    const thing = await getThingById(outputThingId);
    if (!thing) return res.status(404).json({ error: 'Thing not found' });
    const workbench = await getActiveWorkbenchByUser(req.user?.id);
    const recipes = await findRecipesForOutput(outputThingId);
    const paths = generateRecipePaths(thing, workbench, recipes);
    res.json({ paths });
  } catch (err) {
    console.error('[crafting] generateRecipePaths:', err.message);
    res.status(500).json({ error: 'Failed to generate recipe paths' });
  }
});

// ── Workbenches ────────────────────────────────────────────────────────────────

// GET /api/crafting/workbenches
router.get('/workbenches', authMiddleware, async (req, res) => {
  try {
    const workbenches = await listWorkbenchesByUser(req.user?.id);
    res.json({ workbenches });
  } catch (err) {
    console.error('[crafting] listWorkbenches:', err.message);
    res.status(500).json({ error: 'Failed to list workbenches' });
  }
});

// GET /api/crafting/workbenches/active
router.get('/workbenches/active', authMiddleware, async (req, res) => {
  try {
    const workbench = await getActiveWorkbenchByUser(req.user?.id);
    if (!workbench) return res.status(404).json({ error: 'No active workbench' });
    res.json({ workbench });
  } catch (err) {
    console.error('[crafting] getActiveWorkbench:', err.message);
    res.status(500).json({ error: 'Failed to get workbench' });
  }
});

// POST /api/crafting/workbenches
router.post('/workbenches', authMiddleware, async (req, res) => {
  try {
    const { name, location_json, tools_available, skill_profile, budget_range_json, time_constraints_json, preferences_json } =
      parseBody(req, ['name', 'location_json', 'tools_available', 'skill_profile', 'budget_range_json', 'time_constraints_json', 'preferences_json']);
    const workbench = await createWorkbench({
      user_id: req.user?.id, name, location_json, tools_available, skill_profile,
      budget_range_json, time_constraints_json, preferences_json,
    });
    res.status(201).json({ workbench });
  } catch (err) {
    console.error('[crafting] createWorkbench:', err.message);
    res.status(500).json({ error: 'Failed to create workbench' });
  }
});

// PATCH /api/crafting/workbenches/:id
router.patch('/workbenches/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getWorkbenchById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Workbench not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    const workbench = await updateWorkbench(parseInt(req.params.id), parseBody(req, [
      'name', 'location_json', 'tools_available', 'skill_profile',
      'budget_range_json', 'time_constraints_json', 'preferences_json', 'is_active'
    ]));
    res.json({ workbench });
  } catch (err) {
    console.error('[crafting] updateWorkbench:', err.message);
    res.status(500).json({ error: 'Failed to update workbench' });
  }
});

// DELETE /api/crafting/workbenches/:id
router.delete('/workbenches/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getWorkbenchById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Workbench not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    await deleteWorkbench(parseInt(req.params.id));
    res.json({ deleted: true });
  } catch (err) {
    console.error('[crafting] deleteWorkbench:', err.message);
    res.status(500).json({ error: 'Failed to delete workbench' });
  }
});

// POST /api/crafting/assemblies/preview
// Build a DAG and return topologically-sorted operations + shopping list.
// Payload: { sub_things: [{thing_id, quantity}], recipes: [crafting_recipe rows], workbench_id }
router.post('/assemblies/preview', authMiddleware, async (req, res) => {
  try {
    const { sub_things_json, recipe_ids, workbench_id } = req.body;
    const subThings = sub_things_json || [];
    const recipeIds = recipe_ids || [];

    if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
      return res.status(400).json({ error: 'recipe_ids is required' });
    }

    const recipes = [];
    for (const rid of recipeIds) {
      const r = await getRecipeById(parseInt(rid));
      if (r) recipes.push(r);
    }

    const workbench = workbench_id
      ? await getWorkbenchById(parseInt(workbench_id))
      : await getActiveWorkbenchByUser(req.user?.id);

    const graph = buildAssemblyGraph(subThings, recipes);
    const sorted = sortAssemblyOperations(graph);
    const tools = deduplicateTools(recipes);
    const shoppingLists = buildShoppingLists(subThings, recipes, workbench);

    res.json({ graph, sorted, tools, shopping_lists: shoppingLists });
  } catch (err) {
    console.error('[crafting] assembly/preview:', err.message);
    res.status(500).json({ error: 'Failed to build assembly graph' });
  }
});

// POST /api/crafting/assemblies/:id/build
// Load an existing assembly and rebuild its DAG (re-sorts operations, recalculates shopping list).
router.post('/assemblies/:id/build', authMiddleware, async (req, res) => {
  try {
    const assembly = await getAssemblyById(parseInt(req.params.id));
    if (!assembly) return res.status(404).json({ error: 'Assembly not found' });
    if (!requireOwner(res, assembly, req.user?.id)) return;

    const subThings = assembly.sub_things_json || [];
    const recipeIds = (assembly.recipe_graph_json?.recipe_ids || []);
    if (recipeIds.length === 0) return res.json({ assembly, sorted: { ops: [] }, tools: [], shopping_lists: [] });

    const recipes = [];
    for (const rid of recipeIds) {
      const r = await getRecipeById(parseInt(rid));
      if (r) recipes.push(r);
    }
    const workbench = await getActiveWorkbenchByUser(req.user?.id);
    const graph = buildAssemblyGraph(subThings, recipes);
    const sorted = sortAssemblyOperations(graph);
    const tools = deduplicateTools(recipes);
    const shoppingLists = buildShoppingLists(subThings, recipes, workbench);

    res.json({ assembly, graph, sorted, tools, shopping_lists: shoppingLists });
  } catch (err) {
    console.error('[crafting] assembly/build:', err.message);
    res.status(500).json({ error: 'Failed to build assembly' });
  }
});

// ── Assemblies ────────────────────────────────────────────────────────────────

// GET /api/crafting/assemblies
router.get('/assemblies', authMiddleware, async (req, res) => {
  try {
    const { project_id, limit = 50, offset = 0 } = req.query;
    const assemblies = await listAssemblies({
      project_id: project_id ? parseInt(project_id) : undefined,
      created_by: req.user?.id,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json({ assemblies });
  } catch (err) {
    console.error('[crafting] listAssemblies:', err.message);
    res.status(500).json({ error: 'Failed to list assemblies' });
  }
});

// GET /api/crafting/assemblies/:id
router.get('/assemblies/:id', authMiddleware, async (req, res) => {
  try {
    const assembly = await getAssemblyById(parseInt(req.params.id));
    if (!assembly) return res.status(404).json({ error: 'Assembly not found' });
    res.json({ assembly });
  } catch (err) {
    console.error('[crafting] getAssembly:', err.message);
    res.status(500).json({ error: 'Failed to get assembly' });
  }
});

// POST /api/crafting/assemblies
router.post('/assemblies', authMiddleware, async (req, res) => {
  try {
    const { project_id, name, sub_things_json, recipe_graph_json, total_cost, total_time, shopping_lists_json } =
      parseBody(req, ['project_id', 'name', 'sub_things_json', 'recipe_graph_json', 'total_cost', 'total_time', 'shopping_lists_json']);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const assembly = await createAssembly({
      project_id: project_id ? parseInt(project_id) : null,
      name, sub_things_json, recipe_graph_json,
      total_cost: total_cost ? parseFloat(total_cost) : 0,
      total_time: total_time ? parseInt(total_time) : 0,
      shopping_lists_json,
      created_by: req.user?.id,
    });
    res.status(201).json({ assembly });
  } catch (err) {
    console.error('[crafting] createAssembly:', err.message);
    res.status(500).json({ error: 'Failed to create assembly' });
  }
});

// PATCH /api/crafting/assemblies/:id
router.patch('/assemblies/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getAssemblyById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Assembly not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    const assembly = await updateAssembly(parseInt(req.params.id), parseBody(req, [
      'name', 'sub_things_json', 'recipe_graph_json', 'total_cost', 'total_time', 'shopping_lists_json'
    ]));
    res.json({ assembly });
  } catch (err) {
    console.error('[crafting] updateAssembly:', err.message);
    res.status(500).json({ error: 'Failed to update assembly' });
  }
});

// DELETE /api/crafting/assemblies/:id
router.delete('/assemblies/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await getAssemblyById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Assembly not found' });
    if (!requireOwner(res, existing, req.user?.id)) return;
    await deleteAssembly(parseInt(req.params.id));
    res.json({ deleted: true });
  } catch (err) {
    console.error('[crafting] deleteAssembly:', err.message);
    res.status(500).json({ error: 'Failed to delete assembly' });
  }
});

module.exports = router;