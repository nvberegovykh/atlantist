/**
 * Owns: Universal input layer for the Crafting System.
 * Converts any source (BIM model, image, URL, PDF, voice/text, asset store)
 * into a structured crafting_things record with confidence scores.
 * Does NOT own: crafting_things CRUD (db/crafting.js).
 */

// ── Material Taxonomy ──────────────────────────────────────────────────────────
// Normalizes "plastic" vs "resin" vs "polymer" → standard material codes.
// Extensible — add entries as the taxonomy grows.

const MATERIAL_TAXONOMY = {
  // Plastics / Polymers
  abs: { family: 'thermoplastic', density_gcm3: 1.04, tensile_mpa: 40, uv_resistance: 'poor', paintable: true },
  acrylic: { family: 'thermoplastic', density_gcm3: 1.18, tensile_mpa: 70, uv_resistance: 'fair', paintable: true },
  hdpe: { family: 'thermoplastic', density_gcm3: 0.95, tensile_mpa: 20, uv_resistance: 'fair', paintable: false },
  polycarbonate: { family: 'thermoplastic', density_gcm3: 1.20, tensile_mpa: 65, uv_resistance: 'good', paintable: true },
  polystyrene: { family: 'thermoplastic', density_gcm3: 1.05, tensile_mpa: 45, uv_resistance: 'poor', paintable: true },
  pvc: { family: 'thermoplastic', density_gcm3: 1.38, tensile_mpa: 50, uv_resistance: 'good', paintable: true },
  resin: { family: 'thermoset', density_gcm3: 1.10, tensile_mpa: 55, uv_resistance: 'fair', paintable: true },
  polypropylene: { family: 'thermoplastic', density_gcm3: 0.90, tensile_mpa: 30, uv_resistance: 'fair', paintable: false },
  // Natural / Stone
  wood: { family: 'natural', density_gcm3: 0.60, tensile_mpa: 100, uv_resistance: 'poor', paintable: true },
  stone: { family: 'mineral', density_gcm3: 2.70, tensile_mpa: 150, uv_resistance: 'excellent', paintable: false },
  marble: { family: 'mineral', density_gcm3: 2.72, tensile_mpa: 140, uv_resistance: 'excellent', paintable: false },
  granite: { family: 'mineral', density_gcm3: 2.75, tensile_mpa: 180, uv_resistance: 'excellent', paintable: false },
  concrete: { family: 'mineral', density_gcm3: 2.40, tensile_mpa: 30, uv_resistance: 'excellent', paintable: true },
  // Metals
  aluminum: { family: 'metal', density_gcm3: 2.70, tensile_mpa: 270, uv_resistance: 'excellent', paintable: true },
  steel: { family: 'metal', density_gcm3: 7.85, tensile_mpa: 450, uv_resistance: 'excellent', paintable: true },
  'stainless-steel': { family: 'metal', density_gcm3: 7.90, tensile_mpa: 500, uv_resistance: 'excellent', paintable: true },
  brass: { family: 'metal', density_gcm3: 8.50, tensile_mpa: 380, uv_resistance: 'excellent', paintable: true },
  copper: { family: 'metal', density_gcm3: 8.96, tensile_mpa: 220, uv_resistance: 'excellent', paintable: true },
  cast_iron: { family: 'metal', density_gcm3: 7.20, tensile_mpa: 180, uv_resistance: 'excellent', paintable: true },
  // Composites / Ceramics / Glass
  glass: { family: 'ceramic', density_gcm3: 2.50, tensile_mpa: 70, uv_resistance: 'excellent', paintable: false },
  ceramic: { family: 'ceramic', density_gcm3: 2.40, tensile_mpa: 200, uv_resistance: 'excellent', paintable: false },
  fiberglass: { family: 'composite', density_gcm3: 1.80, tensile_mpa: 350, uv_resistance: 'good', paintable: true },
  carbon_fiber: { family: 'composite', density_gcm3: 1.60, tensile_mpa: 600, uv_resistance: 'good', paintable: false },
  drywall: { family: 'composite', density_gcm3: 0.80, tensile_mpa: 5, uv_resistance: 'poor', paintable: true },
  mdf: { family: 'composite', density_gcm3: 0.75, tensile_mpa: 18, uv_resistance: 'none', paintable: true },
  plywood: { family: 'composite', density_gcm3: 0.55, tensile_mpa: 50, uv_resistance: 'poor', paintable: true },
};

