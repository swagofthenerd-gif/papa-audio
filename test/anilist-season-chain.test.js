'use strict'
// The season-chain hardening: a failed hop is retried once after a backoff
// (429s honour Retry-After), and a walk that still loses a hop says so with
// `truncated: true` instead of passing off a partial chain as complete.
const test = require('node:test')
const assert = require('node:assert')
const { createAnilistCatalog, _retryDelayMs } = require('../catalog/anilist')

const node = (id, title, year, over = {}) => Object.assign({
  id, type: 'ANIME', format: 'TV', status: 'FINISHED', seasonYear: year,
  episodes: 12, title: { romaji: title }, coverImage: { large: null },
}, over)

// graph: { id: { relations: [[type, node]], self: {...} } }. `failures` maps
// an id to how many times its relations request should fail first, so a
// retry can be told apart from a fresh request.
function chainFetch(graph, { failures = {}, failWith = {} } = {}) {
  const relationCalls = []
  const fetchFn = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const id = body.variables.id
    const entry = graph[id] || {}
    if (/relations \{/.test(body.query)) {
      relationCalls.push(id)
      if ((failures[id] || 0) > 0) {
        failures[id]--
        return failWith[id] || { ok: false, status: 500 }
      }
      return { ok: true, json: async () => ({ data: { Media: { id, relations: {
        edges: (entry.relations || []).map(([relationType, n]) => ({ relationType, node: n })),
      } } } }) }
    }
    return { ok: true, json: async () => ({ data: { Media: entry.self || null } }) }
  }
  fetchFn.relationCalls = relationCalls
  return fetchFn
}

const TWO_SEASONS = {
  1: { self: node(1, 'S1', 2015), relations: [['SEQUEL', node(2, 'S2', 2018)]] },
  2: { self: node(2, 'S2', 2018), relations: [['PREQUEL', node(1, 'S1', 2015)]] },
}

test('a healthy walk reports truncated: false', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(TWO_SEASONS), retryDelayMs: 1 })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'])
  assert.strictEqual(out.truncated, false)
})

test('a failed hop is retried once and a transient blip stays invisible', async () => {
  // The relations request for id 1 fails once, then works.
  const fetchFn = chainFetch(TWO_SEASONS, { failures: { 1: 1 } })
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 1 })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'],
    'the retry must rescue the hop, not truncate the chain')
  assert.strictEqual(out.truncated, false)
  assert.ok(fetchFn.relationCalls.filter(id => id === 1).length >= 2, 'the hop was retried')
})

test('a hop that fails twice truncates the walk and says so', async () => {
  // Every relations request for id 2 fails, so the sequel walk past S2 is
  // impossible even with the retry.
  const graph = {
    1: { self: node(1, 'S1', 2015), relations: [['SEQUEL', node(2, 'S2', 2018)]] },
    2: { self: node(2, 'S2', 2018), relations: [['SEQUEL', node(3, 'S3', 2020)]] },
    3: { self: node(3, 'S3', 2020), relations: [] },
  }
  const cat = createAnilistCatalog({
    fetchFn: chainFetch(graph, { failures: { 2: 99 } }),
    retryDelayMs: 1,
  })
  const out = await cat.seasonChain(1)
  assert.strictEqual(out.truncated, true, 'a lost hop must be flagged')
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'],
    'what was already walked is kept')
})

test('a start entry that never loads flags the chain truncated', async () => {
  const cat = createAnilistCatalog({
    fetchFn: async () => ({ ok: false, status: 500 }),
    retryDelayMs: 1,
  })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons, [])
  assert.strictEqual(out.truncated, true)
})

test('a missing id keeps the pre-walk shape: no truncated key at all', async () => {
  const cat = createAnilistCatalog({ fetchFn: async () => { throw new Error('never called') } })
  assert.deepStrictEqual(await cat.seasonChain(null), { seasons: [], related: [] })
})

// The backoff policy is pure so it can be tested without timers.
test('the retry delay is the base, except a 429 honours Retry-After up to 3x', () => {
  assert.strictEqual(_retryDelayMs(new Error('boom'), 1000), 1000)
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 500 }), 1000), 1000)
  // 429 with a sane Retry-After: wait what the server asked.
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 429, retryAfter: '2' }), 1000), 2000)
  // 429 asking for more than 3s: capped, a stream lookup cannot wait a minute.
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 429, retryAfter: '60' }), 1000), 3000)
  // 429 with no header falls back to the base delay.
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 429 }), 1000), 1000)
})

