'use strict'
// The album-info / artist-releases handlers, EXECUTED — not string-matched.
//
// Both handlers are lifted out of main.js with their own helpers and run
// against stubbed fetchers and a fake enrich store, so these assertions are
// about what the code does rather than about what it looks like. The fixtures
// are saved live responses.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const peerEnrich = require('../src/peer-enrich')
const artistInfo = require('../src/artist-info')

const fixture = n => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'album-info', n), 'utf8'))

const WYWH_SEARCH = fixture('mb-release-group-search-wywh.json')
const WYWH_DETAIL = fixture('mb-release-group-wywh.json')
const WD_SITELINKS = fixture('wikidata-sitelinks-wywh.json')
const WIKI_EXTRACT = fixture('wikipedia-extract-wywh.json')
const PORTISHEAD_RGS = fixture('mb-release-groups-portishead.json')
const DISCOGS_SEARCH = fixture('discogs-search-dummy.json')
const DISCOGS_MASTER = fixture('discogs-master-dummy.json')
const WEEZER_SEARCH = fixture('mb-release-group-search-weezer.json')
const VA_ARTISTS = fixture('mb-artist-search-va.json')
const MCCARTNEY_50 = fixture('mb-release-groups-mccartney-50.json')
const MCCARTNEY_P1 = fixture('mb-release-groups-mccartney-page1.json')
const MCCARTNEY_P2 = fixture('mb-release-groups-mccartney-page2.json')

// ── lifting ──────────────────────────────────────────────────────────────────

function slice(from, toAfter) {
  const at = MAIN.indexOf(from)
  assert.ok(at > -1, 'main.js must still contain: ' + from)
  const end = MAIN.indexOf(toAfter, at)
  assert.ok(end > at, 'could not find the end of: ' + from)
  return MAIN.slice(at, end + toAfter.length)
}

// Both album handlers plus the Wikidata URL builder and the refusal sentence
// they share, run as one unit.
function liftAlbumHandlers(env) {
  const at = MAIN.indexOf('function _wikidataSitelinksUrl(qid) {')
  const end = MAIN.indexOf("ipcMain.handle('discogs-token-get'", at)
  assert.ok(at > -1 && end > at, 'both album handlers must still live above discogs-token-get')
  const src = MAIN.slice(at, end)
  const handlers = {}
  const names = ['ipcMain', 'peerEnrich', 'artistInfo', '_enrichGet', '_enrichSet',
    '_mbThrottle', '_mbGetJson', '_artistInfoFetchJson', 'store']
  const values = names.map(n => n === 'ipcMain'
    ? { handle: (channel, fn) => { handlers[channel] = fn } }
    : env[n])
  new Function(...names, src)(...values)
  return handlers
}

function liftDiscogsHandler(env) {
  const src = slice("ipcMain.handle('discogs-album'", '\n})')
  const handlers = {}
  const names = ['ipcMain', 'peerEnrich', '_enrichGet', '_enrichSet',
    '_discogsGetJson', '_discogsRedact', 'store']
  const values = names.map(n => n === 'ipcMain'
    ? { handle: (channel, fn) => { handlers[channel] = fn } }
    : env[n])
  new Function(...names, src)(...values)
  return handlers['discogs-album']
}

// A stand-in for the peerEnrich side-store: the same get/set contract, with the
// writes visible so "nothing was cached" is assertable.
function fakeStore(seed) {
  const map = Object.assign({}, seed || {})
  return {
    map,
    _enrichGet: k => (k in map ? map[k] : null),
    _enrichSet: (k, v) => { map[k] = v },
  }
}

// ── album-info ───────────────────────────────────────────────────────────────

function albumEnv(opts) {
  const o = opts || {}
  const store = fakeStore(o.seed)
  const mbCalls = [], webCalls = []
  const env = {
    peerEnrich, artistInfo, store: { get: () => '' },
    _enrichGet: store._enrichGet,
    _enrichSet: store._enrichSet,
    _mbThrottle: fn => (o.throttleThrows ? Promise.reject(new Error('throttle was used')) : fn()),
    _mbGetJson: async p => { mbCalls.push(p); return (o.mb || (() => null))(p) },
    _artistInfoFetchJson: async url => { webCalls.push(url); return (o.web || (() => null))(url) },
  }
  return { env, store, mbCalls, webCalls, handlers: liftAlbumHandlers(env) }
}

