'use strict';
// Trailer on hover (plan item 39).
//
// Three things make this honest rather than annoying, and each has a test,
// because each is the kind of thing that gets quietly dropped in a refactor:
// dwell rather than entry, a slow answer discarded rather than played into a
// card you have left, and a setting that can turn it off.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')

const hoverFns = () => RENDERER.slice(RENDERER.indexOf('const HOVER_DWELL_MS'),
                                      RENDERER.indexOf('function _bindVideoCards(root)'))

// A test that greps source must not read the prose: the comment explaining why
// a function is NOT called names that function, and a doesNotMatch against the
// raw text then fails on the explanation.
const codeOnly = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const previewHandler = () => codeOnly(
  MAIN.slice(MAIN.indexOf("ipcMain.handle('video-trailer-url'"),
             MAIN.indexOf('// Switch to another episode inside the pack')))

test('the preview channel resolves a URL and never touches the player', () => {
  // video-trailer takes over the engine on purpose: pressing Trailer is a
  // decision to watch it. Hovering is not that decision, and a preview that
  // stopped what you were watching would be a bug of the worst kind.
  const h = previewHandler()
  assert.ok(h.length > 200, 'found the handler')
  for (const forbidden of ['_videoTeardown', '_wireVideoEngine', 'videoEngine()', 'player.pause',
                           '_videoSession.token', 'safeSend']) {
    assert.ok(!h.includes(forbidden), 'the preview handler must not call ' + forbidden)
  }
  assert.match(h, /resolveYtUrl\(key, 'video'\)/)
})

test('no trailer is a real answer, not an error', () => {
  // Most older films have none. An error would make the card flash a failure
  // because someone looked at it.
  const h = previewHandler()
  assert.match(h, /if \(!key\) return \{ ok: true, url: null \}/)
  assert.match(h, /if \(!detail\) return \{ ok: true, url: null \}/)
})

test('the channel is exposed and reachable', () => {
  assert.match(PRELOAD, /videoTrailerUrl:\s*\(p\) => ipcRenderer\.invoke\('video-trailer-url', p\)/)
  assert.match(RENDERER, /window\.api\.videoTrailerUrl\(/)
})

test('a preview waits for dwell rather than starting on entry', () => {
  // A pointer crossing a rail passes over eight cards. Starting on
  // pointerenter starts eight previews.
  const fns = hoverFns()
  assert.match(fns, /const HOVER_DWELL_MS = \d{3}/)
  const enter = fns.slice(fns.indexOf("addEventListener('pointerenter'"))
  assert.match(enter, /setTimeout\(function \(\) \{ _startHoverTrailer\(card\) \}, HOVER_DWELL_MS\)/)
  assert.match(enter, /clearTimeout\(_hoverTimer\)/, 'a new hover cancels the pending one')
})

test('leaving the card cancels a pending preview as well as a playing one', () => {
  const fns = hoverFns()
  const leave = fns.slice(fns.indexOf("addEventListener('pointerleave'"))
  assert.match(leave, /_hoverCard === card \|\| _hoverTimer/,
    'a preview still inside its dwell must also be cancelled')
})

test('touch never triggers a preview', () => {
  // There is no hover on touch, and the "hover" is a tap on its way to opening
  // the film.
  const fns = hoverFns()
  assert.match(fns, /if \(e\.pointerType === 'touch'\) return/)
  assert.match(CSS, /@media \(hover: none\) \{\s*\.cinema \.vcard-preview \{ display: none/)
})

test('a slow resolve is discarded rather than played into a card you have left', () => {
  // yt-dlp takes seconds. Everything that can change in that time is checked
  // again on the way back.
  const fn = RENDERER.slice(RENDERER.indexOf('async function _startHoverTrailer'),
                            RENDERER.indexOf('function _bindVideoCards(root)'))
  const after = fn.slice(fn.indexOf('await window.api.videoTrailerUrl'))
  assert.match(after, /if \(_hoverTicket !== ticket\) return/, 'a stale answer must not play')
  assert.match(after, /if \(!card\.isConnected/, 'the card may have been re-rendered away')
  assert.match(after, /!_hoverTrailerAllowed\(\)/, 'playback may have started meanwhile')
})

test('a preview never plays over the theatre or over music', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _hoverTrailerAllowed'),
                            RENDERER.indexOf('function _stopHoverTrailer'))
  assert.match(fn, /vtheatre/, 'the theatre is modal and has its own audio')
  assert.match(fn, /state\.isPlaying/, 'two things playing at once is never what anyone meant')
  assert.match(fn, /if \(!_hoverTrailersOn\) return false/)
})

test('stopping a preview releases the buffer, not just the playback', () => {
  // A paused <video> keeps its buffer and its decoder. A rail of them would
  // hold hundreds of megabytes — which is exactly the kind of thing the soak
  // would catch a week later.
  const fn = RENDERER.slice(RENDERER.indexOf('function _stopHoverTrailer'),
                            RENDERER.indexOf('function _bindHoverTrailer'))
  assert.match(fn, /v\.pause\(\)/)
  assert.match(fn, /v\.removeAttribute\('src'\)/)
  assert.match(fn, /v\.load\(\)/)
  assert.match(fn, /v\.remove\(\)/)
  assert.match(fn, /_hoverTicket\+\+/, 'and an in-flight resolve is invalidated')
})

test('a page change stops the preview', () => {
  // setContent replaces the card the video lives in; the element would be
  // orphaned with its buffer still held.
  const fn = RENDERER.slice(RENDERER.indexOf('function setContent(html)'),
                            RENDERER.indexOf('function setContent(html)') + 400)
  assert.match(fn, /_stopHoverTrailer\(\)/)
  // Before the innerHTML that discards the card, not after.
  assert.ok(fn.indexOf('_stopHoverTrailer()') < fn.indexOf('innerHTML = html'))
})

test('the preview is muted, looped, and not a click target', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _startHoverTrailer'),
                            RENDERER.indexOf('function _bindVideoCards(root)'))
  assert.match(fn, /v\.muted = true/, 'sound on hover is never acceptable')
  assert.match(fn, /v\.loop = true/)
  assert.match(fn, /v\.playsInline = true/)
  assert.match(fn, /setAttribute\('aria-hidden', 'true'\)/, 'it is decoration over the poster')
  assert.match(CSS, /\.cinema \.vcard-preview \{[^}]*pointer-events: none/s,
    'the card must stay the click surface')
})

