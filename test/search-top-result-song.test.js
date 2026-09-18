'use strict'
// M1 — the songs under "Top Result" opened the album instead of playing.
//
// renderSearch() prints the four best-matching songs as
// `.str-track track-row` with a data-album on each. bindContentEvents' generic
// `.track-row` click handler saw that data-album and did what it does for an
// album-page row: navigate('album', …). So clicking the exact song you had
// just searched for played nothing and threw you at its record. Enter did the
// same, and Space did nothing at all.
//
// They were also unnamed: the a11y pass reads `.track-title` / `.track-artist`,
// and these rows use `.str-track-title` / `.str-track-artist`, so every one of
// them announced itself as a bare "button".
//
// The real handler, the real labeller and the real _playRowTrack are lifted
// out of renderer.js and driven through the same small event/DOM model
// card-key-does-not-pause.test.js uses — extended with nextSibling, because a
// search cell's text is broken up by the <mark> wrappers highlightMatch()
// leaves on a hit.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

// The generic .track-row click handler, from the shipped source.
function liftRowClick() {
  // renderer.js binds `.track-row` twice; anchor on the handler's own first
  // line, which is unique, rather than on the forEach it sits in.
  const first = "if (e.target.closest('.track-more-btn') || e.target.closest('.track-like-btn')) return"
  assert.strictEqual(src.split(first).length - 1, 1, 'the anchor must be unique')
  const at = src.indexOf(first)
  const open = src.lastIndexOf("row.addEventListener('click', e => {", at)
  assert.ok(open > -1 && at - open < 200, 'the generic .track-row click binding must still exist')
  const bodyStart = src.indexOf('{', src.indexOf('e => {', open)) + 1
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(bodyStart, i - 1)
}

// The keyboard route, so Enter/Space are tested on the same code the app runs.
function liftCardKeydown() {
  const open = src.indexOf("document.getElementById('content')?.addEventListener('keydown', e => {")
  assert.ok(open > -1, 'the #content card-activation delegate must still exist')
  const bodyStart = src.indexOf('{', src.indexOf('e => {', open)) + 1
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(bodyStart, i - 1)
}

// The a11y naming pass, with the real _rowLabelText it calls.
function liftRowA11y() {
  const marker = "document.querySelectorAll('#content .track-row').forEach(function (row) {"
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the track-row a11y pass must still exist')
  const bodyStart = src.indexOf('{', src.indexOf('function (row) {', at)) + 1
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return new Function('row', liftFn('_rowLabelText') + '\n' + src.slice(bodyStart, i - 1))
}

const ROW_CLICK = liftRowClick()
const CARD_KEY = liftCardKeydown()
const ROW_A11Y = liftRowA11y()

// ── a DOM small enough to read, faithful enough to matter ────────────────────

function node(cls, parent, nodeName) {
  const n = {
    cls: String(cls || ''), parent: parent || null, children: [], attrs: {},
    text: '', dataset: {}, clicked: 0, nodeType: 1, nodeName: nodeName || 'DIV',
    get classList() { return { contains: (c) => n.cls.split(/\s+/).includes(c) } },
    closest(sel) {
      const wanted = sel.split(',').map((s) => s.trim().replace(/^\./, ''))
      let cur = n
      while (cur) {
        if (wanted.some((w) => cur.cls.split(/\s+/).includes(w))) return cur
        cur = cur.parent
      }
      return null
    },
    querySelector(sel) {
      const wanted = sel.replace(/^\./, '')
      const walk = (kids) => {
        for (const k of kids) {
          if (k.cls.split(/\s+/).includes(wanted)) return k
          const deeper = walk(k.children)
          if (deeper) return deeper
        }
        return null
      }
      return walk(n.children)
    },
    // Text first, then elements — and every one of them linked, so a walk over
    // siblings sees the same shape the browser gives.
    // Built once and kept, so firstChild/nextSibling hand back the SAME text
    // node every time — recreating it on each read silently breaks a walk.
    get childNodes() {
      if (!n._nodes) {
        n._nodes = (n.text ? [{ nodeType: 3, textContent: n.text, nodeName: '#text' }] : [])
          .concat(n.children)
      }
      return n._nodes
    },
    get firstChild() { return n.childNodes[0] || null },
    get textContent() { return n.text + n.children.map((c) => c.textContent).join('') },
    click() { n.clicked++ },
    hasAttribute(a) { return a in n.attrs },
    setAttribute(a, v) { n.attrs[a] = String(v) },
    getAttribute(a) { return a in n.attrs ? n.attrs[a] : null },
  }
  if (parent) parent.children.push(n)
  return n
}

// nextSibling over a node's own childNodes list, computed on demand so the
// tree can be built in any order.
function link(parent) {
  const kids = parent.childNodes
  kids.forEach((k, i) => { k.nextSibling = kids[i + 1] || null })
  parent.children.forEach(link)
  return parent
}

// One Top Result song row, exactly as renderSearch prints it: the search term
// is wrapped in <mark> inside the title cell.
function strTrack({ file, albumId, title = 'Lady Fantasy', hit = '', artist = 'Camel' } = {}) {
  const row = node('str-track track-row search-animate-in')
  row.dataset.file = file
  row.dataset.album = albumId
  node('str-track-thumb', row)
  const info = node('str-track-info', row)
  const t = node('str-track-title', info)
  if (hit && title.includes(hit)) {
    t.text = title.slice(0, title.indexOf(hit))
    node('', t, 'MARK').text = hit
    // The tail after the highlight is a second text node; the model keeps a
    // single `text` per node, so a trailing <mark> is the shape used here.
  } else {
    t.text = title
  }
  const a = node('str-track-artist', info); a.text = artist
  return link(row)
}

