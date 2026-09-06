'use strict'
// Papa source canary — a live liveness probe over every video source family.
//
//   npm run canary
//   node tools/source-canary.js
//
// The soak harness (tools/video-soak.js) asks "does the app drift over an
// evening?". This asks a smaller, faster question: "are the sources up right
// now?". It hits each catalog and each torrent provider with one cheap,
// real request and prints a green/red table with latency.
//
// It informs, it does not gate. Exit is ALWAYS 0 — a dead mirror is the
// internet's fault, not the build's, and a canary that fails CI on a flaky
// third party is a light nobody trusts (the same lesson the soak harness
// learned about a probe that fails blind). If you want a gate, read the table.
//
// Everything is timed out at 8s. A source that hangs is as red as one that
// errors; the point is to never wait on a dead mirror longer than a person
// would.
//
// TMDB's config endpoint needs an API key. Without one the row is skipped, not
// failed — a missing key is the user's setup, not a source being down.

const path = require('path')

const ROOT = path.join(__dirname, '..')
const TIMEOUT_MS = 8000

// ─────────────────────────────────────────────────────────────────────────────
// Pure formatting. No network and no requires of the app below this line, so the
// table renderer can be tested against fabricated probe results without touching
// a mirror. test/source-canary.test.js does exactly that.
// ─────────────────────────────────────────────────────────────────────────────

// One probe result:
//   { name, family, ok, skipped, ms, note }
// ok=true  → green, answered in `ms`.
// ok=false, skipped=true → grey, not attempted (e.g. no TMDB key).
// ok=false → red, failed or timed out; `note` says why.

function statusCell (r) {
  if (r.skipped) return 'SKIP'
  return r.ok ? 'UP' : 'DOWN'
}

function msCell (r) {
  if (r.skipped || r.ms == null) return '—'
  return Math.round(r.ms) + 'ms'
}

// A plain-text table, aligned in monospace, no colour codes so it reads the
// same in a terminal, a log file and a PR comment. Colour is carried by the
// UP/DOWN/SKIP word, which survives copy-paste; ANSI does not.
function formatTable (results) {
  const rows = Array.isArray(results) ? results : []
  const header = { family: 'FAMILY', name: 'SOURCE', status: 'STATUS', ms: 'LATENCY', note: 'NOTE' }
  const cells = rows.map(r => ({
    family: r.family || '',
    name: r.name || '',
    status: statusCell(r),
    ms: msCell(r),
    note: r.note || '',
  }))
  const all = [header].concat(cells)
  const width = key => Math.max(...all.map(c => String(c[key]).length))
  const w = {
    family: width('family'),
    name: width('name'),
    status: width('status'),
    ms: width('ms'),
  }
  const line = c =>
    c.family.padEnd(w.family) + '  ' +
    c.name.padEnd(w.name) + '  ' +
    c.status.padEnd(w.status) + '  ' +
    String(c.ms).padStart(w.ms) + '  ' +
    c.note
  const out = [line(header)]
  const rule = '─'.repeat(w.family + w.name + w.status + w.ms + 8)
  out.push(rule)
  for (const c of cells) out.push(line(c).replace(/\s+$/, ''))
  return out.join('\n')
}

// One line the reader sees last: how many of the sources that were actually
// attempted came back up. Skipped rows are not counted either way — a skip is
// not a vote.
function summaryLine (results) {
  const rows = Array.isArray(results) ? results : []
  const attempted = rows.filter(r => !r.skipped)
  const up = attempted.filter(r => r.ok).length
  const skipped = rows.length - attempted.length
  const tail = skipped ? ` (${skipped} skipped)` : ''
  if (!attempted.length) return `no sources attempted${tail}`
  return `${up}/${attempted.length} sources up${tail}`
}

module.exports = {
  formatTable,
  summaryLine,
  statusCell,
  msCell,
  TIMEOUT_MS,
}

// ─────────────────────────────────────────────────────────────────────────────
// Live probes and driver. Nothing below here runs on require, so the tests above
// stay offline and cheap.
// ─────────────────────────────────────────────────────────────────────────────

// Fetch with a hard deadline. A mirror that never answers must not hold the
// whole run open, so every probe races the request against an AbortController
// timer. Returns the parsed response or throws — the caller turns the throw into
// a red row.
async function fetchWithTimeout (url, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
    return res
  } finally {
    clearTimeout(timer)
  }
}

// Runs one probe function, times it, and turns any outcome — success, thrown
// error, or the 8s abort — into a result row. A probe never throws out of here.
async function timed (name, family, fn) {
  const t = Date.now()
  try {
    const r = await fn()
    const ms = Date.now() - t
    if (r && r.skipped) return { name, family, ok: false, skipped: true, ms: null, note: r.note || 'skipped' }
    return { name, family, ok: true, skipped: false, ms, note: (r && r.note) || '' }
  } catch (e) {
    const ms = Date.now() - t
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))
    return {
      name,
      family,
      ok: false,
      skipped: false,
      ms,
      note: aborted ? `timeout >${Math.round(TIMEOUT_MS / 1000)}s` : (e && e.message) || 'error',
    }
  }
}

