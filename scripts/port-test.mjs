// One-shot: copy a source test into meet-kit, rewriting paths and scrubbing
// AIFMB-specific values. Usage: node scripts/port-test.mjs <name> [<name>...]
// where <name> is the source test file stem (e.g. public-book-api).
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = '/Users/leolaskin/Development/AIfindMyBusiness/scripts/cloudflare-cold-call-sheets'

const PATHS = [
  [/'\.\.\/lib\/([\w-]+)\.js'/g, "'../src/core/$1.js'"],
  [/'\.\.\/functions\/api\/public\/book\.js'/g, "'../src/handlers/public-book.js'"],
  [/'\.\.\/functions\/api\/public\/slots\.js'/g, "'../src/handlers/public-slots.js'"],
  [/'\.\.\/functions\/api\/calendar\/calendars\.js'/g, "'../src/handlers/admin-calendars.js'"],
  [/'\.\.\/functions\/api\/admin\/bookings\.js'/g, "'../src/handlers/admin-bookings.js'"],
  [/'\.\.\/functions\/api\/admin\/cancel\.js'/g, "'../src/handlers/admin-cancel.js'"],
  [/'\.\.\/public\/booking\.js'/g, "'../public/picker.js'"],
]

// Every migration is folded into schema.sql, so the source's extra
// migration exec lines are dropped; the schema.sql line stays.
const DROP_LINE = /^\s*db\.exec\(readFileSync\(fileURLToPath\(new URL\('\.\.\/migrations\/[^']+'.*\)\)\s*$/

const SCRUB = [
  [/aifindmybusiness@gmail\.com/g, 'owner@example.com'],
  [/leo@aifindmybusiness\.com/g, 'owner@example.com'],
  [/leo\.laskin@devrev\.ai/g, 'work@example.com'],
  [/https:\/\/aifindmybusiness\.com/g, 'https://example.com'],
  [/AI Find My Business/g, 'Example Co'],
  [/AIFMB_BOOKING/g, 'MEETKIT_PICKER'],
  [/'AIFMB'/g, "'Owner calendar'"],
  [/env\.CALL_STATE_DB/g, 'env.DB'],
  [/CALL_STATE_DB/g, 'DB'],
]

for (const name of process.argv.slice(2)) {
  let s = readFileSync(`${SRC}/tests/${name}.test.js`, 'utf8')
  for (const [re, to] of PATHS) s = s.replace(re, to)
  s = s.split('\n').filter((l) => !DROP_LINE.test(l)).join('\n')
  for (const [re, to] of SCRUB) s = s.replace(re, to)
  writeFileSync(`tests/${name}.test.js`, s)
  const left = s.match(/aifmb|aifindmybusiness|laskin|devrev/gi)
  console.log(`${name}: ${left ? `RESIDUE ${[...new Set(left)].join(',')}` : 'clean'}`)
}
