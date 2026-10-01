import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CSP } from '../src/security-headers.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// CSP comes from src/security-headers.js -- the one constant the Worker
// itself uses for admin HTML / /api/admin/* / /api/public/* -- so this test
// fails the moment public/_headers' literal CSP line drifts from what the
// Worker actually sends, instead of comparing two independently-typed copies.

test('_headers sets a Content-Security-Policy on /* alongside the existing headers', () => {
  const h = read('public/_headers')
  const starBlock = h.slice(h.indexOf('/*'), h.indexOf('/admin/*'))
  assert.match(starBlock, /X-Content-Type-Options: nosniff/, 'existing header must survive')
  assert.match(starBlock, /Referrer-Policy: strict-origin-when-cross-origin/, 'existing header must survive')
  assert.match(starBlock, /X-Frame-Options: DENY/, 'existing header must survive')
  // Exact equality on the extracted line, not .includes(): .includes() only
  // catches CSP shrinking relative to the constant, not growing (an extra
  // directive appended to _headers but never added to the constant would
  // still satisfy .includes() and the drift this test exists to catch would
  // go unnoticed).
  const line = starBlock.match(/^\s*Content-Security-Policy:\s*(.+)$/m)
  assert.ok(line, 'expected a Content-Security-Policy line under /*')
  assert.equal(line[1].trim(), CSP, 'the exact reviewed CSP must be present under /*')
})

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* htmlFiles(p)
    else if (name.endsWith('.html')) yield p
  }
}

test('no public/*.html page contains an inline <script> without src, or an on*= attribute', () => {
  const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>/i
  const INLINE_HANDLER = /\son[a-z]+\s*=/i
  const offenders = []
  for (const f of htmlFiles(join(ROOT, 'public'))) {
    const text = readFileSync(f, 'utf8')
    if (INLINE_SCRIPT.test(text)) offenders.push(`${relative(ROOT, f)}: inline <script> without src`)
    if (INLINE_HANDLER.test(text)) offenders.push(`${relative(ROOT, f)}: inline on*= handler`)
  }
  assert.deepEqual(offenders, [])
})
