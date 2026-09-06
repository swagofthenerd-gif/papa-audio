# Papa Audio — Agent Instructions

## Primary mission
Find and download the music the user asks for, however necessary. This is the
core job for the music side of the app. If something blocks a download — a
broken source, a missing codec, a daemon not running, a search returning
nothing — diagnose and solve it autonomously without waiting for the user to
ask.

The app also streams movies, TV and anime (see **Video / Movies & TV**
below) — that side is just as real and just as much "the app," not a side
experiment. On `feature/papa-video` (often the checked-out branch) it's
active and actively used.

## Stack
- Electron app at `/home/shaharyar/flac-player/`
- Main process: `main.js` | Renderer: `src/renderer.js` | Bridge: `preload.js` | Styles: `src/styles.css`
- Soulseek daemon (slskd) at `http://localhost:5030/api/v0` — JWT auth with username/password `slskd`/`slskd`
- Music library: `/mnt/data/MUSIC` (scanned recursively; downloads go to `/mnt/data/MUSIC/Downloads/`)
- slskd runs externally as PID ~466166, connected as Soulseek user "sherrybaaz"
- Playback: mpv engine (`mpv-engine.js`, JSON IPC) — NOT the <audio> element. Purist mode: no EQ, no visualizer. Settings in electron-store key `playerSettings`. Renderer talks to it via `src/player-shim.js` (`window.__papaPlayer`). mpv is a hard requirement (`dnf install mpv`).

## How searching works
- `slsk-search` IPC handler fires a slskd POST `/searches` with up to 6 query variants in parallel
- Variants: cleaned query, bracket-stripped, stop-word-stripped, year-stripped, drop-first-word, last-N-words, reversed 2-word
- Each search runs for 90 s; responseLimit 3000; progressively renders results as variants complete
- `_slskGroupByFolder()` groups responses by `username::folderPath`, FLAC-first, query-relevance scored
- Download via `slsk-download` IPC → slskd POST `/transfers/downloads/{username}`
- File resolution: `slsk-resolve-file` checks multiple candidate paths on disk

## Defaults and behavior rules
1. **Never give up on a search.** If Soulseek finds nothing, retry with simpler terms. If still nothing, check if slskd is connected and reconnect if needed.
2. **FLAC / lossless first** — always prefer lossless sources. MP3 only if nothing else exists.
3. **Organize downloads into album subfolders** — slskd preserves remote folder structure automatically. Download dir: `/mnt/data/MUSIC/Downloads/`.
4. **After every download, schedule a library rescan** at 15 s, 45 s, and 120 s so new files appear in the library without manual refresh.
5. **Play buttons must always be visible** (not hidden behind hover). `opacity: .85` always on.
6. **Progressive search display** — show results as each search variant completes; never make the user wait for all variants to finish before seeing anything.
7. **Never reintroduce Web Audio / AudioContext processing** — playback must stay in mpv.

## Key IPC handlers (main.js)
- `slsk-search` — start search, poll, return merged results
- `slsk-download` — queue download on slskd
- `slsk-get-transfers` — poll transfer list
- `slsk-resolve-file` — find already-downloaded file on disk
- `slsk-get-download-dir` / `slsk-set-download-dir` — manage download folder
- `slsk-status` — connection health check

## User preferences
- User is "Shaharyar" (Soulseek: "sherrybaaz")
- Prefers lossless (FLAC/WAV) above all else
- Wants the search to be as comprehensive as possible — maximum peer coverage matters
- UI should feel like Spotify but with P2P power underneath
- See memory files for musical taste profile and learned preferences

## Video / Movies & TV (anime, film, TV streaming)
A second major feature living in the same app and the same `main.js`/`renderer.js`
files as the music player — not a separate project. Lets the user browse and
stream movies, TV shows and anime, torrent-backed, playing through the same
mpv engine the music side uses (a second, separate mpv process — see
`video-engine.js`).

- Catalogs (metadata/browsing): `catalog/tmdb.js` (movies/TV, needs a TMDB API
  key set in Settings → Video), `catalog/anilist.js` (anime), `catalog/omdb.js`
  (IMDb/RT/Metacritic ratings enrichment, optional), `catalog/shelves.js`
  (curated rows).
- Sources (where the actual video comes from): `providers/yts.js` (movies),
  `providers/eztv.js` (TV), `providers/nyaa.js` + `providers/apibay.js` +
  `providers/anime.js` (anime), `providers/movie-tv.js` (a broad
  fallback/vidsrc resolver). Picked per-type by `_videoBackends()` in `main.js`.
- Streaming: `torrent-stream.js` (`TorrentStreamer` — turns a torrent into a
  servable file, with pack/season handling and next-episode prefetch),
  `video-engine.js` (`VideoEngine` — drives mpv for video the way
  `mpv-engine.js` drives it for music).
- Renderer: `src/video-player.js` (the theatre UI: controls, seek, skip-intro/
  credits, subtitle/audio/quality menus, fullscreen), `src/video-store.js`
  (watchlist, per-episode progress, "Continue Watching" — **note:** this is
  backed by the renderer's `localStorage`, not by `electron-store` or the
  `SideStore` system everything else in the app uses; `main.js`'s `will-quit`
  and `shutdownFromSignal` both explicitly call
  `session.defaultSession.flushStorageData()` to make sure it actually reaches
  disk before the process exits — don't remove that call), `src/video-enrich.js`
  (lazy shelf-card enrichment), `src/video-format.js`, `src/video-query.js`
  (natural-language search parsing), `src/video-keymap.js`, `src/skip-model.js`
  + `skip/aniskip.js` + `skip/detect-intro.js` + `skip/chapters.js` (opening/
  credits skip detection).
- Navigation: video pages (`video`, `browse`, `person`, `video-detail`,
  `shelf`, `diary`) go through the same `navigate()`/`_currentNavId()` in
  `src/renderer.js` as music pages. A page needs a real id to mean anything —
  `state.currentVideoNavId` is where that id lives for `video-detail`/`person`/
  `shelf`; startup session-restore refuses to reopen one of those pages with a
  missing id (falls back to Home) rather than reopening into a dead error
  state.
- Main-process IPC handlers all start with `video-` (`video-detail`,
  `video-streams`, `video-play`, `video-search`, `video-shelf`,
  `video-skip-segments`, etc. — see `main.js`, search `ipcMain.handle('video-`).
- Tests: `test/video-*.test.js` (~18 files). Run just these with
  `node --test 'test/video-*.test.js'`.
- Deeper background/history lives in `docs/` (`papa-video-plan.md` — the
  original UX spec, `papa-video-handoff.md`, `papa-cinema-plan.md`,
  `HANDOFF-video-playback.md`) — these are point-in-time planning/handoff
  notes, not living docs, so treat them as historical context rather than
  current truth; verify against the actual code before trusting a specific
  claim in them.
