import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { readString, setString, updateMeetConfig, MEET_CONFIG_KEYS } from '../scripts/setup/config-files.mjs'
import { readPristineWrangler } from './helpers/template.js'

const WRANGLER = readPristineWrangler()
const MEET = readFileSync(new URL('../meet.config.json', import.meta.url), 'utf8')

test('readString reads vars and the database id from the real wrangler.jsonc', () => {
  assert.equal(readString(WRANGLER, 'OWNER_EMAIL'), '')
  assert.equal(readString(WRANGLER, 'database_id'), 'REPLACE_WITH_D1_ID')
  assert.equal(readString(WRANGLER, 'NOPE'), null)
})

test('setString edits one value and keeps every comment', () => {
  const out = setString(WRANGLER, 'OWNER_EMAIL', 'jane@example.com')
  assert.equal(readString(out, 'OWNER_EMAIL'), 'jane@example.com')
  const comments = (t) => t.split('\n').filter((l) => l.trim().startsWith('//'))
  assert.deepEqual(comments(out), comments(WRANGLER))
  // Only that one line changed.
  const diff = out.split('\n').filter((l, i) => l !== WRANGLER.split('\n')[i])
  assert.equal(diff.length, 1)
})

test('setString JSON-encodes the value so it cannot break out of the string', () => {
  const out = setString(WRANGLER, 'OWNER_EMAIL', 'a"b\\c')
  assert.equal(readString(out, 'OWNER_EMAIL'), 'a"b\\c')
  assert.equal(readString(setString(out, 'OWNER_EMAIL', 'x'), 'OWNER_EMAIL'), 'x')
})

test('setString replaces the D1 placeholder and later ids', () => {
  const id = '22222222-2222-2222-2222-222222222222'
  const out = setString(WRANGLER, 'database_id', id)
  assert.equal(readString(out, 'database_id'), id)
  assert.equal(readString(out, 'database_name'), 'meet-kit')
})

test('setString refuses an unknown or duplicated key', () => {
  assert.throws(() => setString(WRANGLER, 'NOPE', 'x'), /NOPE/)
  assert.throws(() => setString('{"A": "1", "A": "2"}', 'A', 'x'), /A/)
  assert.throws(() => setString(WRANGLER, 'OWNER_EMAIL', 42), /string/)
})

test('a key mentioned inside a // comment is not edited', () => {
  const text = '{\n  // "OWNER_EMAIL": "old"\n  "OWNER_EMAIL": ""\n}'
  const out = setString(text, 'OWNER_EMAIL', 'new')
  assert.match(out, /\/\/ "OWNER_EMAIL": "old"/)
  assert.equal(readString(out, 'OWNER_EMAIL'), 'new')
})

test('updateMeetConfig writes only known display keys', () => {
  const out = JSON.parse(updateMeetConfig(MEET, { displayName: 'Jane', accentColor: '#112233', evil: 'x' }))
  assert.equal(out.displayName, 'Jane')
  assert.equal(out.accentColor, '#112233')
  assert.equal(out.pageTitle, JSON.parse(MEET).pageTitle)
  assert.equal('evil' in out, false)
  assert.deepEqual(Object.keys(out), MEET_CONFIG_KEYS)
})
