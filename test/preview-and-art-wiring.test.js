'use strict'
// Structural guards for the two user-demanded features that live in renderer.js
// (which can't be imported in Node because it touches window/DOM at load), so —
// like slsk-shop-ui-wiring — these assert the source keeps the invariants the
// features depend on. The pure logic itself is tested in preview-racer.test.js
// and slsk-art-prefetch.test.js.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const CODE = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')

function slice(from, toMarker) {
  const s = CODE.indexOf(from)
  assert.ok(s > -1, `expected to find: ${from}`)
  const e = CODE.indexOf(toMarker, s + from.length)
  return CODE.slice(s, e > -1 ? e : CODE.length)
}

// ── The two helper modules are loaded and exported ────────────────────────────
test('index.html loads the prefetch and racer modules before renderer.js', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  const iPrefetch = order.indexOf('slsk-art-prefetch.js')
  const iRacer = order.indexOf('preview-racer.js')
  const iRenderer = order.indexOf('renderer.js')
  assert.ok(iPrefetch > -1, 'slsk-art-prefetch.js is loaded')
  assert.ok(iRacer > -1, 'preview-racer.js is loaded')
  assert.ok(iPrefetch < iRenderer && iRacer < iRenderer, 'both load before renderer.js')
})

test('the helper modules publish their globals', () => {
  const pf = fs.readFileSync(path.join(SRC, 'slsk-art-prefetch.js'), 'utf8')
  const pr = fs.readFileSync(path.join(SRC, 'preview-racer.js'), 'utf8')
  assert.match(pf, /window\.PapaSlskArtPrefetch\s*=/)
  assert.match(pr, /window\.PapaPreviewRacer\s*=/)
})

// ── Feature 1: cover art prefetch ─────────────────────────────────────────────
test('the shop runs a background cover prefetch for cached/saved shoppers', () => {
  assert.match(CODE, /const PF = window\.PapaSlskArtPrefetch/, 'aliases the pure planner')
  const fn = slice('async function shArtPrefetch()', '\n  // One album card.')
  assert.match(fn, /PF\.planArtPrefetch/, 'plans the fetch order via the module')
  assert.match(fn, /shArtFetchIdentity/, 'fetches via the shared identity path')
  assert.match(fn, /shArtPrefetchAbort/, 'is abortable')
  assert.match(fn, /SH_ART_PREFETCH_MAX/, 'has a bounded concurrency')
  assert.match(fn, /hasLocalArt/, 'skips albums that already have local art')
})

test('the prefetch kicks off only for a cached browse or a saved friend', () => {
  const fn = slice('shelves = SH ? SH.buildShelves', '\n      if (mode === \'shelves\'')
  assert.match(fn, /shArtPrefetch\(\)/, 'the prefetch is started after shelves build')
  assert.match(fn, /shFromCache \|\|/, 'gated on the cached-browse flag')
  assert.match(fn, /PapaSavedUsers.*isSaved/, 'or the saved-friend check')
})

test('the prefetch aborts on modal close and dedupes with the observer', () => {
  const closeFn = slice('const close = () => {', '\n  let tree = null')
  assert.match(closeFn, /shArtPrefetchAbort = true/, 'close aborts the prefetch')
  // Shared in-flight set so observer and prefetch never double-fetch an identity.
  assert.match(CODE, /const shArtInProgress = new Set\(\)/)
  const idFn = slice('async function shArtFetchIdentity(', '\n  // Swap the fetched')
  assert.match(idFn, /shArtInProgress\.has\(key\)/, 'skips an in-flight identity')
  assert.match(idFn, /shArtCache\.has\(key\)/, 'honours the session cache/negative-cache')
})

// ── Feature 2: preview racer ──────────────────────────────────────────────────
test('startPreview races both sources and is guarded to one at a time', () => {
  const fn = slice('function startPreview(spec)', '\nasync function _startSlskLeg')
  assert.match(fn, /_stopPreview\(\{ restore: false \}\)/, 'a new preview stops the old one')
  assert.match(fn, /_startSlskLeg/, 'starts the Soulseek leg')
  assert.match(fn, /_startYtLeg/, 'starts the YouTube leg')
  assert.match(fn, /PREVIEW_TIMEOUT_MS/, 'arms the give-up deadline')
})

