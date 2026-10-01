import * as store from '../core/calendar-store.js'

// cfg key -> Worker env name. Core code reads cfg.google_client_secret etc.;
// this is the ONLY place those values are sourced, and it sources them from
// Worker vars/secrets. Any copy found in D1 is discarded.
export const ENV_KEYS = {
  google_client_id: 'GOOGLE_CLIENT_ID',
  google_client_secret: 'GOOGLE_CLIENT_SECRET',
  zoho_client_id: 'ZOHO_CLIENT_ID',
  zoho_client_secret: 'ZOHO_CLIENT_SECRET',
}

export async function loadCfg(db, env) {
  const cfg = await store.getConfig(db)
  for (const [key, envName] of Object.entries(ENV_KEYS)) cfg[key] = env?.[envName] || ''
  return cfg
}
