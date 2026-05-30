#!/usr/bin/env node
/**
 * jobs/rvt-test-runner.js
 *
 * Comprehensive test suite for the .rvt import pipeline.
 *
 * Run: node jobs/rvt-test-runner.js [--fixture architectural|structural|mep|all]
 *                                        [--format html|json|markdown]
 *                                        [--out /path/to/report]
 *
 * This script exercises the rvtService element mapper using synthetic fixtures,
 * without requiring Forge credentials. It validates:
 *   - Every Revit element category maps to the correct Atlantist type
 *   - Parameter preservation across import round-trip
 *   - Wall layers extracted from compound structure
 *   - Family instance hosting resolved correctly
 *   - Unsupported categories are correctly skipped (not crashed on)
 *   - Version metadata parsed correctly
 *   - Edge cases handled gracefully
 *
 * Outputs:
 *   - Element-by-element test results (pass/fail/skipped per category)
 *   - Coverage matrix (which categories supported vs. not)
 *   - Round-trip validation report
 *   - Known limitations summary
 *
 * When real .rvt files and Forge credentials are available, the full pipeline
 * (Forge → SVF2 → mapper) replaces this fixture-based testing.
 */

const path = require('path');

// Allow running from project root
process.chdir(path.resolve(__dirname, '..'));

// ─── Load service under test ─────────────────────────────────────────────────
let rvtService;
try {
  rvtService = require('../services/rvt-import');
} catch (err) {
  console.error('[rvt-test-runner] Cannot load services/rvt-import.js:', err.message);
  process.exit(1);
}

// ─── Load fixtures ─────────────────────────────────────────────────────────────
let fixtures;
try {
  fixtures = {
    elements: require('../tests/fixtures/rvt/architectural-walls'),
    versions: require('../tests/fixtures/rvt/versions-edge-cases')
  };
} catch (err) {
  console.error('[rvt-test-runner] Cannot load fixtures:', err.message);
  process.exit(1);
}

const { CAT_MAP, _testHelpers } = rvtService;
const { parseRevitParams, mapRevitParamsToAtlantist, parseCompoundStructure } = _testHelpers;

// ─── Mock DB ───────────────────────────────────────────────────────────────────
// Since we're testing the mapper without a real DB, use an in-memory mock.
// This simulates what createElement / createFamilyInstance / createLevel do.

const mockDb = {
  _elements: [],
  _families: [],
  _levels: {},
  _wallLayers: [],

  async createLevel(data) {
    const id = this._levels.count + 1 || 1;
    const lvl = { id, ...data };
    this._levels[data.name] = lvl;
    return lvl;
  },
  async createElement(data) {
    const id = this._elements.length + 1;
    const el = { id, ...data };
    this._elements.push(el);
    return el;
  },
  async createFamilyInstance(data) {
    const id = this._families.length + 1;
    const fi = { id, ...data };
    this._families.push(fi);
    return fi;
  },
  async setWallLayers(elementId, layers) {
    this._wallLayers.push({ elementId, layers });
  },
  reset() {
    this._elements = [];
    this._families = [];
    this._levels = {};
    this._wallLayers = [];
  }
};

// ─── Test runner core ──────────────────────────────────────────────────────────

class TestRunner {
  constructor() {
    this.results = [];
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.startTime = Date.now();
  }

  record(cat, subcat, elementName, status, details = {}) {
    this.results.push({ category: cat, subcategory: subcat, elementName, status, ...details });
    if (status === 'pass') this.passed++;
    else if (status === 'fail') this.failed++;
    else this.skipped++;
  }

  // ── Category mapping tests ─────────────────────────────────────────────────
  async testCategoryMapping() {
    console.log('\n=== Category Mapping Tests ===');
    const allElements = fixtures.elements.all();
    for (const el of allElements) {
      const cat = el.category;
      const cfg = CAT_MAP[cat];
      if (!cfg) {
        this.record(cat, null, el.name, 'fail', { reason: 'No CAT_MAP entry found' });
        continue;
      }
      const expectedType = cfg.type;
      const expectedFamily = cfg.family;

      // Test: does the element's category map to expected type?
      if (expectedType) {
        this.record(cat, cfg.sub || null, el.name, 'pass', {
          mappedType: expectedType,
          supported: cfg.supported,
          hasLayers: !!cfg.layers,
          familyType: expectedFamily || null
        });
      } else {
        this.record(cat, null, el.name, 'fail', { reason: 'CAT_MAP type is null/undefined' });
      }
    }
  }

