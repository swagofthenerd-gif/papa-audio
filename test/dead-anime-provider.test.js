'use strict'
// The anime source list carried an adapter that could never answer.
//
// providers/anime.js is an ADAPTER: it runs an injected list of HTTP
// `resolvers` (gogoanime/Consumet-style scrapers) and merges what they return.
// main.js built it with `resolvers: []`, so every call returned an empty array
// — for every anime search ever run.
//
// That is not free. resolveStream records a source that answered nothing as a
// source that FAILED, and main.js persists that verdict to the source-health
// store, whose rows are what the maintenance panel shows. So a provider that
// was never a provider sat in the table going redder for ever, next to the
// real indexers, and a genuinely broken mirror looked like one more red row
// among several.
//
// These EXECUTE the real resolveStream and the real _videoBackends. The first
// test proves the cost is real rather than theoretical; the second proves the
// anime list no longer pays it.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

const { resolveStream, _resetSourceHealth, getSourceHealth } = require('../providers/index')
const { createAnimeProvider } = require('../providers/anime')

// Why the wiring mattered: the health machinery cannot tell "this adapter has
// nothing to run" from "this indexer is down".
test('an adapter with no resolvers is booked as a source that failed', async () => {
  _resetSourceHealth()
  const sweeps = []
  const out = await resolveStream(
    { title: 'One Piece', episode: 1 },
    [createAnimeProvider({ resolvers: [] })],
    { onSweep: s => sweeps.push(s) },
  )

  assert.strictEqual(out.length, 0, 'it answers nothing, which is the whole point')
  assert.strictEqual(sweeps.length, 1)
  assert.strictEqual(sweeps[0].results.animeProvider, false,
    'the sweep reports it as a source that did not answer')
  const row = getSourceHealth().find(r => r.name === 'animeProvider')
  assert.ok(row, 'it is in the health table at all')
  assert.strictEqual(row.healthy, false)
  assert.ok(row.failStreak >= 1,
    'and its failure streak — the number the maintenance panel colours — starts climbing')
})

// The list itself, built by the real function.
function backends() {
  // Each provider factory hands back a function whose NAME is what
  // resolveStream books health against, so the names are the assertion.
  const tag = n => {
    const f = async () => []
    Object.defineProperty(f, 'name', { value: n })
    return f
  }
  const ctx = {
    Array, Object,
    nyaa: () => tag('nyaa'),
    animetosho: () => tag('animetosho'),
    apibay: () => tag('apibay'),
    knaben: () => tag('knaben'),
    solidtorrents: () => tag('solidtorrents'),
    eztv: () => tag('eztv'),
    yts: () => tag('yts'),
    movieTv: () => tag('movieTvProvider'),
    anime: () => tag('animeProvider'),
    jackett: () => null,
  }
  vm.createContext(ctx)
  const start = MAIN.indexOf('function _videoBackends(')
  assert.ok(start > 0, 'found _videoBackends')
  vm.runInContext(MAIN.slice(start, MAIN.indexOf('\n}', start) + 2), ctx)
  return (type, settings) => ctx._videoBackends(type, settings || {}).map(b => b.name)
}

test('the anime list is real indexers only', () => {
  const names = backends()('anime', { torrentSources: true })
  assert.ok(!names.includes('animeProvider'),
    'an adapter with nothing to run has no place in the list: ' + names.join(', '))
  for (const real of ['nyaa', 'animetosho', 'apibay', 'knaben', 'solidtorrents']) {
    assert.ok(names.includes(real), 'the real indexers are untouched — missing ' + real)
  }
})

test('turning torrent sources off leaves anime with nothing, and says so plainly', () => {
  // Length, not deepStrictEqual: the array is built inside the vm and carries
  // the vm's own Array.prototype.
  const names = backends()('anime', { torrentSources: false })
  assert.strictEqual(names.length, 0,
    'there is no non-torrent anime source, and an empty list is the honest way to say it')
})

// Movie and TV are deliberately untouched here: movieTv is the same empty
// adapter, but it is the ONLY backend those two have when torrent sources are
// off, so removing it is a separate decision about what that switch should do.
test('the movie and tv lists are not changed by this', () => {
  const b = backends()
  assert.ok(b('movie', { torrentSources: true }).includes('yts'))
  assert.ok(b('tv', { torrentSources: true }).includes('eztv'))
  assert.deepStrictEqual(Array.from(b('movie', { torrentSources: false })), ['movieTvProvider'])
})