test('the 429 Retry-After header rides along on the thrown _post error', async () => {
  // The browse/detail entry points now degrade quietly (they no longer reject),
  // so the internal `_post` — which season-chain's retry relies on to throw — is
  // exercised through a season-chain hop instead. A relations hop that answers
  // 429 must produce an Error carrying status:429 and the Retry-After header, or
  // _retryDelayMs cannot honour the backoff. The hop then succeeds, so the retry
  // observably rescued the walk.
  const fetchFn = chainFetch(TWO_SEASONS, {
    failures: { 1: 1 },
    failWith: {
      1: {
        ok: false,
        status: 429,
        headers: { get: name => (name.toLowerCase() === 'retry-after' ? '2' : null) },
      },
    },
  })
  // With base 50ms, a 429 carrying Retry-After:2 resolves to min(2000, 150) =
  // 150ms; a 429 with NO header (or a non-429) would fall back to the 50ms base.
  // Measuring that the retry waited ~150ms proves _post attached BOTH status:429
  // and retryAfter:'2' to the thrown error — the plumbing _retryDelayMs needs.
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 50 })
  const started = Date.now()
  const out = await cat.seasonChain(1)
  const elapsed = Date.now() - started
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'],
    'the 429 hop was retried and the walk completed')
  assert.strictEqual(out.truncated, false)
  assert.ok(fetchFn.relationCalls.filter(id => id === 1).length >= 2,
    'the 429 hop was retried, which only happens if _post threw with the 429')
  assert.ok(elapsed >= 140,
    `the retry honoured Retry-After (waited ${elapsed}ms, expected ~150ms) — ` +
    'only possible if the thrown error carried status:429 and retryAfter')
})

// A card from the Jikan fallback carries a "mal-<id>" key and no AniList id;
// the chain resolves it by MyAnimeList id (else by title) and walks from
// there. Everything off the spine is kept under `related`, relation named.
test('a mal- id is resolved through idMal, and side stories come back as related with their relation', async () => {
  const graph = {
    1: { self: node(1, 'S1', 2011), relations: [['SEQUEL', node(2, 'S2', 2018)], ['SIDE_STORY', node(3, 'Film', 2013, { format: 'MOVIE' })]] },
    2: { self: node(2, 'S2', 2018), relations: [['PREQUEL', node(1, 'S1', 2011)]] },
  }
  const calls = []
  const fetchFn = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push(body.query.includes('idMal:') ? 'byMal:' + body.variables.idMal : (/relations \{/.test(body.query) ? 'rel:' + body.variables.id : 'byId:' + body.variables.id))
    if (body.query.includes('idMal:')) return { ok: true, json: async () => ({ data: { Media: body.variables.idMal === 9253 ? node(1, 'S1', 2011) : null } }) }
    const id = body.variables.id
    const entry = graph[id] || {}
    if (/relations \{/.test(body.query)) return { ok: true, json: async () => ({ data: { Media: { id, relations: { edges: (entry.relations || []).map(([relationType, n]) => ({ relationType, node: n })) } } } }) }
    return { ok: true, json: async () => ({ data: { Media: entry.self || null } }) }
  }
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 1 })
  const out = await cat.seasonChain('mal-9253')
  assert.equal(calls[0], 'byMal:9253', 'resolved by MAL id first')
  assert.deepStrictEqual(out.seasons.map(s => s.id), [1, 2])
  assert.equal(out.related.length, 1)
  assert.equal(out.related[0].relation, 'SIDE_STORY')
  assert.equal(out.related[0].format, 'MOVIE')
  const viaOpt = await cat.seasonChain('kitsu-77', { idMal: 9253 })
  assert.deepStrictEqual(viaOpt.seasons.map(s => s.id), [1, 2], 'an explicit idMal resolves a kitsu card too')
  const none = await cat.seasonChain('kitsu-77')
  assert.deepStrictEqual(none, { seasons: [], related: [] }, 'nothing to resolve by means no walk')
})

