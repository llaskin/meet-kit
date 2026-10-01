// What the public page needs to render itself. Nothing here is secret: the
// Turnstile SITE key is public by design; the secret key never leaves env.
export async function onRequestGet({ env, site }) {
  return Response.json({ ...site, turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
