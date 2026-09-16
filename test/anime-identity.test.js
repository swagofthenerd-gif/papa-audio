'use strict'
// The five faults a layout/identity audit confirmed alongside the spin-off
// numbering bug (2026-09-16), all reported as one thing by the user: "its not
// even loading the correct seasons or episodes... and i dont wanna see
// anything like this again."
//
// Each test names the specific wrong answer it exists to prevent. These EXECUTE
// the real functions — extracted from main.js, which cannot be required because
// it opens Electron — rather than pinning their source text.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function run(startMarker, endMarker, ctx) {
  const start = MAIN.indexOf(startMarker)
  assert.ok(start > 0, 'found ' + startMarker)
  const end = MAIN.indexOf(endMarker, start)
  assert.ok(end > start, 'found ' + endMarker)
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end), ctx)
  return ctx
}

// ── A parent series is not its own spin-off ─────────────────────────────────
// Both title matchers accepted substring containment in either direction, so
// "sword art online" matched "sword art online alternative gun gale online ii".
// _enrichAnimeDetail takes the FIRST overlapping AniList hit and copies its
// titles, idMal and anilistId onto the detail — so an anime opened from
// Movies & TV could borrow the wrong show's romaji title (which is what goes
// to the torrent indexers) and the wrong MAL id (which goes to AniSkip).
const titleCtx = () => run('// Two normalised titles that name the SAME show',
  '// Whether an AniList entry and a TMDB entry describe the same show', { String, RegExp, Set })
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

test('a franchise title is not a match for its own sequel or spin-off', () => {
  const ctx = titleCtx()
  const same = (a, b) => ctx._titlesNameSameShow(norm(a), norm(b))
  assert.strictEqual(same('Sword Art Online', 'Sword Art Online Alternative: Gun Gale Online II'), false,
    'the reported class: a parent passing as its spin-off')
  assert.strictEqual(same('Sousou no Frieren', 'Sousou no Frieren 2nd Season'), false)
  assert.strictEqual(same('Mushoku Tensei II', 'Mushoku Tensei II Part 2'), false, 'a cour split')
  assert.strictEqual(same('Attack on Titan', 'Attack on Titan Final Season'), false)
  assert.strictEqual(same('Steins;Gate', 'Steins;Gate 0'), false, 'a bare number is a marker too')
})

test('the same show under two spellings still matches', () => {
  const ctx = titleCtx()
  const same = (a, b) => ctx._titlesNameSameShow(norm(a), norm(b))
  assert.strictEqual(same('Sword Art Online: Alicization', 'Sword Art Online Alicization'), true)
  assert.strictEqual(same('Demon Slayer: Kimetsu no Yaiba', 'Demon Slayer Kimetsu no Yaiba'), true)
  assert.strictEqual(same('Fullmetal Alchemist: Brotherhood', 'Fullmetal Alchemist Brotherhood'), true)
  assert.strictEqual(same('Cowboy Bebop', 'Cowboy Bebop'), true)
})

test('a title that normalises to a fragment is never evidence of anything', () => {
  const ctx = titleCtx()
  // Both of these normalise to a bare token; containment would otherwise pair
  // two entirely unrelated shows whenever their years happened to agree.
  assert.strictEqual(ctx._titlesNameSameShow(norm('Kemono Friends 2'), norm('Spy x Family Season 2')), false)
  assert.strictEqual(ctx._titlesNameSameShow('re', 're zero kara hajimeru isekai seikatsu'), false)
})

// ── A partial chain must never back arithmetic ──────────────────────────────
// `capped` means the walk ran out of request budget mid-franchise. The cache
// gate reasoned carefully about `truncated` and then ignored the other
// partial-answer flag. Measured: Fate/stay night caps at eight "seasons" that
// are really five separate series, and Fate/Apocrypha episode 1 came out as
// absolute 76.
function absCtx(chain) {
  const ctx = {
    console, String, Number, Array, Math,
    _videoChainCache: { get: () => chain },
    _animeDetailCacheRead: () => null,
  }
  return run('function _animeAbsoluteEpisode(', '\nipcMain.handle(\'video-streams\'', ctx)
}
const season = (id, episodeCount, over = {}) =>
  Object.assign({ id, episodeCount, format: 'TV', run: true }, over)

test('a capped or truncated chain yields no absolute number at all', () => {
  const seasons = [season(1, 25), season(2, 24), season(3, 12)]
  assert.strictEqual(absCtx({ seasons, capped: true })._animeAbsoluteEpisode(3, 1), null,
    'a walk that ran out of budget is a prefix of the truth, not the truth')
  assert.strictEqual(absCtx({ seasons, truncated: true })._animeAbsoluteEpisode(3, 1), null)
  // The same chain, complete, still answers.
  assert.strictEqual(absCtx({ seasons })._animeAbsoluteEpisode(3, 1), 50)
})

