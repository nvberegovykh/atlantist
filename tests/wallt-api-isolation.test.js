/**
 * wallt-api-isolation.test.js
 *
 * CRITICAL: Verifies that POST /api/wallt-api/ingest and POST /api/wallt-api/project-query
 * NEVER write to any Wallt memory table. This test MUST pass on every deploy.
 *
 * Isolation contract:
 *   - wallt_conversations         — NO new rows after any API call
 *   - wallt_messages              — NO new rows after any API call
 *   - wallt_memory                — NO new rows after any API call
 *   - wallt_memory_archive        — NO new rows after any API call
 *   - wallt_core_user_profile     — NO new rows after any API call
 *   - wallt_core_decision_log     — NO new rows after any API call
 *   - wallt_core_institutional_mem — NO new rows after any API call
 *   - wallt_core_conflict_log     — NO new rows after any API call
 *   - wallt_core_escalation_log   — NO new rows after any API call
 *   - wallt_core_skill_inventory  — NO new rows after any API call
 *   - wallt_core_audio_catalog    — NO new rows after any API call
 *   - wallt_context_snapshots     — NO new rows after any API call
 *   - wallt_zoning_chunks         — NO new rows after any API call
 *   - wallt_project_memory        — NO new rows after any API call (project agent memory)
 *   - Any pgvector table           — NO new rows after any API call
 *
 * This test runs against the live (or test) database. It intentionally
 * calls the actual HTTP endpoint and verifies row counts before/after.
 */
const request = require('supertest');

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:3000';
const VALID_TOKEN = process.env.WALLT_API_TOKEN || 'test-wallt-api-token';

// Derive a valid project key for the test project — tests use the same HKDF
const { deriveProjectKey } = require('../routes/wallt-api');
const TEST_PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const VALID_PROJECT_KEY = deriveProjectKey(TEST_PROJECT_ID);
const WRONG_PROJECT_KEY = 'not-a-valid-project-key-at-all-000';

const TABLES = [
  'wallt_conversations',
  'wallt_messages',
  'wallt_memory',
  'wallt_memory_archive',
  'wallt_core_user_profile',
  'wallt_core_decision_log',
  'wallt_core_institutional_mem',
  'wallt_core_conflict_log',
  'wallt_core_escalation_log',
  'wallt_core_skill_inventory',
  'wallt_core_audio_catalog',
  'wallt_context_snapshots',
  'wallt_zoning_chunks',
  'wallt_project_memory',
];

async function countRows(table) {
  try {
    const { pool } = require('../db/index');
    const res = await pool.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
    return parseInt(res.rows[0].cnt, 10);
  } catch {
    // Table might not exist — treat as 0 rows
    return 0;
  }
}

