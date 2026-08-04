# Papa Audio Android — YouTube via Bridge Server

Date: 2026-07-07
Scope: MVP (search → play → download). Browsing (YT album/artist/home/radio) is out of scope.

## Problem

The desktop Electron app has full YouTube support (`youtube-search.js` via youtubei.js,
`youtube-download.js` via yt-dlp, playback through mpv's ytdl hook). The Android app talks
only to the bridge server (`bridge-server/server.js`, port 8765), which has no YouTube
endpoints. So the phone has everything (library streaming, Soulseek, lyrics, EQ) except YouTube.

## Approach

The phone never runs YouTube code. The bridge server (Node, on the desktop) reuses the two
existing desktop modules one directory up (`../youtube-search`, `../youtube-download`) and
exposes them as LAN endpoints. Streaming is **proxied** through the bridge so
react-native-track-player gets a normal seekable HTTP source (no expiring googlevideo URLs
on the phone).

## Bridge endpoints (new `bridge-server/youtube.js`)

- `GET /api/youtube/search?q=&scope=music|all`
  - `music` → `ytSearch.searchMusic(q)`; `all` → `ytSearch.searchAll(q)`
  - Returns `{ items: YtItem[] }`, `YtItem = {videoId,title,artist,album,duration,thumbnailUrl}`
- `GET /api/youtube/stream?videoId=` — the proxy:
  1. Resolve `yt-dlp -f bestaudio -g <videoId>` → direct URL; cache `videoId→url` in memory ~1h
  2. HTTP-GET that URL forwarding the phone's `Range` header; pipe back
     status/`Content-Range`/`Content-Length`/`Accept-Ranges`
  3. On `403/410` mid-stream, drop cache, re-resolve once, retry
- `POST /api/youtube/download {videoId,title,artist}`
  - `ytDownloader.downloadAudio` into `<downloadDir>/YouTube/`
  - Progress pushed over existing `/events` SSE as `youtube-download-progress {videoId,pct,done,error}`
  - File appears in library after a scan

Init: `ytSearch.setCacheDir(<userData>/yt-cache)`, anonymous (no Google cookie needed for
search/playback). Wire-in: `require('./youtube')(app, { sseSend, getDownloadDir, cacheDir })`
before `app.listen`.

## Android changes

- `services/bridge.ts`: `youtubeSearch()`, `youtubeStreamUrl(videoId)` (pure URL builder),
  `youtubeDownload()`; `YtItem` type
- `store/player.ts`: `playYouTube(item)` — build a track with `url: youtubeStreamUrl(videoId)`,
  artwork = thumbnail, marked as a YouTube source
- `app/(tabs)/search.tsx`: third tab `youtube` alongside `local | soulseek`, reusing the
  existing search box + history. Tap = stream; download icon = save to library (SSE progress)

## Build & deliver

- `cd android && ./gradlew assembleRelease` (JAVA_HOME=~/jdk17)
- Copy the release APK to `/home/shaharyar/Desktop/PapaAudio-APK/` for easy reach

## Testing

- Bridge: `node --test` for the URL resolver + cache and the search endpoint
- Manual: search a song on the phone → plays and seeks; download → appears in library after scan