// An album-page song row, for the contrast case.
function albumTrack({ file, albumId } = {}) {
  const row = node('track-row')
  row.dataset.file = file
  row.dataset.album = albumId
  node('track-num', row)
  const info = node('track-info', row)
  node('track-title', info).text = 'Lady Fantasy'
  node('track-artist', info).text = 'Camel'
  return link(row)
}

const ALBUM = {
  id: 'alb_mirage',
  tracks: [
    { filePath: '/mnt/data/MUSIC/Camel/Mirage/01.flac', title: 'Freefall' },
    { filePath: '/mnt/data/MUSIC/Camel/Mirage/02.flac', title: 'Supertwister' },
    { filePath: '/mnt/data/MUSIC/Camel/Mirage/03.flac', title: 'Lady Fantasy' },
  ],
}

// Run the lifted click handler with a tiny stand-in app around it. Returns
// what the app did: what it played, and where it navigated.
function fireClick(row, target) {
  const out = { played: null, navigated: null, queue: [], queueIndex: -1 }
  const state = { library: [ALBUM] }
  const fn = new Function(
    'e', 'row', 'state', 'out', '_selHandleClick', 'navigate', 'playAlbum',
    liftFn('_playRowTrack') + '\n' + ROW_CLICK
  )
  fn(
    { target: target || row, preventDefault() {}, stopPropagation() {} },
    row, state, out,
    () => false,
    (page, id) => { out.navigated = [page, id] },
    (album, idx) => {
      out.played = [album.id, idx]
      out.queue = album.tracks.slice()
      out.queueIndex = idx
    }
  )
  return out
}

// ── the defect ───────────────────────────────────────────────────────────────

test('clicking a Top Result song plays THAT song', () => {
  const row = strTrack({ file: ALBUM.tracks[2].filePath, albumId: ALBUM.id })
  const out = fireClick(row)
  assert.strictEqual(out.navigated, null,
    'it used to navigate to the album instead of playing anything')
  assert.deepStrictEqual(out.played, [ALBUM.id, 2])
  assert.strictEqual(out.queue[out.queueIndex].filePath, row.dataset.file,
    'the playing track must be the row that was clicked')
})

test('and the rest of its record becomes the queue behind it', () => {
  const row = strTrack({ file: ALBUM.tracks[0].filePath, albumId: ALBUM.id })
  const out = fireClick(row)
  assert.strictEqual(out.queueIndex, 0)
  assert.strictEqual(out.queue.length, 3, 'playing one song must not orphan the album')
})

test('an album-page row still opens the album when you miss the number', () => {
  const row = albumTrack({ file: ALBUM.tracks[1].filePath, albumId: ALBUM.id })
  const out = fireClick(row, row.querySelector('.track-title'))
  assert.deepStrictEqual(out.navigated, ['album', ALBUM.id],
    'the fix must not change what a normal song row does')
  assert.strictEqual(out.played, null)
})

test('and its track number still plays, through the same one path', () => {
  const row = albumTrack({ file: ALBUM.tracks[1].filePath, albumId: ALBUM.id })
  const out = fireClick(row, row.querySelector('.track-num'))
  assert.deepStrictEqual(out.played, [ALBUM.id, 1])
})

test('a Top Result row whose file is no longer in the library does nothing rash', () => {
  const row = strTrack({ file: '/gone.flac', albumId: ALBUM.id })
  const out = fireClick(row)
  assert.strictEqual(out.played, null)
  assert.strictEqual(out.navigated, null, 'a dead row must not fall through to navigation')
})

// ── the keyboard ─────────────────────────────────────────────────────────────

function fireKey(row, key) {
  const e = {
    key, target: row, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
  }
  new Function('e', CARD_KEY)(e)
  return e
}

for (const key of ['Enter', ' ']) {
  test(`${key === ' ' ? 'Space' : key} on a Top Result song activates the row itself`, () => {
    const row = strTrack({ file: ALBUM.tracks[2].filePath, albumId: ALBUM.id })
    const e = fireKey(row, key)
    assert.strictEqual(row.clicked, 1,
      'the keypress must reach the row, whose click handler now plays')
    assert.ok(e.defaultPrevented && e.propagationStopped,
      'or Space also reaches the global play/pause shortcut')
  })
}

// ── the name ─────────────────────────────────────────────────────────────────

test('a Top Result song says what it is', () => {
  const row = strTrack({ file: ALBUM.tracks[2].filePath, albumId: ALBUM.id })
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Lady Fantasy by Camel',
    'these rows used to announce themselves as an unnamed "button"')
})

test('the name survives the search highlight inside the title', () => {
  // renderSearch wraps the matched term in <mark>, so the title cell is
  // "Lady " + <mark>Fantasy</mark>.
  const row = strTrack({ file: ALBUM.tracks[2].filePath, albumId: ALBUM.id, hit: 'Fantasy' })
  assert.ok(row.querySelector('.str-track-title').children.length,
    'this fixture must actually contain a <mark>, or it is testing nothing')
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Lady Fantasy by Camel')
})

test('an album-page row is named exactly as before', () => {
  const row = albumTrack({ file: ALBUM.tracks[2].filePath, albumId: ALBUM.id })
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Lady Fantasy by Camel')
  assert.strictEqual(row.getAttribute('role'), 'button')
  assert.strictEqual(row.getAttribute('tabindex'), '0')
})
