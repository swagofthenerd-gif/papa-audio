# Papa Audio — 250 stability findings

Generated 2026-08-27. Companion artifact: https://claude.ai/code/artifact/c05899c1-fa21-4b19-8fc3-05b2745a97df

Status legend: **OPEN** = verified defect, not yet fixed. **PROPOSED** = improvement. **CLOSED** = decided against, recorded so it is not re-raised.

`was #n` marks an item carried forward from the earlier 155-item report.

---

## Playback engine  (35)

### 1. mpv's stderr is discarded, so the engine's own diagnosis is unreadable

`OPEN` `Critical`

**Symptom.** mpv-engine.js:86 spawns with stdio:'ignore'. When mpv says 'Audio device lost', 'Failed to open', or a decoder error, that text goes nowhere. This is why yesterday's stop cannot be explained.

**Solution.** Spawn with stderr piped and --msg-level=all=warn; keep the last ~200 lines in a ring buffer and flush it to the daily log on any abnormal end.

### 2. end-file reasons other than eof and error emit nothing at all

`OPEN` `Critical`

**Symptom.** mpv-engine.js:201-206 handles only reason 'eof' and 'error'. mpv also emits 'stop', 'quit', 'redirect' and 'unknown'. Those produce no event: no ended, no loadError, no advance. mpv goes idle, state.isPlaying stays true, the progress bar freezes. A silent stop with no error and no skip.

**Solution.** Map every reason explicitly. Anything that is not a normal handoff must emit a typed stopped event carrying the reason, and the renderer must act on it.

### 3. engineDown is emitted and forwarded but nothing in the renderer handles it

`OPEN` `Critical`

**Symptom.** mpv-engine.js:266 emits it on every mpv death; main.js:901 forwards it; player-shim.js has no case for it and renderer.js:547 only checks mpvMissing and engineFailed. During a respawn the UI still claims it is playing.

**Solution.** Add the shim case, flip state.isPlaying, and show a 'reconnecting' state; per your decision, resume and then say so.

### 4. Every mpv command shares one 2-second timeout

`OPEN` `Critical`

**Symptom.** mpv-ipc.js:5. A 184 MB 24-bit 5.1 FLAC on a cold cache can exceed 2 s for loadfile alone. The rejection becomes {ok:false} in main's wrap(), and the shim's src setter (player-shim.js:65-71) returns nothing, so the renderer cannot observe the failure. Nothing retries.

**Solution.** Per-operation timeouts — generous for loadfile, tight for get_property — plus one retry before surfacing failure.

### 5. this.client is nulled mid-await, throwing inside setNext

`OPEN` `Critical`

**Symptom.** mpv-engine.js:261-266 sets client=null synchronously. setNext (124-128) awaits playlist-clear, then awaits loadfile. If mpv dies between them the second await throws TypeError. Prefetch is silently disabled and the album stops at the end of the current track.

**Solution.** Capture the client in a local at entry and null-check between awaits; treat a vanished client as a typed EngineGone, not a TypeError.

### 6. Gapless prefetch is not restored after a respawn

`OPEN` `Critical`

**Symptom.** _onExit restores path, position, volume and paused but never _nextPath, which load() has just set to null. Nothing re-arms it, so after any respawn the album plays the current track and then stops.

**Solution.** Re-issue setNext from the renderer's queue after a successful respawn.

### 7. engineFailed tells you to install mpv when mpv is installed and fine

`OPEN` `High`

**Symptom.** renderer.js:548 shows one blocker for both mpvMissing and engineFailed. After an audio-device loss the message is actively misleading.

**Solution.** Carry the reason with the event and write the message from it.

### 8. Three mpv deaths in 60 s leaves a dead engine object that still passes the guards

`OPEN` `High`

**Symptom.** mpv-engine.js:270 emits engineFailed but main.js keeps the old player with alive=false and client=null. Every later handler passes `if (!player)` because player is truthy, then dereferences a null client. Only a manual recheck recovers.

**Solution.** Tear the engine down on engineFailed and attempt one supervised re-init before giving up.

### 9. An exclusive-mode device loss burns the whole respawn budget in seconds

`OPEN` `High`

**Symptom.** _onExit rebuilds the same --audio-device and --audio-exclusive args from unchanged config, so if the device is still gone each respawn fails instantly — three in a row, well inside the 60 s window.

**Solution.** Probe device availability before respawning; back off, and fall back to the default device with a notice rather than failing.

### 10. The 150 ms EOF grace races gapless auto-advance

`OPEN` `High`

**Symptom.** mpv-engine.js:12,201-213. On eof a 150 ms timer arms 'ended'; the next file's path change fires 'autoAdvanced' independently. If start-file lands late both reach the renderer: the track is scrobbled twice and playNext() issues a loadfile replace on a file mpv is already playing — audible cut and restart mid-track.

**Solution.** Make the two paths mutually exclusive with a single state machine keyed on the file mpv actually reports, rather than two independent timers.

### 11. dropMissingTrack permanently deletes present files from the queue

`OPEN` `High`

**Symptom.** renderer.js:650-677 splices on a single load error with no existence check. A transient demuxer or cache error on a large FLAC removes a track that is still on disk, and it never comes back.

**Solution.** Confirm the file is genuinely gone over IPC before removing; on a transient error retry once, then skip without mutating the queue.

### 12. autoadvanced bails out and leaves the queue index pointing at the wrong track

`OPEN` `High`

**Symptom.** renderer.js:11900-11901: `if (idx === -1) return`, which is before updateNextPrefetch(). mpv has already switched files, but queueIndex still points elsewhere, so scrobbling, savePlaybackState, now-playing and playNext's arithmetic all act on a track that is not playing — and prefetch is never re-armed.

**Solution.** Resync the index from what mpv reports, and re-arm prefetch on every exit path from that handler.

### 13. playerSetNext is fire-and-forget across three layers

`OPEN` `High`

**Symptom.** player-shim.js:116 does not return or await; the renderer never sees a prefetch failure. The first symptom is the album stopping at a track boundary.

**Solution.** Return the result and surface a failed prefetch as a retry rather than silence.

### 14. state.isPlaying and the shim's _paused are maintained by two independent optimistic updates

`OPEN` `High`

**Symptom.** player-shim.js:73-88 reverts _paused on failure; renderer.js:5857-5865 sets state.isPlaying before the await and only clears it in a later callback. They can disagree, and after an engineDown both stay wrong.

**Solution.** One source of truth, derived from mpv's observed pause property, with the optimistic value as a short-lived overlay.

### 15. player-switch swallows a failed pause and proceeds anyway

`OPEN` `Medium`

**Symptom.** main.js:956-960 wraps player.pause() in an empty catch, then loads with play:true regardless — including against a client that was just nulled.

**Solution.** Treat a failed pause as a failed switch.

### 16. playlist-clear inside setNext can end the current file

`OPEN` `Medium`

**Symptom.** mpv keeps the currently-playing entry across playlist-clear in the normal case, but setNext issues it on every prefetch update, so any edge where the current entry is not marked current ends playback with reason 'stop' — which, per the first finding, emits nothing.

**Solution.** Use playlist-remove on the specific queued index instead of clearing the whole playlist.

### 17. No watchdog on a stalled position

`OPEN` `Medium`

**Symptom.** If time-pos stops advancing while pause is false, nothing notices. That is the exact signature of yesterday's stop.

**Solution.** If position has not moved for several seconds while unpaused, log it, probe mpv, and recover.

### 18. Seek rejections are silently dropped when a new track loads

`OPEN` `Medium`

**Symptom.** _flushPendingSeek({send:false}) rejects every pending settler with 'seek cancelled by new track load'. Callers do not catch it, so it becomes an unhandled rejection.

**Solution.** Resolve rather than reject on a legitimate cancellation, or catch at the call sites.

### 19. Volume and speed commands have no failure path

`OPEN` `Medium`

**Symptom.** setVolume/setSpeed await a command that can reject; nothing catches, so a slider drag during a respawn produces unhandled rejections.

**Solution.** Wrap and ignore-with-log, since these are cosmetic and must never break playback.

### 20. restart() replays load, seek, volume and play with no failure handling

`OPEN` `Medium`

**Symptom.** If any step throws the engine is left half-configured with no event emitted.

**Solution.** Wrap the resume sequence; on failure emit the typed stopped event so the UI can offer Resume.

### 21. observe_property failures during start() are fatal but unreported

`OPEN` `Medium`

**Symptom.** start() awaits five observe calls in a loop; a rejection escapes to whoever called start, which in the respawn path is a bare try/catch that emits engineFailed with no reason.

