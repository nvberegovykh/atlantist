/**
 * Owns: Wallt Auto-Recovery global error handlers.
 * Does NOT own: auto-recovery logic (services/wallt-auto-recovery.js).
 *
 * Wires uncaughtException and unhandledRejection to wallt-auto-recovery.js
 * crash signal handler. This module is required once at startup.
 */

let autoRecovery = null;

function getRecovery() {
  if (!autoRecovery) {
    autoRecovery = require('./wallt-auto-recovery');
  }
  return autoRecovery;
}

// ── Global error handlers ────────────────────────────────────────────────────

/**
 * uncaughtException — catches synchronous throws in any async code.
 * Calls handleCrashSignal → escalation → human review. Does NOT recover.
 * After logging, the process should exit (Node.js recommendation).
 */
process.on('uncaughtException', (err, origin) => {
  console.error('[wallt-auto-recovery] UNCAUGHT EXCEPTION:', err.message);
  if (err.stack) console.error('[wallt-auto-recovery] Stack:', err.stack);

  getRecovery().handleCrashSignal({
    error:  err,
    source: 'wallt:uncaught-exception',
  }).catch(e => console.error('[wallt-auto-recovery] crash signal failed:', e.message));

  // Let the process terminate as Node.js recommends after uncaughtException
  setTimeout(() => {
    console.error('[wallt-auto-recovery] Exiting after uncaughtException (Node.js recommendation)');
    process.exit(1);
  }, 2000);
});

/**
 * unhandledRejection — catches rejected promises that propagate without a .catch().
 * Not fatal to the process, but logged and escalated if in Wallt scope.
 */
process.on('unhandledRejection', (reason, promise) => {
  // Only escalate if the rejection appears to be in Wallt scope
  const isWalltRejection =
    reason instanceof Error &&
    (reason.message.includes('wallt') ||
     reason.message.includes('OpenAI') ||
     reason.message.includes('wallt-escalation') ||
     reason.message.includes('wallt-session'));

  if (isWalltRejection) {
    console.warn('[wallt-auto-recovery] UNHANDLED REJECTION (Wallt scope):', reason?.message);
    getRecovery().handleCrashSignal({
      error:  reason instanceof Error ? reason : new Error(String(reason)),
      source: 'wallt:unhandled-rejection',
    }).catch(e => console.warn('[wallt-auto-recovery] crash signal failed:', e.message));
  } else {
    console.warn('[wallt-auto-recovery] UNHANDLED REJECTION (non-Wallt):', reason?.message);
  }
});

console.log('[wallt-auto-recovery] Global error handlers registered');