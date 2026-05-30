/**
 * crafting-ui.js — shared UI module for Phase 33D Crafting UI.
 * Manages inventory, assembly graph, recipe browser, shopping summary,
 * and mobile companion state. All three surfaces (context menu, workbench,
 * mobile companion) share this module.
 *
 * Owns: in-app crafting UI state, DOM rendering, API calls.
 * Does NOT own: server-side DB access (routes/crafting.js) or
 * constraint propagation (services/crafting-engine.js).
 */

// ── State ─────────────────────────────────────────────────────────────────────

const CraftUI = {
  inventory: [],       // array of crafting_thing rows
  assembly: null,      // current assembly state
  selectedThing: null,
  recipes: [],         // recipe paths for selectedThing
  workbench: null,
  loading: false,
  error: null,
};

// ── API helpers ────────────────────────────────────────────────────────────────

function apiFetch(path, opts = {}) {
  return fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  }).then(r => {
    if (r.status === 401) window.location.href = '/login';
    return r.json();
  });
}

function apiPost(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
}

// ── Inventory ─────────────────────────────────────────────────────────────────

/** Load all Things for the current user. */
async function loadInventory(projectId) {
  const params = new URLSearchParams({ limit: 200 });
  if (projectId) params.set('project_id', projectId);
  const res = await apiFetch(`/api/crafting/things?${params}`);
  CraftUI.inventory = res.things || [];
  return CraftUI.inventory;
}

/** Create a Thing from arbitrary input (photo/URL/PDF/text). */
async function recognizeAndCreate(inputMethod, inputData, projectId) {
  const res = await apiPost('/api/crafting/recognize', {
    input_method: inputMethod,
    input_data: inputData,
    project_id: projectId,
    create_thing: true,
  });
  if (res.error) throw new Error(res.error);
  if (res.thing) {
    CraftUI.inventory.unshift(res.thing);
    return res.thing;
  }
  return null;
}

/** Sync a BIM element into the crafting inventory as a Thing. */
async function thingFromBIMElement(elementId) {
  const res = await apiPost('/api/crafting/recognize', {
    input_method: 'bim_model',
    input_data: { element_id: elementId },
    create_thing: true,
  });
  if (res.thing) {
    CraftUI.inventory.unshift(res.thing);
    return res.thing;
  }
  return null;
}

// ── Recipe paths ───────────────────────────────────────────────────────────────

/** Fetch scored recipe paths for a Thing given the active workbench. */
async function loadRecipePaths(thingId) {
  const res = await apiFetch(`/api/crafting/paths/${thingId}`);
  CraftUI.recipes = res.paths || [];
  return CraftUI.recipes;
}

/** Set the selected Thing and load its recipes. */
async function selectThing(thingId) {
  CraftUI.selectedThing = CraftUI.inventory.find(t => t.id === thingId) || null;
  if (CraftUI.selectedThing) {
    await loadRecipePaths(thingId);
  } else {
    CraftUI.recipes = [];
  }
  return { thing: CraftUI.selectedThing, paths: CraftUI.recipes };
}

// ── Assembly graph ─────────────────────────────────────────────────────────────

/** Add a Thing to the current assembly. */
function addThingToAssembly(thingId, quantity = 1) {
  if (!CraftUI.assembly) {
    CraftUI.assembly = { sub_things: [], recipe_ids: [], nodes: [], edges: [] };
  }
  const existing = CraftUI.assembly.sub_things.find(st => st.thing_id === thingId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    CraftUI.assembly.sub_things.push({ thing_id: thingId, quantity });
    const thing = CraftUI.inventory.find(t => t.id === thingId);
    if (thing) {
      CraftUI.assembly.nodes.push({
        id: `thing-${thingId}`,
        label: thing.name,
        type: 'thing',
        status: 'needs_sourcing',
        thing_id: thingId,
      });
    }
  }
  return CraftUI.assembly;
}