const mbHit = p => {
  if (p.startsWith('/release-group/?')) return WYWH_SEARCH
  if (p.startsWith('/release-group/')) return WYWH_DETAIL
  return null
}
const webHit = url => {
  if (url.includes('wikidata.org')) return WD_SITELINKS
  if (url.includes('prop=extracts')) return WIKI_EXTRACT
  return null
}

test('album-info returns the documented shape for a hit, and caches it', async () => {
  const h = albumEnv({ mb: mbHit, web: webHit })
  const r = await h.handlers['album-info'](null, { artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975 })
  assert.equal(r.ok, true)
  assert.equal(r.found, true)
  assert.equal(r.confidence, 'firm')
  assert.equal(r.mbid, '1a272023-10d3-38ee-bab3-317b55fcc21d')
  assert.equal(r.artistMbid, '83d91898-7763-47d7-b03b-b92132375c47')
  assert.equal(r.title, 'Wish You Were Here')
  assert.equal(r.date, '1975-09-12')
  assert.equal(r.primaryType, 'Album')
  assert.deepEqual(r.secondaryTypes, [])
  assert.equal(r.discogsUrl, 'https://www.discogs.com/master/11703')
  assert.ok(r.genres.length && r.genres[0].count > 0)
  assert.ok(r.wikiExtract && r.wikiExtract.startsWith('Wish You Were Here is the ninth studio album'))
  assert.ok(h.store.map['albuminfo:v2:pink floyd::wish you were here::1975::'], 'the answer is cached')
})

test('the cache key carries the year and the edition, not just the names', async () => {
  // All seven of MusicBrainz's self-titled Weezer albums shared one key
  // ('albuminfo:v1:weezer::weezer'), so the first answer — right or wrong — was
  // pinned on every folder of that album for thirty days. These three folders
  // are three different records and must not share an entry.
  const h = albumEnv({ mb: mbHit, web: () => null })
  const ask = a => h.handlers['album-info'](null, { artist: 'Weezer', album: 'Weezer', ...a })
  await ask({})
  await ask({ year: 2008 })
  await ask({ year: 2014, editionNote: '2014 Remaster' })
  assert.equal(Object.keys(h.store.map).length, 3, 'three folders, three entries')
  for (const k of Object.keys(h.store.map)) assert.ok(k.startsWith('albuminfo:v2:'))
})

test('album-info goes through Wikidata, not straight to Wikipedia by title', async () => {
  // Looking an album up by bare title is how "Dummy" becomes a disambiguation
  // page printed as fact about the record.
  const h = albumEnv({ mb: mbHit, web: webHit })
  await h.handlers['album-info'](null, { artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975 })
  assert.ok(h.webCalls[0].includes('wbgetentities'), 'the Wikidata hop comes first')
  assert.ok(h.webCalls[0].includes('sitefilter=enwiki'))
  assert.ok(!h.webCalls[0].includes('Special:EntityData'), '48,718 bytes for a 179-byte question')
  assert.ok(h.webCalls[1].includes('Wish%20You%20Were%20Here%20(Pink%20Floyd%20album)'),
    'the page title comes from Wikidata, not from the folder name')
})

test('album-info makes exactly the two throttled MusicBrainz hops', async () => {
  const h = albumEnv({ mb: mbHit, web: webHit })
  await h.handlers['album-info'](null, { artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975 })
  assert.equal(h.mbCalls.length, 2)
  assert.ok(h.mbCalls[0].includes('release-group') && h.mbCalls[0].includes('query='))
  assert.ok(h.mbCalls[1].includes('inc=genres%2Btags%2Burl-rels%2Bartist-credits') ||
    h.mbCalls[1].includes('inc=genres+tags+url-rels+artist-credits'),
    'one response carries the genres, both relations and the artist MBID')
})

