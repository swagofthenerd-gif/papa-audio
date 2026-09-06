'use strict'
// App #34 — editable source-mirror lists. Two halves:
//   1. The pure parse/format helpers in video-format.js, run for real.
//   2. Source-shape assertions on main.js/renderer.js/index.html/preload for the
//      wiring, the same way video-ipc.test.js pins main (it cannot be required
//      outside Electron).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { parseMirrorList, formatMirrorList } = require('../src/video-format')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const RENDERER = root('src/renderer.js')
const HTML = root('src/index.html')

function handlerBody(name) {
  const start = MAIN.indexOf(`ipcMain.handle('${name}'`)
  assert.ok(start > -1, `${name} handler not found`)
  const end = MAIN.indexOf('ipcMain.handle', start + 1)
  return MAIN.slice(start, end === -1 ? MAIN.length : end)
}

// ── The pure helpers ────────────────────────────────────────────────────────

test('parseMirrorList splits on commas and newlines and trims', () => {
  assert.deepStrictEqual(
    parseMirrorList('https://a.example ,  https://b.example\nhttps://c.example'),
    ['https://a.example', 'https://b.example', 'https://c.example'])
})

test('parseMirrorList drops blanks and non-URLs', () => {
  assert.deepStrictEqual(
    parseMirrorList('https://ok.example,, not-a-url ,\n\nftp://nope.example'),
    ['https://ok.example'])
})

test('parseMirrorList de-duplicates while keeping order', () => {
  assert.deepStrictEqual(
    parseMirrorList('https://a.example\nhttps://b.example\nhttps://a.example'),
    ['https://a.example', 'https://b.example'])
})

test('parseMirrorList strips trailing slashes so a mirror is not stored twice', () => {
  assert.deepStrictEqual(
    parseMirrorList('https://a.example/,https://a.example'),
    ['https://a.example'])
})

test('parseMirrorList of nothing is an empty list, never a crash', () => {
  assert.deepStrictEqual(parseMirrorList(null), [])
  assert.deepStrictEqual(parseMirrorList(''), [])
  assert.deepStrictEqual(parseMirrorList('   \n , '), [])
})

test('formatMirrorList round-trips through parseMirrorList', () => {
  const list = ['https://a.example', 'https://b.example']
  assert.strictEqual(formatMirrorList(list), 'https://a.example\nhttps://b.example')
  assert.deepStrictEqual(parseMirrorList(formatMirrorList(list)), list)
})

test('formatMirrorList of a non-array is an empty field, not "null"', () => {
  assert.strictEqual(formatMirrorList(null), '')
  assert.strictEqual(formatMirrorList(undefined), '')
  assert.strictEqual(formatMirrorList('https://x'), '')
})

// ── main.js wiring ──────────────────────────────────────────────────────────

test('sourceMirrors is a video-setting default, empty per provider', () => {
  const start = MAIN.indexOf('function _videoSettings()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /sourceMirrors: \{ yts: \[\], eztv: \[\], nyaa: \[\], apibay: \[\] \}/)
})

test('sourceMirrors is on the write whitelist', () => {
  const start = MAIN.indexOf('const VIDEO_SETTING_KEYS = new Set([')
  const set = MAIN.slice(start, MAIN.indexOf('])', start))
  assert.match(set, /'sourceMirrors'/)
})

test('the four mirror-capable providers are built with baseUrls from the setting', () => {
  for (const name of ['yts', 'eztv', 'nyaa', 'apibay']) {
    const re = new RegExp(`create${name === 'apibay' ? 'Apibay' : name[0].toUpperCase() + name.slice(1)}Provider\\(\\{[^}]*baseUrls: _mirrorsFor\\('${name}'\\)`)
    assert.match(MAIN, re, `${name} is not built with its mirror list`)
  }
})

test('_mirrorsFor returns undefined for an empty list so the provider keeps its defaults', () => {
  const start = MAIN.indexOf('function _mirrorsFor(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  // An empty or non-array list falls back to the built-in defaults (undefined).
  assert.match(body, /if \(!Array\.isArray\(list\)\) return undefined/)
  assert.match(body, /clean\.length \? clean : undefined/)
})

test('_lazy exposes a reset so a memoised singleton can be rebuilt', () => {
  const start = MAIN.indexOf('function _lazy(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /get\.reset = \(\) => \{ value = undefined \}/)
})

test('changing sourceMirrors rebuilds the providers and clears the stream cache', () => {
  const body = handlerBody('video-settings-set')
  assert.match(body, /JSON\.stringify\(next\.sourceMirrors\) !== JSON\.stringify\(current\.sourceMirrors\)/)
  assert.match(body, /_rebuildMirrorProviders\(\)/)
  // The stream cache holds results from the old mirrors and must be dropped.
  const at = body.indexOf('_rebuildMirrorProviders()')
  assert.match(body.slice(at, at + 120), /_videoStreamCache\.clear\(\)/)
})

test('_rebuildMirrorProviders resets exactly the four mirror-capable singletons', () => {
  const start = MAIN.indexOf('const _mirrorProviders = [')
  const decl = MAIN.slice(start, MAIN.indexOf(']', start))
  assert.match(decl, /yts, eztv, nyaa, apibay/)
  const fn = MAIN.slice(MAIN.indexOf('function _rebuildMirrorProviders()'),
    MAIN.indexOf('function _rebuildMirrorProviders()') + 160)
  assert.match(fn, /for \(const p of _mirrorProviders\) p\.reset\(\)/)
})

// ── Renderer + HTML wiring ──────────────────────────────────────────────────

test('the settings HTML carries a mirror field per provider plus a reset', () => {
  for (const name of ['yts', 'eztv', 'nyaa', 'apibay']) {
    assert.match(HTML, new RegExp(`id="video-mirror-${name}"`), `no field for ${name}`)
  }
  assert.match(HTML, /id="video-mirrors-reset"/)
  assert.match(HTML, /<details class="mcs-set-details" id="video-mirrors">/)
})

test('the renderer fills the fields from the stored lists and saves the whole blob', () => {
  const at = RENDERER.indexOf('function _initMirrorFields(')
  assert.ok(at > -1, '_initMirrorFields must exist')
  const body = RENDERER.slice(at, RENDERER.indexOf('\n}\n', at + 100))
  assert.match(body, /formatMirrorList\(stored\[name\]\)/, 'the field is filled from the stored list')
  assert.match(body, /parseMirrorList\(input\.value\)/, 'the parsed list is what gets saved')
  assert.match(body, /save\(\{ sourceMirrors: collect\(\) \}\)/, 'the whole map is written, not one key')
})

test('the mirror reset writes an empty list for every provider', () => {
  const at = RENDERER.indexOf('function _initMirrorFields(')
  const body = RENDERER.slice(at, RENDERER.indexOf('\n}\n', at + 100))
  assert.match(body, /cleared\[name\] = \[\]/)
  assert.match(body, /save\(\{ sourceMirrors: cleared \}\)/)
})
