'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  DEFAULT_BASE_URLS,
  buildSearchUrl,
  normalizeItem,
  createAnimetoshoProvider,
  _resetMirrorHealth,
} = require('../providers/animetosho')
const { fmtSize } = require('../providers/quality')

const HASH = c => String(c).repeat(40).slice(0, 40)

const row = (title, over = {}) => Object.assign({
  title,
  info_hash: HASH('a'),
  magnet_uri: `magnet:?xt=urn:btih:${over.info_hash || HASH('a')}&dn=${encodeURIComponent(title)}`,
  seeders: 50,
  leechers: 5,
  total_size: 1500000000,
}, over)

function jsonResponse(body, { ok = true } = {}) {
  return { ok, text: async () => JSON.stringify(body) }
}

test('buildSearchUrl uses the JSON feed with qx=1 and an encoded query', () => {
  assert.strictEqual(
    buildSearchUrl('https://feed.animetosho.org', 'Sousou no Frieren 09'),
    'https://feed.animetosho.org/json?qx=1&q=Sousou%20no%20Frieren%2009'
  )
})

test('normalizeItem maps a feed row to the shared torrent entry shape', () => {
  const entry = normalizeItem(row('[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCD1234].mkv'))
  assert.strictEqual(entry.kind, 'torrent')
  assert.strictEqual(entry.url, null)
  assert.strictEqual(entry.source, 'AnimeTosho')
  assert.strictEqual(entry.infoHash, HASH('a'))
  assert.ok(entry.magnet.startsWith('magnet:?xt=urn:btih:'))
  assert.strictEqual(entry.quality, '1080p')
  assert.strictEqual(entry.seeds, 50)
  assert.strictEqual(entry.isPack, false)
  assert.strictEqual(entry.dub, false)
  assert.strictEqual(entry.sub, true)
  assert.ok(entry.label.includes('AnimeTosho'))
  // One size convention across Movies & TV (audit N11): the label now says the
  // same binary gigabytes the source row's own size stat paints, so 1.5e9
  // bytes reads "1.4 GB" here and "1.4 GB" there, not "1.5" beside "1.4".
  assert.ok(entry.label.includes(fmtSize(1500000000)))
  assert.ok(entry.label.includes('1.4 GB'))
})

test('normalizeItem builds a magnet from the hash when magnet_uri is missing', () => {
  const entry = normalizeItem(row('Show - 01 (720p)', { magnet_uri: null }))
  assert.ok(entry.magnet.includes(`magnet:?xt=urn:btih:${HASH('a')}`))
  assert.ok(entry.magnet.includes('tr='), 'the built magnet must carry trackers')
})

test('normalizeItem drops a row with neither hash nor magnet', () => {
  assert.strictEqual(normalizeItem({ title: 'X', seeders: 9 }), null)
  assert.strictEqual(normalizeItem({ title: 'X', info_hash: 'not-a-hash' }), null)
})

test('normalizeItem recovers the info hash from the magnet when info_hash is bad', () => {
  const entry = normalizeItem({
    title: 'Show - 02 (1080p)',
    info_hash: null,
    magnet_uri: `magnet:?xt=urn:btih:${HASH('b')}&dn=Show`,
  })
  assert.strictEqual(entry.infoHash, HASH('b'))
})

test('null seeders is honest-unknown, not invented popularity', () => {
  const entry = normalizeItem(row('Show - 03 (1080p)', { seeders: null }))
  assert.strictEqual(entry.seeds, 0)
  assert.ok(!entry.label.includes('seeds'))
})

test('the provider declines anything that is not an anime request', async () => {
  let called = false
  const provider = createAnimetoshoProvider({ fetchFn: async () => { called = true } })
  assert.deepStrictEqual(await provider({ type: 'movie', title: 'Dune' }), [])
  assert.deepStrictEqual(await provider({ type: 'anime' }), [])
  assert.strictEqual(called, false)
})

test('the provider queries with the padded episode and returns only matching episodes', async () => {
  _resetMirrorHealth()
  const calls = []
  const feed = [
    row('[SubsPlease] Sousou no Frieren - 09 (1080p)', { info_hash: HASH('1') }),
    row('[SubsPlease] Sousou no Frieren - 19 (1080p)', { info_hash: HASH('2') }),
    row('[Group] Sousou no Frieren - 109 (720p)', { info_hash: HASH('3') }),
  ]
  const provider = createAnimetoshoProvider({
    baseUrls: ['https://feed.animetosho.org'],
    fetchFn: async url => { calls.push(url); return jsonResponse(feed) },
  })
  const entries = await provider({
    type: 'anime', titles: { romaji: 'Sousou no Frieren' }, episode: 9,
  })
  assert.ok(calls[0].includes('q=Sousou%20no%20Frieren%2009'), 'padded episode in the query')
  assert.strictEqual(entries.length, 1, '19 and 109 must not match a search for 9')
  assert.strictEqual(entries[0].infoHash, HASH('1'))
  _resetMirrorHealth()
})

// Long-running anime is numbered absolutely on the indexers ("One Piece 1071",
// never "S20E10"), so the absolute number is a legitimate match and a distinct
// query.
test('absolute episode numbering matches and is queried as its own form', async () => {
  _resetMirrorHealth()
  const calls = []
  const provider = createAnimetoshoProvider({
    baseUrls: ['https://feed.animetosho.org'],
    fetchFn: async url => {
      calls.push(decodeURIComponent(url))
      // Only the absolute-numbered query finds anything.
      if (url.includes('1071')) {
        return jsonResponse([row('[Net] One Piece - 1071 (1080p)', { info_hash: HASH('4') })])
      }
      return jsonResponse([])
    },
  })
  const entries = await provider({
    type: 'anime', titles: { romaji: 'One Piece' },
    episode: 10, season: 20, absoluteEpisode: 1071,
  })
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].infoHash, HASH('4'))
  assert.ok(calls.some(u => u.includes('One Piece 1071')), 'the absolute form is a distinct query')
  _resetMirrorHealth()
})

