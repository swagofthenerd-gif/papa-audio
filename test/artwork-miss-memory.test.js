'use strict'
// A cover file that is not on disk must be asked for once, not forever.
//
// One session logged 654 net::ERR_FILE_NOT_FOUND on artwork, and the SAME
// missing file was requested six times inside 0.4 seconds. The library keeps an
// artPath for an album whose cover has since been moved or deleted, and nothing
// remembered that the request had already failed — so every grid repaint, every
// queue repaint and every hover fired the whole set of dead file:// requests
// again.
//
// The painters are lifted from renderer.js and run against a counting stub that
// plays the browser's part: it "requests" every src it is handed and reports a
// miss for the ones that are not in its fake filesystem.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(')
  assert.ok(start > -1, name + ' must still exist as a top-level function in renderer.js')
  const a = SRC.indexOf('\nfunction ', start + 1)
  const b = SRC.indexOf('\nasync function ', start + 1)
  const stop = [a, b].filter(n => n > -1).sort((x, y) => x - y)[0]
  return SRC.slice(start, stop === undefined ? undefined : stop)
}

// The miss memory itself, verbatim from the source.
function missBlock() {
  const start = SRC.indexOf('var _artMisses = new Set()')
  assert.ok(start > -1, 'the artwork miss memory must still exist')
  const end = SRC.indexOf('function _artSrc(', start)
  assert.ok(end > start)
  return SRC.slice(start, end)
}

// A page whose browser only has the covers in `onDisk`. Every <img src> emitted
// is counted; a src that is not on disk reports an error the way Chromium does.
function openPage(onDisk) {
  const requests = []
  const listeners = []
  const ctx = vm.createContext({
    Set, String, Date, Math, Number, console,
    document: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) },
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    isHttpPath: p => /^https?:\/\//.test(String(p)),
    fmtSpec: () => '', formatBadgeHtml: () => '', drBadge: () => '',
    computeAlbumDR: () => null, highlightMatch: (s) => String(s),
    _cardHue: () => 120,
  })
  vm.runInContext(missBlock() + lift('_artSrc') + lift('artImg') + lift('albumCard'), ctx)
  assert.ok(listeners.some(l => l.type === 'error' && l.capture === true),
    'a capture-phase error listener is what catches every <img> without each call site remembering to')
  const onError = listeners.find(l => l.type === 'error' && l.capture === true).fn

  // The browser: pull every src out of the painted html, "fetch" it, and fire
  // an error for anything missing — which is the signal the page learns from.
  function paint(html) {
    for (const m of html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)) {
      const src = m[1].replace(/&amp;/g, '&')
      requests.push(src)
      const file = src.replace(/^file:\/\//, '')
      if (!onDisk.has(file)) {
        onError({ target: { tagName: 'IMG', getAttribute: k => (k === 'src' ? src : null) } })
      }
    }
    return html
  }

  return {
    requests,
    paint,
    card: album => { ctx.__a = album; return vm.runInContext('albumCard(__a, 0, "name")', ctx) },
    img: p => { ctx.__p = p; return vm.runInContext('artImg(__p, "c", "f")', ctx) },
    misses: () => vm.runInContext('_artMissCount()', ctx),
    usable: p => { ctx.__p = p; return vm.runInContext('_artUsable(__p)', ctx) },
  }
}

const GONE = '/mnt/data/MUSIC/Radiohead/Kid A/cover.jpg'
const THERE = '/mnt/data/MUSIC/Portishead/Dummy/cover.jpg'
const ALBUM_GONE = { id: 'a1', name: 'Kid A', artist: 'Radiohead', artPath: GONE }
const ALBUM_OK = { id: 'a2', name: 'Dummy', artist: 'Portishead', artPath: THERE }

test('a missing cover is requested once, however many repaints follow', () => {
  // The live shape: the same card painted six times in under half a second.
  const p = openPage(new Set([THERE]))
  for (let i = 0; i < 6; i++) p.paint(p.card(ALBUM_GONE))
  const dead = p.requests.filter(r => r.includes('Kid A'))
  assert.strictEqual(dead.length, 1,
    'six repaints must produce one failed request, not six')
})

test('and the card still shows its fallback, not a broken image', () => {
  const p = openPage(new Set([THERE]))
  p.paint(p.card(ALBUM_GONE))
  const again = p.card(ALBUM_GONE)
  assert.doesNotMatch(again, /<img/, 'no image element at all once the file is known to be gone')
  assert.match(again, /album-card-art-fallback/)
  assert.match(again, /linear-gradient/, 'and it gets the real fallback styling, not a hidden one')
})

test('a cover that IS there is never given up on', () => {
  const p = openPage(new Set([THERE]))
  for (let i = 0; i < 6; i++) p.paint(p.card(ALBUM_OK))
  const live = p.requests.filter(r => r.includes('Dummy'))
  assert.strictEqual(live.length, 6, 'a working cover is requested every time it is painted')
  assert.strictEqual(p.misses(), 0)
})

test('one album going missing does not take the others with it', () => {
  const p = openPage(new Set([THERE]))
  const grid = () => p.paint(p.card(ALBUM_GONE) + p.card(ALBUM_OK))
  grid(); grid(); grid()
  assert.strictEqual(p.requests.filter(r => r.includes('Kid A')).length, 1)
  assert.strictEqual(p.requests.filter(r => r.includes('Dummy')).length, 3)
})

test('the memory is shared by every painter, not per function', () => {
  // The grid learns it; the artist rows, the Continue-listening card and the
  // quick picks all use artImg, and must not have to learn it again.
  const p = openPage(new Set([THERE]))
  p.paint(p.card(ALBUM_GONE))
  const html = p.img(GONE)
  assert.doesNotMatch(html, /<img/, 'artImg must honour what the grid already found out')
  assert.match(html, /class="f"/, 'and fall back cleanly')
})

test('a remote cover URL is never written off', () => {
  // A network image can fail for a hundred reasons that have nothing to do with
  // the file existing, and re-requesting it costs the disk nothing.
  const p = openPage(new Set())
  const url = 'https://i.ytimg.com/vi/abc/hq.jpg'
  for (let i = 0; i < 3; i++) p.paint(p.img(url))
  assert.strictEqual(p.requests.filter(r => r === url).length, 3)
  assert.strictEqual(p.usable(url), true)
  assert.strictEqual(p.misses(), 0, 'only local files are remembered as gone')
})

test('an album with no cover at all was never a request to begin with', () => {
  const p = openPage(new Set())
  const html = p.img(null)
  assert.doesNotMatch(html, /<img/)
  assert.strictEqual(p.misses(), 0)
})

test('the memory lasts the session and no longer', () => {
  // A cover that comes back — fetched, or a drive remounted — must be picked up
  // on the next launch rather than written off for ever, so nothing here may be
  // persisted.
  const block = missBlock()
  assert.match(block, /new Set\(\)/)
  assert.doesNotMatch(block, /localStorage|PapaLocal|window\.api/,
    'a persisted miss list would make a recovered cover invisible for good')
})
