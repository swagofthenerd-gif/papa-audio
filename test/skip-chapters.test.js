'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { classifyTitle, classifyChapters } = require('../skip/chapters')

test('classifyTitle matches the §9 patterns', () => {
  assert.strictEqual(classifyTitle('Opening'), 'intro')
  assert.strictEqual(classifyTitle('Title Sequence'), 'intro')
  assert.strictEqual(classifyTitle('OP'), 'intro')
  assert.strictEqual(classifyTitle('Previously on'), 'recap')
  assert.strictEqual(classifyTitle('Prologue'), 'recap')
  assert.strictEqual(classifyTitle('End Credits'), 'credits')
  assert.strictEqual(classifyTitle('ED1'), 'credits')
  assert.strictEqual(classifyTitle('Outro'), 'credits')
  assert.strictEqual(classifyTitle('Next Episode Preview'), 'preview')
  assert.strictEqual(classifyTitle('Next Time'), 'preview')
})

test('classifyTitle is case-insensitive and whole-word', () => {
  assert.strictEqual(classifyTitle('opening credits'), 'intro')
  assert.strictEqual(classifyTitle('OPENING'), 'intro')
  // 'ended' and 'shopped' must not match \bed\b / \bop\b.
  assert.strictEqual(classifyTitle('ended'), null)
  assert.strictEqual(classifyTitle('shopped'), null)
  assert.strictEqual(classifyTitle('Part 1'), null)
})

test('classifyTitle returns null for blank or non-string', () => {
  assert.strictEqual(classifyTitle(null), null)
  assert.strictEqual(classifyTitle(''), null)
  assert.strictEqual(classifyTitle(42), null)
})

test('classifyChapters turns a chapter list into segments', () => {
  const chapters = [
    { title: 'Opening', start: 0 },
    { title: 'Part 1', start: 90 },
    { title: 'Part 2', start: 1200 },
    { title: 'Ending', start: 1400 },
  ]
  const segments = classifyChapters(chapters, { duration: 1500 })
  assert.deepStrictEqual(segments, [
    { kind: 'intro', start: 0, end: 90, origin: 'chapters', confidence: 0.9 },
    { kind: 'credits', start: 1400, end: 1500, origin: 'chapters', confidence: 0.9 },
  ])
})

test('a trailing chapter ends at the duration; without one it is dropped', () => {
  const chapters = [{ title: 'Opening', start: 0 }, { title: 'Part 1', start: 90 }]
  const withDur = classifyChapters(chapters, { duration: 100 })
  assert.strictEqual(withDur.length, 1)
  assert.deepStrictEqual(withDur[0], { kind: 'intro', start: 0, end: 90, origin: 'chapters', confidence: 0.9 })
  // No duration: only the non-trailing intro survives.
  const noDur = classifyChapters([{ title: 'Part 1', start: 0 }, { title: 'Ending', start: 100 }])
  assert.deepStrictEqual(noDur, [])
})

test('classifyChapters ignores junk and a chapter with no start', () => {
  const segments = classifyChapters([null, { title: 'x', start: NaN }, { title: 'Opening', start: 0 }, { title: 'Part 1', start: 60 }], { duration: 60 })
  assert.deepStrictEqual(segments, [{ kind: 'intro', start: 0, end: 60, origin: 'chapters', confidence: 0.9 }])
})

test('classifyChapters returns [] for a non-array', () => {
  assert.deepStrictEqual(classifyChapters(null), [])
  assert.deepStrictEqual(classifyChapters(undefined), [])
})
