# Papa Audio — the road to seamless (perfect-app roadmap)

Written 2026-09-06 after the full QA campaign, three fix waves, the Soulseek
rework and perfection pass. Everything below is a real, buildable gap between
"excellent" and "seamless" — found by living in the code and the running app,
not speculation. Grouped by surface; roughly ordered by felt impact within
each group. Items marked ◐ are partially built already.

> **STATUS 2026-09-07 — campaign complete.** Waves 1-6 built, verified,
> committed and pushed (commits 324e24c…60a940c; suite 3,110 → 3,493, green
> at every commit). Done: items 1-16, 18-19, 21-25, 27-39, 41-42, 45-54, 56,
> 58-64, 66, 68-70. In the final cleanup wave (W7): 20 MPRIS polish, 44 anime
> numbering override UI, 55 peer messaging, 65 bit-perfect output. Shipped-behind-toggle awaiting a 30-second visual check: 26 (overlay
> controls — docs/learnings-overlay-attempt.md has the recipe). Partial: 62
> (two clean extractions; Downloads-tab region honestly aborted at the
> coupling threshold). Needs user/infrastructure: 17 (Last.fm data), 40 is
> built but token-gated, 43 HDR (needs an HDR display), 57 auto-update
> (hosting decision), 65 Android parity (its own project), 67 long-soak
> (run overnight when convenient).

## Music player & library

1. ◐ Session restore prompt after a crash: "Pick up where you left off?" —
   queue, position, view. The state is already saved; the prompt isn't.
2. Auto-continue when the queue ends: quietly append radio-style similar
   tracks (opt-in toggle on the queue panel) instead of silence.
3. Waveform hover preview on the seek bar: time + nearest section, using the
   waveform data already drawn.
4. Bookmarks/resume for long tracks (DJ mixes, live sets >20 min) — remember
   position per file, chip on the track row.
5. A–B loop repeat for musicians (mpv supports it natively).
6. Per-album vs per-track ReplayGain toggle in settings (mpv flag exists).
7. EQ preset picker UI over the existing eq.js chain (Flat/Rock/Vocal/etc,
   plus save-your-own).
8. Bulk genre fixer: the library has case-duplicates and junk tags (the
   "null"/"rock" chips we fixed display-side); a Manage tool to normalize
   genres across files would fix the source.
9. Tag-fixer APPLY step (the analysis pass exists; the write-back was never
   surfaced).
10. Multi-disc albums shown as one album with disc separators in the album
    view (library parsing already folds discs for Soulseek shelves — apply
    the same to local).
11. Smart playlist rule editor: the smart lists exist but rules are canned;
    let the user compose (genre + year + played-count + format).
12. Playlist folder drag-and-drop reordering.
13. Search upgrades: typo tolerance (fuzzy), filters (year/format/genre
    chips), and recent-search history like the video side has.
14. "Save queue as playlist" one-click on the queue panel.
15. Home personalization: pin, reorder, or hide Home rows.
16. Year-end "wrapped" view from the stats data (listening time is already
    tracked; make it a shareable page).
17. Import listening history (Last.fm CSV / Spotify export) into play counts.
18. Folder auto-watch: detect new files without a manual Rescan.
19. Artist pages: short bio + "similar in your library" row.
20. MPRIS polish on Plasma: artwork, seek position, and rating from the
    media applet; verify media keys under Wayland.
21. Minimize-to-tray option with tray controls.
22. Startup speed: defer non-visible Home rows until first paint is done.
23. One-click backup/restore in Settings (papa-export-all exists as IPC;
    give it a button + optional weekly schedule).
24. Crossfade between tracks globally (exists per-playlist; make it a global
    setting with the same engine).
25. Surface the bug-report bundle (papa-bug-report IPC) as a Settings button.

## Video & anime

26. Overlay controls window over the mpv picture (the known architectural
    item — needs a live session; removes the "held rows" compromise).
27. Picture-in-picture mini player for video while browsing.
28. Episode thumbnails on seek-bar hover (thumbnailer exists; wire to
    vt-seek hover).
