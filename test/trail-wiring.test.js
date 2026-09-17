'use strict'
// J4 wiring: the Trail page exists, is reachable, restores moments through
// the same journeys the Omnibox takes, and Home offers the latest session.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('the Trail is a page: nav item, router, command, Omnibox place, model loaded before the renderer', () => {
  assert.match(HTML, /data-page="trail" id="nav-trail"/)
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('trail-model.js') !== -1 && order.indexOf('trail-model.js') < order.indexOf('renderer.js'))
  assert.match(CODE, /else if \(page === 'trail'\)\s*renderTrail\(\)/)
  assert.match(CODE, /id:'nav-trail', label:'Go to your Trail'/)
  const model = fs.readFileSync(path.join(SRC, 'omnibox-model.js'), 'utf8')
  assert.match(model, /page: 'trail',\s*label: 'Your Trail'/)
  assert.match(CSS, /\.trail-episode\s*\{/)
})

test('the page reads the three stores through the model', () => {
  assert.match(fn('_trailEpisodes'), /window\.PapaTrail\.build\(_trailSources\(\)\)/)
})

test('a moment restores through the shared journeys, not its own navigation', () => {
  const r = fn('_restoreMoment')
  for (const k of ['search', 'album', 'artist', 'track', 'video']) assert.match(r, new RegExp("case '" + k + "'"))
  assert.match(r, /requestVideoSearch\(r\.q\); navigate\('video'\)/)
  assert.match(r, /else commitSearchQuery\(r\.q\)/)
})

// ── Erase, run rather than read ────────────────────────────────────────────
// "Erase searches" sits next to a listening history that took years to build,
// and the button's own tooltip promises that history is not touched. A regex
// looking for `SURFACES.forEach(s => mem.clear(s))` cannot see a line added
// beside it, so the button is actually pressed here and the other two stores
// are checked afterwards.
const SM = require('../src/search-memory')

function liftErase(over = {}) {
  const from = "  document.getElementById('trail-erase')?.addEventListener('click', function () {"
  const a = RENDERER.indexOf(from)
  assert.ok(a > -1, 'the erase button must still be bound in renderTrail')
  const b = RENDERER.indexOf('\n  })\n}', a)
  assert.ok(b > a)

  const cleared = []
  const asked = []
  const snacks = []
  const state = { playHistory: [{ title: 'Xtal', ts: 1 }, { title: 'Tha', ts: 2 }] }
  const watches = [{ type: 'tv', id: '1396', episode: 4 }]
  const mem = {
    list: () => [{ q: 'aphex twin', surface: 'music' }],
    clear: surface => cleared.push(surface),
  }
  const node = { addEventListener (ev, fn) { this.click = fn } }
  const deps = Object.assign({
    document: { getElementById: id => (id === 'trail-erase' ? node : null) },
    _mgConfirm: (title, body, label, onConfirm) => { asked.push({ title, body, label, onConfirm }) },
    _searchMemory: () => mem,
    window: { PapaSearchMemory: SM },
    showSnackbar: m => snacks.push(m),
    renderTrail: () => {},
  }, over)
  const keys = Object.keys(deps)
  new Function(...keys, RENDERER.slice(a, b) + '\n  })')(...keys.map(k => deps[k]))
  return { press: () => node.click(), cleared, asked, snacks, state, watches, mem }
}

test('erasing searches asks first, and does nothing until it is confirmed', () => {
  const e = liftErase()
  e.press()
  assert.strictEqual(e.asked.length, 1, 'a destructive button must ask')
  assert.match(e.asked[0].title, /Forget every remembered search/)
  assert.deepStrictEqual(e.cleared, [], 'and must not act before the answer')
})

test('erasing clears every search surface and nothing else', () => {
  const e = liftErase()
  e.press()
  e.asked[0].onConfirm()
  assert.deepStrictEqual(e.cleared.slice().sort(), SM.SURFACES.slice().sort(),
    'every surface is forgotten, or one box quietly keeps its history')
  assert.deepStrictEqual(e.state.playHistory.map(p => p.title), ['Xtal', 'Tha'],
    'listening history is not searches, and the button says so')
  assert.deepStrictEqual(e.watches, [{ type: 'tv', id: '1396', episode: 4 }],
    'nor is watch history')
  assert.match(e.snacks[0] || '', /erased/, 'and it says what it did')
})

test('with no search memory at all, erasing is a no-op rather than a crash', () => {
  const e = liftErase({ _searchMemory: () => null })
  e.press()
  e.asked[0].onConfirm()
  assert.deepStrictEqual(e.cleared, [])
  assert.deepStrictEqual(e.state.playHistory.length, 2)
})

test('the trail reads searches, plays and watches, and survives a store that throws', () => {
  const a = RENDERER.indexOf('function _trailSources()')
  assert.ok(a > -1)
  const b = RENDERER.indexOf('\nfunction _trailEpisodes()', a)
  const build = (memList, store, plays) => new Function('_searchMemory', '_vStore', 'state',
    RENDERER.slice(a, b) + '\nreturn _trailSources')(
    () => (memList ? { list: () => memList } : null), () => store, { playHistory: plays })()

  const full = build([{ q: 'a' }], {
    history: () => [{ id: 'w1' }], continueWatching: () => [{ id: 'w2' }],
  }, [{ title: 'Xtal' }])
  assert.deepStrictEqual(full.searches, [{ q: 'a' }])
  assert.deepStrictEqual(full.plays, [{ title: 'Xtal' }])
  assert.deepStrictEqual(full.watches.map(w => w.id), ['w1', 'w2'],
    'finished watches and what is still in progress both count')

  const angry = build(null, { history: () => { throw new Error('corrupt') } }, null)
  assert.deepStrictEqual(angry, { searches: [], plays: [], watches: [] },
    'a corrupt watch store costs the watches, not the page')
})

test('Home has a "Pick up where you left off" row fed by the trail, placed after Continue listening', () => {
  assert.match(CODE, /var _HOME_DEFAULT_ROWS = \['jumpback', 'trail', 'quick'/)
  assert.match(CODE, /trail: _homeTrailHtml\(\),/)
  assert.match(CODE, /trail: 'Pick up where you left off'/)
  assert.match(fn('_homeTrailHtml'), /window\.PapaTrail\.pickUp\(_trailEpisodes\(\), 3\)/)
  assert.match(fn('_homeTrailHtml'), /data-page="trail">See the trail/)
  assert.match(CODE, /_bindHomeTrail\(\)\s*document\.getElementById\('jumpback-card'\)/)
})
