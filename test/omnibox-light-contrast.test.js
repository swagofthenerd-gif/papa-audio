'use strict'
// H3 — the Omnibox (Ctrl+K) was unreadable in light mode.
//
// `.cmd-palette-box` hardcoded `background:#161618`. Every rule inside it takes
// its ink from the theme tokens, so on paper the box stayed a dark slab while
// the text flipped to dark ink: 1.08:1 on the input row, 2.49:1 on the result
// rows, 3.08:1 on the group headers. You could open the palette and not see
// what was in it.
//
// The rules are parsed out of the shipped stylesheet the way
// video-targets-and-theme.test.js does, and the colours are resolved through
// test/helpers/contrast.js — which reads the REAL token values out of the
// :root and body.theme-light blocks, so this goes red if either the rule or
// the token it points at regresses.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { contrast } = require('./helpers/contrast')

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

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

const AA = 4.5

test('the palette ground is a theme token, not a hardcoded dark hex', () => {
  const bg = ruleProps('.cmd-palette-box').background
  assert.ok(/^var\(--/.test(bg),
    '.cmd-palette-box background must be a token so it follows the theme, got ' + bg)
  assert.ok(!/#[0-9a-f]{3,6}/i.test(bg), 'no hex may survive in it: ' + bg)
})

test('and its border is the shared glass hairline', () => {
  assert.match(ruleProps('.cmd-palette-box').border, /var\(--glass-border\)/)
})

// Every text layer of the palette, as {what, colour, the surface stack under
// it}. The stack is written topmost-first, opaque ground last — the same order
// the browser paints it.
const SURFACE = ruleProps('.cmd-palette-box').background

const LAYERS = [
  ['the query you typed', '.cmd-palette-input', 'color', [SURFACE]],
  ['its placeholder', '.cmd-palette-input::placeholder', 'color', [SURFACE]],
  ['a result row', '.cmd-item', 'color', [SURFACE]],
  ['the row you are on', '.cmd-item.active,.cmd-item:hover', 'color',
    [ruleProps('.cmd-item.active,.cmd-item:hover').background, SURFACE]],
  ['a group header', '.cmd-group', 'color', [SURFACE]],
  ['a row subtitle', '.cmd-item-sub', 'color', [SURFACE]],
  ['the shortcut chip', '.cmd-kbd', 'color', [ruleProps('.cmd-kbd').background, SURFACE]],
  ['the mode hint', '.cmd-hint', 'color', [SURFACE]],
  ['the empty state', '.cmd-empty', 'color', [SURFACE]],
  ['the footer legend', '.cmd-palette-footer', 'color', [SURFACE]],
  ['the search glyph', '.cmd-palette-search-icon', 'fill', [SURFACE]],
]

for (const [what, selector, prop, stack] of LAYERS) {
  test(`light theme: ${what} is legible on the palette (${selector})`, () => {
    const value = ruleProps(selector)[prop]
    assert.ok(value, selector + ' must still declare ' + prop)
    const ratio = contrast(value, stack, 'light')
    assert.ok(ratio >= AA,
      `${selector} ${prop} is ${ratio}:1 on the palette in light mode, needs ${AA}:1`)
  })
}

test('dark mode did not regress while light mode was fixed', () => {
  for (const [what, selector, prop, stack] of LAYERS) {
    // --text3 is the app-wide tertiary token and sits at 4.28:1 on --bg2 in
    // dark mode; that is a global token question, not an Omnibox one. The bar
    // here is "no worse than the tertiary token", which the old #161618 ground
    // already cleared — the point is that swapping to --bg2 cost nothing.
    const ratio = contrast(ruleProps(selector)[prop], stack, 'dark')
    assert.ok(ratio >= 4.2, `${what} fell to ${ratio}:1 in dark mode`)
  }
})

test('the light theme softens the drop shadow instead of keeping the dark one', () => {
  const light = ruleProps('body.theme-light .cmd-palette-box')
  assert.ok(light['box-shadow'], 'body.theme-light must restate box-shadow')
  const alpha = parseFloat(light['box-shadow'].match(/rgba\([^)]*,\s*([\d.]+)\)/)[1])
  const darkAlpha = parseFloat(ruleProps('.cmd-palette-box')['box-shadow'].match(/rgba\([^)]*,\s*([\d.]+)\)/)[1])
  assert.ok(alpha < darkAlpha,
    'a .6 black shadow under a paper modal reads as soot, got ' + alpha)
})

test('and the scrim behind it is not a 65% black blackout on paper', () => {
  const scrim = ruleProps('body.theme-light .cmd-palette-overlay').background
  const alpha = parseFloat(scrim.match(/rgba\([^)]*,\s*([\d.]+)\)/)[1])
  assert.ok(alpha < 0.65, 'light-mode scrim must be lighter than the dark one, got ' + alpha)
})
