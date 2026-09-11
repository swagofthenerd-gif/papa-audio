'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  qualityRank,
  isMultichannel,
  rankStreams,
  resolveStream,
} = require('../providers/index')

function entry(overrides) {
  return Object.assign(
    {
      kind: 'http',
      url: null,
      magnet: null,
      infoHash: null,
      fileIndex: null,
      source: 'test',
      quality: null,
      label: null,
      audioLayout: null,
      sub: null,
      dub: null,
    },
    overrides
  )
}

test('qualityRank maps quality strings to numbers', () => {
  assert.strictEqual(qualityRank('2160p'), 4)
  assert.strictEqual(qualityRank('1080p'), 3)
  assert.strictEqual(qualityRank('720p'), 2)
  assert.strictEqual(qualityRank('480p'), 1)
  assert.strictEqual(qualityRank('360p'), 0)
  assert.strictEqual(qualityRank(null), 0)
  assert.strictEqual(qualityRank(undefined), 0)
})

test('isMultichannel is true only for 5.1', () => {
  assert.strictEqual(isMultichannel('5.1'), true)
  assert.strictEqual(isMultichannel('2.0'), false)
  assert.strictEqual(isMultichannel(null), false)
  assert.strictEqual(isMultichannel(undefined), false)
})

test('rankStreams: surround-aware 1080p 5.1 beats 2160p stereo when preferSurround', () => {
  const a = entry({ quality: '1080p', audioLayout: '5.1', source: 'a' })
  const b = entry({ quality: '2160p', audioLayout: null, source: 'b' })
  const ranked = rankStreams([b, a], { preferSurround: true })
  assert.strictEqual(ranked[0], a)
  assert.strictEqual(ranked[1], b)
})

test('rankStreams: 2160p beats 1080p 5.1 when preferSurround is false', () => {
  const a = entry({ quality: '1080p', audioLayout: '5.1', source: 'a' })
  const b = entry({ quality: '2160p', audioLayout: null, source: 'b' })
  const ranked = rankStreams([a, b], { preferSurround: false })
  assert.strictEqual(ranked[0], b)
  assert.strictEqual(ranked[1], a)
})

test('rankStreams: same quality, 5.1 above stereo', () => {
  const stereo = entry({ quality: '1080p', audioLayout: '2.0', source: 's' })
  const surround = entry({ quality: '1080p', audioLayout: '5.1', source: 'x' })
  const ranked = rankStreams([stereo, surround])
  assert.strictEqual(ranked[0], surround)
  assert.strictEqual(ranked[1], stereo)
})

test('rankStreams sorts by score, then multichannel, then quality, then source', () => {
  const e1 = entry({ quality: '720p', audioLayout: null, source: 'c' })
  const e2 = entry({ quality: '720p', audioLayout: '5.1', source: 'b' })
  const e3 = entry({ quality: '1080p', audioLayout: null, source: 'a' })
  const e4 = entry({ quality: '1080p', audioLayout: '5.1', source: 'a' })
  const ranked = rankStreams([e1, e2, e3, e4])
  // e4 (1080 5.1, score 4) > e2 (720 5.1, score 3, multichannel) >
  // e3 (1080, score 3, stereo) > e1 (720, score 2)
  assert.deepStrictEqual(
    ranked.map(r => r.source + r.quality + (r.audioLayout || '')),
    ['a1080p5.1', 'b720p5.1', 'a1080p', 'c720p']
  )
})

// Audit #5: aggregator seeder counts (Knaben, SolidTorrents) are unreliable — a
// live pick advertising 370 seeders delivered one real peer. Their seeder signal
// is discounted for ranking so a fictional count cannot leapfrog a genuine
// first-party source of equal quality. The displayed number is never altered.
test('rankStreams discounts aggregator seeders as a tiebreak, not first-party ones', () => {
  // Same quality/audio, so the seeder tiebreak decides. TPB reports 100, the
  // aggregator reports 150 — but scaled by 0.5 that is 75, so TPB should win.
  const tpb = entry({ quality: '1080p', audioLayout: null, source: 'TPB', seeds: 100 })
  const agg = entry({ quality: '1080p', audioLayout: null, source: 'SolidTorrents', seeds: 150 })
  const ranked = rankStreams([agg, tpb])
  assert.strictEqual(ranked[0].source, 'TPB', 'first-party 100 beats aggregator 150 (→75)')
  // The displayed seeder count is untouched by the ranking discount.
  assert.strictEqual(ranked.find(r => r.source === 'SolidTorrents').seeds, 150)

  // A big enough aggregator lead still wins: 300 → 150 > 100.
  const aggBig = entry({ quality: '1080p', audioLayout: null, source: 'Knaben', seeds: 300 })
  const ranked2 = rankStreams([tpb, aggBig])
  assert.strictEqual(ranked2[0].source, 'Knaben', 'aggregator 300 (→150) still beats first-party 100')
})

