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

// Roadmap 037: sleep keeps track, position and paused state; waking offers the same place back.
test('suspend saves the place and resume offers it back without starting noise on its own', () => {
  const sus = renderer.slice(renderer.indexOf("window.api.on('system-suspend'"), renderer.indexOf("window.api.on('system-resume'"))
  assert.ok(sus.includes('_sleptWhilePlaying = (state.isPlaying && t)'), 'what was playing is remembered')
  assert.ok(sus.includes('window.api.savePlaybackState({ filePath: t.filePath, position: Number(audio.currentTime) || 0 })'), 'and persisted')
  const res = renderer.slice(renderer.indexOf("window.api.on('system-resume'"), renderer.indexOf("window.api.on('papa-memory-pressure'"))
  assert.ok(res.includes("'Paused while the computer slept — '"), 'resume says what happened')
  assert.ok(res.includes("'Resume', function () {"), 'and offers the same place back')
  assert.ok(!/audio\.play\(\)|togglePlay\(\)\n/.test(res.slice(0, res.indexOf("showSnackbar('Paused while"))), 'nothing starts playing on its own after waking')
})

// Roadmap 034: Play flips at once, then the engine's truth is reported.
test('a refused or silent Play reverts the button and says why, with Retry', () => {
  assert.ok(renderer.includes(".then(function () { _armMusicStartWatch(_resumeAt) }).catch(_onPlayRefused)"), 'togglePlay handles the rejection')
  // The baseline is the position play was ASKED from — see qa-music-start-watch.
  assert.ok(renderer.includes('function _armMusicStartWatch(startedAt)') && renderer.includes("if ((Number(audio.currentTime) || 0) > at + 0.2) return"), 'no movement after Play is reported')
  assert.ok(renderer.includes("showSnackbar(text, 'Retry', function () { togglePlay() }, 8000)"))
  assert.ok(!renderer.includes("titleEl.textContent = 'File not available'"), 'the blanket "File not available" is gone')
  assert.ok(renderer.includes("audio.play().then(function () { _armMusicStartWatch(_startedAt); return onStarted() }).catch(onError)"))
})

// Roadmap 096: the gain policy is one sentence under Volume boost, kept live.
test('the playback settings show the summed gain policy and clipping risk', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('id="gain-policy-text"') && H.includes('<script src="gain-policy.js"></script>'))
  assert.ok(renderer.includes('function updateGainPolicyText()'))
  assert.ok(renderer.includes('try { updateGainPolicyText() } catch (_) {}'), 'refreshed with the quality badge, i.e. on every volume/EQ/settings change')
})

// Roadmap 137: sharing with Soulseek peers is a stated, changeable setting.
test('the slskd config shares what the setting says, and the setting is in the panel', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(M.includes("const slskShare = _lazyNs(() => require('./src/slsk-share'))"))
  assert.ok(M.includes("slskShare.shareDirs(store.get('slskShareMode', slskShare.DEFAULT), musicFolders, downloadDir)"))
  assert.ok(!M.includes('const shareDir = musicFolders[0] || path.dirname(downloadDir)'), 'the silent whole-library share is gone')
  assert.ok(M.includes("ipcMain.handle('slsk-share-mode-set'"))
  assert.ok(H.includes('id="slsk-share-mode"') && H.includes('<option value="off">Nothing</option>'))
  assert.ok(renderer.includes('async function _initSharingSettings()'))
})

// Roadmap 110: the provider choice states what leaves the device; main scrubs cloud-bound messages.
test('the provider setting shows the disclosure and cloud-bound messages are scrubbed in main', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('id="mcs-provider-disclosure"') && H.includes('<script src="agent-disclosure.js"></script>'))
  assert.ok(renderer.includes('_paintProviderDisclosure(chatState.provider)'))
  assert.ok(M.includes("if (provider === 'claude' || provider === 'openai') messages = _redact.scrubMessagesForCloud(messages)"))
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

