'use strict'
// App #87 — light theme for the music side.
//
// Covers, per the wave-10 brief:
//   1. token-block completeness — every dark :root colour token has a
//      body.theme-light counterpart (the whole light theme rides on this);
//   2. the cinema dark PIN — body.theme-light .cinema re-asserts dark ground +
//      ink so entering the theatre in light mode is still the full dark cinema;
//   3. setting wiring / persistence — _themeChoice normalisation, _resolveTheme
//      (dark/light/system), the store round-trip guard in main.js, the HTML
//      control, and the localStorage early-paint mirror;
//   4. system-follow listener guard — the resolver's 'system' branch and the
//      choice-normalisation the live listener leans on.
//
// The renderer is one giant Electron-only file, so — exactly like
// settings.test.js and video-render — each pure helper is lifted out by
// brace-matching and run in a vm context with only the globals it needs. The
// CSS and HTML are asserted as text: they cannot be executed, but the token
// contract and markup are stable strings.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const RSRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')

function extract(src, name) {
  const start = src.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// Build a sandbox holding the pure theme helpers. matchMedia/localStorage are
// intentionally absent so the guarded fallbacks (dark, "no signal") are what
// runs unless a test injects them.
function sandbox(globals) {
  const ctx = Object.assign({ console, window: {} }, globals || {})
  vm.createContext(ctx)
  // _THEME_CHOICES is a const the helpers close over; declare it first.
  vm.runInContext("const _THEME_CHOICES = ['dark','light','system'];", ctx)
  for (const fn of ['_themeChoice', '_resolveTheme']) {
    vm.runInContext(extract(RSRC, fn), ctx)
  }
  return ctx
}

// ── 1. Token-block completeness ──────────────────────────────────────────────

// The colour tokens declared in :root that the theme must re-skin. Layout,
// font, radius and easing tokens are theme-neutral and deliberately excluded.
const COLOUR_TOKENS = [
  '--text1', '--border', '--color-error', '--color-error-hover', '--accent-hover',
  '--surface-card', '--bg', '--bg2', '--bg3', '--bg4', '--bg5', '--accent',
  '--accent-dim', '--accent-glow', '--text', '--text2', '--text3',
  '--glass', '--glass-hi', '--glass-border',
]

function lightBlock() {
  const m = CSS.match(/body\.theme-light\s*\{([\s\S]*?)\}/)
  assert.ok(m, 'body.theme-light block must exist in styles.css')
  return m[1]
}

test('every dark colour token has a body.theme-light counterpart', () => {
  const block = lightBlock()
  for (const tok of COLOUR_TOKENS) {
    assert.ok(
      new RegExp('\\' + tok + '\\s*:').test(block),
      `light theme is missing a value for ${tok} — add it under body.theme-light`
    )
  }
})

test('the light block redefines the same token set the :root block declares', () => {
  // Guard against drift: if someone adds a colour token to :root but forgets
  // the light value, the completeness list above should have caught it — this
  // test additionally checks nothing in COLOUR_TOKENS is a typo by confirming
  // each is actually declared in :root too.
  const rootM = CSS.match(/:root\s*\{([\s\S]*?)\n\}/)
  assert.ok(rootM, ':root block found')
  const root = rootM[1]
  for (const tok of COLOUR_TOKENS) {
    assert.ok(new RegExp('\\' + tok + '\\s*:').test(root), `${tok} should exist in :root`)
  }
})

test('the light ground is warm paper, not stark white, and text meets a dark ink', () => {
  const block = lightBlock()
  // --bg must be a light value but not #fff / #ffffff (the brief: warm paper).
  const bg = block.match(/--bg\s*:\s*(#[0-9a-fA-F]{3,6})/)
  assert.ok(bg, '--bg is a hex in the light block')
  assert.ok(!/^#f{3}$|^#f{6}$/i.test(bg[1]), '--bg must not be stark white')
  // --text must be a dark ink (each channel low) for contrast.
  const txt = block.match(/--text\s*:\s*#([0-9a-fA-F]{6})/)
  assert.ok(txt, '--text is a 6-digit hex')
  const r = parseInt(txt[1].slice(0, 2), 16)
  assert.ok(r < 80, '--text must be a dark ink in light mode, got #' + txt[1])
})

// ── 2. Cinema dark pin ───────────────────────────────────────────────────────

test('body.theme-light .cinema pins the dark cinema ground and ink', () => {
  const m = CSS.match(/body\.theme-light\s+\.cinema\s*\{([\s\S]*?)\}/)
  assert.ok(m, 'the cinema pin selector must exist so the theatre stays dark in light mode')
  const block = m[1]
  // The pin must re-declare the dark ground and bone tokens...
  assert.match(block, /--cin-ground\s*:\s*#0B0B0C/i, 'pin re-declares dark --cin-ground')
  assert.match(block, /--cin-bone\s*:\s*#EDE8E0/i, 'pin re-declares light-on-dark --cin-bone')
  // ...and actually paint them onto the section root.
  assert.match(block, /background\s*:\s*var\(--cin-ground\)/, 'pin paints the dark ground')
  assert.match(block, /color\s*:\s*var\(--cin-bone\)/, 'pin paints the bone ink')
})

test('the cinema never reaches for a shared --bg/--text token for its own ground', () => {
  // Design decision 1/3: the cinema draws from --cin-* only. If a .cinema rule
  // set its background to a shared token it would lighten in light mode. Assert
  // the .cinema root block sets background from --cin-ground.
  const m = CSS.match(/\n\.cinema\s*\{([\s\S]*?)\}/)
  assert.ok(m, '.cinema root block found')
  assert.match(m[1], /background\s*:\s*var\(--cin-ground\)/, '.cinema draws its own dark ground')
})

// ── 3. Setting wiring / persistence ──────────────────────────────────────────

test('_themeChoice normalises to the three known choices and defaults to dark', () => {
  const { _themeChoice } = sandbox()
  assert.strictEqual(_themeChoice('dark'), 'dark')
  assert.strictEqual(_themeChoice('light'), 'light')
  assert.strictEqual(_themeChoice('system'), 'system')
  assert.strictEqual(_themeChoice('LIGHT'), 'light')      // case-insensitive
  assert.strictEqual(_themeChoice(''), 'dark')            // missing
  assert.strictEqual(_themeChoice(null), 'dark')          // null
  assert.strictEqual(_themeChoice(undefined), 'dark')     // absent
  assert.strictEqual(_themeChoice('sepia'), 'dark')       // nonsense / old build
})

test('_resolveTheme honours explicit dark and light regardless of the system signal', () => {
  const { _resolveTheme } = sandbox()
  assert.strictEqual(_resolveTheme('dark', true), 'dark')
  assert.strictEqual(_resolveTheme('dark', false), 'dark')
  assert.strictEqual(_resolveTheme('light', false), 'light')
  assert.strictEqual(_resolveTheme('light', true), 'light')
})

test('the store round-trips theme and drops anything that is not a known choice', () => {
  // The handler reads theme with a dark default...
  assert.match(MAIN, /theme:\s*store\.get\('theme',\s*'dark'\)/, 'get-general-settings returns theme')
  // ...and the save guard only persists the three known values.
  assert.match(
    MAIN,
    /s\.theme === 'dark' \|\| s\.theme === 'light' \|\| s\.theme === 'system'/,
    'save-general-settings guards theme to the known choices'
  )
})

test('the Appearance control exists in the general settings group with all three options', () => {
  assert.match(HTML, /id="gen-theme"/, 'the Appearance <select> exists')
  const sel = HTML.match(/<select[^>]*id="gen-theme"[\s\S]*?<\/select>/)
  assert.ok(sel, 'gen-theme select block found')
  assert.match(sel[0], /value="dark"/,   'Dark option')
  assert.match(sel[0], /value="light"/,  'Light option')
  assert.match(sel[0], /value="system"/, 'Follow system option')
  // It must live inside the general-settings group so it lands in the right
  // section and the settings search can find it.
  const grp = HTML.match(/id="general-settings"[\s\S]*?<\/div>\s*<div class="mcs-set-group"/)
  assert.ok(grp && /id="gen-theme"/.test(grp[0]), 'gen-theme is inside #general-settings')
})

test('the field initialiser wires persistence to both the store and the early-paint mirror', () => {
  const init = extract(RSRC, '_initThemeField')
  assert.match(init, /getElementById\('gen-theme'\)/, 'reads the gen-theme control')
  assert.match(init, /saveGeneralSettings\(\{\s*theme:/, 'persists theme to the store on change')
  assert.match(init, /localStorage\.setItem\(_THEME_LS_KEY/, 'mirrors the choice to localStorage')
  assert.match(init, /_applyThemeMode\(_resolveTheme/, 're-applies the resolved mode on change')
})

test('early paint applies the theme synchronously from the localStorage mirror', () => {
  const early = extract(RSRC, '_applyThemeEarly')
  assert.match(early, /localStorage\.getItem\(_THEME_LS_KEY\)/, 'reads the mirror, not IPC')
  assert.match(early, /_applyThemeMode\(_resolveTheme/, 'sets the class before first paint')
  // And init() actually calls it.
  const initFn = extract(RSRC, 'init')
  assert.match(initFn, /_applyThemeEarly\(\)/, 'init() calls the early-paint hook')
})

// ── 4. System-follow listener guard ──────────────────────────────────────────

test("_resolveTheme('system', …) follows the OS signal", () => {
  const { _resolveTheme } = sandbox()
  assert.strictEqual(_resolveTheme('system', true), 'light', 'system + OS light → light')
  assert.strictEqual(_resolveTheme('system', false), 'dark', 'system + OS dark → dark')
})

test("'system' with no signal resolves to dark (the app default)", () => {
  const { _resolveTheme } = sandbox()
  assert.strictEqual(_resolveTheme('system', undefined), 'dark')
  assert.strictEqual(_resolveTheme('system'), 'dark')
})

test('the live system listener is bound at most once and only follows when the choice is system', () => {
  const bind = extract(RSRC, '_bindThemeSystemListener')
  // A guard flag prevents stacking duplicate MediaQueryList listeners.
  assert.match(bind, /_themeSystemListenerBound/, 'guards against duplicate listeners')
  // It re-checks the stored preference each fire, so explicit dark/light ignore
  // the OS — the listener is a no-op unless the choice is 'system'.
  assert.match(bind, /_themePref === 'system'/, "only re-skins live when the choice is 'system'")
  // Uses the modern addEventListener with the deprecated addListener fallback.
  assert.match(bind, /addEventListener\('change'/, 'modern MediaQueryList API')
  assert.match(bind, /addListener\(/, 'deprecated-engine fallback')
})

test('_systemPrefersLight is guarded against a missing matchMedia', () => {
  const fn = extract(RSRC, '_systemPrefersLight')
  assert.match(fn, /window\.matchMedia/, 'consults matchMedia')
  assert.match(fn, /catch\s*\([^)]*\)\s*\{\s*return false/, 'falls back to no-signal on throw')
})