**Solution.** Report which property failed.

### 22. The IPC socket path embeds the Electron pid and a counter, and old sockets are only reaped opportunistically

`OPEN` `Medium`

**Symptom.** A crash leaves the socket file behind; the reaper handles the common case but the naming makes collision handling fragile.

**Solution.** Use a per-run random suffix and unlink the socket on stop.

### 23. connect() retries for 5 s with no signal about why it is failing

`OPEN` `Medium`

**Symptom.** mpv-ipc.js:24-37 swallows every socket error and retries until the deadline, then rejects with a generic message.

**Solution.** Keep the last underlying error and include it in the rejection.

### 24. A late mpv reply after a command timeout is silently discarded

`OPEN` `Medium`

**Symptom.** _onData drops any reply whose request_id is no longer pending, so a slow loadfile that eventually succeeded looks like a failure to the app while mpv is actually playing.

**Solution.** Log late replies; for loadfile specifically, reconcile against the observed path rather than assuming failure.

### 25. The IPC read buffer is unbounded

`OPEN` `Medium`

**Symptom.** mpv-ipc.js accumulates into this.buffer until a newline. A malformed or very long line grows it without limit.

**Solution.** Cap the buffer and resync at the next newline.

### 26. No structured playback event log

`PROPOSED` `Medium`

**Symptom.** Nothing records track starts, ends, reasons, respawns or timeouts, so every playback complaint is unfalsifiable after the fact.

**Solution.** A flight recorder appending one line per engine event to the existing daily log, asynchronously.

### 27. No resume prompt after an abnormal stop

`PROPOSED` `Medium`

**Symptom.** playbackState holds the exact file and position, but a restart after a silent stop just sits idle.

**Solution.** On launch, if the last session ended mid-track without a clean stop, offer to resume from that position.

### 28. No audio-device change awareness

`PROPOSED` `Medium`

**Symptom.** The app never learns that the default sink changed, so it keeps playing to a device that may no longer exist.

**Solution.** Watch for device-list changes and re-open the output when the active device disappears.

### 29. Crossfade mode exists but shares all of the engine's failure paths

`PROPOSED` `Low`

**Symptom.** mpv-crossfade.js forwards engineDown but inherits every gap above, and it is only 93 lines against a much larger engine.

**Solution.** Route crossfade through the same state machine rather than a parallel path.

### 30. gapless-audio=yes resamples to hold the output open, which is not lossless for mixed-rate albums

`PROPOSED` `Low`

**Symptom.** A deliberate tradeoff, documented in the code, but never surfaced to you.

**Solution.** Note it in Settings so the choice is visible.

### 31. replaygain is applied without indicating it

`PROPOSED` `Low`

**Symptom.** playerSettings has replaygain 'track'; nothing in the UI says gain is being applied.

**Solution.** Show the applied gain in the now-playing format line.

### 32. The EQ is on while the project brief calls for purist playback

`PROPOSED` `Low`

**Symptom.** playerSettings.eq.enabled is true with a preamp of -6 dB and eight non-zero bands, injected as an --af lavfi graph, while CLAUDE.md states purist mode with no EQ.

**Solution.** Not changing it — it is your setting. Surfacing it, so the contradiction is visible rather than silent.

### 33. No indication of the actual output channel layout

`PROPOSED` `Low`

**Symptom.** With audio-channels 5.1 forced, a stereo file is upmixed or padded and nothing says so.

**Solution.** Show source layout and output layout side by side.

### 34. Volume is stored as 0-100 in mpv and 0-1 in the shim with rounding at the boundary

`PROPOSED` `Low`

**Symptom.** Round-tripping loses precision and can drift.

**Solution.** Keep one unit end to end.

### 35. No hardware sample-rate switching indicator

`PROPOSED` `Low`

**Symptom.** Moving between 44.1 and 48 kHz albums is invisible.

**Solution.** Show it; it is the kind of detail this app's audience wants.

---

## Recovery & supervision  (11)

### 216. There is no supervised restart of the whole audio subsystem

`PROPOSED` `High`

**Symptom.** Every recovery path is local to one failure. Nothing can decide 'the audio subsystem is unhealthy, rebuild it cleanly'.

**Solution.** One supervisor owning engine lifecycle, respawn budget, device validation and resume — which is what makes your chosen 'resume and tell me' behaviour reliable rather than best-effort.

### 217. Respawn budget is fixed at three per sixty seconds regardless of cause

`PROPOSED` `Medium`

**Symptom.** A device that returns after ten seconds is treated the same as a binary that cannot start.

**Solution.** Budget by cause, with backoff rather than a hard cap.

### 218. No degraded playback mode

`PROPOSED` `Medium`

**Symptom.** If 5.1 output cannot be opened the app fails rather than falling back to stereo.

**Solution.** Fall back and say so, since hearing the album matters more than the layout.

### 219. No queue persistence across an abnormal exit beyond 100 tracks

`PROPOSED` `Medium`

**Symptom.** The _auto queue is the only survivor and it is truncated.

**Solution.** Persist the full queue and the index atomically on change.

### 220. No self-test for the playback path

`PROPOSED` `Medium`

**Symptom.** Nothing verifies that audio can actually be produced.

**Solution.** A short silent test file played on demand from Manage, reporting the whole chain.

### 221. No rate limit on error notices

`PROPOSED` `Low`

**Symptom.** A repeating failure could produce a snackbar per tick.

**Solution.** Coalesce identical notices.

### 222. No circuit breaker on repeatedly failing files

`PROPOSED` `Low`

**Symptom.** A file that always fails is retried each time it is reached.

**Solution.** Remember recent failures for the session.

### 223. No guard against a queue of length zero after a repair

`PROPOSED` `Low`

**Symptom.** repairQueue handles it, but only one of the two removal paths goes through it.

**Solution.** Route both through the same repair.

### 224. No verification that the resumed position actually took effect

`PROPOSED` `Low`

**Symptom.** seek is deferred until seekable and can be cancelled silently.

**Solution.** Confirm against the observed position after resume.

### 225. No handling for a library file that becomes unreadable mid-playback

`PROPOSED` `Low`

**Symptom.** A permissions change or an unmount during playback surfaces as a generic error.

**Solution.** Distinguish gone, unreadable and undecodable, and act differently on each.

### 249. No graceful degradation when mpv is missing

`PROPOSED` `Low` `was #90`

**Symptom.** mpv is a hard requirement; its absence is not explained at the point of failure.

**Solution.** Detect at startup and show install instructions rather than failing per-track.

---

## Main process  (35)

### 36. library-storage-report walks the whole music tree synchronously on the main thread

`OPEN` `Critical`

**Symptom.** main.js:1806-1823 dirSize() is recursive readdirSync/statSync with no yielding, called from an async handler at 1906-1914 for every music root, the artwork dir and every trash root. On /mnt/data/MUSIC that freezes the process that also pumps mpv's IPC and every other handler.

**Solution.** Rewrite with fs.promises and a concurrency limit, or move it to a worker thread. Cache the result with a short TTL.

### 37. The same synchronous walk runs from three more handlers

`OPEN` `Critical`

**Symptom.** main.js:1957, 1998, 2064 each call dirSize() on demand, including as a pre-check before a move.

**Solution.** One shared async implementation for all four call sites.

### 38. A failed slskd spawn permanently disables restart for the session

`OPEN` `Critical`

**Symptom.** main.js:419 spawns with no 'error' listener. On ENOENT the 'error' event fires instead of 'exit', slskdProc is never nulled, and the `if (slskdProc) return` guard at 413 blocks every future restart. The 60 s health monitor then retries forever against a guard that can never open.

**Solution.** Attach an error handler that nulls slskdProc and reports the reason.

### 39. batch-transcode never transcodes anything and reports success

`OPEN` `Critical`

**Symptom.** main.js:4274-4279 calls ipcMain.emit('transcode-file', ...), which fires a plain EventEmitter event. ipcMain.handle registers on Electron's private invoke channel, so nothing listens. emit returns a boolean, so results is [false, false, ...]. ffmpeg never runs.

**Solution.** Extract the transcode body into a plain function and call it directly from both the handler and the batch loop.

### 40. The whole 2.4 MB store is rewritten synchronously every 4 seconds during any download

`OPEN` `Critical`

**Symptom.** dlPersist() (main.js:3276) is called from dlTick on a 4000 ms interval (main.js:3495). electron-store serialises and fsyncs the entire config, not the one key. The identical bug was fixed for window drag last round and not applied here.

