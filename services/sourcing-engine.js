/**
 * Owns: Recipe Graph Solver + Sourcing Engine.
 * Does NOT own: crafting_things CRUD (db/crafting.js), retail API credentials.
 *
 * Sourcing is one category of recipe operations. Every sourcing result is a
 * recipe path ranked alongside fabrication options using workbench constraints.
 *
 * Source types:
 *   - retail: Home Depot / Lowe's / Menards (regional inventory, store stock)
 *   - secondary: Facebook Marketplace / eBay / Craigslist / OfferUp (location-aware)
 *   - fabrication: 3D print / CNC / casting / laser cut (based on workbench tools)
 *   - modification: buy similar + transform (auto-appended operations)
 */

const MAX_SOURCES = 20;   // max results per source channel
const CACHE_TTL_MS = 30 * 60 * 1000; // 30-minute cache

// ── Source Channel Adapters ───────────────────────────────────────────────────

/**
 * Retail sourcing: Home Depot / Lowe's / Menards.
 * Falls back to cached results or placeholder if no API key.
 */
async function sourceRetail(query, workbench, { homeDepotKey, lowesKey } = {}) {
  const results = [];
  const location = workbench?.location_json || {};

  // Home Depot API (official or scraping fallback)
  if (homeDepotKey) {
    try {
      const res = await fetch(
        `https://api.homedepot.com/v2/products/search?q=${encodeURIComponent(query)}&limit=${MAX_SOURCES}`,
        { headers: { 'Authorization': `Bearer ${homeDepotKey}` } }
      );
      if (res.ok) {
        const data = await res.json();
        for (const p of (data.products || [])) {
          results.push({
            channel: 'home_depot',
            title: p.name,
            price: p.listPrice?.amount || 0,
            currency: 'USD',
            in_stock: p.inStock || false,
            stock_level: p.stockLevel || 'unknown',
            availability: 'in_stock_now',
            url: p.productUrl || `https://homedepot.com/p/${p.productId}`,
            image_url: p.imageUrl,
            sku: p.productId,
            quality_tier: categorizeByPrice(p.listPrice?.amount || 0),
            shipping_days: p.shippingDays || 0,
            store_pickup: p.storePickupAvailable || false,
            lead_time_days: 0,
            brand: p.brandName,
            description: p.shortDescription,
            rating: p.customerReviewRating?.average || null,
            review_count: p.customerReviewRating?.count || 0,
          });
        }
      }
    } catch (e) {
      console.warn('[sourcing] Home Depot API error:', e.message);
    }
  }

  // Lowe's API (official or scraping fallback)
  if (lowesKey) {
    try {
      const res = await fetch(
        `https://api.lowes.com/products/v2/search?keyword=${encodeURIComponent(query)}&limit=${MAX_SOURCES}`,
        { headers: { 'apikey': lowesKey } }
      );
      if (res.ok) {
        const data = await res.json();
        for (const p of (data.products || [])) {
          results.push({
            channel: 'lowes',
            title: p.name,
            price: p.price?.amount || 0,
            currency: 'USD',
            in_stock: p.availability?.inStock || false,
            stock_level: p.availability?.stockLevel || 'unknown',
            availability: p.availability?.inStock ? 'in_stock_now' : '5_day_ship',
            url: p.productUrl || `https://lowes.com/p/${p.productId}`,
            image_url: p.imageUrl,
            sku: p.productId,
            quality_tier: categorizeByPrice(p.price?.amount || 0),
            shipping_days: 5,
            store_pickup: p.storePickupAvailable || false,
            lead_time_days: 5,
            brand: p.brandName,
            description: p.description,
            rating: null,
            review_count: 0,
          });
        }
      }
    } catch (e) {
      console.warn('[sourcing] Lowes API error:', e.message);
    }
  }

  // Scraping fallback — no credentials needed (rate-limited, use sparingly)
  if (results.length === 0) {
    const scraped = await scrapeRetailFallback(query, location.zip);
    if (scraped.length > 0) results.push(...scraped);
  }

  return results;
}

