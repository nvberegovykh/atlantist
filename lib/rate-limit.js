/**
 * Redis-backed rate limiter middleware factory.
 * Uses sliding window counter via Redis INCR + EXPIRE.
 * Falls back gracefully (allows request) if Redis is unavailable.
 *
 * Usage:
 *   const { rateLimit } = require('./lib/rate-limit');
 *   router.post('/login', rateLimit({ max: 10, windowSec: 60 }), handler);
 */

'use strict';

let _redis = null;

function _getRedis() {
  if (_redis) return _redis;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    client.connect().catch(err => {
      console.warn('[rate-limit] Redis connect failed — rate limiting disabled:', err.message);
      _redis = null;
    });
    client.on('error', err => console.warn('[rate-limit] Redis error:', err.message));
    _redis = client;
  } catch (e) {
    console.warn('[rate-limit] Redis unavailable — rate limiting disabled:', e.message);
  }
  return _redis;
}

/**
 * @param {object} opts
 * @param {number} opts.max        — max requests per window
 * @param {number} opts.windowSec  — window length in seconds
 * @param {string} [opts.keyPrefix] — redis key prefix (default: 'rl')
 * @param {function} [opts.keyFn]  — fn(req) → string key discriminator (default: IP)
 * @returns Express middleware
 */
function rateLimit({ max, windowSec, keyPrefix = 'rl', keyFn }) {
  return async function rateLimitMiddleware(req, res, next) {
    const redis = _getRedis();
    if (!redis || !redis.isReady) return next(); // graceful degradation

    const discriminator = keyFn ? keyFn(req) : (req.ip || 'unknown');
    // keyFn returning null means "skip rate limiting for this request"
    if (discriminator === null) return next();
    const key = `${keyPrefix}:${discriminator}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        // First hit — set expiry
        await redis.expire(key, windowSec);
      }
      if (count > max) {
        res.set('Retry-After', String(windowSec));
        return res.status(429).json({
          error: 'Too many requests. Please try again later.',
          retry_after: windowSec,
        });
      }
      // Attach rate limit headers for observability
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      next();
    } catch (err) {
      console.warn('[rate-limit] Redis op failed — allowing request:', err.message);
      next(); // never block on Redis failure
    }
  };
}

module.exports = { rateLimit };