**Solution.** Debounce dlPersist the same way saveWinState was, and split the store so the scheduler state is its own small file.

### 41. save-library-cache rewrites 1.37 MB synchronously on every library update

`OPEN` `High`

**Symptom.** main.js:1268. Triggered by scans, watcher events and mutations.

**Solution.** Own file, written asynchronously, with the write coalesced.

### 42. save-playback-state rewrites the full store on every position save

`OPEN` `High`

**Symptom.** main.js:1272, called repeatedly during playback. Multi-megabyte writes on the thread that drives mpv is the worst possible place for them.

**Solution.** Own tiny file; this one is written most often and is the smallest payload.

### 43. save-recently-played and save-session-state do the same

`OPEN` `High`

**Symptom.** main.js:2423 and 1275. Capped lists, uncapped write cost.

**Solution.** Same split.

### 44. pollCmd does a synchronous read and write every 200 ms for the life of the process

`OPEN` `High`

**Symptom.** main.js:471-478, wired at 549, never cleared. Five main-thread filesystem operations per second, forever, competing with playback.

**Solution.** Replace with fs.watch on the command file.

### 45. Every console line is a blocking appendFileSync

`OPEN` `High`

**Symptom.** main.js:534-546 reassigns console.log and console.error globally to a synchronous append. A burst — a failing loop, repeated 429s, a bad scan — becomes a burst of blocking disk I/O on the main thread.

**Solution.** Buffer and flush on a timer, or use a write stream.

### 46. slskd 429 is treated as a health failure, so throttling restarts the daemon

`OPEN` `High`

**Symptom.** main.js:346 throws a generic error for any non-2xx. The health check at 579-591 restarts slskd after three consecutive failures, so sustained 429s restart the daemon roughly every three minutes — and each restart hits the missing spawn error handler above. Your log has real 429s on 2026-08-26.

**Solution.** Treat 429 as a distinct outcome: read Retry-After, back off exponentially, and never count it toward the restart threshold.

### 47. No timeout or AbortController on slskd fetches

`OPEN` `High`

**Symptom.** main.js:334-350. A hung daemon leaves requests outstanding indefinitely, and the 4 s scheduler tick keeps adding more.

**Solution.** AbortController with a per-endpoint deadline.

### 48. execSync shells out for unzip and chmod with JSON.stringify quoting and no timeout

`OPEN` `High`

**Symptom.** main.js:449-451. JSON.stringify escapes for JavaScript, not for sh — $( ), backticks, ; and | pass through. And execSync cannot be interrupted, so an unzip that prompts blocks the main thread forever.

**Solution.** execFileSync with an argv array and an explicit timeout. The file already uses execFileSync correctly at 876, 1448 and 2162.

### 49. ffprobe is invoked synchronously per file inside scan loops

`OPEN` `High`

**Symptom.** main.js:1448-1460 and 2162-2180 use execFileSync, blocking the main thread once per file across a whole scan.

**Solution.** Async spawn with a bounded worker pool.

### 50. The chokidar watcher opens a descriptor per directory 30 levels deep

`OPEN` `Medium`

**Symptom.** main.js:2298-2317 filters by extension only after chokidar has already watched everything. On a large library this can exhaust the inotify limit, and ignorePermissionErrors:true masks the failure — parts of the library silently stop being watched.

**Solution.** Pass an ignored predicate so non-audio directories are never watched, and report descriptor exhaustion instead of hiding it.

### 51. The watcher debounce can be postponed indefinitely

`OPEN` `Medium`

**Symptom.** main.js:2308-2319 clears and resets a 4 s timer on every event, so a large batch copy keeps deferring the scan while burning CPU on debounce churn.

**Solution.** A maximum-wait so the scan runs even under a continuous event stream.

### 52. dlState.done grows for the life of the process

`OPEN` `Medium`

**Symptom.** main.js:3256, written at 3677, restored at 3318. Only the persisted abandoned subset is capped at 5000; the in-memory map has no cap or TTL.

**Solution.** Prune terminal entries on the same tick that already prunes the persisted set.

### 53. The close handler runs executeJavaScript on a webContents that may be gone

`OPEN` `Medium`

**Symptom.** main.js:812-835 awaits state.isPlaying from the renderer. If the renderer reloads or dies in that window the call rejects into a catch that silently closes the app — skipping the 'Music is playing' confirmation during active playback.

**Solution.** Track playing state in main, where it already arrives via player events, instead of asking the renderer at close time.

### 54. The console log patch is installed after early startup logging

`OPEN` `Medium`

**Symptom.** main.js:534-546 runs inside whenReady, after module-load errors and after the unhandledRejection and uncaughtException handlers at 111-115 — which themselves log. Under --hidden that stdout goes nowhere, so exactly the failures that explain 'it never opened' leave no trace.

**Solution.** Install the file logger first, before anything else can log.

### 55. Log files are pruned by age but have no size cap

`OPEN` `Medium`

**Symptom.** main.js:481-491 deletes after 30 days. A runaway error loop can grow one day's file without limit.

**Solution.** Rotate at a size threshold as well.

### 56. startSlskd failures at startup are discarded entirely

`OPEN` `Medium`

**Symptom.** main.js:606: startSlskd().catch(() => {}). The renderer only learns the daemon is dead when a search eventually fails.

**Solution.** Report the failure to the renderer so the daemon banner appears immediately.

### 57. The health check swallows restart failures

`OPEN` `Medium`

**Symptom.** main.js:591: try { await startSlskd(); ... } catch {}. The UI can sit in 'restarting' forever with no definitive signal.

**Solution.** Emit a terminal failed state after N attempts.

### 58. 74 empty catch blocks in main.js

`OPEN` `Medium`

**Symptom.** Several sit around non-trivial logic — JSON parsing of remote payloads at 2717 and 2882, scheduler config patches, search cleanup at 3394/3551/3645/3648 — with no logging at all, which is what makes 'why did X stop working' unanswerable.

**Solution.** Every catch logs at least once with context. Genuinely best-effort cleanup can stay silent but must say so in a comment.

### 59. webContents.send is guarded inconsistently

`OPEN` `Medium`

**Symptom.** main.js:4158 wraps it in try/catch; 588, 609 and 4187 do not. Any of the unguarded ones can throw during the close race and reach only the blanket uncaughtException handler.

**Solution.** One safe send helper used everywhere.

### 60. Nothing offloads heavy scanning from the process that pumps the UI and mpv

`OPEN` `Medium`

**Symptom.** dirSize, scanDirAsync and library-scan-extras all share the main event loop.

**Solution.** Move the scan pipeline into a worker thread; it is self-contained and returns plain data.

### 61. No backpressure between the download scheduler and playback

`PROPOSED` `Medium`

**Symptom.** The 4 s tick does network I/O, JSON work and a store write regardless of whether audio is playing.

**Solution.** Lengthen the tick and defer persistence while a track is playing.

### 62. No single-flight guard around library scans

`PROPOSED` `Medium`

**Symptom.** Concurrent triggers can start overlapping scans of the same tree.

**Solution.** One in-flight scan; later requests join the existing promise.

### 63. IPC handlers have no uniform error envelope

`PROPOSED` `Medium`

**Symptom.** Some throw to reject the renderer's invoke, others return {ok:false}, others swallow. The renderer cannot tell failure from silence.

**Solution.** One wrapper for all 127 handlers returning a consistent shape, with the error logged once.

### 64. No startup phase timing

`PROPOSED` `Low`

**Symptom.** There is no way to attribute a slow launch to the store read, the scan or the renderer.

**Solution.** Timestamp the phases and log them.

### 65. No health endpoint for the app itself

`PROPOSED` `Low`

**Symptom.** Diagnosing requires reading files by hand, as this investigation did.

**Solution.** A Manage panel showing engine state, daemon state, scan state and the last ten engine events.

### 66. The single-instance lock is not verified against the orphan reaper

`PROPOSED` `Low`

**Symptom.** Two paths both reason about a previous instance's pid.

**Solution.** One authority for 'is a previous instance alive'.

### 67. No cap on concurrent ffmpeg or yt-dlp children

`PROPOSED` `Low`

**Symptom.** Nothing bounds how many spawn at once.

**Solution.** A shared child-process pool.

### 68. Trash roots are walked on every storage report

`PROPOSED` `Low`

**Symptom.** Even when trash is empty and unchanged.

**Solution.** Cache by mtime.

### 69. Artwork directory grows without a budget

`PROPOSED` `Low`

**Symptom.** cleanupOldFiles handles age, not total size.

**Solution.** A size ceiling with least-recently-used eviction.

