'use strict'
// Anime detail pages were slow enough to read as broken — Tokyo Revengers S2
// measured 53.6 s (Movies & TV audit N18).
//
// Two causes, two fixes, both tested here.
//
// 1. The OMDb ratings enrichment was awaited on the critical path in main, so
//    a slow free-tier lookup for a decorative number held the hero, the facts,
//    the episode grid and the source list behind it. It now has a bound, and a
//    miss just means the page opens without those extra ratings.
//
// 2. The sections that need more requests after the hero has painted — the
//    prequel/sequel walk in particular, which is one AniList round trip PER
//    HOP down a rate-limited lane — had no bound and no way to say they had
//    given up, so a section still empty after half a minute looked exactly
//    like a section with nothing to show. Each now runs on its own lane: it
//    cannot delay the hero, it cannot delay its neighbours, and on a timeout
//    or a throw it says so in its own box with a Retry.
//
// The lane runner is lifted from the shipped renderer and driven with fake
// mounts and controllable lanes.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

function liftBody(src, name) {
  const open = src.indexOf('function ' + name + '(')
  assert.ok(open > -1, name + ' must still exist')
  let depth = 0
  let i = src.indexOf('{', open)
  const start = i
  do {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  } while (depth > 0 && i < src.length)
  return src.slice(start + 1, i - 1)
}

const LANE_MS = Number(/const DETAIL_LANE_MS = (\d+)/.exec(RENDERER)[1])
const SEASON_MS = Number(/const SEASON_LANE_MS = (\d+)/.exec(RENDERER)[1])

// A page with named section mounts, and the two lifted functions closed over it.
function page(opts) {
  // A fast clock for the timeout case: the 8 s bound itself is asserted on its
  // own below, so no test needs to spend eight real seconds proving it fires.
  // A fast clock for the timeout case. For the rest, an unref'd one: a lane
  // that never settles leaves its timer armed, and a live 8 s timer would hold
  // the whole test run open for eight seconds to prove nothing.
  const setT = (opts && opts.fastTimers)
    ? ((fn) => setTimeout(fn, 5))
    : ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t })
  const boxes = new Map()
  const logs = []
  const doc = {
    getElementById: (id) => boxes.get(id) || null,
  }
  function box(id) {
    const el = {
      id, innerHTML: '', hidden: true, dataset: {},
      _listeners: {},
      querySelector(sel) {
        return el.innerHTML.includes(sel.replace(/^\./, '')) ? button : null
      },
    }
    const button = {
      disabled: false, textContent: 'Retry', clicks: [],
      addEventListener(type, fn) { button.clicks.push(fn) },
      press() { button.clicks.forEach(f => f()) },
    }
    el._button = button
    boxes.set(id, el)
    return el
  }

  let ticket = 1
  const esc = (x) => String(x)
  const api = {}
  // eslint-disable-next-line no-new-func
  const DEPS = ['document', 'console', 'setTimeout', 'clearTimeout', 'Promise', 'Date', 'Math', 'Number',
    'esc', '_videoDetailTicket', '_paintLaneFailure', '_paintLaneWaiting', '_detailLane', 'DETAIL_LANE_MS']
  const laneFn = new Function(...DEPS,
    'name', 'mountId', 'label', 'run', 'ticket', 'opts', liftBody(RENDERER, '_detailLane'))
  // eslint-disable-next-line no-new-func
  const paintFn = new Function(...DEPS,
    'name', 'mountId', 'label', 'run', 'ticket', 'why', liftBody(RENDERER, '_paintLaneFailure'))
  // eslint-disable-next-line no-new-func
  const waitFn = new Function(...DEPS,
    'mountId', 'label', liftBody(RENDERER, '_paintLaneWaiting'))

  const fakeConsole = { error: (...a) => logs.push(a.join(' ')) }
  const deps = () => [doc, fakeConsole, setT, clearTimeout, Promise, Date, Math, Number,
    esc, ticket, paint, waiting, lane, LANE_MS]
  const paint = (...a) => paintFn(...deps(), ...a)
  const waiting = (...a) => waitFn(...deps(), ...a)
  const lane = (...a) => laneFn(...deps(), ...a)

  return { box, lane, waiting, logs, api, setTicket: (t) => { ticket = t } }
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('a lane that never resolves does not block anything else', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  const similar = p.box('vsimilar')

  let neverSettled = 0
  const never = p.lane('seasons', 'vseasons', 'the other seasons',
    () => new Promise(() => { neverSettled++ }), 1)
  let fastDone = false
  await p.lane('similar', 'vsimilar', 'more like this',
    () => { fastDone = true; similar.innerHTML = '<div>rows</div>'; return Promise.resolve() }, 1)

  assert.strictEqual(fastDone, true, 'the fast lane finished while the other hung')
  assert.strictEqual(similar.innerHTML, '<div>rows</div>')
  assert.strictEqual(seasons.innerHTML, '', 'and the hung lane has not painted anything yet')
  assert.strictEqual(neverSettled, 1)
  assert.ok(never instanceof Promise)
})

