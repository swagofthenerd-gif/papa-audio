'use strict'
// The season-pack episode strip, for packs RealDebrid serves (2026-09-16).
//
// The strip itself has worked for a long time — but only on the peer-served
// path, which builds it from TorrentStreamer.files(). Debrid is tried FIRST
// whenever it is configured, and that path never built a file list at all. So
// for anyone with a debrid account the strip simply never appeared, and
// clicking an episode answered "Nothing is streaming" while something was
// plainly streaming: "i cant see my season pack episode selectors anywhere
// while i am streaming man".
//
// These EXECUTE _sendDebridPack against fakes rather than checking that
// main.js mentions it — a source match would have passed just as happily with
// the event never leaving the process.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// A twelve-episode pack in the shape debrid().packFiles() returns, with the
// episode the viewer asked for marked current.
function pack(currentEpisode) {
  const files = []
  for (let n = 1; n <= 12; n++) {
    files.push({
      index: n, name: 'Show - S02E' + String(n).padStart(2, '0') + '.mkv',
      group: '', length: 1e9, episode: n, current: n === currentEpisode,
    })
  }
  return files
}

function harness({ session, files, throws = false }) {
  const sent = []
  const asked = []
  const ctx = {
    _videoSession: session,
    safeSend: (channel, payload) => sent.push({ channel, payload }),
    debrid: () => ({
      packFiles: (magnet, want) => {
        asked.push({ magnet, want })
        return throws ? Promise.reject(new Error('RealDebrid said no')) : Promise.resolve(files)
      },
    }),
    Promise, Array, Number, console,
  }
  vm.createContext(ctx)
  const start = MAIN.indexOf('function _sendDebridPack(')
  assert.ok(start > 0, 'found _sendDebridPack in main.js')
  const end = MAIN.indexOf('\n}', start) + 2
  vm.runInContext(MAIN.slice(start, end), ctx)
  return { ctx, sent, asked }
}

const live = () => true

test('a debrid-served pack announces its episodes to the strip', async () => {
  const { ctx, sent, asked } = harness({
    session: { debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 2, episode: 9 } } },
    files: pack(9),
  })
  ctx._sendDebridPack(live)
  await new Promise(r => setImmediate(r))

  assert.strictEqual(asked.length, 1, 'the pack was actually asked for')
  assert.strictEqual(asked[0].magnet, 'magnet:?xt=urn:btih:abc')
  assert.deepStrictEqual(asked[0].want, { season: 2, episode: 9 })

  assert.strictEqual(sent.length, 1, 'exactly one event')
  assert.strictEqual(sent[0].channel, 'video-event')
  assert.strictEqual(sent[0].payload.kind, 'pack', 'the same event the torrent path sends')
  assert.strictEqual(sent[0].payload.files.length, 12)
  assert.strictEqual(sent[0].payload.pick.wanted, 9)
  assert.strictEqual(sent[0].payload.pick.matched, true)
})

// The warning that tells the viewer to pick from the strip themselves. Reporting
// "matched" for a file that merely got picked would swallow it — and picking
// something is exactly what pickVideoFile always does.
test('playing the wrong episode is reported as a miss, not a match', async () => {
  const { ctx, sent } = harness({
    session: { debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 2, episode: 9 } } },
    files: pack(4), // the pack could not tell; the largest file is playing
  })
  ctx._sendDebridPack(live)
  await new Promise(r => setImmediate(r))
  assert.strictEqual(sent[0].payload.pick.matched, false)
  assert.strictEqual(sent[0].payload.pick.wanted, 9)
  assert.match(sent[0].payload.pick.name, /S02E04/)
})

test('a film is not a pack, so nothing is announced', async () => {
  const { ctx, sent } = harness({
    session: { debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: null } },
    files: [{ index: 1, name: 'Some.Movie.mkv', group: '', length: 8e9, episode: null, current: true }],
  })
  ctx._sendDebridPack(live)
  await new Promise(r => setImmediate(r))
  assert.strictEqual(sent.length, 0, 'a strip of one is noise')
})

test('nothing is announced when the play is not debrid-served', async () => {
  const { ctx, sent, asked } = harness({ session: { debrid: null }, files: pack(1) })
  ctx._sendDebridPack(live)
  await new Promise(r => setImmediate(r))
  assert.strictEqual(asked.length, 0, 'RealDebrid is not even asked')
  assert.strictEqual(sent.length, 0)
})

test('a superseded play never announces over the one that replaced it', async () => {
  const { ctx, sent } = harness({
    session: { debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 2, episode: 9 } } },
    files: pack(9),
  })
  ctx._sendDebridPack(() => false) // the viewer has already started something else
  await new Promise(r => setImmediate(r))
  assert.strictEqual(sent.length, 0)
})

test('RealDebrid failing to list the pack never breaks the play', async () => {
  const { ctx, sent } = harness({
    session: { debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 2, episode: 9 } } },
    files: null, throws: true,
  })
  // The strip is a convenience. A play that works without it still works.
  assert.doesNotThrow(() => ctx._sendDebridPack(live))
  await new Promise(r => setImmediate(r))
  assert.strictEqual(sent.length, 0)
})

