import assert from 'node:assert/strict'
import test from 'node:test'
import { zohoCalApi, calendarHostFor, formatZohoStamp, freeBusy, refreshAccessToken } from '../src/core/zoho-calendar.js'

function stubFetch(handler) {
  const calls = []
  zohoCalApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts, calls.length)
  }
  return calls
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('calendarHostFor maps an accounts server to the Calendar host', () => {
  // The token response's api_domain is https://api.zoho.com, which is NOT the
  // Calendar host. The host is derived from the accounts server instead.
  assert.equal(calendarHostFor('https://accounts.zoho.com'), 'https://calendar.zoho.com')
  assert.equal(calendarHostFor('https://accounts.zoho.eu'), 'https://calendar.zoho.eu')
  assert.equal(calendarHostFor('https://accounts.zoho.com.au'), 'https://calendar.zoho.com.au')
})

test('calendarHostFor falls back to the US host when given nothing', () => {
  assert.equal(calendarHostFor(''), 'https://calendar.zoho.com')
  assert.equal(calendarHostFor(undefined), 'https://calendar.zoho.com')
})

test('formatZohoStamp emits the yyyyMMddTHHmmssZ shape Zoho requires', () => {
  assert.equal(formatZohoStamp('2026-09-14T13:05:00.000Z'), '20260914T130500Z')
})

test('refreshAccessToken posts to the stored accounts host', async () => {
  const calls = stubFetch(() => jsonResponse({ access_token: 'zat', expires_in: 3600 }))
  await refreshAccessToken({
    clientId: 'c', clientSecret: 's', refreshToken: 'rt',
    accountsHost: 'https://accounts.zoho.eu',
  })
  assert.equal(calls[0].url, 'https://accounts.zoho.eu/oauth/v2/token')
})

test('freeBusy requests the merged window and returns busy blocks', async () => {
  const calls = stubFetch(() =>
    jsonResponse({ freebusy: [{ startTime: '20260914T140000Z', endTime: '20260914T150000Z', fbtype: 'busy' }] }),
  )
  const result = await freeBusy({
    accessToken: 'zat', apiHost: 'https://calendar.zoho.com', accountEmail: 'owner@example.com',
    timeMin: '2026-09-14T00:00:00Z', timeMax: '2026-09-15T00:00:00Z',
  })
  assert.ok(calls[0].url.startsWith('https://calendar.zoho.com/api/v1/calendars/freebusy'))
  assert.ok(calls[0].url.includes('uemail=owner%40example.com'))
  assert.ok(calls[0].url.includes('ftype=eventbased'))
  assert.deepEqual(result.busy, [{ start: '2026-09-14T14:00:00.000Z', end: '2026-09-14T15:00:00.000Z' }])
  assert.deepEqual(result.errors, [])
})

test('freeBusy ignores entries that are not busy', async () => {
  stubFetch(() =>
    jsonResponse({
      freebusy: [
        { startTime: '20260914T140000Z', endTime: '20260914T150000Z', fbtype: 'busy' },
        { startTime: '20260914T160000Z', endTime: '20260914T170000Z', fbtype: 'free' },
      ],
    }),
  )
  const result = await freeBusy({
    accessToken: 'zat', apiHost: 'https://calendar.zoho.com', accountEmail: 'leo@x.com',
    timeMin: '2026-09-14T00:00:00Z', timeMax: '2026-09-15T00:00:00Z',
  })
  assert.equal(result.busy.length, 1)
})

test('freeBusy reports an error rather than returning empty busy on failure', async () => {
  // Returning [] on failure would read as "completely free" and hand out a slot
  // during a real conflict. The caller fails closed on a non-empty errors array.
  stubFetch(() => jsonResponse({ error: 'rate limited' }, 429))
  const result = await freeBusy({
    accessToken: 'zat', apiHost: 'https://calendar.zoho.com', accountEmail: 'leo@x.com',
    timeMin: '2026-09-14T00:00:00Z', timeMax: '2026-09-15T00:00:00Z',
  })
  assert.equal(result.busy.length, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].calendarId, 'zoho')
})

test('freeBusy chunks a long range and collects every window', async () => {
  const calls = stubFetch(() =>
    jsonResponse({ freebusy: [{ startTime: '20260914T140000Z', endTime: '20260914T150000Z', fbtype: 'busy' }] }),
  )
  const r = await freeBusy({
    accessToken: 'zat', apiHost: 'https://calendar.zoho.com', accountEmail: 'a@b.com',
    timeMin: '2026-09-01T00:00:00.000Z', timeMax: '2026-12-01T00:00:00.000Z',
  })
  assert.ok(calls.length > 1, 'a 91-day range must be chunked')
  assert.equal(r.busy.length, calls.length)
  assert.deepEqual(r.errors, [])
})

test('a chunked freeBusy fails closed if any window fails', async () => {
  // A partial answer would look like availability we cannot vouch for.
  let n = 0
  stubFetch(() => {
    n += 1
    return n === 2
      ? jsonResponse({ error: 'rate limited' }, 429)
      : jsonResponse({ freebusy: [] })
  })
  const r = await freeBusy({
    accessToken: 'zat', apiHost: 'https://calendar.zoho.com', accountEmail: 'a@b.com',
    timeMin: '2026-09-01T00:00:00.000Z', timeMax: '2026-12-01T00:00:00.000Z',
  })
  assert.equal(r.errors.length, 1)
  assert.equal(r.busy.length, 0, 'no partial busy data on failure')
})