### 70. No verification that the mpv binary is the version the flags assume

`PROPOSED` `Low`

**Symptom.** prefetch-playlist and gapless-audio=yes behaviour vary by version.

**Solution.** Read mpv --version at startup and log it with the flight recorder.

---

## Data integrity  (12)

### 91. 463 plays — 38% of your listening history — are silently discarded by every reader

`OPEN` `Critical`

**Symptom.** playHistory entries changed key from timestamp to ts on 2026-08-04 with no migration. Indices 0-625 use ts; 626-1223 use timestamp, running back to 2026-06-25. Every entry has a valid time; the readers only look at ts. This also corrects my previous report, which called this corruption and proposed deleting the tail — that would have destroyed two months of real history.

**Solution.** Read ts ?? timestamp everywhere, then migrate once to a single key.

### 92. Gapless auto-advanced tracks are never written to play history at all

`OPEN` `Critical`

**Symptom.** addPlayHistory has one call site, renderer.js:5836, inside onStarted(), which runs only for an explicitly started track. The autoadvanced handler at 11881 increments play counts but never adds history. A 12-track album listened gaplessly records one entry.

**Solution.** Record history on auto-advance too, using the same 30 s threshold, so counts and history agree by construction.

### 93. playCounts and playHistory disagree by design and nothing reconciles them

`OPEN` `High`

**Symptom.** Counts are incremented on auto-advance; history is not. Every statistic drawn from history under-reports album listening specifically — the exact listening style this app is built for.

**Solution.** After the two fixes above, run a one-time reconciliation and report the delta rather than silently rewriting.

### 94. add-play-history trusts the renderer for the timestamp

`OPEN` `High`

**Symptom.** main.js:1291 stores whatever it is given. A clock change or a renderer bug writes an unusable entry with no validation.

**Solution.** Stamp it in main and ignore any supplied value.

### 95. History entries are denormalised at roughly 294 bytes each

`OPEN` `Medium`

**Symptom.** filePath, title, artist, album, artPath, duration and ts per play — 344 KB of the 2.4 MB config, rewritten in full on every save.

**Solution.** Store filePath and ts; resolve the rest from the library cache at read time.

### 96. The history cap silently drops the oldest entries with no archive

`OPEN` `Medium`

**Symptom.** main.js:1228 splices at 2000. Once the migration recovers the older entries this cap will start discarding real history.

**Solution.** Roll the overflow into a monthly archive file instead of dropping it.

### 97. The saved _auto queue is truncated to 100 tracks with no indication

`OPEN` `Medium`

**Symptom.** renderer.js:5813. Restoring a long queue silently gives you a different one.

**Solution.** Say so, or persist the whole queue to its own file.

### 98. playbackState is written with position 0 on start and then updated in place

`OPEN` `Medium`

**Symptom.** There is no marker distinguishing a clean stop from an abnormal one, which is why a crash and a deliberate pause look identical on restart.

**Solution.** Record a clean-exit flag; its absence is what triggers the resume prompt.

### 99. No schema version on the config

`PROPOSED` `Medium`

**Symptom.** The ts rename happened with nothing recording that a shape changed. The next rename will do the same.

**Solution.** A version integer and a migration table run at startup.

### 100. No backup before a migration

`PROPOSED` `Medium`

**Symptom.** Any future migration rewrites the only copy.

**Solution.** Copy the config aside before migrating; keep the last three.

### 101. No integrity check on the library cache

`PROPOSED` `Low`

**Symptom.** A truncated write leaves a partial library with no signal.

**Solution.** Store a track count alongside and warn on a large unexplained drop.

### 102. Statistics do not say what window or what data they are computed over

`PROPOSED` `Low`

**Symptom.** After the migration the numbers will change substantially and nothing will explain why.

**Solution.** Each stat card names its window and its source count.

---

## Renderer  (20)

### 71. A corrupted localStorage key can silently unbind most of the keyboard

`OPEN` `Critical`

**Symptom.** renderer.js:10703 parses pa_search_history inside initSearchHistory(), called synchronously from setupListeners() at 11228. An unguarded JSON.parse throw aborts the rest of setupListeners, so everything wired after it — queue panel, sleep timer, sidebar resize, drag and drop, keyboard shortcuts — is never bound, for the whole session, with no error shown.

**Solution.** try/catch with a validated fallback, and reorder so no single parse can abort the listener wiring.

### 72. Liking a track throws on corrupt like history

`OPEN` `High`

**Symptom.** renderer.js:2183 and 4438 both JSON.parse papa_like_history unguarded. A bad value aborts the click handler, or the whole Liked Songs page.

**Solution.** One validated reader for every localStorage key, as was done for _libPresets.

### 73. The add-to-playlist modal leaks a document keydown listener on every open

`OPEN` `High`

**Symptom.** renderer.js:5062-5063 removes onEsc only on the Escape path. Closing via the overlay, the X, or picking a playlist leaves it attached forever, each closure holding the modal DOM and the track array. Five call sites.

**Solution.** Remove the listener in close(), not in the handler.

### 74. _mgConfirm can orphan a keydown listener

`OPEN` `High`

**Symptom.** renderer.js:13330-13348 removes a previous dialog's DOM directly instead of calling its close(), so the first instance's handler is never unregistered. Nine call sites in Manage.

**Solution.** Keep one dialog instance and close it properly before opening another.

### 75. _scheduleLibRescan queues three uncancellable timers from 19 call sites

`OPEN` `High`

**Symptom.** renderer.js:8584-8588. None of the handles are stored. A burst of downloads or edits queues dozens of overlapping full-library syncs that cannot be throttled or cancelled.

**Solution.** One coalescing scheduler with a single handle per delay; later calls reschedule rather than stack.

### 76. renderManageStorage and renderManageTrash are missing the stale-render guard their sibling documents

`OPEN` `High`

**Symptom.** renderer.js:13052-13058 and 13083-13091 call setContent unconditionally after a slow await. renderManageHealth at 13985-13995 has the exact guard, with a comment explaining that this bug was already fixed once.

**Solution.** Apply the same tab-and-page guard to both.

### 77. The YouTube album, playlist and artist renders guard on page kind but not on identity

`OPEN` `High`

**Symptom.** renderer.js:3220-3230, 3352-3358, 3492-3498 check state.currentPage only. Open album A then album B before A resolves and A's late response repaints over B, leaving handlers wired to the wrong browseId.

**Solution.** Compare the id being loaded against the id now displayed, the same generation-ticket pattern used for Soulseek search.

### 78. ytSearchState.cache never evicts

`OPEN` `Medium`

**Symptom.** renderer.js:2653, 2761-2762, 2803. Every unique scope::query holds a full result payload for the life of the process, with no TTL and no cap.

**Solution.** Bounded LRU.

### 79. A poll-driven querySelector uses an unescaped download id

`OPEN` `Medium`

**Symptom.** renderer.js:9024 interpolates f.id, which comes from slskd, into a selector on every 6 s tick. A quote in an id throws every tick until the download clears. Line 11988 already uses CSS.escape correctly.

**Solution.** CSS.escape here too.

### 80. off('slsk-progress') tears down whichever listener happens to be live

`OPEN` `Medium`

**Symptom.** renderer.js:10030-10036 and 8531-8536 both register and channel-wide-remove the same event. Clicking Set up Soulseek during a streaming search silently stops the search from updating.

**Solution.** Remove the specific callback, not the channel.

### 81. Poll-driven render functions are not wrapped, so one throw breaks every later tick

`OPEN` `Medium`

**Symptom.** The _dlWaitLabel comment at renderer.js:8624-8633 records a previous instance of exactly this: a function referenced but undefined, throwing on every render of the Downloading tab.

**Solution.** Wrap the poll render step so a bad frame is logged and skipped rather than killing the loop.

### 82. 63 renderer timers, most without stored handles

`OPEN` `Medium`

**Symptom.** 54 setTimeout and 9 setInterval. Several restart without clearing the previous handle.

**Solution.** Audit each; store handles for anything that can be superseded, and clear on navigation.

### 83. 23 document and window listeners registered from functions that can run more than once

`OPEN` `Medium`

**Symptom.** Any of these reachable from bindContentEvents accumulates on every setContent.

**Solution.** Register global listeners exactly once at startup; per-render listeners go on the rendered subtree.

### 84. 31 empty catch blocks in the renderer

`OPEN` `Medium`

**Symptom.** Same class as main: features degrade with no trace.

**Solution.** Log with context.

### 85. 24 .then() chains, several with no rejection handler

`OPEN` `Medium`

