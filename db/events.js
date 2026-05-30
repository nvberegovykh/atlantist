/**
 * Owns: event ledger queries (immutable audit log of parametric changes).
 * Does NOT own: business logic, DAG recalc, HTTP routing.
 */
const pool = require('./index');

async function appendEvent({ entity_type, entity_id, event_type, before_data, after_data, triggered_by, lamport_clock = null }) {
  // Atomic Lamport clock increment per project via advisory lock.
  // We derive the project ID from entity_type + entity_id by looking up
  // the entity's project_id in its respective table. This is synchronous
  // with the insert — two concurrent appends get different clock values.
  let clockValue = lamport_clock;
  if (clockValue === null) {
    const projectId = await _resolveProjectId(entity_type, entity_id);
    if (projectId) {
      const lockResult = await pool.query(
        `SELECT pg_advisory_xact_lock(($1::bigint << 32) % 2147483647) AS _lock`,
        [projectId]
      );
      void lockResult;
      // Increment the project's last_lamport_clock atomically
      const incResult = await pool.query(
        `UPDATE projects SET last_lamport_clock = last_lamport_clock + 1
         WHERE id = $1 RETURNING last_lamport_clock AS clock`,
        [projectId]
      );
      clockValue = incResult.rows[0]?.clock ?? 0;
    } else {
      clockValue = 0;
    }
  }

  const res = await pool.query(
    `INSERT INTO event_ledger (entity_type, entity_id, event_type, before_data, after_data, triggered_by, lamport_clock)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [entity_type, entity_id, event_type, JSON.stringify(before_data), JSON.stringify(after_data), triggered_by || 'user', clockValue]
  );
  return res.rows[0];
}

/**
 * Resolve the project_id for an entity so we can increment the correct Lamport clock.
 * Falls back to null if entity not found (clock stays 0).
 */
async function _resolveProjectId(entity_type, entity_id) {
  let table, idCol;
  switch (entity_type) {
    case 'level': table = 'levels'; idCol = 'id'; break;
    case 'element': case 'wall': case 'column': table = 'elements'; idCol = 'id'; break;
    case 'project': return parseInt(entity_id, 10) || null;
    case 'family': table = 'family_instances'; idCol = 'id'; break;
    case 'issue': table = 'issues'; idCol = 'id'; break;
    case 'im_type': table = 'im_types'; idCol = 'id'; break;
    case 'im_instance': table = 'im_instances'; idCol = 'id'; break;
    case 'im_constraint': table = 'im_constraints'; idCol = 'id'; break;
    default: return null;
  }
  try {
    const res = await pool.query(
      `SELECT project_id FROM ${table} WHERE ${idCol} = $1`,
      [entity_id]
    );
    return res.rows[0]?.project_id ? parseInt(res.rows[0].project_id) : null;
  } catch {
    return null;
  }
}

async function getLastEventForEntity(entity_type, entity_id) {
  const res = await pool.query(
    `SELECT * FROM event_ledger WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [entity_type, entity_id]
  );
  return res.rows[0] || null;
}

async function getEvents({ limit = 50, offset = 0, entity_type, entity_id } = {}) {
  limit = Math.min(limit, 500);
  let sql = `SELECT id, entity_type, entity_id, event_type, before_data, after_data, triggered_by, created_at
             FROM event_ledger WHERE 1=1`;
  const params = [];

  if (entity_type) { params.push(entity_type); sql += ` AND entity_type = $${params.length}`; }
  if (entity_id) { params.push(entity_id); sql += ` AND entity_id = $${params.length}`; }

  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const res = await pool.query(sql, params);
  return res.rows;
}

async function getEventById(id) {
  const res = await pool.query(
    `SELECT id, entity_type, entity_id, event_type, before_data, after_data, triggered_by, created_at
     FROM event_ledger WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function getEventStats() {
  const [totalRes, byTypeRes, recentRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) as total FROM event_ledger`),
    pool.query(`SELECT entity_type, COUNT(*) as count FROM event_ledger GROUP BY entity_type ORDER BY count DESC`),
    pool.query(`SELECT DATE(created_at) as date, COUNT(*) as events FROM event_ledger WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`)
  ]);

  return {
    total: parseInt(totalRes.rows[0].total),
    by_entity_type: byTypeRes.rows,
    last_30_days: recentRes.rows
  };
}

async function revertElementToBefore(event) {
  const { entity_type, entity_id, before_data } = event;
  if (!before_data) throw new Error('No before_data to revert to');

  let table, idCol;
  switch (entity_type) {
    case 'level': table = 'levels'; idCol = 'id'; break;
    case 'wall': case 'column': table = 'elements'; idCol = 'id'; break;
    case 'issue': table = 'issues'; idCol = 'id'; break;
    default: throw new Error(`Cannot revert entity type: ${entity_type}`);
  }

  const cols = Object.keys(before_data).filter(k => k !== 'id' && k !== 'created_at');
  if (!cols.length) throw new Error('No fields to revert');

  const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const values = cols.map(c => before_data[c]);

  const updateRes = await pool.query(
    `UPDATE ${table} SET ${setClause}, updated_at = NOW() WHERE ${idCol} = $1 RETURNING *`,
    [entity_id, ...values]
  );

  await appendEvent({
    entity_type,
    entity_id,
    event_type: 'revert',
    before_data: updateRes.rows[0],
    after_data: before_data,
    triggered_by: 'admin'
  });

  return updateRes.rows[0];
}