test('rankStreams does not mutate the input array', () => {
  const input = [
    entry({ quality: '480p', audioLayout: null, source: 'x' }),
    entry({ quality: '1080p', audioLayout: '5.1', source: 'y' }),
  ]
  const snapshot = input.slice()
  rankStreams(input)
  assert.deepStrictEqual(input, snapshot)
})

test('resolveStream returns fulfilled results and skips rejected backends', async () => {
  const entryA = entry({ quality: '1080p', source: 'backend-a' })
  const backends = [
    async () => [entryA],
    async () => {
      throw new Error('backend down')
    },
  ]
  const result = await resolveStream({ type: 'movie', title: 'Inception' }, backends)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0], entryA)
})

test('resolveStream de-duplicates identical (kind, url) across backends', async () => {
  const shared = entry({ quality: '1080p', url: 'https://cdn/x.mp4', source: 'dup' })
  const backends = [
    async () => [shared],
    async () => [{ ...shared }],
  ]
  const result = await resolveStream({ type: 'movie' }, backends)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0], shared)
})

test('resolveStream de-duplicates by magnet when url is absent', async () => {
  const torrent = entry({
    kind: 'torrent',
    url: null,
    magnet: 'magnet:?xt=urn:btih:AAA',
    source: 'dup',
  })
  const backends = [
    async () => [torrent],
    async () => [{ ...torrent }],
  ]
  const result = await resolveStream({ type: 'movie' }, backends)
  assert.strictEqual(result.length, 1)
})

test('resolveStream ranks results after flattening', async () => {
  const low = entry({ quality: '720p', audioLayout: null, source: 'a', url: 'https://cdn/low.mp4' })
  const high = entry({ quality: '1080p', audioLayout: '5.1', source: 'b', url: 'https://cdn/high.mp4' })
  const backends = [
    async () => [low],
    async () => [high],
  ]
  const result = await resolveStream({ type: 'movie' }, backends)
  assert.strictEqual(result[0], high)
  assert.strictEqual(result[1], low)
})

// ── Timeout, 7.1 and seed ordering ──────────────────────────────────────────
{
  const { resolveStream, rankStreams, isMultichannel } = require('../providers/index')

  // timeoutMs was accepted and then explicitly discarded, so one backend that
  // never settled hung the entire source lookup.
  test('a backend that never settles cannot hang the lookup', async () => {
    const hang = () => new Promise(() => {})
    const good = async () => [{ kind: 'torrent', magnet: 'm1', quality: '1080p', source: 'A', seeds: 5 }]
    const started = Date.now()
    const out = await resolveStream({}, [hang, good], { timeoutMs: 150 })
    assert.strictEqual(out.length, 1, 'the healthy backend still contributes')
    assert.ok(Date.now() - started < 2000, 'must settle on the timeout, not wait forever')
  })

  test('a backend that throws is skipped, not fatal', async () => {
    const boom = async () => { throw new Error('indexer down') }
    const good = async () => [{ kind: 'torrent', magnet: 'm1', quality: '720p', source: 'A' }]
    const out = await resolveStream({}, [boom, good], { timeoutMs: 500 })
    assert.strictEqual(out.length, 1)
  })

  // 7.1 releases used to rank below stereo of the same resolution, because only
  // the literal string '5.1' counted as multichannel.
  test('7.1 counts as multichannel', () => {
    assert.strictEqual(isMultichannel('7.1'), true)
    assert.strictEqual(isMultichannel('5.1'), true)
    assert.strictEqual(isMultichannel('stereo'), false)
    assert.strictEqual(isMultichannel(null), false)
  })

  test('a 7.1 source outranks a stereo one at the same resolution', () => {
    const ordered = rankStreams([
      { quality: '1080p', audioLayout: null, source: 'B', seeds: 1 },
      { quality: '1080p', audioLayout: '7.1', source: 'A', seeds: 1 },
    ])
    assert.strictEqual(ordered[0].audioLayout, '7.1')
  })

  // Seeds decide whether a torrent plays at all, so they must beat the
  // alphabetical source fallback.
  test('seed count breaks ties before the source name does', () => {
    const ordered = rankStreams([
      { quality: '1080p', audioLayout: '5.1', source: 'AAA', seeds: 2 },
      { quality: '1080p', audioLayout: '5.1', source: 'ZZZ', seeds: 900 },
    ])
    assert.strictEqual(ordered[0].source, 'ZZZ')
  })

  test('entries with no seed count still sort deterministically by source', () => {
    const ordered = rankStreams([
      { quality: '720p', audioLayout: null, source: 'ZZZ' },
      { quality: '720p', audioLayout: null, source: 'AAA' },
    ])
    assert.deepStrictEqual(ordered.map(e => e.source), ['AAA', 'ZZZ'])
  })

  test('resolveStream tolerates a null backend list', async () => {
    assert.deepStrictEqual(await resolveStream({}, null, { timeoutMs: 50 }), [])
  })
}

