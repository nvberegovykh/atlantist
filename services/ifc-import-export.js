/**
 * IFC STEP file import and export for Atlantist BIM 2.0.
 * Does NOT own: DB writes, HTTP routing, WebSocket broadcast.
 *
 * IFC (ISO 10303-21) is the open BIM interchange format.
 * Both import and export target IFC 2x3 schema (most widely compatible).
 *
 * Import pipeline (server-side):
 *   1. Parse STEP file lines → entity index (#id → entity data)
 *   2. Walk spatial hierarchy: IfcSite → IfcBuilding → IfcBuildingStorey → IfcSpace → elements
 *   3. Extract placement (IfcLocalPlacement → IfcCartesianPoint)
 *   4. Map entity types → Atlantist element types
 *   5. Return structured result with geometry coords + material data
 *
 * Export pipeline (server-side):
 *   1. Query all levels, elements, family_instances for a project
 *   2. Map Atlantist types → IFC entity types
 *   3. Generate IFC HEADER + representation entities
 *   4. Write IfcProduct entities with IfcLocalPlacement + IfcPropertySet
 *   5. Return IFC STEP file content as Buffer
 *
 * IFC layer mapping:
 *   IfcWallStandardCase / IfcWall        → wall (with layers from IfcMaterialLayerSet)
 *   IfcDoor                                   → door family instance
 *   IfcWindow                                 → window family instance
 *   IfcSlab (FloorType / RoofType)          → floor / roof element
 *   IfcColumn                                 → column element
 *   IfcStair                                 → stair element
 *   IfcSpace                                 → room / space boundary
 *   IfcBuildingElementProxy                  → generic element
 *   IfcBuildingStorey                        → Atlantist level (elevation)
 *   IfcMaterial / IfcMaterialLayerSetUsage   → wall layer material
 */

// ─── IFC STEP Parser (STEP/ISO 10303-21) ──────────────────────────────────────

/**
 * Parse an IFC STEP file into an entity index.
 * Returns { entities: Map<number, Entity>, header: object }
 * Entity: { id, type, attrs }
 */
function parseIFCSTEP(content) {
  const lines = content.split(/\r?\n/);
  const entities = new Map();
  let inData = false;
  let entityBuffer = '';
  let currentId = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'DATA;') { inData = true; continue; }
    if (line === 'ENDSEC;') { inData = false; continue; }
    if (!inData) continue;

    // Accumulate entity lines until we have a balanced )...;
    entityBuffer += ' ' + line;

    // Flush when we see a line ending with semicolon
    if (line.endsWith(';')) {
      // Count parentheses to detect nested entity boundary
      let open = 0, close = 0;
      for (const ch of entityBuffer) {
        if (ch === '(') open++;
        else if (ch === ')') close++;
      }
      if (open > close) continue; // still inside nested parens

      const text = entityBuffer.trim();
      entityBuffer = '';

      if (!text) continue;
      const parsed = parseEntity(text);
      if (parsed) {
        entities.set(parsed.id, parsed);
      }
    }
  }

  return { entities };
}

/**
 * Parse a single STEP entity line.
 * Examples:
 *   #123=IFCWALLSTANDARDCASE('0$abc','Wall','Wall',$,#,#456,#789);
 *   #10=IFCCARTESIANPOINT((0.,0.,0.));
 */
function parseEntity(line) {
  // Remove trailing semicolon
  const text = line.replace(/;$/, '').trim();
  if (!text) return null;

  // Split on first '='
  const eqIdx = text.indexOf('=');
  if (eqIdx < 0) return null;

  const idPart = text.slice(0, eqIdx).trim();
  const id = parseInt(idPart.replace('#', ''), 10);
  if (isNaN(id)) return null;

  // Find type name — everything between '=' and first '('
  const parenIdx = text.indexOf('(');
  if (parenIdx < 0) return null;

  const type = text.slice(eqIdx + 1, parenIdx).trim().toUpperCase();
  const attrStr = text.slice(parenIdx + 1, text.length);

  // Parse attributes, handling nested () and '' strings
  const attrs = parseAttributes(attrStr);

  return { id, type, attrs };
}

/**
 * Parse attribute string inside parentheses, respecting string literals and nesting.
 * Returns an array of attribute values (string, number, null, or array).
 */
