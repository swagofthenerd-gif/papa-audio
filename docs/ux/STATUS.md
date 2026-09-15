# Roadmap status ledger

Tracks the two experience roadmaps against `feature/papa-video`, which is a strict
superset of `main` (225 commits ahead, nothing behind as of 2026-09-15). Both
roadmaps are checked in beside this file:

- `Papa-Audio-UX-Roadmap.md` — items 001–160 (written against `main` @ `e8e6013`)
- `Papa-Video-Movies-TV-Anime-UX-Roadmap.md` — items V001–V150 (written against this branch @ `4f40eb4`)

IDs are stable. A row moves to **Already satisfied**, **Fixed** (with commit),
**Deferred** or **Rejected** only with the evidence beside it. Everything not
listed here is still *Proposed / awaiting verification*.

## Baseline (2026-09-15)

- Tests: 4350 pass, 0 fail, 2 skipped (real-mpv integration) — **requires Node ≥ 22.23**.
  Node 22.14's experimental `MockTimers` does not stop an interval that clears
  itself from inside its own callback, which made `video-player.test.js`
  "activity during the run resets the Still watching counter" fail spuriously.
  `.node-version` and `engines` now say so. Not an app bug.
- One real bug found while establishing the baseline, fixed in `dd2deed`:
  `providers/mirror-race.js` unref'd its backstop timer, so a race in which every
  mirror hung could never time out (6 tests were cancelled on every run).

## Source-finding (F) reconciliation

Each F item re-checked on this branch, not assumed from the `main` review.

| ID | Status | Evidence on this branch |
|---|---|---|
| 001 | **Fixed** `58e0b7e` | Wizard can be finished with no folder, but reappears every launch until one is set (`renderer.js` `_initSetupWizard` finish comment). |
| 004 | **Fixed** `55143ea` | Queue panel "Clear queue" pauses audio and drops the current track (`renderer.js` ~17487); same in the `clear-queue` command (~29535). No "clear upcoming". |
| 005 | **Fixed** (see work log) | `#content` wheel handler converts vertical `deltaY` into `scrollLeft` on `.scroll-row` (~28120). |
| 008 | **Fixed** `9d801e0` | `index.html` ~1156 hard-codes `dnf`/`apt`/`pacman`; `renderer.js` ~5240 says "run: sudo dnf install mpv". No macOS/Windows text. |
| 012 | **Already satisfied** | `styles.css` uses local `@font-face` → `assets/fonts/Poppins-*.woff2`; no Google Fonts import anywhere. |
| 043 | Confirmed as described | `playAlbum`/`playTrack` replace the queue; policy item, not a bug. |
| 087 | **Fixed** (see work log) | `renderer.js` ~12489 still shows "visual only — save to file coming soon". |
| 093 | **Fixed** `1da705b` | `updateBitPerfectBadge` (~1230) labels any non-http track LOSSLESS with no codec check. |
| 134 | **Deferred to the runtime pass** — CSS has 900/600 px breakpoints the 950 px floor hides; needs the app running to judge | `main.js` `minWidth: 950`. |
| V101 | **Fixed** `af4d25b` | `bindMiniDrag`: `pointercancel` → `endDrag`, which contains the tap-to-toggle and fling paths (~789–836). |
| V102 | **Fixed** `2d1f1c9` | Stage has `click` → `togglePlay()` and `dblclick` → `toggleFullscreen()`; a double-click issues two play toggles (~2610–2620). |
| V103 | **Fixed** `ff8a02b` | Deck and stage wheel use `deltaY > 0 ? -5 : 5`: zero delta = volume up; horizontal-only scroll changes volume (~2593, ~2626). |
| V111 | **Fixed** (see log) | `watch-rules.js`: `STARTED_AT 0.05`, `MIN_SECONDS 30`, `WATCHED_AT 0.92`. |

## Work log

| Date | IDs | Commit | Result |
|---|---|---|---|
| 2026-09-15 | baseline | `dd2deed` | mirror-race backstop fixed; suite green on Node 22.23 |
| 2026-09-15 | V103 | `ff8a02b` | wheelDirection(): zero/horizontal ignored, trackpad deltas accumulate to a 40px notch; 4 behavioural tests |
| 2026-09-15 | V101 | `af4d25b` | pointercancel/lostpointercapture → cancelDrag: no tap, no fling, corner kept; 2 tests that fail on the old code |
| 2026-09-15 | V102 | `2d1f1c9` | 250 ms click arbitration on theatre and mini picture; double-click no longer sends two stale play/pause commands; 4 tests |
| 2026-09-15 | 004 | `55143ea` | Clear upcoming / Clear played / Stop and clear; ext command `clear-upcoming`; music-tools helper + tests |
| 2026-09-15 | 008 | `9d801e0` | src/install-hints.js; preload exposes platform; blocker, start-honesty, _videoErrorText and sysdeps-advisor all OS-aware |
| 2026-09-15 | 093 | `1da705b` | src/quality-badge.js: codec-checked LOSSLESS, full-chain BIT-PERFECT, honest tooltip; refreshes on every relevant change. Also fixed: ReplayGain 'no' vs 'off' mismatch |

