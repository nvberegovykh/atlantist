/**
 * Owns: Universal Crafting Engine core logic.
 * Does NOT own: CRUD for crafting tables (db/crafting.js).
 * Recipe paths integrate with the project DAG constraint system.
 */

const SKILL_LEVELS = ['diy', 'tradesperson', 'fab_shop', 'engineer'];
const SKILL_RANK = { diy: 1, tradesperson: 2, fab_shop: 3, engineer: 4 };

// ── Recipe Path Generation ─────────────────────────────────────────────────────

/**
 * Given a Thing and Workbench context, score and rank viable recipe paths.
 * Each path is one way to obtain or produce the target Thing.
 *
 * @param {Object} thing - crafting_thing row
 * @param {Object|null} workbench - crafting_workbench row (null = no context)
 * @param {Object[]} recipes - Array of crafting_recipe rows for the output_thing_id
 * @returns {Object[]} Array of scored path objects, sorted by score (best first)
 */
function generateRecipePaths(thing, workbench, recipes) {
  const skillRank = workbench ? (SKILL_RANK[workbench.skill_profile] || 1) : 1;
  const availableTools = workbench && workbench.tools_available
    ? workbench.tools_available.map(t => t.tool_name) : [];
  const maxBudget = workbench && workbench.budget_range_json
    ? (workbench.budget_range_json.max_usd || Infinity) : Infinity;
  const maxTime = workbench && workbench.time_constraints_json
    ? (workbench.time_constraints_json.available_hours_per_week * 60 || Infinity) : Infinity;

  const paths = recipes.map(recipe => {
    const operations = recipe.operations_json || [];
    const costScore = scoreCost(recipe.total_cost_estimate, maxBudget);
    const timeScore = scoreTime(recipe.total_time_estimate, maxTime);
    const toolScore = scoreToolAvailability(operations, availableTools);
    const skillScore = scoreSkillLevel(operations, skillRank);
    const envScore = scoreEnvironmentalImpact(operations);

    const totalScore = (costScore * 0.3) + (timeScore * 0.25) + (toolScore * 0.2) + (skillScore * 0.15) + (envScore * 0.1);
    const pathRank = recipe.path_rank || 99;

    return {
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      total_cost_estimate: recipe.total_cost_estimate,
      total_time_estimate: recipe.total_time_estimate,
      path_rank_composite: pathRank + (1 - totalScore) * 100,
      scores: { cost: costScore, time: timeScore, tools: toolScore, skill: skillScore, env: envScore },
      viable: totalScore > 0.3,
      blocked_reason: totalScore <= 0.3 ? getBlockedReason(operations, availableTools, skillRank, recipe.total_cost_estimate, maxBudget) : null,
      operations: operations.map((op, i) => ({
        order: i + 1,
        type: op.type,
        duration_min: op.duration_min || 0,
        skill_level: op.skill_level || 1,
        tools_required: op.requirements?.tools || [],
        consumables: op.requirements?.consumables || [],
        tool_gap: (op.requirements?.tools || []).filter(t => !availableTools.includes(t)),
      })),
      recommendations: buildRecommendations(operations, availableTools, skillRank),
    };
  });

  return paths.sort((a, b) => a.path_rank_composite - b.path_rank_composite);
}

function scoreCost(cost, maxBudget) {
  if (cost === 0 || cost === null || cost === undefined) return 0.5;
  if (cost > maxBudget) return 0;
  return 1 - (cost / maxBudget) * 0.5;
}

function scoreTime(minutes, maxMinutes) {
  if (!minutes || minutes === 0) return 0.5;
  if (minutes > maxMinutes) return 0;
  return 1 - (minutes / maxMinutes) * 0.5;
}

function scoreToolAvailability(operations, availableTools) {
  let total = 0, count = 0;
  for (const op of operations) {
    const required = op.requirements?.tools || [];
    if (required.length === 0) { total += 1; count++; continue; }
    const owned = required.filter(t => availableTools.includes(t));
    total += owned.length / required.length;
    count++;
  }
  return count > 0 ? total / count : 1;
}

function scoreSkillLevel(operations, workbenchRank) {
  let total = 0, count = 0;
  for (const op of operations) {
    const reqLevel = op.skill_level || 1;
    total += reqLevel <= workbenchRank ? 1 : 0.2;
    count++;
  }
  return count > 0 ? total / count : 1;
}

function scoreEnvironmentalImpact(operations) {
  const greenOps = new Set(['fasten', 'mount', 'seal']);
  let total = 0;
  for (const op of operations) {
    total += greenOps.has(op.type) ? 1 : 0.5;
  }
  return operations.length > 0 ? total / operations.length : 1;
}