// ── Spin-offs must not inherit the parent series' numbering ─────────────────
// "man i am watching sword art online and its not even loading the correct
// seasons or episodes" (2026-09-16).
//
// PARENT was in SPINE as well as EXPAND, which made the walk asymmetric.
// Walking DOWN from Sword Art Online correctly demoted Gun Gale Online to
// `related` via SPIN_OFF. But starting AT Gun Gale Online II and walking UP
// through PREQUEL -> PARENT pulled the whole SAO main line in as SEASONS. GGO
// II then sat at index 6 of a seven-season array, and main.js's
// _animeAbsoluteEpisode summed 25+24+12+24+12+11 to call its first episode
// "absolute 109" — of a twelve-episode show. Measured in the running app.
//
// Worse than a missing number, because providers/nyaa.js both QUERIES the
// absolute and ACCEPTS a release numbered with it as a match for the episode
// asked for. Fixtures rather than live ids: the real walk rate-limits, and a
// truncated live chain reads as a passing test.

// The real shape, reduced: a spin-off's second season, its own first season,
// and the parent franchise reached through PARENT.
const SPINOFF_GRAPH = {
  // GGO II — the page being opened.
  22: { self: node(22, 'Spin-off II', 2024), relations: [['PREQUEL', node(21, 'Spin-off', 2018)]] },
  // GGO — reached by PREQUEL, so it IS a season of the spin-off.
  21: { self: node(21, 'Spin-off', 2018), relations: [
    ['SEQUEL', node(22, 'Spin-off II', 2024)],
    // ...and the parent franchise, reached by PARENT.
    ['PARENT', node(12, 'Main II', 2014, { episodes: 24 })],
  ] },
  12: { self: node(12, 'Main II', 2014, { episodes: 24 }), relations: [
    ['PREQUEL', node(11, 'Main', 2012, { episodes: 25 })],
    ['SEQUEL', node(13, 'Main III', 2018, { episodes: 24 })],
  ] },
  11: { self: node(11, 'Main', 2012, { episodes: 25 }), relations: [['SEQUEL', node(12, 'Main II', 2014, { episodes: 24 })]] },
  13: { self: node(13, 'Main III', 2018, { episodes: 24 }), relations: [['PREQUEL', node(12, 'Main II', 2014, { episodes: 24 })]] },
}

// main.js's _animeAbsoluteEpisode, replayed against a chain. Kept in step with
// main.js:_animeAbsoluteEpisode deliberately — this is the consumer whose
// answer the `run` flag exists to protect.
function absoluteEpisode(chain, id, episode) {
  const tv = (chain.seasons || []).filter(s => s && /^TV/i.test(String(s.format || '')) && s.run !== false)
  const idx = tv.findIndex(s => String(s.id) === String(id))
  if (idx <= 0) return null
  let prior = 0
  for (let i = 0; i < idx; i++) { const n = Number(tv[i].episodeCount); if (!n || n < 1) return null; prior += n }
  const own = Number(tv[idx] && tv[idx].episodeCount)
  const ep = Number(episode) || 0
  if (own && ep > own) return null
  return prior + ep
}

test('a spin-off\'s seasons are its own — the parent franchise is related, not a season', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(SPINOFF_GRAPH), retryDelayMs: 1 })
  const chain = await cat.seasonChain(22)
  assert.deepStrictEqual(Array.from(chain.seasons).map(s => s.id), [21, 22],
    'exactly the spin-off\'s two seasons — not the parent franchise as well')
  // The parent is still DISCOVERED and still offered, just not counted.
  const relatedIds = Array.from(chain.related).map(r => r.id)
  for (const id of [11, 12, 13]) {
    assert.ok(relatedIds.includes(id), 'the parent series stays reachable under Related, id ' + id)
  }
})

test('a spin-off\'s episode 1 is not numbered from the parent franchise', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(SPINOFF_GRAPH), retryDelayMs: 1 })
  const chain = await cat.seasonChain(22)
  // 12 episodes of the spin-off's own first season, then this one.
  assert.strictEqual(absoluteEpisode(chain, 22, 1), 13, 'was 109 — the whole parent franchise summed in')
  // An episode beyond this entry's own length is not an answerable question;
  // a confident wrong absolute is worse than none, because nyaa.js accepts it.
  assert.strictEqual(absoluteEpisode(chain, 22, 99), null)
})

test('a spin-off\'s FIRST season reports no absolute — its own numbers already are', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(SPINOFF_GRAPH), retryDelayMs: 1 })
  const chain = await cat.seasonChain(21)
  assert.strictEqual(absoluteEpisode(chain, 21, 1), null, 'was 50')
})

