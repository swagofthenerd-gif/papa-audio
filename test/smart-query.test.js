'use strict'
const test = require('node:test')
const assert = require('node:assert')
const SQ = require('../src/smart-query')

// ── Tokenizer ────────────────────────────────────────────────────────────────
test('tokenize lowercases, folds diacritics and strips punctuation', () => {
  assert.deepEqual(SQ.tokenize('Björk — Jóga (Live!)'), ['bjork', 'joga', 'live'])
  assert.deepEqual(SQ.tokenize('Hall & Oates'), ['hall', 'oates'])
  assert.deepEqual(SQ.tokenize('  Radiohead   '), ['radiohead'])
  assert.deepEqual(SQ.tokenize(''), [])
  assert.deepEqual(SQ.tokenize(null), [])
})

test('normalize joins tokens into a stable string', () => {
  assert.equal(SQ.normalize('Café  del   Mar'), 'cafe del mar')
})

// ── Edit distance ────────────────────────────────────────────────────────────
test('editDistance is bounded and correct within budget', () => {
  assert.equal(SQ.editDistance('creep', 'creep', 2), 0)
  assert.equal(SQ.editDistance('creap', 'creep', 2), 1)
  assert.equal(SQ.editDistance('radiohed', 'radiohead', 2), 1)
  // Over budget returns budget+1, not the true (large) distance.
  assert.equal(SQ.editDistance('cat', 'elephant', 2), 3)
})

// ── Order-blind scorer ───────────────────────────────────────────────────────
test('order-blind: "creep radiohead" and "radiohead creep" score identically', () => {
  const field = ['Radiohead', 'Creep']
  const a = SQ.scoreQuery('creep radiohead', field)
  const b = SQ.scoreQuery('radiohead creep', field)
  assert.ok(a > 0, 'should match')
  assert.equal(a, b, 'word order must not change the score')
})

test('all-tokens-must-hit: a query token that lands nowhere means no match', () => {
  const field = ['Radiohead', 'Creep']
  assert.equal(SQ.scoreQuery('creep beatles', field), 0)
  assert.ok(SQ.scoreQuery('creep radiohead', field) > 0)
})

test('exact ranks above prefix ranks above typo', () => {
  const exact = SQ._tokenScore('creep', 'creep')
  const prefix = SQ._tokenScore('cree', 'creep')
  const typo = SQ._tokenScore('creap', 'creep')
  assert.ok(exact > prefix, 'exact > prefix')
  assert.ok(prefix > typo, 'prefix > typo')
  assert.ok(typo > 0, 'typo still matches')
})

test('typo within edit distance 2 still matches a field token', () => {
  assert.ok(SQ.scoreQuery('radiohed creap', ['Radiohead', 'Creep']) > 0)
})

test('per-token best-field: query tokens can span different fields', () => {
  // "band" hits the artist field, "song" hits the title field — order-blind and
  // cross-field, both must land for a hit.
  const field = ['The Band', 'The Weight'] // artist | title
  assert.ok(SQ.scoreQuery('weight band', field) > 0)
  assert.equal(SQ.scoreQuery('weight beatles', field), 0)
})

test('tightness boost favours a record that is more about the query', () => {
  const tight = SQ.scoreQuery('creep', ['Creep'])
  const loose = SQ.scoreQuery('creep', ['Creep', 'is', 'a', 'song', 'by', 'radiohead'])
  assert.ok(tight > loose, 'tighter record scores higher for the same match')
})

// ── Vocabulary corrector ─────────────────────────────────────────────────────
test('buildVocabulary counts token frequency across records', () => {
  const v = SQ.buildVocabulary([['Radiohead', 'Creep'], ['Radiohead', 'Kid A']])
  assert.equal(v.radiohead, 2)
  assert.equal(v.creep, 1)
  assert.equal(v.kid, 1)
})

test('correctToken fixes an unambiguous off-by-one typo', () => {
  const v = SQ.buildVocabulary([['Radiohead', 'Creep']])
  const r = SQ.correctToken('creap', v)
  assert.equal(r.corrected, true)
  assert.equal(r.token, 'creep')
})

test('correctToken never "corrects" a word already in the vocabulary', () => {
  const v = SQ.buildVocabulary([['Radiohead', 'Creep'], ['Radiohead', 'Kid A']])
  const r = SQ.correctToken('kid', v)
  assert.equal(r.corrected, false)
  assert.equal(r.token, 'kid')
})

test('correctToken REFUSES an ambiguous fix (kid a → kid b tie)', () => {
  // Both "a" and "b" would be within distance 1 of a hypothetical typo, and
  // neither dominates by frequency — the corrector must leave it alone rather
  // than guess. This is the trust-critical MUST-NOT-correct case.
  const v = SQ.buildVocabulary([['Kid', 'A'], ['Kid', 'B']])
  // "c" is distance 1 from both "a" and "b"; equal frequency → ambiguous.
  const r = SQ.correctToken('c', v)
  assert.equal(r.corrected, false, 'a symmetric tie must not be corrected')
})

