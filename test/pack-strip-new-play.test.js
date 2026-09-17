'use strict'
// Starting anything new must not inherit the last thing's episode list.
//
// The strip is only ever replaced by a pack event, and a play that is not a
// pack never sends one. So opening a film straight after a season pack left
// the season's twelve episodes sitting under the film, and opening another
// show's pack left the previous show's list up until the new torrent went
// ready — up to 45 seconds, or for ever if it failed.
//
// It is not only cosmetic. Both readers of that list act on the CURRENT
// stream: clicking an entry sends its index to video-pack-select, and
// "Download next episode" sends its index to video-predownload. An index from
// the previous release addresses a different file, or no file at all.
//
// This EXECUTES the real _videoPlayResult. It is a large function with a great
// many collaborators, so everything it touches that this test does not care
// about answers with a permissive stub — while _packFiles, _setPackFiles,
// _forgetPackStrip and the deck's setPack are the real thing. Removing the
// clear turns the assertions red, which is what keeps the stubs honest.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function bodyOf(name) {
  const at = RENDERER.indexOf('function ' + name + '(')
  assert.ok(at > 0, name + ' exists')
  let depth = 0
  const open = RENDERER.indexOf('{', at)
  for (let j = open; j < RENDERER.length; j++) {
    if (RENDERER[j] === '{') depth++
    else if (RENDERER[j] === '}') { depth--; if (!depth) return RENDERER.slice(at, j + 1) }
  }
  throw new Error('unterminated ' + name)
}

// A season pack of the show that was playing a moment ago.
const LAST_PACK = [
  { index: 3, name: 'Show - 07.mkv', group: '', length: 1e9, episode: 7, current: true },
  { index: 5, name: 'Show - 08.mkv', group: '', length: 1e9, episode: 8, current: false },
]

function harness() {
  const seen = { setPack: [], opened: 0 }
  // Anything unnamed below is a stub that accepts every call, every property
  // read and every construction, so the function under test runs to its end
  // instead of tripping over a collaborator this test has no opinion about.
  const anything = new Proxy(function () {}, {
    get (_t, k) {
      // .then/.catch chain rather than resolve: the play path fires several
      // best-effort promises whose callbacks are irrelevant here, and it is
      // itself synchronous, so nothing ever awaits one of these.
      // A stub often ends up inside a string or a comparison, so it has to be
      // able to become a primitive rather than throwing.
      if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return () => ''
      if (k === Symbol.iterator) return function * () {}
      if (typeof k === 'symbol') return undefined
      return anything
    },
    apply () { return anything },
    construct () { return anything },
  })
  const named = {
    console, Object, Array, Number, String, Boolean, Math, JSON, Date, Promise,
    RegExp, setTimeout, clearTimeout, isNaN, parseInt, parseFloat,
    _updatePredownloadControl () {},
    _player: {
      setPack (files) { seen.setPack.push(files && files.length) },
      open () { seen.opened++ },
      setSegments () {}, setStageMessage () {}, setUpNext () {}, setPrefs () {},
    },
  }
  const store = {}
  const ctx = new Proxy(store, {
    has () { return true },
    get (t, k) {
      if (k in t) return t[k]
      if (k in named) return named[k]
      return typeof k === 'symbol' ? undefined : anything
    },
    set (t, k, v) { t[k] = v; return true },
  })
  vm.createContext(ctx)

  // The real pack state, the real clear, and the real play entry point.
  const predlStart = RENDERER.indexOf('var _packFiles = []')
  const predlEnd = RENDERER.indexOf('function _updatePredownloadControl(')
  assert.ok(predlStart > 0 && predlEnd > predlStart, 'found the pack-state block')
  vm.runInContext(RENDERER.slice(predlStart, predlEnd), ctx)
  vm.runInContext(bodyOf('_forgetPackStrip'), ctx)
  vm.runInContext(bodyOf('_videoPlayResult'), ctx)
  // Seeded AFTER the block runs — it carries `var _packFiles = []`, which
  // would otherwise wipe the state this test is about.
  store._packFiles = LAST_PACK.slice()
  store._packVia = 'debrid'
  return { ctx, store, seen }
}

test('starting a new play drops the previous release’s episode list', () => {
  const { ctx, store, seen } = harness()
  assert.strictEqual(store._packFiles.length, 2, 'the last pack is still held to begin with')

  ctx._videoPlayResult({ kind: 'torrent', magnet: 'magnet:new', quality: '1080p' })

  assert.strictEqual(store._packFiles.length, 0,
    'the new stream must not be addressed with the old release’s file numbers')
  assert.ok(seen.setPack.length >= 1, 'and the strip on screen is emptied with it')
  assert.strictEqual(seen.setPack[0], 0)
  assert.ok(seen.opened >= 1, 'the play really did run through to opening the theatre')
})

test('a play with nothing to play changes nothing', () => {
  const { ctx, store, seen } = harness()
  ctx._videoPlayResult(null)
  assert.strictEqual(store._packFiles.length, 2, 'no play, no reset')
  assert.strictEqual(seen.setPack.length, 0)
  assert.strictEqual(seen.opened, 0)
})