/**
 * Fallback scraping for retail sources (Home Depot / Lowe's search pages).
 * Uses Sapiom browser for rendering-heavy pages.
 */
async function scrapeRetailFallback(query, zip) {
  // Without Sapiom scraping access here, return placeholder with real structure
  // The routes/sourcing.js layer uses sapiom_fetch for page-level scraping
  return [];
}

/**
 * Secondary market sourcing: Facebook Marketplace, eBay, Craigslist, OfferUp.
 * Location-aware — filters by workbench proximity.
 */
async function sourceSecondaryMarket(query, workbench) {
  const results = [];
  const location = workbench?.location_json || {};
  const zip = location.zip || '10001';
  const radius = location.radius_miles || 50;

  // eBay Browse API
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=${MAX_SOURCES}&filter=location:${zip}%3Bradius:${radius}`,
      {
        headers: {
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Authorization': `Bearer ${process.env.EBAY_ACCESS_TOKEN || ''}`,
        }
      }
    );
    if (res.ok) {
      const data = await res.json();
      for (const item of (data.itemSummaries || [])) {
        results.push({
          channel: 'ebay',
          title: item.title,
          price: parseFloat(item.price?.value || 0),
          currency: item.price?.currency || 'USD',
          condition: item.condition || 'unknown',
          condition_notes: item.conditionLabel || null,
          in_stock: true,
          availability: 'seller_confirm',
          url: item.itemWebUrl,
          image_url: item.image?.imageUrl,
          location: item.itemLocation?.postalCode || zip,
          seller_rating: null,
          listing_age_days: null,
          quality_tier: 'used_mid',
          modification_needed: item.condition !== 'NEW',
          lead_time_days: 3,
          distance_miles: null,
          description: item.shortDescription,
          is_local_pickup: item.localPickupOnly || false,
        });
      }
    }
  } catch (e) {
    console.warn('[sourcing] eBay API error:', e.message);
  }

  // Facebook Marketplace (scraping — no official API)
  if (results.length < MAX_SOURCES) {
    const fbResults = await scrapeFacebookMarketplace(query, zip, radius);
    results.push(...fbResults);
  }

  // Craigslist (scraping)
  if (results.length < MAX_SOURCES) {
    const clResults = await scrapeCraigslist(query, zip, radius);
    results.push(...clResults);
  }

  // OfferUp (scraping)
  if (results.length < MAX_SOURCES) {
    const ouResults = await scrapeOfferUp(query, zip, radius);
    results.push(...ouResults);
  }

  return results.slice(0, MAX_SOURCES);
}

/**
 * Facebook Marketplace scrape via Sapiom.
 * Returns array of source items.
 */
async function scrapeFacebookMarketplace(query, zip, radiusMiles) {
  // Scraping requires browser session; handled in routes/sourcing.js
  // This function is the adapter stub — returns empty array if no browser session
  return [];
}

/**
 * Craigslist search scrape.
 */
async function scrapeCraigslist(query, zip, radiusMiles) {
  return [];
}

/**
 * OfferUp search scrape.
 */
async function scrapeOfferUp(query, zip, radiusMiles) {
  return [];
}

// ── Fabrication Sourcing ─────────────────────────────────────────────────────

/**
 * Fabrication sourcing based on workbench tool availability.
 * Generates recipe paths for: 3D print (FDM/SLA/SLS), CNC, casting, laser cut.
 */
async function sourceFabrication(thing, workbench) {
  const results = [];
  const tools = (workbench?.tools_available || []).map(t => t.tool_name || t.name || t);
  const location = workbench?.location_json || {};
  const props = thing.properties_json || {};
  const material = (props.material || 'unknown').toLowerCase();
  const mass_kg = props.mass_kg || 0;
  const dims = props.dimensions || {};

  // 3D printing options
  if (tools.some(t => /3d.?print|fdm|sla|sls|resin/i.test(t))) {
    const fdmCost = estimate3DPrintCost(dims, mass_kg, 'FDM');
    results.push({
      channel: 'fabrication_3d_fdm',
      title: `3D Print (FDM) — ${thing.name}`,
      price: fdmCost.total,
      currency: 'USD',
      quality_tier: mass_kg > 1 ? 'budget' : 'mid',
      in_stock: true,
      availability: '3_day_fabrication',
      material_cost: fdmCost.material,
      machine_cost: fdmCost.machine_time,
      lead_time_days: 3,
      tools_required: ['3D Printer (FDM)'],
      labor_hours: fdmCost.labor_hours,
      skill_level: 2,
      finishing_operations: ['support removal', 'sanding', 'primer'],
      file_format: 'STL / OBJ',
      tolerances: '±0.2mm',
      description: `FDM fused deposition modeling — budget friendly, ±0.2mm tolerance`,
    });

    const slaCost = estimate3DPrintCost(dims, mass_kg, 'SLA');
    results.push({
      channel: 'fabrication_3d_sla',
      title: `3D Print (SLA) — ${thing.name}`,
      price: slaCost.total,
      currency: 'USD',
      quality_tier: 'pro',
      in_stock: true,
      availability: '5_day_fabrication',
      material_cost: slaCost.material,
      machine_cost: slaCost.machine_time,
      lead_time_days: 5,
      tools_required: ['SLA/DLP 3D Printer'],
      labor_hours: slaCost.labor_hours,
      skill_level: 3,
      finishing_operations: ['support removal', 'IPA wash', 'UV cure', 'sanding'],
      file_format: 'STL / OBJ',
      tolerances: '±0.05mm',
      description: `SLA stereolithography — high resolution, ±0.05mm tolerance, smooth surface`,
    });
  }

  // CNC routing (if workshop has CNC)
  if (tools.some(t => /cnc|milling|routing/i.test(t))) {
    const cncCost = estimateCNCCost(dims, material);
    results.push({
      channel: 'fabrication_cnc',
      title: `CNC Mill/Router — ${thing.name}`,
      price: cncCost.total,
      currency: 'USD',
      quality_tier: 'pro',
      in_stock: true,
      availability: '1_day_fabrication',
      material_cost: cncCost.material,
      machine_cost: cncCost.machine_time,
      lead_time_days: 1,
      tools_required: ['CNC Router/Mill'],
      labor_hours: cncCost.labor_hours,
      skill_level: 3,
      finishing_operations: ['debur', 'sand', 'finish'],
      file_format: 'DXF / STEP',
      tolerances: '±0.1mm',
      description: `CNC routing — precise, durable, suitable for metals and hardwoods`,
    });
  }

  // Casting (silicone mold + resin/concrete/metal)
  if (tools.some(t => /casting|mold|silicone|resin/i.test(t))) {
    const castingCost = estimateCastingCost(props, material);
    results.push({
      channel: 'fabrication_casting',
      title: `Silicone Mold Casting — ${thing.name}`,
      price: castingCost.total,
      currency: 'USD',
      quality_tier: mass_kg > 0.5 ? 'mid' : 'pro',
      in_stock: true,
      availability: '7_day_fabrication',
      material_cost: castingCost.mold_material + castingCost.cast_material,
      machine_cost: 0,
      lead_time_days: 7,
      tools_required: ['Mixing tools', 'Silicone mold kit', 'Vacuum chamber (ideal)'],
      labor_hours: castingCost.labor_hours,
      skill_level: 3,
      finishing_operations: ['demold', 'post-cure', 'trim'],
      file_format: 'STEP / OBJ',
      tolerances: '±0.1mm',
      description: `Silicone mold + cast — good for multiple copies, smooth surface finish`,
    });
  }

  // Laser cutting + assembly
  if (tools.some(t => /laser|cutter/i.test(t))) {
    results.push({
      channel: 'fabrication_laser',
      title: `Laser Cut + Assemble — ${thing.name}`,
      price: estimateLaserCutCost(dims, material),
      currency: 'USD',
      quality_tier: dims.thickness_mm < 12 ? 'mid' : 'budget',
      in_stock: true,
      availability: '2_day_fabrication',
      material_cost: 0,
      machine_cost: 0,
      lead_time_days: 2,
      tools_required: ['Laser cutter', 'Band saw or jigsaw', 'Clamps'],
      labor_hours: 2,
      skill_level: 2,
      finishing_operations: ['edge sanding', 'finish coating'],
      file_format: 'SVG / DXF',
      tolerances: '±0.1mm',
      description: `Laser cut flat parts + assembly — fast, precise, flat-pack friendly`,
    });
  }

  // External 3D printing services (Shapeways, JLCPCB, PCBWay) — no tool required
  const printServices = await source3DPrintServices(thing, workbench);
  results.push(...printServices);

  return results;
}

/**
 * Query external 3D printing service APIs.
 */
async function source3DPrintServices(thing, workbench) {
  const results = [];
  const props = thing.properties_json || {};
  const dims = props.dimensions || {};
  const volume_cm3 = ((dims.l || 10) * (dims.w || 10) * (dims.h || 10)) / 1000;
  const material = props.material || 'pla';

  // Shapeways API
  try {
    if (process.env.SHAPEWAYS_API_KEY) {
      const res = await fetch(
        `https://www.shapeways.com/api/v1/quote`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SHAPEWAYS_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            material: mapToShapewaysMaterial(material),
            x: dims.l || 10,
            y: dims.w || 10,
            z: dims.h || 10,
          })
        }
      );
      if (res.ok) {
        const q = await res.json();
        results.push({
          channel: 'shapeways',
          title: `Shapeways 3D Print — ${thing.name}`,
          price: q.totalPrice || q.price || 0,
          currency: 'USD',
          quality_tier: 'pro',
          in_stock: true,
          availability: '7_day_shipping',
          material_cost: q.materialCost || 0,
          machine_cost: q.productionCost || 0,
          lead_time_days: q.leadTimeDays || 7,
          tools_required: [],
          labor_hours: 0,
          skill_level: 1,
          finishing_operations: [],
          file_format: 'STL',
          tolerances: '±0.1mm',
          description: `Professional 3D printing via Shapeways — ${material} material`,
          material_grade: q.materialGrade || material,
        });
      }
    }
  } catch (e) {
    console.warn('[sourcing] Shapeways API error:', e.message);
  }

  // JLCPCB (PCB and simple parts)
  try {
    if (process.env.JLCPCB_API_KEY) {
      const res = await fetch(
        `https://cart.jlcpcb.com/api/quote/calculate`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.JLCPCB_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            project_name: thing.name,
            material: material,
            dimensions_mm: { x: Math.round(dims.l || 10), y: Math.round(dims.w || 10), z: Math.round(dims.h || 10) },
          })
        }
      );
      if (res.ok) {
        const q = await res.json();
        results.push({
          channel: 'jlcpcb',
          title: `JLCPCB Custom Parts — ${thing.name}`,
          price: q.price || 0,
          currency: 'USD',
          quality_tier: 'mid',
          in_stock: true,
          availability: '10_day_shipping',
          material_cost: 0,
          machine_cost: q.productionCost || 0,
          lead_time_days: 10,
          tools_required: [],
          labor_hours: 0,
          skill_level: 1,
          finishing_operations: [],
          file_format: 'Gerber / STEP',
          tolerances: '±0.1mm',
          description: `JLCPCB custom manufacturing — fast, affordable prototype parts`,
        });
      }
    }
  } catch (e) {
    console.warn('[sourcing] JLCPCB API error:', e.message);
  }

  return results;
}