// Mounting method normalization
const MOUNT_TAXONOMY = {
  'wall-mounted': { method: 'wall_mount', anchor_required: true, wall_type: 'any' },
  'ceiling-mounted': { method: 'ceiling_mount', anchor_required: true, anchor_type: 'toggle_bolt' },
  'floor-standing': { method: 'floor_mount', anchor_required: false, base_required: true },
  'floor-standing-weighted': { method: 'floor_mount', anchor_required: false, base_required: true, weighted: true },
  'surface-mount': { method: 'surface_mount', anchor_required: false, adhesive: true },
  'recessed': { method: 'recessed', anchor_required: false, requires_cavity: true },
  'pendant': { method: 'pendant_mount', anchor_required: true, canopy_required: true },
  'clamp': { method: 'clamp_mount', anchor_required: false, surface_thickness_range: '0.5-2in' },
  'freestanding': { method: 'freestanding', anchor_required: false, base_required: true },
  'bolted': { method: 'bolt_mount', anchor_required: true, bolt_spec: 'hardware_included' },
};

// ── OpenAI client ─────────────────────────────────────────────────────────────

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) return null;
  const { OpenAI } = require('openai');
  return new OpenAI({ apiKey });
}

// ── Property Normalization ─────────────────────────────────────────────────────

/**
 * Normalize a raw property value to the standard Thing schema.
 * Maps colloquial materials → canonical material codes with property values.
 * Maps colloquial dimensions → {l_cm, w_cm, h_cm}.
 * Maps colloquial weight → estimated mass_kg with tolerance.
 */