// The other half, and the reason ALTERNATIVE stays in SPINE while PARENT
// leaves it. AniList links Steins;Gate to Steins;Gate 0 only through an
// ALTERNATIVE edge, so dropping ALTERNATIVE "on the same argument" would lose
// the second series from the season list entirely — which is the regression
// the comment above SPINE was written for. But an ALTERNATIVE sibling is
// released numbered from 1, so it must not inherit the numbering either.
const ALTERNATIVE_GRAPH = {
  1: { self: node(1, 'Original', 2011, { episodes: 24 }), relations: [['ALTERNATIVE', node(2, 'Alternative', 2018, { episodes: 23 })]] },
  2: { self: node(2, 'Alternative', 2018, { episodes: 23 }), relations: [['ALTERNATIVE', node(1, 'Original', 2011, { episodes: 24 })]] },
}

test('an ALTERNATIVE sibling stays in the season list but keeps its own numbering', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(ALTERNATIVE_GRAPH), retryDelayMs: 1 })
  const chain = await cat.seasonChain(2)
  assert.deepStrictEqual(Array.from(chain.seasons).map(s => s.id), [1, 2],
    'both belong in the season list — this is why ALTERNATIVE stays in SPINE')
  assert.strictEqual(absoluteEpisode(chain, 2, 1), null,
    'but it is released numbered from 1, so it must not be summed onto the original')
})

// The case the whole mechanism exists to serve, which must keep working.
const CONTINUATION_GRAPH = {
  1: { self: node(1, 'S1', 2013, { episodes: 25 }), relations: [['SEQUEL', node(2, 'S2', 2017, { episodes: 12 })]] },
  2: { self: node(2, 'S2', 2017, { episodes: 12 }), relations: [
    ['PREQUEL', node(1, 'S1', 2013, { episodes: 25 })],
    ['SEQUEL', node(3, 'S3', 2018, { episodes: 22 })],
  ] },
  3: { self: node(3, 'S3', 2018, { episodes: 22 }), relations: [['PREQUEL', node(2, 'S2', 2017, { episodes: 12 })]] },
}

test('a genuine continuation still numbers absolutely across its seasons', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(CONTINUATION_GRAPH), retryDelayMs: 1 })
  const chain = await cat.seasonChain(3)
  assert.deepStrictEqual(Array.from(chain.seasons).map(s => s.id), [1, 2, 3])
  assert.strictEqual(absoluteEpisode(chain, 3, 1), 38, '25 + 12 + 1 — fansubs number this one 38')
  assert.strictEqual(absoluteEpisode(chain, 2, 1), 26)
  assert.strictEqual(absoluteEpisode(chain, 1, 1), null, 'a first season is already absolute')
})

// ── Resolving a card that carries no AniList id ─────────────────────────────
// A "mal-…"/"kitsu-…" card is resolved by MAL id, else by title. The title
// branch used to end `exact || list[0]` — AniList's top relevance hit, taken
// with no year check, no format check and no title check at all. For a
// franchise title that is a prefix of many entries the top hit is routinely
// the umbrella or first series, and that entry then became the START of the
// whole chain walk: the seasons rail and the absolute numbering both derived
// from a show nobody asked for.

function searchFetch(hits, { byMal = null, malThrows = false } = {}) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body)
    // Dispatch on the VARIABLES, not on the query text: MEDIA_SELECTION itself
    // contains the word idMal, so every query matches /idMal/ and a fake that
    // keys on that answers the search with the byMal response.
    if (body.variables.idMal != null) {
      if (malThrows) return { ok: false, status: 500 }
      return { ok: true, json: async () => ({ data: { Media: byMal } }) }
    }
    if (/Page\(/.test(body.query)) {
      return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, media: hits } } }) }
    }
    // byId / relations for whatever the walk does next.
    const id = body.variables.id
    if (/relations \{/.test(body.query)) {
      return { ok: true, json: async () => ({ data: { Media: { id, relations: { edges: [] } } } }) }
    }
    return { ok: true, json: async () => ({ data: { Media: node(id, 'Resolved', 2020) } }) }
  }
}

const HIT = (id, romaji, year, over = {}) => Object.assign({
  id, format: 'TV', seasonYear: year, episodes: 12, status: 'FINISHED',
  title: { romaji, english: romaji, native: romaji }, coverImage: { large: null },
}, over)

