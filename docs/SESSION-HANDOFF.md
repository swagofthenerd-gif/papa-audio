# Session handoff — Papa Audio elite-experience campaign

Written 2026-09-11 by Opus 5 at the end of a long session, for the next model
(Fable 5.1) to pick up cold. Read this top to bottom before touching anything.

---

## 0. Who you are working for, and how

**Shaharyar. Non-technical.** He is smart but does not read code and does not
know the jargon.

- The `no-bullshit` skill is mandatory for every substantial update.
  **Before any commit, send the plain-English account first** — what we had,
  what was found, what changed, what it means for him. Bad news first.
- He wants **commit + push per verified wave**, not one giant dump.
- He does not trust subagent findings on weaker models. Memory
  `subagent-quality-gate.md`: dispatch subagents with `model: "fable"`, and
  **personally verify every agent claim before repeating it to him.** In this
  session two agent claims were flat-out wrong (details in §5) — that is why
  the rule exists.
- He has corrected me three times for saying models don't exist. **Opus 5
  exists** (`claude-opus-5`). Do not assert a model is unavailable.

## 1. The project

`~/flac-player` — **Papa Audio**, an Electron music + video player.
Branch: **`feature/papa-video`** (NOT main). Clean and pushed at handoff.

- `main.js` ~11k lines (main process), `src/renderer.js` ~30k lines (UI,
  partially modularised), `preload.js` (contextBridge).
- Playback is **mpv over JSON IPC** (`mpv-engine.js`), not `<audio>`.
  `src/player-shim.js` translates engine events into DOM-ish events.
- Soulseek via the **slskd daemon at localhost:5030**.
- Music library `/mnt/data/MUSIC`, downloads land in `/mnt/data/MUSIC/Downloads/`.
- `bridge-server/` serves FLAC over LAN on port 8765 to the Android app.
- Tests: `npm test` (`node --test 'test/**/*.test.js'`). **3991 passing at
  handoff. Keep it green.**
- Read `~/flac-player/CLAUDE.md` first — it is authoritative for this repo.

Companion: `~/papa-audio-android` (React Native + Expo, not a git repo).

## 2. HARD SAFETY RULES — carry these forward verbatim

The slskd daemon at localhost:5030 is **his real account**:

- You MAY search and browse peers freely.
- You MUST NOT start any download.
- You MUST NOT cancel, retry, or reorder his real existing downloads.
- You MUST NOT message peers.
- You MUST NOT change slskd config.
- The **Manage tab**: analyses and dry-runs only. NEVER apply, fix, delete,
  or reclaim.
- **Mute the volume before any playback test.**
- Firewall / sudo commands are handed to him to run himself, never run.

## 3. The QA twin pattern (how live verification is done)

Never test against his live profile. Instead:

1. `rsync` `~/.config/papa-audio/` into a disposable dir, excluding
   `Cache*`, `GPUCache`, `Singleton*`, `logs`, `Code Cache`, `Dawn*`.
2. Launch `PAPA_USER_DATA=$PROFILE npx electron . --remote-debugging-port=NNNN`.
3. Drive it over raw Chrome DevTools Protocol with a small `drive.js`
   (eval / screenshot / click). **The scratchpad is wiped between sessions,
   so drive.js must be rebuilt each time.**
4. **Always `pkill` the twin and `rm -rf` its profile afterwards.** Orphaned
   twins bit us twice; one cleanup reclaimed 1.9 GB.

## 4. What shipped this session (all committed and pushed)

| Commit | What it fixed, in his words |
|---|---|
| `027fae5` | Anime *search* now falls back AniList → Jikan like the shelves already did |
| `29b41bf` | **Kitsu** added as a third anime database so a double outage can't blank the app |
| `c4fea5c` | The long plan: `docs/elite-experience-roadmap.md` |
| `228ca83` | Killed the app's only recurring crash-in-the-console (taste tracking) |
| `945edb1` | The **"dub" checkbox** now actually puts dubs at the top |
| `5044efb` | **The 108 stalled downloads** + back-button memory + peer-library speed + a stray row |
| `1ae1b8b` | **The playback crash**: one bad file can no longer kill the whole player |

### Detail on the big ones

**Tokyo Revengers S3 missing** — genuine double outage (AniList 403 for days,
Jikan 504) plus a real gap: search had no fallback chain while shelves did.
Added `catalog/kitsu.js` (+377, mirrors `jikan.js`'s shape; cards keyed
`kitsu-<id>`, `source:'kitsu'`, JSON:API headers, `filter[text]` search) and
the `lastFailure()` convention on every rung. `_animeSearch` in `main.js` is
the chain. Verified live: 3 seasons, 13 episodes, 28 sources.

**The 108 stalled downloads** (`src/download-scheduler.js`) — `maxAttempts`
was counting *raw dispatch attempts* instead of *distinct sources tried*, and
the restart path (`dlPersist`/`dlRestore`) carried the count across restarts,
so a file with one good peer got permanently benched. Fixed with
`distinctTried(entry)` at four gates, a separate `maxTotalAttempts: 24`
backstop, and exponential `retryGapMs` capped at 30 min. Proved against his
real queue: **0 → 37 dispatches.**

