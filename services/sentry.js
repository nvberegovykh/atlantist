/**
 * services/sentry.js
 * Owns: Sentry SDK init, Express request handler, Express error handler,
 *       and a captureException helper usable anywhere in the app.
 *
 * Design: fully no-op when SENTRY_DSN is unset (dev / CI / test).
 * Wire order in server.js:
 *   1. const sentry = require('./services/sentry');
 *   2. sentry.init(app)                     ← before any routes
 *   3. app.use(sentry.requestHandler())     ← first middleware
 *   4. app.use(sentry.traceHandler())       ← after requestHandler
 *   ... all routes ...
 *   5. app.use(sentry.errorHandler())       ← before global error handler
 *   6. app.use((err, req, res, next) => {}) ← existing global error handler
 */

'use strict';

let Sentry = null;
let initialized = false;

function init(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN not set — Sentry disabled (no-op mode)');
    return;
  }

  try {
    Sentry = require('@sentry/node');

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || undefined,

      // Performance: 10% of requests traced in prod, 100% in dev
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

      // Integrations: http, postgres, redis auto-instrumented
      integrations: [
        // Express integration wired below via requestHandler / errorHandler
        Sentry.expressIntegration({ app }),
      ],

      // Don't leak internal stack traces to Sentry for known non-errors
      ignoreErrors: [
        'ECONNRESET',
        'EPIPE',
        'AbortError',
      ],

      beforeSend(event) {
        // Strip any PII from request data before sending to Sentry
        if (event.request) {
          delete event.request.cookies;
          if (event.request.headers) {
            delete event.request.headers['authorization'];
            delete event.request.headers['cookie'];
          }
        }
        return event;
      },
    });

    initialized = true;
    console.log(`[sentry] Initialized — env=${process.env.NODE_ENV}, release=${process.env.RENDER_GIT_COMMIT || 'local'}`);
  } catch (err) {
    // @sentry/node not installed yet — graceful no-op
    console.warn('[sentry] @sentry/node not installed, running without error tracking:', err.message);
    Sentry = null;
  }
}

/** First middleware — attach Sentry request context */
function requestHandler() {
  if (!initialized || !Sentry) return (_req, _res, next) => next();
  return Sentry.expressRequestHandler();
}

/** After requestHandler — performance tracing */
function traceHandler() {
  if (!initialized || !Sentry) return (_req, _res, next) => next();
  return Sentry.expressTracingHandler();
}

/**
 * Error handler — MUST be placed before your own error handler.
 * It calls next(err) after capturing, so your handler still fires.
 */
function errorHandler() {
  if (!initialized || !Sentry) return (_err, _req, _res, next) => next(_err);
  return Sentry.expressErrorHandler({
    // Only capture 5xx; 4xx are client errors, not bugs
    shouldHandleError(error) {
      const status = error.status || error.statusCode || 500;
      return status >= 500;
    },
  });
}

/**
 * Manual capture — use in catch blocks for non-Express async paths.
 * Safe to call even when Sentry is disabled.
 *
 * @param {Error} err
 * @param {object} [context] — extra tags/data to attach
 */
function captureException(err, context = {}) {
  if (!initialized || !Sentry) {
    console.error('[error]', err?.message || err, context);
    return;
  }
  Sentry.withScope(scope => {
    if (context.user) scope.setUser(context.user);
    if (context.tags) Object.entries(context.tags).forEach(([k, v]) => scope.setTag(k, v));
    if (context.extra) Object.entries(context.extra).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(err);
  });
}

/**
 * Set user context for the current request (call after auth middleware).
 * No-op when Sentry disabled.
 */
function setUser(userId, email) {
  if (!initialized || !Sentry) return;
  Sentry.setUser({ id: String(userId), email });
}

module.exports = { init, requestHandler, traceHandler, errorHandler, captureException, setUser };