// Roadmap 104: consequential tool calls the person did not ask for are previewed.
test('auto_download and clear_queue are gated behind a preview unless the request named them', () => {
  assert.ok(renderer.includes('var _CONSEQUENTIAL_TOOLS = {'))
  // The wording of the "did he name it?" test is behaviour, not wiring, and is
  // pinned properly by test/agent-download-confirm.test.js, which runs the real
  // gate. Here we only check the tool still HAS one. A literal copy of the
  // pattern was a test of its spelling, and went stale the moment the pattern
  // was narrowed (B19: a bare "get" or "save" is not permission to download).
  assert.ok(/auto_download:\s*\{[\s\S]{0,400}?ask:\s*\//.test(renderer),
    'auto_download must still carry an ask pattern')
  assert.ok(renderer.includes("if (asked && rule.ask.test(asked.content)) return Promise.resolve(true)"), 'naming the action is authorisation')
  const fn = renderer.slice(renderer.indexOf('async function _executeTool('), renderer.indexOf('async function _executeTool(') + 400)
  assert.ok(fn.includes("if (!ok) return 'The user declined: '"), 'a decline is reported back to the model honestly')
})

// Roadmap 111: provider failures are specific and recoverable.
test('a provider failure comes back classified with a next step, and the renderer offers it', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  const h = M.slice(M.indexOf("ipcMain.handle('agent-chat'"), M.indexOf('async function _agentChatOnce('))
  assert.ok(h.includes("const r = F.explain(name, e, {})") && h.includes("failure: quota ? 'quota' : r.kind"))
  assert.ok(!h.includes('throw e'), 'nothing reaches the renderer as an IPC throw')
  assert.ok(renderer.includes('function _agentFailureText(res)') && renderer.includes("'Open Settings', function () { openSettings('mcs-claude-row') }"))
})

// Roadmap 109: taste memory is editable one insight at a time; rejected keys stay rejected.
test('insights can be edited, deleted or excluded, and the profile builder honours both', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  const PRE = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(M.includes("ipcMain.handle('agent-edit-insight'") && PRE.includes("'agent-edit-insight'"))
  assert.ok(M.includes("if (!ins || excluded.has(ins.key)) continue"), 'an excluded key is never merged back')
  assert.ok(M.includes("if (ex && ex.edited) continue"), 'a hand-corrected text is never overwritten')
  assert.ok(renderer.includes('data-ins-act="exclude"') && renderer.includes('data-ins-act="edit"') && renderer.includes('data-ins-act="delete"'))
})

// Roadmap 103: the assistant's welcome reflects real capabilities and names what is off.
test('the agent welcome is built from connections and says what is not available', () => {
  const fn = renderer.slice(renderer.indexOf('function _paintAgentWelcome()'), renderer.indexOf('async function _initSettingsPanel()'))
  assert.ok(fn.includes("const slskOn = !!(slsk && slsk.status && slsk.status.connected)"))
  assert.ok(fn.includes("if (!slskOn) cannot.push('Soulseek is not connected, so downloading is off until it is')"))
  assert.ok(fn.includes("if (!online) cannot.push("))
  assert.ok(renderer.includes("if (chatState.open) { try { _paintAgentWelcome() } catch (_) {} }"), 'refreshed each time the drawer opens')
})

// Roadmap 094: the signal path is stated stage by stage, with unknowns labelled.
test('the stats row carries a source → decoder → processing → output tooltip that never claims a device rate', () => {
  const fn = renderer.slice(renderer.indexOf('function _signalPathText('), renderer.indexOf('function updatePlayBtn('))
  assert.ok(fn.includes("'\\nDecoder: '") && fn.includes("'\\nProcessing: '") && fn.includes("'\\nOutput: '"))
  assert.ok(fn.includes('device sample rate not measured'))
  assert.ok(fn.includes("'mpv (decoded format not reported yet)'"))
  assert.ok(renderer.includes('el.title = _signalPathText(track)'))
})

// Roadmap 095/097: ReplayGain and exclusive mode are explained before they are chosen.
test('the output-mode and ReplayGain controls carry plain explanations', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('nothing else can play through it while a track is loaded'))
  assert.ok(H.includes('a file without them plays unchanged'))
  assert.ok(H.includes('<option value="album">Album — keep an album'))
})

// Roadmap 089: compilations show the track artist; discs say their total.
test('now-playing and queue rows lead with the track artist; disc bands say "of N"', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes("discTotal: c.disk?.of || null,"))
  assert.ok(renderer.includes("? track.artist + ' · ' + track.albumArtist"))
  assert.ok(renderer.includes("${esc(t.artist || t.albumArtist || '')}${t.bpm"))
  assert.ok(renderer.includes("Disc ${disc}${discTotal > 1 ? ' of ' + discTotal : ''}"))
})

// Roadmap 088: artwork changes preview the candidate, its size, the current cover and what is replaced.
test('the artwork dialog shows current vs new, measures the candidate, and states where the change lands', () => {
  const fn = renderer.slice(renderer.indexOf('async function setAlbumArtwork()'), renderer.indexOf('function _artCacheBust('))
  assert.ok(fn.includes('art-preview-current') && fn.includes('id="art-candidate"'))
  assert.ok(fn.includes("cand.naturalWidth + '×' + cand.naturalHeight"), 'resolution is read from the decoded image')
  assert.ok(fn.includes("Replaces the cover Papa Audio shows for this album; the image file you chose and your music files are not touched unless you embed"))
})

