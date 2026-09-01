'use strict'
// The Dub toggle, checked against the shape each catalogue actually returns.
//
// This exists because of a real regression. The toggle began life inside the
// Anime tab, where it was unconditional. When it was widened to television and
// film it became conditional, and the condition was written against TMDB's
// fields — isAnime and originalLanguage. AniList sets neither. Both come back
// undefined, so the new condition answered "no" on the one catalogue the
// control had always worked on, and Tokyo Revengers lost its Dub option.
//
// The function lives in renderer.js, which is a browser script with no exports,
// so its source is lifted out and evaluated. Binding the test to the real text
// is the point: a hand-copied duplicate would keep passing after the original
// changed, which is exactly how the cast-photo bug survived its own test.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const start = src.indexOf('function _dubbable(')
assert.ok(start > -1, '_dubbable must still exist in renderer.js')
// Read to the start of the next top-level function.
const end = src.indexOf('\nfunction ', start + 1)
const _dubbable = new Function(`${src.slice(start, end)}; return _dubbable`)()

// The shapes below are the real ones, captured from the live APIs.

test('an AniList title is dubbable on type alone', () => {
  // Tokyo Revengers, as AniList returns it: no isAnime, no originalLanguage.
  const d = { id: 120120, title: 'Tokyo Revengers', type: 'anime' }
  assert.strictEqual(d.isAnime, undefined, 'the fixture must not carry the field')
  assert.strictEqual(d.originalLanguage, undefined, 'nor this one')
  assert.strictEqual(_dubbable(d), true)
})

test('anime arriving through the TV tab is still dubbable', () => {
  // TMDB files anime as ordinary television, and flags it separately.
  assert.strictEqual(_dubbable({ type: 'tv', isAnime: true, originalLanguage: 'ja' }), true)
})

test('any non-English film is dubbable', () => {
  assert.strictEqual(_dubbable({ type: 'movie', originalLanguage: 'ko' }), true)
  assert.strictEqual(_dubbable({ type: 'movie', originalLanguage: 'fa' }), true)
})

test('an English-language title is not', () => {
  assert.strictEqual(_dubbable({ type: 'tv', originalLanguage: 'en' }), false)
})

// A blank language must not read as "not English" and offer a dub for a title
// that has none — but it must also not be the reason an anime loses its toggle.
test('a title with nothing known offers no dub', () => {
  assert.strictEqual(_dubbable({ type: 'movie' }), false)
  assert.strictEqual(_dubbable({ type: 'movie', originalLanguage: '' }), false)
  assert.strictEqual(_dubbable(null), false)
  assert.strictEqual(_dubbable(undefined), false)
})