29. Auto-"Next episode" countdown overlay at the outro (skip-outro's sibling).
30. Subtitle styling: size/color/position controls in the CC menu.
31. Per-show memory for subtitle language and audio track choice.
32. Per-series dub/sub preference for anime (global preference exists).
33. Continue Watching management: remove item, "mark season watched".
34. Diary: auto-log finished films/episodes (store already knows watched:true)
    with a toggle; today the diary is manual-only and reads 0.
35. Desktop notification when a followed show airs (airing data exists).
36. Airing calendar month view + "my shows only" filter.
37. TMDB collections: trilogy/franchise shelves on detail pages.
38. Person pages: full filmography click-through (vperson exists; deepen).
39. Jackett/Prowlarr integration for a second tier of sources.
40. Debrid (RealDebrid/AllDebrid) support: instant HTTP streams instead of
    P2P when the user has an account.
41. Learned dead-magnet memory: skip infohashes that never connected before.
42. Offline downloads manager: list, quotas, and expiry for video-keep files.
43. HDR: tone-mapping toggle and passthrough setting for HDR displays.
44. Anime absolute-numbering override UI for the rare mismatched season maps.
45. Simplify the video store to single-encoded JSON (currently JSON inside
    JSON; works but fragile for recovery tooling).

## Soulseek

46. ◐ Cover art everywhere: prefetch covers for cached/saved libraries in the
    background so shelves open face-rich (in build right now).
47. ◐ Preview streaming: hear any remote track before downloading — race
    Soulseek vs YouTube, fastest wins (in build right now).
48. Wishlist per-entry quality target ("only 5.1", "lossless only") and a
    notify-only mode (tell me, don't auto-download).
49. Post-download verification pass: track-count completeness vs the album,
    corrupt-file probe (ffprobe), and a surround-labelling check — one
    "verified ✓" badge on completed albums.
50. Auto-organize completed downloads: normalize "Artist/Year - Album"
    folder naming on arrival (opt-in), so the library stays tidy.
51. Bandwidth schedule: throttle downloads during the day, open at night.
52. Drag-to-reorder priority in the Active downloads tab.
53. Search result persistence across restarts (recent searches replayable
    from cache instantly).
54. Upload awareness: a small "you're sharing N files, M people browsing"
    status (slskd has the data; good citizenship helps queue priority).
55. Peer messaging (Soulseek chat) — at least reply to incoming messages
    from uploaders (some gate downloads behind a hello).
56. Substitution log surface: the engine now logs every alternate-source
    accept/reject — show it in the Downloads page so trust is inspectable.

## Platform & polish

57. Auto-update infrastructure (build exists; update channel doesn't).
58. Accent color picker (the palette engine already extracts colors; let the
    user pin one for the whole app).
59. Font-size / density setting (compact vs comfortable).
60. Accessibility audit: full keyboard coverage on every modal, aria labels
    on icon-only buttons, focus-visible everywhere, contrast check.
61. Onboarding: a 5-step first-run tour and a "what's new" panel after
    updates (the changelog exists).
62. Renderer modularization: renderer.js is ~26k lines; splitting it into
    modules is what keeps future work fast and safe.
63. Memory ceiling watchdog: warn (and self-heal caches) if the renderer
    crosses a threshold during long sessions.
64. Bridge/Android parity: artwork endpoint + optional transcode for the
    Android app; video streaming to Android via the bridge later.
65. Bit-perfect output mode: exclusive audio device + no resampling toggle
    for the audiophile path (mpv supports it).
66. Global undo toast pattern audit: every destructive action should offer
    the same Undo the folder-remove flow has.
67. Session-length soak: a scripted 8-hour run watching memory/listener
    growth (the budgets exist as tests; run them against a live marathon).
68. Light theme completion pass for the music side (cinema stays dark by
    design).
69. Keyboard cheat-sheet overlay refresh (new surfaces: hub, shop, racer).
70. "Report what's slow" one-click profiler capture for future perf triage.
