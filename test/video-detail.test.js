'use strict'
// The detail page sections. Every one of these was already being fetched with
// the title and thrown away. Executed for real against a fake DOM.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

function harness() {
  const nodes = {}
  const mk = id => ({ id, innerHTML: '', querySelectorAll: () => [], querySelector: () => null })
  for (const id of ['vcast', 'vwatch', 'vsimilar']) nodes[id] = mk(id)
  const ctx = {
    console,
    document: { getElementById: i => nodes[i] || null },
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    _vRowShell: (k, l, c) => '<row data-l="' + l + '" data-c="' + c + '">',
    _fillRow: () => {},
  }
  vm.createContext(ctx)
  for (const fn of ['_videoFactsHtml', '_fmtRuntime', '_animeStatus', '_videoCrewHtml',
                    '_renderCastRow', '_renderProviders', '_renderSimilar']) {
    vm.runInContext(extract(fn), ctx)
  }
  return { ctx, nodes }
}

// "166 min" makes the reader do the arithmetic.
test('runtime reads as hours and minutes', () => {
  const { ctx } = harness()
  assert.strictEqual(ctx._fmtRuntime(166), '2h 46m')
  assert.strictEqual(ctx._fmtRuntime(120), '2h')
  assert.strictEqual(ctx._fmtRuntime(45), '45m')
  assert.strictEqual(ctx._fmtRuntime(0), '')
  assert.strictEqual(ctx._fmtRuntime(null), '')
})

