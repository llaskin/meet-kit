import assert from 'node:assert/strict'
import test from 'node:test'
import { onRequestGet, onRequestPut } from '../src/handlers/admin-calendars.js'

function fakeDB(connections = [], selections = []) {
  // Deep-copy each row. A shallow [...selections] shares the row OBJECTS with
  // the module-level fixture, so one test flipping busy to 0 in place would
  // corrupt the next test's starting state.
  const rows = selections.map((r) => ({ ...r }))
  return {
    rows,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this },
        async all() {
          if (this.sql.includes('FROM calendar_connections')) return { results: connections }
          return { results: rows.filter((r) => r.connection_id === this.args[0]) }
        },
        async first() { return null },
        async run() {
          if (this.sql.startsWith('UPDATE calendar_selections')) {
            const [busy, connId, calendarId] = this.args
            const row = rows.find((r) => r.connection_id === connId && r.calendar_id === calendarId)
            if (row) row.busy = busy
          }
          return { success: true }
        },
      }
    },
  }
}

const CONNS = [
  { connection_id: 'google:owner@example.com', provider: 'google', role: 'write', account_email: 'owner@example.com' },
  { connection_id: 'google:work@example.com', provider: 'google', role: 'busy', account_email: 'work@example.com' },
]

const SELECTIONS = [
  { connection_id: 'google:owner@example.com', calendar_id: 'owner@example.com', name: 'Owner calendar', busy: 1 },
  { connection_id: 'google:work@example.com', calendar_id: 'work@example.com', name: 'Work calendar', busy: 1 },
  { connection_id: 'google:work@example.com', calendar_id: 'masonic@group', name: 'Masonic', busy: 0 },
]

test('GET groups calendars under their connection and flags the write account', async () => {
  const body = await (await onRequestGet({ env: { DB: fakeDB(CONNS, SELECTIONS) } })).json()
  assert.equal(body.connections.length, 2)
  assert.equal(body.connections[0].writesEvents, true)
  assert.equal(body.connections[1].writesEvents, false)
  assert.equal(body.connections[1].calendars.length, 2)
  assert.equal(body.connections[1].calendars.find((c) => c.name === 'Masonic').busy, false)
})

test('PUT flips a calendar off on the connection it names', async () => {
  const db = fakeDB(CONNS, SELECTIONS)
  const res = await onRequestPut({
    request: new Request('https://x/api/calendar/calendars', {
      method: 'PUT',
      body: JSON.stringify({ calendars: [{ connectionId: 'google:work@example.com', calendarId: 'work@example.com', busy: false }] }),
    }),
    env: { DB: db },
  })
  assert.equal(res.status, 200)
  assert.equal(db.rows.find((r) => r.calendar_id === 'work@example.com').busy, 0)
})

test('PUT without a connectionId changes nothing', async () => {
  // The same calendar id can appear under two accounts; an unqualified update
  // could unblock a calendar the operator meant to keep.
  const db = fakeDB(CONNS, SELECTIONS)
  await onRequestPut({
    request: new Request('https://x/api/calendar/calendars', {
      method: 'PUT',
      body: JSON.stringify({ calendars: [{ calendarId: 'work@example.com', busy: false }] }),
    }),
    env: { DB: db },
  })
  assert.equal(db.rows.find((r) => r.calendar_id === 'work@example.com').busy, 1)
})

test('PUT rejects a malformed body', async () => {
  const res = await onRequestPut({
    request: new Request('https://x/api/calendar/calendars', { method: 'PUT', body: 'nope' }),
    env: { DB: fakeDB() },
  })
  assert.equal(res.status, 400)
})