// Roadmap 056: a truncated Songs section says how many are shown and gives access to the rest.
test('local search shows "N of M" and a Show all button that lifts the cap for this query', () => {
  assert.ok(renderer.includes("if (state._searchTrackCapFor !== query) { state._searchTrackCap = 20; state._searchTrackCapFor = query }"))
  assert.ok(renderer.includes('id="search-show-all-tracks">Show all ${matchTracksTotal} songs</button>'))
  assert.ok(renderer.includes("state._searchTrackCap = Infinity\n    renderSearch(query)"))
})

// Roadmap 082: wishlist automation is explicit per entry.
test('wishlist rows state auto vs notify, pause, last check and cadence; paused entries are skipped', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes("const entries = all.filter(w => w && !w.paused)"), 'the sweep skips paused entries')
  assert.ok(M.includes("store.set('wishlistLastSweepAt', Date.now())"))
  assert.ok(M.includes("ipcMain.handle('get-wishlist-status'"))
  assert.ok(renderer.includes("'Notify only — tells you, never downloads'") && renderer.includes("'Auto-download when a clean copy appears'"))
  assert.ok(renderer.includes("Checked every ' + wlEvery + ' while the app is open"))
  assert.ok(renderer.includes("class=\"wishlist-pause-btn\"") && renderer.includes("class=\"wishlist-mode-btn\""))
})

// Roadmap 098: the requested device is never shown as active while the default output plays.
test('a device fallback is remembered, shown under the picker, and demotes BIT-PERFECT', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('id="pb-device-active"'))
  assert.ok(renderer.includes("state._activeDeviceFallback = { from: d.from || 'the chosen device'"))
  assert.ok(renderer.includes("el.textContent = 'Active now: the default output — not ' + fb.from"))
  assert.ok(renderer.includes("if (fb && v.label === 'BIT-PERFECT') { v = { label: 'LOSSLESS'"), 'no bit-perfect claim on a device not in use')
  assert.ok(renderer.includes("if (!d.deviceFallback && state._activeDeviceFallback) { state._activeDeviceFallback = null"), 'cleared on a clean recovery')
})

// Roadmap 041: the sleep timer states itself, can be extended, and explains Stop after this track.
test('the sleep panel shows remaining time in words, offers +15, and explains the stop-after interaction', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('id="sleep-status"') && H.includes('id="sleep-extend" data-extend="15"'))
  assert.ok(renderer.includes("' min left — fades out and pauses at ' + hhmm"))
  assert.ok(renderer.includes("Stop after this track is also on; whichever comes first wins."))
  assert.ok(renderer.includes("setSleepTimer(Math.round((left + Number(btn.dataset.extend) * 60000) / 60000))"), 'extend adds to what is left')
})

// Roadmap 080: Cancel and Remove say what they keep and what they drop.
test('download row actions explain partial data, list-only removal and retry', () => {
  assert.ok(renderer.includes('title="Cancel — stops this transfer and takes it off the queue. Nothing downloaded so far is kept'))
  assert.ok(renderer.includes('title="Remove from this list only. A downloaded file stays in your library'))
  assert.ok(renderer.includes('Finished tracks stay in your library." aria-label="Cancel every transfer in this album"'))
  assert.ok(!renderer.includes('title="Remove" aria-label="Remove">'), 'no bare Remove is left')
})

// Roadmap 049: a saved queue is a session (tracks + place); a playlist is a collection.
test('a saved queue keeps index and position and resumes there', () => {
  assert.ok(renderer.includes("index: state.queueIndex >= 0 ? state.queueIndex : 0,"))
  assert.ok(renderer.includes("position: state.queueIndex >= 0 ? Math.floor(Number(audio && audio.currentTime) || 0) : 0,"))
  assert.ok(renderer.includes("const idx = Number.isInteger(q.index) && q.index >= 0 && q.index < q.tracks.length ? q.index : 0"))
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('A saved queue is a listening session'))
})

// Roadmap 044: remaining listening time is shown separately from the total.
test('the queue header shows time left from here and the total', () => {
  assert.ok(renderer.includes("? fmtDur(leftQD) + ' left · ' + totalQDstr + ' total'"))
  assert.ok(renderer.includes("leftQD = Math.max(0, leftQD - (Number(audio && audio.currentTime) || 0))"), 'minus how far into this track we are')
})

