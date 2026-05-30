/**
 * node-editor.js — Atlantist Visual Scripting Engine
 * MIT Scratch / Dynamo / Grasshopper-style node graph.
 * Each connection IS a DAG constraint; editing a node triggers DAG re-solve.
 */

// ── Port type definitions ──────────────────────────────────────────────────
const PORT_TYPES = {
  geometry: { color: '#00d4ff', wireClass: 'ne-wire-geometry', label: 'Geom' },
  number:   { color: '#fb923c', wireClass: 'ne-wire-number',   label: 'Num' },
  boolean:  { color: '#facc15', wireClass: 'ne-wire-boolean',  label: 'Bool' },
  vector:   { color: '#a78bfa', wireClass: 'ne-wire-vector',    label: 'Vec' },
  string:   { color: '#34d399', wireClass: 'ne-wire-string',    label: 'Str' },
  struct:   { color: '#c084fc', wireClass: 'ne-wire-struct',   label: 'Struct' },
  enum:     { color: '#a855f7', wireClass: 'ne-wire-struct',   label: 'Enum' },
  any:      { color: '#888888', wireClass: 'ne-wire-default',   label: 'Any' },
};

const CATEGORY_COLORS = {
  geometry: '#00d4ff',
  bim: '#38bdf8',      // BIM spawn nodes — lighter sky blue to distinguish from raw geometry
  constraint: '#ffd700',
  structure: '#c084fc',
  mep: '#4aad6e',
  energy: '#f59e0b',
  simulation: '#ef4444',
  data: '#60a5fa',
  design: '#f472b6',
};

