# YouTube Spotify-Experience Expansion — Design

Date: 2026-07-06
Status: Approved by Shaharyar

## Goal

Extend the existing YouTube integration (search, streaming, downloads) into a full
Spotify-like experience: deep search filters with See-all/pagination, YT playlists,
local playlists that mix library + YT tracks, a YT Music home feed, and
like/follow/save for YT songs, artists, and albums.

Out of scope (explicitly, for a later round): radio/autoplay via YT up-next,
lyrics, podcasts.

## Architecture: parallel YT stores, merged at render

Saved YT entities live in **new electron-store keys**, never in `state.library`
or the library cache. The library scanner remains untouched; a rescan can never
clobber YT saves. Pages that show mixed content (home, library, liked songs,
playlists) merge YT entries in at render time and mark them with the existing
`yt-badge`.

New store keys (all arrays, persisted via new IPC get/save pairs):

| Key | Shape |
|---|---|
| `ytLikedTracks` | full track objects `{ videoId, title, artist, album, duration, thumbnailUrl, likedAt }` |
| `ytFollowedArtists` | `{ channelId, name, thumbnailUrl, followedAt }` |
| `ytSavedAlbums` | full album snapshot from `getAlbum()` + `savedAt` (header + tracks) |
| `ytRecentAlbums` | rolling list (max 20) of YT album/track "album" cards played recently |

Local playlists (`playlists` store) accept YT tracks directly — a YT playlist
entry is the existing `_ytQueueItem()` shape (`filePath` = watch URL,
`artPath` = thumbnail URL, `albumId` = `yt_…`). No store migration needed;
existing code treats tracks as opaque objects keyed by `filePath`.

Identity rules: YT tracks are identified by `filePath`
(`https://www.youtube.com/watch?v=<id>`) everywhere — likes, playlists,
now-playing checks. YT artists by `channelId`, YT albums by `browseId`.

## 1. Deep search filters

### Backend (`youtube-search.js`)
- `searchMusicFull()` gains a 4th parallel call: `yt.music.search(query, { type: 'playlist' })`
  → `playlists` section mapped by new `mapPlaylistItem()`
  (`{ playlistId, title, author, songCount, thumbnailUrl }`).
- New `searchContinue(kind, query, token)` supporting pagination for each entity
  kind via youtubei.js continuations (`res.getContinuation()`). First page
  returns `{ items, continuation }`; continuation token is opaque to the
  renderer. Music-scope kinds: `song`, `album`, `artist`, `playlist`.
  All-of-YouTube scope: `video`.
- Keep result caps per section on the main search (10 songs / 12 albums /
  8 artists / 8 playlists); See-all pages page in 25 at a time.

### IPC (main.js) + preload
- `yt-search-page` — `{ kind, query, continuation? }` → `{ ok, items, continuation }`.
- Existing `yt-music-search` response gains `playlists`.

### Renderer
- Search filter tabs become **All / Songs / Albums / Artists / Playlists**.
  The YT sub-section filter (`_applyYtFilter`) and the local-section filter both
  honor the new tab; local content has no playlists section in search (local
  playlist search stays on the Playlists page), so the Playlists tab shows only
  the YT sub-section.
