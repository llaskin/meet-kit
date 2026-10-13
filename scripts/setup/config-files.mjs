// Targeted edits to wrangler.jsonc and meet.config.json for the setup wizard.
// wrangler.jsonc carries comments, so it is never parsed and re-serialised:
// a single "KEY": "value" string is replaced in place and everything else,
// comments included, is left byte-for-byte alone.

export const MEET_CONFIG_KEYS = [
  'displayName', 'pageTitle', 'pageSubtitle', 'eventTitle', 'privacyUrl', 'termsUrl', 'accentColor',
]

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every "KEY": "<json string>" occurrence that is not on a // comment line.
function matches(text, key) {
  const re = new RegExp(`"${escapeRe(key)}"\\s*:\\s*"((?:[^"\\\\\\n]|\\\\.)*)"`, 'g')
  const found = []
  for (const m of text.matchAll(re)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    if (text.slice(lineStart, m.index).includes('//')) continue
    found.push(m)
  }
  return found
}

export function readString(text, key) {
  const [m] = matches(text, key)
  return m ? JSON.parse(`"${m[1]}"`) : null
}

export function setString(text, key, value) {
  if (typeof value !== 'string') throw new TypeError(`${key}: value must be a string`)
  const found = matches(text, key)
  if (found.length !== 1) throw new Error(`${key}: expected exactly one "${key}" string, found ${found.length}`)
  const m = found[0]
  const replacement = m[0].slice(0, m[0].length - m[1].length - 2) + JSON.stringify(value)
  return text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length)
}

export function updateMeetConfig(text, patch) {
  const current = JSON.parse(text)
  const out = {}
  for (const k of MEET_CONFIG_KEYS) {
    out[k] = typeof patch[k] === 'string' ? patch[k] : typeof current[k] === 'string' ? current[k] : ''
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