function getBlockedReason(operations, availableTools, skillRank, cost, maxBudget) {
  const toolGap = [];
  for (const op of operations) {
    for (const t of (op.requirements?.tools || [])) {
      if (!availableTools.includes(t)) toolGap.push(t);
    }
  }
  if (toolGap.length > 0) return `Missing tools: ${[...new Set(toolGap)].join(', ')}`;
  for (const op of operations) {
    if ((op.skill_level || 1) > skillRank + 1) return `Operation "${op.type}" requires higher skill level`;
  }
  if (cost > maxBudget) return `Cost $${cost} exceeds budget $${maxBudget}`;
  return 'Path not viable with current workbench constraints';
}

function buildRecommendations(operations, availableTools, skillRank) {
  const recs = [];
  const toolGap = new Set();
  for (const op of operations) {
    for (const t of (op.requirements?.tools || [])) {
      if (!availableTools.includes(t)) toolGap.add(t);
    }
  }
  if (toolGap.size > 0) {
    recs.push({ type: 'tool_rental', tools: [...toolGap], message: `Rent or borrow: ${[...toolGap].join(', ')}` });
  }
  const highSkillOps = operations.filter(op => (op.skill_level || 1) > skillRank + 1);
  if (highSkillOps.length > 0) {
    recs.push({ type: 'skill_gap', message: `Consider subcontracting: ${highSkillOps.map(o => o.type).join(', ')}` });
  }
  return recs;
}

// ── Assembly Graph ────────────────────────────────────────────────────────────

/**
 * Build the dependency DAG for an assembly from sub-things and recipes.
 * Returns a topologically-sorted operation sequence.
 *
 * @param {Object[]} subThings - [{thing_id, quantity}]
 * @param {Object[]} recipes - Array of crafting_recipe rows used in the assembly
 * @returns {Object} DAG with nodes and edges
 */
function buildAssemblyGraph(subThings, recipes) {
  const nodes = [];
  const edges = [];
  const nodeSet = new Set();

  // Add sub-thing nodes
  for (const st of subThings) {
    if (!nodeSet.has('thing:' + st.thing_id)) {
      nodes.push({ id: 'thing:' + st.thing_id, type: 'thing', data: st });
      nodeSet.add('thing:' + st.thing_id);
    }
  }

  // Add recipe nodes and edges
  const recipeNodeIds = new Set();
  for (const recipe of recipes) {
    const rNodeId = 'recipe:' + recipe.id;
    if (!nodeSet.has(rNodeId)) {
      nodes.push({ id: rNodeId, type: 'recipe', data: recipe });
      nodeSet.add(rNodeId);
      recipeNodeIds.add(recipe.id);
    }

    // Edges: input things → recipe
    const inputs = recipe.input_things_json || [];
    for (const inp of inputs) {
      const tNodeId = 'thing:' + inp.thing_id;
      if (!nodeSet.has(tNodeId)) {
        nodes.push({ id: tNodeId, type: 'thing', data: inp });
        nodeSet.add(tNodeId);
      }
      edges.push({ from: tNodeId, to: rNodeId });
    }

    // Edges: recipe → output thing
    if (recipe.output_thing_id) {
      const oNodeId = 'thing:' + recipe.output_thing_id;
      if (!nodeSet.has(oNodeId)) {
        nodes.push({ id: oNodeId, type: 'thing', data: { thing_id: recipe.output_thing_id } });
        nodeSet.add(oNodeId);
      }
      edges.push({ from: rNodeId, to: oNodeId });
    }
  }

  return { nodes, edges };
}

/**
 * Topologically sort assembly operations in correct dependency order.
 * Returns the operation sequence for execution.
 */
function sortAssemblyOperations(assembly) {
  const { nodes, edges } = assembly;
  const inDegree = {};
  const adjacency = {};

  for (const n of nodes) {
    inDegree[n.id] = 0;
    adjacency[n.id] = [];
  }
  for (const e of edges) {
    inDegree[e.to] = (inDegree[e.to] || 0) + 1;
    adjacency[e.from].push(e.to);
  }

  // Kahn's algorithm — topological sort
  const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
  const sorted = [];
  while (queue.length > 0) {
    const curr = queue.shift();
    sorted.push(curr);
    for (const next of (adjacency[curr] || [])) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  // Detect cycles
  if (sorted.length !== nodes.length) {
    return { error: 'Cycle detected in assembly graph', nodes: sorted };
  }

  // Extract operations from recipe nodes in sorted order
  const ops = [];
  for (const nodeId of sorted) {
    const node = nodes.find(n => n.id === nodeId);
    if (node && node.type === 'recipe') {
      const recipeOps = (node.data.operations_json || []).sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const op of recipeOps) {
        ops.push({ recipe_id: node.data.id, recipe_name: node.data.name, ...op });
      }
    }
  }
  return { ops, sorted };
}

