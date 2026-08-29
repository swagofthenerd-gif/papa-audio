# Papa Video — Movies, TV & Anime Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Movies/TV/Anime streaming surface to Papa Audio: browse TMDB/AniList catalogs, resolve playable streams (YTS torrents for reliable 5.1, plus direct-stream backends), and play them embedded via a second mpv process with PCM 5.1.

**Architecture:** Pure, I/O-free modules for catalog normalisation and provider ranking around a thin `fetch` shell; a torrent-stream engine that reuses the existing `webtorrent` client and its Range-aware HTTP server; a video mpv process (`video-engine.js`) that mirrors `mpv-engine.js` and reuses `channelsValue()` and `MpvIpcClient`. IPC via `main.js` handlers exposed through `preload.js`.

**Tech Stack:** Electron 28 (Node 18 runtime, global `fetch`), CommonJS (`require` only), `webtorrent@1.9.7` (already a dependency), `node --test` (Node v24 toolchain), mpv, ffprobe. No new runtime dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-29-papa-video-design.md`

## Global Constraints

- **CommonJS only.** Use `require`. Do not add ESM files or `"type": "module"`.
- **No new runtime dependencies.** Torrents reuse `webtorrent@1.9.7` (already installed). Catalog uses the global `fetch`. Everything else is `require` of existing modules.
- **Tests run with** `node --test 'test/**/*.test.js'` (full suite via `npm test`). Single file: `node --test test/<file>`.
- **5.1 / surround:** the video mpv must reuse `channelsValue(layout)` from `mpv-engine.js` (it maps `'auto'` → `'auto-safe'`); never omit `--audio-channels`; never add `--audio-spdif`. Exclusive ALSA output reuses the existing `outputMode`/`alsaDevice` config keys.
- **TMDB key** is read from `electron-store` key `videoSettings.tmdbApiKey`, falling back to env `TMDB_API_KEY`. It must **never** be hardcoded or committed. (The user's key is `5f55ab3ab40475113ac279cfdddda6c1` — reference it only in Settings UI text/local config, never in source.)
- **Playback stays in mpv.** Never reintroduce Web Audio / `<audio>` / `<video>` element playback for video.
- **Play buttons always visible** (`opacity: .85` at minimum), matching the music-side rule.
- **Styling** uses the existing CSS variables (`--bg3`, `--text2`, `--bg4`, `--border`, `--r`, `--text3`, etc.) and the Spotify-like look already in `src/styles.css`.
- **Internal shapes** (exact, used across tasks):

```js
// Catalog entry (what the UI renders)
{ id, type: 'movie'|'tv'|'anime', title, year, poster, backdrop, overview, rating, genres: [] }
// TV adds:  seasons: [{ seasonNumber, name, episodeCount, episodes: [{ episodeNumber, name, overview, still, airDate }] }]
// Anime adds: episodeCount (total), status, isSub?: undefined (sub/dub is stream-level)

// Stream entry (provider output / source-picker item)
{ kind: 'http'|'torrent', url: null|string, magnet: null|string, infoHash: null|string,
  fileIndex: null|number, source: string, quality: '2160p'|'1080p'|'720p'|'480p'|'unknown',
  label: string, audioLayout: null|'5.1'|'stereo', sub: null|boolean, dub: null|boolean }
```

---

### Task 1: TMDB catalog (`catalog/tmdb.js`)

**Files:**
- Create: `catalog/tmdb.js`
- Test: `test/catalog-tmdb.test.js`

**Interfaces:**
- Produces (consumed by Task 9 IPC):
  - `normalizeMovie(raw)` → catalog entry (`type:'movie'`)
  - `normalizeTv(raw)` → catalog entry (`type:'tv'`, with `seasons` when `raw.seasons` present)
  - `normalizeSeason(raw)` → `{ seasonNumber, name, episodeCount, episodes }`
  - `normalizeSearchResult(raw)` → `{ id, type:'movie'|'tv', title, year, poster }`
  - `buildTrendingUrl(kind, opts)` / `buildPopularUrl(kind)` / `buildSearchUrl(query)` / `buildDetailUrl(type,id)` / `buildSeasonUrl(tvId,n)` — pure URL string builders (base `https://api.themoviedb.org/3`, `api_key` query param appended by the caller)
  - `createTmdbCatalog({ apiKey, fetchFn })` → `{ trending(kind), popular(kind), search(query), detail(type,id), season(tvId,n) }` — the thin fetch shell; each method fetches, checks `res.ok`, returns the *normalized* shape. `fetchFn` defaults to global `fetch`; injectable for tests.

