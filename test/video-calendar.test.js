'use strict'
// Airing shelf (App §25) + calendar page (App §26).
//
// The merge/normalisation lives in main.js and the shelf/calendar builders in
// the renderer. Both files are Electron entry points that cannot be required
// outside Electron, so each pure function is extracted by brace-matching and
// run for real in a vm — the same technique video-render/video-binge use —
// rather than asserted against source text. The IPC/preload wiring is checked
// against the source, because that is what "the channel exists" actually means.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const { makeCache } = require('../src/ttl-cache')

function extractFrom(src, name) {
  const start = src.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

// A vm realm loaded with the pure builders. esc mirrors the renderer's, and a
// couple of globals the builders reach for are stubbed to inert defaults.
function realm(src, names, extra = {}) {
  const ctx = Object.assign({
    console,
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  }, extra)
  vm.createContext(ctx)
  for (const n of names) vm.runInContext(extractFrom(src, n), ctx)
  return ctx
}

// Values built inside the vm belong to another realm, so deepStrictEqual fails
// on prototype identity even when the contents match. A JSON round-trip gives
// them this realm's prototypes across arbitrary nesting.
const plain = o => (o == null ? o : JSON.parse(JSON.stringify(o)))

// ── main.js: merge + date handling ──────────────────────────────────────────

const mainCtx = realm(MAIN, ['_mergeAiring', '_dayStringToLocalMs'])
const mergeAiring = (a, b) => plain(mainCtx._mergeAiring(a, b))
const dayToMs = mainCtx._dayStringToLocalMs

test('_dayStringToLocalMs parses a day to local midnight, rejects junk', () => {
  const ms = dayToMs('2026-09-12')
  const d = new Date(ms)
  assert.strictEqual(d.getFullYear(), 2026)
  assert.strictEqual(d.getMonth(), 8) // September (0-based)
  assert.strictEqual(d.getDate(), 12)
  assert.strictEqual(d.getHours(), 0)
  assert.strictEqual(dayToMs('nope'), null)
  assert.strictEqual(dayToMs(''), null)
  assert.strictEqual(dayToMs(null), null)
})

test('_mergeAiring converts AniList airingAt seconds to ms and keys by anime:id', () => {
  const out = mergeAiring([{ id: 21, title: 'One Piece', episode: 1089, airingAt: 1000 }], [])
  assert.deepStrictEqual(out, [{ key: 'anime:21', title: 'One Piece', episode: 1089, airsAt: 1000000, type: 'anime' }])
})

test('_mergeAiring reads TMDB nextEpisode and anchors the day to local midnight', () => {
  const out = mergeAiring([], [{ id: 1396, title: 'BB', nextEpisode: { episodeNumber: 3, airDate: '2026-09-12' } }])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].key, 'tv:1396')
  assert.strictEqual(out[0].episode, 3)
  assert.strictEqual(out[0].type, 'tv')
  assert.strictEqual(out[0].airsAt, dayToMs('2026-09-12'))
})

test('_mergeAiring drops rows with no usable time and sorts soonest-first', () => {
  const out = mergeAiring(
    [
      { id: 2, title: 'Later', episode: 1, airingAt: 3000 },
      { id: 3, title: 'NoTime', episode: 1, airingAt: 0 },
      { id: 4, title: 'Sooner', episode: 1, airingAt: 1000 },
    ],
    [{ id: 5, title: 'Ended', nextEpisode: null }]
  )
  assert.deepStrictEqual(out.map(r => r.title), ['Sooner', 'Later'])
})

test('_mergeAiring tolerates non-array inputs', () => {
  assert.deepStrictEqual(mergeAiring(null, undefined), [])
})

// ── main.js: cache behaviour (30-min TTL, id-order-independent key) ──────────

test('the video-airing cache is a 30-minute TTL cache', () => {
  const decl = MAIN.slice(MAIN.indexOf('const _videoAiringCache'))
    .slice(0, 200)
  assert.match(decl, /ttlMs:\s*1000\s*\*\s*60\s*\*\s*30/)
})