// The same torrent from two indexers carries different tracker lists, so the
// magnet strings differ while the content is identical.
test('the same torrent from two indexers is offered once', async () => {
  const { resolveStream } = require('../providers/index')
  const a = async () => [{ kind: 'torrent', infoHash: 'ABC123', magnet: 'magnet:?xt=urn:btih:ABC123&tr=one', quality: '1080p', source: 'YTS', seeds: 10 }]
  const b = async () => [{ kind: 'torrent', infoHash: 'abc123', magnet: 'magnet:?xt=urn:btih:abc123&tr=two', quality: '1080p', source: 'TPB', seeds: 10 }]
  const out = await resolveStream({}, [a, b], { timeoutMs: 500 })
  assert.strictEqual(out.length, 1, 'de-duplication must key on the info hash, not the magnet string')
})

test('a cam rip never outranks a real encode, whatever its resolution or seeds', () => {
  const { rankStreams } = require('../providers/index')
  const out = rankStreams([
    { quality: '2160p', audioLayout: '5.1', source: 'TPB', seeds: 9999, lowQuality: true },
    { quality: '480p', audioLayout: null, source: 'YTS', seeds: 1 },
  ])
  assert.strictEqual(out[0].lowQuality, undefined)
  assert.strictEqual(out[1].lowQuality, true)
})

// --- source-health memory (checklist #39) --------------------------------
// A session-level record of how each source has been behaving, so the router
// consults healthy sources first — without ever dropping a source, because
// coverage at the tail is the whole reason for running many indexers.
const {
  orderBackendsByHealth, recordSourceResult, _resetSourceHealth,
} = require('../providers/index')

test.beforeEach(() => _resetSourceHealth())

const named = (name, fn) => Object.assign(fn, { sourceName: name })

test('orderBackendsByHealth keeps caller order when all sources are healthy', () => {
  const a = named('A', async () => [])
  const b = named('B', async () => [])
  const c = named('C', async () => [])
  const order = orderBackendsByHealth([a, b, c]).map(x => x.name)
  assert.deepStrictEqual(order, ['A', 'B', 'C'])
})

test('a failing source is demoted below a healthy one but never dropped', () => {
  recordSourceResult('flaky', false)
  recordSourceResult('flaky', false)
  const good = named('good', async () => [])
  const flaky = named('flaky', async () => [])
  const ordered = orderBackendsByHealth([flaky, good])
  assert.deepStrictEqual(ordered.map(x => x.name), ['good', 'flaky'])
  assert.strictEqual(ordered.length, 2, 'the demoted source is still present')
})

test('a result clears the streak so a recovered source climbs back up', () => {
  recordSourceResult('src', false)
  recordSourceResult('src', false)
  recordSourceResult('src', true) // recovered
  const src = named('src', async () => [])
  const other = named('other', async () => [])
  // src is back to streak 0, so caller order (src first) stands.
  assert.deepStrictEqual(orderBackendsByHealth([src, other]).map(x => x.name), ['src', 'other'])
})

