// Byte-identical in two codebases (see tests/topics.sha256). Edit both or neither.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateTopicList, validateCustomTopic, resolveTopic, eventTitle, topicsFromConfig,
  MAX_TOPICS, MAX_TOPIC_LENGTH, OTHER_CHOICE, CUSTOM_TOPIC_ERROR,
} from '../public/topics.js'

const n = (k) => Array.from({ length: k }, (_, i) => `Topic ${i + 1}`)

test('list: up to 12 accepted, 13 refused', () => {
  assert.equal(MAX_TOPICS, 12)
  assert.deepEqual(validateTopicList(n(12)), { ok: true, topics: n(12) })
  assert.equal(validateTopicList(n(13)).ok, false)
})

test('list: 40 chars accepted, 41 refused, trimmed', () => {
  assert.equal(MAX_TOPIC_LENGTH, 40)
  assert.deepEqual(validateTopicList(['  ' + 'a'.repeat(40) + ' ']), { ok: true, topics: ['a'.repeat(40)] })
  assert.equal(validateTopicList(['a'.repeat(41)]).ok, false)
})

test('list: blanks, duplicates, reserved Other, control chars and non-strings refused', () => {
  for (const bad of [[''], ['  '], ['Pricing', 'pricing'], ['Other'], ['oTHER'], ['a\nb'], ['a\tb'], [42], 'Pricing']) {
    const r = validateTopicList(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.equal(typeof r.error, 'string')
  }
})

test('list: empty list is valid', () => {
  assert.deepEqual(validateTopicList([]), { ok: true, topics: [] })
})

test('custom: accepted examples, whitespace collapsed', () => {
  for (const [input, value] of [
    ['Partnership idea', 'Partnership idea'],
    ['Q&A (pricing)', 'Q&A (pricing)'],
    ['Café chat', 'Café chat'],
    ['  e.g.   pricing  ', 'e.g. pricing'],
    ["Owner's renewal, v2", "Owner's renewal, v2"],
  ]) assert.deepEqual(validateCustomTopic(input), { ok: true, value }, input)
})

test('custom: links, contacts, lookalikes, markup and lengths refused', () => {
  for (const bad of [
    'http://x', 'see https now', 'www.x', 'a@b', 'evil.com', 'go to Example.org',
    'call 5551234567', '555 123 4567', 'раураl', '<b>x</b>', '', '   ',
    'a'.repeat(41), 'semi;colon', 'quote"d', null, 7,
  ]) {
    assert.deepEqual(validateCustomTopic(bad), { ok: false, error: CUSTOM_TOPIC_ERROR }, String(bad))
  }
})

test('resolve: no topics and Other off means no topic, choice ignored', () => {
  assert.deepEqual(resolveTopic({ topics: [], allowOther: false, choice: 'anything' }), { ok: true, topic: null, isCustom: false })
})

test('resolve: member of the current list', () => {
  assert.deepEqual(resolveTopic({ topics: ['Audit review'], allowOther: false, choice: 'Audit review' }),
    { ok: true, topic: 'Audit review', isCustom: false })
})

test('resolve: stale, required, Other disabled, bad custom, good custom', () => {
  const base = { topics: ['Audit review'], allowOther: true }
  assert.deepEqual(resolveTopic({ ...base, choice: 'Removed topic' }), { ok: false, code: 'stale' })
  assert.deepEqual(resolveTopic({ ...base, choice: '' }), { ok: false, code: 'required' })
  assert.deepEqual(resolveTopic({ ...base, choice: undefined }), { ok: false, code: 'required' })
  assert.deepEqual(resolveTopic({ topics: ['Audit review'], allowOther: false, choice: OTHER_CHOICE, custom: 'Ok' }), { ok: false, code: 'stale' })
  assert.deepEqual(resolveTopic({ ...base, choice: OTHER_CHOICE, custom: 'evil.com' }), { ok: false, code: 'custom', error: CUSTOM_TOPIC_ERROR })
  assert.deepEqual(resolveTopic({ ...base, choice: OTHER_CHOICE, custom: ' Partnership  idea ' }),
    { ok: true, topic: 'Other – Partnership idea', isCustom: true })
})

test('resolve: Other alone (no list) still requires a choice', () => {
  assert.deepEqual(resolveTopic({ topics: [], allowOther: true, choice: '' }), { ok: false, code: 'required' })
})

test('eventTitle: base, topic, custom', () => {
  assert.equal(eventTitle('Intro call', null), 'Intro call')
  assert.equal(eventTitle('Intro call', 'Audit review'), 'Intro call: Audit review')
  assert.equal(eventTitle('Intro call', 'Other – Partnership idea'), 'Intro call: Other – Partnership idea')
})

test('topicsFromConfig: parses, validates, and fails safe', () => {
  assert.deepEqual(topicsFromConfig({ meeting_topics: '["A","B"]', allow_other_topic: '1' }), { topics: ['A', 'B'], allowOther: true })
  assert.deepEqual(topicsFromConfig({}), { topics: [], allowOther: false })
  assert.deepEqual(topicsFromConfig({ meeting_topics: 'not json' }), { topics: [], allowOther: false })
  assert.deepEqual(topicsFromConfig({ meeting_topics: '["Other"]' }), { topics: [], allowOther: false })
  assert.deepEqual(topicsFromConfig(null), { topics: [], allowOther: false })
})
