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
const SCRIPT_BYTE_CEILING = 1864365

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
// Same contract as the byte budget: raise it deliberately, not incidentally.
const REQUIRE_CEILING = 69

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
