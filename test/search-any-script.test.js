'use strict'
const test = require('node:test')
const assert = require('node:assert')
const q = require('../src/smart-query')
const LI = require('../src/library-index')

// The tokenizer split on [^a-z0-9]+, so every character outside the Latin
// alphabet was treated as a separator. An artist tagged in Japanese, Korean,
// Chinese, Cyrillic or Greek tokenised to NOTHING: the index stored an empty
// field, scoreTokens short-circuited to 0, and the name could never be found by
// any query at all — no error, no "did you mean", just no results. His own
// library holds 新しい日の誕生 and αριθμός τέσσερα.
test('names in any script produce tokens instead of nothing', () => {
  const cases = {
    'アニメ': 1,               // Japanese katakana
    '新しい日の誕生': 1,          // Japanese mixed kanji/kana
    '방탄소년단': 1,             // Korean
    'Ленинград': 1,           // Cyrillic
    'αριθμός τέσσερα': 2,     // Greek, two words
    '周杰倫': 1,                // Chinese
  }
  for (const [name, expected] of Object.entries(cases)) {
    const t = q.tokenize(name)
    assert.strictEqual(t.length, expected, `${name} tokenised to ${JSON.stringify(t)}`)
    assert.ok(t.every(x => x.length > 0))
  }
})

test('a name in any script can actually be found by searching for it', () => {
  for (const name of ['アニメ', '新しい日の誕生', '방탄소년단', 'Ленинград', '周杰倫']) {
    assert.ok(q.scoreQuery(name, name) > 0.9, `${name} must match itself`)
  }
})

// CJK has no spaces, so a whole title is one token and what a person types is
// usually a substring rather than a prefix.
test('part of an unspaced name matches, from the start or the middle', () => {
  assert.ok(q.scoreQuery('宇多田', '宇多田ヒカル') > 0.7, 'a prefix of a CJK run')
  assert.ok(q.scoreQuery('ヒカル', '宇多田ヒカル') > 0.5, 'the middle of a CJK run')
  assert.ok(q.scoreQuery('誕生', '新しい日の誕生') > 0.5, 'the end of a CJK run')
})

test('a prefix still outranks a substring, and both outrank a typo', () => {
  const prefix = q.scoreQuery('宇多田', '宇多田ヒカル')
  const middle = q.scoreQuery('ヒカル', '宇多田ヒカル')
  assert.ok(prefix > middle, 'starting the way you typed is the stronger signal')
})

// Latin ranking is tuned and covered elsewhere; widening the separator class
// must not disturb it.
test('Latin behaviour is unchanged', () => {
  assert.ok(Math.abs(q.scoreQuery('radiohead', 'radiohead') - 1.04) < 0.01, 'exact')
  assert.ok(q.scoreQuery('rad', 'radiohead') > 0.8, 'prefix')
  assert.strictEqual(q.scoreQuery('creep', 'radiohead'), 0, 'no match is still no match')
  assert.deepStrictEqual(q.tokenize('AC/DC'), ['ac', 'dc'])
  assert.deepStrictEqual(q.tokenize('Panic! At The Disco'), ['panic', 'at', 'the', 'disco'])
  assert.deepStrictEqual(q.tokenize('Sigur Rós'), ['sigur', 'ros'], 'accents still fold to Latin')
  assert.deepStrictEqual(q.tokenize('Björk'), ['bjork'])
})

test('a library indexed with non-Latin tags is searchable through the index', () => {
  const albums = [
    { id: 'a1', name: '新しい日の誕生', artist: '2814', year: 2015, tracks: [{ title: 'Recovery', filePath: '/x/1.flac', duration: 300 }] },
    { id: 'a2', name: 'Kind of Blue', artist: 'Miles Davis', year: 1959, tracks: [{ title: 'So What', filePath: '/x/2.flac', duration: 545 }] },
    { id: 'a3', name: 'Ленинград', artist: 'Ленинград', year: 2000, tracks: [{ title: 'WWW', filePath: '/x/3.flac', duration: 200 }] },
  ]
  const idx = LI.build(albums)
  const found = name => {
    const r = LI.query(idx, name) || {}
    const all = [].concat(r.albums || [], r.artists || [], r.tracks || [])
    return all.length > 0
  }
  assert.ok(found('新しい日の誕生'), 'the Japanese album is found')
  assert.ok(found('Ленинград'), 'the Cyrillic one too')
  assert.ok(found('Kind of Blue'), 'and Latin still works')
})
