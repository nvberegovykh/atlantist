# .rvt Import Compatibility — Known Limitations & Element Coverage

**Atlantist BIM · Phase 22 · 2026-05-24**

---

## Overview

The .rvt import pipeline uses **Autodesk Forge Model Derivative API** to convert
Revit files into extractable geometry and BIM metadata, then maps results into
Atlantist's DAG-based data model. Two extraction paths exist:

| Path | API Used | Output | Element Data |
|------|----------|--------|-------------|
| **View-only** | SVF2 manifest | Geometry + materials | Limited (no parameters) |
| **Full element** | Design Automation | DB API, parameters, geometry | Complete |

**Current implementation uses SVF2** for geometry + parameter metadata extraction.
This is sufficient for most element categories. Full DB API access requires
Design Automation API credentials (separate from Model Derivative).

---

## Forge Credentials Setup

```bash
# Required environment variables:
FORGE_CLIENT_ID=your_forge_client_id
FORGE_CLIENT_SECRET=your_forge_client_secret
FORGE_OSS_BUCKET=atlantist-rvt-imports  # optional, defaults to this
```

1. Go to [developer.autodesk.com](https://developer.autodesk.com)
2. Create an app and enable: **Model Derivative API**, **Data Management API**
3. Copy Client ID + Secret to your Render environment variables
4. The pipeline will start processing automatically once credentials are set

---

## Element Category Support

### ✅ Architectural — Full Support

| Revit Category | Atlantist Type | Notes |
|---------------|---------------|-------|
| OST_Walls | `wall` | Compound structure → wall_layers |
| OST_CurtainWallPanels | `wall` (sub: curtain) | Curtain wall systems |
| OST_StackedWalls | `wall` (sub: stacked) | Stacked compound walls |
| OST_Floors | `floor` | Structural, architectural, sloped |
| OST_Roofs | `roof` | Footprint, extrusion, in-place |
| OST_Ceilings | `ceiling` | Ceiling systems |
| OST_Rooms | `room` | Area, number, department |
| OST_RoomTags | `room_tag` | Tag elements, reference only |
| OST_Columns | `column` | Architectural columns |
| OST_Doors | `family_instance` (door) | Hosted on walls, cut geometry auto-generated |
| OST_Windows | `family_instance` (window) | Hosted on walls, sill height preserved |

**Wall layers:** Compound structure parsed → multi-layer wall construction with
material, thickness, and function per layer. 3-layer minimum recommended.

**Door/Window hosting:** `host_face_u` normalized position along host wall (0–1).
Wall cut geometry is automatically computed by the DAG solver.

**Rooms:** Bound to level. Area converted from ft² to m². Room boundaries used
for zone-based energy simulation input.

---

### ✅ Structural — Partial Support

| Revit Category | Atlantist Type | Status |
|---------------|---------------|--------|
| OST_StructuralColumns | `column` (sub: structural) | ✅ Full support |
| OST_StructuralFraming | `beam` | ✅ Full support |
| OST_StructuralFoundation | `foundation` | ⏸️ Mapped as element, no analysis yet |
| OST_StructuralConnections | `connection` | ⏸️ Mapped as element, no 3D geometry yet |
| OST_Rebar | `rebar` | ⏸️ Catalog only, not rendered in 3D |
| OST_FabricationRebar | `rebar` | ⏸️ Same as above |

**Beams:** Structural framing → beam type with start/end levels and offsets.
Used in structural analysis (AISC 360-22).

**Columns:** Structural columns mapped with location line and column style.
Included in structural analysis runs.

---

### ⏸️ MEP — Planned Support

These categories are recognized but not yet mapped to renderable elements.

| Revit Category | Mapped Type | Workaround |
|---------------|-------------|------------|
| OST_DuctCurves | `duct` | Export to IFC → import as IFC Duct |
| OST_FabricationDuctwork | `duct` | Same as above |
| OST_DuctTerminal | `duct_terminal` | Not rendered |
| OST_PipeCurves | `pipe` | Export to IFC → import |
| OST_FabricationPipework | `pipe` | Same as above |
| OST_CableTray | `cabletray` | Not rendered |
| OST_Conduit | `conduit` | Not rendered |
| OST_LightingDevices | `fixture` | Not rendered |
| OST_LightingFixtures | `fixture` | Not rendered |
| OST_ElectricalEquipment | `equipment` | Not rendered |
| OST_MechanicalEquipment | `equipment` | Not rendered |
| OST_PlumbingFixtures | `fixture` | Not rendered |

**MEP workaround:** Export from Revit as IFC2x3 or IFC4 → use Atlantist's IFC import.
MEP systems render in the 3D viewer and are included in the BIM model.
Energy simulation uses room/zone boundaries, not MEP routing.

---

### ⏸️ Stairs & Railings — Not Rendered

| Revit Category | Status | Notes |
|---------------|--------|-------|
| OST_Stairs | `stair` (⏸️) | In BIM model, not rendered in 3D |
| OST_StairsRisers | — | Skipped (detail of stair) |
| OST_StairsTreads | — | Skipped (detail of stair) |
| OST_Railing | `railing` (⏸️) | In BIM model, not rendered in 3D |
| OST_RailingTermination | — | Skipped |

Stair geometry is complex (run/tread/riser/landing). Full 3D support requires
component-based stair import — on the roadmap for Phase 26 (Furniture Assembly).

---

## Revit Version Coverage

Tested with: **2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025**

| Version | Status | Notes |
|---------|--------|-------|
| 2018 | ✅ Works | Oldest supported version |
| 2019 | ✅ Works | |
| 2020 | ✅ Works | |
| 2021 | ✅ Works | |
| 2022 | ✅ Works | |
| 2023 | ✅ Works | |
| 2024 | ✅ Works | |
| 2025 | ✅ Works | |

**Upgraded files:** Files saved from an older version in a newer Revit are
handled correctly. The file version (what it was last saved in) is used
for format detection, not the original creation version.

---

## Workshared Files

Central model (.rvt) and local copies (.rvt) work correctly. The importer
processes whatever is uploaded — worksharing state is not relevant since
we're importing geometry, not editing the model.

**Note:** Workshared files may contain model group overrides. These are
flattened on export and may not reflect design option overrides.

---

## Design Options

Elements belonging to a design option group are imported with their option name
stored in `parameters['Design Option']`. Currently **all options are imported**
(not filtered by active option). To filter to a specific option, add a
`design_option_filter` parameter to the import request.

---

## In-Place Families

In-place families (custom geometry created inside the .rvt file) are imported
as `wall` or `element` type with the family name preserved. The geometry may
not be optimal since in-place families often use simplified sweep/extrusion
forms rather than parametric solid geometry.

**Tip:** If you have in-place families that don't import correctly, convert them
to system families or loaded component families in Revit before exporting.

---

## Linked Models

Linked .rvt files (via `OST_RevitLinks`) are **not imported automatically**.
To include a linked model:

1. Bind the links in Revit (Link → Bind Link) then save
2. Or import the linked model separately and merge projects

Revit's linked model references are not flattened by Model Derivative.

---

## Large Files

Files 500MB+ are handled with:
- **Streaming upload** to Forge OSS (chunked)
- **Extended polling timeout** (5 minutes for manifest)
- **Batch result insertion** (batchCreateResults, not row-by-row)

If you encounter timeout errors on large files, increase the `timeout` parameter
in `services/rvt-import.js` → `pollManifest()`.

---

## Corrupt / Partial Files

The importer handles malformed elements gracefully:
- Missing `Type Name` → uses `Name` or category as fallback
- Missing `Level` → element has null `base_level_id`
- Missing `hostElementId` for doors/windows → `host_wall_id` is null, element
  is created but not bound to a wall (user can reassign manually)
- Empty parameters object → element created with empty `parameters` JSONB

Error handling: individual element failures are recorded in `rvt_import_results`
with `import_status = 'failed'` and `error_message`. The job continues processing
remaining elements.

---

## Known Gaps

| Gap | Severity | Workaround |
|-----|----------|------------|
| No IFC export round-trip | Low | Use IFC export (separate pipeline) |
| MEP not rendered | Medium | Use IFC import workaround |
| Stairs not in 3D | Low | On roadmap Phase 26 |
| Railings not rendered | Low | On roadmap Phase 26 |
| Design options not filtered | Low | Use design_option_filter param |
| Linked models not auto-imported | Medium | Bind links before exporting |
| No shared parameters extraction | Medium | Parameters must be exposed as Type/Instance |
| No phase/assembly data | Low | Phase data not in SVF2 output |
| No structural analytical model | Medium | Use OpenSees for structural analysis (Phase 13) |

---

## Running the Test Suite

```bash
# Run all tests (no Forge credentials needed — uses fixtures)
node jobs/rvt-test-runner.js

# Architectural only
node jobs/rvt-test-runner.js --fixture architectural

# Structural only
node jobs/rvt-test-runner.js --fixture structural

# MEP only
node jobs/rvt-test-runner.js --fixture mep

# JSON output
node jobs/rvt-test-runner.js --format json --out /tmp/rvt-report.json

# Markdown report
node jobs/rvt-test-runner.js --format markdown --out /tmp/rvt-report.md
```

---

## Test Fixtures Location

All synthetic Revit element fixtures are in `tests/fixtures/rvt/`:
- `architectural-walls.js` — architectural, structural, MEP element fixtures
- `versions-edge-cases.js` — Revit versions, design options, corrupt files

Fixtures represent the normalized JSON format produced by the Model Derivative
API after SVF2 metadata extraction. They let us test the mapper end-to-end
without a live Forge connection.

---

*Last updated: 2026-05-24 · Phase 22 · Atlantist BIM*