**Symptom.** An unhandled rejection in the renderer aborts the rest of that callback silently.

**Solution.** Catch at every chain, or convert to async/await under the existing boundaries.

### 86. setContent replaces innerHTML wholesale on every navigation

`PROPOSED` `Medium`

**Symptom.** Every listener bound to the replaced subtree dies with it, which is why binding discipline matters so much here.

**Solution.** Keep the wholesale replace, but make bindContentEvents idempotent and provably scoped to the new subtree.

### 87. No renderer memory ceiling or diagnostics

`PROPOSED` `Medium`

**Symptom.** Nothing reports detached nodes, listener counts or cache sizes.

**Solution.** A hidden diagnostics panel reporting them, so a leak is visible before it is painful.

### 88. Library renders build the full album grid every time

`PROPOSED` `Medium`

**Symptom.** 231 cards rebuilt on each filter change.

**Solution.** Reuse nodes for unchanged cards.

### 89. _colorCache and _bioCache never invalidate

`PROPOSED` `Low`

**Symptom.** Small, but the same never-evicted pattern as the YouTube cache.

**Solution.** Bound them.

### 90. No global keyboard shortcut map

`PROPOSED` `Low`

**Symptom.** Shortcuts are wired ad hoc, which is why one throw can silently remove them.

**Solution.** One declarative table bound once.

---

## Downloads & transfers  (30)

### 133. The download poll competes with playback for the main thread

`OPEN` `High`

**Symptom.** A 1 MB fetch, a structured clone in both directions, a flatten and a hash every 6 s, plus a store write every 4 s from the scheduler — all on the thread that pumps mpv's IPC.

**Solution.** Gate polling on an active transfer, shrink the payload, and never write the store on a tick while audio is playing.

### 134. The scheduler tick has no overlap guard beyond a boolean

`OPEN` `Medium`

**Symptom.** dlTicking prevents re-entry but a tick that hangs on a slow fetch blocks every subsequent tick indefinitely with no timeout.

**Solution.** Deadline the tick and log an overrun.

### 135. Transfer state transitions are not logged

`OPEN` `Medium`

**Symptom.** When a download stalls there is no record of what slskd reported.

**Solution.** Log state transitions at info, into the same daily log.

### 136. A failed retry leaves the transfer cancelled

`OPEN` `Medium`

**Symptom.** Retry cancels then re-downloads with no rollback, so a failure destroys the thing it was meant to recover.

**Solution.** Queue the replacement first; cancel only once it is accepted.

### 137. Transfer ids are round-tripped through a comma-joined string

`OPEN` `Medium`

**Symptom.** renderer.js:8929 joins, 9013 splits. slskd ids are file paths, which contain commas.

**Solution.** Pass arrays across IPC.

### 138. dlAbandonByFilename matches basenames across unrelated albums

`OPEN` `Medium`

**Symptom.** The twin-cancel behaviour is deliberate and commented, but the match is not scoped, so a generic track name abandons transfers from other releases.

**Solution.** Scope to the same remote folder.

### 139. _downloadDir falls back to the music library root

`OPEN` `Medium`

**Symptom.** Latent here because the setting is populated, but a fresh install would write peer-supplied paths into the library root.

**Solution.** Fail loudly with a setup prompt.

### 140. No disk-space check before queueing

`PROPOSED` `Medium`

**Symptom.** A 4 GB 24-bit release can fill the volume silently.

**Solution.** statfs the download directory and warn.

### 141. No automatic failover to the next-best peer

`PROPOSED` `Medium`

**Symptom.** When a peer drops, the download fails and the search must be repeated.

**Solution.** Keep the ranked alternates from the originating search and offer the next one.

### 142. No ETA, aggregate throughput, or queue position

`PROPOSED` `Low`

**Symptom.** A stalled queue is indistinguishable from a broken download.

**Solution.** All three; slskd already reports queue position.

### 143. Failures are interleaved with successes in one list

`PROPOSED` `Low`

**Symptom.** With 1,490 records the list is unnavigable.

**Solution.** A collapsed Failed section with retry-all, plus a filter.

### 144. Download history dies with slskd's record set

`PROPOSED` `Low`

**Symptom.** Everything the tab knows is the daemon's state.

**Solution.** Record completions locally.

### 145. No per-transfer cancel confirmation for large in-flight files

`PROPOSED` `Low`

**Symptom.** A misclick discards a nearly complete transfer.

**Solution.** Confirm above a size threshold and past halfway.

### 146. Completed transfers do not link to the album they became

`PROPOSED` `Low`

**Symptom.** The path is known but not actionable.

**Solution.** Resolve to an albumId after the rescan lands.

### 147. The poll interval is fixed regardless of activity

`PROPOSED` `Low`

**Symptom.** Same cost idle as under load.

**Solution.** Fast while active, slow while idle, stopped when the tab is closed.

### 232. Succeeded transfers are never purged, so the poll payload grows forever

`OPEN` `Critical` `was #39`

**Symptom.** Measured: 1,490 records across 108 users, 1,451 of them Completed/Succeeded. GET /transfers/downloads returns 1,020,307 bytes. startDownloadsPolling fetches it every 6 s and structured-clones it across the IPC bridge in both directions, then flattens and hashes 1,490 files — even with nothing downloading. purgeStaleSearches clears searches; the scheduler purges failed and cancelled; nothing purges succeeded.

**Solution.** Purge succeeded transfers older than N days on the same scheduler tick that already purges failures, and gate polling on there being an active transfer.

### 233. stopDownloadsPolling is never called

`OPEN` `High` `was #40`

**Symptom.** The 6-second poll starts and runs for the life of the process regardless of which page is open.

**Solution.** Stop on navigate-away, restart on navigate-in; keep it running only while a transfer is active.

### 234. Retry cancels then re-downloads with no rollback

`OPEN` `High` `was #43`

**Symptom.** If the re-download call fails, the transfer is already cancelled — the retry destroys the thing it was meant to recover.

**Solution.** Queue the new transfer first, cancel the old one only once the new one is accepted.

### 235. _dlSig can miss a state transition

`OPEN` `Medium` `was #46`

**Symptom.** The signature is deliberately id-set-based so progress updates patch in place, but a transition that changes neither the id set nor the count is invisible.

**Solution.** Include a coarse state hash — count per state — in the signature.

### 236. Group headers are not keyboard-focusable

`OPEN` `Medium` `was #47`

**Symptom.** Expanding a download group requires a mouse.

**Solution.** Same a11y sweep extension as the other card classes.

### 237. No ETA

`PROPOSED` `Medium` `was #49`

**Symptom.** Progress percentage only.

**Solution.** Derive from a rolling average of the last several samples, not instantaneous speed.

### 238. Queued-behind-N-others is not surfaced per transfer

`PROPOSED` `Medium` `was #50`

**Symptom.** slskd reports queue position; the UI does not show it, so a stalled queue looks like a broken download.

**Solution.** Show 'position N in queue' where the field is present.

### 239. No automatic retry from an alternative peer

`PROPOSED` `Medium` `was #51`

**Symptom.** When a peer drops, the download simply fails and the user must search again.

**Solution.** Keep the ranked alternates from the originating search; on failure, offer or auto-try the next peer for the same folder.

### 240. Failed transfers are not grouped separately

`PROPOSED` `Low` `was #54`

**Symptom.** Failures interleave with successes in one long list.

**Solution.** A collapsed 'Failed (N)' section with a retry-all.

### 241. No filter or search within the transfer list

`PROPOSED` `Low` `was #55`

**Symptom.** With 1,490 records the list is unnavigable.

**Solution.** Reuse the playlist filter pattern already built.

### 242. The 15/45/120 s rescan schedule is not coalesced

`PROPOSED` `Medium` `was #57`

**Symptom.** _scheduleLibRescan has 19 call sites and queues three untracked, uncancellable timers each. Ten downloads finishing together schedule 30 full library scans. The policy is intended; the implementation is not.

**Solution.** One module-level handle per delay; reschedule rather than stack.

### 243. No notification when a download completes while on another tab

`PROPOSED` `Low` `was #58`

**Symptom.** Completion is only visible on Downloads.

**Solution.** Use the notification path the player already has.

### 244. Peer username is not clickable

`PROPOSED` `Low` `was #60`

**Symptom.** No way to see what else a good peer has.

**Solution.** Click a username to browse that peer's share.

### 245. Completed rows do not show final average speed

`PROPOSED` `Low` `was #61`

**Symptom.** Useful for judging which peers to prefer.

**Solution.** Compute from size and elapsed at completion.

### 246. No 'open containing folder' on a completed transfer

