'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  BASE,
  toNumericImdb,
  normalizeLanguages,
  buildSearchUrl,
  normalizeSearchResult,
  createOpenSubtitles,
} = require('../subs/opensubtitles')

const rawResult = (over = {}, attrs = {}, file = {}) => Object.assign({
  id: '9000',
  type: 'subtitle',
  attributes: Object.assign({
    language: 'en',
    release: 'Dune.Part.Two.2024.1080p.WEB.H264',
    download_count: 4210,
    files: [Object.assign({ file_id: 555, file_name: 'dune.srt' }, file)],
  }, attrs),
}, over)

function jsonResponse(body, { ok = true } = {}) {
  return { ok, json: async () => body }
}

test('toNumericImdb strips the tt prefix and refuses garbage', () => {
  assert.strictEqual(toNumericImdb('tt0903747'), '0903747')
  assert.strictEqual(toNumericImdb('0903747'), '0903747')
  assert.strictEqual(toNumericImdb('garbage'), null)
  assert.strictEqual(toNumericImdb(null), null)
})

test('normalizeLanguages accepts an array or a comma list and lowercases', () => {
  assert.strictEqual(normalizeLanguages(['en', 'ES', 'en']), 'en,es')
  assert.strictEqual(normalizeLanguages('en, Fr'), 'en,fr')
  assert.strictEqual(normalizeLanguages([]), null)
  assert.strictEqual(normalizeLanguages(null), null)
})

test('buildSearchUrl carries every given filter with alphabetised params', () => {
  const url = buildSearchUrl({
    imdbId: 'tt0903747', season: 1, episode: 2, languages: ['en'],
  })
  assert.strictEqual(url,
    `${BASE}/subtitles?episode_number=2&imdb_id=0903747&languages=en&season_number=1`)
})

test('buildSearchUrl supports tmdb id and free-text query forms', () => {
  assert.strictEqual(buildSearchUrl({ tmdbId: 693134 }), `${BASE}/subtitles?tmdb_id=693134`)
  assert.strictEqual(buildSearchUrl({ query: 'Dune Part Two' }),
    `${BASE}/subtitles?query=Dune+Part+Two`)
})

test('normalizeSearchResult maps the row and drops one without a file id', () => {
  assert.deepStrictEqual(normalizeSearchResult(rawResult()), {
    id: '9000',
    language: 'en',
    release: 'Dune.Part.Two.2024.1080p.WEB.H264',
    downloadCount: 4210,
    fileId: 555,
  })
  assert.strictEqual(normalizeSearchResult(rawResult({}, { files: [] })), null)
  assert.strictEqual(normalizeSearchResult({ id: '1' }), null)
  assert.strictEqual(normalizeSearchResult(null), null)
})

// No key is not an error — it is a feature the user has not set up. The
// empty result carries the marker so the UI can say "add a key in Settings"
// instead of "no subtitles found".
test('search without a key returns [] flagged needsKey and makes no request', async () => {
  let called = false
  const subs = createOpenSubtitles({ fetcher: async () => { called = true } })
  const out = await subs.search({ imdbId: 'tt1' })
  assert.deepStrictEqual([...out], [])
  assert.strictEqual(out.needsKey, true)
  assert.strictEqual(called, false)
})

test('download without a key returns { url: null, needsKey: true }', async () => {
  const subs = createOpenSubtitles({ fetcher: async () => { throw new Error('never') } })
  assert.deepStrictEqual(await subs.download(555), { url: null, needsKey: true })
})

test('search sends the Api-Key header and normalizes sorted by downloads', async () => {
  let captured = null
  const fetcher = async (url, opts) => {
    captured = { url, opts }
    return jsonResponse({ data: [
      rawResult({ id: '1' }, { download_count: 10, release: 'small' }, { file_id: 1 }),
      rawResult({ id: '2' }, { download_count: 999, release: 'big' }, { file_id: 2 }),
      { id: '3' }, // no attributes: dropped
    ] })
  }
  const subs = createOpenSubtitles({ apiKey: 'k123', fetcher })
  const out = await subs.search({ imdbId: 'tt42', languages: 'en' })
  assert.strictEqual(captured.opts.headers['Api-Key'], 'k123')
  assert.ok(captured.opts.headers['User-Agent'], 'the API rejects an empty User-Agent')
  assert.ok(captured.url.startsWith(`${BASE}/subtitles?`))
  assert.deepStrictEqual(out.map(r => r.id), ['2', '1'], 'most-downloaded first')
  assert.strictEqual(out[0].fileId, 2)
  assert.strictEqual(out.needsKey, undefined)
})

test('the api key may be a function so the settings value is read fresh', async () => {
  let key = null
  const fetcher = async () => jsonResponse({ data: [] })
  const subs = createOpenSubtitles({ apiKey: () => key, fetcher })
  assert.strictEqual((await subs.search({ query: 'x' })).needsKey, true)
  key = 'now-set'
  assert.strictEqual((await subs.search({ query: 'x' })).needsKey, undefined)
})

test('search never throws: bad status, bad body and a network error yield []', async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json: async () => { throw new Error('bad json') } }),
    async () => jsonResponse({ data: 'not an array' }),
    async () => { throw new Error('ENOTFOUND') },
  ]) {
    const subs = createOpenSubtitles({ apiKey: 'k', fetcher })
    assert.deepStrictEqual(await subs.search({ imdbId: 'tt1' }), [])
  }
})

test('download POSTs the file id and returns the minted link', async () => {
  let captured = null
  const fetcher = async (url, opts) => {
    captured = { url, opts }
    return jsonResponse({ link: 'https://dl.opensubtitles.com/x.srt', remaining: 99 })
  }
  const subs = createOpenSubtitles({ apiKey: 'k123', fetcher })
  const out = await subs.download(555)
  assert.strictEqual(captured.url, `${BASE}/download`)
  assert.strictEqual(captured.opts.method, 'POST')
  assert.strictEqual(captured.opts.headers['Api-Key'], 'k123')
  assert.strictEqual(captured.opts.headers['Content-Type'], 'application/json')
  assert.deepStrictEqual(JSON.parse(captured.opts.body), { file_id: 555 })
  assert.deepStrictEqual(out, { url: 'https://dl.opensubtitles.com/x.srt' })
})

test('download never throws: failures and a missing link yield { url: null }', async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 406 }),
    async () => jsonResponse({}),
    async () => { throw new Error('ENOTFOUND') },
  ]) {
    const subs = createOpenSubtitles({ apiKey: 'k', fetcher })
    assert.deepStrictEqual(await subs.download(555), { url: null })
  }
  const subs = createOpenSubtitles({ apiKey: 'k', fetcher: async () => { throw new Error('never') } })
  assert.deepStrictEqual(await subs.download(null), { url: null })
})