test('the SLSK leg downloads then polls resolve-until-on-disk', () => {
  const fn = slice('async function _startSlskLeg', '\n// YouTube leg')
  assert.match(fn, /slskResolveFile/, 'checks disk first / polls')
  assert.match(fn, /slskDownload/, 'queues the single-file download')
  assert.match(fn, /_previewSlskReady/, 'signals readiness when on disk')
  assert.match(fn, /Failed\|Aborted\|Cancelled/, 'bails on a failed transfer')
})

test('the YT leg searches the derived query and streams the top hit', () => {
  const fn = slice('async function _startYtLeg', '\n// SLSK produced')
  assert.match(fn, /derivePreviewQuery/, 'derives "<artist> <title>"')
  assert.match(fn, /ytMusicSearch/, 'searches YouTube Music')
  assert.match(fn, /_ytQueueItem/, 'streams the hit through the normal pipeline')
  assert.match(fn, /_armPreviewAudioWatch/, 'waits for real audio to confirm the win')
})

test('a confirmed YT win cancels the losing Soulseek transfer', () => {
  const fn = slice('function _previewConfirmedAudible', '\n// Feed a lifecycle')
  assert.match(fn, /_cancelPreviewSlskTransfer\(\)/, 'stands down the SLSK loser')
  const cancel = slice('async function _cancelPreviewSlskTransfer', '\n// Stop the current')
  assert.match(cancel, /slskGetTransfers/, 'finds the transfer id from the live list')
  assert.match(cancel, /slskCancelTransfer/, 'cancels it')
})

test('stopping restores the exact prior queue, index and position', () => {
  const snap = slice('function _previewSnapshot()', '\n// Kick off a preview')
  assert.match(snap, /state\.queue\.slice\(\)/, 'snapshots the queue')
  assert.match(snap, /queueIndex/, 'snapshots the index')
  assert.match(snap, /audio\.currentTime/, 'snapshots the position')
  const restore = slice('function _restorePreviewSnapshot', '\n// ── Preview pill')
  assert.match(restore, /state\.queue = snap\.queue/, 'restores the queue')
  assert.match(restore, /state\.queueIndex = snap\.queueIndex/, 'restores the index')
  assert.match(restore, /audio\.currentTime = want/, 'seeks back to the saved position')
})

test('the racer gives up after the timeout with a friendly toast', () => {
  const fn = slice('function _previewEvent(', '\n// Cancel the Soulseek')
  assert.match(fn, /racerReduce/, 'drives the pure reducer')
  assert.match(fn, /timedout/, 'acts on the give-up transition')
  assert.match(fn, /showSnackbar/, 'tells the user')
})

test('the pill badges which source is playing', () => {
  const fn = slice('function _renderPreviewPill', '\nfunction _removePreviewPill')
  assert.match(fn, /preview-pill-badge/, 'renders a source badge')
  assert.match(fn, /'YT'|"YT"/, 'labels a YouTube win')
  assert.match(fn, /'FLAC'|"FLAC"/, 'labels a Soulseek win')
  assert.match(fn, /back to your music/, 'offers the restore action')
})

test('a preview button is wired into all three remote-track surfaces', () => {
  // Shop shelf cards.
  assert.match(CODE, /class="slsh-card-act slsh-preview"/, 'shelf card has ⚡')
  assert.match(CODE, /btn\.classList\.contains\('slsh-preview'\)/, 'and is handled')
  // Folders-mode file rows.
  assert.match(CODE, /data-act="preview"/, 'folder file row has ⚡')
  assert.match(CODE, /btn\.dataset\.act === 'preview'/, 'and is handled')
  // Search-card expanded track rows.
  assert.match(CODE, /class="slsk-track-preview"/, 'search track row has ⚡')
  assert.match(CODE, /querySelectorAll\('\.slsk-track-preview'\)/, 'and is bound')
})

test('previews do not pollute the YouTube recents list', () => {
  const fn = slice('function recordYtRecent(', '\nfunction updateYtHealth')
  assert.match(fn, /_papaPreview && _papaPreview\.active/, 'a transient preview is skipped')
})
