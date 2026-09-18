'use strict'
// M6 — the Trail painted blank squares where a cover used to be.
//
// _trailMomentHtml built its own `'file://' + m.art` instead of asking
// _artSrcIfUsable, which owns the session's artwork miss memory. Two costs:
// a cover whose file is gone (133 of 990 moments on the live profile, under
// ~/.config/papa-audio/artwork/<hash>.jpg) painted a blank 28x28 square with
// no onerror to replace it, and every repaint re-requested every one of them.
//
// The Diary timeline had the same hole from the other side: its <img> hid
// itself on error but never revealed the .tl-art-fallback block, leaving a gap
// in a row where every neighbour has a picture. It also handed a bare local
// path straight to src=, with no file:// scheme at all.
//
// Both painters are lifted out of renderer.js with the helpers they call and
// run for real, so the OUTPUT is what is asserted, not the source text.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

// A context holding the real painters, the real artwork-miss memory, and the
// real esc(). `misses` is the live Set, so a test can mark a cover as gone the
// same way the app's capture-phase error listener does.
function painters() {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext('var _artMisses = new Set()', ctx)
  vm.runInContext(
    "function esc(s){return String(s==null?'':s)" +
    ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;')}",
    ctx
  )
  for (const fn of ['_artUsable', '_artSrc', '_artSrcIfUsable', '_trailIcon',
    '_trailArtHtml', '_trailMomentHtml', '_tlArtHtml']) {
    vm.runInContext(liftFn(fn), ctx)
  }
  vm.runInContext("var window = { PapaTrail: { timeLabel: function () { return '14:02' } } }", ctx)
  return ctx
}

const ART = '/home/shaharyar/.config/papa-audio/artwork/9f2c.jpg'

function moment(over) {
  return Object.assign({ kind: 'album', icon: 'album', label: 'Mirage', sub: 'Camel', ts: 1 }, over)
}

function trailHtml(ctx, m) {
  ctx.__m = m
  return vm.runInContext('_trailMomentHtml(__m, 0, 0)', ctx)
}

// ── the Trail ────────────────────────────────────────────────────────────────

test('a moment with no cover shows its glyph, not an empty square', () => {
  const ctx = painters()
  const html = trailHtml(ctx, moment({ art: null }))
  assert.match(html, /trail-ico/)
  assert.ok(!/<img/.test(html), 'there must be no image element at all')
})

test('a cover already known to be gone is not requested again', () => {
  const ctx = painters()
  ctx.__p = ART
  vm.runInContext('_artMisses.add(__p)', ctx)
  const html = trailHtml(ctx, moment({ art: ART }))
  assert.match(html, /trail-ico/)
  assert.ok(!/<img/.test(html),
    'the miss memory is the whole point: a dead cover must not be re-fetched')
  assert.ok(!html.includes(ART), 'and its path must not appear in the markup')
})

test('a cover that is still there is painted, with the glyph waiting behind it', () => {
  const ctx = painters()
  const html = trailHtml(ctx, moment({ art: ART }))
  assert.match(html, /<img class="trail-art" src="file:\/\/\/home[^"]*9f2c\.jpg"/)
  assert.match(html, /onerror="[^"]*display='none'/,
    'the first failure has to be survivable — there was no onerror at all before')
  assert.match(html, /<span class="trail-ico" style="display:none">/,
    'the fallback must already be in the DOM for onerror to reveal')
})

test('a remote cover keeps its own scheme instead of being turned into a file path', () => {
  const ctx = painters()
  const html = trailHtml(ctx, moment({ art: 'https://image.tmdb.org/t/p/w92/x.jpg' }))
  assert.match(html, /src="https:\/\/image\.tmdb\.org/)
  assert.ok(!/file:\/\/https/.test(html))
})

test('the glyph is the one the moment kind asks for', () => {
  const ctx = painters()
  ctx.__a = moment({ art: null, kind: 'search', icon: null })
  ctx.__b = moment({ art: null, kind: 'video', icon: null })
  const a = vm.runInContext('_trailMomentHtml(__a, 0, 0)', ctx)
  const b = vm.runInContext('_trailMomentHtml(__b, 0, 0)', ctx)
  assert.notStrictEqual(a.match(/trail-ico">([^<]*)</)[1], b.match(/trail-ico">([^<]*)</)[1],
    'a search and a video must not collapse to the same glyph')
})

// ── the Diary ────────────────────────────────────────────────────────────────

test('a diary row with no artwork renders the fallback block', () => {
  const ctx = painters()
  ctx.__s = null
  const html = vm.runInContext('_tlArtHtml(__s)', ctx)
  assert.strictEqual(html, '<span class="tl-art tl-art-fallback"></span>')
})

test('and a row whose artwork fails swaps to that same fallback', () => {
  const ctx = painters()
  ctx.__s = ART
  const html = vm.runInContext('_tlArtHtml(__s)', ctx)
  assert.match(html, /<img class="tl-art"/)
  assert.match(html, /tl-art-fallback" style="display:none"/,
    'the fallback must be present for the onerror to reveal — it used to hide the img and show nothing')
  assert.match(html, /onerror="[^"]*nextElementSibling/)
})

test('a local album cover in the diary finally gets a file:// scheme', () => {
  const ctx = painters()
  ctx.__s = ART
  assert.match(vm.runInContext('_tlArtHtml(__s)', ctx), /src="file:\/\/\/home/,
    'the old markup handed the bare path to src=, which no browser can load')
})

test('and a TMDB poster is left alone', () => {
  const ctx = painters()
  ctx.__s = 'https://image.tmdb.org/t/p/w92/poster.jpg'
  assert.match(vm.runInContext('_tlArtHtml(__s)', ctx), /src="https:\/\/image\.tmdb\.org/)
})

test('the diary shares the Trail\'s miss memory', () => {
  const ctx = painters()
  ctx.__s = ART
  vm.runInContext('_artMisses.add(__s)', ctx)
  assert.strictEqual(vm.runInContext('_tlArtHtml(__s)', ctx),
    '<span class="tl-art tl-art-fallback"></span>')
})

test('both diary call sites go through the one painter', () => {
  assert.match(src, /const art = _tlArtHtml\(e\.art\)/)
  assert.match(src, /const poster = _tlArtHtml\(e\.poster\)/)
})
