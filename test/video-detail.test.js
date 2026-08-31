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
  // The cast row is built from a shared person tile and a crew de-duplicator
  // now, so the sandbox needs both or every cast assertion fails on a missing
  // helper rather than on anything real.
  vm.runInContext("var _CREW_ROLES = [['directors','Director'],['writers','Writer']," +
    "['cinematographers','Cinematography'],['composers','Music'],['editors','Editor']]", ctx)
  for (const fn of ['_videoFactsHtml', '_fmtRuntime', '_animeStatus', '_videoCrewHtml',
                    '_personTileHtml', '_keyCrewList', '_externalRatingsHtml',
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

// The fixture used to say `profile`, which is not what the catalogue returns —
// it returns `profilePath`. The code read the same wrong name, so the test
// passed while every portrait on every film fell through to a grey circle with
// a letter in it. A fixture that agrees with the bug cannot catch it.
test('the cast rail shows names, roles and links to each person', () => {
  const { ctx, nodes } = harness()
  ctx._renderCastRow({ cast: [
    { id: 1, name: 'Timothée Chalamet', character: 'Paul', profilePath: 'https://img/a.jpg' },
    { id: 2, name: 'Zendaya', character: 'Chani', profilePath: null },
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

// ── Made by ─────────────────────────────────────────────────────────────────
// A cinephile follows a cinematographer the way other people follow an actor,
// and the page had no way to tell you who shot a film.
test('the crew a cinephile follows appears with the cast', () => {
  const { ctx, nodes } = harness()
  ctx._renderCastRow({
    cast: [{ id: 9, name: 'Al Pacino', character: 'Michael', profilePath: 'https://img/p.jpg' }],
    keyCrew: {
      directors: [{ id: 1, name: 'Francis Ford Coppola', profilePath: 'https://img/c.jpg' }],
      cinematographers: [{ id: 2, name: 'Gordon Willis', profilePath: null }],
      composers: [{ id: 3, name: 'Nino Rota', profilePath: null }],
    },
  })
  assert.match(nodes.vcast.innerHTML, /Made by/)
  assert.match(nodes.vcast.innerHTML, /Gordon Willis/)
  assert.match(nodes.vcast.innerHTML, /Cinematography/)
  assert.match(nodes.vcast.innerHTML, /Nino Rota/)
})

// Coppola directed and wrote The Godfather. Listing him twice says less than
// listing him once with both credits.
test('one person who held two jobs appears once, with both', () => {
  const { ctx } = harness()
  const list = ctx._keyCrewList({ keyCrew: {
    directors: [{ id: 1, name: 'Francis Ford Coppola' }],
    writers: [{ id: 1, name: 'Francis Ford Coppola' }],
  } })
  assert.strictEqual(list.length, 1)
  assert.match(list[0]._role, /Director/)
  assert.match(list[0]._role, /Writer/)
})

test('no crew and no cast renders nothing at all', () => {
  const { ctx, nodes } = harness()
  ctx._renderCastRow({})
  assert.strictEqual(nodes.vcast.innerHTML, '')
})

// ── The second opinion ──────────────────────────────────────────────────────
test('the three outside scores, the awards and the box office are shown', () => {
  const { ctx } = harness()
  const html = ctx._externalRatingsHtml({ external: {
    imdbRating: 9.2, rottenTomatoes: 97, metascore: 100,
    awards: { text: 'Won 3 Oscars. 31 wins & 31 nominations total', oscars: 3 },
    boxOffice: 136381073,
  } })
  assert.match(html, /IMDb/)
  assert.match(html, /9\.2/)
  assert.match(html, /97%/)
  assert.match(html, /Metacritic/)
  assert.match(html, /Won 3 Oscars/)
  assert.match(html, /has-oscars/, 'an Oscar is the one award most people can place')
  assert.match(html, /136,381,073/, 'a raw integer is not a box office figure')
})

// A film with no outside data must not leave an empty row of labels behind.
test('no second opinion renders nothing rather than empty labels', () => {
  const { ctx } = harness()
  assert.strictEqual(ctx._externalRatingsHtml({}), '')
  assert.strictEqual(ctx._externalRatingsHtml({ external: {} }), '')
})

test('a film with only one of the three scores shows only that one', () => {
  const { ctx } = harness()
  const html = ctx._externalRatingsHtml({ external: { imdbRating: 8.1 } })
  assert.match(html, /IMDb/)
  assert.ok(!/Metacritic/.test(html), 'a missing score is absent, not zero')
})
