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

### The queue, in order

1. ~~J2 + J3~~ done — see above. This is his
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
