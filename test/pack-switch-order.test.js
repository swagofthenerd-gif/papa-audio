'use strict'
// Advancing through a pack must prepare the episode AFTER the one you just
// moved to. _switchPackEpisode told the pack strip about the new file list
// before it moved _videoState.episode, and it never asked for the look-ahead
// at all — so the Up Next card, the next-episode source prefetch and the
// "download next episode" control were either looking at the episode that had
// just finished or not running. Watching straight through a season quietly
// stopped preparing anything after the first switch.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftSwitch(files) {
  const seen = []
  const note = what => () => seen.push(what + '@' + ctx._videoState.episode)
  const ctx = {
    console: { warn() {}, log() {} }, Array, Number, String, Object, Promise, setTimeout,
    _player: {
      setStageMessage() {}, setSegments() {},
      setPack() { seen.push('setPack@' + ctx._videoState.episode) },
    },
    _packFiles: [{ index: 4, episode: 5 }, { index: 7, episode: 6 }],
    _videoDetail: { type: 'tv', d: { id: 1396, title: 'Breaking Bad', poster: null } },
    _videoState: { season: 1, episode: 5 },
    _watch: { ctx: null },
    _watchKey: require('../src/watch-key').watchKey,
    _setPackFiles() { seen.push('setPackFiles@' + ctx._videoState.episode) },
    _keepPackEpisode() {},
    _loadSkipSegments() {},
    _setUpNextInfo: note('upNext'),
    _prefetchNextSources: note('prefetch'),
    _updatePredownloadControl: note('predownload'),
    esc: s => s,
    _videoErrorText: s => s,
    window: { api: { videoPackSelect: () => Promise.resolve({ ok: true, files: files }) } },
  }
  vm.createContext(ctx)
  const start = RENDERER.indexOf('async function _switchPackEpisode(index, opts) {')
  assert.ok(start > 0)
  const end = RENDERER.indexOf('\n}', start) + 2
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return { ctx, seen }
}

const FILES = [{ index: 4, episode: 5 }, { index: 7, episode: 6, current: true }]

test('everything told about the switch is told the NEW episode', async () => {
  const { ctx, seen } = liftSwitch(FILES)
  await ctx._switchPackEpisode(7, {})
  assert.strictEqual(ctx._videoState.episode, 6)
  assert.ok(seen.length >= 5, 'expected the pack and the look-ahead to run: ' + seen.join(','))
  for (const s of seen) {
    assert.ok(s.endsWith('@6'), s + ' still saw the episode that just ended')
  }
})

test('the look-ahead runs on a strip switch — up next, sources, and the background pull', async () => {
  const { ctx, seen } = liftSwitch(FILES)
  await ctx._switchPackEpisode(7, {})
  const names = seen.map(s => s.split('@')[0])
  assert.ok(names.includes('upNext'), 'the Up Next card was never refreshed')
  assert.ok(names.includes('prefetch'), 'the next episode’s sources were never resolved')
  assert.ok(names.includes('predownload'), 'the background pull was never re-offered')
})

test('the watch identity moves before the pack is repainted', async () => {
  const { ctx, seen } = liftSwitch(FILES)
  await ctx._switchPackEpisode(7, {})
  assert.strictEqual(ctx._watch.key, 'tv:1396:s1e6')
  assert.ok(seen.indexOf('setPack@6') >= 0)
})

test('a failed switch changes nothing and asks for nothing', async () => {
  const seen = []
  const ctx = {
    console: { warn() {} }, Array, Number, String, Object, Promise, setTimeout,
    _player: { setStageMessage() {}, setPack() { seen.push('setPack') }, setSegments() {} },
    _packFiles: [{ index: 7, episode: 6 }],
    _videoDetail: { type: 'tv', d: { id: 1396, title: 'B', poster: null } },
    _videoState: { season: 1, episode: 5 },
    _watch: {}, _watchKey: require('../src/watch-key').watchKey,
    _setPackFiles() { seen.push('setPackFiles') }, _keepPackEpisode() {}, _loadSkipSegments() {},
    _setUpNextInfo() { seen.push('upNext') },
    _prefetchNextSources() { seen.push('prefetch') },
    _updatePredownloadControl() { seen.push('predownload') },
    esc: s => s, _videoErrorText: s => s,
    window: { api: { videoPackSelect: () => Promise.resolve({ ok: false, error: 'nope' }) } },
  }
  vm.createContext(ctx)
  const start = RENDERER.indexOf('async function _switchPackEpisode(index, opts) {')
  vm.runInContext(RENDERER.slice(start, RENDERER.indexOf('\n}', start) + 2), ctx)
  await ctx._switchPackEpisode(7, {})
  assert.strictEqual(ctx._videoState.episode, 5)
  assert.deepStrictEqual(seen, [])
})
