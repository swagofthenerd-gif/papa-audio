# The Video Experience Plan — Movies & TV, the player, and the mini player

Written 2026-09-11 by Fable 5.1 at the end of the elite-experience campaign's
first day of shipping (J1–J6, R3–R19, S7). This is the plan for what the user
asked for next, in his words: *"the app's video player is still very buggy and
finicky, it needs proper workflows and it should have all the mini player
smoothness as YouTube, even better than that if possible, and the dragging of
the mini player too … everything in the video tab and movies tab to be beyond
perfect, functionally and visually and experientially."*

Everything below is grounded in the code as it stands (`src/video-player.js`
2,632 lines, `video-engine.js`, the `video-*` IPC in `main.js`, the Movies & TV
renderer sections) and in the crews' measured findings. Where a claim is
unverified it says so.

---

## 0. Why the mini player feels finicky (the honest diagnosis)

mpv paints into a **native child window** (`--wid`) that sits *under* the HTML.
The HTML draws the chrome (controls, the mini card) and tells the main process
where the picture belongs (`videoSurfaceBounds` / `videoMiniMode({rect})`), and
main moves the native window with `setBounds`. Three consequences, all visible
today:

1. **Drag lag and jump.** On drag the HTML card moves every pointer event
   (transform), but the native window follows over IPC **throttled to ~50 ms**
   (`miniRectTimer`). The picture trails the card by up to three frames, then
   catches up in a jump; on release the card snaps to a corner and the picture
   snaps a beat later. That is the "not like YouTube" feeling.
2. **The picture eats the pointer.** The native window swallows every pointer
   event over it, so the card is only draggable by its 26 px handle strip and
   the bar's dead space. You cannot grab the video, hover it, or click it to
   play/pause. Controls-on-the-picture needed a *second* native overlay window
   (`roadmap #26`) to exist at all.
3. **Nothing can be composited with it.** No rounded corners on the picture,
   no shadow, no fade in/out, no scale animation from theatre to corner, no
   blur behind it. Every "Apple-level" transition is impossible while the
   picture is a foreign window.

The rest of the video tab's rough edges (below) are ordinary bugs; this one is
architectural, and fixing it is what makes the rest possible.

## 1. The one big change: render the video *inside* the page

**Decision to make first (V0):** move from `--wid` native embedding to a
frame path that the page can composite. Two viable routes, prototype both for
a day each, pick by measurement:

- **V0a — mpv → shared GPU texture → `<canvas>`/WebGL.** mpv's `libmpv` render
  API with `--vo=libmpv` into a texture, exported through an Electron native
  addon (Node-API + EGL/DMA-BUF on Linux). Zero-copy, full mpv feature set
  (subtitles, 5.1, filters) kept. Highest ceiling, most engineering (a native
  addon, Wayland/X11 differences on this Fedora KDE box).
- **V0b — mpv/ffmpeg → local fMP4/HLS → `<video>`.** Remux (not re-encode)
  the stream to fragmented MP4 served on localhost, played by Chromium's own
  `<video>`. Cheap, immediately composited (CSS transforms, PiP API, rounded
  corners, fades all free), but Chromium cannot decode every codec/audio
  layout mpv can (HEVC 10-bit, DTS/TrueHD 5.1, ASS subtitles) — those would
  need a transcode fallback and lose quality, which for this user (5.1, hi-res)
  is a real cost.

Measurement gate for the pick: play the user's own 5.1 HEVC file and an ASS-
subtitled anime episode through each; count dropped frames on a 1080p60 drag
of the mini card; confirm audio layout is preserved. **Recommendation:** V0a
if the addon builds cleanly on Fedora 44 in a day; otherwise V0b with mpv
kept as the fallback for anything Chromium refuses.

Everything in §2 assumes the page owns the pixels.

### V0 measurements (2026-09-11, this machine: Fedora 44, RTX 3070, Electron 28 / Chromium 120, ffmpeg 8.1 with CUDA/NVENC)

What this Electron build's `<video>` can decode: **H.264, AV1 (8- and 10-bit), VP9, AAC, Opus, FLAC — yes. HEVC (any), AC-3, E-AC-3, TrueHD — no.** libmpv headers are not installed, so V0a could not be prototyped without `sudo dnf install mpv-libs-devel`.

