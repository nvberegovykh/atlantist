/**
 * IM Panel — Information Modeling UI
 * Property sheets (Type/Instance/Constraints/Schedule) + Type Catalog + Element Inspector
 * Reads state from window.state (selectedId, selectedType, elements, wallTypes, etc.)
 */

let imState = {
  active: false,
  activeSheet: 'type',    // 'type' | 'instance' | 'constraints' | 'schedule'
  selectedElement: null,  // current BIM element object
  inspectorCollapsed: false,
  typeTree: [],           // hierarchy for type catalog
  activeTypeId: null,
  activeTypeCat: null,    // wall | column | door | window | stair | floor | ceiling
};

// ─── Public API ──────────────────────────────────────────────────────────────

export function initIMPanel() {
  // Toggle button in toolbar — add "IM" button to toolbar group Data
  wireIMToolbarButton();
  // Ctrl+I hotkey
  document.addEventListener('keydown', handleIMHotkey);
  // Panel close button
  document.getElementById('im-panel-close')?.addEventListener('click', closeIMPanel);
  // Inspector collapse
  document.getElementById('im-inspector-collapse')?.addEventListener('click', toggleInspector);
  // Catalog search
  document.getElementById('im-cat-search')?.addEventListener('input', (e) => {
    renderTypeTree(e.target.value);
  });
  // Change Type search
  document.getElementById('im-ct-search')?.addEventListener('input', (e) => {
    renderChangeTypeGrid(e.target.value);
  });
  // Listen for element selection changes from app.js
  window.addEventListener('atl-element-selected', onElementSelected);
  window.addEventListener('atl-selection-cleared', onSelectionCleared);
}