**The playback crash** (`mpv-engine.js`) — 17 `SIGSEGV`s, **100% on `.dsf`
(DSD) files** at 352.8 kHz. Proved the segfault is in mpv/ALSA's *output*
path (decode with `--ao=null` is clean; PipeWire owns the 48 kHz/6 ch device)
— i.e. outside the app. But the app's own bug: `_onExit` resumed the very
file that had just killed mpv, so one track burned all three respawns and
killed the engine. Added per-file poison quarantine (`POISON_DEATHS = 2`,
`POISON_WINDOW_MS = 45000`, early-death-only counting, checked *before* the
respawn-budget check), emitting a new `trackUnplayable` event → `main.js`
forwarder → renderer toast + `playNext()`.
`trackUnplayable` is registered in `STOPS_AT_SHIM` in
`test/engine-event-wiring.test.js` — that guard will fail on any new
main→renderer event you add without documenting it.

### New tests added
`test/taste-ipc.test.js` (2), `test/journey-nav.test.js` (18),
`test/download-scheduler-single-source-stall.test.js` (8),
`test/engine-poison-track.test.js` (5, fake mpv that segfaults on demand),
`test/kitsu.test.js` (33), `test/slsk-shelves-chunked-bench.test.js`.

## 5. Agent claims that were WRONG (cautionary)

- An agent reported a "zombie smart playlist in the real profile". It did not
  exist — the agent had created it in its own sandbox. Real `config.json`
  has `smartPlaylists: []`.
- An agent reported "taste tracking is dead". Recording always worked; only
  the profile *refresh* crashed.
- An `about:blank` popup flagged as a bug is the **intentional hidden mpv
  embed surface** (`_videoWindow()`, `visibilityState: hidden`). Leave it.

Two Fable builders hit their usage limit mid-flight before their own
verification step. Their work survived uncommitted and I verified it by hand.
**Consequence: the peer-library speed numbers are bench-only, never
live-measured.** That is open debt — see §7.

## 6. THE PLAN — what to build next

Authoritative document: **`~/flac-player/docs/elite-experience-roadmap.md`**
(274 lines). Read it in full. Its through-line is:
**"the engine is elite, the memory is not."**

It came from his request, verbatim:

> "there is no history of the recent searches i made, when i go back from the
> anime page of an anime, it just goes straight to home instead of back to the
> search … make something unique that you can actually be proud of"

(He later clarified: he meant the search **in the Movies & TV tab**.)

Structure: Part I Journey Engine (J1–J6), Part II 19 verified repairs,
Part III 8 speed items, Part IV truth & polish, Part V delivery + honest debt.

**J1 is done and shipped** (nav truth: `navHistory`/`navFuture` capped at 200,
`_scrollMemory` keyed `page:navId`, `_NEEDS_NAV_ID`, `_backOr`,
`_restoreVideoSearch` with a 5-minute cache, nav-dismiss registry).

### J2 + J3 shipped (2026-09-11, Fable 5.1)