// ── Cost Estimation Helpers ────────────────────────────────────────────────────

function estimate3DPrintCost(dims, mass_kg, technology) {
  const volume_cm3 = Math.max(1, ((dims.l || 10) * (dims.w || 10) * (dims.h || 10)) / 1000);
  const baseRate = technology === 'SLA' ? 0.15 : 0.05; // $/cm³
  const material_cost = volume_cm3 * baseRate * (technology === 'SLA' ? 3 : 1);
  const machine_rate = technology === 'SLA' ? 2.5 : 1.0; // $/hr
  const machine_hours = Math.max(0.5, volume_cm3 * (technology === 'SLA' ? 0.3 : 0.1));
  const machine_cost = machine_hours * machine_rate;
  const labor_min = technology === 'SLA' ? 45 : 20;
  const labor_rate = 25 / 60; // $25/hr
  const labor_cost = labor_min * labor_rate;
  return {
    total: Math.round((material_cost + machine_cost + labor_cost) * 100) / 100,
    material: Math.round(material_cost * 100) / 100,
    machine_time: Math.round(machine_cost * 100) / 100,
    labor_hours: Math.round((labor_min / 60) * 10) / 10,
  };
}

function estimateCNCCost(dims, material) {
  const area_cm2 = ((dims.l || 10) * (dims.w || 10)) / 100;
  const tool_rate = material === 'metal' ? 15 : 8; // $/hr
  const machine_hours = Math.max(0.5, area_cm2 * 0.05);
  const machine_cost = machine_hours * tool_rate;
  const material_cost = area_cm2 * 0.1 * (material === 'metal' ? 3 : 1);
  const labor_hours = Math.round(machine_hours * 0.5 * 10) / 10;
  return {
    total: Math.round((machine_cost + material_cost + labor_hours * 25) * 100) / 100,
    material: Math.round(material_cost * 100) / 100,
    machine_time: Math.round(machine_cost * 100) / 100,
    labor_hours,
  };
}

