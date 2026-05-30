// Owns: product catalog adapters — Pella, Simpson Strong-Tie, generic REST
// Does NOT own: design book persistence (db/design-book.js), route handling

// Pella catalog — representative product data for windows and patio doors
// In production these could be fetched from a Pella partner API or web scraper;
// for now we ship a curated catalog that covers common window types.
const PELLA_CATALOG = [
  {
    product_code: 'PE-250-3030',
    product_name: 'Pella 250 Series Double-Hung 3\'0" × 3\'0"',
    manufacturer: 'Pella',
    category: 'window',
    specs: {
      width_in: 36, height_in: 36, type: 'double-hung',
      u_value: 0.29, shgc: 0.19, vt: 0.47,
      frame: 'vinyl', glazing: 'Low-E insulating glass',
      fire_rating: null, certified: 'ENERGY STAR',
    },
    estimated_cost: 410,
    lead_time_days: 21,
  },
  {
    product_code: 'PE-250-3060',
    product_name: 'Pella 250 Series Double-Hung 3\'0" × 6\'0"',
    manufacturer: 'Pella',
    category: 'window',
    specs: {
      width_in: 36, height_in: 72, type: 'double-hung',
      u_value: 0.28, shgc: 0.19, vt: 0.47,
      frame: 'vinyl', glazing: 'Low-E insulating glass',
      fire_rating: null, certified: 'ENERGY STAR',
    },
    estimated_cost: 560,
    lead_time_days: 21,
  },
  {
    product_code: 'PE-350-3030',
    product_name: 'Pella 350 Series Casement 3\'0" × 3\'0"',
    manufacturer: 'Pella',
    category: 'window',
    specs: {
      width_in: 36, height_in: 36, type: 'casement',
      u_value: 0.27, shgc: 0.17, vt: 0.49,
      frame: 'vinyl', glazing: 'Triple-pane Low-E',
      fire_rating: null, certified: 'ENERGY STAR Most Efficient',
    },
    estimated_cost: 680,
    lead_time_days: 28,
  },
  {
    product_code: 'PE-ARCH-3060-PD',
    product_name: 'Pella Architect Series Patio Door 3\'0" × 6\'8"',
    manufacturer: 'Pella',
    category: 'door',
    specs: {
      width_in: 36, height_in: 80, type: 'sliding-patio',
      u_value: 0.30, shgc: 0.22, vt: 0.44,
      frame: 'fiberglass', glazing: 'Low-E argon',
      fire_rating: null, certified: 'ENERGY STAR',
    },
    estimated_cost: 1850,
    lead_time_days: 35,
  },
  {
    product_code: 'PE-IMPA-3030',
    product_name: 'Pella Impact-Resistant Double-Hung 3\'0" × 3\'0"',
    manufacturer: 'Pella',
    category: 'window',
    specs: {
      width_in: 36, height_in: 36, type: 'double-hung',
      u_value: 0.31, shgc: 0.20, vt: 0.38,
      frame: 'vinyl', glazing: 'Impact laminated glass',
      fire_rating: null, certified: 'Florida Product Approval',
    },
    estimated_cost: 720,
    lead_time_days: 30,
  },
];

// Simpson Strong-Tie — structural connectors (post bases, joist hangers, holdowns)
const SIMPSON_CATALOG = [
  {
    product_code: 'ABU44',
    product_name: 'Simpson ABU44 Adjustable Post Base',
    manufacturer: 'Simpson Strong-Tie',
    category: 'structural',
    specs: {
      post_size: '4×4', material: 'ZMAX galvanized steel',
      allowable_uplift_lbs: 1535, allowable_lateral_lbs: 1535,
      icc_report: 'ESR-2549',
    },
    estimated_cost: 12.50,
    lead_time_days: 5,
  },
  {
    product_code: 'ABU66',
    product_name: 'Simpson ABU66 Adjustable Post Base',
    manufacturer: 'Simpson Strong-Tie',
    category: 'structural',
    specs: {
      post_size: '6×6', material: 'ZMAX galvanized steel',
      allowable_uplift_lbs: 2645, allowable_lateral_lbs: 2645,
      icc_report: 'ESR-2549',
    },
    estimated_cost: 18.75,
    lead_time_days: 5,
  },
  {
    product_code: 'LUS26',
    product_name: 'Simpson LUS26 Joist Hanger 2×6',
    manufacturer: 'Simpson Strong-Tie',
    category: 'structural',
    specs: {
      joist_size: '2×6', material: '18ga galvanized',
      allowable_load_lbs: 1290, icc_report: 'ESR-1356',
    },
    estimated_cost: 1.65,
    lead_time_days: 3,
  },
  {
    product_code: 'HDU5',
    product_name: 'Simpson HDU5 Holdown Connector',
    manufacturer: 'Simpson Strong-Tie',
    category: 'structural',
    specs: {
      allowable_tension_lbs: 4565, rod_diameter_in: 0.625,
      material: 'ZMAX galvanized', icc_report: 'ESR-2549',
    },
    estimated_cost: 24.50,
    lead_time_days: 7,
  },
  {
    product_code: 'SP4',
    product_name: 'Simpson SP4 Standoff Post Base',
    manufacturer: 'Simpson Strong-Tie',
    category: 'structural',
    specs: {
      post_size: '4×4', base_plate: '3.5"×3.5"',
      allowable_uplift_lbs: 1215, material: 'ZMAX',
      icc_report: 'ESR-2549',
    },
    estimated_cost: 9.80,
    lead_time_days: 5,
  },
];

// Generic / custom products — finish materials, HVAC equipment, etc.
const GENERIC_CATALOG = [
  {
    product_code: 'FSH-TILE-12X24',
    product_name: 'Porcelain Floor Tile 12"×24" (Custom)',
    manufacturer: 'Generic',
    category: 'finish',
    specs: { material: 'porcelain', size_in: '12×24', pei: 4, slip_resistance: 'R10' },
    estimated_cost: 3.80,
    lead_time_days: 14,
  },
  {
    product_code: 'HVAC-RTU-5T',
    product_name: 'Rooftop Unit 5-Ton 14 SEER',
    manufacturer: 'Generic',
    category: 'HVAC',
    specs: { capacity_tons: 5, seer: 14, fuel: 'electric', refrigerant: 'R-410A' },
    estimated_cost: 4800,
    lead_time_days: 30,
  },
  {
    product_code: 'DR-HM-36X84',
    product_name: 'Hollow Metal Door 3\'0"×7\'0" 18GA',
    manufacturer: 'Generic',
    category: 'door',
    specs: {
      width_in: 36, height_in: 84, gauge: '18ga',
      material: 'hollow metal steel', fire_rating: '90-min',
    },
    estimated_cost: 320,
    lead_time_days: 21,
  },
];

const CATALOGS = {
  pella: PELLA_CATALOG,
  simpson: SIMPSON_CATALOG,
  generic: GENERIC_CATALOG,
};

/**
 * Search a product catalog by keyword.
 * Returns matching products with relevance (name/code/category match).
 */
async function search(source, query) {
  const catalog = CATALOGS[source] || GENERIC_CATALOG;
  if (!query || !query.trim()) return catalog.slice(0, 20);

  const q = query.toLowerCase();
  const results = catalog.filter(p =>
    p.product_name.toLowerCase().includes(q) ||
    p.product_code.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) ||
    (p.manufacturer || '').toLowerCase().includes(q)
  );
  return results;
}

module.exports = { search };