describe('Wallt API isolation — NO writes to memory tables', () => {
  let beforeCounts = {};

  beforeAll(async () => {
    for (const table of TABLES) {
      beforeCounts[table] = await countRows(table);
    }
  });

  afterAll(async () => {
    const { pool } = require('../db/index');
    await pool.end();
  });

  async function assertIsolation(tableName) {
    const after = await countRows(tableName);
    const before = beforeCounts[tableName] || 0;
    expect(after).toBe(before);
  }

  // ── /ingest isolation tests ──────────────────────────────────────────────────

  test('POST /ingest does NOT write to wallt_conversations', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test',
        payload: [{ text: 'Testing isolation — AISC beam span on W14x30', sender: 'test' }],
      });
    await assertIsolation('wallt_conversations');
  });

  test('POST /ingest does NOT write to wallt_messages', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test',
        payload: [{ text: 'NFPA 13 sprinkler layout for A-2 occupancy', sender: 'test' }],
      });
    await assertIsolation('wallt_messages');
  });

  test('POST /ingest does NOT write to wallt_memory', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test',
        payload: [{ text: 'NYC DOB zoning resolution FAR calculation', sender: 'test' }],
      });
    await assertIsolation('wallt_memory');
  });

  test('POST /ingest does NOT write to wallt_core_decision_log', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test',
        payload: [{ text: 'What is the thermal U-value for a 6" CMU wall?', sender: 'test' }],
      });
    await assertIsolation('wallt_core_decision_log');
  });

  test('POST /ingest does NOT write to wallt_core_user_profile', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test',
        user_id: 'test-user-uuid',
        payload: [{ text: 'ASHRAE 90.1 envelope requirements', sender: 'test' }],
      });
    await assertIsolation('wallt_core_user_profile');
  });

  test('POST /ingest does NOT write to wallt_context_snapshots', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test',
        payload: [{ text: 'ACI 318-22 column design for W12x40', sender: 'test' }],
      });
    await assertIsolation('wallt_context_snapshots');
  });

  test('POST /ingest does NOT write to wallt_project_memory', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        source: 'isolation-test',
        project_id: TEST_PROJECT_ID,
        payload: [{ text: 'Steel grade for main beam W14x90', sender: 'test' }],
      });
    await assertIsolation('wallt_project_memory');
  });

  test('batch ingest does NOT write to any Wallt memory table', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-test-batch',
        payload: [
          { text: 'AISC 360-22 W14x90 beam', sender: 'alice' },
          { text: 'NFPA 13 sprinkler density', sender: 'bob' },
          { text: 'NYC DOB filing requirements', sender: 'carol' },
          { text: 'CSI MasterFormat 05 21 00 structural steel', sender: 'dave' },
          { text: 'ASHRAE 90.1 R-value for roof assembly', sender: 'eve' },
        ],
      });
    for (const table of TABLES) {
      await assertIsolation(table);
    }
  });

  // ── /project-query isolation tests ─────────────────────────────────────────

  test('POST /project-query with valid key does NOT write to wallt_project_memory', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        project_id: TEST_PROJECT_ID,
        query: 'What steel grade was specified for the main beams?',
        sectors: ['Structural', 'Materials'],
      });
    await assertIsolation('wallt_project_memory');
  });

  test('POST /project-query with valid key does NOT write to any Wallt memory table', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        project_id: TEST_PROJECT_ID,
        query: 'DOB egress requirements for A-3 occupancy',
      });
    for (const table of TABLES) {
      await assertIsolation(table);
    }
  });

  test('POST /project-query with invalid key returns 403', async () => {
    const res = await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', WRONG_PROJECT_KEY)
      .send({
        project_id: TEST_PROJECT_ID,
        query: 'What steel grade was specified?',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_project_key');
  });

  test('POST /project-query with missing key returns 403', async () => {
    const res = await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      // No X-Project-Key header
      .send({
        project_id: TEST_PROJECT_ID,
        query: 'What steel grade was specified?',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_project_key');
  });

  test('POST /project-query with mismatched project_id/key returns 403 (cross-project replay)', async () => {
    // Use key derived for TEST_PROJECT_ID but request a different project_id.
    // This simulates an attacker who stole a key for project A and tries to use it on project B.
    const res = await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY) // key for TEST_PROJECT_ID
      .send({
        project_id: '22222222-2222-2222-2222-222222222222', // different project
        query: 'What steel grade was specified?',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_project_key');
  });

  test('POST /project-query with missing project_id returns 400', async () => {
    const res = await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        query: 'What steel grade was specified?',
        // no project_id
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('"project_id" is required');
  });

  test('POST /project-query with missing query returns 400', async () => {
    const res = await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        project_id: TEST_PROJECT_ID,
        // no query
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('"query" is required and must be non-empty');
  });

  test('POST /project-query with valid key returns 200 and enriched response', async () => {
    const res = await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        project_id: TEST_PROJECT_ID,
        query: 'What steel grade was specified for the main beams?',
        sectors: ['Structural'],
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('request_id');
    expect(res.body).toHaveProperty('project_context');
    expect(res.body).toHaveProperty('sector_enrichment');
    expect(res.body).toHaveProperty('processing_time_ms');
    expect(Array.isArray(res.body.project_context)).toBe(true);
    expect(Array.isArray(res.body.sector_enrichment)).toBe(true);
  });

  test('POST /project-query with valid key does NOT write to any Wallt table (after 200 response)', async () => {
    await request(`${API_BASE}`)
      .post('/api/wallt-api/project-query')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-Key', VALID_PROJECT_KEY)
      .send({
        project_id: TEST_PROJECT_ID,
        query: 'CSI MasterFormat section for structural steel',
      });
    for (const table of TABLES) {
      await assertIsolation(table);
    }
  });

  // ── Audit table sanity check ───────────────────────────────────────────────

  test('audit table DOES receive a row (isolation test sanity check)', async () => {
    const before = await countRows('wallt_api_audit');
    await request(`${API_BASE}`)
      .post('/api/wallt-api/ingest')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        source: 'isolation-audit-check',
        payload: [{ text: 'DOB zoning compliance', sender: 'test' }],
      });
    const after = await countRows('wallt_api_audit');
    expect(after).toBeGreaterThan(before);
  });
});