// ── Node type registry ──────────────────────────────────────────────────────
const NODE_TYPES = [
  // GEOMETRY
  {
    id: 'wall', category: 'geometry', label: 'Wall', icon: '▭',
    inputs: [
      { id: 'x', label: 'X', type: 'number', default: 0 },
      { id: 'z', label: 'Z', type: 'number', default: 0 },
      { id: 'height', label: 'Height', type: 'number', default: 3000 },
      { id: 'length', label: 'Length', type: 'number', default: 6000 },
      { id: 'rotation', label: 'Rotation', type: 'number', default: 0 },
      { id: 'wall_type', label: 'Wall Type', type: 'string', default: 'Generic 200mm' },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
      { id: 'bbox', label: 'Bounds', type: 'geometry' },
    ],
    params: [
      { label: 'Height (mm)', key: 'height', type: 'number', default: '3000' },
      { label: 'Length (mm)', key: 'length', type: 'number', default: '6000' },
      { label: 'Thickness (mm)', key: 'thickness', type: 'number', default: '200' },
      { label: 'Wall Type', key: 'wall_type', type: 'select', options: ['Generic 200mm', 'Curtain Wall', 'Masonry 300mm', 'Steel Stud', 'Concrete 250mm'] },
    ],
    help: 'Creates a wall element in the BIM model. Connect Wall Type from the catalog, height/length params, and X/Z position.',
  },
  {
    id: 'column', category: 'geometry', label: 'Column', icon: '⊢',
    inputs: [
      { id: 'x', label: 'X', type: 'number', default: 0 },
      { id: 'z', label: 'Z', type: 'number', default: 0 },
      { id: 'height', label: 'Height', type: 'number', default: 3000 },
      { id: 'section', label: 'Section', type: 'string', default: 'W310×97' },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Section', key: 'section', type: 'select', options: ['W310×97','W360×134','W410×114','HSS 152×152×9','HSS 203×203×13'] },
      { label: 'Height (mm)', key: 'height', type: 'number', default: '3000' },
      { label: 'Base Offset (mm)', key: 'base_offset', type: 'number', default: '0' },
    ],
    help: 'Creates a structural column. Section comes from AISC catalog. Height binds to levels.',
  },
  {
    id: 'beam', category: 'geometry', label: 'Beam', icon: '—',
    inputs: [
      { id: 'start_x', label: 'Start X', type: 'number', default: 0 },
      { id: 'start_z', label: 'Start Z', type: 'number', default: 0 },
      { id: 'end_x', label: 'End X', type: 'number', default: 6000 },
      { id: 'end_z', label: 'End Z', type: 'number', default: 0 },
      { id: 'section', label: 'Section', type: 'string', default: 'W310×97' },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Section', key: 'section', type: 'select', options: ['W310×97','W360×134','W460×113','LVL 302×89','PSL 302×140'] },
      { label: 'Depth (mm)', key: 'depth', type: 'number', default: '500' },
      { label: 'Rotation (°)', key: 'rotation', type: 'number', default: '0' },
    ],
    help: 'Creates a horizontal beam between two points. Section type from AISC or LVL catalog.',
  },
  {
    id: 'floor_slab', category: 'geometry', label: 'Floor Slab', icon: '▭',
    inputs: [
      { id: 'elevation', label: 'Elevation', type: 'number', default: 0 },
      { id: 'thickness', label: 'Thickness', type: 'number', default: 300 },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Thickness (mm)', key: 'thickness', type: 'number', default: '300' },
      { label: 'Floor Type', key: 'floor_type', type: 'select', options: ['Standard 300mm','Lightweight 200mm','Post-Tension 350mm','Precast Hollow Core 400mm'] },
    ],
    help: 'Creates a floor slab at a given elevation. Binds to levels for parametric height updates.',
  },
  {
    id: 'stairs', category: 'geometry', label: 'Stairs', icon: '⤢',
    inputs: [
      { id: 'base_level', label: 'Base Level', type: 'struct' },
      { id: 'top_level', label: 'Top Level', type: 'struct' },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
      { id: 'riser_count', label: 'Risers', type: 'number' },
    ],
    params: [
      { label: 'Width (mm)', key: 'width', type: 'number', default: '1500' },
      { label: 'Tread Depth (mm)', key: 'tread_depth', type: 'number', default: '280' },
      { label: 'Config', key: 'config', type: 'select', options: ['Straight','L-Shaped','U-Shaped','Spiral'] },
    ],
    help: 'Creates a multi-story stair between two levels. Risers/going computed from level delta.',
  },
  {
    id: 'door', category: 'geometry', label: 'Door', icon: '⤢',
    inputs: [
      { id: 'host_wall', label: 'Host Wall', type: 'struct' },
      { id: 'face_u', label: 'Position', type: 'number', default: 0.5 },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Width (mm)', key: 'width', type: 'number', default: '915' },
      { label: 'Height (mm)', key: 'height', type: 'number', default: '2130' },
      { label: 'Door Type', key: 'door_type', type: 'select', options: ['Single 900','Double 1800','Double-E 1800','Fire Rated 1HR'] },
    ],
    help: 'Places a door family instance on a host wall. Auto-cuts wall geometry.',
  },
  {
    id: 'window', category: 'geometry', label: 'Window', icon: '⊡',
    inputs: [
      { id: 'host_wall', label: 'Host Wall', type: 'struct' },
      { id: 'face_u', label: 'Position', type: 'number', default: 0.5 },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Width (mm)', key: 'width', type: 'number', default: '1200' },
      { label: 'Height (mm)', key: 'height', type: 'number', default: '1500' },
      { label: 'Sill Height (mm)', key: 'sill_height', type: 'number', default: '900' },
      { label: 'Window Type', key: 'window_type', type: 'select', options: ['Fixed','Casement','Double-Hung','Sliding','Curtain Wall Panel'] },
    ],
    help: 'Places a window family instance on a host wall. Auto-cuts wall geometry.',
  },
  {
    id: 'mep_duct', category: 'geometry', label: 'MEP Duct', icon: '═',
    inputs: [
      { id: 'start_x', label: 'Start X', type: 'number', default: 0 },
      { id: 'start_z', label: 'Start Z', type: 'number', default: 0 },
      { id: 'end_x', label: 'End X', type: 'number', default: 6000 },
      { id: 'end_z', label: 'End Z', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Width (mm)', key: 'width', type: 'number', default: '400' },
      { label: 'Height (mm)', key: 'height', type: 'number', default: '300' },
      { label: 'System Type', key: 'system_type', type: 'select', options: ['Supply','Return','Exhaust','Outside Air'] },
    ],
    help: 'Creates a rectangular HVAC duct run. Diameter connects to MEP airflow simulation.',
  },
  {
    id: 'mep_pipe', category: 'geometry', label: 'MEP Pipe', icon: '│',
    inputs: [
      { id: 'start_x', label: 'Start X', type: 'number', default: 0 },
      { id: 'start_z', label: 'Start Z', type: 'number', default: 0 },
      { id: 'end_x', label: 'End X', type: 'number', default: 3000 },
      { id: 'end_z', label: 'End Z', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'element_id', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Diameter (mm)', key: 'diameter', type: 'number', default: '50' },
      { label: 'System', key: 'system', type: 'select', options: ['Domestic Water','Sanitary','Storm','Fire Sprinkler'] },
    ],
    help: 'Creates a plumbing pipe run. Diameter parameter drives hydraulic calculations.',
  },

  // CONSTRAINTS
  {
    id: 'parallel', category: 'constraint', label: 'Parallel', icon: '∥',
    inputs: [
      { id: 'angle', label: 'Angle (°)', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [
      { label: 'Angle (°)', key: 'angle', type: 'number', default: '0' },
    ],
    help: 'Constrains two elements to be parallel. Angle 0° = same direction, 90° = perpendicular.',
  },
  {
    id: 'perpendicular', category: 'constraint', label: 'Perpendicular', icon: '⊥',
    inputs: [],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [],
    help: 'Constrains two elements to be perpendicular (90°). Connect two wall outputs.',
  },
  {
    id: 'equal_length', category: 'constraint', label: 'Equal Length', icon: '≅',
    inputs: [],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [],
    help: 'Constrains two wall or beam elements to have equal length.',
  },
  {
    id: 'midpoint', category: 'constraint', label: 'Midpoint', icon: '·',
    inputs: [],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [],
    help: 'Constrains two elements to share the same midpoint.',
  },
  {
    id: 'offset_distance', category: 'constraint', label: 'Offset Distance', icon: '↔',
    inputs: [
      { id: 'distance', label: 'Distance', type: 'number', default: 1000 },
    ],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [
      { label: 'Distance (mm)', key: 'distance', type: 'number', default: '1000' },
    ],
    help: 'Constrains an element to be offset from a reference by a fixed distance.',
  },
  {
    id: 'tangent', category: 'constraint', label: 'Tangent', icon: '◯',
    inputs: [],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [],
    help: 'Constrains an arc or curved surface to be tangent to a line or another curve.',
  },
  {
    id: 'coincident', category: 'constraint', label: 'Coincident', icon: '●',
    inputs: [
      { id: 'tolerance', label: 'Tolerance (mm)', type: 'number', default: 1 },
    ],
    outputs: [
      { id: 'constraint', label: 'Constraint', type: 'struct' },
    ],
    params: [
      { label: 'Tolerance (mm)', key: 'tolerance', type: 'number', default: '1' },
    ],
    help: 'Constrains two points to occupy the same position within tolerance.',
  },

  // STRUCTURE
  {
    id: 'load_case', category: 'structure', label: 'Load Case', icon: '↓',
    inputs: [],
    outputs: [
      { id: 'load_case', label: 'Load Case', type: 'struct' },
    ],
    params: [
      { label: 'Type', key: 'type', type: 'select', options: ['Dead (D)','Live (L)','Roof Live (Lr)','Snow (S)','Wind (W)','Seismic (E)'] },
      { label: 'Factor', key: 'factor', type: 'number', default: '1.0' },
    ],
    help: 'Defines a load case for structural analysis. Dead = self-weight, Live = occupancy, Wind/Seismic = environmental.',
  },
  {
    id: 'boundary_condition', category: 'structure', label: 'Boundary Condition', icon: '⊣',
    inputs: [],
    outputs: [
      { id: 'bc', label: 'B.C.', type: 'struct' },
    ],
    params: [
      { label: 'Type', key: 'type', type: 'select', options: ['Fixed','Pinned','Roller','Spring','Free'] },
      { label: 'K (kN/m)', key: 'spring_k', type: 'number', default: '0' },
    ],
    help: 'Defines how a structural member end is supported. Fixed = all 6 DOF restrained, Pinned = rotation free.',
  },
  {
    id: 'section_property', category: 'structure', label: 'Section Property', icon: '⊟',
    inputs: [
      { id: 'designation', label: 'Designation', type: 'string' },
    ],
    outputs: [
      { id: 'section', label: 'Section', type: 'struct' },
    ],
    params: [
      { label: 'Designation', key: 'designation', type: 'select', options: ['W310×97','W360×134','W410×114','W460×113','HSS 152×152×9','HSS 203×203×13'] },
      { label: 'Fy (MPa)', key: 'fy', type: 'number', default: '345' },
    ],
    help: 'AISC section property lookup. Designation selects shape; Fy sets steel yield for code checks.',
  },
  {
    id: 'opensees_trigger', category: 'structure', label: 'OpenSees Trigger', icon: '⚡',
    inputs: [
      { id: 'members', label: 'Members', type: 'struct' },
      { id: 'bc', label: 'Boundary Cond.', type: 'struct' },
      { id: 'loads', label: 'Load Cases', type: 'struct' },
    ],
    outputs: [
      { id: 'results', label: 'Results', type: 'struct' },
    ],
    params: [
      { label: 'Analysis', key: 'analysis', type: 'select', options: ['Linear Static','Modal','Response Spectrum'] },
    ],
    help: 'Runs the Atlantist structural FEA engine (direct stiffness method + OpenSees .tcl generation). Results appear in the Simulation Timeline.',
  },

  // MEP
  {
    id: 'hvac_zone', category: 'mep', label: 'HVAC Zone', icon: '❄',
    inputs: [
      { id: 'cooling_load', label: 'Cooling (kW)', type: 'number', default: 10 },
      { id: 'heating_load', label: 'Heating (kW)', type: 'number', default: 8 },
    ],
    outputs: [
      { id: 'zone', label: 'Zone', type: 'struct' },
    ],
    params: [
      { label: 'Zone Name', key: 'name', type: 'text', default: 'Zone A' },
      { label: 'Setpoint Cool (°C)', key: 'cool_sp', type: 'number', default: '24' },
      { label: 'Setpoint Heat (°C)', key: 'heat_sp', type: 'number', default: '20' },
    ],
    help: 'Defines an HVAC thermal zone with cooling/heating loads. Used for equipment sizing.',
  },
  {
    id: 'equipment_load', category: 'mep', label: 'Equipment Load', icon: '⚡',
    inputs: [],
    outputs: [
      { id: 'load', label: 'Load', type: 'struct' },
    ],
    params: [
      { label: 'Name', key: 'name', type: 'text', default: 'Equipment A' },
      { label: 'Power (kW)', key: 'power', type: 'number', default: '5' },
      { label: 'Schedule', key: 'schedule', type: 'select', options: ['24/7','Business Hours','Night Only'] },
    ],
    help: 'Defines an electrical equipment load. Connects to panel schedule and energy simulation.',
  },
  {
    id: 'sprinkler_layout', category: 'mep', label: 'Sprinkler Layout', icon: '⬡',
    inputs: [
      { id: 'area', label: 'Area (m²)', type: 'number', default: 150 },
    ],
    outputs: [
      { id: 'sprinklers', label: 'Sprinklers', type: 'struct' },
    ],
    params: [
      { label: 'Coverage (m²/sprinkler)', key: 'coverage', type: 'number', default: '12' },
      { label: 'Type', key: 'type', type: 'select', options: ['NFPA 13 Standard','NFPA 13R','ESFR'] },
    ],
    help: 'Generates sprinkler head positions per NFPA 13 spacing rules. Area input drives head count.',
  },

  // ENERGY
  {
    id: 'energy_plus_trigger', category: 'energy', label: 'EnergyPlus Trigger', icon: '🌡',
    inputs: [
      { id: 'model_snapshot', label: 'Model Snapshot', type: 'struct' },
      { id: 'weather_file', label: 'Weather File', type: 'string' },
    ],
    outputs: [
      { id: 'results', label: 'Results', type: 'struct' },
    ],
    params: [
      { label: 'Simulation Steps', key: 'steps', type: 'select', options: ['Annual (8760h)','Design Day','Monthly'] },
    ],
    help: 'Runs the ASHRAE JS energy simulation engine. Results include EUI, peak loads, and EN-001 to EN-008 compliance.',
  },
  {
    id: 'gbxml_export', category: 'energy', label: 'gbXML Export', icon: '📤',
    inputs: [
      { id: 'model', label: 'Model', type: 'struct' },
    ],
    outputs: [
      { id: 'file', label: 'gbXML', type: 'struct' },
    ],
    params: [],
    help: 'Exports the BIM model as gbXML for energy analysis tools (DesignBuilder, IESVE, EnergyPlus).',
  },
  {
    id: 'weather_file_input', category: 'energy', label: 'Weather File Input', icon: '☁',
    inputs: [],
    outputs: [
      { id: 'weather', label: 'Weather', type: 'struct' },
    ],
    params: [
      { label: 'Location', key: 'location', type: 'select', options: ['New York City (TMY3)','Chicago TMY3','Los Angeles TMY3','Boston TMY3'] },
    ],
    help: 'Selects the TMY3 weather file for energy simulation. NYC uses ASHRAE 90.1-2019 climate zone 7A.',
  },
  {
    id: 'en_form_trigger', category: 'energy', label: 'EN Form Trigger', icon: '📋',
    inputs: [
      { id: 'sim_results', label: 'Sim Results', type: 'struct' },
    ],
    outputs: [
      { id: 'forms', label: 'Forms', type: 'struct' },
    ],
    params: [
      { label: 'Form Set', key: 'form_set', type: 'select', options: ['EN-001–EN-008 Full','EN-001 only','Custom'] },
    ],
    help: 'Auto-fills DOB Local Law 33/87 compliance forms (EN-001 through EN-008) from energy simulation results.',
  },

  // SIMULATION
  {
    id: 'structural_sim', category: 'simulation', label: 'Structural Sim', icon: '⊞',
    inputs: [
      { id: 'members', label: 'Members', type: 'struct' },
    ],
    outputs: [
      { id: 'displacements', label: 'Displacements', type: 'geometry' },
      { id: 'forces', label: 'Forces', type: 'struct' },
    ],
    params: [
      { label: 'Method', key: 'method', type: 'select', options: ['Direct Stiffness','Lumped Mass','Ritz Vectors'] },
    ],
    help: 'Linear static structural analysis via direct stiffness method. Outputs displacement field and member forces.',
  },
  {
    id: 'fire_sim', category: 'simulation', label: 'Fire Sim (FDS)', icon: '🔥',
    inputs: [
      { id: 'floor_plan', label: 'Floor Plan', type: 'geometry' },
    ],
    outputs: [
      { id: 'tenability', label: 'Tenability', type: 'struct' },
    ],
    params: [
      { label: 'Fire HRR (kW)', key: 'hrr', type: 'number', default: '3000' },
      { label: 'Occupancy', key: 'occupancy', type: 'select', options: ['Assembly','Business','Educational','Mercantile'] },
    ],
    help: 'Fire dynamics simulation using NIST FDS formulas. NFPA 101 egress time and tenability limits.',
  },
  {
    id: 'geotech_sim', category: 'simulation', label: 'Geotech Sim', icon: '⛰',
    inputs: [
      { id: 'soil_profile', label: 'Soil Profile', type: 'struct' },
    ],
    outputs: [
      { id: 'bearing', label: 'Bearing', type: 'struct' },
      { id: 'settlement', label: 'Settlement', type: 'struct' },
    ],
    params: [
      { label: 'Method', key: 'method', type: 'select', options: ['Terzaghi','Meyerhof','Briaud','NAVFAC'] },
    ],
    help: 'Bearing capacity and settlement analysis per Terzaghi/Meyerhof/NAVFAC methods.',
  },
  {
    id: 'mep_airflow', category: 'simulation', label: 'MEP Airflow', icon: '💨',
    inputs: [
      { id: 'ducts', label: 'Ducts', type: 'struct' },
      { id: 'zones', label: 'Zones', type: 'struct' },
    ],
    outputs: [
      { id: 'pressures', label: 'Pressures', type: 'struct' },
      { id: 'flows', label: 'Flows', type: 'struct' },
    ],
    params: [
      { label: 'Solver', key: 'solver', type: 'select', options: ['Hardy-Cross','Flow Network','CFD'] },
    ],
    help: 'HVAC airflow network analysis. Hardy-Cross for distribution, CFD for detailed patterns.',
  },

  // DATA
  {
    id: 'project_info', category: 'data', label: 'Project Info', icon: '📁',
    inputs: [],
    outputs: [
      { id: 'name', label: 'Name', type: 'string' },
      { id: 'address', label: 'Address', type: 'string' },
      { id: 'bin', label: 'BIN', type: 'string' },
      { id: 'levels', label: 'Levels', type: 'struct' },
    ],
    params: [
      { label: 'Project Name', key: 'name', type: 'text', default: 'New Project' },
      { label: 'Address', key: 'address', type: 'text', default: '' },
      { label: 'BIN', key: 'bin', type: 'text', default: '' },
    ],
    help: 'Project metadata node. Address + BIN are required for DOB filing. Levels output feeds elevation binding.',
  },
  {
    id: 'material_library', category: 'data', label: 'Material Library', icon: '🧱',
    inputs: [
      { id: 'search', label: 'Search', type: 'string', default: '' },
    ],
    outputs: [
      { id: 'material', label: 'Material', type: 'struct' },
    ],
    params: [
      { label: 'Material', key: 'material', type: 'select', options: ['Concrete 30MPa','Steel A992','Aluminum 6061-T6','Masonry CMU','Timber GL24h'] },
      { label: 'Conductivity (W/mK)', key: 'k', type: 'number', default: '1.8' },
    ],
    help: 'Searchable material library. Materials drive energy simulation (conductivity) and structural analysis (Fy/Fu).',
  },
  {
    id: 'dob_filing_trigger', category: 'data', label: 'DOB Filing Trigger', icon: '🏛',
    inputs: [
      { id: 'sim_results', label: 'Sim Results', type: 'struct' },
      { id: 'project_info', label: 'Project Info', type: 'struct' },
    ],
    outputs: [
      { id: 'package', label: 'Package', type: 'struct' },
    ],
    params: [
      { label: 'Filing Type', key: 'filing_type', type: 'select', options: ['NB','A1','A2','A3','POST'] },
    ],
    help: 'Triggers the 9-PDF DOB submission bundle generation (energy analysis, code compliance, fire protection).',
  },

  // DESIGN OPTIONS
  {
    id: 'create_option_set', category: 'design', label: 'Create Option Set', icon: '⚙',
    inputs: [
      { id: 'name', label: 'Name', type: 'string', default: 'Option Set A' },
    ],
    outputs: [
      { id: 'option_set', label: 'Option Set', type: 'struct' },
    ],
    params: [
      { label: 'Name', key: 'name', type: 'text', default: 'Option Set A' },
    ],
    help: 'Creates a Design Options set for comparative studies. Multiple alternatives can be switched on/off.',
  },
  {
    id: 'add_alternative', category: 'design', label: 'Add Alternative', icon: '+',
    inputs: [
      { id: 'option_set', label: 'Option Set', type: 'struct' },
    ],
    outputs: [
      { id: 'alt', label: 'Alternative', type: 'struct' },
    ],
    params: [
      { label: 'Name', key: 'name', type: 'text', default: 'Alternative B' },
    ],
    help: 'Adds an alternative to a Design Options set. Connect elements to the alternative to group them.',
  },
  {
    id: 'compare_options', category: 'design', label: 'Compare Options', icon: '⚖',
    inputs: [
      { id: 'options', label: 'Options', type: 'struct' },
    ],
    outputs: [
      { id: 'summary', label: 'Summary', type: 'struct' },
    ],
    params: [
      { label: 'Metric', key: 'metric', type: 'select', options: ['Cost ($/m²)','Energy EUI (kBtu/m²)','Carbon (kgCO₂/m²)','Schedule Impact'] },
    ],
    help: 'Compares Design Options across a chosen metric. Generates a comparison table in the Simulation Timeline.',
  },
  {
    id: 'publish_winning', category: 'design', label: 'Publish Winning', icon: '✓',
    inputs: [
      { id: 'option', label: 'Option', type: 'struct' },
    ],
    outputs: [],
    params: [],
    help: 'Commits a Design Option as the winning alternative. All others are discarded.',
  },

  // ── Phase 29 MVP: Geometry Primitives ───────────────────────────────────────
  // These 8 nodes create real BIM geometry pushed to the event ledger.

  {
    id: 'ne_point', category: 'geometry', label: 'Point', icon: '·',
    inputs: [
      { id: 'x', label: 'X', type: 'number', default: 0 },
      { id: 'y', label: 'Y', type: 'number', default: 0 },
      { id: 'z', label: 'Z', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'point', label: 'Point', type: 'geometry' },
    ],
    params: [],
    help: 'Creates a 3D point at (X, Y, Z) in meters. Feed into Line, Polyline, or Wall nodes.',
  },
  {
    id: 'ne_line', category: 'geometry', label: 'Line', icon: '—',
    inputs: [
      { id: 'start', label: 'Start', type: 'geometry' },
      { id: 'end',   label: 'End',   type: 'geometry' },
    ],
    outputs: [
      { id: 'line', label: 'Line', type: 'geometry' },
    ],
    params: [],
    help: 'Creates a straight line between two Point nodes. Feed into Wall or Extrude.',
  },
  {
    id: 'ne_polyline', category: 'geometry', label: 'Polyline', icon: '∿',
    inputs: [
      { id: 'points', label: 'Points', type: 'geometry' },
    ],
    outputs: [
      { id: 'polyline', label: 'Polyline', type: 'geometry' },
    ],
    params: [
      { label: 'Closed', key: 'closed', type: 'boolean', default: false },
    ],
    help: 'Creates a polyline through an array of Point nodes. Set closed=true for a polygon.',
  },
  {
    id: 'ne_wall', category: 'geometry', label: 'Wall', icon: '▭',
    inputs: [
      { id: 'line',    label: 'Line',    type: 'geometry' },
      { id: 'height',  label: 'Height',  type: 'number', default: 3000 },
      { id: 'thickness', label: 'Thickness', type: 'number', default: 200 },
    ],
    outputs: [
      { id: 'element', label: 'Element', type: 'struct' },
      { id: 'wall',   label: 'Wall',    type: 'geometry' },
    ],
    params: [
      { label: 'Height (mm)', key: 'height', type: 'number', default: '3000' },
      { label: 'Thickness (mm)', key: 'thickness', type: 'number', default: '200' },
      { label: 'Wall Type', key: 'wall_type', type: 'select', options: ['Generic 200mm', 'Curtain Wall', 'Masonry 300mm', 'Steel Stud', 'Concrete 250mm'] },
    ],
    help: 'Creates a real BIM wall. Connect a Line node for the path, set Height and Thickness.',
  },
  {
    id: 'ne_window', category: 'geometry', label: 'Window', icon: '⊡',
    inputs: [
      { id: 'wall',   label: 'Host Wall', type: 'geometry' },
      { id: 'offset', label: 'Offset',   type: 'number', default: 0.5 },
      { id: 'width',  label: 'Width',    type: 'number', default: 1200 },
      { id: 'height', label: 'Height',  type: 'number', default: 1500 },
    ],
    outputs: [
      { id: 'element', label: 'Element', type: 'struct' },
    ],
    params: [
      { label: 'Width (mm)', key: 'width', type: 'number', default: '1200' },
      { label: 'Height (mm)', key: 'height', type: 'number', default: '1500' },
      { label: 'Sill Height (mm)', key: 'sill_height', type: 'number', default: '900' },
      { label: 'Window Type', key: 'window_type', type: 'select', options: ['Fixed', 'Casement', 'Double-Hung', 'Sliding'] },
    ],
    help: 'Places a window on a Wall node. Offset is a 0–1 fraction along the wall. Auto-cuts wall.',
  },
  {
    id: 'ne_extrude', category: 'geometry', label: 'Extrude', icon: '↑',
    inputs: [
      { id: 'profile', label: 'Profile', type: 'geometry' },
      { id: 'height',  label: 'Height',  type: 'number', default: 3000 },
    ],
    outputs: [
      { id: 'solid', label: 'Solid', type: 'geometry' },
    ],
    params: [
      { label: 'Height (mm)', key: 'height', type: 'number', default: '3000' },
      { label: 'Direction', key: 'direction', type: 'select', options: ['+Z', '-Z', '+X', '-X', '+Y', '-Y'] },
    ],
    help: 'Extrudes a polyline profile along an axis to create a 3D solid. Useful for slabs, columns.',
  },
  {
    id: 'ne_mirror', category: 'geometry', label: 'Mirror', icon: '◁',
    inputs: [
      { id: 'geometry', label: 'Geometry', type: 'geometry' },
      { id: 'axis',     label: 'Axis',     type: 'enum',    default: 'X' },
    ],
    outputs: [
      { id: 'mirrored', label: 'Mirrored', type: 'geometry' },
    ],
    params: [
      { label: 'Axis', key: 'axis', type: 'select', options: ['X', 'Y', 'Z', 'XY', 'XZ', 'YZ'] },
      { label: 'Distance', key: 'distance', type: 'number', default: '0' },
    ],
    help: 'Mirrors geometry across a plane. Axis X/Y/Z mirrors in that cardinal direction.',
  },
  {
    id: 'ne_array', category: 'geometry', label: 'Array', icon: '≡',
    inputs: [
      { id: 'geometry', label: 'Geometry', type: 'geometry' },
      { id: 'count',    label: 'Count',    type: 'number',   default: 3 },
      { id: 'spacing',  label: 'Spacing',  type: 'number',   default: 3000 },
    ],
    outputs: [
      { id: 'items', label: 'Items', type: 'struct' },
    ],
    params: [
      { label: 'Count', key: 'count', type: 'number', default: '3' },
      { label: 'Spacing (mm)', key: 'spacing', type: 'number', default: '3000' },
      { label: 'Direction', key: 'direction', type: 'select', options: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] },
    ],
    help: 'Copies geometry N times along an axis. Results in an array of elements pushed to BIM.',
  },

  // ── Phase 29 MVP: BIM spawn nodes ───────────────────────────────────────────
  // These nodes call the element-create API when Execute is pressed.
  {
    id: 'ne_level', category: 'bim', label: 'Level', icon: '≡',
    inputs: [
      { id: 'name',      label: 'Name',      type: 'string',  default: 'Level 1' },
      { id: 'elevation', label: 'Elevation', type: 'number',  default: 0 },
    ],
    outputs: [
      { id: 'levelRef', label: 'Level Ref', type: 'struct' },
    ],
    params: [
      { label: 'Name',           key: 'name',      type: 'text',   default: 'Level 1' },
      { label: 'Elevation (mm)', key: 'elevation', type: 'number', default: '0' },
    ],
    help: 'Creates a building level at the given elevation. Pushes to the BIM model on Execute and returns a Level reference for Wall/Column nodes.',
  },
  {
    id: 'ne_bim_wall', category: 'bim', label: 'Wall', icon: '▭',
    inputs: [
      { id: 'baseLine',  label: 'Base Line',  type: 'geometry' },
      { id: 'height',    label: 'Height',    type: 'number',  default: 3000 },
      { id: 'thickness', label: 'Thickness', type: 'number',  default: 200 },
      { id: 'levelRef',  label: 'Level Ref', type: 'struct' },
    ],
    outputs: [
      { id: 'element', label: 'Wall Element', type: 'struct' },
    ],
    params: [
      { label: 'Height (mm)',    key: 'height',    type: 'number', default: '3000' },
      { label: 'Thickness (mm)', key: 'thickness', type: 'number', default: '200' },
      { label: 'Wall Type', key: 'wall_type', type: 'select', options: ['Generic 200mm', 'Curtain Wall', 'Masonry 300mm', 'Steel Stud', 'Concrete 250mm'] },
    ],
    help: 'BIM Wall — connects a Line node as baseLine. On Execute, spawns a wall element in the active project.',
  },
  {
    id: 'ne_column', category: 'bim', label: 'Column', icon: '⊢',
    inputs: [
      { id: 'basePoint', label: 'Base Point', type: 'geometry' },
      { id: 'height',    label: 'Height',    type: 'number',  default: 3000 },
      { id: 'profile',   label: 'Profile',   type: 'string',  default: 'W12x26' },
      { id: 'levelRef',  label: 'Level Ref', type: 'struct' },
    ],
    outputs: [
      { id: 'element', label: 'Column Element', type: 'struct' },
    ],
    params: [
      { label: 'Profile', key: 'profile', type: 'select', options: ['W12x26','W14x48','W310×97','W360×134','HSS 152×152×9','HSS 203×203×13'] },
      { label: 'Height (mm)', key: 'height', type: 'number', default: '3000' },
      { label: 'Base Offset (mm)', key: 'base_offset', type: 'number', default: '0' },
    ],
    help: 'BIM Column — connect a Point as basePoint. On Execute, spawns a structural column in the active project.',
  },

  // ── Phase 29 MVP: Core scripting primitives ─────────────────────────────────
  // Number → Level.ByElevation → Watch is the canonical first Dynamo graph.
  {
    id: 'ne_number', category: 'data', label: 'Number', icon: '#',
    inputs: [],
    outputs: [
      { id: 'value', label: 'Value', type: 'number' },
    ],
    params: [
      { label: 'Value', key: 'value', type: 'number', default: '0' },
    ],
    help: 'Emits a constant number. Drag the value field or type a number. Connect to any Number input port.',
  },
  {
    id: 'ne_add', category: 'data', label: 'Add', icon: '+',
    inputs: [
      { id: 'a', label: 'A', type: 'number', default: 0 },
      { id: 'b', label: 'B', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'result', label: 'Result', type: 'number' },
    ],
    params: [],
    help: 'Adds two numbers. Result = A + B.',
  },
  {
    id: 'ne_multiply', category: 'data', label: 'Multiply', icon: '×',
    inputs: [
      { id: 'a', label: 'A', type: 'number', default: 0 },
      { id: 'b', label: 'B', type: 'number', default: 1 },
    ],
    outputs: [
      { id: 'result', label: 'Result', type: 'number' },
    ],
    params: [],
    help: 'Multiplies two numbers. Result = A × B.',
  },
  {
    id: 'ne_subtract', category: 'data', label: 'Subtract', icon: '−',
    inputs: [
      { id: 'a', label: 'A', type: 'number', default: 0 },
      { id: 'b', label: 'B', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'result', label: 'Result', type: 'number' },
    ],
    params: [],
    help: 'Subtracts two numbers. Result = A − B.',
  },
  {
    id: 'ne_divide', category: 'data', label: 'Divide', icon: '÷',
    inputs: [
      { id: 'a', label: 'A', type: 'number', default: 0 },
      { id: 'b', label: 'B', type: 'number', default: 1 },
    ],
    outputs: [
      { id: 'result', label: 'Result', type: 'number' },
    ],
    params: [],
    help: 'Divides two numbers. Result = A ÷ B. Returns 0 when B = 0.',
  },
  {
    id: 'ne_level_by_elevation', category: 'geometry', label: 'Level.ByElevation', icon: '≡',
    inputs: [
      { id: 'elevation', label: 'Elevation (mm)', type: 'number', default: 0 },
    ],
    outputs: [
      { id: 'level', label: 'Level', type: 'struct' },
    ],
    params: [
      { label: 'Name', key: 'name', type: 'text', default: 'Level 1' },
      { label: 'Elevation (mm)', key: 'elevation', type: 'number', default: '0' },
    ],
    help: 'Creates a building level at the given elevation (mm). Pushes to the BIM model and DAG constraint solver. Chain Number → Level.ByElevation → Watch to see it appear in the 3D viewport.',
  },
  {
    id: 'ne_watch', category: 'data', label: 'Watch', icon: '👁',
    inputs: [
      { id: 'value', label: 'Value', type: 'any' },
    ],
    outputs: [],
    params: [],
    help: 'Displays the connected value inline. Attach to any output port to observe computed values. Errors show in red.',
  },
];

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  open: false,
  nodes: [],           // { id, typeId, x, y, params, inputValues, outputValues }
  connections: [],     // { id, fromNodeId, fromPort, toNodeId, toPort }
  _levelNodeMap: {},   // nodeId → levelId: avoids duplicate level creation on re-eval
  selectedNodeId: null,
  draggingNodeId: null,
  dragOffsetX: 0,
  dragOffsetY: 0,
  connecting: null,    // { fromNodeId, fromPort, tempX, tempY }
  panning: false,
  panStartX: 0,
  panStartY: 0,
  offsetX: 0,
  offsetY: 0,
  zoom: 1,
  undoStack: [],
  redoStack: [],
  minimapCtx: null,
  helpTooltip: null,
  contextMenu: null,
  nodeIdCounter: 1,
  connIdCounter: 1,
  searchQuery: '',
  collapsedCategories: {},
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getNodeType(id) {
  return NODE_TYPES.find(n => n.id === id);
}

function getPortColor(type) {
  return PORT_TYPES[type]?.color || '#888';
}

function getWireClass(type) {
  return PORT_TYPES[type]?.wireClass || 'ne-wire-default';
}

function makeNodeId() { return 'node_' + (state.nodeIdCounter++); }
function makeConnId() { return 'conn_' + (state.connIdCounter++); }

function snapZoom(z) {
  return Math.min(Math.max(z, 0.25), 4.0);
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  const canvas = document.getElementById('ne-canvas');
  if (!canvas) return;

  // Render connections (SVG)
  const svg = document.getElementById('ne-connections');
  if (svg) {
    svg.innerHTML = '';
    renderConnections(svg);
  }

  // Render nodes (DOM)
  const existingNodes = canvas.querySelectorAll('.ne-node');
  existingNodes.forEach(n => n.remove());

  state.nodes.forEach(node => {
    const el = createNodeElement(node);
    canvas.appendChild(el);
  });

  // Update zoom indicator
  const zi = document.getElementById('ne-zoom-indicator');
  if (zi) zi.textContent = Math.round(state.zoom * 100) + '%';

  // Update minimap
  renderMinimap();

  // Update empty state
  const empty = document.getElementById('ne-empty-state');
  if (empty) {
    empty.style.display = state.nodes.length === 0 ? 'flex' : 'none';
  }
}

function renderConnections(svg) {
  state.connections.forEach(conn => {
    const fromNode = state.nodes.find(n => n.id === conn.fromNodeId);
    const toNode = state.nodes.find(n => n.id === conn.toNodeId);
    if (!fromNode || !toNode) return;

    const fromType = getNodeType(fromNode.typeId);
    const toType = getNodeType(toNode.typeId);
    if (!fromType || !toType) return;

    const fromPortIdx = fromType.outputs.findIndex(p => p.id === conn.fromPort);
    const toPortIdx = toType.inputs.findIndex(p => p.id === conn.toPort);
    if (fromPortIdx < 0 || toPortIdx < 0) return;

    const fromEl = document.querySelector(`[data-node-id="${conn.fromNodeId}"]`);
    const toEl = document.querySelector(`[data-node-id="${conn.toNodeId}"]`);
    if (!fromEl || !toEl) return;

    const outPort = fromEl.querySelectorAll('.ne-port.output')[fromPortIdx];
    const inPort = toEl.querySelectorAll('.ne-port.input')[toPortIdx];
    if (!outPort || !inPort) return;

    const fromRect = outPort.getBoundingClientRect();
    const toRect = inPort.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();

    const x1 = fromRect.left + fromRect.width / 2 - svgRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - svgRect.top;
    const x2 = toRect.left + toRect.width / 2 - svgRect.left;
    const y2 = toRect.top + toRect.height / 2 - svgRect.top;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const cx = (x1 + x2) / 2;
    path.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'ne-connection-path ' + getWireClass(conn.wireType || 'any'));
    path.dataset.connId = conn.id;
    svg.appendChild(path);
  });

  // Preview connection while dragging
  if (state.connecting) {
    const fromNode = state.nodes.find(n => n.id === state.connecting.fromNodeId);
    if (fromNode) {
      const fromType = getNodeType(fromNode.typeId);
      if (fromType) {
        const fromEl = document.querySelector(`[data-node-id="${state.connecting.fromNodeId}"]`);
        if (fromEl) {
          const outPorts = fromEl.querySelectorAll('.ne-port.output');
          const portIdx = fromType.outputs.findIndex(p => p.id === state.connecting.fromPort);
          if (outPorts[portIdx]) {
            const fromRect = outPorts[portIdx].getBoundingClientRect();
            const svgRect = svg.getBoundingClientRect();
            const x1 = fromRect.left + fromRect.width / 2 - svgRect.left;
            const y1 = fromRect.top + fromRect.height / 2 - svgRect.top;
            const x2 = (state.connecting.tempX - svgRect.left);
            const y2 = (state.connecting.tempY - svgRect.top);

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const cx = (x1 + x2) / 2;
            path.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
            path.setAttribute('class', 'ne-connection-path ne-wire-preview');
            svg.appendChild(path);
          }
        }
      }
    }
  }
}

function createNodeElement(node) {
  const type = getNodeType(node.typeId);
  if (!type) return null;

  const el = document.createElement('div');
  el.className = 'ne-node';
  el.dataset.nodeId = node.id;
  el.dataset.cat = type.category;
  if (state.selectedNodeId === node.id) el.classList.add('selected');

  // Apply zoom + pan transform
  el.style.transform = `translate(${node.x * state.zoom + state.offsetX}px, ${node.y * state.zoom + state.offsetY}px) scale(${state.zoom})`;
  el.style.transformOrigin = 'top left';

  el.innerHTML = `
    <div class="ne-node-header">
      <span class="ne-node-category-badge" style="background:${CATEGORY_COLORS[type.category]}22;color:${CATEGORY_COLORS[type.category]}">${type.category.toUpperCase()}</span>
      <span class="ne-node-title">${type.label}</span>
      <span class="ne-node-help" data-tip="${type.help?.replace(/"/g, '&quot;') || ''}" title="Help">?</span>
      <span class="ne-node-close" data-node-id="${node.id}">×</span>
    </div>
    <div class="ne-node-body">
      <div class="ne-node-ports">
        <div class="ne-node-ports-left">
          ${type.inputs.map((p, i) => `
            <div class="ne-port-row" data-port-type="input" data-port-id="${p.id}" data-node-id="${node.id}">
              <span class="ne-port input port-type-${p.type}" style="border-color:${getPortColor(p.type)};color:${getPortColor(p.type)}" data-port-id="${p.id}" data-node-id="${node.id}"></span>
              <span class="ne-port-label">${p.label}</span>
              <span class="ne-port-type-label">${PORT_TYPES[p.type]?.label || p.type}</span>
            </div>
          `).join('')}
        </div>
        <div class="ne-node-ports-right">
          ${type.outputs.map((p, i) => `
            <div class="ne-port-row" data-port-type="output" data-port-id="${p.id}" data-node-id="${node.id}">
              <span class="ne-port-type-label">${PORT_TYPES[p.type]?.label || p.type}</span>
              <span class="ne-port-label">${p.label}</span>
              <span class="ne-port output" style="border-color:${getPortColor(p.type)};color:${getPortColor(p.type)}" data-port-id="${p.id}" data-node-id="${node.id}"></span>
            </div>
          `).join('')}
        </div>
      </div>
      ${type.params.length > 0 ? `
        <div class="ne-node-params">
          ${type.params.map(p => `
            <div class="ne-param-row">
              <label class="ne-param-label">${p.label}</label>
              ${p.type === 'select' ? `
                <select class="ne-param-input" data-node-id="${node.id}" data-param-key="${p.key}">
                  ${p.options.map(o => `<option value="${o}" ${(node.params[p.key] || p.default) === o ? 'selected' : ''}>${o}</option>`).join('')}
                </select>
              ` : p.type === 'text' ? `
                <input type="text" class="ne-param-input" value="${node.params[p.key] || p.default || ''}" data-node-id="${node.id}" data-param-key="${p.key}" placeholder="${p.label}">
              ` : `
                <input type="number" class="ne-param-input" value="${node.params[p.key] ?? p.default}" data-node-id="${node.id}" data-param-key="${p.key}" step="any">
              `}
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${node.typeId === 'ne_watch' ? `
        <div class="ne-watch-display ${node._watchDisplay === undefined || node._watchDisplay === '—' ? 'ne-watch-empty' : ''}">
          ${node._watchDisplay !== undefined ? node._watchDisplay : '—'}
        </div>
      ` : ''}
    </div>
  `;

  // Wire up events
  el?.addEventListener('mousedown', onNodeMouseDown);
  el.querySelector('.ne-node-header')?.addEventListener('mousedown', onNodeHeaderMouseDown);
  el.querySelector('.ne-node-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeNode(node.id);
  });
  el.querySelector('.ne-node-help')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showHelpTooltip(type, e.clientX, e.clientY);
  });

  // Port events
  el.querySelectorAll('.ne-port').forEach(port => {
    port?.addEventListener('mousedown', onPortMouseDown);
  });

  // Param change events
  el.querySelectorAll('.ne-param-input').forEach(input => {
    input?.addEventListener('change', onParamChange);
    input?.addEventListener('mousedown', e => e.stopPropagation());
  });

  // Selection
  el?.addEventListener('click', (e) => {
    if (!e.target.closest('.ne-port') && !e.target.closest('.ne-node-close') && !e.target.closest('.ne-node-help') && !e.target.closest('input,select')) {
      selectNode(node.id);
    }
  });

  // Context menu
  el?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectNode(node.id);
    showContextMenu(e.clientX, e.clientY, node.id);
  });

  return el;
}

