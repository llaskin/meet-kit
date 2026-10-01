import assert from 'node:assert/strict'
import test from 'node:test'
import { siteConfig } from '../src/core/site-config.js'
import { onRequestGet } from '../src/handlers/public-site.js'

test('siteConfig drops non-https links and bad colours', () => {
  const s = siteConfig({ privacyUrl: 'javascript:alert(1)', termsUrl: 'http://x.test', accentColor: 'red' })
  assert.equal(s.privacyUrl, '')
  assert.equal(s.termsUrl, '')
  assert.equal(s.accentColor, '#0b6cff')
})

test('siteConfig tolerates null and non-object input', () => {
  assert.equal(siteConfig(null).eventTitle, 'Intro call')
  assert.equal(siteConfig('x').pageTitle, 'Book a call')
})

test('site endpoint exposes the site key but no secret', async () => {
  const res = await onRequestGet({ env: { TURNSTILE_SITE_KEY: 'pub', TURNSTILE_SECRET_KEY: 'SECRET' }, site: siteConfig({}) })
  const text = await res.text()
  assert.match(text, /"turnstileSiteKey":"pub"/)
  assert.doesNotMatch(text, /SECRET/)
})
