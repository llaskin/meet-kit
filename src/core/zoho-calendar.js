// Zoho Calendar API v1, read-only. Zoho is a busy-time source only: it never
// receives an event. See the spec's "Zoho's role" decision.
export const zohoCalApi = {
  fetch: (...args) => fetch(...args),
}

// Read-only scopes. freebusy.READ is what the double-booking guard needs;
// calendar.READ is only used to discover the account email at connect time.
export const ZOHO_SCOPES = 'ZohoCalendar.calendar.READ,ZohoCalendar.freebusy.READ'

/**
 * Derive the Calendar host from the accounts server.
 *
 * Do NOT use the token response's `api_domain`: it returns https://api.zoho.com,
 * which is not where Calendar lives. Zoho's regional hosts mirror the accounts
 * server's TLD (accounts.zoho.eu -> calendar.zoho.eu).
 */
export function calendarHostFor(accountsHost) {
  if (!accountsHost) return 'https://calendar.zoho.com'
  return accountsHost.replace('//accounts.', '//calendar.')
}

export function buildAuthUrl({ clientId, redirectUri, state, accountsHost = 'https://accounts.zoho.com' }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ZOHO_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${accountsHost}/oauth/v2/auth?${params}`
}

async function tokenRequest(accountsHost, form) {
  const res = await zohoCalApi.fetch(`${accountsHost}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(`Zoho token request failed: ${body.error || res.status}`)
  }
  return body
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, accountsHost }) {
  const body = await tokenRequest(accountsHost, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  }
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken, accountsHost }) {
  const body = await tokenRequest(accountsHost, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  }
}

/** Zoho wants yyyyMMdd'T'HHmmss'Z' with no punctuation. */
export function formatZohoStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function parseZohoStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString()
}

/** List calendars. Used at connect time to discover the account email. */
export async function listCalendars({ accessToken, apiHost }) {
  const res = await zohoCalApi.fetch(`${apiHost}/api/v1/calendars`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Zoho calendars failed: ${res.status}`)
  const body = await res.json()
  return (body.calendars || []).map((c) => ({ id: c.uid, name: c.name, email: c.email }))
}

/**
 * Busy blocks from Zoho.
 *
 * Zoho's free/busy endpoint has NO per-calendar filter — it returns the user's
 * calendars merged. That is why there are no Zoho checkboxes in the UI.
 *
 * KNOWN UNVERIFIED BEHAVIOUR: the sdate/edate params carry no offset and Zoho
 * never documents which timezone they are read in. We send an explicit trailing
 * Z. Before trusting this in production, create a Zoho event at a known time and
 * confirm the returned block lines up (see the plan's Task 13 verification).
 */
// Zoho documents no maximum span for free/busy. Its EVENTS endpoint documents a
// hard 31-day cap, and while that limit provably belongs to the other endpoint,
// an unstated cap here is plausible enough that chunking is cheaper than
// discovering it as zero availability mid-call.
const FREEBUSY_MAX_DAYS = 30

export async function freeBusy({ accessToken, apiHost, accountEmail, timeMin, timeMax }) {
  const span = FREEBUSY_MAX_DAYS * 86_400_000
  const end = Date.parse(timeMax)
  if (Date.parse(timeMax) - Date.parse(timeMin) > span) {
    const busy = []
    for (let s = Date.parse(timeMin); s < end; s += span) {
      const part = await freeBusy({
        accessToken, apiHost, accountEmail,
        timeMin: new Date(s).toISOString(),
        timeMax: new Date(Math.min(s + span, end)).toISOString(),
      })
      // Fail closed on the first bad window: a partial answer would look like
      // availability we cannot actually vouch for.
      if (part.errors.length) return part
      busy.push(...part.busy)
    }
    return { busy, errors: [] }
  }

  const params = new URLSearchParams({
    uemail: accountEmail,
    sdate: formatZohoStamp(timeMin),
    edate: formatZohoStamp(timeMax),
    ftype: 'eventbased',
  })
  let res
  try {
    res = await zohoCalApi.fetch(`${apiHost}/api/v1/calendars/freebusy?${params}`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    })
  } catch (err) {
    return { busy: [], errors: [{ calendarId: 'zoho', reason: String(err.message || err) }] }
  }

  if (!res.ok) {
    // Never return an empty busy list on failure: that reads as "free" and
    // would hand out a slot during a real conflict.
    return { busy: [], errors: [{ calendarId: 'zoho', reason: `http_${res.status}` }] }
  }

  const body = await res.json().catch(() => ({}))
  const busy = []
  for (const entry of body.freebusy || []) {
    if (entry.fbtype && entry.fbtype !== 'busy') continue
    const start = parseZohoStamp(entry.startTime)
    const end = parseZohoStamp(entry.endTime)
    if (start && end) busy.push({ start, end })
  }
  return { busy, errors: [] }
}
