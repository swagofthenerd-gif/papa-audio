'use strict'
// Wave-6a UI polish — accent picker (App #58), density (App #59), a11y
// (App #60), onboarding tour + what's-new (App #61), light-theme hairline pass
// (App #68) and the shortcut cheat-sheet refresh (App #69).
//
// The renderer is one Electron-only file, so each pure helper is lifted out by
// brace-matching and run in a vm context with only the globals it needs — the
// same approach settings.test.js / theme-wave10.test.js use. CSS and HTML are
// asserted as text: they cannot execute, but the token/markup contracts are
// stable strings.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const RSRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')

// Lift a top-level `function name(` out of the renderer by brace-matching.
function extract(name) {
  const start = RSRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in the renderer')
  let depth = 0
  for (let j = RSRC.indexOf('{', start); j < RSRC.length; j++) {
    if (RSRC[j] === '{') depth++
    else if (RSRC[j] === '}') { depth--; if (!depth) return RSRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function sandbox(fns) {
  const ctx = { console }
  vm.createContext(ctx)
  for (const fn of fns) vm.runInContext(extract(fn), ctx)
  return ctx
}

// ── Accent picker: colour maths (App #58) ────────────────────────────────────

test('_accentHexToRgb parses #rrggbb and #rgb, rejects junk', () => {
  const { _accentHexToRgb } = sandbox(['_accentHexToRgb'])
  // Cross-realm arrays are not reference-equal to host arrays, so compare by
  // value via join rather than deepStrictEqual.
  const rgb = h => { const v = _accentHexToRgb(h); return v && Array.from(v).join(',') }
  assert.strictEqual(rgb('#1db954'), '29,185,84')
  assert.strictEqual(rgb('#fff'), '255,255,255')
  assert.strictEqual(rgb('#000'), '0,0,0')
  assert.strictEqual(_accentHexToRgb('rgb(1,2,3)'), null)
  assert.strictEqual(_accentHexToRgb(''), null)
  assert.strictEqual(_accentHexToRgb(null), null)
  assert.strictEqual(_accentHexToRgb('#12'), null)
})

test('_accentTextColor flips to dark text on a light accent for contrast', () => {
  const { _accentTextColor, _accentLuma, _accentHexToRgb } =
    sandbox(['_accentTextColor', '_accentLuma', '_accentHexToRgb'])
  // Light accents (amber, teal, white) need black text.
  assert.strictEqual(_accentTextColor('#eab308'), '#000000', 'amber → black text')
  assert.strictEqual(_accentTextColor('#ffffff'), '#000000', 'white → black text')
  // Dark/mid accents keep white text.
  assert.strictEqual(_accentTextColor('#3b82f6'), '#ffffff', 'blue → white text')
  assert.strictEqual(_accentTextColor('#8b5cf6'), '#ffffff', 'violet → white text')
  assert.strictEqual(_accentTextColor('#000000'), '#ffffff', 'black → white text')
  // Junk falls back to white rather than throwing.
  assert.strictEqual(_accentTextColor('nope'), '#ffffff')
})

test('_accentHover lightens each channel toward white and stays a 6-digit hex', () => {
  const { _accentHover, _accentHexToRgb } = sandbox(['_accentHover', '_accentHexToRgb'])
  const h = _accentHover('#1db954')
  assert.match(h, /^#[0-9a-f]{6}$/, 'hover is a hex colour')
  const base = _accentHexToRgb('#1db954')
  const hov = _accentHexToRgb(h)
  for (let i = 0; i < 3; i++) assert.ok(hov[i] >= base[i], 'each channel is at least as bright')
  // A non-hex input is returned unchanged (no throw).
  assert.strictEqual(_accentHover('bad'), 'bad')
})

// ── Density normalisation (App #59) ──────────────────────────────────────────

test('_densityChoice normalises to the two known choices and defaults comfortable', () => {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext("const _DENSITY_CHOICES = ['comfortable','compact'];", ctx)
  vm.runInContext(extract('_densityChoice'), ctx)
  const { _densityChoice } = ctx
  assert.strictEqual(_densityChoice('compact'), 'compact')
  assert.strictEqual(_densityChoice('comfortable'), 'comfortable')
  assert.strictEqual(_densityChoice('COMPACT'), 'compact')     // case-insensitive
  assert.strictEqual(_densityChoice(''), 'comfortable')        // missing
  assert.strictEqual(_densityChoice(null), 'comfortable')      // null
  assert.strictEqual(_densityChoice('cozy'), 'comfortable')    // nonsense
})

// ── What's-new gating + trimming (App #61) ───────────────────────────────────

test('_whatsNewShouldShow only fires on a real version change, never on first run', () => {
  const { _whatsNewShouldShow } = sandbox(['_whatsNewShouldShow'])
  assert.strictEqual(_whatsNewShouldShow('1.2.0', '1.1.0'), true, 'bumped → show')
  assert.strictEqual(_whatsNewShouldShow('1.2.0', '1.2.0'), false, 'same → hide')
  assert.strictEqual(_whatsNewShouldShow('1.2.0', null), false, 'first ever run → hide (tour covers it)')
  assert.strictEqual(_whatsNewShouldShow('1.2.0', ''), false, 'no baseline → hide')
  assert.strictEqual(_whatsNewShouldShow(null, '1.1.0'), false, 'no current version → hide')
  assert.strictEqual(_whatsNewShouldShow('', '1.1.0'), false)
})

test('_whatsNewTrim keeps the intro plus the first N sections and drops the h1', () => {
  const { _whatsNewTrim } = sandbox(['_whatsNewTrim'])
  const md = [
    '# What\'s new in Papa Audio',
    '',
    'Intro line.',
    '',
    '## Section A',
    '- a1',
    '## Section B',
    '- b1',
    '## Section C',
    '- c1',
  ].join('\n')
  const out = _whatsNewTrim(md, 2)
  assert.ok(!/^#\s/m.test(out), 'the top-level h1 title is stripped')
  assert.match(out, /Intro line/, 'intro before the first heading survives')
  assert.match(out, /## Section A/)
  assert.match(out, /## Section B/)
  assert.ok(!/## Section C/.test(out), 'sections past the cap are dropped')
  // A doc with no ## headings comes back (minus the h1) rather than empty.
  const flat = _whatsNewTrim('# Title\n\nJust a paragraph.', 2)
  assert.match(flat, /Just a paragraph/)
})

// ── The tour is data-driven and gated (App #61) ──────────────────────────────

test('the five tour steps anchor to the real nav selectors, in order', () => {
  // _TOUR_STEPS is a const array of {sel,title,body}. Pull it out of the source
  // by evaluating just that declaration.
  const m = RSRC.match(/const _TOUR_STEPS = (\[[\s\S]*?\n\])/)
  assert.ok(m, '_TOUR_STEPS array found')
  // eslint-disable-next-line no-new-func
  const steps = new Function('return ' + m[1])()
  assert.strictEqual(steps.length, 5, 'exactly five steps')
  const sels = steps.map(s => s.sel)
  assert.deepStrictEqual(sels, [
    '.nav-item[data-page="library"]',
    '#nav-search',
    '#nav-soulseek',
    '.nav-item[data-page="video"]',
    '#btn-agent-chat',
  ])
  // Each anchor selector must actually exist in the markup so a step never lands
  // on nothing. (data-page attrs and ids are in index.html.)
  assert.match(HTML, /data-page="library"/)
  assert.match(HTML, /id="nav-search"/)
  assert.match(HTML, /id="nav-soulseek"/)
  assert.match(HTML, /data-page="video"/)
  assert.match(HTML, /id="btn-agent-chat"/)
  // Every step carries a title and body.
  for (const s of steps) { assert.ok(s.title && s.body, 'step has copy') }
})

test('the tour is one-shot and only started from the wizard finish', () => {
  // Gate: _maybeStartTour bails when the flag is set, and finish() calls it.
  const gate = extract('_maybeStartTour')
  assert.match(gate, /_tourDone\(\)/, 'checks the done flag first')
  assert.match(RSRC, /_maybeStartTour\(\)/, 'called from the wizard')
  // The call site is inside the wizard finish, NOT at module scope or init, so
  // it can never fire during the e2e wizard check (which never clicks Finish).
  const wiz = RSRC.slice(RSRC.indexOf('const finish = async ()'),
                         RSRC.indexOf('// Step 1 — the music-folder picker'))
  assert.match(wiz, /_maybeStartTour\(\)/, 'the tour is kicked off from finish()')
  // The done flag is a localStorage key.
  assert.match(RSRC, /_TOUR_LS_KEY = 'papa-tour-done'/)
})

// ── HTML: the new settings controls exist in the right group (App #58/#59) ────

test('the accent swatches and density select live in the general-settings group', () => {
  assert.match(HTML, /id="gen-accent-swatches"/, 'accent swatch mount exists')
  assert.match(HTML, /id="gen-density"/, 'density select exists')
  const sel = HTML.match(/<select[^>]*id="gen-density"[\s\S]*?<\/select>/)
  assert.ok(sel, 'gen-density select block found')
  assert.match(sel[0], /value="comfortable"/)
  assert.match(sel[0], /value="compact"/)
  // Both must be inside #general-settings (so the settings search finds them and
  // they sit under Appearance next to the theme control).
  const grp = HTML.match(/id="general-settings"[\s\S]*?<div class="mcs-set-group" id="playback-settings"/)
  assert.ok(grp, 'general-settings group found')
  assert.match(grp[0], /id="gen-accent-swatches"/)
  assert.match(grp[0], /id="gen-density"/)
})

// ── Persistence + early paint wiring (App #58/#59) ───────────────────────────

test('accent + density are applied early (before first paint) from PapaLocal', () => {
  const initFn = extract('init')
  assert.match(initFn, /_applyAccentEarly\(\)/, 'init applies the pinned accent early')
  assert.match(initFn, /_applyDensityEarly\(\)/, 'init applies density early')
  // The early hooks read PapaLocal, not IPC.
  assert.match(extract('_applyAccentEarly'), /PapaLocal[\s\S]*readObject\(_ACCENT_LS_KEY\)/)
  assert.match(extract('_applyDensityEarly'), /PapaLocal[\s\S]*readObject\(_DENSITY_LS_KEY\)/)
  // Keys are the agreed PapaLocal keys.
  assert.match(RSRC, /_ACCENT_LS_KEY = 'papa-accent'/)
  assert.match(RSRC, /_DENSITY_LS_KEY = 'papa-density'/)
})

test('the settings init wires both new fields before the early-return guards', () => {
  const gen = extract('_initGeneralSettings')
  assert.match(gen, /_initAccentField\(\)/)
  assert.match(gen, /_initDensityField\(\)/)
  // They come before the close-to-tray guard's early return, mirroring the theme
  // field — so a missing later control can't skip them.
  const upToGuard = gen.slice(0, gen.indexOf("getElementById('gen-close-to-tray')"))
  assert.match(upToGuard, /_initAccentField\(\)/, 'accent wired before the guard')
  assert.match(upToGuard, /_initDensityField\(\)/, 'density wired before the guard')
})

test('a pinned accent stops the album-follow colour from overriding it', () => {
  // extractAlbumColor must bail while a pin is set, else every track change
  // repaints --accent and the pin never sticks.
  const fn = extract('extractAlbumColor')
  assert.match(fn, /_accentPinned/, 'consults the pin')
  assert.match(fn, /if \(typeof _accentPinned !== 'undefined' && _accentPinned\) return/,
    'returns early when a pin is active')
})

test('_applyDensity toggles exactly the body.density-compact class', () => {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext("const _DENSITY_CHOICES = ['comfortable','compact'];", ctx)
  vm.runInContext(extract('_densityChoice'), ctx)
  // Fake document.body so the class toggle is observable.
  const classes = new Set()
  ctx.document = { body: { classList: {
    toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c) },
  } } }
  vm.runInContext(extract('_applyDensity'), ctx)
  ctx._applyDensity('compact')
  assert.ok(classes.has('density-compact'), 'compact adds the class')
  ctx._applyDensity('comfortable')
  assert.ok(!classes.has('density-compact'), 'comfortable removes it')
})

// ── CSS: the density block + hairline token (App #59/#68) ────────────────────

test('body.density-compact tightens the three list surfaces', () => {
  assert.match(CSS, /body\.density-compact \.track-row/, 'track rows')
  assert.match(CSS, /body\.density-compact \.album-grid/, 'album grid')
  assert.match(CSS, /body\.density-compact \.nav-item/, 'sidebar nav')
})

test('the --hairline token is defined in both :root and body.theme-light', () => {
  const root = CSS.match(/:root\s*\{([\s\S]*?)\n\}/)
  assert.ok(root && /--hairline\s*:/.test(root[1]), '--hairline in :root')
  const light = CSS.match(/body\.theme-light\s*\{([\s\S]*?)\}/)
  assert.ok(light && /--hairline\s*:/.test(light[1]), '--hairline in body.theme-light')
  // The light value must be a dark rgba so the hairlines stay visible on paper.
  const lm = light[1].match(/--hairline\s*:\s*rgba\(0,\s*0,\s*0/)
  assert.ok(lm, 'light --hairline is a dark (0,0,0-based) rgba')
})

test('music-surface hairlines actually adopt var(--hairline)', () => {
  // A representative sample of the converted rules — if these regress to a raw
  // rgba the light-theme pass silently un-does itself.
  assert.match(CSS, /\.titlebar[\s\S]*?border-bottom:1px solid var\(--hairline\)/)
  assert.match(CSS, /\.sidebar\b[\s\S]*?border-right:1px solid var\(--hairline\)/)
  assert.match(CSS, /\.torrent-row[\s\S]*?border-bottom: 1px solid var\(--hairline\)/)
})

// ── Shortcut cheat-sheet refresh (App #69) ───────────────────────────────────

test('the cheat-sheet lists the A–B loop and the Soulseek library keys', () => {
  const m = RSRC.match(/var ALL_SHORTCUTS = (\[[\s\S]*?\n\])/)
  assert.ok(m, 'ALL_SHORTCUTS array found')
  // eslint-disable-next-line no-new-func
  const rows = new Function('return ' + m[1])()
  const descs = rows.map(r => r.desc).join(' | ')
  assert.match(descs, /A–B loop/, 'A–B loop is listed (was bound but unlisted)')
  const cats = new Set(rows.map(r => r.category))
  assert.ok(cats.has('Soulseek library'), 'the Soulseek library key group exists')
  const slsk = rows.filter(r => r.category === 'Soulseek library').map(r => r.desc).join(' | ')
  assert.match(slsk, /Play the focused album/, 'Enter → play')
  assert.match(slsk, /Download the focused album/, 'D → download')
  assert.match(slsk, /Move between shelf cards/, 'arrows → move focus')
})

// ── A11y: aria-live + focus-visible + focus trap (App #60) ────────────────────

test('the snackbar container is an aria-live region', () => {
  const m = HTML.match(/<div class="snackbar-container"[^>]*>/)
  assert.ok(m, 'snackbar container found')
  assert.match(m[0], /aria-live="polite"/)
  assert.match(m[0], /role="status"/)
})

test('the Wave 3–5 surfaces have focus-visible rings', () => {
  // One rule covers them all; assert each selector is in it.
  assert.match(CSS, /\.dl2-sched-input:focus-visible/)
  assert.match(CSS, /\.wishlist-search-btn:focus-visible/)
  assert.match(CSS, /\.wishlist-remove-btn:focus-visible/)
  assert.match(CSS, /\.slsk-wl-target:focus-visible/)
  assert.match(CSS, /\.video-keep-item:focus-visible/)
  assert.match(CSS, /\.vcal-cell:focus-visible/)
})

test('the saved-libraries modal traps focus and closes on Escape, with clean teardown', () => {
  const fn = extract('showSlskSavedUsers')
  assert.match(fn, /_trapFocus\(dlg/, 'focus is trapped inside the modal')
  assert.match(fn, /key === 'Escape'/, 'Escape closes it')
  // Every exit path routes through _closeSaved, which removes the keydown
  // listener and releases the trap — no leaked global listener.
  assert.match(fn, /_closeSaved = \(\) => \{[\s\S]*?removeEventListener\('keydown', _onSavedKey\)/)
  assert.ok(!/\bdlg\.remove\(\)/.test(fn.replace(/_closeSaved[\s\S]*?dlg\.remove\(\)/, '')),
    'internal handlers use _closeSaved, not a bare dlg.remove that would leak the listener')
})

test('icon-only buttons that had no accessible name now carry aria-label', () => {
  // Close buttons were bare "✕".
  assert.ok((HTML + RSRC).indexOf('modal-close-btn') > -1)
  assert.match(RSRC, /id="slsk-lib-close" aria-label="Close"/)
  assert.match(RSRC, /id="slsk-saved-close" aria-label="Close"/)
  assert.match(RSRC, /class="sticky-play-btn"[^>]*aria-label="Play album"/)
  // A representative ctrl-btn now names itself.
  assert.match(RSRC, /id="album-shuffle-btn"[^>]*aria-label="Shuffle play"/)
})