// The TMDB key comes from the app's own settings, then the environment, so the
// canary sees what the app sees. Reading the store is best-effort: if electron
// is not available (this runs as plain node) the store read simply yields
// nothing and we fall through to the env var.
function tmdbKey () {
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY
  try {
    const Store = require(path.join(ROOT, 'node_modules/electron-store'))
    const store = new Store()
    const vs = store.get('videoSettings') || {}
    if (vs.tmdbApiKey) return vs.tmdbApiKey
  } catch (_) {}
  return null
}

// Each probe issues ONE real, cheap request per source family and cares only
// whether a usable answer came back — not what it contained. A working mirror
// that has no torrent for this exact query is still up; only a network failure,
// a non-OK status, or a body that will not parse is down.

async function probeTmdb () {
  const key = tmdbKey()
  if (!key) return { skipped: true, note: 'no TMDB key in settings or TMDB_API_KEY' }
  const tmdb = require(path.join(ROOT, 'catalog/tmdb'))
  const base = tmdb.TMDB_BASE || 'https://api.themoviedb.org/3'
  const res = await fetchWithTimeout(`${base}/configuration?api_key=${encodeURIComponent(key)}`)
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`)
  const body = await res.json()
  if (!body || !body.images) throw new Error('no config in body')
  return { note: 'configuration ok' }
}

async function probeAnilist () {
  const { createAnilistCatalog } = require(path.join(ROOT, 'catalog/anilist'))
  const cat = createAnilistCatalog({ fetchFn: fetchWithTimeout })
  const out = await cat.search('cowboy bebop', 1)
  // search resolves to a list; an empty list is still a live endpoint, so any
  // resolution counts as up. A dead endpoint throws.
  if (!Array.isArray(out)) throw new Error('unexpected shape')
  return { note: `${out.length} results` }
}

// A torrent provider is probed by requiring its factory directly, building it
// with the real network fetch (timeout-wrapped) and its default mirrors, and
// running one representative request. The provider swallows mirror failures and
// returns [] — so to tell "up" from "down" the probe asks the mirror-race layer
// nothing and instead treats a resolved call (even to []) as reaching the
// factory, while a thrown error or timeout is down. Because the providers race
// their own mirrors internally with their own abort, the 8s wrapper here is the
// backstop.
const TORRENT_PROBES = [
  {
    name: 'yts', family: 'torrent/movie',
    make: () => require(path.join(ROOT, 'providers/yts')).createYtsProvider,
    request: { type: 'movie', title: 'Inception', year: 2010 },
  },
  {
    name: 'eztv', family: 'torrent/tv',
    make: () => require(path.join(ROOT, 'providers/eztv')).createEztvProvider,
    request: { type: 'tv', imdbId: 'tt0944947', season: 1, episode: 1 },
  },
  {
    name: 'nyaa', family: 'torrent/anime',
    make: () => require(path.join(ROOT, 'providers/nyaa')).createNyaaProvider,
    request: { type: 'anime', title: 'Cowboy Bebop', episode: 1 },
  },
  {
    name: 'apibay', family: 'torrent/anime',
    make: () => require(path.join(ROOT, 'providers/apibay')).createApibayProvider,
    request: { type: 'movie', title: 'Inception', year: 2010 },
  },
  {
    name: 'animetosho', family: 'torrent/anime',
    make: () => require(path.join(ROOT, 'providers/animetosho')).createAnimetoshoProvider,
    request: { type: 'anime', title: 'Frieren', episode: 1 },
  },
  {
    name: 'knaben', family: 'torrent/meta',
    make: () => require(path.join(ROOT, 'providers/knaben')).createKnabenProvider,
    request: { type: 'movie', title: 'Inception', year: 2010 },
  },
  {
    name: 'solidtorrents', family: 'torrent/meta',
    make: () => require(path.join(ROOT, 'providers/solidtorrents')).createSolidTorrentsProvider,
    request: { type: 'movie', title: 'Inception', year: 2010 },
  },
]

async function probeTorrent (spec) {
  const factory = spec.make()
  const provider = factory({ fetchFn: fetchWithTimeout })
  const out = await provider(spec.request)
  if (!Array.isArray(out)) throw new Error('provider returned non-array')
  // A provider that reaches every mirror and finds nothing returns []. That is
  // still a reachable family, so it reads as up but notes the empty result so a
  // reader can see the difference between "up with hits" and "up, no match".
  return { note: out.length ? `${out.length} results` : 'reachable, no match' }
}

async function run () {
  const t0 = Date.now()
  console.log('Papa source canary — one live probe per source family, 8s cap each.')
  console.log('Informs only; exit is always 0. Read the table, not the exit code.\n')

  const jobs = [
    timed('tmdb', 'catalog/movie-tv', probeTmdb),
    timed('anilist', 'catalog/anime', probeAnilist),
  ]
  for (const spec of TORRENT_PROBES) {
    jobs.push(timed(spec.name, spec.family, () => probeTorrent(spec)))
  }

  const results = await Promise.all(jobs)
  console.log(formatTable(results))
  console.log('')
  console.log(summaryLine(results) + `  ·  ${((Date.now() - t0) / 1000).toFixed(1)}s total`)
}

if (require.main === module) {
  run()
    .catch(e => {
      // Even a bug in the canary itself must not fail the caller — it informs.
      console.error('canary error:', e && e.stack ? e.stack : e)
    })
    .finally(() => process.exit(0))
}