function normalizeProperties(raw) {
  const normalized = {
    dimensions: null,    // { l_cm, w_cm, h_cm }
    mass_kg: null,       // float
    material: null,     // canonical material code
    material_props: null,// { family, density_gcm3, tensile_mpa, uv_resistance, paintable }
    finish: null,        // surface finish string
    mounting: null,      // canonical mounting code
    mounting_props: null,
    discipline: null,    // architectural | structural | mechanical | electrical | plumbing | fire
    attachment_type: null, // bolt | weld | adhesive | friction | magnetic | hung
    estimated_price_usd: null,
    source_confidence: null, // 0.0–1.0
    raw_input: null,     // preserved for user review
    property_confidences: {}, // per-property confidence scores
  };

  // Normalize dimensions (always in cm)
  if (raw.dimensions) {
    const d = raw.dimensions;
    let l, w, h;
    if (typeof d === 'string') {
      // Parse "10x20x30 cm" or "10 x 20 x 30 inches"
      const parts = d.replace(/[^\td.x]/g, ' ').trim().split(/\/*\t+|\/*\//).filter(Boolean);
      if (parts.length >= 3) {
        [l, w, h] = parts.map(Number);
      }
    } else if (typeof d === 'object') {
      l = d.l || d.width || d.l_cm || d.width_cm;
      w = d.w || d.depth || d.w_cm || d.depth_cm;
      h = d.h || d.height || d.h_cm || d.height_cm;
    }
    if (l && w && h) {
      const unit = (typeof d === 'string' && d.match(/inch/)) ? 2.54 : 1;
      normalized.dimensions = {
        l_cm: Math.round(l * unit * 10) / 10,
        w_cm: Math.round(w * unit * 10) / 10,
        h_cm: Math.round(h * unit * 10) / 10,
      };
      normalized.property_confidences.dimensions = raw.dimensions_confidence || 0.9;
    }
  }

  // Normalize weight (always in kg)
  if (raw.mass_kg !== undefined && raw.mass_kg !== null) {
    let val = raw.mass_kg;
    if (typeof val === 'string') {
      const match = val.match(/([\/*0-9.]+)\/*\t*\/*\t*(kg|lbs?|lb|pounds?)/i);
      if (match) {
        val = parseFloat(match[1]);
        if (match[2].toLowerCase().startsWith('lb')) val *= 0.453592;
      }
    }
    if (typeof val === 'number') {
      normalized.mass_kg = Math.round(val * 100) / 100;
      normalized.property_confidences.mass_kg = raw.mass_kg_confidence || 0.85;
    }
  }

  // Estimate mass from dimensions + material if not provided
  if (normalized.dimensions && normalized.material_props && !normalized.mass_kg) {
    const { l_cm, w_cm, h_cm } = normalized.dimensions;
    const vol_cm3 = l_cm * w_cm * h_cm;
    const estMass = (normalized.material_props.density_gcm3 * vol_cm3) / 1000;
    normalized.mass_kg = Math.round(estMass * 100) / 100;
    normalized.property_confidences.mass_kg = 0.6; // estimated, lower confidence
    normalized.mass_estimated = true;
  }

  // Normalize material
  if (raw.material) {
    const mat = (raw.material || '').toLowerCase().replace(/[\/\/\t]/g, ' ').replace(/\bplastic\b/g, 'abs')
      .replace(/\bpolymer\b/g, 'abs').replace(/\bpoly\b/g, 'abs')
      .replace(/\bmild steel\b/g, 'steel').replace(/\bcarbon steel\b/g, 'steel')
      .replace(/\bstainless\b/g, 'stainless-steel').replace(/\bss\b/g, 'stainless-steel')
      .replace(/\bfabric\b/g, 'fiberglass').replace(/\bfrp\b/g, 'fiberglass')
      .replace(/\bplywood\b/g, 'plywood').replace(/\bcomposite\b/g, 'fiberglass')
      .trim();
    if (MATERIAL_TAXONOMY[mat]) {
      normalized.material = mat;
      normalized.material_props = MATERIAL_TAXONOMY[mat];
      normalized.property_confidences.material = raw.material_confidence || 0.85;
    }
  }

  // Normalize finish
  if (raw.finish) {
    normalized.finish = raw.finish.toLowerCase().replace(/\bpolished\b/g, 'polished')
      .replace(/\bmatte\b/g, 'matte').replace(/\bbrushed\b/g, 'brushed')
      .replace(/\blacquered\b/g, 'lacquered').replace(/\banodized\b/g, 'anodized')
      .replace(/\bpowder-coated\b/g, 'powder_coated').replace(/\bpainted\b/g, 'painted')
      .replace(/\bgalvanized\b/g, 'galvanized').replace(/\bchrome\b/g, 'chrome')
      .replace(/\bbrass\b/g, 'brass_finish').replace(/\bgold\b/g, 'gold_finish')
      .replace(/\bsatin\b/g, 'satin').replace(/\bsemi-gloss\b/g, 'semi_gloss').trim();
    normalized.property_confidences.finish = raw.finish_confidence || 0.8;
  }

  // Normalize mounting
  if (raw.mounting) {
    const m = (raw.mounting || '').toLowerCase();
    for (const [key, val] of Object.entries(MOUNT_TAXONOMY)) {
      if (m.includes(key.replace(/-/g, ' '))) {
        normalized.mounting = key;
        normalized.mounting_props = val;
        break;
      }
    }
    if (!normalized.mounting) {
      normalized.mounting = 'wall_mount';
      normalized.mounting_props = { method: 'wall_mount', anchor_required: true };
    }
    normalized.property_confidences.mounting = raw.mounting_confidence || 0.8;
  }

  // Discipline
  if (raw.discipline) {
    const d = (raw.discipline || '').toLowerCase();
    if (d.includes('struct')) normalized.discipline = 'structural';
    else if (d.includes('mech') || d.includes('hvac')) normalized.discipline = 'mechanical';
    else if (d.includes('elec')) normalized.discipline = 'electrical';
    else if (d.includes('plumb')) normalized.discipline = 'plumbing';
    else if (d.includes('fire')) normalized.discipline = 'fire';
    else normalized.discipline = 'architectural';
    normalized.property_confidences.discipline = raw.discipline_confidence || 0.95;
  }

  // Attachment
  if (raw.attachment_type) {
    const at = (raw.attachment_type || '').toLowerCase();
    if (at.includes('bolt')) normalized.attachment_type = 'bolt';
    else if (at.includes('weld')) normalized.attachment_type = 'weld';
    else if (at.includes('adhes') || at.includes('glue')) normalized.attachment_type = 'adhesive';
    else if (at.includes('friction') || at.includes('interference')) normalized.attachment_type = 'friction';
    else if (at.includes('magnet')) normalized.attachment_type = 'magnetic';
    else if (at.includes('hang') || at.includes('suspen')) normalized.attachment_type = 'hung';
    else normalized.attachment_type = 'bolt';
  }

  if (raw.estimated_price_usd) {
    normalized.estimated_price_usd = parseFloat(raw.estimated_price_usd) || null;
  }

  if (raw.source_confidence !== undefined) {
    normalized.source_confidence = parseFloat(raw.source_confidence);
  }

  normalized.raw_input = raw._raw || null;
  return normalized;
}

// ── Input Method Handlers ─────────────────────────────────────────────────────

/**
 * 1. BIM Model Selection — direct from DB, authoritative data.
 * Returns high-confidence (1.0) thing properties.
 */
async function fromBIMModel(elementId) {
  const pool = require('../db/index');
  const r = await pool.query(
    `SELECT id, name, type, level_id, elevation,
            parameters_json, family_type, material, fire_rating,
            width_cm, height_cm, depth_cm, mass_kg
     FROM elements WHERE id=$1`,
    [elementId]
  );
  if (!r.rows.length) throw new Error('BIM element not found: ' + elementId);

  const el = r.rows[0];
  const params = el.parameters_json || {};

  const raw = {
    name: el.name || params.name || el.type,
    dimensions: {
      l_cm: el.width_cm || params.width_cm,
      w_cm: el.depth_cm || params.depth_cm,
      h_cm: el.height_cm || params.height_cm,
    },
    mass_kg: el.mass_kg || params.mass_kg,
    material: el.material || params.material,
    discipline: params.discipline || 'architectural',
    source_confidence: 1.0,
    dimensions_confidence: 1.0,
    mass_kg_confidence: 1.0,
    material_confidence: 1.0,
    _raw: { element_id: elementId, source: 'bim_model' },
  };

  return { name: raw.name, properties: normalizeProperties(raw), source_type: 'bim_model', source_ref: `element:${elementId}` };
}

/**
 * 2. Photograph/Image — AI vision analysis.
 * Accepts: base64 image data or R2 URL.
 * Returns: Thing properties with confidence scores, highlight low-confidence fields.
 */
async function fromImage(imageData, imageMimeType = 'image/jpeg', userPrompt = '') {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY not configured');

  const systemPrompt = `You are a BIM object analyst. Analyze the image and extract properties for a construction/crafting object. Return ONLY valid JSON (no markdown, no explanation) with this exact schema:

{
  "name": "object name",
  "dimensions": { "l_cm": 100, "w_cm": 50, "h_cm": 200 },
  "estimated_mass_kg": 45,
  "material": "steel",
  "material_confidence": 0.7,
  "finish": "powder_coated",
  "finish_confidence": 0.6,
  "mounting": "wall-mounted",
  "mounting_confidence": 0.8,
  "discipline": "architectural",
  "attachment_type": "bolt",
  "object_type": "lighting_fixture",
  "reasoning": "brief explanation of your choices"
}

Rules:
- dimensions: estimate from visible reference objects (doors are ~200cm, humans ~170cm). Return in centimeters.
- material_confidence: rate 0.3–1.0 based on visual clarity (0.3 = blurry/hard to tell, 1.0 = clearly visible texture)
- finish_confidence: rate 0.3–1.0 (matte vs glossy can be hard to distinguish in photos)
- mounting_confidence: rate 0.3–1.0
- If the image shows multiple objects, analyze the primary/largest one.
- Use lowercase for all string values.`;

  let imageContent;
  if (imageData.startsWith('data:')) {
    imageContent = imageData; // Already base64 data URI
  } else if (imageData.startsWith('http')) {
    // Fetch and convert to base64 (Node.js 20 has native fetch)
    const resp = await fetch(imageData);
    if (!resp.ok) throw new Error('Failed to fetch image: ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const b64 = buf.toString('base64');
    imageContent = `data:${imageMimeType};base64,${b64}`;
  } else {
    // Raw base64
    imageContent = `data:${imageMimeType};base64,${imageData}`;
  }

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: imageContent, detail: 'high' } },
        ...(userPrompt ? [{ type: 'text', text: `Additional context: ${userPrompt}` }] : []),
      ]},
    ],
    max_tokens: 600,
  });

  const rawText = response.choices[0].message.content.trim();
  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/```json\n?|```\n?/g, ''));
  } catch {
    throw new Error('AI returned non-JSON response: ' + rawText.slice(0, 200));
  }

  const raw = {
    name: parsed.name,
    dimensions: parsed.dimensions,
    mass_kg: parsed.estimated_mass_kg,
    material: parsed.material,
    material_confidence: parsed.material_confidence,
    finish: parsed.finish,
    finish_confidence: parsed.finish_confidence,
    mounting: parsed.mounting,
    mounting_confidence: parsed.mounting_confidence,
    discipline: parsed.discipline,
    attachment_type: parsed.attachment_type,
    source_confidence: Math.min(1, (parsed.material_confidence || 0.7) + (parsed.finish_confidence || 0.6) + (parsed.mounting_confidence || 0.8)) / 3,
    _raw: { ai_response: parsed, reasoning: parsed.reasoning },
  };

  return { name: raw.name, properties: normalizeProperties(raw), source_type: 'image', source_ref: null };
}