test('a schedule survives inside the TTL and is dropped after it (30-min semantics)', () => {
  let t = 0
  const cache = makeCache({ cap: 40, ttlMs: 1000 * 60 * 30, now: () => t })
  cache.set('airing:21|1396', [{ key: 'anime:21' }])
  t = 1000 * 60 * 29
  assert.ok(cache.get('airing:21|1396'), 'still cached at 29 min')
  t = 1000 * 60 * 31
  assert.strictEqual(cache.get('airing:21|1396'), undefined, 'evicted after 30 min')
})

test('the cache key is built from sorted, de-duplicated id sets so order does not matter', () => {
  // Mirrors the key construction in the handler: same follow list in any order
  // must resolve to the same cache key.
  const uniqSorted = list => [...new Set(list)].sort((a, b) => a - b)
  const key = (a, t) => `airing:${uniqSorted(a).join(',')}|${uniqSorted(t).join(',')}`
  assert.strictEqual(key([21, 44], [1396]), key([44, 21, 44], [1396]))
})

test('the handler only caches a non-empty schedule', () => {
  // The empty-result guard: a transient upstream failure must not be cached for
  // half an hour. Asserted on the source because it is a control-flow property.
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-airing'"), MAIN.indexOf("ipcMain.handle('video-airing'") + 3000)
  assert.match(body, /if \(airing\.length\) _videoAiringCache\.set/)
})

// ── renderer: seed + label helpers ──────────────────────────────────────────

const seedCtx = realm(RENDERER, ['_airingSeed', '_airingWhenLabel', '_airingSubLabel', '_airingByDay', '_calendarDayLabel'])

test('_airingSeed splits anime→anilistIds and tv→tmdbIds, dropping movies and junk', () => {
  const cw = [
    { type: 'anime', id: '21' },
    { type: 'tv', id: 1396 },
    { type: 'movie', id: 500 },
    { type: 'anime', id: null },
  ]
  const wl = [{ type: 'tv', id: '1399' }, { type: 'anime', id: 21 }]
  const seed = plain(seedCtx._airingSeed(cw, wl))
  assert.deepStrictEqual(seed.anilistIds.sort((a, b) => a - b), [21])
  assert.deepStrictEqual(seed.tmdbIds.sort((a, b) => a - b), [1396, 1399])
})

test('_airingSeed is empty for empty/undefined inputs', () => {
  assert.deepStrictEqual(plain(seedCtx._airingSeed(undefined, undefined)), { anilistIds: [], tmdbIds: [] })
})