test('after its timeout, a hung lane says so in its OWN box only', async () => {
  const p = page({ fastTimers: true })
  const seasons = p.box('vseasons')
  const similar = p.box('vsimilar')
  similar.innerHTML = '<div>rows</div>'

  p.lane('seasons', 'vseasons', 'the other seasons', () => new Promise(() => {}), 1)
  await new Promise(r => setTimeout(r, 40))

  assert.match(seasons.innerHTML, /Couldn.t load the other seasons/,
    'the hung section must say it gave up: ' + seasons.innerHTML)
  assert.match(seasons.innerHTML, /took too long/)
  assert.match(seasons.innerHTML, /Retry/, 'and offer a way back')
  assert.strictEqual(similar.innerHTML, '<div>rows</div>',
    'and the sections beside it are untouched')
})

test('a lane that throws paints its own note, not a page error', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  await p.lane('seasons', 'vseasons', 'the other seasons',
    () => Promise.reject(new Error('AniList said 429')), 1)
  assert.match(seasons.innerHTML, /Couldn.t load the other seasons/)
  assert.match(seasons.innerHTML, /could not be loaded/)
  assert.ok(p.logs.some(l => /AniList said 429/.test(l)), 'and the reason is logged: ' + p.logs)
})

test('a lane that throws synchronously is a lane failure, not an exception', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  await assert.doesNotReject(() => p.lane('seasons', 'vseasons', 'the other seasons',
    () => { throw new Error('boom') }, 1))
  assert.match(seasons.innerHTML, /Couldn.t load/)
})

test('Retry runs the lane again and the second attempt can succeed', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  let attempts = 0
  const run = () => {
    attempts++
    if (attempts === 1) return Promise.reject(new Error('429'))
    seasons.innerHTML = '<div>the chain</div>'
    return Promise.resolve()
  }
  await p.lane('seasons', 'vseasons', 'the other seasons', run, 1)
  assert.match(seasons.innerHTML, /Couldn.t load/)
  seasons._button.press()
  await tick()
  assert.strictEqual(attempts, 2)
  assert.strictEqual(seasons.innerHTML, '<div>the chain</div>', 'the retry replaced the note')
})

test('a note never paints over a section that did arrive', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  seasons.innerHTML = '<div>the chain, late but here</div>'
  await p.lane('seasons', 'vseasons', 'the other seasons',
    () => Promise.reject(new Error('a second attempt failed')), 1)
  assert.strictEqual(seasons.innerHTML, '<div>the chain, late but here</div>')
})

test('a lane belonging to a page you have already left says nothing', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  // ticket 1 is the lane's; the live page is now 2.
  p.setTicket(2)
  await p.lane('seasons', 'vseasons', 'the other seasons',
    () => Promise.reject(new Error('too late')), 1)
  assert.strictEqual(seasons.innerHTML, '', 'nothing may be painted onto the page you moved to')
})

// ── Wiring ────────────────────────────────────────────────────────────────────

test('the season chain is the lane it needs to be', () => {
  assert.match(RENDERER, /_chainPending = _detailLane\('seasons', 'vseasons', 'the other seasons',/,
    'the prequel/sequel walk — the slowest section on an anime page — must run on a lane')
})

test('the bound is eight seconds', () => {
  assert.strictEqual(LANE_MS, 8000)
})

// ── The seasons lane needs longer (live re-test, 2026-09-19) ───────────────
// Every anime page tested — One Piece, Bungo Stray Dogs, Tokyo Revengers S2 —
// hit the 8 s ceiling on the seasons lane, and a hand Retry then took 21 s and
// SUCCEEDED. The walk was never failing; the budget was wrong for a section
// that makes one rate-limited AniList request per hop. A longer budget on its
// own would only buy a longer silence, so the box says it is still going.

test('the seasons lane gets a budget a franchise walk can actually finish in', () => {
  assert.ok(SEASON_MS >= 21000,
    'a Retry took 21 s and succeeded; a budget under that fails work that was fine')
  assert.ok(SEASON_MS > LANE_MS, 'and it is longer than the ordinary lane')
  const call = RENDERER.slice(RENDERER.indexOf("_detailLane('seasons'"), RENDERER.indexOf("_detailLane('seasons'") + 300)
  assert.match(call, /budgetMs: SEASON_LANE_MS/, 'and the seasons lane is the one that gets it')
  assert.match(call, /noticeMs: DETAIL_LANE_MS/, 'and it speaks up at the old ceiling')
})

test('a slow lane says it is still going instead of sitting empty', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  p.lane('seasons', 'vseasons', 'the other seasons', () => new Promise(() => {}), 1,
    { budgetMs: 200, noticeMs: 20 })
  await new Promise(r => setTimeout(r, 60))
  assert.match(seasons.innerHTML, /Still finding the other seasons/,
    'an empty box and a slow box must not look the same: ' + seasons.innerHTML)
  assert.doesNotMatch(seasons.innerHTML, /Retry/, 'it has not given up yet, so it offers nothing to retry')
  assert.strictEqual(seasons.hidden, false)
})

