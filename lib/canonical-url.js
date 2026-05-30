/**
 * Canonical URL config — single source of truth for the public domain.
 * Every server-side route that builds an absolute URL should import this
 * instead of reading env vars or hardcoding a domain.
 *
 * WHY: The app is reachable on multiple hosts (atlantist.cloud, nexaxis.polsia.app,
 * atlantist.polsia.app) but ALL generated URLs must use the canonical domain
 * for SEO, social sharing, and brand consistency.
 */

const CANONICAL_ORIGIN = 'https://atlantist.cloud';

/**
 * Build a full canonical URL from a path.
 * @param {string} [path='/'] — must start with /
 * @returns {string} e.g. "https://atlantist.cloud/blog/my-post"
 */
function canonicalUrl(path = '/') {
  return `${CANONICAL_ORIGIN}${path}`;
}

module.exports = { CANONICAL_ORIGIN, canonicalUrl };