test('a MAL id resolves the card outright, and is not called fuzzy', async () => {
  const cat = createAnilistCatalog({ fetchFn: searchFetch([], { byMal: HIT(21127, 'Steins;Gate 0', 2018) }), retryDelayMs: 1 })
  const got = await cat._resolveStartId({ id: 'mal-30484', idMal: 30484, title: 'Steins;Gate 0', year: 2018 })
  assert.deepStrictEqual({ id: got.id, fuzzy: got.fuzzy }, { id: 21127, fuzzy: false })
})

test('a name in common resolves the card, across punctuation and spacing', async () => {
  const hits = [HIT(1, 'Some Other Show', 2019), HIT(2, 'Sword Art Online: Alicization', 2018)]
  const cat = createAnilistCatalog({ fetchFn: searchFetch(hits), retryDelayMs: 1 })
  const got = await cat._resolveStartId({ id: 'kitsu-9', title: 'Sword Art Online Alicization', year: 2018 })
  assert.strictEqual(got.id, 2, 'matched on the normalised title, not on relevance order')
  assert.strictEqual(got.fuzzy, false)
})

test('a bare relevance hit is never accepted', async () => {
  // AniList's top hit for a franchise prefix is the umbrella series. It shares
  // no name with the card and disagrees on year — it must not be taken.
  const hits = [HIT(11757, 'Sword Art Online', 2012), HIT(167141, 'Gun Gale Online II', 2024)]
  const cat = createAnilistCatalog({ fetchFn: searchFetch(hits), retryDelayMs: 1 })
  const got = await cat._resolveStartId({ id: 'kitsu-1', title: 'Totally Different Title', year: 2024 })
  assert.strictEqual(got.id, 167141, 'only because year and format independently agree')
  assert.strictEqual(got.fuzzy, true, 'and it is reported as a guess')
  // With no year to corroborate, nothing is accepted at all.
  const blind = await cat._resolveStartId({ id: 'kitsu-1', title: 'Totally Different Title', year: null })
  assert.deepStrictEqual({ id: blind.id, fuzzy: blind.fuzzy }, { id: 0, fuzzy: false })
})

test('a year that matches nothing on offer resolves to nothing, not to the top hit', () => {
  // The branch that actually mattered: a year IS known, and no hit agrees with
  // it. The old code fell through to list[0] here — AniList's top relevance
  // hit for a franchise prefix, which is routinely the umbrella series, and
  // which then became the START of the entire chain walk.
  const hits = [HIT(11757, 'Sword Art Online', 2012), HIT(20594, 'Sword Art Online II', 2014)]
  const cat = createAnilistCatalog({ fetchFn: searchFetch(hits), retryDelayMs: 1 })
  return cat._resolveStartId({ id: 'kitsu-1', title: 'Some 2024 Spin-off', year: 2024 })
    .then(got => {
      assert.deepStrictEqual({ id: got.id, fuzzy: got.fuzzy }, { id: 0, fuzzy: false },
        'nothing shares a name and nothing shares a year — the honest answer is none')
    })
})

test('a hit that agrees on year but is the wrong FORMAT is not accepted either', () => {
  const hits = [HIT(999, 'Some Film', 2024, { format: 'MOVIE' })]
  const cat = createAnilistCatalog({ fetchFn: searchFetch(hits), retryDelayMs: 1 })
  return cat._resolveStartId({ id: 'kitsu-1', title: 'Some 2024 Series', year: 2024 })
    .then(got => assert.strictEqual(got.id, 0))
})

test('a byMal that throws does not take the title search down with it', async () => {
  const hits = [HIT(42, 'Cowboy Bebop', 1998)]
  const cat = createAnilistCatalog({ fetchFn: searchFetch(hits, { malThrows: true }), retryDelayMs: 1 })
  const got = await cat._resolveStartId({ id: 'mal-1', idMal: 1, title: 'Cowboy Bebop', year: 1998 })
  assert.strictEqual(got.id, 42, 'the title path still ran')
})

test('a chain records the id it actually walked from', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(TWO_SEASONS), retryDelayMs: 1 })
  const chain = await cat.seasonChain(2)
  assert.strictEqual(chain.startId, 2, 'so a card whose own id is not an AniList id can locate itself')
  assert.strictEqual(chain.fuzzy, false)
})
