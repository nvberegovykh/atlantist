/**
 * CSI MasterFormat 2023 code lookup and schedule type detection.
 * Covers Divisions 01–49 and common sub-sections used in AEC Excel schedules.
 */

// Full division catalog
const DIVISIONS = {
  1:  { name: 'General Requirements',           sections: {} },
  2:  { name: 'Existing Conditions',             sections: {} },
  3:  { name: 'Concrete',                        sections: {} },
  4:  { name: 'Masonry',                         sections: {} },
  5:  { name: 'Metals',                          sections: {} },
  6:  { name: 'Wood, Plastics, and Composites',  sections: {} },
  7:  { name: 'Thermal and Moisture Protection', sections: {} },
  8:  { name: 'Openings',                        sections: {} },
  9:  { name: 'Finishes',                        sections: {} },
  10: { name: 'Specialties',                      sections: {} },
  11: { name: 'Equipment',                       sections: {} },
  12: { name: 'Furnishings',                     sections: {} },
  13: { name: 'Special Construction',             sections: {} },
  14: { name: 'Conveying Equipment',              sections: {} },
  21: { name: 'Fire Suppression',                 sections: {} },
  22: { name: 'Plumbing',                         sections: {} },
  23: { name: 'HVAC',                            sections: {} },
  26: { name: 'Electrical',                      sections: {} },
  27: { name: 'Communications',                   sections: {} },
  28: { name: 'Electronic Safety and Security',   sections: {} },
  31: { name: 'Earthwork',                        sections: {} },
  32: { name: 'Exterior Improvements',            sections: {} },
  33: { name: 'Utilities',                        sections: {} },
};

// Common sections (partial list — most used in BIM schedules)
const SECTIONS = {
  '08 11 00': { name: 'Doors and Frames',         division: 8,  scheduleType: 'door' },
  '08 12 00': { name: 'Storefronts',               division: 8,  scheduleType: 'door' },
  '08 13 00': { name: 'Access Doors',              division: 8,  scheduleType: 'door' },
  '08 14 00': { name: 'Fire Door Assemblies',      division: 8,  scheduleType: 'door' },
  '08 17 00': { name: 'Hardware',                  division: 8,  scheduleType: 'door' },
  '08 30 00': { name: 'Specialty Doors',           division: 8,  scheduleType: 'door' },
  '08 40 00': { name: 'Entrances and Storefronts', division: 8,  scheduleType: 'door' },
  '08 50 00': { name: 'Windows',                   division: 8,  scheduleType: 'other' },
  '08 51 00': { name: 'Fixed Windows',             division: 8,  scheduleType: 'other' },
  '08 60 00': { name: 'Roof Windows and Skylights', division: 8, scheduleType: 'other' },
  '09 21 00': { name: 'Plaster and Gypsum Board',  division: 9,  scheduleType: 'finish' },
  '09 22 00': { name: 'Supports for Plaster and Gypsum Board', division: 9, scheduleType: 'finish' },
  '09 24 00': { name: 'Portland Cement Plastering', division: 9, scheduleType: 'finish' },
  '09 28 00': { name: 'Plaster Facings',            division: 9, scheduleType: 'finish' },
  '09 29 00': { name: 'Gypsum Board',              division: 9, scheduleType: 'finish' },
  '09 30 00': { name: 'Tiling',                     division: 9, scheduleType: 'finish' },
  '09 50 00': { name: 'Ceilings',                  division: 9, scheduleType: 'finish' },
  '09 51 00': { name: 'Suspended Ceilings',        division: 9, scheduleType: 'finish' },
  '09 51 30': { name: 'Acoustical Tile Ceilings',  division: 9, scheduleType: 'finish' },
  '09 62 00': { name: 'Wood Flooring',             division: 9, scheduleType: 'finish' },
  '09 63 00': { name: 'Elastic Flooring',          division: 9, scheduleType: 'finish' },
  '09 65 00': { name: 'Resilient Flooring',        division: 9, scheduleType: 'finish' },
  '09 65 13': { name: 'Resilient Tile Flooring',   division: 9, scheduleType: 'finish' },
  '09 66 00': { name: 'Carpeting',                 division: 9, scheduleType: 'finish' },
  '09 68 00': { name: 'Carpet Tile',               division: 9, scheduleType: 'finish' },
  '09 72 00': { name: 'Wall Coverings',            division: 9, scheduleType: 'finish' },
  '09 90 00': { name: 'Painting and Coatings',     division: 9, scheduleType: 'finish' },
  '10 21 00': { name: 'Toilet Accessories',        division: 10, scheduleType: 'other' },
  '21 13 00': { name: 'Fire-Suppression Water Supply', division: 21, scheduleType: 'other' },
  '21 14 00': { name: 'Wet-Pipe Sprinkler Systems', division: 21, scheduleType: 'other' },
  '22 11 00': { name: 'Plumbing Piping',            division: 22, scheduleType: 'plumbing' },
  '22 40 00': { name: 'Plumbing Fixtures',          division: 22, scheduleType: 'plumbing' },
  '22 41 00': { name: 'Residential Plumbing Fixtures', division: 22, scheduleType: 'plumbing' },
  '23 05 00': { name: 'Common Work Results for HVAC', division: 23, scheduleType: 'hvac' },
  '23 06 00': { name: 'HVAC Controls',               division: 23, scheduleType: 'hvac' },
  '23 08 00': { name: 'Testing, Adjusting, Balancing', division: 23, scheduleType: 'hvac' },
  '23 09 00': { name: 'Instrumentation and Controls', division: 23, scheduleType: 'hvac' },
  '23 30 00': { name: 'HVAC Air Distribution',       division: 23, scheduleType: 'hvac' },
  '23 60 00': { name: 'Air Handling Units',          division: 23, scheduleType: 'hvac' },
  '23 81 00': { name: 'Unit Ventilators',            division: 23, scheduleType: 'hvac' },
  '26 05 00': { name: 'Common Work Results for Electrical', division: 26, scheduleType: 'electrical' },
  '26 20 00': { name: 'Interior Distribution',       division: 26, scheduleType: 'electrical' },
  '26 24 00': { name: 'Switchboards and Panelboards', division: 26, scheduleType: 'electrical' },
  '26 27 00': { name: 'Branch Circuiting',            division: 26, scheduleType: 'electrical' },
  '26 28 00': { name: 'Wiring Devices',              division: 26, scheduleType: 'electrical' },
  '26 36 00': { name: 'Lighting Equipment',          division: 26, scheduleType: 'electrical' },
  '27 10 00': { name: 'Structured Cabling',          division: 27, scheduleType: 'other' },
  '33 03 00': { name: 'Utility Meters',              division: 33, scheduleType: 'other' },
  '33 82 00': { name: 'Natural-Gas Distribution',   division: 33, scheduleType: 'other' },
  '33 91 00': { name: 'Electrical Utilities',        division: 33, scheduleType: 'electrical' },
};