function parseAttributes(str) {
  // Remove outer parentheses
  let inner = str;
  if (inner.startsWith('(')) inner = inner.slice(1);
  if (inner.endsWith(')')) inner = inner.slice(0, -1);
  if (!inner) return [];

  const attrs = [];
  let i = 0;
  const n = inner.length;

  while (i < n) {
    const ch = inner[i];

    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }

    if (ch === '(') {
      // Nested list — find matching close
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (inner[j] === '(') depth++;
        else if (inner[j] === ')') depth--;
        j++;
      }
      attrs.push(parseAttributes(inner.slice(i, j)));
      i = j;
    } else if (ch === "'") {
      // Quoted string
      let j = i + 1;
      while (j < n) {
        if (inner[j] === "'" && inner[j + 1] === "'") { j += 2; continue; }
        if (inner[j] === "'") { j++; break; }
        j++;
      }
      attrs.push(inner.slice(i + 1, j - 1));
      i = j;
    } else if (ch === '$') {
      attrs.push(null);
      i++;
    } else if (ch === '*') {
      attrs.push('*');
      i++;
    } else if (ch === ',') {
      i++;
    } else {
      // Unquoted value — read until comma or close paren
      let j = i;
      while (j < n && inner[j] !== ',' && inner[j] !== ')') j++;
      const val = inner.slice(i, j).trim();
      if (val === '') { i = j; continue; }
      if (val === '.T.') attrs.push(true);
      else if (val === '.F.') attrs.push(false);
      else if (!isNaN(parseFloat(val)) && val.includes('.')) attrs.push(parseFloat(val));
      else if (!isNaN(parseInt(val, 10))) attrs.push(parseInt(val, 10));
      else attrs.push(val);
      i = j;
    }
  }

  return attrs;
}

// ─── Placement extraction ─────────────────────────────────────────────────────

/**
 * Get 3D position of an IfcProduct from its ObjectPlacement.
 * Returns { x, y, z } in IFC world coordinates (meters in IFC typically).
 */
function getPlacementPosition(entities, placementRef) {
  if (!placementRef) return { x: 0, y: 0, z: 0 };
  const ref = deref(entities, placementRef);
  if (!ref) return { x: 0, y: 0, z: 0 };

  // IfcLocalPlacement: attrs[0] = RelativePlacement (IfcAxis2Placement)
  // IfcAxis2Placement: attrs[0] = Location (IfcCartesianPoint)
  // IfcCartesianPoint: attrs[0] = Coordinates list [x, y, z]
  const relPlacement = deref(entities, ref.attrs[0]);
  if (!relPlacement) return { x: 0, y: 0, z: 0 };

  const point = deref(entities, relPlacement.attrs[0]);
  if (!point) return { x: 0, y: 0, z: 0 };

  // IfcCartesianPoint — coords may be in attr[0] as array
  const coords = point.attrs[0];
  if (Array.isArray(coords)) {
    return {
      x: coords[0] || 0,
      y: coords[1] || 0,
      z: coords[2] || 0
    };
  }
  return { x: 0, y: 0, z: 0 };
}

/**
 * Get start/end points for wall placement.
 * IfcWallStandardCase has a Reprsentation → IfcShapeRepresentation with
 * IfcExtrudedAreaSolid → IfcSweptAreaSolid → profile → IfcRectangleProfileDef
 * or IfcArbitraryClosedProfileDef → IfcPolyline.
 *
 * Simpler path: walk ObjectPlacement to get placement, walk Representation
 * for geometry. Falls back to using axis points from IfcWall's containment link.
 */
function getWallPoints(entities, wallEntity) {
  // Try to find axis line from representation
  const pos = getPlacementPosition(entities, wallEntity.attrs.find(a => a && typeof a === 'number'));

  // Look for IfcShapeRepresentation children
  const shapeReprs = findEntityRefs(entities, wallEntity, 'IFCSHAPEREPRESENTATION');
  for (const repr of shapeReprs) {
    // Check if this is an ExtrudedAreaSolid (axis line)
    const items = repr.attrs[5]; // Items
    if (!Array.isArray(items)) continue;
    for (const itemRef of items) {
      const item = deref(entities, itemRef);
      if (!item) continue;

      if (item.type === 'IFCEXTRUDEDAREASOLID') {
        // Get SweptArea → ProfileDef
        const sweptArea = deref(entities, item.attrs[0]);
        if (!sweptArea) continue;
        const profileDef = deref(entities, sweptArea.attrs[0]);
        if (!profileDef) continue;

        // Position of extrusion gives direction
        const extrPos = deref(entities, item.attrs[3]); // Position
        const depth = item.attrs[4]; // Depth

        let dirX = 1, dirY = 0, dirZ = 0;
        if (extrPos) {
          const pLoc = deref(entities, extrPos.attrs[0]);
          if (pLoc) {
            // pLoc is IfcAxis2Placement → RefDirection
            const refDir = deref(entities, extrPos.attrs.length > 1 ? extrPos.attrs[1] : null);
            if (refDir) {
              const dirCoords = refDir.attrs[0];
              if (Array.isArray(dirCoords) && dirCoords.length >= 2) {
                dirX = dirCoords[0]; dirY = dirCoords[1];
              }
            }
          }
        }

        const pos3 = getPlacementPosition(entities, item.attrs[3]);
        return {
          startX: pos3.x, startY: pos3.y, startZ: pos3.z,
          endX: pos3.x + dirX * depth, endY: pos3.y + dirY * depth, endZ: pos3.z + dirZ * depth
        };
      }
    }
  }

  // Fallback: check RelVoidsElement or ContainedInStructure
  return { startX: pos.x, startY: pos.y, startZ: pos.z,
           endX: pos.x + 3, endY: pos.y, endZ: pos.z };
}

