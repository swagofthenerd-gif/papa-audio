# Overnight run — audio experience overhaul

Started 2026-09-17. Session `claude-desktop-debian-5b`. Branch `feature/papa-video`.
Decisions taken before he left: commit AND push each verified fix; bit-perfect
stays seamless (relabel honestly rather than change what he hears); delete only
the RealDebrid entries my own testing created; he may reach me from a remote
terminal session.

Rules held throughout: never touch his running app; every live test on a
throwaway twin at volume 0; slskd is read-only (no downloads, cancels, messages
or config changes); Manage tab dry-run only; never enter credentials; never
print the debrid token.

## Status

| # | Item | State |
|---|---|---|
| — | Next button undone by a stale reconcile (regression from bb7db5d) | DONE `8505088` |
| A1 | Device loss killed the engine permanently (`const` reassignment) | DONE `6736434` |
| A2 | ReplayGain applied 3x the requested dB | DONE `6736434` |
| A3 | Gain not re-applied on gapless advance; stale path in the volume slider | DONE `0103938` |
| A4 | Audible level blip at the start of every track | DONE `0103938` |
| — | Merged the 32 Sep-15 commits from the parallel session | DONE `df8f8d1` |
| — | Non-Latin names unsearchable (JP/KR/CN/RU/GR) | DONE `09cd938` |
| — | Stats/Trail/Recently-played frozen at launch all session | DONE `09cd938` |
| F1 | A play counted 30s of wall clock, not of listening | DONE `09cd938` |
| — | Retry on a stuck download silently did nothing, then blacklisted it | DONE `e7a36a0` |
| — | Cancel always claimed success even when the daemon refused | DONE `e7a36a0` |
| — | Video player mode (Smooth/Purist) never saved | DONE `e7a36a0` |
| — | Space could not open dropdowns; shortcuts fired over them | DONE `e7a36a0` |
| E1 | Compilations shattered into one album per performer (16 -> 1) | DONE `feeb929` |
| — | Clearing the queue threw and left the tray/MPRIS lying | DONE `feeb929` |
| — | A wedged slskd killed Soulseek until an app restart | DONE `cc27749` |
| — | A corrupt store was silently replaced by an empty one | DONE `cc27749` |
| — | Diagnostics reported an outage that was not happening | DONE `cc27749` |
| F2 | Resume queue put you on the wrong song past track 100 | DONE `09cd938`→`befor` |
| F5 | Shuffle, repeat and speed reset on every restart | DONE |
| D1 | Seek drag fired one mpv seek per pixel of travel | DONE |
| E2 | "The Beatles" filed under T | DONE |
| — | Fake random waveform presented as the track's signal | DONE `dd1f8d7` |
| D2 | Album track list: 7 children in a 5-column grid, reflowed on hover | DONE `dd1f8d7` |
| — | Track-list header labels sat over the wrong columns | DONE `dd1f8d7` |
| — | Enricher retained every card from 4 in-place repaints | DONE `dd1f8d7` |
| — | now-playing.json written 86,400x/day with no change check | DONE `dd1f8d7` |
| — | Soulseek section rebuilt on every poll for the whole session | DONE `dd1f8d7` |
| — | Tag-editing hero fields had no affordance at all | DONE `dd1f8d7` |
| — | My own device-loss test was flaky (2-3 in 20) — now deterministic | DONE `dd1f8d7` |

All of the above are committed and pushed to `feature/audio-overhaul`, each with
the full account in its commit message. Suite at 4681, green at every commit.

## Queue

### A. Engine correctness (verified by me)
- A1 `const resume` reassignment kills the engine on device loss — proven throws
- A2 ReplayGain applies 3x the requested dB (cubic volume curve) — proven: -6 dB gives -18 dB
- A3 ReplayGain never re-applied on gapless advance; volume slider then uses a stale path
- A4 Volume blip: gain applied after audio is already audible, un-awaited

### B. Crossfade
- B1 A failed fade leaves _fading true forever -> player goes permanently silent
- B2 trackUnplayable not forwarded -> poisoned track silently stalls
- B3 engineDown/Failed/Recovered not gated to the active engine -> false "paused"
- B4 Linear ramp in a cubic domain -> audible dip mid-fade
- B5 Crossfade + exclusive output fight over the device

### C. Honesty of the quality badge
- C1 Badge blind to replaygainApply; mpv volume never relayed to the renderer
- C2 mpv-replaygain-mode bypasses the bit-perfect gate
- C3 Two different controls both called "bit-perfect"; relabel the dropdown
- C4 Gapless resamples mixed-rate libraries — DISCLOSE, do not change (his call)
- C5 DSD is decoded to PCM but badged as lossless/bit-perfect

### D. Responsiveness
- D1 Seek bar fires a real mpv seek per pixel of drag
- D2 Queue panel: 3x includes per row, no lazy art, no windowing
- D3 playCurrentTrack has no generation guard -> stale response paints wrong track
- D4 Now-playing sync re-serialises the whole queue every second
- D5 350 ms from click to sound — investigate what the wait actually is

### E. Library
- E1 Compilations shatter: "Best 5.1 Songs" = 16 albums, "Digital Singles Vol.1" = 6,
      "Raja Ram's Anthology" = 5, "Unknown Album" = 7 (verified against his cache)
- E2 Artist sort files "The Beatles" under T
- E3 writeLibraryExt does a 612 KB synchronous write on the main thread

### F. Memory and continuity
- F1 Play counted by wall clock; pause does not stop it
- F2 Resume queue always saves the FIRST 100 -> wrong track past 100
- F3 Smart playlists and long-track bookmarks live in localStorage, which no backup reaches
- F4 playCounts/likes/playlists/savedQueues still on the synchronous whole-file store
- F5 Shuffle, repeat and speed reset on every restart
- F6 Two competing crash-recovery prompts that disagree
- F7 Stale 907 KB libraryCache key still in config.json

### G. Then
- G1 Continuous bug hunt across every tab (running in parallel throughout)
- G2 Per-tab exhaustive QA pass — one "month" per tab, on twins
- G3 RealDebrid cleanup of my own test entries, dry-run logged first

## Branch divergence — needs his decision, not mine

`feature/papa-video` on GitHub carries **32 commits from 2026-09-15** that this
working copy never had: video work (V020, V046, V048, V053, V058 and the ledger
entries around them), authored in a parallel session. This copy is 16 ahead and
32 behind.

I did not merge them. A test merge in a throwaway worktree conflicts in exactly
one file — `src/renderer.js` — which is tractable, but resolving two days of
someone else's work into mine in a 34k-line file and pushing it to the shared
branch, unattended, risks the video side he uses daily. The conservative option
costs nothing; the other could cost two days of work.

So every commit from this run is pushed to **`feature/audio-overhaul`** instead.
Nothing is lost and nothing of his is overwritten. Merging the two lines is a
decision for him when he is back.
