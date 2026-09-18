'use strict'
// M5 — an unclean exit put up two competing Resume snackbars.
//
// The renderer detects the crash itself (no pagehide flag) and offered
// "Pick up where you left off? (28 tracks)" 1.2s into boot, whose Resume
// rebuilt the queue paused at the saved position. main ALSO sends
// app-recovered-from-crash, and that handler put up a second snackbar —
// "Last time ended mid-track — 05 - track.flac at 2:35" — printing the raw
// filename, with a Resume that started playing instead. Two offers, two
// different behaviours, one of them unreadable.
//
// One offer now, from _offerCrashRestore, whichever trigger gets there first.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(source, name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(source)
  assert.ok(m, `${name} not found in the renderer`)
  const start = m.index + 1
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has no closing brace`)
  return source.slice(start, end + 2)
}

// The handler main's event runs, lifted out of init() by its own comment
// anchor so the test drives the real body rather than a transcription.
function liftCrashHandler(source) {
  const at = source.indexOf("window.api.on('app-recovered-from-crash'")
  assert.ok(at > -1, 'the app-recovered-from-crash listener must still exist')
  const end = source.indexOf('\n  })\n', at)
  assert.ok(end > at)
  const body = source.slice(source.indexOf('{', source.indexOf('=>', at)) + 1, end)
  return 'async function _onMainCrashEvent() {' + body + '\n}\n'
}

const AUTO_QUEUE = {
  id: '_auto',
  tracks: Array.from({ length: 28 }, (_, i) => ({
    filePath: '/mnt/data/MUSIC/OK Computer/0' + i + ' - track.flac',
    title: i === 5 ? 'Karma Police' : 'Track ' + i,
  })),
}

function harness(source, {
  uncleanExit = true,
  queues = [AUTO_QUEUE],
  playback = { filePath: '/mnt/data/MUSIC/OK Computer/05 - track.flac', position: 155 },
  library = [],
  playing = false,
} = {}) {
  const snackbars = []
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    _uncleanExit: uncleanExit,
    state: { library, queue: playing ? [{}] : [], isPlaying: playing, queueIndex: 0 },
    snackbars,
    window: {
      api: {
        getSavedQueues: async () => queues,
        getPlaybackState: async () => playback,
      },
    },
    showSnackbar(msg, action, fn, ms) { snackbars.push({ msg, action, fn, ms }) },
    fmtDur(sec) {
      const s = Math.floor(sec || 0)
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
    },
    _resumeCrashSession() { ctx.resumed = 'queue+position' },
    resumeFromSavedState() { ctx.resumed = 'play-only' },
    resumed: null,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext([
    lift(source, '_offerCrashRestore'),
    lift(source, '_crashRestoreTitle'),
    'var _crashRestoreOffered = false',
    liftCrashHandler(source),
  ].join('\n'), ctx)
  return {
    ctx, snackbars,
    boot: () => vm.runInContext('_offerCrashRestore()', ctx),
    fromMain: () => vm.runInContext('_onMainCrashEvent()', ctx),
  }
}

test('both triggers firing produces exactly one snackbar with one action', async () => {
  const h = harness(RENDERER)
  await h.fromMain()
  await h.boot()
  assert.strictEqual(h.snackbars.length, 1,
    'two snackbars is the bug: ' + h.snackbars.map(s => s.msg).join(' || '))
  assert.strictEqual(h.snackbars[0].action, 'Resume')
})

test('and in the other order too', async () => {
  const h = harness(RENDERER)
  await h.boot()
  await h.fromMain()
  assert.strictEqual(h.snackbars.length, 1)
})

test('the one snackbar names the track, not the filename', async () => {
  const h = harness(RENDERER)
  await h.boot()
  const msg = h.snackbars[0].msg
  assert.match(msg, /Karma Police/, 'the title the library knows')
  assert.doesNotMatch(msg, /\.flac/, 'the raw filename told the user nothing')
  assert.doesNotMatch(msg, /05 - track/)
})

test('it carries the position and the queue size', async () => {
  const h = harness(RENDERER)
  await h.boot()
  assert.match(h.snackbars[0].msg, /Pick up where you left off\?/)
  assert.match(h.snackbars[0].msg, /at 2:35/)
  assert.match(h.snackbars[0].msg, /28 tracks/)
})

test('the title can come from the library when the saved queue has no metadata', async () => {
  const bare = { id: '_auto', tracks: [{ filePath: '/mnt/data/MUSIC/a/05.flac' }] }
  const h = harness(RENDERER, {
    queues: [bare],
    playback: { filePath: '/mnt/data/MUSIC/a/05.flac', position: 12 },
    library: [{ tracks: [{ filePath: '/mnt/data/MUSIC/a/05.flac', title: 'Paranoid Android' }] }],
  })
  await h.boot()
  assert.match(h.snackbars[0].msg, /Paranoid Android/)
})

test('and falls back to the filename only when nothing knows the track', async () => {
  const bare = { id: '_auto', tracks: [{ filePath: '/mnt/data/MUSIC/a/mystery.flac' }] }
  const h = harness(RENDERER, {
    queues: [bare],
    playback: { filePath: '/mnt/data/MUSIC/a/mystery.flac', position: 5 },
  })
  await h.boot()
  assert.match(h.snackbars[0].msg, /mystery\.flac/)
})

test('the one Resume restores the queue AND the position, never a bare play', async () => {
  const h = harness(RENDERER)
  await h.fromMain()
  h.snackbars[0].fn()
  assert.strictEqual(h.ctx.resumed, 'queue+position',
    'main’s Resume used to play the track and drop the rest of the queue')
})

test('a clean exit offers nothing', async () => {
  const h = harness(RENDERER, { uncleanExit: false })
  await h.boot()
  assert.strictEqual(h.snackbars.length, 0)
})

test('main’s event alone still answers when there is nothing to resume', async () => {
  const h = harness(RENDERER, { queues: [] })
  await h.fromMain()
  assert.strictEqual(h.snackbars.length, 1)
  assert.match(h.snackbars[0].msg, /did not shut down cleanly/)
  assert.strictEqual(h.snackbars[0].action, '', 'nothing to offer, so no action')
})

test('and the boot path stays silent in that case, as it always did', async () => {
  const h = harness(RENDERER, { queues: [] })
  await h.boot()
  assert.strictEqual(h.snackbars.length, 0)
})

test('someone already playing is left alone', async () => {
  const h = harness(RENDERER, { playing: true })
  await h.boot()
  assert.strictEqual(h.snackbars.length, 0)
})

// ── Mutation checks ─────────────────────────────────────────────────────────

test('MUTATION: dropping the once-only guards brings both snackbars back', () => {
  // Both guards: the entry one, and the re-check after the getPlaybackState
  // await that catches the two paths racing inside the same tick.
  const broken = RENDERER
    .replace('  if (!_uncleanExit || _crashRestoreOffered) return false',
      '  if (!_uncleanExit) return false')
    .replace('  if (_crashRestoreOffered) return false      // the other path won the await\n', '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  return Promise.resolve()
    .then(() => h.fromMain())
    .then(() => h.boot())
    .then(() => {
      assert.strictEqual(h.snackbars.length, 2, 'this is the reported bug')
    })
})

test('MUTATION: main going back to its own snackbar is two again, with the filename', () => {
  const broken = RENDERER.replace(
    '    _uncleanExit = true\n    await _offerCrashRestore({ notifyIfNothing: true })',
    "    var _s = await window.api.getPlaybackState()\n" +
    "    showSnackbar('Last time ended mid-track \u2014 ' + (_s.filePath || '').split('/').pop(), " +
    "'Resume', function () { resumeFromSavedState(_s) }, 12000)")
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  return Promise.resolve()
    .then(() => h.fromMain())
    .then(() => h.boot())
    .then(() => {
      assert.strictEqual(h.snackbars.length, 2, 'this is the reported bug')
      assert.match(h.snackbars[0].msg, /\.flac/, 'and it printed the raw filename')
    })
})

test('MUTATION: resolving the title straight off the path prints the filename again', () => {
  const broken = RENDERER.replace(
    '  var bits = [_crashRestoreTitle(filePath, queued)]',
    "  var bits = [(filePath || '').split('/').pop()]")
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  return h.boot().then(() => {
    assert.match(h.snackbars[0].msg, /05 - track\.flac/, 'this is the reported bug')
  })
})
