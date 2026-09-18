'use strict'
// Manage → Health must not show a bare "Scanning the library…" for 50 seconds.
//
// It did — one line, no progress, no numbers — while the Overview tab one click
// away was already showing "88/100 · 5 findings" from the same cached result.
// The page had the answer and would not say it, and there was nothing on screen
// to tell a slow scan from a hung one.
//
// Two fixes. The findings already known are painted at once, labelled as still
// being re-checked, so the tab is useful from the first frame; and the folder
// walk in main reports where it has got to on library-extras-progress, so the
// wait is visibly a wait.
//
// The card builder is lifted and run for real; the walk's progress emission is
// driven against a fake clock and a recording send.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(')
  assert.ok(start > -1, name + ' must still exist as a top-level function in renderer.js')
  const a = SRC.indexOf('\nfunction ', start + 1)
  const b = SRC.indexOf('\nasync function ', start + 1)
  const stop = [a, b].filter(n => n > -1).sort((x, y) => x - y)[0]
  return SRC.slice(start, stop === undefined ? undefined : stop)
}

const ctx = vm.createContext({ Array, Object, Number, Math, String, console })
vm.runInContext(`
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
  function _mgBaseName(p) { return String(p || '').split('/').pop() }
  function _mgFmtBytes(n) { return String(n) + ' B' }
` + lift('_mgHealthFindingsHtml') + lift('_mgHealthScanningHtml'), ctx)

const call = (fn, arg) => { ctx.__x = arg; return vm.runInContext(fn + '(__x)', ctx) }
const cards = (findings, relink) => {
  ctx.__f = findings; ctx.__r = relink || ''
  return vm.runInContext('_mgHealthFindingsHtml(__f, __r)', ctx)
}

const FINDINGS = [
  { id: 'stray', severity: 'low', title: 'Stray files', detail: 'Not music.',
    count: 3, bytes: 900, paths: ['/m/a.txt', '/m/b.nfo', '/m/c.log'] },
  { id: 'notags', severity: 'med', title: 'Albums with no year', detail: 'Tags missing.',
    count: 1, paths: [], items: [{ id: 'al1', label: 'Kid A', path: '/m/Kid A' }] },
]

test('the findings already known are painted, not withheld', () => {
  const html = cards(FINDINGS, '')
  assert.match(html, /Stray files/)
  assert.match(html, /Albums with no year/)
  assert.match(html, /data-album-open="al1"/, 'and they are still clickable')
})

test('the scanning line says the scan is still running, and is not an error', () => {
  const html = call('_mgHealthScanningHtml', null)
  assert.match(html, /Still checking/i)
  assert.match(html, /id="mg-health-scanning"/, 'so the progress can be updated in place')
  assert.doesNotMatch(html, /failed|error/i, 'a scan in progress is not a failure')
})

test('and it shows how far the scan has got once it knows', () => {
  const html = call('_mgHealthScanningHtml', { dirs: 1234, files: 7, path: '/mnt/data/MUSIC/Radiohead' })
  assert.match(html, /1,234 folders checked/)
  assert.match(html, /Radiohead/, 'the folder it is in right now, not the whole path')
  assert.doesNotMatch(html, /\/mnt\/data\/MUSIC\/Radiohead/, 'a full path would wrap the line')
})

test('with nothing cached it says so plainly instead of pretending', () => {
  const health = SRC.slice(SRC.indexOf('async function renderManageHealth('))
    .slice(0, 2200)
  assert.match(health, /_mgCacheGet\('health'\)/,
    'the tab must read what the Overview card is already showing')
  assert.match(health, /details still scanning/,
    'and label the cached findings honestly while they are re-checked')
  assert.match(health, /first scan/, 'and say when there is genuinely nothing yet')
  assert.doesNotMatch(health.slice(0, 400), /mg-empty">Scanning the library/,
    'the bare one-line spinner must be gone')
})

test('the progress subscription is dropped when the scan finishes', () => {
  // A subscription per visit, never released, is how a Manage tab turns into a
  // slow leak — and a late progress message would overwrite the results.
  const health = SRC.slice(SRC.indexOf('async function renderManageHealth('))
    .slice(0, 3000)
  assert.match(health, /library-extras-progress/)
  assert.match(health, /_stopProgress\(\)/)
  assert.match(health, /_mgState\.tab !== _tabAtStart \|\| state\.currentPage !== 'manage'/,
    'and a message arriving after you have left the tab is ignored')
})

test('one builder feeds both the early paint and the final one', () => {
  // If they diverge, the cards jump around when the scan lands.
  const health = SRC.slice(SRC.indexOf('async function renderManageHealth('))
    .slice(0, 6000)
  const uses = [...health.matchAll(/_mgHealthFindingsHtml\(/g)]
  assert.strictEqual(uses.length, 2, 'the instant paint and the final paint, and nothing else')
})

// ── the main-process side ───────────────────────────────────────────────────

// The walk's progress emitter, run against a fake clock.
function liftNoteWalk() {
  const start = MAIN.indexOf('  let _walkedDirs = 0')
  assert.ok(start > -1, 'the extras-scan progress counter must still exist in main.js')
  const end = MAIN.indexOf('  const walk = async (dir) => {', start)
  assert.ok(end > start)
  const sent = []
  // A real clock is a big number; starting at 0 would make the first call look
  // like it had just sent one.
  let now = 1.7e12
  const ctx2 = vm.createContext({
    Date: { now: () => now },
    safeSend: (ch, payload) => sent.push({ ch, payload }),
    nonAudio: [],
  })
  vm.runInContext(MAIN.slice(start, end), ctx2)
  return {
    sent,
    tick: ms => { now += ms },
    walk: dir => { ctx2.__d = dir; vm.runInContext('_noteWalk(__d)', ctx2) },
  }
}

test('the walk reports where it has got to', () => {
  const w = liftNoteWalk()
  w.walk('/m/one')
  assert.strictEqual(w.sent.length, 1)
  assert.strictEqual(w.sent[0].ch, 'library-extras-progress')
  assert.strictEqual(w.sent[0].payload.dirs, 1)
  assert.strictEqual(w.sent[0].payload.path, '/m/one')
})

test('but a deep tree cannot flood the renderer with them', () => {
  // Thousands of folders in a second must not become thousands of messages.
  const w = liftNoteWalk()
  for (let i = 0; i < 500; i++) w.walk('/m/d' + i)
  assert.strictEqual(w.sent.length, 1, 'at most one message per throttle window')
  w.tick(401)
  w.walk('/m/later')
  assert.strictEqual(w.sent.length, 2)
  assert.strictEqual(w.sent[1].payload.dirs, 501, 'and the count is the real one, not the sent one')
})

test('the channel the renderer listens on is the one main sends, and is allowed', () => {
  assert.match(MAIN, /safeSend\('library-extras-progress'/)
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  const allowed = PRE.slice(PRE.indexOf('const allowed = ['), PRE.indexOf('const allowed = [') + 2500)
  assert.match(allowed, /'library-extras-progress'/,
    'an un-allowlisted channel is silently dropped by the bridge')
})