test('season packs are accepted for their own season and refused for another', async () => {
  _resetMirrorHealth()
  const feed = [
    row('[Group] Show Season 2 Batch 01-12 (1080p)', { info_hash: HASH('5') }),
    row('[Group] Show Season 1 Complete (1080p)', { info_hash: HASH('6') }),
  ]
  const provider = createAnimetoshoProvider({
    baseUrls: ['https://feed.animetosho.org'],
    fetchFn: async () => jsonResponse(feed),
  })
  const entries = await provider({
    type: 'anime', titles: { romaji: 'Show' }, episode: 5, season: 2,
  })
  assert.strictEqual(entries.length, 1, 'only the season-2 pack can contain S2E5')
  assert.strictEqual(entries[0].infoHash, HASH('5'))
  assert.strictEqual(entries[0].isPack, true, 'the streamer must know to pick a file inside')
  _resetMirrorHealth()
})

test('a dub request asks with dub qualifiers first and leads with the dub', async () => {
  _resetMirrorHealth()
  const calls = []
  const feed = [
    row('[Sub] Show - 04 (1080p)', { info_hash: HASH('7'), seeders: 900 }),
    row('[DualAudio] Show - 04 (1080p) [Dual Audio]', { info_hash: HASH('8'), seeders: 3 }),
  ]
  const provider = createAnimetoshoProvider({
    baseUrls: ['https://feed.animetosho.org'],
    fetchFn: async url => { calls.push(decodeURIComponent(url)); return jsonResponse(feed) },
  })
  const entries = await provider({
    type: 'anime', titles: { romaji: 'Show' }, episode: 4, dub: true,
  })
  assert.ok(calls[0].includes('Show Dual Audio'), 'dub-qualified query goes first')
  assert.strictEqual(entries[0].infoHash, HASH('8'), 'the requested dub outranks a popular sub')
  assert.ok(!('_preferred' in entries[0]), 'the internal ordering key must not leak')
  _resetMirrorHealth()
})

test('malformed responses are dead mirrors, never crashes', async () => {
  _resetMirrorHealth()
  const cases = [
    async () => ({ ok: false, status: 502, text: async () => '' }),
    async () => ({ ok: true, text: async () => '<html>Cloudflare</html>' }),
    async () => jsonResponse({ error: 'not an array' }),
    async () => { throw new Error('ENOTFOUND') },
  ]
  for (const fetchFn of cases) {
    const provider = createAnimetoshoProvider({ baseUrls: ['https://only'], fetchFn })
    assert.deepStrictEqual(
      await provider({ type: 'anime', titles: { romaji: 'Show' }, episode: 1 }),
      []
    )
  }
  _resetMirrorHealth()
})

test('rows that are not objects are skipped and duplicates collapse by hash', async () => {
  _resetMirrorHealth()
  const feed = [
    null, 'garbage', 42,
    row('Show - 06 (1080p)', { info_hash: HASH('9') }),
    row('Show - 06 v2 (1080p)', { info_hash: HASH('9') }),
  ]
  const provider = createAnimetoshoProvider({
    baseUrls: ['https://feed.animetosho.org'],
    fetchFn: async () => jsonResponse(feed),
  })
  const entries = await provider({ type: 'anime', titles: { romaji: 'Show' }, episode: 6 })
  assert.strictEqual(entries.length, 1)
  _resetMirrorHealth()
})

test('results are capped at maxResults and sorted by seeds', async () => {
  _resetMirrorHealth()
  const feed = []
  for (let i = 1; i <= 30; i++) {
    feed.push(row(`[G${i}] Show - 07 (1080p)`, {
      info_hash: (String(i).padStart(2, '0')).repeat(20), seeders: i,
    }))
  }
  const provider = createAnimetoshoProvider({
    baseUrls: ['https://feed.animetosho.org'],
    fetchFn: async () => jsonResponse(feed),
    maxResults: 5,
  })
  const entries = await provider({ type: 'anime', titles: { romaji: 'Show' }, episode: 7 })
  assert.strictEqual(entries.length, 5)
  assert.strictEqual(entries[0].seeds, 30, 'best-seeded first')
  _resetMirrorHealth()
})

test('racing: the fast mirror wins and the slow request is aborted', async () => {
  _resetMirrorHealth()
  const aborted = []
  const fetchFn = (url, opts) => new Promise((resolve, reject) => {
    if (url.startsWith('https://slow')) {
      opts.signal.addEventListener('abort', () => {
        aborted.push('slow')
        reject(new Error('aborted'))
      })
      return
    }
    setTimeout(() => resolve(jsonResponse([row('Show - 08 (1080p)')])), 5)
  })
  const provider = createAnimetoshoProvider({ fetchFn, baseUrls: ['https://slow', 'https://fast'] })
  const entries = await provider({ type: 'anime', titles: { romaji: 'Show' }, episode: 8 })
  assert.strictEqual(entries.length, 1)
  assert.deepStrictEqual(aborted, ['slow'])
  _resetMirrorHealth()
})

test('the default mirror list is real and https', () => {
  assert.ok(Array.isArray(DEFAULT_BASE_URLS) && DEFAULT_BASE_URLS.length > 0)
  assert.ok(DEFAULT_BASE_URLS.every(u => u.startsWith('https://')))
})