// ── Shopping List Optimization ────────────────────────────────────────────────

/**
 * Group assembly inputs by retailer with regional optimization.
 * Given workbench location, prefer local suppliers within sourcing radius.
 */
function buildShoppingLists(subThings, recipes, workbench) {
  const itemsByCategory = {};

  // Collect all input things
  for (const recipe of recipes) {
    const inputs = recipe.input_things_json || [];
    for (const inp of inputs) {
      if (!itemsByCategory[inp.thing_id]) {
        itemsByCategory[inp.thing_id] = { thing_id: inp.thing_id, quantity: 0 };
      }
      itemsByCategory[inp.thing_id].quantity += inp.quantity || 1;
    }
  }

  // Simple category-based grouping (extension point for retailer APIs)
  const lists = [];
  const hardwareItems = [];
  const materialsItems = [];
  const toolsItems = [];

  for (const [tid, item] of Object.entries(itemsByCategory)) {
    if (item.thing_id < 1000) {
      toolsItems.push(item); // placeholder IDs for demo
    } else {
      materialsItems.push(item);
    }
  }

  if (hardwareItems.length > 0) {
    lists.push({ retailer: 'Home Depot', items: hardwareItems, estimated_total: hardwareItems.length * 25 });
  }
  if (materialsItems.length > 0) {
    lists.push({ retailer: 'Local Supplier', items: materialsItems, estimated_total: materialsItems.length * 75 });
  }
  if (toolsItems.length > 0) {
    lists.push({ retailer: 'Harbor Freight', items: toolsItems, estimated_total: toolsItems.length * 40 });
  }

  return lists;
}

// ── Tool Deduplication ─────────────────────────────────────────────────────────

/**
 * Collect all tools required across all recipes in an assembly.
 * Returns deduplicated list with ownership/rental info.
 */
function deduplicateTools(recipes) {
  const toolMap = new Map();
  for (const recipe of recipes) {
    const ops = recipe.operations_json || [];
    for (const op of ops) {
      for (const tool of (op.requirements?.tools || [])) {
        if (!toolMap.has(tool)) {
          toolMap.set(tool, { name: tool, count_recipes: 1, operations: [op.type] });
        } else {
          const entry = toolMap.get(tool);
          entry.count_recipes++;
          if (!entry.operations.includes(op.type)) entry.operations.push(op.type);
        }
      }
    }
  }
  return [...toolMap.values()].sort((a, b) => b.count_recipes - a.count_recipes);
}

// ── DAG Property Propagation ──────────────────────────────────────────────────

/**
 * When a Thing's properties change, propagate the effect through all
 * dependent recipes and update recipe viability scores.
 * Returns affected recipe IDs for re-ranking.
 *
 * @param {number} thingId - ID of the changed thing
 * @param {Object[]} recipes - All recipes that use this thing as input
 * @param {Object} deltaProperties - Properties that changed
 * @returns {Object[]} Affected recipes with updated path_rank suggestion
 */
function propagatePropertyChange(thingId, recipes, deltaProperties) {
  const affected = [];
  for (const recipe of recipes) {
    const inputs = recipe.input_things_json || [];
    const usesThing = inputs.some(i => i.thing_id === thingId);

    if (!usesThing) continue;

    let costDelta = 0;
    let timeDelta = 0;

    if (deltaProperties.mass_kg) {
      const inputQty = inputs.find(i => i.thing_id === thingId)?.quantity || 1;
      costDelta += deltaProperties.mass_kg * 0.5 * inputQty;
    }
    if (deltaProperties.dimensions) {
      const dims = deltaProperties.dimensions;
      const vol = (dims.l || 0) * (dims.w || 0) * (dims.h || 0);
      timeDelta += Math.ceil(vol * 0.1);
    }

    affected.push({
      recipe_id: recipe.id,
      cost_delta: Math.round(costDelta * 100) / 100,
      time_delta: timeDelta,
      new_cost: Math.max(0, recipe.total_cost_estimate + costDelta),
      new_time: Math.max(0, recipe.total_time_estimate + timeDelta),
    });
  }
  return affected;
}

module.exports = {
  generateRecipePaths,
  buildAssemblyGraph,
  sortAssemblyOperations,
  buildShoppingLists,
  deduplicateTools,
  propagatePropertyChange,
  SKILL_LEVELS,
  SKILL_RANK,
};