function findEntityRefs(entities, entity, type) {
  const results = [];
  function walk(v) {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'number') {
      const e = entities.get(v);
      if (e && e.type === type) results.push(e);
    }
  }
  Object.values(entity.attrs).forEach(walk);
  return results;
}

function deref(entities, ref) {
  if (!ref) return null;
  if (typeof ref === 'number') return entities.get(ref) || null;
  return null;
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

/** IFC entity type → Atlantist element type */
function mapIfcTypeToAtlantist(ifcType) {
  const t = ifcType.toUpperCase();
  if (t === 'IFCWALLSTANDARDCASE' || t === 'IFCWALL') return 'wall';
  if (t === 'IFCCOLUMN') return 'column';
  if (t === 'IFCDOOR') return 'door';
  if (t === 'IFCWINDOW') return 'window';
  if (t === 'IFCSLAB') return 'slab';
  if (t === 'IFCROOF') return 'roof';
  if (t === 'IFCSTAIR') return 'stair';
  if (t === 'IFCSPACE') return 'room';
  if (t === 'IFCBUILDINGELEMENTPROXY') return 'element';
  return null;
}

/** Atlantist element type → IFC entity type */
function mapAtlantistTypeToIfc(type) {
  const t = (type || '').toLowerCase();
  if (t === 'wall') return 'IfcWallStandardCase';
  if (t === 'column') return 'IfcColumn';
  if (t === 'slab' || t === 'floor') return 'IfcSlab';
  if (t === 'roof') return 'IfcRoof';
  if (t === 'door') return 'IfcDoor';
  if (t === 'window') return 'IfcWindow';
  return 'IfcBuildingElementProxy';
}

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * Run full IFC import: parse STEP file, map entities, return structured result.
 * @param {string} ifcContent - raw text of the .ifc STEP file
 * @param {object} options - { project_id }
 * @returns {object} { levels: [], elements: [], family_instances: [], stats }
 */
function importIFC(ifcContent, options = {}) {
  const { entities } = parseIFCSTEP(ifcContent);
  const result = {
    elements: [],
    levels: [],
    family_instances: [],
    stats: { walls: 0, columns: 0, doors: 0, windows: 0, slabs: 0, stairs: 0, rooms: 0, other: 0 }
  };

  // ── Walk spatial hierarchy to extract levels ─────────────────────────────
  // IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey → IfcSpace
  // We find IfcBuildingStorey entities and create levels

  const storeys = [];
  entities.forEach((entity, id) => {
    if (entity.type === 'IFCBUILDINGSTOREY') {
      storeys.push({ id, entity });
    }
  });

  // Sort by elevation (IfcBuildingStorey has Elevation attribute, or default +index)
  storeys.sort((a, b) => {
    const elevA = extractNumericAttr(a.entity, 1, 0);
    const elevB = extractNumericAttr(b.entity, 1, 0);
    return elevA - elevB;
  });

  storeys.forEach((storey, idx) => {
    const name = extractStringAttr(storey.entity, 1, `Level ${idx + 1}`);
    const elevation = extractNumericAttr(storey.entity, 1, idx * 3.0); // default 3m floors
    result.levels.push({
      name,
      elevation,
      ifc_global_id: getGlobalId(storey.entity),
      ifc_entity_id: storey.id
    });
  });

  if (result.levels.length === 0) {
    // Default level if no IfcBuildingStorey found
    result.levels.push({ name: 'Level 1', elevation: 0 });
  }

  // ── Walk elements ─────────────────────────────────────────────────────────
  entities.forEach((entity, id) => {
    const atlantistType = mapIfcTypeToAtlantist(entity.type);
    if (!atlantistType) return;

    const globalId = getGlobalId(entity) || `IFC-${id}`;
    const name = extractStringAttr(entity, 1, atlantistType);
    const placement = getPlacementPosition(entities, entity.attrs[5]); // ObjectPlacement often at attr[5]

    if (atlantistType === 'wall') {
      const pts = getWallPoints(entities, entity);
      const height = extractNumericAttr(entity, 7, 2.7);
      const ifcMat = extractMaterial(entities, entity);

      result.elements.push({
        type: 'wall',
        type_name: extractStringAttr(entity, 2, 'Generic Wall'),
        parameters: {
          height: height || 2.7,
          start: { x: pts.startX, y: pts.startY, z: pts.startZ },
          end: { x: pts.endX, y: pts.endY, z: pts.endZ },
          thickness: ifcMat.thickness || 0.15,
          layers: ifcMat.layers || [],
        },
        computed: {
          start: { x: pts.startX, y: pts.startY, z: pts.startZ },
          end: { x: pts.endX, y: pts.endY, z: pts.endZ },
          length: Math.sqrt(
            Math.pow(pts.endX - pts.startX, 2) +
            Math.pow(pts.endY - pts.startY, 2)
          ),
          height: height || 2.7,
        },
        ifc_global_id: globalId,
        ifc_entity_id: id,
        ifc_type: entity.type,
        position: placement,
        statsCategory: 'walls'
      });
      result.stats.walls++;
    } else if (atlantistType === 'column') {
      const height = extractNumericAttr(entity, 7, 3.0);
      result.elements.push({
        type: 'column',
        type_name: extractStringAttr(entity, 2, 'Structural Column'),
        parameters: {
          height: height || 3.0,
          width: extractNumericAttr(entity, 8, 0.3),
          depth: extractNumericAttr(entity, 9, 0.3),
        },
        computed: {
          x: placement.x, y: placement.y, z: placement.z,
          height: height || 3.0,
        },
        ifc_global_id: globalId,
        ifc_entity_id: id,
        ifc_type: entity.type,
        position: placement,
        statsCategory: 'columns'
      });
      result.stats.columns++;
    } else if (atlantistType === 'slab') {
      // Check usage attribute (FloorType vs RoofType)
      const usageType = extractStringAttr(entity, 3, 'FLOOR');
      result.elements.push({
        type: usageType === 'ROOF' ? 'roof' : 'floor',
        type_name: extractStringAttr(entity, 2, 'Slab'),
        parameters: {
          thickness: extractNumericAttr(entity, 7, 0.15),
        },
        computed: {
          z: placement.z,
        },
        ifc_global_id: globalId,
        ifc_entity_id: id,
        ifc_type: entity.type,
        position: placement,
        statsCategory: 'slabs'
      });
      result.stats.slabs++;
    } else if (atlantistType === 'stair') {
      result.elements.push({
        type: 'stair',
        type_name: extractStringAttr(entity, 2, 'Stair'),
        parameters: {},
        computed: { x: placement.x, y: placement.y, z: placement.z },
        ifc_global_id: globalId,
        ifc_entity_id: id,
        ifc_type: entity.type,
        position: placement,
        statsCategory: 'stairs'
      });
      result.stats.stairs++;
    } else if (atlantistType === 'room') {
      // IfcSpace → could become room boundary, skip for element list
      result.stats.rooms++;
    } else {
      result.stats.other++;
    }
  });

  // ── Walk doors and windows ────────────────────────────────────────────────
  entities.forEach((entity, id) => {
    const globalId = getGlobalId(entity) || `IFC-${id}`;
    const placement = getPlacementPosition(entities, entity.attrs[5]);
    const name = extractStringAttr(entity, 1, '');

    if (entity.type === 'IFCDOOR') {
      const width = extractNumericAttr(entity, 5, 0.9);
      const height = extractNumericAttr(entity, 6, 2.1);
      // Find which wall this door is hosted on (F relating connection structure)
      const hostWallRef = entity.attrs.find(a => typeof a === 'number');

      result.family_instances.push({
        type: 'door',
        family_type: name || 'Standard Door',
        parameters: { width: width || 0.9, height: height || 2.1 },
        host_face_u: 0.5, // default center
        host_wall_ifc_id: hostWallRef,
        ifc_global_id: globalId,
        ifc_entity_id: id,
        ifc_type: entity.type,
        position: placement,
        statsCategory: 'doors'
      });
      result.stats.doors++;
    } else if (entity.type === 'IFCWINDOW') {
      const width = extractNumericAttr(entity, 5, 1.2);
      const height = extractNumericAttr(entity, 6, 1.5);
      const sillHeight = extractNumericAttr(entity, 7, 0.9);

      result.family_instances.push({
        type: 'window',
        family_type: name || 'Standard Window',
        parameters: { width: width || 1.2, height: height || 1.5, sill_height: sillHeight || 0.9 },
        host_face_u: 0.5,
        host_wall_ifc_id: null,
        ifc_global_id: globalId,
        ifc_entity_id: id,
        ifc_type: entity.type,
        position: placement,
        statsCategory: 'windows'
      });
      result.stats.windows++;
    }
  });

  return result;
}

// ─── Attribute helpers ────────────────────────────────────────────────────────

function extractStringAttr(entity, idx, fallback = '') {
  const v = entity.attrs[idx];
  if (typeof v === 'string') return v.replace(/^'|'$/g, '');
  if (v === null || v === undefined) return fallback;
  return String(fallback);
}

function extractNumericAttr(entity, idx, fallback = 0) {
  const v = entity.attrs[idx];
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'number') return v[0];
  return fallback;
}

