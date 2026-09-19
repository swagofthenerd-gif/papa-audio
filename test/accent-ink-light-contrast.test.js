'use strict'
// M4 — the light theme painted words in colours chosen to GLOW on black.
//
// Two separate mistakes, one symptom:
//
//   1. `.search-tab.active` was `background:var(--text); color:#000`. In dark
//      mode --text is near-white, so black-on-white reads 18:1. In light mode
//      --text IS the near-black ink, so the tab became black on black — 1.25:1,
//      the label simply gone.
//
//   2. --accent (#1db954) and the hardcoded badge colours (#f0c800, #f0a500,
//      #00c8ff, #e05c5c) are FILL colours. Used as TEXT on a light surface they
//      collapse: "Undo" 1.58, the radio badge 2.06, the playing queue title
//      1.75, "Autoplay On" 1.97, the hi-res badge 1.11, "Setup required" 1.90.
//
// The fix adds an INK pair per hue (--accent-ink / --amber-ink / --info-ink /
// --error-ink): identical to the old value in dark mode, darkened for paper.
// This test resolves the real rules through the real token blocks, so both the
// rule picking the wrong token and the token drifting to an illegible value go
// red.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { contrast, tokens } = require('./helpers/contrast')

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

const AA = 4.5
const INKS = ['--accent-ink', '--amber-ink', '--warn-ink', '--info-ink', '--error-ink']

// ── the ink tokens themselves ────────────────────────────────────────────────

test('every ink token exists in both theme blocks', () => {
  const dark = tokens('dark')
  const light = tokens('light')
  for (const ink of INKS) {
    assert.ok(dark[ink], ':root is missing ' + ink)
    assert.ok(light[ink] && light[ink] !== dark[ink],
      ink + ' must be darkened under body.theme-light, not inherited from :root')
  }
})

test('the dark ink is the colour the app already shipped — this is a paper fix', () => {
  const dark = tokens('dark')
  assert.strictEqual(dark['--accent-ink'], dark['--accent'],
    'dark mode must look exactly as before: the ink IS the accent there')
})

// ── every word that used to be painted with a fill colour ────────────────────
//
// [what it says, selector, property, surface stack topmost-first, ground last]

const WORDS = [
  ['the chosen search-result tab', '.search-tab.active', 'color', ['var(--text)']],
  ['a snackbar "Undo"', '.snackbar-action', 'color', ['var(--bg5)']],
  ['the RADIO badge', '.radio-badge', 'color', ['rgba(91,140,255,.14)', 'var(--bg)']],
  ['its pulsing dot', '.radio-badge .radio-dot', 'background', ['rgba(91,140,255,.14)', 'var(--bg)']],
  ['the playing track in the queue', '.queue-row.playing .queue-row-title', 'color',
    ['var(--accent-dim)', 'var(--bg3)']],
  ['"Autoplay On"', '.queue-autoplay-toggle.on', 'color', ['var(--bg3)']],
  ['the player-bar format badge', '.np-format', 'color', ['var(--accent-dim)', 'var(--bg4)'], 1],
  ['its HI-RES variant', '.np-format.hi-res', 'color', ['rgba(255,215,0,.12)', 'var(--bg4)']],
  ['its MASTER variant', '.np-format.master', 'color', ['rgba(0,190,255,.12)', 'var(--bg4)']],
  ['its crossfade badge', '.np-format.cf-badge', 'color', ['rgba(240,165,0,.12)', 'var(--bg4)']],
  ['the engine-down badge', '.np-format.engine-state', 'color', ['rgba(224,92,92,.14)', 'var(--bg4)']],
  ['the engine-recovering badge', '.np-format.engine-state.recovering', 'color',
    ['rgba(240,165,0,.14)', 'var(--bg4)']],
  ['a found online source', '.osrc-status.found', 'color', ['var(--bg)']],
  ['"Setup required"', '.osrc-status.setup', 'color', ['var(--bg)']],
  ['a failed online source', '.osrc-status.error', 'color', ['var(--bg)']],
  // 2026-09-19 final pass (D4): the accent-as-text leftovers the M4 sweep
  // missed, each measured on the surface it actually sits on.
  ['the chosen sort button', '.sort-btn.active', 'color', ['var(--accent-dim)', 'var(--bg)']],
  ['a Liked-songs stat number', '.liked-stat-val', 'color', ['var(--glass)', 'var(--bg)']],
  ['the chosen Manage tab', '.mg-tab.active', 'color', ['var(--accent-dim)', 'var(--bg)']],
  ['an "In Library" badge', '.in-lib-badge', 'color', ['rgba(29,185,84,.15)', 'var(--bg)']],
  ['"Following" under an artist card', '.artist-card-following.on', 'color', ['var(--bg3)']],
  // The unread-notice count lives on the RAISED player bar, not the page
  // ground: --amber-ink cleared only 4.54:1 there, so it has its own pair.
  ['the unread-notice count', '.notice-badge', 'color', ['rgba(240,165,0,.16)', 'var(--bg4)']],
]

