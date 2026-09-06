'use strict'
// The source canary, tested where it can be tested: the pure table formatting
// and summary. The probes themselves hit live third parties and must never run
// in CI — a test that depends on nyaa.si being up is a test that fails for
// reasons that have nothing to do with this repo. So these tests feed
// fabricated probe results into formatTable / summaryLine and assert the shape,
// exactly the split the file draws with its "pure formatting above this line"
// comment.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const canary = require(path.join(__dirname, '..', 'tools', 'source-canary.js'))

// A representative mix: one up-with-hits, one up-but-empty, one down, one
// skipped. Every branch of statusCell / msCell is exercised.
function sampleResults () {
  return [
    { name: 'tmdb', family: 'catalog/movie-tv', ok: false, skipped: true, ms: null, note: 'no TMDB key' },
    { name: 'anilist', family: 'catalog/anime', ok: true, skipped: false, ms: 412, note: '20 results' },
    { name: 'yts', family: 'torrent/movie', ok: true, skipped: false, ms: 890, note: '5 results' },
    { name: 'nyaa', family: 'torrent/anime', ok: true, skipped: false, ms: 1200, note: 'reachable, no match' },
    { name: 'eztv', family: 'torrent/tv', ok: false, skipped: false, ms: 8000, note: 'timeout >8s' },
  ]
}

test('the module exposes only pure helpers, no live probes', () => {
  // Requiring the file must not touch the network or spawn anything. If a probe
  // leaked above the fold this require would try to fetch on load.
  assert.strictEqual(typeof canary.formatTable, 'function')
  assert.strictEqual(typeof canary.summaryLine, 'function')
  assert.strictEqual(typeof canary.statusCell, 'function')
  assert.strictEqual(typeof canary.msCell, 'function')
  assert.strictEqual(typeof canary.TIMEOUT_MS, 'number')
})

test('the timeout is 8 seconds, as the spec requires', () => {
  assert.strictEqual(canary.TIMEOUT_MS, 8000)
})

test('statusCell maps the three states to UP / DOWN / SKIP', () => {
  assert.strictEqual(canary.statusCell({ ok: true, skipped: false }), 'UP')
  assert.strictEqual(canary.statusCell({ ok: false, skipped: false }), 'DOWN')
  // A skip wins over ok=false: a skipped row is grey, not red.
  assert.strictEqual(canary.statusCell({ ok: false, skipped: true }), 'SKIP')
})

test('msCell shows a rounded millisecond figure, or a dash when there is none', () => {
  assert.strictEqual(canary.msCell({ skipped: false, ms: 412.7 }), '413ms')
  assert.strictEqual(canary.msCell({ skipped: true, ms: null }), '—')
  assert.strictEqual(canary.msCell({ skipped: false, ms: null }), '—')
})

test('formatTable renders one line per source plus a header and a rule', () => {
  const rows = sampleResults()
  const table = canary.formatTable(rows)
  const lines = table.split('\n')
  // header + rule + one per row.
  assert.strictEqual(lines.length, rows.length + 2)
  assert.match(lines[0], /FAMILY/)
  assert.match(lines[0], /SOURCE/)
  assert.match(lines[0], /STATUS/)
  assert.match(lines[0], /LATENCY/)
  // The rule is drawn from box-drawing dashes.
  assert.match(lines[1], /^─+$/)
})

test('every source name and its status word appear in the table', () => {
  const table = canary.formatTable(sampleResults())
  assert.match(table, /anilist/)
  assert.match(table, /nyaa/)
  assert.match(table, /\bUP\b/)
  assert.match(table, /\bDOWN\b/)
  assert.match(table, /\bSKIP\b/)
  // The status word is plain text, not an ANSI colour code, so it survives a
  // copy-paste into a PR comment — that is the point of using words for colour.
  assert.doesNotMatch(table, /\[/)
})

test('formatTable tolerates an empty result set', () => {
  const table = canary.formatTable([])
  const lines = table.split('\n')
  // Just the header and the rule; no crash on the reduce over widths.
  assert.strictEqual(lines.length, 2)
  assert.match(lines[0], /FAMILY/)
})

test('formatTable columns are aligned to the widest cell', () => {
  const table = canary.formatTable(sampleResults())
  const lines = table.split('\n').slice(2) // drop header + rule
  // Find where the STATUS word starts on each row; alignment means it is the
  // same column on every row.
  const cols = lines.map(l => {
    const m = /\b(UP|DOWN|SKIP)\b/.exec(l)
    return m ? m.index : -1
  })
  assert.ok(cols.every(c => c > 0))
  assert.strictEqual(new Set(cols).size, 1, 'the STATUS column lines up on every row')
})

test('summaryLine counts only attempted sources, never the skipped ones', () => {
  // sampleResults: 3 up (anilist, yts, nyaa), 1 down (eztv), 1 skipped (tmdb).
  const line = canary.summaryLine(sampleResults())
  assert.match(line, /3\/4 sources up/)
  assert.match(line, /1 skipped/)
})

test('summaryLine reports when nothing was attempted', () => {
  const line = canary.summaryLine([
    { name: 'tmdb', skipped: true, ok: false },
    { name: 'omdb', skipped: true, ok: false },
  ])
  assert.match(line, /no sources attempted/)
  assert.match(line, /2 skipped/)
})

test('summaryLine omits the skipped tail when nothing was skipped', () => {
  const line = canary.summaryLine([
    { name: 'yts', ok: true, skipped: false, ms: 100 },
    { name: 'nyaa', ok: true, skipped: false, ms: 200 },
  ])
  assert.match(line, /2\/2 sources up/)
  assert.doesNotMatch(line, /skipped/)
})

test('summaryLine and formatTable handle non-array input without throwing', () => {
  assert.doesNotThrow(() => canary.formatTable(null))
  assert.doesNotThrow(() => canary.summaryLine(undefined))
})

test('the canary script wires up the npm run canary command', () => {
  // The whole point of "npm run canary" is that it exists. Guard the wiring so a
  // package.json edit that drops it is caught here.
  const pkg = require(path.join(__dirname, '..', 'package.json'))
  assert.strictEqual(pkg.scripts.canary, 'node tools/source-canary.js')
})
