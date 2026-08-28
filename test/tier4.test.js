'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const RENDERER = root('src/renderer.js')
const MAIN = root('main.js')
const CSS = root('src/styles.css')

// ── 4.1: a card announced as a button must be activatable ──────────────────

test('every focusable card class has a real click handler', () => {
  // The a11y sweep gives each of these tabindex="0" and role="button", and the
  // delegated Enter/Space handler calls card.click(). .discovery-swipe-card was
  // in that list with no click listener anywhere -- only mousedown/mouseup on
  // its container -- so it was announced as a button and Enter did nothing.
  const sweepAt = RENDERER.indexOf("document.querySelectorAll('#content .album-card")
  assert.ok(sweepAt > 0, 'found the a11y sweep')
  const sweepLine = RENDERER.slice(sweepAt, RENDERER.indexOf('\n', sweepAt))
  const classes = [...sweepLine.matchAll(/#content \.([a-z0-9-]+)/g)].map(m => m[1])
  assert.ok(classes.length >= 15, `found ${classes.length} focusable classes`)

  // The two selector lists -- the a11y sweep and the keyboard-activation
  // handler -- name every class and neither is a click handler, so both are
  // excluded or every class would look bound.
  const lines = RENDERER.split('\n').filter(l =>
    !l.includes("#content .album-card") && !l.includes('.album-card,.quick-card'))

  // A class is activatable if it is mentioned within a few lines of a click
  // listener. Both spellings count: as a class selector (.jumpback-card) and as
  // an id (getElementById('jumpback-card')) -- several cards carry the class
  // and are bound by id, which is the same element either way.
  const WINDOW = 12
  const missing = classes.filter(cls => {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('.' + cls) && !lines[i].includes("'" + cls + "'")) continue
      const around = lines.slice(Math.max(0, i - WINDOW), i + WINDOW).join('\n')
      if (around.includes("addEventListener('click'")) return false
    }
    return true
  })
  assert.deepStrictEqual(missing, [], 'announced as buttons, not activatable')
})

test('the Discover container handles click, and a swipe does not double-fire', () => {
  const fn = RENDERER.slice(RENDERER.indexOf("var swipeEl = document.getElementById('discovery-swipe')"),
                            RENDERER.indexOf("document.querySelectorAll('.era-chip')"))
  assert.match(fn, /swipeEl\.addEventListener\('click'/)
  // Whether pointer capture also produces a synthetic click is
  // implementation-dependent, so the pointer path is authoritative and the
  // click handler ignores anything right after a gesture.
  assert.match(fn, /_swipeHandledAt = Date\.now\(\)/)
  assert.match(fn, /Date\.now\(\) - _swipeHandledAt < 400/)
  assert.match(fn, /navigate\('album', card\.dataset\.album\)/)
})

// ── 4.2: every command main sends must be handled ──────────────────────────

test('the renderer handles every media-key command main sends', () => {
  const sent = new Set([...MAIN.matchAll(/send\('([a-z-]+)'\)/g)].map(m => m[1]))
  assert.ok(sent.size >= 5, `main sends ${sent.size} commands`)
  const h = RENDERER.slice(RENDERER.indexOf("window.api.on('media-key'"),
                           RENDERER.indexOf("window.api.on('media-key'") + 900)
  const handled = new Set([...h.matchAll(/key === '([a-z-]+)'/g)].map(m => m[1]))
  const unhandled = [...sent].filter(c => !handled.has(c)).sort()
  assert.deepStrictEqual(unhandled, [],
    "a desktop applet's Play, Pause and Stop buttons were all inert")
  assert.match(h, /console\.warn.*unhandled media key/, 'and a new one says so')
})

test('MPRIS Stop stops rather than pausing', () => {
  assert.doesNotMatch(MAIN, /mprisPlayer\.on\('stop',\s*\(\) => send\('pause'\)\)/)
  assert.match(MAIN, /mprisPlayer\.on\('stop',\s*\(\) => send\('stop'\)\)/)
  assert.match(RENDERER, /function mediaStop\(\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('function mediaStop()'),
                            RENDERER.indexOf('// \u2500\u2500 Playback engine state, visible'))
  assert.match(fn, /audio\.currentTime = 0/, 'stop returns to the start')
  assert.match(fn, /_dom\.fill\.style\.width = '0%'/,
    'the bar is painted from timeupdate, which will not fire again while paused')
})

// ── 4.3: shuffle must not pick what is already playing ─────────────────────

test('the shuffle fallback never returns the current index', () => {
  // Run, not read. Measured over 200,000 runs the old bare-random fallback
  // returned the current track 12.5% of the time on a two-track queue.
  const src = RENDERER.slice(RENDERER.indexOf('function pickShuffleIndex('),
                             RENDERER.indexOf('function playPrev()'))
  const state = { queueIndex: 0 }
  // eslint-disable-next-line no-new-func
  const pick = new Function('state', src + '; return pickShuffleIndex')(state)

  for (const len of [2, 3, 12]) {
    const queue = Array.from({ length: len }, () => ({ artist: 'One Artist' }))
    for (let cur = 0; cur < len; cur++) {
      state.queueIndex = cur
      // Every index "recent" forces the fallback on most attempts, which is the
      // single-artist album case this app is mostly used for.
      const recent = queue.map((_, i) => i)
      for (let i = 0; i < 20000; i++) {
        const idx = pick(queue, recent)
        assert.notStrictEqual(idx, cur, `len=${len} cur=${cur} returned the current track`)
        assert.ok(idx >= 0 && idx < len, `len=${len} returned ${idx}`)
      }
    }
  }
})

test('a single-track queue still returns 0', () => {
  const src = RENDERER.slice(RENDERER.indexOf('function pickShuffleIndex('),
                             RENDERER.indexOf('function playPrev()'))
  const state = { queueIndex: 0 }
  // eslint-disable-next-line no-new-func
  const pick = new Function('state', src + '; return pickShuffleIndex')(state)
  assert.strictEqual(pick([{ artist: 'a' }], [0]), 0)
})

// ── 4.4-4.6: classes the app applies that had no rule at all ───────────────

test('every class the app applies exists in the stylesheet', () => {
  // .progress-tooltip, .loading-wrap, .spinner and .listening were applied by
  // the app and matched no selector, so each element existed and did nothing:
  // the seek preview joined the normal flow inside the 5px progress bar and
  // distorted it, the first-scan spinner was a zero-size empty div, and the mic
  // button had no way to show it was recording.
  for (const cls of ['progress-tooltip', 'loading-wrap', 'spinner', 'listening']) {
    assert.ok(CSS.includes('.' + cls), '.' + cls + ' has no rule')
  }
})

test('the seek tooltip is positioned and does not eat the drag', () => {
  const at = CSS.indexOf('.progress-tooltip {')
  const rule = CSS.slice(at, CSS.indexOf('}', at))
  assert.match(rule, /position:\s*absolute/, 'without a position the left is ignored')
  assert.match(rule, /pointer-events:\s*none/, 'or it sits under the cursor it follows')
  assert.match(rule, /z-index/)
  // The modal shares the element and positions it against the viewport, so it
  // must undo the bar's transform explicitly.
  const modal = RENDERER.slice(RENDERER.indexOf("modalTrack.addEventListener('mousemove'"),
                               RENDERER.indexOf("modalTrack.addEventListener('mousemove'") + 1400)
  assert.match(modal, /tooltip\.style\.transform = 'none'/)
  const leave = RENDERER.slice(RENDERER.indexOf("modalTrack.addEventListener('mouseleave'"),
                               RENDERER.indexOf("modalTrack.addEventListener('mouseleave'") + 600)
  assert.match(leave, /tooltip\.style\.transform = ''/,
    'or the player bar inherits the modal positioning for the rest of the session')
})

test('the spinner and the listening pulse respect reduced motion', () => {
  const reduced = [...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^}]*\}[^}]*)\}/g)]
    .map(m => m[1]).join('\n')
  assert.match(reduced, /\.spinner \{ animation: none/)
  assert.match(reduced, /\.listening \{ animation: none/)
})