function getGlobalId(entity) {
  // GlobalId is typically attrs[0] for IfcProduct subtypes
  // Stored as 22-char encoded string like '0$abc123'
  const v = entity.attrs[0];
  if (typeof v === 'string') return v;
  return null;
}

function extractMaterial(entities, entity) {
  // Walk attrs to find IfcMaterial or IfcMaterialLayerSet
  let materialRef = null;
  function walkAttr(v) {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walkAttr); return; }
    if (typeof v === 'number') {
      const e = entities.get(v);
      if (!e) return;
      if (e.type === 'IFCMATERIALLAYERSETUSAGE') {
        const lsRef = e.attrs[0];
        const ls = entities.get(lsRef);
        if (ls && ls.type === 'IFCMATERIALLAYERSET') {
          const layersRef = ls.attrs[2];
          if (Array.isArray(layersRef)) {
            const layerRefs = layersRef.flat ? layersRef.flat() : layersRef;
            return layerRefs;
          }
        }
      }
    }
  }
  entity.attrs.forEach(walkAttr);
  return { thickness: 0.15, layers: [] };
}

// ─── Export ────────────────────────────────────────────────────────────────────

let _entityCounter = 1;
function nextId() { return _entityCounter++; }
function resetCounter() { _entityCounter = 1; }

