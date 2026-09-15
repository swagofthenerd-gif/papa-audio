'use strict'
// Wiring checks for the Wave-6 music features, in the same source-assertion
// style as queue-ui.test.js: prove the renderer emits what the CSS styles and
// that the new surfaces are reachable, without standing up a DOM.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const p = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const renderer = p('src/renderer.js')
const html = p('src/index.html')
const css = p('src/styles.css')

test('music-tools is loaded in the renderer before renderer.js', () => {
  assert.ok(html.includes('music-tools.js'), 'music-tools.js is not loaded in index.html')
  const mtAt = html.indexOf('music-tools.js')
  const rAt = html.indexOf('renderer.js')
  assert.ok(mtAt < rAt, 'music-tools.js must load before renderer.js so the global exists')
})

test('every new class the renderer emits has a CSS rule', () => {
  for (const c of ['queue-clear-row', 'queue-clear-played-btn', 'stats-month-chart',
    'stats-month-bar', 'stats-dupes', 'dupe-group', 'dupe-file', 'sleep-label']) {
    assert.ok(renderer.includes(c), `${c} is not emitted by the renderer`)
    assert.ok(new RegExp(`\\.${c}\\s*[{,]`).test(css), `.${c} has no CSS rule`)
  }
})

test('the sleep timer offers 90 minutes and end-of-track', () => {
  assert.ok(/data-mins="90"/.test(html), 'no 90-minute preset in the sleep panel')
  assert.ok(/data-mins="0"[^>]*>\s*End of track/.test(html), 'no end-of-track option')
  // Cancel must not collide with the end-of-track (mins 0) entry.
  assert.ok(/sleep-cancel[^>]*data-mins="-1"/.test(html), 'cancel must use a distinct data-mins')
})

test('the sleep timer fades and restores volume rather than hard-cutting', () => {
  assert.ok(renderer.includes('_sleepFadeAndPause'), 'no fade path on the sleep timer')
  assert.ok(renderer.includes('sleepFadeSteps'), 'the fade does not use the tested pure curve')
  assert.ok(/audio\.volume\s*=\s*startVol/.test(renderer), 'the volume is never restored after pausing')
})

test('end-of-track sleep is honoured at the track boundary', () => {
  assert.ok(renderer.includes('_sleepAtTrackEnd'), 'no end-of-track hook')
  assert.ok(/_sleepAtTrackEnd\(\)\)\s*return/.test(renderer), 'playNext does not consult the end-of-track hook')
})

test('the queue panel wires a clear-played action to the tested helper', () => {
  assert.ok(renderer.includes('clearPlayedQueue'), 'clear-played does not call the tested helper')
  assert.ok(renderer.includes("'Clear played'"), 'no Clear played button label')
})

// Roadmap 106: Stop stops the assistant now, aborts the request, and is honest about in-flight work.
test('assistant Stop releases immediately, aborts the provider request, and names the tool in flight', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  const PRE = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(renderer.includes("stopBtn?.addEventListener('click', stopChat)"))
  const fn = renderer.slice(renderer.indexOf('function stopChat()'), renderer.indexOf('async function handleChatMessage('))
  assert.ok(fn.includes('_setChatBusy(false)'), 'the UI is released at once, not after the request returns')
  assert.ok(fn.includes('window.api.agentCancel'), 'main is asked to abort')
  assert.ok(fn.includes('was already running and may finish on its own'), 'in-flight work is reported honestly')
  assert.ok(fn.includes('Your playback was not touched'), 'and playback is left alone')
  assert.ok(!fn.includes('audio.pause'), 'Stop never pauses the music')
  const loop = renderer.slice(renderer.indexOf('async function handleChatMessage('), renderer.indexOf('// ── UI helpers'))
  assert.ok((loop.match(/if \(stale\(\)\) return/g) || []).length >= 5, 'every await is followed by a staleness check')
  assert.ok(!loop.includes("'Stopped.'"), 'the loop no longer speaks for Stop')
  assert.ok(PRE.includes("ipcRenderer.invoke('agent-cancel')"))
  assert.ok(M.includes("ipcMain.handle('agent-cancel'") && M.includes('_agentAbort = new AbortController()'))
  for (const fn2 of ['claudeChat', 'openaiChat', 'ollamaToolChat']) {
    const body = M.slice(M.indexOf('async function ' + fn2 + '('), M.indexOf('\n}\n', M.indexOf('async function ' + fn2 + '(')))
    assert.ok(body.includes('signal: _agentSignal(30000)'), fn2 + ' honours the cancel')
  }
})

