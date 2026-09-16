'use strict'
// The Play button on a video card (2026-09-16).
//
// Found by driving a twin through the Continue Watching shelf. The handler read:
//
//     if (act.dataset.act === 'play') return open()
//
// and `open` is `navigate('video-detail', …)` — exactly what clicking anywhere
// else on the card does. So the Play button was decorative: it opened the detail
// page and stopped. Measured before the fix: click it, and sixty seconds later
// the theatre had never opened and no play event had fired.
//
// On the Continue Watching shelf that is the one control people reach for, and
// it is the one that did the least.
//
// Fixing it needed two halves, not one. Arming auto-play alone would have been
// WORSE than doing nothing: the detail page opens at episode 1 by default, so a
// card showing "The God of High School, episode 9" would have started episode 1
// and overwritten the viewer's place.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function slice(from, to) {
  const a = RENDERER.indexOf(from)
  assert.ok(a > 0, 'found ' + from)
  const b = RENDERER.indexOf(to, a)
  assert.ok(b > a, 'found ' + to)
  return RENDERER.slice(a, b)
}

test('a card records the episode it was left off at', () => {
  const card = slice("return '<article class=\"vcard\"", '</article>')
  assert.match(card, /data-episode="/, 'the card carries its episode')
  assert.match(card, /data-season="/, 'and its season')
  // Only when there is one — a film card must not grow empty attributes.
  assert.match(card, /item && item\.episode != null \?/)
  assert.match(card, /item && item\.season != null \?/)
})

test('the Play button arms a play, instead of only opening the page', () => {
  const bind = slice('const open = function () { navigate(\'video-detail\'', 'keydown')
  assert.match(bind, /_playOnArrival = \{/, 'it arms the arrival')
  assert.ok(!/act === 'play'\) return open\(\)/.test(bind),
    'the old navigate-and-stop behaviour must be gone, not merely shadowed')
  assert.match(bind, /episode: c\.dataset\.episode != null \? Number\(c\.dataset\.episode\) : null/)
})

test('the detail page takes the arm exactly once, and never inherits a stale one', () => {
  const detail = slice('async function renderVideoDetail(navId)', '_videoStreams = []')
  assert.match(detail, /const arrival = _playOnArrival/)
  assert.match(detail, /_playOnArrival = null/, 'cleared immediately, before anything can fail')
  // The clear must NOT be inside the if — a card Play that carried nothing
  // usable would otherwise leave the arm set and make some later, unrelated
  // page start playing by itself.
  const clearAt = detail.indexOf('_playOnArrival = null')
  const ifAt = detail.indexOf('if (arrival)')
  assert.ok(clearAt < ifAt, 'cleared unconditionally, outside the branch')
  assert.match(detail, /_autoPlayTicket = ticket/, 'and it actually plays')
})

test('the arm sets the episode it was given, and only a real number', () => {
  const detail = slice('const arrival = _playOnArrival', '_videoStreams = []')
  assert.match(detail, /Number\.isFinite\(arrival\.episode\)\) _videoState\.episode = arrival\.episode/)
  assert.match(detail, /Number\.isFinite\(arrival\.season\)\) _videoState\.season = arrival\.season/)
})

// A television show picks its first season on load. That must not overwrite the
// season a card Play just asked for, or Continue Watching on season 3 would
// resume season 1.
test('a television show does not overwrite the season the card asked for', () => {
  const tv = slice("if (type === 'tv') {", '_renderVideoControls(type)')
  assert.match(tv, /if \(!Number\.isFinite\(_videoState\.season\)\) _videoState\.season = pick/)
})