// Uniform B-spline knot vector generator for IFC NURBS surfaces
function generateUniformKnotVector(controlPointCount, degree) {
  const total = controlPointCount + degree + 1;
  const knots = [];
  for (let i = 0; i < total; i++) {
    if (i <= degree) knots.push(0.0);
    else if (i >= total - degree - 1) knots.push(1.0);
    else knots.push((i - degree) / (total - 2 * degree - 1));
  }
  return knots;
}

/**
 * Generate IFC STEP file content from Atlantist elements.
 * Uses IFC 2x3 schema.
 *
 * @param {object} data - { levels, elements, family_instances, projectName, schema }
 * @returns {string} IFC STEP file content
 */
function exportIFC(data) {
  resetCounter();
  const lines = [];

  const emit = (line) => lines.push(line);

  // ── File header ────────────────────────────────────────────────────────────
  emit("ISO-10303-21;");
  emit("HEADER;");
  emit("FILE_DESCRIPTION((\\'ViewDefinition [CoordinationView]\\'),\\'2;1\\');");
  const projName = (data.projectName || "Atlantist Export").replace(/'/g, "\\'");
  const dateStr = new Date().toISOString().split("T")[0];
  emit(`FILE_NAME(\\'${projName}.ifc\\',\\'${dateStr}\\',(\\'Atlantist BIM 2.0\\'),(\\'Atlantist\\'),\\' Atlantist IFC Export\\',\\'\\',\\'\\');`);
  emit("FILE_SCHEMA((\\'IFC2X3\\'));");
  emit("ENDSEC;");
  emit("DATA;");

  // ── Entity map for reference resolution ──────────────────────────────────
  const entityMap = {};

  function reg(globalId, stepId) { entityMap[globalId] = stepId; }

  // ── Owner history (required for IfcProduct) ───────────────────────────────
  const ownerHistoryId = nextId();
  const applicationId = nextId();
  const orgId = nextId();
  const personId = nextId();
  const personAndOrgId = nextId();

  emit(`#${ownerHistoryId}=IFCOWNERHISTORY(#${personAndOrgId},#${applicationId},$,.NOACTION.,$,$,$,$);`);
  emit(`#${applicationId}=IFCAPPLICATION(#${orgId},\\'1.0\\',\\'Atlantist BIM 2.0\\',\\'\\');`);
  emit(`#${orgId}=IFCORGANIZATION($,\\'Atlantist\\',$,$,$);`);
  emit(`#${personId}=IFCPERSON($,\\'\\',$,$,$,$);`);
  emit(`#${personAndOrgId}=IFCPERSONANDORGANIZATION(#${personId},#${orgId},$);`);

  // ── Project ───────────────────────────────────────────────────────────────
  const projectId = nextId();
  const buildingId = nextId();
  const siteId = nextId();

  emit(`#${projectId}=IFCPROJECT($,$,$,(\\),(\\),(#${buildingId}),#${ownerHistoryId});`);
  reg("IFCPROJECT", projectId);

  emit(`#${siteId}=IFCSITE($,$,$,$,$,$,$,$,$,$,$,$);`);
  reg("IFCSITE", siteId);

  emit(`#${buildingId}=IFCBUILDING($,$,$,$,$,$,$,$,$,$);`);
  reg("IFCBUILDING", buildingId);

  // ── Levels (IfcBuildingStorey) ───────────────────────────────────────────
  const levelStepIds = {};
  const defaultLevelId = nextId();
  emit(`#${defaultLevelId}=IFCBUILDINGSTOREY($,\\'Level 1\\',$,$,$,#${ownerHistoryId},$,$,$,0.);`);
  reg("Level 1", defaultLevelId);
  levelStepIds[1] = defaultLevelId;

  (data.levels || []).forEach((level, idx) => {
    const stepId = nextId();
    const name = (level.name || `Level ${idx + 1}`).replace(/'/g, "\\'");
    const elev = level.elevation || 0;
    emit(`#${stepId}=IFCBUILDINGSTOREY($,\\'${name}\\',$,$,$,#${ownerHistoryId},$,$,$,${elev.toFixed(3)});`);
    reg(name, stepId);
    levelStepIds[idx + 1] = stepId;
  });

  // ── Site geometry ────────────────────────────────────────────────────────
  const sitePtId = nextId();
  emit(`#${sitePtId}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const sitePlacementId = nextId();
  emit(`#${sitePlacementId}=IFCLOCALPLACEMENT($,#${sitePtId});`);
  const buildingPlacementId = nextId();
  emit(`#${buildingPlacementId}=IFCLOCALPLACEMENT(#${sitePlacementId},#${sitePtId});`);

  // ── Elements (walls, columns) ─────────────────────────────────────────────
  (data.elements || []).forEach((el, idx) => {
    const px = el.computed?.start?.x || 0;
    const py = el.computed?.start?.y || 0;
    const pz = el.computed?.start?.z || 0;
    const stepId = nextId();
    const globalId = (el.ifc_global_id || `ATL-${idx + 1}`).replace(/'/g, "\\'");
    const name = (el.type_name || mapAtlantistTypeToIfc(el.type)).replace(/'/g, "\\'");

    emit(`#${nextId()}=IFCCARTESIANPOINT((${px.toFixed(4)},${py.toFixed(4)},${pz.toFixed(4)}));`);
    const placementId = nextId();
    const ptId = stepId;
    emit(`#${placementId}=IFCLOCALPLACEMENT(#${buildingPlacementId},(#${ptId},$,$));`);

    if (el.type === "wall") {
      const sx = el.computed?.start?.x || 0;
      const sy = el.computed?.start?.y || 0;
      const ex = el.computed?.end?.x || sx + 3;
      const ey = el.computed?.end?.y || sy;
      const height = el.parameters?.height || 2.7;
      const thickness = el.parameters?.thickness || 0.15;

      const pt1 = nextId(), pt2 = nextId();
      emit(`#${pt1}=IFCCARTESIANPOINT((${sx.toFixed(4)},${sy.toFixed(4)}));`);
      emit(`#${pt2}=IFCCARTESIANPOINT((${ex.toFixed(4)},${ey.toFixed(4)}));`);
      emit(`#${nextId()}=IFCPOLYLINE((#${pt1},#${pt2}),$);`);

      const profileId = nextId();
      emit(`#${profileId}=IFCRECTANGLEPROFILEDEF(.AREA.,\\'Wall Profile\\',$,${thickness.toFixed(4)},${thickness.toFixed(4)});`);
      const dirId = nextId();
      emit(`#${dirId}=IFCDIRECTION((0.,0.,1.));`);
      const ePt = nextId();
      emit(`#${ePt}=IFCCARTESIANPOINT((${sx.toFixed(4)},${sy.toFixed(4)}));`);
      const ePlace = nextId();
      emit(`#${ePlace}=IFCAXIS2PLACEMENT3D(#${ePt},#${dirId},$);`);
      const extId = nextId();
      emit(`#${extId}=IFCEXTRUDEDAREASOLID(#${profileId},#${ePlace},#${dirId},${height.toFixed(4)});`);
      const reprId = nextId();
      emit(`#${reprId}=IFCSHAPEREPRESENTATION(#${buildingId},\\'Body\\',$,(#${extId}),$);`);
      const shapeId = nextId();
      emit(`#${shapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${reprId}));`);
      emit(`#${stepId}=IFCWALLSTANDARDCASE(\\'${globalId}\\,\\'${name}\\,\\'\\,\\'\\,#${placementId},#${shapeId},\\'${globalId}\\');`);
    } else if (el.type === "column") {
      const w = el.parameters?.width || 0.3;
      const d = el.parameters?.depth || 0.3;
      const h = el.computed?.height || 3.0;
      const profileId = nextId();
      emit(`#${profileId}=IFCRECTANGLEPROFILEDEF(.AREA.,\\'Column Profile\\',$,${w.toFixed(4)},${d.toFixed(4)});`);
      const dirId = nextId();
      emit(`#${dirId}=IFCDIRECTION((0.,0.,1.));`);
      const ePt = nextId();
      emit(`#${ePt}=IFCCARTESIANPOINT((${px.toFixed(4)},${py.toFixed(4)}));`);
      const ePlace = nextId();
      emit(`#${ePlace}=IFCAXIS2PLACEMENT3D(#${ePt},#${dirId},$);`);
      const extId = nextId();
      emit(`#${extId}=IFCEXTRUDEDAREASOLID(#${profileId},#${ePlace},#${dirId},${h.toFixed(4)});`);
      const reprId = nextId();
      emit(`#${reprId}=IFCSHAPEREPRESENTATION(#${buildingId},\\'Body\\',$,(#${extId}),$);`);
      const shapeId = nextId();
      emit(`#${shapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${reprId}));`);
      emit(`#${stepId}=IFCCOLUMN(\\'${globalId}\\,\\'${name}\\,\\'\\,\\'\\,#${placementId},#${shapeId},\\'${globalId}\\');`);
    } else {
      const reprId = nextId();
      emit(`#${reprId}=IFCSHAPEREPRESENTATION(#${buildingId},\\'Body\\',$,(),$);`);
      const shapeId = nextId();
      emit(`#${shapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${reprId}));`);
      emit(`#${stepId}=IFCBUILDINGELEMENTPROXY(\\'${globalId}\\,\\'${name}\\,\\'\\,\\'\\,#${placementId},#${shapeId},\\'${globalId}\\');`);
    }

    reg(globalId, stepId);
  });

  // ── Family instances (doors, windows) ───────────────────────────────────
  (data.family_instances || []).forEach((fi, idx) => {
    const globalId = (fi.ifc_global_id || `ATL-FI-${idx + 1}`).replace(/'/g, "\\'");
    const name = (fi.family_type || (fi.type === "door" ? "Door" : "Window")).replace(/'/g, "\\'");
    const px = fi.position?.x || 0;
    const py = fi.position?.y || 0;
    const pz = fi.position?.z || 0;
    const w = fi.parameters?.width || 0.9;
    const h = fi.parameters?.height || 2.1;

    const ptId = nextId();
    emit(`#${ptId}=IFCCARTESIANPOINT((${px.toFixed(4)},${py.toFixed(4)},${pz.toFixed(4)}));`);
    const placementId = nextId();
    emit(`#${placementId}=IFCLOCALPLACEMENT(#${buildingPlacementId},(#${ptId},$,$));`);

    const pWidthId = nextId(), pHeightId = nextId(), psetId = nextId();
    emit(`#${pWidthId}=IFCPROPERTYSINGLEVALUE(\\'Width\\',$,IFCREAL(${w.toFixed(4)}),$);`);
    emit(`#${pHeightId}=IFCPROPERTYSINGLEVALUE(\\'Height\\',$,IFCREAL(${h.toFixed(4)}),$);`);
    emit(`#${psetId}=IFCPROPERTYSET(\\'${globalId}-dim\\',$,(#${pWidthId},#${pHeightId}),#${ownerHistoryId});`);

    const stepId = nextId();
    if (fi.type === "window") {
      emit(`#${stepId}=IFCWINDOW(\\'${globalId}\\,\\'${name}\\,\\'\\,\\'\\,#${placementId},$,\\'${globalId}\\');`);
    } else {
      emit(`#${stepId}=IFCDOOR(\\'${globalId}\\,\\'${name}\\,\\'\\,\\'\\,#${placementId},$,\\'${globalId}\\');`);
    }
    reg(globalId, stepId);
  });

  // ── Curved Surfaces (Phase 22) ─────────────────────────────────────────
  (data.curvedSurfaces || []).forEach((cs, idx) => {
    const globalId = (cs.ifc_global_id || `ATL-CS-${idx + 1}`).replace(/'/g, "\\'");
    const name = (cs.name || cs.surface_type || "Curved Surface").replace(/'/g, "\\'");
    const params = typeof cs.parameters === 'string' ? JSON.parse(cs.parameters) : (cs.parameters || {});
    const ctrlPts = cs.control_points || params.control_points || [];

    const ptId = nextId();
    emit(`#${ptId}=IFCCARTESIANPOINT((0.,0.,0.));`);
    const placementId = nextId();
    emit(`#${placementId}=IFCLOCALPLACEMENT(#${buildingPlacementId},(#${ptId},$,$));`);

    if (ctrlPts.length >= 2 && ctrlPts[0]?.length >= 2) {
      // NURBS surface → IfcBSplineSurface
      const degU = parseInt(params.degree_u || 2, 10);
      const degV = parseInt(params.degree_v || 2, 10);
      const uUpper = ctrlPts.length - 1;
      const vUpper = ctrlPts[0].length - 1;

      // Knot vectors (uniform)
      const knotU = generateUniformKnotVector(ctrlPts.length, degU);
      const knotV = generateUniformKnotVector(ctrlPts[0].length, degV);

      // Control points as IFC array
      const ctrlPtsStr = ctrlPts.map(row =>
        `(${row.map(pt => `(${pt.x || 0}.`, `${pt.y || 0}.`, `${pt.z || 0}.`).join(',')})`
      ).join(',');

      const surfId = nextId();
      emit(`#${surfId}=IFCBSPLINESURFACEWITHKNOTS(3,1,(${degU},${degV}),(${uUpper},${vUpper}),.CARTESIAN.,.UNSPECIFIED.,.U.,.UNSPECIFIED.,(${knotU.join(',')}),(${knotV.join(',')}),0.,1.);`);

      // Product entity
      const prodId = nextId();
      emit(`#${prodId}=IFCBUILDINGELEMENTPROXY(\\'${globalId}\\',\\'${name}\\',$,$,\\'\\,#${placementId},$,\\'\\');`);
      reg(globalId, prodId);
    } else {
      // Fallback: IfcRectangularTrimmedSurface for simple curved surfaces
      const radA = parseFloat(params.radius_a || 2.0);
      const halfH = parseFloat(params.half_height || 4.0);
      const surfType = cs.surface_type || 'revolution';

      const surfId = nextId();
      const baseId = nextId(), topId = nextId();
      emit(`#${baseId}=IFCCARTESIANPOINT((0.,0.,${-halfH.toFixed(4)}));`);
      emit(`#${topId}=IFCCARTESIANPOINT((0.,0.,${halfH.toFixed(4)}));`);
      const axisId = nextId();
      emit(`#${axisId}=IFCDIRECTION((0.,0.,1.));`);

      // Surface of revolution (simplified representation)
      const surfRepId = nextId();
      emit(`#${surfRepId}=IFCSHAPEREPRESENTATION(#${placementId},'Body','MappedRepresentation',(#${surfId}),$);`);

      const prodId = nextId();
      emit(`#${prodId}=IFCBUILDINGELEMENTPROXY(\\'${globalId}\\',\\'${name}\\',$,$,\\'\\,#${placementId},$,\\'SurfaceType=${surfType},Radius=${radA.toFixed(2)}\\');`);
      reg(globalId, prodId);
    }
  });

  emit("ENDSEC;");
  emit("END-ISO-10303-21;");

  return lines.join("\n");
}

// ─── Module exports ────────────────────────────────────────────────────────────

module.exports = {
  parseIFCSTEP,
  importIFC,
  exportIFC,
  mapIfcTypeToAtlantist,
  mapAtlantistTypeToIfc,
};