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

1. Inspect keyboard input ownership (V104/V105) and countdown focus (V036).
2. Run combined player/mini/keymap regression suites after changes.
3. Validate gesture behavior in the real desktop app on web and native paths.
   Especially test slow double-click settings: the 300 ms arbitration interval
   may need an accessible configurable preference. Do not claim V102 complete
   across native mpv merely because the page handlers pass.
4. Verify seek cancellation and delayed commands do not cross video sessions.
5. Keep this file updated with exact tests, outstanding risks, and push status.

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
