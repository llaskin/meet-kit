import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com; " +
  "connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'self'; " +
  "object-src 'none'; frame-ancestors 'none'"

test('_headers sets a Content-Security-Policy on /* alongside the existing headers', () => {
  const h = read('public/_headers')
  const starBlock = h.slice(h.indexOf('/*'), h.indexOf('/admin/*'))
  assert.match(starBlock, /X-Content-Type-Options: nosniff/, 'existing header must survive')
  assert.match(starBlock, /Referrer-Policy: strict-origin-when-cross-origin/, 'existing header must survive')
  assert.match(starBlock, /X-Frame-Options: DENY/, 'existing header must survive')
  assert.ok(starBlock.includes(`Content-Security-Policy: ${CSP}`), 'the exact reviewed CSP must be present under /*')
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
