'use strict'
// Exercises the Soulseek hub and album-first search-card builders for real,
// rather than asserting strings appear in the source. The renderer is one large
// file that cannot be required outside Electron, so each pure markup/logic
// function is extracted by brace-matching and run in a vm context with only the
// globals it touches — the same approach as test/video-render.test.js.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const filters = require('../src/slsk-filters')
const tree = require('../src/slsk-tree')

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

// A vm context carrying the globals the extracted functions reach for. Only what
// they touch — a missing helper surfaces as a real failure, not a stubbed pass.
function sandbox(extra = {}) {
  const ctx = Object.assign({
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    highlightMatch: (t) => String(t == null ? '' : t),
    window: { PapaSlskFilters: filters, PapaSlskTree: tree },
    state: { library: [], currentPage: 'soulseek', downloadWishlist: [] },
    Math, Number, String, Array, Map, Object, isNaN, parseInt, Date,
    _dlLastFiles: [],
    _dlFolderName: (fn) => {
      const parts = (fn || '').replace(/\//g, '\\').split('\\')
      return parts.length >= 2 ? parts[parts.length - 2] : ''
    },
    _dlCategory: (s) => (s === 'Completed' || s === 'Succeeded') ? 'completed' : 'active',
    console,
  }, extra)
  vm.createContext(ctx)
  return ctx
}

function run(ctx, names) {
  for (const n of names) vm.runInContext(extract(n), ctx)
}

// ── quality line ────────────────────────────────────────────────────────────

test('card quality line reads FLAC as depth/rate and MP3 as bitrate', () => {
  const ctx = sandbox()
  run(ctx, ['_slskQualLabel', '_slskCardQuality'])
  const flac = ctx._slskCardQuality([{ ext: 'flac', isFlac: true, bitDepth: 24, sampleRate: 96000 }])
  assert.equal(flac, 'FLAC · 24/96')
  const mp3 = ctx._slskCardQuality([{ ext: 'mp3', isFlac: false, bitRate: 320 }])
  assert.equal(mp3, 'MP3 · 320')
  // A lossless file with only a sample rate still says something useful.
  assert.equal(ctx._slskCardQuality([{ ext: 'flac', isFlac: true, sampleRate: 44100 }]), 'FLAC · 44 kHz')
  // Empty in, empty out — never throws.
  assert.equal(ctx._slskCardQuality([]), '')
})

// ── availability line ───────────────────────────────────────────────────────

test('availability line turns peer signals into human words', () => {
  const ctx = sandbox()
  run(ctx, ['_slskAvailability'])
  assert.deepEqual(ctx._slskAvailability({ hasFreeSlot: true, queueLength: 999 }),
    { text: 'Ready now', cls: 'slsk-avail-ready' })
  assert.deepEqual(ctx._slskAvailability({ hasFreeSlot: false, queueLength: 42 }),
    { text: '~42 in line', cls: 'slsk-avail-queue' })
  // No free slot, no queue, crawling upload speed → flagged as slow.
  assert.deepEqual(ctx._slskAvailability({ hasFreeSlot: false, queueLength: 0, uploadSpeed: 1024 }),
    { text: 'Slow uploader', cls: 'slsk-avail-slow' })
  // No signals at all falls back to a neutral "Available", never a number dump.
  assert.equal(ctx._slskAvailability({}).text, 'Available')
})

// ── inline progress matching ────────────────────────────────────────────────

test('card progress matches downloads-poll files by peer and album folder', () => {
  const ctx = sandbox({
    _dlLastFiles: [
      { username: 'Bob', filename: 'Music\\DSOTM\\01.flac', state: 'Completed' },
      { username: 'Bob', filename: 'Music\\DSOTM\\02.flac', state: 'Completed' },
      { username: 'Bob', filename: 'Music\\DSOTM\\03.flac', state: 'InProgress' },
      // A different peer's file for the same album must not be counted here.
      { username: 'Al',  filename: 'Music\\DSOTM\\01.flac', state: 'Completed' },
    ],
  })
  run(ctx, ['_slskCardKey', '_slskCardProgress'])
  ctx._slskCardDownloads = new ctx.Map()
  ctx._slskCardDownloads.set(ctx._slskCardKey('Bob', 'DSOTM'), { total: 3 })
  const p = ctx._slskCardProgress({ username: 'Bob', folderName: 'DSOTM' })
  assert.equal(p.total, 3)
  assert.equal(p.done, 2)
  assert.equal(p.pct, 67)
  assert.equal(p.complete, false)
})

test('a card not downloaded this session has no progress strip', () => {
  const ctx = sandbox()
  run(ctx, ['_slskCardKey', '_slskCardProgress'])
  ctx._slskCardDownloads = new ctx.Map()
  assert.equal(ctx._slskCardProgress({ username: 'Bob', folderName: 'DSOTM' }), null)
})

// ── per-folder quality summary in the explorer ──────────────────────────────

test('explorer folder summary reports the majority format and depth/rate', () => {
  const ctx = sandbox()
  run(ctx, ['_slskDirQuality'])
  const node = {
    path: 'Music\\DSOTM',
    files: [
      { name: '01.flac', bitDepth: 16, sampleRate: 44100 },
      { name: '02.flac', bitDepth: 16, sampleRate: 44100 },
      { name: 'cover.jpg' },
    ],
    dirs: new ctx.Map(),
  }
  const out = ctx._slskDirQuality(node)
  assert.ok(out.includes('FLAC'), out)
  assert.ok(out.includes('16/44'), out)
})

test('folder summary counts surround-labelled subfolders', () => {
  const ctx = sandbox()
  run(ctx, ['_slskDirQuality'])
  const dirs = new ctx.Map()
  dirs.set('a', { path: 'Root\\DSOTM 5.1', name: 'DSOTM 5.1' })
  const node = {
    path: 'Root',
    files: [{ name: '01.flac', bitDepth: 24, sampleRate: 96000 }],
    dirs,
  }
  const out = ctx._slskDirQuality(node)
  assert.ok(out.includes('surround'), out)
})

test('folder with no audio directly in it gets no summary', () => {
  const ctx = sandbox()
  run(ctx, ['_slskDirQuality'])
  assert.equal(ctx._slskDirQuality({ path: 'x', files: [{ name: 'notes.txt' }], dirs: new ctx.Map() }), '')
})

// ── static wiring the hub relies on ─────────────────────────────────────────

test('the hub page is registered and renders its four sections', () => {
  // The page must be reachable from navigate() and from the nav item.
  assert.ok(/else if \(page === 'soulseek'\)\s+renderSoulseekHub\(\)/.test(SRC),
    'navigate() must route the soulseek page')
  const hub = extract('renderSoulseekHub')
  for (const id of ['slsk-hub-friends', 'slsk-hub-wishlist', 'slsk-hub-recent', 'slsk-section']) {
    assert.ok(hub.includes(id), 'hub is missing the ' + id + ' section')
  }
  // The hub shares the Search page's card renderer, not a copy of it.
  assert.ok(hub.includes('renderSoulseekRow('), 'hub must reuse renderSoulseekRow')
  assert.ok(hub.includes('runSlskSearch('), 'hub search must reuse runSlskSearch')

  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(html.includes('data-page="soulseek"'), 'nav needs a Soulseek item')
  // The old always-open sidebar friends list is gone, replaced by the compact
  // summary link that navigates to the hub.
  assert.ok(html.includes('slsk-summary-link'), 'sidebar needs the compact summary link')
})

test('the friend-diff badge renders only when newFiles > 0', () => {
  const friends = extract('_renderHubFriends')
  // The badge is gated on a positive newFiles count from slskFriendDiffs.
  assert.ok(/newFiles\s*&&\s*diff\.newFiles\s*>\s*0/.test(friends) || /diff\.newFiles\s*>\s*0/.test(friends),
    'the badge must be gated on newFiles > 0')
  assert.ok(friends.includes('slsk-friend-badge'), 'the badge element must exist')
  // The diff channel is read defensively so a missing backend never crashes.
  assert.ok(SRC.includes('window.api.slskFriendDiffs'), 'friend diffs must come from the backend channel')
})

test('the queue-position sort option is offered in the results sort dropdown', () => {
  assert.ok(SRC.includes("['queue', 'Queue position']"),
    'the Queue position sort option must be in the dropdown')
})