// ── 4.7: stacked LRC timestamps ────────────────────────────────────────────

test('a chorus repeated with stacked timestamps yields one entry each', () => {
  const { parseLrc } = require('../lyrics.js')
  const out = parseLrc('[00:10.00][00:20.00]same line twice\n[00:15.50]middle\n')
  assert.deepStrictEqual(out, [
    { time: 10, text: 'same line twice' },
    { time: 15.5, text: 'middle' },
    { time: 20, text: 'same line twice' },
  ])
  // The literal timestamp used to be left in the text.
  assert.ok(!out.some(l => l.text.includes('[')), 'no raw timestamp in the text')
})

test('parseLrc skips metadata and accepts colon centiseconds', () => {
  const { parseLrc } = require('../lyrics.js')
  const out = parseLrc('[ar:Someone]\n[length:03:21]\n[01:00:25]colon form\nno timestamp\n')
  assert.deepStrictEqual(out, [{ time: 60.25, text: 'colon form' }])
})

test('parseLrc still returns null for nothing usable', () => {
  const { parseLrc } = require('../lyrics.js')
  assert.strictEqual(parseLrc(''), null)
  assert.strictEqual(parseLrc(null), null)
  assert.strictEqual(parseLrc('just some plain lyrics\nwith no timing'), null)
})

// ── 4.8 and 4.9 ────────────────────────────────────────────────────────────

test('cover art no longer diverges from its own card', () => {
  // Right-clicking the largest and easiest-to-hit part of an album card gave
  // "Path copied" instead of the album menu.
  assert.doesNotMatch(RENDERER, /querySelectorAll\('\.album-card-art'\)/)
})

test('the artwork progress bar is painted after each item', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('const missing = state.library.filter(a => !a.artPath)'),
                            RENDERER.indexOf('function patchAlbumArtInDOM'))
  assert.match(fn, /\(\(i \+ 1\) \/ missing\.length\)/,
    'computed before the item, the bar sat one behind its own label')
  // The fill assignment must come after the await, not before it.
  const fillAt = fn.indexOf('fillEl.style.width = `')
  const awaitAt = fn.indexOf('await window.api.fetchAlbumArt')
  assert.ok(awaitAt > 0 && fillAt > awaitAt, 'the paint follows the fetch')
  assert.match(fn, /if \(!artFetchCancelled\) fillEl\.style\.width = '100%'/,
    'a cancel used to snap the bar full and then say "Cancelled" underneath it')
})
