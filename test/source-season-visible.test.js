'use strict'
// "what if you give me the list of season packs that came up as season 1 and i
// can see and select them? that would certainly make things easier" — his
// suggestion, after two attempts at deciding it for him went wrong.
//
// So the season each release NAMES is shown on its row, and a release from
// another season is MARKED and sunk, never hidden. Hiding was tried and
// collapsed the list to nothing, because most anime season-two entries are
// catalogued under a title that states no season.
//
// Measured on the app's own query for "That Time I Got Reincarnated as a Slime
// 01" (15 live results): one names season 1, two season 2, one season 4, and
// eleven name none. He was watching season one and being handed season four,
// because a season-four pack contains an episode "01" like every season does.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const RN = require('../src/release-name')

function lift() {
  const start = RENDERER.indexOf('function _demoteWrongSeason(')
  assert.ok(start > 0, '_demoteWrongSeason must exist')
  const end = RENDERER.indexOf('\n}\n', start) + 3
  const ctx = { Array, Object, Number, String, Boolean, console, PapaReleaseName: RN }
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return ctx
}

const S = (title) => ({ kind: 'torrent', title, magnet: 'magnet:' + title.length + title.slice(0, 6) })

test('a release from another season sinks below the ones that fit', () => {
  const ctx = lift()
  const list = [
    S('[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 01'),
    S('[MCR] That Time I Got Reincarnated as a Slime - 01'),
    S('[EMBER] That Time I Got Reincarnated as a Slime (Season 1 + OVA)'),
  ]
  const out = ctx._demoteWrongSeason(list, 'That Time I Got Reincarnated as a Slime')
  assert.strictEqual(out.length, 3, 'nothing may be dropped')
  assert.match(out[out.length - 1].title, /4th Season/, 'the other season goes last')
  assert.ok(!/4th Season/.test(out[0].title), 'and never first, where Play would take it')
})

test('nothing is ever hidden — the list keeps every source it was given', () => {
  const ctx = lift()
  const list = [S('[G] Show 4th Season - 01'), S('[G] Show - 01'), S('[G] Show 2nd Season - 01')]
  const out = ctx._demoteWrongSeason(list, 'Show')
  assert.strictEqual(out.length, list.length)
  for (const s of list) assert.ok(out.includes(s), 'every source survives: ' + s.title)
})

test('when EVERY candidate names another season the order is left alone', () => {
  // This is the case that collapsed the list when they were hidden instead:
  // a season-two entry catalogued under a title that states no season, where
  // every correct release says "2nd Season".
  const ctx = lift()
  const list = [S('[G] Show 2nd Season - 01'), S('[G] Show 2nd Season - 01 [720p]')]
  const out = ctx._demoteWrongSeason(list, 'Show')
  assert.deepStrictEqual(out, list, 'no reordering, and above all no hiding')
})

test('a title that names its own season is compared exactly', () => {
  const ctx = lift()
  const list = [S('[G] Show 2nd Season - 01'), S('[G] Show 3rd Season - 01')]
  const out = ctx._demoteWrongSeason(list, 'Show 3rd Season')
  assert.match(out[0].title, /3rd Season/, 'the season actually being watched leads')
  assert.match(out[1].title, /2nd Season/)
})

test('a season-one release is never treated as the wrong season', () => {
  const ctx = lift()
  const list = [S('[G] Show 1st Season - 01'), S('[G] Show 4th Season - 01')]
  const out = ctx._demoteWrongSeason(list, 'Show')
  assert.match(out[0].title, /1st Season/)
})

test('a list of one, or none, is returned untouched', () => {
  const ctx = lift()
  const one = [S('[G] Show 4th Season - 01')]
  assert.deepStrictEqual(ctx._demoteWrongSeason(one, 'Show'), one)
  assert.deepStrictEqual(ctx._demoteWrongSeason([], 'Show'), [])
})

test('every row shows the season its release names, and marks another season', () => {
  const at = RENDERER.indexOf('function _videoStreamRow(')
  const body = RENDERER.slice(at, RENDERER.indexOf('\n}\n', at))
  assert.match(body, /RNs\.declaredSeason\(s\.title\)/, 'read from the release itself')
  assert.match(body, /video-source-season/, 'and shown on the row')
  assert.match(body, /video-source-season-off/, 'a different season is marked')
  assert.match(body, /not the season you are watching/, 'in words, on hover')
  assert.match(body, /groupTag \+ instantTag \+ seasonTag/, 'and actually rendered')
})
