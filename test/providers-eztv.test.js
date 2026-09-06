'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  DEFAULT_BASE_URLS, toNumericImdb, buildListUrl, matchesEpisode,
  normalizeTorrent, createEztvProvider,
} = require('../providers/eztv')

const RAW = {
  torrents: [
    { title: 'Breaking.Bad.S01E02.1080p.WEB.DDP5.1', hash: 'AAA', magnet_url: 'magnet:?xt=urn:btih:AAA', seeds: 42, season: '1', episode: '2' },
    { title: 'Breaking.Bad.S01E03.720p.WEB.AAC2.0', hash: 'BBB', magnet_url: 'magnet:?xt=urn:btih:BBB', seeds: 7, season: '1', episode: '3' },
    { title: 'Breaking.Bad.S02E01.1080p', hash: 'CCC', magnet_url: 'magnet:?xt=urn:btih:CCC', seeds: 3, season: '2', episode: '1' },
  ],
}

const jsonResponse = (body, { ok = true } = {}) => ({ ok, text: async () => JSON.stringify(body) })

// EZTV wants the digits only; TMDB hands back the "tt"-prefixed form.
test('toNumericImdb strips the tt prefix and rejects junk', () => {
  assert.strictEqual(toNumericImdb('tt0903747'), '0903747')
  assert.strictEqual(toNumericImdb('0903747'), '0903747')
  assert.strictEqual(toNumericImdb('not-an-id'), null)
  assert.strictEqual(toNumericImdb(null), null)
  assert.strictEqual(toNumericImdb(undefined), null)
})

test('buildListUrl produces an exact string', () => {
  assert.strictEqual(
    buildListUrl('https://eztvx.to', '0903747'),
    'https://eztvx.to/api/get-torrents?imdb_id=0903747&limit=100&page=1'
  )
})

// EZTV returns the whole series in one payload, so the filter is local.
test('matchesEpisode filters on season and episode', () => {
  assert.strictEqual(matchesEpisode({ season: '1', episode: '2' }, 1, 2), true)
  assert.strictEqual(matchesEpisode({ season: '1', episode: '3' }, 1, 2), false)
  assert.strictEqual(matchesEpisode({ season: '2', episode: '2' }, 1, 2), false)
  assert.strictEqual(matchesEpisode({ season: '1', episode: '2' }, null, null), true)
})

test('normalizeTorrent reads quality and audio out of the release title', () => {
  const e = normalizeTorrent(RAW.torrents[0])
  assert.strictEqual(e.kind, 'torrent')
  assert.strictEqual(e.source, 'EZTV')
  assert.strictEqual(e.quality, '1080p')
  assert.strictEqual(e.audioLayout, '5.1')
  assert.strictEqual(e.seeds, 42)
  assert.strictEqual(e.infoHash, 'AAA')
})

test('normalizeTorrent builds a magnet from the hash when magnet_url is missing', () => {
  const e = normalizeTorrent({ title: 'X.S01E01.1080p', hash: 'DDD', seeds: 1, season: '1', episode: '1' })
  assert.ok(e.magnet.startsWith('magnet:?xt=urn:btih:DDD'))
  assert.ok(e.magnet.includes('tr=udp'))
})

test('normalizeTorrent drops an entry with no hash rather than emitting a dud', () => {
  assert.strictEqual(normalizeTorrent({ title: 'X', seeds: 1 }), null)
})

test('the provider returns only the requested episode', async () => {
  const calls = []
  const provider = createEztvProvider({ fetchFn: async url => { calls.push(url); return jsonResponse(RAW) } })
  const entries = await provider({ type: 'tv', imdbId: 'tt0903747', season: 1, episode: 2 })
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].infoHash, 'AAA')
  // Mirrors race in parallel now, so every mirror is asked; the first-listed
  // one is initiated first.
  assert.deepStrictEqual(calls, DEFAULT_BASE_URLS.map(
    base => `${base}/api/get-torrents?imdb_id=0903747&limit=100&page=1`
  ))
})

