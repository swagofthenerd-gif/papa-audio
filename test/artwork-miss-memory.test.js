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

// The queue panel and the player deck paint from the same queue, many times a
// session — every track change, every drag, every reorder. They used to build
// their own <img src> straight from _artSrc and so never asked the miss memory
// anything. These lift the REAL painters (renderQueuePanel's rows and the
// deck's np-queue) and run them against the same counting browser stub.
//
// The painters live deep in renderer.js and touch a lot of page furniture, so
// the sandbox answers any name they reach for; what is being measured is the
// html they hand the browser, which is produced before any of that matters.
function openQueuePage(onDisk, queue) {
  const requests = []
  const listeners = []
  const painted = []

  function el() {
    const e = {
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeEventListener() {}, appendChild() {},
      remove() {}, querySelectorAll: () => [], querySelector: () => null,
      closest: () => null, insertBefore() {}, setAttribute() {}, focus() {},
      scrollTop: 0, textContent: '', className: '', title: '',
    }
    Object.defineProperty(e, 'innerHTML', {
      get() { return e._html || '' },
      set(v) { e._html = v; painted.push(String(v)) },
    })
    return e
  }

  const base = {
    Set, String, Date, Math, Number, Object, Array, JSON, console, parseInt, parseFloat,
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    isHttpPath: p => /^https?:\/\//.test(String(p)),
    fmtDur: () => '0:00',
    dragHandleSvg: '<svg></svg>',
    autoplayEnabled: () => false,
    keepGoingEnabled: () => false,
    computeNextIndex: () => null,
    _pendingShuffle: null,
    state: {
      queue, queueIndex: 0, shuffle: false, playCounts: {}, likedTracks: [],
      _restoredFromQueue: false, queuePanelOpen: true, modalOpen: true,
    },
    document: {
      addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
      getElementById: () => el(),
      createElement: () => el(),
      querySelector: () => null,
      querySelectorAll: () => [],
      body: el(),
    },
  }
  const sandbox = new Proxy(base, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : undefined),
  })
  const ctx = vm.createContext(sandbox)
  vm.runInContext(
    missBlock() + lift('_artSrc') + lift('_artSrcIfUsable') + lift('artImg') +
    lift('renderQueuePanel') + lift('renderNpQueue'), ctx)

  const onError = listeners.find(l => l.type === 'error' && l.capture === true).fn

  // The browser again: request every src that was painted, and report the ones
  // that are not on disk.
  function run(fnName) {
    painted.length = 0
    try { vm.runInContext(fnName + '()', ctx) } catch (e) { /* page furniture the painter reaches for afterwards */ }
    const html = painted.join('')
    assert.ok(html.length, fnName + ' must still paint something')
    for (const m of html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)) {
      const src = m[1].replace(/&amp;/g, '&')
      requests.push(src)
      if (!onDisk.has(src.replace(/^file:\/\//, ''))) {
        onError({ target: { tagName: 'IMG', getAttribute: k => (k === 'src' ? src : null) } })
      }
    }
    return html
  }

  return { requests, queuePanel: () => run('renderQueuePanel'), npQueue: () => run('renderNpQueue') }
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

const TRACK_GONE = { title: 'Idioteque', artist: 'Radiohead', albumArtist: 'Radiohead', filePath: '/m/a.flac', artPath: GONE }
const TRACK_OK   = { title: 'Roads', artist: 'Portishead', albumArtist: 'Portishead', filePath: '/m/b.flac', artPath: THERE }

test('the queue panel stops re-requesting a cover that already failed', () => {
  const p = openQueuePage(new Set([THERE]), [TRACK_GONE, TRACK_OK])
  p.queuePanel(); p.queuePanel(); p.queuePanel()
  assert.strictEqual(p.requests.filter(r => r.includes('Kid A')).length, 1,
    'three repaints of the queue must cost one failed request, not three')
  assert.strictEqual(p.requests.filter(r => r.includes('Dummy')).length, 3,
    'and the cover that is really there is still painted every time')
})

test('the queue row shows its fallback once the cover is known gone', () => {
  const p = openQueuePage(new Set([THERE]), [TRACK_GONE])
  p.queuePanel()
  const again = p.queuePanel()
  assert.doesNotMatch(again, /<img/, 'no <img> at all on a repaint after the file failed')
  assert.match(again, /queue-row-art-fallback/, 'the row still draws its placeholder')
})

test("the player deck's queue stops re-requesting it too", () => {
  const p = openQueuePage(new Set([THERE]), [TRACK_GONE, TRACK_OK])
  p.npQueue(); p.npQueue(); p.npQueue()
  assert.strictEqual(p.requests.filter(r => r.includes('Kid A')).length, 1)
  assert.strictEqual(p.requests.filter(r => r.includes('Dummy')).length, 3)
})

test('what one painter learns, the other already knows', () => {
  // The queue panel and the deck share one memory: a cover that failed in the
  // panel must not be asked for again by the deck.
  const p = openQueuePage(new Set([THERE]), [TRACK_GONE])
  p.queuePanel()
  const deck = p.npQueue()
  assert.doesNotMatch(deck, /<img/)
  assert.strictEqual(p.requests.filter(r => r.includes('Kid A')).length, 1)
})

test('no painter builds a cover src without asking the miss memory', () => {
  // _artSrc answers "file or http", not "is it worth asking for". Every call
  // site goes through artImg or _artSrcIfUsable, which ask _artUsable first —
  // one raw _artSrc anywhere is a painter that will hammer a dead file again.
  const callers = [...SRC.matchAll(/_artSrc\(/g)]
    .filter(m => !/function\s+$/.test(SRC.slice(0, m.index)))   // its own declaration
    .map(m => {
      const fn = [...SRC.slice(0, m.index).matchAll(/\nfunction\s+([\w$]+)\s*\(/g)].pop()
      return fn ? fn[1] : '(top level)'
    })
  assert.deepStrictEqual([...new Set(callers)].sort(), ['_artSrcIfUsable'],
    'only _artSrcIfUsable may call _artSrc; every painter goes through it or artImg')
})