- [ ] **Step 1: Write the failing test** — `test/catalog-tmdb.test.js` uses fixture objects (hand-written, not network). Assert:
  - `normalizeMovie` maps `{ id, title, release_date, poster_path, backdrop_path, overview, vote_average, genre_ids }` → `{ id, type:'movie', title, year: '2010', poster, backdrop, overview, rating, genres: [] }`; `poster` = `https://image.tmdb.org/t/p/w500` + path (or `null` when absent); `year` from `release_date.slice(0,4)`; missing fields → `null`/`[]`.
  - `normalizeTv` uses `name` and `first_air_date`; includes `seasons` only when `raw.seasons` present, each via `normalizeSeason`.
  - `normalizeSeason` maps `{ season_number, name, episode_count, episodes: [{ episode_number, name, overview, still_path, air_date }] }` → episode `still` prefixed same as poster.
  - `normalizeSearchResult` handles `media_type` in `{'movie','tv'}` and ignores others (returns `null`).
  - URL builders produce the exact expected strings.
  - `createTmdbCatalog` with a fake `fetchFn` (returns `{ ok:true, json: async () => fixture }`) returns normalized data; a `{ ok:false, status: 401 }` throws an Error containing `'TMDB'`.

- [ ] **Step 2: Run test** — `node --test test/catalog-tmdb.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `catalog/tmdb.js` to satisfy the above exactly. Keep every function pure; the fetch shell is the only place with I/O.
- [ ] **Step 4: Run test** — expect PASS.
- [ ] **Step 5: Commit** — `git add catalog/tmdb.js test/catalog-tmdb.test.js && git commit -m "feat(video): tmdb catalog normalisation + fetch shell"`

---

### Task 2: AniList catalog (`catalog/anilist.js`)

**Files:**
- Create: `catalog/anilist.js`
- Test: `test/catalog-anilist.test.js`

**Interfaces:**
- Produces (consumed by Task 9 IPC):
  - `normalizeMedia(raw)` → anime catalog entry (`type:'anime'`): `id` = `raw.id`, `title` = `raw.title.english || raw.title.romaji || raw.title.native`, `year` from `raw.seasonYear`, `poster` = `raw.coverImage.large`, `overview` = `raw.description`, `rating` = `raw.averageScore` (number, may be null), `genres` = `raw.genres`, `episodeCount` = `raw.episodes`, `status` = `raw.status`.
  - `buildQuery(kind, { page, perPage })` → the GraphQL query string for `trending|popular|season|search`. Search takes `query`/`type: 'ANIME'`.
  - `createAnilistCatalog({ fetchFn })` → `{ trending(page), popular(page), season(page), search(query, page) }`; each POSTs `{ query, variables }` to `https://graphql.anilist.co` with `Content-Type: application/json`, returns `data.Page.media.map(normalizeMedia)`.

- [ ] **Step 1: Failing test** — `test/catalog-anilist.test.js` with fixtures: assert `normalizeMedia` title fallback order, `year` from `seasonYear`, poster/overview/rating/genres/episodeCount/status mapping, and `createAnilistCatalog.search` builds the right variables and normalizes a fake response. Assert a non-OK / GraphQL-error response throws.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): anilist catalog (graphql) normalisation"`

---

### Task 3: Provider router + ranker (`providers/index.js`)

**Files:**
- Create: `providers/index.js`
- Test: `test/providers-index.test.js`

