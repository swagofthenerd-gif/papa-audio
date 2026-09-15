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
| 004 | Confirmed | Queue panel "Clear queue" pauses audio and drops the current track (`renderer.js` ~17487); same in the `clear-queue` command (~29535). No "clear upcoming". |
| 005 | Confirmed | `#content` wheel handler converts vertical `deltaY` into `scrollLeft` on `.scroll-row` (~28120). |
| 008 | Confirmed | `index.html` ~1156 hard-codes `dnf`/`apt`/`pacman`; `renderer.js` ~5240 says "run: sudo dnf install mpv". No macOS/Windows text. |
| 012 | **Already satisfied** | `styles.css` uses local `@font-face` → `assets/fonts/Poppins-*.woff2`; no Google Fonts import anywhere. |
| 043 | Confirmed as described | `playAlbum`/`playTrack` replace the queue; policy item, not a bug. |
| 087 | Confirmed | `renderer.js` ~12489 still shows "visual only — save to file coming soon". |
| 093 | Confirmed | `updateBitPerfectBadge` (~1230) labels any non-http track LOSSLESS with no codec check. |
| 134 | Confirmed | `main.js` `minWidth: 950`. |
| V101 | Confirmed | `bindMiniDrag`: `pointercancel` → `endDrag`, which contains the tap-to-toggle and fling paths (~789–836). |
| V102 | Confirmed | Stage has `click` → `togglePlay()` and `dblclick` → `toggleFullscreen()`; a double-click issues two play toggles (~2610–2620). |
| V103 | Confirmed | Deck and stage wheel use `deltaY > 0 ? -5 : 5`: zero delta = volume up; horizontal-only scroll changes volume (~2593, ~2626). |
| V111 | Confirmed | `watch-rules.js`: `STARTED_AT 0.05`, `MIN_SECONDS 30`, `WATCHED_AT 0.92`. |

## Work log

| Date | IDs | Commit | Result |
|---|---|---|---|
| 2026-09-15 | baseline | `dd2deed` | mirror-race backstop fixed; suite green on Node 22.23 |
