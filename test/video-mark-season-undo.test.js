'use strict'
// "Mark season watched" says "You can undo this", then offers an Undo bar for
// five seconds — and immediately kicked off a source refetch measured at about
// four of them, with a loading state over the page for the duration. Six
// attempts out of six, the bar had gone before it could be used. The promise
// was real; the window to take it up was not.
//
// The fix defers the refetch until the bar's own lifetime has passed, rather
// than lengthening the bar. Nothing the refetch fetches depends on the mark —
// marking episodes watched does not change which sources exist for the episode
// on screen — so the work simply is not urgent, and a longer bar would only
// mean a longer spinner.
//
// Run against the real _confirmMarkSeasonWatched with a clock this test drives.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = source.indexOf('{', source.indexOf('(', start)); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function extractVar (source, name) {
  const m = new RegExp('^var ' + name + '\\b[^\\n]*', 'm').exec(source)
  assert.ok(m, name + ' not found')
  return m[0]
}

// A clock the test advances by hand, so "five seconds later" is a statement
// about the code rather than about how long the test sits still.
function clock () {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeout (fn, ms) { const id = ++seq; pending.set(id, { at: now + (Number(ms) || 0), fn }); return id },
    clearTimeout (id) { pending.delete(id) },
    tick (ms) {
      now += ms
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { pending.delete(id); t.fn() }
      }
    },
    get pendingCount () { return pending.size },
  }
}

function harness (opts) {
  const o = opts || {}
  const c = clock()
  const store = {
    _watched: new Set(),
    _entries: new Map(),
    get (k) { return this._entries.get(k) || null },
    setPosition (k, meta) { this._entries.set(k, Object.assign({ watched: false }, meta)) },
    markWatched (k) { this._watched.add(k) },
    remove (k) { this._watched.delete(k); this._entries.delete(k) },
  }
  const s = {
    console,
    Date: { now: c.now },
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    esc: v => String(v == null ? '' : v),
    showToast (m) { s.toasts.push(m) },
    toasts: [],
    refreshes: [],
    sourceLoads: [],
    undos: [],
    _videoDetail: { type: 'tv', id: 1396, d: { id: 1396, title: 'Breaking Bad', poster: null } },
    _videoDetailTicket: 3,
    _videoSeasonTicket: 0,
    _vStore: () => store,
    _seasonEpisodeNumbers: () => (o.episodes || [1, 2, 3]),
    _watchKey: (type, id, season, ep) => type + ':' + id + ':s' + season + 'e' + ep,
    _refreshTvEpisodes (ticket, seasonTicket, opt) { s.refreshes.push(opt || {}) },
    _loadVideoSources (ticket, seasonTicket) { s.sourceLoads.push([ticket, seasonTicket]) },
    // The confirm dialog is not what is under test; press "Mark watched".
    _mgConfirm (title, body, label, onOk) { s.confirmed = { title, label }; onOk() },
    pushUndo (label, fn) { s.undos.push({ label, fn }) },
  }
  s.globalThis = s
  vm.createContext(s)
  vm.runInContext([
    extractVar(SRC, 'UNDO_SNACKBAR_MS'),
    extractFn(SRC, '_seasonEpisodesToMark'),
    extractFn(SRC, '_deferPastUndo'),
    extractFn(SRC, '_confirmMarkSeasonWatched'),
  ].join('\n'), s)
  return { s, c, store }
}

test('the Undo bar gets its whole life before the page reloads anything', () => {
  const h = harness()
  h.s._confirmMarkSeasonWatched(1)
  assert.strictEqual(h.s.undos.length, 1, 'Undo was offered')
  assert.strictEqual(h.s.sourceLoads.length, 0,
    'nothing was refetched while the bar was going up — this is the four seconds it used to eat')

  // The grid itself is correct immediately, because the marks come from the
  // store and not from the network.
  assert.strictEqual(h.s.refreshes.length, 1)
  assert.strictEqual(h.s.refreshes[0].skipSources, true)

  // Four seconds in — still inside the bar's life, still nothing over the page.
  h.c.tick(4000)
  assert.strictEqual(h.s.sourceLoads.length, 0)

  // After the bar has had its full five seconds, the refetch happens.
  h.c.tick(1000)
  assert.strictEqual(h.s.sourceLoads.length, 1, 'the reload still happens, just out of the way')
})

test('pressing Undo cancels the reload outright', () => {
  const h = harness()
  h.s._confirmMarkSeasonWatched(1)
  h.s.undos[0].fn()
  h.c.tick(60000)
  assert.strictEqual(h.s.sourceLoads.length, 0,
    'the state is back where it started, so there is nothing to reload for')
  assert.strictEqual(h.c.pendingCount, 0, 'and no timer is left holding the page')
})

test('Undo really un-marks what was marked, and only that', () => {
  const h = harness()
  // Episode 2 was already watched before the press, so Undo must leave it.
  h.store.setPosition('tv:1396:s1e2', { type: 'tv', id: 1396, episode: 2 })
  h.store._entries.get('tv:1396:s1e2').watched = true
  h.s._confirmMarkSeasonWatched(1)
  assert.strictEqual(h.store._watched.has('tv:1396:s1e1'), true)
  assert.strictEqual(h.store._watched.has('tv:1396:s1e3'), true)
  h.s.undos[0].fn()
  assert.strictEqual(h.store._watched.has('tv:1396:s1e1'), false)
  assert.strictEqual(h.store._watched.has('tv:1396:s1e3'), false)
  assert.ok(h.store._entries.get('tv:1396:s1e2'), 'an episode watched beforehand stays watched')
})

test('Undo repaints the grid without paying for a refetch either', () => {
  const h = harness()
  h.s._confirmMarkSeasonWatched(1)
  h.s.undos[0].fn()
  assert.strictEqual(h.s.refreshes.length, 2)
  assert.strictEqual(h.s.refreshes[1].skipSources, true,
    'un-marking does not change which sources exist any more than marking did')
})

test('the delay is the bar\'s own lifetime, not a number picked twice', () => {
  const h = harness()
  assert.strictEqual(h.s.UNDO_SNACKBAR_MS, 5000)
  h.s._confirmMarkSeasonWatched(1)
  h.c.tick(h.s.UNDO_SNACKBAR_MS - 1)
  assert.strictEqual(h.s.sourceLoads.length, 0)
  h.c.tick(1)
  assert.strictEqual(h.s.sourceLoads.length, 1)
})

test('a season with nothing left to mark says so and schedules nothing', () => {
  const h = harness()
  for (const n of [1, 2, 3]) {
    h.store.setPosition('tv:1396:s1e' + n, { type: 'tv', id: 1396, episode: n })
    h.store._entries.get('tv:1396:s1e' + n).watched = true
  }
  h.s._confirmMarkSeasonWatched(1)
  assert.match(h.s.toasts.join(' '), /already watched/)
  assert.strictEqual(h.s.undos.length, 0)
  assert.strictEqual(h.c.pendingCount, 0)
})