function wireIMToolbarButton() {
  // Guard: the static #btn-im tab button (app.html line ~1129) already handles IM.
  // Skip injection if it already exists — avoids a duplicate toolbar button.
  if (document.getElementById('btn-im')) return;
  // Add IM button after Simulations button in toolbar
  const simBtn = document.getElementById('btn-simulations');
  if (!simBtn) return;
  // Create IM button
  const imBtn = document.createElement('button');
  imBtn.id = 'btn-im-panel';
  imBtn.className = 'tool-btn';
  imBtn.title = 'Information Modeling (Ctrl+I)';
  imBtn.setAttribute('aria-label', 'Open Information Modeling panel (Ctrl+I)');
  imBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span class="tb-label" style="color:#c084fc">IM</span>`;
  imBtn.style.cssText = 'background:rgba(192,132,252,0.08);border-color:rgba(192,132,252,0.4)';
  imBtn.addEventListener('click', toggleIMPanel);
  // Insert after Analysis group end
  const lastAnalysisBtn = document.getElementById('btn-yearviz');
  if (lastAnalysisBtn) {
    lastAnalysisBtn.parentElement.insertAdjacentElement('afterend', imBtn);
  } else if (simBtn) {
    simBtn.parentElement.insertAdjacentElement('afterend', imBtn);
  }
}

function handleIMHotkey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    toggleIMPanel();
  }
}

function toggleIMPanel() {
  imState.active = !imState.active;
  const panel = document.getElementById('im-panel');
  const inspector = document.getElementById('im-inspector');
  if (!panel) return;

  if (imState.active) {
    panel.style.display = 'flex';
    // Sync selection from current state
    if (window.state?.selectedId) {
      onElementSelected({ detail: { id: window.state.selectedId, type: window.state.selectedType } });
    }
    updateIMButtonActive(true);
  } else {
    panel.style.display = 'none';
    inspector.style.display = 'none';
    updateIMButtonActive(false);
  }
}

function closeIMPanel() {
  imState.active = false;
  document.getElementById('im-panel').style.display = 'none';
  document.getElementById('im-inspector').style.display = 'none';
  updateIMButtonActive(false);
}

function updateIMButtonActive(active) {
  const btn = document.getElementById('btn-im-panel');
  if (!btn) return;
  if (active) {
    btn.style.background = 'rgba(192,132,252,0.2)';
    btn.style.borderColor = 'rgba(192,132,252,0.7)';
  } else {
    btn.style.background = 'rgba(192,132,252,0.08)';
    btn.style.borderColor = 'rgba(192,132,252,0.4)';
  }
}

function toggleInspector() {
  imState.inspectorCollapsed = !imState.inspectorCollapsed;
  const inspector = document.getElementById('im-inspector');
  const btn = document.getElementById('im-inspector-collapse');
  if (!inspector) return;
  if (imState.inspectorCollapsed) {
    inspector.style.height = '36px';
    document.getElementById('im-inspector-fields').style.display = 'none';
    btn.textContent = '▥';
  } else {
    inspector.style.height = '220px';
    document.getElementById('im-inspector-fields').style.display = 'flex';
    btn.textContent = '▟';
  }
}

// ─── Element Selection ────────────────────────────────────────────────────────

function onElementSelected(event) {
  const { id, type } = event.detail || event;
  if (!id) return onSelectionCleared();
  const el = findElement(id, type);
  if (!el) return;
  imState.selectedElement = el;
  showIMPanel();
  buildTypeTree(el);
  switchSheet('type');
  renderInspector(el);
}

function onSelectionCleared() {
  imState.selectedElement = null;
  document.getElementById('im-sheet-content').innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">Select an element to view its properties</div>';
  document.getElementById('im-type-tree').innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px">Select an element to browse its type catalog</div>';
  document.getElementById('im-inspector-fields').innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px;width:100%">Select an element to inspect all fields</div>';
  document.getElementById('im-inspector-title').textContent = 'ELEMENT INSPECTOR';
  document.getElementById('im-inspector-count').textContent = '';
}

function findElement(id, type) {
  const s = window.state;
  if (!s) return null;
  if (type === 'element' || !type) return s.elements?.find(e => e.id === id);
  if (type === 'family') return s.familyInstances?.find(f => f.id === id);
  if (type === 'level') return s.levels?.find(l => l.id === id);
  if (type === 'room') return s.rooms?.find(r => r.id === id);
  if (type === 'stair') return s.stairs?.find(st => st.id === id);
  if (type === 'floor') return s.floors?.find(f => f.id === id);
  if (type === 'ceiling') return s.ceilings?.find(c => c.id === id);
  return null;
}

function showIMPanel() {
  if (!imState.active) {
    imState.active = true;
    document.getElementById('im-panel').style.display = 'flex';
    updateIMButtonActive(true);
  }
  document.getElementById('im-inspector').style.display = 'flex';
  imState.inspectorCollapsed = false;
  document.getElementById('im-inspector-collapse').textContent = '▟';
  document.getElementById('im-inspector-fields').style.display = 'flex';
}

// ─── Property Sheets ─────────────────────────────────────────────────────────

function switchSheet(sheetName) {
  imState.activeSheet = sheetName;
  // Update tab highlights
  document.querySelectorAll('.im-sheet-tab').forEach(tab => {
    tab.style.borderBottomColor = 'transparent';
    tab.style.color = 'var(--text-muted)';
  });
  const activeTab = document.getElementById(`im-tab-${sheetName}`);
  if (activeTab) {
    activeTab.style.borderBottomColor = '#c084fc';
    activeTab.style.color = '#c084fc';
  }
  // Render the sheet
  renderSheet(sheetName);
}

function renderSheet(sheet) {
  const el = imState.selectedElement;
  const container = document.getElementById('im-sheet-content');
  if (!el || !container) return;

  if (sheet === 'type') renderTypeSheet(el, container);
  else if (sheet === 'instance') renderInstanceSheet(el, container);
  else if (sheet === 'constraints') renderConstraintsSheet(el, container);
  else if (sheet === 'schedule') renderScheduleSheet(el, container);
}

function renderTypeSheet(el, container) {
  const typeName = el.type_name || el.family_name || el.name || 'Unknown Type';
  const cat = getElementCategory(el);
  const typeData = getTypeData(el);

  container.innerHTML = `
    <div class="im-field-group">
      <div class="im-field-label">Type Name</div>
      <div class="im-field-value" style="font-weight:700;color:var(--text)">${escHtml(typeName)}</div>
    </div>
    <div class="im-field-group">
      <div class="im-field-label">Category</div>
      <div class="im-field-value" style="text-transform:capitalize">${escHtml(cat)}</div>
    </div>
    ${typeData.map(f => renderTypeField(f)).join('')}
  `;
}

function renderInstanceSheet(el, container) {
  const instData = getInstanceData(el);
  const elementName = el.name || el.element_name || `Element ${el.id}`;
  container.innerHTML = `
    <div class="im-field-group">
      <div class="im-field-label">Instance Name</div>
      <div class="im-field-value" style="font-weight:700;color:var(--text)">${escHtml(elementName)}</div>
    </div>
    <div class="im-field-group">
      <div class="im-field-label">Instance ID</div>
      <div class="im-field-value" style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">#${el.id}</div>
    </div>
    ${instData.map(f => renderTypeField(f)).join('')}
  `;
}

function renderConstraintsSheet(el, container) {
  const constraints = getConstraints(el);
  if (constraints.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">No constraints defined for this element</div>';
    return;
  }
  container.innerHTML = constraints.map(c => `
    <div class="im-field-group">
      <div class="im-field-label">${escHtml(c.label)}</div>
      <div class="im-field-value">${escHtml(c.value)}</div>
      ${c.locked ? '<div class="im-constraint-lock" title="Locked by DAG constraint">🔒</div>' : ''}
    </div>
  `).join('');
}

function renderScheduleSheet(el, container) {
  const schedData = getScheduleData(el);
  if (schedData.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">No schedule data for this element</div>';
    return;
  }
  container.innerHTML = schedData.map(f => renderTypeField(f)).join('');
}

function renderTypeField(field) {
  const badgeClass = field.badge === 'R' ? 'im-badge-read' : field.badge === 'E' ? 'im-badge-edit' : 'im-badge-calc';
  const tooltipAttr = field.tooltip ? `title="${escHtml(field.tooltip)}"` : '';
  return `
    <div class="im-field-row" ${tooltipAttr}>
      <div class="im-field-label">${escHtml(field.label)}</div>
      <div class="im-field-row-right">
        <span class="im-field-value ${field.badge === 'E' ? 'im-editable' : ''}">${escHtml(field.value)}</span>
        <span class="im-badge ${badgeClass}">${field.badge}</span>
      </div>
    </div>
  `;
}

// ─── Type Catalog ────────────────────────────────────────────────────────────

function buildTypeTree(el) {
  const cat = getElementCategory(el);
  imState.activeTypeCat = cat;
  const catalog = getTypeCatalog(cat);
  imState.typeTree = catalog;
  renderTypeTree();
}

function renderTypeTree(filter = '') {
  const tree = document.getElementById('im-type-tree');
  if (!tree) return;
  const cat = imState.activeTypeCat;
  const catalog = getTypeCatalog(cat);
  const filterLower = filter.toLowerCase();

  // Build hierarchy
  const categories = {};
  for (const entry of catalog) {
    const group = entry.group || 'Other';
    if (!categories[group]) categories[group] = [];
    if (!filter || entry.name.toLowerCase().includes(filterLower) || (entry.code && entry.code.toLowerCase().includes(filterLower))) {
      categories[group].push(entry);
    }
  }

  if (Object.keys(categories).length === 0) {
    tree.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px">No matching types found</div>';
    return;
  }

  let html = '';
  for (const [group, entries] of Object.entries(categories)) {
    html += `
      <div style="margin-bottom:8px">
        <button onclick="window._im && window._im.toggleTreeSection('${escHtml(group)}')" style="display:flex;align-items:center;gap:6px;width:100%;background:none;border:none;color:var(--text-muted);font-size:10px;font-weight:700;cursor:pointer;padding:5px 10px;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer">
          <span id="im-tree-arrow-${escHtml(group)}" style="font-size:10px;transition:transform 0.15s;display:inline-block">▶</span>
          ${escHtml(group)}
          <span style="margin-left:auto;font-size:9px;opacity:0.6">${entries.length}</span>
        </button>
        <div id="im-tree-section-${escHtml(group)}" style="padding-left:14px;padding-top:2px;display:none">
          ${entries.map(e => `
            <button onclick="window._im && window._im.selectTypeInCatalog('${cat}', '${e.id}')" class="im-tree-item" data-id="${e.id}" style="display:flex;align-items:center;gap:6px;width:100%;background:none;border:none;padding:4px 8px;cursor:pointer;border-radius:4px;color:var(--text);font-size:11px;text-align:left;transition:background 0.1s" onmouseover="this.style.background='var(--bg-panel-hover)'" onmouseout="this.style.background='none'">
              <span style="font-size:9px;color:var(--text-muted);min-width:12px">•</span>
              ${escHtml(e.name)}
              ${e.default ? '<span style="margin-left:auto;font-size:9px;color:var(--accent)">✓</span>' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }
  tree.innerHTML = html;
}

function toggleTreeSection(group) {
  const section = document.getElementById(`im-tree-section-${group}`);
  const arrow = document.getElementById(`im-tree-arrow-${group}`);
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.style.transform = isOpen ? '' : 'rotate(90deg)';
}

function selectTypeInCatalog(cat, typeId) {
  // Highlight selected item
  document.querySelectorAll('.im-tree-item').forEach(item => {
    item.style.background = item.dataset.id === typeId ? 'rgba(192,132,252,0.12)' : 'none';
    item.style.color = item.dataset.id === typeId ? '#c084fc' : 'var(--text)';
  });
  imState.activeTypeId = typeId;
  // Show type preview in the property sheet
  const preview = getTypePreview(cat, typeId);
  const container = document.getElementById('im-sheet-content');
  if (container) {
    container.innerHTML = preview;
    // Update header
    const badge = document.getElementById('im-mode-badge');
    if (badge) badge.textContent = preview ? 'TYPE' : 'IM';
  }
}

// ─── Element Inspector ───────────────────────────────────────────────────────

function renderInspector(el) {
  const fields = getAllInspectorFields(el);
  const container = document.getElementById('im-inspector-fields');
  const title = document.getElementById('im-inspector-title');
  const count = document.getElementById('im-inspector-count');

  if (!container) return;

  const elName = el.name || el.type_name || `Element ${el.id}`;
  title.textContent = elName.toUpperCase();
  count.textContent = `${fields.length} fields`;

  container.innerHTML = fields.map(f => `
    <div class="im-inspector-field" data-field="${escHtml(f.key)}" data-badge="${f.badge}" tabindex="0" role="button" aria-label="${escHtml(f.label)}: ${escHtml(f.value)}${f.tooltip ? ' — ' + escHtml(f.tooltip) : ''}"
      title="${escHtml(f.tooltip || '')}" style="min-width:160px;max-width:200px;padding:8px 10px;background:var(--bg-panel-hover);border:1px solid var(--border);border-radius:6px;cursor:${f.badge === 'E' ? 'pointer' : 'default'};transition:border-color 0.15s"
      onmouseover="if(this.dataset.badge==='E') this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'"
      onclick="window._im && window._im.editInspectorField('${escHtml(f.key)}')">
      <div style="font-size:9px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;display:flex;align-items:center;gap:4px">
        ${escHtml(f.label)}
        <span style="font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600" class="${f.badge === 'R' ? 'im-badge-read' : f.badge === 'E' ? 'im-badge-edit' : 'im-badge-calc'}">${f.badge}</span>
      </div>
      <div style="font-size:12px;font-weight:600;color:var(--text)">${escHtml(f.value)}</div>
      ${f.formula ? `<div style="font-size:9px;color:var(--text-muted);margin-top:2px;font-style:italic">${escHtml(f.formula)}</div>` : ''}
    </div>
  `).join('');

  // Keyboard nav: Tab between inspector fields
  container.querySelectorAll('.im-inspector-field').forEach(field => {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (field.dataset.badge === 'E') field.click();
      } else if (e.key === 'Escape') {
        field.blur();
      }
    });
  });
}

function editInspectorField(key) {
  const el = imState.selectedElement;
  if (!el) return;
  // For now, show a simple prompt — replace with proper inline edit in future iteration
  const current = el[key] ?? '';
  const newVal = prompt(`Edit ${key}:`, current);
  if (newVal === null || newVal === current) return;
  // Dispatch update to app.js via custom event
  window.dispatchEvent(new CustomEvent('atl-im-field-edit', {
    detail: { elementId: el.id, field: key, value: newVal }
  }));
  // Re-render
  renderInspector(el);
  showToast(`${key} updated`, 'success');
}

// ─── Change Type Dialog ───────────────────────────────────────────────────────

function openChangeTypeDialog() {
  const el = imState.selectedElement;
  if (!el) return;
  const currentName = el.type_name || el.family_name || el.name || 'Unknown';
  document.getElementById('im-ct-current-type').textContent = `Currently: ${currentName}`;
  document.getElementById('im-change-type-dialog').style.display = 'flex';
  renderChangeTypeGrid('');
  document.getElementById('im-ct-search').focus();
}

function closeChangeTypeDialog() {
  document.getElementById('im-change-type-dialog').style.display = 'none';
}

function renderChangeTypeGrid(filter = '') {
  const el = imState.selectedElement;
  const cat = getElementCategory(el);
  const catalog = getTypeCatalog(cat);
  const filterLower = filter.toLowerCase();
  const filtered = catalog.filter(t =>
    t.name.toLowerCase().includes(filterLower) || (t.code && t.code.toLowerCase().includes(filterLower))
  );
  const container = document.getElementById('im-ct-grid');
  if (!container) return;

  if (filtered.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);font-size:12px;padding:16px">No types match your search</div>';
    return;
  }

  container.innerHTML = filtered.map(t => `
    <button onclick="window._im && window._im.applyTypeChange('${cat}', '${t.id}')" style="padding:10px 12px;background:var(--bg-viewport);border:1px solid var(--border);border-radius:8px;text-align:left;cursor:pointer;transition:all 0.15s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${escHtml(t.name)}</div>
      ${t.description ? `<div style="font-size:10px;color:var(--text-muted);line-height:1.4">${escHtml(t.description)}</div>` : ''}
      ${t.code ? `<div style="font-size:9px;color:var(--text-muted);margin-top:4px;font-family:var(--font-mono)">CSI ${escHtml(t.code)}</div>` : ''}
    </button>
  `).join('');
}

function applyTypeChange(cat, typeId) {
  const el = imState.selectedElement;
  if (!el) return;
  const typeData = imState.typeTree.find(t => t.id === typeId);
  if (!typeData) return;
  // Dispatch change to app.js
  window.dispatchEvent(new CustomEvent('atl-im-type-change', {
    detail: { elementId: el.id, newTypeId: typeId, newTypeName: typeData.name, category: cat }
  }));
  closeChangeTypeDialog();
  showToast(`Type changed to ${typeData.name}`, 'success');
  // Re-render
  onElementSelected({ detail: { id: el.id, type: window.state.selectedType } });
}

// ─── Data Builders ────────────────────────────────────────────────────────────

function getElementCategory(el) {
  if (el.wall_type_id || el.wall_type) return 'wall';
  if (el.column_type_id || el.type_name?.startsWith('W') || el.type_name?.startsWith('HSS')) return 'column';
  if (el.door_type_id || el.family_name?.toLowerCase().includes('door')) return 'door';
  if (el.window_type_id || el.family_name?.toLowerCase().includes('window')) return 'window';
  if (el.stair_type_id || el.type_name?.toLowerCase().includes('stair')) return 'stair';
  if (el.floor_type_id || el._type === 'floor') return 'floor';
  if (el.ceiling_type_id || el._type === 'ceiling') return 'ceiling';
  if (el._type === 'room') return 'room';
  return 'wall'; // default
}

function getTypeData(el) {
  // Type-level properties based on element category
  const cat = getElementCategory(el);
  const typeName = el.type_name || el.family_name || '';

  if (cat === 'wall') {
    return [
      { label: 'Type', value: typeName || 'Standard Wall', badge: 'R', tooltip: 'Wall type definition from catalog' },
      { label: 'Thickness', value: formatDimension(el.thickness || el.parameters?.thickness || 150), badge: 'R', tooltip: 'Total wall thickness from all layers' },
      { label: 'Base Level', value: el.base_level_name || el.level_name || '—', badge: 'R', tooltip: 'Level at which wall starts — changing this moves the wall' },
      { label: 'Top Level', value: el.top_level_name || '—', badge: 'R', tooltip: 'Level at which wall ends — changing this recalculates height' },
      { label: 'Height', value: formatDimension(el.height || el.computed_height || ''), badge: 'C', tooltip: 'Calculated from top_level - base_level elevation' },
      { label: 'Length', value: formatDimension(el.length || el.computed_length || ''), badge: 'C', tooltip: 'Calculated wall length in plan view' },
      { label: 'Function', value: el.wall_function || el.parameters?.function || 'Exterior', badge: 'E', tooltip: 'Wall function: Exterior, Interior, Retaining' },
      { label: 'Absorption', value: el.absorption || '', badge: 'E', tooltip: 'Wall surface absorption coefficient for energy analysis' },
    ];
  }
  if (cat === 'column') {
    return [
      { label: 'Section', value: typeName || 'W12x26', badge: 'R', tooltip: 'AISC W-shape section designation' },
      { label: 'Material', value: el.material || 'Steel', badge: 'R', tooltip: 'Structural material grade' },
      { label: 'Height', value: formatDimension(el.height || ''), badge: 'C', tooltip: 'Calculated from level span' },
      { label: 'Area', value: el.section_area ? `${el.section_area} cm²` : '', badge: 'C', tooltip: 'Cross-sectional area from section property' },
      { label: 'Mark', value: el.mark || '', badge: 'E', tooltip: 'Structural member mark number' },
    ];
  }
  if (cat === 'door') {
    return [
      { label: 'Family', value: typeName || el.family_name || 'Standard Door', badge: 'R', tooltip: 'Door family from type catalog' },
      { label: 'Width', value: formatDimension(el.width || el.parameters?.width || ''), badge: 'R', tooltip: 'Door opening width' },
      { label: 'Height', value: formatDimension(el.height || el.parameters?.height || ''), badge: 'R', tooltip: 'Door opening height' },
      { label: 'Fire Rating', value: el.fire_rating || 'None', badge: 'E', tooltip: 'Fire resistance rating in hours (0 = non-rated)' },
      { label: 'Material', value: el.material || 'Wood', badge: 'E', tooltip: 'Door panel material' },
    ];
  }
  if (cat === 'window') {
    return [
      { label: 'Family', value: typeName || el.family_name || 'Standard Window', badge: 'R', tooltip: 'Window family from type catalog' },
      { label: 'Width', value: formatDimension(el.width || el.parameters?.width || ''), badge: 'R', tooltip: 'Window opening width' },
      { label: 'Height', value: formatDimension(el.height || el.parameters?.height || ''), badge: 'R', tooltip: 'Window opening height' },
      { label: 'Sill Height', value: formatDimension(el.sill_height || ''), badge: 'E', tooltip: 'Height from floor to window sill' },
      { label: 'Glazing', value: el.glazing || 'Double', badge: 'E', tooltip: 'Glazing type: Single, Double, Triple' },
    ];
  }
  if (cat === 'stair') {
    return [
      { label: 'Type', value: typeName || 'Standard Stair', badge: 'R', tooltip: 'Stair type from catalog' },
      { label: 'Configuration', value: el.config || el.parameters?.config || 'Straight', badge: 'R', tooltip: 'Stair run configuration per IBC 1011.2' },
      { label: 'Tread', value: el.tread ? `${el.tread} mm` : '', badge: 'R', tooltip: 'Horizontal tread depth — IBC minimum 11" (279mm)' },
      { label: 'Riser', value: el.riser ? `${el.riser} mm` : '', badge: 'R', tooltip: 'Vertical riser height — IBC range 4"-7" (102-178mm)' },
      { label: 'Width', value: formatDimension(el.width || ''), badge: 'E', tooltip: 'Stair run width — IBC min 44" (1118mm) for egress' },
    ];
  }
  return [
    { label: 'Type', value: typeName || 'Unknown', badge: 'R', tooltip: 'Element type from catalog' },
  ];
}

function getInstanceData(el) {
  const baseLevel = el.base_level_name || el.level_name || '—';
  const topLevel = el.top_level_name || '—';
  const cat = getElementCategory(el);

  const fields = [];

  // Location — always present
  if (el.x !== undefined || el.pos_x !== undefined) {
    fields.push({ label: 'X Position', value: formatDimension(el.x ?? el.pos_x), badge: 'E', tooltip: 'X coordinate in plan view (relative to project origin)' });
    fields.push({ label: 'Z Position', value: formatDimension(el.z ?? el.pos_z ?? el.y), badge: 'E', tooltip: 'Z coordinate (Y in CAD convention) in plan view' });
  }
  if (el.base_elevation !== undefined) {
    fields.push({ label: 'Base Elevation', value: formatDimension(el.base_elevation), badge: 'E', tooltip: 'Base elevation of element relative to project datum' });
  }

  // Host wall for openings
  if (el.host_wall_id) {
    fields.push({ label: 'Host Wall', value: `#${el.host_wall_id}`, badge: 'R', tooltip: 'Wall element this opening is hosted on' });
    fields.push({ label: 'Position (u)', value: el.host_face_u != null ? el.host_face_u.toFixed(3) : '—', badge: 'E', tooltip: 'Normalized position along wall face (0 = start, 1 = end)' });
  }

  // Level binding
  if (baseLevel !== '—') {
    fields.push({ label: 'Base Level', value: baseLevel, badge: 'E', tooltip: 'Level binding — changing this moves all hosted elements' });
  }
  if (topLevel !== '—') {
    fields.push({ label: 'Top Level', value: topLevel, badge: 'E', tooltip: 'Top level binding for walls, stairs, columns' });
  }

  // Dimensions
  if (el.width) fields.push({ label: 'Width', value: formatDimension(el.width), badge: 'E', tooltip: 'Element width in plan view' });
  if (el.height) fields.push({ label: 'Height', value: formatDimension(el.height), badge: 'E', tooltip: 'Element height (from base elevation)' });
  if (el.length && cat === 'wall') fields.push({ label: 'Length', value: formatDimension(el.length), badge: 'C', tooltip: 'Calculated from wall endpoints — DOB filing requires this' });
  if (el.thickness) fields.push({ label: 'Thickness', value: formatDimension(el.thickness), badge: 'E', tooltip: 'Wall or floor thickness' });

  // Room
  if (el.room_id) {
    fields.push({ label: 'Room', value: `Room ${el.room_id}`, badge: 'R', tooltip: 'Room this element belongs to for finish schedule' });
  }

  // Phase
  if (el.phase) fields.push({ label: 'Phase', value: el.phase, badge: 'E', tooltip: 'Construction phase' });

  return fields;
}

function getConstraints(el) {
  const constraints = [];
  const cat = getElementCategory(el);

  // Level constraints
  if (el.base_level_name) {
    constraints.push({
      label: 'Base Level',
      value: el.base_level_name,
      locked: true,
    });
  }
  if (el.top_level_name) {
    constraints.push({
      label: 'Top Level',
      value: el.top_level_name,
      locked: true,
    });
  }

  // Host constraint for openings
  if (el.host_wall_id) {
    constraints.push({
      label: 'Host',
      value: `Wall #${el.host_wall_id}`,
      locked: true,
    });
  }

  // Grid constraints (columns)
  if (cat === 'column' && el.grid_x && el.grid_z) {
    constraints.push({
      label: 'Grid X',
      value: el.grid_x,
      locked: true,
    });
    constraints.push({
      label: 'Grid Z',
      value: el.grid_z,
      locked: true,
    });
  }

  // Room constraint
  if (el.room_id) {
    constraints.push({
      label: 'Room Boundary',
      value: `Room ${el.room_id}`,
      locked: true,
    });
  }

  return constraints;
}

function getScheduleData(el) {
  const cat = getElementCategory(el);
  const fields = [];

  // CSI MasterFormat for finish/material schedules
  if (el.csi_division || el.csi_section) {
    fields.push({
      label: 'CSI Division',
      value: el.csi_division || '—',
      badge: 'R',
      tooltip: 'CSI MasterFormat 2023 division number',
    });
    fields.push({
      label: 'CSI Section',
      value: el.csi_section || '—',
      badge: 'R',
      tooltip: 'CSI MasterFormat 2023 section number',
    });
  }

  // Material specs (from Drive import)
  if (el.manufacturer || el.product_name) {
    fields.push({ label: 'Manufacturer', value: el.manufacturer || '—', badge: 'R', tooltip: 'Material/manufacturer from spec sheet' });
    fields.push({ label: 'Product', value: el.product_name || '—', badge: 'R', tooltip: 'Product name from spec sheet' });
  }

  // Cost data
  if (el.unit_cost != null) {
    fields.push({
      label: 'Unit Cost',
      value: `$${Number(el.unit_cost).toFixed(2)}`,
      badge: 'C',
      formula: 'From Drive Excel import (tax-inclusive)',
      tooltip: 'Unit cost from Drive Excel import — tax-inclusive, before Smart Pricing markup',
    });
    if (el.quantity) {
      fields.push({ label: 'Quantity', value: String(el.quantity), badge: 'R', tooltip: 'Quantity from spec sheet' });
      fields.push({
        label: 'Total Cost',
        value: `$${(Number(el.unit_cost) * Number(el.quantity)).toFixed(2)}`,
        badge: 'C',
        formula: `unit × qty`,
        tooltip: 'Calculated: unit_cost × quantity — before Smart Pricing markup',
      });
    }
  }

  // Thermal properties (walls/doors/windows)
  if (cat === 'wall' && el.r_value) {
    fields.push({
      label: 'R-value',
      value: `${el.r_value} BTU·in/hr·ft²·°F`,
      badge: 'C',
      formula: 'From wall layer assembly',
      tooltip: 'Calculated thermal resistance from wall layer stack',
    });
    fields.push({
      label: 'U-factor',
      value: el.u_factor ? `${el.u_factor} BTU/hr·ft²·°F` : '—',
      badge: 'C',
      formula: '1 / R-value',
      tooltip: 'Calculated U-factor = 1/R-value',
    });
  }

  // Fire rating for doors
  if (cat === 'door' && el.fire_rating) {
    fields.push({
      label: 'Fire Rating',
      value: `${el.fire_rating}h`,
      badge: 'R',
      tooltip: 'NFPA 80 compliant fire door rating',
    });
  }

  return fields;
}

function getTypeCatalog(cat) {
  const s = window.state;
  switch (cat) {
    case 'wall':
      return (s.wallTypes || []).map(w => ({
        id: w.id,
        name: w.name || w.type_name || 'Standard Wall',
        group: w.wall_function || 'Standard',
        code: w.csi_section || '04 20 00',
        description: w.description || '',
        default: w.is_default,
      }));
    case 'column':
      return (s.columnTypes || []).map(c => ({
        id: c.id,
        name: c.type_name || c.name || 'W12x26',
        group: c.type_name?.startsWith('W') ? 'Wide Flange (W)' : c.type_name?.startsWith('HSS') ? 'HSS' : 'Other',
        description: c.description || '',
        default: c.is_default,
      }));
    case 'door':
      return (s.doorTypes || []).map(d => ({
        id: d.id,
        name: d.name || d.type_name || 'Standard Door',
        group: d.fire_rating ? `${d.fire_rating}h Fire Rated` : 'Standard',
        description: `W:${d.width} H:${d.height}`,
        default: d.is_default,
      }));
    case 'window':
      return (s.windowTypes || []).map(w => ({
        id: w.id,
        name: w.name || w.type_name || 'Standard Window',
        group: w.glazing || 'Double Glazing',
        description: `W:${w.width} H:${w.height}`,
        default: w.is_default,
      }));
    case 'stair':
      return (s.stairTypes || []).map(s => ({
        id: s.id,
        name: s.name || 'Standard Stair',
        group: s.config || 'Straight',
        description: `T:${s.tread}mm R:${s.riser}mm`,
        default: s.is_default,
      }));
    case 'floor':
      return (s.floorTypes || []).map(f => ({
        id: f.id,
        name: f.name || 'Standard Floor',
        group: 'Structural',
        description: f.thickness ? `t=${f.thickness}mm` : '',
        default: f.is_default,
      }));
    case 'ceiling':
      return (s.ceilingTypes || []).map(c => ({
        id: c.id,
        name: c.name || 'Standard Ceiling',
        group: c.ceiling_type || 'Flat',
        description: '',
        default: c.is_default,
      }));
    default:
      return [];
  }
}

function getTypePreview(cat, typeId) {
  const catalog = getTypeCatalog(cat);
  const type = catalog.find(t => t.id === typeId);
  if (!type) return '<div style="padding:16px;text-align:center;color:var(--text-muted)">Type not found</div>';
  return `
    <div style="padding:16px">
      <div style="font-size:14px;font-weight:700;color:#c084fc;margin-bottom:8px">${escHtml(type.name)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${type.group}</div>
      ${type.description ? `<div style="font-size:12px;color:var(--text);margin-bottom:8px">${escHtml(type.description)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:12px">
        <button onclick="window._im && window._im.applyTypeChange('${cat}', '${typeId}')" style="flex:1;padding:8px;background:rgba(192,132,252,0.15);border:1px solid rgba(192,132,252,0.4);border-radius:6px;color:#c084fc;font-size:12px;font-weight:600;cursor:pointer">Apply Type</button>
        <button onclick="window._im && window._im.closeChangeTypeDialog()" style="padding:8px 12px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:12px;cursor:pointer">Cancel</button>
      </div>
    </div>
  `;
}

function getAllInspectorFields(el) {
  // Flatten all field types into the inspector
  const typeFields = getTypeData(el);
  const instFields = getInstanceData(el);
  const schedFields = getScheduleData(el);

  // Add discipline color badge
  const cat = getElementCategory(el);
  const disciplineColor = { wall: 'structural', column: 'structural', door: 'architectural', window: 'architectural', stair: 'structural', floor: 'architectural', ceiling: 'architectural', room: 'architectural' }[cat] || 'architectural';

  return [
    // Discipline header field
    {
      key: '_discipline',
      label: disciplineColor === 'structural' ? '🔵 Structural' : '⚪ Architectural',
      value: disciplineColor === 'structural' ? 'Structural' : 'Architectural',
      badge: 'R',
      tooltip: 'Discipline category for color coding in the IM panel',
    },
    ...typeFields.map(f => ({ ...f, key: `type_${f.label}` })),
    ...instFields.map(f => ({ ...f, key: `inst_${f.label}` })),
    ...schedFields.map(f => ({ ...f, key: `sched_${f.label}` })),
  ];
}

function formatDimension(val) {
  if (val == null || val === '') return '—';
  const num = Number(val);
  if (isNaN(num)) return String(val);
  // Use M-derived display
  const m = window.getModuleM?.() || 100;
  if (num >= 1000) return `${(num / 1000).toFixed(2)} m`;
  return `${num.toFixed(0)} mm`;
}

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info') {
  if (window.toast) window.toast(msg, type);
}

// ─── Global registration ──────────────────────────────────────────────────────
window._im = {
  init: initIMPanel,
  toggleIMPanel,
  closeIMPanel,
  switchSheet,
  selectTypeInCatalog,
  toggleTreeSection,
  openChangeTypeDialog,
  closeChangeTypeDialog,
  applyTypeChange,
  renderChangeTypeGrid,
  editInspectorField,
};

// Wire up events from app.js selections
window.addEventListener('atl-element-selected', (e) => onElementSelected(e));
window.addEventListener('atl-selection-cleared', () => onSelectionCleared());

// Expose for other modules
export { toggleIMPanel, closeIMPanel, switchSheet, openChangeTypeDialog };