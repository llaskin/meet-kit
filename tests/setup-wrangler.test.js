import assert from 'node:assert/strict'
import test from 'node:test'
import { createWrangler } from '../scripts/setup/wrangler.mjs'

function fakeRun(reply = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = []
  const run = async (args, opts = {}) => {
    calls.push({ args, ...opts })
    return reply(args)
  }
  return { run, calls }
}

test('every call pins the chosen account and turns colour off', async () => {
  const { run, calls } = fakeRun()
  let account = 'acct-1'
  const w = createWrangler({ run, accountId: () => account })
  await w.secretNames()
  account = 'acct-2'
  await w.secretNames()
  assert.equal(calls[0].env.CLOUDFLARE_ACCOUNT_ID, 'acct-1')
  assert.equal(calls[1].env.CLOUDFLARE_ACCOUNT_ID, 'acct-2')
  assert.equal(calls[0].env.NO_COLOR, '1')
})

test('no account chosen yet: CLOUDFLARE_ACCOUNT_ID is not set', async () => {
  const { run, calls } = fakeRun()
  await createWrangler({ run, accountId: () => '' }).whoami()
  assert.equal('CLOUDFLARE_ACCOUNT_ID' in calls[0].env, false)
})

test('whoami parses --json output', async () => {
  const { run, calls } = fakeRun(() => ({ code: 0, stdout: '{"loggedIn":true,"email":"j@x.co","accounts":[{"id":"a","name":"J"}]}' }))
  const r = await createWrangler({ run }).whoami()
  assert.deepEqual(calls[0].args, ['whoami', '--json'])
  assert.equal(r.loggedIn, true)
  assert.deepEqual(r.accounts, [{ id: 'a', name: 'J' }])
})

test('secretPut sends the value on stdin, never in argv', async () => {
  const { run, calls } = fakeRun()
  const r = await createWrangler({ run }).secretPut('GOOGLE_CLIENT_SECRET', 's3cret-value')
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0].args, ['secret', 'put', 'GOOGLE_CLIENT_SECRET'])
  assert.equal(calls[0].stdin, 's3cret-value')
  assert.equal(JSON.stringify(calls[0].args).includes('s3cret'), false)
})

test('secretPut only accepts the three known secret names', async () => {
  const { run } = fakeRun()
  await assert.rejects(createWrangler({ run }).secretPut('PATH', 'x'), /PATH/)
})

test('secretPut failure output is not returned (it could echo the value)', async () => {
  const { run } = fakeRun(() => ({ code: 1, stdout: 'x s3cret-value', stderr: 'boom s3cret-value' }))
  const r = await createWrangler({ run }).secretPut('TURNSTILE_SECRET_KEY', 's3cret-value')
  assert.equal(r.ok, false)
  assert.equal(JSON.stringify(r).includes('s3cret'), false)
})

test('database commands target the meet-kit database remotely and never prompt', async () => {
  const { run, calls } = fakeRun(() => ({ code: 0, stdout: '[]' }))
  const w = createWrangler({ run })
  await w.d1List()
  await w.d1Create()
  await w.applySchema()
  await w.tables()
  assert.deepEqual(calls[0].args, ['d1', 'list', '--json'])
  assert.deepEqual(calls[1].args, ['d1', 'create', 'meet-kit'])
  assert.deepEqual(calls[2].args, ['d1', 'execute', 'meet-kit', '--remote', '--yes', '--file=schema.sql'])
  assert.deepEqual(calls[3].args.slice(0, 5), ['d1', 'execute', 'meet-kit', '--remote', '--yes'])
  assert.ok(calls[3].args.includes('--json'))
})

test('deploy returns the URL or the subdomain onboarding link', async () => {
  const ok = fakeRun(() => ({ code: 0, stdout: 'Deployed\n  https://meet-kit.jane.workers.dev\n' }))
  assert.deepEqual(await createWrangler({ run: ok.run }).deploy(),
    { ok: true, url: 'https://meet-kit.jane.workers.dev', onboarding: null, output: 'Deployed\n  https://meet-kit.jane.workers.dev\n' })
  const sub = fakeRun(() => ({ code: 1, stdout: '', stderr: 'register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/abc123/workers/onboarding' }))
  const r = await createWrangler({ run: sub.run }).deploy()
  assert.equal(r.ok, false)
  assert.equal(r.onboarding, 'https://dash.cloudflare.com/abc123/workers/onboarding')
})