test('facts show the certification, runtime and studio', () => {
  const { ctx } = harness()
  const html = ctx._videoFactsHtml({ certification: 'PG-13', runtime: 167, studios: ['Legendary'], languages: ['English'] })
  assert.match(html, /vfact-cert">PG-13/)
  assert.match(html, /2h 47m/)
  assert.match(html, /Legendary/)
})

test('a title with no facts renders nothing rather than an empty bar', () => {
  const { ctx } = harness()
  assert.strictEqual(ctx._videoFactsHtml({}), '')
})

test('anime status is shown in words, not as an enum', () => {
  const { ctx } = harness()
  assert.strictEqual(ctx._animeStatus('RELEASING'), 'Airing')
  assert.strictEqual(ctx._animeStatus('NOT_YET_RELEASED'), 'Upcoming')
  assert.match(ctx._videoFactsHtml({ type: 'anime', status: 'RELEASING' }), /Airing/)
})

// Director and writer are the two credits a viewer chooses a film by.
test('crew shows director and writers, deduplicated', () => {
  const { ctx } = harness()
  const html = ctx._videoCrewHtml({ crew: [
    { id: 1, name: 'Denis Villeneuve', job: 'Director' },
    { id: 1, name: 'Denis Villeneuve', job: 'Screenplay' },
    { id: 2, name: 'Jon Spaihts', job: 'Screenplay' },
    { id: 3, name: 'Someone', job: 'Gaffer' },
  ] })
  assert.match(html, /Directed by/)
  assert.match(html, /Written by/)
  assert.ok(!/Gaffer|Someone/.test(html), 'only the credits that matter')
  assert.strictEqual((html.match(/Denis Villeneuve/g) || []).length, 2, 'once per role, not once per credit')
})

test('crew names link to that person', () => {
  const { ctx } = harness()
  assert.match(ctx._videoCrewHtml({ crew: [{ id: 7, name: 'D', job: 'Director' }] }), /data-person="7"/)
})

test('no crew renders nothing', () => {
  const { ctx } = harness()
  assert.strictEqual(ctx._videoCrewHtml({}), '')
  assert.strictEqual(ctx._videoCrewHtml({ crew: [{ id: 1, name: 'X', job: 'Gaffer' }] }), '')
})

test('the cast rail shows names, roles and links to each person', () => {
  const { ctx, nodes } = harness()
  ctx._renderCastRow({ cast: [
    { id: 1, name: 'Timothée Chalamet', character: 'Paul', profile: '/a.jpg' },
    { id: 2, name: 'Zendaya', character: 'Chani', profile: null },
  ] })
  assert.match(nodes.vcast.innerHTML, /Timothée Chalamet/)
  assert.match(nodes.vcast.innerHTML, /Paul/)
  assert.match(nodes.vcast.innerHTML, /data-person="1"/)
  // A missing photo becomes an initial rather than a broken image.
  assert.strictEqual((nodes.vcast.innerHTML.match(/<img/g) || []).length, 1)
  assert.match(nodes.vcast.innerHTML, /vcast-photo-fallback">Z/)
})

test('an empty cast renders nothing', () => {
  const { ctx, nodes } = harness()
  ctx._renderCastRow({ cast: [] })
  assert.strictEqual(nodes.vcast.innerHTML, '')
  ctx._renderCastRow({})
  assert.strictEqual(nodes.vcast.innerHTML, '')
})

test('a hostile cast name cannot break out of the rail', () => {
  const { ctx, nodes } = harness()
  ctx._renderCastRow({ cast: [{ id: 1, name: '"><img onerror=alert(1)>', character: 'X' }] })
  assert.ok(!/<img onerror/.test(nodes.vcast.innerHTML))
})

// Knowing a film is on a service you already pay for is worth more than a
// torrent.
test('streaming providers are shown for the viewer’s region', () => {
  const { ctx, nodes } = harness()
  ctx._renderProviders({ providers: { GB: { flatrate: ['Netflix', 'Netflix'] }, US: { flatrate: ['Hulu'] } } })
  assert.match(nodes.vwatch.innerHTML, /Netflix/)
  assert.ok(!/Hulu/.test(nodes.vwatch.innerHTML), 'GB is preferred over US')
  assert.strictEqual((nodes.vwatch.innerHTML.match(/Netflix/g) || []).length, 1, 'duplicates collapse')
})

test('rent and buy listings are not presented as streaming', () => {
  const { ctx, nodes } = harness()
  ctx._renderProviders({ providers: { GB: { rent: ['Apple TV'], buy: ['Amazon'] } } })
  assert.strictEqual(nodes.vwatch.innerHTML, '')
})

test('recommendations are preferred over bare similarity', () => {
  const { ctx, nodes } = harness()
  ctx._renderSimilar({
    recommendations: [{ id: 1, title: 'Rec', poster: 'p.jpg' }],
    similar: [{ id: 2, title: 'Sim', poster: 'p.jpg' }],
  })
  assert.match(nodes.vsimilar.innerHTML, /More like this/)
  ctx._renderSimilar({ recommendations: [], similar: [{ id: 2, title: 'Sim', poster: 'p.jpg' }] })
  assert.match(nodes.vsimilar.innerHTML, /Similar titles/)
})

// A poster-less card in a poster rail is a hole.
test('related titles without artwork are dropped', () => {
  const { ctx, nodes } = harness()
  ctx._renderSimilar({ similar: [{ id: 1, title: 'No art' }, { id: 2, title: 'Has art', poster: 'p.jpg' }] })
  assert.match(nodes.vsimilar.innerHTML, /data-c="1"/)
})

test('the person page is routed and split by medium', () => {
  assert.match(SRC, /page === 'person'\)\s*renderPerson\(navId\)/)
  const body = SRC.slice(SRC.indexOf('async function renderPerson('), SRC.indexOf('var _lastPerson'))
  assert.match(body, /'Films'/)
  assert.match(body, /'Television'/)
  assert.match(body, /_personTicket !== ticket/, 'a stale filmography must not render')
})

// The credit that linked here already had the name and photo; fetching them
// again would be a second request for data already in hand.
test('the person page heads itself from the credit that linked to it', () => {
  assert.match(SRC, /var _lastPerson = \{\}/)
  assert.match(SRC, /_lastPerson = \{/)
  assert.match(SRC, /function _personName\(id\)/)
})