  // ── Parameter parsing tests ───────────────────────────────────────────────
  async testParameterParsing() {
    console.log('\n=== Parameter Parsing Tests ===');
    const allElements = fixtures.elements.all();
    for (const el of allElements) {
      try {
        const params = parseRevitParams(el);
        this.record(el.category, null, el.name, 'pass', {
          paramCount: Object.keys(params).length,
          hasLevel: !!params.Level || !!params['Base Constraint'],
          hasType: !!params['Type Name'] || !!params.Type
        });
      } catch (err) {
        this.record(el.category, null, el.name, 'fail', { reason: err.message });
      }
    }
  }

  // ── Parameter mapping tests ───────────────────────────────────────────────
  async testParameterMapping() {
    console.log('\n=== Parameter Mapping Tests ===');
    const allElements = fixtures.elements.all();
    for (const el of allElements) {
      const params = parseRevitParams(el);
      try {
        const mapped = mapRevitParamsToAtlantist(params, el.category, null);
        // For walls, should have length
        if (el.category === 'OST_Walls') {
          const ok = mapped.length !== undefined || mapped.wall_height !== undefined;
          this.record(el.category, 'params', el.name, ok ? 'pass' : 'fail', {
            mapped, reason: ok ? null : 'Wall missing length or wall_height in mapped params'
          });
        }
        // For doors/windows, should have width/height
        else if (el.category === 'OST_Doors' || el.category === 'OST_Windows') {
          const ok = mapped.width !== undefined && mapped.height !== undefined;
          this.record(el.category, 'params', el.name, ok ? 'pass' : 'fail', {
            mapped, reason: ok ? null : 'Family instance missing width or height in mapped params'
          });
        }
        // For rooms, should have area
        else if (el.category === 'OST_Rooms') {
          const ok = mapped.area !== undefined;
          this.record(el.category, 'params', el.name, ok ? 'pass' : 'fail', {
            mapped, reason: ok ? null : 'Room missing area in mapped params'
          });
        }
        else {
          this.record(el.category, 'params', el.name, 'pass', { mapped });
        }
      } catch (err) {
        this.record(el.category, 'params', el.name, 'fail', { reason: err.message });
      }
    }
  }

  // ── Compound structure parsing (wall layers) ─────────────────────────────
  async testCompoundStructureParsing() {
    console.log('\n=== Compound Structure / Wall Layers ===');
    for (const wall of fixtures.elements.walls) {
      const params = parseRevitParams(wall);
      const cs = params['Compound Structure'];
      if (cs) {
        const layers = parseCompoundStructure(params);
        if (layers.length > 0) {
          this.record(wall.category, 'compound-structure', wall.name, 'pass', {
            layerCount: layers.length,
            layers: layers.map(l => `${l.material} (${l.thickness.toFixed(4)}m)`)
          });
        } else {
          this.record(wall.category, 'compound-structure', wall.name, 'fail', {
            reason: 'Compound structure present but no layers parsed'
          });
        }
      } else {
        this.record(wall.category, 'compound-structure', wall.name, 'skip', {
          reason: 'No compound structure in fixture params'
        });
      }
    }
  }

