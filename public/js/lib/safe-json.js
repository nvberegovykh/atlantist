/**
 * Safe JSON parse helper.
 * Throws on non-2xx OR non-JSON Content-Type so the caller gets a real error
 * instead of cryptic "Unexpected token <" from HTML bodies (login redirects,
 * error pages, misrouted requests returning the SPA shell).
 */
export async function safeParseResponse(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `HTTP ${res.status} from ${res.url} — body: ${text.substring(0, 200)}`
    );
  }
  const ct = (res.headers.get('content-type') || '');
  if (!ct.includes('application/json') && !ct.includes('+json')) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Expected JSON from ${res.url} but Content-Type is "${ct}" — body: ${body.substring(0, 200)}`
    );
  }
  return res.json();
}