/** Lock a recipe path for a Thing in the assembly. */
function lockRecipePath(thingId, recipeId) {
  if (!CraftUI.assembly) return null;
  const node = CraftUI.assembly.nodes.find(n => n.thing_id === thingId);
  if (node) {
    node.recipe_id = recipeId;
    node.status = resolveRecipeStatus(recipeId);
  } else {
    const thing = CraftUI.inventory.find(t => t.id === thingId);
    CraftUI.assembly.nodes.push({
      id: `thing-${thingId}`,
      label: thing?.name || `Thing ${thingId}`,
      type: 'thing',
      status: resolveRecipeStatus(recipeId),
      thing_id: thingId,
      recipe_id: recipeId,
    });
    CraftUI.assembly.sub_things.push({ thing_id: thingId, quantity: 1 });
  }
  if (!CraftUI.assembly.recipe_ids.includes(recipeId)) {
    CraftUI.assembly.recipe_ids.push(recipeId);
  }
  return CraftUI.assembly;
}

function resolveRecipeStatus(recipeId) {
  const path = CraftUI.recipes.find(p => p.recipe_id === recipeId);
  if (!path) return 'blocked';
  if (!path.viable) return 'blocked';
  // Channels: retail=green, secondary=yellow, fabrication=blue
  const op = path.operations?.[0];
  if (!op) return 'blocked';
  if (op.type === 'buy_retail') return 'sourced';
  if (op.type === 'buy_secondary') return 'needs_sourcing';
  return 'fabricating';
}

/** Build a DAG preview and get sorted operations + shopping lists. */
async function buildAssemblyPreview() {
  if (!CraftUI.assembly?.recipe_ids?.length) return null;
  const res = await apiPost('/api/crafting/assemblies/preview', {
    recipe_ids: CraftUI.assembly.recipe_ids,
    sub_things_json: CraftUI.assembly.sub_things,
  });
  return res; // { graph, sorted: { ops }, tools, shopping_lists }
}

/** Save the current assembly. */
async function saveAssembly(name, projectId) {
  if (!CraftUI.assembly) return null;
  const preview = await buildAssemblyPreview();
  const res = await apiPost('/api/crafting/assemblies', {
    project_id: projectId,
    name: name || 'Untitled Assembly',
    sub_things_json: CraftUI.assembly.sub_things,
    recipe_graph_json: {
      nodes: CraftUI.assembly.nodes,
      edges: CraftUI.assembly.edges || [],
      recipe_ids: CraftUI.assembly.recipe_ids,
    },
    total_cost: preview?.shopping_lists?.total_cost || 0,
    total_time: preview?.sorted?.total_minutes || 0,
    shopping_lists_json: preview?.shopping_lists,
  });
  if (res.assembly) {
    CraftUI.assembly.id = res.assembly.id;
    CraftUI.assembly.name = res.assembly.name;
  }
  return res.assembly;
}

/** Load an existing assembly by ID. */
async function loadAssembly(assemblyId) {
  const res = await apiFetch(`/api/crafting/assemblies/${assemblyId}`);
  if (res.assembly) {
    const data = res.assembly;
    CraftUI.assembly = {
      id: data.id,
      name: data.name,
      sub_things: data.sub_things_json || [],
      nodes: data.recipe_graph_json?.nodes || [],
      edges: data.recipe_graph_json?.edges || [],
      recipe_ids: data.recipe_graph_json?.recipe_ids || [],
    };
  }
  return res.assembly;
}

// ── Shopping list helpers ──────────────────────────────────────────────────────

/** Format a shopping list for display / printing. */
function formatShoppingList(shoppingLists) {
  if (!shoppingLists) return '';
  const groups = [];
  for (const [store, items] of Object.entries(shoppingLists.by_store || {})) {
    const lines = items.map(it => `  • ${it.name} × ${it.quantity}  ${it.price ? `$${it.price.toFixed(2)}` : ''}`).join('\n');
    groups.push(`${store}:\n${lines}`);
  }
  return groups.join('\n\n');
}

