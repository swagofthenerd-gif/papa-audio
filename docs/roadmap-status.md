# Roadmap status ledger

Tracks the two experience roadmaps against `feature/papa-video`, which is a strict
superset of `main` (225 commits ahead, nothing behind as of 2026-09-15). Both
roadmaps are checked in beside this file:

- `roadmap-audio-160.md` — items 001–160 (written against `main` @ `e8e6013`)
- `roadmap-video-150.md` — items V001–V150 (written against this branch @ `4f40eb4`)

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
| 001 | Confirmed (softer) | Wizard can be finished with no folder, but reappears every launch until one is set (`renderer.js` `_initSetupWizard` finish comment). |
| 004 | **Fixed** `55143ea` | Queue panel "Clear queue" pauses audio and drops the current track (`renderer.js` ~17487); same in the `clear-queue` command (~29535). No "clear upcoming". |
| 005 | Confirmed | `#content` wheel handler converts vertical `deltaY` into `scrollLeft` on `.scroll-row` (~28120). |
| 008 | **Fixed** `9d801e0` | `index.html` ~1156 hard-codes `dnf`/`apt`/`pacman`; `renderer.js` ~5240 says "run: sudo dnf install mpv". No macOS/Windows text. |
| 012 | **Already satisfied** | `styles.css` uses local `@font-face` → `assets/fonts/Poppins-*.woff2`; no Google Fonts import anywhere. |
| 043 | Confirmed as described | `playAlbum`/`playTrack` replace the queue; policy item, not a bug. |
| 087 | Confirmed | `renderer.js` ~12489 still shows "visual only — save to file coming soon". |
| 093 | **Fixed** `1da705b` | `updateBitPerfectBadge` (~1230) labels any non-http track LOSSLESS with no codec check. |
| 134 | Confirmed | `main.js` `minWidth: 950`. |
| V101 | **Fixed** `af4d25b` | `bindMiniDrag`: `pointercancel` → `endDrag`, which contains the tap-to-toggle and fling paths (~789–836). |
| V102 | **Fixed** `2d1f1c9` | Stage has `click` → `togglePlay()` and `dblclick` → `toggleFullscreen()`; a double-click issues two play toggles (~2610–2620). |
| V103 | **Fixed** `ff8a02b` | Deck and stage wheel use `deltaY > 0 ? -5 : 5`: zero delta = volume up; horizontal-only scroll changes volume (~2593, ~2626). |
| V111 | Confirmed | `watch-rules.js`: `STARTED_AT 0.05`, `MIN_SECONDS 30`, `WATCHED_AT 0.92`. |

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

## Still open from the F list, in suggested order

- **005** (P1) vertical wheel → horizontal rail: `#content` wheel delegate at `renderer.js` ~28120. Same shape as V005.
- **087** (P0 by roadmap, verify scope first): `editField` "visual only" path; other tag writers exist (`flac-tags.js`) — map every entry point before changing copy.
- **001** (P1) wizard reappears every launch until a folder is set.
- **134** (P1) 950px minimum window width — needs a layout audit, not just a number change.
- **V111** (P1) resume thresholds in `watch-rules.js` — a policy decision; evaluate with real film lengths before changing.

## Verification scope — read before trusting the table

Everything above is unit/behavioural tests under Node and reading the source.
Nothing has been run in the Electron shell on this Mac yet (mpv is not
installed here; `npm ci --ignore-scripts` skipped Electron's binary). Items
153–160 and V141–V150 remain unmeasured.