// Default column maps per schedule type (Excel header → Atlantist field)
const DEFAULT_COLUMN_MAPS = {
  finish: {
    'Material': 'product_name', 'Product': 'product_name', 'Finish Material': 'product_name',
    'Finish Type': 'product_name',
    'CSI Code': 'csi_code', 'MasterFormat': 'csi_code', 'MF': 'csi_code',
    'Manufacturer': 'manufacturer', 'Mfg': 'manufacturer', 'Vendor': 'manufacturer',
    'Model': 'model_number', 'Model No': 'model_number', 'Part #': 'model_number',
    'Color': 'description', 'Finish Color': 'description',
    'Room': 'room_name', 'Space': 'room_name', 'Area': 'room_name',
    'Level': 'level_name', 'Floor': 'level_name',
    'Unit': 'unit', 'UOM': 'unit',
    'Qty': 'quantity', 'Quantity': 'quantity',
    'Cost': 'unit_cost', 'Unit Cost': 'unit_cost', 'Unit Price': 'unit_cost',
    'Total': 'total_cost', 'Total Cost': 'total_cost',
    'Reference': 'reference_std', 'Spec': 'reference_std', 'Std Ref': 'reference_std',
  },
  door: {
    'Mark': 'product_name', 'Door Mark': 'product_name', 'Door ID': 'product_name', 'ID': 'product_name',
    'Type': 'product_name', 'Door Type': 'product_name',
    'Width': 'description', 'Height': 'description', 'Size': 'description',
    'Material': 'product_name',
    'CSI Code': 'csi_code', 'MF': 'csi_code',
    'Manufacturer': 'manufacturer', 'Mfg': 'manufacturer',
    'Model': 'model_number', 'Model No': 'model_number',
    'Frame': 'description', 'Frame Material': 'description',
    'Fire Rating': 'reference_std', 'Rating': 'reference_std',
    'Hardware Set': 'spec_section', 'Hardware': 'spec_section',
    'Room': 'room_name', 'Location': 'room_name',
    'Level': 'level_name', 'Floor': 'level_name',
    'Qty': 'quantity', 'Quantity': 'quantity',
    'Unit Cost': 'unit_cost', 'Cost': 'unit_cost',
    'Total': 'total_cost', 'Total Cost': 'total_cost',
  },
  room: {
    'Room': 'room_name', 'Room Name': 'room_name', 'Space': 'room_name',
    'Number': 'room_name', 'Room Number': 'room_name', 'Rm #': 'room_name',
    'Level': 'level_name', 'Floor': 'level_name', 'Story': 'level_name',
    'Area': 'quantity', 'SF': 'quantity', 'Area (SF)': 'quantity', 'GFA': 'quantity',
    'Volume': 'description', 'Volume (CF)': 'description',
    'Finish Floor': 'description', 'Floor Finish': 'description',
    'Finish Wall': 'description', 'Wall Finish': 'description',
    'Finish Ceiling': 'description', 'Ceiling Finish': 'description',
    'Department': 'location', 'Program': 'location', 'Use': 'location',
    'CSI Code': 'csi_code',
  },
  structural: {
    'Member': 'product_name', 'Element': 'product_name', 'Steel': 'product_name',
    'Size': 'product_name', 'Section': 'product_name',
    'Grade': 'description', 'Steel Grade': 'description',
    'CSI Code': 'csi_code',
    'Qty': 'quantity', 'Length': 'quantity',
    'Unit': 'unit',
    'Cost': 'unit_cost',
  },
  other: {
    'Item': 'product_name', 'Description': 'product_name', 'Name': 'product_name',
    'CSI Code': 'csi_code', 'MF': 'csi_code',
    'Manufacturer': 'manufacturer', 'Mfg': 'manufacturer',
    'Model': 'model_number', 'Model No': 'model_number',
    'Qty': 'quantity', 'Quantity': 'quantity',
    'Unit': 'unit',
    'Cost': 'unit_cost', 'Unit Cost': 'unit_cost', 'Unit Price': 'unit_cost',
    'Total': 'total_cost', 'Total Cost': 'total_cost',
    'Room': 'room_name', 'Location': 'room_name',
    'Level': 'level_name', 'Floor': 'level_name',
    'Ref': 'reference_std', 'Reference': 'reference_std',
  },
};