// ── Node creation ────────────────────────────────────────────────────────────
function addNode(typeId, x, y) {
  const type = getNodeType(typeId);
  if (!type) return;

  pushUndo();
  const node = {
    id: makeNodeId(),
    typeId,
    x: (x - state.offsetX) / state.zoom,
    y: (y - state.offsetY) / state.zoom,
    params: Object.fromEntries((type.params || []).map(p => [p.key, p.default || ''])),
    inputValues: {},
    outputValues: {},
  };
  state.nodes.push(node);
  selectNode(node.id);
  render();
  return node;
}

function removeNode(nodeId) {
  pushUndo();
  state.connections = state.connections.filter(c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId);
  state.nodes = state.nodes.filter(n => n.id !== nodeId);
  if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
  render();
  scheduleEvaluate();
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  render();
  updatePropertiesPanel();
}

function duplicateNode(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const newNode = addNode(node.typeId, (node.x + 50) * state.zoom + state.offsetX, (node.y + 50) * state.zoom + state.offsetY);
  if (newNode) {
    newNode.params = { ...node.params };
    render();
  }
}

// ── Connection logic ─────────────────────────────────────────────────────────
function canConnect(fromNodeId, fromPortId, toNodeId, toPortId) {
  if (fromNodeId === toNodeId) return false;
  const fromNode = state.nodes.find(n => n.id === fromNodeId);
  const toNode = state.nodes.find(n => n.id === toNodeId);
  if (!fromNode || !toNode) return false;

  const fromType = getNodeType(fromNode.typeId);
  const toType = getNodeType(toNode.typeId);
  if (!fromType || !toType) return false;

  const fromPort = fromType.outputs.find(p => p.id === fromPortId);
  const toPort = toType.inputs.find(p => p.id === toPortId);
  if (!fromPort || !toPort) return false;

  return fromPort.type === toPort.type || fromPort.type === 'any' || toPort.type === 'any';
}

