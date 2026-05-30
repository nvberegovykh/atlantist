/**
 * Synthetic Revit element fixtures for import pipeline testing.
 * Each fixture simulates what the Model Derivative SVF2 metadata bundle
 * would contain for a given element category. Not real .rvt data — this is
 * the normalized JSON format that rvtService.importRvtFile() expects.
 *
 * Real .rvt files go through Forge → SVF2 → metadata JSON.
 * These fixtures let us test the mapper end-to-end without Forge credentials.
 */

// ─── Architectural ───────────────────────────────────────────────────────────

const wallFixtures = [
  // Basic wall
  {
    id: 'wall-basic-001',
    guid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    category: 'OST_Walls',
    name: 'Basic Wall',
    parameters: {
      'Type Name': 'Generic - 6" Masonry',
      'Length': 15.0,      // feet
      'Height': 10.0,      // feet
      'Base Constraint': 'Level 1',
      'Top Constraint': 'Level 2',
      'Base Offset': 0,
      'Top Offset': 0,
      'Structural': false,
      'Compound Structure': [
        ['Finish 1', 'Gypsum Wall Board', 0.5 / 3.281, 'Finish 1'],
        ['Structure', 'Concrete, Cast-in-Place', 6.0 / 3.281, 'Structure 1'],
        ['Finish 2', 'Masonry CMU', 4.0 / 3.281, 'Finish 2']
      ],
      'Level': 'Level 1',
      'Unique Id': 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'Mark': 'W-001'
    }
  },
  // Curtain wall
  {
    id: 'wall-curtain-001',
    guid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    category: 'OST_CurtainWallPanels',
    name: 'Curtain Wall',
    parameters: {
      'Type Name': 'Curtain Wall 1',
      'Length': 40.0,
      'Height': 12.0,
      'Base Constraint': 'Level 1',
      'Top Constraint': 'Level 2',
      'Structural': false,
      'Level': 'Level 1',
      'Unique Id': 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
    }
  },
  // Stacked wall
  {
    id: 'wall-stacked-001',
    guid: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
    category: 'OST_StackedWalls',
    name: 'Stacked Wall',
    parameters: {
      'Type Name': 'Exterior - Stacked',
      'Length': 20.0,
      'Height': 10.0,
      'Base Constraint': 'Level 1',
      'Top Constraint': 'Level 2',
      'Structural': false,
      'Level': 'Level 1',
      'Unique Id': 'c3d4e5f6-a7b8-9012-cdef-123456789012'
    }
  },
  // In-place wall (custom family)
  {
    id: 'wall-inplace-001',
    guid: 'd4e5f6a7-b8c9-0123-def0-234567890123',
    category: 'OST_Walls',
    name: 'In-Place Wall',
    parameters: {
      'Type Name': 'In-Place Family: Custom Wall',
      'Family': 'In-Place',
      'Length': 8.0,
      'Height': 9.0,
      'Base Constraint': 'Level 1',
      'Top Constraint': 'Level 1',
      'Level': 'Level 1',
      'Unique Id': 'd4e5f6a7-b8c9-0123-def0-234567890123'
    }
  }
];

const floorFixtures = [
  {
    id: 'floor-structural-001',
    guid: 'e5f6a7b8-c9d0-1234-ef01-345678901234',
    category: 'OST_Floors',
    name: 'Structural Floor',
    parameters: {
      'Type Name': 'Waffle Slab - 8"',
      'Height Offset From Level': 0,
      'Slope': 0,
      'Level': 'Level 1',
      'Unique Id': 'e5f6a7b8-c9d0-1234-ef01-345678901234',
      'Mark': 'F-001'
    }
  },
  {
    id: 'floor-sloped-001',
    guid: 'f6a7b8c9-d0e1-2345-f012-456789012345',
    category: 'OST_Floors',
    name: 'Sloped Floor',
    parameters: {
      'Type Name': 'Sloped Pan',
      'Height Offset From Level': 0,
      'Slope': 0.04,  // 4% slope
      'Level': 'Roof',
      'Unique Id': 'f6a7b8c9-d0e1-2345-f012-456789012345'
    }
  }
];

const roofFixtures = [
  {
    id: 'roof-footprint-001',
    guid: 'a7b8c9d0-e1f2-3456-0123-567890123456',
    category: 'OST_Roofs',
    name: 'Roof - Footprint',
    parameters: {
      'Type Name': 'Roof - Generic 6"',
      'Height Offset From Level': 0,
      'Level': 'Roof',
      'Unique Id': 'a7b8c9d0-e1f2-3456-0123-567890123456'
    }
  },
  {
    id: 'roof-extrusion-001',
    guid: 'b8c9d0e1-f2a3-4567-1234-678901234567',
    category: 'OST_Roofs',
    name: 'Roof - Extrusion',
    parameters: {
      'Type Name': 'Roof - Extrusion',
      'Level': 'Roof',
      'Unique Id': 'b8c9d0e1-f2a3-4567-1234-678901234567'
    }
  }
];