// This is why the TV section had nothing to play: it must not be asked for
// movies, and it cannot answer without an IMDb id.
test('the provider declines anything that is not a TV request with an imdb id', async () => {
  let called = false
  const provider = createEztvProvider({ fetchFn: async () => { called = true; return jsonResponse(RAW) } })
  assert.deepStrictEqual(await provider({ type: 'movie', imdbId: 'tt1' }), [])
  assert.deepStrictEqual(await provider({ type: 'tv' }), [])
  assert.deepStrictEqual(await provider({ type: 'tv', imdbId: 'garbage' }), [])
  assert.strictEqual(called, false, 'no request should be made without a usable id')
})

test('a dead mirror falls through to the next one', async () => {
  const calls = []
  const provider = createEztvProvider({
    baseUrls: ['https://dead.example', 'https://live.example'],
    fetchFn: async url => {
      calls.push(url)
      if (url.startsWith('https://dead.example')) return { ok: false, status: 502, text: async () => '' }
      return jsonResponse(RAW)
    },
  })
  const entries = await provider({ type: 'tv', imdbId: 'tt0903747', season: 2, episode: 1 })
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].infoHash, 'CCC')
  assert.strictEqual(calls.length, 2)
})

test('the provider never throws: a network error and bad JSON both yield []', async () => {
  const boom = createEztvProvider({ baseUrls: ['https://x'], fetchFn: async () => { throw new Error('ENOTFOUND') } })
  assert.deepStrictEqual(await boom({ type: 'tv', imdbId: 'tt1', season: 1, episode: 1 }), [])
  const html = createEztvProvider({ baseUrls: ['https://x'], fetchFn: async () => ({ ok: true, text: async () => '<html>nope</html>' }) })
  assert.deepStrictEqual(await html({ type: 'tv', imdbId: 'tt1', season: 1, episode: 1 }), [])
})

// EZTV usually populates the numeric season/episode fields, but not for every
// show — and a blank field used to exclude every torrent for that series.
test('parseSxxExx reads the season and episode out of a release filename', () => {
  const { parseSxxExx } = require('../providers/eztv')
  assert.deepStrictEqual(parseSxxExx('Show.S02E11.1080p.WEB.mkv'), { season: 2, episode: 11 })
  assert.deepStrictEqual(parseSxxExx('Show S01 E05 720p'), { season: 1, episode: 5 })
  assert.strictEqual(parseSxxExx('Show.1080p.mkv'), null)
  assert.strictEqual(parseSxxExx(null), null)
})

test('a torrent with blank season/episode fields falls back to its filename', () => {
  assert.strictEqual(matchesEpisode({ season: '0', episode: '0', filename: 'Show.S03E07.1080p.mkv' }, 3, 7), true)
  assert.strictEqual(matchesEpisode({ season: '', episode: '', filename: 'Show.S03E07.1080p.mkv' }, 3, 8), false)
  // Nothing to go on at all must exclude, not match everything.
  assert.strictEqual(matchesEpisode({ season: '', episode: '', filename: 'Show.1080p.mkv' }, 3, 7), false)
})

// A dead first mirror otherwise burns its timeout on every single lookup.
test('the mirror that answered last is tried first on the next query', async () => {
  const { _resetMirrorHealth } = require('../providers/eztv')
  _resetMirrorHealth()
  const calls = []
  const provider = createEztvProvider({
    baseUrls: ['https://dead.example', 'https://live.example'],
    fetchFn: async url => {
      calls.push(new URL(url).origin)
      if (url.startsWith('https://dead.example')) throw new Error('ENOTFOUND')
      return jsonResponse(RAW)
    },
  })
  await provider({ type: 'tv', imdbId: 'tt0903747', season: 1, episode: 2 })
  assert.deepStrictEqual(calls, ['https://dead.example', 'https://live.example'])
  await provider({ type: 'tv', imdbId: 'tt0903747', season: 1, episode: 2 })
  assert.strictEqual(calls[2], 'https://live.example', 'the known-good mirror must lead')
  _resetMirrorHealth()
})

test('quality is parsed from the filename, which carries it, not the prettified title', () => {
  const e = normalizeTorrent({
    title: 'Show Episode Two',
    filename: 'Show.S01E02.1080p.WEB.DDP5.1.x264.mkv',
    hash: 'ZZZ', magnet_url: 'magnet:?xt=urn:btih:ZZZ', seeds: 5, season: '1', episode: '2',
  })
  assert.strictEqual(e.quality, '1080p')
  assert.strictEqual(e.audioLayout, '5.1')
  assert.strictEqual(e.title, 'Show Episode Two')
})