// ── The first play must not throw away a warm relay ─────────────────────────
// Measured on a twin (2026-09-16): with debrid configured and the source held,
// the FIRST play fell back to peers and every play after it used debrid.
//
// The background pick — the one that runs while you are reading the page —
// resolved with no episode context and stamped the relay it built `want: null`.
// The play then asked for {season:null, episode:1}, the relay-reuse check read
// that as "a relay for a different file", discarded it, and re-ran the whole
// cold flow (four cached-checks, a resolve, a fresh relay) against a 14 s
// budget. Missing that budget is a fall back to peers.
//
// Two guards now. The pick carries the episode, so the wants match. And when
// they legitimately do not — switching episode inside a pack — the magnet is
// still known-held, so the expensive fan-out is skipped rather than repeated.

function playPath({ ready, playable }) {
  const calls = { isCached: [], playable: [] }
  const ctx = {
    console, Date, Number, Array, Promise, Error,
    DEBRID_RELAY_TTL_MS: 600000,
    DEBRID_STAGGER_MS: 0,
    _debridReady: ready,
    _videoSession: {},
    _debridRefusedHas: () => false,
    _debridRefusedMark() {},
    _debridBackOff() {},
    debrid: () => ({ isCached: async m => { calls.isCached.push(m); return true } }),
    _debridPlayable: async (m, want) => {
      calls.playable.push({ magnet: m, want })
      if (playable === 'throw') throw new Error('nope')
      return 'relay://' + m + '#' + (want ? want.episode : 'none')
    },
    setTimeout,
  }
  vm.createContext(ctx)
  // _debridPlayableAny and the two want helpers, which sit AFTER
  // _debridPlayable in the file — slice to the budget constant that follows
  // them, not to _debridPlayable, or the range comes out empty.
  const start = MAIN.indexOf('async function _debridPlayableAny(')
  const end = MAIN.indexOf('const DEBRID_BUDGET_MS', start)
  assert.ok(start > 0 && end > start, 'found the play-path block')
  // _debridPlayable itself is stubbed on the context, so drop the real one.
  const src = MAIN.slice(start, end)
    .replace(/async function _debridPlayable\(magnet, want\) \{[\s\S]*?\n\}\n/, '')
  vm.runInContext(src, ctx)
  return { ctx, calls }
}

const MAGNET = 'magnet:?xt=urn:btih:aaaa'
const fresh = (want) => ({ magnet: MAGNET, url: 'relay://warm', want, at: Date.now() })

test('a relay warmed for the same episode is used at once', async () => {
  const { ctx, calls } = playPath({ ready: fresh({ season: null, episode: 1 }) })
  const url = await ctx._debridPlayableAny({ magnet: MAGNET, season: null, episode: 1 })
  assert.strictEqual(url, 'relay://warm')
  assert.strictEqual(calls.isCached.length, 0, 'RealDebrid is not asked anything at all')
  assert.strictEqual(calls.playable.length, 0)
})

// The exact regression. Before the pick carried an episode, this was EVERY
// first play of an anime or TV episode.
test('a relay warmed with no episode does not cost a cold round trip', async () => {
  const { ctx, calls } = playPath({ ready: fresh(null) })
  const url = await ctx._debridPlayableAny({ magnet: MAGNET, season: null, episode: 1 })
  assert.strictEqual(calls.isCached.length, 0,
    'the magnet is known held — the four-candidate fan-out must not run')
  assert.strictEqual(calls.playable.length, 1)
  assert.strictEqual(calls.playable[0].want.episode, 1, 'it resolves the episode actually asked for')
  assert.strictEqual(calls.playable[0].want.season, null, 'and no season means null, not season 0')
  assert.match(url, /#1$/)
})

test('a relay for another episode of the same pack skips the fan-out too', async () => {
  const { ctx, calls } = playPath({ ready: fresh({ season: 2, episode: 3 }) })
  await ctx._debridPlayableAny({ magnet: MAGNET, season: 2, episode: 9 })
  assert.strictEqual(calls.isCached.length, 0)
  assert.strictEqual(calls.playable[0].want.episode, 9)
  assert.strictEqual(calls.playable[0].want.season, 2)
})

test('a relay for a different SOURCE is not treated as known-held', async () => {
  const { ctx, calls } = playPath({ ready: fresh({ season: null, episode: 1 }) })
  await ctx._debridPlayableAny({ magnet: 'magnet:?xt=urn:btih:bbbb', season: null, episode: 1 })
  assert.strictEqual(calls.isCached.length, 1, 'this one really does have to be asked about')
})

test('a stale relay is not trusted', async () => {
  const stale = { magnet: MAGNET, url: 'relay://old', want: { season: null, episode: 1 }, at: Date.now() - 900000 }
  const { ctx, calls } = playPath({ ready: stale })
  const url = await ctx._debridPlayableAny({ magnet: MAGNET, season: null, episode: 1 })
  assert.notStrictEqual(url, 'relay://old')
  assert.strictEqual(calls.isCached.length, 1, 'past its TTL it proves nothing, so ask properly')
})

test('the shortcut failing still falls through to the full check', async () => {
  const { ctx, calls } = playPath({ ready: fresh(null), playable: 'throw' })
  await assert.rejects(() => ctx._debridPlayableAny({ magnet: MAGNET, season: null, episode: 1 }))
  assert.strictEqual(calls.isCached.length, 1, 'the fan-out is the fallback, not the first move')
})
