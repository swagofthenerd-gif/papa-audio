'use strict'
// "Download next episode" must not be offered for a pack RealDebrid is serving.
//
// The control exists because a season pack is one torrent: the next episode is
// another file in it, so it can be pulled to completion in the background
// while this one plays. A pack served by RealDebrid is not a torrent at all —
// it is an HTTPS stream — and main's video-predownload answers "Nothing is
// streaming" because there is no streamer to ask.
//
// This could not come up until the debrid episode strip landed, because the
// control is gated on there being a pack on screen and debrid packs never
// produced one. The moment the strip started appearing, so did a dead button
// that says "Nothing is streaming" while something is plainly streaming —
// which is word for word the complaint the strip was added to fix.
//
// The fix is for the pack event to say where it came from. These EXECUTE both
// ends: main's _sendDebridPack, and the renderer's own gate.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

const packOf = (n, current) => Array.from({ length: n }, (_, i) => ({
  index: i + 1, name: 'Show - S02E' + String(i + 1).padStart(2, '0') + '.mkv',
  group: '', length: 1e9, episode: i + 1, current: i + 1 === current,
}))

// ── Main says where the list came from ──────────────────────────────────────

test('a pack RealDebrid is serving announces itself as debrid-served', async () => {
  const sent = []
  const ctx = {
    _videoSession: { debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 2, episode: 3 } } },
    safeSend: (channel, payload) => sent.push({ channel, payload }),
    debrid: () => ({ packFiles: async () => packOf(12, 3) }),
    Promise, Array, Number, console,
  }
  vm.createContext(ctx)
  const start = MAIN.indexOf('function _sendDebridPack(')
  assert.ok(start > 0, 'found _sendDebridPack')
  vm.runInContext(MAIN.slice(start, MAIN.indexOf('\n}', start) + 2), ctx)

  ctx._sendDebridPack(() => true)
  await new Promise(r => setImmediate(r))

  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].payload.kind, 'pack')
  assert.strictEqual(sent[0].payload.via, 'debrid',
    'without this the renderer cannot tell a debrid pack from a torrent one')
  assert.strictEqual(sent[0].payload.files.length, 12, 'and it is still a real pack event')
})

// ── The renderer acts on it ─────────────────────────────────────────────────

function rendererCtx(over) {
  const seen = { painted: 0 }
  const ctx = Object.assign({
    console, Number, String, Boolean, Array, Object, Math, Date,
    _videoDetail: { type: 'anime', id: 21, d: { id: 21, title: 'One Piece' } },
    _videoState: { season: null, episode: 3 },
    // Episode 4 exists, so there IS something to predownload.
    _nextEpisodeOf: () => ({ season: null, episode: 4 }),
    _updatePredownloadControl() { seen.painted++ },
    window: { api: { videoPredownload() {} } },
  }, over || {})
  ctx.Set = Set
  ctx.PapaReleaseName = require('../src/release-name')
  ctx.window.PapaReleaseName = ctx.PapaReleaseName
  vm.createContext(ctx)
  // The real _setPackFiles, _nextEpisodePackFile and _predownloadAvailable.
  const start = RENDERER.indexOf('var _packFiles = []')
  const end = RENDERER.indexOf('function _updatePredownloadControl(')
  assert.ok(start > 0 && end > start, 'found the predownload block')
  vm.runInContext(RENDERER.slice(start, end), ctx)
  // _nextEpisodePackFile delegates to the one season-aware matcher instead of
  // repeating an episode-number-only match of its own — a complete-series pack
  // holds an "episode 2" per season, and the folder has to decide which.
  for (const fn of ['_packGroupSeason', '_packFileForEpisode']) {
    const at = RENDERER.indexOf('\nfunction ' + fn + '(')
    assert.ok(at > -1, fn + ' must still be a top-level function in renderer.js')
    let depth = 0
    let body = ''
    for (let i = RENDERER.indexOf('{', at); i < RENDERER.length; i++) {
      if (RENDERER[i] === '{') depth++
      else if (RENDERER[i] === '}') { depth--; if (depth === 0) { body = RENDERER.slice(at, i + 1); break } }
    }
    vm.runInContext(body, ctx)
  }
  return { ctx, seen }
}

test('a peer-served pack still offers the next episode', () => {
  const { ctx } = rendererCtx()
  ctx._setPackFiles(packOf(12, 3), 'torrent')
  assert.ok(ctx._nextEpisodePackFile(), 'episode 4 is in the pack')
  assert.strictEqual(ctx._predownloadAvailable(), true,
    'this is the case the control was built for and it must keep working')
})

test('a debrid-served pack does not offer it', () => {
  const { ctx } = rendererCtx()
  ctx._setPackFiles(packOf(12, 3), 'debrid')
  assert.ok(ctx._nextEpisodePackFile(),
    'episode 4 is still listed — the strip is right, it is the download that is impossible')
  assert.strictEqual(ctx._predownloadAvailable(), false,
    'there is no torrent behind a debrid stream, so the button can only fail')
})

test('a pack event that says nothing is treated as peer-served, as every old one was', () => {
  const { ctx } = rendererCtx()
  ctx._setPackFiles(packOf(12, 3))
  assert.strictEqual(ctx._predownloadAvailable(), true)
})

test('switching episode inside a debrid pack does not quietly re-enable it', () => {
  const { ctx } = rendererCtx()
  ctx._setPackFiles(packOf(12, 3), 'debrid')
  // video-pack-select hands back a fresh file list with no origin on it: the
  // source has not changed, only which file of it is playing.
  ctx._setPackFiles(packOf(12, 4))
  assert.strictEqual(ctx._predownloadAvailable(), false,
    'the pack is still the same debrid-served pack')
})

test('the control is repainted every time the list changes', () => {
  const { ctx, seen } = rendererCtx()
  ctx._setPackFiles(packOf(12, 3), 'debrid')
  ctx._setPackFiles([])
  assert.strictEqual(seen.painted, 2, 'a stale bar left on screen is its own bug')
})
