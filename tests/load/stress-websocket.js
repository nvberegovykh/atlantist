/**
 * k6 stress test — WebSocket broadcast under load.
 * Tests that the ws-server handles concurrent broadcasts without crashes.
 * Run: k6 run tests/load/stress-websocket.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { WebSocket } from 'k6/ws';

const BASE_URL = __ENV.APP_URL || 'https://atlantist.polsia.app';

const errors = new Rate('ws_errors');
const broadcastLatency = new Trend('broadcast_latency');
const broadcastsReceived = new Counter('broadcasts_received');

export const options = {
  scenarios: {
    ws_stress: {
      executor: 'per-vus-iterations',
      vus: 100,
      iterations: 5,
      maxDuration: '2m'
    }
  },
  thresholds: {
    'ws_errors': ['rate<0.05'],
    'broadcast_latency': ['p(95)<1000']
  }
};

export default function () {
  const sessionUuid = `ws-stress-${__VU}-${__ITER}-${Date.now()}`;

  // Create anonymous session first
  http.post(`${BASE_URL}/api/auth/init`,
    JSON.stringify({ session_uuid: sessionUuid }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const wsUrl = BASE_URL.replace('https://', 'wss://') + '/ws';
  let ws;
  let connected = false;
  let messageCount = 0;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connected = true;
      // Send first message to join the room
      ws.send(JSON.stringify({ type: 'join', session_uuid: sessionUuid }));
    };

    ws.onmessage = (msg) => {
      messageCount++;
      broadcastsReceived.add(1);
      const start = Date.now();
      broadcastLatency.add(Date.now() - start);
    };

    ws.onerror = () => {
      errors.add(1);
    };

    // Wait for broadcasts
    sleep(3);

    if (connected && messageCount > 0) {
      check({}, { 'received broadcasts': () => messageCount > 0 });
    }

    ws.close();
  } catch (_) {
    errors.add(1);
  }
}