**Interfaces:**
- Produces (consumed by Tasks 4, 8, 9):
  - `qualityRank(q)` → number; `'2160p'`→4, `'1080p'`→3, `'720p'`→2, `'480p'`→1, else 0.
  - `isMultichannel(audioLayout)` → boolean (`audioLayout === '5.1'`).
  - `rankStreams(entries, { preferSurround = true } = {})` → new sorted array. Score = `qualityRank + (preferSurround && isMultichannel(audioLayout) ? 1 : 0)`; sort by score desc, then multichannel desc, then quality desc, then `source` asc (stable tie-break). Does not mutate input.
  - `resolveStream(request, backends, { preferSurround, timeoutMs = 8000 } = {})` → `Promise<entries[]>`. Fans out to every `backends` function concurrently with `Promise.allSettled`; collects fulfilled results, flattens, de-duplicates by `(kind, url||magnet)`, then returns `rankStreams(...)`. A rejected backend is skipped. `request` = `{ type, tmdbId?, anilistId?, title?, year?, season?, episode? }`.

- [ ] **Step 1: Failing test** — `test/providers-index.test.js`:
  - Ranking: a 1080p `audioLayout:'5.1'` entry sorts above a 2160p `audioLayout:null` entry when `preferSurround:true`; when `preferSurround:false`, 2160p wins. Same-quality: 5.1 above stereo. Input array is not mutated.
  - `resolveStream`: two fake backends — one resolves `[entryA]`, one rejects; result contains `entryA` and does not throw. Duplicate `(kind,url)` from two backends appears once.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): provider router + surround-aware ranking"`

---

### Task 4: YTS torrent provider (`providers/yts.js`)

**Files:**
- Create: `providers/yts.js`
- Test: `test/providers-yts.test.js`

**Interfaces:**
- Produces (consumed by Task 9):
  - `createYtsProvider({ fetchFn })` → `async (request) => entries[]`.
  - `normalizeMovieResult(raw, { baseUrl = 'https://yts.mx' })` → torrent entries (one per torrent in `raw.torrents`), each: `{ kind:'torrent', url: null, magnet: <magnet url>, infoHash: raw.torrent.hash, fileIndex: 0, source: 'YTS', quality: raw.quality mapped ('2160p'|'1080p'|'720p'|'480p'|'unknown'), label: 'YTS · <quality>', audioLayout: '5.1', sub: null, dub: null }`. A torrent whose `hash` is missing is skipped.

  Resolution logic: build `GET ${baseUrl}/api/v2/list_movies.json?query_term=<title year>&limit=5`; pick the best match (title match, and if `request.year` given, prefer `movie.year === year`); then map its `torrents`. `fetchFn` injectable. Search/JSON is cached by the caller (Task 9), not here.

- [ ] **Step 1: Failing test** — `test/providers-yts.test.js`:
  - `normalizeMovieResult` on a fixture with 3 torrents (720p/1080p/2160p) yields 3 entries, correct magnet/hash/quality/label/audioLayout='5.1'; a torrent missing `hash` is dropped.
  - Full `createYtsProvider` with a fake `fetchFn` returning a fixture `list_movies.json` resolves to entries for a matched title; a non-OK response returns `[]` (does not throw).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): yts torrent provider"`

---

### Task 5: Torrent stream engine (`torrent-stream.js`)

**Files:**
- Create: `torrent-stream.js`
- Test: `test/torrent-stream.test.js`

**Interfaces:**
- Produces (consumed by Task 9):
  - `class TorrentStreamer extends EventEmitter` with `constructor({ client, timeoutMs = 20000 })` (`client` = webtorrent instance, injectable). Events: `'ready'` `{ url }`, `'progress'` `{ downloaded, total, speed, percent }`, `'error'` `{ code, message }`.
  - `async start({ magnet, fileIndex = 0 })` → resolves `{ url }` when the file is servable. `stop()` → destroys server + torrent cleanly (idempotent).
  - `buildFileUrl(port, fileIndex, fileName)` → `http://127.0.0.1:${port}/${fileIndex}/${encodeURIComponent(fileName)}`.

  Implementation: `client.add(magnet)` → on `'ready'`, pick `torrent.files[fileIndex]`, call `torrent.createServer()` and listen on port `0`; derive the actual port from `server.address().port`; return `buildFileUrl`. Forward `torrent.on('download')` to `'progress'`. If `timeoutMs` elapses without `'ready'`, emit `'error'` `{ code: 'NO_SEEDERS' }` and `destroy` the torrent.