One search memory (`src/search-memory.js`, localStorage key
`papa-search-memory`, migrates + retires the three legacy keys at startup)
and one dropdown (`src/search-recents-ui.js`) behind the music bar, the
library box, the Movies & TV box and the Soulseek hub box. One brain:
`PapaLibraryIndex.query` runs the committed search page, `filterAlbums` runs
the library grid (artist+album → +song titles → +correction), `suggest` gives
runnable did-you-mean; the renderer's private `_fuzzyFind`/`_levenshtein` and
music-tools' `fuzzyFilter`/`pushRecentSearch` are deleted. Correction undo is
pinned per query (`state._searchNoCorrect`, `state._libNoCorrect`,
`slsk.noCorrectFor`). "Opened from this search" is recorded
(`_openedItemOf`, capture click on #content; video cards) — the J4 seed.
Verified live on a QA twin: "camel mirage" found everywhere; row ✕ keeps the
list open (the outside-click rule now reads `composedPath`). Tests 4,036.

### R5 shipped (2026-09-11, Fable 5.1)

`src/dl-numbers.js` is the one model behind every Downloads number (cards,
strip, tab badges, scheduler line, nav badge); `mergeHeld` replaces a FAILED
earlier attempt with the scheduler's retry; cards patch live via
`_dlPaintDashboard`. Root cause found on the real queue: after a restart the
scheduler re-requested files slskd still had queued (refused → counted as a
failed attempt, 40 of 44 "waiting" were this). Fix: `adoptLive` in the
scheduler + an adopt pass at the top of `dlTick` (before reconcile/dispatch).
Soulseek header via `PapaSlskFilters.summaryLine` (units named). Observe-only
twin recipe: pin `slskSchedulerConfig` in the twin's config.json to
`{ maxGlobalInflight: 0, discoverAlternates: false, stallAfterMs: 86400000 }`
so the twin sends no requests and cancels nothing. Tests 4,060.

### Shipped after J2 + J3 (2026-09-11, Fable 5.1) — all committed + pushed

| Commit | What |
|---|---|
| `2822c67` | R5: `src/dl-numbers.js` one model behind every Downloads number; scheduler **adopts** files slskd already has (`adoptLive`, dlTick adopt pass) — 40 of 44 "waiting" were live at the peer |
| `e826a99` | R3/R4/R16: search survives navigation (no bail on missing section); `_setSlskStatus` one connection truth + `_onSlskConnected` runs the waiting search; throttled-empty says "Rate-limited" |
| `1538cac` | R6/R7: `src/mood-map.js` moods from audio-analysis z-scores (library has NO genre tags; `audio-features-all` IPC); `state.libMood`; genre chips split compounds; Save-search rules in evaluator language (`normalizeSmartRules`, `any/matches`), load sweep, delete hits the right store |
| `9678460` | R9/R10: Health findings carry `items` (name/folder/id, Open ›); OMDb title fallback gated by year+type (`plausibleMatch`, `omdbTypeFor`); `catalog/search-rank.js` junk last |
| `74ea6e7` | R11/R12: `_searchIntent` Browse chip in live video search, fuzzy anime hidden for descriptions, `_COUNTRY_FALLBACK`; extractor errors honest + "Update yt-dlp" action, toast reaches mini mode, hover-preview watchdog |
| `1d9121d` | J5: `src/omnibox-model.js` + renderer `_omni*`; Ctrl+K = Omnibox, Ctrl+Shift+P = command mode; exact page/tab/command name outranks library typo hits |
| `27de94c` | J4/J6: `src/trail-model.js` + `renderTrail`, Home row `trail`, nav item; `src/journey-model.js` + `_crumbFor`/`_journeyCrumbUpdate` return strip (`#journey-crumb`) on cross-surface jumps |

Later the same day: `3ffe22e` (R8 R14 R15 R17 + plural sweep), `a7370cd` (R18 R19 S7: analysis progress truth, AniList circuit breaker, outage wording, shelf dedupe). Suite: **4,136 green**. The video plan the user asked for is `docs/video-experience-plan.md` — its §0 diagnosis (native `--wid` window under the HTML) is the reason the mini player can never feel like YouTube until the pixels are rendered in-page (V0). Twin traps learned: `pkill -f "<port>"` kills your own shell (use `pgrep -f 'electron [.] --remote-debugging-port=NNNN'`); pin the twin's `slskSchedulerConfig` to `{ maxGlobalInflight: 0, discoverAlternates: false, stallAfterMs: 86400000 }` so it can only observe the shared slskd; `.focus()` fires no focus event without window focus → dispatch `new FocusEvent('focus')`.

### The queue, in order

1. ~~J2 + J3, R5, R3/R4, R6, R7, R9, R10, R11, R12, J5, J4, J6~~ done — see above.
2. **V0 decided + V1 foundation shipped** (`src/stream-plan.js`, `web-stream.js`, `src/web-player.js`; `playerMode` setting, default `smooth`; CSP admits `http://127.0.0.1:*`). Live-measured: full-res HEVC→H.264 playback with 0 dropped frames; 705-frame picture drag, none > 20 ms; far seek first frame in 0.6 s. Twin trick for video: `_initVideoUI(); _player.open({title}); window.api.videoPlay({ result: { kind: 'file', url: '/path.mkv' } })` then `_webPlayer.seekTo()`; `pkill -f` on a pattern in your own command line kills the shell — kill by env/port instead.
3. **V1 polish shipped** (`src/mini-motion.js`): release velocity → projected corner → spring settle (27 frames, worst 20 ms); corner grip free-resize 240–720 px (persisted as a number in `papa-vmini-pos`); theatre↔card flight flies a one-frame canvas **ghost** (a live `<video>` inside a scaled layer stalls 100 ms; a shadow+radius on the ghost stalls too — transform only, no shadow): worst frame 17–24 ms both ways; hover chrome over the picture (`.vmini-overlay`, z-index above the appended video); keys reach the card only while it has focus (press focuses it, Escape blurs; renderer's music shortcuts and the poster-grid arrows stand down for `#vmini`). Found and fixed: the top corners sat behind the 44 px title bar (`#layout` is a fixed stacking context under it) — `miniCardTopLeft` now takes a `topInset`.
4. **V2 shipped (part 1):** `src/watch-rules.js` (fresh <5 %/30 s, partial, watched ≥92 %) used by the store, `_offerResume`, `_videoCard`, `_EP_STARTED`; `src/release-name.js` (group/resolution/batch + `plausible(req, name)`) — providers now keep `title` (the release name), rows show a group badge, the group is remembered per show (`preferredGroup`, +200 in `_pickMatchingStream`), and sources whose name does not carry the title are hidden behind a count ("Show them"); `src/episode-list.js` — TV seasons paint as rows (`_epRowHtml`: still, title, date, runtime, synopsis, ✓, bar, Up next/Continue). Live-checked on the twin: "X" (2001) had 43 junk sources (Logic Pro, hentai) — all hidden; Steins;Gate 50 shown, 0 hidden.
5. **V2 part 2 shipped:** inline hero trailer (`_playInlineTrailer`, Sound/close bar, theatre only as fallback); detail-page keys P/S/T/1–9/Esc (`_DETAIL_KEYS`; music handler and poster-grid arrows stand down); shortcuts dialog rows. **Found and fixed on the way — every trailer in the app was dead:** yt-dlp ≥2025.11 refuses YouTube without a JS runtime (fixed: `--js-runtimes node:<path>` via `ytdlp-manager.nodePath()`, and `--ytdl-raw-options-append=js-runtimes=…` for mpv), AND YouTube serves no single muxed file any more (fixed: `YT_FORMATS.pair` → `resolveTrailerStream()` → `web-stream.openPair(v, a)` copies the pair into one local fMP4; the hero/hover/inline/theatre paths all use it; preview sessions swept at 4). Verified live: inline trailer 1080p, theatre trailer in smooth mode, ffmpeg gone after close. Hover/hero previews could not be exercised on the twin at the time (TMDB "fetch failed"; check `curl https://api.themoviedb.org/3/configuration`).
6. **Seek-back rebuffering (user report, fixed 2026-09-12):** the V1 feed threw converted output away and restarted ffmpeg on every seek outside the browser's small buffer. Now: every converter run writes to `<userData>/web-stream-cache/<session>/run-N.mp4` with a fragment index (`src/fmp4-index.js`: init length, timescale, tfdt→offset), a request inside a converted span is served from the file (`X-Papa-Cached: 1`, `X-Papa-Start` = the run's start second), one live ffmpeg per title, runs capped 4 GiB / title 10 GiB, cache removed on stop. The page plays through Media Source Extensions (`src/web-player.js`: one SourceBuffer per session, `timestampOffset` = X-Papa-Start, film timeline throughout, quota handled by dropping >300 s behind, `&fresh=1` for the plain-src fallback). MSE traps hit and fixed: sourceopen can fire twice (idempotent), `timestampOffset` is refused while a segment is half-parsed (always `abort()` first), a bad append sets `video.error` and MSE is dead (rebuild). Measured on the twin: fresh seek ~500–620 ms, cached seek back ~300 ms, in-buffer 65 ms, converter runs ahead ~5× for 1080p HEVC.
7. **Lip-sync (user report, fixed 2026-09-12):** a re-encoding run seeked with a single input `-ss` had the picture stamped from the keyframe before the target and the copied sound rebased to the target — 2.3 s offset on every seek and every resume (software decode too; not the CUDA decoder). `ffmpegArgs` now splits the seek: `-ss t-2` before `-i`, `-ss 2` after (copied video keeps the input seek). Probed on the planner's own args: video 0.125/0.167/0.208 s, audio 0/0.146 s — one clock.
7b. **Lip-sync, copied picture (the user's anime case, H.264 copied + audio re-encoded):** the muxer's default `-avoid_negative_ts auto` wrote one sound packet then a jump the size of the seek; `make_non_negative` keeps the sound contiguous, and a copy run now starts exactly on the keyframe at or before the target (`keyframeProbeArgs` / `keyframeAtOrBefore`, ~250 ms ffprobe over a 20 s window) with `X-Papa-Start` = that keyframe, so the page timeline is exact. Verified on a synthetic 7-min H.264/E-AC-3 file: seek 301 → run @300, offset 300, t=301.02, audio 0.0065/0.0965/0.1165.
7c. **Interactions in the page (V4):** stage click/dblclick/wheel with in-page OSD and burst; mini tap; scrub previews never start a converter; seeks coalesced 180 ms; buffer bar = browser buffer ∪ server coverage (`/coverage`); chapters via ffprobe; thumbnails through the real thumbnailer; screenshots via canvas → `video-save-frame`; PGS/DVD burn-in through an overlay graph (slow at 4K HDR, ~0.25×); three empty responses → engine stops and errors (a bad burn once caused 50 runs). `fmp4-index` indexes only the video track (tfhd track_ID); probe retries ×3 on http with `-rw_timeout`.
8. **4K HDR:** this ffmpeg has `tonemap_opencl`; measured 15 s of 4K HDR in 5.2 s (~2.9×) vs 16.9 s for the CPU zscale chain. The planner uses OpenCL when `caps.opencl` (probed at startup in main with a tagged synthetic frame) and falls back to the CPU chain otherwise; pre-roll 4 s with OpenCL, 8 s without.
9. **Subtitles on streamed inputs:** no more whole-file extractor — text tracks come out of the converter run as extra WebVTT outputs (`-flush_packets 1`), cues shifted by the run's start and merged across runs; the engine re-fetches the showing track every 15 s. Local files keep the direct extractor (complete in seconds).
10. Seen live in the user's own app (his PID 6496 running the branch): a 4K HDR DV torrent through the smooth player spawned three subtitle extractors seconds apart — fixed (one in-flight job per track per session, killed on close). **Follow-up:** sidecar extraction from an http/torrent input reads the whole file (subtitles are interleaved); design a progressive extractor (second output of the main ffmpeg, streamed VTT) or limit sidecars to local files.
11. **V2.5 done:** collections sorted by year ("Part 1" is the first film), current entry says "Part N · this page" not "Watching"; airing entries without a title are skipped (the "Untitled" Home card); rating slots are blank until enriched (no dash rows); diary delete has Undo (`restoreViewing` via `_onTasteChange(action, result)` — the host callback used to receive the action string as an "event"). Checked, not bugs: the global-search Movies strip already uses `_videoCard` + `_bindVideoCards` (which observes for enrichment); the video-search decade dropdown is derived from the results present, so "stops at 1990s" is the result set, not a filter cap. Remaining: 2.6 "Approved" chip (reproduce with the crews' exact query). Then V3 polish, V4 stability. Sequel bleed (Steins;Gate 0 sources listed for Steins;Gate) fixed in §19. One dropped video frame per reparent (minimise/restore) is measured and accepted.
12. Open question: the user's own app (was back up with its SingletonLock by 17:20Z) was not running at 16:15Z on 2026-09-11 with no quit line in its log; nothing in this session targeted it, but tell him.
2. ~~R5~~ done — see above.
3. ~~R3 / R4 / R16~~ done (2026-09-11): `runSlskSearch` never bails on a missing
   `#slsk-section` (background job; pages paint from `slsk` state);
   `_setSlskStatus` is the one status writer (fills `slsk.status` AND
   `state.connectionStatus.slskd`, paints the footer dot, runs a waiting search
   on the connect edge); no entry point gates on `slsk.status.connected`;
   main returns `throttled` on an empty search under a recent 429 and the row
   says "Rate-limited". Live: mechanism verified; result cards not seen because
   the shared daemon was throttling the twin (user's app live at the same time). This is his
   original complaint. Today there are **three disjoint recent-search stores**
   (`pa_search_history`, `papa-lib-recent-searches`, `papaVideoRecentSearches`)
   and **three separate typo engines** (`smart-query.js`,
   `PapaMusicTools.fuzzyFilter`, `_fuzzyFind`). Verified breaks this causes:
   searching "camel mirage" returns nothing, and the did-you-mean suggestion
   is a guaranteed dead end.
2. R5 Downloads-numbers reconciliation
3. R3 / R4 Soulseek search race + connection truth
4. R6 mood chips
5. R7 save-search zombie
6. R9 Manage Health hex IDs
7. R10 OMDb title collision
8. R11 natural-language-search bridge
9. R12 trailer honesty
10. **J5 Omnibox**, then **J4 The Trail** (a persistent, browsable journey
    timeline — the genuinely novel piece), then J6 journey-aware cross-jumps
11. Remaining Speed and Truth lanes

### 13. V4 stability, part 1 (2026-09-12, Fable 5.1)

- **Stream-start honesty**: `src/start-honesty.js` is the one table of
  failures between "click Play" and the first frame (mpv missing, ffmpeg
  missing, unreadable/unreachable source, nobody sharing, slow start,
  converter failing, page cannot decode, mpv quit, no magnet/URL, timeout,
  offline, TMDB key). `_videoErrorText` delegates to it; `sentence()` joins
  the words to the next step. Tests: `test/start-honesty.test.js`.
- **Never a black frame with no words**: two watchdogs.
  - Renderer start-up watchdog (`_armStartWatch` on play; disarmed by the
    page engine's `playing`, by a moving position on the state stream, by
    `ended`/`error`/stop). Quiet for 15 s → "Still no picture after N s.
    Nothing has arrived from the source yet." on the stage, once as a toast
    (the mini card hides the stage). mpv's `playing` fires before any frame,
    so in purist mode only the state stream disarms it.
  - Engine stuck watchdog (`web-player.js` `_watchdog`): position frozen
    12 s while unpaused → `stuck` event with `phase` (start/play) and
    `converted` (seconds the converter has on disk ahead of the playhead);
    `unstuck` when it moves. Words say which side is stuck (converter has
    nothing → source; converter ahead → the page cannot decode fast enough →
    Purist mode).
- **Probe failures no longer fall through to mpv** (`main.js` smooth
  branch): an unreadable/unreachable source used to be handed to mpv, which
  hung silently after the stage had said "playing" (found live on the twin
  with a TCP black hole on :9599). Now it is reported.
- **Stage words above the picture**: `.vt-stage-msg` gets `z-index:4` and a
  dark pill; the in-page `<video>` is appended after it and was painting over
  the words.
- Live proof (twin, port 9505, muted): no-magnet → "This source has no magnet
  link — Pick another source…"; black-hole URL → start words at 15 s, then
  the honest probe error at 49 s and no mpv; HEVC test file, seek + SIGSTOP
  the converter → stuck words at 12 s over the frozen frame, SIGCONT →
  "Resumed", words cleared. Screenshots in the scratchpad
  (`v4-start-watchdog.png`, `v4-unreadable.png`, `v4-stuck2.png`).
- Twin trap: killing by `ps | grep <port>` matched the shell's own cmdline
  (exit 144) — filter on `comm=="electron"` with awk instead. A stale
  port refuses the DevTools bind: move to the next port.
- Soak (12 min, twin, HEVC 720p test file, muted): 75 rounds of seek →
  minimise → two card drags → pause/play → restore, a fresh open every 4th
  round. JS heap sample identical every round (18.4 MB, Chromium's bucketed
  `performance.memory`, so "same bucket", not a precise flat line), zero
  long tasks (>50 ms) over the whole run, zero page errors, at most 3
  dropped frames after a seek, never a stage message. Script:
  scratchpad `soak.js` (rebuild it; the scratchpad vanishes).
- Crash isolation (live): SIGKILL of the converter mid-play at 63.6 s → the
  page kept playing, a new run started at 68 s where the buffer ran out,
  10 s later the position was 73.7 s with no words on the stage. The
  existing starvation refetch (`_mseContinueIfStarved`) plus the server's
  "dead run is not covering" rule is the isolation; no new code needed.
- **Open observation (not reproduced):** once, after a stray drag release
  over the detail page behind the mini card, the twin ended up with a new
  session (an extra `run 0 @0s`), the deck minimised, the `<video>` still
  parented to `#vt-stage` (so the card would be black) and paused at 2:24
  with nobody driving it. Re-opening a play while minimised (deck restores,
  picture on stage — fine) and clicking the collection row did not reproduce
  it. Worth a look if he reports a black mini card after clicking around a
  detail page.

### 14. V4 stability, part 2 — the in-page player's memory fault, 4K, and purist back as the default (2026-09-12, Fable 5.1)

- **He asked for the old behaviour back** ("smooth as butter, not reducing
  the quality, just like before"; also "local films need buffering every
  time I seek"). "Before" is the mpv path, now called Purist mode. The
  default is purist again (`main.js` `_videoSettings` +
  `_migratePlayerModeOnce`: a stored 'smooth' without `playerModeByUser`
  migrates once, stamped `playerModeMigrated`; the Settings selector sets
  `playerModeByUser`). Verified on a twin: stored smooth → purist on launch,
  mpv plays a local file, seek 100 s lands in 1.5 s. Smooth stays a choice.
- **The quota storm (why "Buffering…" kept flashing, even at 1080p):**
  Chromium holds ~150 MB of video in a SourceBuffer — forty seconds of 4K,
  two and a half minutes of 1080p. The engine kept 300 s behind and 90 s
  ahead, so the browser refused appends; the old handler retried in a tight
  loop (14,000 refused appends a second, measured) while the reader piled
  the whole file into a queue (12,800 chunks). `web-player.js` now: keeps
  5 s behind (the disk cache covers seek-back), caps the read-ahead queue
  at 16 MB, and on a refusal frees behind first, then halves the look-ahead
  (`aheadCap`, floor 10 s), cuts beyond it and stops the stream; the
  starvation check refetches from the edge (a cache hit). A hole the
  browser evicted right after the playhead is refetched at the edge. A span
  starting behind the playhead nudges `currentTime` once (Chromium sat at
  readyState 2 with 16 s buffered otherwise). Media-error rebuilds capped at
  3 per session (an AV1 + PGS-burn run refetched the same second 1,012
  times). Tests in `test/web-player-mse.test.js`.
- **4K at 0.86× with nothing dropped — the real cause:** ffmpeg's streaming
  fMP4 (`empty_moov`) writes mvhd.duration = 0; Chromium reads that as a
  *live* stream and decodes in low-delay mode, one thread, no frame
  threading. `fmp4.stampDuration` (src/fmp4-index.js) writes the title's
  duration into mvhd/mehd of the served init segment (`_followRun`). After
  it: four Media decode threads, 4K H.264 at 28 Mbit/s at real time (rates
  1.0/1.0/1.0 before the quota cut that led to the nudge fix). VA-API
  hardware decode (libva-nvidia-driver is installed and decodes the 4K
  HEVC at 1.95× in ffmpeg) crashed Electron's GPU process (exit 133) with
  `--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL` +
  `--ignore-gpu-blocklist`; left behind env gates `PAPA_HW_DECODE=1`
  (`PAPA_HW_DECODE_FEATURES`, `PAPA_HW_DECODE_BLOCKLIST=ignore`) and
  `PAPA_NO_GPU_SAVERS=1` (skips disable-gpu-rasterization/zero-copy; made
  no difference) for the next attempt. Not enabled by default.
- **"Buffering…" honesty:** the engine reports a wait only after 400 ms
  with readyState < 3, and `canplay` sends `ready`, which clears the stage
  even when paused.
- **Open (fixed in §18):** the AV1 (Clockwork Orange) file with a PGS track
  burned in gave "The smooth player could not decode this stream" (now one
  error, not a storm) — the SourceBuffer was typed for AV1 while the burn
  run produces H.264; the burn re-encodes a zero-cost remux through
  libx264 at 981 % CPU because the remembered subtitle preference picked
  the PGS track. (`_videoPlayResult` in purist mode was re-checked with the
  deck's open/ready traced: open → ready resolved → mpv up, position moving
  — the earlier "did nothing" was the harness: the context-bridge `api`
  object is frozen, so a traced `window.api.videoPlay` never installed, and
  `_videoLastState` is only set once `_watch.key` exists.)
- Measuring tips: `requestVideoFrameCallback` gives the true presented fps
  and media rate; `currentTime` alone lied under the retry storm. Front the
  twin (`drive.js front`) and leave the film's detail page first, or a saved
  position seeks under the measurement. Chromium's `performance.memory` is
  bucketed.

### 15. mpv-path soak, silent twins, and roadmap S3 (2026-09-12, Fable 5.1)

- **Silent twins:** `PAPA_VIDEO_AO=null` makes the video mpv use the null
  audio output (`video-engine.js` `_args`, `main.js` engine config). Use it
  on every QA twin: mpv starts at the audio server's remembered stream
  volume before any mute command lands, and a test tone reached the
  speakers once this session.
- **mpv-path soak** (6 min, 23 rounds of seek → minimise → two card drags →
  pause/play → restore, a fresh open every 4th round): zero errors, zero
  stage words, muted throughout, but 8 long tasks, worst 107 ms, all on the
  reopen rounds (`_videoStopAndHide` + `_videoPlayResult` + deck open with
  mpv). Over the 100 ms budget by a hair. A profiled stop-and-reopen on a
  fresh twin showed no long task and under 5 ms of JS (render 3 ms, ready
  1 ms; the rest native), so the soak's hitch was not the reopen's JS —
  possibly a GC or the drags before it. Left as is.
- **Harness quirk:** `_videoStopAndHide()` before anything has ever played
  makes the play that follows in the same tick do nothing on a fresh page;
  guard with `if (_player._state())`. `_videoLastState` is only set once
  `_watch.key` exists; the context-bridge `api` object is frozen, so a
  traced `window.api.videoPlay` never installs.
- **Roadmap S3 shipped:** "Show N more" on Soulseek results appends the next
  page of cards (`_appendSlskUnits`, `_slskShowMore`) instead of rebuilding
  the section; the per-card bindings moved to `_bindSlskCards(root, query,
  groups)` and are applied to a fragment of just the new cards. The first cut
  (render the whole row into a template, move the new cards) still cost
  70 ms: the grouping/scoring/sorting/merging of ~1,000 sources was the
  bulk, not the DOM. So `renderSoulseekRow` leaves its unit list and summary
  inputs in `_slskPipeline` (keyed on query, result count, filter, sort,
  grouping) and the fast path renders only the new cards from it. Measured
  on the twin with a 312-album search: 83 ms (rebuild) → 4 ms per click,
  no long task, three pages in a row, appended cards' buttons live.

### 16. Peer-library speed measured live (2026-09-12, Fable 5.1) — S1/S2 closed

The "bench-only" debt is paid. On a twin (silent, scheduler pinned off,
browse only), opening real peers from a Radiohead search:

| Peer | Library | First tree on screen | Page blocked |
|---|---|---|---|
| n0h0pe | 1,323 folders · 65,615 files | 2.5–3.4 s wall (network + chunked build) | one 58 ms task |
| cloudberry | 1 folder · 5 files | 4.6 s wall | one 96 ms task (odd for 5 files; not chased) |
| Deliberata | never answered in 90 s | — | 0 ms (nothing blocks while waiting) |

Typing "radiohead ok computer" (21 keystrokes) into the 65k-file library's
own search box: zero long tasks, at most 1 ms of synchronous work per
keystroke (the roadmap had 2.4 s per pass). The chunked tree and index
builds (`buildTreeChunked`, `buildTreeSearchIndexChunked`) hold up on a
real library. Trap: `input[placeholder*=earch]` matches the top bar first —
use `#slskx-search`.

### 17. Roadmap S4 (stats) and S5 (tab switches) (2026-09-12, Fable 5.1)

Measured on a silent twin with his profile (long tasks via
PerformanceObserver, CPU profile via `drive.js profile`):

- **Stats page (S4):** open 296 ms, each range chip ~240 ms — all of it
  eight achievement `check`s that rescanned every album's every track for
  every play in the window (Century, Completionist, Variety, Throwback,
  Globetrotter, Genre Explorer, Long Haul, Quick Hit). `renderStats` now
  builds one `filePath → {album, index, track}` map (`_where`/`_hit`) and
  the checks read it. After: open with no long task, chips 28 ms of work,
  no long task. Wrapped already had none. Pin: `test/stats-speed.test.js`.
- **Movies tab switch (S5):** 185–205 ms. Two causes. (1) `_bindRail`'s
  first sync read `scrollWidth` right after the previous rail's class
  toggle: a forced layout per rail. Now reads and writes are split, pending
  rails are checked in one frame after a fill and on any scroll, only rails
  whose row is near the screen are measured, all reads before all writes
  (`_scheduleRailSync`/`_railSyncPass`). (2) `.vrow { content-visibility:
  auto; contain-intrinsic-size: auto 340px }` so rows below the fold are
  neither laid out nor painted until near. After: cold visit 139 ms (TMDB
  rows arriving), warm 60–65 ms, then none; scrolling pays 50–65 ms per
  batch of rows entering. Also: a rail that has not been scrolled sits at
  27.6 px (the 28 px padding the cards snap to), so "at the start" now
  allows 32 px — the left arrow and fade no longer show over the first card.
  Home tab: 60–120 ms, almost all native layout (JS under 20 ms); left.
- **Add to playlist (S6):** 0.5 ms with one playlist of one track — the
  roadmap's 1 s is not reproducible on his current data.
- Trap: `location.reload()` on the twin can serve the old renderer.js from
  the Code Cache — check `_fn.toString()` for the new code or relaunch with
  the profile's `Code Cache` removed.

### 18. AV1 + burned subtitle in smooth mode — fixed (2026-09-12, Fable 5.1)

The "could not decode" on the AV1 Clockwork Orange file (§14, open) was
`CHUNK_DEMUXER_ERROR_APPEND_FAILED: Video stream codec h264 doesn't match
SourceBuffer codecs`: his remembered subtitle preference picked the English
PGS track, the burn run re-encodes the picture to H.264 through libx264,
but the SourceBuffer had been created for the plan's copied AV1 MIME.
`web-stream.open` now returns `burnMime` (the plan with the picture
re-encoded: `avc1.640028,opus` here) and the engine's `_currentMime()` types
the SourceBuffer with it whenever a burned track is on (each burn switch
already rebuilt the media source). Live on a twin: plays with the English
image subtitle drawn in at 3 s; switching it off returns to the copied
AV1 and keeps playing. Test: web-player-mse "switching a burned subtitle…".
Note the burn still costs a full software encode (libx264 at ~980 % CPU on
this 1080p file) — the price of an image subtitle in the page; mpv (purist)
draws PGS natively.

### 19. Sequel bleed in sources fixed; Soulseek search edge guarded (2026-09-12, Fable 5.1)

- `release-name.plausible` now rejects a release whose name carries a
  sequel token right after the title that the request's own variants do
  not ("Steins;Gate 0 - 01", "Steins.Gate.Zero", "Dune.Part.Two",
  "Sousou no Frieren 2 - 05"); "Part One"/"1"/"I" is not a sequel and an
  episode number after " - " is not a token. A film request with a year
  rejects a release naming only other years (±1) — "Dune.1984" and
  "Dune.Part.Two.2024" for Dune 2021; resolutions ("2160p") are not years.
  The requests now carry `year`. Live on a twin: Steins;Gate lists 26
  sources and hides 24, every Steins;Gate 0 release among the hidden; the
  real batches ("Steins;Gate 01-25") stay. Tests in release-name.test.js.
- `slsk-search` IPC: no/blank query answers `{ results: [], error: 'No
  search text' }` instead of a raw TypeError (roadmap W-T input validation;
  `test/ipc-input-guard.test.js`). Other edges were not swept.

### 20. Roadmap S8 and the queue panel (2026-09-12, Fable 5.1)

- **S8, following-row art:** the circle painted blank until the photo
  arrived because the silhouette fallback was `display:none` whenever an
  art path existed. The silhouette now stays as the placeholder and the
  photo (absolute, opacity 0) fades in over it on `load`; a failed photo
  removes itself. Both templates (library artists, YouTube artists).
  Test: following-art-placeholder.test.js.
- **Queue panel reopen centres the playing track:** `renderQueuePanel`
  nudged the row with `block:'nearest'` and then restored the panel's old
  scrollTop, so on open the row sat just below the fold. `toggleQueuePanel`
  sets `state._queueJustOpened`; that render skips the restore and scrolls
  the playing row to `block:'center'`; live re-renders keep their position.
  Live on a twin: the following row's five photos fade in over their
  silhouettes (no blank circles); the queue panel opened with the playing
  row in view and centred — but his 14-track queue fits the panel without
  scrolling, so the centring itself is only unit-pinned, not proven live.

### 21. Empty-state echo clamp (2026-09-12, Fable 5.1)

`_shortQ(q, max = 60)` clamps what an empty state echoes back (whitespace
collapsed, 60 characters and an ellipsis): the video search "No matches
for…", the library search "No results for…", the two artist snackbars,
and the assistant's "Nothing found…" replies (Soulseek, library, YouTube
×3). The roadmap's "settings filter with no matches shows a blank panel"
could not be located — there is no settings filter input by any of the
names tried; treat that line as stale. Test: empty-state-echo.test.js.

### 22. Every season, sequel, prequel and side story on an anime's page (2026-09-12, Fable 5.1)

He opened an anime and saw no seasons at all. Two causes, both fixed:

- **The card came from the Jikan fallback** (`mal-9253`, source `mal`), and
  `anilist.seasonChain(Number('mal-9253'))` was a walk from NaN — empty.
  The chain now resolves a MAL/Kitsu card first: AniList `Media(idMal:)`
  (new `byMal` query), else a title search picking the exact-title hit.
  The request carries `idMal` and `title` from the renderer. When AniList
  gives nothing, `jikan.seasonChain(mal)` walks MAL's own `/relations`
  graph (ids stay `mal-<id>` so navigation routes back to Jikan).
- **Only PREQUEL/SEQUEL were walked.** AniList links Steins;Gate to
  Steins;Gate 0 only through an ALTERNATIVE OVA, so the second series was
  never reached. Both chains now walk the whole franchise breadth-first
  (prequel, sequel, side story, spin-off, alternative, parent, summary…)
  under a request budget (`capped`, cacheable; `truncated` only on a failed
  hop). Seasons = television entries on the story's own line (reached
  through prequel/sequel/parent/alternative/summary edges); a side story or
  spin-off, even a TV one, and everything else (films, OVAs, ONAs, the
  wider universe via OTHER/CHARACTER) is `related`, each with its relation.
- **The page shows a Related rail** under Seasons (`_relatedRailHtml`,
  `_relationWord`: "Side story · film", "Alternative · OVA", "Shares
  characters"), shown even when there is only one season.
- Live on a twin (AniList reachable): Steins;Gate → Seasons: Steins;Gate
  2011 · 24 ep, Steins;Gate 0 2018 · 23 ep; Related: the film, Egoistic
  Poriomania OVA, Cognitive Computing ONA, 23β, Valentine's OVA, Sonico,
  ChäoS;HEAd, Robotics;Notes, Occultic;Nine. The Jikan path is unit-tested
  (jikan.test.js), not seen live (AniList was up).
- V2.6 "Approved" chip: it is the certificate — "Approved" is a real
  pre-1968 MPAA rating. `_certLabel` prefixes word-style certificates
  ("Rated Approved") and both chips carry `title="Age rating"`.

## 7. Open debt and outstanding items

- **Peer-library speed** measured live on a 65k-file peer (§16): one 58 ms
  block on open, none while typing. A ~140k-file peer is still unmeasured.
- **Android Wave A2** not started: multi-server switch UI, download-to-PC
  mode, network-switch download UX.
- **Phone pairing unconfirmed by him.** IP `192.168.18.4`, port `8765`,
  token `23820273263ac5dcd47f16b4e981c12b`. The setup screen text was fixed
  (`~/papa-audio-android/app/setup.tsx`) — it used to tell him to run
  `node server.js`, which is wrong; the bridge starts with the app.
- **He must restart the desktop app** to pick up everything in §4.
- **DSD playback** still can't actually play — it only skips politely now.
  He was offered a transcode-to-a-supported-rate fix and hasn't answered.
- A safety classifier once blocked grepping `slskd.yml` for credentials.
  Don't work around it; use the scheduler state file and source instead.

## 8. Resume protocol

Session state also lives in memory at
`~/.claude/projects/-home-shaharyar-claude-desktop-debian/memory/elite-campaign-state.md`
— keep it updated as waves land, so the next cut-off is survivable.

He said: **"keep the progress saved as we go so when the session limit ends,
everything is saved and we can continue."** Honour that: commit and push each
verified wave, and update the memory file and this handoff as you go.

His standing greenlight is **"lets do it"** — the campaign is approved. Pick
up at J2 + J3.
