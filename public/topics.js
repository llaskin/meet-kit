// Meeting topics: the owner's list, the visitor's "Other" text, and the event
// title. Pure -- no storage, no network -- so the server and the /meet page
// run the same rules.
//
// This exact file ships in two codebases. tests/topics.sha256 pins it; change
// both copies together and update both checksums.
//
// Why "Other" text is so strict: the event title is the subject line of a real
// invite emailed from the owner's own calendar to any address a visitor types.
// Free text there would let anyone send their own words, links or phone
// numbers as a genuine invite from the business.

export const MAX_TOPICS = 12
export const MAX_TOPIC_LENGTH = 40
export const OTHER_CHOICE = '__other__'
export const CUSTOM_TOPIC_ERROR =
  'Please describe the topic in a few words, without links or contact details.'

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
// Plain Latin letters only (ASCII plus the accented Latin blocks, without
// the x and / signs). Lookalikes -- other scripts, fullwidth forms, Roman
// numerals, Latin pseudo-punctuation -- are how spoofed text slips past a
// domain filter.
const CUSTOM_ALLOWED = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF0-9 \-'&,.()]+$/u
const DOMAIN_SHAPE = /[\p{L}\p{N}]\.\p{L}{2,}/u
const LINKISH = /http|www|@/i
const IPV4 = /\d+\.\d+\.\d+\.\d+/
// Vanity phone numbers carry few digits but are fully dialable:
// "1-800-FLOWERS", "(855) GETHELP", "800-flowers", "1 844 ...".
const VANITY = /\d{3}\)?[\s.-]?[A-Z]{4,}/
const TOLL_FREE = /\b8(?:00|33|44|55|66|77|88)-[A-Za-z]{3,}|\b1[\s.-]8(?:00|33|44|55|66|77|88)\b/i

/** Owner's topic list from the admin page. */
export function validateTopicList(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'Topics must be a list.' }
  if (list.length > MAX_TOPICS) return { ok: false, error: `Use at most ${MAX_TOPICS} topics.` }
  const topics = []
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== 'string') return { ok: false, error: 'Each topic must be text.' }
    if (CONTROL.test(raw)) return { ok: false, error: 'Topics cannot contain line breaks or control characters.' }
    const t = raw.trim()
    if (!t) return { ok: false, error: 'Topics cannot be blank.' }
    if (t.length > MAX_TOPIC_LENGTH) {
      return { ok: false, error: `Topic "${t.slice(0, 20)}…" is longer than ${MAX_TOPIC_LENGTH} characters.` }
    }
    const key = t.toLowerCase()
    if (key === 'other') return { ok: false, error: '"Other" is reserved; use the "Offer Other" checkbox instead.' }
    if (seen.has(key)) return { ok: false, error: `Topic "${t}" is listed twice.` }
    seen.add(key)
    topics.push(t)
  }
  return { ok: true, topics }
}

/** Visitor's custom topic after choosing "Other". */
export function validateCustomTopic(text) {
  const fail = { ok: false, error: CUSTOM_TOPIC_ERROR }
  if (typeof text !== 'string') return fail
  const value = text.replace(/\s+/g, ' ').trim()
  if (!value || value.length > MAX_TOPIC_LENGTH) return fail
  if (!CUSTOM_ALLOWED.test(value)) return fail
  if (LINKISH.test(value) || DOMAIN_SHAPE.test(value) || IPV4.test(value)) return fail
  if (VANITY.test(value) || TOLL_FREE.test(value)) return fail
  if ((value.match(/\d/g) || []).length >= 7) return fail
  return { ok: true, value }
}

/**
 * Server-side decision for a booking. Always checks against the CURRENT list:
 * a page loaded before the owner removed a topic gets code 'stale'.
 */
export function resolveTopic({ topics = [], allowOther = false, choice, custom } = {}) {
  if (topics.length === 0 && !allowOther) return { ok: true, topic: null, isCustom: false }
  if (typeof choice !== 'string' || choice === '') return { ok: false, code: 'required' }
  if (choice === OTHER_CHOICE) {
    if (!allowOther) return { ok: false, code: 'stale' }
    const c = validateCustomTopic(custom)
    if (!c.ok) return { ok: false, code: 'custom', error: c.error }
    return { ok: true, topic: `Other – ${c.value}`, isCustom: true }
  }
  if (topics.includes(choice)) return { ok: true, topic: choice, isCustom: false }
  return { ok: false, code: 'stale' }
}

export function eventTitle(base, topic) {
  return topic ? `${base}: ${topic}` : base
}

/** Read the two config keys. A corrupt stored list fails safe to "no topics". */
export function topicsFromConfig(cfg) {
  let list = []
  try { list = JSON.parse(cfg?.meeting_topics || '[]') } catch { list = [] }
  const v = validateTopicList(list)
  return { topics: v.ok ? v.topics : [], allowOther: cfg?.allow_other_topic === '1' }
}
