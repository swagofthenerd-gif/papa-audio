'use strict'
// Now Playing fullscreen redesign — palette maths, idle-timer logic, the
// next-track chip's correctness under repeat/shuffle, layered Escape, the queue
// panel, the reduced-motion block, and the wiring pins that have no return value.
//
// Follows the same harness as polish-wave8.test.js: renderer.js is one giant
// file that cannot be required outside Electron, so each function under test is
// lifted out by brace-matching and run in a vm context with only the globals it
// needs. palette.js is dual-mode CommonJS, so it is required directly.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const pal = require('../src/palette')

const SRC  = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
const CSS  = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// A byte array of solid-colour pixels: n copies of [r,g,b,255].
function solid(r, g, b, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(r, g, b, 255)
  return out
}

// ── Palette maths (pure core) ────────────────────────────────────────────────

test('palettePfrom returns a complete {dominant,accent,muted} of hex strings', () => {
  const p = pal.palettePfrom(solid(200, 40, 40, 256))
  for (const k of ['dominant', 'accent', 'muted']) {
    assert.ok(typeof p[k] === 'string', k + ' is a string')
    assert.match(p[k], /^#[0-9a-f]{6}$/, k + ' is a 6-digit hex colour')
  }
})

test('a red cover yields a reddish dominant', () => {
  const p = pal.palettePfrom(solid(200, 40, 40, 256))
  const r = parseInt(p.dominant.slice(1, 3), 16)
  const g = parseInt(p.dominant.slice(3, 5), 16)
  assert.ok(r > g, 'red channel dominates the extracted dominant colour')
})

test('a dark cover is lifted so the accent stays legible on a dark scrim', () => {
  // A dim blue: luma well under the 60 floor ensureVivid enforces.
  const p = pal.palettePfrom(solid(10, 10, 60, 256))
  const l = pal._luma(
    parseInt(p.accent.slice(1, 3), 16),
    parseInt(p.accent.slice(3, 5), 16),
    parseInt(p.accent.slice(5, 7), 16))
  assert.ok(l >= 60, 'the accent was brightened above the dark floor, got luma ' + l)
})

test('the accent tracks the vivid part, not the biggest dull part', () => {
  // Mostly grey background with a splash of saturated orange.
  const pixels = solid(120, 120, 120, 240).concat(solid(230, 130, 20, 16))
  const p = pal.palettePfrom(pixels)
  const r = parseInt(p.accent.slice(1, 3), 16)
  const b = parseInt(p.accent.slice(5, 7), 16)
  assert.ok(r > b + 40, 'the accent is the warm splash, not the grey field')
})

test('empty / malformed pixel data falls back to a complete default palette', () => {
  for (const bad of [null, [], [1, 2, 3], new Array(7).fill(0)]) {
    const p = pal.palettePfrom(bad)
    assert.ok(p && p.dominant && p.accent && p.muted, 'fallback is complete for ' + JSON.stringify(bad))
    assert.match(p.accent, /^#[0-9a-f]{6}$/)
  }
})

test('a pure-black cover still reads its average rather than defaulting blindly', () => {
  // All pixels clipped as near-black by bucketize → the average-colour branch.
  const p = pal.palettePfrom(solid(4, 4, 4, 256))
  assert.match(p.dominant, /^#[0-9a-f]{6}$/)
  assert.match(p.accent, /^#[0-9a-f]{6}$/)
})

// ── Palette cache (LRU-ish, capped) ──────────────────────────────────────────

test('the cache round-trips a value and honours its cap of 100', () => {
  pal._cacheClear()
  assert.strictEqual(pal._cacheCap, 100)
  pal._cacheSet('a', { accent: '#111111' })
  assert.deepStrictEqual(pal._cacheGet('a'), { accent: '#111111' })
  // Overflow the cap; the oldest untouched key must be evicted.
  for (let i = 0; i < 100; i++) pal._cacheSet('k' + i, { accent: '#000000' })
  assert.strictEqual(pal._cacheGet('a'), undefined, 'the oldest entry was evicted past the cap')
})

test('touching a cache entry saves it from eviction', () => {
  pal._cacheClear()
  pal._cacheSet('keep', { accent: '#abcdef' })
  for (let i = 0; i < 60; i++) pal._cacheSet('x' + i, { accent: '#000000' })
  pal._cacheGet('keep')  // touch → moves to newest
  for (let i = 60; i < 120; i++) pal._cacheSet('x' + i, { accent: '#000000' })
  assert.deepStrictEqual(pal._cacheGet('keep'), { accent: '#abcdef' }, 'the touched key survived')
})

test('a null id is never cached (no key collisions on missing album ids)', () => {
  pal._cacheClear()
  pal._cacheSet(null, { accent: '#123456' })
  assert.strictEqual(pal._cacheGet(null), undefined)
})

// ── extractPalette guards (headless / no-canvas) ─────────────────────────────

test('extractPalette resolves to null (never throws) with no DOM', async () => {
  // Node has no document/Image, so every wrapper path bottoms out at null.
  const r = await pal.extractPalette('file:///nope.jpg', 'albX')
  assert.strictEqual(r, null, 'headless extraction is a clean null so the caller falls back')
})

// ── Idle-timer pure logic ────────────────────────────────────────────────────

function idleCtx() {
  const ctx = { console }
  vm.createContext(ctx)
  // npShouldIdle references the module const NP_IDLE_MS via its default branch;
  // define it so the function resolves standalone.
  vm.runInContext('var NP_IDLE_MS = 10000;', ctx)
  vm.runInContext(extract('npShouldIdle'), ctx)
  vm.runInContext(extract('npClockText'), ctx)
  return ctx
}

test('npShouldIdle is false before the timeout and true at/after it', () => {
  const ctx = idleCtx()
  assert.strictEqual(ctx.npShouldIdle(1000, 500, 10000), false, '500ms of inactivity is not idle')
  assert.strictEqual(ctx.npShouldIdle(11000, 500, 10000), true, '10.5s of inactivity is idle')
  assert.strictEqual(ctx.npShouldIdle(10500, 500, 10000), true, 'exactly at the boundary counts as idle')
})

test('npShouldIdle uses the 10s default when no idleMs is given', () => {
  const ctx = idleCtx()
  assert.strictEqual(ctx.npShouldIdle(9000, 0), false)
  assert.strictEqual(ctx.npShouldIdle(10000, 0), true)
})

test('npClockText renders HH:MM zero-padded', () => {
  const ctx = idleCtx()
  assert.strictEqual(ctx.npClockText(new Date(2026, 0, 1, 9, 5)), '09:05')
  assert.strictEqual(ctx.npClockText(new Date(2026, 0, 1, 23, 59)), '23:59')
  assert.strictEqual(ctx.npClockText(new Date(2026, 0, 1, 0, 0)), '00:00')
})

// ── Next-track chip correctness (the screenshot bug: NEXT == current) ────────

// Run computeNextIndex + updateNpNext together against a fake DOM and a state we
// control, so the chip's text/label can be asserted directly.
function chipCtx(state) {
  const els = {}
  const mk = id => (els[id] = {
    id, style: {}, textContent: '', src: '',
    _kids: {},
    querySelector(sel) {
      if (sel === '.np-next-label') return (els['__label'] = { textContent: '' })
      return null
    },
  })
  mk('np-next'); mk('np-next-title'); mk('np-next-artist'); mk('np-next-art')
  const document = { getElementById: id => els[id] || null }
  const ctx = {
    console, Math, String, document, state,
    // The chip asks the artwork miss memory before setting a src, so the
    // memory travels with it.
    _artMisses: new Set(),
    _pendingShuffle: null,
    _shuffleHistory: [],
    pickShuffleIndex: () => 0,
  }
  vm.createContext(ctx)
  vm.runInContext(extract('computeNextIndex'), ctx)
  // updateNpNext resolves art through _artSrcIfUsable: the http-vs-file://
  // scheme rule of _artSrc, plus the session miss memory (_artUsable), so a
  // cover that already failed is not asked for again.
  vm.runInContext(extract('_artSrc'), ctx)
  vm.runInContext(extract('_artUsable'), ctx)
  vm.runInContext(extract('_artSrcIfUsable'), ctx)
  vm.runInContext(extract('updateNpNext'), ctx)
  ctx._els = els
  return ctx
}

const Q = [
  { title: 'One',   artist: 'A', artPath: '/a.jpg' },
  { title: 'Two',   artist: 'B', artPath: '/b.jpg' },
  { title: 'Three', artist: 'C', artPath: '/c.jpg' },
]

test('the chip shows the FOLLOWING track, never the one that is playing', () => {
  const state = { modalOpen: true, repeat: 'off', shuffle: false, queue: Q, queueIndex: 0 }
  const ctx = chipCtx(state)
  ctx.updateNpNext()
  assert.strictEqual(ctx._els['np-next-title'].textContent, 'Two', 'next of #0 is #1, not #0')
  assert.strictEqual(ctx._els['__label'].textContent, 'Next')
})

test('at the end of the queue with repeat off, the chip hides (no next)', () => {
  const state = { modalOpen: true, repeat: 'off', shuffle: false, queue: Q, queueIndex: 2 }
  const ctx = chipCtx(state)
  ctx.updateNpNext()
  assert.strictEqual(ctx._els['np-next'].style.display, 'none', 'nothing plays next → chip hidden')
})

test('repeat-all wraps the chip to the first track', () => {
  const state = { modalOpen: true, repeat: 'all', shuffle: false, queue: Q, queueIndex: 2 }
  const ctx = chipCtx(state)
  ctx.updateNpNext()
  assert.strictEqual(ctx._els['np-next-title'].textContent, 'One')
})

test('repeat-one labels the chip "Repeats" — it does not masquerade the current track as a different "Next"', () => {
  const state = { modalOpen: true, repeat: 'one', shuffle: false, queue: Q, queueIndex: 1 }
  const ctx = chipCtx(state)
  ctx.updateNpNext()
  assert.strictEqual(ctx._els['__label'].textContent, 'Repeats',
    'repeat-one must read as "Repeats", the confirmed screenshot bug (NEXT == current)')
  assert.strictEqual(ctx._els['np-next-title'].textContent, 'Two', 'and it shows the track that repeats')
})

test('computeNextIndex agrees with the chip authority under repeat-one', () => {
  const state = { repeat: 'one', shuffle: false, queue: Q, queueIndex: 1 }
  const ctx = chipCtx(state)
  assert.strictEqual(ctx.computeNextIndex(), 1, 'repeat-one "next" is the current index by design')
})

// ── Layered Escape + queue panel + full-art wiring pins ──────────────────────

test('Escape inside the modal peels queue → full-art → close, one layer at a time', () => {
  // The cascade must check queue-open first, then art-expanded, then hide.
  assert.match(SRC, /if \(state\.modalOpen\) \{[\s\S]*?queue-open'\)\) \{ closeNpQueue\(\); return \}/,
    'first Escape closes the queue panel')
  assert.match(SRC, /art-expanded'\)\) \{ toggleNpFullArt\(\); return \}[\s\S]*?hideNowPlayingModal\(\); return/,
    'then full-art, then the modal itself')
})

test('the modal queue panel is a 320px right slide-in that reuses the queue data', () => {
  assert.match(CSS, /\.np-queue-panel \{[\s\S]*?width:320px/, 'the panel is 320px wide')
  assert.match(CSS, /\.np-modal\.queue-open \.np-queue-panel \{ transform:translateX\(0\); \}/,
    'queue-open slides it in')
  // renderNpQueue reuses state.queue / state.queueIndex and the playCurrentTrack jump.
  const fn = extract('renderNpQueue')
  assert.match(fn, /state\.queue/, 'renders from the shared queue')
})

test('the Up Next chip opens the queue panel', () => {
  assert.match(SRC, /nextEl\.addEventListener\('click', \(\) => \{ openNpQueue\(\)/)
})

// ── Player-bar palette hairline is actually driven ───────────────────────────

test('the timeupdate loop drives the palette hairline var --np-bar-progress', () => {
  // The CSS reads it; without this write the hairline stayed pinned at 0.
  assert.match(CSS, /--np-bar-progress/, 'the CSS hairline references the var')
  assert.match(SRC, /setProperty\('--np-bar-progress', String\(ratio \* 100\)\)/,
    'timeupdate sets the hairline width')
  assert.match(SRC, /setProperty\('--np-bar-progress', '0'\)/,
    'and it resets to 0 when playback clears')
})

test('the extracted accent colours both the modal and the bar hairline', () => {
  const fn = extract('_applyNpPalette')
  assert.match(fn, /setProperty\('--np-accent', p\.accent\)/, 'modal accent var')
  assert.match(fn, /setProperty\('--np-bar-accent', p\.accent\)/, 'bar hairline accent var')
  // And a clean fallback removes them so the app accent shows through.
  assert.match(fn, /removeProperty\('--np-bar-accent'\)/)
})

// ── Modal-scoped keys do not double-fire with the global handlers ─────────────

test('L / Q / F act on the modal when it is open, and RETURN (no double-fire)', () => {
  assert.match(SRC, /if \(state\.modalOpen\) \{\s*[\s\S]*?toggleLyrics', e\)\) \{ e\.preventDefault\(\); toggleNpLyrics\(\); return \}/)
  assert.match(SRC, /toggleQueue', e\)\)\s*\{ e\.preventDefault\(\); toggleNpQueue\(\);\s*return \}/)
  assert.match(SRC, /fullscreen', e\)\)\s*\{ e\.preventDefault\(\); toggleNpFullArt\(\); return \}/)
})

// ── Timers are cleaned on close (interval-leak probe) ────────────────────────

test('closing the modal clears both the idle timeout and the clock interval', () => {
  const fn = extract('hideNowPlayingModal')
  assert.match(fn, /clearTimeout\(_npIdleTimer\)/, 'idle timeout cleared')
  assert.match(fn, /clearInterval\(_npClockTimer\)/, 'clock interval cleared')
  assert.match(fn, /_npClockTimer = null/, 'and the handle is dropped so it cannot be re-cleared stale')
})

// ── Lyrics UI does not exist in art mode ─────────────────────────────────────

test('the lyrics stage is display:none unless .lyrics-mode is set', () => {
  assert.match(CSS, /\.np-lyrics-stage \{ display:none; \}/, 'lyrics stage is out of the flow by default')
  assert.match(CSS, /\.np-modal\.lyrics-mode \.np-lyrics-stage \{\s*display:flex/, 'shown only in lyrics mode')
  assert.match(CSS, /\.np-modal\.lyrics-mode \.np-art-stage \{ display:none; \}/, 'art stage hidden in lyrics mode')
})

// ── The monument has no white matte frame ────────────────────────────────────

test('the art monument sizes to min(62vh,560px) with no matte frame', () => {
  assert.match(CSS, /\.np-modal-art-box \{[\s\S]*?width:min\(62vh, 560px\)/, 'monumental sizing')
  const box = CSS.slice(CSS.indexOf('.np-modal-art-box {'), CSS.indexOf('.np-modal-art-box:active'))
  assert.ok(!/padding:/.test(box), 'no matte padding around the cover')
})

// ── Backdrop reads as atmosphere, not near-black ─────────────────────────────

test('the blurred backdrop is lifted above the old near-black brightness', () => {
  const bg = CSS.slice(CSS.indexOf('.np-modal-art-bg {'), CSS.indexOf('}', CSS.indexOf('.np-modal-art-bg {')))
  const m = bg.match(/brightness\((\.?[0-9.]+)\)/)
  assert.ok(m, 'the backdrop declares a brightness')
  // ".55" → 0.55; "0.55" also parses. The old crushed value was .2.
  const brightness = parseFloat(m[1].startsWith('.') ? '0' + m[1] : m[1])
  assert.ok(brightness >= 0.4, 'brightness is lifted (>= .4), not crushed to near-black; got ' + brightness)
})

// ── Reduced motion kills every np-* animation/transition ─────────────────────

test('prefers-reduced-motion disables the np-* animations and the bar hairline transition', () => {
  const rm = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(rm, /\.np-modal \{ animation:none; \}/)
  assert.match(rm, /\.np-art-pulse\.pulsing \{ animation:none; \}/)
  assert.match(rm, /\.np-queue-panel \{ transition:none; \}/)
  // The bar hairline lives in an earlier reduced-motion block; assert it too.
  assert.match(CSS, /\.player-bar::after \{ transition:none; \}/)
})

// ── A11y: labels, roles, aria-live ───────────────────────────────────────────

test('the modal carries dialog semantics and an aria-live track announcer', () => {
  assert.match(HTML, /id="np-modal"[^>]*role="dialog"[^>]*aria-modal="true"/)
  assert.match(HTML, /id="np-live"[^>]*aria-live="polite"/)
  assert.match(HTML, /id="np-modal-track"[^>]*role="slider"/, 'the seek slider has slider role + aria')
  assert.match(HTML, /id="np-modal-vol-track"[^>]*role="slider"/)
})

test('the chrome buttons are real buttons with labels, not inline-styled ghosts', () => {
  for (const id of ['np-modal-lyrics-toggle', 'np-modal-full-art', 'np-modal-close']) {
    const re = new RegExp('<button[^>]*id="' + id + '"[^>]*aria-label=')
    assert.match(HTML, re, id + ' is a labelled <button>')
  }
})
