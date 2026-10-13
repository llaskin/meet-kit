// The template's own wrangler.jsonc, as shipped. Tests must not read the live
// file and assume it is pristine: `npm run setup` (or a hand edit) fills in the
// deployer's OWNER_EMAIL, database id, client ids, and so on, and the setup
// wizard runs this suite right after doing that.
import { readFileSync } from 'node:fs'
import { setString } from '../../scripts/setup/config-files.mjs'

const BLANK_VARS = ['OWNER_EMAIL', 'GOOGLE_CLIENT_ID', 'ZOHO_CLIENT_ID', 'TURNSTILE_SITE_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']

export function pristineWrangler(text) {
  let out = setString(text, 'database_id', 'REPLACE_WITH_D1_ID')
  for (const k of BLANK_VARS) out = setString(out, k, '')
  return out
}

export const readPristineWrangler = () =>
  pristineWrangler(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'))