// ─── Model-level history — all events across elements + levels in a project ──
// Includes: project-level events, element events (walls, columns) for the project,
// and level events for the project. Grouped by 5-minute sessions in the UI.
async function getModelHistory({ projectId, limit = 50, before = null } = {}) {
  limit = Math.min(limit, 500);
  // Fetch project-level events + element/level events scoped by project_id
  // ORDER BY created_at DESC so newest events surface first (UI newest-first)
  const sql = `
    WITH eligible_entity_ids AS (
      -- IDs of elements and levels that belong to this project
      SELECT id FROM elements WHERE project_id = $1
      UNION ALL
      SELECT id FROM levels WHERE project_id = $1
    )
    SELECT
      el.id, el.entity_type, el.entity_id, el.event_type,
      el.before_data, el.after_data, el.triggered_by, el.created_at,
      el.lamport_clock,
      u.id as user_id, u.email as user_email, u.first_name as user_name
    FROM event_ledger el
    LEFT JOIN app_users u ON
      el.triggered_by = u.id::text OR el.triggered_by = u.session_uuid
    WHERE
      (
        (el.entity_type = 'project' AND el.entity_id = $1)
        OR (el.entity_type = 'element' AND el.entity_id IN (SELECT id FROM eligible_entity_ids))
        OR (el.entity_type = 'level'   AND el.entity_id IN (SELECT id FROM eligible_entity_ids))
        OR (el.entity_type = 'family'  AND el.entity_id IN (SELECT id FROM eligible_entity_ids))
      )
    ORDER BY el.created_at DESC
    LIMIT $2
  `;
  const res = await pool.query(sql, [String(projectId), limit + 1]);
  const rows = res.rows;

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  return { events: rows, has_more: hasMore };
}

// Count events (all types) for a project after a given timestamp
async function countEventsSince(projectId, afterTime) {
  const sql = `
    WITH eligible_entity_ids AS (
      SELECT id FROM elements WHERE project_id = $1
      UNION ALL
      SELECT id FROM levels WHERE project_id = $1
    )
    SELECT COUNT(*) as count,
           COUNT(DISTINCT triggered_by) as user_count,
           MIN(created_at) as first_event,
           MAX(created_at) as last_event
    FROM event_ledger
    WHERE
      (
        (entity_type = 'project' AND entity_id = $1)
        OR (entity_type = 'element' AND entity_id IN (SELECT id FROM eligible_entity_ids))
        OR (entity_type = 'level'   AND entity_id IN (SELECT id FROM eligible_entity_ids))
        OR (entity_type = 'family'  AND entity_id IN (SELECT id FROM eligible_entity_ids))
      )
      AND created_at > $2
  `;
  const res = await pool.query(sql, [String(projectId), afterTime]);
  return res.rows[0];
}

// Full model revert: replay all events up to target_event_id, write shadow page
async function revertModelToEvent({ projectId, targetEventId, revertedBy }) {
  const targetEvent = await getEventById(targetEventId);
  if (!targetEvent) throw new Error('Target event not found');

  // Diff summary: count all events (all types) created after the target event
  const diff = await countEventsSince(String(projectId), targetEvent.created_at);

  // Capture current model state as the "before" snapshot for the revert event
  const modelSnapshot = await buildModelSnapshotAtEvent(String(projectId));

  const revertedEvent = await appendEvent({
    entity_type: 'project',
    entity_id: String(projectId),
    event_type: 'model.reverted',
    before_data: modelSnapshot,
    after_data: {
      reverted_to_event_id: targetEventId,
      reverted_by: revertedBy,
      undone_event_count: parseInt(diff.count),
      undone_user_count: parseInt(diff.user_count),
      reverted_at: new Date().toISOString()
    },
    triggered_by: String(revertedBy)
  });

  return {
    reverted_event_id: revertedEvent.id,
    undone_event_count: parseInt(diff.count),
    undone_user_count: parseInt(diff.user_count),
    model_snapshot: modelSnapshot
  };
}

// Snapshot of all element/level/issue data for the project (used in revert events)
async function buildModelSnapshotAtEvent(projectId) {
  const [levels, elements] = await Promise.all([
    pool.query(`SELECT * FROM levels WHERE project_id = $1 ORDER BY id`, [projectId]),
    pool.query(`SELECT * FROM elements WHERE project_id = $1 ORDER BY id`, [projectId])
  ]);
  return {
    snapshot_at: new Date().toISOString(),
    levels: levels.rows,
    elements: elements.rows
  };
}

