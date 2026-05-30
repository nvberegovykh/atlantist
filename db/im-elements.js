/**
 * Owns: all DB queries for the IM (Information Modeling) data model.
 * Tables: im_element_types, im_type_properties, im_element_instances, im_constraints.
 * Does NOT own: DAG solver, HTTP routing, element creation.
 */
const pool = require('./index');

// ── im_element_types ──────────────────────────────────────────────────────────

async function createElementType(data) {
  const {
    project_id, parent_type_id = null, element_category, type_name,
    classification_csi = null, classification_omniclass = null,
    material_id = null, material_grade = null, material_finish = null,
    material_fire_rating = null, material_thermal_conductivity = null,
    structural_section = null, aisc_table_ref = null,
    d_mm = null, b_f_mm = null, t_f_mm = null, t_w_mm = null, weight_plf = null,
    connection_type = null, connection_plate = null, bolt_spec = null, weld_type = null,
    cost_per_unit = null, cost_unit = null, vendor = null, lead_time_days = 0,
    occupancy_classification = null, fire_separation_distance = null, assembly_rating = null,
    properties_json = {}
  } = data;
  const res = await pool.query(
    `INSERT INTO im_element_types
      (project_id, parent_type_id, element_category, type_name,
       classification_csi, classification_omniclass, material_id, material_grade, material_finish,
       material_fire_rating, material_thermal_conductivity, structural_section, aisc_table_ref,
       d_mm, b_f_mm, t_f_mm, t_w_mm, weight_plf,
       connection_type, connection_plate, bolt_spec, weld_type,
       cost_per_unit, cost_unit, vendor, lead_time_days,
       occupancy_classification, fire_separation_distance, assembly_rating, properties_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
     RETURNING *`,
    [project_id, parent_type_id, element_category, type_name,
     classification_csi, classification_omniclass, material_id, material_grade, material_finish,
     material_fire_rating, material_thermal_conductivity, structural_section, aisc_table_ref,
     d_mm, b_f_mm, t_f_mm, t_w_mm, weight_plf,
     connection_type, connection_plate, bolt_spec, weld_type,
     cost_per_unit, cost_unit, vendor, lead_time_days,
     occupancy_classification, fire_separation_distance, assembly_rating, JSON.stringify(properties_json)]
  );
  return res.rows[0];
}

