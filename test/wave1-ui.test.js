'use strict'
// Wiring checks for the Wave-1 UI features (roadmap items 1, 2, 3, 4, 14, 25,
// 66), in the same source-assertion style as music-wave6-ui.test.js and
// renderer-hygiene.test.js: prove the renderer emits what the CSS styles, that
// each feature reuses the machinery the roadmap named, and that the destructive
// actions offer Undo — without standing up a DOM.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const p = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const renderer = p('src/renderer.js')
const css = p('src/styles.css')
// Comments quote the very patterns some of these tests forbid, so strip them.
const code = renderer
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// ── Item 1: crash-restore prompt ────────────────────────────────────────────

test('crash detection is renderer-owned via a clean-exit flag', () => {
  // The flag is read (and cleared) at boot before anything else can clear it,
  // and re-armed on pagehide. Its absence at boot is what means "crashed".
  assert.match(code, /_uncleanExit = localStorage\.getItem\('papa-clean-exit'\) !== '1'/)
  assert.match(code, /localStorage\.removeItem\('papa-clean-exit'\)/)
  assert.match(code, /localStorage\.setItem\('papa-clean-exit', '1'\)/,
    'a clean shutdown must leave the flag')
  // The re-arm sits on pagehide, the last synchronous moment the renderer has.
  const setup = code.slice(code.indexOf('function setupListeners()'),
                          code.indexOf('function setupListeners()') + 900)
  assert.match(setup, /addEventListener\('pagehide'/, 'clean-exit marker is on pagehide')
})

test('the crash banner offers Resume and never auto-plays', () => {
  const fn = code.slice(code.indexOf('async function _offerCrashRestore(opts)'),
                        code.indexOf('async function _resumeCrashSession()'))
  assert.ok(fn.length > 100, 'found _offerCrashRestore')
  assert.match(fn, /if \(!_uncleanExit \|\| _crashRestoreOffered\) return false/,
    'only offered after an unclean exit, and only once')
  assert.match(fn, /getSavedQueues/, 'only when there was a queue mid-flight')
  assert.match(fn, /showSnackbar\('Pick up where you left off/, 'the dismissible banner')
  assert.match(fn, /'Resume'/, 'with a Resume action')
  const resume = code.slice(code.indexOf('async function _resumeCrashSession()'),
                            code.indexOf('async function resumeFromSavedState('))
  assert.match(resume, /state\.isPlaying = false/, 'restores paused')
  assert.doesNotMatch(resume, /audio\.play\(\)/, 'and never calls play()')
})

test('an unclean exit offers the banner instead of auto-restoring', () => {
  const fn = code.slice(code.indexOf('if (_uncleanExit) setTimeout(_offerCrashRestore'),
                        code.indexOf('if (_uncleanExit) setTimeout(_offerCrashRestore') + 200)
  assert.match(fn, /_offerCrashRestore/, 'crash path offers the banner')
  assert.match(fn, /else setTimeout\(restorePlaybackState/, 'clean path restores as before')
})

// ── Item 2: keep-the-music-going ────────────────────────────────────────────

test('keep-the-music-going is opt-in and persisted under its own key', () => {
  assert.match(code, /function keepGoingEnabled\(\) \{ return localStorage\.getItem\('papa-keep-going'\) === '1' \}/,
    'opt-in: default OFF, distinct from the default-on autoplay key')
  assert.match(code, /function setKeepGoing\(on\) \{ localStorage\.setItem\('papa-keep-going'/)
})

test('keep-going continues the queue with the btn-np-radio machinery', () => {
  const fn = code.slice(code.indexOf('async function _keepGoingContinue()'),
                        code.indexOf('let _autoplayBusy = false'))
  assert.ok(fn.length > 100, 'found _keepGoingContinue')
  assert.match(fn, /window\.api\.queueBuild\(\{ mode: 'radio'/,
    'reuses the same similarity source the Radio button uses')
  assert.match(fn, /state\.queue\.push/, 'appends rather than replacing')
  assert.match(fn, /showToast\(/, 'a subtle toast when it kicks in')
})

test('the queue-end path consults keep-going before falling silent', () => {
  const fn = code.slice(code.indexOf('function playNext() {'),
                        code.indexOf('function pickShuffleIndex('))
  assert.match(fn, /if \(keepGoingEnabled\(\)\) \{ _keepGoingContinue\(\); return \}/,
    'keep-going takes precedence over the plain stop')
})

test('the queue header wires the keep-going toggle', () => {
  assert.match(code, /id="queue-keepgoing-toggle"/, 'the toggle is rendered')
  assert.match(code, />Keep the music going</, 'labelled as the roadmap asks')
  const wire = code.slice(code.indexOf('function _wireQueueHeaderControls()'),
                          code.indexOf('function saveQueueAsPlaylist()'))
  assert.match(wire, /queue-keepgoing-toggle.*setKeepGoing/s, 'the toggle flips the setting')
})

// ── Item 3: the waveform, removed ───────────────────────────────────────────
// It was never a waveform. Every bar height was Math.random(), re-rolled by a
// setInterval once a second, drawn full width above the seek bar with a
// progress fill, a time-at-cursor tooltip and click-to-seek — everything needed
// to convince a listener it was the shape of their track. In an app whose whole
// claim is that it does not touch or misrepresent the audio, and whose badge
// refuses to say BIT-PERFECT unless it really is, decorative noise dressed as
// signal was the one thing that could make the honest parts unbelievable too.
//
// This test used to pin its hover behaviour, so it guarded the wrong thing. It
// now guards the removal: a real waveform means decoding the file and caching a
// peak map, and until that exists there must not be a fake one.

test('there is no fake waveform drawn over the player bar', () => {
  assert.doesNotMatch(code, /waveform-canvas/, 'the canvas is gone')
  assert.doesNotMatch(code, /drawWaveform/, 'so is the drawing loop')
  assert.doesNotMatch(code, /Math\.random\(\) \* h \* 0\.8/, 'and the random bar heights')
  assert.doesNotMatch(code, /_waveformTimer/, 'and the interval that re-rolled them every second')
})

// ── Item 4: long-track bookmarks ────────────────────────────────────────────

test('long-track bookmarks are capped and go through the validated reader', () => {
  assert.match(code, /var LONG_TRACK_SECS = 20 \* 60/, 'the 20-minute threshold')
  assert.match(code, /var LONG_BOOKMARK_CAP = 200/, 'capped at 200 (LRU)')
  const write = code.slice(code.indexOf('function _writeLongBookmarks('),
                           code.indexOf('function saveLongBookmark('))
  assert.match(write, /keys\.length > LONG_BOOKMARK_CAP/, 'the cap is enforced, not just declared')
  assert.match(write, /map\[a\]\.at/, 'evicts the oldest by timestamp (LRU)')
  // Hygiene: never a raw JSON.parse of localStorage (renderer-hygiene rule).
  const read = code.slice(code.indexOf('function _readLongBookmarks('),
                          code.indexOf('function _writeLongBookmarks('))
  assert.match(read, /PapaLocal\.readObject\(LONG_BOOKMARK_KEY\)/)
})

test('a long track only saves a bookmark past the 20-minute mark', () => {
  const save = code.slice(code.indexOf('function saveLongBookmark('),
                          code.indexOf('function getLongBookmark('))
  assert.match(save, /dur < LONG_TRACK_SECS\) return/, 'short tracks never get one')
  assert.match(save, /pos <= 60 \|\| pos >= dur - 15/, 'the extreme ends are not worth keeping')
  // Wired into the 5-second autosave for tracks over the threshold.
  assert.match(code, /audio\.duration >= LONG_TRACK_SECS\) \{\s*saveLongBookmark/)
})

test('starting a long track with a saved position offers an unobtrusive resume', () => {
  const fn = code.slice(code.indexOf('function _maybeOfferLongResume('),
                        code.indexOf('function _maybeOfferLongResume(') + 900)
  assert.match(fn, /bm\.pos > 60/, 'only when there is a meaningful saved position')
  assert.match(fn, /showActionToast\('Resume from '/, 'the same action-toast pattern used elsewhere')
  assert.match(fn, /audio\.currentTime = bm\.pos/, 'and it actually seeks on accept')
  assert.match(code, /_maybeOfferLongResume\(track\)/, 'called when a track starts')
})

test('long tracks with a bookmark show a chip on the row', () => {
  assert.match(code, /function _longBookmarkChip\(t\)/)
  assert.match(code, /surroundBadge\(t\.channels\)\}\$\{_longBookmarkChip\(t\)\}/,
    'the chip rides in the track title')
  assert.ok(renderer.includes('track-bookmark-chip'), 'the chip class is emitted')
  assert.match(css, /\.track-bookmark-chip\s*\{/, 'and it is styled')
})

// ── Item 14: save queue as playlist ─────────────────────────────────────────

test('save-queue-as-playlist reuses _mgPrompt and the create+persist path', () => {
  const fn = code.slice(code.indexOf('function saveQueueAsPlaylist()'),
                        code.indexOf('function renderQueuePanel()'))
  assert.ok(fn.length > 100, 'found saveQueueAsPlaylist')
  assert.match(fn, /_mgPrompt\('Save queue as playlist'/, 'the shared prompt names it')
  assert.match(fn, /id: 'pl_' \+ Date\.now\(\)/, 'the same playlist id scheme as the New-playlist flow')
  assert.match(fn, /state\.playlists\.unshift\(pl\)/, 'added to state like everywhere else')
  assert.match(fn, /window\.api\.savePlaylist\(pl\)/, 'persisted through the existing channel')
})

test('the queue header has the save-as-playlist button, styled', () => {
  assert.match(code, /id="queue-save-playlist"/)
  assert.ok(renderer.includes('queue-save-playlist-btn'), 'the button class is emitted')
  assert.match(css, /\.queue-save-playlist-btn\s*\{/)
  assert.match(css, /\.queue-header-actions\s*\{/)
})

// ── Item 25: settings bug report + backup (already built; verify contract) ───

test('settings expose the bug-report button on the existing IPC', () => {
  const fn = code.slice(code.indexOf('function _initBugReport()'),
                        code.indexOf('function _initBugReport()') + 900)
  assert.match(fn, /window\.api\.papaBugReport/, 'calls the existing IPC')
  assert.match(fn, /typeof window\.api\.papaBugReport !== 'function'/, 'feature-detected')
  assert.match(fn, /res\.path/, 'and tells the user where the bundle was written')
})

test('settings expose backup, feature-detected on papaExportAll', () => {
  const fn = code.slice(code.indexOf('function _initBackupSettings()'),
                        code.indexOf('function _initBackupSettings()') + 900)
  assert.match(fn, /typeof window\.api\.papaExportAll !== 'function'/, 'hides/guards when absent')
  assert.match(fn, /window\.api\.papaExportAll\(\)/, 'calls the contract channel')
})

// ── Item 66: undo-toast audit ───────────────────────────────────────────────

test('wishlist remove now offers Undo', () => {
  const at = code.indexOf('.wishlist-remove-btn')
  const fn = code.slice(at, at + 700)
  assert.match(fn, /var removed = state\.downloadWishlist\.splice/, 'snapshots what it removed')
  assert.match(fn, /pushUndo\('Removed from wishlist'/, 'and offers Undo, not a bare snackbar')
  assert.match(fn, /splice\(idx, 0, removed\)/, 'restores it at the same position')
})

test('removing a saved user (friend) offers Undo via slskSaveUser', () => {
  const at = code.indexOf("dlg.querySelectorAll('[data-remove]')")
  const fn = code.slice(at, at + 700)
  assert.match(fn, /slskUnsaveUser/, 'still removes')
  assert.match(fn, /pushUndo\('Removed '/, 'and offers Undo')
  assert.match(fn, /slskSaveUser\(\{ username: snap\.username, note: snap\.note/,
    're-saves through the existing channel, note and all')
})

test('the destructive actions that already had Undo still do', () => {
  // Guard against a regression removing the Undo that the audit relies on being
  // present at these sites.
  assert.match(code, /pushUndo\('Removed from ' \+ pl\.name/, 'remove from playlist')
  // Wording depends on the store the playlist lived in (R7), the Undo does not.
  assert.match(code, /showSnackbar\(isSmart \? 'Smart playlist deleted' : 'Playlist deleted', 'Undo'/, 'delete playlist')
  // Roadmap 004 split the old Clear queue into two; both keep their Undo.
  assert.match(code, /pushUndo\('Stopped and cleared the queue'/, 'stop and clear')
  assert.match(code, /pushUndo\('Cleared ' \+ dropped \+ ' upcoming track'/, 'clear upcoming')
  assert.match(code, /pushUndo\('Cleared played tracks'/, 'clear played')
  assert.match(code, /pushUndo\('Removed from queue'/, 'remove from queue')
})