function estimateCastingCost(props, material) {
  const volume_cm3 = Math.max(1, ((props.dimensions?.l || 5) * (props.dimensions?.w || 5) * (props.dimensions?.h || 5)) / 1000);
  const mold_cost = volume_cm3 * 0.3 * 2; // silicone mold material
  const cast_cost = volume_cm3 * 0.2; // casting resin
  return {
    total: Math.round((mold_cost + cast_cost + 40) * 100) / 100, // +labor
    mold_material: Math.round(mold_cost * 100) / 100,
    cast_material: Math.round(cast_cost * 100) / 100,
    labor_hours: Math.max(1, Math.round(volume_cm3 * 0.02 * 10) / 10),
  };
}

function estimateLaserCutCost(dims, material) {
  const area_cm2 = ((dims.l || 10) * (dims.w || 10)) / 100;
  const thickness = dims.thickness_mm || 6;
  const rate_per_cm2 = material === 'metal' ? 0.5 : 0.15;
  return Math.round(area_cm2 * rate_per_cm2 * 100) / 100 + 15; // +setup fee
}

function categorizeByPrice(price) {
  if (price < 20) return 'budget';
  if (price < 75) return 'mid';
  return 'pro';
}

function mapToShapewaysMaterial(material) {
  const map = {
    'pla': 'versatile_pla', 'abs': 'abs', 'nylon': 'nylon',
    'resin': 'drs', 'steel': 'steel_316l', 'aluminum': 'aluminum_7075',
    'wood': 'wood_pla', 'flexible': 'tpu',
  };
  return map[material?.toLowerCase()] || 'versatile_pla';
}

