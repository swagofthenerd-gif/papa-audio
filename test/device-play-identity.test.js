'use strict'
// Playing a file from the On-device page must not inherit the last title's
// identity (2026-09-17).
//
// _videoPlayResult built the watch record inside a single `if (d) { … }`, where
// `d` is the detail page's title. There was no else. So a play with no title
// behind it — which is exactly what pressing Play on a cached episode is — left
// `_watch` holding the PREVIOUS film's key and meta, and every gate downstream
// reads `_watch.key`:
//
//     function _persistPosition(final, st) { if (!store || !_watch.key) return
//       store.setPosition(_watch.key, _watch.meta || {}, …) }
//
// So watching a cached episode wrote its position, its duration and its
// "watched" state onto whatever was watched before it. Silent, and it corrupts
// the one thing the video side is trusted to remember.
//
// This lifts the real assignment block and the real _persistPosition and runs
// them together, because the bug is in the pair: each half reads correctly on
// its own.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The watch-record block: the `if (d) { _watch = { key: _watchKey(…` and its
// else, brace-matched so it survives reformatting inside.
function watchBlock(source) {
  const at = source.indexOf('    _watch = {\n      key: _watchKey(')
  assert.ok(at > 0, 'the watch assignment is where it was')
  const start = source.lastIndexOf('  if (d) {', at)
  assert.ok(start > 0 && at - start < 200, 'and it is the body of an `if (d)`')
  let depth = 0
  for (let j = source.indexOf('{', start); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') {
      depth--
      if (!depth) {
        // Take the `else { … }` too when one follows.
        const tail = source.slice(j + 1, j + 10)
        if (/^\s*else\b/.test(tail)) {
          let d2 = 0
          for (let k = source.indexOf('{', j + 1); k < source.length; k++) {
            if (source[k] === '{') d2++
            else if (source[k] === '}') { d2--; if (!d2) return source.slice(start, k + 1) }
          }
        }
        return source.slice(start, j + 1)
      }
    }
  }
  throw new Error('unbalanced braces')
}

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// One scope holding the real block, the real _persistPosition and a real
// enough store to see what gets written.
function lift(source) {
  const writes = []
  const store = {
    setPosition(key, meta, position, duration) { writes.push({ key, meta, position, duration }) },
  }
  const fn = new Function('store', 'writes', `
    var _watch = { key: null, meta: null, savedAt: 0, resumed: false }
    var _player = null
    function _vStore() { return store }
    function _watchKey(type, id, season, episode) {
      return type + ':' + id + (season != null ? ':s' + season : '') + (episode != null ? ':e' + episode : '')
    }
    function _releaseGroupOf() { return null }
    ${extractFn(source, '_persistPosition')}
    // The shape _videoPlayResult has in scope at the point of the block.
    function startPlay(detail, stateNow, result, opts) {
      var pctx = { detail: detail, state: stateNow, streams: [] }
      var vd = pctx.detail
      var vs = pctx.state || { season: null, episode: 1, sub: true }
      var d = vd && vd.d
      var isEpisode = vd && vd.type !== 'movie'
      var startFromZero = false
      opts = opts || {}
      ${watchBlock(source)}
    }
    return {
      startPlay: startPlay,
      persist: function (st) { return _persistPosition(false, st) },
      watch: function () { return _watch },
      seed: function (w) { _watch = w },
    }
  `)(store, writes)
  return { ...fn, writes }
}

const EVANGELION = {
  type: 'anime',
  d: { id: 30, title: 'Neon Genesis Evangelion', poster: null },
}

test('a play from a title page writes under that title', () => {
  const h = lift(SRC)
  h.startPlay(EVANGELION, { season: null, episode: 2, sub: true }, { kind: 'torrent' }, {})
  assert.strictEqual(h.watch().key, 'anime:30:e2')
  h.persist({ position: 300, duration: 1400 })
  assert.strictEqual(h.writes.length, 1)
  assert.strictEqual(h.writes[0].key, 'anime:30:e2')
})

test('a play with no title behind it writes nowhere — it does not inherit the last one', () => {
  const h = lift(SRC)
  // Watch something first. This is the ordinary case: he has just been on a
  // title page, then goes to On device and presses Play on a cached file.
  h.startPlay(EVANGELION, { season: null, episode: 2, sub: true }, { kind: 'torrent' }, {})
  h.persist({ position: 300, duration: 1400 })
  assert.strictEqual(h.writes.length, 1)

  // Now the device play: no detail, no state, no streams.
  h.startPlay(null, null, { kind: 'cached', url: '/fixture/anime_11757_e1.mkv', title: 'Sword Art Online' }, { manual: true })
  assert.strictEqual(h.watch().key, null, 'the watch identity is cleared, not carried over')
  assert.strictEqual(h.watch().meta, null)

  h.persist({ position: 42, duration: 1400 })
  assert.strictEqual(h.writes.length, 1,
    'the cached file wrote nothing — in particular nothing under Evangelion')
  assert.strictEqual(h.writes[0].position, 300, 'and the real record is untouched')
})

test('the device play does not leave the old page steering Next/Previous', () => {
  const h = lift(SRC)
  h.startPlay(EVANGELION, { season: null, episode: 2, sub: true }, { kind: 'torrent' }, {})
  h.startPlay(null, null, { kind: 'cached', url: '/x.mkv' }, { manual: true })
  const ctx = h.watch().ctx
  assert.ok(ctx, 'the play still pins a context')
  assert.strictEqual(ctx.detail, null,
    'and it is the empty one, so the deck cannot advance the previous show')
})

test('MUTATION: with no else branch the cached file writes onto the last title', () => {
  const broken = SRC.replace('  } else {\n    // A play with no title behind it',
                             '  } else if (false) {\n    // A play with no title behind it')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = lift(broken)
  h.startPlay(EVANGELION, { season: null, episode: 2, sub: true }, { kind: 'torrent' }, {})
  h.startPlay(null, null, { kind: 'cached', url: '/x.mkv' }, { manual: true })
  assert.strictEqual(h.watch().key, 'anime:30:e2', 'the stale identity survives')
  h.persist({ position: 42, duration: 1400 })
  assert.strictEqual(h.writes[0].key, 'anime:30:e2')
  assert.strictEqual(h.writes[0].position, 42,
    'and Evangelion is rewound to the cached file’s position — the actual damage')
})
