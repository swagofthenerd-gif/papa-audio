'use strict'
// A switch must not be believed until the picture changes.
//
// Everything a switch altered used to be applied on `ok`, which means only
// that main accepted the request and began resolving — seconds, sometimes
// minutes, before anything plays. Four separate complaints came out of that
// one assumption:
//   * during every switch, and permanently after any failure, the list showed
//     source B as current while mpv was still on A's frozen frame;
//   * that row was marked current, so it could not even be picked again;
//   * the episode strip was emptied for a release that never arrived;
//   * the "one switch at a time" guard was released in milliseconds, so two
//     quick clicks raced each other.
//
// These EXECUTE the real functions against fakes. A source-text match would
// have passed just as happily with nothing being held back.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

const PACK = [{ index: 1, name: 'Show - 07.mkv' }, { index: 2, name: 'Show - 08.mkv' }]
const S = (o) => Object.assign({ kind: 'torrent', quality: '1080p', seeders: 80, sizeBytes: 2e9 }, o)

function harness(over) {
  over = over || {}
  const seen = { setPack: [], toasts: [], switched: [] }
  const ctx = Object.assign({
    console, Number, String, Boolean, Array, Object, Math, JSON, Date, Promise,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t },
    clearTimeout,
    _packFiles: PACK.slice(),
    _packVia: 'debrid',
    _updatePredownloadControl() {},
    _autoSwitchInFlight: false,
    _playSourceKey: '',
    _playing: { dub: false, source: 'old-source', quality: '720p' },
    _videoDetailTicket: 1,
    _videoSeasonTicket: 1,
    _videoDetail: { type: 'anime', id: 21, d: { id: 21, title: 'Show' } },
    _videoState: { season: null, episode: 7 },
    _videoStreams: [],
    _watch: { pick: { magnet: 'magnet:old', source: 'old-source' }, tried: {}, key: 'anime:21::7', autoSwitches: 0 },
    _sourceKey: s => (s && (s.magnet || s.url)) || '',
    _playCtx: () => ({ detail: ctx._videoDetail, state: ctx._videoState, streams: ctx._videoStreams }),
    _debridKnownMiss: () => false,
    _absoluteEpisodeFor: () => null,
    _nextUntriedSource: () => over._nextUntried || null,
    _rememberPreferredSource() {},
    _syncSourcesHighlight() {},
    _switchPackEpisode() {},
    _keepPackEpisode() {},
    _videoErrorText: m => String(m),
    showToast: m => seen.toasts.push(String(m)),
    _player: {
      setPack(files) { seen.setPack.push(Array.isArray(files) ? files.slice() : files) },
      syncSources() {},
      setStageMessage() {},
    },
    window: {
      PapaReleaseName: { parse: t => ({ group: (/^\[([^\]]+)\]/.exec(t || '') || [])[1] || null }) },
      api: {
        videoSwitchStream(arg) {
          seen.switched.push(arg)
          return Promise.resolve(over.switchResult || { ok: true })
        },
      },
    },
  }, over.ctx || {})
  vm.createContext(ctx)
  const sfStart = RENDERER.indexOf('function _setPackFiles(')
  vm.runInContext(RENDERER.slice(sfStart, RENDERER.indexOf('\n}', sfStart) + 2), ctx)
  const start = RENDERER.indexOf('function _playerSourceList(')
  const end = RENDERER.indexOf('// Mark the sources-list row that matches what is actually playing')
  assert.ok(start > 0 && end > start, 'found the switch-source block')
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return { ctx, seen }
}

const NEXT = S({ magnet: 'magnet:new', source: 'nyaa', quality: '1080p', title: '[Erai] Show - 07.mkv' })

test('starting a switch changes nothing the viewer can see about what is playing', async () => {
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  await ctx._playerPickSource('magnet:new')
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:old',
    'the list must still name the source that is actually on screen')
  assert.strictEqual(ctx._playing.source, 'old-source')
  assert.strictEqual(ctx._playSourceKey, '', 'and no standing preference is set')
  assert.ok(ctx._switchPending, 'the switch is held, not forgotten')
  assert.strictEqual(ctx._autoSwitchInFlight, true, 'and it still counts as in flight')
})

test('the picture arriving is what commits it', async () => {
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  await ctx._playerPickSource('magnet:new')
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:new' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:new')
  assert.strictEqual(ctx._playing.source, 'nyaa')
  assert.strictEqual(ctx._playSourceKey, 'magnet:new')
  assert.strictEqual(ctx._switchPending, null)
  assert.strictEqual(ctx._autoSwitchInFlight, false, 'and the guard is released')
  assert.ok(ctx._watch.sourceCandidate, 'the preference is a candidate, earned by playing on')
})