`PROPOSED` `Low` `was #62`

**Symptom.** The path is known but not actionable.

**Solution.** Reuse the existing shell.showItemInFolder path, behind libPathAllowed().

---

## Soulseek search  (23)

### 148. 429 has no backoff on the renderer side either

`OPEN` `High`

**Symptom.** A throttled search returns nothing and the UI reports an empty result.

**Solution.** Surface throttling explicitly and retry with backoff.

### 149. Retired searches are never cancelled at the daemon

`OPEN` `Medium`

**Symptom.** Each search runs six variants for 90 s. Starting a new search leaves the old ones running.

**Solution.** Track the slskd search ids per generation and delete them when the generation is retired.

### 150. Results are capped at 60 with no way to see the rest

`OPEN` `Medium`

**Symptom.** With responseLimit 3000 across six variants the discarded tail routinely contains better sources.

**Solution.** An explicit Show more that extends the slice.

### 151. No per-variant progress

`PROPOSED` `Medium`

**Symptom.** One spinner for six independent 90 s searches.

**Solution.** Show variants completed with a determinate bar.

### 152. Result cards are mouse-only

`PROPOSED` `Medium`

**Symptom.** No tabindex, no Enter or Space, on the most important surface in the app.

**Solution.** Extend the existing a11y sweep to the card class.

### 153. The result count is not announced

`PROPOSED` `Medium`

**Symptom.** Results stream in with no live region.

**Solution.** One polite aria-live region.

### 154. Surround detection trusts the filename

`PROPOSED` `Medium`

**Symptom.** A correctly tagged 5.1 FLAC with a plain name ranks as stereo — the exact case this app exists for. The Camel album in this investigation is a real 5.1 release whose ranking depends on its folder name.

**Solution.** Read the real channel count after download and correct the badge; feed confirmed results back into ranking.

### 155. Bit depth and sample rate are not surfaced

`PROPOSED` `Low`

**Symptom.** A 24/96 folder looks identical to 16/44.

**Solution.** Show them where the peer supplied them.

### 156. Folder size is not shown

`PROPOSED` `Low`

**Symptom.** A full album is indistinguishable from a single track.

**Solution.** Sum the sizes already in the response.

### 157. Duplicate files within a folder are not collapsed

`PROPOSED` `Low`

**Symptom.** Peers list the same track under multiple extensions.

**Solution.** Dedupe by stem, preferring lossless.

### 158. No lossless-only or has-a-free-slot filter

`PROPOSED` `Low`

**Symptom.** Both signals exist and are used only for ranking.

**Solution.** Two toggle chips.

### 159. Recent searches are not remembered

`PROPOSED` `Low`

**Symptom.** Every session starts empty.

**Solution.** Persist the last twenty.

### 160. Results are lost on navigation

`PROPOSED` `Low`

**Symptom.** Leaving the tab discards the result set.

**Solution.** Keep the last set keyed by query.

### 161. Peer upload speed is an unlabelled integer

`PROPOSED` `Low`

**Symptom.** Peers are compared on a raw number.

**Solution.** Format and band it.

### 162. No peer blocklist

`PROPOSED` `Low`

**Symptom.** A peer that always queues forever keeps ranking well.

**Solution.** Persist a penalty updated from transfer outcomes.

### 163. Library-ownership is recomputed per card per render

`PROPOSED` `Low`

**Symptom.** Each result re-scans the library.

**Solution.** One Set per render pass.

### 164. No guided retry when all six variants return nothing

`PROPOSED` `Low`

**Symptom.** A bare Nothing found for a query that only needs simplifying, despite the project's own rule to never give up on a search.

**Solution.** Offer the simplified query as a one-click retry.

### 226. slskd rate-limits (HTTP 429) with no backoff

`OPEN` `High` `was #16`

**Symptom.** Repeated searches in quick succession get 429ed. Nothing retries and nothing tells the user why results stopped arriving.

**Solution.** Detect 429, show 'the daemon is throttling — retrying in Ns', and back off exponentially per variant rather than firing all six again.

### 227. A running search cannot be cancelled

`OPEN` `Medium` `was #18`

**Symptom.** Each variant runs for 90 s. Starting a new search leaves the old ones running against the daemon.

**Solution.** Track the slskd search ids per generation and DELETE them when the generation is retired.

### 228. No indication of which variant produced a result

`PROPOSED` `Low` `was #26`

**Symptom.** When a search succeeds only via the reversed-two-word variant, that information is discarded.

**Solution.** Tag each group with its originating variant; useful for tuning the variant list.

### 229. No 'download the whole folder' affordance distinct from the card click

`PROPOSED` `Low` `was #28`

**Symptom.** The primary action is implicit.

**Solution.** Explicit primary button on the card; the card body opens a file list.

### 230. Search history does not inform ranking

`PROPOSED` `Low` `was #33`

**Symptom.** Nothing learns from which results the user actually downloaded.

**Solution.** Small persistent boost for peers whose downloads previously completed.

### 231. Query is not reflected in navigation state

`PROPOSED` `Low` `was #36`

**Symptom.** Navigating away and back loses the results entirely.

**Solution.** Keep the last result set keyed by query in module state.

---

## Library & scanning  (13)

### 165. A rescan can race a tag write and make a present file look missing

`OPEN` `High`

**Symptom.** Tag writes schedule a rescan on a 1.2 s debounce while mpv holds the file open with 30 s of readahead. A rename during that window produces end-file error, which reaches dropMissingTrack and removes a track that is not missing.

**Solution.** Suppress the missing-file path for any file the app itself is currently rewriting.

### 166. A full rescan runs for a single new file

`OPEN` `High`

**Symptom.** The watcher triggers performScan over the whole tree after one event.

**Solution.** Incremental scan of the changed directory; keep the full scan manual and scheduled.

### 167. backgroundSync re-navigates the current page whenever the library signature changes

`OPEN` `Medium`

**Symptom.** A rescan landing while you are reading a page rebuilds it under you.

**Solution.** Update in place where possible; re-navigate only when the current page's data actually changed.

### 168. The rescan cadence in code does not match the documented one

`OPEN` `Medium`

**Symptom.** CLAUDE.md documents 15/45/120 s after a Soulseek download; the torrent path uses 8/25/60. Two policies, one document.

**Solution.** One scheduler, one policy, and correct the document.

### 169. Scan failures are reported as an empty library rather than a failure

`OPEN` `Medium`

**Symptom.** An empty result is indistinguishable from a failed scan at several consumers.

**Solution.** A typed failure that every consumer must handle, as was done for the health check.

### 170. Nothing bounds how long a scan may run

`OPEN` `Medium`

**Symptom.** A slow or unresponsive mount stalls it indefinitely.

**Solution.** A deadline, with partial results and a clear report.

### 171. No scan progress

`PROPOSED` `Medium`

**Symptom.** A long scan is silent.

**Solution.** Report files seen and current directory.

### 172. No detection of a library root that has gone away

`PROPOSED` `Medium`

**Symptom.** If /mnt/data is unmounted the scan simply finds nothing.

**Solution.** Detect a missing root and refuse to prune anything.

### 173. Prune has no dry run

`PROPOSED` `Medium`

**Symptom.** Cleanup operations act directly.

**Solution.** Preview what would be removed first.

### 174. Cue sheets and multi-disc layouts are handled inconsistently

`PROPOSED` `Low`

**Symptom.** The folder tree fix addressed multi-disc grouping; the scanner still treats discs as separate album candidates in places.

**Solution.** One album identity rule shared by scanner and UI.

### 175. Embedded cover art is re-extracted rather than cached by content hash

`PROPOSED` `Low`

**Symptom.** Every file in this Camel album carries a 1500x1500 JPEG.

**Solution.** Hash and share.

### 176. No report of files the scanner skipped and why

`PROPOSED` `Low`

**Symptom.** A file that fails to parse simply does not appear.

**Solution.** A skipped list in Manage.

### 248. Library rescan is not incremental

`PROPOSED` `Medium` `was #88`

**Symptom.** A full recursive scan of /mnt/data/MUSIC for one new download.

**Solution.** Scan the download folder only for post-download rescans; keep the full scan manual and scheduled.

---

## IPC bridge  (8)

### 103. 173 IPC endpoints with no uniform timeout

`OPEN` `High`

**Symptom.** 127 handle plus 46 on. A renderer invoke against a handler that never settles hangs that UI action forever with no feedback.

**Solution.** A wrapper applying a per-endpoint deadline and rejecting with a typed timeout.

### 104. Large payloads cross the bridge structured-cloned in both directions