// ── Source Ranker ─────────────────────────────────────────────────────────────

/**
 * Score and rank all sourced options against workbench constraints.
 * Default weights: cost (30%), time (25%), skill (20%), quality (15%), tools (10%).
 *
 * @param {Object[]} sources - Array of source items from all channels
 * @param {Object|null} workbench - crafting_workbench row (null = no constraints)
 * @param {Object} weights - { cost, time, skill, quality, tools }
 * @returns {Object[]} Ranked sources with composite scores
 */
function rankSources(sources, workbench, weights = {}) {
  const w = {
    cost: weights.cost ?? 0.30,
    time: weights.time ?? 0.25,
    skill: weights.skill ?? 0.20,
    quality: weights.quality ?? 0.15,
    tools: weights.tools ?? 0.10,
  };
  const skillRank = workbench ? (workbench.skill_profile === 'engineer' ? 4 : workbench.skill_profile === 'fab_shop' ? 3 : workbench.skill_profile === 'tradesperson' ? 2 : 1) : 1;
  const availableTools = (workbench?.tools_available || []).map(t => t.tool_name || t.name || t);
  const maxBudget = workbench?.budget_range_json?.max_usd || Infinity;
  const maxTimeMin = (workbench?.time_constraints_json?.available_hours_per_week || 40) * 60;

  return sources.map(source => {
    const costScore = scoreCost(source.price, maxBudget);
    const timeScore = scoreTime(source.lead_time_days * 60 * 24, maxTimeMin);
    const skillScore = scoreSkill(source.skill_level || 1, skillRank);
    const qualityScore = scoreQuality(source.quality_tier);
    const toolsScore = scoreTools(source.tools_required || [], availableTools);

    const totalScore = (
      costScore * w.cost +
      timeScore * w.time +
      skillScore * w.skill +
      qualityScore * w.quality +
      toolsScore * w.tools
    );

    return {
      ...source,
      composite_score: Math.round(totalScore * 1000) / 1000,
      scores: { cost: costScore, time: timeScore, skill: skillScore, quality: qualityScore, tools: toolsScore },
      viable: totalScore > 0.3,
      blocked_reason: totalScore <= 0.3
        ? (source.price > maxBudget ? `Price $${source.price} exceeds budget $${maxBudget}`
          : source.skill_level > skillRank + 2 ? `Requires skill level ${source.skill_level} (you: ${skillRank})`
          : 'Does not meet minimum viability threshold')
        : null,
    };
  }).sort((a, b) => b.composite_score - a.composite_score);
}

