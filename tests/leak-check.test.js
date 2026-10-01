// Nothing of the original owner's may ship in the template.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'docs'])
const SELF = 'tests/leak-check.test.js'

// Patterns split so this file does not match itself if SELF is ever removed.
const PATTERNS = [
  ['aifind', 'mybusiness'], ['AI', 'FMB'], ['las', 'kin'], ['dev', 'rev'],
  ['7301c7b4-bbb8', '-4f32-a6ce-ca5b3e3d429b'], ['org_3Dthhdve6', 'MC7xfTv0b0NnUCgArr'],
  ['0x4AAAAAAE0', 'VFxAQIP8jtMZM'], ['cold-call', ''], ['CALL_STATE', '_DB'],
].map(([a, b]) => new RegExp(`${a}${b}`, 'i'))

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* files(p) } else yield p
  }
}

test('no original-owner identifiers anywhere in the shipped tree', () => {
  const hits = []
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f)
    if (rel === SELF || rel === 'package-lock.json' || rel === 'LICENSE') continue
    const text = readFileSync(f, 'utf8')
    for (const re of PATTERNS) if (re.test(text)) hits.push(`${rel}: ${re}`)
  }
  assert.deepEqual(hits, [])
})