`OPEN` `High`

**Symptom.** The 1 MB transfer list every 6 s is the worst case, but library and scan results are comparable.

**Solution.** Return only the fields the renderer reads; warn above a size threshold in development.

### 105. The preload surface is a flat list of 164 endpoints with no grouping or validation

`OPEN` `Medium`

**Symptom.** Arguments are forwarded unvalidated to main.

**Solution.** Group by domain and validate argument shapes at the boundary.

### 106. Renderer-supplied paths reach main handlers that do not all go through libPathAllowed

`OPEN` `Medium`

**Symptom.** The trash and show-in-folder paths are correctly guarded; other path-taking handlers are not consistently checked.

**Solution.** Route every path-taking handler through the existing guard rather than adding a second one.

### 107. Events are broadcast to the window with no sequence numbers

`OPEN` `Medium`

**Symptom.** A renderer that missed an event cannot tell.

**Solution.** Monotonic sequence per channel so the renderer can detect a gap and resync.

### 108. No IPC call logging in development

`PROPOSED` `Medium`

**Symptom.** There is no way to see which handler hung.

**Solution.** Log slow invokes above a threshold.

### 109. No versioning between preload and renderer

`PROPOSED` `Low`

**Symptom.** A stale renderer against a new preload fails at the call site.

**Solution.** A version constant checked at startup.

### 110. contextIsolation assumptions are not asserted

`PROPOSED` `Low`

**Symptom.** The bridge relies on a frozen object; nothing verifies it.

**Solution.** Assert at startup and refuse to run otherwise.

---

## Observability  (15)

### 111. There is no record of playback ever having stopped

`OPEN` `Critical`

**Symptom.** This is the finding that made yesterday's incident unexplainable. No engine event, no reason code, no respawn, no timeout is written anywhere.

**Solution.** The flight recorder is the first thing built, before any other fix, so the next occurrence is diagnosable.

### 112. No crash-loop protection

`OPEN` `High`

**Symptom.** The render-process-gone handler offers Reload, and a page that crashes on load can be reloaded into the same crash indefinitely.

**Solution.** Count reloads in a window; after three, open on a safe page and say why.

### 113. No log levels

`OPEN` `High`

**Symptom.** Everything is console.log, so verbose diagnostics cannot ship enabled and the log cannot be filtered.

**Solution.** debug/info/warn/error behind a level gate, with the flight recorder always on at info.

### 114. The renderer's failure card shows no stack

`OPEN` `Medium`

**Symptom.** The error boundaries added last round render a card, but the error itself only reaches devtools.

**Solution.** Include a copyable stack and a one-click 'copy diagnostics'.

### 115. Nothing correlates renderer and main logs

`OPEN` `Medium`

**Symptom.** They are separate streams with no shared identifier.

**Solution.** A session id stamped on both.

### 116. No 'what just happened' panel

`PROPOSED` `Medium`

**Symptom.** When something goes wrong the only recourse is asking someone to read files, exactly as this investigation did.

**Solution.** A Manage panel showing the last engine events, the daemon state, and the last error, copyable.

### 117. No automated smoke test of the ten tabs

`PROPOSED` `Medium`

**Symptom.** The CDP sweep that catches regressions is run by hand.

**Solution.** Wrap .qa/relaunch.sh and the sweep as one npm script.

### 118. No test coverage of the main process IPC handlers

`PROPOSED` `Medium`

**Symptom.** 399 tests, none exercising the 173 endpoints.

**Solution.** A thin harness invoking handlers directly with fixture arguments.

### 119. No regression test for the playback state machine

`PROPOSED` `Medium`

**Symptom.** The most important logic in the app has the least coverage.

**Solution.** Drive the engine against a scripted fake mpv socket and assert the emitted events for every end-file reason.

### 120. No fault-injection harness

`PROPOSED` `Medium`

**Symptom.** Nothing exercises mpv dying, hanging, or losing its device.

**Solution.** A test mode that can SIGKILL, SIGSTOP and detach the device on command — the reproduction harness this plan already requires.

### 121. No startup self-check

`PROPOSED` `Low`

**Symptom.** mpv, slskd and the library root are all hard requirements checked only when first used.

**Solution.** Check all three at launch and report clearly.

### 122. No way to export diagnostics

`PROPOSED` `Low`

**Symptom.** Reporting a problem means finding files by hand.

**Solution.** One button producing a zip of the day's log, the config minus secrets, and the flight recorder.

### 123. The stale comment about hardware acceleration is still in main.js

`PROPOSED` `Low`

**Symptom.** It claims Electron gets none and composites with SwiftShader. The machine has an RTX 3070 on OpenGL 4.6 and the app has a real GPU process.

**Solution.** Rewrite it to state the actual reason the flags are there — a VRAM budget shared with DaVinci Resolve — per your decision to keep them.

### 124. CPU rasterisation flags: keeping them is now a recorded decision, not an open bug

`CLOSED` `Medium`

**Symptom.** disable-gpu-rasterization, disable-zero-copy and num-raster-threads=2, against monitors at 1.7x and 1.0x scale, are the remaining half of the monitor-switch hitch after last round's store.set fix.

**Solution.** Closed by your decision on 2026-08-27: Resolve's VRAM headroom wins. Recorded here so it is not re-raised as a defect.

### 247. No renderer-side error reporting surface

`PROPOSED` `Low` `was #87`

**Symptom.** The new boundaries render a failure card, but the error itself is only in devtools.

**Solution.** Include a copyable stack in the failure card.

---

## Player UI  (8)

### 125. There is no visible state for 'the player is in trouble'

`OPEN` `High`

**Symptom.** The UI has playing, paused and a full-screen blocker, and nothing in between. Every transient failure therefore looks like normal playback.

**Solution.** A quiet inline state on the player bar for reconnecting, retrying and resumed — which is what your chosen recovery behaviour needs.

### 126. Snackbars are the only failure channel and they expire in five seconds

`OPEN` `Medium`

**Symptom.** Anything that goes wrong while you are away is gone before you see it.

**Solution.** Keep a short dismissible history of recent notices.

### 127. The progress bar freezing is indistinguishable from a paused track

`OPEN` `Medium`

**Symptom.** When mpv dies, position stops updating and nothing else changes.

**Solution.** Stale position is itself a signal; show it.

### 128. Track changes do not verify that the UI matches what mpv is playing

`OPEN` `Medium`

**Symptom.** Several findings above end in a desync between queueIndex and the actual file.

**Solution.** Reconcile the displayed track against mpv's observed path on every position tick, cheaply.

### 129. No 'now playing from' provenance

`PROPOSED` `Medium`

**Symptom.** When the queue is a six-track selection rather than a full album, nothing says so — which is precisely the ambiguity that made yesterday's queue hard to interpret.

**Solution.** Show the queue's origin: album, playlist, selection, search.

### 130. The queue panel does not show that the queue is shorter than the album

`PROPOSED` `Medium`

**Symptom.** A partial album looks identical to a full one.

**Solution.** Show '6 of 12 from this album' with a one-click add-the-rest.

### 131. No keyboard access to the player bar controls

`PROPOSED` `Low`

**Symptom.** Consistent with the gaps already fixed on other surfaces.

**Solution.** Same a11y sweep.

### 132. No indication that a rescan is running

`PROPOSED` `Low`

**Symptom.** Background syncs re-render pages with no explanation.

**Solution.** A subtle indicator while a scan is in flight.

---

## Performance  (6)

### 177. 73 store.set sites each pay a whole-document synchronous write

`OPEN` `High`

**Symptom.** The config is 2.56 MB. libraryCache is 1.37 MB, playHistory 344 KB, playCounts 110 KB. Playing one track writes the whole thing at least twice.

**Solution.** Split into separate stores so the hot config is roughly 30 KB. This single change fixes every one of the 73 sites, including the download scheduler and playback state.

### 178. The library cache is rewritten whole for one new album

`OPEN` `Medium`

**Symptom.** 1.37 MB per change.

**Solution.** Falls out of the split; consider SQLite past roughly 50k tracks.

### 179. Window state lives in the hot config

`OPEN` `Medium`

**Symptom.** It changes more often than anything else in that file.

**Solution.** Its own tiny file — free once the store is split.

### 180. No measurement of main-thread block time

`PROPOSED` `Medium`

**Symptom.** Every freeze in this report was found by reading code or by measuring by hand.

**Solution.** Sample the event loop and log stalls above a threshold, with the last IPC handler named.

### 181. Album art is decoded at full resolution for grid cards

`PROPOSED` `Medium`