/** Generate a printable shopping list as a text blob. */
function generateShoppingListText(shoppingLists) {
  if (!shoppingLists?.by_store) return 'No items.';
  let text = 'SHOPPING LIST\n================\n\n';
  let total = 0;
  for (const [store, items] of Object.entries(shoppingLists.by_store)) {
    text += `📍 ${store}\n`;
    for (const it of items) {
      const price = it.price || 0;
      total += price;
      text += `  • ${it.name} × ${it.quantity}  $${price.toFixed(2)}\n`;
    }
    text += '\n';
  }
  text += `Estimated total: $${total.toFixed(2)}`;
  return text;
}

// ── Workbench management ───────────────────────────────────────────────────────

/** Load the user's active workbench. */
async function loadWorkbench() {
  const res = await apiFetch('/api/crafting/workbenches/active');
  CraftUI.workbench = res.workbench || null;
  return CraftUI.workbench;
}

/** Create or update the active workbench. */
async function setWorkbench(data) {
  if (CraftUI.workbench?.id) {
    const res = await apiFetch(`/api/crafting/workbenches/${CraftUI.workbench.id}`, {
      method: 'PATCH', body: JSON.stringify(data), headers: {}
    });
    Object.assign(CraftUI.workbench, res.workbench);
  } else {
    const res = await apiPost('/api/crafting/workbenches', data);
    CraftUI.workbench = res.workbench;
  }
  return CraftUI.workbench;
}

// ── Drop zone — recognize dropped files/URLs ────────────────────────────────────

/** Process a dropped item (photo / URL / PDF) via the recognizer. */
async function processDroppedItem(file, projectId) {
  if (!file) return null;
  const name = file.name || '';

  if (name.match(/\b(jpe?g|png|gif|webp|heic|heif)\b/i)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const thing = await recognizeAndCreate('image', { base64: e.target.result }, projectId);
          resolve(thing);
        } catch (err) { reject(err); }
      };
      reader.readAsDataURL(file);
    });
  }

  if (name.match(/\bpdf\b/i)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const thing = await recognizeAndCreate('pdf', { base64: e.target.result }, projectId);
          resolve(thing);
        } catch (err) { reject(err); }
      };
      reader.readAsDataURL(file);
    });
  }

  // URL drop
  if (name.startsWith('http://') || name.startsWith('https://')) {
    const thing = await recognizeAndCreate('url', { url: name }, projectId);
    return thing;
  }

  return null;
}

// ── DOM rendering helpers ──────────────────────────────────────────────────────

