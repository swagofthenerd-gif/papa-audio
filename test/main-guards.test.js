'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const CODE = MAIN
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// ── Item 59: one safe send, used everywhere ─────────────────────────────────

test('nothing pushes to the renderer except through the helper', () => {
  // webContents.send throws if the window is gone, and during the close race
  // that reached only the blanket uncaughtException handler. One of four call
  // sites was wrapped; the rest were not.
  assert.strictEqual([...CODE.matchAll(/webContents\.send\(/g)].length, 0,
    'every send goes through a guarded helper, which resolves the webContents itself')
  // The real sends live inside the two guarded helpers, each after its own
  // liveness checks: safeSend pushes to the main renderer, _overlaySend pushes
  // to the overlay controls window (roadmap #26). Both resolve and check their
  // own webContents; nothing else calls wc.send directly.
  const sends = [...CODE.matchAll(/\bwc\.send\(/g)]
  assert.strictEqual(sends.length, 2)
  const helper = CODE.slice(CODE.indexOf('function safeSend('), CODE.indexOf('function resetChannelSeq('))
  assert.ok(helper.includes('wc.send(channel, payload,'), 'the send carries the sequence alongside the payload')
  const overlayHelper = CODE.slice(CODE.indexOf('function _overlaySend('),
    CODE.indexOf('function _overlaySend(') + 500)
  assert.match(overlayHelper, /mainWindow|ov\.isDestroyed\(\)/)
  assert.match(overlayHelper, /wc\.isDestroyed\(\)/, 'the overlay send checks its webContents too')
  assert.ok(overlayHelper.includes('wc.send('), 'the overlay push goes through wc.send')
})

test('safeSend checks the window and the webContents, and never throws', () => {
  const fn = CODE.slice(CODE.indexOf('function safeSend('), CODE.indexOf('function resetChannelSeq('))
  assert.match(fn, /mainWindow\.isDestroyed\(\)/)
  assert.match(fn, /wc\.isDestroyed\(\)/)
  assert.match(fn, /catch/)
})

// ── Items 53 and 200: one engine-ready check ────────────────────────────────

test('the close confirmation asks the engine, not the renderer', () => {
  // executeJavaScript('state.isPlaying') rejected if the renderer had reloaded or
  // died, and the catch silently closed the app — skipping the confirmation
  // during active playback.
  assert.doesNotMatch(CODE, /executeJavaScript\('state\.isPlaying'\)/)
  const close = CODE.slice(CODE.indexOf("mainWindow.on('close'"), CODE.indexOf("mainWindow.on('closed'"))
  assert.match(close, /playerIsPlaying\(\)/)
})

test('every engine entry point shares one readiness check', () => {
  // `if (!player)` passed even when the client inside it was null, which is how
  // a media key or the tray could act on a dead engine.
  assert.match(CODE, /function playerReady\(\)/)
  const ready = CODE.slice(CODE.indexOf('function playerReady()'), CODE.indexOf('function playerIsPlaying()'))
  assert.match(ready, /player\.alive !== false/, 'a truthy player is not a live one')
  const wrap = CODE.slice(CODE.indexOf('const wrap = fn =>'), CODE.indexOf('const wrap = fn =>') + 400)
  assert.match(wrap, /if \(!playerReady\(\)\)/)
})

test('playerIsPlaying reads mpv rather than a mirror of it', () => {
  const fn = CODE.slice(CODE.indexOf('function playerIsPlaying()'), CODE.indexOf('function sendPlayerEvent('))
  assert.match(fn, /player\.getState\(\)/)
  assert.match(fn, /st\.paused === false/)
  assert.match(fn, /catch/, 'asking a dying engine must not throw at the close handler')
})

// ── Item 106: every path-taking handler goes through the guard ─────────────

test('the path guard is lexical, so it works for a file that does not exist', () => {
  const fn = CODE.slice(CODE.indexOf('function pathIsOurs('), CODE.indexOf('function libPathInRoots('))
  assert.match(fn, /path\.resolve/)
  assert.doesNotMatch(fn, /realpath/, 'realpath fails for a path that does not exist yet')
})

test('the guard is side-effect free', () => {
  // _downloadDir() creates directories and warns; a guard must not.
  const fn = CODE.slice(CODE.indexOf('function papaRoots('), CODE.indexOf('function pathIsOurs('))
  assert.doesNotMatch(fn, /mkdir|_downloadDir\(\)|console\./)
})

test('the four unguarded path handlers now refuse paths outside the app folders', () => {
  for (const [channel, until] of [
    ["ipcMain.handle('slsk-show-in-folder'", "ipcMain.handle('open-external'"],
    ["ipcMain.handle('verify-surround'", "ipcMain.handle('verify-surround-folder'"],
    ["ipcMain.handle('verify-surround-folder'", "ipcMain.handle('get-audio-devices'"],
  ]) {
    const at = CODE.indexOf(channel)
    assert.ok(at > 0, `${channel} not found`)
    const end = CODE.indexOf(until, at)
    const body = CODE.slice(at, end > at ? end : at + 900)
    assert.match(body, /pathIsOurs\(/, `${channel} takes a path and does not check it`)
  }
  // transcode is the one that WRITES, so both ends are checked.
  const fn = CODE.slice(CODE.indexOf('function transcodeFile('), CODE.indexOf('function transcodeFile(') + 900)
  assert.match(fn, /pathIsOurs\(filePath\)/)
  assert.match(fn, /pathIsOurs\(outDir\)/)
})

// ── Item 139: peer paths never land in the library root ───────────────────

test('the download folder fallback is a subfolder, not the library root', () => {
  const fn = CODE.slice(CODE.indexOf('function _downloadDir()'), CODE.indexOf("ipcMain.handle('slsk-get-download-dir'"))
  assert.match(fn, /DOWNLOAD_SUBDIR/)
  assert.doesNotMatch(fn, /return cfg\.downloadDir \|\| folders\[0\]/, 'that is the bug')
  assert.match(fn, /mkdirSync/, 'the fallback has to exist, not be assumed')
})

// ── Item 170: a scan on a dead mount has no natural end ──────────────────

test('the scan has a deadline and reports what it skipped', () => {
  assert.match(CODE, /SCAN_DEADLINE_MS/)
  const fn = CODE.slice(CODE.indexOf('async function _performScanOnce('), CODE.indexOf('async function _performScanOnce(') + 1600)
  assert.match(fn, /overDeadline\(\)/)
  assert.match(fn, /console\.error/, 'stopping early has to say so')
})

// ── Tier 0 regressions from the 125-item round ──────────────────────────────

test('nothing that waits on a person is deadlined', () => {
  // A deadline on a dialog does not protect against a wedged handler, it cancels
  // the user. add-music-folder commits the folder BEFORE it returns, so a
  // rejected invoke left main and the renderer disagreeing about the library.
  const tbl = CODE.slice(CODE.indexOf('const IPC_TIMEOUT_OVERRIDES = {'), CODE.indexOf('const _ipcRawHandle'))
  const humanWaiting = []
  for (const m of CODE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
    const nxt = CODE.indexOf('ipcMain.', m.index + 10)
    const body = CODE.slice(m.index, nxt > 0 ? nxt : m.index + 2500)
    if (/showOpenDialog|showSaveDialog|showMessageBox|new BrowserWindow/.test(body)) humanWaiting.push(m[1])
  }
  assert.ok(humanWaiting.length >= 5, `expected several, found ${humanWaiting}`)
  const missing = humanWaiting.filter(ch => !new RegExp(`'${ch}': 0`).test(tbl))
  assert.deepStrictEqual(missing, [], 'these wait on a person and must be exempt with 0')
})

test('the tray tooltip has exactly one writer', () => {
  // update-now-playing used to set it directly while the engine-event refresh —
  // reading a _trayTrack nothing fed — overwrote it with a bare "Papa Audio".
  const sets = [...CODE.matchAll(/tray\.setToolTip\(/g)]
  assert.strictEqual(sets.length, 2, 'createTray plus refreshTrayTooltip, nothing else')
  const nowPlaying = CODE.slice(CODE.indexOf("ipcMain.on('update-now-playing'"), CODE.indexOf("ipcMain.on('update-now-playing'") + 900)
  assert.doesNotMatch(nowPlaying, /tray\.setToolTip\(/, 'it must go through refreshTrayTooltip')
  assert.match(nowPlaying, /_trayTrack = data\.title/, 'and it must feed the name it already has')
})

test('a background search is never cancelled by a UI search', () => {
  assert.match(CODE, /const BACKGROUND_GENERATION = -1/)
  const fn = CODE.slice(CODE.indexOf('async function cancelSearchesExcept'), CODE.indexOf('async function cancelSearchesExcept') + 700)
  assert.match(fn, /info\.generation <= BACKGROUND_GENERATION\) continue/)
})

test('the search registry is cleaned in a finally', () => {
  // Any slskdFetch in the polling loop can throw; the cleanup used to sit after
  // the loop, so a thrown search leaked its id forever.
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('slsk-search'"), CODE.indexOf("ipcMain.handle('slsk-download'"))
  const fin = h.lastIndexOf('} finally {')
  assert.ok(fin > 0, 'the handler needs a finally')
  const tail = h.slice(fin)
  assert.match(tail, /_liveSearches\.delete\(id\)/)
  assert.match(tail, /_cancelledSearches\.delete\(id\)/)
})

// ── Items 1.7 and 1.8: the artwork cache must never be poisoned ────────────

// Extracted and run for real, because the whole point of this function is what
// it says about specific bytes.
function loadLooksLikeImage() {
  const src = MAIN.slice(MAIN.indexOf('function looksLikeImage('), MAIN.indexOf('const ART_MISS_TTL_MS'))
  // eslint-disable-next-line no-new-func
  return new Function('Buffer', src + '; return looksLikeImage')(Buffer)
}

function pad(head, len) {
  const b = Buffer.alloc(len || 4096)
  Buffer.from(head).copy(b, 0)
  return b
}

test('looksLikeImage accepts the three formats iTunes actually serves', () => {
  const looksLikeImage = loadLooksLikeImage()
  assert.strictEqual(looksLikeImage(pad([0xFF, 0xD8, 0xFF, 0xE0])), true, 'JPEG')
  assert.strictEqual(looksLikeImage(pad([0x89, 0x50, 0x4E, 0x47])), true, 'PNG')
  const webp = pad([], 4096)
  Buffer.from('RIFF').copy(webp, 0)
  Buffer.from('WEBP').copy(webp, 8)
  assert.strictEqual(looksLikeImage(webp), true, 'WEBP')
})

test('looksLikeImage rejects what a failed request actually returns', () => {
  const looksLikeImage = loadLooksLikeImage()
  // The three shapes seen in the wild, each of which used to be written to
  // disk as <albumId>.jpg and then believed forever.
  assert.strictEqual(looksLikeImage(Buffer.from('{"errorMessage":"Not Found"}')), false, 'a JSON error body')
  assert.strictEqual(looksLikeImage(pad(Buffer.from('<!DOCTYPE html><html><body>403'))), false, 'an HTML error page')
  assert.strictEqual(looksLikeImage(Buffer.alloc(0)), false, 'an empty body')
  assert.strictEqual(looksLikeImage(null), false, 'nothing at all')
  // A truncated JPEG header with no image behind it is not a cover either.
  assert.strictEqual(looksLikeImage(Buffer.from([0xFF, 0xD8, 0xFF])), false, 'three bytes of JPEG')
})

test('httpsGet rejects a non-2xx instead of resolving the error body', () => {
  const fn = CODE.slice(CODE.indexOf('function httpsGet('), CODE.indexOf('function httpsGet(') + 1600)
  assert.match(fn, /res\.statusCode < 200 \|\| res\.statusCode >= 300/)
  // The redirect branch has to come first, or a 302 rejects instead of following.
  assert.ok(fn.indexOf('308].includes(res.statusCode)') < fn.indexOf('res.statusCode < 200'),
    'redirects are handled before the non-2xx rejection')
  assert.match(fn, /res\.resume\(\)/, 'the discarded body is drained, not left to hold the socket')
})

test('album art has no results[0] fallback', () => {
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('fetch-album-art'"), CODE.indexOf("ipcMain.handle('fetch-album-art'") + 2600)
  assert.doesNotMatch(h, /\|\| data\.results\[0\]/,
    'the first result of a free-text search is routinely a different release')
  // Both remaining candidates still require the album name to match.
  assert.strictEqual([...h.matchAll(/collectionName\?\.toLowerCase\(\)\.includes\(al\)/g)].length, 2)
})

test('a cached cover is verified, and a bad one is repaired not believed', () => {
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('fetch-album-art'"), CODE.indexOf("ipcMain.handle('fetch-album-art'") + 2600)
  assert.match(h, /looksLikeImage\(existing\)/, 'the file on disk is checked, not just its existence')
  assert.match(h, /unlinkSync\(cached\)/, 'and a poisoned entry is removed so it can be refetched')
  assert.match(h, /looksLikeImage\(imgBuf\)/, 'the download is checked before it is written')
})

test('the cover is written through a temp file', () => {
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('fetch-album-art'"), CODE.indexOf("ipcMain.handle('fetch-album-art'") + 2600)
  assert.match(h, /const tmp = cached \+ '\.part'/)
  assert.match(h, /renameSync\(tmp, cached\)/, 'so a partial write is never visible as a cover')
  assert.doesNotMatch(h, /writeFileSync\(cached, imgBuf\)/, 'nothing writes the destination directly')
})

test('a miss is remembered with an expiry, not written as a file', () => {
  const h = CODE.slice(CODE.indexOf("const ART_MISS_TTL_MS"), CODE.indexOf("ipcMain.handle('fetch-album-art'") + 2600)
  assert.match(h, /ART_MISS_TTL_MS/)
  assert.match(h, /_artMisses\.size > 500\) _artMisses\.clear\(\)/, 'the miss map is bounded')
  // Every early return records the miss, or the next visit refetches immediately.
  assert.ok([...h.matchAll(/_artMisses\.set\(albumId, Date\.now\(\)\)/g)].length >= 4)
})

// ── Item 2.6: a store key read on one side and written on the other ────────

test('every store key that is read is also written somewhere', () => {
  // _torrentAdd read a top-level `downloadDir` that nothing wrote, so every
  // torrent went to a hardcoded /mnt/data path regardless of the setting. The
  // symmetry is mechanical, so check it mechanically.
  const reads = new Set([...CODE.matchAll(/store\.get\(\s*'([^']+)'/g)].map(m => m[1]))
  const writes = new Set([...CODE.matchAll(/store\.(?:set|delete)\(\s*'([^']+)'/g)].map(m => m[1]))
  const orphans = [...reads].filter(k => !writes.has(k)).sort()
  assert.deepStrictEqual(orphans, [],
    'a key that is read and never written is a setting that cannot be changed')
})

test('every store key that is written is also read somewhere', () => {
  const reads = new Set([...CODE.matchAll(/store\.get\(\s*'([^']+)'/g)].map(m => m[1]))
  const writes = new Set([...CODE.matchAll(/store\.(?:set|delete)\(\s*'([^']+)'/g)].map(m => m[1]))
  const orphans = [...writes].filter(k => !reads.has(k)).sort()
  assert.deepStrictEqual(orphans, [],
    'a key that is written and never read is a setting that does nothing')
})

test('no download path is a literal from one machine', () => {
  assert.doesNotMatch(CODE, /'\/mnt\//, 'derive it, or ask')
  const fn = CODE.slice(CODE.indexOf('function _torrentAdd('), CODE.indexOf('function _torrentAdd(') + 400)
  assert.match(fn, /_downloadDir\(\)/)
})

test('slskd is configured with the credentials we authenticate with', () => {
  // slskdApiCreds was read and never written, so the only reachable value was
  // slskd's literal default on a listening port.
  assert.match(CODE, /function _slskdApiCreds\(\)/)
  assert.match(CODE, /function _mintSlskdApiCreds\(\)/)
  const tok = CODE.slice(CODE.indexOf('async function slskdAcquireToken'), CODE.indexOf('async function slskdAcquireToken') + 600)
  assert.match(tok, /_slskdApiCreds\(\)/, 'the token request uses the shared accessor')
  const wr = CODE.slice(CODE.indexOf('function writeSlskdConfig('), CODE.indexOf('async function slskdAcquireToken'))
  assert.match(wr, /_mintSlskdApiCreds\(\)/)
  assert.match(wr, /authentication:/, 'and the config we write names them')
  // Minting must not happen on read: an existing config has no auth block, so
  // inventing a password would lock us out of a running daemon.
  const read = CODE.slice(CODE.indexOf('function _slskdApiCreds()'), CODE.indexOf('function _mintSlskdApiCreds()'))
  assert.doesNotMatch(read, /store\.set/)
})

test('reconfiguring Soulseek credentials keeps the download folder', () => {
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('slsk-configure'"), CODE.indexOf("ipcMain.handle('slsk-setup'"))
  assert.match(h, /store\.set\('slskConfig', \{ \.\.\.prev, username, password \}\)/,
    'a wholesale replace used to drop downloadDir')
})

test('every writeSlskdConfig caller derives the download folder', () => {
  // folders[0] means peer-supplied folder names land in the library root.
  const calls = [...CODE.matchAll(/writeSlskdConfig\(\{[^}]*\}\)/g)].map(m => m[0])
  assert.ok(calls.length >= 3, `found ${calls.length} call sites`)
  // The picker is the one exception: it passes the folder the user just chose.
  const picker = CODE.slice(CODE.indexOf("ipcMain.handle('slsk-set-download-dir'"),
                            CODE.indexOf("ipcMain.handle('slsk-show-in-folder'"))
  for (const c of calls) {
    if (picker.includes(c)) continue
    assert.match(c, /downloadDir: _downloadDir\(\)/, c)
  }
})

test('picking a download folder restarts slskd', () => {
  // slskd reads the folder once at startup, so writing the config and stopping
  // there left the new folder inert while the UI reported success.
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('slsk-set-download-dir'"),
                       CODE.indexOf("ipcMain.handle('slsk-show-in-folder'"))
  assert.match(h, /stopSlskd\(\)/)
  assert.match(h, /await startSlskd\(\)/)
  assert.match(h, /restarted:/, 'and it says whether the restart happened')
})

// ── Tier 3: what grows, blocks or drifts over a long session ───────────────

test('the now-playing file is not written synchronously once a second', () => {
  // syncExtension() fires this every second for the whole time anything is
  // playing, and it was writeFileSync -- a blocking main-thread write per
  // second, forever, competing with mpv's IPC.
  const fn = CODE.slice(CODE.indexOf('function writeNowPlaying(data)'),
                        CODE.indexOf('function stopNowPlayingWrites()'))
  assert.doesNotMatch(fn, /writeFileSync/)
  assert.match(fn, /fs\.promises\.writeFile/)
  assert.match(fn, /NOW_PLAYING_COALESCE_MS/, 'and it coalesces')
  assert.match(fn, /fs\.promises\.rename/, 'temp plus rename, so no half-written read')
})

test('pending now-playing writes are stopped before the file is deleted', () => {
  // will-quit unlinks the file. An async write still in flight would land after
  // the unlink and leave a stale now-playing file for the extension to read
  // forever -- a race the async rewrite introduced.
  const q = CODE.slice(CODE.indexOf("app.on('will-quit'"), CODE.indexOf('function createWindow'))
  const stopAt = q.indexOf('stopNowPlayingWrites()')
  const unlinkAt = q.indexOf('unlinkSync(NOW_PLAYING_PATH)')
  assert.ok(stopAt > 0 && unlinkAt > 0, 'both present')
  assert.ok(stopAt < unlinkAt, 'the stop must come first')
  assert.match(q, /NOW_PLAYING_PATH \+ '\.tmp'/, 'and the temp file goes too')
})

test('the extension can send the same command twice', () => {
  // The dedup check used to come BEFORE the clear, so a repeated command
  // returned early with the file still full, and every later poll re-read the
  // same value and ignored it. Pressing next twice advanced one track.
  const fn = CODE.slice(CODE.indexOf('function readCmd()'), CODE.indexOf('let _cmdWatcher'))
  const clearAt = fn.indexOf("writeFile(CMD_PATH, '')")
  assert.ok(clearAt > 0, 'the file is still cleared')
  assert.doesNotMatch(fn, /cmd === _lastCmd/, 'no payload dedup before the clear')
  assert.doesNotMatch(CODE, /let _lastCmd/, 'and the dead variable is gone')
})

test('the yt downloads map is pruned and live entries are pinned', () => {
  assert.match(CODE, /function _pruneYtDownloads\(\)/)
  const fn = CODE.slice(CODE.indexOf('function _pruneYtDownloads()'), CODE.indexOf('function _ytEmit'))
  assert.match(fn, /if \(dl\.state === 'downloading'\) continue/,
    'an in-progress download must not be evicted under its own callbacks')
  assert.match(fn, /YT_DL_FINISHED_TTL_MS/)
  assert.match(fn, /_ytDownloads\.size > YT_DL_CAP/)
  // And the handler that returned the whole map prunes first.
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('yt-get-downloads'"), CODE.indexOf("ipcMain.handle('yt-get-downloads'") + 200)
  assert.match(h, /_pruneYtDownloads\(\)/)
})

test('a failed yt download does not stay pinned as in-progress', () => {
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('yt-download'"), CODE.indexOf("ipcMain.handle('yt-get-downloads'"))
  const catchAt = h.lastIndexOf('.catch(e => {')
  assert.ok(catchAt > 0)
  const tail = h.slice(catchAt)
  assert.match(tail, /dl\.state = 'failed'/, "the entry stayed 'downloading' forever")
  assert.match(tail, /dl\.finishedAt = Date\.now\(\)/)
})

test('the log file is named by the local day, like every other day', () => {
  // The stats group by toDateString(), which is local, so under
  // TZ=Australia/Sydney an incident at 22:30 was written to the NEXT day's
  // file -- and HANDOFF.md tells the next session to read papa-<date>.log.
  assert.match(CODE, /function localDayStamp\(d\)/)
  const fn = CODE.slice(CODE.indexOf('function _logFile()'), CODE.indexOf('function _flushLog'))
  assert.match(fn, /localDayStamp\(\)/)
  assert.doesNotMatch(fn, /toISOString/)
})

test('localDayStamp actually differs from the UTC day where it matters', () => {
  // Run, not read: the point is arithmetic, and a comment cannot be wrong in
  // the way arithmetic can.
  const src = CODE.slice(CODE.indexOf('function localDayStamp(d)'), CODE.indexOf('function _logFile()'))
  // eslint-disable-next-line no-new-func
  const localDayStamp = new Function(src + '; return localDayStamp')()
  const d = new Date('2026-08-27T22:30:00Z')
  const utc = d.toISOString().slice(0, 10)
  const local = localDayStamp(d)
  // In UTC they agree; the assertion that holds everywhere is that the stamp
  // matches what the stats page calls that day.
  const statsDay = new Date(d).toDateString()
  const [y, m, dd] = local.split('-').map(Number)
  assert.strictEqual(new Date(y, m - 1, dd).toDateString(), statsDay,
    `stamp ${local} must name the same day as the stats (${statsDay}); UTC said ${utc}`)
})

test('the YouTube sign-in poll has a deadline', () => {
  // Nothing but the window closing used to stop it, so an abandoned sign-in
  // polled the session store every 1.5s for as long as the app ran.
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('yt-auth-start'"), CODE.indexOf("ipcMain.handle('yt-auth-signout'"))
  assert.match(h, /const AUTH_DEADLINE_MS = /)
  assert.match(h, /Date\.now\(\) - startedAt > AUTH_DEADLINE_MS/)
  assert.match(h, /finish\(\{ ok: false, error: 'Sign-in was not completed/, 'and it says why')
})

// ── Surviving a GPU that will not start ─────────────────────────────────────
// Chromium retries a failed GPU process a few times and then aborts the whole
// process: "GPU process isn't usable. Goodbye." Observed intermittently on this
// machine — twice in about fifteen launches, with no pattern under CPU load,
// concurrent launches or a cold profile. Losing the window because compositing
// could not start is a far worse outcome than compositing slowly.
test('a GPU that will not start does not take the app with it', () => {
  const MAIN = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(MAIN, /disable-gpu-process-crash-limit/)
})

// Chromium's helper processes die out of sight of every JavaScript handler, so
// without these an intermittent crash leaves nothing behind to diagnose.
test('a helper process that dies leaves a record', () => {
  const MAIN = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(MAIN, /app\.on\('child-process-gone'/)
  assert.match(MAIN, /child process gone:/)
  // Renderer crashes already have their own handler with loop detection; a
  // second one registered earlier would shadow it.
  assert.strictEqual((MAIN.match(/app\.on\('render-process-gone'/g) || []).length, 0)
})

// ── Wave 7 · App §6: a crash reporter the user can forward ──────────────────

test('the crash reporter appends a plain-English entry and never throws', () => {
  const fn = CODE.slice(CODE.indexOf('function _appendCrashLog('),
                        CODE.indexOf('process.on(\'unhandledRejection\''))
  assert.match(fn, /crash-log\.txt/, 'it writes the one file the user is told to send')
  assert.match(fn, /appendFileSync/, 'each event is appended, not clobbered')
  // The four things the entry must carry.
  assert.match(fn, /When:/)
  assert.match(fn, /What the app was doing:/)
  assert.match(fn, /_crashTrail/, 'it names the last thing the app did')
  assert.match(fn, /send this file to the developer/)
  // It is wrapped so a failing reporter cannot itself crash the crash handler:
  // the body opens with a try and every path is swallowed by a bare catch.
  assert.match(fn, /^function _appendCrashLog\(kind, err\) \{\s*\n\s*try \{/)
  assert.match(fn, /catch \(_\) \{\s*\}\s*\n\}/, 'the outer catch swallows any failure')
})

test('both process crash handlers write the crash log', () => {
  const rej = CODE.slice(CODE.indexOf("process.on('unhandledRejection'"),
                         CODE.indexOf("process.on('uncaughtException'"))
  assert.match(rej, /_appendCrashLog\(/)
  const exc = CODE.slice(CODE.indexOf("process.on('uncaughtException'"),
                         CODE.indexOf("process.on('uncaughtException'") + 300)
  assert.match(exc, /_appendCrashLog\(/)
})

test('a renderer crash writes the same crash log', () => {
  const h = CODE.slice(CODE.indexOf("webContents.on('render-process-gone'"),
                       CODE.indexOf("webContents.on('render-process-gone'") + 900)
  assert.match(h, /_appendCrashLog\(/, 'the renderer path lands in the same file')
})

test('the last few IPC channels are recorded for the crash trail', () => {
  // A ring buffer, bounded, pushed to on every invoke through the one wrapper.
  assert.match(CODE, /const CRASH_TRAIL_MAX = 5/)
  const fn = CODE.slice(CODE.indexOf('function _noteChannel('),
                        CODE.indexOf('function _noteChannel(') + 200)
  assert.match(fn, /_crashTrail\.push\(channel\)/)
  assert.match(fn, /_crashTrail\.shift\(\)/, 'it stays bounded')
  // The wrapper feeds it on both the deadlined and un-deadlined paths.
  const wrap = CODE.slice(CODE.indexOf('ipcMain.handle = function'),
                          CODE.indexOf('const { MpvEngine }'))
  assert.strictEqual((wrap.match(/_noteChannel\(channel\)/g) || []).length, 2,
    'both the timed and untimed handler paths record the channel')
})

// ── Wave 7 · App §11: offline detection ─────────────────────────────────────

test('connectivity is probed on a slow interval with a short timeout', () => {
  assert.match(CODE, /const CONNECTIVITY_PROBE_TIMEOUT_MS = 5000/)
  assert.match(CODE, /const CONNECTIVITY_PROBE_INTERVAL_MS = 60000/)
  const probe = CODE.slice(CODE.indexOf('function _probeOnce()'),
                           CODE.indexOf('async function _checkConnectivity()'))
  assert.match(probe, /method: 'HEAD'/, 'a HEAD, so no body is pulled')
  assert.match(probe, /timeout: CONNECTIVITY_PROBE_TIMEOUT_MS/)
  assert.match(probe, /req\.on\('timeout'/, 'a slow probe counts as down')
  assert.match(probe, /req\.on\('error'/)
})

test('a single blip never claims OFFLINE — two in a row are required', () => {
  // Asymmetric on purpose, and the asymmetry is the point: a failure proves only
  // that one host did not answer at one moment, so it still takes two; a success
  // proves the network is up, so one is enough to come back. The old symmetric
  // rule meant one blip latched "You're offline" for at least two minutes on a
  // 60 s cadence. Behaviour is covered in test/connectivity-asymmetric.test.js.
  const fn = CODE.slice(CODE.indexOf('async function _checkConnectivity()'),
                        CODE.indexOf('function startConnectivityMonitor()'))
  assert.match(fn, /_lastProbe === false && _onlineState !== false/,
    'going offline must still need the previous probe to agree')
  assert.match(fn, /safeSend\('app-online-state', \{ online: false \}\)/)
  assert.match(fn, /safeSend\('app-online-state', \{ online: true \}\)/)
})

test('the connectivity monitor is started after startup settles', () => {
  assert.match(CODE, /startConnectivityMonitor\(\)/)
  const fn = CODE.slice(CODE.indexOf('function startConnectivityMonitor()'),
                        CODE.indexOf('function startConnectivityMonitor()') + 400)
  assert.match(fn, /setInterval\(/)
  assert.match(fn, /setTimeout\(/, 'the first probe waits out the launch stampede')
})

// ── Wave 7 · App §4: auto-backups ───────────────────────────────────────────

test('the auto-backup reuses the shared bundling routine', () => {
  const fn = CODE.slice(CODE.indexOf('function _runAutoBackup()'),
                        CODE.indexOf('function startAutoBackup()'))
  assert.match(fn, /_buildBackupPayload\(\)/, 'it must not re-implement export')
  assert.match(fn, /backups/, 'it writes under a backups folder')
  assert.match(fn, /papa-backup\.json/)
})

test('auto-backups rotate, keeping the seven newest', () => {
  assert.match(CODE, /const AUTO_BACKUP_KEEP = 7/)
  const fn = CODE.slice(CODE.indexOf('function _runAutoBackup()'),
                        CODE.indexOf('function startAutoBackup()'))
  assert.match(fn, /\.sort\(\)/, 'ISO stamps sort chronologically')
  assert.match(fn, /entries\.length - AUTO_BACKUP_KEEP/)
  assert.match(fn, /rmSync/, 'older backups are deleted')
})

test('the auto-backup never blocks startup and never throws past its log', () => {
  const fn = CODE.slice(CODE.indexOf('function startAutoBackup()'),
                        CODE.indexOf('function startAutoBackup()') + 400)
  assert.match(fn, /setTimeout\(/, 'it runs on a timer after startup')
  assert.match(fn, /catch \(e\)/, 'a failed backup logs, it does not crash')
  assert.match(fn, /auto-backup failed/)
})

// ── Wave 7 · App §96: store schema versioning ───────────────────────────────

test('a future schema version is detected loudly as a downgrade', () => {
  assert.match(CODE, /const STORE_SCHEMA_VERSION = \d+/)
  const fn = CODE.slice(CODE.indexOf('function checkStoreSchemaVersion()'),
                        CODE.indexOf('function _collectBackupStores()'))
  assert.match(fn, /store-schema-version/, 'the marker file is named')
  assert.match(fn, /onDisk > STORE_SCHEMA_VERSION/, 'a newer-on-disk version is the downgrade case')
  assert.match(fn, /console\.error/, 'and it is loud')
  // A missing marker is stamped with the current version, not left absent.
  assert.match(fn, /if \(onDisk == null\)/)
  assert.match(fn, /writeFileSync\(marker, String\(STORE_SCHEMA_VERSION\)/)
})

test('the schema check runs at startup', () => {
  assert.match(CODE, /checkStoreSchemaVersion\(\)/)
})

// Roadmap 084: an unplugged drive is "not connected", never "deleted".
test('the scan keeps albums from an unreachable root and track-exists never calls them gone', () => {
  const fs = require('node:fs'), path = require('node:path')
  const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const scan = M.slice(M.indexOf('async function _performScanOnce('), M.indexOf('async function scanDirAsync(') > 0 ? M.length : M.length)
  assert.match(scan, /try \{ await fs\.promises\.stat\(f\) \} catch \(_\) \{ unreachable\.push\(f\); continue \}/, 'each root is checked before it is scanned')
  assert.match(scan, /albums\.push\(\{ \.\.\.a, unavailable: true, unavailableRoot: root \}\)/, 'cached albums under it are kept, flagged')
  assert.match(scan, /return \{ albums, unavailableRoots: unreachable \}/, 'and the renderer is told')
  const te = M.slice(M.indexOf("ipcMain.handle('track-exists'"), M.indexOf("ipcMain.handle('locate-track-file'"))
  assert.match(te, /reason: 'drive not connected'/, 'ENOENT under an unreachable root is "cannot tell"')
})

// Roadmap 136: secrets are scrubbed at log-write time and on every export path.
test('the logger, the bundle and the settings export all go through src/redact', () => {
  const fs = require('node:fs'), path = require('node:path')
  const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes("const _redact = require('./src/redact')"))
  const q = M.slice(M.indexOf('function _queueLog('), M.indexOf('function _queueLog(') + 900)
  assert.ok(q.includes('msg = _redact.redactText(msg)'), 'log lines are scrubbed before they are buffered')
  assert.ok(M.includes('function _redactSecrets(obj) { return _redact.redactObject(obj) }'))
  assert.ok(M.includes("_redact.redactText(`Last 200 lines of"), 'the log tail in the bundle is scrubbed')
  assert.ok(M.includes("_redact.redactText(fs.readFileSync(crashLog, 'utf8'))"), 'so is the crash log')
  assert.ok(M.includes('_redact.redactText(JSON.stringify(_redact.redactObject(diagnostics)'), 'and the diagnostics snapshot')
  assert.ok(!/const _SECRET_KEY_RE = \/password\|token\|key\/i/.test(M), 'the narrow key rule is gone')
})

// Roadmap 139: an update writes a backup before it touches anything.
test('a version change writes a pre-migration backup before the scheduled tick, and the route is documented', () => {
  const fs = require('node:fs'), path = require('node:path')
  const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(M.includes('function backupBeforeMigration()'))
  assert.match(M, /backupBeforeMigration\(\)\n\s+recoverInterruptedOps\(\)\n\s+startScheduledBackup\(\)/, 'runs at startup, before the delayed backup tick')
  const fn = M.slice(M.indexOf('function backupBeforeMigration()'), M.indexOf('function backupBeforeMigration()') + 1600)
  assert.ok(fn.includes("if (last === current) return"), 'same version: nothing')
  assert.ok(fn.indexOf('fs.writeFileSync(file') < fn.indexOf("store.set('lastRunVersion', current)\n    console.log"), 'the version is recorded only after the backup is written')
  assert.ok(fn.includes('MIGRATION_BACKUP_KEEP'), 'rotated')
  assert.ok(M.includes('migrationFiles,'), 'the backup status lists them')
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'RECOVERY.md')), 'the recovery route is documented')
})

// Roadmap 083/085: the guided relink.
test('the relink finds dead paths only under reachable roots, previews before applying, and carries every store', () => {
  const fs = require('node:fs'), path = require('node:path')
  const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  const dead = M.slice(M.indexOf('async function _libraryDeadPaths()'), M.indexOf("ipcMain.handle('library-dead-paths'"))
  assert.ok(dead.includes('if (!_underAnyRoot(p, live)) continue'), 'an unplugged root is not "moved" (084)')
  const apply = M.slice(M.indexOf("ipcMain.handle('library-relink-apply'"), M.indexOf("ipcMain.handle('library-scan-extras'"))
  assert.ok(apply.includes('libPrune.pruneAll(snapshot, map)'), 'likes/history/playlists/queues follow through the same remap as an in-app move')
  assert.ok(apply.includes('sideStores.libraryCache.set(albums)'), 'the library cache follows so album ids survive')
  assert.ok(apply.includes("roots.push(root); store.set('musicFolders', roots)"), 'the new home becomes a root')
  assert.ok(R.includes('async function _mgRelinkFlow()') && R.includes("_mgConfirm('Relink '"), 'a preview stands between choosing and applying')
  assert.ok(R.includes('had more than one possible match and are left alone'))
  for (const ch of ['library-dead-paths', 'pick-folder', 'library-relink-plan', 'library-relink-apply']) assert.ok(PRE.includes("'" + ch + "'"), ch)
})

// Roadmap 091: an interrupted move leaves the original or a finished result, never a half copy.
test('moves are journaled, a failed copy is cleaned up, and startup finishes or undoes what was interrupted', () => {
  const fs = require('node:fs'), path = require('node:path')
  const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const mv = M.slice(M.indexOf("ipcMain.handle('library-move-path'"), M.indexOf('const TAG_FIELDS ='))
  assert.ok(mv.includes("_opBegin({ kind: 'move', from: path.resolve(from), to: dest, phase: 'rename' })"), 'journaled before it starts')
  assert.ok(mv.indexOf('_opBegin(') < mv.indexOf('fs.renameSync('))
  assert.ok(mv.includes("_opUpdate(opId, { phase: 'copy' })"), 'the copy phase is recorded')
  // The copy is asynchronous now (it used to block the main thread for the
  // whole of a multi-GB move), so the cleanup is too. What matters is
  // unchanged: a failed copy removes its partial result, but only once the
  // original is confirmed still there. Behaviour is pinned in
  // test/library-move-async.test.js.
  assert.ok(mv.includes('if (fs.existsSync(path.resolve(from))) {') &&
    mv.includes('await fs.promises.rm(dest, { recursive: true, force: true })'),
    'a failed copy removes its partial result')
  assert.ok(mv.includes('_opEnd(opId)\n  _scheduleLibraryRescan()'), 'the journal entry goes only when the move is complete')
  const rec = M.slice(M.indexOf('function recoverInterruptedOps()'), M.indexOf("ipcMain.handle('library-move-path'"))
  assert.ok(rec.includes("if (srcThere && dstThere && op.phase === 'copy')") && rec.includes('fs.rmSync(op.to, { recursive: true, force: true })'), 'mid-copy: the partial goes, the original stays')
  assert.ok(rec.includes('const n2 = _remapMovedPrefix(op.from, op.to)'), 'moved-but-unrecorded: the references follow')
  assert.match(M, /backupBeforeMigration\(\)\n\s+recoverInterruptedOps\(\)/, 'runs at startup after the backup')
})