- [ ] **Step 1: Failing test** — `test/torrent-stream.test.js` with a **fake client** (a minimal object implementing `add(magnet, cb)` that calls back with a fake torrent exposing `files: [{ name, length, createReadStream: () => new stream.Readable() }]`, `createServer()` returning a real `http.createServer()` stub that immediately reports `.address()`, `on()`, `destroy()`, `removeListener()`):
  - `buildFileUrl(8080, 0, 'Movie (2010) 1080p.mp4')` produces the exact encoded URL.
  - `start()` resolves with a URL matching `^http://127.0.0.1:\d+/0/`.
  - When the fake client never calls back (timeout short via injected `timeoutMs: 10`), `start()` rejects / emits `'error'` with code `'NO_SEEDERS'`.
  - `stop()` after `start()` does not throw and is callable twice.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): torrent stream engine over existing webtorrent"`

---

### Task 6: Video engine (`video-engine.js`)

**Files:**
- Create: `video-engine.js`
- Test: `test/video-engine.test.js`

**Interfaces:**
- Produces (consumed by Task 9): `class VideoEngine extends EventEmitter`, mirroring `mpv-engine.js`'s discipline but for video. Constructor `({ config = {}, spawnFn, binary = 'mpv' })`. Key methods: `_args(socketPath)` (pure — this is what the tests assert), `async start(url, { wid })`, `stop()`, `command(...)`, `load(url)`.
- `_args(socketPath)` must return an array that includes: `--no-terminal`, `--idle=yes`, `--input-ipc-server=${socketPath}`, `--wid=<wid>` (when provided), `--audio-channels=${channelsValue(config.audioChannels)}` (import `channelsValue` from `mpv-engine.js`; if it is not exported there, export it), `--cache=yes`, `--demuxer-max-bytes=64MiB`, `--ytdl=no`. When `config.outputMode === 'exclusive' && config.alsaDevice`, also `--audio-device=${alsaDevice}` and `--audio-exclusive=yes`. Must **not** contain `--audio-spdif` or `--no-video`.

- [ ] **Step 1: Failing test** — `test/video-engine.test.js`, mirroring `test/mpv-engine.test.js`:
  - `_args('/tmp/v.sock')` with `config.audioChannels:'5.1'` includes `--audio-channels=5.1` and `--input-ipc-server=/tmp/v.sock`; never `--no-video`; never `--audio-spdif`.
  - `config.audioChannels:'auto'` → `--audio-channels=auto-safe`.
  - `_args(..., { wid: '0x1a2b' })` includes `--wid=0x1a2b`.
  - `config = { outputMode:'exclusive', alsaDevice:'alsa/hw:2,0' }` → includes `--audio-device=alsa/hw:2,0` and `--audio-exclusive=yes`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** (reuse `MpvIpcClient` from `mpv-ipc.js`; keep a generation counter + `alive` flag like the audio engine; `start()` spawns with `_args` and `spawnFn`/`spawn`, then connects the IPC client).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): mpv video engine with 5.1 pcm args"`

---

### Task 7: YarrList directory (`yarrlist-directory.js`)

**Files:**
- Create: `yarrlist-directory.js`
- Test: `test/yarrlist-directory.test.js`

**Interfaces:**
- Produces (consumed by Task 9/10):
  - `parseSites(html, category)` → `[{ name, url, category }]`. Extract `<a href>` links from the page, filter to absolute `http(s)` URLs that are not `yarrlist.*`, skip anchors/`#`, de-duplicate by hostname, and tag each with `category` (`'movies-tv'` or `'anime'`).
  - `createYarrlistDirectory({ fetchFn })` → `{ refresh() }` where `refresh()` fetches `https://yarrlist.net/movies-and-tv-shows` and `https://yarrlist.net/anime-list`, parses each, and returns `{ moviesTv: [...], anime: [...], fetchedAt }`.

- [ ] **Step 1: Failing test** — `test/yarrlist-directory.test.js` with a fixture HTML string: assert `parseSites` returns the expected sites, de-duplicates by host, excludes a `yarrlist.net` link and a `#` link, and tags categories correctly. `refresh()` with a fake `fetchFn` returns both categories.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** (no DOM library — regex/extraction over the HTML string is fine; the page is simple `<a>` markup).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): yarrlist source directory parser"`

