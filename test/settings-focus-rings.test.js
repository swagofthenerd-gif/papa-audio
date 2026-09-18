'use strict'
// Every control in Settings must show where the keyboard is.
//
// Eight did not: the Playback selects (#pb-mode, #pb-replaygain, #pb-channels,
// #pb-device-loss), Soulseek sharing (#slsk-share-mode), and the Video keys and
// download limit (#video-tmdb-key, #video-opensubs-key, #video-download-limit).
// Tabbing through Settings, focus simply vanished at each of them.
//
// They were not styleless — they had `:focus { border-color: var(--accent) }`,
// a one-pixel tint against a dark panel. That is not a focus ring, and because
// it is :focus and not :focus-visible it also fires on a mouse click, so it
// says nothing about where the keyboard is. The rest of the app uses a 2px
// accent outline on :focus-visible; these now match.
//
// Parses the real stylesheet and the real markup and checks each of the eight
// by id, the way test/slsk-card-affordance.test.js does — so a control added
// later with a class that has no ring is caught by name.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
// Comments first: a declaration after an inline comment would otherwise be read
// as part of the comment's text.
const CSS = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const HTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')

// The controls the audit found with no ring, and nothing else.
const CONTROLS = [
  'pb-mode', 'pb-replaygain', 'pb-channels', 'pb-device-loss',
  'slsk-share-mode', 'video-tmdb-key', 'video-opensubs-key', 'video-download-limit',
]

// The opening tag of an element by id, from the real page.
function tagOf(id) {
  const at = HTML.indexOf('id="' + id + '"')
  assert.ok(at > -1, '#' + id + ' must still exist in index.html')
  const open = HTML.lastIndexOf('<', at)
  return HTML.slice(open, HTML.indexOf('>', at) + 1)
}

// Every class named on that element.
function classesOf(id) {
  const m = /class="([^"]*)"/.exec(tagOf(id))
  return m ? m[1].split(/\s+/).filter(Boolean) : []
}

// Selectors that carry a real focus ring: an outline, or a ring-shaped shadow.
function ringSelectors() {
  const out = new Set()
  const re = /(^|\})\s*([^{}]*?:focus-visible[^{}]*?)\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(CSS))) {
    const decls = m[3]
    if (!/(^|;|\s)(outline|box-shadow)\s*:/.test(decls)) continue
    if (/outline\s*:\s*(none|0)\b/.test(decls)) continue
    for (const sel of m[2].split(',')) out.add(sel.trim())
  }
  return out
}

const RINGS = ringSelectors()

function hasRing(id) {
  if (RINGS.has('#' + id + ':focus-visible')) return true
  for (const c of classesOf(id)) if (RINGS.has('.' + c + ':focus-visible')) return true
  return false
}

test('the stylesheet really does define focus rings', () => {
  // Guards the parser: if this came back empty every assertion below would pass
  // for the wrong reason.
  assert.ok(RINGS.size > 10, `expected many :focus-visible rules, parsed ${RINGS.size}`)
  assert.ok(RINGS.has('.slsh-card:focus-visible'),
    'the existing pattern this follows must still be found by the parser')
})

for (const id of CONTROLS) {
  test(`#${id} shows a focus ring`, () => {
    assert.ok(hasRing(id),
      `#${id} has no :focus-visible outline — tabbing to it makes focus disappear`)
  })
}

test('the ring is a ring, not the old one-pixel border tint', () => {
  const m = /(^|\})\s*\.mcs-set-select:focus-visible[^{]*\{([^}]*)\}/.exec(CSS)
  assert.ok(m, '.mcs-set-select:focus-visible must exist')
  assert.match(m[2], /outline:\s*2px solid var\(--accent\)/,
    'the same 2px accent ring the rest of the app uses')
  assert.match(m[2], /outline-offset/, 'offset, so it is not swallowed by the control border')
})

test('it is :focus-visible, so a mouse click does not draw it', () => {
  // The old rule was plain :focus, which lights up on every click and therefore
  // cannot mean "the keyboard is here".
  const plain = /(^|\})\s*\.mcs-set-select:focus\s*\{([^}]*)\}/.exec(CSS)
  if (plain) {
    assert.doesNotMatch(plain[2], /outline:\s*2px/,
      'the ring belongs on :focus-visible, not on every click')
  }
})

test('all eight are still really in Settings, and are really controls', () => {
  // Otherwise this file could go green by the controls being deleted.
  const panel = HTML.slice(HTML.indexOf('id="playback-settings"'))
  assert.ok(panel.length > 0)
  for (const id of CONTROLS) {
    assert.match(tagOf(id), /^<(select|input|textarea|button)\b/,
      '#' + id + ' must still be a focusable control')
  }
})
