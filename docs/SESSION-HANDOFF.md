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
6. Remaining V2: 2.5 small fixes (decade parity, collection order, WATCHING wording, diary undo, dashes, Untitled card, global-search strip), 2.6 "Approved" chip reproduce, 2.7 inline trailer, 2.8 detail-page keys. Then V3 polish, V4 stability. Seen but not fixed: sequel bleed (Steins;Gate 0 sources listed for Steins;Gate). One dropped video frame per reparent (minimise/restore) is measured and accepted.
7. Open question: the user's own app (was back up with its SingletonLock by 17:20Z) was not running at 16:15Z on 2026-09-11 with no quit line in its log; nothing in this session targeted it, but tell him.
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

## 7. Open debt and outstanding items

- **Peer-library speed is bench-only.** Re-measure live against a real
  ~140k-file peer.
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
