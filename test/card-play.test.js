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

// The two halves are in different functions 200 lines apart: the card handler
// arms _playOnArrival, and renderVideoDetail consumes it. Checking each half's
// spelling separately is what let them drift — "arming auto-play alone would
// have been WORSE than doing nothing" is a statement about the PAIR. Both are
// lifted into one scope here, sharing the real variable, so the arm that is set
// is the arm that is taken.
function liftArrival() {
  const bind = slice("      const act = e.target.closest('[data-act]')",
    "      if (act.dataset.act === 'cwremove') {")
  const take = slice('  _videoState = { season: null, episode: 1, sub: true }', '\n  _videoStreams = []')
  const tvLine = /if \(!Number\.isFinite\(_videoState\.season\)\) _videoState\.season = pick/
  assert.ok(tvLine.test(RENDERER),
    'a tv page must still default its season only when none was asked for')

  const opened = []
  const fn = new Function('open', 'navigate', `
    var _playOnArrival = null
    var _videoState = null
    var _autoPlayTicket = null
    // Every detail page takes the next ticket, exactly as renderVideoDetail
    // does — that is what stops a stale arm from playing on a later page.
    var _videoDetailTicket = 0
    function cardClick(e, c) { ${bind} }
    function arrive() {
      var ticket = ++_videoDetailTicket
      ${take}
      return { state: _videoState, autoPlay: _autoPlayTicket === ticket }
    }
    function tvDefaultSeason(pick) { ${tvLine.exec(RENDERER)[0]} }
    return { cardClick: cardClick, arrive: arrive, tvDefaultSeason: tvDefaultSeason,
             armed: function () { return _playOnArrival } }
  `)(() => opened.push('detail'), () => opened.push('navigate'))
  return { ...fn, opened }
}

// A shelf card, and a click on one of its buttons.
function card(dataset) { return { dataset } }
function clickOn(actName) {
  const act = actName ? { dataset: { act: actName } } : null
  return { target: { closest: sel => (sel === '[data-act]' ? act : null) }, stopPropagation () {} }
}

test('a card records the episode it was left off at', () => {
  const cardHtml = slice("return '<article class=\"vcard\"", '</article>')
  assert.match(cardHtml, /data-episode="/, 'the card carries its episode')
  assert.match(cardHtml, /data-season="/, 'and its season')
  // Only when there is one — a film card must not grow empty attributes.
  assert.match(cardHtml, /item && item\.episode != null \?/)
  assert.match(cardHtml, /item && item\.season != null \?/)
})

test('Continue Watching plays the episode on the card, not episode one', () => {
  // The whole point. A card reading "episode 9" that starts episode 1 does not
  // merely fail to resume — it writes episode 1's position over episode 9's.
  const a = liftArrival()
  a.cardClick(clickOn('play'), card({ episode: '9', season: '3', video: 'tv:1396' }))
  assert.strictEqual(a.opened.length, 1, 'the detail page still opens')

  const arrived = a.arrive()
  assert.strictEqual(arrived.state.episode, 9, 'episode 9, as the card said')
  assert.strictEqual(arrived.state.season, 3)
  assert.strictEqual(arrived.autoPlay, true, 'and it plays, rather than just sitting there')
})

test('a Play that carried no episode does not invent one', () => {
  const a = liftArrival()
  a.cardClick(clickOn('play'), card({ video: 'movie:550' }))
  const arrived = a.arrive()
  assert.strictEqual(arrived.state.episode, 1, 'a film starts where films start')
  assert.strictEqual(arrived.state.season, null)
  assert.strictEqual(arrived.autoPlay, true)
})

test('a season the card asked for survives the page picking a default', () => {
  // A television page picks its first season on load. Doing that unconditionally
  // is how Continue Watching on season 3 resumed season 1.
  const a = liftArrival()
  a.cardClick(clickOn('play'), card({ episode: '4', season: '3', video: 'tv:1396' }))
  a.arrive()
  a.tvDefaultSeason(1)
  assert.strictEqual(a.armed(), null)
  const again = liftArrival()
  again.cardClick(clickOn('play'), card({ episode: '4', season: '3', video: 'tv:1396' }))
  const st = again.arrive().state
  again.tvDefaultSeason(1)
  assert.strictEqual(st.season, 3, 'the default must not overwrite what was asked for')
})

test('a page opened with no season still gets the default', () => {
  const a = liftArrival()
  const st = a.arrive().state
  a.tvDefaultSeason(2)
  assert.strictEqual(st.season, 2, 'and a page nobody armed still picks one')
})

test('the arm is taken exactly once and never leaks into a later page', () => {
  // An arm left set makes some later, unrelated page start playing by itself.
  const a = liftArrival()
  a.cardClick(clickOn('play'), card({ episode: '9', season: '3', video: 'tv:1396' }))
  assert.ok(a.armed(), 'armed')
  assert.strictEqual(a.arrive().autoPlay, true)
  assert.strictEqual(a.armed(), null, 'cleared on the way in')
  assert.strictEqual(a.arrive().autoPlay, false, 'the next page does not inherit it')
})

test('an arm carrying nothing usable is still cleared', () => {
  const a = liftArrival()
  a.cardClick(clickOn('play'), card({ episode: 'not-a-number', video: 'tv:1' }))
  const first = a.arrive()
  assert.strictEqual(first.state.episode, 1, 'junk is ignored, not coerced to NaN')
  assert.ok(Number.isFinite(first.state.episode))
  assert.strictEqual(a.armed(), null, 'and the arm is gone either way')
  assert.strictEqual(a.arrive().autoPlay, false)
})

test('clicking anywhere else on a card opens it without arming a play', () => {
  const a = liftArrival()
  a.cardClick(clickOn(null), card({ episode: '9', video: 'tv:1396' }))
  assert.strictEqual(a.opened.length, 1, 'the card still opens')
  assert.strictEqual(a.armed(), null, 'but nothing starts playing on its own')
  assert.strictEqual(a.arrive().autoPlay, false)
})

test('the old navigate-and-stop behaviour is gone, not merely shadowed', () => {
  const bind = slice("const open = function () { navigate('video-detail'", 'keydown')
  assert.ok(!/act === 'play'\) return open\(\)/.test(bind),
    'a Play button that only opens a page is a lie')
})