test('a rejected play() is handled, because autoplay policies reject', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _startHoverTrailer'),
                            RENDERER.indexOf('function _bindVideoCards(root)'))
  assert.match(fn, /v\.play\(\)\.catch\(/)
})

test('the card is bound once however many times the grid repaints', () => {
  // _bindVideoCards runs on every append and every repaint.
  const fn = RENDERER.slice(RENDERER.indexOf('function _bindHoverTrailer'),
                            RENDERER.indexOf('async function _startHoverTrailer'))
  assert.match(fn, /if \(!card \|\| card\.dataset\.hoverBound === '1'\) return/)
  assert.match(fn, /card\.dataset\.hoverBound = '1'/)
})

test('it can be turned off, and the choice persists', () => {
  const fns = hoverFns()
  assert.match(fns, /const HOVER_TRAILER_KEY = 'papa_hover_trailers'/)
  assert.match(fns, /function setHoverTrailers\(on\)/)
  assert.match(fns, /localStorage\.setItem\(HOVER_TRAILER_KEY/)
  assert.match(fns, /function restoreHoverTrailerPref\(\)/)
  assert.match(RENDERER, /restoreHoverTrailerPref\(\)/, 'and it is restored at startup')
  // Turning it off stops whatever is playing now, not only the next one.
  const setter = fns.slice(fns.indexOf('function setHoverTrailers(on)'))
  assert.match(setter, /if \(!_hoverTrailersOn\) _stopHoverTrailer\(\)/)
})

test('there is a control for it', () => {
  assert.match(HTML, /id="gen-hover-trailers"/)
  assert.match(RENDERER, /getElementById\('gen-hover-trailers'\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('async function _initGeneralSettings'),
                            RENDERER.indexOf('async function _initGeneralSettings') + 900)
  assert.match(fn, /hov\.checked = _hoverTrailersOn/, 'the box must show the real value')
  assert.match(fn, /setHoverTrailers\(!!e\.target\.checked\)/)
})

test('absent means on, because the plan asked for the feature', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function restoreHoverTrailerPref'),
                            RENDERER.indexOf('function setHoverTrailers'))
  assert.match(fn, /v === null \? true : v === '1'/)
})

test('the loading hint does not claim a trailer exists', () => {
  // Most older films have none, so a spinner that resolves to nothing would be
  // worse than a still poster. It is a small mark, and it goes.
  const fn = RENDERER.slice(RENDERER.indexOf('async function _startHoverTrailer'),
                            RENDERER.indexOf('function _bindVideoCards(root)'))
  assert.match(fn, /classList\.add\('is-preview-loading'\)/)
  assert.match(fn, /classList\.remove\('is-preview-loading'\)/)
  assert.match(CSS, /\.cinema \.vcard\.is-preview-loading/)
})

test('both animations honour reduced motion', () => {
  const reduced = [...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map(m => m[1]).join('\n')
  assert.match(reduced, /\.cinema \.vcard-preview \{ transition: none/)
  assert.match(reduced, /is-preview-loading[\s\S]*animation: none/)
})

test('a hover never spends an OMDb request', () => {
  // The trailer list comes from TMDB's own detail response. Going through
  // _videoShowDetail would also call OMDb, whose free tier is a thousand
  // requests a day — so hovering across a rail of twenty cards would have spent
  // twenty of them on a number nobody asked to see.
  const h = previewHandler()
  assert.doesNotMatch(h, /_videoShowDetail/, 'that path enriches through OMDb')
  assert.doesNotMatch(h, /_enrichExternalRatings/)
  assert.match(h, /_videoDetailCache\.get\(/, 'a warm cache is free and is used')
  assert.match(h, /tmdb\(\)\.detail\(/, 'and a cold one asks TMDB directly')
})

test('a cold preview fetch never poisons the detail cache', () => {
  // The object it fetches has no external ratings on it. Caching that would
  // make the real detail page show a film with no IMDb, RT or Metacritic line,
  // and it would stay that way for the life of the cache.
  const h = previewHandler()
  assert.doesNotMatch(h, /_videoDetailCache\.set/, 'the preview path must not write the cache')
})