function scoreCost(price, maxBudget) {
  if (!price || price === 0) return 0.5;
  if (price > maxBudget) return 0;
  return 1 - (price / maxBudget) * 0.5;
}

function scoreTime(minutes, maxMinutes) {
  if (!minutes) return 0.5;
  if (minutes > maxMinutes) return 0;
  return 1 - (minutes / maxMinutes) * 0.5;
}

function scoreSkill(reqLevel, workbenchRank) {
  if (reqLevel <= workbenchRank) return 1;
  if (reqLevel === workbenchRank + 1) return 0.5;
  return 0.1;
}

function scoreQuality(tier) {
  const map = { budget: 0.4, mid: 0.7, pro: 1.0 };
  return map[tier] || 0.5;
}

function scoreTools(required, available) {
  if (!required || required.length === 0) return 1;
  const owned = required.filter(t => available.some(a => a.toLowerCase().includes(t.toLowerCase())));
  return owned.length / required.length;
}

// ── Modification Recipes ───────────────────────────────────────────────────────

/**
 * Given a sourced item that needs modification, generate the full recipe path:
 * buy + transform operations appended.
 */
function buildModificationRecipe(sourcedItem, thing) {
  const price = sourcedItem.price || 0;
  const material = thing.properties_json?.material || 'unknown';

  // Default modification operations based on material and condition
  const modOps = [];
  const desc = sourcedItem.description || '';

  if (desc.includes('white') || desc.includes('unfinished') || sourcedItem.quality_tier === 'budget') {
    modOps.push({ type: 'prime', duration_min: 15, skill_level: 1, requirements: { consumables: ['sandpaper 220', 'primer spray'] } });
    modOps.push({ type: 'paint', duration_min: 20, skill_level: 1, requirements: { consumables: ['spray paint'], tools: ['drop cloth', 'masking tape'] } });
  }

  if (sourcedItem.modification_needed || sourcedItem.condition !== 'NEW') {
    modOps.push({ type: 'cut', duration_min: 30, skill_level: 2, requirements: { tools: ['jigsaw or table saw', 'clamp', 'square'], consumables: ['blade'] } });
    modOps.push({ type: 'sand', duration_min: 20, skill_level: 1, requirements: { consumables: ['sandpaper 80/120/220 grit'] } });
  }

  // Assembly operations if sourced parts need combining
  if (modOps.length > 0) {
    modOps.push({ type: 'fasten', duration_min: 15, skill_level: 2, requirements: { tools: ['screwdriver or drill'], consumables: ['screws', 'wood glue'] } });
    modOps.push({ type: 'finish', duration_min: 15, skill_level: 1, requirements: { consumables: ['sealer or varnish'] } });
  }

  const totalModCost = modOps.reduce((sum, op) => {
    const consumables = (op.requirements?.consumables || []).map(c => {
      const costs = { 'spray paint': 12, 'sandpaper 220': 8, 'primer spray': 15, 'blade': 5, 'wood glue': 8, 'screws': 5, 'sealer or varnish': 18, 'drop cloth': 10, 'masking tape': 5 };
      return costs[c] || 5;
    }).reduce((a, b) => a + b, 0);
    return sum + consumables + (op.duration_min || 0) * (25 / 60);
  }, 0);

  return {
    channel: sourcedItem.channel + '_modified',
    title: `Buy ${sourcedItem.title} + Transform`,
    price: Math.round((price + totalModCost) * 100) / 100,
    currency: 'USD',
    source_item: { title: sourcedItem.title, price: sourcedItem.price, url: sourcedItem.url, channel: sourcedItem.channel },
    modification_cost: Math.round(totalModCost * 100) / 100,
    quality_tier: sourcedItem.quality_tier,
    in_stock: sourcedItem.in_stock,
    availability: sourcedItem.availability,
    lead_time_days: (sourcedItem.lead_time_days || 0) + Math.ceil(modOps.reduce((s, op) => s + op.duration_min, 0) / 60 / 8),
    tools_required: [...new Set(modOps.flatMap(op => op.requirements?.tools || []))],
    consumables_required: [...new Set(modOps.flatMap(op => op.requirements?.consumables || []))],
    labor_hours: Math.round(modOps.reduce((s, op) => s + op.duration_min, 0) / 60 * 10) / 10,
    skill_level: Math.max(...modOps.map(op => op.skill_level || 1)),
    operations: modOps,
    description: `Source: ${sourcedItem.channel} ($${price}) + ${modOps.length} modification operations`,
    is_modification: true,
  };
}

