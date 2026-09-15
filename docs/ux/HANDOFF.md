# UX implementation handoff

Branch: `ux/video-interaction-foundations`
Base: `feature/papa-video` at `4f40eb46c4c69d4236cee2e528e0c649832461fa`.

## Start here

Read both roadmap files in this directory. The music roadmap reviewed an older
main-branch snapshot; reconcile it with this newer video branch before editing.
User authorized implementation and saving plans/progress to GitHub. Do not
replace the video branch with main. Preserve existing features and tests.

## First batch: V101, V102, V103 (partial; hardware verification pending)

- Mini-player pointer cancellation and lost capture no longer follow tap/release
  actions. Cancel returns to the saved anchor without committing a new corner.
- Picture single clicks are deferred 300 ms to arbitrate double clicks. Explicit
  play buttons remain immediate. Pending taps clear on open/close/minimize/restore.
- Wheel volume ignores zero, horizontal, modifier/pinch, and menu/form input;
  small deltas accumulate to 120 pixels per 5 volume points. Line units normalize.
- Added nine behavioral regression tests in `test/video-player.test.js`.

Validation: existing video-player + video-mini suite passed 179 tests before
adding regressions; all nine new regressions passed separately. No desktop,
real pointer hardware, native mpv relay, or actual audio/video validation yet.

## Next work

1. Verify cancellation restoration, double-clicks, keyboard ownership and focus
   countdown in the desktop app on both web playback and native mpv.
2. Review V073 seek accessibility against actual DOM and keyboard behavior.
3. Check slow OS double-click settings; fixed 300 ms arbitration is still limited.
4. Continue the complete PROGRESS.md tracker against both original roadmaps.
5. Save a fresh checkpoint after each batch. GitHub push needs authenticated access.

No roadmap item is marked fully done solely on fake-DOM tests.

## Second batch: V104/V105 and V036 (partial)

- Document keyboard handling now respects defaultPrevented and IME composition.
- Space/Enter on a focused button stays with that button's native activation.
- Up Next countdown pauses for keyboard focus independently of mouse hover.
- Three more behavioral tests added (12 new regressions total).

Final targeted validation: `node --test test/video-player.test.js test/video-mini.test.js test/video-keymap.test.js`
passed **204/204**. `git diff --check` passed. No whole-app or real-device test
has been run. Next priorities remain actual DOM/native gesture validation and
seek cancellation/session-lifetime review. Fixed 300 ms double-click arbitration
is a known limitation for slower OS double-click settings.

## Remote checkpoint status

GitHub push was attempted and FAILED: no GitHub authentication was available
(`could not read Username for https://github.com`). The branch is committed
locally, not published. Public repository visibility permits reads, not writes.
A portable checkpoint archive accompanies this handoff and contains the git
bundle, patch series, both plans, and recovery instructions. Import it into an
authenticated checkout and push the named branch; do not assume it exists online.

## Third batch: seek/session and thumbnail correctness (V027/V073/V076/V080)

- Opening/closing a title invalidates pending thumbnail responses and cancels
  queued keyboard/live-scrub commands.
- Thumbnail responses only paint for the current requested bucket/session;
  missing previews clear unrelated images instead of implying a wrong scene.
- Theatre seeks enforce primary-button/pointer ownership; lost capture cancels
  trailing work. Mini seek releases from an older title cannot seek the next one.
- Seven new behavioral regressions. Combined targeted suite now **211/211 passed**
  (19 new tests across all three batches). `git diff --check` passed.
- Cancellation currently keeps the last already-sent live preview position;
  it does not undo engine seeks already completed before cancellation. Full V073
  pre-drag-position restoration remains a product decision and implementation task.
- No real desktop/hardware verification yet; GitHub still not authenticated.

## Fourth batch: restore cancelled seek previews (V073 partial)

- Both seek bars remember the playback position at gesture start. Cancelling a
  preview drag or losing pointer capture seeks back to that position once.
- A cancelled press without preview leaves progressing playback alone.
- Cancellation from an old title cannot restore a position into a new title.
- Six regression tests cover both bars, engine position updates, queued previews,
  late release/lost capture, and title changes. No pause command is introduced.
- Supersedes the third-batch limitation about retaining the preview position.
  Actual engine restore success and native pointer delivery still need desktop tests.
- Added PROGRESS.md with all 310 item IDs. Original requirements remain intact.

Validation after fourth batch: **217/217 targeted tests passed** using
`node --test test/video-player.test.js test/video-mini.test.js test/video-keymap.test.js`.
`git diff --check` passed. 25 new regressions across four batches. Full suite and
real desktop playback have not been tested. GitHub publication remains blocked
by missing authentication; the checkpoint preserves the local branch and plans.

## Fifth batch: keyboard seeking consistency (V074/V104/V105 partial)

- Both seek sliders now share Left/Down (-10s), Right/Up (+10s), Page Down/Up
  (-/+60s), Home (start) and End (duration) controls.
- Mini-player key repeats accumulate against the pending target and show it in
  the slider and accessible value even while stale engine updates arrive.
- Home/End and new pointer gestures cancel queued keyboard seeks, preventing a
  delayed command from overriding the newer action.
- Slider keys respect IME, handled events, and Ctrl/Meta/Alt combinations.
  Unknown duration and active pointer dragging do not accept keyboard seeks.
- Eight new regression tests; **225/225** targeted player/mini/keymap tests pass.
  `git diff --check` passed. Real desktop, screen-reader and native mpv validation
  remain outstanding; no full-suite test or GitHub publication claimed.
- Next: validate the above in desktop; inspect focus and keyboard behavior in
  chapter/track menus (V077), including Escape and focus return. Preserve all 310
  requirements and continue updating PROGRESS.md with evidence per batch.

## Merge with the parallel session (2026-09-15)

A second session worked from the same base in parallel. It also did V101–V103
(dropped in favour of this branch's versions, which go further), and separately
did music 004, 008, 093, a mirror-race timeout bug, and a Node-version pin. See
`STATUS.md` in this folder for its ledger. Two corrections carried into this
branch from that merge:

- **Wheel notch is 40 px, not 120.** A Chromium mouse detent is ~100 px, so the
  120 px rule meant one click of a real mouse wheel changed nothing. Now any
  single event of ≥ 40 px is exactly one step (mouse unchanged from before),
  sub-notch trackpad deltas accumulate, and a large flick is still one step.
- **The full suite was never run here.** Only three test files were. On the
  full suite this branch had one failing wiring test (`mini-motion-wiring`,
  asserting the old double-click source) and six cancelled mirror-race tests
  (a real bug: an unref'd backstop timer). Both are fixed after the merge.
  Run `node --test 'test/**/*.test.js'` on Node ≥ 22.23 before every checkpoint.