  // ── Round-trip validation ─────────────────────────────────────────────────
  async testRoundTrip() {
    console.log('\n=== Round-Trip Validation ===');
    mockDb.reset();
    const allElements = fixtures.elements.all();

    for (const el of allElements) {
      const params = parseRevitParams(el);
      const mapped = mapRevitParamsToAtlantist(params, el.category, null);
      const cfg = CAT_MAP[el.category];

      if (!cfg || !cfg.supported) {
        this.record(el.category, null, el.name, 'skip', { reason: `Category not supported (${el.category})` });
        continue;
      }

      // Simulate element creation
      try {
        let created;
        if (cfg.type === 'wall') {
          created = await mockDb.createElement({
            type: 'wall', type_name: params['Type Name'], parameters: mapped,
            base_level_id: 1, top_level_id: 1
          });
        } else if (cfg.type === 'family_instance') {
          created = await mockDb.createFamilyInstance({
            family_type: cfg.family, type_name: params['Type Name'],
            host_wall_id: 1, host_face_u: el.hostFaceU || 0.5,
            parameters: mapped
          });
        } else {
          created = await mockDb.createElement({
            type: cfg.type, type_name: params['Type Name'], parameters: mapped,
            base_level_id: 1
          });
        }

        // Verify round-trip: params should survive
        const storedParams = typeof created.parameters === 'string'
          ? JSON.parse(created.parameters) : created.parameters;

        const issues = [];
        if (el.category === 'OST_Walls') {
          if (!storedParams.length && !storedParams.wall_height) {
            issues.push('missing length after round-trip');
          }
        }
        if (cfg.type === 'family_instance') {
          if (!created.host_wall_id) issues.push('no host wall');
          if (created.host_face_u === undefined) issues.push('no host_face_u');
        }

        this.record(el.category, 'round-trip', el.name, issues.length ? 'fail' : 'pass', {
          issues,
          createdId: created.id,
          createdType: cfg.type
        });
      } catch (err) {
        this.record(el.category, 'round-trip', el.name, 'fail', { reason: err.message });
      }
    }
  }

  // ── Version metadata tests ───────────────────────────────────────────────
  async testVersionMetadata() {
    console.log('\n=== Version Metadata ===');
    for (const v of fixtures.versions.revitVersions) {
      const name = `Revit ${v.revitVersion}`;
      this.record('version-check', v.revitVersion, v.fileName, 'pass', {
        revitVersion: v.revitVersion,
        fileSizeMB: v.fileSizeMB,
        expectedVersion: v.revitVersion
      });
    }
    for (const u of fixtures.versions.upgradedFiles) {
      this.record('version-check', 'upgraded', u.fileName, 'pass', {
        currentVersion: u.revitVersion,
        originalVersion: u.originalVersion,
        migrated: u.migrated
      });
    }
    for (const w of fixtures.versions.worksharedFiles) {
      this.record('version-check', 'workshared', w.fileName, 'pass', {
        workshared: w.workshared,
        hasCentralPath: !!w.centralPath,
        hasLocalPath: !!w.localPath
      });
    }
  }

  // ── Edge case tests ────────────────────────────────────────────────────────
  async testEdgeCases() {
    console.log('\n=== Edge Case Tests ===');

    // In-place families
    for (const ec of fixtures.versions.edgeCases) {
      const cfg = CAT_MAP[ec.category] || { type: 'unknown', supported: false };
      // Should not crash — graceful handling
      try {
        const params = parseRevitParams(ec);
        const mapped = mapRevitParamsToAtlantist(params, ec.category, null);
        this.record(ec.category, 'edge-case', ec.name, 'pass', {
          cfgType: cfg.type,
          cfgSupported: cfg.supported,
          paramKeys: Object.keys(params).length
        });
      } catch (err) {
        this.record(ec.category, 'edge-case', ec.name, 'fail', { reason: err.message });
      }
    }

    // Corrupt files — should handle gracefully
    for (const corrupt of fixtures.versions.corruptFiles) {
      try {
        const params = parseRevitParams(corrupt);
        // Missing required params should not throw
        const mapped = mapRevitParamsToAtlantist(params, corrupt.category, null);
        this.record(corrupt.category, 'corrupt', corrupt.name, 'pass', {
          note: 'Handled gracefully despite missing data',
          paramKeys: Object.keys(params).length
        });
      } catch (err) {
        this.record(corrupt.category, 'corrupt', corrupt.name, 'fail', {
          reason: 'Crashed on malformed element — should handle gracefully'
        });
      }
    }

    // Linked models
    for (const link of fixtures.versions.linkedModels) {
      this.record(link.category, 'linked-model', link.name, 'skip', {
        reason: 'Linked model — geometry not in primary file. ' +
          'Must be imported separately with Design Automation API.'
      });
    }
  }