function addConnection(fromNodeId, fromPort, toNodeId, toPort) {
  // Remove existing connection to same input port
  state.connections = state.connections.filter(c => !(c.toNodeId === toNodeId && c.toPort === toPort));

  pushUndo();
  const fromType = getNodeType(state.nodes.find(n => n.id === fromNodeId)?.typeId);
  const fromPortDef = fromType?.outputs.find(p => p.id === fromPort);
  state.connections.push({
    id: makeConnId(),
    fromNodeId,
    fromPort,
    toNodeId,
    toPort,
    wireType: fromPortDef?.type || 'any',
  });
  render();
  updatePropertiesPanel();
  scheduleEvaluate();
}

function removeConnection(connId) {
  pushUndo();
  state.connections = state.connections.filter(c => c.id !== connId);
  render();
}

// ── Drag node ────────────────────────────────────────────────────────────────
function onNodeHeaderMouseDown(e) {
  if (e.target.classList.contains('ne-node-help') || e.target.classList.contains('ne-node-close') || e.target.closest('input,select')) return;
  e.preventDefault();
  e.stopPropagation();

  const nodeEl = e.target.closest('.ne-node');
  const nodeId = nodeEl.dataset.nodeId;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;

  state.draggingNodeId = nodeId;
  state.dragOffsetX = e.clientX;
  state.dragOffsetY = e.clientY;

  const onMove = (ev) => {
    const node = state.nodes.find(n => n.id === state.draggingNodeId);
    if (!node) return;
    const dx = (ev.clientX - state.dragOffsetX) / state.zoom;
    const dy = (ev.clientY - state.dragOffsetY) / state.zoom;
    node.x += dx;
    node.y += dy;
    state.dragOffsetX = ev.clientX;
    state.dragOffsetY = ev.clientY;
    render();
  };

  const onUp = () => {
    state.draggingNodeId = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function onNodeMouseDown(e) {
  if (e.target.closest('.ne-port') || e.target.closest('input,select') || e.target.closest('.ne-node-close') || e.target.closest('.ne-node-help')) return;
  e.stopPropagation();
}

// ── Port connection ──────────────────────────────────────────────────────────
function onPortMouseDown(e) {
  e.preventDefault();
  e.stopPropagation();

  const portEl = e.target;
  const nodeId = portEl.dataset.nodeId;
  const portId = portEl.dataset.portId;
  const portType = portEl.closest('.ne-port-row').dataset.portType;

  if (portType === 'output') {
    state.connecting = {
      fromNodeId: nodeId,
      fromPort: portId,
      tempX: e.clientX,
      tempY: e.clientY,
    };

    // Highlight compatible input ports
    document.querySelectorAll('.ne-port.input').forEach(p => {
      const n = p.dataset.nodeId;
      const pp = p.dataset.portId;
      if (canConnect(nodeId, portId, n, pp)) {
        p.classList.add('highlight');
      }
    });

    const onMove = (ev) => {
      if (state.connecting) {
        state.connecting.tempX = ev.clientX;
        state.connecting.tempY = ev.clientY;
        render();
      }
    };

    const onUp = (ev) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetPort = target?.closest('.ne-port.input');
      if (targetPort && canConnect(nodeId, portId, targetPort.dataset.nodeId, targetPort.dataset.portId)) {
        addConnection(nodeId, portId, targetPort.dataset.nodeId, targetPort.dataset.portId);
      }
      state.connecting = null;
      document.querySelectorAll('.ne-port.highlight').forEach(p => p.classList.remove('highlight'));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      render();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  } else {
    // Input port: look for existing connection to disconnect
    const conn = state.connections.find(c => c.toNodeId === nodeId && c.toPort === portId);
    if (conn) {
      removeConnection(conn.id);
    }
  }
}

// ── Param change ─────────────────────────────────────────────────────────────
function onParamChange(e) {
  const nodeId = e.target.dataset.nodeId;
  const key = e.target.dataset.paramKey;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;

  pushUndo();
  node.params[key] = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
  updatePropertiesPanel();

  // Trigger DAG re-solve if connected to constraint/sim nodes
  triggerDAGSolve(node);
}

// ── Pan & Zoom ────────────────────────────────────────────────────────────────
function setupCanvasInteraction() {
  const canvasWrap = document.getElementById('ne-canvas-wrap');
  if (!canvasWrap) return;

  canvasWrap?.addEventListener('mousedown', (e) => {
    if (e.target === document.getElementById('ne-canvas') || e.target === document.getElementById('ne-connections')) {
      state.selectedNodeId = null;
      state.panning = true;
      state.panStartX = e.clientX - state.offsetX;
      state.panStartY = e.clientY - state.offsetY;
      canvasWrap.style.cursor = 'grabbing';
      render();
      updatePropertiesPanel();
    }
  });

  canvasWrap?.addEventListener('mousemove', (e) => {
    if (state.panning) {
      state.offsetX = e.clientX - state.panStartX;
      state.offsetY = e.clientY - state.panStartY;
      render();
    }
  });

  canvasWrap?.addEventListener('mouseup', () => {
    state.panning = false;
    canvasWrap.style.cursor = 'crosshair';
  });

  // Space+drag pan
  let spaceDown = false;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input,textarea')) {
      spaceDown = true;
      canvasWrap.style.cursor = 'grab';
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      canvasWrap.style.cursor = 'crosshair';
    }
  });

  canvasWrap?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasWrap.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = snapZoom(state.zoom * delta);

    const worldX = (mouseX - state.offsetX) / state.zoom;
    const worldY = (mouseY - state.offsetY) / state.zoom;

    state.zoom = newZoom;
    state.offsetX = mouseX - worldX * state.zoom;
    state.offsetY = mouseY - worldY * state.zoom;

    render();
  }, { passive: false });
}