const doorFixtures = [
  {
    id: 'door-hosted-001',
    guid: 'c9d0e1f2-a3b4-5678-2345-789012345678',
    category: 'OST_Doors',
    name: 'Door - Single',
    parameters: {
      'Type Name': 'Single - 3x7',
      'Family': 'Single Flush',
      'Width': 3.0,        // feet
      'Height': 7.0,       // feet
      'Fire Rating': '20 min',
      'Material': 'Wood',
      'Hand': 'Left',
      'Mark': 'D-001',
      'Level': 'Level 1',
      'Unique Id': 'c9d0e1f2-a3b4-5678-2345-789012345678'
    },
    hostElementId: 'wall-basic-001',
    hostFaceU: 0.35
  },
  {
    id: 'door-double-001',
    guid: 'd0e1f2a3-b4c5-6789-3456-890123456789',
    category: 'OST_Doors',
    name: 'Door - Double',
    parameters: {
      'Type Name': 'Double - 6x7',
      'Family': 'Double Flush',
      'Width': 6.0,
      'Height': 7.0,
      'Fire Rating': '90 min',
      'Material': 'Steel',
      'Hand': 'Left',
      'Mark': 'D-002',
      'Level': 'Level 1',
      'Unique Id': 'd0e1f2a3-b4c5-6789-3456-890123456789'
    },
    hostElementId: 'wall-basic-001',
    hostFaceU: 0.72
  }
];

const windowFixtures = [
  {
    id: 'window-basic-001',
    guid: 'e1f2a3b4-c5d6-7890-4567-901234567890',
    category: 'OST_Windows',
    name: 'Window - Fixed',
    parameters: {
      'Type Name': 'Fixed - 4x3',
      'Family': 'Fixed',
      'Width': 4.0,
      'Height': 3.0,
      'Sill Height': 3.0,  // feet
      'Glazing': 'Double Pane',
      'Material': 'Aluminum',
      'Mark': 'WND-001',
      'Level': 'Level 1',
      'Unique Id': 'e1f2a3b4-c5d6-7890-4567-901234567890'
    },
    hostElementId: 'wall-basic-001',
    hostFaceU: 0.55
  }
];

const columnFixtures = [
  {
    id: 'col-arch-001',
    guid: 'f2a3b4c5-d6e7-8901-5678-012345678901',
    category: 'OST_Columns',
    name: 'Column - Architectural',
    parameters: {
      'Type Name': 'Round Column 12"',
      'Height': 10.0,
      'Location Line': 'Core Center',
      'Height Type': 'Height',
      'Column Style': 'Architecture',
      'Level': 'Level 1',
      'Unique Id': 'f2a3b4c5-d6e7-8901-5678-012345678901',
      'Mark': 'C-001'
    }
  },
  {
    id: 'col-struct-001',
    guid: 'a3b4c5d6-e7f8-9012-6789-123456789012',
    category: 'OST_StructuralColumns',
    name: 'Column - Structural',
    parameters: {
      'Type Name': 'W14x90',
      'Height': 10.0,
      'Location Line': 'Core Center',
      'Height Type': 'Height',
      'Column Style': 'Structural',
      'Level': 'Level 1',
      'Unique Id': 'a3b4c5d6-e7f8-9012-6789-123456789012',
      'Mark': 'S-001'
    }
  }
];

const roomFixtures = [
  {
    id: 'room-001',
    guid: 'b4c5d6e7-f8a9-0123-7890-234567890123',
    category: 'OST_Rooms',
    name: 'Room 101',
    parameters: {
      'Name': 'Conference Room',
      'Number': '101',
      'Area': 300,         // ft²
      'Department': 'Operations',
      'Level': 'Level 1',
      'Unique Id': 'b4c5d6e7-f8a9-0123-7890-234567890123'
    }
  }
];

// ─── Structural ───────────────────────────────────────────────────────────────

const beamFixtures = [
  {
    id: 'beam-001',
    guid: 'c5d6e7f8-a9b0-1234-8901-345678901234',
    category: 'OST_StructuralFraming',
    name: 'Beam - W-Beam',
    parameters: {
      'Type Name': 'W18x35',
      'Family': 'W-Beam',
      'Start Level': 'Level 1',
      'End Level': 'Level 1',
      'Start Offset': 0,
      'End Offset': 0,
      'Structural Usage': 'Floor Framing',
      'Level': 'Level 1',
      'Unique Id': 'c5d6e7f8-a9b0-1234-8901-345678901234',
      'Mark': 'B-001'
    }
  }
];

const foundationFixtures = [
  {
    id: 'foundation-001',
    guid: 'd6e7f8a9-b0c1-2345-9012-456789012345',
    category: 'OST_StructuralFoundation',
    name: 'Foundation - Spread',
    parameters: {
      'Type Name': 'Spread Footing - 4x4',
      'Level': 'Foundation',
      'Unique Id': 'd6e7f8a9-b0c1-2345-9012-456789012345'
    }
  }
];

const connectionFixtures = [
  {
    id: 'connection-001',
    guid: 'e7f8a9b0-c1d2-3456-0123-567890123456',
    category: 'OST_StructuralConnections',
    name: 'Connection - Weld',
    parameters: {
      'Type Name': 'W12 Moment Connection',
      'Level': 'Level 1',
      'Unique Id': 'e7f8a9b0-c1d2-3456-0123-567890123456'
    }
  }
];

