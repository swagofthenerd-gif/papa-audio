'use strict'
// Switching source must forget the episode list of the release being left.
//
// The episode strip is fed by a `kind:'pack'` event, and the two halves of the
// app that send one number their files DIFFERENTLY. TorrentStreamer.files()
// reports a 0-based offset into the torrent's own file list; debrid's
// packFiles() reports RealDebrid's file id, which starts at 1 and counts the
// .nfo and the sample too. They share the field name `index` and nothing else.
//
// video-pack-select routes on whether a streamer exists, NOT on which half
// built the strip — and video-switch-stream installs a streamer the instant it
// is called. So from the moment a source is switched, the strip on screen
// belongs to the release just abandoned while the handler acts on the new one.
// Clicking episode 9 then opens whatever file happens to sit at RealDebrid's
// id 7 in the new torrent, and autoplay-next does it without being asked,
// because _playNextEpisode prefers the pack fast path.
//
// The new source announces its own episodes when it is ready — which is up to
// 45 seconds later, or never if it fails. Until then the strip must be empty
// rather than wrong.
//
// These EXECUTE _playerPickSource and _autoSwitchSource against fakes. A
// source-text match would have passed just as happily with the strip never
// being cleared.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// A pack strip exactly as a debrid-served play builds it: RealDebrid file ids,
// not torrent offsets.
const DEBRID_PACK = [
  { index: 3, name: 'Show - 07.mkv', group: '', length: 1e9, episode: 7, current: true },
  { index: 5, name: 'Show - 08.mkv', group: '', length: 1e9, episode: 8, current: false },
  { index: 7, name: 'Show - 09.mkv', group: '', length: 1e9, episode: 9, current: false },
]

const S = (o) => Object.assign({ kind: 'torrent', quality: '1080p', seeders: 80, sizeBytes: 2e9 }, o)

