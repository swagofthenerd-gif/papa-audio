'use strict'
// A card that opens must look like it opens.
//
// slsk-shop-ui.js binds a click on the card body to openAlbumView — its own
// comment says "the card becomes a first-class, openable album" — and the
// cards are tabbable and Enter-activated. styles.css then set
// `cursor: default` on them. So the album-opening he asked for had already
// shipped, and every signal on screen said it had not.
//
// This test holds the two halves together: if the behaviour is removed the
// affordance assertions become pointless, and if the affordance regresses the
// behaviour is still there. Either drift fails.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
// Comments are stripped first: a declaration that follows an inline comment
// would otherwise be parsed as part of the comment's own text.
const CSS = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const SHOP = fs.readFileSync(path.join(root, 'src', 'slsk-shop-ui.js'), 'utf8')

// The declarations of one CSS rule, as a map.
function ruleProps(css, selector) {
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm')
  const m = re.exec(css)
  assert.ok(m, selector + ' must still exist in styles.css')
  const out = {}
  for (const decl of m[2].split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
  }
  return out
}

test('the shelf card still opens an album view on a body click', () => {
  // The behaviour half. If this ever stops being true, the affordance below
  // is no longer required and this test should be deleted, not silenced.
  assert.match(SHOP, /const card = e\.target\.closest\('\.slsh-card:not\(\.slsh-skel\)'\)/,
    'a click on the card body is still routed')
  assert.match(SHOP, /function openAlbumView\(/, 'and the album view still exists')
})

test('so the card does not tell him it is inert', () => {
  const props = ruleProps(CSS, '.slsh-card')
  assert.notStrictEqual(props.cursor, 'default',
    'cursor:default on a card that opens an album is the bug this test exists for')
  assert.strictEqual(props.cursor, 'pointer')
})

test('it announces itself as activatable, not as a div', () => {
  const markup = SHOP.slice(SHOP.indexOf('<div class="slsh-card" data-idx='))
  const tag = markup.slice(0, markup.indexOf('>') + 1)
  assert.match(tag, /role="button"/, 'screen readers must be told it activates')
  assert.match(tag, /tabindex="0"/, 'and it must stay reachable by keyboard')
  assert.match(tag, /aria-label="Open /, 'and say what it opens')
})

test('the loading skeletons do not claim to be openable', () => {
  const skel = ruleProps(CSS, '.slsh-card.slsh-skel')
  assert.strictEqual(skel.cursor, 'default',
    'a placeholder that opens nothing must not offer a pointer')
})

test('there is a hover cue, not only a background tint', () => {
  const hover = ruleProps(CSS, '.slsh-card:hover')
  assert.ok(hover.transform || hover['box-shadow'],
    'a tint alone reads as "highlighted"; it needs to read as "this opens"')
})

test('the keyboard focus ring is visible on the card', () => {
  const focus = ruleProps(CSS, '.slsh-card:focus-visible')
  assert.ok(focus.outline && focus.outline !== 'none',
    'the cards are tabbable, so focus must be visible')
})
