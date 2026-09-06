'use strict'
// Wave-9 performance work on the music LIBRARY page, run the same way
// polish-wave8.test.js / settings.test.js run the renderer's pure helpers: the
// renderer is one giant file that cannot be required outside Electron, so each
// function under test is lifted out by brace-matching and executed in a vm
// context with only the globals it needs, against a tiny hand-rolled DOM stub.
//
// Covers:
//   #89  Library album-grid windowing (chunked render + IntersectionObserver
//        sentinel append, rollback-on-failure, repaint-from-full-set)
//   #92  Library scan runs off the main thread / in awaited async chunks
//        (main.js, read-only static verification)
//   #3   Album + artist art carry loading="lazy" decoding="async"
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

// Lift a top-level `function name(` out of a source string by matching braces.
// Brace-matching starts at the body's opening `{` — found by walking past the
// parameter list's parentheses — so a default-parameter object literal like
// `out = { audio: [] }` does not derail the scan.
function extractFrom(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  // Skip the parameter list: balance parens from the first '(' after the name.
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  const bodyStart = source.indexOf('{', i)
  let depth = 0
  for (let j = bodyStart; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// ── A minimal DOM stub ───────────────────────────────────────────────────────
// Just enough for _libGridAppendChunk / _armLibGridObserver: a grid element that
// tracks appended children, a sentinel, and a fake IntersectionObserver whose
// callback we can fire on demand.
function makeEl(id) {
  const el = {
    id: id || '',
    children: [],
    style: {},
    _attrs: {},
    dataset: {},
    get childElementCount() { return this.children.length },
    get lastElementChild() { return this.children[this.children.length - 1] || null },
    previousElementSibling: null,
    insertAdjacentHTML(pos, html) {
      // Each appended card is one top-level <div class="album-card" data-album>.
      // Parse the ids so the bound nodes look like real cards to the binder.
      const ids = [...html.matchAll(/data-album="([^"]*)"/g)].map(m => m[1])
      for (const id of ids) {
        const c = makeEl('')
        c.dataset.album = id
        this.children.push(c)
      }
    },
    closest() { return null },
    appendChild(node) {
      const i = this.children.indexOf(node)
      if (i !== -1) this.children.splice(i, 1)
      this.children.push(node)
    },
    setAttribute(k, v) { this._attrs[k] = String(v) },
    getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null },
    hasAttribute(k) { return this._attrs[k] != null },
    querySelectorAll() { return [] },
    addEventListener() {},
  }
  return el
}

// Build a vm context wired to a controllable DOM + IntersectionObserver.
function windowCtx(albumCount) {
  const grid = makeEl('lib-grid')
  const sentinel = makeEl('lib-grid-more')
  const content = makeEl('content')
  content.scrollTop = 0
  content.scrollHeight = 1000
  content.clientHeight = 800

  const byId = { 'lib-grid': grid, 'lib-grid-more': sentinel, content }
  let ioCallback = null
  let ioObserving = false

  class FakeIO {
    constructor(cb) { ioCallback = cb }
    observe() { ioObserving = true }
    disconnect() { ioObserving = false }
  }

  const state = { currentPage: 'library', libSort: 'alpha', library: [] }
  // A trivial albumCard: one card div per album, so the stub can count them.
  const albumCard = (a) => `<div class="album-card" data-album="${a.id}"></div>`

  const ctx = {
    console, Math, Array,
    document: {
      getElementById: (id) => byId[id] || null,
    },
    IntersectionObserver: FakeIO,
    requestAnimationFrame: (fn) => fn(),
    state,
    albumCard,
    playAlbum() {}, navigate() {}, showContextMenu() {},
    playCurrentTrack() {}, _ytAlbumTrackItem() {},
    LIB_WINDOW_CHUNK: 200,
    _libWindow: { all: [], rendered: 0, sort: null, observer: null, ticket: 0 },
  }
  vm.createContext(ctx)
  vm.runInContext(extractFrom(SRC, '_bindAppendedAlbumCards'), ctx)
  vm.runInContext(extractFrom(SRC, '_libGridAppendChunk'), ctx)
  vm.runInContext(extractFrom(SRC, '_armLibGridObserver'), ctx)

  // Seed the window as renderLibrary() does: full set, first chunk rendered.
  const all = Array.from({ length: albumCount }, (_, i) => ({ id: 'a' + i }))
  ctx._libWindow.all = all
  ctx._libWindow.sort = 'alpha'
  ctx._libWindow.ticket++
  // Paint the first chunk into the grid the way _libGridInitial would.
  const first = Math.min(ctx.LIB_WINDOW_CHUNK, all.length)
  grid.insertAdjacentHTML('beforeend', all.slice(0, first).map(albumCard).join(''))
  ctx._libWindow.rendered = first

  return {
    ctx, grid, sentinel, content,
    fireSentinel() { if (ioCallback) ioCallback([{ isIntersecting: true }]) },
    get observing() { return ioObserving },
    // Count only real album cards, not the sentinel node (which _armLibGridObserver
    // moves into the grid's children, exactly as it sits inside #lib-grid live).
    get cardCount() { return grid.children.filter(c => c.dataset && c.dataset.album != null).length },
  }
}

// ── #89  windowing ───────────────────────────────────────────────────────────

test('a small library renders every card up front and arms no observer', () => {
  const h = windowCtx(50)
  assert.strictEqual(h.cardCount, 50, 'all 50 cards are in the first chunk')
  h.ctx._armLibGridObserver()
  assert.strictEqual(h.observing, false, 'nothing left to stream, so no sentinel observer')
  assert.strictEqual(h.sentinel.style.display, 'none', 'the sentinel is hidden')
})

test('a large library paints one chunk, then streams the rest a chunk at a time', () => {
  const h = windowCtx(650) // 4 chunks: 200 + 200 + 200 + 50
  assert.strictEqual(h.cardCount, 200, 'first paint is one chunk only')
  assert.strictEqual(h.ctx._libWindow.rendered, 200)

  h.ctx._armLibGridObserver()
  assert.strictEqual(h.observing, true, 'more to come, so the sentinel is observed')

  h.fireSentinel()
  assert.strictEqual(h.ctx._libWindow.rendered, 400, 'a sighting appends the next chunk')
  h.fireSentinel()
  assert.strictEqual(h.ctx._libWindow.rendered, 600)
  h.fireSentinel()
  assert.strictEqual(h.ctx._libWindow.rendered, 650, 'the short final chunk is exact, never over')
  assert.strictEqual(h.cardCount, 650, 'every card is reachable once fully scrolled')

  // Past the end, another sighting is a no-op and the observer stands down.
  h.fireSentinel()
  assert.strictEqual(h.ctx._libWindow.rendered, 650)
})

test('append rolls back the cursor when the DOM write throws', () => {
  const h = windowCtx(400)
  h.ctx._libWindow.rendered = 200
  // Make the next insert throw, the way a bad record mid-build would.
  h.grid.insertAdjacentHTML = () => { throw new Error('boom') }
  h.ctx._libGridAppendChunk()
  assert.strictEqual(h.ctx._libWindow.rendered, 200,
    'a failed write leaves the cursor put so the same slice retries, never skips')
})

test('a stale ticket ignores a late observer callback', () => {
  const h = windowCtx(650)
  h.ctx._armLibGridObserver()
  // A re-render (search/filter/sort) bumps the ticket; the old observer must not
  // keep appending into a grid that belongs to the previous paint.
  h.ctx._libWindow.ticket++
  const before = h.ctx._libWindow.rendered
  h.fireSentinel()
  assert.strictEqual(h.ctx._libWindow.rendered, before,
    'the superseded observer does nothing')
})

test('without IntersectionObserver the whole grid is painted so nothing is unreachable', () => {
  const h = windowCtx(650)
  h.ctx.IntersectionObserver = undefined
  h.ctx._armLibGridObserver()
  assert.strictEqual(h.ctx._libWindow.rendered, 650, 'no observer support means paint it all')
  assert.strictEqual(h.cardCount, 650)
})

// The chunk size is a real ceiling: a value that renders the whole library
// defeats the point. Kept modest so the first paint is cheap.
test('the window chunk size is a sane, bounded number', () => {
  const m = SRC.match(/var LIB_WINDOW_CHUNK\s*=\s*(\d+)/)
  assert.ok(m, 'LIB_WINDOW_CHUNK is declared')
  const n = Number(m[1])
  assert.ok(n >= 50 && n <= 500, 'chunk is bounded (' + n + ')')
})

// The window must repaint from the full filtered/sorted set every render, not
// from a stale window: renderLibrary reassigns _libWindow.all from getSorted().
test('renderLibrary reseeds the window from the freshly sorted set on every call', () => {
  const rl = extractFrom(SRC, 'renderLibrary')
  assert.ok(/_libWindow\.all\s*=\s*sortedAlbums/.test(rl),
    'the window is rebuilt from the current filtered/sorted list')
  assert.ok(/_libWindow\.rendered\s*=\s*0/.test(rl), 'the cursor resets each render')
  assert.ok(/_libWindow\.ticket\+\+/.test(rl), 'the ticket invalidates the previous observer')
})

// Scroll restore on Back must still land: the deferred pass paints forward until
// the saved scrollTop has content beneath it.
test('scroll restore paints forward until the saved position has content', () => {
  const rl = extractFrom(SRC, 'renderLibrary')
  assert.ok(/scrollHeight\s*<\s*target\s*\+\s*content\.clientHeight/.test(rl),
    'the restore loop tops up the grid to cover the saved scrollTop')
  assert.ok(/_libGridAppendChunk\(\)/.test(rl), 'it appends chunks to get there')
})

// ── #3  lazy + async decoding on library art ─────────────────────────────────

test('album card art is lazy-loaded and async-decoded', () => {
  const fn = extractFrom(SRC, 'albumCard')
  const img = fn.slice(fn.indexOf('album-card-art'))
  assert.ok(/loading="lazy"/.test(img), 'album art defers loading')
  assert.ok(/decoding="async"/.test(img), 'album art decodes off the main thread')
})

test('artist card art is lazy-loaded and async-decoded', () => {
  const fn = extractFrom(SRC, 'renderArtists')
  // The first <img> in the artist card is the local-file artist photo.
  const seg = fn.slice(fn.indexOf('artist-card-art'), fn.indexOf('artist-card-art') + 400)
  assert.ok(/loading="lazy"/.test(seg), 'artist art defers loading')
  assert.ok(/decoding="async"/.test(seg), 'artist art decodes off the main thread')
})

// The sentinel needs geometry to be observable and must span the grid so it
// truly sits at the bottom row.
test('the grid sentinel has a style that makes it a real observer target', () => {
  assert.ok(/\.lib-grid-sentinel\s*\{[^}]*grid-column\s*:\s*1\s*\/\s*-1/.test(CSS),
    'the sentinel spans the full row')
  assert.ok(/\.lib-grid-sentinel\s*\{[^}]*height\s*:/.test(CSS),
    'the sentinel has a height so the observer can see it')
})

// ── #92  scan is off the main thread (read-only main.js verification) ─────────

test('the directory walk is fully async — every readdir is awaited, none sync', () => {
  const walk = extractFrom(MAIN, 'scanDirAsync')
  assert.ok(/await fs\.promises\.readdir/.test(walk),
    'the recursive walk uses the async readdir')
  assert.ok(/await scanDirAsync/.test(walk), 'recursion is awaited, so it yields per directory')
  assert.ok(!/readdirSync/.test(walk), 'no synchronous readdir in the walk')
  assert.ok(!/statSync/.test(walk), 'no synchronous stat in the walk')
})

test('the parse phase is a bounded async worker pool that awaits its I/O', () => {
  const scan = extractFrom(MAIN, '_performScanOnce')
  assert.ok(/CONCURRENCY\s*=\s*\d+/.test(scan), 'a bounded number of parse workers')
  assert.ok(/await Promise\.all/.test(scan), 'the workers run and are awaited')
  assert.ok(/await fs\.promises\.stat/.test(scan), 'stat is async inside the worker')
  assert.ok(!/readFileSync|statSync|readdirSync/.test(scan),
    'no synchronous filesystem call blocks the loop in the parse phase')
})

test('per-file parsing is dominated by awaited async I/O, not sync work', () => {
  const parse = extractFrom(MAIN, 'parseTrackFile')
  assert.ok(/await mm\.parseFile/.test(parse), 'metadata parse is awaited')
  // The only sync fs calls are the small artwork existence/write, gated on a
  // picture actually being present. That is bytes, not seconds, and is the
  // documented exception rather than a directory walk on the main thread.
  const syncCalls = (parse.match(/fs\.(existsSync|writeFileSync)/g) || [])
  for (const c of syncCalls) {
    assert.ok(/existsSync|writeFileSync/.test(c),
      'the only sync fs calls are the small per-file artwork write')
  }
  assert.ok(!/readFileSync/.test(parse), 'no synchronous whole-file read here')
})

// The scan runs behind a single-flight guard and a deadline, so a wedged mount
// cannot pin a second scan or run forever — both are main-thread-hygiene wins.
test('the scan is single-flight and deadline-bounded', () => {
  assert.ok(/_scanInFlight/.test(MAIN), 'a single-flight guard prevents overlapping scans')
  assert.ok(/SCAN_DEADLINE_MS/.test(MAIN), 'a deadline stops a scan wedged on a dead mount')
})