// ── Undo / Redo ──────────────────────────────────────────────────────────────
function pushUndo() {
  state.undoStack.push(JSON.stringify({ nodes: state.nodes, connections: state.connections }));
  state.redoStack = [];
  if (state.undoStack.length > 50) state.undoStack.shift();
}

function undo() {
  if (state.undoStack.length === 0) return;
  state.redoStack.push(JSON.stringify({ nodes: state.nodes, connections: state.connections }));
  const prev = JSON.parse(state.undoStack.pop());
  state.nodes = prev.nodes;
  state.connections = prev.connections;
  render();
}

function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(JSON.stringify({ nodes: state.nodes, connections: state.connections }));
  const next = JSON.parse(state.redoStack.pop());
  state.nodes = next.nodes;
  state.connections = next.connections;
  render();
}

// ── Auto-Evaluate Engine (Phase 29 MVP) ────────────────────────────────────
// Debounced evaluation — runs 100ms after any graph change.
// Computes the graph, creates BIM geometry, pushes to event ledger.

let _evaluateTimer = null;

function scheduleEvaluate() {
  clearTimeout(_evaluateTimer);
  _evaluateTimer = setTimeout(() => {
    evaluateGraph();
  }, 100);
}

function evaluateGraph() {
  // Build adjacency + compute topological order
  const adj = {};
  const inDeg = {};
  state.nodes.forEach(n => { adj[n.id] = []; inDeg[n.id] = 0; });
  state.connections.forEach(c => {
    if (adj[c.fromNodeId]) adj[c.fromNodeId].push(c.toNodeId);
    if (inDeg[c.toNodeId] !== undefined) inDeg[c.toNodeId]++;
  });

  // Kahn's algorithm for topological sort
  const queue = state.nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj[id] || []) {
      if (--inDeg[next] === 0) queue.push(next);
    }
  }

  if (order.length !== state.nodes.length) {
    showToast('❌ Circular dependency in node graph', 'error');
    return;
  }

  // Collect evaluated results
  const results = {}; // nodeId → computed values

  for (const nodeId of order) {
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) continue;
    results[nodeId] = evaluateNode(node, results);
  }

  // Collect BIM elements to push (only geometry nodes that produced elements)
  const toCreate = [];
  state.nodes.forEach(node => {
    const result = results[node.id];
    if (!result) return;
    if (result._element) toCreate.push(result._element);
    if (result._elements && result._elements.length) {
      toCreate.push(...result._elements);
    }
  });

  if (toCreate.length > 0) {
    pushElementsToBIM(toCreate);
  }

  render();
}

function evaluateNode(node, results) {
  const type = getNodeType(node.typeId);
  if (!type) return {};

  // Gather connected inputs from upstream nodes.
  // Use ?? instead of || so numeric 0 and boolean false propagate correctly.
  const inputs = {};
  state.connections.filter(c => c.toNodeId === node.id).forEach(c => {
    const src = results[c.fromNodeId];
    if (src !== undefined && src !== null) {
      // Prefer the named output port value, fall back to _out (single-output nodes), then src itself
      const portVal = src[c.fromPort];
      inputs[c.toPort] = portVal !== undefined ? portVal : (src._out !== undefined ? src._out : src);
    }
  });

  const params = node.params || {};

  switch (node.typeId) {
    case 'ne_point': {
      const x = inputs.x ?? params.x ?? 0;
      const y = inputs.y ?? params.y ?? 0;
      const z = inputs.z ?? params.z ?? 0;
      return { _out: { x, y, z }, point: { x, y, z }, x, y, z };
    }
    case 'ne_line': {
      const start = inputs.start || params._start || { x: 0, y: 0, z: 0 };
      const end   = inputs.end   || params._end   || { x: 1, y: 0, z: 0 };
      return { _out: { start, end }, line: { start, end }, start, end };
    }
    case 'ne_polyline': {
      const pts = inputs.points || params._points || [];
      return { _out: { points: pts }, polyline: { points: pts, closed: params.closed || false }, _points: pts };
    }
    case 'ne_wall': {
      const lineData = inputs.line || {};
      const start = lineData.start || params._start || { x: 0, y: 0, z: 0 };
      const end   = lineData.end   || params._end   || { x: params.length || 6, y: 0, z: 0 };
      const height  = parseFloat(inputs.height  ?? params.height   ?? 3000) / 1000;
      const thick   = parseFloat(inputs.thickness ?? params.thickness ?? 0.2);
      return {
        _out: { start, end, height, thickness: thick },
        element: { type: 'wall', params },
        wall: { start, end, height, thickness: thick },
        _element: { nodeId: node.id, type: 'wall', start, end, height, thickness: thick, wall_type: params.wall_type || 'Generic 200mm', nodeX: node.x, nodeY: node.y },
      };
    }
    case 'ne_window': {
      const wallGeom = inputs.wall || {};
      const offset   = inputs.offset ?? params.offset ?? 0.5;
      const width    = (inputs.width  ?? params.width  ?? 1200) / 1000;
      const height   = (inputs.height ?? params.height ?? 1500) / 1000;
      const sill     = (params.sill_height ?? 900) / 1000;
      return {
        _out: { wallGeom, offset, width, height },
        element: { type: 'window', params },
        _element: { nodeId: node.id, type: 'window', hostWall: wallGeom, offset, width, height, sill, window_type: params.window_type || 'Fixed', nodeX: node.x, nodeY: node.y },
      };
    }
    case 'ne_extrude': {
      const profile = inputs.profile || {};
      const pts     = profile.points || params._points || [];
      const height  = (inputs.height ?? params.height ?? 3000) / 1000;
      const dir     = params.direction || '+Z';
      return {
        _out: { profile, height, direction: dir },
        solid: { profile, height, direction: dir },
        _element: { nodeId: node.id, type: 'extrude', profile: pts, height, direction: dir, nodeX: node.x, nodeY: node.y },
      };
    }
    case 'ne_mirror': {
      const geom = inputs.geometry || {};
      const axis = inputs.axis ?? params.axis ?? 'X';
      const dist = parseFloat(inputs.distance ?? params.distance ?? 0);
      return {
        _out: { geometry: geom, axis, distance: dist },
        mirrored: { geometry: geom, axis, distance: dist },
      };
    }
    case 'ne_array': {
      const geom   = inputs.geometry || {};
      const count  = parseInt(inputs.count    ?? params.count    ?? 3);
      const space  = (inputs.spacing ?? params.spacing ?? 3000) / 1000;
      const dir    = params.direction || '+X';
      // Generate N copies of the geometry
      const items = [];
      const dx = dir === '+X' ? space : dir === '-X' ? -space : 0;
      const dy = dir === '+Y' ? space : dir === '-Y' ? -space : 0;
      const dz = dir === '+Z' ? space : dir === '-Z' ? -space : 0;
      for (let i = 0; i < count; i++) {
        items.push({ index: i, offset: { x: dx * i, y: dy * i, z: dz * i }, original: geom });
      }
      return {
        _out: { items },
        items,
        _elements: items.map((item, i) => ({
          nodeId: node.id + '_' + i,
          type: 'array_item',
          baseGeom: geom,
          offset: item.offset,
          direction: dir,
          index: i,
        })),
      };
    }
    // ── Phase 29 MVP: core scripting nodes ───────────────────────────────────
    case 'ne_number': {
      const val = parseFloat(inputs.value ?? params.value ?? 0);
      return { _out: val, value: val };
    }
    case 'ne_add': {
      const a = parseFloat(inputs.a ?? params.a ?? 0);
      const b = parseFloat(inputs.b ?? params.b ?? 0);
      const result = a + b;
      return { _out: result, result };
    }
    case 'ne_multiply': {
      const a = parseFloat(inputs.a ?? params.a ?? 0);
      const b = parseFloat(inputs.b ?? params.b ?? 1);
      const result = a * b;
      return { _out: result, result };
    }
    case 'ne_subtract': {
      const a = parseFloat(inputs.a ?? params.a ?? 0);
      const b = parseFloat(inputs.b ?? params.b ?? 0);
      const result = a - b;
      return { _out: result, result };
    }
    case 'ne_divide': {
      const a = parseFloat(inputs.a ?? params.a ?? 0);
      const b = parseFloat(inputs.b ?? params.b ?? 1);
      // Guard divide-by-zero
      const result = b === 0 ? 0 : a / b;
      return { _out: result, result };
    }
    // BIM spawn nodes — produce _element markers consumed by executeGraph()
    case 'ne_level': {
      const elevation = parseFloat(inputs.elevation ?? params.elevation ?? 0);
      const name = (inputs.name ?? params.name ?? 'Level 1').toString();
      return {
        _out: { name, elevation },
        levelRef: { name, elevation },
        _element: { nodeId: node.id, type: 'bim_level', name, elevation },
      };
    }
    case 'ne_bim_wall': {
      const lineData = inputs.baseLine || {};
      const start = lineData.start || { x: 0, y: 0, z: 0 };
      const end   = lineData.end   || { x: params.length || 6, y: 0, z: 0 };
      const height    = parseFloat(inputs.height    ?? params.height    ?? 3000) / 1000;
      const thickness = parseFloat(inputs.thickness ?? params.thickness ?? 200)  / 1000;
      const levelRef  = inputs.levelRef || {};
      return {
        _out: { start, end, height, thickness },
        element: { type: 'wall', start, end },
        _element: {
          nodeId: node.id, type: 'bim_wall',
          start, end, height, thickness,
          wall_type: params.wall_type || 'Generic 200mm',
          levelRef,
        },
      };
    }
    case 'ne_column': {
      const pt      = inputs.basePoint || {};
      const x       = parseFloat(pt.x ?? pt._out?.x ?? params.x ?? 0);
      const z       = parseFloat(pt.z ?? pt._out?.z ?? params.z ?? 0);
      const height  = parseFloat(inputs.height ?? params.height ?? 3000) / 1000;
      const profile = (inputs.profile ?? params.profile ?? 'W12x26').toString();
      const levelRef = inputs.levelRef || {};
      return {
        _out: { x, z, height, profile },
        element: { type: 'column', x, z },
        _element: {
          nodeId: node.id, type: 'bim_column',
          x, z, height, profile,
          base_offset: parseFloat(params.base_offset ?? 0) / 1000,
          levelRef,
        },
      };
    }
    case 'ne_level_by_elevation': {
      // elevation can come from a connected Number node or from params
      const rawElevation = inputs.elevation ?? params.elevation ?? 0;
      // rawElevation may be a number object or a plain number
      const elevation = parseFloat(typeof rawElevation === 'object' ? (rawElevation._out ?? rawElevation.value ?? 0) : rawElevation);
      const name = params.name || 'Level 1';
      return {
        _out: { name, elevation },
        level: { name, elevation },
        _element: { nodeId: node.id, type: 'level', name, elevation },
      };
    }
    case 'ne_watch': {
      // Pass through — value is displayed in createNodeElement
      const raw = inputs.value;
      let display;
      if (raw === undefined || raw === null) {
        display = '—';
      } else if (typeof raw === 'object' && raw !== null) {
        // Structured value — show key fields
        if (raw.elevation !== undefined) display = `elevation: ${raw.elevation} mm`;
        else if (raw.value !== undefined) display = String(raw.value);
        else display = JSON.stringify(raw, null, 1).slice(0, 80);
      } else {
        display = String(raw);
      }
      node._watchDisplay = display;
      return { _out: raw, value: raw };
    }
    default: {
      // Legacy nodes: compute output values from params
      const out = {};
      if (type.outputs) {
        type.outputs.forEach(p => { out[p.id] = {}; });
      }
      return out;
    }
  }
}

