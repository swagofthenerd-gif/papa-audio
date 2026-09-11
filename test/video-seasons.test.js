'use strict'
// The season / franchise selector. Executes the real renderer function
// against a fake DOM, rather than asserting on source text.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extract(name) {
  let start = SRC.indexOf('async function ' + name + '(')
  if (start === -1) start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

function harness({ detail, seasons = [], collection = null, store = null } = {}) {
  const nav = []
  const box = {
    hidden: true, innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    document: { getElementById: id => (id === 'vseasons' ? box : null) },
    _videoDetail: detail,
    _videoDetailTicket: 1,
    _vStore: () => store,
    navigate: (page, id) => nav.push(page + '|' + id),
    console,
    window: { api: {
      videoSeasons: async () => ({ ok: true, seasons, related: [] }),
      videoCollection: async () => ({ ok: true, collection }),
    } },
  }
  vm.createContext(ctx)
  vm.runInContext(extract('_renderSeasonChain'), ctx)
  return { ctx, box, nav }
}

const season = (id, title, year, over = {}) =>
  Object.assign({ id, title, year, format: 'TV', episodeCount: 12, poster: null }, over)

const animeDetail = (id = 2) => ({ type: 'anime', d: { id, title: 'Show' } })

test('an anime chain renders every entry in order, current one marked', async () => {
  const { ctx, box } = harness({
    detail: animeDetail(2),
    seasons: [season(1, 'First', 2015), season(2, 'Second', 2018), season(3, 'Third', 2020)],
  })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, false)
  const names = [...box.innerHTML.matchAll(/vseason-name">([^<]+)</g)].map(m => m[1])
  assert.deepStrictEqual(names, ['First', 'Second', 'Third'])
  assert.match(box.innerHTML, /vseason current/)
  assert.match(box.innerHTML, /aria-current="true"/)
})

// The entry you are on is marked rather than removed, so the list always
// reads as the complete run.
test('the current entry is labelled rather than hidden', async () => {
  const { ctx, box } = harness({
    detail: animeDetail(2),
    seasons: [season(1, 'First', 2015), season(2, 'Second', 2018)],
  })
  await ctx._renderSeasonChain(1)
  // "Part N" is the fact on every entry; the current one adds "this page"
  // instead of claiming "Watching" (V2.5).
  const labels = [...box.innerHTML.matchAll(/vseason-n">([^<]+)</g)].map(m => m[1].trim())
  assert.deepStrictEqual(labels, ['Part 1', 'Part 2'])
  assert.match(box.innerHTML, /vseason current[^>]*>[\s\S]*?vseason-here">this page</)
})

// A list of one is just the title you are already looking at.
test('a standalone title shows no selector', async () => {
  const { ctx, box } = harness({ detail: animeDetail(1), seasons: [season(1, 'Only', 2019)] })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, true)
  assert.strictEqual(box.innerHTML, '')
})

test('no chain at all shows no selector', async () => {
  const { ctx, box } = harness({ detail: animeDetail(1), seasons: [] })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, true)
})

test('a film franchise renders as the same selector', async () => {
  const { ctx, box } = harness({
    detail: { type: 'movie', d: { id: 2, title: 'Dune', collection: { id: 9, name: 'Dune Collection' } } },
    collection: { id: 9, name: 'Dune Collection', parts: [
      { id: 1, title: 'Dune', year: 2021 }, { id: 2, title: 'Part Two', year: 2024 },
    ] },
  })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, false)
  assert.match(box.innerHTML, /Dune Collection/)
  const names = [...box.innerHTML.matchAll(/vseason-name">([^<]+)</g)].map(m => m[1])
  assert.deepStrictEqual(names, ['Dune', 'Part Two'])
})

// TMDB already nests seasons inside a show; the season picker handles those.
test('a TV show does not get a chain selector', async () => {
  const { ctx, box } = harness({ detail: { type: 'tv', d: { id: 1, title: 'Show' } } })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, true)
})

test('a film with no franchise shows nothing', async () => {
  const { ctx, box } = harness({ detail: { type: 'movie', d: { id: 1, title: 'Standalone', collection: null } } })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, true)
})

// A slow chain arriving after the user has opened something else must not
// paint the previous title's seasons over the new page.
test('a stale response is discarded', async () => {
  const { ctx, box } = harness({
    detail: animeDetail(2),
    seasons: [season(1, 'First', 2015), season(2, 'Second', 2018)],
  })
  ctx._videoDetailTicket = 2          // the user navigated away
  await ctx._renderSeasonChain(1)     // response for the old ticket
  assert.strictEqual(box.innerHTML, '', 'stale seasons must not be painted')
})

test('a failed lookup leaves the page alone', async () => {
  const { ctx, box } = harness({ detail: animeDetail(2) })
  ctx.window.api.videoSeasons = async () => { throw new Error('network') }
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, true)
})

test('metadata is shown per entry where it exists', async () => {
  const { ctx, box } = harness({
    detail: animeDetail(1),
    seasons: [season(1, 'A', 2015, { format: 'ONA', episodeCount: 26 }), season(2, 'B', 2018)],
  })
  await ctx._renderSeasonChain(1)
  assert.match(box.innerHTML, /2015 · ONA · 26 ep/)
})

test('a missing poster does not emit a broken image', async () => {
  const { ctx, box } = harness({
    detail: animeDetail(1),
    seasons: [season(1, 'A', 2015, { poster: null }), season(2, 'B', 2018, { poster: 'p.jpg' })],
  })
  await ctx._renderSeasonChain(1)
  assert.strictEqual((box.innerHTML.match(/<img/g) || []).length, 1)
})

test('a hostile season title cannot break out of the markup', async () => {
  const { ctx, box } = harness({
    detail: animeDetail(1),
    seasons: [season(1, '"><img onerror=alert(1)>', 2015), season(2, 'B', 2018)],
  })
  await ctx._renderSeasonChain(1)
  assert.ok(!/<img onerror/.test(box.innerHTML))
})

test('a broken watch store does not break the list', async () => {
  const { ctx, box } = harness({
    detail: { type: 'movie', d: { id: 1, title: 'X', collection: { id: 9, name: 'C' } } },
    collection: { id: 9, name: 'C', parts: [{ id: 1, title: 'One', year: 2001 }, { id: 2, title: 'Two', year: 2004 }] },
    store: { get () { throw new Error('corrupt') } },
  })
  await ctx._renderSeasonChain(1)
  assert.strictEqual(box.hidden, false)
  assert.match(box.innerHTML, /One/)
})

test('watched parts of a franchise are marked', async () => {
  const { ctx, box } = harness({
    detail: { type: 'movie', d: { id: 2, title: 'X', collection: { id: 9, name: 'C' } } },
    collection: { id: 9, name: 'C', parts: [{ id: 1, title: 'One', year: 2001 }, { id: 2, title: 'Two', year: 2004 }] },
    store: { get: key => (key === 'movie:1' ? { watched: true } : null) },
  })
  await ctx._renderSeasonChain(1)
  assert.match(box.innerHTML, /vseason-watched">Watched/)
})
