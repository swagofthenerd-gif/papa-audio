# Papa Perfect — master checklist

Tracking for the 30-item player list and the 100-item app list (2026-09-04).
Status: [x] done · [~] partial · [ ] open · [!] needs user input / live session.

## Player (30)
- [~] 1. Overlay controls window over the picture — BUILT, shipped behind the
  `Controls on the picture (overlay)` settings toggle (default OFF). Machinery
  proven headlessly (transparent click-through child window, live state render,
  control round-trips, 0 errors); the on-screen z-order of sibling XWayland
  child windows could not be verified headlessly on this fractional-scaled
  dual-monitor KDE Wayland box. Flip the toggle to confirm visually, then
  promote the default. Full account: docs/learnings-overlay-attempt.md
- [x] 2. Layout stability (held rows, no picture jumps, no dead bands)
- [x] 3. Status messages on the picture via mpv OSD (stalls, volume)
- [x] 4. Click picture to pause
- [x] 5. Seek-bar hover thumbnails (lazy per-bucket ffmpeg thumbnailer; bubble shows the frame above the time on hover + keyboard seek)
- [x] 6. Chapter ticks on the seek bar
- [x] 7. Distinct unbuffered region (hatched)
- [x] 8. Time-remaining toggle
- [x] 9. Keyboard seek bubble
- [x] 10. Stop button in theatre
- [x] 11. Previous-episode button
- [x] 12. Scroll-wheel volume + OSD flash
- [x] 13. 100% volume notch
- [x] 14. Volume/mute memory verified
- [x] 15. Stats panel (speed, peers, progress)
- [ ] 16. Episode strip with titles (season groups done; titles pending)
- [x] 17. "Start over" on resume
- [x] 18. Auto-play-next toggle
- [x] 19. Up Next hover-pause + still verified
- [x] 20. "Still watching?" prompt
- [x] 21. Online subtitle search (module + IPC + CC menu UI)
- [x] 22. Torrent-bundled subtitles served
- [x] 23. Subtitle size + background controls
- [x] 24. Subtitle delay remembered per show
- [x] 25. "Louder dialogue" labeling
- [x] 26. Mid-play source switch keeping position (+ auto-switch on repeated stalls)
- [x] 27. Repeated stalls auto-switch source (capped at 2/episode)
- [ ] 28. Picture-in-picture mini video
- [x] 29. A11y: focus rings, seek/volume announcements
- [x] 30. Faster start: mpv spawns in parallel with torrent

## App (100)
- [x] 1. Watch history on crash-proof store (migrated, verified)
- [~] 2-12. Foundation: [x]2/3 export+import [x]5 health chip [x]9 settings search [x]10 reset [x]12 diagnostics page; open: 4 auto-backups, 6 crash reporter, 7 changelog, 8 wizard, 11 offline banner
- [x] 13. Person page header
- [x] 14. Because-you-watched shelf (home tab)
- [ ] 15. Hero trailer autoplay on hover
- [x] 16. Hero pauses on hover
- [ ] 17-27. Franchise pages, CW nudge, watch-providers row, richer search, typo tolerance, list collections, sort/filter My List (done: [x]23), hide-seen shelves (done: [x]24), airing shelf, calendar, random pick (done: [x]27 Surprise me)
- [x] 28. Episode-grid windowing (anime + big TV seasons)
- [x] 29. Detail page shows your history
- [x] 30. Genre chips work everywhere
- [x] 31-ish. (32 AnimeTosho done; 35 mirror racing done)
- [ ] 31. Jackett/Prowlarr
- [x] 33. Meta-indexers instead (Knaben + SolidTorrents aggregate TGx/1337x and dozens more; 40-50 sources/title)
- [x] 34. Editable mirror lists in settings (Settings → Video → Advanced; empty = built-in defaults; providers rebuilt on change)
- [x] 36. TMDB→OMDb fallback (detailFromOmdb — wiring pending)
- [x] 37. AniList→Jikan fallback (catalog/jikan.js — wiring pending)
- [x] 38. Backoff + truncated chains never cached
- [x] 39. Source health memory (session-level, healthiest-first ordering, never drops)
- [x] 40. Full predownload (engine + Download-next-episode UI)
- [x] 41. Bandwidth cap (engine + settings UI; app-wide limiter)
- [x] 42. Seed toggle + ratio (engine + settings UI)
- [x] 43. Per-title source overrides (a manual non-first pick that plays >5 min is remembered per show; auto-pick prefers it; clear chip in the sources panel)
- [ ] 44. Download-for-offline
- [~] 45. Player list (see above)
- [x] 46. Skip-intro training from manual seeks (two 60–120s forward jumps in a season's first 5 min → toast offers to learn a manual skip segment averaged from them)
- [ ] 47. Watch-together over LAN
- [x] 48. Screenshot button surfaced (camera button in the deck + Shift+S; saves to Pictures/Papa Audio with a USER_DATA fallback; toasts the path)
- [x] 49. Diary playback timeline (film/TV viewings interleaved with album first-listens, grouped by month; pure PapaDiaryTimeline helper; also covers #75 unified diary)
- [ ] 50. Resume across devices (bridge)
- [~] 51-68. Music: [x]53 dupe finder [x]56 queue tools [x]63 stats+chart [x]66 sleep timer; open: crossfade/playlist, smart playlists, missing-track hunt, album completion, synced lyrics, scrobble health, ReplayGain, tag fixer, cover art, storage dashboard, playlist import, radio, alarm, MPRIS
- [~] 69-76. Unification (done: [x]71 soundtrack link — "Find soundtrack" on detail pages → music search; [x]75 unified diary — timeline interleaving films + album first-listens; open: universal search, unified home, media handoff, global mini-bar, year recap)
- [ ] 77-88. Interface polish (tokens, animation discipline, skeletons, empty/error states, toasts, context menus, keyboard audit, focus, window memory, light theme, UI scale)
- [ ] 89-93. Speed (virtualization, image cache, startup budget, scan off-thread, leak ceiling)
- [ ] 94-100. Craft (E2E harness, indexer canary, store versioning, bug reporter, auto-update, philosophy doc, greeting)
