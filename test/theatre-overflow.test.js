'use strict'
/**
 * Structural guards against the theatre layout being widened by its own
 * content (2026-09-16).
 *
 * The bug, measured in the running app on a 48-episode pack at a 1402px
 * viewport: the episode strip grew to 2012px, the grid's implicit `auto`
 * column grew with it, every row became 2012px wide, and the deck's
 * fullscreen button landed at x=1956 — 590 pixels off the right edge, where
 * it could not be clicked at all. The user's report: "the whole episode row
 * is just a single row the goes on and on, and that causes the player
 * controls at the right to also move off the screen and i have no way of
 * using them".
 *
 * .vt-pack-list had declared `overflow-x:auto` since it was written, and it
 * had never once engaged: a flex item's `min-width` defaults to `auto`, which
 * means "never shrink below my content", so there was nothing for the overflow
 * to clip.
 *
 * There is no DOM in this run, so these cannot prove the theatre LOOKS right.
 * What they pin is the two declarations that make overflow possible at all —
 * both are single words that look redundant and read like dead code, which is
 * exactly how they get deleted.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

// Every declaration made for one selector, concatenated. A selector is
// declared more than once here on purpose — .vt-pack gets its grid-row in the
// layout block and its looks further down — so reading only the first rule
// silently tests the wrong half of the file.
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}', 'g')
  const bodies = []
  let m
  while ((m = re.exec(CSS)) !== null) bodies.push(m[1])
  assert.ok(bodies.length, 'no rule found for ' + selector)
  // Comments are stripped, or the prose EXPLAINING a declaration satisfies the
  // assertion for the declaration itself. Caught by mutation check: deleting
  // `min-width:0` from .vt-pack-list left the test green, because the comment
  // above it says the words "min-width:0".
  return bodies.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

test('the theatre grid caps its column, so no row can drag its siblings off screen', () => {
  const body = ruleBody('.vtheatre')
  // Without an explicit column the implicit one is `auto` — it sizes to the
  // WIDEST row, which is how one overflowing row moved every other row.
  assert.match(body, /grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
    'the single column must be pinned to the theatre width, not sized to content')
  // The rows themselves must stay explicitly placed — a display:none child is
  // removed from the grid and everything after it shifts up a row.
  assert.match(body, /grid-template-rows\s*:\s*auto 1fr auto auto auto/)
})

test('the episode strip can actually scroll, rather than only claiming to', () => {
  const body = ruleBody('.vt-pack-list')
  assert.match(body, /overflow-x\s*:\s*auto/)
  // The declaration that makes the line above mean anything.
  assert.match(body, /min-width\s*:\s*0/,
    'a flex item defaults to min-width:auto and will not shrink below its content, which defeats overflow-x entirely')
})

test('the strip row cannot outgrow its grid cell', () => {
  assert.match(ruleBody('.vt-pack'), /min-width\s*:\s*0/,
    'a grid item defaults to min-width:auto too')
})

// The rows hold fixed heights so the native mpv window's rectangle never
// resizes mid-playback and the picture never jumps. A fix for the WIDTH
// problem must not be paid for in height.
test('the overflow fix did not cost the rows their fixed heights', () => {
  assert.match(ruleBody('.vt-pack'), /height\s*:\s*46px/)
  assert.match(ruleBody('.vt-strip'), /height\s*:\s*96px/)
  // Wrapping to a second line would change the row height, which is why the
  // strip scrolls instead.
  assert.ok(!/flex-wrap\s*:\s*wrap/.test(ruleBody('.vt-pack-list')),
    'the strip must scroll, never wrap — wrapping resizes the row and the picture jumps')
})

// ── The deck row ───────────────────────────────────────────────────────────
// Found by a layout audit after the pack fix, and it is the more expensive of
// the two bugs. .vt-deck is the one theatre row with NO height contract — it
// is `auto` — so when .vt-row wrapped to a second line the deck grew 42px,
// .vt-stage (1fr) gave up exactly that, and the whole strip slid up.
//
// The stage is the rectangle the native mpv window is positioned onto, and
// bounds are re-sent only on window resize, fullscreen toggle and session
// start — there is no ResizeObserver anywhere in src/. So the picture kept its
// old, taller rectangle and covered the top of the episode row, where a click
// lands on the native video and does nothing at all.
//
// Measured at the 950px window minimum with Chapters and Source shown:
// row 42 -> 84px, deck 94 -> 136px, stage 452 -> 410px, mid-playback.
test('the deck row never wraps, so the stage never moves under the picture', () => {
  const body = ruleBody('.vt-row')
  assert.match(body, /flex-wrap\s*:\s*nowrap/,
    'wrapping grows the deck, which moves the stage, which strands the mpv rectangle')
  assert.ok(!/flex-wrap\s*:\s*wrap/.test(body), 'the old wrapping policy must be gone, not merely overridden')
  assert.match(body, /height\s*:\s*42px/, 'the deck row needs the same fixed-height contract as .vt-pack and .vt-strip')
  // The last-resort guard, for a control set that outgrows even the budget below.
  assert.match(body, /overflow-x\s*:\s*auto/)
  assert.match(body, /min-width\s*:\s*0/)
})

// Scrolling is a guard, not a plan: #vt-deck binds the wheel to volume, so the
// obvious gesture does not scroll, and the scrollbar is deliberately hidden. A
// control reachable only that way is the bug this replaces. So the narrow-width
// budget has to make scrolling unnecessary.
test('a narrow window sheds the diagnostic chip rather than the controls you watch with', () => {
  // Located by its CONTENT, not by being the first 1100px query — three
  // unrelated ones (.vbrowse, .vfilters, .vresults) come earlier in the file,
  // and matching the first of them tested nothing at all.
  const at = CSS.indexOf('.vt-row { gap:4px; }')
  assert.ok(at > 0, 'the narrow-deck budget exists')
  const open = CSS.lastIndexOf('@media', at)
  assert.ok(open > 0 && CSS.slice(open, at).includes('max-width: 1100px'),
    'the deck budget is the 1100px breakpoint')
  const block = CSS.slice(open, CSS.indexOf('\n}', at) + 2)
  assert.match(block, /#vt-stats\s*\{\s*display\s*:\s*none/,
    'Stats is diagnostic — it is what gives way')
  assert.ok(!/vt-vol-range\s*\{\s*display\s*:\s*none/.test(block),
    'the volume slider stays: it is part of watching, Stats is not')
  assert.ok(!/#vt-full|#vt-settings|#vt-subs|#vt-audio/.test(block),
    'no control that the deck exists to provide may be hidden to make room')
})