// ── BIM Push ────────────────────────────────────────────────────────────────
// Push evaluated elements to the Atlantist API — they appear in the 3D viewport
// and in the Explorer tree, just like elements created via the toolbar.

async function pushElementsToBIM(elements) {
  const projectId = window._atlantist_current_project_id || window.atlantistActiveProjectId;
  if (!projectId) return;

  for (const el of elements) {
    if (el.type === 'wall') {
      try {
        await fetch('/api/elements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            type: 'wall',
            type_name: el.wall_type,
            parameters: {
              startCoord: { x: el.start.x, y: el.start.y },
              endCoord:   { x: el.end.x,   y: el.end.y },
              thickness:  el.thickness,
              loadBearing: true,
              phase: 'New Construction',
              _nodeId: el.nodeId,
            },
            elevation: 0,
          }),
        });
      } catch (e) {
        console.error('[node-editor] wall push error:', e);
      }
    } else if (el.type === 'window') {
      try {
        await fetch('/api/families', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            family_type: 'window',
            type_name: el.window_type,
            host_element_id: null, // wall reference set when wall is placed
            offset: el.offset,
            width: el.width,
            height: el.height,
            parameters: { _nodeId: el.nodeId },
          }),
        });
      } catch (e) {
        console.error('[node-editor] window push error:', e);
      }
    } else if (el.type === 'level') {
      // Level.ByElevation: upsert — PATCH existing if we already created it this session,
      // otherwise POST and record the returned id to avoid duplicates on re-eval.
      try {
        const existingId = state._levelNodeMap[el.nodeId];
        if (existingId) {
          await fetch(`/api/levels/${existingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: el.name || 'Level 1', elevation: el.elevation }),
          });
        } else {
          const res = await fetch('/api/levels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: projectId,
              name: el.name || 'Level 1',
              elevation: el.elevation,
            }),
          });
          if (res.ok) {
            let created;
            try { created = await res.json(); } catch {
              console.warn('[node-editor] level POST returned non-JSON');
              return;
            }
            if (created && created.id) state._levelNodeMap[el.nodeId] = created.id;
          }
        }
      } catch (e) {
        console.error('[node-editor] level push error:', e);
      }
    } else if (el.type === 'bim_level') {
      // ne_level node (BIM category) — same upsert logic as Level.ByElevation
      try {
        const existingId = state._levelNodeMap[el.nodeId];
        if (existingId) {
          await fetch(`/api/levels/${existingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: el.name || 'Level 1', elevation: el.elevation }),
          });
        } else {
          const res = await fetch('/api/levels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, name: el.name || 'Level 1', elevation: el.elevation }),
          });
          if (res.ok) {
            let created;
            try { created = await res.json(); } catch {
              console.warn('[node-editor] bim_level POST returned non-JSON');
              return;
            }
            if (created && created.id) {
              state._levelNodeMap[el.nodeId] = created.id;
              // Store resolved level id so downstream Wall/Column nodes can reference it
              el.levelRef = created;
            }
          }
        }
      } catch (e) {
        console.error('[node-editor] bim_level push error:', e);
      }
    } else if (el.type === 'bim_wall') {
      try {
        await fetch('/api/elements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            type: 'wall',
            type_name: el.wall_type || 'Generic 200mm',
            parameters: {
              startCoord: { x: el.start.x, y: el.start.z ?? el.start.y ?? 0 },
              endCoord:   { x: el.end.x,   y: el.end.z   ?? el.end.y   ?? 0 },
              thickness:  el.thickness,
              loadBearing: true,
              phase: 'New Construction',
              _nodeId: el.nodeId,
              _source: 'dynamo_execute',
            },
            elevation: el.levelRef?.elevation ?? 0,
          }),
        });
      } catch (e) {
        console.error('[node-editor] bim_wall push error:', e);
      }
    } else if (el.type === 'bim_column') {
      try {
        await fetch('/api/elements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            type: 'column',
            type_name: el.profile || 'W12x26',
            parameters: {
              x: el.x,
              z: el.z,
              height: el.height,
              section: el.profile || 'W12x26',
              base_offset: el.base_offset ?? 0,
              _nodeId: el.nodeId,
              _source: 'dynamo_execute',
            },
            elevation: el.levelRef?.elevation ?? 0,
          }),
        });
      } catch (e) {
        console.error('[node-editor] bim_column push error:', e);
      }
    }
  }

  // Notify app.js to rebuild the scene
  window.dispatchEvent(new CustomEvent('atlantist:nodegraph:elements-pushed', {
    detail: { count: elements.length }
  }));
}

// ── DAG solve (legacy wrapper — calls the new evaluate engine) ──────────────
function triggerDAGSolve(changedNode) {
  scheduleEvaluate();
}

// ── Minimap ─────────────────────────────────────────────────────────────────
function renderMinimap() {
  const mmCanvas = document.getElementById('ne-minimap-canvas');
  const mmViewport = document.getElementById('ne-minimap-viewport');
  if (!mmCanvas) return;

  const ctx = mmCanvas.getContext('2d');
  const W = 160, H = 100;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  if (state.nodes.length === 0) return;

  const xs = state.nodes.map(n => n.x);
  const ys = state.nodes.map(n => n.y);
  const minX = Math.min(...xs) - 200;
  const maxX = Math.max(...xs) + 200;
  const minY = Math.min(...ys) - 200;
  const maxY = Math.max(...ys) + 200;

  const scaleX = W / (maxX - minX || 1);
  const scaleY = H / (maxY - minY || 1);
  const scale = Math.min(scaleX, scaleY);

  // Draw nodes
  state.nodes.forEach(node => {
    const type = getNodeType(node.typeId);
    const cat = type?.category || 'geometry';
    ctx.fillStyle = CATEGORY_COLORS[cat] || '#888';
    ctx.fillRect((node.x - minX) * scale, (node.y - minY) * scale, 8, 8);
  });

  // Draw connections
  state.connections.forEach(conn => {
    const from = state.nodes.find(n => n.id === conn.fromNodeId);
    const to = state.nodes.find(n => n.id === conn.toNodeId);
    if (!from || !to) return;
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo((from.x - minX) * scale + 4, (from.y - minY) * scale + 4);
    ctx.lineTo((to.x - minX) * scale + 4, (to.y - minY) * scale + 4);
    ctx.stroke();
  });

  // Draw viewport rect
  if (mmViewport) {
    const canvasEl = document.getElementById('ne-canvas-wrap');
    if (canvasEl) {
      const vw = (canvasEl.clientWidth / state.zoom) * scale;
      const vh = (canvasEl.clientHeight / state.zoom) * scale;
      const vx = (state.offsetX / state.zoom - minX) * scale;
      const vy = (state.offsetY / state.zoom - minY) * scale;
      mmViewport.style.left = Math.max(0, vx) + 'px';
      mmViewport.style.top = Math.max(0, vy) + 'px';
      mmViewport.style.width = Math.min(W, vw) + 'px';
      mmViewport.style.height = Math.min(H, vh) + 'px';
    }
  }
}

// ── Help tooltip ────────────────────────────────────────────────────────────
function showHelpTooltip(type, x, y) {
  const tt = document.getElementById('ne-help-tooltip');
  if (!tt) return;
  tt.innerHTML = `
    <h4>${type.label}</h4>
    <p>${type.help || 'No description available.'}</p>
    <div class="ne-port-type-list">
      ${type.inputs.map(p => `<span class="ne-port-chip" style="background:${getPortColor(p.type)}22;color:${getPortColor(p.type)}">${p.type}</span>`).join('')}
      ${type.outputs.map(p => `<span class="ne-port-chip" style="background:${getPortColor(p.type)}22;color:${getPortColor(p.type)}">${p.type}</span>`).join('')}
    </div>
  `;
  tt.style.left = (x + 12) + 'px';
  tt.style.top = (y - 10) + 'px';
  tt.classList.add('visible');

  setTimeout(() => {
    const listener = (e) => {
      if (!tt.contains(e.target)) {
        tt.classList.remove('visible');
        document.removeEventListener('click', listener);
      }
    };
    document.addEventListener('click', listener);
  }, 100);
}

// ── Context menu ─────────────────────────────────────────────────────────────
function showContextMenu(x, y, nodeId) {
  const cm = document.getElementById('ne-context-menu');
  if (!cm) return;
  cm.style.left = x + 'px';
  cm.style.top = y + 'px';
  cm.classList.add('visible');

  cm.innerHTML = `
    <div class="ne-ctx-item" id="ctx-duplicate">⧉ Duplicate</div>
    <div class="ne-ctx-item" id="ctx-delete">✕ Delete</div>
    <div class="ne-ctx-sep"></div>
    <div class="ne-ctx-item" id="ctx-copy-params">⧉ Copy Params</div>
    <div class="ne-ctx-sep"></div>
    <div class="ne-ctx-item" id="ctx-disconnect">⤵ Disconnect All</div>
  `;

  cm.querySelector('#ctx-duplicate')?.addEventListener('click', () => { cm.classList.remove('visible'); duplicateNode(nodeId); });
  cm.querySelector('#ctx-delete')?.addEventListener('click', () => { cm.classList.remove('visible'); removeNode(nodeId); });
  cm.querySelector('#ctx-copy-params')?.addEventListener('click', () => {
    cm.classList.remove('visible');
    const node = state.nodes.find(n => n.id === nodeId);
    if (node) {
      window._atlantist_node_clipboard = JSON.stringify(node.params);
    }
  });
  cm.querySelector('#ctx-disconnect')?.addEventListener('click', () => {
    cm.classList.remove('visible');
    pushUndo();
    state.connections = state.connections.filter(c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId);
    render();
  });
}

