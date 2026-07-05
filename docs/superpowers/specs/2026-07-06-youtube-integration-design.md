# YouTube Integration — Design

**Date:** 2026-07-06
**Status:** Approved

## Goal

Search YouTube's music catalog from Papa Audio, presented Spotify-style, with per-track
**stream** (instant, via mpv) and **download** (yt-dlp, native format) actions. YouTube Music
is the default scope; a separate tab exposes full-YouTube results (DJ sets, bootlegs,
podcasts). The AI agent gets matching tools.

## Decisions

| Decision | Choice |
|---|---|
| Search backend | `youtubei.js` (Node, InnerTube API, no key) — covers both YT Music and full YouTube |
| Scope | YT Music default, full-YouTube via tab/toggle |
| Per-track actions | Stream instantly AND download — both offered on every result |
| Download format | Native `bestaudio` (`.opus`/`.m4a`), embedded tags + thumbnail. **No FLAC transcode** (lossy source) |
| Download location | `/mnt/data/MUSIC/Downloads/` (same as Soulseek) |
| UI | Unified search page: results grouped **Library / YouTube / Soulseek** |
| Streaming path | mpv's built-in yt-dlp hook — no new audio path, Purist mode preserved |
| Agent | 3 new tools: `youtube_search`, `youtube_play`, `youtube_download` |

## Architecture

### 1. Search module (main process) — `youtube-search.js`

New module wrapping `youtubei.js`:

- `searchMusic(query)` → YT Music results: `{ songs[], albums[], artists[] }`, each song
  `{ videoId, title, artist, album, duration, thumbnailUrl }`
- `searchAll(query)` → full YouTube results: `{ videoId, title, channel, duration, thumbnailUrl, viewCount }`

IPC handlers in `main.js`: `yt-music-search`, `yt-search`. Lazy-init the Innertube client
on first search; cache it for the session.

### 2. Unified search page (renderer)

- One search box → fires Library search (existing in-memory), `yt-music-search`, and
  `slsk-search` in parallel.
- Results render in three groups: **Library / YouTube / Soulseek**. Each group loads and
  errors independently — one source failing never blanks the others.
- YouTube group has two tabs: **Music** (default) and **All of YouTube**. Switching tabs
  re-queries via `yt-search`.
- Existing Soulseek search logic is untouched; its results render as a group here.
- Each YouTube result row: art, title, artist/channel, duration, YT badge, and two
  actions — **Play** (stream) and **Download**. Context menu (native `ctx-menu-show`)
  offers Play, Add to queue, Download.

### 3. Streaming

- Queue item for a YouTube track: `filePath: "https://www.youtube.com/watch?v=<id>"` plus
  title/artist/duration/art from search metadata.
- mpv plays the URL through its yt-dlp hook with `ytdl-format=bestaudio`. Gapless prefetch
  and crossfade work unchanged. ~2 s startup latency accepted (URLs never go stale, unlike
  pre-resolved stream URLs).
- YouTube tracks mix freely with local tracks in the queue; UI shows a small YT badge.
- `mpv-engine.js`: ensure ytdl is enabled for URL entries (local files unaffected).

### 4. Download

- New IPC `yt-download(videoId, meta)`: spawn
  `yt-dlp -f bestaudio --embed-metadata --embed-thumbnail -o "/mnt/data/MUSIC/Downloads/%(artist,uploader)s - %(title)s.%(ext)s" <url>`
- Parse yt-dlp stdout for `%` progress → push to renderer via the same downloads/transfers
  UI Soulseek uses (new source type `youtube`).
- On completion, the file is picked up by the normal library rescan.

### 5. Agent tools (18 → 21)

- `youtube_search(query, scope)` — scope `music` | `all`, returns top ~10 results
- `youtube_play(query)` — search music scope, stream best match immediately
- `youtube_download(query)` — search music scope, download best match
- System prompt: fallback order **Library → YouTube stream (instant) → Soulseek download**.
  Pass only artist/song/album names as queries (existing rule applies).

## Error handling

- **Search:** per-group error text inside the group; other groups unaffected.
- **Stream failure** (deleted/region-locked/age-gated): skip to next queue item, show toast.
- **Download failure:** surfaced in downloads panel with yt-dlp stderr summary; retry action.
- **youtubei.js breakage** (YouTube API drift): search group shows error; app otherwise fine.
  Library and Soulseek unaffected.

## Out of scope

- No YouTube login / premium / personal playlists
- No FLAC or MP3 transcoding of downloads
- No pre-resolving stream URLs (mpv+yt-dlp handles it)
- No changes to Soulseek search internals

## Testing

- Unit: search result mapping (youtubei.js response → app result shape).
- Manual: search common + obscure tracks in both tabs; stream (start, pause, seek, next,
  crossfade into local track); download and verify tags/art in the file; agent commands
  ("play X from youtube", "download Y"); failure cases (garbage query, deleted video).
