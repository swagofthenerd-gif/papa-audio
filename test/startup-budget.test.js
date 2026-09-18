'use strict'
// A startup budget, in the same spirit as test/soak-probe.test.js: a static
// number recorded at commit time so that unnoticed growth trips a test instead
// of quietly making the app slower to start.
//
// Two things dominate how long the app takes to become usable:
//   1. The renderer parses every <script> in index.html synchronously before it
//      can paint. That cost is roughly the total byte size of those files.
//   2. The main process runs every top-level `require(...)` in main.js before it
//      can even create a window. Each require drags in a module tree.
//
// Neither is measured here as time — wall-clock is noisy and machine-dependent.
// What is measured is the input to the time: bytes to parse, modules to load.
// Both are compared against a recorded ceiling set generously above today's
// value.
//
// The contract, stated once so nobody has to reverse-engineer it:
//   Growth is fine. Doubling unnoticed is not. The ceiling sits ~15% above the
//   current figure — enough headroom that ordinary feature work does not trip
//   it, tight enough that a script or a require-tree quietly doubling in size
//   does. When you legitimately cross a ceiling, RAISE it in one deliberate
//   commit and say why, the same way test/soak-probe.test.js asks you to update
//   a listener budget when you add a global listener. Bumping the number is the
//   moment to ask whether the growth was meant.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

// ── the synchronous script-parse budget ────────────────────────────────────

// Every <script src="..."> in index.html is a file the renderer must fetch and
// parse before first paint. index.html loads them without defer/async, so the
// sum of their byte sizes is the synchronous parse cost.
function syncScriptBytes () {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  let total = 0
  const missing = []
  for (const rel of scripts) {
    const p = path.join(ROOT, 'src', rel)
    try { total += fs.statSync(p).size } catch (_) { missing.push(rel) }
  }
  return { total, count: scripts.length, missing }
}

// Recorded 2026-09-04: 30 scripts, 1,403,855 bytes. Ceiling ~15% above.
// If this trips, either a script grew a lot or one was added — decide whether
// that was intended, then raise this number in a commit that says so.
// Raised 2026-09-05: waves 6-10 added music-tools, home-recap, diary-timeline,
// loudness, thumbnailer glue and the light-theme/settings growth — deliberate
// feature work, re-based with ~15% headroom over the new measured total.
// Raised 2026-09-06: Wave-1 UI (crash restore, keep-going, waveform hover, long-track bookmarks, save-queue-as-playlist, undo audit) grew renderer.js — re-based ~15% above the new measured total.
// 2026-09-06 (roadmap #62 structural split, half A): began carving renderer.js
// into per-region <script> files. Wrapped moved to wrapped-ui.js and the Soulseek
// shop moved to slsk-shop-ui.js. This shuffles bytes between files and adds a
// little per-file wrapper/comment overhead, but the SYNCHRONOUS TOTAL is what the
// budget measures and it stays under the ceiling (renderer.js shrinks by roughly
// what the new files gain). The ceiling is unchanged — the split did not grow the
// total past it, so there is nothing to re-base.
// Raised 2026-09-07 (search overhaul): added three shared pure modules —
// smart-query.js (tokenizer/scorer/vocabulary corrector), library-index.js (the
// in-memory instant-search index) and yt-suggest-model.js (suggestion debounce +
// speculative-prefetch logic) — plus the renderer wiring for instant library
// search, YouTube autocomplete and Soulseek spelling correction. Deliberate
// feature work; re-based ~15% above the new measured total.
// Raised 2026-09-12 (video plan V1–V4): the smooth player and its pure modules
// — web-player.js (Media Source engine), mini-motion.js, watch-rules.js,
// release-name.js, episode-list.js and start-honesty.js (the start-up failure
// table and stuck-picture words) — plus the theatre and mini-card wiring in
// renderer.js and video-player.js. Deliberate feature work; the old ceiling had
// been reached to within 0.4 % before the last file. Re-based ~15% above the
// new measured total (2,539,444).
// Raised 2026-09-19 (live music-tab audit fixes): the Library empty-state scope
// fix, the crossfade rewiring, the bit-perfect dependent-control painter, the
// Stats totals split, the connectivity asymmetry, the Manage → Health progress
// paint and the artwork miss memory — plus their explanatory comments, which
// are most of the bytes. The previous ceiling had ~0.1 % left, so this is a
// re-base rather than a raise for one change; ~2 % above the new measured total
// (2,930,230).
const SCRIPT_BYTE_CEILING = 2990000