// Roadmap 079: capacity is checked before transfer work and refused as a choice.
test('downloads are checked for space and writability before enqueue, and refusals offer a way on', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes("require('./src/dl-capacity')"))
  const h = M.slice(M.indexOf("ipcMain.handle('slsk-enqueue-downloads'"), M.indexOf('function dlQueueFiles()'))
  assert.ok(/if \(!ignoreCapacity\) \{\n\s+const cap = await _dlCapacityCheck\(items\)\n\s+if \(!cap\.ok\) \{/.test(h), 'the check runs before addItems')
  assert.ok(h.indexOf('_dlCapacityCheck') < h.indexOf('dlSched.addItems'), 'and before anything is queued')
  assert.ok(renderer.includes('_slskOfferCapacityChoice(list, res.capacity)'))
  assert.ok(renderer.includes("showSnackbar(cap.text, 'Choose folder'"), 'unwritable offers a folder change')
  assert.ok(renderer.includes("showSnackbar(cap.text, 'Download anyway'"), 'low space offers to proceed knowingly')
  assert.ok(renderer.includes('ignoreCapacity: true'))
})

// Roadmap 084: the renderer reports a disconnected root and dims its albums.
test('unavailable albums are shown as not connected, not removed', () => {
  assert.ok(renderer.includes('_reportUnavailableRoots(data.unavailableRoots)'))
  assert.ok(renderer.includes("class=\"album-card${album.unavailable ? ' unavailable' : ''}\""))
  assert.ok(renderer.includes('kept but unavailable until it returns'))
})

// Roadmap 048: a missing file stays in the queue with Locate / Remove.
test('a confirmed-missing file is marked, played past, and offered Locate', () => {
  const P = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'load-error-policy.js'), 'utf8')
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  const PRE = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(!P.includes("action: 'drop'"), 'the policy no longer removes anything')
  assert.ok(P.includes("action: 'mark'"))
  assert.ok(renderer.includes("if (decision.action === 'mark') {") && renderer.includes('markMissingTrack(filePath, track)'))
  assert.ok(renderer.includes('function _nextPlayableIndex('), 'playback skips marked entries')
  assert.ok(/if \(track\._missing\) \{\n\s+const next = _nextPlayableIndex/.test(renderer), 'a marked entry is never sent to the engine')
  assert.ok(renderer.includes('class="q-missing-badge"') && renderer.includes('data-locate-idx='), 'the row shows the badge and Locate')
  assert.ok(PRE.includes("ipcRenderer.invoke('locate-track-file', p)"))
  assert.ok(M.includes("ipcMain.handle('locate-track-file'") && M.includes('if (!libPathInRoots(fp)) return'), 'Locate stays inside the library roots')
})

// Roadmap 051: duplicates are skipped by default and offered, never silently dropped.
test('adding duplicates to a playlist offers Keep both instead of discarding them', () => {
  assert.ok(renderer.includes('tools.playlistAddPlan(pl.tracks, slim)'))
  assert.ok(renderer.includes("showSnackbar(msg, 'Keep both', keepBoth, 6000)"))
  assert.ok(renderer.includes("showSnackbar('Already in this playlist', 'Keep both'"), 'the single-track path offers it too')
  assert.ok(!renderer.includes("showSnackbar('Already in this playlist'); return"), 'the flat refusal is gone')
})

// Roadmap 057: empty is not failure; each failure kind has its own next step.
test('the YouTube section paints failures through the shared classifier', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('<script src="source-failure.js"></script>'))
  assert.ok(renderer.includes('function _ytFailureHtml('))
  assert.ok(renderer.includes('_ytFailureHtml(null, { offline: true })'), 'offline')
  assert.ok(renderer.includes('_ytFailureHtml(null, { cancelled: true })'), 'cancelled')
  assert.ok(renderer.includes("_ytFailureHtml(res.error || 'unknown error', { offline: !state.isOnline })"), 'errors')
  assert.ok(!/YouTube search failed: \$\{esc\(res\.error/.test(renderer), 'the raw error dump is gone')
  assert.ok(renderer.includes("F.explain('Soulseek', e,"), 'Soulseek reads the same table')
})

// Roadmap 040/045: Previous and Play next follow one documented rule each.
test('Previous and the context-menu Play next go through the tested rules and the help says so', () => {
  assert.ok(renderer.includes('tools.prevAction(audio.currentTime, state.queue.length)'))
  assert.ok(renderer.includes("desc: 'Previous / next track — Previous restarts the track after 3 s, goes back before that'"), 'the shortcut help states the threshold')
  assert.ok(renderer.includes('tools.insertPlayNext(state.queue, state.queueIndex, tracks)'))
  const i = renderer.indexOf("_ctxOn('ctx-play-next'")
  const body = renderer.slice(i, renderer.indexOf("_ctxOn('ctx-trash'", i))
  assert.ok(body.includes('updateNextPrefetch()'), 'Play next re-arms gapless prefetch')
  assert.ok(body.includes('in order'), 'a multi-track Play next says the order is kept')
})

