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
  // Origin naming the PLAYER host. This asserted a Referer until 2026-09-24 —
  // it was asserting the wrong header, which is how a source that could never
  // play shipped with a green suite.
  assert.strictEqual(e.headers.Origin, 'https://krussdomi.com',
    'the CDN 403s every segment without this, and mpv hangs silently on that')
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

// ── What audio a stream actually carries ───────────────────────────────────
//
// "There is only japanese language available. There does exist the eng version
// and its in the torrents, so it has to be there too." Measured: the streaming
// host has 13 Japanese episodes of that show and zero English, while nyaa has
// dozens of dual-audio releases. Both true at once. What the app could not do
// was SAY so — an entry announced "Sub" or "Dub" from what had been asked for,
// never from what the manifest held, so a stream carrying nine languages and
// one carrying Japanese alone were indistinguishable until it was playing.

const { audioTracksOf, hasEnglishAudio, hasJapaneseAudio } = require('../providers/kickassanime')

const MULTI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="English",LANGUAGE="eng",URI="a/playlist.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="Japanese",DEFAULT=YES,LANGUAGE="jpn",URI="b/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="stereo"
v/playlist.m3u8`
const JA_ONLY = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="Japanese",DEFAULT=YES,LANGUAGE="jpn",URI="b/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="stereo"
v/playlist.m3u8`

function hostWithManifest(manifest) {
  const ok = b => ({ ok: true, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) })
  return async url => {
    if (url.endsWith('/api/search')) return ok([{ slug: 's1', title: 'Sousou no Frieren' }])
    if (/\/episodes\?/.test(url)) return ok({ result: [{ slug: 'e5', episode_number: 5 }] })
    if (/\/episode\/ep-/.test(url)) return ok({ servers: [{ name: 'VidStreaming', src: 'https://krussdomi.com/p?id=1' }] })
    if (/\.m3u8/.test(url)) return ok(manifest)
    return ok(PLAYER_HTML)
  }
}
const ANY = { type: 'anime', title: 'Frieren', episode: 5, titles: { romaji: 'Sousou no Frieren', english: 'Frieren' } }

test('audioTracksOf reads every audio track a manifest declares', () => {
  const t = audioTracksOf(MULTI)
  assert.deepStrictEqual(t.map(x => x.label), ['English', 'Japanese'])
  assert.strictEqual(hasEnglishAudio(t), true)
  assert.strictEqual(hasJapaneseAudio(t), true)
  assert.strictEqual(hasEnglishAudio(audioTracksOf(JA_ONLY)), false)
})

test('audioTracksOf is empty, never a throw, on anything unexpected', () => {
  for (const bad of ['', null, '<html>nope</html>', '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English"']) {
    assert.deepStrictEqual(audioTracksOf(bad), [])
  }
})

test('a stream carrying English satisfies a dub request', async () => {
  // It did not before: dub was set from what was ASKED, so a manifest holding
  // a perfectly good English track was offered as a sub and ranked beneath
  // every dubbed torrent.
  const provider = createKickAssAnimeProvider({ fetchFn: hostWithManifest(MULTI) })
  const [e] = await provider(Object.assign({}, ANY, { dub: true }))
  assert.strictEqual(e.dub, true)
  assert.strictEqual(e.sub, true, 'one manifest holding both is honestly both — the player switches')
  assert.match(e.label, /incl\. English/)
  assert.deepStrictEqual(e.audioLanguages, ['English', 'Japanese'])
})

test('a Japanese-only stream says Japanese and does not claim a dub', async () => {
  const provider = createKickAssAnimeProvider({ fetchFn: hostWithManifest(JA_ONLY) })
  const [e] = await provider(Object.assign({}, ANY, { dub: true }))
  assert.strictEqual(e.dub, false, 'claiming a dub it does not have is how the row lies')
  assert.match(e.label, /Japanese/)
  assert.ok(!/languages/.test(e.label), 'one track is named, not counted')
})

test('a manifest that will not load leaves the audio unknown, not the entry lost', async () => {
  const ok = b => ({ ok: true, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) })
  const provider = createKickAssAnimeProvider({ fetchFn: async url => {
    if (/\.m3u8/.test(url)) throw new Error('CDN hiccup')
    if (url.endsWith('/api/search')) return ok([{ slug: 's1', title: 'Sousou no Frieren' }])
    if (/\/episodes\?/.test(url)) return ok({ result: [{ slug: 'e5', episode_number: 5 }] })
    if (/\/episode\/ep-/.test(url)) return ok({ servers: [{ name: 'V', src: 'https://krussdomi.com/p?id=1' }] })
    return ok(PLAYER_HTML)
  } })
  const [e] = await provider(Object.assign({}, ANY, { dub: true }))
  assert.ok(e, 'a stream that plays must not be dropped because its languages could not be counted')
  assert.strictEqual(e.dub, true, 'falls back to what was asked for')
  assert.deepStrictEqual(e.audioLanguages, [])
})
