'use strict'
// L7 + L8 — four controls under the 24 px minimum target, and a label clipped
// at every window width.
//
// L7, measured live: the playlist-card rename pencil 10x18, its duplicate
// button 15x18, the heart on a Liked row 16x14, the download scheduler's
// checkbox 16x16. Each grows its TARGET without growing its ink — the same
// trade N20 made for the Movies & TV chips.
//
// L8: a genre tile is an overflow:hidden flex box holding a bare text node
// with no wrap rule and no ellipsis. "Singer/Songwriter" is one unbreakable
// token wider than the 160 px minimum column, so it was cut off at every width
// the grid can produce.
//
// Parsed out of the shipped stylesheet with the same reader
// video-targets-and-theme.test.js uses.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')

function ruleProps(selector, nth = 0) {
  const re = new RegExp('(^|\\}|\\{)\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'gm')
  const found = []
  let m
  while ((m = re.exec(CSS))) found.push(m[2])
  assert.ok(found.length > nth, selector + ' must still exist in styles.css')
  const out = {}
  for (const decl of found[nth].split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
  }
  return out
}

const px = (v) => Number(String(v || '').replace('px', ''))

// Every rule for a selector, layered in document order — which is what the
// cascade does at equal specificity. `.genre-tile` is declared twice (the
// genre-grid card at ~4859 and the browse tile at ~6256) and the live element
// takes properties from both, so reading only one of them measures nothing.
function cascaded(selector) {
  const re = new RegExp('(^|\\}|\\{)\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'gm')
  const out = {}
  let m, seen = 0
  while ((m = re.exec(CSS))) {
    seen++
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
  }
  assert.ok(seen, selector + ' must still exist in styles.css')
  return out
}

// ── L7: the three button targets ─────────────────────────────────────────────

const OVERLAY = '.track-like-btn::after, .pl-rename-btn::after, .pl-dup-btn::after'

test('the heart, the pencil and the duplicate button all carry a 24 px target', () => {
  const o = ruleProps(OVERLAY)
  assert.strictEqual(o.content, "''", 'the overlay must be a real pseudo-element')
  assert.strictEqual(o.position, 'absolute')
  assert.ok(px(o.width) >= 24, 'the target must be 24 px across, got ' + o.width)
  assert.ok(px(o.height) >= 24, 'and 24 px tall, got ' + o.height)
  assert.strictEqual(o['min-width'], '100%', 'and never smaller than the control it covers')
  assert.strictEqual(o['min-height'], '100%')
})

test('it is centred on the control, so the target does not drift off it', () => {
  const o = ruleProps(OVERLAY)
  assert.strictEqual(o.left, '50%')
  assert.strictEqual(o.top, '50%')
  assert.strictEqual(o.transform, 'translate(-50%,-50%)')
})

test('the heart is its own positioning parent, or the overlay lands elsewhere', () => {
  assert.strictEqual(ruleProps('.track-like-btn').position, 'relative')
})

test('the two playlist-card buttons are already positioned, inline', () => {
  // They set position:absolute in their style attribute, which makes each one a
  // containing block on its own — so they need the overlay but not the anchor.
  for (const cls of ['pl-rename-btn', 'pl-dup-btn']) {
    const m = RENDERER.match(new RegExp('class="' + cls + '"[^>]*style="([^"]*)"'))
    assert.ok(m, cls + ' must still be rendered with an inline style')
    assert.match(m[1], /position:absolute/,
      cls + ' must stay absolutely positioned, or the ::after target needs an anchor rule')
  }
})

test('and the buttons themselves did not get any bigger', () => {
  const heart = ruleProps('.track-like-btn')
  assert.strictEqual(heart['font-size'], '14px', 'the ink is unchanged — only the target grew')
  assert.strictEqual(heart.padding, '0 4px')
  for (const cls of ['pl-rename-btn', 'pl-dup-btn']) {
    const m = RENDERER.match(new RegExp('class="' + cls + '"[^>]*style="([^"]*)"'))
    assert.match(m[1], /font-size:12px/)
  }
})

test('the scheduler checkbox is 24 px of target around 16 px of box', () => {
  const cb = ruleProps('.dl2-sched-row input[type="checkbox"]')
  assert.strictEqual(cb.width, '16px', 'the visible box must not change')
  assert.strictEqual(cb.height, '16px')
  assert.strictEqual(cb['box-sizing'], 'content-box',
    'without this the padding eats the box instead of growing it')
  const pad = px(cb.padding)
  assert.ok(px(cb.width) + pad * 2 >= 24,
    'border box is ' + (px(cb.width) + pad * 2) + 'px, needs 24')
  assert.strictEqual(px(cb.margin), -pad,
    'the negative margin must cancel the padding, or the row re-flows')
})

// ── L8: the genre tile ───────────────────────────────────────────────────────

test('a genre name may wrap instead of being cut off', () => {
  const tile = cascaded('.genre-tile')
  assert.strictEqual(tile['overflow-wrap'], 'anywhere',
    '"Singer/Songwriter" has no space to break at, so only `anywhere` lets it wrap')
  assert.ok(tile['line-height'], 'two lines in a 100 px tile need a line-height that fits')
  assert.ok(Number(tile['line-height']) <= 1.4, 'got ' + tile['line-height'])
})

test('the tile is still the same tile', () => {
  const tile = cascaded('.genre-tile')
  assert.strictEqual(tile.height, '100px')
  assert.strictEqual(tile.padding, '14px')
  assert.strictEqual(tile.overflow, 'hidden')
})

test('two lines fit inside it', () => {
  const tile = cascaded('.genre-tile')
  const inner = px(tile.height) - px(tile.padding) * 2
  // The grid column can be as narrow as 160 px — that is what clipped the
  // label in the first place.
  assert.ok(px(ruleProps('.genre-tile-grid')['grid-template-columns'].match(/minmax\((\d+px)/)[1]) >= 160)
  const twoLines = px(tile['font-size']) * Number(tile['line-height']) * 2
  assert.ok(inner >= twoLines,
    'a two-line label needs ' + twoLines + 'px and the content box is ' + inner + 'px')
})

test('and the full name is still reachable when even two lines run out', () => {
  assert.match(RENDERER, /class="genre-tile"[^`]*title="\$\{esc\(g\)\}"/,
    'the tile must carry the untruncated name as a title attribute')
})
