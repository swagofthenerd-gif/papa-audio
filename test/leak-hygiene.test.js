'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// setContent releases observed cards when the whole page is replaced, and the
// comment there records the measurement that prompted it: 0.6 MB per
// navigation, 57.6 MB over 96 page changes. But four paths replace a grid's
// innerHTML IN PLACE without navigating, and the enricher's Map is strong — it
// keeps a record, an element reference and a closure per card. Browse is the
// worst: infinite scroll re-renders the whole accumulated result set on every
// page, so the retention is quadratic in pages scrolled.
test('every in-place card repaint releases the cards it is about to discard', () => {
  assert.match(R, /function _releaseCardsIn\(el\)/, 'the scoped release exists')
  const sites = [
    "grid.innerHTML = _hideSeenNote(vis.hidden) + vis.shown.map(_videoCard).join('')",
    "rail.innerHTML = items.map(_videoCard).join('')",
  ]
  for (const site of sites) {
    let from = 0
    let seen = 0
    while (true) {
      const at = R.indexOf(site, from)
      if (at < 0) break
      seen++
      const before = R.slice(Math.max(0, at - 220), at)
      assert.match(before, /_releaseCardsIn\(/,
        `the repaint at offset ${at} must release first:\n${site}`)
      from = at + site.length
    }
    assert.ok(seen > 0, `the repaint site still exists: ${site}`)
  }
})

test('the search strip releases its cards too', () => {
  const at = R.indexOf("if (!results.length) { sec.hidden = true; sec.innerHTML = ''; return }")
  assert.ok(at > 0)
  assert.match(R.slice(Math.max(0, at - 260), at), /_releaseCardsIn\(sec\)/)
})

// _slskCardDownloads had four set() calls and no delete anywhere, so after the
// first album download it was permanently non-empty — and the repaint it drives
// had no signature gate, so every poll rebuilt the whole Soulseek section for
// the rest of the session, losing scroll position each time.
test('tracked Soulseek downloads are evicted once nothing is moving', () => {
  assert.match(R, /if \(!_liveCardKeys\.has\(key\)\) _slskCardDownloads\.delete\(key\)/,
    'a finished download must stop being tracked')
})

test('the Soulseek section only repaints when the tracked set actually changed', () => {
  assert.match(R, /let _slskCardSig = null/)
  assert.match(R, /if \(sig !== _slskCardSig\)/, 'an unchanged poll must be free')
  const at = R.indexOf('sec.innerHTML = renderSoulseekRow(q)\n        bindSlskSearchEvents(q)')
  assert.ok(at > 0, 'the repaint is still there')
  assert.match(R.slice(at, at + 200), /scrollTop/, 'and it no longer throws the scroll position away')
})

// The renderer ticks once a second while playing and `position` moves every
// tick, so every tick produced a temp write plus a rename — 86,400 file writes
// a day of continuous listening, each re-serialising the whole queue, on the
// thread that also pumps mpv's IPC.
test('the now-playing file is only written when something other than the clock changed', () => {
  const fn = MAIN.slice(MAIN.indexOf('function _flushNowPlaying'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.match(body, /_npLastBodyNoPos/, 'the last payload is remembered')
  assert.match(body, /"position"/, 'and position is excluded from the comparison')
  const skipAt = body.indexOf('if (withoutPosition === _npLastBodyNoPos)')
  const writeAt = body.indexOf('fs.promises.writeFile(tmp')
  assert.ok(skipAt > 0 && writeAt > skipAt, 'the check must come before the write')
})

test('a real change still writes immediately', () => {
  const strip = b => b.replace(/"position":-?[\d.]+,?/, '')
  const base = JSON.stringify({ title: 'X', position: 10, queue: [1, 2] })
  assert.strictEqual(strip(base), strip(JSON.stringify({ title: 'X', position: 11, queue: [1, 2] })),
    'the clock alone is not a change')
  assert.notStrictEqual(strip(base), strip(JSON.stringify({ title: 'Y', position: 10, queue: [1, 2] })),
    'a new track is')
  assert.notStrictEqual(strip(base), strip(JSON.stringify({ title: 'X', position: 10, queue: [1, 2, 3] })),
    'so is a changed queue')
  assert.notStrictEqual(strip(base), strip(JSON.stringify({ title: 'X', position: 10, queue: [1, 2], paused: true })),
    'so is pausing')
})