| File (the user's own) | Path to a browser-playable stream | Speed | Playback in Electron |
|---|---|---|---|
| Mononoke (1080p HEVC 10-bit, AAC 5.1) | GPU decode → H.264 (NVENC, CQ 19) + audio copy | **5.45× real time** | 0 dropped frames; drag bench: 240 frames, 1 over 20 ms, 0 video frames dropped |
| A Clockwork Orange (1080p AV1 10-bit, Opus 5.1) | **remux only** (`-c copy` to fragmented MP4) | 228× real time | 0 dropped frames; drag bench: 240 frames, 1 over 20 ms, 0 dropped |
| Fantastic 4 (4K HEVC 10-bit HDR10+/DV, TrueHD 7.1 / E-AC-3) | GPU decode → CPU tone-map → H.264 SDR (NVENC) + E-AC-3 → Opus 5.1 | **~1.0× real time** (20 s took 21 s) | not benched |

The RTX 3070 (Ampere) has **no AV1 encoder**, so 4K HDR cannot stay 10-bit on the GPU path; it becomes H.264 SDR with tone-mapping, at about real time. TrueHD is never passed through: it becomes Opus 5.1.

**Decision (V0): the page owns the pixels, ffmpeg feeds it, mpv stays as the purist fallback.**
- Remux when the codecs allow (H.264/AV1/VP9 + AAC/Opus/FLAC; SRT → WebVTT).
- GPU-transcode when they do not (HEVC → H.264 at a high, near-transparent bitrate; AC-3/E-AC-3/TrueHD → Opus 5.1; ASS/PGS subtitles burned in on that path so fansub styling survives).
- HDR is shown tone-mapped, with an honest "HDR shown as SDR" badge; 4K HDR gets a pre-roll buffer because it converts at ~1×.
- **Purist mode** (a setting, and automatic for anything the pipeline refuses) plays through mpv in the native window exactly as today: bit-exact, HDR and TrueHD pass-through, and the old mini player. V0a (libmpv → texture) remains the way to get both at once; it needs the devel package and a native addon, and is parked until the user wants it.


## 2. The mini player, YouTube-grade and beyond (V1)

- **Drag by the picture.** Any press on the card (picture included) starts a
  drag; a press-and-release without movement toggles play/pause. Pointer
  capture, `translate3d` on a single composited layer, no IPC in the loop.
  Target: zero dropped frames during drag on this machine (measure with
  `requestAnimationFrame` deltas; a bench test asserts < 1 % > 20 ms frames).
- **Physics on release.** Fling with velocity (last 100 ms of pointer
  history), decelerate, then settle into the nearest corner with a spring
  (stiffness/damping tuned like iOS PiP: ~350/30). Snap distance and inset
  respect the music player bar, as today.
- **Resize by corner-drag and by pinch/scroll**, not just compact/large.
  Persisted per corner. Minimum keeps the controls legible.
- **Continuous scale from theatre to corner.** Minimise is one animation:
  the picture shrinks and travels to its corner (FLIP technique), controls
  cross-fade. Restore is the reverse. 250 ms, `cubic-bezier(.2,.8,.2,1)`,
  respects reduced motion.
- **Hover chrome.** Controls fade in on hover over the picture (they can now
  receive the pointer), fade out after 2 s idle; the progress bar stays as a
  1 px line at the bottom until hovered.
- **Double-click to theatre, Esc to corner, `M` mute, `Space` play/pause,
  `←/→` 10 s** — one keymap for theatre and mini (today they differ).
- **Rounded corners, shadow, subtle border** on the picture itself, and a
  backdrop blur behind the card on light content — now possible.
- **System PiP as an option** (`requestPictureInPicture` if V0b, or mpv's
  own corner mode as today) for "keep watching while I use another app".

## 3. Proper workflows in Movies & TV (V2)

Each is a small, testable slice; each fixes a verified or observed break.

1. **Episode pickers become episode lists** — title, air date, thumbnail,
   synopsis, watched tick, "up next" highlight (TMDB has it; the thumbnailer
   exists). "Which one is the bathtub episode?" becomes answerable.
2. **Sources show release names** (fansub group, batch, resolution badge) and
   remember the last-chosen group per show, so the second episode does not
   ask again.
3. **Resume rules stated and honoured**: resume if 5 %–92 % in; offer "start
   over"; mark watched at 92 %; the same numbers on the card, the detail page
   and Continue Watching (they drift today).
4. **Video deck hides film-irrelevant controls** — no Episodes / Next-episode
   on a film or a trailer.
5. **Decade filter parity** (search stops at 1990s, shelves reach the 1920s);
   collection ordering ("PART 1" on a sequel); "WATCHING" badge wording;
   diary delete gets Undo; ratings "—" dashes below the fold; "Untitled" card
   on Home; global-search Movies strip card quality to Movies-tab standard.
6. **The "Approved" chip** the crews saw as a genre tag — could not be found
   in the current code (Jikan/Kitsu map only real genres). Reproduce with the
   crews' exact query before touching anything.
7. **Trailer on the detail page** plays inline in the hero (muted, with a
   "sound on" button) instead of taking over the theatre — a trailer is not
   a decision to watch.
8. **Keyboard-complete detail page**: `S` toggle My List, `P` play, `T`
   trailer, `1–9` seasons; announced by the shortcuts dialog.

## 4. Visual and motion polish (V3) — Apple-level finish

- Poster rails: momentum scroll with edge fades; cards lift on hover with a
  2° tilt on the art only; art loads with a blur-up from the dominant colour.
- Hero: Ken Burns drift on the backdrop (8 s, 3 % scale), title logo instead
  of text where TMDB has one, cross-fade between rotations (never a cut).
- Detail page: backdrop parallax on scroll; the poster's dominant colour tints
  the page's accent (palette.js already extracts it for music).
- Skeletons everywhere a fetch takes > 120 ms; never a layout shift when
  ratings arrive (slots already reserved — extend to credits and chips).
- One motion vocabulary: 150 ms micro, 250 ms travel, 400 ms scene; one
  easing curve; every transition listed under `prefers-reduced-motion`
  (the test that enforces this already exists).
- Typography pass on the cinema section: real quotes, en dashes in ranges,
  tabular numerals on times, consistent 11/12/13/14 px scale.

## 5. Stability (V4)

- **Stream start honesty**: every failure between "click Play" and first
  frame gets a specific sentence and a next action (no source / peer slow /
  extractor stale / mpv missing / unsupported codec).
- **Never a black frame with no words**: a watchdog on "playing" (like the
  hover-preview one shipped today) for the theatre and the mini card.
- **A soak test** in the QA-twin pattern: 30 minutes of open/minimise/drag/
  restore/seek/next-episode with heap and longtask capture; budget: flat
  heap, no longtask > 100 ms.
- **Crash isolation**: a decoder crash restarts the stream at the last
  position without touching the page (the music engine's poison-quarantine
  pattern, applied to video).

## 6. Order and proof

1. **V0** prototype week: both routes, measured, decision recorded in
   `docs/decisions.md`. Nothing else in this plan is worth doing before this.
2. **V1** mini player on the chosen route, with the drag bench test.
3. **V2** workflows, one slice per commit, each with a wiring test and a
   twin screenshot.
4. **V3** polish in parallel with V2 (different files).
5. **V4** soak + crash isolation last, because it measures the result.

Every slice: unit tests green, live twin verification with screenshots, and a
plain-English account before the commit — the same rules as today.

---

## Appendix — what else remains from the elite-experience roadmap

Shipped today: J1–J6, R3–R12, R14–R19, S7, plus the pluralisation sweep and
the genre-chip normalisation from the truth lane. Still open:

- **Speed lane** S1/S2 (peer-library tree build off the main thread — the
  chunked builder exists; a worker is the next step), S3 ("Show 60 more"
  should append, not rebuild — needs `renderSoulseekRow`'s list computation
  extracted into a memoised helper first), S4 (Stats page 350 ms freezes),
  S5 (tab switches 200–250 ms), S6 (Add-to-playlist modal 1 s), S8 (blank
  artist circles before art loads).
- **Truth lane** empty-state sweep, main-process IPC input validation, queue
  panel reopen centring, Prev-at-queue-start wrap, "Broken audio files"
  listing in-progress downloads (noticed today, unverified as a bug).
- **Debt** peer-library speed numbers are bench-only; Android Wave A2; phone
  pairing unconfirmed; DSD files still only skip politely.
