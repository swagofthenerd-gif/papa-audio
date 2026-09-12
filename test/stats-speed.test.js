'use strict'
// Roadmap S4: the stats page's achievement checks rescanned the whole library
// for every play in the window (~240 ms per range-chip click, measured).
// They read one filePath → album/track lookup built once per render.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const at = RENDERER.indexOf('function renderStats()')
const body = RENDERER.slice(at, RENDERER.indexOf('\nfunction ', at + 10))

test('the achievement checks use the one lookup and never loop the library per play', () => {
  assert.match(body, /var _where = new Map\(\)/)
  assert.match(body, /var _hit = function \(p\) \{ return _where\.get\(p\.filePath\) \|\| null \}/)
  const checks = body.slice(body.indexOf('var achievements = ['))
  assert.doesNotMatch(checks, /recent\.(forEach|some|filter)\([^\n]*?state\.library\.length/, 'no library scan inside a per-play loop')
  assert.doesNotMatch(checks, /state\.library\.find\(/, 'no linear album find per id')
  for (const id of ['century', 'completist', 'variety', 'throwback', 'globetrotter', 'diversegenre', 'longesttrack', 'shortesttrack']) {
    const line = checks.split('\n').find(l => l.includes("id:'" + id + "'"))
    assert.ok(line && /_hit\(p\)/.test(line), id + ' reads the lookup')
  }
})

// Roadmap S5, the Movies tab: every rail's first arrow/fade sync read layout
// right after the previous rail's write, forcing a full layout per rail.
test('rail syncs are batched: all reads in one frame, then all writes', () => {
  const at2 = RENDERER.indexOf('function _bindRail(rail)')
  const rail = RENDERER.slice(at2, RENDERER.indexOf('\nfunction ', at2 + 10))
  assert.match(rail, /const read = function \(\) \{\n\s+return \{ left: rail\.scrollLeft, max: rail\.scrollWidth - rail\.clientWidth \}/)
  assert.match(rail, /_scheduleRailSync\(\{ rail: rail, read: read, write: write \}\)/)
  assert.doesNotMatch(rail, /requestAnimationFrame\(sync\)/)
  const atP = RENDERER.indexOf('function _railSyncPass()')
  const pass = RENDERER.slice(atP, RENDERER.indexOf('\nif (typeof document', atP))
  assert.match(pass, /const box = rail \? \(rail\.closest\('\.vrow'\) \|\| rail\) : null/, 'nearness is judged on the row, whose box exists while its contents are skipped')
  assert.match(pass, /if \(r\.bottom < -300 \|\| r\.top > vh \+ 300\) return true/, 'a rail far from the screen stays pending')
  assert.match(pass, /const measured = due\.map\(function \(j\) \{ try \{ return j\.read\(\) \}/)
  assert.match(pass, /due\.forEach\(function \(j, i\) \{ if \(measured\[i\]\) \{ try \{ j\.write\(measured\[i\]\) \}/)
  assert.match(RENDERER, /document\.addEventListener\('scroll', _railSyncSoon, \{ capture: true, passive: true \}\)/, 'scrolling any scroller wakes the pending rails')
})