| 2026-09-15 | merge | `ecd8ff0` | parallel-session checkpoint merged (V104/V105/V036/V027/V073/V076/V080/V074 partial); wheel notch corrected to 40 px |
| 2026-09-15 | 005 | see log | rowWheelDelta: vertical wheel scrolls the page; rows get the video rail arrows via MutationObserver |
| 2026-09-15 | 087 | see log | album hero edits write real tags through library-write-tags with an explicit scope note; heroTagWrites + tests |
| 2026-09-15 | 001 (+013/017 copy) | `58e0b7e` | wizard offers Add / Explore / Later, remembers the answer, init continues with zero folders |
| 2026-09-15 | 002 | see log | Settings nav entry + openSettings(section); drawer titled Settings on that tab |
| 2026-09-15 | V111 | see log | resume: 5 % threshold capped at 120 s; long films resume |
| 2026-09-15 | 114 (+116 part) | `157ddc1` | player-bar seek/volume are ARIA sliders with keys; seek value written only on whole-percent change |
| 2026-09-15 | 040, 045 | see log | prevAction (3 s rule, in help); insertPlayNext single rule; ctx Play next re-arms prefetch |
| 2026-09-15 | 057 | `890a469` | src/source-failure.js: cancelled/offline/rate-limited/auth/timeout/unreachable/empty each with a next step; YouTube + Soulseek |
| 2026-09-15 | 081 | see log | one "Album ready" notice per album (summary above 3), click plays it |
| 2026-09-15 | 051 | `92584be` | playlist duplicates skipped by default, "Keep both" offered |
| 2026-09-15 | 048 | `6ba664c` | missing queue file stays, badged, Locate/Remove; playback plays past it |
| 2026-09-15 | 084 | `2e01d08` | unreachable root keeps its albums flagged unavailable; track-exists says "drive not connected" |
| 2026-09-15 | 079 | `bfb2d44` | src/dl-capacity.js: space + writability checked before enqueue; Choose folder / Download anyway |
| 2026-09-15 | 136 | `20689d5` | src/redact.js: logger scrubs at write; bundle scrubs log tail, crash log, diagnostics; broader key rule |
| 2026-09-15 | 106 | `037e34b` | assistant Stop releases at once, aborts provider request (agent-cancel), names in-flight tool |
| 2026-09-15 | 110 | `ece3972` | src/agent-disclosure.js beside the provider choice; main scrubs local paths + secrets from cloud-bound messages |
| 2026-09-15 | 137 | `54971c2` | src/slsk-share.js: library / downloads only / nothing; Settings group; wizard copy corrected |
| 2026-09-15 | V012 | `3d58e3b` | detail hero reads Play or Resume from <time>; Start over erases nothing until playback starts |
| 2026-09-15 | V097 | `bf9c785` | ■ reads "Stop and close"; help says Esc backs out one level and never stops |
| 2026-09-15 | 096 | `578f3e5` | src/gain-policy.js: summed gain + clipping verdict under Volume boost |
| 2026-09-15 | 034 | `4f045cd` | refused Play reverts + says why; silent Play reported (not asserted) after 6 s |
| 2026-09-15 | 038 | `273a9d8` | device loss → respawn resumes paused (policy setting); Keep playing one click |
| 2026-09-15 | 139 | `ef3789a` | pre-migration backup on version change (userData/migration-backups, keep 3); docs/RECOVERY.md |
| 2026-09-15 | 037 | `54d84c0` | suspend remembers track+position; resume stays paused and offers the place back |
| 2026-09-15 | V052 | `726414d` | inferred vs measured source badges; engine passes demux-channel-count |
| 2026-09-15 | V113 | `7e5dd3a` | pause is a position checkpoint (close/pagehide flush already existed) |
| 2026-09-15 | V109 | `9ef44c1` | player.isOpen(); media keys route to the video session when one exists |
| 2026-09-15 | V082 | `356f05c` | refused track switch reverts the tick and reports |
| 2026-09-15 | V123 | `f429e67` | evictPlan protects the playing file |
| 2026-09-15 | V125 | `212b659` | keep checks space first; ENOSPC removes the partial file |
| 2026-09-15 | V121 | `0a86fd5` | SAVED / CACHED / INSTANT badges |
| 2026-09-15 | V132 | `87ce8d7` | aria-pressed/labels on deck toggles; aria-haspopup on menu openers |
| 2026-09-15 | V129 | `0e60fd1` | "Who receives what" disclosure in Video settings |
| 2026-09-15 | 021 | `2d47c50` | first download of a session names destination + free space |
| 2026-09-15 | 019 | `94eec8a` | libraryEmptyState: no folder / not connected / no music / filtered |
| 2026-09-15 | 083, 085 | `71abddb` | guided relink: dead paths → longest-tail matching → preview → remap every store + cache |
| 2026-09-15 | 091 | `3668f0b` | move journal; startup recovery finishes or undoes an interrupted move |
| 2026-09-15 | V045 | `2037c8d` | validateSegments: outside-file dropped, mismatched edition → button only; cache keyed by length |
| 2026-09-15 | V055 | `012c192` | pack pick verdict; unmatched episode is announced |
| 2026-09-15 | V037 | `e1e9fc4` | unaired next season → honest end, no Up Next |
| 2026-09-15 | V041, V042 | `58293d6` | numbering line above sources; override dialog previews mapping, progress untouched |
| 2026-09-15 | V034 | `90c2816` | double-episode ranges; SP/Special tags stripped |
| 2026-09-15 | V088 | `5428081` | online subs scored against the playing release; source + sync verdict on the row |
| 2026-09-15 | 128 | see log | ticker: tooltip, pause on hover, off under reduced motion |
| 2026-09-15 | 121 | `f1f37c3` | unicode-bidi: plaintext on metadata elements |
| 2026-09-15 | 130 | `36366fc` | ▶ on playing rows; outline + ✓ on selected rows |
| 2026-09-15 | 050 | `8a69303` | bulk Remove from playlist with count + undo; × undoable |
| 2026-09-15 | 047 | see log | shuffle next-pick line; order kept |
| 2026-09-15 | 044 | see log | queue header: time left · total |
| 2026-09-15 | 049 | `e8d95f1` | saved queue keeps index + position; resumes there; labels explain session vs collection |
| 2026-09-15 | 080 | see log | Cancel/Remove/Retry tooltips state outcomes |
| 2026-09-15 | 041 | `b4c4997` | sleep panel states timer, +15, stop-after interaction |
| 2026-09-15 | 098 | `5a988f3` | device fallback remembered; "Active now" line; BIT-PERFECT demoted |
| 2026-09-15 | 082 | `b6fb102` | wishlist rows: auto/notify, pause, last check, cadence |
| 2026-09-15 | V067 | see log | badges: HDR shown as SDR / video re-encoded / audio re-encoded; remux silent |
| 2026-09-15 | 086 | see log | duplicate groups classified: identical / recordings / editions; editions never safe to delete |
| 2026-09-15 | 056 | `7f8357c` | Show all N songs lifts the local search cap |
| 2026-09-15 | 118, 046 | `75a9e17` | queue Move up/down via context menu and Alt+↑/↓ |
| 2026-09-15 | merge | `5d3a166` | other session's debrid work (0d26dc3, 18be92b, 48d1799) merged; suite green |
| 2026-09-15 | 088 | `c5fcbb1` | artwork preview: current vs new, measured resolution, scope stated |
| 2026-09-15 | 089 | `285be09` | track artist leads on compilations; Disc N of M |
| 2026-09-15 | 092 | see log | m3u8For: absolute paths, streams as comments, counts; liked-songs export |
| 2026-09-15 | 095, 097 | `11e3e2c` | ReplayGain / exclusive explained in labels and hints |
| 2026-09-15 | 094 | see log | signal-path tooltip on the stats row; device rate marked not measured |
| 2026-09-15 | 103 | `7e5d047` | agent welcome built from real connections; names what is off |
| 2026-09-15 | 109 | see log | per-insight edit / delete / exclude; excluded keys never relearned |
| 2026-09-15 | 111 | `d18d8fe` | provider failures classified with next step; Open Settings action |
| 2026-09-15 | 104 | see log | auto_download / clear_queue previewed unless the request named them |

## F list: all resolved (134 deferred to runtime). Now working through P0 E-items


## Verification scope — read before trusting the table

Everything above is unit/behavioural tests under Node and reading the source.
Nothing has been run in the Electron shell on this Mac yet (mpv is not
installed here; `npm ci --ignore-scripts` skipped Electron's binary). Items
153–160 and V141–V150 remain unmeasured.