function harness(over) {
  over = over || {}
  const seen = { setPack: [], toasts: [], switched: [], predownload: 0 }
  const ctx = Object.assign({
    console, Number, String, Boolean, Array, Object, Math, JSON, Date, Promise,
    // A switch is now HELD until the new source actually plays, with a timer
    // that gives up if it never does — so the lift needs real timers. Unref'd
    // so a pending switch cannot keep the test runner alive.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t },
    clearTimeout,

    // The real _setPackFiles is lifted below, so this is the live variable it
    // writes — not a stub standing in for it.
    _packFiles: DEBRID_PACK.slice(),
    // Which half produced the strip. Real module-level state in the renderer
    // (var _packVia = 'torrent'); the switch snapshots it so a failed switch
    // can put the strip back, and the lift needs it declared.
    _packVia: 'debrid',
    _updatePredownloadControl() { seen.predownload++ },

    _autoSwitchInFlight: false,
    _playSourceKey: '',
    _playing: { dub: false, source: 'nyaa', quality: '1080p' },
    _videoDetailTicket: 1,
    _videoSeasonTicket: 1,
    _videoDetail: { type: 'anime', id: 21, d: { id: 21, title: 'One Piece' } },
    _videoState: { season: null, episode: 7 },
    _videoStreams: [],
    _watch: { pick: null, tried: {}, key: 'anime:21::7' },

    _sourceKey: s => (s && (s.magnet || s.url)) || '',
    _playCtx: () => ({ detail: ctx._videoDetail, state: ctx._videoState, streams: ctx._videoStreams }),
    // Whether RealDebrid was already asked about this source and said no —
    // it decides whether the switch waits on debrid or goes straight to peers.
    // Supplied explicitly so these run against a real value rather than the
    // renderer's typeof fallback.
    _debridKnownMiss: () => false,
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

  // The real _setPackFiles, so _packFiles is genuinely the renderer's own.
  const sfStart = RENDERER.indexOf('function _setPackFiles(')
  assert.ok(sfStart > 0, 'found _setPackFiles')
  vm.runInContext(RENDERER.slice(sfStart, RENDERER.indexOf('\n}', sfStart) + 2), ctx)

  // The whole switch-source block, run for real. Anchored on the two
  // functions that bracket it rather than on anything the fix introduced, so
  // reverting the fix makes the ASSERTIONS fail rather than the slice.
  const start = RENDERER.indexOf('function _playerSourceList(')
  const end = RENDERER.indexOf('// Mark the sources-list row that matches what is actually playing')
  assert.ok(start > 0 && end > start, 'found the switch-source block')
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return { ctx, seen }
}

// ── The bug, from the viewer's seat ─────────────────────────────────────────

test('picking another source clears the episode strip of the source left behind', async () => {
  const next = S({ magnet: 'magnet:b', source: 'nyaa', title: '[Erai] Show - 07.mkv' })
  const { ctx, seen } = harness({ ctx: { _videoStreams: [next] } })
  assert.strictEqual(ctx._packFiles.length, 3, 'the old release’s strip is on screen to begin with')

  await ctx._playerPickSource('magnet:b')

  assert.strictEqual(seen.switched.length, 1, 'the switch really was requested')
  // Length, not deepStrictEqual: an array built inside the vm has the vm's own
  // Array.prototype, which deepStrictEqual counts as a difference.
  assert.strictEqual(ctx._packFiles.length, 0,
    'the abandoned release’s file list must not survive the switch')
  assert.ok(seen.setPack.length >= 1, 'the strip on screen was told as well')
  assert.strictEqual(seen.setPack[seen.setPack.length - 1].length, 0,
    'the strip is emptied, not left showing the old episodes')
})

test('the stall-driven switch clears it too — the viewer did not even ask for this one', async () => {
  const next = S({ magnet: 'magnet:c', source: 'apibay', title: '[C] Show - 07.mkv' })
  const { ctx, seen } = harness({ _nextUntried: next, ctx: { _videoStreams: [next] } })

  await ctx._autoSwitchSource()

  assert.strictEqual(seen.switched.length, 1)
  assert.strictEqual(ctx._packFiles.length, 0, 'an automatic switch leaves no stale strip either')
  assert.strictEqual(seen.setPack[seen.setPack.length - 1].length, 0)
})

// ── The cases that must NOT clear it ────────────────────────────────────────

test('a switch that failed leaves the strip alone — nothing was switched', async () => {
  const next = S({ magnet: 'magnet:b', source: 'nyaa', title: '[Erai] Show - 07.mkv' })
  const { ctx, seen } = harness({
    ctx: { _videoStreams: [next] },
    switchResult: { ok: false, error: 'no peers' },
  })

  await ctx._playerPickSource('magnet:b')

  assert.strictEqual(ctx._packFiles.length, 3,
    'the original release is still playing, so its episodes are still the right ones')
  assert.strictEqual(seen.setPack.length, 0)
})

test('a switch landing after the viewer walked off the page changes nothing', async () => {
  const next = S({ magnet: 'magnet:b', source: 'nyaa', title: '[Erai] Show - 07.mkv' })
  const { ctx, seen } = harness({
    ctx: {
      _videoStreams: [next],
      window: null, // replaced below so the ticket can move mid-flight
    },
  })
  // Rebuilt with a videoSwitchStream that navigates away while it is in flight.
  ctx.window = {
    PapaReleaseName: { parse: () => ({ group: null }) },
    api: {
      videoSwitchStream(arg) {
        seen.switched.push(arg)
        ctx._videoDetailTicket = 2 // the viewer opened a different show
        return Promise.resolve({ ok: true })
      },
    },
  }

  await ctx._playerPickSource('magnet:b')

  assert.strictEqual(seen.switched.length, 1)
  assert.strictEqual(ctx._packFiles.length, 3,
    'this switch belongs to a page that is gone; it must not touch what is on screen now')
})