---

### Task 8: Direct-stream providers (`providers/movie-tv.js`, `providers/anime.js`)

**Files:**
- Create: `providers/movie-tv.js`, `providers/anime.js`
- Test: `test/providers-http.test.js`

**Interfaces:**
- Produces (consumed by Task 9):
  - `createMovieTvProvider({ fetchFn, resolvers = [] })` → `async (request) => entries[]`
  - `createAnimeProvider({ fetchFn, resolvers = [] })` → `async (request) => entries[]` (tags `sub`/`dub` from each result)
  - `normalizeHttpEntry(raw)` → a valid `kind:'http'` entry: `{ kind:'http', url, source, quality, label, audioLayout, sub, dub }`.

**Honesty note (implementer must respect):** these backends resolve against *live* streaming sites that change and rotate; a resolver can silently stop working. For v1, implement the **adapter + a single resolver stub** that returns `[]` when no resolver is configured, plus `normalizeHttpEntry` fully tested. Each concrete resolver is a small function injected via `resolvers` and wrapped in try/catch so a dead resolver never throws. The reliable 5.1 path is Task 4/5 (YTS torrent); these HTTP backends are additive and may need live tuning later. Do **not** hand-write fragile site-scraping regexes in this task beyond a single clearly-named `vidsrc` resolver that maps a TMDB id to a known embed URL template and returns it tagged `quality:'1080p'`, `audioLayout:null` — treat it as best-effort and isolate it.

- [ ] **Step 1: Failing test** — `test/providers-http.test.js`:
  - `normalizeHttpEntry` coerces a raw `{ url, quality, title, sub, dub }` into a valid entry with `kind:'http'`, `source` defaulting to `'http'`, missing fields nulled.
  - `createMovieTvProvider({ resolvers: [fakeOk, fakeThrow], fetchFn })` returns only `fakeOk`'s entries and does not throw.
  - A provider with no resolvers returns `[]`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): http provider adapter (best-effort)"`

---

### Task 9: Settings, IPC handlers, preload wiring

**Files:**
- Modify: `main.js` (add handlers + wiring), `preload.js` (expose API), `src/renderer.js` (a minimal `window.api` surface is created in preload; no UI yet)
- Test: `test/video-ipc.test.js` (asserts handler registration strings / exported surface via the same technique as `test/preload-surface.test.js` and `test/ipc-channel-wiring.test.js`)

**Interfaces:**
- IPC handlers (all `ipcMain.handle`): `video-catalog-get`, `video-search`, `video-detail`, `video-streams`, `video-probe`, `video-play`, `video-stop`. Reuse the existing slskd-style timeouts map (see `main.js` line ~49) by adding `'video-play'` and `'video-probe'` with generous budgets.
- Wiring in `main.js`:
  - Lazily construct `catalog = createTmdbCatalog({ apiKey: videoSettings.tmdbApiKey || process.env.TMDB_API_KEY, fetchFn: fetch })`, `anilist = createAnilistCatalog({ fetchFn: fetch })`, `yts = createYtsProvider({ fetchFn: fetch })`, `movieTv = createMovieTvProvider({ fetchFn: fetch })`, `anime = createAnimeProvider({ fetchFn: fetch })`.
  - `video-streams` = `resolveStream(request, [yts, movieTv, anime], { preferSurround: videoSettings.preferSurround !== false })`, with a `ttl-cache.js` entry (short TTL, ~15 min).
  - `video-probe` = run `ffprobe -v error -show_entries stream=codec_type,channels,codec_name -of json <url>` (mirror the ffprobe usage already in `main.js` for artwork, but over a URL) and map the audio stream's `channels` through `classify()` from `src/surround-verify.js`. Return `{ ok, audioLayout, channels }`.
  - `video-play` = ensure the audio engine is paused/stopped first (the existing music engine), then `videoEngine.start(url, { wid })`. Return `{ ok }`. `video-stop` = `videoEngine.stop()`.
- `preload.js`: expose `videoCatalogGet`, `videoSearch`, `videoDetail`, `videoStreams`, `videoProbe`, `videoPlay`, `videoStop`, plus `onVideoProgress`/`onVideoEvent` channels as needed, mirroring the `torrentAdd`-style entries already at `preload.js:100-102`.

