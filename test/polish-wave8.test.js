'use strict'
// Wave-8 app-chrome polish, run the same way settings.test.js and
// video-render.test.js run the renderer's pure helpers: the renderer and main
// process are each one giant file that cannot be required outside Electron, so
// each function under test is lifted out by brace-matching and executed in a vm
// context with only the globals it needs. Plus regex pins over the source for
// the wiring that has no return value to test (the settings field, the focus
// restoration, the error/empty states).
//
// Covers:
//   #86  window-state clamp math (multi-monitor sanity)   — main.js  _clampWindowState
//   #88  UI-scale value normalisation + persistence wiring — renderer _uiScaleValue + pins
//   #85  focus-trap helper behaviour + restoration pins    — renderer _trapFocus/_focusables
//   #81  music error states (lyrics failure) pins
//   #80  music empty states (playlist/liked/no-results CTA) pins
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC  = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const CSS  = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

// Lift a top-level `function name(` out of an arbitrary source string by
// matching braces. Same shape as the other renderer tests, but parameterised on
// the source so it can pull from main.js too.
function extractFrom(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = source.indexOf('{', start); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}
const extract = name => extractFrom(SRC, name)

// ── #86  Window-state clamp (multi-monitor sanity) ───────────────────────────

function clampCtx() {
  const ctx = { console, Math, Array }
  vm.createContext(ctx)
  vm.runInContext(extractFrom(MAIN, '_clampWindowState'), ctx)
  return ctx._clampWindowState
}

// One 1920×1080 display anchored at the origin, minus a top panel.
const ONE_SCREEN = [{ x: 0, y: 0, width: 1920, height: 1040 }]
// A second display to the right, as a laptop with an external monitor.
const TWO_SCREENS = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 2560, height: 1400 },
]

test('nothing saved means nothing to restore — the caller falls back', () => {
  const clamp = clampCtx()
  assert.strictEqual(clamp(null, ONE_SCREEN, {}), null)
  assert.strictEqual(clamp({}, ONE_SCREEN, {}), null)
  assert.strictEqual(clamp({ x: 10, y: 10 }, ONE_SCREEN, {}), null, 'a position with no size is not restorable')
})

test('a normal on-screen window is returned unchanged', () => {
  const clamp = clampCtx()
  const out = clamp({ x: 100, y: 80, width: 1400, height: 900, maximized: false }, ONE_SCREEN, {})
  assert.strictEqual(out.width, 1400)
  assert.strictEqual(out.height, 900)
  assert.strictEqual(out.x, 100)
  assert.strictEqual(out.y, 80)
  assert.strictEqual(out.maximized, false)
})

test('a window whose display was unplugged drops its position, keeps its size', () => {
  const clamp = clampCtx()
  // Saved on a second monitor at x:2000 that is gone now.
  const out = clamp({ x: 2200, y: 200, width: 1400, height: 900, maximized: false }, ONE_SCREEN, {})
  assert.strictEqual(out.width, 1400)
  assert.strictEqual(out.height, 900)
  assert.strictEqual(out.x, undefined, 'off-screen x is dropped so the OS re-centres it')
  assert.strictEqual(out.y, undefined)
})

test('a window that survives on the second display keeps its position', () => {
  const clamp = clampCtx()
  const out = clamp({ x: 2200, y: 200, width: 1400, height: 900, maximized: false }, TWO_SCREENS, {})
  assert.strictEqual(out.x, 2200)
  assert.strictEqual(out.y, 200)
})

test('a window hanging off the right edge is pulled fully back onto its display', () => {
  const clamp = clampCtx()
  // Top-left still visible, but width would run past the 1920 edge.
  const out = clamp({ x: 1700, y: 100, width: 1400, height: 900, maximized: false }, ONE_SCREEN, {})
  assert.strictEqual(out.x, 1920 - 1400, 'x pulled in so the whole frame fits')
  assert.strictEqual(out.y, 100)
})

test('a size larger than any display is capped to the largest work area', () => {
  const clamp = clampCtx()
  const out = clamp({ x: 0, y: 0, width: 4000, height: 3000, maximized: false }, ONE_SCREEN, {})
  assert.strictEqual(out.width, 1920)
  assert.strictEqual(out.height, 1040)
})

test('a size below the app floor is raised to the minimums', () => {
  const clamp = clampCtx()
  const out = clamp({ x: 0, y: 0, width: 200, height: 100 }, ONE_SCREEN,
    { width: 1400, height: 900, minWidth: 950, minHeight: 650 })
  assert.strictEqual(out.width, 950)
  assert.strictEqual(out.height, 650)
})

test('the maximized flag is carried through', () => {
  const clamp = clampCtx()
  const out = clamp({ x: 100, y: 80, width: 1400, height: 900, maximized: true }, ONE_SCREEN, {})
  assert.strictEqual(out.maximized, true)
})

