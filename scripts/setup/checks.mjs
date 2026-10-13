// Validators for what the person pastes into the setup wizard, and parsers
// for wrangler's output. Pure functions: no I/O, so they are unit-tested
// directly (tests/setup-checks.test.js).

export const REQUIRED_TABLES = Object.freeze([
  'calendar_config', 'calendar_connections', 'calendar_selections',
  'public_bookings', 'public_bookings_cancelled', 'rate_counters',
])

const str = (v) => (typeof v === 'string' ? v : '')

export function isEmail(v) {
  const s = str(v)
  return s.length > 0 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

export function isHttpsUrlOrEmpty(v) {
  const s = str(v)
  if (s === '') return true
  try {
    return new URL(s).protocol === 'https:' && /^https:\/\//i.test(s)
  } catch {
    return false
  }
}

export const isHexColor = (v) => /^#[0-9a-fA-F]{6}$/.test(str(v))

export const isGoogleClientId = (v) => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(str(v))

// Real site keys start with 0x. Cloudflare's documented test keys (1x…, 2x…,
// 3x…) always pass or always fail, so they are refused here.
export const isTurnstileSiteKey = (v) => /^0x[A-Za-z0-9_-]{16,}$/.test(str(v))

// Accepts "team", "team.cloudflareaccess.com" or the full https URL and
// returns the canonical "https://team.cloudflareaccess.com", or null.
export function normalizeTeamDomain(v) {
  let s = str(v).trim().toLowerCase().replace(/\/+$/, '')
  if (s.startsWith('http://')) return null
  s = s.replace(/^https:\/\//, '').replace(/\.cloudflareaccess\.com$/, '')
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return null
  return `https://${s}.cloudflareaccess.com`
}

export const isAud = (v) => /^[0-9a-f]{64}$/.test(str(v))

// Wrangler can print a banner before its JSON; take the outermost JSON value.
function extractJson(text) {
  const s = str(text)
  try {
    return JSON.parse(s)
  } catch {}
  const start = s.search(/[[{]/)
  if (start < 0) return undefined
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function parseWhoami(code, stdout) {
  const j = code === 0 ? extractJson(stdout) : undefined
  if (!j || j.loggedIn !== true) return { loggedIn: false, accounts: [] }
  const accounts = Array.isArray(j.accounts)
    ? j.accounts.filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, name: str(a.name) }))
    : []
  return { loggedIn: true, email: str(j.email), accounts }
}

export function findDatabaseId(stdout, name) {
  const list = extractJson(stdout)
  if (!Array.isArray(list)) return null
  const db = list.find((d) => d && d.name === name)
  return db && typeof db.uuid === 'string' ? db.uuid : null
}

export function parseTableNames(stdout) {
  const j = extractJson(stdout)
  if (!Array.isArray(j)) return []
  return j.flatMap((r) => (Array.isArray(r?.results) ? r.results : [])).map((row) => str(row?.name)).filter(Boolean)
}

export function parseSecretNames(stdout) {
  const j = extractJson(stdout)
  return Array.isArray(j) ? j.map((s) => str(s?.name)).filter(Boolean) : []
}

export function parseDeployUrl(output) {
  const m = str(output).match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i)
  return m ? m[0] : null
}

export function subdomainOnboardingLink(output) {
  const m = str(output).match(/https:\/\/dash\.cloudflare\.com\/[0-9a-f]+\/workers\/onboarding/i)
  return m ? m[0] : null
}

// node --test prints "ℹ tests N" (spec reporter) or "# tests N" (TAP).
export function parseTestSummary(output) {
  const pick = (k) => {
    const m = str(output).match(new RegExp(`^(?:ℹ|#) ${k} (\\d+)$`, 'm'))
    return m ? Number(m[1]) : null
  }
  const tests = pick('tests'), pass = pick('pass'), fail = pick('fail')
  return tests === null || pass === null || fail === null ? null : { tests, pass, fail }
}