/** Render the inventory list into a container element. */
function renderInventoryList(containerEl, onSelect) {
  if (!containerEl) return;
  if (CraftUI.inventory.length === 0) {
    containerEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">
      <div style="font-size:32px;margin-bottom:8px">📦</div>
      <div>No items in inventory.</div>
      <div style="font-size:11px;margin-top:4px">Drop photos, URLs, or PDFs onto the viewport to add things.</div>
    </div>`;
    return;
  }

  containerEl.innerHTML = CraftUI.inventory.map(t => {
    const conf = t.properties_json?.property_confidences;
    const lowConf = conf ? Object.entries(conf).filter(([, v]) => v < 0.7).length : 0;
    const badge = lowConf > 0 ? `<span style="background:#f59e0b;color:#000;font-size:10px;padding:1px 5px;border-radius:3px">${lowConf} ⚠</span>` : '';
    const tag = t.is_assembly ? `<span style="color:var(--accent)">⊞</span>` : '';
    return `<div class="craft-inv-item" data-id="${t.id}" style="
      padding:10px 12px;cursor:pointer;border-radius:6px;margin-bottom:4px;
      background:var(--bg-raised);border:1px solid var(--border);
      display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${tag}${t.name}${badge}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t.source_type || 'unknown'}${t.project_id ? ' · project-linked' : ''}</div>
      </div>
      <div style="font-size:16px;opacity:0.4">▶</div>
    </div>`;
  }).join('');

  containerEl.querySelectorAll('.craft-inv-item').forEach(el => {
    el?.addEventListener('click', () => {
      const id = parseInt(el.dataset.id);
      if (onSelect) onSelect(id);
    });
  });
}

/** Render recipe paths into a container element. */
function renderRecipeList(containerEl, selectedThingId, onLock) {
  if (!containerEl) return;
  if (!CraftUI.selectedThing) {
    containerEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">Select a thing to see recipes.</div>`;
    return;
  }
  if (CraftUI.recipes.length === 0) {
    containerEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">
      No recipes found for this thing.
    </div>`;
    return;
  }

  containerEl.innerHTML = `<div style="margin-bottom:12px;padding:10px 12px;background:var(--bg-raised);border-radius:6px;border:1px solid var(--border)">
    <div style="font-size:12px;font-weight:600;color:var(--text)">${CraftUI.selectedThing.name}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${CraftUI.recipes.length} recipe path${CraftUI.recipes.length !== 1 ? 's' : ''} available</div>
  </div>` +
  CraftUI.recipes.map((path, i) => {
    const statusColor = path.viable
      ? (path.scores?.cost > 0.7 ? '#22c55e' : path.scores?.skill > 0.7 ? '#60a5fa' : '#eab308')
      : '#ef4444';
    const statusLabel = path.viable ? 'viable' : 'blocked';
    const tools = path.operations?.flatMap(op => op.tools_required || []) || [];
    return `<div style="
      padding:12px;margin-bottom:8px;background:var(--bg-raised);
      border:1px solid var(--border);border-radius:8px;
      ${i === 0 ? 'border-color:var(--accent);box-shadow:0 0 0 1px rgba(168,85,247,0.3)' : ''}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:14px;font-weight:600;color:var(--text)">#${i + 1} ${path.recipe_name || 'Path ' + (i+1)}</span>
        <span style="font-size:10px;padding:2px 6px;border-radius:3px;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}55">${statusLabel}</span>
      </div>
      <div style="display:flex;gap:16px;font-size:11px;color:var(--text-muted);margin-bottom:8px">
        <span>💰 $${(path.total_cost_estimate || 0).toFixed(2)}</span>
        <span>⏱ ${path.total_time_estimate || 0} min</span>
        <span>🔧 ${tools.slice(0,3).join(', ') || 'no tools'}</span>
      </div>
      ${path.blocked_reason ? `<div style="font-size:11px;color:#ef4444;margin-bottom:6px">⚠ ${path.blocked_reason}</div>` : ''}
      ${path.operations?.length ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Steps: ${path.operations.map(o => o.type).join(' → ')}</div>` : ''}
      <button data-recipe-id="${path.recipe_id}" data-thing-id="${selectedThingId}"
        style="width:100%;padding:7px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">
        Use this path
      </button>
    </div>`;
  }).join('');

  containerEl.querySelectorAll('[data-recipe-id]').forEach(btn => {
    btn?.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.recipeId);
      const tid = parseInt(btn.dataset.thingId);
      if (onLock) onLock(tid, rid);
    });
  });
}

