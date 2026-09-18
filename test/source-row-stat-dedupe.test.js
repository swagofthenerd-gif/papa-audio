'use strict'
// A source row printed the size and the seeder count twice: once as its own
// stat spans, and again inside the provider's label —
//
//   [1080p] [torrent] [sub] ↑58  1.3 GB   AnimeTosho · 1080p · sub · 1.3 GB · 58 seeds
//
// 25 of 45 rows on one anime page. The providers are not at fault: their
// labels are read by other surfaces too, so the row drops the tokens it is
// itself about to paint, and only those.
//
// _videoStreamRow is lifted from renderer.js and driven with the collaborators
// it names stubbed, so this follows the shipped painter.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function lift () {
  const ctx = {
    Number,
    esc: function (s) { return String(s) },
    _fmtVideoSize: function (n) { return (n / 1e9).toFixed(1) + ' GB' },
    _videoStreamBadge: function (s) { return { text: s.quality || '1080p', cls: 'video-source-badge', title: 'q' } },
    _isInstantSource: function () { return false },
    _videoDetail: null,
    _VICON: { down: '<svg></svg>' },
    window: {},
  }
  vm.createContext(ctx)
  vm.runInContext(extractFn(SRC, '_labelWithoutShownStats'), ctx)
  vm.runInContext(extractFn(SRC, '_videoStreamRow'), ctx)
  return ctx._videoStreamRow
}

function labelOf (html) {
  const m = html.match(/<span class="video-source-label">([^<]*)<\/span>/)
  assert.ok(m, 'the row must still carry a label span')
  return m[1]
}

// How many times a string appears in the whole row, label and stats together.
function occurrences (html, needle) {
  return html.split(needle).length - 1
}

const ANIME_ROW = {
  kind: 'torrent',
  magnet: 'magnet:?xt=1',
  label: 'AnimeTosho · 1080p · sub · 1.3 GB · 58 seeds',
  title: '[SubsPlease] Bungo Stray Dogs - 01 (1080p)',
  sizeBytes: 1.3e9,
  seeders: 58,
  sub: true,
  dub: false,
}

test('a label carrying the size and the seeds prints each of them once', () => {
  const row = lift()(ANIME_ROW, 0)
  assert.strictEqual(occurrences(row, '1.3 GB'), 1, 'the size is said once')
  assert.strictEqual(occurrences(row, '58'), 1, 'the seeder count is said once')
  assert.strictEqual(labelOf(row), 'AnimeTosho · 1080p · sub',
    'and what is left of the label is the part the stats do not cover')
})

test('the stats themselves are still there', () => {
  const row = lift()(ANIME_ROW, 0)
  assert.match(row, /class="video-source-stat video-source-size"[^>]*>1\.3 GB</)
  assert.match(row, /class="video-source-stat video-source-seeds"[^>]*>↑ 58</)
})

test('what the row cannot show, it does not take away', () => {
  // No size and no seeder count from the indexer: the row paints a muted dash
  // for both, so the provider's own figures are the only ones there are.
  // (An absent field, not an explicit null — Number(null) is 0, which the row
  // still paints as a real "0 seeders". That is a separate, older defect.)
  const row = lift()(Object.assign({}, ANIME_ROW, { sizeBytes: undefined, seeders: undefined }), 0)
  assert.strictEqual(labelOf(row), 'AnimeTosho · 1080p · sub · 1.3 GB · 58 seeds')
})

test('one known and one unknown strips only the known one', () => {
  const row = lift()(Object.assign({}, ANIME_ROW, { seeders: undefined }), 0)
  assert.strictEqual(labelOf(row), 'AnimeTosho · 1080p · sub · 58 seeds')
})

test('a label with nothing to strip is untouched', () => {
  const row = lift()(Object.assign({}, ANIME_ROW, { label: 'YTS · 1080p · x265' }), 0)
  assert.strictEqual(labelOf(row), 'YTS · 1080p · x265')
})

test('the source name survives even when it looks like a stat', () => {
  // The first segment is the provider, never a figure — a provider called
  // "1080p" would still be the row's only identification.
  const row = lift()(Object.assign({}, ANIME_ROW, { label: '2 GB' }), 0)
  assert.strictEqual(labelOf(row), '2 GB')
})

test('a bare magnet label (no separators) is left exactly as it is', () => {
  const row = lift()(Object.assign({}, ANIME_ROW, { label: '' , source: '' }), 0)
  assert.strictEqual(labelOf(row), 'magnet:?xt=1')
})