/**
 * 3. URL Paste — scrape retail/product pages and extract Thing properties.
 * Supports: Amazon, eBay, AliExpress, Home Depot, IKEA, any product page.
 * Returns: structured Thing with confidence scores per field.
 */
async function fromURL(url) {
  // Detect URL patterns for known retailers
  const retailerPatterns = [
    { name: 'amazon', pattern: /amazon\/(?:.*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})/i, extractId: (u) => u.match(/dp\/([A-Z0-9]{10})/)?.[1] },
    { name: 'homedepot', pattern: /homedepot\/.*(?:p|product)\/.*\/([0-9]+)/i, extractId: (u) => u.match(/\/([0-9]+)\/.*\/(?:p|product)/)?.[1] },
    { name: 'ikea', pattern: /ikea\/(?:.*\/)?([a-z]{2}\/.*\/[0-9]+)/i, extractId: (u) => u.match(/\/([0-9]+)\/?$/)?.[1] },
    { name: 'ebay', pattern: /ebay\/(?:.*\/)?(?:itm|item)\/([0-9]+)/i, extractId: (u) => u.match(/itm\/([0-9]+)/)?.[1] },
    { name: 'aliexpress', pattern: /aliexpress\/(?:.*\/)?item\/([0-9]+)/i, extractId: (u) => u.match(/item\/([0-9]+)/)?.[1] },
  ];

  let retailer = 'generic';
  let productId = null;
  for (const rp of retailerPatterns) {
    const m = url.match(rp.pattern);
    if (m) { retailer = rp.name; productId = rp.extractId(url); break; }
  }

  // Scrape the URL (Node.js 20 has native fetch)
  let html = '';
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    html = await resp.text();
  } catch (err) {
    throw new Error('Failed to fetch URL: ' + err.message);
  }

  // Extract structured data
  let name, price, dimensions, weight, material, brand, description, images = [];

  // Try JSON-LD first (most reliable)
  const jsonLdMatch = html.match(/"@type"\\s*:\\s*"Product"[\\S]*?}([\r\n\t]*?}?)/);
  if (jsonLdMatch) {
    try {
      const jsonLdStr = html.match(/<script[^>]*type="application\/json"[^>]*>([\\S]*?)<\/script>/gi)?.[0] || '';
      const ldData = JSON.parse(jsonLdStr.replace(/<[^>]+>/g, ''));
      name = ldData.name;
      price = ldData.offers?.price;
      if (ldData.weight) weight = ldData.weight;
    } catch { /* ignore */ }
  }

  // Fallback: regex-based extraction
  if (!name) {
    const titleMatch = html.match(/<title[^>]*>([^<]{10,200})<\/title>/i);
    if (titleMatch) name = decodeHTMLEntities(titleMatch[1].split('|')[0].split('-')[0].trim());
  }

  // Price extraction
  const priceMatch = html.match(/[\t\n\r]*[$€£]\/?[\/*\t]?[\/*\t]?([0-9,]+\/*\t*[\/*\t]*[0-9]*\/*\t*\/*\t*[0-9]*)/);
  if (priceMatch) {
    const p = parseFloat(priceMatch[1].replace(/[^\/*\t0-9.]/g, ''));
    if (p > 0 && p < 100000) price = p;
  }

  // Dimensions (various formats: "24 x 36 x 12 inches")
  const dimMatch = html.match(/(\b[0-9.]+)\/*\t*\/*\t*[x×]\/*\t*\/*\t*([0-9.]+)\/*\t*\/*\t*[x×]\/*\t*\/*\t*([0-9.]+)\/*\t*\/*\t*(in(?:ches)?|cm|mm)?/i);
  if (dimMatch) {
    const unit = dimMatch[4]?.toLowerCase().startsWith('in') ? 2.54 : 1;
    dimensions = {
      l_cm: Math.round(parseFloat(dimMatch[1]) * unit * 10) / 10,
      w_cm: Math.round(parseFloat(dimMatch[2]) * unit * 10) / 10,
      h_cm: Math.round(parseFloat(dimMatch[3]) * unit * 10) / 10,
    };
  }

  // Weight
  const weightMatch = html.match(/([0-9.]+)\/*\t*\/*\t*\/*\t*(lbs?|pounds?|kg|kilograms?)/i);
  if (weightMatch) {
    const val = parseFloat(weightMatch[1]);
    weight = weightMatch[2].toLowerCase().startsWith('lb') ? val * 0.453592 : val;
  }

  // Brand
  const brandMatch = html.match(/brand["\/\t]*[\t\n\r]*:[\t\n\r]*["']?([^"'\n\r,]{2,50})/i);
  if (brandMatch) brand = brandMatch[1].trim();

  // Meta description
  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]{20,500})"/i);
  if (descMatch) description = decodeHTMLEntities(descMatch[1]);

  // Material from description
  const matPatterns = [
    { regex: /\b(steel|stainless|aluminum|wood|oak|pine|maple|walnut|ceramic|porcelain|marble|granite|glass|acrylic|abs|pvc|polypropylene|fiberglass|concrete|brass|copper|iron)/gi,
      name: (m) => m.toLowerCase() },
  ];
  const descLower = (description || '').toLowerCase();
  for (const mp of matPatterns) {
    const m = descLower.match(mp.regex);
    if (m) { material = mp.name(m[0]); break; }
  }

  const raw = {
    name,
    dimensions,
    mass_kg: weight,
    material,
    estimated_price_usd: price,
    source_confidence: retailer !== 'generic' ? 0.95 : 0.85,
    dimensions_confidence: dimensions ? 0.95 : 0.5,
    mass_kg_confidence: weight ? 0.9 : 0.4,
    material_confidence: material ? 0.85 : 0.5,
    finish_confidence: 0.3,
    mounting_confidence: 0.4,
    discipline_confidence: 0.8,
    _raw: { url, retailer, productId, description: description?.slice(0, 200) },
  };

  return { name: name || 'Unknown Product', properties: normalizeProperties(raw), source_type: 'url', source_ref: url };
}

/**
 * 4. PDF / Document Upload — parse PDF or text document and extract line items.
 * Returns: array of Thing objects (one per extracted line item).
 */
async function fromPDF(buffer) {
  const { PDFDocument } = require('pdf-lib');
  let text = '';
  try {
    const pdfDoc = await PDFDocument.load(buffer);
    const pages = pdfDoc.getPages();
    for (const page of pages) {
      const content = page.getTextContent();
      text += (content?.items?.map(i => i.str).join(' ') || '') + '\n';
    }
  } catch (err) {
    throw new Error('Failed to parse PDF: ' + err.message);
  }
  return fromTextDocument(text, 'pdf');
}

/**
 * 5. Voice / Text Description — NLP extraction with tolerance ranges.
 * Example: "human-scale resin figure, wall-mounted, about 40 lbs, needs gold finish"
 * Returns: parametric Thing with range-aware properties.
 */
async function fromTextDescription(text, userContext = '') {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY not configured');

  const systemPrompt = `You are a BIM object property extractor. Given a natural language description, extract structured properties for a construction/crafting object. Return ONLY valid JSON:

{
  "name": "extracted object name",
  "dimensions": {
    "l_cm": { "value": 100, "tolerance_minus": 5, "tolerance_plus": 15 },
    "w_cm": { "value": 50, "tolerance_minus": 0, "tolerance_plus": 5 },
    "h_cm": { "value": 200, "tolerance_minus": 10, "tolerance_plus": 20 }
  },
  "mass_kg": { "value": 40, "tolerance_minus": 5, "tolerance_plus": 5 },
  "material": "resin",
  "material_confidence": 0.75,
  "finish": "gold",
  "finish_confidence": 0.9,
  "mounting": "wall-mounted",
  "mounting_confidence": 0.9,
  "discipline": "architectural",
  "attachment_type": "bolt",
  "object_type": "decorative_figure",
  "parametric": true,
  "reasoning": "why you chose these values"
}

Rules:
- Use "about ~40 lbs" → mass_kg.value=40, tolerance_minus=5, tolerance_plus=5
- Use "roughly 2 feet tall" → h_cm.value=61, tolerance_minus=5, tolerance_plus=10
- Use "50-60 cm wide" → w_cm.value=55, tolerance_minus=5, tolerance_plus=5
- dimensions always in cm, weight in kg
- If something is not mentioned, omit the field (don't guess)
- If uncertain, set confidence to 0.5–0.7
- material_confidence should be low (0.3–0.6) when the material is inferred from context
- parametric=true means the properties have acceptable ranges rather than fixed values`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: `Extract properties from: "${text}"` },
        ...(userContext ? [{ type: 'text', text: `Additional context: ${userContext}` }] : []),
      ]},
    ],
    max_tokens: 500,
  });

  const rawText = response.choices[0].message.content.trim();
  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/```json\n?|```\n?/g, ''));
  } catch {
    throw new Error('AI returned non-JSON: ' + rawText.slice(0, 200));
  }

  // Build tolerance-aware raw properties
  const raw = {
    name: parsed.name,
    dimensions: parsed.dimensions,
    mass_kg: parsed.mass_kg?.value,
    material: parsed.material,
    material_confidence: parsed.material_confidence || 0.7,
    finish: parsed.finish,
    finish_confidence: parsed.finish_confidence || 0.7,
    mounting: parsed.mounting,
    mounting_confidence: parsed.mounting_confidence || 0.7,
    discipline: parsed.discipline,
    discipline_confidence: parsed.discipline_confidence || 0.8,
    attachment_type: parsed.attachment_type,
    source_confidence: parsed.material_confidence || 0.7,
    parametric: parsed.parametric || false,
    tolerance_ranges: {
      dimensions: parsed.dimensions,
      mass_kg: parsed.mass_kg,
    },
    _raw: { ai_response: parsed, reasoning: parsed.reasoning, original_text: text },
  };

  return { name: raw.name, properties: normalizeProperties(raw), source_type: 'text', source_ref: null };
}

