'use strict'
// L4 — "Still analysing your library — try again shortly" for a finished pass.
//
// startSmartQueue printed that one line for ANY empty result: a build that
// never answered, a pass still running, and a pass that had finished and
// simply had nothing to offer. Live, queueBuild({mode:'rediscover'}) came back
// { featuresReady: true, n: 0 } and the user was told to wait for analysis that
// had already stopped — so waiting and retrying gets the same message forever.
//
// The empty case now branches on what actually happened.
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

function harness(source, result) {
  const snackbars = []
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Number,
    snackbars,
    state: { queue: [], queueIndex: -1, queuePanelOpen: false },
    _oldQueue: { stale: true },
    window: {
      api: {
        queueBuild: async () => {
          if (result === 'reject') throw new Error('main went away')
          return result
        },
      },
    },
    showSnackbar(msg) { snackbars.push(msg) },
    playCurrentTrack() { ctx.played = true },
    renderQueuePanel() {},
    played: false,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(
    source.slice(source.indexOf("var SMART_QUEUE_MODES = "), source.indexOf("var SMART_QUEUE_MODES = ")) +
    source.slice(source.indexOf('// What to say when the build came back'), source.indexOf('async function startSmartQueue')) +
    lift(source, 'startSmartQueue'), ctx)
  return {
    ctx, snackbars,
    start: (mode) => vm.runInContext(`startSmartQueue(${JSON.stringify(mode)})`, ctx),
  }
}

test('a finished analysis with nothing to offer says so, not "still analysing"', async () => {
  const h = harness(RENDERER, { ok: true, featuresReady: true, tracks: [] })
  const out = await h.start('rediscover')
  assert.strictEqual(out, null)
  assert.deepStrictEqual(h.snackbars, ['Nothing to rediscover yet — play more first'])
})

test('and an analysis that really is still running still says to wait', async () => {
  const h = harness(RENDERER, { ok: true, featuresReady: false, tracks: [] })
  await h.start('rediscover')
  assert.deepStrictEqual(h.snackbars, ['Still analysing your library — try again shortly'])
})

test('each mode gets copy that means something for that mode', async () => {
  const seen = {}
  for (const mode of ['radio', 'mix', 'surprise', 'rediscover']) {
    const h = harness(RENDERER, { ok: true, featuresReady: true, tracks: [] })
    await h.start(mode)
    assert.strictEqual(h.snackbars.length, 1, mode)
    assert.doesNotMatch(h.snackbars[0], /analysing/i,
      mode + ' still blamed the analysis for a finished pass')
    seen[mode] = h.snackbars[0]
  }
  assert.strictEqual(new Set(Object.values(seen)).size, 4, 'four modes, four answers')
})

test('a build that never answered is reported as a failure, not as pending work', async () => {
  const h = harness(RENDERER, 'reject')
  await h.start('surprise')
  assert.strictEqual(h.snackbars.length, 1)
  assert.doesNotMatch(h.snackbars[0], /analysing/i)
  assert.match(h.snackbars[0], /try again/)
})

test('an unknown mode still gets an honest line rather than nothing', async () => {
  const h = harness(RENDERER, { ok: true, featuresReady: true, tracks: [] })
  await h.start('somethingelse')
  assert.strictEqual(h.snackbars.length, 1)
  assert.match(h.snackbars[0], /Nothing to play there yet/)
})

test('a successful build still plays and says nothing', async () => {
  const h = harness(RENDERER, { ok: true, featuresReady: true, tracks: [{ filePath: '/a.flac' }] })
  const out = await h.start('surprise')
  assert.ok(out, 'the result is returned')
  assert.strictEqual(h.ctx.played, true)
  assert.deepStrictEqual(h.snackbars, [])
  assert.strictEqual(h.ctx.state.queue.length, 1)
})

test('a successful build on an UNFINISHED analysis still warns it is general', async () => {
  const h = harness(RENDERER, { ok: true, featuresReady: false, tracks: [{ filePath: '/a.flac' }] })
  await h.start('surprise')
  assert.strictEqual(h.snackbars.length, 1)
  assert.match(h.snackbars[0], /general queue/)
})

test('MUTATION: one message for every empty result blames the analysis again', async () => {
  const broken = RENDERER.replace(
    /    \/\/ A build that never answered is a failure, not a pending analysis\.\n    if \(!result\)[\s\S]*?\n    else showSnackbar\(_SMART_QUEUE_NOTHING\[mode\] \|\| 'Nothing to play there yet'\)\n/,
    "    showSnackbar('Still analysing your library — try again shortly')\n")
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken, { ok: true, featuresReady: true, tracks: [] })
  await h.start('rediscover')
  assert.deepStrictEqual(h.snackbars, ['Still analysing your library — try again shortly'],
    'this is the reported bug')
})
