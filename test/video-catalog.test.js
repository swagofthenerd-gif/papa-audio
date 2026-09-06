'use strict'
// The person lookup: one request that carries both the filmography and the
// person it belongs to, so the page can head itself without a clicked credit.
const test = require('node:test')
const assert = require('node:assert')
const tmdb = require('../catalog/tmdb')

test('the person URL appends the credits to the person request', () => {
  const url = tmdb.buildPersonUrl(525)
  assert.match(url, /\/person\/525\?/)
  assert.match(url, /append_to_response=combined_credits/)
})

test('personCredits carries the person on the credits it returns', async () => {
  const fetchFn = async url => {
    assert.match(url, /\/person\/5\?append_to_response=combined_credits/)
    return { ok: true, json: async () => ({
      id: 5,
      name: 'Denis Villeneuve',
      profile_path: '/p.jpg',
      biography: 'Denis Villeneuve is a Canadian film director.\n\nBorn in 1967…',
      combined_credits: {
        cast: [{ id: 1, media_type: 'movie', title: 'Old', release_date: '1999-01-01' }],
        crew: [{ id: 2, media_type: 'movie', title: 'New', release_date: '2021-01-01' }],
      },
    }) }
  }
  const cat = tmdb.createTmdbCatalog({ apiKey: 'k', fetchFn })
  const out = await cat.personCredits(5)
  assert.deepStrictEqual(out.map(x => x.title), ['New', 'Old'], 'still newest first')
  assert.strictEqual(out.person.name, 'Denis Villeneuve')
  assert.match(out.person.photo, /\/p\.jpg$/)
  assert.strictEqual(out.person.bio, 'Denis Villeneuve is a Canadian film director.')
  assert.strictEqual(out.length, 2, 'the person must not count as a credit')
})

// The bare combined_credits shape — and anything cached from it — has cast
// and crew at the top level and no person at all.
test('personCredits still reads the old top-level credits shape', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({
    cast: [{ id: 1, media_type: 'movie', title: 'Only', release_date: '2010-01-01' }],
    crew: [],
  }) })
  const cat = tmdb.createTmdbCatalog({ apiKey: 'k', fetchFn })
  const out = await cat.personCredits(5)
  assert.deepStrictEqual(out.map(x => x.title), ['Only'])
  assert.strictEqual(out.person, undefined, 'no name, no person')
})

test('shortBio keeps the first paragraph and ends on a sentence', () => {
  assert.strictEqual(tmdb.shortBio('One line.\n\nSecond paragraph.'), 'One line.')
  assert.strictEqual(tmdb.shortBio(''), null)
  assert.strictEqual(tmdb.shortBio(null), null)
  assert.strictEqual(tmdb.shortBio('   '), null)
  const long = ('A sentence about a long and storied career in pictures. ').repeat(12)
  const cut = tmdb.shortBio(long)
  assert.ok(cut.length <= 361, 'a header line, not a life story')
  assert.match(cut, /\.$/, 'cut at a sentence end, not mid-word')
})
