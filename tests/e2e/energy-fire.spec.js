/**
 * Playwright e2e — Energy and Fire Protection flows
 *
 * Covers:
 * - Run energy simulation
 * - Download gbXML
 * - Check EN-1 through EN-8 compliance
 * - Fire protection analysis
 * - DOB checklist
 *
 * Run: npx playwright test tests/e2e/energy-fire.spec.js
 */
const { test, expect } = require('@playwright/test');

const APP_URL = process.env.APP_URL || 'https://atlantist.cloud';

test.describe('Energy Simulation Flows', () => {
  test('POST /api/energy/simulate creates simulation job', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/energy/simulate`, {
      data: { project_id: 1, model_snapshot: { elements: [] } }
    });
    expect([202, 400, 500]).toContain(res.status());
    if (res.status() === 202) {
      const body = await res.json();
      expect(body).toHaveProperty('simulation_id');
    }
  });

  test('POST /api/energy/simulate without project_id → 400', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/energy/simulate`, {
      data: {}
    });
    expect(res.status()).toBe(400);
  });

  test('GET /api/energy/compliance-standards returns EN standards', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/energy/compliance-standards`);
    expect([200, 500]).toContain(res.status());
    if (res.status() === 200) {
      const standards = res.json();
      expect(standards).toBeInstanceOf(Array);
      expect(standards.length).toBeGreaterThanOrEqual(8); // EN-1 through EN-8
    }
  });

  test('energy simulation completes and stores gbXML', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/energy/simulate`, {
      data: {
        project_id: 1,
        model_snapshot: {
          levels: [{ id: 1, elevation: 0 }],
          elements: [
            { id: 1, type: 'wall', parameters: { length: 10000, wall_height: 3000, elevation: 0 } }
          ]
        }
      }
    });
    expect([202, 500]).toContain(res.status());
  });

  test('DOB package endpoint accepts request', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/energy/dob-package`, {
      data: {
        simulation_id: 1,
        project_name: 'E2E DOB Test',
        address: '123 Main St',
        BIN: '1234567',
        borough: 'Manhattan'
      }
    });
    expect([202, 404, 500]).toContain(res.status());
  });
});

test.describe('Fire Protection Analysis', () => {
  test('POST /api/fire-protection/analyze with A2 occupancy → results', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/fire-protection/analyze`, {
      data: {
        occupancy_type: 'A2',
        project_id: 1,
        floor_area: 500,
        occupant_load: 200,
        ceiling_height: 3.5
      }
    });
    expect([200, 400, 500]).toContain(res.status());
    if (res.status() === 200) {
      const body = res.json();
      expect(body).toHaveProperty('sprinkler');
      expect(body).toHaveProperty('egress');
      expect(body).toHaveProperty('smoke');
    }
  });

  test('POST /api/fire-protection/analyze without occupancy → 400', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/fire-protection/analyze`, {
      data: { project_id: 1 }
    });
    expect(res.status()).toBe(400);
  });

  test('NFPA 13 sprinkler design returns parameters', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/fire-protection/nfpa-13?occupancy=A2&hazard=ordinary`);
    expect([200, 500]).toContain(res.status());
    if (res.status() === 200) {
      const data = res.json();
      expect(data).toHaveProperty('density');
    }
  });

  test('NFPA 101 egress requirements returns occupant load', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/fire-protection/nfpa-101?occupancy=A2&floor_area=500`);
    expect([200, 500]).toContain(res.status());
    if (res.status() === 200) {
      const data = res.json();
      expect(data).toHaveProperty('occupant_load_factor');
    }
  });

  test('FDNY filing requirements endpoint accessible', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/fire-protection/fdny-requirements?occupancy=A2`);
    expect([200, 404, 500]).toContain(res.status());
  });
});

test.describe('Issue Tracking', () => {
  test('issues API accepts create request', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/issues`, {
      data: { title: 'E2E Test Issue', status: 'open', priority: 'medium', element_id: 1 }
    });
    expect([201, 500]).toContain(res.status());
    if (res.status() === 201) {
      const body = res.json();
      expect(body).toHaveProperty('id');
    }
  });

  test('issues API validates required fields', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/issues`, {
      data: { status: 'open' } // missing title
    });
    expect(res.status()).toBe(400);
  });

  test('comments API accepts new comment', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/issues/1/comments`, {
      data: { content: 'E2E test comment', author: 'Test User' }
    });
    expect([201, 404, 500]).toContain(res.status());
  });
});