test('correctToken breaks a tie only under strong frequency dominance', () => {
  // "creep" appears many times, "creek" once. A typo equidistant from both
  // resolves to the dominant one; without dominance it would refuse.
  const recs = []
  for (let i = 0; i < 10; i++) recs.push(['Radiohead', 'Creep'])
  recs.push(['A', 'Creek'])
  const v = SQ.buildVocabulary(recs)
  const r = SQ.correctToken('creec', v) // dist 1 from both creep and creek
  assert.equal(r.corrected, true)
  assert.equal(r.token, 'creep')
})

test('correctQuery reports whether anything actually changed', () => {
  const v = SQ.buildVocabulary([['Radiohead', 'Creep']])
  const fixed = SQ.correctQuery('radiohed creap', v)
  assert.equal(fixed.corrected, true)
  assert.equal(fixed.query, 'radiohead creep')

  const clean = SQ.correctQuery('radiohead creep', v)
  assert.equal(clean.corrected, false)
})

// ── Spelling-fix gate (Soulseek) ─────────────────────────────────────────────
test('isSpellingFix accepts a small per-token drift', () => {
  assert.equal(SQ.isSpellingFix('radiohed creap', 'radiohead creep'), true)
})

test('isSpellingFix rejects a different token count (different intent)', () => {
  assert.equal(SQ.isSpellingFix('creep', 'radiohead creep'), false)
  assert.equal(SQ.isSpellingFix('radiohead creep live', 'radiohead creep'), false)
})

test('isSpellingFix is a distance gate — the SLSK caller must also require an authoritative suggestion', () => {
  // The gate ONLY answers "is this within a small edit distance?". "kid a" vs
  // "kid b" is distance 1, so the gate alone would pass it — which is exactly why
  // the Soulseek caller never swaps real words on its own: it only applies a fix
  // that BOTH came from YouTube's suggestion engine AND passes this gate. The
  // suggestion engine won't return "kid b" for "kid a" (it's a real, different
  // query), so the swap never happens in practice. Documented here so the two-
  // part contract is explicit and can't be quietly loosened.
  assert.equal(SQ.isSpellingFix('kid a', 'kid b'), true)
  // A heavier drift across the whole query (total > 4) is rejected by the gate:
  assert.equal(SQ.isSpellingFix('kidz aa', 'band cc'), false)
})

test('isSpellingFix rejects when nothing differs', () => {
  assert.equal(SQ.isSpellingFix('creep', 'creep'), false)
})

// ── Soulseek correction gate (integration-shaped) ────────────────────────────
// Mirrors the exact loop renderer.js's _slskCorrectQuery runs: walk the YT
// suggestion list, take the FIRST one that passes isSpellingFix. This proves the
// two-part contract end to end with realistic suggestion payloads.
function pickSlskCorrection(query, suggestions) {
  for (const cand of suggestions) {
    if (SQ.isSpellingFix(query, cand)) return { from: query, to: cand }
  }
  return null
}

test('SLSK gate: a genuine typo is corrected to the matching suggestion', () => {
  // YT autocomplete for "radiohaed creap" would surface the real spelling.
  const suggestions = ['radiohead creep', 'radiohead creep live', 'radiohead karma police']
  const fix = pickSlskCorrection('radiohaed creap', suggestions)
  assert.ok(fix)
  assert.equal(fix.to, 'radiohead creep')
})

test('SLSK gate: "kid a" is NEVER corrected to "kid b" (different real query)', () => {
  // The suggestion engine returns real, different queries for "kid a" — none of
  // which is the "kid b" swap. Even though isSpellingFix('kid a','kid b') is
  // distance-1, "kid b" never appears in the suggestions, so the swap can't
  // happen. This is the MUST-NOT-correct case, proven with a realistic payload.
  const suggestions = ['kid a radiohead', 'kid a full album', 'kid a vinyl']
  const fix = pickSlskCorrection('kid a', suggestions)
  assert.equal(fix, null, 'no suggestion is a spelling fix of the already-correct "kid a"')
})

test('SLSK gate: suggestions that only add words (different intent) are rejected', () => {
  // Every suggestion here changes the token count — a broader/different search,
  // never a one-for-one spelling repair — so none passes the gate.
  const fix = pickSlskCorrection('creep', ['creep radiohead', 'creep live', 'creep official video'])
  assert.equal(fix, null)
})

test('isSpellingFix caps total drift across many tokens', () => {
  // Each token drifts by 2 (within per-token budget) but the total exceeds the
  // budget, so this is not one clean correction.
  assert.equal(SQ.isSpellingFix('aa bb cc', 'xx yy zz'), false)
})