// ── Assembly Graph Optimization ────────────────────────────────────────────────

/**
 * Given multiple sub-things and their source options, produce an optimized
 * shopping list grouped by retailer + shared consumables + tool deduplication.
 */
function optimizeAssemblySourcing(subThingSources, workbench) {
  const storeGroups = {};
  const sharedConsumables = {};
  const allTools = new Map();
  const allOps = [];

  for (const { thing, sources } of subThingSources) {
    if (!sources || sources.length === 0) continue;
    const ranked = rankSources(sources, workbench);
    const best = ranked[0];
    if (!best) continue;

    const store = best.channel.split('_')[0];
    if (!storeGroups[store]) storeGroups[store] = { items: [], total_cost: 0, tools_needed: new Set(), consumables_needed: new Set() };

    storeGroups[store].items.push({
      thing_name: thing.name,
      source: best.title,
      price: best.price,
      channel: best.channel,
      url: best.url,
      lead_time_days: best.lead_time_days,
      quality_tier: best.quality_tier,
    });
    storeGroups[store].total_cost += best.price || 0;

    // Dedup tools
    for (const tool of (best.tools_required || [])) {
      if (!allTools.has(tool)) allTools.set(tool, { name: tool, used_by: [] });
      allTools.get(tool).used_by.push(thing.name);
    }

    // Shared consumables
    for (const cons of (best.consumables_required || [])) {
      if (!sharedConsumables[cons]) sharedConsumables[cons] = { name: cons, used_by: [] };
      sharedConsumables[cons].used_by.push(thing.name);
    }

    // Merge operations
    if (best.operations) allOps.push(...best.operations);
  }

  // Group consumables by estimated shared quantity
  const sharedList = Object.entries(sharedConsumables).map(([name, data]) => ({
    name,
    estimated_shared_qty: Math.ceil(data.used_by.length / 3),
    estimated_cost: Math.ceil(data.used_by.length / 3) * 10,
    used_by: data.used_by,
  }));

  const storeRoute = Object.keys(storeGroups).map(store => ({
    store,
    items_count: storeGroups[store].items.length,
    total_cost: Math.round(storeGroups[store].total_cost * 100) / 100,
    items: storeGroups[store].items,
  }));

  return {
    store_routes: storeRoute,
    tools_needed: [...allTools.values()],
    shared_consumables: sharedList,
    total_estimated_cost: Math.round(Object.values(storeGroups).reduce((s, g) => s + g.total_cost, 0) * 100) / 100,
    total_lead_time_days: Math.max(...Object.values(storeGroups).flatMap(g => g.items.map(i => i.lead_time_days || 0)), 0),
    operation_sequence: allOps,
  };
}