test('a title bar dragged just off the top is judged not visible and dropped', () => {
  const clamp = clampCtx()
  // y far above every work area — no part of the grab band is reachable.
  const out = clamp({ x: 100, y: -400, width: 1400, height: 900 }, ONE_SCREEN, {})
  assert.strictEqual(out.x, undefined)
  assert.strictEqual(out.y, undefined)
})

test('createWindow runs the saved state through the clamp before building the window', () => {
  // The window is only as safe as its being fed clamped bounds. Pin the wiring.
  assert.match(MAIN, /_clampWindowState\(savedWin,\s*workAreas/,
    'createWindow must clamp the saved state, not use it raw')
  assert.match(MAIN, /screen\.getAllDisplays\(\)\.map\(d => d\.workArea\)/,
    'the work areas come from the live displays')
})

test('maximize and unmaximize are saved even without a move or resize', () => {
  assert.match(MAIN, /mainWindow\.on\('maximize',\s*saveWinState\)/)
  assert.match(MAIN, /mainWindow\.on\('unmaximize',\s*saveWinState\)/)
})

// ── #88  UI scale ────────────────────────────────────────────────────────────

function uiScaleCtx() {
  const ctx = { console, Math, Number, isFinite }
  vm.createContext(ctx)
  // _UI_SCALE_STEPS is a const the function closes over; declare it, then the fn.
  vm.runInContext('const _UI_SCALE_STEPS = [0.9, 1, 1.1, 1.25];', ctx)
  vm.runInContext(extract('_uiScaleValue'), ctx)
  return ctx._uiScaleValue
}

test('a stored interface size that is one of the offered steps is used as-is', () => {
  const f = uiScaleCtx()
  assert.strictEqual(f(0.9), 0.9)
  assert.strictEqual(f(1), 1)
  assert.strictEqual(f(1.1), 1.1)
  assert.strictEqual(f(1.25), 1.25)
})

test('a missing or nonsense interface size resolves to 100%', () => {
  const f = uiScaleCtx()
  assert.strictEqual(f(undefined), 1)
  assert.strictEqual(f(null), 1)
  assert.strictEqual(f('nonsense'), 1)
  assert.strictEqual(f(0), 1, 'zoom of nothing is not a real value')
  assert.strictEqual(f(-2), 1)
})

test('an off-menu value snaps to the nearest offered step', () => {
  const f = uiScaleCtx()
  assert.strictEqual(f(0.95), 0.9, 'ties/near values pick the closest step')
  assert.strictEqual(f(1.05), 1)
  assert.strictEqual(f(1.2), 1.25)
  assert.strictEqual(f(5), 1.25, 'a huge value clamps to the top step, never past it')
})

test('the interface-size field exists in the general settings group', () => {
  assert.match(HTML, /id="gen-ui-scale"/)
  assert.match(HTML, /Interface size/)
  // The four offered steps, in the exact select markup pattern.
  for (const v of ['0.9', '1', '1.1', '1.25']) {
    assert.match(HTML, new RegExp('<option value="' + v.replace('.', '\\.') + '">'))
  }
})

test('preload exposes a clamped setZoomFactor and nothing wilder', () => {
  assert.match(PRELOAD, /webFrame/, 'webFrame is required into the preload')
  assert.match(PRELOAD, /setZoomFactor:\s*\(f\)\s*=>/)
  assert.match(PRELOAD, /webFrame\.setZoomFactor\(Math\.max\(0\.5,\s*Math\.min\(2/,
    'the applied factor is clamped so a bad value cannot shrink the app to nothing')
})

test('the scale is applied at startup and persisted on change', () => {
  // Applied once before the modal exists...
  assert.match(SRC, /_applyUiScaleFromSettings\(\)/)
  assert.match(SRC, /window\.api\.setZoomFactor\(scale\)/)
  // ...and written + re-applied when the field changes.
  assert.match(SRC, /saveGeneralSettings\(\{ uiScale: v \}\)/)
  // main persists it within the offered range.
  assert.match(MAIN, /store\.set\('uiScale', s\.uiScale\)/)
  assert.match(MAIN, /uiScale: store\.get\('uiScale', 1\)/)
})

// ── #85  Focus management ────────────────────────────────────────────────────

// A minimal focus-aware fake DOM. Elements track focus() calls; the container
// dispatches synthetic keydowns to the listener the trap installs.
function makeFakeDom() {
  let active = { focus() { active = this }, tagName: 'BODY' }
  const doc = {
    get activeElement() { return active },
    contains: () => true,
  }
  function el(id, opts) {
    opts = opts || {}
    return {
      id,
      tagName: opts.tag || 'BUTTON',
      disabled: !!opts.disabled,
      offsetWidth: opts.hidden ? 0 : 40,
      offsetHeight: opts.hidden ? 0 : 20,
      focus() { active = this },
    }
  }
  function container(children) {
    let handler = null
    return {
      _children: children,
      contains(node) { return children.indexOf(node) !== -1 || node === this },
      querySelector(sel) {
        // Support only '#id' and the focusables selector shape used in tests.
        if (sel[0] === '#') return children.find(c => c.id === sel.slice(1)) || null
        return children[0] || null
      },
      querySelectorAll() { return children },
      addEventListener(type, fn) { if (type === 'keydown') handler = fn },
      removeEventListener() { handler = null },
      focus() { active = this },
      _fireTab(shiftKey) {
        let prevented = false
        handler && handler({ key: 'Tab', shiftKey: !!shiftKey, preventDefault() { prevented = true } })
        return prevented
      },
      get _hasHandler() { return !!handler },
    }
  }
  return { doc, el, container, get active() { return active }, setActive(n) { active = n } }
}

function trapCtx(dom) {
  const ctx = {
    console, Array, document: dom.doc,
  }
  vm.createContext(ctx)
  vm.runInContext(extract('_focusables'), ctx)
  vm.runInContext(extract('_trapFocus'), ctx)
  return ctx
}

test('opening a modal moves focus into it, to the named target', () => {
  const dom = makeFakeDom()
  const closeBtn = dom.el('np-modal-close')
  const other = dom.el('np-next')
  const modal = dom.container([other, closeBtn])
  const ctx = trapCtx(dom)
  const opener = { focus() { dom.setActive(this) }, tagName: 'BUTTON' }
  dom.setActive(opener)
  ctx._trapFocus(modal, { initial: '#np-modal-close' })
  assert.strictEqual(dom.active, closeBtn, 'focus moved to the requested initial element')
})

test('with no named target, focus lands on the first focusable', () => {
  const dom = makeFakeDom()
  const first = dom.el('a')
  const second = dom.el('b')
  const modal = dom.container([first, second])
  const ctx = trapCtx(dom)
  ctx._trapFocus(modal, {})
  assert.strictEqual(dom.active, first)
})

test('closing the modal returns focus to whoever opened it', () => {
  const dom = makeFakeDom()
  const btn = dom.el('x')
  const modal = dom.container([btn])
  const ctx = trapCtx(dom)
  const opener = { focus() { dom.setActive(this) }, tagName: 'BUTTON' }
  dom.setActive(opener)
  const release = ctx._trapFocus(modal, {})
  assert.strictEqual(dom.active, btn, 'focus went in on open')
  release()
  assert.strictEqual(dom.active, opener, 'focus came back to the opener on close')
})

test('release is idempotent — a second call does not steal focus again', () => {
  const dom = makeFakeDom()
  const btn = dom.el('x')
  const modal = dom.container([btn])
  const ctx = trapCtx(dom)
  const opener = { focus() { dom.setActive(this) }, tagName: 'BUTTON' }
  dom.setActive(opener)
  const release = ctx._trapFocus(modal, {})
  release()
  const somethingElse = { focus() { dom.setActive(this) }, tagName: 'INPUT' }
  dom.setActive(somethingElse)
  release()   // second release must be a no-op
  assert.strictEqual(dom.active, somethingElse, 'the trap does not yank focus after it is released')
  assert.strictEqual(modal._hasHandler, false, 'the keydown listener is unbound once')
})

test('Tab wraps from the last focusable back to the first', () => {
  const dom = makeFakeDom()
  const first = dom.el('a')
  const last = dom.el('b')
  const modal = dom.container([first, last])
  const ctx = trapCtx(dom)
  ctx._trapFocus(modal, {})
  dom.setActive(last)
  const prevented = modal._fireTab(false)
  assert.strictEqual(prevented, true, 'the default tab-out is prevented')
  assert.strictEqual(dom.active, first, 'focus wrapped to the first element')
})

test('Shift+Tab wraps from the first focusable back to the last', () => {
  const dom = makeFakeDom()
  const first = dom.el('a')
  const last = dom.el('b')
  const modal = dom.container([first, last])
  const ctx = trapCtx(dom)
  ctx._trapFocus(modal, {})
  dom.setActive(first)
  const prevented = modal._fireTab(true)
  assert.strictEqual(prevented, true)
  assert.strictEqual(dom.active, last)
})

test('disabled and hidden controls are not counted as focusable', () => {
  const dom = makeFakeDom()
  const ctx = trapCtx(dom)
  const good = dom.el('good')
  const off  = dom.el('off', { disabled: true })
  const gone = dom.el('gone', { hidden: true })
  const list = ctx._focusables({ querySelectorAll: () => [good, off, gone] })
  // _focusables leans on the CSS selector to drop [disabled]; our fake returns
  // all three, so the visibility filter must still drop the hidden one, and the
  // disabled one is only excluded by the selector in the real DOM — assert the
  // selector names it.
  assert.ok(list.indexOf(gone) === -1, 'a zero-box element is filtered out')
  const fn = extract('_focusables')
  assert.match(fn, /:not\(\[disabled\]\)/, 'the selector excludes disabled controls')
})

test('the primary modals now trap focus and restore it', () => {
  // Now Playing
  assert.match(SRC, /modal\._releaseFocus = _trapFocus\(modal, \{ initial: '#np-modal-close' \}\)/)
  assert.match(SRC, /if \(modal\._releaseFocus\) \{ try \{ modal\._releaseFocus\(\)/)
  // Shortcuts overlay, both open and close paths through the toggle
  assert.match(SRC, /m\._releaseFocus = _trapFocus\(m, \{ initial: '\.shortcuts-close' \}\)/)
  // The Escape cascade closes the shortcuts modal through the toggle so focus
  // returns, rather than a raw display:none.
  assert.match(SRC, /sm\.style\.display !== 'none'\) \{ toggleChatSidebar\(\)|sm && sm\.style\.display !== 'none'\) \{ toggleShortcutsModal\(\)/)
})

test('the agent/settings panel restores focus to its opener and closes on Escape', () => {
  assert.match(SRC, /_mcsOpener = \(btn && document\.contains\(btn\)\) \? btn : document\.activeElement/)
  assert.match(SRC, /if \(chatState\.open\) \{ toggleChatSidebar\(\); return \}/)
})

// ── #81  Music error states ──────────────────────────────────────────────────

test('a failed lyrics fetch is told apart from a song with no lyrics', () => {
  // The catch sets an error flag rather than silently swallowing.
  assert.match(SRC, /_lyricsError = true/)
  assert.match(SRC, /let _lyricsError = false/)
})

test('the lyrics error state names the failure and offers a retry', () => {
  const panel = extract('renderLyricsPanel')
  assert.match(panel, /Couldn't fetch lyrics/, 'the message names what failed')
  assert.match(panel, /lyrics-retry-btn/, 'a retry button is offered')
  assert.match(panel, /loadLyricsFor\(t\)/, 'the retry actually re-runs the fetch')
  // The drawer variant carries the same affordance.
  const drawer = extract('updateLyricsDrawer')
  assert.match(drawer, /Couldn't fetch lyrics/)
  assert.match(drawer, /lyrics-drawer-retry/)
})

test('the retry button has a style so it reads as an action', () => {
  assert.match(CSS, /\.lyrics-retry-btn \{/)
})

// ── #80  Music empty states ──────────────────────────────────────────────────

test('the empty playlists page offers a create button, not just a sentence', () => {
  assert.match(SRC, /No playlists yet\. Create one to get started\./)
  assert.match(SRC, /id="pl-empty-new-btn"/)
  assert.match(SRC, /getElementById\('pl-empty-new-btn'\)\?\.addEventListener\('click', function\(\) \{\s*_showNewPlaylistWithFolder\(\)/)
})

test('the empty liked-songs page offers a way to find music', () => {
  assert.match(SRC, /No liked songs yet\. Tap the heart on any track\./)
  assert.match(SRC, /id="liked-empty-find-btn"/)
  assert.match(SRC, /getElementById\('liked-empty-find-btn'\)\?\.addEventListener\('click', \(\) => navigate\('search'\)\)/)
})

test('an empty individual playlist points at the library', () => {
  assert.match(SRC, /id="pl-empty-browse-btn"/)
  assert.match(SRC, /getElementById\('pl-empty-browse-btn'\)\?\.addEventListener\('click', \(\) => navigate\('library'\)\)/)
})

test('the no-results search state routes to the P2P results already loading', () => {
  assert.match(SRC, /id="search-empty-slsk-btn"/)
  assert.match(SRC, /getElementById\('search-empty-slsk-btn'\)\?\.addEventListener/)
  // QA #17: the jump is one helper that scrolls the lane AND moves focus to it.
  const jump = SRC.slice(SRC.indexOf('function _jumpToSlskLane('), SRC.indexOf('function _jumpToSlskLane(') + 600)
  assert.match(jump, /getElementById\('slsk-section'\)/)
  assert.match(jump, /scrollIntoView/)
  assert.match(jump, /sec\.focus\(/, 'a jump that only scrolls leaves the keyboard user at the top')
})

test('all four empty-state buttons share one CSS class', () => {
  assert.match(CSS, /\.empty-cta-btn \{/)
  // Four call sites in the renderer wearing the same class.
  const hits = (SRC.match(/class="empty-cta-btn"/g) || []).length
  assert.ok(hits >= 4, 'expected at least four empty-cta-btn buttons, found ' + hits)
})