test('only the seasons sharing this one\'s numbering are summed', () => {
  // A sibling that belongs in the season list but is released numbered from 1.
  const seasons = [season(1, 24, { run: false }), season(2, 23)]
  assert.strictEqual(absCtx({ seasons })._animeAbsoluteEpisode(2, 1), null)
})

test('an episode beyond the entry\'s own length is refused, not guessed', () => {
  const seasons = [season(1, 12), season(2, 12)]
  const ctx = absCtx({ seasons })
  assert.strictEqual(ctx._animeAbsoluteEpisode(2, 1), 13)
  assert.strictEqual(ctx._animeAbsoluteEpisode(2, 99), null,
    'nyaa.js both QUERIES the absolute and accepts a release numbered with it')
})

// ── A card with no AniList id can still find itself ─────────────────────────
// A card from the Jikan or Kitsu fallback has id "mal-9253"/"kitsu-48671",
// while the chain's rows are AniList ids — so the comparison always missed and
// such a show could NEVER resolve an absolute number. Measured on the user's
// own cache: chain:kitsu-48671 holds [151807, 176496] and contains no row
// whose id equals its own key.
test('a mal- or kitsu- card resolves through the id the chain actually walked from', () => {
  const chain = { seasons: [season(151807, 12), season(176496, 13)], startId: 176496 }
  const ctx = absCtx(chain)
  assert.strictEqual(ctx._animeAbsoluteEpisode('kitsu-48671', 1), 13,
    'Solo Leveling season 2 episode 1 — previously unresolvable for good')
  // A numeric id still resolves directly, unchanged.
  assert.strictEqual(ctx._animeAbsoluteEpisode(176496, 1), 13)
})

test('startId does not rescue a card that genuinely is the first season', () => {
  const chain = { seasons: [season(151807, 12), season(176496, 13)], startId: 151807 }
  assert.strictEqual(absCtx(chain)._animeAbsoluteEpisode('kitsu-1', 1), null,
    'a first season is already absolute')
})

// ── The episode page loop ───────────────────────────────────────────────────
// Two conflations in the same loop, plus an unbounded span.
//
// (a) The old control stopped on a page shorter than twenty — but that length
//     is measured AFTER normalizeEpisode drops rows with no usable number. One
//     episode-0 or null-numbered row in the middle of a run convinced the loop
//     it had reached the end and silently truncated everything after it.
// (b) "Show all" forwarded the whole span, so One Piece asked for 1,402
//     episodes = 71 serialized Kitsu requests behind a 250 ms single-lane
//     queue: about half a minute of blank numbered buttons.
//
// Paged on Kitsu's own meta.count now, which needs no catalog change and
// survives the pages already cached on disk.
function pageLoop(pages, { first, last, MAX_PAGES = 10, PAGE = 20 }) {
  const requested = []
  let lastWanted = Math.max(first, last)
  let truncated = false
  if (lastWanted - first + 1 > MAX_PAGES * PAGE) { lastWanted = first + MAX_PAGES * PAGE - 1; truncated = true }
  const out = []
  let total = null, offset = Math.floor((first - 1) / PAGE) * PAGE, highest = 0
  for (let guard = 0; guard < MAX_PAGES + 2; guard++) {
    requested.push(offset)
    const page = pages(offset)
    if (page.total != null) total = page.total
    for (const ep of page.episodes) {
      if (ep.episodeNumber > highest) highest = ep.episodeNumber
      if (ep.episodeNumber >= first && ep.episodeNumber <= lastWanted) out.push(ep)
    }
    offset += PAGE
    if (total != null && offset >= total) break
    if (!page.episodes.length && total == null) break
    if (highest >= lastWanted) break
  }
  return { out, total, truncated, servedTo: truncated ? lastWanted : null, requested }
}

// A run of `count` episodes, with `holes` episode numbers dropped by
// normalizeEpisode as unusable — exactly what makes a full page look short.
const kitsuPages = (count, holes = []) => (offset) => ({
  total: count,
  episodes: Array.from({ length: 20 }, (_, i) => offset + i + 1)
    .filter(n => n <= count && !holes.includes(n))
    .map(n => ({ episodeNumber: n })),
})

test('a dropped row mid-run no longer ends the list early', () => {
  // Episode 7 is unusable, so page 1 comes back with nineteen rows. The old
  // control read that as "the end" and lost episodes 8 to 24 entirely.
  const r = pageLoop(kitsuPages(24, [7]), { first: 1, last: 24 })
  const got = r.out.map(e => e.episodeNumber)
  assert.ok(got.includes(24), 'the run continues past the short page')
  assert.strictEqual(got.length, 23, 'only the genuinely unusable row is missing')
  assert.strictEqual(r.truncated, false)
})

test('a deep window costs one request, not a walk from episode one', () => {
  const r = pageLoop(kitsuPages(1402), { first: 1001, last: 1020 })
  assert.deepStrictEqual(Array.from(r.requested), [1000], 'straight to the page that holds it')
  assert.deepStrictEqual(r.out.map(e => e.episodeNumber), Array.from({ length: 20 }, (_, i) => 1001 + i))
})

