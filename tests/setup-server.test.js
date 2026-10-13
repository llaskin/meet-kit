import assert from 'node:assert/strict'
import test from 'node:test'
import { request as httpRequest } from 'node:http'
import { createWizardServer } from '../scripts/setup/server.mjs'

const TOKEN = 'b'.repeat(64)

function fakeSetup() {
  const calls = []
  const handler = (name) => async (input) => {
    calls.push({ name, input })
    if (name === 'saveGoogle') return { ok: true, message: 'Google client saved.' }
    if (name === 'firstDeploy') return new Promise((r) => setTimeout(() => r({ ok: true }), 50))
    if (name === 'setupDatabase') throw new Error('kaboom')
    return { ok: true }
  }
  const setup = { status: () => ({ steps: [], info: {} }) }
  for (const n of ['login', 'chooseAccount', 'saveProfile', 'setupDatabase', 'firstDeploy', 'saveGoogle', 'saveTurnstile', 'saveAccess', 'lockCheck', 'tick']) setup[n] = handler(n)
  return { setup, calls }
}

async function start() {
  const { setup, calls } = fakeSetup()
  const server = createWizardServer({ setup, token: TOKEN })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { server, port, calls }
}

// Raw http so the Host header can be set (fetch forbids overriding it).
function send(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const post = (port, action, data, extra = {}) => send(port, {
  method: 'POST', path: `/api/${action}`,
  headers: { 'content-type': 'application/json', 'x-setup-token': TOKEN, origin: `http://127.0.0.1:${port}`, ...extra },
  body: JSON.stringify(data ?? {}),
})

test('the page needs the token and is served with a strict CSP', async () => {
  const { server, port } = await start()
  try {
    assert.equal((await send(port, { path: '/' })).status, 403)
    assert.equal((await send(port, { path: `/?t=${'c'.repeat(64)}` })).status, 403)
    const ok = await send(port, { path: `/?t=${TOKEN}` })
    assert.equal(ok.status, 200)
    assert.match(ok.headers['content-type'], /text\/html/)
    assert.match(ok.headers['content-security-policy'], /default-src 'none'/)
    assert.match(ok.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.equal(ok.headers['cache-control'], 'no-store')
    assert.ok(ok.text.includes(TOKEN), 'page carries the token for its API calls')
  } finally {
    server.close()
  }
})

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const { server, port } = await start()
  try {
    const r = await send(port, { path: `/?t=${TOKEN}`, headers: { host: `evil.example:${port}` } })
    assert.equal(r.status, 403)
    const local = await send(port, { path: `/?t=${TOKEN}`, headers: { host: `localhost:${port}` } })
    assert.equal(local.status, 200)
  } finally {
    server.close()
  }
})

test('API calls need the token header, same origin and JSON', async () => {
  const { server, port, calls } = await start()
  try {
    assert.equal((await post(port, 'login', {}, { 'x-setup-token': 'nope' })).status, 403)
    assert.equal((await post(port, 'login', {}, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post(port, 'login', {}, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await send(port, { method: 'GET', path: '/api/login', headers: { 'x-setup-token': TOKEN } })).status, 405)
    assert.equal((await post(port, 'deleteEverything', {})).status, 404)
    assert.equal(calls.length, 0)
    const ok = await post(port, 'login', {})
    assert.equal(ok.status, 200)
    assert.deepEqual(calls.map((c) => c.name), ['login'])
  } finally {
    server.close()
  }
})

test('status is a token-gated GET', async () => {
  const { server, port } = await start()
  try {
    assert.equal((await send(port, { path: '/api/status' })).status, 403)
    const r = await send(port, { path: '/api/status', headers: { 'x-setup-token': TOKEN } })
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.text), { steps: [], info: {} })
  } finally {
    server.close()
  }
})

test('a secret sent to an action is passed through and never echoed back', async () => {
  const { server, port, calls } = await start()
  try {
    const r = await post(port, 'saveGoogle', { clientId: 'x', clientSecret: 'GOCSPX-topsecret' })
    assert.equal(r.status, 200)
    assert.equal(calls[0].input.clientSecret, 'GOCSPX-topsecret')
    assert.equal(r.text.includes('topsecret'), false)
    assert.deepEqual(JSON.parse(r.text).result, { ok: true, message: 'Google client saved.' })
  } finally {
    server.close()
  }
})

test('one action at a time', async () => {
  const { server, port } = await start()
  try {
    const [a, b] = await Promise.all([post(port, 'firstDeploy', {}), post(port, 'login', {})])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
  } finally {
    server.close()
  }
})

test('an action that throws returns a JSON error and frees the lock', async () => {
  const { server, port } = await start()
  try {
    const r = await post(port, 'setupDatabase', {})
    assert.equal(r.status, 500)
    assert.match(JSON.parse(r.text).result.message, /kaboom/)
    assert.equal((await post(port, 'login', {})).status, 200)
  } finally {
    server.close()
  }
})

test('oversized bodies are refused', async () => {
  const { server, port } = await start()
  try {
    const r = await post(port, 'saveProfile', { big: 'x'.repeat(70_000) })
    assert.equal(r.status, 413)
  } finally {
    server.close()
  }
})