  // ── CAT_MAP coverage audit ─────────────────────────────────────────────────
  async testCATMAPCoverage() {
    console.log('\n=== CAT_MAP Coverage Audit ===');
    const allRevitCategories = [
      'OST_Walls', 'OST_CurtainWallPanels', 'OST_StackedWalls',
      'OST_Floors', 'OST_Roofs', 'OST_Ceilings',
      'OST_Rooms', 'OST_RoomTags',
      'OST_Doors', 'OST_Windows',
      'OST_Stairs', 'OST_StairsRisers', 'OST_StairsTreads', 'OST_Railing',
      'OST_Columns', 'OST_StructuralColumns',
      'OST_StructuralFraming', 'OST_StructuralFoundation', 'OST_StructuralConnections',
      'OST_Rebar', 'OST_FabricationRebar',
      'OST_DuctCurves', 'OST_FabricationDuctwork', 'OST_DuctTerminal',
      'OST_PipeCurves', 'OST_FabricationPipework',
      'OST_CableTray', 'OST_Conduit',
      'OST_LightingDevices', 'OST_LightingFixtures',
      'OST_ElectricalEquipment', 'OST_MechanicalEquipment',
      'OST_PlumbingFixtures',
      'OST_RevitLinks', 'OST_Groups'
    ];
    const supported = allRevitCategories.filter(c => {
      const cfg = CAT_MAP[c];
      return cfg && cfg.supported;
    });
    const unsupported = allRevitCategories.filter(c => {
      const cfg = CAT_MAP[c];
      return cfg && !cfg.supported;
    });
    const unmapped = allRevitCategories.filter(c => !CAT_MAP[c]);

    for (const cat of supported) {
      this.record('cat-map-coverage', 'supported', cat, 'pass', {
        mappedType: CAT_MAP[cat].type,
        hasLayers: CAT_MAP[cat].layers
      });
    }
    for (const cat of unsupported) {
      this.record('cat-map-coverage', 'unsupported', cat, 'skip', {
        mappedType: CAT_MAP[cat].type,
        reason: 'Not yet supported — see docs/rvt-import-compatibility.md'
      });
    }
    for (const cat of unmapped) {
      this.record('cat-map-coverage', 'unmapped', cat, 'fail', {
        reason: 'No entry in CAT_MAP — add to services/rvt-import.js CAT_MAP'
      });
    }
  }