// Per-element revert (scope = element_id)
async function revertSingleElement({ elementId, targetEventId, revertedBy }) {
  const targetEvent = await getEventById(targetEventId);
  if (!targetEvent) throw new Error('Target event not found');

  // Find the before_data from the target event for this specific element
  const entityType = targetEvent.entity_type;
  const entityId = targetEvent.entity_id;

  if (!targetEvent.before_data) throw new Error('No before_data to revert to');

  let table;
  switch (entityType) {
    case 'level': table = 'levels'; break;
    case 'wall': case 'column': table = 'elements'; break;
    case 'family': table = 'family_instances'; break;
    default: throw new Error(`Cannot revert entity type: ${entityType}`);
  }

  const beforeData = targetEvent.before_data;
  const cols = Object.keys(beforeData).filter(k => k !== 'id' && k !== 'created_at');
  if (!cols.length) throw new Error('No fields to revert');

  const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const values = cols.map(c => beforeData[c]);

  const updateRes = await pool.query(
    `UPDATE ${table} SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [entityId, ...values]
  );

  // Append revert event
  await appendEvent({
    entity_type: entityType,
    entity_id: entityId,
    event_type: 'element.reverted',
    before_data: updateRes.rows[0],
    after_data: { reverted_to_event_id: targetEventId, reverted_by: revertedBy },
    triggered_by: String(revertedBy)
  });

  return updateRes.rows[0];
}

/**
 * Append a Wallt agent completion event (W6 bidirectional signaling).
 * Also posts an event to event_ledger for Lamport clock ordering + audit trail.
 */
async function appendAgentEvent({ agentId, sectorId, taskId, status, resultSummary, sectorVersionsUsed = {}, extra = {} }) {
  const lamportClock = await _incrementLamportClock();

  // Append to wallt_agent_events for structured query + cross-system reads
  const res = await pool.query(
    `INSERT INTO wallt_agent_events (agent_id, sector_id, task_id, status, result_summary, sector_versions_used, lamport_clock, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [agentId, sectorId || null, taskId || null, status, resultSummary || null, JSON.stringify(sectorVersionsUsed), lamportClock, JSON.stringify(extra)]
  );

  // Also append to event_ledger so Polsia orchestrator can read from shared graph
  await pool.query(
    `INSERT INTO event_ledger (entity_type, entity_id, event_type, after_data, lamport_clock)
     VALUES ($1, $2, $3, $4, $5)`,
    ['wallt_agent', agentId, `wallt.agent.${status}`, JSON.stringify({
      agent_id: agentId,
      sector_id: sectorId,
      task_id: taskId,
      status,
      result_summary: resultSummary,
      sector_versions_used: sectorVersionsUsed,
      timestamp: new Date().toISOString(),
    }), lamportClock]
  );

  return res.rows[0];
}

async function _incrementLamportClock() {
  // Atomically increment and return the global wallt Lamport clock.
  // If wallt_lamport_clock table doesn't exist, returns 0 (events still get recorded).
  try {
    const res = await pool.query(
      `UPDATE wallt_lamport_clock SET clock = clock + 1 WHERE id = 1 RETURNING clock`
    );
    return res.rows[0]?.clock ?? 0;
  } catch {
    return 0;
  }
}

// Append an IM data change event (type catalog edit, instance override, constraint value)
async function appendIMEvent({ projectId, element_id, type_id, changes, triggered_by }) {
  const clockValue = await _incrementLamportClock();
  const res = await pool.query(
    `INSERT INTO event_ledger (entity_type, entity_id, event_type, after_data, lamport_clock, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      element_id ? 'im_instance' : 'im_type',
      element_id || type_id,
      'im_data_change',
      JSON.stringify({ project_id: projectId, element_id, type_id, changes }),
      clockValue,
      triggered_by || 'user'
    ]
  );
  return res.rows[0];
}

// Get all IM data change events for a project (for load pipeline replay)
async function getIMEvents(projectId) {
  const res = await pool.query(
    `SELECT el.id, el.entity_type, el.entity_id, el.event_type, el.after_data,
            el.triggered_by, el.created_at, el.lamport_clock,
            u.id as user_id, u.email as user_email, u.first_name as user_name
     FROM event_ledger el
     LEFT JOIN app_users u ON
       el.triggered_by = u.id::text OR el.triggered_by = u.session_uuid
     WHERE el.event_type = 'im_data_change'
       AND el.after_data->>'project_id' = $1
     ORDER BY el.lamport_clock ASC`,
    [String(projectId)]
  );
  return res.rows;
}

module.exports = {
  appendEvent,
  appendAgentEvent,
  appendIMEvent,
  getIMEvents,
  getLastEventForEntity,
  getEvents,
  getEventById,
  getEventStats,
  revertElementToBefore,
  getModelHistory,
  countEventsSince,
  revertModelToEvent,
  buildModelSnapshotAtEvent,
  revertSingleElement
};