// Roadmap 114: the player bar's seek and volume are sliders to assistive tech.
test('the player-bar seek and volume tracks carry slider semantics, values and keys', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.match(H, /id="progress-track" role="slider" tabindex="0"\n\s+aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext=/)
  assert.match(H, /id="vol-track" role="slider" tabindex="0"\n\s+aria-label="Volume" aria-valuemin="0" aria-valuemax="100"/)
  assert.ok(renderer.includes('_syncSeekAria(ct, audio.duration)'), 'the time tick keeps the seek value current')
  assert.ok(renderer.includes('_syncVolumeAria(vol)'), 'every volume change keeps the volume value current')
  assert.ok(/if \(a\.valuenow === _ariaSeekLast\) return/.test(renderer), 'the seek value is written only when the percent changes (116)')
  assert.ok(renderer.includes("bindSliderKeys(document.getElementById('progress-track')"), 'seek takes keys')
  assert.ok(renderer.includes("bindSliderKeys(document.getElementById('vol-track')"), 'volume takes keys')
  assert.ok(renderer.includes('sliderKeyRatio(e.key, e.shiftKey, cur, step)'), 'through the tested key rule')
})

// Roadmap 087: the hero editor writes real tags and says so; no "coming soon".
test('album hero edits go through the tag writer with an explicit scope note', () => {
  assert.ok(!renderer.includes('visual only — save to file coming soon'), 'the placeholder note is gone')
  const i = renderer.indexOf('function editField(')
  const body = renderer.slice(i, renderer.indexOf('\n}\n', i))
  assert.ok(body.includes('libraryWriteTags'), 'editField writes through the real writer')
  assert.ok(body.includes('Writes the tag into '), 'the prompt states the file scope')
  assert.ok(body.includes('Changes only what this app shows'), 'and the app-only scope when there is no writer')
  assert.ok(/if \(!res\.written\) \{[\s\S]*?return\s*\}[\s\S]*?callback\(newVal\)/.test(body), 'the display changes only after a successful write')
  assert.ok(renderer.includes("_heroWrite('album')") && renderer.includes("_heroWrite('artist')"), 'title and artist edits are wired to it')
  assert.ok(renderer.includes('heroTagWrites(album'), 'through the tested mapping')
})

// Roadmap 005: the page scrolls vertically over album rows; rows get arrows.
test('album rows no longer hijack vertical wheel and are dressed with rail arrows', () => {
  const i = renderer.indexOf("addEventListener('wheel', e => {\n    const row = e.target.closest('.scroll-row')")
  assert.ok(i > 0, 'the row wheel delegate exists')
  const body = renderer.slice(i, renderer.indexOf('}, { passive: false })', i))
  assert.ok(body.includes('rowWheelDelta(e)'), 'the delegate asks the tested helper what the wheel meant')
  assert.ok(!/row\.scrollLeft \+= e\.deltaY/.test(body), 'deltaY is never applied as horizontal movement directly')
  assert.ok(renderer.includes('function _dressScrollRow('), 'rows are wrapped with arrows')
  assert.ok(renderer.includes("wrap.className = 'vrail-wrap music-rail-wrap'"), 'reusing the video rail wrapper so _bindRail applies')
  assert.ok(renderer.includes('_watchScrollRows()'), 'the observer is started from setup')
})

// Roadmap 004: clearing upcoming and stopping are separate, explicit actions.
test('the queue panel separates Clear upcoming from Stop and clear', () => {
  assert.ok(renderer.includes('clearUpcomingQueue'), 'clear-upcoming does not call the tested helper')
  assert.ok(renderer.includes("'Clear upcoming'"), 'no Clear upcoming button label')
  assert.ok(renderer.includes("'Stop and clear'"), 'no Stop and clear button label')
  assert.ok(!renderer.includes("'Clear queue'"), 'the ambiguous Clear queue label is gone')
  // The upcoming path never touches playback: no pause between its helper call and its undo.
  const start = renderer.indexOf("clearUpcomingBtn.addEventListener('click'")
  const end = renderer.indexOf('const clearBtn = document.createElement', start)
  const body = renderer.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.ok(!/audio\.pause\(|isPlaying = false|updateNowPlaying\(null\)/.test(body), 'Clear upcoming stops nothing')
  assert.ok(renderer.includes("cmd === 'clear-upcoming'"), 'the extension can ask for the safe clear too')
})

test('the stats page registers under navigate and gains the new sections', () => {
  assert.ok(/page === 'stats'\s*\)\s*renderStats\(\)/.test(renderer), 'stats page is not registered in navigate')
  assert.ok(renderer.includes('topAlbumsByPlays'), 'stats page does not compute top albums')
  assert.ok(renderer.includes('playsPerMonth'), 'stats page does not compute plays-per-month')
  assert.ok(renderer.includes('>Top Albums'), 'no Top Albums heading rendered')
  assert.ok(renderer.includes('>Plays per Month'), 'no Plays per Month heading rendered')
})

test('the duplicate finder is reachable from the stats page', () => {
  assert.ok(renderer.includes('find-dupes-btn'), 'no Find duplicates button')
  assert.ok(renderer.includes('renderDupeFinder'), 'no duplicate finder render function')
  assert.ok(renderer.includes('findDuplicateTracks'), 'the finder does not use the tested helper')
})