test('"Show all" on a long-runner is bounded, and says that it was', () => {
  const r = pageLoop(kitsuPages(1402), { first: 1, last: 2000 })
  assert.strictEqual(r.requested.length, 10, '10 requests, not 71')
  assert.strictEqual(r.truncated, true)
  assert.strictEqual(r.servedTo, 200, 'and the page can say where titles stop')
  assert.strictEqual(r.out.length, 200)
})

test('an ordinary season is unaffected', () => {
  const r = pageLoop(kitsuPages(12), { first: 1, last: 12 })
  assert.strictEqual(r.requested.length, 1)
  assert.strictEqual(r.out.length, 12)
  assert.strictEqual(r.truncated, false)
})

test('a show whose reported count overshoots Kitsu\'s rows still terminates', () => {
  // An airing show: AniList says 24, Kitsu has aired 6. Without a backstop the
  // "keep going until the window is covered" rule never finishes.
  const airing = (offset) => ({ total: null, episodes: offset === 0 ? [{ episodeNumber: 1 }, { episodeNumber: 2 }] : [] })
  const r = pageLoop(airing, { first: 1, last: 24 })
  assert.ok(r.requested.length <= 12, 'bounded: ' + r.requested.length + ' requests')
  assert.deepStrictEqual(r.out.map(e => e.episodeNumber), [1, 2])
})

// ── The start-up watchdog cleans up after itself ───────────────────────────
// Found on a twin during an end-to-end run (2026-09-16): RealDebrid served the
// file, the position ran 25 -> 32 -> 38 -> 50 s, and the stage still read
// "Still no picture after 15 s. Try another source below." The watchdog
// disarmed correctly the moment the position moved; it just never took down
// the warning it had already painted. So working playback carried a message
// telling the viewer it was broken.
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function watchdog(over) {
  const stage = []
  const ctx = Object.assign({
    console, Date, Math, String,
    _startWatchTimer: null,
    _player: { setStageMessage: m => stage.push(m) },
    _watch: { pick: null },
    esc: v => String(v == null ? '' : v),
    showToast() {},
    _autoSwitchSource() {},
    START_WATCH_QUIET_MS: 0,
    START_SWITCH_QUIET_MS: 1e9,
    PapaStartHonesty: undefined,
    clearInterval() {},
  }, over)
  const start = RENDERER.indexOf('function _disarmStartWatch()')
  const end = RENDERER.indexOf('\n}', RENDERER.indexOf('function _startWatchTick('))
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end + 2), ctx)
  return { ctx, stage }
}

test('a warning the watchdog painted is taken down when the picture arrives', () => {
  const { ctx, stage } = watchdog({ _startWatch: { at: Date.now() - 15000, wordsAt: Date.now() - 15000 } })
  ctx._startWatchTick(Date.now())
  assert.strictEqual(stage.length, 1, 'it warned')
  assert.match(stage[0], /Still no picture/)
  ctx._disarmStartWatch()
  assert.strictEqual(stage.length, 2, 'and it cleared')
  assert.strictEqual(stage[1], '', 'the stage is handed back empty, not left saying playback failed')
})

test('a watchdog that never warned clears nothing', () => {
  // Otherwise disarming would wipe whatever else had put a message up.
  const { ctx, stage } = watchdog({ _startWatch: { at: Date.now(), wordsAt: Date.now() } })
  ctx._disarmStartWatch()
  assert.strictEqual(stage.length, 0)
})

// ── A slow catalog fetch says so ───────────────────────────────────────────
// The detail page showed a bare skeleton for as long as the fetch took, and
// said nothing. Usually that is a second or two. But the catalog lane is
// strictly first-come — a page opened while the app is still filling its
// shelves waits behind them — and a single rate-limit refusal makes the lane
// hold everything for as long as the service asks. Observed once on a cold
// start: 22 s, and then a failure. Intermittent, and I could not reproduce it
// on demand, so this does not claim a cause — it fixes the part that is wrong
// in every version of it, which is a screen that never changes reading as
// "not loading".
test('the detail skeleton carries somewhere to say what it is waiting on', () => {
  const at = RENDERER.indexOf("setContent('<div class=\"page\"><div class=\"skeleton skeleton-card\" style=\"height:280px\">")
  assert.ok(at > 0, 'found the detail skeleton')
  const block = RENDERER.slice(at, at + 2200)
  assert.match(block, /id="vdet-waiting" hidden/, 'the element ships hidden with the skeleton')
  assert.match(block, /Still fetching this title/, 'a first word after a few seconds')
  assert.match(block, /limits how often it answers/, 'and an explanation if it drags on')
  // Both timers must be cleared, or a slow page that has already rendered
  // still paints "still fetching" over the finished article.
  assert.match(block, /waitTimers\.forEach\(clearTimeout\)/)
  // And nothing may paint into a page the viewer has already left.
  assert.match(block, /if \(_videoDetailTicket !== ticket\) return/)
})
