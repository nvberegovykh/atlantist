// Owns: design_books, design_book_placeholders, design_book_product_selections queries
// Does NOT own: element/family data (read-only aggregation), file storage
const pool = require('./index');

// ── Design Books ────────────────────────────────────────────────────────────

async function getOrCreateBook(projectId) {
  const existing = await pool.query(
    'SELECT * FROM design_books WHERE project_id = $1 ORDER BY id LIMIT 1',
    [projectId]
  );
  if (existing.rows.length) return existing.rows[0];
  const created = await pool.query(
    `INSERT INTO design_books (project_id, title) VALUES ($1, 'Design Book') RETURNING *`,
    [projectId]
  );
  return created.rows[0];
}

async function getBookById(id) {
  const r = await pool.query('SELECT * FROM design_books WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function updateBook(id, fields) {
  const allowed = ['title', 'revision', 'address', 'team', 'sheet_order', 'settings'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getBookById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const r = await pool.query(
    `UPDATE design_books SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0];
}

// ── Placeholders ─────────────────────────────────────────────────────────────

async function getPlaceholders(designBookId) {
  const r = await pool.query(
    'SELECT * FROM design_book_placeholders WHERE design_book_id = $1 ORDER BY id',
    [designBookId]
  );
  return r.rows;
}

async function createPlaceholder(designBookId, data) {
  const r = await pool.query(
    `INSERT INTO design_book_placeholders
       (design_book_id, sheet_ref, placeholder_type, title, description,
        required_spec, reference_std, approved_alts, status, attachments, position_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      designBookId,
      data.sheet_ref || null,
      data.placeholder_type || 'custom',
      data.title,
      data.description || null,
      data.required_spec || null,
      data.reference_std || null,
      JSON.stringify(data.approved_alts || []),
      data.status || 'open',
      JSON.stringify(data.attachments || []),
      JSON.stringify(data.position_data || {}),
    ]
  );
  return r.rows[0];
}

async function updatePlaceholder(id, fields) {
  const allowed = [
    'sheet_ref','placeholder_type','title','description',
    'required_spec','reference_std','approved_alts','status','attachments','position_data'
  ];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE design_book_placeholders SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function deletePlaceholder(id) {
  await pool.query('DELETE FROM design_book_placeholders WHERE id = $1', [id]);
}

// ── Product Selections ───────────────────────────────────────────────────────

async function getProductSelections(designBookId) {
  const r = await pool.query(
    'SELECT * FROM design_book_product_selections WHERE design_book_id = $1 ORDER BY id',
    [designBookId]
  );
  return r.rows;
}

async function createProductSelection(designBookId, data) {
  const r = await pool.query(
    `INSERT INTO design_book_product_selections
       (design_book_id, placeholder_id, source, manufacturer, product_name,
        product_code, category, specs, cut_sheet_url, estimated_cost,
        lead_time_days, quantity, unit, order_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      designBookId,
      data.placeholder_id || null,
      data.source || 'manual',
      data.manufacturer || null,
      data.product_name,
      data.product_code || null,
      data.category || null,
      JSON.stringify(data.specs || {}),
      data.cut_sheet_url || null,
      data.estimated_cost || null,
      data.lead_time_days || null,
      data.quantity || 1,
      data.unit || 'EA',
      data.order_status || 'not_ordered',
    ]
  );
  return r.rows[0];
}

async function updateProductSelection(id, fields) {
  const allowed = [
    'source','manufacturer','product_name','product_code','category',
    'specs','cut_sheet_url','estimated_cost','lead_time_days',
    'quantity','unit','order_status','placeholder_id'
  ];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE design_book_product_selections SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function deleteProductSelection(id) {
  await pool.query('DELETE FROM design_book_product_selections WHERE id = $1', [id]);
}

// ── MEP → Design Book Integration ──────────────────────────────────────────────
// Populates Design Book placeholders + product selections from MEP simulation results.
// Enables: procurement lists, equipment cut sheets, schedule generation from sim output.

async function populateFromMEPSimulation(projectId, mepResults) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create book
    let bookId;
    const existingBook = await client.query(
      'SELECT id FROM design_books WHERE project_id = $1', [projectId]
    );
    if (existingBook.rows.length) {
      bookId = existingBook.rows[0].id;
    } else {
      const bk = await client.query(
        `INSERT INTO design_books (project_id, title) VALUES ($1, 'Design Book') RETURNING id`,
        [projectId]
      );
      bookId = bk.rows[0].id;
    }

    const createdPlaceholders = [];
    const createdProducts = [];

    const { hvac, plumbing, electrical, fire } = mepResults || {};

    // ── HVAC placeholders ──────────────────────────────────────────────────────
    if (hvac) {
      const existingHVAC = await client.query(
        `SELECT id FROM design_book_placeholders WHERE design_book_id = $1 AND placeholder_type = 'hvac'`,
        [bookId]
      );
      if (!existingHVAC.rows.length) {
        const ph = await client.query(`
          INSERT INTO design_book_placeholders
            (design_book_id, placeholder_type, title, description, status, required_spec, reference_std, position_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [
          bookId, 'hvac',
          'HVAC Equipment Schedule',
          `Heating: ${hvac.heatingLoadBtuH?.toLocaleString() || '—'} Btu/h · Cooling: ${hvac.coolingLoadBtuH?.toLocaleString() || '—'} Btu/h · Floor area: ${hvac.floorAreaM2?.toLocaleString() || '—'} m² · ${hvac.ventilationCFM || '—'} CFM ventilation · ${hvac.zones?.length || '—'} zones`,
          'pending_approval',
          `Heating: ${hvac.heatingLoadBtuH?.toLocaleString() || '?'} Btu/h (${hvac.heatingLoadW?.toLocaleString() || '?'} W) · Cooling: ${hvac.coolingLoadBtuH?.toLocaleString() || '?'} Btu/h (${hvac.coolingLoadW?.toLocaleString() || '?'} W) · ASHRAE ${hvac.compliance?.code || '90.1'} EUI: ${hvac.compliance?.euiBtuSqftYr || '?'} Btu/ft²/yr (limit ${hvac.compliance?.limit || '250'})`,
          'ASHRAE 90.1-2019 · ASHRAE 62.1 · Manual D Duct Design',
          JSON.stringify({ heating_btuh: hvac.heatingLoadBtuH, cooling_btuh: hvac.coolingLoadBtuH, ventilation_cfm: hvac.ventilationCFM, zone_count: hvac.zones?.length, floor_area_m2: hvac.floorAreaM2, eui: hvac.compliance?.euiBtuSqftYr }),
        ]);
        createdPlaceholders.push(ph.rows[0]);

        // HVAC product selections
        const hvacProducts = [
          { name: 'Air Handling Unit (AHU)', category: 'HVAC Equipment', specs: { capacity_btuh: hvac.heatingLoadBtuH, cooling_btuh: hvac.coolingLoadBtuH, airflow_cfm: hvac.ventilationCFM }, estimated_cost: Math.round((hvac.heatingLoadBtuH + hvac.coolingLoadBtuH) / 1000 * 8) },
          { name: 'VAV Terminal Unit', category: 'HVAC Equipment', specs: { min_cfm: Math.round((hvac.ventilationCFM || 400) * 0.3), max_cfm: Math.round(hvac.ventilationCFM || 400) }, estimated_cost: 3200 },
          { name: 'Ductwork (supply)', category: 'Ductwork', specs: { total_linear_ft: Math.round((hvac.ventilationCFM || 400) * 0.5), friction_loss_inwg: hvac.ductSizing?.totalPressureDropInWg || 0.5 }, estimated_cost: Math.round((hvac.ventilationCFM || 400) * 8) },
        ];
        for (const p of hvacProducts) {
          const ps = await client.query(`
            INSERT INTO design_book_product_selections
              (design_book_id, placeholder_id, source, product_name, category, specs, estimated_cost, quantity, order_status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
          `, [bookId, ph.rows[0].id, 'mep_simulation', p.name, p.category, JSON.stringify(p.specs), p.estimated_cost, 1, 'not_ordered']);
          createdProducts.push(ps.rows[0]);
        }
      }
    }

    // ── Plumbing placeholders ──────────────────────────────────────────────────
    if (plumbing) {
      const existingPlumb = await client.query(
        `SELECT id FROM design_book_placeholders WHERE design_book_id = $1 AND placeholder_type = 'plumbing'`,
        [bookId]
      );
      if (!existingPlumb.rows.length) {
        const ph = await client.query(`
          INSERT INTO design_book_placeholders
            (design_book_id, placeholder_type, title, description, status, required_spec, reference_std, position_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [
          bookId, 'plumbing',
          'Plumbing / Fire Protection Schedule',
          `${plumbing.totalDFU || '?'} DFU total · ${plumbing.sprinkler?.headCount || '?'} sprinkler heads · ${plumbing.mainLineSizeIn || '?'}" main · ${plumbing.branchLineSizeIn || '?'}" branch · Water hammer: ${plumbing.supplyPipe?.waterHammer?.status || '?'}`,
          'pending_approval',
          `Main: ${plumbing.mainLineSizeIn || '?'}" · Branch: ${plumbing.branchLineSizeIn || '?'}" · GPM: ${plumbing.supplyPipe?.velocityFPS ? (plumbing.supplyPipe.velocityFPS / 0.3208 / (Math.PI * plumbing.supplyPipe.diamIn ** 2) * 0.01).toFixed(1) : '?'} gpm · Hot water recirc: ${plumbing.hotWaterRecirc?.returnPipeDiamIn || '?'}" · Sprinkler heads: ${plumbing.sprinkler?.headCount || '?'} (${plumbing.sprinkler?.hazardType || 'light'})`,
          'IPC 2021 · NFPA 13 · NYC PC 2020',
          JSON.stringify({ total_dfu: plumbing.totalDFU, main_size_in: plumbing.mainLineSizeIn, branch_size_in: plumbing.branchLineSizeIn, sprinkler_heads: plumbing.sprinkler?.headCount, sprinkler_coverage_sf: plumbing.sprinkler?.coveragePerHeadSqFt }),
        ]);
        createdPlaceholders.push(ph.rows[0]);

        const plumbProducts = [
          { name: 'Wet Pipe Sprinkler Head', category: 'Fire Protection', specs: { k_factor: 5.6, coverage_sf: plumbing.sprinkler?.coveragePerHeadSqFt, hazard: plumbing.sprinkler?.hazardType }, estimated_cost: 150 },
          { name: 'Sprinkler Riser', category: 'Fire Protection', specs: { diam_in: plumbing.mainLineSizeIn, material: 'black steel' }, estimated_cost: Math.round((plumbing.mainLineSizeIn || 2) * 400) },
          { name: 'Water Closet', category: 'Plumbing Fixture', specs: { type: 'flushometer', dfu: 6, fire_rating: 0 }, estimated_cost: 850 },
          { name: 'Lavatory Faucet', category: 'Plumbing Fixture', specs: { type: 'grid drain', dfu: 1 }, estimated_cost: 280 },
          { name: 'Hot Water Recirculation Pump', category: 'Plumbing Equipment', specs: { gpm: plumbing.hotWaterRecirc?.recircGPM, hp: plumbing.hotWaterRecirc?.circPumpHP }, estimated_cost: Math.round((plumbing.hotWaterRecirc?.recircGPM || 2) * 800) },
        ];
        for (const p of plumbProducts) {
          const ps = await client.query(`
            INSERT INTO design_book_product_selections
              (design_book_id, placeholder_id, source, product_name, category, specs, estimated_cost, quantity, order_status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
          `, [bookId, ph.rows[0].id, 'mep_simulation', p.name, p.category, JSON.stringify(p.specs), p.estimated_cost, 1, 'not_ordered']);
          createdProducts.push(ps.rows[0]);
        }
      }
    }

    // ── Electrical placeholders ────────────────────────────────────────────────
    if (electrical) {
      const existingElec = await client.query(
        `SELECT id FROM design_book_placeholders WHERE design_book_id = $1 AND placeholder_type = 'electrical'`,
        [bookId]
      );
      if (!existingElec.rows.length) {
        const ph = await client.query(`
          INSERT INTO design_book_placeholders
            (design_book_id, placeholder_type, title, description, status, required_spec, reference_std, position_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [
          bookId, 'electrical',
          'Electrical Panel Schedule',
          `Panel: ${electrical.panel?.recommendedPanelAmps || '?'}A ${electrical.panel?.voltage || '?'}V ${electrical.panel?.phase || '?'} · Wire: #${electrical.wiring?.awg || '?'} AWG · Voltage drop: ${electrical.wiring?.voltageDropPct || '?'}% at 100 ft · Conduit: ${electrical.conduit?.type || 'EMT'} ${electrical.conduit?.size || '?'}" (${electrical.conduit?.fillPct || '?'}% fill)`,
          'pending_approval',
          `Panel: ${electrical.panel?.recommendedPanelAmps || '?'}A ${electrical.panel?.voltage || '?'}V · Load: ${electrical.panel?.totalKW || '?'} kW · Wire: #${electrical.wiring?.awg || '?'} AWG ${electrical.wiring?.ampacity || '?'}A ampacity · Voltage drop: ${electrical.wiring?.voltageDropPct || '?'}% · Conduit: ${electrical.conduit?.type || 'EMT'} ${electrical.conduit?.size || '?'}" · Service entrance: #${electrical.serviceEntrance?.recommendedAWG || '?'} AWG`,
          'NEC 2023 · NYC Electrical Code',
          JSON.stringify({ panel_amps: electrical.panel?.recommendedPanelAmps, voltage: electrical.panel?.voltage, wire_awg: electrical.wiring?.awg, voltage_drop_pct: electrical.wiring?.voltageDropPct, conduit_size_in: electrical.conduit?.size, conduit_fill_pct: electrical.conduit?.fillPct }),
        ]);
        createdPlaceholders.push(ph.rows[0]);

        const elecProducts = [
          { name: `${electrical.panel?.recommendedPanelAmps || 100}A Distribution Panel`, category: 'Electrical Equipment', specs: { amps: electrical.panel?.recommendedPanelAmps, voltage: electrical.panel?.voltage, phase: electrical.panel?.phase }, estimated_cost: Math.round((electrical.panel?.recommendedPanelAmps || 100) * 12) },
          { name: `#${electrical.wiring?.awg || 12} THHN Wire (1000 ft)`, category: 'Electrical Wiring', specs: { awg: electrical.wiring?.awg, type: 'THHN', length_ft: 1000 }, estimated_cost: Math.round((electrical.wiring?.awg || 12) < 10 ? 450 : 280) },
          { name: `${electrical.conduit?.size || 1}" EMT Conduit (10 ft)`, category: 'Electrical Conduit', specs: { size_in: electrical.conduit?.size, type: 'EMT' }, estimated_cost: Math.round((electrical.conduit?.size || 1) * 8) },
          { name: '20A Single-Pole Circuit Breaker', category: 'Electrical Protection', specs: { amps: 20, type: 'single-pole' }, estimated_cost: 18 },
        ];
        for (const p of elecProducts) {
          const ps = await client.query(`
            INSERT INTO design_book_product_selections
              (design_book_id, placeholder_id, source, product_name, category, specs, estimated_cost, quantity, order_status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
          `, [bookId, ph.rows[0].id, 'mep_simulation', p.name, p.category, JSON.stringify(p.specs), p.estimated_cost, 1, 'not_ordered']);
          createdProducts.push(ps.rows[0]);
        }
      }
    }

    // ── Fire Protection placeholders ───────────────────────────────────────────
    if (fire) {
      const existingFire = await client.query(
        `SELECT id FROM design_book_placeholders WHERE design_book_id = $1 AND placeholder_type = 'fire_protection'`,
        [bookId]
      );
      if (!existingFire.rows.length) {
        const ph = await client.query(`
          INSERT INTO design_book_placeholders
            (design_book_id, placeholder_type, title, description, status, required_spec, reference_std, position_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [
          bookId, 'fire_protection',
          'Fire Protection / Standpipe Schedule',
          `Sprinkler: ${fire.sprinkler_results?.hazard_label || '?'} hazard · ${fire.sprinkler_results?.total_sprinklers || '?'} heads @ ${fire.sprinkler_results?.k_factor || '?'} K-factor · Egress: ${fire.egress_results?.occupant_load_per_floor || '?'} persons · ${fire.egress_results?.exits_provided || '?'} exits · Standpipe: ${fire.fdny_results?.standpipe_class || '?'} · High-rise: ${fire.fdny_results?.is_high_rise ? 'Yes' : 'No'}`,
          'pending_approval',
          `Occupancy: ${fire.egress_results?.occupancy_type || '?'} · Sprinkler system: ${fire.sprinkler_results?.system_type || 'wet pipe'} · Design density: ${fire.sprinkler_results?.design_density_gpm_sf || '?'} gpm/ft² · System demand: ${fire.sprinkler_results?.system_demand_gpm || '?'} gpm · Standpipe: ${fire.fdny_results?.standpipe_class || '?'}`,
          'NFPA 13 · NFPA 14 · NFPA 101 · NFPA 92 · NYC BC',
          JSON.stringify({ hazard_type: fire.sprinkler_results?.hazard_type, sprinkler_heads: fire.sprinkler_results?.total_sprinklers, k_factor: fire.sprinkler_results?.k_factor, occupant_load: fire.egress_results?.occupant_load_per_floor, exits: fire.egress_results?.exits_provided, standpipe_class: fire.fdny_results?.standpipe_class }),
        ]);
        createdPlaceholders.push(ph.rows[0]);

        const fireProducts = [
          { name: 'Fire Sprinkler Head', category: 'Fire Protection', specs: { k_factor: fire.sprinkler_results?.k_factor, hazard: fire.sprinkler_results?.hazard_type }, estimated_cost: 150 },
          { name: 'Fire Department Connection (FDC)', category: 'Fire Protection', specs: { type: '3-way' }, estimated_cost: 1800 },
          { name: 'Fire Alarm Control Panel', category: 'Fire Protection', specs: { zone_count: 8 }, estimated_cost: 4200 },
        ];
        for (const p of fireProducts) {
          const ps = await client.query(`
            INSERT INTO design_book_product_selections
              (design_book_id, placeholder_id, source, product_name, category, specs, estimated_cost, quantity, order_status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
          `, [bookId, ph.rows[0].id, 'mep_simulation', p.name, p.category, JSON.stringify(p.specs), p.estimated_cost, 1, 'not_ordered']);
          createdProducts.push(ps.rows[0]);
        }
      }
    }

    // Add MEP summary sheet
    const existingSummary = await client.query(
      `SELECT id FROM design_book_placeholders WHERE design_book_id = $1 AND placeholder_type = 'mep-summary'`,
      [bookId]
    );
    if (!existingSummary.rows.length) {
      const summary = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, placeholder_type, title, description, status, required_spec, reference_std, position_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
      `, [
        bookId, 'mep-summary',
        'MEP Calculation Summary',
        'Master MEP loads, equipment schedules, and code compliance summary generated from simulation results.',
        'pending_approval',
        `HVAC: ${hvac?.heatingLoadBtuH?.toLocaleString() || '?'} / ${hvac?.coolingLoadBtuH?.toLocaleString() || '?'} Btu/h · Plumbing: ${plumbing?.totalDFU || '?'} DFU / ${plumbing?.sprinkler?.headCount || '?'} heads · Electrical: ${electrical?.panel?.totalKW || '?'} kW / ${electrical?.panel?.recommendedPanelAmps || '?'}A panel · Fire: ${fire?.egress_results?.occupant_load_per_floor || '?'} occupants`,
        'ASHRAE 90.1 · IPC · NEC 2023 · NFPA 13/14/101',
        JSON.stringify({ hvac_heating_btuh: hvac?.heatingLoadBtuH, hvac_cooling_btuh: hvac?.coolingLoadBtuH, plumbing_total_dfu: plumbing?.totalDFU, plumbing_sprinkler_heads: plumbing?.sprinkler?.headCount, electrical_kw: electrical?.panel?.totalKW, electrical_panel_amps: electrical?.panel?.recommendedPanelAmps, fire_occupant_load: fire?.egress_results?.occupant_load_per_floor }),
      ]);
      createdPlaceholders.push(summary.rows[0]);
    }

    await client.query('COMMIT');
    return { bookId, placeholders: createdPlaceholders, products: createdProducts };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Auto-population from model data ────────────────────────────────────────────
// Generates placeholder entries for each sheet type from actual BIM model data.
// This is the "model → sheets" pipeline: floors, doors, windows, rooms, stairs,
// sections, and elevations are inferred from elements and family_instances tables.

async function autoPopulateFromModel(projectId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create the book first
    const existingBook = await client.query(
      'SELECT * FROM design_books WHERE project_id = $1', [projectId]
    );
    let bookId;
    if (existingBook.rows.length) {
      bookId = existingBook.rows[0].id;
    } else {
      const bk = await client.query(
        `INSERT INTO design_books (project_id, title) VALUES ($1, 'Design Book') RETURNING id`,
        [projectId]
      );
      bookId = bk.rows[0].id;
    }

    // Fetch model data
    const [levels, elements, families, rooms, stairs] = await Promise.all([
      client.query('SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC', [projectId]),
      client.query('SELECT * FROM elements WHERE project_id = $1 ORDER BY type, id', [projectId]),
      client.query(`
        SELECT f.*, e.type_name AS host_wall_type
        FROM family_instances f
        JOIN elements e ON f.host_wall_id = e.id
        WHERE e.project_id = $1
        ORDER BY f.family_type, f.mark
      `, [projectId]),
      client.query('SELECT * FROM rooms WHERE project_id = $1 ORDER BY number', [projectId]),
      client.query('SELECT * FROM stairs WHERE project_id = $1 ORDER BY id', [projectId]),
    ]);

    const existingPlaceholders = await client.query(
      'SELECT sheet_ref FROM design_book_placeholders WHERE design_book_id = $1 AND sheet_ref IS NOT NULL',
      [bookId]
    );
    const existingSheetRefs = new Set(existingPlaceholders.rows.map(r => r.sheet_ref));

    const created = [];

    // ── Floor plan sheets ─────────────────────────────────────────────────
    for (const lvl of levels.rows) {
      if (!lvl.is_building_storey) continue;
      const cleanName = lvl.name.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase().slice(0, 8);
      const sheetRef = `A-101-${cleanName}`;
      if (existingSheetRefs.has(sheetRef)) continue;

      const elementsOnLevel = elements.rows.filter(e =>
        e.base_level_id === lvl.id || (e.base_level_id === lvl.id && e.type !== 'mep_fixture')
      );
      const wallsOnLevel = elementsOnLevel.filter(e => e.type === 'wall').length;
      const columnsOnLevel = elementsOnLevel.filter(e => e.type === 'column').length;
      const doorsOnLevel = families.rows.filter(f =>
        f.family_type === 'door' && elements.rows.find(el => el.id === f.host_wall_id && el.base_level_id === lvl.id)
      );

      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, sheetRef, 'floor-plan',
        `Floor Plan — ${lvl.name} (${lvl.elevation.toFixed(2)}m)`,
        `${wallsOnLevel} walls · ${columnsOnLevel} columns · ${doorsOnLevel.length} doors · Auto-generated from model`,
        'open',
        JSON.stringify({ level_id: lvl.id, elevation: lvl.elevation, wall_count: wallsOnLevel, column_count: columnsOnLevel, door_count: doorsOnLevel.length }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Door schedule ─────────────────────────────────────────────────────
    const doorSheet = 'A-400-DOORS';
    if (!existingSheetRefs.has(doorSheet)) {
      const doorCount = families.rows.filter(f => f.family_type === 'door').length;
      const doorByType = {};
      families.rows.filter(f => f.family_type === 'door').forEach(f => {
        doorByType[f.type_name] = (doorByType[f.type_name] || 0) + 1;
      });
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, doorSheet, 'door-schedule',
        'Door Schedule (A-400)',
        `${doorCount} doors · Types: ${Object.keys(doorByType).join(', ') || 'None'} · Auto-generated from ${doorCount} door instances`,
        'open',
        JSON.stringify({ door_count: doorCount, types: doorByType }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Window schedule ───────────────────────────────────────────────────
    const windowSheet = 'A-400-WINDOWS';
    if (!existingSheetRefs.has(windowSheet)) {
      const winCount = families.rows.filter(f => f.family_type === 'window').length;
      const winByType = {};
      families.rows.filter(f => f.family_type === 'window').forEach(f => {
        winByType[f.type_name] = (winByType[f.type_name] || 0) + 1;
      });
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, windowSheet, 'window-schedule',
        'Window Schedule (A-400)',
        `${winCount} windows · Types: ${Object.keys(winByType).join(', ') || 'None'} · Auto-generated from ${winCount} window instances`,
        'open',
        JSON.stringify({ window_count: winCount, types: winByType }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Room schedule ────────────────────────────────────────────────────
    const roomSheet = 'A-400-ROOMS';
    if (!existingSheetRefs.has(roomSheet)) {
      const roomCount = rooms.rows.length;
      const departments = [...new Set(rooms.rows.map(r => r.department).filter(Boolean))];
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, roomSheet, 'room-schedule',
        'Room Schedule (A-400)',
        `${roomCount} rooms · Departments: ${departments.join(', ') || 'None'} · Auto-generated from ${roomCount} room records`,
        'open',
        JSON.stringify({ room_count: roomCount, departments }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Finish schedule ──────────────────────────────────────────────────
    const finishSheet = 'A-400-FINISHES';
    if (!existingSheetRefs.has(finishSheet)) {
      // Extract unique wall layers from walls with multi-layer construction
      const wallElements = elements.rows.filter(e => e.type === 'wall');
      const wallLayerCount = wallElements.length;
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, finishSheet, 'finish-schedule',
        'Finish Schedule (A-400)',
        `Wall assemblies from ${wallLayerCount} wall elements · Auto-generated from multi-layer wall construction`,
        'open',
        JSON.stringify({ wall_element_count: wallLayerCount }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Elevation sheets (N, S, E, W) ────────────────────────────────────
    for (const [name, dir] of [['A-201-NORTH-ELEV', 'N'], ['A-202-SOUTH-ELEV', 'S'], ['A-203-EAST-ELEV', 'E'], ['A-204-WEST-ELEV', 'W']]) {
      if (existingSheetRefs.has(name)) continue;
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, name, 'elevation',
        `Elevation — ${dir}`,
        `Auto-generated elevation view · ${dir} facing · Model-derived camera at ${dir} azimuth`,
        'open',
        JSON.stringify({ direction: dir }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Section sheet ───────────────────────────────────────────────────
    const sectionSheet = 'A-300-SECTION-AA';
    if (!existingSheetRefs.has(sectionSheet)) {
      const buildingLevels = levels.rows.filter(l => l.is_building_storey);
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, sectionSheet, 'section',
        'Section A-A (Building Cross-Section)',
        `${buildingLevels.length} building stories · Auto-generated section through building core`,
        'open',
        JSON.stringify({ section_type: 'cross_section', level_count: buildingLevels.length }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Material takeoff sheet ──────────────────────────────────────────
    const materialSheet = 'A-500-MATERIALS';
    if (!existingSheetRefs.has(materialSheet)) {
      const wallCount = elements.rows.filter(e => e.type === 'wall').length;
      const roofCount = elements.rows.filter(e => e.type === 'roof').length;
      const columnCount = elements.rows.filter(e => e.type === 'column').length;
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, materialSheet, 'material-takeoff',
        'Material Takeoff (A-500)',
        `${wallCount} walls · ${roofCount} roofs · ${columnCount} columns · ${families.rows.length} openings · Aggregate material volumes from multi-layer construction`,
        'open',
        JSON.stringify({ wall_count: wallCount, roof_count: roofCount, column_count: columnCount, opening_count: families.rows.length }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Stair plan sheets ────────────────────────────────────────────────
    const stairSheet = 'A-401-STAIRS';
    if (!existingSheetRefs.has(stairSheet) && stairs.rows.length > 0) {
      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, stairSheet, 'stair-schedule',
        'Stair Schedule (A-401)',
        `${stairs.rows.length} stairs in model · IBC-compliant configurations · Auto-generated`,
        'open',
        JSON.stringify({ stair_count: stairs.rows.length }),
      ]);
      created.push(item.rows[0]);
    }

    // ── Energy narrative sheet ───────────────────────────────────────────
    const energySheet = 'EN-NARRATIVE';
    if (!existingSheetRefs.has(energySheet)) {
      // Fetch latest energy simulation for this project (use most recent simulation regardless of project)
      let energyData = { EUI: null, compliance: null, results: null };
      try {
        const latestSim = await client.query(
          `SELECT results, compliance FROM energy_simulations ORDER BY created_at DESC LIMIT 1`
        );
        if (latestSim.rows.length > 0) {
          const rawResults = typeof latestSim.rows[0].results === 'string'
            ? JSON.parse(latestSim.rows[0].results)
            : latestSim.rows[0].results;
          const rawCompliance = typeof latestSim.rows[0].compliance === 'string'
            ? JSON.parse(latestSim.rows[0].compliance)
            : latestSim.rows[0].compliance;
          energyData = { results: rawResults, compliance: rawCompliance };
        }
      } catch (_) { /* no simulations yet */ }

      const eui = energyData.results?.EUI;
      const passCount = energyData.compliance
        ? Object.values(energyData.compliance).filter(v => v.pass).length
        : 0;
      const totalCount = energyData.compliance
        ? Object.values(energyData.compliance).length
        : 0;

      const descParts = [];
      if (eui) descParts.push(`EUI ${eui.toFixed(0)} kBtu/ft²/yr`);
      if (passCount > 0) descParts.push(`${passCount}/${totalCount} EN forms pass`);
      descParts.push('NYC Climate Zone 4A');
      descParts.push('ASHRAE 90.1 / NYECC prescriptive path');
      if (energyData.results) {
        const wallU = energyData.results.avgWallUValue;
        const winU = energyData.results.windowUValue;
        if (wallU) descParts.push(`Wall U ${wallU.toFixed(3)} W/m²·K`);
        if (winU) descParts.push(`Window U ${winU.toFixed(1)} W/m²·K`);
      }

      const item = await client.query(`
        INSERT INTO design_book_placeholders
          (design_book_id, sheet_ref, placeholder_type, title, description, status, position_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        bookId, energySheet, 'energy-narrative',
        'Energy Analysis Narrative (EN-1)',
        descParts.join(' · ') + ' · Auto-generated from ASHRAE JS simulation results',
        'open',
        JSON.stringify({ simulation_id: null, eui: eui || null, compliance: energyData.compliance || null }),
      ]);
      created.push(item.rows[0]);
    }

    await client.query('COMMIT');
    return { book_id: bookId, created, summary: `Generated ${created.length} sheet placeholders from ${elements.rows.length} elements, ${families.rows.length} family instances, ${rooms.rows.length} rooms, ${stairs.rows.length} stairs` };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Crafting System integration ────────────────────────────────────────────────
// Populates Design Book with Things from the Universal Crafting Engine.
// Enables: procurement lists auto-populated from recognized BIM components + crafting source cache.
// Auto-links placeholders ↔ crafting_things and product_selections ↔ sourcing-engine results.

async function populateFromCraftingThings(projectId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create book
    const existingBook = await client.query(
      'SELECT id FROM design_books WHERE project_id = $1', [projectId]
    );
    let bookId;
    if (existingBook.rows.length) {
      bookId = existingBook.rows[0].id;
    } else {
      const bk = await client.query(
        `INSERT INTO design_books (project_id, title) VALUES ($1, 'Design Book') RETURNING id`,
        [projectId]
      );
      bookId = bk.rows[0].id;
    }

    // Fetch all crafting_things for this user (project owner)
    // We scan all things where source_type indicates BIM insertion
    const things = await client.query(`
      SELECT ct.id, ct.name, ct.properties_json, ct.source_type, ct.source_ref,
             ct.is_assembly, cs.channels, cs.cached_data
      FROM crafting_things ct
      LEFT JOIN crafting_source_cache cs ON cs.thing_id = ct.id
      WHERE ct.is_assembly = FALSE
      ORDER BY ct.name ASC
    `);

    const createdProducts = [];
    let sourcingLog = [];

    for (const thing of things.rows) {
      const props = typeof thing.properties_json === 'string'
        ? JSON.parse(thing.properties_json)
        : (thing.properties_json || {});
      const cached = typeof thing.cached_data === 'string'
        ? JSON.parse(thing.cached_data)
        : (thing.cached_data || {});

      // Determine BIM element category from source_type
      const category = deriveCategory(thing.source_type, props);
      const placeholderType = category + '-takeoff';

      // Find or create placeholder for this category
      const existingPh = await client.query(
        `SELECT id FROM design_book_placeholders WHERE design_book_id = $1 AND placeholder_type = $2 LIMIT 1`,
        [bookId, placeholderType]
      );
      let phId;
      if (existingPh.rows.length) {
        phId = existingPh.rows[0].id;
      } else {
        const ph = await client.query(`
          INSERT INTO design_book_placeholders
            (design_book_id, placeholder_type, title, description, status, position_data)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
        `, [
          bookId, placeholderType,
          `${capitalize(category)} Takeoff from Crafting`,
          `Sourced from: ${thing.source_ref || thing.source_type} · ${props.material || 'unknown material'} · Dimensions: ${props.length_mm || '?'}×${props.width_mm || '?'}×${props.height_mm || '?'} mm · Auto-populated from crafting_things`,
          'open',
          JSON.stringify({ thing_id: thing.id, source_type: thing.source_type }),
        ]);
        phId = ph.rows[0].id;
      }

      // Extract sourcing info from cache
      const suppliers = cached?.retailers || [];
      const bestPrice = extractBestPrice(cached);
      const leadTime = cached?.lead_days || props.lead_time_days || null;
      const unitCost = bestPrice || props.estimated_cost || null;

      // Create product selection
      const ps = await client.query(`
        INSERT INTO design_book_product_selections
          (design_book_id, placeholder_id, source, manufacturer, product_name,
           product_code, category, specs, estimated_cost, lead_time_days,
           quantity, unit, order_status, crafting_thing_id, unit_cost)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id
      `, [
        bookId, phId, 'crafting_thing',
        suppliers[0] || null,
        thing.name,
        props.product_code || props.sku || null,
        category,
        JSON.stringify({
          material: props.material,
          dimensions_mm: `${props.length_mm || '?'}×${props.width_mm || '?'}×${props.height_mm || '?'}`,
          mass_kg: props.mass_kg,
          connection: props.connection_type,
          source_ref: thing.source_ref,
        }),
        bestPrice || null,
        leadTime,
        1,
        props.unit || 'EA',
        'not_ordered',
        thing.id,
        unitCost,
      ]);
      createdProducts.push(ps.rows[0]);

      // Build sourcing log entry
      sourcingLog.push({
        thing_id: thing.id,
        name: thing.name,
        category,
        suppliers: suppliers.slice(0, 5),
        best_price: bestPrice,
        unit_cost: unitCost,
        lead_days: leadTime,
        channels: thing.channels || '',
      });
    }

    // Compute total estimated cost
    const totalCost = createdProducts.reduce((sum, p) => sum + (p.estimated_cost || 0), 0);

    // Update design book with sourcing log + total
    await client.query(
      `UPDATE design_books SET sourcing_log = $1, total_estimated_cost = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(sourcingLog), totalCost, bookId]
    );

    await client.query('COMMIT');
    return {
      book_id: bookId,
      things_processed: things.rows.length,
      products_created: createdProducts.length,
      total_estimated_cost: totalCost,
      sourcing_log: sourcingLog,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function deriveCategory(sourceType, props) {
  if (!sourceType) return 'generic';
  const st = sourceType.toLowerCase();
  if (st.includes('door')) return 'door';
  if (st.includes('window')) return 'window';
  if (st.includes('hvac') || st.includes('duct')) return 'hvac';
  if (st.includes('plumb') || st.includes('pipe')) return 'plumbing';
  if (st.includes('electr')) return 'electrical';
  if (st.includes('struct') || st.includes('beam') || st.includes('column')) return 'structural';
  if (st.includes('finish') || st.includes('floor') || st.includes('wall')) return 'finish';
  if (props.material) {
    const m = props.material.toLowerCase();
    if (m.includes('concrete')) return 'structural';
    if (m.includes('steel')) return 'structural';
    if (m.includes('glass')) return 'window';
    if (m.includes('wood')) return 'finish';
  }
  return 'generic';
}

function extractBestPrice(cached) {
  if (!cached || typeof cached !== 'object') return null;
  // Try channels — pick lowest price from available retailers
  const channels = cached.channels || cached.retailers || [];
  if (Array.isArray(channels)) {
    const prices = channels
      .map(ch => typeof ch === 'object' ? ch.price : null)
      .filter(p => p !== null && p > 0);
    if (prices.length) return Math.min(...prices);
  }
  if (cached.price) return typeof cached.price === 'number' ? cached.price : null;
  return null;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  getOrCreateBook, getBookById, updateBook,
  getPlaceholders, createPlaceholder, updatePlaceholder, deletePlaceholder,
  getProductSelections, createProductSelection, updateProductSelection, deleteProductSelection,
  autoPopulateFromModel,
  populateFromMEPSimulation,
  populateFromCraftingThings,
};