test('resolveStream records health from each backend and re-orders next time', async () => {
  const dead = named('dead', async () => { throw new Error('down') })
  const alive = named('alive', async () => [
    { kind: 'torrent', infoHash: 'F'.repeat(40), quality: '1080p', source: 'alive', seeds: 5 },
  ])
  // First run: dead throws, alive answers. Order is caller order (dead first).
  const first = await resolveStream({}, [dead, alive], { timeoutMs: 500 })
  assert.strictEqual(first.length, 1)
  // Health now knows dead failed and alive worked, so the next ordering leads
  // with alive.
  assert.deepStrictEqual(orderBackendsByHealth([dead, alive]).map(x => x.name), ['alive', 'dead'])
})

test('an empty (but non-throwing) backend counts as unhealthy', async () => {
  const empty = named('empty', async () => [])
  const full = named('full', async () => [
    { kind: 'torrent', infoHash: 'A'.repeat(40), quality: '720p', source: 'full', seeds: 1 },
  ])
  await resolveStream({}, [empty, full], { timeoutMs: 500 })
  // empty produced nothing → demoted; full produced a result → healthy.
  assert.deepStrictEqual(orderBackendsByHealth([empty, full]).map(x => x.name), ['full', 'empty'])
})

test('resolveStream still returns every source’s results despite health ordering', async () => {
  const a = named('a', async () => [
    { kind: 'torrent', infoHash: '1'.repeat(40), quality: '1080p', source: 'a', seeds: 3 },
  ])
  const b = named('b', async () => [
    { kind: 'torrent', infoHash: '2'.repeat(40), quality: '720p', source: 'b', seeds: 3 },
  ])
  // Pre-demote a so b leads, then confirm a's result is still merged in.
  recordSourceResult('a', false)
  const out = await resolveStream({}, [a, b], { timeoutMs: 500 })
  const hashes = out.map(e => e.infoHash).sort()
  assert.deepStrictEqual(hashes, ['1'.repeat(40), '2'.repeat(40)])
})

test('a backend with no discernible name never crashes the ordering', () => {
  const anon = async () => []
  const ordered = orderBackendsByHealth([anon])
  assert.strictEqual(ordered.length, 1)
})

// ── Dub-aware ranking ────────────────────────────────────────────────────────
// Providers (nyaa) order their own slice dub-first, but the merged ranking was
// dub-blind — dubs seed lower than subs, so the Dub toggle appeared to do
// nothing to the final order (found live). A requested dub now leads the whole
// merged list, beneath only the dead-magnet and cam-rip demotions.
test('rankStreams: a requested dub beats a better-seeded, higher-quality sub', () => {
  const sub = entry({ quality: '1080p', seeds: 500, sub: true, dub: false, source: 'a' })
  const dub = entry({ quality: '720p', seeds: 12, sub: false, dub: true, source: 'b' })
  const ranked = rankStreams([sub, dub], { preferDub: true })
  assert.strictEqual(ranked[0], dub)
  assert.strictEqual(ranked[1], sub)
})

test('rankStreams: without preferDub the order is unchanged by dub flags', () => {
  const sub = entry({ quality: '1080p', seeds: 500, sub: true, dub: false, source: 'a' })
  const dub = entry({ quality: '720p', seeds: 12, sub: false, dub: true, source: 'b' })
  const ranked = rankStreams([sub, dub], {})
  assert.strictEqual(ranked[0], sub)
})

test('rankStreams: a dead dub still sinks beneath a live sub even when dubs are preferred', () => {
  const sub = entry({ quality: '1080p', seeds: 500, sub: true, dub: false, source: 'a', kind: 'torrent', infoHash: 'live1' })
  const dub = entry({ quality: '1080p', seeds: 400, sub: false, dub: true, source: 'b', kind: 'torrent', infoHash: 'dead1' })
  const ranked = rankStreams([dub, sub], { preferDub: true, isDead: h => h === 'dead1' })
  assert.strictEqual(ranked[0].infoHash, 'live1')
  assert.strictEqual(ranked[1].deadHint, true)
})