- YT Playlists section renders playlist cards (square art, title, "Playlist ·
  author · N songs"), click → `yt-playlist` page.
- Every YT sub-section header gets a **See all** button → `navigate('yt-see-all',
  { kind, query })`. New page renders a paged grid/list of that entity kind with
  a **Load more** button while a continuation exists. Rows/cards reuse the same
  renderers and bind the same actions as search results.
- "All of YouTube" scope keeps its flat video list and also gets See all/Load
  more (kind `video`).

## 2. Playlists

### YT playlist page (`yt-playlist`)
- New backend `getPlaylist(playlistId)` via `yt.music.getPlaylist()` →
  `{ playlistId, title, author, songCount, thumbnailUrl, tracks[] }` (tracks are
  song-shaped: videoId/title/artist/duration/thumbnailUrl).
- IPC `yt-playlist` + preload `ytPlaylist`.
- Page mirrors the yt-album page: gradient hero (Playlist · YT badge · author ·
  N songs), controls row — **Play all, Shuffle, +Queue all, Download all,
  Save to your playlists** — and track rows identical to yt-album rows
  (number, title/artist, like ♥, download, duration; click row = play from here;
  context menu as below).
- **Save to your playlists** creates a local playlist named after the YT
  playlist with all tracks as YT queue items, then navigates to it.

### Local playlists accept YT tracks
- **Add to playlist ▸** appears in every YT context menu (search rows, see-all
  rows, yt-album track rows, yt-playlist track rows) and as an action in the
  row's context menu — submenu lists existing playlists + "New playlist…",
  same as the local flow.
- Playlist page rendering handles YT entries: `artPath` that is an http(s) URL
  renders as `<img src>` directly (no `file://` prefix — extend `artImg()`),
  row shows the YT badge, duration/title/artist come from the stored object.
  Reorder/remove/sort work unchanged (keyed by `filePath`/position).
- Recommended-tracks logic skips YT rows when computing genre/artist matches
  (they have no library albumId); YT tracks are simply never recommended from
  the local library — acceptable.
- Playlist play/shuffle/queue flows work unchanged — the player shim already
  streams http(s) filePaths through mpv's ytdl hook.

## 3. Home feed + saves

### Likes (songs)
- ♥ toggle on every YT row (search songs, see-all songs, yt-album tracks,
  yt-playlist tracks, queue panel rows for YT items). State check:
  `ytLikedTracks.some(t => watchUrl(t.videoId) === filePath)` — expose helper
  `isYtLiked(filePath)`.
- Liked Songs page merges: local liked (existing resolve via library) followed
  by YT liked (rendered from stored metadata, YT badge, newest first),
  play/queue/context actions identical to search rows.

### Follows (artists)
- **Follow / Following** toggle button on the yt-artist page header (same style
  as the local artist page follow button).
- Home "Following" row and the library Artists view merge YT followed artists —
  round thumb from `thumbnailUrl`, name, "Artist · YT"; click →
  `yt-artist/channelId`.

### Saved albums
- **Save / Saved** toggle (♥ or bookmark styled like local) on the yt-album
  page controls row. Saving stores the full `getAlbum()` snapshot.
- Library grid merges saved YT albums as cards (thumbnail art, YT card badge),
  sorted into the existing sort modes using `savedAt` as addedAt. Click opens
  `yt-album` rendered **instantly from the snapshot**, with a background
  `yt-album` IPC refresh that re-renders if data changed.
- Home "Recently Added" style row includes newly saved YT albums.

### Home feed
- New backend `getHomeFeed()` via `yt.music.getHomeFeed()` → up to 3 sections:
  `{ title, kind: 'songs'|'albums', items[] }` (quick picks → song rows,
  charts / new releases / recommended albums → album cards). Section detection
  is defensive: skip anything that doesn't map cleanly.
- IPC `yt-home` + preload `ytHome`. Session-cached in the renderer
  (`ytHomeCache`), fetched lazily after the local home sections paint;
  on failure/offline the YT block is silently omitted.
- Rendered below local home sections as `scroll-row` carousels with the YT
  badge treatment; song rows bind play/queue/download/context, album cards
  navigate to `yt-album`.

### Recently played
- Playing any YT track pushes a card into `ytRecentAlbums`
  (`{ albumId: yt_…, name, artist, artUrl, playedAt }` — from the queue item),
  deduped, capped at 20. Home quick-grid and Recently Played row merge these
  (badge, click → replay the track / open the yt-album when it is a real album).

## Every click (inventory)

Row (song/video): click = play · hover/visible ▶ = play · **+** = queue (✓ flash)
· ♥ = like toggle · ⬇ = download · right-click = Play now / Play next /
Add to queue / Like–Unlike / Add to playlist ▸ / Go to album (when known) /
Go to artist / Download.
Card (album/artist/playlist): click = entity page · hover ▶ (albums/playlists) =
play all.
Entity pages: hero ▶ = play all · Shuffle · +Queue all · Download all ·
Save/Follow toggle · per-track rows as above · artist page rows: top songs +
Albums / Singles carousels (+ See all pages already covered by search see-all).
Sections: See all → paged page with Load more.

## Error handling

- All new IPC handlers return `{ ok, error }` like existing yt handlers; the
  renderer shows `yt-status yt-error` blocks inline, never blank sections.
- Home feed and background album refresh fail silently (log to console).
- Continuation failures show a "Couldn't load more" inline note with retry.
- Stale-response guards (query/scope/page changed while awaiting) follow the
  existing `ytSearchState.lastQuery` pattern; see-all pages guard on
  `state.currentPage`.

## Testing

- Unit tests for new mappers: `mapPlaylistItem`, `getPlaylist`, `getHomeFeed`
  section mapping, `searchContinue` (mock client via `_setClientForTest`),
  run under Electron's runtime (`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron`).
- Renderer store-merge helpers (`isYtLiked`, merge functions) unit-tested where
  they are pure.
- Existing test suite must stay green; manual QA pass over the click inventory.

## Constraints

- youtubei.js stays pinned to ~14.0.0 (Electron 28 / Node 18 — no import
  attributes).
- No Web Audio; playback stays in mpv (watch URLs through the ytdl hook).
- CSP already allows `img-src https:`.
