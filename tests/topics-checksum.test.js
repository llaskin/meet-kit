import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url))

test('public/topics.js matches the pinned checksum (shared with a second codebase)', () => {
  const actual = createHash('sha256').update(read('public/topics.js')).digest('hex')
  const pinned = read('tests/topics.sha256').toString().trim()
  assert.equal(actual, pinned, 'topics.js changed: update the other copy too, then both topics.sha256 files')
})
