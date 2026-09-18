'use strict'
// Five follow-ups from an adversarial review of the 17–18 Sep work.
//
// Two of them are about fixes that shipped with green tests and did not do
// what they said: the anime-episodes handler became honest at the wire while
// the screen showed the same nothing, and a browse fingerprint was moved onto
// the main thread under a comment claiming ~11 ms that measures at 95–183 ms.
// The tests here execute the real code where it can be lifted, and where a
// property is about source ORDER they say so.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(ROOT, 'src', 'slsk-shop-ui.js'), 'utf8')
const dlSched = require('../src/download-scheduler.js')
const SH = require('../src/slsk-shelves.js')

const stripComments = s => s.replace(/^[ \t]*\/\/.*$/gm, '')

// ── 1. A failed episode fetch is SAID on screen ─────────────────────────────

function liftEpisodesBlock() {
  const start = RENDERER.indexOf("const list = document.getElementById('video-episode-list')\n      const EL = typeof PapaEpisodeList")
  assert.ok(start > -1, 'the episode-titles block must still exist')
  const end = RENDERER.indexOf('const byN = {}', start)
  return RENDERER.slice(start, end)
}

function runEpisodes(res) {
  const list = { html: [], removed: 0, querySelector: () => null,
    insertAdjacentHTML(_, h) { this.html.push(h) } }
  const ctx = vm.createContext({
    res, document: { getElementById: id => (id === 'video-episode-list' ? list : null) },
    PapaEpisodeList: { rows: () => [] },
    esc: s => String(s), _shortQ: (s, n) => String(s).slice(0, n), Array,
  })
  let returned = false
  try { vm.runInContext('(function(){' + liftEpisodesBlock() + '\n})()', ctx) } catch (e) { throw e }
  return { list }
}

test('a FAILED fetch paints a note into the episode list instead of returning silently', () => {
  const { list } = runEpisodes({ ok: false, failed: true, episodes: [], error: 'ECONNRESET' })
  assert.strictEqual(list.html.length, 1, 'exactly one note is added')
  assert.match(list.html[0], /could not be fetched/)
  assert.match(list.html[0], /ECONNRESET/, 'the reason rides along')
  assert.match(list.html[0], /vep-note-failed/)
})

test('a genuinely EMPTY answer still paints nothing — that is not a failure', () => {
  const { list } = runEpisodes({ ok: true, episodes: [] })
  assert.deepStrictEqual(list.html, [])
})

test('a null answer (renderer-side catch) paints nothing and does not throw', () => {
  const { list } = runEpisodes(null)
  assert.deepStrictEqual(list.html, [])
})

// ── 2. The browse fingerprint is off the reply path ─────────────────────────

test('slsk-browse-begin does not compute a fingerprint on the reply path', () => {
  const at = MAIN.indexOf('function _browseHead(')
  assert.ok(at > -1)
  const body = stripComments(MAIN.slice(at, MAIN.indexOf('\n}', at)))
  assert.doesNotMatch(body, /fingerprintBrowse\b|fingerprintBrowseChunked/,
    'hashing here blocks the main thread for ~100-180 ms on every shop open')
})

test('the background hash yields with setImmediate, not a browser primitive', () => {
  const at = MAIN.indexOf('function _browseSessionOpen(')
  const body = stripComments(MAIN.slice(at, MAIN.indexOf('\n}', at)))
  assert.match(body, /fingerprintBrowseChunked/)
  assert.match(body, /setImmediate/, 'main has no requestIdleCallback; the yield must be Node-safe')
  assert.doesNotMatch(body, /await slskShelves\.fingerprint/, 'and the open must not wait for it')
})

test('slsk-browse-end hands the fingerprint back', () => {
  const at = MAIN.indexOf("ipcMain.handle('slsk-browse-end'")
  const body = stripComments(MAIN.slice(at, MAIN.indexOf('\n})', at)))
  assert.match(body, /fingerprint/)
})

