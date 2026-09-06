'use strict'

/**
 * Structural guards for the fixes landed against docs/qa-audit-2026-09-05.md.
 *
 * These run without a DOM, so they prove the source keeps the shape the fix
 * relies on — not that it renders. Each test names the audit item and the
 * regression it exists to catch, matching the regex-over-source style already
 * used by renderer-hygiene.test.js and cinema-css.test.js.
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')

// Strip block comments and line comments so patterns can't match prose that
// merely quotes the thing being forbidden.
const CODE = RENDERER
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// ── Audit #1: unfocused entry-animation exemptions ──────────────────────────
// A one-shot entry animation (keyframes from opacity:0) paused at frame 0 by
// `body.app-unfocused *` leaves an invisible, click-blocking overlay. The fix
// is an exemption block forcing those surfaces to `animation:none`.

test('unfocused blanket pause still exists (protects looping animations)', () => {
  assert.match(CSS, /body\.app-unfocused \*[\s\S]*?animation-play-state:\s*paused\s*!important/,
    'the blanket pause must stay — it is what stops looping animations while unfocused')
})

test('every entry-animated surface is exempted with animation:none when unfocused', () => {
  // Enumerated from styles.css: surfaces whose entry keyframes start at
  // opacity:0 (fadeIn / searchFadeIn / pageEnter / greetingFade / dlCtxIn /
  // queueAdd). If a new such surface is added it must join this list, or it
  // will freeze invisible when opened unfocused.
  const surfaces = [
    '.queue-panel', '.np-modal', '.sleep-panel', '.ctx-menu', '#ctx-menu',
    '.vcard-ctx-menu', '.dl-ctx-menu.open', '.art-status', '.dialog-overlay',
    '.dl2-group', '.search-animate-in', '.tooltip-box', '.page',
    '.modal-overlay', '.modal-dialog', '.greeting-fade-in', '.queue-row.new',
    '.vtheatre', '.vmini', '.vt-skip button', '.vt-upnext', '.vt-menu',
  ]
  // Isolate the exemption block: from the first `body.app-unfocused .` selector
  // up to its closing `animation: none !important; }`.
  const start = CSS.indexOf('body.app-unfocused .queue-panel')
  assert.ok(start !== -1, 'exemption block missing')
  const end = CSS.indexOf('animation: none !important', start)
  assert.ok(end !== -1, 'exemption block has no animation:none terminator')
  const block = CSS.slice(start, end)
  for (const sel of surfaces) {
    assert.ok(block.includes('body.app-unfocused ' + sel),
      'unfocused exemption missing for ' + sel)
  }
})

// ── Audit #2: bar + fullscreen hearts like the TRACK, not the album ─────────

test('the player-bar heart click toggles track like, not album like', () => {
  const at = CODE.indexOf("getElementById('btn-like')?.addEventListener('click'")
  assert.ok(at !== -1, 'bar heart click handler not found')
  const body = CODE.slice(at, at + 600)
  assert.ok(/toggleTrackLike\(\s*currentTrack\.filePath\s*\)/.test(body),
    'bar heart must call toggleTrackLike(currentTrack.filePath)')
  assert.ok(!/toggleLike\(/.test(body),
    'bar heart must not album-like (toggleLike) any more')
})

test('updatePlayerLikeBtn fills from likedTracks (track semantics)', () => {
  const at = CODE.indexOf('function updatePlayerLikeBtn')
  assert.ok(at !== -1)
  const body = CODE.slice(at, at + 600)
  assert.ok(/likedTracks\.includes\(currentTrack\.filePath\)/.test(body),
    'bar heart fill must reflect the current track being in likedTracks')
})

test('_syncNpLike (fullscreen heart) reads track-like state', () => {
  const at = CODE.indexOf('function _syncNpLike')
  assert.ok(at !== -1)
  const body = CODE.slice(at, at + 500)
  assert.ok(/likedTracks[\s\S]*?includes\(track\.filePath\)/.test(body),
    'fullscreen heart must reflect the track being in likedTracks')
})

// ── Renderer P1: arrow keys must not scrub music on the video grid ──────────

test('music seek branch bails when a video page is active', () => {
  const at = CODE.indexOf("matchesShortcut('seekForward'")
  assert.ok(at !== -1, 'seek handler not found')
  // The guard is defined just above and consulted inside both seek branches.
  const region = CODE.slice(at - 400, at + 400)
  assert.ok(/VIDEO_PAGES\.has\(state\.currentPage\)/.test(region),
    'seek must be guarded by the video-page check')
  assert.ok(/if \(_onVideoGrid\) return/.test(region),
    'seekForward must bail when on the video grid')
})

// ── Renderer P1: interlude-skip recursion guard ─────────────────────────────

test('interlude skip shares the short-skip recursion guard', () => {
  const at = CODE.indexOf('_isInterlude(state.queue[state.queueIndex])')
  assert.ok(at !== -1, 'interlude skip branch not found')
  const body = CODE.slice(at, at + 400)
  assert.ok(/_skipShortGuard\+\+/.test(body),
    'interlude skip must increment the recursion guard')
  assert.ok(/_skipShortGuard > 20[\s\S]*?playCurrentTrack\(\)/.test(body),
    'interlude skip must terminate into playCurrentTrack after enough skips')
})

// ── Audit #3: video search history records on commit only ───────────────────

test('debounced title-search path does not remember history', () => {
  // The two _vSearchRemember calls inside the fetch .then() blocks were the
  // per-keystroke pollution source; they must be gone.
  const runAt = CODE.indexOf('function _runVideoTitleSearch')
  const retryEnd = CODE.indexOf('function _actOnParsedQuery')
  assert.ok(runAt !== -1 && retryEnd !== -1)
  const region = CODE.slice(runAt, retryEnd)
  assert.ok(!/_vSearchRemember\(/.test(region),
    'no _vSearchRemember may run inside the debounced search/retry path')
})

test('history is remembered on Enter and on result click', () => {
  // Enter commit.
  assert.ok(/if \(e\.key === 'Enter'\)[\s\S]{0,200}_vSearchRemember\(query\)/.test(CODE),
    'Enter must commit the query to history')
  // Result-click commit.
  assert.ok(/closest\('\.vcard'\)[\s\S]{0,120}_vSearchRemember\(_vSearchFilter\.query\)/.test(CODE),
    'clicking a result must commit the query to history')
})

test('history self-heals by dropping strict prefixes on read', () => {
  const at = CODE.indexOf('function _vSearchDropPrefixes')
  assert.ok(at !== -1, 'prefix cleanup helper missing')
  const heal = CODE.indexOf('function _vSearchHistory')
  const body = CODE.slice(heal, heal + 700)
  assert.ok(/_vSearchDropPrefixes\(/.test(body),
    '_vSearchHistory must run the prefix cleanup')
})

// ── Audit #7: np-modal volume slider stays in sync ──────────────────────────

test('setVolDisplay updates the np-modal volume slider', () => {
  const at = CODE.indexOf('function setVolDisplay')
  assert.ok(at !== -1)
  const body = CODE.slice(at, at + 900)
  assert.ok(/np-modal-vol-fill/.test(body) && /np-modal-vol-thumb/.test(body),
    'setVolDisplay must drive the modal slider fill/thumb so it cannot go stale')
})

test('opening the np-modal seeds its volume slider from real volume', () => {
  const at = CODE.indexOf('function showNowPlayingModal')
  assert.ok(at !== -1)
  const body = CODE.slice(at, at + 900)
  assert.ok(/setVolDisplay\(audio\.volume\)/.test(body),
    'modal open must seed the volume slider from audio.volume')
})
