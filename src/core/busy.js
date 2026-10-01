import * as store from './calendar-store.js'
import * as google from './google-calendar.js'
import * as zoho from './zoho-calendar.js'
import { accessTokenFor } from './booking-core.js'

/**
 * Gather busy time across every connection, regardless of role. The write
 * account's own calendars, every read-only busy account's calendars, and
 * Zoho all contribute conflicts equally.
 *
 * Extracted from functions/api/calendar/slots.js so the authenticated and
 * public handlers share ONE implementation of the fail-closed conflict
 * logic -- a second copy is exactly how a safety property silently rots.
 *
 * Returns { busy, errors }. Callers decide what to do with `errors`: the
 * authenticated handler surfaces connection ids, account emails and raw
 * upstream reasons to the operator; the public handler must never do that
 * and should collapse any non-empty `errors` into an empty slot list.
 */
export async function gatherBusy({ db, cfg, fromDay, rules }) {
  // Query window: from the start of fromDay through the horizon, padded a day
  // each side so events straddling a boundary are still seen.
  const timeMin = new Date(Date.parse(`${fromDay}T00:00:00Z`) - 86_400_000).toISOString()
  const timeMax = new Date(
    Date.parse(`${fromDay}T00:00:00Z`) + (rules.horizonDays + 1) * 86_400_000,
  ).toISOString()

  const busy = []
  const errors = []

  const connections = await store.getAllConnections(db)

  for (const conn of connections) {
    const label = conn.account_email || conn.connection_id
    try {
      const accessToken = await accessTokenFor(db, cfg, conn)

      if (conn.provider === 'google') {
        const selections = await store.getSelections(db, conn.connection_id)
        const selectedIds = selections.filter((sel) => sel.busy === 1).map((sel) => sel.calendar_id)
        // Every calendar deliberately unchecked is not a failure; skip quietly.
        if (selectedIds.length === 0) continue
        const result = await google.freeBusy(accessToken, selectedIds, timeMin, timeMax)
        busy.push(...result.busy)
        for (const e of result.errors) {
          const name = selections.find((sel) => sel.calendar_id === e.calendarId)?.name
          errors.push({ ...e, name: name || e.calendarId, account: label })
        }
      } else {
        // Zoho has NO selection rows by design: its free/busy endpoint has no
        // per-calendar filter and always returns every calendar merged. Zero
        // selections here means "query the merged endpoint", never "skip".
        const result = await zoho.freeBusy({
          accessToken,
          apiHost: conn.api_host || 'https://calendar.zoho.com',
          accountEmail: conn.account_email,
          timeMin,
          timeMax,
        })
        busy.push(...result.busy)
        for (const e of result.errors) {
          errors.push({ ...e, name: `Zoho (${label})`, account: label })
        }
      }
    } catch (err) {
      errors.push({
        calendarId: conn.connection_id,
        name: label,
        account: label,
        reason: String(err.message || err),
      })
    }
  }

  return { busy, errors }
}