test('album-info asks for a window wide enough to rank in', async () => {
  // The window is cut BEFORE the ranking, so a record missing from it can never
  // be picked. The live search for Weezer's self-titled album reports 18 hits
  // and seven of them are self-titled studio albums scoring 100 — five of which
  // is all a limit=5 request can hold.
  assert.equal(WEEZER_SEARCH.count, 18)
  assert.equal(WEEZER_SEARCH['release-groups'].filter(r => r.title === 'Weezer').length, 7)
  const h = albumEnv({ mb: () => WEEZER_SEARCH, web: () => null })
  await h.handlers['album-info'](null, { artist: 'Weezer', album: 'Weezer' })
  assert.ok(h.mbCalls[0].includes('limit=25'), 'the search window is 25, not 5')
  assert.equal(h.mbCalls.length, 2, 'and it is still one search and one detail read')
})

test('album-info hands the picker the artist and the edition note', async () => {
  // Both were already being threaded from the folder through the dossier; the
  // picker never read either one until the reissue-year and artist fixes.
  const seen = []
  const env = albumEnv({ mb: mbHit, web: webHit })
  const real = peerEnrich.pickReleaseGroup
  env.env.peerEnrich = Object.assign({}, peerEnrich, {
    pickReleaseGroup: (json, opts) => { seen.push(opts); return real(json, opts) },
  })
  const handlers = liftAlbumHandlers(env.env)
  await handlers['album-info'](null, {
    artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975, editionNote: '2011 Remaster',
  })
  assert.deepEqual(seen[0], {
    title: 'Wish You Were Here', artist: 'Pink Floyd', year: 1975, editionNote: '2011 Remaster',
  })
})

test('album-info caches a clean miss — but never a thrown lookup', async () => {
  const miss = albumEnv({ mb: () => ({ 'release-groups': [] }) })
  const r = await miss.handlers['album-info'](null, { artist: 'Nobody', album: 'Nothing' })
  assert.equal(r.ok, true)
  assert.equal(r.found, false)
  assert.equal(r.confidence, null)
  assert.ok('albuminfo:v2:nobody::nothing::::' in miss.store.map,
    'MusicBrainz genuinely not having a record is a stable fact')

  const thrown = albumEnv({ mb: () => { throw new Error('ENOTFOUND musicbrainz.org') } })
  const t = await thrown.handlers['album-info'](null, { artist: 'Nobody', album: 'Nothing' })
  assert.equal(t.ok, false)
  assert.ok(/did not answer/.test(t.reason), 'a readable sentence, not a stack')
  assert.deepEqual(Object.keys(thrown.store.map), [],
    'a network blip must not pin "nothing found" on this album for a month')
})

test('album-info reads the cache BEFORE the first throttled call', async () => {
  // A cached album has to paint in milliseconds even while the room's warm
  // sweep owns the throttle chain. _mbThrottle rejects on sight here, so a
  // cache read that happened after it would fail the test.
  const h = albumEnv({
    throttleThrows: true,
    seed: { 'albuminfo:v2:pink floyd::wish you were here::::': { found: true, confidence: 'firm', title: 'Wish You Were Here' } },
  })
  const r = await h.handlers['album-info'](null, { artist: 'Pink Floyd', album: 'Wish You Were Here' })
  assert.equal(r.ok, true)
  assert.equal(r.fromCache, true)
  assert.equal(r.title, 'Wish You Were Here')
  assert.equal(h.mbCalls.length, 0)
})

