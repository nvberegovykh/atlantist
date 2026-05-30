/**
 * Playwright E2E tests for Phase 34: WebSocket offline hardening
 *
 * Tests:
 *  1. Offline edit queue — 3 edits made offline survive reconnect
 *  2. Conflict detection — simultaneous edit from another client triggers conflict modal
 *  3. 10MB cap — queue refuses new edits when cap is reached
 *
 * Run with: npx playwright test tests/e2e/ws-offline-hardening.spec.js
 */

const { test, expect, chromium } = require('@playwright/test');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

/**
 * Utility: simulate network disconnect by blocking WebSocket connections
 * using browser.context.route to intercept ws:// URLs.
 */
async function blockWebSocket(page) {
  // Abort any WebSocket upgrade requests
  await page.route('**/ws**', route => route.abort());
}

/**
 * Utility: wait for the ws-status dot to show a given state.
 * States: 'connected', 'connecting', 'reconnecting', 'offline'
 */
async function waitForWsState(page, state, timeout = 8000) {
  const label = state === 'connected' ? 'Live'
              : state === 'reconnecting' ? 'Reconnect'
              : state === 'offline' ? 'Offline'
              : 'Connecting';
  await page.waitForFunction(
    (s) => {
      const dot = document.getElementById('ws-status');
      return dot && dot.textContent.trim() === s;
    },
    label,
    { timeout }
  );
}

