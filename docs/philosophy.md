# What Papa Audio refuses to become

Papa Audio is a music and video player that runs on one person's machine and
serves that one person. It is not a service, not a funnel, and not a growth
product. This page is the short list of things it will not do, and the design
principles that are already visible in the code — every claim below points at
something real in this repo, not at a slogan.

## What it will not do

- **No ads.** There is no ad SDK, no sponsor slot, no "recommended for you" that
  is really a placement. The home shelves come from `catalog/shelves.js` and the
  user's own history, not from anyone paying to be there.
- **No telemetry.** Nothing phones home to count the user. The only network the
  app makes is the network the user asked for: a Soulseek search, a torrent for
  a film, a TMDB or AniList lookup to name it. `tools/video-soak.js` measures the
  app by driving it locally and reading its own process metrics — there is no
  analytics endpoint to measure it from outside because there is no analytics.
- **No cloud accounts.** There is no login to Papa Audio. The one credential in
  the whole stack is the local slskd daemon's `slskd`/`slskd` on
  `http://localhost:5030`, which never leaves the machine. Video API keys (TMDB,
  OMDb, OpenSubtitles) are the user's own keys, held in local settings, and the
  app works — degraded, not broken — without them.
- **No subscriptions.** Nothing is gated behind a tier. The sources are
  peer-to-peer (Soulseek for music, torrents for video) and public metadata
  APIs; there is no paywall to add because there is no server charging rent.
- **Lossless first, always.** The music mission is explicit: "FLAC / lossless
  first — always prefer lossless sources. MP3 only if nothing else exists"
  (`CLAUDE.md`). The search groups results FLAC-first
  (`_slskGroupByFolder()`), and playback runs through mpv in a deliberately
  purist mode — "no EQ, no visualizer" — because the point is to hand the user
  the bits, not to reshape them. Web Audio / AudioContext processing is banned
  by rule: "Never reintroduce Web Audio / AudioContext processing."
- **The user's data lives on the user's disk.** The library is a real directory
  the user owns (`/mnt/data/MUSIC`); downloads land in a folder under it. Watch
  history, watchlist and per-episode progress live in the renderer's own store
  on disk — and the app goes out of its way to keep them there: `will-quit` and
  `shutdownFromSignal` both call `session.defaultSession.flushStorageData()` so
  the user's place reaches disk before the process exits. There is no
  server-side copy because there is no server.

## Design principles the code already follows

These are not aspirations. They are patterns you can find by reading the repo,
and they are the reason the refusals above are cheap to keep.

- **Fail loudly, never silently.** A tool that measures nothing must say so, not
  report success. The soak harness makes this a law: a run whose probe failed to
  install *aborts* rather than passing blind, because "a light that is always
  red is a light nobody looks at" and, worse, a green light on a blind run is a
  lie (`tools/video-soak.js`, the listener-probe abort). A metric that never
  varied is reported as `constant` — "nothing happened, or nothing was
  measured" — and does not count toward the metrics that decided anything.
- **Never lose the user's place.** Session restore refuses to reopen a video
  page whose id is missing, falling back to Home rather than into a dead error
  state. Downloads schedule a library rescan at 15 s, 45 s and 120 s so new
  files appear without the user asking. Subtitle delay is remembered per show;
  volume and mute are remembered across sessions. The whole video-store flush
  described above exists for one reason: the user should never come back to find
  their progress gone.
- **Comments explain constraints, not mechanics.** The hard-won comments in this
  codebase say *why*, and usually name the bug that taught the lesson. The soak
  harness explains that `performance.memory` is quantized by Chromium and read a
  flat placeholder for 400 samples, so the renderer's real memory is taken from
  the main process instead. The global-listener test names the three separate
  times this app shipped the same modal-reopen leak (catalogue items 73, 74,
  257). A comment here is a fence with a note explaining who put it up.
- **Coverage over speed at the tail.** The interesting failures are the slow
  ones. Smoothness over a minute and smoothness over an evening "are different
  properties. Only the second one can be promised to a user, and it cannot be
  demonstrated — it has to be measured" (`tools/video-soak.js`). The leak
  analysis watches the *floor* of memory across a long run, not the average,
  because "a floor that never comes down has no reason to stop." A static
  listener budget in `test/soak-probe.test.js` catches at commit time what a
  two-hour soak would only catch by luck. The app would rather be provably
  steady for an evening than merely quick for a demo.

## Why write this down

Refusals are easy to state and easy to erode one reasonable-sounding feature at
a time. Each item above is here because the alternative — an ad, a login, a
metric that phones home, a lossy default, a place that gets lost — would be a
small, defensible change on its own. Written together, they are the shape of the
thing, and the shape is the promise.