test('the renderer loads its scripts and none is missing from disk', () => {
  const { count, missing } = syncScriptBytes()
  assert.deepStrictEqual(missing, [], 'index.html references a script that is not on disk')
  // A sanity floor: if this suddenly reads a handful of scripts the regex broke.
  assert.ok(count > 10, 'expected the full script list, found ' + count)
})

test('the synchronous script-parse budget stays under its recorded ceiling', () => {
  const { total } = syncScriptBytes()
  assert.ok(
    total <= SCRIPT_BYTE_CEILING,
    `scripts loaded synchronously by index.html total ${total} bytes, over the ` +
    `recorded ceiling of ${SCRIPT_BYTE_CEILING}. Growth is fine; an unnoticed ` +
    `doubling is not. If this growth was intended, raise SCRIPT_BYTE_CEILING in ` +
    `test/startup-budget.test.js and say why.`
  )
})

test('the script budget has real headroom, so ordinary work does not trip it', () => {
  // Guards against the ceiling being accidentally set at or below the current
  // value, which would make the budget fire on the very next byte added.
  const { total } = syncScriptBytes()
  assert.ok(SCRIPT_BYTE_CEILING > total,
    'the ceiling must sit above the current size, or the budget has no headroom')
})

// ── the main-process require budget ────────────────────────────────────────

// Every top-level `const x = require('...')` in main.js runs before the app can
// create a window. Counting them is a proxy for the module-load cost at
// startup: each one loads and executes a module tree synchronously. A require
// moved off the hot path (required lazily inside the handler that needs it)
// drops out of this count, which is exactly the change this budget is meant to
// encourage when the number gets uncomfortable.
function topLevelRequireCount () {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  let n = 0
  for (const line of src.split('\n')) {
    // Column-zero assignment form: `const/let/var ... = require(`. Indented
    // requires (inside functions, i.e. lazy loads) are deliberately excluded —
    // they are not paid at startup. A bare top-level `require('x')` for side
    // effects is caught too.
    if (/^(const|let|var)[^=]*=[^=]*\brequire\(/.test(line)) { n++; continue }
    if (/^require\(/.test(line)) n++
  }
  return n
}

// Recorded 2026-09-04: 60 top-level requires in main.js. Ceiling ~15% above.
// Raised 2026-09-06 to 74: the Wave 1 backend added four tiny pure-logic
// modules required at startup (dead-magnet, watch-debounce, backup-schedule,
// search-history) — each is a handful of pure functions with no I/O at import,
// so the startup cost is negligible, but the ceiling moves deliberately, not
// incidentally, per the contract below.
// Raised 2026-09-06 to 78: the Wave 4 backend added three more pure-logic
// modules required at startup (debrid, track-memory, memory-watchdog) — same
// shape, no I/O at import, negligible startup cost — plus a little headroom.
// Raised 2026-09-07 to 94: the self-maintenance suite added five pure-logic
// modules required at startup (slskd-updater, tracker-list, source-health,
// sysdeps-advisor, app-update-check). Each is pure policy + an exec layer that
// only runs later behind a throttled scheduler, so nothing does I/O at import;
// the startup cost is negligible. Re-based ~15% above the new measured total (82).
// Re-based 2026-09-17 to 108: the count had crept from the measured 82 of the
// last re-base to 94 -- the audio-overhaul run added pure-logic modules at a
// steady rate (album-grouping, anime-upscale, anime-numbering, store-migration
// and others), each a handful of pure functions with no I/O at import. The
// ceiling moves deliberately, ~15% above the new measured total, per the
// contract below. Worth a look on its own though: twelve new startup requires
// since 07 Sep is a trend, not an incident, and the next re-base should be a
// decision about what belongs at startup rather than another arithmetic bump.
const REQUIRE_CEILING = 108

test('main.js top-level require count stays under its recorded ceiling', () => {
  const n = topLevelRequireCount()
  // A floor too: if this reads near zero the regex stopped matching and the
  // budget would pass while measuring nothing — the soak harness's "a run that
  // measured nothing is not a run that found nothing wrong" applied here.
  assert.ok(n > 20, 'expected to find the top-level requires, counted ' + n)
  assert.ok(
    n <= REQUIRE_CEILING,
    `main.js has ${n} top-level requires, over the recorded ceiling of ` +
    `${REQUIRE_CEILING}. Each runs before the first window can open. If a new ` +
    `require is genuinely needed at startup, raise REQUIRE_CEILING in ` +
    `test/startup-budget.test.js; otherwise consider requiring it lazily inside ` +
    `the handler that uses it.`
  )
})

test('the require budget has headroom', () => {
  const n = topLevelRequireCount()
  assert.ok(REQUIRE_CEILING > n,
    'the require ceiling must sit above the current count, or it has no headroom')
})
