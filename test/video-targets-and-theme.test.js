'use strict'
// Three Movies & TV defects that all live in the stylesheet (audit N14, N20).
//
// N14 — the hero's page dots were 22x3 px. Three pixels of vertical target is
//       not a control; it is a decoration you can hit by accident.
// N20 — `color-scheme` was never declared, so Chromium rendered the native
//       furniture (scrollbars, <select> popups, the caret, form glyphs) with
//       its LIGHT defaults on top of a dark app; the filter chips were under
//       the 24 px minimum target; and the catalogue posters hid their Play
//       button until hover, which contradicts the app's own rule 5 ("Play
//       buttons must always be visible, opacity .85 always on" — CLAUDE.md).
//
// Parsed out of the shipped stylesheet with the same rule reader the Soulseek
// affordance test uses.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const CSS = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')

// The declarations of one CSS rule, as a map. `nth` picks a later occurrence
// when a selector is declared more than once (theme overrides).
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

// ── N14: the hero page dots ───────────────────────────────────────────────────

test('a hero dot is a real target, not a three-pixel sliver', () => {
  const dot = ruleProps('.vhero-dot')
  assert.ok(px(dot.height) >= 24,
    'the dot must occupy at least 24 px of hit area, got ' + dot.height)
  assert.ok(px(dot.width) >= 24,
    'and at least 24 px across, got ' + dot.width)
  assert.strictEqual(dot['min-height'], '24px', 'and it must not be squashed by a flex parent')
})

test('but it still LOOKS like a slim bar — the extra height is padding', () => {
  const dot = ruleProps('.vhero-dot')
  assert.strictEqual(dot['background-clip'], 'content-box',
    'the background must paint inside the padding, or the dots become blocks')
  // 24 px box minus 8 px of padding top and bottom leaves an 8 px visible bar.
  const pad = px(String(dot.padding || '').split(/\s+/)[0])
  const visible = px(dot.height) - pad * 2
  assert.ok(visible >= 8, 'the visible bar must be at least 8 px, got ' + visible)
  assert.ok(visible <= 12, 'and still read as a dot strip, got ' + visible)
})

test('the current show is marked by more than a colour', () => {
  const active = ruleProps('.vhero-dot.active')
  assert.ok(px(active.width) > px(ruleProps('.vhero-dot').width),
    'the current dot is wider, so the state survives a colour-blind reading')
  assert.ok(active['box-shadow'], 'and it is ringed')
  assert.ok(ruleProps('.vhero-dot:focus-visible').outline,
    'and it shows where the keyboard is')
})

test('the cinema theme re-tints the dots without re-solidifying them', () => {
  for (const sel of ['.cinema .vhero-dot', '.cinema .vhero-dot:hover', '.cinema .vhero-dot.active']) {
    assert.strictEqual(ruleProps(sel)['background-clip'], 'content-box',
      sel + ' must restate background-clip, or its background paints the whole hit area')
  }
})

test('each dot says which show it is, and which one you are on', () => {
  assert.match(RENDERER, /aria-label="Show ' \+ \(i \+ 1\) \+ ' of ' \+ _videoHero\.items\.length/,
    'the label must say "Show N of M", not a bare index')
  assert.match(RENDERER, /aria-current="true"/,
    'and the current dot must be marked for a screen reader too')
})

// ── N20: color-scheme ─────────────────────────────────────────────────────────

test('the app tells the browser it is dark, so the native furniture matches', () => {
  assert.strictEqual(ruleProps(':root')['color-scheme'], 'dark',
    'without this, scrollbars and <select> popups render light over a dark app')
})

test('and the light theme says light', () => {
  assert.strictEqual(ruleProps('body.theme-light')['color-scheme'], 'light')
})

test('and so does the system-preference light block', () => {
  const at = CSS.indexOf('@media (prefers-color-scheme:light)')
  assert.ok(at > -1, 'the system light block must still exist')
  const block = CSS.slice(at, CSS.indexOf('}', CSS.indexOf('}', at) + 1))
  assert.match(block, /color-scheme:\s*light/)
})

// ── N20: chip hit areas ───────────────────────────────────────────────────────

// Every chip class that is a real button. .video-genre-chip was missed by the
// first pass and a live re-test measured it at 17-21 px on the hub cards and
// the detail page — the same defect N20 fixed for the other four.
const CHIP_CLASSES = ['.vf-chip', '.vlist-chip', '.vsfilter-chip', '.vt-chip', '.video-genre-chip']

test('every Movies & TV chip carries at least a 24 px target', () => {
  const overlay = ruleProps(CHIP_CLASSES.map((c) => c + '::after').join(', '))
  assert.ok(px(overlay.height) >= 24, 'the target overlay must be 24 px tall, got ' + overlay.height)
  assert.strictEqual(overlay['min-height'], '100%',
    'and never smaller than the chip it covers')
  assert.strictEqual(overlay.position, 'absolute')
  const anchored = ruleProps(CHIP_CLASSES.join(', '))
  assert.strictEqual(anchored.position, 'relative',
    'the overlay needs the chip as its positioning parent')
})

test('the genre chips are in that list, not just the filter rail', () => {
  // Their own rule is deliberately small (11px text, 3px padding) — about
  // 19 px of box — so without the overlay they are under the minimum.
  const chip = ruleProps('.video-genre-chip')
  const box = px(chip['font-size']) * 1.2 + px(chip.padding.split(' ')[0]) * 2 + 2
  assert.ok(box < 24, 'if the chip itself grew past 24 px this test is measuring nothing')
  const overlay = ruleProps(CHIP_CLASSES.map((c) => c + '::after').join(', '))
  assert.ok(px(overlay.height) >= 24,
    '.video-genre-chip must be covered by the 24 px overlay rule')
})

test('and the chips themselves did not get any bigger', () => {
  // The visual box is unchanged: same padding, same font size as before.
  const chip = ruleProps('.vf-chip')
  assert.strictEqual(chip.padding, '5px 10px')
  assert.strictEqual(chip['font-size'], '11.5px')
})

// ── N20: poster Play ──────────────────────────────────────────────────────────

test('a poster Play button is visible without hovering (rule 5)', () => {
  const actions = ruleProps('.vcard-actions', 1)
  assert.strictEqual(actions.opacity, '.85',
    'rule 5: play buttons are always visible at .85, never hidden behind hover')
})

test('and it still comes to full strength under the pointer or the keyboard', () => {
  const props = ruleProps('.vcard:hover .vcard-actions, .vcard:focus-within .vcard-actions')
  assert.strictEqual(props.opacity, '1')
})

test('the cinema theme does not hide them again', () => {
  assert.strictEqual(ruleProps('.cinema .vcard-actions').opacity, '.85',
    'the cinema block out-specifies the shared rule, so it must repeat it')
})