test('the chunked hash really does run in a bare Node context with that yield', async () => {
  // Executes the real function the way main now calls it.
  const dirs = []
  for (let d = 0; d < 400; d++) dirs.push({ name: 'A\\B' + d, files: [{ filename: 'A\\B' + d + '\\01.flac', size: 1 }] })
  const fp = await SH.fingerprintBrowseChunked(dirs, { budgetMs: 1, yieldFn: () => new Promise(r => setImmediate(r)) })
  assert.ok(typeof fp === 'string' && fp.length > 3)
  assert.strictEqual(fp, SH.fingerprintBrowse(dirs), 'chunked and one-shot must agree')
})

// ── 3. The hunt refuses loudly when it cannot identify the file ─────────────

test('sameRecordingSize with an unknown wanted size is false — the premise', () => {
  assert.strictEqual(dlSched.sameRecordingSize(0, 5e7), false)
  assert.strictEqual(dlSched.sameRecordingSize(null, 5e7), false)
})

test('dlSearchAlbum with no wanted size logs a refusal and issues NO search', async () => {
  const start = MAIN.indexOf('async function dlSearchAlbum(')
  const end = MAIN.indexOf('\n}', start) + 2
  const fetches = []
  const logged = []
  const fn = new Function('slskdFetch', 'dlSched', 'dlState', 'console', 'dlBaseName', `
    ${MAIN.slice(start, end)}
    return dlSearchAlbum
  `)(
    async (...a) => { fetches.push(a); return { id: 'x' } },
    { ...dlSched, logSubstitution: (_, e) => logged.push(e) },
    {}, { warn() {}, error() {} }, p => String(p).split(/[\\/]/).pop(),
  )
  const out = await fn('some album name', ['01 - Intro.flac'], 0)
  assert.deepStrictEqual(out, [])
  assert.strictEqual(fetches.length, 0, 'must not spend a 15-second slskd search that cannot succeed')
  assert.strictEqual(logged.length, 1)
  assert.match(logged[0].reason, /no known size/)
  assert.strictEqual(logged[0].accepted, false)
})

// ── 4. The On Device action guards its re-render ────────────────────────────

test('_deviceAction does not dereference a missing #vrows', () => {
  const at = RENDERER.indexOf('function _deviceAction(')
  const body = stripComments(RENDERER.slice(at, RENDERER.indexOf('\n}', at)))
  assert.match(body, /const rows = document\.getElementById\('vrows'\)/)
  assert.match(body, /if \(rows\) _renderDeviceTab\(rows/)
  assert.doesNotMatch(body, /_renderDeviceTab\(document\.getElementById\('vrows'\)/,
    'passing the lookup straight in was an unhandled rejection after navigating away')
})

// ── 5. The refresh listener exists before the pull starts ───────────────────

test('the shop subscribes to slsk-browse-refreshed BEFORE it begins the pull', () => {
  // A source-order property, stated as one. The pull takes seconds; a refresh
  // landing with no listener leaves stale data on screen for a whole cycle.
  const sub = SHOP.indexOf('onSlskBrowseRefreshed(async')
  const begin = SHOP.indexOf('slskBrowseBegin({ username })')
  assert.ok(sub > -1 && begin > -1)
  assert.ok(sub < begin, `subscription at ${sub} must precede the pull at ${begin}`)
})

test('the shop takes the fingerprint from end, and no longer hashes the payload itself on the streaming path', () => {
  const a = SHOP.indexOf('const streaming = !!(window.api.slskBrowseBegin')
  const b = SHOP.indexOf('tree = tb.finish()', a)
  const pull = stripComments(SHOP.slice(a, b))
  assert.match(pull, /slskBrowseEnd\(\{ token: res\.token \}\)/)
  assert.match(pull, /done\.fingerprint/)
  assert.doesNotMatch(pull, /fingerprintBrowseChunked/, 'the renderer no longer has the payload; it must not hash')
})
