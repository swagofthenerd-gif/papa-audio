# YT Radio + Autoplay, Lyrics, Account, Explore — Design & Plan (Round 3)

Date: 2026-07-06 · Status: Approved by Shaharyar
Prereq: Round 2 (`docs/superpowers/specs/2026-07-06-youtube-spotify-experience-design.md`)

## Scope

1. **Radio & autoplay** — "Start radio" from any YT row/artist; infinite autoplay
   when the queue ends (seeded from last track; local tracks seed via YT lookup).
2. **Lyrics** — synced LRCLIB lyrics panel (works for local FLACs), YT plain-text
   fallback.
3. **YouTube account** — OAuth device-flow sign-in via youtubei.js so the feed,
   radio, and recommendations are personalized to the user's taste.
4. **Explore page + polish** — new sidebar page rendering the full personalized
   feed in grids (song sections as 2-column quick-pick grids, album/playlist
   sections as card rows); home YT block gets the same grid treatment.

## Architecture decisions

- **Auth**: `Innertube.create({ cache: new UniversalCache(true, <userData>/yt-cache) })`
  + `session.signIn()` (TV device flow). Events: `auth-pending` → forward
  `{ verification_url, user_code }` to renderer via `yt-auth-pending` webContents
  event; `auth`/`update-credentials` → `session.oauth.cacheCredentials()`.
  `youtube-search.js` stays electron-free: main.js calls `setCacheDir(dir)` before
  first use. Sign-in status = credentials present in cache / session logged_in.
  After sign-in/out the Innertube client is recreated (reset `_clientPromise`).
  Fallback if device flow is dead upstream: cookie-paste auth (documented, not built).
- **Radio**: `getRadio(videoId)` → `yt.music.getUpNext(videoId, true)` →
  map `PlaylistPanelVideo` items (`{ videoId, title, artist, duration, thumbnailUrl }`),
  skip the seed itself. `findVideoId(artist, title)` → first `searchMusic` hit
  (seeds radio/autoplay from local tracks).
- **Autoplay**: `playerSettings.autoplay` (default ON). Hook in `playNext()` at the
  wrap-to-zero/repeat-off stop: fetch radio for last track (videoId or lookup),
  dedupe against queue filePaths, append, continue playing. Guard `_autoplayBusy`
  + only once per queue-end (no infinite retry on failure). Toggle switch in the
  queue panel header.
- **Lyrics**: main-process `lyrics.js` — `fetchLyrics({ artist, title, album, duration, videoId })`:
  LRCLIB `/api/get` (artist+title+album+duration) → LRCLIB `/api/search` best
  match → `yt.music.getLyrics(videoId)` for YT tracks. Returns
  `{ synced: [{time, text}]|null, plain: string|null, source }`. LRC parsing in
  lyrics.js (unit-tested). Session cache Map keyed `artist|title`, cap 200.
  Native `https` (main process → no CSP change).
- **Feed**: `getHomeFeed()` cap raised to 8 sections and gains `kind: 'playlists'`
  (feed items with playlist-ish ids: `^(VL|PL|RDCLAK)`). Home shows first 3
  from the shared session cache; Explore renders all sections + connect banner
  when signed out.

## Every click

Radio: context-menu "Start radio" on every YT row (search, see-all, album,
playlist, liked, home) replaces queue with seed+radio and plays; radio button on
yt-artist hero seeds from top song. Autoplay toggle in queue panel persists.
Lyrics: mic button in player bar toggles panel; synced lines highlight +
auto-scroll; click line seeks; graceful "No lyrics found". Explore: nav item →
sections in grids; song tile click plays, hover ▶, cards open entity pages; signed-out
banner "Connect YouTube account" → code+URL flow with live status, sign-out button
when connected.

## Tasks

1. Backend auth (`setCacheDir`, signIn/signOut/status + events) + IPC
   (`yt-auth-start`, `yt-auth-signout`, `yt-auth-status`) + preload.
2. Backend radio (`getRadio`, `findVideoId`) + IPC (`yt-radio`, `yt-find-video`)
   + unit tests + live smoke.
3. Backend feed upgrade (8 sections, playlists kind) + unit test.
4. `lyrics.js` (LRC parser + LRCLIB + YT fallback) + IPC `get-lyrics` + unit
   tests + live smoke.
5. Renderer: Explore page + nav item + auth UI (banner, code screen, sign-out).
6. Renderer: radio actions + autoplay hook + queue-panel toggle.
7. Renderer: lyrics panel (player-bar mic button, sync, seek).
8. CSS: explore grids, 2-col home song grid, lyrics panel, auth banner.
9. Verify: full suite (node + Electron runtimes), live smokes, boot smoke, merge.

## Constraints

Same as round 2: youtubei.js ~14.0.0 pinned, no Web Audio, `{ok,error}` IPC,
2-space vanilla JS, `esc()` everywhere, tests must not hit network (mock via
`_setClientForTest`; lyrics tests mock the HTTP layer).
