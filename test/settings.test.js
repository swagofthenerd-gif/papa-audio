'use strict'
// Runs the settings-panel pure helpers for real, the same way video-render does:
// the renderer is one giant file that cannot be required outside Electron, so
// each function is lifted out by brace-matching and executed in a vm context
// with only the globals it needs. Covers the Wave-6 settings additions —
// download-limit parsing, the settings search filter, and the diagnostics
// markup builders.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in the renderer')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function sandbox() {
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    console,
  }
  vm.createContext(ctx)
  for (const fn of ['_settingsMatchesFilter', '_parseDownloadLimit', '_diagRowsHtml', '_diagMetaHtml',
    '_changelogToHtml']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

// ── Download-limit parsing ───────────────────────────────────────────────────

test('an empty download limit means no cap', () => {
  const { _parseDownloadLimit } = sandbox()
  assert.strictEqual(_parseDownloadLimit(''), null)
  assert.strictEqual(_parseDownloadLimit('   '), null)
  assert.strictEqual(_parseDownloadLimit(null), null)
  assert.strictEqual(_parseDownloadLimit(undefined), null)
})

test('zero or negative never becomes a real cap that throttles to nothing', () => {
  const { _parseDownloadLimit } = sandbox()
  assert.strictEqual(_parseDownloadLimit('0'), null)
  assert.strictEqual(_parseDownloadLimit('-5'), null)
  assert.strictEqual(_parseDownloadLimit('nonsense'), null)
})

test('a positive number becomes a rounded integer of Mbps', () => {
  const { _parseDownloadLimit } = sandbox()
  assert.strictEqual(_parseDownloadLimit('25'), 25)
  assert.strictEqual(_parseDownloadLimit('12.6'), 13)
  assert.strictEqual(_parseDownloadLimit(50), 50)
})

// ── Settings search filter ───────────────────────────────────────────────────

test('an empty query matches every row', () => {
  const { _settingsMatchesFilter } = sandbox()
  assert.strictEqual(_settingsMatchesFilter('Preferred quality', ''), true)
  assert.strictEqual(_settingsMatchesFilter('Anything', '   '), true)
})

test('search is a case-insensitive substring over the label text', () => {
  const { _settingsMatchesFilter } = sandbox()
  assert.strictEqual(_settingsMatchesFilter('Download speed limit', 'SPEED'), true)
  assert.strictEqual(_settingsMatchesFilter('Prefer surround', 'surr'), true)
  assert.strictEqual(_settingsMatchesFilter('TMDB API key', 'opensub'), false)
})

// ── Diagnostics markup ───────────────────────────────────────────────────────

test('a missing diagnostics payload says so instead of throwing', () => {
  const { _diagRowsHtml } = sandbox()
  assert.match(_diagRowsHtml(null), /not available/)
  assert.match(_diagRowsHtml(undefined), /not available/)
})

test('each core check renders a labelled dot with the right colour', () => {
  const { _diagRowsHtml } = sandbox()
  const html = _diagRowsHtml({
    checks: {
      slskd: { ok: true },
      tmdb: { ok: false, detail: 'no key' },
      mpv: { ok: true },
      storage: { ok: true },
    },
  })
  assert.match(html, /Music downloader \(Soulseek\)/)
  assert.match(html, /Movie database \(TMDB\)[\s\S]*no key/)
  assert.match(html, /Player program \(mpv\)/)
  assert.match(html, /Watch-history storage/)
  assert.match(html, /mcs-diag-ok/)  // a passing check
  assert.match(html, /mcs-diag-bad/) // the failing TMDB check
})

test('an unknown check is amber, not a false green', () => {
  const { _diagRowsHtml } = sandbox()
  // storage absent -> unknown state, never rendered as ok.
  const html = _diagRowsHtml({ checks: { slskd: { ok: true } } })
  assert.match(html, /mcs-diag-unknown/)
})

test('per-source health rows render when present', () => {
  const { _diagRowsHtml } = sandbox()
  const html = _diagRowsHtml({
    checks: {},
    sources: [{ name: 'YTS', ok: true }, { name: 'EZTV', ok: false, detail: 'timeout' }],
  })
  assert.match(html, /Video sources/)
  assert.match(html, /YTS/)
  assert.match(html, /EZTV[\s\S]*timeout/)
})

test('diagnostic labels and details are html-escaped', () => {
  const { _diagRowsHtml } = sandbox()
  const html = _diagRowsHtml({
    checks: {},
    sources: [{ name: '<img onerror=alert(1)>', ok: false, detail: '"><b>' }],
  })
  assert.ok(!/<img onerror/.test(html), 'source name escaped')
  assert.ok(!/"><b>/.test(html), 'detail escaped')
})

test('the meta footer lists only the fields the payload actually carries', () => {
  const { _diagMetaHtml } = sandbox()
  assert.strictEqual(_diagMetaHtml(null), '')
  assert.strictEqual(_diagMetaHtml({}), '')
  const html = _diagMetaHtml({ version: '1.0.0', configDir: '/home/x/.config/papa-audio' })
  assert.match(html, /Version 1\.0\.0/)
  assert.match(html, /Config folder: \/home\/x\/\.config\/papa-audio/)
  assert.ok(!/Stream cache/.test(html), 'omitted field is skipped')
})

// ── About & what's new: changelog markdown → html (App §7) ────────────────────

test('the changelog renders headings and bullets, nothing else as markup', () => {
  const { _changelogToHtml } = sandbox()
  const html = _changelogToHtml('# 1.0.0\n- Added stacking toasts\nPlain note.')
  assert.match(html, /<h2 class="mcs-cl-h">1\.0\.0<\/h2>/)
  assert.match(html, /<li>Added stacking toasts<\/li>/)
  assert.match(html, /<p class="mcs-cl-p">Plain note\.<\/p>/)
})

test('the changelog escapes every line — release notes are data, not markup', () => {
  const { _changelogToHtml } = sandbox()
  const html = _changelogToHtml('# <script>alert(1)</script>\n- <img src=x onerror=alert(2)>')
  assert.ok(!/<script>/.test(html), 'script escaped')
  assert.ok(!/<img /.test(html), 'img escaped')
  assert.match(html, /&lt;script&gt;/)
})

test('an empty changelog renders nothing rather than throwing', () => {
  const { _changelogToHtml } = sandbox()
  assert.strictEqual(_changelogToHtml(''), '')
  assert.strictEqual(_changelogToHtml(null), '')
})
