/**
 * Owns: /api/crafting/sourcing/* — Recipe Graph Solver + Sourcing API.
 * Does NOT own: sourcing logic (services/sourcing-engine.js), crafting CRUD (db/crafting.js).
 *
 * Generates ranked recipe paths from retail, secondary market, and fabrication sources.
 * Each sourced result is a ranked recipe path against workbench constraints.
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const { getThingById, getActiveWorkbenchByUser, getWorkbenchById, findRecipesForOutput } = require('../db/crafting');
const { generateRecipePaths } = require('../services/crafting-engine');
const {
  sourceRetail, sourceSecondaryMarket, sourceFabrication,
  rankSources, buildModificationRecipe, optimizeAssemblySourcing, generateSourcedPaths,
} = require('../services/sourcing-engine');

// ── helpers ───────────────────────────────────────────────────────────────────

function parseBody(req, fields) {
  const out = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) out[f] = req.body[f];
  }
  return out;
}

// ── Sourcing Search ────────────────────────────────────────────────────────────

// POST /api/crafting/sourcing/search
// Search all source channels for a query term, ranked by workbench constraints.
// Body: { query, channels: ['retail','secondary','fabrication'], weights: {...} }
router.post('/search', authMiddleware, async (req, res) => {
  try {
    const { query, channels = ['retail', 'secondary', 'fabrication'], weights, workbench_id } = req.body;
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'query must be at least 2 characters' });
    }

    const workbench = workbench_id
      ? await getWorkbenchById(parseInt(workbench_id))
      : await getActiveWorkbenchByUser(req.userId);

    const results = { retail: [], secondary: [], fabrication: [], ranked: [] };
    const parallel = [];

    if (channels.includes('retail')) {
      parallel.push(
        sourceRetail(query, workbench, {
          homeDepotKey: process.env.HOME_DEPOT_API_KEY,
          lowesKey: process.env.LOWES_API_KEY,
        }).then(r => { results.retail = r; })
      );
    }

    if (channels.includes('secondary')) {
      parallel.push(
        sourceSecondaryMarket(query, workbench).then(r => { results.secondary = r; })
      );
    }

    if (channels.includes('fabrication')) {
      // For fabrication, we need a Thing context — create a temporary one
      parallel.push(
        sourceFabrication({ name: query, properties_json: {} }, workbench).then(r => { results.fabrication = r; })
      );
    }

    await Promise.allSettled(parallel);

    // Merge all sources
    const allSources = [...results.retail, ...results.secondary, ...results.fabrication];
    const ranked = rankSources(allSources, workbench, weights);

    res.json({
      query,
      total_sources: allSources.length,
      by_channel: {
        retail: results.retail.length,
        secondary: results.secondary.length,
        fabrication: results.fabrication.length,
      },
      ranked,
    });
  } catch (err) {
    console.error('[sourcing] search:', err.message);
    res.status(500).json({ error: 'Sourcing search failed' });
  }
});

// GET /api/crafting/sourcing/thing/:thingId
// Source materials/inputs needed to produce a specific thing via recipes.
router.get('/thing/:thingId', authMiddleware, async (req, res) => {
  try {
    const thingId = parseInt(req.params.thingId);
    const thing = await getThingById(thingId);
    if (!thing) return res.status(404).json({ error: 'Thing not found' });

    const { weights, workbench_id } = req.query;
    const workbench = workbench_id
      ? await getWorkbenchById(parseInt(workbench_id))
      : await getActiveWorkbenchByUser(req.userId);

    // Get existing fabrication recipes
    const recipes = await findRecipesForOutput(thingId);
    const existingPaths = recipes.length > 0 ? generateRecipePaths(thing, workbench, recipes) : [];

    // Source new paths for inputs
    const inputQueries = (thing.properties_json?.needed_for || [thing.name]);
    const sourcedPaths = [];

    for (const q of inputQueries.slice(0, 3)) {
      const paths = await generateSourcedPaths(
        { name: q, properties_json: thing.properties_json },
        workbench,
        { homeDepotKey: process.env.HOME_DEPOT_API_KEY, lowesKey: process.env.LOWES_API_KEY, ebayToken: process.env.EBAY_ACCESS_TOKEN }
      );
      sourcedPaths.push(...paths);
    }

    // Merge and rank all paths
    const rankedPaths = rankSources(sourcedPaths, workbench, weights ? JSON.parse(weights) : {});

    res.json({
      thing,
      existing_recipe_paths: existingPaths.filter(p => p.viable),
      sourced_paths: rankedPaths,
      recipe_types: {
        retail: rankedPaths.filter(p => p.path_type === 'retail').length,
        secondary: rankedPaths.filter(p => p.path_type === 'secondary').length,
        fabrication: rankedPaths.filter(p => p.path_type === 'fabrication').length,
        modification: rankedPaths.filter(p => p.is_modification).length,
      },
    });
  } catch (err) {
    console.error('[sourcing] thing/:id:', err.message);
    res.status(500).json({ error: 'Failed to source thing' });
  }
});

// GET /api/crafting/sourcing/retail
// Direct retail search with channel filter.
router.get('/retail', authMiddleware, async (req, res) => {
  try {
    const { query, channels = 'home_depot,lowes', limit = 10 } = req.query;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const workbench = await getActiveWorkbenchByUser(req.userId);
    const channelList = channels.split(',');

    const results = [];
    if (channelList.includes('home_depot')) {
      const hd = await sourceRetail(query, workbench, { homeDepotKey: process.env.HOME_DEPOT_API_KEY });
      results.push(...hd);
    }
    if (channelList.includes('lowes')) {
      const lw = await sourceRetail(query, workbench, { lowesKey: process.env.LOWES_API_KEY });
      results.push(...lw.filter(r => r.channel === 'lowes'));
    }

    const ranked = rankSources(results.slice(0, parseInt(limit)), workbench);
    res.json({ results: ranked });
  } catch (err) {
    console.error('[sourcing] retail:', err.message);
    res.status(500).json({ error: 'Retail search failed' });
  }
});

// GET /api/crafting/sourcing/secondary
// Direct secondary market search.
router.get('/secondary', authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const workbench = await getActiveWorkbenchByUser(req.userId);
    const results = await sourceSecondaryMarket(query, workbench);
    const ranked = rankSources(results, workbench);

    res.json({ results: ranked });
  } catch (err) {
    console.error('[sourcing] secondary:', err.message);
    res.status(500).json({ error: 'Secondary market search failed' });
  }
});

// GET /api/crafting/sourcing/fabrication
// Fabrication sourcing for a thing with workbench tools.
router.get('/fabrication', authMiddleware, async (req, res) => {
  try {
    const { thing_id, thing_name } = req.query;
    const workbench = await getActiveWorkbenchByUser(req.userId);

    let thing = null;
    if (thing_id) {
      thing = await getThingById(parseInt(thing_id));
    }
    if (!thing && thing_name) {
      thing = { name: thing_name, properties_json: {} };
    }
    if (!thing) return res.status(400).json({ error: 'thing_id or thing_name is required' });

    const results = await sourceFabrication(thing, workbench);
    const ranked = rankSources(results, workbench);

    res.json({ results: ranked, workbench_tools: (workbench?.tools_available || []).map(t => t.tool_name || t) });
  } catch (err) {
    console.error('[sourcing] fabrication:', err.message);
    res.status(500).json({ error: 'Fabrication sourcing failed' });
  }
});

// ── Modification Recipes ──────────────────────────────────────────────────────

// POST /api/crafting/sourcing/modify
// Take a sourced item and generate the full modification recipe path.
router.post('/modify', authMiddleware, async (req, res) => {
  try {
    const { source_item, thing_id, thing_name } = req.body;
    if (!source_item) return res.status(400).json({ error: 'source_item is required' });

    const thing = thing_id
      ? await getThingById(parseInt(thing_id))
      : { name: thing_name || 'Item', properties_json: {} };

    const recipe = buildModificationRecipe(source_item, thing);
    const ranked = rankSources([recipe], await getActiveWorkbenchByUser(req.userId));

    res.json({ modification_recipe: ranked[0] });
  } catch (err) {
    console.error('[sourcing] modify:', err.message);
    res.status(500).json({ error: 'Failed to generate modification recipe' });
  }
});

// ── Assembly Optimization ─────────────────────────────────────────────────────

// POST /api/crafting/sourcing/assembly-optimize
// Given multiple sub-things and their source options, produce optimized
// shopping list grouped by retailer with tool/consumable deduplication.
// Body: { sub_things: [{thing_id, sources: [source items]}] }
router.post('/assembly-optimize', authMiddleware, async (req, res) => {
  try {
    const { sub_things } = req.body;
    if (!Array.isArray(sub_things) || sub_things.length === 0) {
      return res.status(400).json({ error: 'sub_things array is required' });
    }

    const workbench = await getActiveWorkbenchByUser(req.userId);

    // Resolve thing names for any IDs
    const resolved = await Promise.all(sub_things.map(async st => {
      let thing = null;
      if (st.thing_id) {
        thing = await getThingById(parseInt(st.thing_id));
      }
      return {
        thing: thing || { name: st.name || 'Unknown', properties_json: st.properties_json || {} },
        sources: st.sources || [],
      };
    }));

    const optimization = optimizeAssemblySourcing(resolved, workbench);
    res.json(optimization);
  } catch (err) {
    console.error('[sourcing] assembly-optimize:', err.message);
    res.status(500).json({ error: 'Assembly optimization failed' });
  }
});

// ── Sourcing Cache ─────────────────────────────────────────────────────────────

// GET /api/crafting/sourcing/cache
// Get cached sourcing results for a query (30-min TTL).
router.get('/cache', authMiddleware, async (req, res) => {
  try {
    const { getSourcingCache, setSourcingCache } = require('../db/sourcing');
    const { query, channels } = req.query;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const cached = await getSourcingCache(req.userId, query, channels);
    if (cached) {
      return res.json({ cached: true, data: cached, age_seconds: Math.floor((Date.now() - new Date(cached.cached_at).getTime()) / 1000) });
    }
    res.json({ cached: false });
  } catch (err) {
    console.error('[sourcing] cache:', err.message);
    res.status(500).json({ error: 'Cache lookup failed' });
  }
});

// POST /api/crafting/sourcing/cache
// Store sourcing results in cache.
router.post('/cache', authMiddleware, async (req, res) => {
  try {
    const { setSourcingCache } = require('../db/sourcing');
    const { query, channels, data } = req.body;
    if (!query || !data) return res.status(400).json({ error: 'query and data are required' });

    await setSourcingCache(req.userId, query, channels, data);
    res.json({ cached: true });
  } catch (err) {
    console.error('[sourcing] cache set:', err.message);
    res.status(500).json({ error: 'Failed to cache results' });
  }
});

// ── Recipe Path Ranking ───────────────────────────────────────────────────────

// GET /api/crafting/sourcing/paths/:thingId
// Generate all recipe paths (fabrication + retail + secondary) for a thing,
// ranked by workbench constraints.
router.get('/paths/:thingId', authMiddleware, async (req, res) => {
  try {
    const thingId = parseInt(req.params.thingId);
    const thing = await getThingById(thingId);
    if (!thing) return res.status(404).json({ error: 'Thing not found' });

    const { weights, workbench_id } = req.query;
    const workbench = workbench_id
      ? await getWorkbenchById(parseInt(workbench_id))
      : await getActiveWorkbenchByUser(req.userId);

    // Existing fabrication/assembly recipes
    const recipes = await findRecipesForOutput(thingId);
    const existingPaths = recipes.length > 0 ? generateRecipePaths(thing, workbench, recipes) : [];

    // Sourced paths
    const sourcedPaths = await generateSourcedPaths(thing, workbench, {
      homeDepotKey: process.env.HOME_DEPOT_API_KEY,
      lowesKey: process.env.LOWES_API_KEY,
      ebayToken: process.env.EBAY_ACCESS_TOKEN,
    });

    // Merge + rank
    const allPaths = [...existingPaths, ...sourcedPaths];
    const w = weights ? JSON.parse(weights) : {};
    const ranked = rankSources(allPaths.map(p => ({
      ...p,
      price: p.total_cost_estimate,
      lead_time_days: Math.ceil((p.total_time_estimate || 0) / 60 / 24),
      skill_level: p.skill_level || 1,
    })), workbench, w);

    res.json({
      thing,
      paths: ranked,
      summary: {
        total: ranked.length,
        viable: ranked.filter(p => p.viable).length,
        by_type: {
          retail: ranked.filter(p => p.path_type === 'retail').length,
          secondary: ranked.filter(p => p.path_type === 'secondary').length,
          fabrication: ranked.filter(p => p.path_type === 'fabrication').length,
          modification: ranked.filter(p => p.is_modification).length,
          recipe: ranked.filter(p => p.recipe_id).length,
        },
      },
    });
  } catch (err) {
    console.error('[sourcing] paths/:id:', err.message);
    res.status(500).json({ error: 'Failed to generate recipe paths' });
  }
});

module.exports = router;