const rebarFixtures = [
  {
    id: 'rebar-001',
    guid: 'f8a9b0c1-d2e3-4567-1234-678901234567',
    category: 'OST_Rebar',
    name: 'Rebar #5',
    parameters: {
      'Type Name': '#5 Bar',
      'Bar Diameter': 0.625,  // inches
      'Level': 'Level 1',
      'Unique Id': 'f8a9b0c1-d2e3-4567-1234-678901234567'
    }
  }
];

// ─── MEP ─────────────────────────────────────────────────────────────────────

const ductFixtures = [
  {
    id: 'duct-001',
    guid: 'a9b0c1d2-e3f4-5678-2345-789012345678',
    category: 'OST_DuctCurves',
    name: 'Duct - Rectangular',
    parameters: {
      'Type Name': 'Rectangular Duct',
      'Diameter': 12,      // inches (for round) or use Rough Size for rect
      'Rough Size': '24x12',
      'System Type': 'Supply Air',
      'Level': 'Level 1',
      'Unique Id': 'a9b0c1d2-e3f4-5678-2345-789012345678'
    }
  }
];

const pipeFixtures = [
  {
    id: 'pipe-001',
    guid: 'b0c1d2e3-f4a5-6789-3456-890123456789',
    category: 'OST_PipeCurves',
    name: 'Pipe - Supply',
    parameters: {
      'Type Name': 'Pipe - 2"',
      'Rough Size': '2"',
      'System Type': 'Domestic Hot Water',
      'Level': 'Level 1',
      'Unique Id': 'b0c1d2e3-f4a5-6789-3456-890123456789'
    }
  }
];

const cableTrayFixtures = [
  {
    id: 'cabletray-001',
    guid: 'c1d2e3f4-a5b6-7890-4567-901234567890',
    category: 'OST_CableTray',
    name: 'Cable Tray - Ladder',
    parameters: {
      'Type Name': 'Ladder 12"',
      'Rough Size': '12"',
      'Level': 'Level 1',
      'Unique Id': 'c1d2e3f4-a5b6-7890-4567-901234567890'
    }
  }
];

const equipmentFixtures = [
  {
    id: 'equipment-001',
    guid: 'd2e3f4a5-b6c7-8901-5678-012345678901',
    category: 'OST_MechanicalEquipment',
    name: 'AHU-1',
    parameters: {
      'Type Name': 'Air Handling Unit',
      'Level': 'Level 1',
      'Unique Id': 'd2e3f4a5-b6c7-8901-5678-012345678901',
      'Mark': 'AHU-1'
    }
  }
];

const fixtureFixtures = [
  {
    id: 'fixture-lighting-001',
    guid: 'e3f4a5b6-c7d8-9012-6789-123456789012',
    category: 'OST_LightingFixtures',
    name: 'Light Fixture',
    parameters: {
      'Type Name': '2x4 LED Panel',
      'Level': 'Level 1',
      'Unique Id': 'e3f4a5b6-c7d8-9012-6789-123456789012',
      'Mark': 'LT-001'
    }
  },
  {
    id: 'fixture-plumbing-001',
    guid: 'f4a5b6c7-d8e9-0123-7890-234567890123',
    category: 'OST_PlumbingFixtures',
    name: 'Toilet',
    parameters: {
      'Type Name': 'Wall-Hung Toilet',
      'Level': 'Level 1',
      'Unique Id': 'f4a5b6c7-d8e9-0123-7890-234567890123',
      'Mark': 'WC-001'
    }
  }
];

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  walls: wallFixtures,
  floors: floorFixtures,
  roofs: roofFixtures,
  doors: doorFixtures,
  windows: windowFixtures,
  columns: columnFixtures,
  rooms: roomFixtures,
  beams: beamFixtures,
  foundations: foundationFixtures,
  connections: connectionFixtures,
  rebars: rebarFixtures,
  ducts: ductFixtures,
  pipes: pipeFixtures,
  cableTrays: cableTrayFixtures,
  equipment: equipmentFixtures,
  fixtures: fixtureFixtures,

  // All fixtures as one flat array for test iteration
  all() {
    return [
      ...this.walls, ...this.floors, ...this.roofs,
      ...this.doors, ...this.windows, ...this.columns,
      ...this.rooms, ...this.beams, ...this.foundations,
      ...this.connections, ...this.rebars,
      ...this.ducts, ...this.pipes, ...this.cableTrays,
      ...this.equipment, ...this.fixtures
    ];
  },

  // Fixtures organized by architectural / structural / MEP
  byGroup() {
    return {
      architectural: [
        ...this.walls, ...this.floors, ...this.roofs,
        ...this.doors, ...this.windows, ...this.columns,
        ...this.rooms
      ],
      structural: [
        ...this.beams, ...this.foundations,
        ...this.connections, ...this.rebars, ...this.columns
      ],
      mep: [
        ...this.ducts, ...this.pipes, ...this.cableTrays,
        ...this.equipment, ...this.fixtures
      ]
    };
  }
};