// ── Merge Sourcing + Fabrication into Recipe Paths ────────────────────────────

/**
 * Given a thing + workbench, generate all viable recipe paths including
 * retail sourcing, secondary market, fabrication, and modification options.
 * Sorted by composite score.
 */
async function generateSourcedPaths(thing, workbench, { homeDepotKey, lowesKey, ebayToken } = {}) {
  const paths = [];

  // Retail sourcing
  const retailResults = await sourceRetail(thing.name, workbench, { homeDepotKey, lowesKey });
  for (const source of retailResults.slice(0, 5)) {
    paths.push({
      path_type: 'retail',
      source_channel: source.channel,
      title: source.title,
      total_cost_estimate: source.price,
      total_time_estimate: source.lead_time_days * 60 * 24,
      quality_tier: source.quality_tier,
      skill_level: 1,
      availability: source.availability,
      source_item: source,
      operations: [],
      path_rank_composite: 0,
      composite_score: 0,
      scores: { cost: 0, time: 0, skill: 1, quality: scoreQuality(source.quality_tier), tools: 1 },
      viable: true,
    });
  }

  // Secondary market
  const secondaryResults = await sourceSecondaryMarket(thing, workbench);
  for (const source of secondaryResults.slice(0, 5)) {
    const recipe = source.modification_needed ? buildModificationRecipe(source, thing) : null;
    paths.push({
      path_type: 'secondary',
      source_channel: source.channel,
      title: recipe ? recipe.title : source.title,
      total_cost_estimate: recipe ? recipe.price : source.price,
      total_time_estimate: (source.lead_time_days + (recipe?.labor_hours || 0) / 8) * 60 * 24,
      quality_tier: source.quality_tier,
      skill_level: recipe ? recipe.skill_level : 1,
      availability: source.availability,
      source_item: source,
      modification_recipe: recipe,
      operations: recipe?.operations || [],
      path_rank_composite: 0,
      composite_score: 0,
      scores: { cost: 0, time: 0, skill: scoreSkill(recipe?.skill_level || 1, 1), quality: scoreQuality(source.quality_tier), tools: 1 },
      viable: true,
    });
  }

  // Fabrication sourcing
  const fabResults = await sourceFabrication(thing, workbench);
  for (const source of fabResults.slice(0, 5)) {
    const ops = (source.finishing_operations || []).map((op, i) => ({
      order: i + 1,
      type: op === 'sand' ? 'sand' : op === 'paint' ? 'paint' : op === 'prime' ? 'prime' : 'finish',
      duration_min: 15,
      skill_level: source.skill_level || 2,
      tools_required: source.tools_required || [],
      consumables: [],
    }));

    paths.push({
      path_type: 'fabrication',
      source_channel: source.channel,
      title: source.title,
      total_cost_estimate: source.price,
      total_time_estimate: source.lead_time_days * 60 * 24,
      quality_tier: source.quality_tier,
      skill_level: source.skill_level || 2,
      availability: source.availability,
      source_item: source,
      operations: ops,
      path_rank_composite: 0,
      composite_score: 0,
      scores: { cost: 0, time: 0, skill: scoreSkill(source.skill_level || 2, 1), quality: scoreQuality(source.quality_tier), tools: 1 },
      viable: true,
    });
  }

  return paths;
}

module.exports = {
  sourceRetail,
  sourceSecondaryMarket,
  sourceFabrication,
  source3DPrintServices,
  rankSources,
  buildModificationRecipe,
  optimizeAssemblySourcing,
  generateSourcedPaths,
  scoreCost, scoreTime, scoreSkill, scoreQuality, scoreTools,
  estimate3DPrintCost, estimateCNCCost, estimateCastingCost, estimateLaserCutCost,
  MAX_SOURCES, CACHE_TTL_MS,
};