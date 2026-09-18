'use strict'
// The offline banner used to promise more than the app delivers (audit N16).
//
// It read "You're offline — browsing and playback of downloaded content still
// work". "Browsing" is the word the Movies & TV catalogue uses for itself, and
// every shelf, search, detail page and trailer in it is a live request that
// fails while offline. So the banner told him the one thing that definitely
// would not work was fine, and he found out by trying it.
//
// This test pins the SHAPE, not the wording: two clauses, one naming what still
// works and one naming what does not, and the banner must never again claim
// browsing works without qualification.
//
// The banner element is the real one from src/index.html and the code that
// shows it is the real _applyOnlineState lifted out of renderer.js, so a copy
// change that quietly drops the second clause, or a rewire that stops showing
// the banner at all, both go red.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const HTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')

// The banner element's inner markup, straight out of the shipped page.
function bannerMarkup() {
  const at = HTML.indexOf('id="offline-banner"')
  assert.ok(at > -1, 'the offline banner must still exist')
  const open = HTML.indexOf('>', at) + 1
  const close = HTML.indexOf('</div>', open)
  return HTML.slice(open, close)
}

// One clause per span, decoded enough for a text assertion.
function clauses() {
  const markup = bannerMarkup()
  const out = {}
  const re = /<span class="(offline-works|offline-wont)">([\s\S]*?)<\/span>/g
  let m
  while ((m = re.exec(markup))) {
    out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  }
  return out
}

test('the banner says what still works AND what does not', () => {
  const c = clauses()
  assert.ok(c['offline-works'], 'a clause naming what still works must be present')
  assert.ok(c['offline-wont'], 'a clause naming what does NOT work must be present')
})

test('the works clause names things that are genuinely on this machine', () => {
  const works = clauses()['offline-works'].toLowerCase()
  assert.match(works, /offline/, 'it must still say he is offline')
  // The local surfaces: the music library, the On device tab, files on disk.
  const named = ['library', 'on device', 'disk', 'download'].filter(w => works.includes(w))
  assert.ok(named.length >= 2,
    'the works clause must name the local surfaces, got: ' + works)
})

test('the does-not clause names the catalogue, streaming and trailers', () => {
  const wont = clauses()['offline-wont'].toLowerCase()
  for (const needed of ['catalogue', 'streaming', 'trailer']) {
    assert.ok(wont.includes(needed),
      'the offline limits must name ' + needed + ', got: ' + wont)
  }
})

test('it never again claims browsing works', () => {
  const all = Object.values(clauses()).join(' ').toLowerCase()
  assert.ok(!/\bbrowsing\b/.test(all),
    'unqualified "browsing" is the over-promise this test exists for: ' + all)
})

test('and the banner is still the thing the offline state shows', () => {
  // Lift the real _applyOnlineState and drive it with a fake document, so the
  // copy above is not dead markup on an element nothing paints.
  const open = RENDERER.indexOf('function _applyOnlineState(online) {')
  assert.ok(open > -1, '_applyOnlineState must still exist')
  let depth = 0
  let i = RENDERER.indexOf('{', open)
  const start = i
  do {
    if (RENDERER[i] === '{') depth++
    else if (RENDERER[i] === '}') depth--
    i++
  } while (depth > 0 && i < RENDERER.length)
  const body = RENDERER.slice(start + 1, i - 1)

  const banner = { hidden: true }
  const state = {}
  const toasts = []
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'state', 'showToast', '_wasOffline', 'online', body)
  fn({ getElementById: (id) => (id === 'offline-banner' ? banner : null) },
    state, (t) => toasts.push(t), false, false)
  assert.strictEqual(banner.hidden, false, 'going offline must reveal the banner')
  assert.strictEqual(state.isOnline, false)

  fn({ getElementById: (id) => (id === 'offline-banner' ? banner : null) },
    state, (t) => toasts.push(t), true, true)
  assert.strictEqual(banner.hidden, true, 'coming back online must hide it again')
  assert.deepStrictEqual(toasts, ['Back online'])
})