// Roadmap 047: shuffle's next pick is visible; the list keeps its original order.
test('the queue panel names the shuffled next pick and says the order is kept', () => {
  assert.ok(renderer.includes("shuffleNote = '<div class=\"queue-shuffle-note\">Shuffle is on — next up: '"))
  assert.ok(renderer.includes('The list keeps its original order.'))
})

// Roadmap 050: playlist edits report their count and undo without touching files.
test('playlist removal — single × and bulk — is undoable and never deletes audio', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(H.includes('id="sel-remove-pl"'))
  const bulk = renderer.slice(renderer.indexOf("document.getElementById('sel-remove-pl')?.addEventListener"), renderer.indexOf("document.getElementById('sel-trash')?.addEventListener"))
  assert.ok(bulk.includes("pushUndo('Removed ' + removed.length + ' track'"), 'count + undo')
  assert.ok(!/trash|unlink|rm/i.test(bulk.replace(/Removed/g, '')), 'no file operation')
  const single = renderer.slice(renderer.indexOf("const fp = btn.dataset.plRemoveFp"), renderer.indexOf("const fp = btn.dataset.plRemoveFp") + 600)
  assert.ok(single.includes("pushUndo('Removed from ' + pl.name"), 'the × is undoable too')
})

// Roadmap 130: playing and selected are not colour alone.
test('the playing row carries a ▶ and a selected row an outline and ✓, not only a colour', () => {
  const CSS = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(CSS, /\.queue-row\.playing \.queue-row-title::before \{ content:'\\25B6/)
  assert.match(CSS, /\.track-row\.playing \.track-title::before \{ content:'\\25B6/)
  assert.match(CSS, /\.track-row\.row-selected, \.queue-row\.row-selected \{ outline:1px solid var\(--accent\)/)
  assert.match(CSS, /\.track-row\.row-selected \.track-num::after \{ content:' \\2713'/)
})

// Roadmap 121: mixed-script metadata reads in its own direction.
test('metadata text elements use unicode-bidi: plaintext', () => {
  const CSS = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const rule = CSS.slice(CSS.indexOf('/* Roadmap 121'), CSS.indexOf('{ unicode-bidi: plaintext; }'))
  for (const c of ['.np-title', '.track-title', '.track-artist', '.album-card-name', '.queue-row-title', '.vt-title', '.vcard-title', '.video-detail-title', '.vep-title']) {
    assert.ok(rule.includes(c), c + ' is covered')
  }
})

// Roadmap 128: long titles are readable without a perpetual marquee.
test('the now-playing ticker carries the full text on its tooltip, pauses on hover, and is off under reduced motion', () => {
  const CSS = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const fn = renderer.slice(renderer.indexOf('function applyTicker('), renderer.indexOf('function updateStatsRow('))
  assert.ok(fn.includes("el.title = (el.textContent || '').trim()"))
  assert.match(CSS, /\.np-title\.ticker-active:hover[^{]*\{ animation-play-state: paused; \}/)
  assert.match(CSS, /prefers-reduced-motion: reduce\) \{\n\s+\.np-title\.ticker-active, \.np-artist\.ticker-active \{ animation: none; text-overflow: ellipsis; \}/)
})

// Roadmap 019: the Library's empty state says why.
test('the Library empty state goes through the tested cause table and offers Add a music folder', () => {
  assert.ok(renderer.includes('function _libEmptyHtml('))
  assert.ok(renderer.includes('tools.libraryEmptyState({ folders: state.musicFolders, unavailableRoots: state._unavailableRoots'))
  assert.ok(renderer.includes('id="lib-empty-add-folder">Add a music folder</button>'))
  assert.ok(!renderer.includes("'Your library is empty. Add a music folder to get started.')}</p>"), 'the one-size message is gone from the grid')
})

// Roadmap 021: the first download of a session says where it goes and how much room there is.
test('the first successful enqueue names the destination and free space with a Change folder action', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes("destination = { dir, freeBytes: freeSpaceAt(path.join(dir, 'x')) }"))
  assert.ok(M.includes('return { ok: true, added, refused, destination, stats: dlSched.stats(dlState) }'))
  assert.ok(renderer.includes("showSnackbar('Downloading to ' + shortPath(res.destination.dir) + free, 'Change folder'"))
  assert.ok(renderer.includes('_dlDestinationTold = true'), 'once per session, not per download')
})

// Roadmap 079: capacity is checked before transfer work and refused as a choice.
test('downloads are checked for space and writability before enqueue, and refusals offer a way on', () => {
  const M = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes("const dlCapacity = _lazyNs(() => require('./src/dl-capacity'))"))
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