test('and the note is replaced by the real thing when it lands', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  let finish
  const run = () => new Promise(r => { finish = () => { seasons.innerHTML = '<div>eight seasons</div>'; r() } })
  const lane = p.lane('seasons', 'vseasons', 'the other seasons', run, 1, { budgetMs: 400, noticeMs: 20 })
  await new Promise(r => setTimeout(r, 60))
  assert.match(seasons.innerHTML, /Still finding/)
  finish()
  await lane
  assert.strictEqual(seasons.innerHTML, '<div>eight seasons</div>',
    'the content wins over its own waiting note')
})

test('the waiting note becomes the failure note if the budget does run out', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  p.lane('seasons', 'vseasons', 'the other seasons', () => new Promise(() => {}), 1,
    { budgetMs: 60, noticeMs: 20 })
  await new Promise(r => setTimeout(r, 120))
  assert.match(seasons.innerHTML, /Couldn.t load the other seasons/,
    'a waiting note must not block the give-up note: ' + seasons.innerHTML)
  assert.match(seasons.innerHTML, /Retry/)
})

test('a lane that finishes with nothing to show leaves no note behind', async () => {
  const p = page()
  const seasons = p.box('vseasons')
  let finish
  // The real chain hides the box when a title has fewer than two entries.
  const run = () => new Promise(r => { finish = () => { seasons.innerHTML = ''; seasons.hidden = true; r() } })
  const lane = p.lane('seasons', 'vseasons', 'the other seasons', run, 1, { budgetMs: 400, noticeMs: 20 })
  await new Promise(r => setTimeout(r, 60))
  assert.match(seasons.innerHTML, /Still finding/)
  finish()
  await lane
  assert.strictEqual(seasons.innerHTML, '', 'a one-season show must not be told seasons are still coming')
  assert.strictEqual(seasons.hidden, true)
})

test('an ordinary lane still keeps the old bound and says nothing early', async () => {
  const p = page()
  const similar = p.box('vsimilar')
  p.lane('similar', 'vsimilar', 'more like this', () => new Promise(() => {}), 1)
  await new Promise(r => setTimeout(r, 60))
  assert.strictEqual(similar.innerHTML, '',
    'only the lane that asked for a notice gets one')
})

test('the hero is painted before any lane starts', () => {
  const start = RENDERER.indexOf('async function renderVideoDetail(')
  const body = RENDERER.slice(start, RENDERER.indexOf('\n// Where this title legally streams', start))
  const paint = body.indexOf("setContent('<div class=\"page video-detail-page cinema\">")
  const firstLane = body.indexOf('_detailLane(')
  assert.ok(paint > -1, 'the detail shell must still be painted in one place')
  assert.ok(firstLane > -1, 'and a lane must still be started after it')
  assert.ok(paint < firstLane,
    'the hero and the facts paint FIRST — no lane may be awaited before them')
})

// ── The ratings lane in main ──────────────────────────────────────────────────

test('the optional ratings lookup can no longer hold a detail page open', () => {
  const body = liftBody(MAIN, '_videoShowDetail')
  assert.match(body, /withTimeout\(_enrichExternalRatings\(detail\), RATINGS_LANE_MS/,
    'OMDb is a free tier behind someone else\'s rate limit; it must be bounded')
  assert.match(body, /\.catch\(function \(e\) \{[\s\S]*?return detail\n\s*\}\)/,
    'and a miss must leave the page with the detail it already has')
  const ms = Number(/const RATINGS_LANE_MS = (\d+)/.exec(MAIN)[1])
  assert.ok(ms > 0 && ms <= 6000, 'the bound must be short enough to matter, got ' + ms)
})