test('album-info refuses a folder with no artist without asking anything', async () => {
  const h = albumEnv({ mb: mbHit })
  const r = await h.handlers['album-info'](null, { artist: '', album: 'Some Folder' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, "This folder's name doesn't say who the artist is, so I can't look the record up.")
  assert.equal(h.mbCalls.length, 0, 'artist:"" would burn two throttled slots on whatever Lucene liked')
})

// ── artist-releases ──────────────────────────────────────────────────────────

test('artist-releases with a firm MBID skips the artist search entirely', async () => {
  const h = albumEnv({ mb: () => PORTISHEAD_RGS })
  const r = await h.handlers['artist-releases'](null, { artistMbid: 'MBID', artist: 'Portishead' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.releases.map(x => x.title), ['Dummy', 'Portishead', 'Third'])
  assert.equal(h.mbCalls.length, 1)
  assert.ok(h.mbCalls[0].includes('artist=MBID'))
})

test('artist-releases with no MBID searches for one, caches it, then asks once more', async () => {
  const h = albumEnv({
    mb: p => (p.startsWith('/artist?')
      ? { artists: [{ id: 'FOUND-MBID', name: 'Portishead', score: 100 }] }
      : PORTISHEAD_RGS),
  })
  const r = await h.handlers['artist-releases'](null, { artist: 'Portishead' })
  assert.equal(r.artistMbid, 'FOUND-MBID')
  assert.equal(r.releases.length, 3)
  assert.equal(h.mbCalls.length, 2, 'one search, one browse')
  assert.equal(h.store.map['artistmbid:v1:portishead'], 'FOUND-MBID',
    'cached per ARTIST, so it is paid once per artist and not once per album')
  assert.ok(h.store.map['artistrgs:v2:FOUND-MBID'])

  // A second open of any album by this artist costs nothing at all.
  const again = await h.handlers['artist-releases'](null, { artist: 'Portishead' })
  assert.equal(again.releases.length, 3)
  assert.equal(again.fromCache, true)
  assert.equal(h.mbCalls.length, 2, 'no further network call')
})

test('artist-releases answers a shape when MusicBrainz has no such artist', async () => {
  const h = albumEnv({ mb: () => ({ artists: [] }) })
  const r = await h.handlers['artist-releases'](null, { artist: 'Nobody At All' })
  assert.equal(r.ok, true)
  assert.equal(r.artistMbid, null)
  assert.deepEqual(r.releases, [])
})

test('artist-releases will not take a band that is not the one asked for', async () => {
  // The live search for "VA" — what a folder called "VA - Best of the 90s"
  // parses its artist as — answers with "No Te Va Gustar" at score 100. Taking
  // artists[0] blind printed a Uruguayan rock band's catalogue under a heading
  // reading "More by VA".
  const h = albumEnv({ mb: p => (p.startsWith('/artist?') ? VA_ARTISTS : PORTISHEAD_RGS) })
  const r = await h.handlers['artist-releases'](null, { artist: 'Va Gustar Nobody' })
  assert.equal(r.ok, true)
  assert.equal(r.artistMbid, null, 'no artist is a better answer than the wrong one')
  assert.deepEqual(r.releases, [])
  assert.equal(h.mbCalls.length, 1, 'and the browse is never paid for')
  assert.deepEqual(Object.keys(h.store.map), [], 'nor is a wrong MBID cached for a month')
})

test('the artist search asks for five and compares the names', async () => {
  const h = albumEnv({ mb: p => (p.startsWith('/artist?') ? VA_ARTISTS : PORTISHEAD_RGS) })
  await h.handlers['artist-releases'](null, { artist: 'No Te Va Gustar' })
  assert.ok(h.mbCalls[0].includes('limit=5'), 'artists[0] is not a shortlist')
})

// ── the discography is paged, or the count is not stated ─────────────────────

test('one page of 50 really would have said 24 where the truth is 42', () => {
  // The premise, straight off the wire: Paul McCartney's type=album browse
  // reports 181 release groups. studioAlbums on the fifty a single page
  // returned finds 24 studio albums; on all 181 it finds 42.
  assert.equal(MCCARTNEY_50['release-group-count'], 181)
  assert.equal(MCCARTNEY_50['release-groups'].length, 50)
  assert.equal(peerEnrich.studioAlbums(MCCARTNEY_50).length, 24)
  const all = { 'release-groups': MCCARTNEY_P1['release-groups'].concat(MCCARTNEY_P2['release-groups']) }
  assert.equal(all['release-groups'].length, 181)
  assert.equal(peerEnrich.studioAlbums(all).length, 42)
})

test('artist-releases reads every page before it hands back a count', async () => {
  const pages = []
  const h = albumEnv({
    mb: p => { pages.push(p); return p.includes('offset=0') ? MCCARTNEY_P1 : MCCARTNEY_P2 },
  })
  const r = await h.handlers['artist-releases'](null, { artistMbid: 'MACCA', artist: 'Paul McCartney' })
  assert.equal(r.ok, true)
  assert.equal(r.complete, true)
  assert.equal(r.releases.length, 42, 'the number the panel is allowed to print')
  assert.equal(pages.length, 2, '181 groups at 100 a page')
  assert.ok(pages[0].includes('offset=0') && pages[1].includes('offset=100'))
  assert.equal(h.store.map['artistrgs:v2:MACCA'].complete, true)
})

test('a discography the paging could not finish says so instead of counting', async () => {
  // Five pages is the cap. An artist with more filed than that gets what was
  // read and NO total, because a total from a truncated list is the
  // 24-instead-of-42 bug with a bigger number on it.
  const page = { 'release-group-count': 9000, 'release-groups': MCCARTNEY_P1['release-groups'] }
  const h = albumEnv({ mb: () => page })
  const r = await h.handlers['artist-releases'](null, { artistMbid: 'PROLIFIC' })
  assert.equal(r.complete, false)
  assert.equal(h.mbCalls.length, 5, 'and it stops rather than walking 9,000 groups')
})

test('a browse that answers in one page still costs exactly one request', async () => {
  const h = albumEnv({ mb: () => PORTISHEAD_RGS })
  const r = await h.handlers['artist-releases'](null, { artistMbid: 'MBID' })
  assert.equal(r.complete, true)
  assert.equal(r.releases.length, 3)
  assert.equal(h.mbCalls.length, 1)
})

// ── discogs-album ────────────────────────────────────────────────────────────

test('discogs-album with NO token makes its calls and fills the panel', async () => {
  // This replaces the old "never calls out without a token" assertion. Both
  // endpoints answer to the User-Agent alone — verified live, HTTP 200 with
  // x-discogs-ratelimit 25 against 60 signed in — and the star row a token was
  // supposed to buy does not exist on a Discogs master.
  const store = fakeStore()
  const calls = []
  const handler = liftDiscogsHandler({
    peerEnrich,
    _enrichGet: store._enrichGet,
    _enrichSet: store._enrichSet,
    _discogsRedact: s => String(s || ''),
    _discogsGetJson: async (p, token) => {
      calls.push({ p, token })
      return p.startsWith('/database/search') ? DISCOGS_SEARCH : DISCOGS_MASTER
    },
    store: { get: () => '' },
  })
  const r = await handler(null, { artist: 'Portishead', album: 'Dummy' })
  assert.equal(r.ok, true)
  assert.equal(r.tokenless, true)
  assert.equal(calls.length, 2, 'the search and the master lookup both happen')
  assert.equal(calls[0].token, '', 'and no credential goes on the wire')
  assert.equal(r.year, 1994)
  assert.deepEqual(r.genres, ['Electronic'])
  assert.deepEqual(r.styles, ['Trip Hop'])
  assert.ok(r.notes.startsWith('Winner of the 1995 Mercury Music Prize.'))
  assert.ok(r.url.includes('/master/5542'))
  assert.ok('discogs:v2:portishead::dummy' in store.map,
    'v2 — the 18 entries already holding the narrow shape must not be read as the wide one')
})

test('discogs-album says the rate ceiling in words he can act on', async () => {
  const store = fakeStore()
  const handler = liftDiscogsHandler({
    peerEnrich,
    _enrichGet: store._enrichGet,
    _enrichSet: store._enrichSet,
    _discogsRedact: s => String(s || ''),
    _discogsGetJson: async () => { throw new Error('HTTP 429 Too Many Requests') },
    store: { get: () => '' },
  })
  const r = await handler(null, { artist: 'Portishead', album: 'Dummy' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'Discogs is busy right now. Try again in a minute.')
  assert.deepEqual(Object.keys(store.map), [], 'a failure is never cached')
})

test('discogs-album marks a plain miss as an ANSWER, not as a failure', async () => {
  // The panel will not say "No genre tags on this record." until both lookups
  // have answered, and "Discogs has no entry" IS an answer. Without this flag
  // it is indistinguishable from the lookup falling over.
  const store = fakeStore()
  const handler = liftDiscogsHandler({
    peerEnrich,
    _enrichGet: store._enrichGet,
    _enrichSet: store._enrichSet,
    _discogsRedact: s => String(s || ''),
    _discogsGetJson: async () => ({ results: [] }),
    store: { get: () => '' },
  })
  const r = await handler(null, { artist: 'Portishead', album: 'Dummy' })
  assert.equal(r.ok, false)
  assert.equal(r.found, false)
  assert.equal(r.reason, 'Discogs has no entry for this album.')
})

test('the tokenless Discogs pacing matches the tokenless ceiling', () => {
  // 60 a minute is the AUTHENTICATED ceiling and this call carries no token:
  // the live x-discogs-ratelimit header reads 25 without one. One a second was
  // pacing straight through a limit 2.4 seconds wide.
  const src = MAIN.slice(MAIN.indexOf('const DISCOGS_GAP_TOKEN_MS'),
    MAIN.indexOf('return JSON.parse(String(raw))'))
  assert.match(src, /DISCOGS_GAP_ANON_MS\s*=\s*2400/)
  assert.match(src, /DISCOGS_GAP_TOKEN_MS\s*=\s*1000/)
  assert.match(src, /const gap = token \? DISCOGS_GAP_TOKEN_MS : DISCOGS_GAP_ANON_MS/)
  assert.match(src, /const wait = gap - \(Date\.now\(\) - _discogsLastAt\)/)
})

test('the MusicBrainz User-Agent points at THIS app', () => {
  // It advertised github.com/aaddrick/claude-desktop-debian — a different
  // project entirely, which is where MusicBrainz would have sent any complaint
  // about this app's traffic.
  const src = MAIN.slice(MAIN.indexOf('const MB_UA'), MAIN.indexOf('const MB_MIN_INTERVAL_MS'))
  assert.ok(!/claude-desktop/.test(src), 'no other project in the User-Agent')
  assert.match(src, /pkg\.homepage/)
  assert.match(src, /PapaAudio\/\$\{version\} \( \$\{home\} \)/)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.ok(/^https:\/\//.test(pkg.homepage), 'and package.json has somewhere to point at')
})

test('discogs-album rejects a master that is a different record', async () => {
  const store = fakeStore()
  const handler = liftDiscogsHandler({
    peerEnrich,
    _enrichGet: store._enrichGet,
    _enrichSet: store._enrichSet,
    _discogsRedact: s => String(s || ''),
    _discogsGetJson: async () => fixture('discogs-search-tubular-bells.json'),
    store: { get: () => '' },
  })
  const r = await handler(null, { artist: 'Mike Oldfield', album: 'Ommadawn' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'Discogs has no entry for this album.')
})

// ── wiring ───────────────────────────────────────────────────────────────────

test('both new channels exist in main, are exposed in preload, and are deadlined', () => {
  for (const ch of ['album-info', 'artist-releases']) {
    assert.ok(MAIN.includes(`ipcMain.handle('${ch}'`), ch + ' handler')
    assert.ok(PRELOAD.includes(`invoke('${ch}'`), ch + ' exposed on the bridge')
    // Without a deadline the wrapper races the handler against the 60 s
    // default and REJECTS the invoke, which becomes a permanent "Looking up…".
    const table = MAIN.slice(MAIN.indexOf('const IPC_TIMEOUT_OVERRIDES'), MAIN.indexOf('\n}', MAIN.indexOf('const IPC_TIMEOUT_OVERRIDES')))
    assert.match(table, new RegExp(`'${ch}':\\s*\\d+`), ch + ' has an IPC deadline')
  }
  assert.ok(PRELOAD.includes('albumInfo:') && PRELOAD.includes('artistReleases:'))
})

test('the artist-info lookup no longer bypasses the MusicBrainz throttle', () => {
  // It used to hit MusicBrainz twice per uncached artist with a bare fetch and
  // no spacing at all, which meant the 1 req/s the User-Agent promises was not
  // actually being kept.
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('artist-info'"))
  const at = body.indexOf('artistInfo.resolve(')
  const block = body.slice(at, at + 600)
  assert.match(block, /mb:\s*url\s*=>\s*_mbThrottle\(/)
})
