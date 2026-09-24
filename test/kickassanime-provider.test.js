'use strict'
// The instant HTTP anime source: the four-step chain the streaming sites use,
// run here against fakes shaped from the LIVE responses captured on 2026-09-24
// (the player-page fixture is the real page, byte for byte). The live chain was
// verified first — search to master.m3u8 to mpv decoding 1080p frames — and
// these tests pin the handling, not the host.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  createKickAssAnimeProvider, extractStream, episodeRef, searchTerms,
} = require('../providers/kickassanime')

const PLAYER_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'kaa-player-page.html'), 'utf8')

const FRIEREN = { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End' }
const REQ = { type: 'anime', title: FRIEREN.english, titles: FRIEREN, episode: 5 }

// A fake host, shaped call for call from the live one. `log` records the URLs
// asked, so a test can assert what was and was not asked.
function fakeHost({ servers, searchResults, log = [], episodeListDelayMs = 0 } = {}) {
  const ok = body => ({ ok: true, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
  return async (url, opts) => {
    log.push(url)
    if (url.endsWith('/api/search')) {
      return ok(searchResults !== undefined ? searchResults : [
        { slug: 'sousou-no-frieren-2d15', title: 'Sousou no Frieren', type: 'tv', year: 2023 },
      ])
    }
    if (/\/episodes\?/.test(url)) {
      if (episodeListDelayMs) await new Promise(r => setTimeout(r, episodeListDelayMs))
      return ok({ result: [
        { slug: 'aaa111', episode_number: 1, title: 'Journey’s End' },
        { slug: 'f897b3', episode_number: 5, title: 'Phantoms of the Dead' },
      ] })
    }
    if (/\/episode\/ep-/.test(url)) {
      return ok({
        episode_title: 'Phantoms of the Dead',
        servers: servers !== undefined ? servers : [
          { name: 'VidStreaming', src: 'https://krussdomi.com/cat-player/player?id=abc' },
        ],
      })
    }
    if (/cat-player/.test(url)) return ok(PLAYER_HTML)
    return { ok: false, text: async () => '' }
  }
}

test('the full chain: a request becomes a playable entry', async () => {
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({}) })
  const out = await provider(REQ)
  assert.strictEqual(out.length, 1)
  const e = out[0]
  assert.strictEqual(e.kind, 'http')
  assert.match(e.url, /^https:\/\/hls\.krussdomi\.com\/manifest\/[a-f0-9]+\/master\.m3u8/,
    'the manifest out of the real player page')
  assert.strictEqual(e.instant, true, 'the badge is the point of the source')
  assert.strictEqual(e.sub, true)
  assert.strictEqual(e.dub, false)
  assert.ok(e.headers && typeof e.headers.Referer === 'string', 'mpv needs the headers the CDN checks')
  assert.ok(e.subtitles.length >= 1, 'the player page lists subtitle tracks in the clear')
  assert.ok(e.subtitles.every(s => !/preview/i.test(s.url)), 'the thumbnail strip is not a subtitle')
})

test('the entry is named like a release: show first, then the episode', async () => {
  // The renderer's plausibility filter hides an entry whose name does not
  // carry the show's title — an entry titled only "Phantoms of the Dead"
  // reads as a different work and vanishes from the list.
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({}) })
  const [e] = await provider(REQ)
  assert.match(e.title, /^Sousou no Frieren - 05/)
  const RN = require('../src/release-name.js')
  assert.strictEqual(RN.plausible({ type: 'anime', title: FRIEREN.english, titles: FRIEREN, season: null }, e.title), true,
    'the entry must survive the renderer’s own filter, or it was never really added')
})

test('a show that merely shares a word is rejected', async () => {
  // The Monster lesson: a text search answers with every show containing the
  // word. Same guard the torrent providers use, same reason.
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({
    searchResults: [{ slug: 'frieren-cafe-story-9999', title: 'Cafe Story of a Completely Different Frieren World', type: 'tv' }],
  }) })
  assert.deepStrictEqual(await provider(REQ), [])
})

test('a show listed with zero servers answers empty, not broken', async () => {
  // The Kaiji case, measured live: the catalogue lists the show, the video is
  // not there. An ordinary miss — the torrent sources still answer.
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({ servers: [] }) })
  assert.deepStrictEqual(await provider(REQ), [])
})

test('the dub request asks the host in the dub language', async () => {
  const log = []
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({ log }) })
  const out = await provider(Object.assign({}, REQ, { dub: true }))
  assert.strictEqual(out[0].dub, true)
  assert.ok(log.some(u => /lang=en-US/.test(u)), 'sub and dub are the same episode under two language codes')
})

test('a second candidate is not walked once the first yielded streams', async () => {
  const log = []
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({
    log,
    searchResults: [
      { slug: 'sousou-no-frieren-2d15', title: 'Sousou no Frieren' },
      { slug: 'sousou-no-frieren-movie-777', title: 'Sousou no Frieren' },
    ],
  }) })
  const out = await provider(REQ)
  assert.strictEqual(out.length, 1)
  assert.ok(!log.some(u => u.includes('movie-777')),
    'the first matching show with streams IS the show; the rest are other entries sharing its words')
})

test('a request that is not anime, or has no episode, asks nothing', async () => {
  const log = []
  const provider = createKickAssAnimeProvider({ fetchFn: fakeHost({ log }) })
  assert.deepStrictEqual(await provider({ type: 'movie', title: 'Dune' }), [])
  assert.deepStrictEqual(await provider({ type: 'anime', title: 'X' }), [])
  assert.strictEqual(log.length, 0)
})

test('out of time, it answers with what it has and asks nothing further', async () => {
  const log = []
  const provider = createKickAssAnimeProvider({
    fetchFn: fakeHost({ log, episodeListDelayMs: 300 }),
    timeBudgetMs: 100,
  })
  const t0 = Date.now()
  const out = await provider(REQ)
  assert.ok(Date.now() - t0 < 2000, 'the budget bounds the run')
  assert.deepStrictEqual(out, [], 'nothing was resolved in time — an honest empty, not a hang')
  assert.ok(!log.some(u => /\/episode\/ep-/.test(u)), 'no request fired after the budget was spent')
})

test('extractStream reads the real page: manifest, subtitles, no thumbnails', () => {
  const s = extractStream(PLAYER_HTML)
  assert.ok(s, 'the live page must parse')
  assert.match(s.url, /master\.m3u8/)
  assert.ok(s.subtitles.length >= 5, 'the live page lists many languages: got ' + s.subtitles.length)
  assert.ok(s.subtitles.every(x => !/preview/i.test(x.url)))
  assert.ok(s.subtitles.some(x => /english/i.test(x.label)), 'labels are read from beside each track')
})

test('extractStream on a page with no stream is null, never a throw', () => {
  assert.strictEqual(extractStream('<html>redesigned</html>'), null)
  assert.strictEqual(extractStream(''), null)
  assert.strictEqual(extractStream(null), null)
})

test('episodeRef spells the reference the way the host does', () => {
  // Confirmed against miruro’s own encoding of the same episode: "ep-1-12cab3".
  assert.strictEqual(episodeRef(1, '12cab3'), 'ep-1-12cab3')
  assert.strictEqual(episodeRef(12, 'b2397a'), 'ep-12-b2397a')
  assert.strictEqual(episodeRef(null, 'x'), null)
  assert.strictEqual(episodeRef(3, ''), null)
})

test('searchTerms tries romaji first — this host indexes under it', () => {
  assert.deepStrictEqual(
    searchTerms({ title: FRIEREN.english, titles: FRIEREN }),
    ['Sousou no Frieren', FRIEREN.english])
})
