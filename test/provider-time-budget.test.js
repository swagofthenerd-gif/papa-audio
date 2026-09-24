'use strict'
// A partial answer beats a timeout answering nothing.
//
// The query list a search runs multiplies out — title variants x episode /
// absolute / pack forms, plus two dub forms per variant when a dub is wanted —
// and nyaa serialises requests at its end at ~500 ms each (parallelising was
// measured to change nothing). With the Dub toggle on, a five-variant show runs
// ~30 queries and needs ~15 s; resolveStream kills any backend at 20 s and takes
// EVERYTHING it had found. Logged from the running app, Kaiji episode 17, the
// same minute:
//
//     dub off:  nyaa=7  animetosho=7   -> a list of 8
//     dub on:   nyaa=-1 animetosho=-1  -> a list of 1
//
// Seven results were in hand when the deadline fired, and were thrown away.
// The loop now keeps its own clock and answers with what it has.

const test = require('node:test')
const assert = require('node:assert')
const { createNyaaProvider } = require('../providers/nyaa')
const { createAnimetoshoProvider } = require('../providers/animetosho')

// The two providers speak different feeds — nyaa an RSS page, AnimeTosho a JSON
// list — so each gets its rows in its own dialect and the tests below stay
// identical in what they assert.
const rssItem = (title, hash, seeders) =>
  `<item><title><![CDATA[${title}]]></title><link>https://nyaa.si/download/1.torrent</link>` +
  `<nyaa:infoHash>${hash}</nyaa:infoHash><nyaa:seeders>${seeders}</nyaa:seeders><nyaa:size>1.4 GiB</nyaa:size></item>`
const rssFeed = items =>
  ({ ok: true, text: async () => `<?xml version="1.0"?><rss><channel>${items.map(i => rssItem(...i)).join('')}</channel></rss>` })
const jsonFeed = items =>
  ({ ok: true, text: async () => JSON.stringify(items.map(([title, hash, seeders]) => ({
    title, info_hash: hash.toLowerCase(),
    magnet_uri: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`,
    seeders, leechers: 5, total_size: 1500000000,
  }))) })

// One matching row on the FIRST query, then every later query slow or hung.
// Two title variants keep the query list long enough (episode + bare + pack
// forms each) that the run can never finish inside a small budget, so what
// comes back is what the budget saved. The title is deliberately a single word
// with plain release names: how the show-title filter treats dashes and group
// tags is another test's subject, not this one's.
const REQ = {
  type: 'anime', title: 'Kaiji', episode: 12,
  titles: { romaji: 'Gyakkyou Burai Kaiji' },
}
const HIT = ['[SubsPlease] Kaiji - 12 (1080p)', 'A'.repeat(40), 50]

function slowAfterFirst(feed, { laterMs }) {
  const fn = async () => {
    fn.calls++
    if (fn.calls === 1) return feed([HIT])
    if (laterMs === Infinity) return new Promise(() => {})   // hung: never answers
    await new Promise(r => setTimeout(r, laterMs))
    return feed([])
  }
  fn.calls = 0
  return fn
}

for (const [name, make, feed] of [
  ['nyaa', opts => createNyaaProvider(opts), rssFeed],
  ['animetosho', opts => createAnimetoshoProvider(opts), jsonFeed],
]) {
  test(name + ': when the budget runs out, what was found is returned', async () => {
    const fetchFn = slowAfterFirst(feed, { laterMs: 150 })
    const provider = make({
      baseUrls: ['https://x'],
      fetchFn,
      timeBudgetMs: 400,
    })
    const t0 = Date.now()
    const out = await provider(REQ)
    const took = Date.now() - t0
    assert.ok(out.length >= 1, 'the first query found a result and it must survive: got ' + out.length)
    assert.ok(took < 1500, 'the run must stop near its budget, not run every query (took ' + took + 'ms)')
    // The break is not only about returning on time — once the budget is spent,
    // no FURTHER request may be fired at the indexer at all. Capping the mirror
    // race alone would still fire every remaining query and abort each a
    // millisecond later, which to a public indexer is a burst of junk requests.
    // This request shape produces 8 queries (2 title variants x episode, bare
    // and two pack forms); at ~150 ms each against a 400 ms budget, at most 5
    // can legitimately begin.
    assert.ok(fetchFn.calls <= 6,
      'queries kept firing after the budget was spent: ' + fetchFn.calls + ' requests')
  })

  test(name + ': one hung mirror cannot spend the whole budget', async () => {
    // The second query never answers at all. Uncapped, the mirror race waits its
    // default 10 s backstop for it; capped by the time left, the run still
    // answers around its budget — with the first query's find.
    const provider = make({
      baseUrls: ['https://x'],
      fetchFn: slowAfterFirst(feed, { laterMs: Infinity }),
      timeBudgetMs: 400,
    })
    const t0 = Date.now()
    const out = await provider(REQ)
    const took = Date.now() - t0
    assert.ok(out.length >= 1, 'the find from before the hang must survive')
    assert.ok(took < 3000, 'a hung query must cost the time left, not the race backstop (took ' + took + 'ms)')
  })

  test(name + ': a fast healthy run is unchanged by the budget', async () => {
    let calls = 0
    const wide = Array.from({ length: 8 }, (_, i) =>
      [`[Group${i}] Kaiji - 12 (1080p)`, String(i).repeat(40).slice(0, 40), 100 + i])
    const provider = make({
      baseUrls: ['https://x'],
      fetchFn: async () => { calls++; return feed(wide) },
      timeBudgetMs: 14000,
    })
    const out = await provider(REQ)
    assert.ok(out.length >= 8, 'a well-seeded show still fills the list: got ' + out.length)
    assert.strictEqual(calls, 1, 'one query satisfied it, exactly as before the budget existed')
  })
}
