'use strict'
// Executes the renderer's pure markup builders for real, rather than asserting
// that certain strings appear in the source. The renderer is one 17k-line file
// that cannot be required outside Electron, so each function is extracted by
// brace-matching and run in a vm context with only the globals it touches.
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

function sandbox({ store = null, tab = 'all' } = {}) {
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    window: {},
    _videoTab: tab,
    _videoTabs: [{ key: 'all', label: 'All' }, { key: 'movie', label: 'Movies' }],
    _VICON: { play: '<svg/>', plus: '<svg/>', check: '<svg/>', info: '<svg/>', left: '<svg/>', right: '<svg/>', search: '<svg/>' },
    _vStore: () => store,
    console,
  }
  vm.createContext(ctx)
  for (const fn of ['_videoCard', '_vHeadHtml', '_vRowShell', '_vRailSkeleton', '_stripTags']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

function tagsBalanced(html) {
  const open = (html.match(/<(div|article|section|button|span|h1|h2)\b/g) || []).length
  const close = (html.match(/<\/(div|article|section|button|span|h1|h2)>/g) || []).length
  return open === close
}

// AniList scores out of 100, TMDB out of 10. One badge has to mean one thing.
test('ratings from both catalogs normalise to the same 0-10 badge', () => {
  const ctx = sandbox()
  assert.match(ctx._videoCard({ type: 'movie', id: 1, title: 'Dune', rating: 8.36 }), /★ 8\.4/)
  assert.match(ctx._videoCard({ type: 'anime', id: 2, title: 'Frieren', rating: 92 }), /★ 9\.2/)
})

test('a zero or missing rating shows no badge rather than a zero', () => {
  const ctx = sandbox()
  assert.ok(!/vbadge-rating/.test(ctx._videoCard({ type: 'movie', id: 1, title: 'X' })))
  assert.ok(!/vbadge-rating/.test(ctx._videoCard({ type: 'movie', id: 1, title: 'X', rating: 0 })))
})

test('the resume bar appears only once something is meaningfully started', () => {
  const ctx = sandbox()
  assert.match(ctx._videoCard({ type: 'tv', id: 3, title: 'X', position: 1800, duration: 3600 }),
    /vcard-progress[\s\S]*?width:50%/)
  assert.ok(!/vcard-progress/.test(ctx._videoCard({ type: 'tv', id: 4, title: 'X', position: 2, duration: 3600 })))
  assert.ok(!/vcard-progress/.test(ctx._videoCard({ type: 'tv', id: 5, title: 'X' })))
})

// Titles and ids come from third-party APIs and are injected via innerHTML.
test('hostile metadata cannot break out of the card markup', () => {
  const ctx = sandbox()
  const html = ctx._videoCard({
    type: 'movie', id: '"><script>x</script>', title: '"><img onerror=alert(1)>', poster: '\'"><b>',
  })
  assert.ok(!/<img onerror/.test(html), 'title escaped')
  assert.ok(!/<script>/.test(html), 'id escaped')
  assert.ok(!/'"><b>/.test(html), 'poster url escaped')
})

test('a missing poster renders the fallback instead of a broken image', () => {
  const ctx = sandbox()
  const html = ctx._videoCard({ type: 'movie', id: 5, title: 'No Art' })
  assert.ok(!/<img/.test(html))
  assert.match(html, /vcard-fallback/)
})

test('every builder emits balanced markup', () => {
  const ctx = sandbox()
  for (const [name, html] of [
    ['card', ctx._videoCard({ type: 'movie', id: 1, title: 'X', poster: 'p.jpg', rating: 7 })],
    ['head', ctx._vHeadHtml()],
    ['shell', ctx._vRowShell('k', 'Label', 3)],
  ]) {
    assert.ok(tagsBalanced(html), name + ' has unbalanced tags')
  }
})

test('a card is announced and operable as a button', () => {
  const html = sandbox()._videoCard({ type: 'movie', id: 1, title: 'Dune' })
  assert.match(html, /role="button"/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /aria-label="Dune"/)
})

test('the watchlist button reflects stored state', () => {
  const inList = sandbox({ store: { inWatchlist: () => true } })
  const notIn = sandbox({ store: { inWatchlist: () => false } })
  assert.match(inList._videoCard({ type: 'movie', id: 1, title: 'X' }), /vcard-act-list on/)
  assert.match(inList._videoCard({ type: 'movie', id: 1, title: 'X' }), /aria-label="Remove from My List"/)
  assert.ok(!/vcard-act-list on/.test(notIn._videoCard({ type: 'movie', id: 1, title: 'X' })))
})

// The store ships with the engine work; a card must render before it exists.
test('cards render with no watch store loaded', () => {
  const html = sandbox({ store: null })._videoCard({ type: 'movie', id: 1, title: 'X' })
  assert.match(html, /vcard-act-list/)
})

test('a store that throws does not take the card down', () => {
  const ctx = sandbox({ store: { inWatchlist () { throw new Error('corrupt') } } })
  assert.doesNotThrow(() => ctx._videoCard({ type: 'movie', id: 1, title: 'X' }))
})

test('the tab strip is a real tablist with a selected tab', () => {
  const html = sandbox({ tab: 'all' })._vHeadHtml()
  assert.match(html, /role="tablist"/)
  assert.match(html, /aria-selected="true"/)
  assert.match(html, /aria-selected="false"/)
  assert.match(html, /class="vtab active"/)
})

// AniList overviews are HTML fragments; TMDB's are plain text.
test('AniList markup is flattened to text', () => {
  const ctx = sandbox()
  assert.strictEqual(ctx._stripTags('a<br>b <i>c</i>'), 'a b c')
  assert.strictEqual(ctx._stripTags(null), '')
  assert.strictEqual(ctx._stripTags('<p>Only</p>'), 'Only')
})

test('the rail skeleton fills a row width', () => {
  const ctx = sandbox()
  assert.strictEqual((ctx._vRailSkeleton().match(/vskel-card/g) || []).length, 7)
  assert.strictEqual((ctx._vRailSkeleton(3).match(/vskel-card/g) || []).length, 3)
})

test('the row shell carries the rail and both arrows', () => {
  const html = sandbox()._vRowShell('trending-movies', 'Trending Movies', 12)
  assert.match(html, /data-rail="trending-movies"/)
  assert.match(html, /vrail-prev[\s\S]*aria-label="Scroll left"/)
  assert.match(html, /vrail-next[\s\S]*aria-label="Scroll right"/)
  assert.match(html, /hidden/, 'arrows start hidden until scroll position is known')
})
