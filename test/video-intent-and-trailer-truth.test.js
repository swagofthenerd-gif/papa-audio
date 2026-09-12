'use strict'
// R11: a query that describes a kind of film gets a Browse chip in the live
// search, and loses fuzzy anime title hits when nothing was left as a title.
// R12: extractor failures are named honestly, reach mini mode, offer the fix;
// a hover preview that never starts gives the poster back.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const query = require(path.join(__dirname, '..', 'src', 'video-query.js'))
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

// Lift the intent helpers and run them against the real parser.
function liftIntent() {
  // One contiguous block: the intent helpers, the parser bridge, the Browse
  // filter mapper, the summary and the country names, exactly as shipped.
  const src = CODE.slice(CODE.indexOf('function _searchIntent('), CODE.indexOf('function _actOnParsedQuery('))
  const ctx = {
    window: { PapaVideoQuery: query },
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    _QUERY_SORTS: { rating: 'rating', newest: 'newest' },
    _browseVocab: null,
  }
  vm.createContext(ctx)
  vm.runInContext(src + '\nthis._searchIntent = _searchIntent; this._vSearchIntentHtml = _vSearchIntentHtml', ctx)
  return ctx
}

test('R11: "90s korean thrillers" is understood as a description with nothing left as a title; a bare title is not', () => {
  const c = liftIntent()
  const intent = c._searchIntent('90s korean thrillers')
  assert.ok(intent, 'a description parses')
  assert.equal(intent.describesKind, true)
  assert.match(intent.summary, /Thriller/)
  assert.match(intent.summary, /South Korea/, 'a country code reads as a name even before the Browse vocabulary loads')
  assert.equal(c._searchIntent('blade runner'), null, 'a bare title carries no intent')
  const html = c._vSearchIntentHtml(intent, true)
  assert.match(html, /id="vsearch-intent-go"/)
  assert.match(html, /Browse: .*Thriller/)
  assert.match(html, /anime title matches hidden/)
})

test('R11: the live title search carries the intent, paints the chip, hides fuzzy anime for descriptions', () => {
  assert.match(fn('_runVideoTitleSearch'), /intent: _searchIntent\(query\)/)
  const paint = fn('_paintVideoSearchResults')
  assert.match(paint, /const intent = _vSearchFilter\.intent \|\| null/)
  assert.match(paint, /const hideAnime = !!\(intent && intent\.describesKind && !\(intent\.parsed\.filters && intent\.parsed\.filters\.catalog === 'anime'\)\)/)
  assert.match(paint, /groups\.filter\(function \(g\) \{ return g\.key !== 'anime' \}\)/)
  assert.match(fn('_vSearchEmptyHtml'), /_vSearchIntentHtml\(intent, false\)/, 'the empty state offers Browse too')
  // One delegated click, because the results box is repainted constantly.
  assert.match(fn('_bindVideoSearch'), /closest\('#vsearch-intent-go'\)[\s\S]{0,200}_actOnParsedQuery\(_vSearchFilter\.intent\.parsed\)/)
  assert.match(CSS, /\.vsearch-intent-btn\s*\{/)
})

test('R12: extractor failures are named as such, not as the network', () => {
  const src = fn('_isExtractorError') + '\n' + fn('_videoErrorText')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(src + '\nthis._videoErrorText = _videoErrorText; this._isExtractorError = _isExtractorError', ctx)
  assert.match(ctx._videoErrorText('yt-dlp timed out'), /could not be extracted from YouTube/, 'a stale extractor is not a connection problem')
  assert.match(ctx._videoErrorText('Could not load this trailer'), /stale yt-dlp/)
  assert.match(ctx._videoErrorText('fetch failed'), /Could not reach the service/)
  assert.equal(ctx._isExtractorError('mpv socket not ready'), false)
})

test('R12: a player error reaches mini mode as a toast, and an extractor error offers Update yt-dlp', () => {
  const ev = fn('_handleVideoEvent')
  const branch = ev.slice(ev.indexOf("payload.kind === 'error'"), ev.indexOf("payload.kind === 'error'") + 1800)
  assert.match(branch, /_player\.setStageMessage/)
  assert.match(branch, /showSnackbar\(text, 'Update yt-dlp', _updateYtdlpFromError, 12000\)/)
  assert.match(branch, /else showToast\(text\)/)
  assert.match(fn('_updateYtdlpFromError'), /window\.api\.ytdlpUpdateNow\(\)/)
})

test('R12: a hover preview that errors or never starts gives the poster back', () => {
  const start = fn('_startHoverTrailer')
  assert.match(start, /v\.addEventListener\('error', function \(\) \{ if \(_hoverTicket === ticket\) _stopHoverTrailer\(\) \}\)/)
  assert.match(start, /if \(_hoverTicket === ticket && !started\) _stopHoverTrailer\(\) \}, HOVER_START_TIMEOUT_MS\)/)
  assert.match(CODE, /const HOVER_START_TIMEOUT_MS = 8000/)
})