test('a picture that NAMES a different source abandons it rather than crediting it', async () => {
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  await ctx._playerPickSource('magnet:new')
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:somethingelse' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:old', 'nothing is credited to the switch')
  assert.strictEqual(ctx._switchPending, null)
  assert.strictEqual(ctx._autoSwitchInFlight, false)
})

test('an UNIDENTIFIED picture neither commits nor abandons it', async () => {
  // The rule this test used to assert — that any `playing` supersedes — IS the
  // bug. Six other places in main send a plain `playing` with no identity on
  // it, and reading one of those as supersession abandoned a switch that was
  // about to succeed: the new source played while the list went on naming the
  // old one. Reported as "list shows the wrong source".
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  await ctx._playerPickSource('magnet:new')
  ctx._resolveSwitchOnPlaying({ kind: 'playing' })
  assert.ok(ctx._switchPending, 'the switch must still be waiting for its own answer')
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:old', 'and nothing is committed early')
  // Its real answer still lands, and still commits.
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:new' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:new')
  assert.strictEqual(ctx._switchPending, null)
  assert.strictEqual(ctx._autoSwitchInFlight, false)
})

test('a switch that never arrives gives the source back its place, and the strip back', async () => {
  const { ctx, seen } = harness({ ctx: { _videoStreams: [NEXT] } })
  await ctx._playerPickSource('magnet:new')
  assert.strictEqual(ctx._packFiles.length, 0, 'the strip is cleared while the switch is under way')
  assert.ok(ctx._watch.tried['magnet:new'], 'and the source is marked tried')

  ctx._abandonSwitch(ctx._switchPending, 'That source never started.')
  assert.ok(!ctx._watch.tried['magnet:new'],
    'a source that never played must not be hidden from the list for the episode')
  assert.strictEqual(ctx._packFiles.length, 2,
    'and the old release is still playing, so its episode strip is still the true one')
  assert.ok(seen.toasts.some(t => /never started/.test(t)), 'and the viewer is told')
})

test('an automatic switch that never arrives gets its budget back', async () => {
  const { ctx } = harness({
    ctx: { _videoStreams: [NEXT], _watch: { pick: { magnet: 'magnet:old' }, tried: {}, key: 'k', autoSwitches: 0, stallEvents: 2 } },
    _nextUntried: NEXT,
  })
  await ctx._autoSwitchSource()
  assert.strictEqual(ctx._watch.autoSwitches, 1, 'it spent one while trying')
  ctx._abandonSwitch(ctx._switchPending, null)
  assert.strictEqual(ctx._watch.autoSwitches, 0,
    'two failures used to exhaust the episode\'s recovery for good')
})

test('a second deliberate pick supersedes the first instead of being ignored', async () => {
  const other = S({ magnet: 'magnet:third', source: 'eztv', title: '[X] Show - 07.mkv' })
  const { ctx, seen } = harness({ ctx: { _videoStreams: [NEXT, other] } })
  await ctx._playerPickSource('magnet:new')
  assert.ok(ctx._switchPending)
  await ctx._playerPickSource('magnet:third')
  assert.strictEqual(seen.switched.length, 2, 'the second click must actually do something')
  assert.strictEqual(ctx._switchPending.next.magnet, 'magnet:third', 'and it is the one now pending')
})

test('an automatic switch defers while one is already under way', async () => {
  const { ctx, seen } = harness({ ctx: { _videoStreams: [NEXT] }, _nextUntried: NEXT })
  await ctx._playerPickSource('magnet:new')
  const before = seen.switched.length
  await ctx._autoSwitchSource()
  assert.strictEqual(seen.switched.length, before,
    'a stall must not race the switch the viewer just asked for')
})

// ── the viewer's choice is the viewer's ("if i select a source, the player
// should not auto switch to anything else other than what i select") ───────
test('a source chosen by hand is never switched away from automatically', async () => {
  const other = S({ magnet: 'magnet:third', source: 'eztv', title: '[X] Show - 07.mkv' })
  const { ctx, seen } = harness({ ctx: { _videoStreams: [NEXT, other] }, _nextUntried: other })
  await ctx._playerPickSource('magnet:new')
  assert.strictEqual(ctx._watch.manualPick, true, 'the choice is recorded as his')
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:new' })

  const before = seen.switched.length
  const out = await ctx._autoSwitchSource()
  assert.strictEqual(out, false, 'the automatic switch must stand down')
  assert.strictEqual(seen.switched.length, before, 'and must not request anything')
  assert.ok(seen.toasts.some(t => /stalled/i.test(t) && /pick another/i.test(t)),
    'but he is told, so a dead source is not silent: ' + JSON.stringify(seen.toasts))
})

