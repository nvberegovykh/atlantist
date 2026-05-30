/**
 * Revit version + edge case fixtures for import pipeline testing.
 * These simulate the version metadata and edge-case element scenarios
 * described in the test matrix.
 */

// Revit version fixtures — version-specific parameter format variations
const revitVersionFixtures = [
  { revitVersion: '2018', fileName: 'sample_2018.rvt', fileSizeMB: 45 },
  { revitVersion: '2019', fileName: 'sample_2019.rvt', fileSizeMB: 48 },
  { revitVersion: '2020', fileName: 'sample_2020.rvt', fileSizeMB: 52 },
  { revitVersion: '2021', fileName: 'sample_2021.rvt', fileSizeMB: 55 },
  { revitVersion: '2022', fileName: 'sample_2022.rvt', fileSizeMB: 58 },
  { revitVersion: '2023', fileName: 'sample_2023.rvt', fileSizeMB: 61 },
  { revitVersion: '2024', fileName: 'sample_2024.rvt', fileSizeMB: 65 },
  { revitVersion: '2025', fileName: 'sample_2025.rvt', fileSizeMB: 70 },
];

// Upgraded file scenario — old format saved in new Revit
const upgradedFixtures = [
  {
    revitVersion: '2022',
    fileName: 'upgraded_from_2018.rvt',
    notes: 'Saved in Revit 2022 but originally created in 2018',
    originalVersion: '2018',
    migrated: true
  },
  {
    revitVersion: '2024',
    fileName: 'upgraded_from_2020.rvt',
    notes: 'Saved in Revit 2024 but originally created in 2020',
    originalVersion: '2020',
    migrated: true
  }
];

// Workshared file — central model metadata
const worksharedFixtures = [
  {
    fileName: 'central_model.rvt',
    workshared: true,
    centralPath: '\\\\server\\BIM\\central\\model.rvt',
    localPath: 'C:\\Users\\user\\LocalDesktop\\model_01.rvt',
    lastSaveBy: 'user@company.com',
    lastSaveAt: '2025-03-15T14:30:00Z',
    workset: 'Shared Levels & Grids'
  },
  {
    fileName: 'local_copy.rvt',
    workshared: true,
    centralPath: '\\\\server\\BIM\\central\\model.rvt',
    localPath: 'C:\\Users\\user\\LocalDesktop\\model_copy.rvt',
    derivedFromCentral: true
  }
];

// Edge case elements
const edgeCaseFixtures = [
  // In-place families (complex non-standard geometry)
  {
    id: 'inplace-furniture-001',
    guid: 'inplace-001-001',
    category: 'OST_Walls',
    name: 'In-Place Custom Family',
    parameters: {
      'Type Name': 'In-Place Family: Reception Desk',
      'Family': 'In-Place',
      'Length': 12.0,
      'Height': 3.5,
      'Level': 'Level 1',
      'Unique Id': 'inplace-001-001',
      'Note': 'In-place family — non-standard geometry, may not translate cleanly'
    }
  },
  // Custom family (loaded from .rfa)
  {
    id: 'custom-family-001',
    guid: 'custom-001-001',
    category: 'OST_Doors',
    name: 'Custom Door Family',
    parameters: {
      'Type Name': 'Custom - Pivot Door 36x84',
      'Family': 'Pivot Door',
      'Width': 3.0,
      'Height': 7.0,
      'Fire Rating': '45 min',
      'Material': 'Steel',
      'Level': 'Level 1',
      'Unique Id': 'custom-001-001',
      'Note': 'Third-party custom family — may lack standard parameter names'
    }
  },
  // Design options (alternative design variants)
  {
    id: 'wall-design-option-a',
    guid: 'do-a-001',
    category: 'OST_Walls',
    name: 'Wall - Design Option A',
    parameters: {
      'Type Name': 'Generic - 6" Masonry',
      'Length': 20.0,
      'Height': 10.0,
      'Design Option': 'Option A - Open Plan',
      'Option Status': 'Active',
      'Level': 'Level 1',
      'Unique Id': 'do-a-001'
    }
  },
  {
    id: 'wall-design-option-b',
    guid: 'do-b-001',
    category: 'OST_Walls',
    name: 'Wall - Design Option B',
    parameters: {
      'Type Name': 'Generic - 6" Masonry',
      'Length': 20.0,
      'Height': 10.0,
      'Design Option': 'Option B - Closed Offices',
      'Option Status': 'Inactive',
      'Level': 'Level 1',
      'Unique Id': 'do-b-001'
    }
  },
  // Large file element (simplified representation)
  {
    id: 'wall-large-project-001',
    guid: 'large-001',
    category: 'OST_Walls',
    name: 'Wall - Large Project',
    parameters: {
      'Type Name': 'Generic - 8" Concrete',
      'Length': 250.0,   // ft — large project
      'Height': 15.0,
      'Base Constraint': 'Level 1',
      'Top Constraint': 'Level 3',
      'Level': 'Level 1',
      'Unique Id': 'large-001'
    }
  }
];

// Linked model references
const linkedModelFixtures = [
  {
    id: 'link-ref-001',
    guid: 'link-001',
    category: 'OST_RevitLinks',
    name: 'Linked Model - Architectural',
    parameters: {
      'File Name': 'arch_model.rvt',
      'Path': '\\\\server\\BIM\\links\\arch_model.rvt',
      'Host': 'Current Model',
      'Revit Version': '2024'
    }
  }
];

// Corrupt / damaged file — graceful error handling tests
const corruptFixtures = [
  {
    id: 'corrupt-partial-001',
    guid: 'corrupt-001',
    category: 'OST_Walls',
    name: 'Wall - Partial Data',
    parameters: {
      // Missing Type Name — required field absent
      'Level': 'Level 1',
      'Length': 10.0
      // No Type Name, no Height — partial element
    }
  },
  {
    id: 'corrupt-null-param-001',
    guid: 'corrupt-002',
    category: 'OST_Doors',
    name: 'Door - Null Host',
    parameters: {
      'Type Name': 'Single Flush',
      'Width': 3.0,
      'Height': 7.0,
      'Level': 'Level 1',
      // hostElementId intentionally null — no host wall
      'Host': null
    },
    hostElementId: null,
    hostFaceU: 0.5
  }
];

module.exports = {
  revitVersions: revitVersionFixtures,
  upgradedFiles: upgradedFixtures,
  worksharedFiles: worksharedFixtures,
  edgeCases: edgeCaseFixtures,
  linkedModels: linkedModelFixtures,
  corruptFiles: corruptFixtures
};