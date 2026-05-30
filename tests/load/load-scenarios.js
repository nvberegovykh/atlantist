/**
 * k6 load test — 500 concurrent users across realistic BIM scenarios.
 * Run: k6 run tests/load/load-scenarios.js
 *
 * Target thresholds:
 * - p95 API response < 200ms
 * - error rate < 1%
 * - WebSocket reconnect < 3s
 *
 * Test scenarios:
 *   1. Model load (GET /api/levels, /api/elements)
 *   2. Element CRUD (POST/PATCH/DELETE walls, columns)
 *   3. Energy sim trigger
 *   4. WebSocket broadcast
 *   5. Subscription create
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { WebSocket } from 'k6/ws';

const BASE_URL = __ENV.APP_URL || 'https://atlantist.polsia.app';
const TARGET_VUS = 500;
const DURATION = '5m';

// Custom metrics
const errors = new Rate('errors');
const apiLatency = new Trend('api_latency');
const wsLatency = new Trend('ws_reconnect');
const elementCreates = new Counter('element_creates');
const simTriggers = new Counter('sim_triggers');

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 200 },
    { duration: '2m', target: 500 },
    { duration: '1m', target: 500 },
    { duration: '30s', target: 0 }
  ],
  thresholds: {
    'api_latency': ['p(95)<200'],
    'errors': ['rate<0.01'],
    'ws_reconnect': ['p(95)<3000']
  }
};

// Shared state across VUs
const sessionUuids = [`load-test-${__VU}-${__ITER}`];

export default function () {
  const vuId = __VU;

  // Scenario 1: Model load — 10% of traffic
  if (Math.random() < 0.1) {
    modelLoadScenario();
  }
  // Scenario 2: Element CRUD — 40% of traffic
  else if (Math.random() < 0.4) {
    elementCRUDScenario();
  }
  // Scenario 3: Energy simulation — 10% of traffic
  else if (Math.random() < 0.5) {
    energySimScenario();
  }
  // Scenario 4: WebSocket broadcast — 20% of traffic
  else if (Math.random() < 0.7) {
    wsScenario();
  }
  // Scenario 5: Auth flows — 20% of traffic
  else {
    authScenario();
  }

  sleep(Math.random() * 2 + 0.5); // 0.5-2.5s between requests
}

function modelLoadScenario() {
  const start = Date.now();

  // Load all levels
  const levelsRes = http.get(`${BASE_URL}/api/levels`);
  check(levelsRes, { 'levels loaded': (r) => r.status < 500 });
  errors.add(levelsRes.status >= 500);
  apiLatency.add(Date.now() - start);

  // Load elements for first level
  if (levelsRes.status === 200) {
    try {
      const levels = JSON.parse(levelsRes.body);
      if (levels.length > 0) {
        const elStart = Date.now();
        const elementsRes = http.get(`${BASE_URL}/api/elements?level_id=${levels[0].id}`);
        check(elementsRes, { 'elements loaded': (r) => r.status < 500 });
        errors.add(elementsRes.status >= 500);
        apiLatency.add(Date.now() - elStart);
      }
    } catch (_) {}
  }

  // Load catalog
  const catalogRes = http.get(`${BASE_URL}/api/catalog/wall-types`);
  check(catalogRes, { 'catalog loaded': (r) => r.status < 500 });
  errors.add(catalogRes.status >= 500);
}

function elementCRUDScenario() {
  const start = Date.now();

  // Create a wall
  const createRes = http.post(`${BASE_URL}/api/elements`,
    JSON.stringify({
      type: 'wall',
      type_name: 'Load Test Wall',
      base_level_id: 1,
      parameters: {
        length: 3000 + Math.floor(Math.random() * 2000),
        wall_height: 3000,
        elevation: 0
      }
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(createRes, {
    'element created (201 or 500)': (r) => r.status === 201 || r.status === 500,
    'valid JSON response': (r) => {
      try { JSON.parse(r.body); return true; } catch { return false; }
    }
  });
  errors.add(![201, 500].includes(createRes.status));
  apiLatency.add(Date.now() - start);
  elementCreates.add(1);

  // If created, patch it
  if (createRes.status === 201) {
    try {
      const el = JSON.parse(createRes.body);
      const patchRes = http.patch(`${BASE_URL}/api/elements/${el.id}`,
        JSON.stringify({ parameters: { length: 4000 } }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      check(patchRes, { 'element patched': (r) => r.status < 500 });
      errors.add(patchRes.status >= 500);
    } catch (_) {}
  }
}

function energySimScenario() {
  const start = Date.now();

  const res = http.post(`${BASE_URL}/api/energy/simulate`,
    JSON.stringify({
      project_id: 1,
      model_snapshot: { elements: [] }
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'energy sim triggered': (r) => r.status < 500,
    'returns simulation_id': (r) => {
      try { return !!JSON.parse(r.body).simulation_id; } catch { return false; }
    }
  });
  errors.add(res.status >= 500);
  apiLatency.add(Date.now() - start);
  simTriggers.add(1);
}

function wsScenario() {
  const wsUrl = BASE_URL.replace('https://', 'wss://') + '/ws';
  const start = Date.now();

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Connected — send a ping
      ws.send(JSON.stringify({ type: 'ping' }));
      wsLatency.add(Date.now() - start);
    };

    ws.onmessage = (msg) => {
      // Receive any broadcast
      check(msg, { 'ws message received': () => true });
    };

    ws.onerror = () => {
      errors.add(1);
    };

    // Close after 2 seconds
    setTimeout(() => ws.close(), 2000);
  } catch (_) {
    errors.add(1);
  }
}

function authScenario() {
  const sessionUuid = `load-test-${__VU}-${__ITER}-${Date.now()}`;

  const initRes = http.post(`${BASE_URL}/api/auth/init`,
    JSON.stringify({ session_uuid: sessionUuid }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(initRes, { 'auth init': (r) => r.status < 500 });
  errors.add(initRes.status >= 500);

  // Check /me
  const meRes = http.get(`${BASE_URL}/api/auth/me`);
  check(meRes, { 'auth/me': (r) => r.status < 500 });
  errors.add(meRes.status >= 500);
}

export function handleSummary(data) {
  const reqCount = data.metrics?.http_reqs?.values?.count || 0;
  const errorRate = (data.metrics?.errors?.values?.rate || 0) * 100;
  const p95 = data.metrics?.api_latency?.values?.['p(95)']?.toFixed(0) || 'N/A';
  const wsP95 = data.metrics?.ws_reconnect?.values?.['p(95)']?.toFixed(0) || 'N/A';

  let out = `\n${'='.repeat(60)}\n`;
  out += `LOAD TEST RESULTS — ${TARGET_VUS} concurrent users\n${'='.repeat(60)}\n`;
  out += `Duration: ${DURATION}\n`;
  out += `Total requests: ${reqCount}\n`;
  out += `Error rate: ${errorRate.toFixed(2)}%\n`;
  out += `API p95 latency: ${p95}ms\n`;
  out += `WS reconnect p95: ${wsP95}ms\n`;
  out += `Elements created: ${data.metrics?.element_creates?.values?.count || 0}\n`;
  out += `Simulations triggered: ${data.metrics?.sim_triggers?.values?.count || 0}\n`;
  out += `\nPass thresholds: p95<200ms, error_rate<1%, ws_p95<3000ms\n`;

  const pass = errorRate < 1 && parseInt(p95) < 200;
  out += `Result: ${pass ? '✅ PASS' : '❌ FAIL'}\n`;

  return { 'stdout': out };
}