test('it says so once, not on every stall', async () => {
  const { ctx, seen } = harness({ ctx: { _videoStreams: [NEXT] }, _nextUntried: NEXT })
  await ctx._playerPickSource('magnet:new')
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:new' })
  await ctx._autoSwitchSource()
  await ctx._autoSwitchSource()
  await ctx._autoSwitchSource()
  const said = seen.toasts.filter(t => /stalled/i.test(t) && /pick another/i.test(t))
  assert.strictEqual(said.length, 1, 'a stall storm must not become a toast storm')
})

test('a source picked from the list counts as chosen by hand too', () => {
  const R = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = R.indexOf('// What is actually playing, so the auto-switch can avoid re-picking it.')
  assert.ok(at > 0)
  assert.match(R.slice(at, at + 400), /manualPick: opts\.manual === true/)
})

// ── the switch must ask for the episode that is PLAYING ────────────────────
test('browsing another episode does not make the switch fetch that one', async () => {
  // _playCtx().state is a LIVE reference to _videoState, and clicking a row in
  // the episode list mutates it without playing anything. Watching episode 3
  // while episode 9 is highlighted made a switch come back with episode 9.
  const { ctx, seen } = harness({
    ctx: {
      _videoStreams: [NEXT],
      _videoState: { season: null, episode: 9 },
      _watch: {
        pick: { magnet: 'magnet:old' }, tried: {}, key: 'anime:21::3', autoSwitches: 0,
        meta: { type: 'anime', id: 21, season: null, episode: 3 },
      },
    },
  })
  await ctx._playerPickSource('magnet:new')
  assert.strictEqual(seen.switched.length, 1)
  assert.strictEqual(seen.switched[0].result.episode, 3,
    'the switch must ask for what is playing, not for what the list is showing')
})

test('with nothing pinned it still falls back to the page, rather than asking for nothing', async () => {
  const { ctx, seen } = harness({
    ctx: {
      _videoStreams: [NEXT],
      _videoState: { season: null, episode: 7 },
      _watch: { pick: { magnet: 'magnet:old' }, tried: {}, key: 'k', autoSwitches: 0, meta: null },
    },
  })
  await ctx._playerPickSource('magnet:new')
  assert.strictEqual(seen.switched[0].result.episode, 7)
})

// ── the list must name what is PLAYING, however it got there ───────────────
// "its showing a different source then the one its playing", reported twice.
//
// Holding the change until a switch confirms was right, but it left a hole: a
// switch that outran its confirmation window was abandoned, and when the
// picture finally arrived there was no pending switch left to accept it — so
// the new source played while the list went on naming the old one.
test('a picture arriving after the switch gave up is still adopted', async () => {
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  await ctx._playerPickSource('magnet:new')
  // The confirmation window elapses before the picture arrives.
  ctx._abandonSwitch(ctx._switchPending, null)
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:old', 'nothing was committed, correctly')

  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:new' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:new',
    'the list must follow what is actually playing')
  assert.strictEqual(ctx._playing.source, 'nyaa')
})

test('a picture naming a source nobody asked for is still adopted', async () => {
  // An automatic recovery inside main, or a play started elsewhere: whatever
  // it is, the row that is marked has to be the row that is playing.
  const other = S({ magnet: 'magnet:third', source: 'eztv', quality: '720p', title: '[X] Show - 07.mkv' })
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT, other] } })
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:third' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:third')
  assert.strictEqual(ctx._playing.quality, '720p')
})

test('a picture naming something not in the list changes nothing', async () => {
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  ctx._resolveSwitchOnPlaying({ kind: 'playing', switchedTo: 'magnet:unknown' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:old', 'no guessing at what it might be')
})

test('an unidentified picture still says nothing about which source it is', async () => {
  const { ctx } = harness({ ctx: { _videoStreams: [NEXT] } })
  ctx._resolveSwitchOnPlaying({ kind: 'playing' })
  assert.strictEqual(ctx._watch.pick.magnet, 'magnet:old')
})
