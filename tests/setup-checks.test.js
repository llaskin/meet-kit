import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isEmail, isHttpsUrlOrEmpty, isHexColor, isGoogleClientId, isTurnstileSiteKey,
  normalizeTeamDomain, isAud, parseWhoami, findDatabaseId, parseTableNames,
  REQUIRED_TABLES, parseSecretNames, parseDeployUrl, subdomainOnboardingLink,
  parseTestSummary,
} from '../scripts/setup/checks.mjs'

test('isEmail', () => {
  assert.equal(isEmail('jane@example.com'), true)
  assert.equal(isEmail(' jane@example.com'), false)
  assert.equal(isEmail('jane@example'), false)
  assert.equal(isEmail('jane example@x.com'), false)
  assert.equal(isEmail(''), false)
  assert.equal(isEmail(undefined), false)
})

test('isHttpsUrlOrEmpty', () => {
  assert.equal(isHttpsUrlOrEmpty(''), true)
  assert.equal(isHttpsUrlOrEmpty('https://example.com/privacy'), true)
  assert.equal(isHttpsUrlOrEmpty('http://example.com'), false)
  assert.equal(isHttpsUrlOrEmpty('javascript:alert(1)'), false)
  assert.equal(isHttpsUrlOrEmpty('example.com'), false)
})

test('isHexColor', () => {
  assert.equal(isHexColor('#0b6cff'), true)
  assert.equal(isHexColor('#0B6CFF'), true)
  assert.equal(isHexColor('0b6cff'), false)
  assert.equal(isHexColor('#fff'), false)
})

test('isGoogleClientId', () => {
  assert.equal(isGoogleClientId('123456789012-abc123def456.apps.googleusercontent.com'), true)
  assert.equal(isGoogleClientId('GOCSPX-secretlooking'), false)
  assert.equal(isGoogleClientId('123.apps.googleusercontent.com'), false)
})

test('isTurnstileSiteKey accepts real keys, refuses the always-pass test keys', () => {
  assert.equal(isTurnstileSiteKey('0x4AAAAAAABkMYinukE8nzYS'), true)
  assert.equal(isTurnstileSiteKey('1x00000000000000000000AA'), false)
  assert.equal(isTurnstileSiteKey('0x123'), false)
})

test('normalizeTeamDomain accepts the forms people paste', () => {
  const want = 'https://acme-team.cloudflareaccess.com'
  assert.equal(normalizeTeamDomain('acme-team'), want)
  assert.equal(normalizeTeamDomain('acme-team.cloudflareaccess.com'), want)
  assert.equal(normalizeTeamDomain('https://acme-team.cloudflareaccess.com/'), want)
  assert.equal(normalizeTeamDomain(' https://Acme-Team.cloudflareaccess.com '), want)
  assert.equal(normalizeTeamDomain('https://evil.example.com'), null)
  assert.equal(normalizeTeamDomain('http://acme-team.cloudflareaccess.com'), null)
  assert.equal(normalizeTeamDomain('a b'), null)
  assert.equal(normalizeTeamDomain(''), null)
})

test('isAud', () => {
  assert.equal(isAud('a'.repeat(64)), true)
  assert.equal(isAud('A'.repeat(64)), false)
  assert.equal(isAud('a'.repeat(63)), false)
})

test('parseWhoami', () => {
  const out = JSON.stringify({
    loggedIn: true, email: 'jane@example.com',
    accounts: [{ id: 'abc', name: 'Jane' }, { id: 'def', name: 'Work' }],
  })
  assert.deepEqual(parseWhoami(0, out), {
    loggedIn: true, email: 'jane@example.com',
    accounts: [{ id: 'abc', name: 'Jane' }, { id: 'def', name: 'Work' }],
  })
  assert.deepEqual(parseWhoami(1, '{"loggedIn":false}'), { loggedIn: false, accounts: [] })
  assert.deepEqual(parseWhoami(0, 'garbage'), { loggedIn: false, accounts: [] })
  // Wrangler may print a banner line before the JSON.
  assert.equal(parseWhoami(0, ` ⛅️ wrangler 4\n${out}`).loggedIn, true)
})

test('findDatabaseId', () => {
  const out = JSON.stringify([
    { uuid: '11111111-1111-1111-1111-111111111111', name: 'other' },
    { uuid: '22222222-2222-2222-2222-222222222222', name: 'meet-kit' },
  ])
  assert.equal(findDatabaseId(out, 'meet-kit'), '22222222-2222-2222-2222-222222222222')
  assert.equal(findDatabaseId(out, 'missing'), null)
  assert.equal(findDatabaseId('nope', 'meet-kit'), null)
})

test('parseTableNames flattens d1 execute --json output', () => {
  const out = JSON.stringify([{ results: [{ name: 'calendar_config' }, { name: '_cf_KV' }], success: true }])
  assert.deepEqual(parseTableNames(out), ['calendar_config', '_cf_KV'])
  assert.deepEqual(parseTableNames('nope'), [])
})

test('REQUIRED_TABLES matches schema.sql', async () => {
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort()
  assert.deepEqual([...REQUIRED_TABLES].sort(), created)
})

test('parseSecretNames', () => {
  assert.deepEqual(parseSecretNames('[{"name":"GOOGLE_CLIENT_SECRET","type":"secret_text"}]'), ['GOOGLE_CLIENT_SECRET'])
  assert.deepEqual(parseSecretNames('error'), [])
})

test('parseDeployUrl', () => {
  const out = 'Uploaded meet-kit (3.1 sec)\nDeployed meet-kit triggers (0.5 sec)\n  https://meet-kit.jane-doe.workers.dev\n  schedule: 17 7 * * *'
  assert.equal(parseDeployUrl(out), 'https://meet-kit.jane-doe.workers.dev')
  assert.equal(parseDeployUrl('no url'), null)
})

test('subdomainOnboardingLink', () => {
  const out = 'You can either deploy ... or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/0123abcd/workers/onboarding'
  assert.equal(subdomainOnboardingLink(out), 'https://dash.cloudflare.com/0123abcd/workers/onboarding')
  assert.equal(subdomainOnboardingLink('fine'), null)
})

test('parseTestSummary', () => {
  assert.deepEqual(parseTestSummary('ℹ tests 445\nℹ pass 444\nℹ fail 1\n'), { tests: 445, pass: 444, fail: 1 })
  assert.deepEqual(parseTestSummary('# tests 3\n# pass 3\n# fail 0\n'), { tests: 3, pass: 3, fail: 0 })
  assert.equal(parseTestSummary('crashed'), null)
})