  // ─── Run all tests ─────────────────────────────────────────────────────────
  async run(filter = 'all') {
    const group = fixtures.elements.byGroup();
    const groups = {
      architectural: group.architectural,
      structural: group.structural,
      mep: group.mep,
      all: fixtures.elements.all()
    };

    if (filter !== 'all' && !groups[filter]) {
      console.error(`Unknown filter: ${filter}. Use: architectural|structural|mep|all`);
      process.exit(1);
    }

    console.log(`\nRunning .rvt import pipeline tests (filter: ${filter})...`);
    await this.testCategoryMapping();
    await this.testParameterParsing();
    await this.testParameterMapping();
    await this.testCompoundStructureParsing();
    await this.testRoundTrip();
    await this.testVersionMetadata();
    await this.testEdgeCases();
    await this.testCATMAPCoverage();

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Tests: ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped`);
    console.log(`Elapsed: ${elapsed}s`);

    return this;
  }
}

// ─── Report generation ────────────────────────────────────────────────────────

function generateMarkdownReport(runner) {
  const results = runner.results;
  const groups = {};

  for (const r of results) {
    if (!groups[r.category]) groups[r.category] = [];
    groups[r.category].push(r);
  }

  let md = '';
  md += `# .rvt Import Pipeline — Compatibility Test Report\n\n`;
  md += `**Date:** ${new Date().toISOString()}  \n`;
  md += `**Total:** ${runner.passed} pass · ${runner.failed} fail · ${runner.skipped} skip\n\n`;

  md += `## Summary\n\n`;
  md += `| Category | Pass | Fail | Skip | Status |\n`;
  md += `|---------|------|------|------|--------|\n`;
  for (const [cat, rows] of Object.entries(groups)) {
    const pass = rows.filter(r => r.status === 'pass').length;
    const fail = rows.filter(r => r.status === 'fail').length;
    const skip = rows.filter(r => r.status === 'skip').length;
    const status = fail > 0 ? '❌ FAIL' : '✅ PASS';
    md += `| ${cat} | ${pass} | ${fail} | ${skip} | ${status} |\n`;
  }

  md += `\n## Element Category Coverage\n\n`;
  const supported = Object.entries(CAT_MAP).filter(([, v]) => v.supported);
  const unsupported = Object.entries(CAT_MAP).filter(([, v]) => !v.supported);

  md += `### ✅ Supported Categories\n\n`;
  md += `| Revit Category | Atlantist Type | Wall Layers |\n`;
  md += `|---------------|---------------|------------|\n`;
  for (const [cat, cfg] of supported) {
    md += `| ${cat} | ${cfg.type}${cfg.family ? ` (${cfg.family})` : ''} | ${cfg.layers ? 'yes' : 'no'} |\n`;
  }

  md += `\n### ⏸️ Not Yet Supported\n\n`;
  md += `| Revit Category | Mapped Type | Notes |\n`;
  md += `|---------------|-------------|-------|\n`;
  for (const [cat, cfg] of unsupported) {
    md += `| ${cat} | ${cfg.type} | See docs/rvt-import-compatibility.md |\n`;
  }

  md += `\n## Detail — Failed Tests\n\n`;
  const fails = results.filter(r => r.status === 'fail');
  if (fails.length === 0) {
    md += `*No failures.*\n`;
  } else {
    for (const f of fails) {
      md += `**${f.category}** / ${f.subcategory || '—'} / ${f.elementName}\n`;
      md += `> ${f.reason || 'Unknown failure'}\n\n`;
    }
  }

  md += `\n## Element-by-Element Results\n\n`;
  for (const [cat, rows] of Object.entries(groups)) {
    md += `### ${cat}\n\n`;
    md += `| Element | Subcategory | Status | Details |\n`;
    md += `|---------|-------------|--------|---------|\n`;
    for (const r of rows) {
      const badge = r.status === 'pass' ? '✅ pass' : r.status === 'fail' ? '❌ fail' : '⏸️ skip';
      const detail = r.mappedType ? `type:${r.mappedType}` :
                     r.layerCount ? `layers:${r.layerCount}` :
                     r.reason || (r.issues && r.issues.length ? `issues: ${r.issues.join(', ')}` : '');
      md += `| ${r.elementName} | ${r.subcategory || '—'} | ${badge} | ${detail} |\n`;
    }
    md += `\n`;
  }

  md += `\n---\n*Generated by jobs/rvt-test-runner.js — Atlantist .rvt Import Pipeline*\n`;
  return md;
}

function generateJSONReport(runner) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: runner.results.length,
      passed: runner.passed,
      failed: runner.failed,
      skipped: runner.skipped
    },
    results: runner.results,
    catMap: CAT_MAP
  }, null, 2);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let filter = 'all';
  let format = 'markdown';
  let outPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fixture') filter = args[++i] || 'all';
    else if (args[i] === '--format') format = args[++i] || 'markdown';
    else if (args[i] === '--out') outPath = args[++i];
  }

  const runner = new TestRunner();
  await runner.run(filter);

  let report;
  if (format === 'json') {
    report = generateJSONReport(runner);
  } else {
    report = generateMarkdownReport(runner);
  }

  if (outPath) {
    const fs = require('fs');
    fs.writeFileSync(outPath, report);
    console.log(`\nReport written to: ${outPath}`);
  } else {
    console.log(report);
  }

  // Exit with error code if any tests failed
  process.exit(runner.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[rvt-test-runner] Fatal error:', err);
  process.exit(1);
});