async function getElementTypeById(id) {
  const res = await pool.query('SELECT * FROM im_element_types WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getElementTypesByProject(projectId, category = null) {
  let sql = 'SELECT * FROM im_element_types WHERE project_id = $1';
  const params = [projectId];
  if (category) { sql += ' AND element_category = $2'; params.push(category); }
  sql += ' ORDER BY element_category, type_name';
  const res = await pool.query(sql, params);
  return res.rows;
}

async function getTypeAncestry(typeId) {
  const rows = [];
  let current = await getElementTypeById(typeId);
  while (current) {
    rows.push(current);
    if (!current.parent_type_id) break;
    current = await getElementTypeById(current.parent_type_id);
  }
  return rows;
}

async function getChildTypes(parentTypeId) {
  const res = await pool.query(
    'SELECT * FROM im_element_types WHERE parent_type_id = $1 ORDER BY type_name',
    [parentTypeId]
  );
  return res.rows;
}

async function updateElementType(id, data) {
  const allowed = [
    'type_name', 'classification_csi', 'classification_omniclass', 'material_id',
    'material_grade', 'material_finish', 'material_fire_rating', 'material_thermal_conductivity',
    'structural_section', 'd_mm', 'b_f_mm', 't_f_mm', 't_w_mm', 'weight_plf',
    'connection_type', 'connection_plate', 'bolt_spec', 'weld_type',
    'cost_per_unit', 'cost_unit', 'vendor', 'lead_time_days',
    'occupancy_classification', 'fire_separation_distance', 'assembly_rating', 'properties_json'
  ];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(data)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = $${idx++}`);
      values.push(k === 'properties_json' ? JSON.stringify(v) : v);
    }
  }
  if (fields.length === 0) return getElementTypeById(id);
  values.push(id);
  const res = await pool.query(
    `UPDATE im_element_types SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteElementType(id) {
  await pool.query('DELETE FROM im_element_types WHERE id = $1', [id]);
}

// ── im_type_properties ───────────────────────────────────────────────────────

async function upsertTypeProperty(typeId, propertyKey, propertyValue, overrideFlag = false, formula = null) {
  const res = await pool.query(
    `INSERT INTO im_type_properties (type_id, property_key, property_value, override_flag, formula)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (type_id, property_key)
     DO UPDATE SET property_value = $3, override_flag = $4, formula = $5
     RETURNING *`,
    [typeId, propertyKey, JSON.stringify(propertyValue), overrideFlag, formula]
  );
  return res.rows[0];
}

async function getTypeProperties(typeId) {
  const res = await pool.query(
    'SELECT * FROM im_type_properties WHERE type_id = $1 ORDER BY property_key',
    [typeId]
  );
  return res.rows;
}

// Merge type + inherited properties (parent chain, child overrides take precedence)
async function getEffectiveProperties(typeId) {
  const ancestry = await getTypeAncestry(typeId);
  const merged = {};
  for (const type of ancestry) {
    const props = await getTypeProperties(type.id);
    for (const p of props) {
      if (!merged[p.property_key] || p.override_flag) {
        merged[p.property_key] = p.property_value;
      }
    }
  }
  return merged;
}

// ── im_element_instances ──────────────────────────────────────────────────────

async function createElementInstance(data) {
  const {
    element_id, type_id = null, override_values = {},
    overridden_keys = [], status = 'design',
    quantity = 1, markup_pct = 0, markup_reason = null, instance_cost = null,
    host_element_id = null, host_face_u = null
  } = data;
  const res = await pool.query(
    `INSERT INTO im_element_instances
      (element_id, type_id, override_values, overridden_keys, status,
       quantity, markup_pct, markup_reason, instance_cost, host_element_id, host_face_u)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [element_id, type_id, JSON.stringify(override_values), overridden_keys, status,
     quantity, markup_pct, markup_reason, instance_cost, host_element_id, host_face_u]
  );
  return res.rows[0];
}

async function getElementInstanceByElementId(elementId) {
  const res = await pool.query(
    'SELECT * FROM im_element_instances WHERE element_id = $1',
    [elementId]
  );
  return res.rows[0] || null;
}

async function getInstancesByTypeId(typeId) {
  const res = await pool.query(
    'SELECT * FROM im_element_instances WHERE type_id = $1',
    [typeId]
  );
  return res.rows;
}

// Get all IM instances for elements belonging to a project
async function getInstancesByProject(projectId) {
  const res = await pool.query(
    `SELECT i.* FROM im_element_instances i
     JOIN elements e ON e.id = i.element_id
     WHERE e.project_id = $1
     ORDER BY i.element_id`,
    [projectId]
  );
  return res.rows;
}

// Get all constraints for elements belonging to a project
async function getConstraintsByProject(projectId) {
  const res = await pool.query(
    `SELECT c.* FROM im_constraints c
     JOIN elements e ON e.id = c.element_id
     WHERE e.project_id = $1
     ORDER BY c.element_id, c.constraint_key`,
    [projectId]
  );
  return res.rows;
}

async function updateElementInstance(elementId, data) {
  const allowed = [
    'type_id', 'override_values', 'overridden_keys', 'status',
    'quantity', 'markup_pct', 'markup_reason', 'instance_cost', 'host_element_id', 'host_face_u'
  ];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(data)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = $${idx++}`);
      values.push(k === 'override_values' ? JSON.stringify(v) : v);
    }
  }
  if (fields.length === 0) return getElementInstanceByElementId(elementId);
  values.push(elementId);
  const res = await pool.query(
    `UPDATE im_element_instances SET ${fields.join(', ')} WHERE element_id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteElementInstance(elementId) {
  await pool.query('DELETE FROM im_element_instances WHERE element_id = $1', [elementId]);
}

// Mark a property override on an instance (break type inheritance)
async function setInstanceOverride(elementId, propertyKey, value) {
  const inst = await getElementInstanceByElementId(elementId);
  if (!inst) return null;
  const overrides = { ...inst.override_values };
  overrides[propertyKey] = value;
  const overriddenKeys = [...new Set([...inst.overridden_keys, propertyKey])];
  return updateElementInstance(elementId, { override_values: overrides, overridden_keys: overriddenKeys });
}

// Remove override, fall back to type default
async function clearInstanceOverride(elementId, propertyKey) {
  const inst = await getElementInstanceByElementId(elementId);
  if (!inst) return null;
  const overrides = { ...inst.override_values };
  delete overrides[propertyKey];
  const overriddenKeys = inst.overridden_keys.filter(k => k !== propertyKey);
  return updateElementInstance(elementId, { override_values: overrides, overridden_keys: overriddenKeys });
}

// ── im_constraints ───────────────────────────────────────────────────────────

async function createConstraint(data) {
  const { element_id, constraint_key, constraint_category = null,
          formula_expression, bound_value = null, unit = null } = data;
  const res = await pool.query(
    `INSERT INTO im_constraints (element_id, constraint_key, constraint_category, formula_expression, bound_value, unit)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (element_id, constraint_key)
     DO UPDATE SET constraint_category = $3, formula_expression = $4, bound_value = $5, unit = $6
     RETURNING *`,
    [element_id, constraint_key, constraint_category, formula_expression,
     JSON.stringify(bound_value), unit]
  );
  return res.rows[0];
}

async function getConstraintsByElementId(elementId) {
  const res = await pool.query(
    'SELECT * FROM im_constraints WHERE element_id = $1 ORDER BY constraint_key',
    [elementId]
  );
  return res.rows;
}

async function updateConstraintBoundValue(elementId, constraintKey, boundValue, unit) {
  const res = await pool.query(
    `UPDATE im_constraints SET bound_value = $1, unit = $2 WHERE element_id = $3 AND constraint_key = $4 RETURNING *`,
    [JSON.stringify(boundValue), unit, elementId, constraintKey]
  );
  return res.rows[0] || null;
}

async function deleteConstraint(elementId, constraintKey) {
  await pool.query(
    'DELETE FROM im_constraints WHERE element_id = $1 AND constraint_key = $2',
    [elementId, constraintKey]
  );
}

// Batch-create constraints for an element
async function setConstraintsForElement(elementId, constraints) {
  for (const c of constraints) {
    await createConstraint({ element_id: elementId, ...c });
  }
}

// ── Type propagate ────────────────────────────────────────────────────────────
// When a type's property changes, propagate to all non-overridden children.
// Returns count of updated child types.
async function propagateTypeChange(parentTypeId, changedKeys) {
  const children = await getChildTypes(parentTypeId);
  let updated = 0;
  for (const child of children) {
    // Only propagate if child doesn't have an override for this key
    for (const key of changedKeys) {
      const props = await getTypeProperties(child.id);
      const prop = props.find(p => p.property_key === key);
      if (!prop?.override_flag) {
        await updateElementType(child.id, { [key]: (await getElementTypeById(parentTypeId))[key] });
        updated++;
      }
    }
  }
  return updated;
}

module.exports = {
  // Types
  createElementType, getElementTypeById, getElementTypesByProject,
  getTypeAncestry, getChildTypes, updateElementType, deleteElementType,
  // Type properties
  upsertTypeProperty, getTypeProperties, getEffectiveProperties,
  // Instances
  createElementInstance, getElementInstanceByElementId, getInstancesByTypeId,
  getInstancesByProject, getConstraintsByProject,
  updateElementInstance, deleteElementInstance,
  setInstanceOverride, clearInstanceOverride,
  // Constraints
  createConstraint, getConstraintsByElementId, updateConstraintBoundValue,
  deleteConstraint, setConstraintsForElement,
  // Type propagation
  propagateTypeChange,
};