**Symptom.** 1500x1500 JPEGs rendered into small cards, 231 at a time.

**Solution.** Generate and cache thumbnails.

### 182. No virtualisation on long track lists

`PROPOSED` `Low`

**Symptom.** Thousands of rows are built as DOM.

**Solution.** Windowed rendering for lists past a threshold.

---

## Architecture  (5)

### 183. 14,085 lines in one file across 18 global-scope script tags

`OPEN` `High`

**Symptom.** src/renderer.js is two thirds of the codebase in a single shared scope. Most of the collision and double-binding findings in this and the previous report are symptoms of this one fact.

**Solution.** Convert to ES modules with explicit imports. Mechanical and low-risk per file, and it makes the whole class of defect impossible.

### 184. var API is declared in eight files sharing one global scope

`OPEN` `Medium`

**Symptom.** Latent rather than live — each file captures its namespaced export before the next overwrites the bare global, and nothing reads bare API. The real gap is that test/script-globals.test.js guards function collisions but not var.

**Solution.** Extend the guard to var, then rename.

### 185. The playback state lives in three places that can disagree

`OPEN` `Medium`

**Symptom.** mpv's observed properties, the shim's private fields, and state.isPlaying in the renderer.

**Solution.** One state machine in the engine; the other two become views of it.

### 186. There is no seam to test playback without a real mpv

`PROPOSED` `Medium`

**Symptom.** spawnFn is injectable but nothing exercises it.

**Solution.** A scripted fake mpv socket, which the fault-injection work needs anyway.

### 187. Helper modules are loaded as globals rather than required

`PROPOSED` `Low`

**Symptom.** Load order is significant and unstated.

**Solution.** Falls out of the module conversion.

---

## Network & YouTube  (8)

### 192. YouTube parser errors are logged as multi-page stack dumps into the app log

`OPEN` `High`

**Symptom.** Your 2026-08-26 log contains a full InnertubeError dump with generated TypeScript, from youtubei.js. Every line of it went through the synchronous appendFileSync path.

**Solution.** Catch and summarise parser errors to one line; they are expected when YouTube changes its schema.

### 193. youtubei.js schema drift degrades silently after the log line

`OPEN` `Medium`

**Symptom.** A parser failure means the shelf simply does not appear.

**Solution.** Report which section failed to the UI rather than rendering an empty page.

### 194. Resolved YouTube stream URLs expire and nothing tracks that

`OPEN` `Medium`

**Symptom.** The log shows resolved googlevideo URLs with an expire parameter. A queued YouTube track can hold a URL that is dead by the time it plays.

**Solution.** Re-resolve if the expiry is near when the track is reached.

### 195. The cookie refresh runs on a timer with no failure reporting

`OPEN` `Medium`

**Symptom.** validateYtCookie and refreshYtCookie run at startup behind a setTimeout with no surfaced outcome.

**Solution.** Report a failed refresh; it is the reason YouTube features stop working.

### 196. No offline mode

`PROPOSED` `Medium`

**Symptom.** With no network, YouTube and Soulseek surfaces fail one call at a time.

**Solution.** Detect it once and degrade the whole UI coherently.

### 197. No request budget for YouTube

`PROPOSED` `Low`

**Symptom.** Nothing bounds calls per minute.

**Solution.** A simple limiter, as the 429 work adds for slskd.

### 198. The bridge server on port 8765 is unauthenticated on the LAN

`PROPOSED` `Low`

**Symptom.** It serves the music library to the Android app with no token.

**Solution.** A shared token; the Android app already has a settings screen to hold one.

### 199. The bridge server shares the library scan with the desktop app

`PROPOSED` `Low`

**Symptom.** Two consumers, one uncoordinated scan.

**Solution.** Serve from the cache rather than rescanning.

---

## Desktop integration  (6)

### 200. Media keys and the tray can act on a dead engine

`OPEN` `Medium`

**Symptom.** They call the same handlers, which pass the truthy-player guard even when the client is null.

**Solution.** One engine-ready check shared by every entry point.

### 201. The tray tooltip is updated from renderer state that can be stale

`OPEN` `Medium`

**Symptom.** After an engineDown the tooltip keeps claiming a track is playing.

**Solution.** Drive it from the engine's own state.

### 202. No MPRIS integration on KDE

`PROPOSED` `Medium`

**Symptom.** The desktop is Plasma now; the old GNOME extension is inactive. Media controls, artwork and position would come free.

**Solution.** Expose MPRIS from main; it maps directly onto the engine's observed properties.

### 203. No inhibit while playing

`PROPOSED` `Medium`

**Symptom.** The session can idle or sleep mid-album.

**Solution.** Take an idle inhibitor while audio is playing and release it on pause.

### 204. No resume-after-suspend handling

`PROPOSED` `Low`

**Symptom.** Waking from sleep leaves mpv in an undefined state with no reconnect.

**Solution.** Re-probe the engine on resume.

### 205. Notifications carry no album art on some paths

`PROPOSED` `Low`

**Symptom.** notifyTrack passes artPath which may be null for bridge tracks.

**Solution.** Fall back to the album's art by containment, the rule already established for bridge tracks.

---

## Settings  (5)

### 206. Changing output settings rebuilds the engine mid-track with no warning

`OPEN` `Medium`

**Symptom.** main.js:1032 rebuilds for outputMode, alsaDevice, mode and crossfadeSecs. The rebuild path replays load, seek, volume and play with no failure handling.

**Solution.** Warn, then rebuild through the same supervised resume path as a respawn.

### 207. An invalid ALSA device is only discovered at spawn time

`OPEN` `Medium`

**Symptom.** The stored device string can name a sink that no longer exists.

**Solution.** Validate against the device list when the setting is opened, and mark a missing device.

### 208. No reset-to-defaults for player settings

`PROPOSED` `Medium`

**Symptom.** A bad combination has to be undone by hand.

**Solution.** One reset, with the current values shown first.

### 209. Settings changes are not logged

`PROPOSED` `Low`

**Symptom.** A behaviour change after a settings edit cannot be correlated.

**Solution.** Log them into the flight recorder.

### 210. The crossfade seconds control is live even in gapless mode

`PROPOSED` `Low`

**Symptom.** It is hidden, but the value is still applied on the next mode switch with no preview.

**Solution.** Preview the change.

---

## Accessibility  (5)

### 211. No live region for player state changes

`PROPOSED` `Medium`

**Symptom.** Track changes, errors and recovery are all silent to a screen reader.

**Solution.** One polite region on the player bar.

### 212. Focus is not restored after a modal closes

`PROPOSED` `Low`

**Symptom.** Focus returns to the document.

**Solution.** Restore to the trigger.

### 213. No skip-to-content

`PROPOSED` `Low`

**Symptom.** Keyboard users traverse the sidebar every navigation.

**Solution.** A skip link.

### 214. Focus order does not always match visual order after a re-render

`PROPOSED` `Low`

**Symptom.** setContent replaces the subtree wholesale.

**Solution.** Restore focus by a stable key after a re-render.

### 215. prefers-reduced-motion is not honoured everywhere

`PROPOSED` `Low`

**Symptom.** Some transitions are unconditional.

**Solution.** One media query at the top of the stylesheet.

---

## Tests & tooling  (5)

### 188. No lint rule against empty catch blocks

`PROPOSED` `Medium`

**Symptom.** There are 105, and they are the single largest reason failures are invisible in this codebase.

**Solution.** A lint rule requiring a logged reason or an explicit comment.

### 189. No lint rule against floating promises

`PROPOSED` `Medium`

**Symptom.** The fire-and-forget prefetch is one instance of a general pattern.

**Solution.** Enforce handled rejections.

### 190. No CI

`PROPOSED` `Medium`

**Symptom.** 399 tests run only when someone runs them.

**Solution.** Run tests and the ten-tab smoke sweep on every commit.

### 191. No coverage reporting

`PROPOSED` `Low`

**Symptom.** The least-covered code is the most important — the playback path.

**Solution.** Report coverage and gate the playback modules specifically.

### 250. ~200 lines of confirmed-dead CSS

`OPEN` `Low` `was #155`

**Symptom.** .smart-pl-box/-rule/-badge, .playlist-folder-tree, .playlist-import-drop, .artist-bio-photo, .album-grid-skeleton, .artist-hero-bio — all verified to have zero class= producers. Two audit claims were rejected on close reading: .album-card-meta is used in 3 places, and .smart-pl-modal is dead as a class but live as an id.

**Solution.** Safe to purge in a dedicated pass. Left alone deliberately: zero user-visible benefit, non-zero regression risk.

---

