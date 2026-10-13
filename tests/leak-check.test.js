// Nothing of the original owner's may ship in the template.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// graphify-out is a local code-graph cache (never shipped, gitignored) that
// records absolute paths of whoever generated it.
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'graphify-out'])
const SELF = 'tests/leak-check.test.js'

// Patterns split so this file does not match itself if SELF is ever removed.
const PATTERNS = [
  ['aifind', 'mybusiness'], ['AI', 'FMB'], ['las', 'kin'], ['dev', 'rev'],
  ['7301c7b4-bbb8', '-4f32-a6ce-ca5b3e3d429b'], ['org_3Dthhdve6', 'MC7xfTv0b0NnUCgArr'],
  ['0x4AAAAAAE0', 'VFxAQIP8jtMZM'], ['cold-call', ''], ['CALL_STATE', '_DB'],
  // Broader source-project leftovers: the source project's own auth
  // provider, call-tracking table, Pages Functions path convention, intake
  // product name, the space-separated variant of the term already covered
  // above by the hyphenated 'cold-call' pattern, and its `lib/` module-path
  // convention (meet-kit's own code lives under src/core, src/handlers --
  // 'lib/' never legitimately appears in this tree; confirmed empirically
  // with a full-tree grep before adding this pattern).
  ['cl', 'erk'], ['call', '_state'], ['functions', '/api'], ['blue', 'print'],
  ['cold', ' call'], ['lib', '/'],
].map(([a, b]) => new RegExp(`${a}${b}`, 'i'))

function* files(dir) {
  for (const name of readdirSync(dir)) {
    // Check SKIP_DIRS by NAME before statSync: a git worktree's '.git' is a
    // FILE (containing a path to the real gitdir elsewhere), not a
    // directory, so gating the skip on isDirectory() would miss it and this
    // generator would read and yield that file's contents.
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

// Gitignored, per-deployment files: never shipped, and they hold whoever is
// deploying's own email and name.
const LOCAL_FILES = new Set(['.setup-state.json', '.dev.vars'])
// Once OWNER_EMAIL is set, this copy is someone's own deployment and these two
// files carry their details (written by `npm run setup` or by hand), which
// can legitimately match a pattern -- an employer's domain, a surname. The
// pristine template (OWNER_EMAIL "") is still checked in full.
const DEPLOYER_FILES = new Set(['wrangler.jsonc', 'meet.config.json'])
const configured = /"OWNER_EMAIL"\s*:\s*"[^"]+"/.test(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'))

test('no original-owner identifiers anywhere in the shipped tree', () => {
  const hits = []
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f)
    if (rel === SELF || rel === 'package-lock.json' || rel === 'LICENSE') continue
    if (LOCAL_FILES.has(rel) || (configured && DEPLOYER_FILES.has(rel))) continue
    const text = readFileSync(f, 'utf8')
    for (const re of PATTERNS) if (re.test(text)) hits.push(`${rel}: ${re}`)
  }
  assert.deepEqual(hits, [])
})