// ── Properties panel ────────────────────────────────────────────────────────
function updatePropertiesPanel() {
  const panel = document.getElementById('ne-properties');
  const body = document.getElementById('ne-props-body');
  if (!panel || !body) return;

  if (!state.selectedNodeId) {
    panel.classList.remove('open');
    return;
  }

  panel.classList.add('open');
  const node = state.nodes.find(n => n.id === state.selectedNodeId);
  const type = node ? getNodeType(node.typeId) : null;
  if (!node || !type) return;

  body.innerHTML = `
    <div class="ne-prop-section">
      <div class="ne-prop-section-title">Node</div>
      <div class="ne-prop-row">
        <label>Type</label>
        <span style="color:var(--ne-text);font-size:12px">${type.label}</span>
      </div>
      <div class="ne-prop-row">
        <label>ID</label>
        <span style="color:var(--ne-text-muted);font-size:10px;font-family:var(--font-mono)">${node.id}</span>
      </div>
      <div class="ne-prop-row">
        <label>Position</label>
        <input type="number" value="${Math.round(node.x)}" data-prop="x" style="width:60px" onchange="updateNodeProp('${node.id}','x',parseFloat(this.value))">
        <input type="number" value="${Math.round(node.y)}" data-prop="y" style="width:60px" onchange="updateNodeProp('${node.id}','y',parseFloat(this.value))">
      </div>
    </div>
    <div class="ne-prop-section">
      <div class="ne-prop-section-title">Parameters</div>
      ${type.params.map(p => `
        <div class="ne-prop-row">
          <label>${p.label}</label>
          ${p.type === 'select' ? `
            <select onchange="updateNodeProp('${node.id}','params.${p.key}',this.value)">
              ${p.options.map(o => `<option value="${o}" ${(node.params[p.key] || p.default) === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
          ` : `
            <input type="${p.type === 'text' ? 'text' : 'number'}" value="${node.params[p.key] ?? p.default ?? ''}" onchange="updateNodeProp('${node.id}','params.${p.key}',${p.type === 'text' ? 'this.value' : 'parseFloat(this.value)'})">
          `}
        </div>
      `).join('')}
    </div>
    <div class="ne-prop-section">
      <div class="ne-prop-section-title">Connections</div>
      <div class="ne-props-conn-list">
        ${state.connections.filter(c => c.fromNodeId === node.id || c.toNodeId === node.id).map(c => {
          const otherId = c.fromNodeId === node.id ? c.toNodeId : c.fromNodeId;
          const otherNode = state.nodes.find(n => n.id === otherId);
          const otherType = otherNode ? getNodeType(otherNode.typeId) : null;
          const direction = c.fromNodeId === node.id ? '→' : '←';
          return `<div class="ne-props-conn-item">${direction} <b>${otherType?.label || '?'}</b> <span style="color:var(--ne-text-muted)">(${c.fromPortId || c.toPortId})</span></div>`;
        }).join('') || '<span style="font-size:11px;color:var(--ne-text-muted)">No connections</span>'}
      </div>
    </div>
  `;
}

// Global function for inline handlers
window.updateNodeProp = function(nodeId, prop, value) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  pushUndo();
  if (prop.startsWith('params.')) {
    const key = prop.slice(7);
    node.params[key] = value;
  } else {
    node[prop] = value;
  }
  render();
  updatePropertiesPanel();
};

// ── Palette ─────────────────────────────────────────────────────────────────
function buildPalette() {
  const body = document.getElementById('ne-palette-body');
  if (!body) return;
  body.innerHTML = '';

  const grouped = {};
  NODE_TYPES.forEach(type => {
    if (!grouped[type.category]) grouped[type.category] = [];
    grouped[type.category].push(type);
  });

  const categoryOrder = ['geometry', 'bim', 'constraint', 'structure', 'mep', 'energy', 'simulation', 'data', 'design'];
  const categoryLabels = {
    geometry: 'Geometry',
    bim: 'BIM',
    constraint: 'Constraints',
    structure: 'Structure',
    mep: 'MEP',
    energy: 'Energy',
    simulation: 'Simulation',
    data: 'Data',
    design: 'Design Options',
  };

  categoryOrder.forEach(cat => {
    if (!grouped[cat] || grouped[cat].length === 0) return;
    const items = grouped[cat].filter(type =>
      state.searchQuery === '' ||
      type.label.toLowerCase().includes(state.searchQuery.toLowerCase()) ||
      type.help?.toLowerCase().includes(state.searchQuery.toLowerCase())
    );
    if (items.length === 0 && state.searchQuery !== '') return;

    const catEl = document.createElement('div');
    catEl.className = 'ne-category' + (state.collapsedCategories[cat] ? ' collapsed' : '');

    catEl.innerHTML = `
      <div class="ne-category-header" data-cat="${cat}">
        <span class="ne-category-dot" style="background:${CATEGORY_COLORS[cat]}"></span>
        <span class="ne-category-name">${categoryLabels[cat] || cat}</span>
        <span class="ne-category-count">${items.length}</span>
        <span class="ne-category-arrow">▼</span>
      </div>
      <div class="ne-category-items">
        ${items.map(type => `
          <div class="ne-node-item" draggable="true" data-type-id="${type.id}">
            <div class="ne-node-item-icon" style="background:${CATEGORY_COLORS[cat]}22;color:${CATEGORY_COLORS[cat]}">${type.icon}</div>
            <span class="ne-node-item-name">${type.label}</span>
          </div>
        `).join('')}
      </div>
    `;

    // Toggle collapse
    catEl.querySelector('.ne-category-header')?.addEventListener('click', () => {
      state.collapsedCategories[cat] = !state.collapsedCategories[cat];
      catEl.classList.toggle('collapsed');
    });

    // Drag to canvas
    catEl.querySelectorAll('.ne-node-item').forEach(item => {
      item?.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('nodeTypeId', item.dataset.typeId);
        e.dataTransfer.effectAllowed = 'copy';
      });
      item?.addEventListener('click', () => {
        const canvas = document.getElementById('ne-canvas-wrap');
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          addNode(item.dataset.typeId, rect.left + rect.width / 2, rect.top + rect.height / 2);
        }
      });
    });

    body.appendChild(catEl);
  });
}

// ── Open / Close ─────────────────────────────────────────────────────────────
function openNodeEditor() {
  if (state.open) return;
  state.open = true;

  // Insert overlay into DOM if not present
  let overlay = document.getElementById('node-editor-overlay');
  if (!overlay) {
    overlay = buildOverlayDOM();
    document.body.appendChild(overlay);
  } else {
    overlay.style.display = 'flex';
  }

  setupCanvasInteraction();
  buildPalette();
  render();

  // Ctrl+Z / Ctrl+Y
  const keyHandler = (e) => {
    if (!state.open) return;
    if (e.target.matches('input,textarea,select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'Escape') closeNodeEditor();
    if (e.key === 'Delete' && state.selectedNodeId) removeNode(state.selectedNodeId);
  };
  document.addEventListener('keydown', keyHandler);

  // Close on click outside
  overlay?.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeNodeEditor();
  });
}

function closeNodeEditor() {
  const overlay = document.getElementById('node-editor-overlay');
  if (overlay) overlay.style.display = 'none';
  state.open = false;
  state.selectedNodeId = null;
}

function buildOverlayDOM() {
  const overlay = document.createElement('div');
  overlay.id = 'node-editor-overlay';
  overlay.innerHTML = `
    <!-- Left: Node Palette -->
    <div id="ne-palette">
      <div id="ne-palette-header">
        <h3>Node Library</h3>
        <span style="font-size:10px;color:var(--ne-text-muted)">Scratch / Dynamo style</span>
      </div>
      <div id="ne-palette-search">
        <div id="ne-search-wrap">
          <input type="text" id="ne-search-input" placeholder="Search nodes..." autocomplete="off">
        </div>
      </div>
      <div id="ne-palette-body"></div>
    </div>

    <!-- Center: Canvas -->
    <div id="ne-canvas-wrap">
      <div id="ne-toolbar">
        <button class="ne-tool-btn" id="ne-btn-undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="ne-tool-btn" id="ne-btn-redo" title="Redo (Ctrl+Y)">↷</button>
        <div class="ne-tool-sep"></div>
        <button class="ne-tool-btn" id="ne-btn-zoom-in" title="Zoom In">+</button>
        <button class="ne-tool-btn" id="ne-btn-zoom-out" title="Zoom Out">−</button>
        <button class="ne-tool-btn" id="ne-btn-zoom-fit" title="Fit to View">⊡</button>
        <div class="ne-tool-sep"></div>
        <button class="ne-tool-btn" id="ne-btn-validate" title="Validate Graph">✓</button>
        <div class="ne-tool-sep"></div>
        <button class="ne-tool-btn" id="ne-btn-export-py" title="Export Dynamo (.py)">⬇ .py</button>
        <button class="ne-tool-btn" id="ne-btn-export-gh" title="Export Grasshopper (.gh)">⬇ .gh</button>
        <button class="ne-tool-btn" id="ne-btn-save" title="Save Graph">💾</button>
        <div class="ne-tool-sep"></div>
        <button class="ne-tool-btn ne-execute-btn" id="ne-btn-execute" title="Execute graph — spawn BIM elements in the active project">▶ Execute</button>
      </div>

      <div id="ne-canvas" style="position:relative;width:100%;height:100%">
        <svg id="ne-connections" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible"></svg>
      </div>

      <div id="ne-empty-state">
        <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
          <rect x="10" y="20" width="30" height="20" rx="4" stroke="white" stroke-width="2"/>
          <rect x="40" y="30" width="30" height="20" rx="4" stroke="white" stroke-width="2"/>
          <circle cx="40" cy="30" r="4" fill="white"/>
          <circle cx="40" cy="50" r="4" fill="white"/>
          <path d="M40 30 C 55 30, 55 50, 40 50" stroke="white" stroke-width="2"/>
        </svg>
        <p>Drag nodes from the palette or click to add</p>
        <span>Ctrl+Z undo · Ctrl+Y redo · Space+drag pan · Scroll to zoom</span>
      </div>

      <div id="ne-zoom-controls">
        <button class="ne-zoom-btn" id="ne-zoom-out-btn">−</button>
        <span id="ne-zoom-indicator">100%</span>
        <button class="ne-zoom-btn" id="ne-zoom-in-btn">+</button>
        <button class="ne-zoom-btn" id="ne-zoom-reset-btn">⊡</button>
      </div>

      <div id="ne-minimap">
        <canvas id="ne-minimap-canvas" width="160" height="100"></canvas>
        <div id="ne-minimap-viewport" style="position:absolute;border:1px solid #00d4ff;background:rgba(0,212,255,0.1);pointer-events:none"></div>
      </div>

      <button id="ne-close" title="Close Node Editor (Esc)">✕</button>
    </div>

    <!-- Right: Properties -->
    <div id="ne-properties">
      <div id="ne-props-header">
        <h3>Properties</h3>
        <button onclick="document.getElementById('ne-properties').classList.remove('open')" style="background:none;border:none;color:var(--ne-text-dim);cursor:pointer;font-size:14px">×</button>
      </div>
      <div id="ne-props-body"></div>
    </div>

    <!-- Help tooltip -->
    <div id="ne-help-tooltip"></div>

    <!-- Context menu -->
    <div id="ne-context-menu"></div>
  `;

  // Wire toolbar buttons
  overlay?.addEventListener('click', (e) => {
    if (e.target.id === 'ne-btn-undo') { undo(); return; }
    if (e.target.id === 'ne-btn-redo') { redo(); return; }
    if (e.target.id === 'ne-btn-zoom-in') { state.zoom = snapZoom(state.zoom * 1.2); render(); return; }
    if (e.target.id === 'ne-btn-zoom-out') { state.zoom = snapZoom(state.zoom * 0.8); render(); return; }
    if (e.target.id === 'ne-btn-zoom-fit') { fitToView(); return; }
    if (e.target.id === 'ne-btn-validate') { validateGraph(); return; }
    if (e.target.id === 'ne-btn-export-py') { exportDynamoScript(); return; }
    if (e.target.id === 'ne-btn-export-gh') { exportGrasshopperScript(); return; }
    if (e.target.id === 'ne-btn-save') { saveGraph(); return; }
    if (e.target.id === 'ne-btn-execute') { executeGraph(); return; }
    if (e.target.id === 'ne-close') { closeNodeEditor(); return; }
    if (e.target.id === 'ne-zoom-in-btn') { state.zoom = snapZoom(state.zoom * 1.2); render(); return; }
    if (e.target.id === 'ne-zoom-out-btn') { state.zoom = snapZoom(state.zoom * 0.8); render(); return; }
    if (e.target.id === 'ne-zoom-reset-btn') { state.zoom = 1; state.offsetX = 0; state.offsetY = 0; render(); return; }
  });

  // Search
  const searchInput = overlay.querySelector('#ne-search-input');
  if (searchInput) {
    searchInput?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      buildPalette();
    });
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.target.blur(); state.searchQuery = ''; buildPalette(); }
    });
  }

  // Canvas drop
  const canvasWrap = overlay.querySelector('#ne-canvas-wrap');
  if (canvasWrap) {
    canvasWrap?.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    canvasWrap?.addEventListener('drop', (e) => {
      e.preventDefault();
      const typeId = e.dataTransfer.getData('nodeTypeId');
      if (!typeId) return;
      const rect = canvasWrap.getBoundingClientRect();
      addNode(typeId, e.clientX - rect.left, e.clientY - rect.top);
    });
  }

  // Context menu close on click elsewhere
  document.addEventListener('click', (e) => {
    const cm = document.getElementById('ne-context-menu');
    if (cm && !cm.contains(e.target)) cm.classList.remove('visible');
  });

  return overlay;
}

// ── Graph operations ─────────────────────────────────────────────────────────
function fitToView() {
  if (state.nodes.length === 0) return;
  const xs = state.nodes.map(n => n.x);
  const ys = state.nodes.map(n => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const canvasWrap = document.getElementById('ne-canvas-wrap');
  if (!canvasWrap) return;
  const cw = canvasWrap.clientWidth;
  const ch = canvasWrap.clientHeight;

  const graphW = maxX - minX + 300;
  const graphH = maxY - minY + 300;
  state.zoom = snapZoom(Math.min(cw / graphW, ch / graphH));
  state.offsetX = (cw - graphW * state.zoom) / 2 - minX * state.zoom;
  state.offsetY = (ch - graphH * state.zoom) / 2 - minY * state.zoom;
  render();
}

function validateGraph() {
  const errors = [];
  const warnings = [];

  // Check for circular dependencies
  try {
    const adj = {};
    state.nodes.forEach(n => { adj[n.id] = []; });
    state.connections.forEach(c => {
      if (adj[c.fromNodeId]) adj[c.fromNodeId].push(c.toNodeId);
    });

    const visited = new Set();
    const recStack = new Set();

    function hasCycle(nodeId) {
      visited.add(nodeId);
      recStack.add(nodeId);
      for (const neighbor of (adj[nodeId] || [])) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }
      recStack.delete(nodeId);
      return false;
    }

    for (const nodeId of state.nodes.map(n => n.id)) {
      if (!visited.has(nodeId) && hasCycle(nodeId)) {
        errors.push('Circular dependency detected in node graph');
        break;
      }
    }
  } catch (e) {
    errors.push('Graph validation error: ' + e.message);
  }

  // Check for unconnected constraint nodes
  state.nodes.forEach(node => {
    const type = getNodeType(node.typeId);
    if (type?.category === 'constraint') {
      const hasConn = state.connections.some(c => c.fromNodeId === node.id || c.toNodeId === node.id);
      if (!hasConn) warnings.push(`${type.label} node has no connections`);
    }
  });

  if (errors.length === 0 && warnings.length === 0) {
    showToast('✓ Graph valid — no errors or warnings', 'success');
  } else {
    if (errors.length > 0) showToast('❌ ' + errors[0], 'error');
    else showToast('⚠ ' + warnings[0], 'warning');
  }
}

// ── Execute ──────────────────────────────────────────────────────────────────
// Topologically evaluates the graph then pushes BIM nodes to the active project.
// Per-node errors are displayed inline (node border turns red); a toast reports
// the total element count created and links to the 3D viewport.
async function executeGraph() {
  const btn = document.getElementById('ne-btn-execute');
  const projectId = window._atlantist_current_project_id || window.atlantistActiveProjectId;

  if (!projectId) {
    showToast('❌ No project open — open a project first', 'error');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }

  // Clear previous error state from nodes
  document.querySelectorAll('.ne-node.ne-node-error').forEach(el => {
    el.classList.remove('ne-node-error');
    const errLabel = el.querySelector('.ne-node-exec-error');
    if (errLabel) errLabel.remove();
  });

  // Topological sort (Kahn's)
  const adj = {};
  const inDeg = {};
  state.nodes.forEach(n => { adj[n.id] = []; inDeg[n.id] = 0; });
  state.connections.forEach(c => {
    if (adj[c.fromNodeId]) adj[c.fromNodeId].push(c.toNodeId);
    if (inDeg[c.toNodeId] !== undefined) inDeg[c.toNodeId]++;
  });
  const queue = state.nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj[id] || []) {
      if (--inDeg[next] === 0) queue.push(next);
    }
  }
  if (order.length !== state.nodes.length) {
    showToast('❌ Circular dependency — fix the graph before executing', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Execute'; }
    return;
  }

  // Evaluate all nodes, collecting _element markers
  const results = {};
  const nodeErrors = {};
  for (const nodeId of order) {
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) continue;
    try {
      results[nodeId] = evaluateNode(node, results);
    } catch (err) {
      results[nodeId] = {};
      nodeErrors[nodeId] = err.message || 'Evaluation error';
    }
  }

  // Highlight errored nodes in the DOM
  Object.entries(nodeErrors).forEach(([nodeId, msg]) => {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (!el) return;
    el.classList.add('ne-node-error');
    const lbl = document.createElement('div');
    lbl.className = 'ne-node-exec-error';
    lbl.textContent = msg;
    el.appendChild(lbl);
  });

  if (Object.keys(nodeErrors).length > 0) {
    showToast(`❌ ${Object.keys(nodeErrors).length} node(s) errored — see highlights`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Execute'; }
    return;
  }

  // Collect BIM elements to create
  const toCreate = [];
  state.nodes.forEach(node => {
    const result = results[node.id];
    if (!result) return;
    // Only push element types that correspond to real BIM API calls
    const BIM_TYPES = new Set(['bim_level','bim_wall','bim_column','level','wall','window']);
    if (result._element && BIM_TYPES.has(result._element.type)) toCreate.push(result._element);
    if (result._elements) {
      result._elements.filter(e => BIM_TYPES.has(e.type)).forEach(e => toCreate.push(e));
    }
  });

  if (toCreate.length === 0) {
    showToast('ℹ Graph has no BIM nodes to execute — add a Wall, Column, or Level node', 'warning');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Execute'; }
    return;
  }

  await pushElementsToBIM(toCreate);

  // Toast with count + viewport link
  const noun = toCreate.length === 1 ? 'element' : 'elements';
  const toastHtml = `✓ ${toCreate.length} ${noun} created — <a href="#" onclick="document.getElementById('node-editor-overlay').style.display='none';window.dispatchEvent(new CustomEvent('atlantist:focus-viewport'));return false;" style="color:#fff;text-decoration:underline;">view in 3D</a>`;
  showToastHtml(toastHtml, 'success');

  // Signal viewport to refresh
  window.dispatchEvent(new CustomEvent('atlantist:nodegraph:execute-complete', {
    detail: { projectId, count: toCreate.length }
  }));

  if (btn) { btn.disabled = false; btn.textContent = '▶ Execute'; }
  render();
}

function showToast(msg, type) {
  // Simple inline toast (no dependency on app.js toast)
  const existing = document.getElementById('ne-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ne-toast';
  toast.style.cssText = `
    position:fixed;bottom:60px;left:50%;transform:translateX(-50%);
    background:${type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#4aad6e'};
    color:white;padding:10px 20px;border-radius:8px;font-size:13px;
    z-index:1000;box-shadow:0 4px 16px rgba(0,0,0,0.4);
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showToastHtml(html, type) {
  const existing = document.getElementById('ne-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'ne-toast';
  toast.style.cssText = `
    position:fixed;bottom:60px;left:50%;transform:translateX(-50%);
    background:${type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#4aad6e'};
    color:white;padding:10px 20px;border-radius:8px;font-size:13px;
    z-index:1000;box-shadow:0 4px 16px rgba(0,0,0,0.4);
  `;
  toast.innerHTML = html;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── Save / Load ───────────────────────────────────────────────────────────────
async function saveGraph() {
  const projectId = window._atlantist_current_project_id;
  if (!projectId) {
    showToast('No project open — cannot save graph', 'error');
    return;
  }

  try {
    const res = await fetch('/api/node-editor/graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        nodes: state.nodes,
        connections: state.connections,
      }),
    });
    if (res.ok) {
      showToast('Graph saved ✓', 'success');
    } else {
      showToast('Save failed: ' + res.statusText, 'error');
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

async function loadGraph(projectId) {
  try {
    const res = await fetch(`/api/node-editor/graph?project_id=${projectId}`);
    if (res.ok) {
      let data;
      try { data = await res.json(); } catch {
        console.warn('[node-editor] loadGraph non-JSON response');
        state.nodes = [];
        state.connections = [];
        render();
        return;
      }
      state.nodes = data.nodes || [];
      state.connections = data.connections || [];
      state.nodeIdCounter = (state.nodes.length ? Math.max(...state.nodes.map(n => parseInt(n.id.split('_')[1]) || 0)) + 1 : 1);
      state.connIdCounter = (state.connections.length ? Math.max(...state.connections.map(c => parseInt(c.id.split('_')[1]) || 0)) + 1 : 1);
      render();
      showToast('Graph loaded ✓', 'success');
    }
  } catch (e) {
    // No saved graph — start fresh
    state.nodes = [];
    state.connections = [];
    render();
  }
}

// ── Export: Dynamo Python script ─────────────────────────────────────────────
function exportDynamoScript() {
  const lines = [];
  lines.push('# ── Atlantist Dynamo Export ────────────────────────────────────────────');
  lines.push('# Generated by Atlantist BIM — Visual Scripting Node Editor');
  lines.push(`# Date: ${new Date().toISOString()}`);
  lines.push(`# Nodes: ${state.nodes.length}, Connections: ${state.connections.length}`);
  lines.push('');
  lines.push('import clr');
  lines.push('clr.AddReference("DynamoCore")');
  lines.push('from Autodesk.DesignScript.Runtime import *');
  lines.push('');
  lines.push('# ── Node registry ──────────────────────────────────────────────────────');

  // Generate node creation code
  state.nodes.forEach(node => {
    const type = getNodeType(node.typeId);
    lines.push('');
    lines.push(`# ${type?.label || node.typeId} (${node.id})`);
    lines.push(`${node.id.replace(/-/g, '_')} = ${type?.label || node.typeId}(`);
    if (type?.params) {
      type.params.forEach(p => {
        lines.push(`    ${p.key}=${JSON.stringify(node.params[p.key] ?? p.default)},`);
      });
    }
    lines.push(')');
  });

  lines.push('');
  lines.push('# ── Connections ───────────────────────────────────────────────────────');

  state.connections.forEach(conn => {
    const fromNode = state.nodes.find(n => n.id === conn.fromNodeId);
    const toNode = state.nodes.find(n => n.id === conn.toNodeId);
    const fromType = fromNode ? getNodeType(fromNode.typeId) : null;
    const toType = toNode ? getNodeType(toNode.typeId) : null;
    if (fromNode && toNode) {
      lines.push(`# Connect ${fromType?.label || conn.fromNodeId}.${conn.fromPort} → ${toType?.label || conn.toNodeId}.${conn.toPort}`);
      lines.push(`${conn.toNodeId.replace(/-/g, '_')}.SetInput("${conn.toPort}", ${conn.fromNodeId.replace(/-/g, '_')}.${conn.fromPort})`);
    }
  });

  lines.push('');
  lines.push('print("Dynamo script executed successfully")');

  const code = lines.join('\n');
  downloadFile(code, 'atlantist-graph.dyn.py', 'text/x-python');
  showToast('Dynamo Python script exported ✓', 'success');
}

// ── Export: Grasshopper-like JSON ────────────────────────────────────────────
function exportGrasshopperScript() {
  const out = {
    name: 'Atlantist Graph Export',
    version: '1.0',
    exportDate: new Date().toISOString(),
    nodes: state.nodes.map(node => {
      const type = getNodeType(node.typeId);
      return {
        id: node.id,
        name: type?.label || node.typeId,
        category: type?.category || 'Unknown',
        position: { x: node.x, y: node.y },
        params: node.params,
        inputs: (type?.inputs || []).map(p => ({
          id: p.id,
          type: p.type,
          label: p.label,
        })),
        outputs: (type?.outputs || []).map(p => ({
          id: p.id,
          type: p.type,
          label: p.label,
        })),
      };
    }),
    wires: state.connections.map(c => ({
      id: c.id,
      from: { nodeId: c.fromNodeId, port: c.fromPort, type: c.wireType || 'any' },
      to: { nodeId: c.toNodeId, port: c.toPort },
    })),
    metadata: {
      nodeCount: state.nodes.length,
      connectionCount: state.connections.length,
    },
  };

  downloadFile(JSON.stringify(out, null, 2), 'atlantist-graph.gh.json', 'application/json');
  showToast('Grasshopper JSON exported ✓', 'success');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Public API (called from app.js) ─────────────────────────────────────────
window._ne = {
  open: openNodeEditor,
  close: closeNodeEditor,
  addNode,
  removeNode,
  undo,
  redo,
  saveGraph,
  loadGraph,
  exportDynamoScript,
  exportGrasshopperScript,
  validateGraph,
  fitToView,
  getState: () => state,
};

// ── Project open auto-load ──────────────────────────────────────────────────
// Listen for Atlantist project-open event and load the saved graph.
window.addEventListener('atlantist:project:open', async (e) => {
  // projectId may be on the event detail or on window
  const projectId = e?.detail?.projectId || window._atlantist_current_project_id || window.atlantistActiveProjectId;
  if (!projectId) return;

  // Wire currentProjectId for saveGraph
  window._atlantist_current_project_id = projectId;

  // Small delay so node-editor overlay is fully rendered before loading
  setTimeout(() => {
    if (window._ne) window._ne.loadGraph(projectId);
  }, 300);
});