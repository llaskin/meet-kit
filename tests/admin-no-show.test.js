import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { realDB } from './helpers/d1.js'
import { savePublicBooking } from '../src/core/public-bookings.js'
import { webhookApi } from '../src/core/booking-webhook.js'
import { onRequestPost } from '../src/handlers/admin-no-show.js'

const OWNER = 'owner@example.com'
const HOOK = { BOOKING_WEBHOOK_URL: 'https://example.com/hooks/meet', BOOKING_WEBHOOK_SECRET: 'shh' }
const ENV = (db) => ({ DB: db, ...HOOK })

const PAST = { startUtc: '2026-10-01T15:00:00.000Z', endUtc: '2026-10-01T15:30:00.000Z' }
const FUTURE = { startUtc: '2099-01-01T15:00:00.000Z', endUtc: '2099-01-01T15:30:00.000Z' }

async function seed(when = PAST) {
  const db = realDB()
  const id = await savePublicBooking(db, { email: 'v@example.org', capIdentity: 'v@example.org', durationMinutes: 30,
    ...when, eventId: 'e1', meetUrl: 'https://meet.google.com/u', meetUrlSource: 'unique', calendarId: OWNER,
    topic: 'Audit review', notes: 'private stuff', clientIp: '203.0.113.9' })
  return { db, id }
}

function hookStub() {
  const hooks = []
  webhookApi.fetch = async (url, opts) => { hooks.push({ url, opts }); return new Response(null, { status: 204 }) }
  return hooks
}
const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o } }
const req = (body) => new Request('https://x.test', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

async function mark(db, body, env = ENV(db)) {
  const pending = []
  const res = await onRequestPost({ request: req(body), env, owner: OWNER, waitUntil: (p) => pending.push(p) })
  await Promise.all(pending)
  return { res, pending }
}

// --- Validation before any DB call -----------------------------------------

const noTouchDB = () => ({
  prepare() { throw new Error('DB touched before id validation') },
  batch() { throw new Error('DB touched before id validation') },
})

for (const id of ['', 'a'.repeat(65), 'abc def', "x' OR 1=1--", '../etc', 42, ['a'], { a: 1 }, null]) {
  test(`no-show rejects id ${JSON.stringify(id)} with 400 before touching the DB`, async () => {
    const hooks = hookStub()
    const { res } = await mark(noTouchDB(), { id })
    assert.equal(res.status, 400)
    assert.equal(hooks.length, 0)
  })
}

test('no-show rejects a non-JSON body with 400 before touching the DB', async () => {
  const { res } = await mark(noTouchDB(), 'not json')
  assert.equal(res.status, 400)
})

// --- Outcomes ------------------------------------------------------------------

test('unknown id -> 404, no event', async () => {
  const db = realDB()
  const hooks = hookStub()
  const { res } = await mark(db, { id: 'a-'.repeat(32) })
  assert.equal(res.status, 404)
  assert.equal(hooks.length, 0)
})

test('a meeting that has not started -> 409, nothing written, no event', async () => {
  const { db, id } = await seed(FUTURE)
  const hooks = hookStub()
  const { res } = await mark(db, { id })
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { error: 'That call has not started yet' })
  assert.equal(db.raw.prepare('SELECT no_show_at FROM public_bookings WHERE id = ?').get(id).no_show_at, null)
  assert.equal(hooks.length, 0)
})

test('a past meeting is stamped with the owner, and booking.no_show is emitted exactly once', async () => {
  const { db, id } = await seed()
  const hooks = hookStub()
  const restore = quiet()
  try {
    const { res, pending } = await mark(db, { id })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    const row = db.raw.prepare('SELECT * FROM public_bookings WHERE id = ?').get(id)
    assert.ok(row.no_show_at && !Number.isNaN(Date.parse(row.no_show_at)))
    assert.equal(row.no_show_by, OWNER)

    assert.equal(pending.length, 1)
    assert.equal(hooks.length, 1)
    const { opts } = hooks[0]
    assert.equal(opts.headers['X-Meet-Event'], 'booking.no_show')
    assert.equal(opts.headers['X-Meet-Signature-256'],
      createHmac('sha256', HOOK.BOOKING_WEBHOOK_SECRET).update(opts.body, 'utf8').digest('hex'))
    const body = JSON.parse(opts.body)
    assert.equal(body.type, 'booking.no_show')
    assert.equal(body.id, id)
    assert.equal(body.booking.id, id)
    assert.equal(body.booking.attendee_email, 'v@example.org')
    assert.equal(body.booking.topic, 'Audit review')
    assert.equal(body.booking.no_show_at, row.no_show_at)
    assert.equal(body.booking.no_show_by, OWNER)
    assert.equal('notes' in body.booking, false)
    assert.equal('client_ip' in body.booking, false)
    assert.ok(!opts.body.includes('private stuff'))
    assert.ok(!opts.body.includes('203.0.113.9'))
  } finally { restore() }
})

test('marking twice: second call is 200 {ok, already:true}, keeps the first stamp, emits nothing', async () => {
  const { db, id } = await seed()
  const hooks = hookStub()
  const restore = quiet()
  try {
    await mark(db, { id })
    const first = db.raw.prepare('SELECT no_show_at, no_show_by FROM public_bookings WHERE id = ?').get(id)
    assert.equal(hooks.length, 1)

    const pending = []
    const res = await onRequestPost({ request: req({ id }), env: ENV(db), owner: 'other@example.com', waitUntil: (p) => pending.push(p) })
    await Promise.all(pending)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, already: true })
    assert.equal(hooks.length, 1, 'no second event')
    assert.deepEqual(db.raw.prepare('SELECT no_show_at, no_show_by FROM public_bookings WHERE id = ?').get(id), first)
  } finally { restore() }
})

test('a failing DB read -> 500 JSON, no event', async () => {
  const { db, id } = await seed()
  const hooks = hookStub()
  const broken = { ...db, prepare(sql) { if (sql.includes('FROM public_bookings')) throw new Error('D1 down'); return db.prepare(sql) } }
  const { res } = await mark(broken, { id })
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: 'Could not mark the booking' })
  assert.equal(hooks.length, 0)
})

test('webhook unconfigured: the mark still succeeds and nothing is sent', async () => {
  const { db, id } = await seed()
  const hooks = hookStub()
  const { res } = await mark(db, { id }, { DB: db })
  assert.equal(res.status, 200)
  assert.equal(hooks.length, 0)
})