- [ ] **Step 1: Failing test** — assert the new channel names appear in the preload surface and IPC timeout map (copy the approach in `test/ipc-channel-wiring.test.js` / `test/preload-surface.test.js`).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** wiring.
- [ ] **Step 4: Run** — expect PASS (and `npm test` still green).
- [ ] **Step 5: Commit** — `git commit -m "feat(video): settings, ipc handlers, preload surface"`

---

### Task 10: Renderer UI — catalog, detail, source picker, video panel

**Files:**
- Modify: `src/renderer.js`, `src/index.html`, `src/styles.css`
- Test: `test/video-ui.test.js` (string-level assertions, following `test/renderer-hygiene.test.js` patterns — e.g. assert the sidebar entry, the video panel element id, and that play buttons carry `opacity:.85`)

**Interfaces:**
- Add a sidebar entry **"Movies & TV"** (reuse the existing sidebar nav mechanism in `renderer.js`).
- A `renderVideoView()` that shows rows of poster cards from `videoCatalogGet` (Trending Movies, Popular TV, Trending Anime). Cards use `--bg3`/`--text2` and a poster `<img>`.
- A detail view (movie → overview/rating/genres + source picker; TV → season selector + episode list; anime → episode picker + sub/dub toggle).
- A source picker listing `videoStreams` results with badges `"<quality> · <audioLayout||'stereo'>"`, torrent entries marked, each with an always-visible Play button.
- A **video panel** element (`id="video-panel"`) that holds the embedded mpv surface (a child `BrowserWindow`/native view is the Task 11 spike's job; here the panel + its show/hide + controls scaffold live in the DOM).
- Wire Play → `videoPlay({ result })`; show buffering state for torrents (via progress events); "stop" tears down and returns to catalog.
- Settings: add `videoSettings` fields to the existing Settings surface — TMDB key input, `preferSurround` toggle, `preferredQuality` select.

- [ ] **Step 1: Failing test** — assert presence of: `id="video-panel"`, the "Movies & TV" nav label, a `.video-source-play` class with `opacity` styling rule present in styles.css, and that `renderVideoView` exists as a function string.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** UI (mirror existing views; keep it minimal but real).
- [ ] **Step 4: Run** — expect PASS; `npm test` green.
- [ ] **Step 5: Commit** — `git commit -m "feat(video): movies/tv/anime ui (catalog, detail, source picker, panel)"`

---

### Task 11: Wayland embedding spike + end-to-end verification

**Files:**
- Modify: `main.js` (embed surface), possibly `video-engine.js` (wid plumbing)
- Test: manual + `npm test`; no new unit tests (this is integration)

**Interfaces:**
- De-risk `--wid` embedding under KDE Plasma Wayland. Attempt order: (1) obtain a native window id for the `video-panel` region and pass `--wid`; (2) if unavailable, force the video surface through XWayland; (3) fallback frameless always-on-top mpv window.
- Verify end-to-end: launch the app, browse a catalog row, open a known title, confirm YTS torrent entries resolve and a 1080p 5.1 entry plays with audio in the correct channels (probe badge shows `5.1`), and that music pauses on video start.

- [ ] **Step 1:** Implement the embed path + fallback in `main.js`/`video-engine.js`.
- [ ] **Step 2:** `npm test` green; manual run confirms playback.
- [ ] **Step 3: Commit** — `git commit -m "feat(video): wayland embed spike + fallback"`

---

## Self-review notes (checked)

- Spec coverage: §1→Task 1, §2→Task 2, §3 (ranking/backends)→Tasks 3/4/8, §4→Tasks 5/6, §5→Task 7, §6→Task 9, §7→Task 10, spike→Task 11. 5.1 guarantee threaded through Tasks 3/4/6/9.
- No placeholders; every task has concrete interfaces, file paths, and test targets.
- Type consistency: `channelsValue` import target (Task 6) is the same `channelsValue` in `mpv-engine.js`; `classify` (Task 9) is the export in `src/surround-verify.js`; entry shapes match the Global Constraints block exactly.