for (const [what, selector, prop, stack, nth] of WORDS) {
  test(`light theme: ${what} is readable (${selector})`, () => {
    const value = ruleProps(selector, nth || 0)[prop]
    assert.ok(value, selector + ' must still declare ' + prop)
    const ratio = contrast(value, stack, 'light')
    assert.ok(ratio >= AA, `${selector} ${prop} is ${ratio}:1 on paper, needs ${AA}:1`)
  })

  test(`dark theme: ${what} is readable too (${selector})`, () => {
    const value = ruleProps(selector, nth || 0)[prop]
    const ratio = contrast(value, stack, 'dark')
    assert.ok(ratio >= AA, `${selector} ${prop} is ${ratio}:1 in dark mode, needs ${AA}:1`)
  })
}

// ── the two shapes of the mistake, guarded directly ──────────────────────────

test('no ink-on-surface rule reaches for a raw hex again', () => {
  for (const [what, selector, prop, , nth] of WORDS) {
    const value = ruleProps(selector, nth || 0)[prop]
    assert.ok(/^var\(--/.test(value),
      `${selector} ${prop} must be a token so the theme can move it, got ${value} (${what})`)
  }
})

test('"Setup required" carries a class instead of an inline colour', () => {
  assert.match(RENDERER, /class="osrc-status setup"/,
    'the status must take its colour from the stylesheet')
  assert.ok(!/osrc-status"\s+style="color:#/.test(RENDERER),
    'an inline hex on .osrc-status is unreachable by the light theme')
})

test('the "In Library" badge and "Following" take their colour from the sheet', () => {
  // Both used to carry a fill colour inline (#1db954 / var(--accent)), which
  // the light theme cannot reach at all.
  assert.ok(!/in-lib-badge"[^>]*style="[^"]*color:/.test(RENDERER),
    'an inline colour on .in-lib-badge is unreachable by the light theme')
  assert.ok(!/color:\$\{[^}]*'var\(--accent\)'[^}]*\}">\$\{[^}]*Following/.test(RENDERER),
    '"Following" must take its colour from a class, not an inline ternary')
  assert.match(RENDERER, /class="artist-card-following/)
})

test('the notice badge has its own ink pair, not a raw hex', () => {
  const dark = tokens('dark')
  const light = tokens('light')
  assert.strictEqual(dark['--warn-ink'], dark['--amber-ink'],
    'dark mode must look exactly as before')
  assert.ok(light['--warn-ink'] !== light['--amber-ink'],
    '--warn-ink exists because the player bar needs more headroom than --amber-ink gives')
  assert.strictEqual(ruleProps('.notice-badge').color, 'var(--warn-ink)')
})

test('the active tab uses the page ground as its label, not black', () => {
  const tab = ruleProps('.search-tab.active')
  assert.strictEqual(tab.color, 'var(--bg)',
    'a label on a --text-filled pill must be the ground colour in BOTH themes')
  assert.strictEqual(tab.background, 'var(--text)', 'the fill itself is unchanged')
})