/**
 * 5b. Voice audio — transcribe via OpenAI Whisper then process as text.
 */
async function fromVoice(audioBuffer, mimeType = 'audio/webm') {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY not configured');

  // Write buffer to temp file for Whisper
  const fs = require('fs');
  const path = require('path');
  const tmpPath = path.join('/tmp', `voice-${Date.now()}.webm`);
  fs.writeFileSync(tmpPath, audioBuffer);

  const resp = await client.audio.transcriptions.create({
    file: fs.createReadStream(tmpPath),
    model: 'whisper-1',
  });

  fs.unlink(tmpPath, () => {});
  return fromTextDescription(resp.text);
}

/**
 * 6. Asset Store / BIM Library — convert pre-populated asset data to Thing.
 * source_ref points to the original asset (BIMObject, Asset Store, etc.)
 * Confidence is high since manufacturer data is authoritative.
 */
async function fromAssetStore(assetData) {
  const raw = {
    name: assetData.name || assetData.title,
    dimensions: assetData.dimensions || assetData.specs?.dimensions,
    mass_kg: assetData.mass_kg || assetData.weight_kg || assetData.specs?.weight_kg,
    material: assetData.material || assetData.specs?.material,
    finish: assetData.finish || assetData.specs?.finish,
    estimated_price_usd: assetData.price_usd || assetData.price,
    source_confidence: 0.98, // Manufacturer data is high-confidence
    dimensions_confidence: assetData.dimensions ? 0.98 : 0.7,
    mass_kg_confidence: assetData.mass_kg ? 0.98 : 0.6,
    material_confidence: assetData.material ? 0.98 : 0.7,
    finish_confidence: assetData.finish ? 0.95 : 0.5,
    mounting_confidence: 0.8,
    discipline_confidence: assetData.discipline ? 0.95 : 0.8,
    _raw: { source: 'asset_store', asset_id: assetData.asset_id, manufacturer: assetData.manufacturer },
  };

  return { name: raw.name, properties: normalizeProperties(raw), source_type: 'asset_store', source_ref: assetData.source_ref || assetData.asset_id };
}