/** Render the assembly graph as a simple node-list into a container element. */
function renderAssemblyGraph(containerEl) {
  if (!containerEl) return;
  if (!CraftUI.assembly?.nodes?.length) {
    containerEl.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">
      <div style="font-size:40px;margin-bottom:12px">⬡</div>
      <div style="font-size:13px">Drag things from inventory to build your assembly graph.</div>
      <div style="font-size:11px;margin-top:4px">Recipes connect things; the graph shows the full supply chain.</div>
    </div>`;
    return;
  }

  const statusIcon = { sourced: '✅', needs_sourcing: '⏳', fabricating: '🔵', blocked: '❌' };
  const statusColor = { sourced: '#22c55e', needs_sourcing: '#eab308', fabricating: '#60a5fa', blocked: '#ef4444' };

  containerEl.innerHTML = `<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px">Assembly Graph — ${CraftUI.assembly.nodes.length} node(s)</div>` +
    CraftUI.assembly.nodes.map(n => `
      <div style="
        padding:10px 14px;margin-bottom:8px;border-radius:8px;
        background:var(--bg-raised);border:2px solid ${statusColor[n.status] || 'var(--border)'};
        display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">${statusIcon[n.status] || '⬡'}</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:var(--text)">${n.label}</div>
          <div style="font-size:11px;color:${statusColor[n.status] || 'var(--text-muted)'}">${n.status?.replace('_', ' ') || 'unknown'}</div>
        </div>
      </div>`).join('');
}

/** Render the shopping summary bar. */
function renderShoppingSummary(containerEl) {
  if (!containerEl) return;
  if (!CraftUI.assembly?.sub_things?.length) {
    containerEl.innerHTML = `<span style="color:var(--text-muted);font-size:12px">No assembly started.</span>`;
    return;
  }

  const count = CraftUI.assembly.sub_things.length;
  const nodeCount = CraftUI.assembly.nodes?.length || 0;
  const totalCost = CraftUI.assembly.total_cost || 0;

  containerEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;font-size:12px;color:var(--text-muted)">
      <span>${count} thing${count !== 1 ? 's' : ''} · ${nodeCount} in graph</span>
      <span style="color:var(--accent)">$${totalCost.toFixed(2)} est.</span>
      <div style="display:flex;gap:8px">
        <button id="craft-btn-shopping-list" style="padding:5px 10px;background:var(--bg-raised);border:1px solid var(--border);border-radius:5px;cursor:pointer;font-size:11px;color:var(--text)">📋 Shopping List</button>
        <button id="craft-btn-assembly-guide" style="padding:5px 10px;background:var(--bg-raised);border:1px solid var(--border);border-radius:5px;cursor:pointer;font-size:11px;color:var(--text)">📄 Assembly Guide</button>
      </div>
    </div>`;

  document.getElementById('craft-btn-shopping-list')?.addEventListener('click', async () => {
    const preview = await buildAssemblyPreview();
    if (!preview) return;
    const text = generateShoppingListText(preview.shopping_lists);
    const modal = document.getElementById('modal-craft-shopping-list') || createShoppingListModal();
    document.getElementById('craft-shopping-text').textContent = text;
    modal.classList.remove('hidden');
  });

  document.getElementById('craft-btn-assembly-guide')?.addEventListener('click', () => {
    window.print(); // browser print dialog with assembly guide content
  });
}

function createShoppingListModal() {
  const div = document.createElement('div');
  div.id = 'modal-craft-shopping-list';
  div.style = 'position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
  div.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:24px;min-width:520px;max-width:640px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="font-size:16px;font-weight:700;color:var(--text)">📋 Shopping List</h2>
        <button id="craft-shopping-close" style="padding:4px 8px;background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--text)">✕</button>
      </div>
      <pre id="craft-shopping-text" style="font-size:12px;color:var(--text);white-space:pre-wrap;line-height:1.6;background:var(--bg-raised);padding:16px;border-radius:8px;max-height:400px;overflow-y:auto"></pre>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button onclick="navigator.clipboard.writeText(document.getElementById('craft-shopping-text').textContent)"
          style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">📋 Copy to clipboard</button>
        <button onclick="window.print()" style="padding:8px 16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;color:var(--text)">🖨 Print</button>
      </div>
    </div>`;
  document.body.appendChild(div);
  document.getElementById('craft-shopping-close')?.addEventListener('click', () => div.classList.add('hidden'));
  div?.addEventListener('click', (e) => { if (e.target === div) div.classList.add('hidden'); });
  return div;
}

// ── Workbench settings panel ───────────────────────────────────────────────────

function renderWorkbenchSettings(containerEl) {
  if (!containerEl) return;
  const wb = CraftUI.workbench;
  const skillLevels = ['diy', 'tradesperson', 'fab_shop', 'engineer'];
  const selectedSkill = wb?.skill_profile || 'tradesperson';

  containerEl.innerHTML = `
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px">Workbench Settings</div>
    <div style="margin-bottom:14px">
      <label style="font-size:12px;color:var(--text);display:block;margin-bottom:4px">Skill level</label>
      <select id="craft-skill-level" style="width:100%;padding:6px 8px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px">
        ${skillLevels.map(s => `<option value="${s}" ${s === selectedSkill ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
    </div>
    <div style="margin-bottom:14px">
      <label style="font-size:12px;color:var(--text);display:block;margin-bottom:4px">Max budget: $<span id="craft-budget-label">${wb?.budget_range_json?.max_usd || 200}</span></label>
      <input id="craft-budget-slider" type="range" min="10" max="1000" step="10"
        value="${wb?.budget_range_json?.max_usd || 200}"
        style="width:100%;accent-color:var(--accent)">
    </div>
    <div style="margin-bottom:14px">
      <label style="font-size:12px;color:var(--text);display:block;margin-bottom:4px">Time (hours/week): <span id="craft-time-label">${wb?.time_constraints_json?.available_hours_per_week || 8}</span></label>
      <input id="craft-time-slider" type="range" min="1" max="40" step="1"
        value="${wb?.time_constraints_json?.available_hours_per_week || 8}"
        style="width:100%;accent-color:var(--accent)">
    </div>
    <button id="craft-wb-save" style="width:100%;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">Save Settings</button>`;

  const budgetSlider = document.getElementById('craft-budget-slider');
  const budgetLabel = document.getElementById('craft-budget-label');
  budgetSlider?.addEventListener('input', () => { budgetLabel.textContent = budgetSlider.value; });

  const timeSlider = document.getElementById('craft-time-slider');
  const timeLabel = document.getElementById('craft-time-label');
  timeSlider?.addEventListener('input', () => { timeLabel.textContent = timeSlider.value; });

  document.getElementById('craft-wb-save')?.addEventListener('click', async () => {
    const skill = document.getElementById('craft-skill-level').value;
    const budget = parseInt(budgetSlider?.value || 200);
    const hours = parseInt(timeSlider?.value || 8);
    await setWorkbench({
      skill_profile: skill,
      budget_range_json: { min_usd: 0, max_usd: budget },
      time_constraints_json: { available_hours_per_week: hours },
    });
    toast('Workbench settings saved', 'success');
  });
}

// ── Mobile companion helpers ───────────────────────────────────────────────────

const CraftMobile = {
  checklist: [],
  scannedProducts: [],

  async init(projectId) {
    const items = await loadInventory(projectId);
    this.checklist = items.map(t => ({ thing: t, checked: false, matched: false }));
    return this.checklist;
  },

  toggleCheck(id) {
    const item = this.checklist.find(i => i.thing.id === id);
    if (item) item.checked = !item.checked;
  },

  /** Compare a scanned product photo against a stored Thing spec. */
  async comparePhoto(file, thingId) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = async (e) => {
        try {
          const result = await recognizeAndCreate('image', { base64: e.target.result, compare_thing_id: thingId }, null);
          resolve(result); // may contain match_score
        } catch (err) { reject(err); }
      };
      reader.readAsDataURL(file);
    });
  },
};

// ── Toast notification ──────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const colors = { success: '#22c55e', error: '#ef4444', info: '#60a5fa', warning: '#eab308' };
  const color = colors[type] || colors.info;
  const el = document.createElement('div');
  el.style = `position:fixed;bottom:20px;right:20px;padding:10px 16px;background:${color}22;border:1px solid ${color}55;border-radius:8px;color:${color};font-size:12px;z-index:9999;animation:fadeIn 0.2s`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── CSS injection ─────────────────────────────────────────────────────────────

const _craftCSSInjected = (typeof document !== 'undefined' && document.getElementById('craft-ui-styles'));
if (!_craftCSSInjected) {
  const style = document.createElement('style');
  style.id = 'craft-ui-styles';
  style.textContent = `
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.craft-inv-item:hover { background: var(--bg-raised) !important; border-color: var(--accent) !important; }
#ctx-craft-trigger:hover { background: rgba(168,85,247,0.15); }
#ctx-craft-submenu button:hover { background: rgba(168,85,247,0.15); }
`;
  (document.head || document.body).appendChild(style);
}

// Export for use by workbench and mobile pages
if (typeof window !== 'undefined') window.CraftUI = CraftUI;
if (typeof window !== 'undefined') window.CraftMobile = CraftMobile;
if (typeof module !== 'undefined' && module.exports) module.exports = { CraftUI, CraftMobile };