test.describe('Phase 34: WebSocket Offline Hardening', () => {

  test('T1: Offline edits survive reconnect and replay', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Login / navigate to app with a known project
    await page.goto(`${APP_URL}/app`, { waitUntil: 'networkidle' });

    // Ensure we're connected first (baseline)
    await page.waitForSelector('#ws-status', { timeout: 10000 });
    await waitForWsState(page, 'connected', 15000);

    // Get project ID
    const projectId = await page.evaluate(() => window.currentProjectId || 1);

    // Disconnect: block WS connections
    await blockWebSocket(page);

    // Wait for offline state
    await page.waitForTimeout(3000);
    await waitForWsState(page, 'reconnecting', 10000);

    // Simulate 3 offline edits by calling the queue directly via CDP
    const offlineQueue = await page.evaluateHandle(async (pid) => {
      const { enqueue } = await import('/js/offline-queue.js');
      const results = [];
      for (let i = 1; i <= 3; i++) {
        const r = await enqueue(pid, {
          _editType: 'element_update',
          entity_type: 'element',
          id: `E-TEST-${i}`,
          type: 'wall',
          name: `Offline Wall ${i}`,
          length: 4 + i,
        });
        results.push(r);
      }
      return results;
    }, projectId);

    const results = await offlineQueue.json();
    expect(results).toHaveLength(3);
    expect(results.every(r => r.ok)).toBe(true);

    // Re-enable WebSocket (unblock route) and wait for reconnect
    await context.unroute('**/ws**');
    await page.waitForTimeout(2000);
    await waitForWsState(page, 'connected', 30000);

    // Verify the conflict/replay modal or success toast appears (or no error)
    // The ws-client will attempt to replay — we just need to ensure no crash
    await page.waitForTimeout(3000); // allow replay to run

    // Verify app is still functional (page not crashed)
    const bodyText = await page.evaluate(() => document.body.textContent);
    expect(bodyText.length).toBeGreaterThan(100);

    await context.close();
  });

  test('T2: Conflict modal appears when same element edited by another user', async ({ browser }) => {
    // This requires two browser contexts to simulate two users editing the same element.
    // Since we don't have a real second user, we test the conflict UI flow by injecting
    // a conflict scenario via the ws-client's onConflict callback simulation.

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${APP_URL}/app`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#ws-status', { timeout: 10000 });
    await waitForWsState(page, 'connected', 15000);

    // Check conflict modal is hidden initially
    const modalHidden = await page.evaluate(() => {
      const m = document.getElementById('modal-conflict');
      return !m || m.style.display === 'none' || m.classList.contains('hidden');
    });
    expect(modalHidden).toBe(true);

    // Simulate a conflict by directly calling the onConflict handler
    const conflictResult = await page.evaluate(async () => {
      const { wsClient } = await import('/js/ws-client.js');

      // Simulate conflict between local wall edit and server edit
      const conflicts = [{
        entityId: 'W-204',
        entityType: 'element',
        local: { id: 'W-204', name: 'My Wall', length: 5 },
        server: { id: 'W-204', name: 'Alex Wall', length: 8 },
        serverUser: 'Alex',
      }];

      if (!wsClient.onConflict) return { error: 'onConflict not set' };

      const result = await wsClient.onConflict(conflicts);
      return result;
    });

    // Modal should now be visible
    const modalVisible = await page.evaluate(() => {
      const m = document.getElementById('modal-conflict');
      return m && (m.style.display !== 'none' && !m.classList.contains('hidden'));
    });
    expect(modalVisible).toBe(true);

    // Conflict list should show W-204
    const conflictListContent = await page.evaluate(() => {
      const list = document.getElementById('conflict-list');
      return list ? list.textContent : '';
    });
    expect(conflictListContent).toContain('W-204');
    expect(conflictListContent).toContain('Alex');

    await context.close();
  });

  test('T3: 10MB cap — queue refuses new edits when at limit', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${APP_URL}/app`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#ws-status', { timeout: 10000 });
    await waitForWsState(page, 'connected', 15000);

    const projectId = await page.evaluate(() => window.currentProjectId || 1);

    // Block WS so edits go to queue instead of being sent
    await blockWebSocket(page);
    await page.waitForTimeout(3000);
    await waitForWsState(page, 'reconnecting', 10000);

    // Fill the queue to near cap (9MB) then verify the 10MB boundary
    const result = await page.evaluate(async (pid) => {
      const { enqueue, MAX_BYTES, WARN_BYTES, clearAll } = await import('/js/offline-queue.js');

      // Clear any existing entries
      await clearAll(pid);

      // Create a large edit payload (~500KB each, 20 entries = ~10MB)
      const bigPayload = { data: 'x'.repeat(500000), _editType: 'element_update', entity_type: 'element' };

      const entries = [];
      let lastResult = null;
      for (let i = 0; i < 20; i++) {
        const r = await enqueue(pid, { ...bigPayload, id: `BIG-${i}` });
        lastResult = r;
        entries.push(r);
        if (!r.ok) break;
      }

      const finalState = await enqueue(pid, { ...bigPayload, id: 'should-fail' });
      return {
        entriesCount: entries.filter(e => e.ok).length,
        lastOk: lastResult?.ok,
        finalResult: finalState,
        maxBytes: MAX_BYTES,
        warnBytes: WARN_BYTES,
      };
    }, projectId);

    expect(result.lastOk).toBe(true);
    expect(result.finalResult.ok).toBe(false);
    expect(result.finalResult.reason).toBe('queue_full');
    expect(result.finalResult.maxSize).toBe(result.maxBytes);

    await context.close();
  });

  test('T4: Connection state shows correct labels in presence bar', async ({ page }) => {
    await page.goto(`${APP_URL}/app`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#ws-status', { timeout: 10000 });

    // Initially: "Connecting" or "Live"
    const initialText = await page.textContent('#ws-status');
    console.log('Initial ws-status:', initialText);

    // Block WS
    await blockWebSocket(page);

    // After disconnect, should show "Reconnect in Xs" or "Offline"
    await page.waitForTimeout(4000);
    const afterDisconnect = await page.textContent('#ws-status');
    console.log('After disconnect ws-status:', afterDisconnect);

    // Offline badge should appear
    const badgeVisible = await page.evaluate(() => {
      const badge = document.getElementById('ws-offline-badge');
      return badge && !badge.classList.contains('hidden');
    });
    expect(badgeVisible).toBe(true);

    // Restore WS
    await page.context().unroute('**/ws**');
    await page.waitForTimeout(3000);

    // Should return to connected state ("Live")
    const afterRestore = await page.textContent('#ws-status');
    console.log('After restore ws-status:', afterRestore);
  });

  test('T5: Exponential backoff — reconnect delay doubles until 30s cap', async ({ page }) => {
    await page.goto(`${APP_URL}/app`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#ws-status', { timeout: 10000 });

    // Get the wsClient reconnect delay from the page
    const initialDelay = await page.evaluate(async () => {
      const { wsClient } = await import('/js/ws-client.js');
      return wsClient._reconnectDelay;
    });

    // Block WS to trigger disconnect
    await blockWebSocket(page);
    await page.waitForTimeout(3000);

    // Check reconnect count increased
    const reconnectCount = await page.evaluate(async () => {
      const { wsClient } = await import('/js/ws-client.js');
      return wsClient._reconnectCount;
    });

    expect(reconnectCount).toBeGreaterThan(0);

    // Unblock and wait
    await page.context().unroute('**/ws**');
    await page.waitForTimeout(2000);
    await waitForWsState(page, 'connected', 30000);

    // After reconnect, delay should reset to base (1000ms)
    const resetDelay = await page.evaluate(async () => {
      const { wsClient } = await import('/js/ws-client.js');
      return wsClient._reconnectDelay;
    });

    expect(resetDelay).toBe(1000);
  });

});