// ── Log Recognition ────────────────────────────────────────────────────────────

async function logRecognition({ userId, sourceType, rawProperties, confidence, thingId }) {
  const pool = require('../db/index');
  try {
    await pool.query(
      `INSERT INTO crafting_recognition_logs (thing_id, user_id, source_type, raw_properties_json, confidence, status)
       VALUES ($1,$2,$3,$4,$5,'completed')`,
      [thingId, userId, sourceType, JSON.stringify(rawProperties), confidence]
    );
  } catch { /* non-critical */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

const HANDLERS = {
  bim_model: fromBIMModel,
  image: fromImage,
  url: fromURL,
  pdf: fromPDF,
  text: fromTextDescription,
  voice: fromVoice,
  asset_store: fromAssetStore,
};

/**
 * Main entry point — dispatch to the appropriate input handler.
 * Returns a fully-normalized Thing ready for createThing() in db/crafting.js.
 */
async function recognize(inputMethod, inputData, userId) {
  const handler = HANDLERS[inputMethod];
  if (!handler) throw new Error('Unknown input method: ' + inputMethod);

  const parsed = await handler(inputData);

  // Store confidence score in properties
  parsed.properties.overall_confidence = parsed.properties.source_confidence
    || Object.values(parsed.properties.property_confidences).reduce((a, b) => a + b, 0)
    / Math.max(1, Object.keys(parsed.properties.property_confidences).length);

  return parsed;
}

module.exports = {
  recognize,
  normalizeProperties,
  HANDLERS,
  MATERIAL_TAXONOMY,
  MOUNT_TAXONOMY,
  fromBIMModel,
  fromImage,
  fromURL,
  fromPDF,
  fromTextDescription,
  fromVoice,
  fromAssetStore,
  logRecognition,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function decodeHTMLEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)));
}