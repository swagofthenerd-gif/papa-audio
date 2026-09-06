# Overlay controls window over the mpv picture (roadmap #26)

Status: **shipped behind a toggle, default OFF.** The full feature is built and
proven working at the machinery level; the one thing that could not be verified
without the user's eyes is the on-screen z-order of two sibling XWayland child
windows on this fractional-scaled dual-monitor KDE Wayland session. Flip
`Controls on the picture (overlay)` in the theatre settings menu to try it.

## What #26 is

The mpv picture is a native child `BrowserWindow` (`_videoSession.win`) that mpv
renders into via `--wid` (XWayland X11 window id). A native child window is
composited **above** the page, so HTML the renderer draws "over" the video is
invisible behind it. That is why the theatre has always used "held rows" — the
control deck sits **beside/below** the stage, never on the picture. #26 removes
that compromise: put the controls **on** the picture like every normal player.

## Approach taken

A **second** transparent, frameless, non-focusable child `BrowserWindow`
(`_videoSession.overlay`), parented to the main window, layered over the mpv
surface and kept there:

- Mirrors the mpv surface's window options exactly (`transparent: true`,
  `backgroundColor: '#00000000'`, `frame: false`, `hasShadow: false`) — the
  same transparency rationale documented on `_videoWindow()` (an opaque host
  repaints over what's beneath it).
- `focusable: false` — the deck, shortcuts and skip buttons live in the main
  window; a focused overlay would starve them exactly as a focused mpv window
  would.
- Click-through by default via `setIgnoreMouseEvents(true, { forward: true })`.
  The overlay page watches `mousemove` (which keeps flowing because of
  `forward: true`) and toggles pass-through **off** only while the pointer is
  over a `.hot` control surface, back **on** when it leaves — the documented
  Electron forward pattern.
- Kept above the surface with `setAlwaysOnTop(true, 'screen-saver')` +
  `moveTop()`, re-armed on every reposition (a sibling child showing/moving can
  re-order the stack on some compositors).
- Positioned in lockstep with the mpv surface: `_positionOverlayWindow()` is
  called from inside `_positionVideoWindow()`, so the two never drift — through
  resize/move/fullscreen follow, mini (PiP) mode, minimise/restore and teardown.

Files:
- `src/overlay-window.html` — the on-picture UI: bottom control bar (play/pause,
  seek with position fill + knob, current/total time, volume bar + mute,
  fullscreen) and a top title gradient. Auto-hides after 3 s of stillness.
- `src/overlay-preload.js` — a slim bridge exposing exactly `onState`, `control`,
  `onTitle`, `setIgnore`. **No new engine channels**: playback verbs are replayed
  through main's shared `_invokeVideoControl` — the identical path the theatre
  deck uses.
- `main.js` — `_overlayWindow()`, `_positionOverlayWindow()`, show/hide/close,
  `_overlaySend()`, and two main-only IPC channels: `overlay-control`
  (invoke, guarded to the overlay's own webContents) and `overlay-set-ignore`
  (send). The `video-control` switch was lifted into `_invokeVideoControl` so
  both the renderer handler and the overlay share one source of truth.
- `src/video-player.js` — a feature-detected `Controls on the picture (overlay)`
  toggle in the settings menu, reading/writing `videoConfig.overlayControls`
  (default OFF). The held-rows deck stays as the always-available fallback.

Fullscreen from the overlay is relayed to the deck through the existing
`video-event {kind:'key', action:'fullscreen'}` channel, so the theatre's own
`toggleFullscreen` runs (the one that re-measures the stage and re-lays the
surface). A "back/minimise" button was **deliberately dropped**: minimise is a
renderer-UI action (`src/renderer.js`) which this work is not permitted to touch,
and shipping a button wired to a no-op or a destructive stop would have been
worse than not shipping it. The deck below still carries stop and minimise.

## What is proven (headless, on this machine)

Run from `/tmp/.../scratchpad/overlay-live.js` against the real HTML + preload:

- Overlay window creates with transparency intact (`capturePage`: top pixel
  alpha 0, control bar renders solid), click-through and always-on-top set
  without throwing.
- The live state stream renders: `754s/9000s → "12:34 / 2:30:00"`, seek fill
  8.38%, volume fill 85%, play icon reflects `paused:false`.
- Title paints in the top gradient.
- Controls round-trip through IPC: clicking play sent `{verb:'pause'}`; a
  volume-bar click at mid-bar sent `{verb:'volume', value:49}`.
- Preload exposes exactly `onState, control, onTitle, setIgnore`. Zero console
  errors.
- `npm test`: the 372 tests over the changed files pass; `npm run e2e`: 8/8
  (the overlay is never created on the e2e path because it defaults OFF).

## What blocked the default-ON promotion

**On-screen z-order of two sibling XWayland child windows could not be verified
headlessly on this display.** The session is KDE Plasma on **Wayland** with
**fractional scaling 1.7** on the primary monitor (`kscreen-doctor`: DP-3 scale
1.7, DP-2 scale 1.0) across a **dual-monitor** framebuffer (physical 8358×2542).

- `import -window root` and `spectacle -f` both capture the union framebuffer,
  but the known-good mpv surface (a solid coloured child window in the probe)
  could **not** be located as a solid block at its reported logical coordinates
  — the logical→physical mapping through fractional scaling + the multi-monitor
  offset does not line up with a naive `bounds × scale`, and transparent
  `showInactive` child windows may not land in the grab where expected. Since the
  grab cannot even find the surface that demonstrably displays in the real app,
  it cannot be used to prove or disprove the overlay's stacking. It is a
  measurement failure, not evidence of a stacking failure.

This is the exact class of problem the roadmap flagged: "transparent
always-on-top child windows on Wayland/KDE can misbehave." The machinery is
sound; whether KDE's compositor keeps the transparent child reliably above the
mpv child **on screen**, and whether click-through hits the picture beneath, is a
30-second visual check the user can do that no headless probe on this box can.

## Live verification recipe (for the user / next session)

1. Play any video in the theatre.
2. Open the theatre settings menu (gear) → toggle **Controls on the picture
   (overlay)** ON.
3. Stop and re-play (the overlay is built when playback starts).
4. Confirm on screen:
   - the bottom control bar and top title are drawn **over** the picture (not
     behind it, not in a separate floating window);
   - moving the mouse over the bar lets you press play/seek/volume;
   - moving the mouse over the middle of the picture passes clicks through to
     mpv (play/pause on click still works);
   - resizing the app and going fullscreen keep the bar glued to the picture.

If any of those fail (bar behind the picture, unclickable buttons, bar detaches
on resize), the compositor is fighting the sibling stack — leave the toggle OFF;
the held-rows deck is unaffected. Symptoms and the `--gpu-context` / transparency
history that constrain the surface live alongside `_videoWindow()` in `main.js`.

## If it proves reliable

Promote the default in `_videoConfig()` (`overlayControls`) from
`=== true` to `!== false`, and consider hiding the redundant held-rows transport
while the overlay is up (the rows currently stay as a belt-and-braces fallback).