// Schedule type detection from sheet name patterns
const SHEET_TYPE_PATTERNS = {
  finish:  ['finish', 'flooring', 'floor', 'wall', 'ceiling', 'paint', 'coating', 'tile', 'carpet', 'masonry'],
  door:    ['door', 'hardware'],
  room:    ['room', 'space', 'program'],
  structural: ['structural', 'steel', 'concrete', 'masonry', 'beam', 'column'],
  hvac:    ['hvac', 'mechanical', 'air', 'duct', 'ventilation'],
  plumbing: ['plumbing', 'plumb', 'fixture', 'pipe'],
  electrical: ['electrical', 'elec', 'lighting', 'power', 'data'],
};

// Schedule type detection from column headers (heuristic)
function detectScheduleType(sheetName, headers) {
  const sheetLower = (sheetName || '').toLowerCase();
  for (const [type, patterns] of Object.entries(SHEET_TYPE_PATTERNS)) {
    for (const p of patterns) {
      if (sheetLower.includes(p)) return type;
    }
  }
  // Heuristic from headers
  const headerSet = new Set(headers.map(h => h.toLowerCase()));
  const hasDoors  = headerSet.has('mark') || headerSet.has('door mark') || headerSet.has('door type');
  const hasFinishes = headerSet.has('finish material') || headerSet.has('finish type') || headerSet.has('floor finish');
  const hasRoom   = headerSet.has('room name') || headerSet.has('room number') || headerSet.has('space');
  const hasFloor  = headerSet.has('level') || headerSet.has('floor');
  if (hasDoors) return 'door';
  if (hasFinishes) return 'finish';
  if (hasRoom && hasFloor) return 'room';
  return 'other';
}

// Parse a raw CSI code string into structured form
function parseCode(rawCode) {
  if (!rawCode) return null;
  const cleaned = String(rawCode).replace(/[\n\r\t]+/g, ' ').trim();
  // Match patterns like "09 29 00", "092900", "9-29", "09/29/00", "Division 09 Section 29 00"
  const match = cleaned.match(/(?:division[\t ]+)?(\b[0-9]{1,2})\b[\/\t -]+([0-9]{2})[\/\t -]*([0-9]{2})?/i);
  if (!match) {
    const digitsOnly = cleaned.replace(/\b0+/g, s => s).replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 4) {
      const div = parseInt(digitsOnly.slice(0, 2), 10);
      const sec = digitsOnly.slice(2, 7);
      return { division: div, section: sec, full: cleaned, code: `${String(div).padStart(2,'0')} ${sec.slice(0,2)} ${sec.slice(2,4)}`.replace(/(\b0+)/g, s => s).trim() };
    }
    return null;
  }
  const division = parseInt(match[1], 10);
  const section  = (match[2] || '').padStart(2, '0');
  const sub      = (match[3] || '00').padStart(2, '0');
  return {
    division,
    section: `${section}${sub}`,
    full: cleaned,
    code: `${String(division).padStart(2,'0')} ${section} ${sub}`.trim(),
  };
}

function lookupSection(csiCode) {
  const key = (csiCode || '').replace(/\b0+/g, s => s).replace(/[^0-9]/g, '').slice(0, 7);
  if (SECTIONS[key]) return SECTIONS[key];
  return null;
}

function getDefaultMapping(scheduleType) {
  return DEFAULT_COLUMN_MAPS[scheduleType] || DEFAULT_COLUMN_MAPS.other;
}

module.exports = {
  DIVISIONS,
  SECTIONS,
  SHEET_TYPE_PATTERNS,
  DEFAULT_COLUMN_MAPS,
  detectScheduleType,
  parseCode,
  lookupSection,
  getDefaultMapping,
};