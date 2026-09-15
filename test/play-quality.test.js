'use strict'
// The Play button aims at a quality (2026-09-15). With debrid configured the
// swarm's size stops deciding anything — RealDebrid serves a cached torrent
// over HTTPS whether it has three sharers or three hundred — so the best
// picture should win instead of the healthiest swarm. And the viewer gets a
// picker beside Play for the times they want something other than the best.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function ranker() {
  const start = MAIN.indexOf('const HEALTHY_SEEDS')
  const end = MAIN.indexOf('\n}', MAIN.indexOf('function _applyQualityPreference(')) + 2
  const ctx = { rankingSeeds: e => Number(e && e.seeds) || 0 }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end), ctx)
  return ctx
}
const t = (q, seeds, extra) => Object.assign({ kind: 'torrent', quality: q, seeds }, extra)

// The source list is the PEER-TO-PEER ordering and stays health-first even
// when debrid is configured. Making it quality-first under debrid was wrong:
// RealDebrid refuses a great deal of content (every anime source tried came
// back 451), so the app lands on the swarm anyway and was then handed a
// four-seeder source. Which source debrid can serve is decided separately.
test('a starving swarm never leads, whether or not debrid is configured', () => {
  const ctx = ranker()
  const thin4k = t('2160p', 2)
  const healthy1080 = t('1080p', 900)
  assert.deepStrictEqual([...ctx._applyQualityPreference([healthy1080, thin4k], '2160p')],
    [healthy1080, thin4k], 'health decides the swarm ordering')
})

test('cams and known-dead magnets stay at the bottom', () => {
  const ctx = ranker()
  const cam = t('2160p', 999, { lowQuality: true })
  const dead4k = t('2160p', 500, { deadHint: true })
  const good1080 = t('1080p', 10)
  assert.deepStrictEqual([...ctx._applyQualityPreference([cam, dead4k, good1080], '2160p')],
    [good1080, dead4k, cam])
})

test('the debrid candidates are ordered by picture, since sharers do not matter there', () => {
  const RENDERER2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const block = RENDERER2.slice(RENDERER2.indexOf('const qRank = {'), RENDERER2.indexOf('videoDebridPick({'))
  assert.ok(/sort\(function \(a, b\) \{ return \(\(qRank\[b\.s\.quality\]/.test(block), 'best picture asked about first')
  assert.ok(/_streamable\(s, minutes\)/.test(block), 'and only ones that can stream at all')
})

function picker() {
  const src = RENDERER.slice(RENDERER.indexOf('var _playQuality ='), RENDERER.indexOf('function _autoPickStream('))
  // _pickForPlay reads page state: which source debrid proved it can serve,
  // and how long the thing is (to judge whether a file can stream at all).
  const ctx = { esc: x => String(x == null ? '' : x), document: { getElementById: () => null },
    Array, Number, String, Math, _videoDetail: null, _debridPick: null }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return ctx
}

test('the picker offers only qualities this title actually has, best first', () => {
  const ctx = picker()
  const list = [t('1080p', 5), t('2160p', 5), t('1080p', 9), t('720p', 1), t('2160p', 2, { lowQuality: true })]
  assert.deepStrictEqual([...ctx._availableQualities(list)], ['2160p', '1080p', '720p'], 'deduplicated, cams excluded')
  assert.deepStrictEqual([...ctx._availableQualities([])], [])
})

test('Play uses the chosen quality, and falls back rather than refusing', () => {
  const ctx = picker()
  ctx._autoPickStream = list => list[0]
  const uhd = t('2160p', 3), hd = t('1080p', 500)
  const list = [hd, uhd]
  assert.strictEqual(ctx._pickForPlay(list), hd, 'no choice made: the automatic pick')
  ctx._playQuality = '2160p'
  assert.strictEqual(ctx._pickForPlay(list), uhd, 'the chosen quality wins')
  // A quality this title does not have must not leave Play doing nothing.
  ctx._playQuality = '480p'
  assert.strictEqual(ctx._pickForPlay(list), hd, 'falls back to the automatic pick')
  assert.strictEqual(ctx._pickForPlay([]), null)
})

test('the picker is wired to Play, filled from the real sources, and hidden when there is no choice', () => {
  assert.ok(/_videoPlayResult\(_pickForPlay\(_videoStreams\)\)/.test(RENDERER), 'Play goes through the picker')
  assert.ok(/id="vdet-quality"/.test(RENDERER))
  assert.ok(/_renderQualityPicker\(streams\)/.test(RENDERER), 'filled when the sources land')
  const fn = RENDERER.slice(RENDERER.indexOf('function _renderQualityPicker('), RENDERER.indexOf('// What Play starts.'))
  assert.ok(/if \(qualities\.length < 2\) \{ wrap\.hidden = true; return \}/.test(fn), 'one option is not a choice')
  assert.ok(/qualities\.indexOf\(_playQuality\) === -1\) _playQuality = ''/.test(fn), 'a vanished quality cannot stay selected')
  // The source list is the peer ordering; debrid servability is decided
  // separately by the renderer's debrid pick, not by reshuffling this list.
  assert.ok(/_applyQualityPreference\(ranked, settings\.preferredQuality\)/.test(MAIN))
})