test('_airingWhenLabel says the weekday within a week and a date beyond it', () => {
  const now = new Date(2026, 8, 10, 12, 0, 0).getTime() // Thu Sep 10 2026, noon
  const thu = new Date(2026, 8, 10, 20, 0, 0).getTime()
  assert.strictEqual(seedCtx._airingWhenLabel(thu, now), new Date(thu).toLocaleDateString(undefined, { weekday: 'long' }))
  const twoWeeks = new Date(2026, 8, 24, 20, 0, 0).getTime()
  assert.strictEqual(seedCtx._airingWhenLabel(twoWeeks, now), new Date(twoWeeks).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  assert.strictEqual(seedCtx._airingWhenLabel(now - 1000, now), 'Aired')
})

test('_airingSubLabel is "Ep N · When", or just the date when the episode is unknown', () => {
  const now = new Date(2026, 8, 10, 12, 0, 0).getTime()
  const airs = new Date(2026, 8, 12, 20, 0, 0).getTime()
  const when = new Date(airs).toLocaleDateString(undefined, { weekday: 'long' })
  assert.strictEqual(seedCtx._airingSubLabel({ episode: 5, airsAt: airs }, now), 'Ep 5 · ' + when)
  assert.strictEqual(seedCtx._airingSubLabel({ episode: null, airsAt: airs }, now), when)
})

// ── renderer: calendar day grouping ─────────────────────────────────────────

test('_airingByDay groups into day buckets within the window, soonest day first, omitting empty days', () => {
  const today = new Date(2026, 8, 10).getTime()
  const at = (d, h) => new Date(2026, 8, d, h).getTime()
  const airing = [
    { key: 'tv:1', title: 'A', episode: 1, airsAt: at(12, 9) },
    { key: 'tv:2', title: 'B', episode: 2, airsAt: at(10, 20) },
    { key: 'anime:3', title: 'C', episode: 3, airsAt: at(10, 8) },
    { key: 'tv:9', title: 'TooFar', episode: 1, airsAt: at(30, 8) }, // beyond 14 days
  ]
  const groups = plain(seedCtx._airingByDay(airing, today + 12 * 3600 * 1000, 14))
  assert.strictEqual(groups.length, 2, 'Sep 10 and Sep 12 only; Sep 30 is out of range')
  assert.strictEqual(groups[0].label, 'Today')
  // Within a day, earlier airing time first.
  assert.deepStrictEqual(groups[0].items.map(i => i.title), ['C', 'B'])
  assert.strictEqual(groups[1].items[0].title, 'A')
})

test('_calendarDayLabel reads Today / Tomorrow / weekday+date', () => {
  const today = new Date(2026, 8, 10).getTime()
  const day = 24 * 3600 * 1000
  assert.strictEqual(seedCtx._calendarDayLabel(today, today), 'Today')
  assert.strictEqual(seedCtx._calendarDayLabel(today + day, today), 'Tomorrow')
  const later = today + 4 * day
  assert.strictEqual(seedCtx._calendarDayLabel(later, today),
    new Date(later).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))
})

// ── renderer: markup builders ───────────────────────────────────────────────

const htmlCtx = realm(RENDERER, ['_airingCardHtml', '_calendarRowHtml', '_calendarEmptyHtml', '_airingWhenLabel', '_airingSubLabel'])

test('_airingCardHtml carries the detail key and the air sub-label, escaping the title', () => {
  const now = new Date(2026, 8, 10, 12).getTime()
  const html = htmlCtx._airingCardHtml({ key: 'anime:21', title: 'One <Piece>', episode: 1089, airsAt: new Date(2026, 8, 12, 20).getTime() }, now)
  assert.match(html, /data-video="anime:21"/)
  assert.match(html, /Ep 1089/)
  assert.match(html, /One &lt;Piece&gt;/)
  assert.ok(!html.includes('<Piece>'), 'title is escaped')
})

test('_calendarRowHtml is a keyed row with kind, name and episode', () => {
  const html = htmlCtx._calendarRowHtml({ key: 'tv:1396', title: 'Breaking Bad', episode: 3, airsAt: new Date(2026, 8, 12, 20).getTime(), type: 'tv' })
  assert.match(html, /data-video="tv:1396"/)
  assert.match(html, /Breaking Bad/)
  assert.match(html, /Ep 3/)
  assert.match(html, /vcal-kind/)
})

test('_calendarEmptyHtml teaches how to fill the calendar', () => {
  const html = htmlCtx._calendarEmptyHtml()
  assert.match(html, /My List/)
})

// ── IPC + preload wiring ────────────────────────────────────────────────────

test('the video-airing handler is registered in main', () => {
  const registered = new Set([...MAIN.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]))
  assert.ok(registered.has('video-airing'), 'video-airing is not registered')
})

test('preload exposes videoAiring on window.api', () => {
  assert.match(PRELOAD, /videoAiring:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('video-airing',\s*p\)/)
})

test('the calendar page is registered in navigate and the video-page set', () => {
  assert.match(RENDERER, /VIDEO_PAGES = new Set\(\[[^\]]*'calendar'/)
  assert.match(RENDERER, /page === 'calendar'\)\s*renderCalendar\(\)/)
})

test('the airing badge and calendar agenda carry scoped cinema styles', () => {
  assert.match(CSS, /\.cinema \.vbadge-air/)
  assert.match(CSS, /\.cinema \.vcal-row/)
  assert.match(CSS, /\.cinema \.vcal-empty/)
})
