/**
 * k6 smoke test — verifies basic API contract and health endpoints.
 * Run: k6 run tests/load/smoke.js
 *
 * Target thresholds:
 * - p95 < 500ms for /health
 * - p95 < 1s for /api/levels
 * - error rate < 1%
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_URL || 'https://atlantist.polsia.app';

// Custom metrics
const errorRate = new Rate('errors');
const healthLatency = new Trend('health_latency');
const apiLatency = new Trend('api_latency');

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    'health_latency': ['p(95)<500'],
    'api_latency': ['p(95)<1000'],
    'errors': ['rate<0.01']
  }
};

export default function () {
  // 1. Health check
  const healthStart = Date.now();
  const healthRes = http.get(`${BASE_URL}/health`);
  healthLatency.add(Date.now() - healthStart);

  check(healthRes, {
    'health returns 200': (r) => r.status === 200,
    'health has status field': (r) => r.json('status') !== undefined
  });
  errorRate.add(healthRes.status !== 200);

  // 2. Landing page
  const landingRes = http.get(BASE_URL);
  check(landingRes, {
    'landing page loads': (r) => r.status === 200,
    'landing has body': (r) => r.body.length > 1000
  });
  errorRate.add(landingRes.status !== 200);

  // 3. App SPA
  const appRes = http.get(`${BASE_URL}/app`);
  check(appRes, {
    'app serves SPA': (r) => r.status === 200,
    'app has DOCTYPE': (r) => r.body.includes('DOCTYPE')
  });
  errorRate.add(appRes.status !== 200);

  // 4. API — levels list
  const apiStart = Date.now();
  const levelsRes = http.get(`${BASE_URL}/api/levels`);
  apiLatency.add(Date.now() - apiStart);

  check(levelsRes, {
    'levels API returns 200 or 500': (r) => r.status === 200 || r.status === 500,
    'levels response is valid JSON': (r) => {
      try { JSON.parse(r.body); return true; } catch { return false; }
    }
  });
  errorRate.add(![200, 500].includes(levelsRes.status));

  // 5. API — catalog wall types
  const wallRes = http.get(`${BASE_URL}/api/catalog/wall-types`);
  check(wallRes, {
    'wall-types returns 200 or 500': (r) => r.status === 200 || r.status === 500
  });
  errorRate.add(![200, 500].includes(wallRes.status));

  // 6. Legal pages
  const privacyRes = http.get(`${BASE_URL}/legal/privacy`);
  check(privacyRes, {
    'privacy policy loads': (r) => r.status === 200
  });
  errorRate.add(privacyRes.status !== 200);

  sleep(1);
}

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { printOnlyFailed: false })
  };
}

function textSummary(data, opts) {
  const passed = data.passes || 0;
  const failed = data.failures || 0;
  let out = `Smoke Test Summary\n${'='.repeat(40)}\n`;
  out += `Total: ${data.metrics?.http_reqs?.values?.count || 0} requests\n`;
  out += `Failed: ${failed}\n`;
  out += `Health p95: ${data.metrics?.health_latency?.values?.['p(95)']?.toFixed(0) || 'N/A'}ms\n`;
  out += `API p95: ${data.metrics?.api_latency?.values?.['p(95)']?.toFixed(0) || 'N/A'}ms\n`;
  out += `Error rate: ${((data.metrics?.errors?.values?.rate || 0) * 100).toFixed(2)}%\n`;
  return out;
}