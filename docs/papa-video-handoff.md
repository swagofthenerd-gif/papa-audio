# Papa Video — Implementation Handoff

**You are implementing the engine, data and logic layers of a video feature in an Electron app.**
A second engineer (Claude) is building every user-facing surface **in parallel**, against the
contracts in §4 of this document. Those contracts are frozen — build to them exactly.

Full specification: **`docs/papa-video-plan.md`** in this repo. Read it before starting.

---

## 1. Repo

```
Path      ~/flac-player          Branch  feature/papa-video
Base      commit ee735d5         Tests   1098 passing (`npm test`)
Run       npm start
```

**Stack: Electron 28, CommonJS, no build step, no framework, no TypeScript.**
The renderer is plain DOM string-building. **Do not introduce React, TS, a bundler, or any new
runtime dependency.** Match the style of the file you are editing.

### Process split
- `main.js` (~6300 lines) — Electron main. All network I/O and `ipcMain.handle` endpoints.
  The video section starts at the comment `── Papa Video:`.
- `preload.js` — `contextBridge` surface.
- `src/renderer.js` (~17k lines) — all UI. **Not yours** (see §3).

### Existing video subsystem
```
catalog/tmdb.js       TMDB movies + TV        catalog/anilist.js   AniList anime (GraphQL)
providers/yts.js      movie torrents          providers/eztv.js    TV torrents (IMDb id)
providers/nyaa.js     anime torrents          providers/apibay.js  broad TPB index
providers/quality.js  release-name parsing (quality, audio layout, cam detection, magnets)
providers/index.js    router: parallel fan-out, timeout, dedupe by infoHash, ranking
torrent-stream.js     WebTorrent → local HTTP server, file picking, prebuffer
video-engine.js       spawns mpv, JSON IPC over a unix socket
mpv-ipc.js            IPC client: command / observe_property / events
```

### Conventions — follow these exactly
- **Injectable I/O.** Every module doing network work takes `{ fetchFn }` so tests run offline.
  Look at `providers/nyaa.js` for the canonical shape.
- **Providers never throw.** Total failure returns `[]`. Mirror this in every new client.
- **Ticket guards** for async that touches shared state — see `_videoSeasonTicket` in
  `src/renderer.js`. A stale response must never overwrite newer state.
- **Tests are `node:test`**, one file per module in `test/`, named `test/<module>.test.js`.
  Run with `npm test`.
- **Comments explain WHY, not WHAT.** Look at the existing files: they document the bug the code
  exists to prevent. Match that. Do not add comments restating the function name.

### Reuse — do not rebuild
| Need | Use | Location |
|---|---|---|
| Debounced JSON persistence | `SideStore` | `side-store.js` |
| TTL + LRU cache | `makeCache` | `src/ttl-cache.js` |
| mpv property observation | the `OBSERVED_PROPS` loop | `mpv-engine.js:52,295` ← **copy this** |
| mpv commands | `client.command()` / `.observe()` | `mpv-ipc.js:101,140` |
| Audio layout from channel count | `classify` | `src/surround-verify.js` |

### Renderer module pattern
Modules under `src/` that the renderer uses are loaded as **classic scripts**, so they need the
UMD wrapper used by `src/ttl-cache.js:13-18` and must be added to the `<script>` list in
`src/index.html` (~line 650), **before `renderer.js`**.

---

## 2. ⚠ Traps that will cost you hours

1. **`preload.js` has a channel allowlist (~line 281).** A `send`/`on` channel not listed there
   fails **silently** — no error, nothing. Every new push channel must be added.
2. **`_videoWid()` may return null.** mpv embedding uses X11 `--wid` via XWayland. It is verified
   working on this machine, but the separate-window fallback must stay functional. Never assume
   embedding succeeded.
3. **Do not cache empty results.** Empty almost always means a transient upstream failure; caching
   it pins the failure for the whole TTL. This bug has already been fixed twice here.
4. **`fpcalc`/chromaprint is NOT installed.** Do not add a native dependency. Compute audio
   fingerprints in Node from ffmpeg PCM output.
5. **mpv is chatty on stderr.** An undrained pipe blocks the process. See `video-engine.js`.

---

## 3. Ownership — do not edit outside your column

| Yours | Claude's — **do not touch** |
|---|---|
| `catalog/tmdb.js`, `catalog/anilist.js` | `src/renderer.js` |
| `video-engine.js`, `torrent-stream.js` | `src/index.html` *(except adding `<script>` tags)* |
| `main.js` — video IPC section | `src/styles.css` |
| `preload.js` | `src/video-player.js` |
| `src/video-store.js`, `src/video-format.js` | |
| `src/video-keymap.js`, `src/skip-model.js` | |
| `skip/*`, `subtitles/*`, `trakt/*` | |
| `test/` for all of the above | |

Commit only your own files. If you believe a renderer change is required, **stop and say so**
rather than editing it.

---

## 4. Frozen contracts

Claude is coding against these now. Shapes must match exactly; extra fields are fine, missing or
renamed fields are not.

### 4.1 Preload surface (`window.api.*`)
```js
videoControl(verb, args)   // → { ok, value? }
videoTracks()              // → { ok, tracks: Track[] }
videoChapters()            // → { ok, chapters: Chapter[] }
videoSkipSegments(req)     // → { ok, segments: Segment[] }
onVideoState(cb)           // push, ~4/s while playing; returns an unsubscribe fn
```
`verb` ∈ `seek | pause | play | volume | mute | speed | track | subAdd | subDelay |
audioDelay | subStyle | aspect | zoom | audioFilter | screenshot | frameStep | stop`

### 4.2 `video-state` payload
```js
{ position, duration, paused, volume, muted, speed,
  buffered,                       // seconds of cache ahead of position
  eof,                            // true once the file ends
  video:  { width, height, codec },
  audio:  { layout, channels, codec },   // layout via classify()
  tracks: { sub, audio },                // currently selected ids, null when off
  chapters: Chapter[] }
```
Emit **throttled to ~4/s**. Send a full object every time — the UI does not merge partials.

### 4.3 Types
```js
Track    { id, type:'sub'|'audio', title, lang, codec, default, forced, external }
Chapter  { index, title, start }
Segment  { kind:'intro'|'recap'|'credits'|'preview', start, end,
           origin:'chapters'|'aniskip'|'detected'|'manual', confidence }  // 0..1
```

### 4.4 `src/video-store.js`
```js
PapaVideoStore.get(key)                  // key: "movie:27205" | "tv:1396:s1e2"
PapaVideoStore.setPosition(key, meta, position, duration)
PapaVideoStore.markWatched(key)
PapaVideoStore.continueWatching(limit)    // → newest first, unfinished only
PapaVideoStore.watchlist() / toggleWatchlist(item) / inWatchlist(type, id)
PapaVideoStore.history(limit)
PapaVideoStore.prefs(showKey) / setPrefs(showKey, patch)
PapaVideoStore.skip(seasonKey) / setSkip(seasonKey, segments)
```
Schema is in §16 of the plan. Watched at **≥90%**; anything under 2% is not "in progress".

### 4.5 `src/skip-model.js` (pure)
```js
mergeSegments(sources)          // resolve overlaps; higher confidence and manual always win
activeSegment(segments, t)      // → the segment covering t, or null
buttonFor(segments, t, prefs)   // → { label, action, segment } | null
```

### 4.6 `src/video-format.js` (pure)
```js
duration(sec)      // 1:07:23 / 7:23
size(bytes)        // 4.2 GB
bitrate(bps)       // 12.4 Mb/s
relativeDate(iso)  // "3 days ago"
certification(tmdbReleaseDates)  // "15" / "PG-13" / null
```

### 4.7 `src/video-keymap.js` (pure)
```js
resolve(event, context)   // → { action, arg } | null
```
Key table is in §8 of the plan. Must return `null` when focus is in an input.

---

## 5. Your scope

Implement in this order. **Each phase must end green (`npm test`) and be committed separately.**

| Phase | Plan § | What |
|---|---|---|
| **0** | §6 | Foundations: the four pure modules (§4.4–4.7), TMDB `append_to_response` metadata expansion, AniList `idMal`. Verify `_videoWid()` at runtime. |
| **1** | §7 | Playback core: mpv property observation, throttled `video-state`, all control verbs, IPC + preload surface, theatre `BrowserWindow` plumbing. **Claude builds the overlay DOM; you provide the surface and the data.** |
| **3** | §9 | Skip detection: `skip/aniskip.js` (verified working, no key), chapter classification, `skip/detect-intro.js` cross-episode audio correlation, manual overrides. **Logic only** — Claude builds the buttons. |
| **4** | §10 | Binge logic: next-episode resolution, prebuffer-during-credits, watched marking, season roll-over. **Logic only.** |
| **5** | §11 | `subtitles/opensubtitles.js` — search, rank, download, `sub-add`. **Client only.** |
| **10** | §16 | Watch data behind `src/video-store.js`. |
| **11** | §17 | Trakt device-flow OAuth + scrobble. Must be fully optional. |

**Not yours:** Phases 2, 6, 7, 8, 9, 12 — every visual surface, and the final polish pass.

### Definition of done, per phase
- `npm test` green, with real tests for new logic (not just "it is exported").
- Test the **failure** paths: dead network, malformed payload, missing key, cancellation.
- No new runtime dependency.
- Live-verify anything network-facing with a real request before claiming it works.
- Conventional-commit message explaining **why**, not just what.

---

## 6. Verified facts — do not re-litigate

Checked on this machine. Trust them.

| Fact | Evidence |
|---|---|
| **AniSkip works, no key.** `GET https://api.aniskip.com/v2/skip-times/{malId}/{ep}?types=op&types=ed&episodeLength=0` | One Piece ep 1 → `op 28.783–118.783`, `ed 1387.996–1500` |
| **AniList exposes `idMal`** — the key AniSkip needs | `Media(id:21)` → `idMal: 21` |
| **mpv properties present**: `chapter-list`, `audio-delay`, `sub-delay`, `sub-scale`, `sub-pos`, `video-zoom`, `video-aspect-override`, `af`, `speed`, `volume-max`, `demuxer-cache-time`, `track-list` | `mpv --list-properties` |
| **ffmpeg filters present**: `blackdetect`, `silencedetect`, `dynaudnorm`, `loudnorm` | `ffmpeg -filters` |
| **`fpcalc` is NOT installed** | `command -v fpcalc` |
| **`--wid` embedding works** — Wayland session but `Xwayland :0` running, Electron 28 defaults to X11 | `pgrep Xwayland`, `DISPLAY=:0` |
| mpv 0.41.0 · ffmpeg 8.0.1 · WebTorrent 1.9.7 · Electron 28.3.3 | — |

---

## 7. Rules of engagement

- **Do not touch the picture.** Buffer, cache and transport settings only. No mpv `--profile=fast`,
  no scaler, no filter that alters the image. A test in `test/video-engine.test.js` enforces this —
  if you make it fail, you have broken the product's core promise.
- **Report honestly.** If a phase is partly blocked, finish everything else and say precisely what
  you left and why. Do not claim a network feature works without a real request proving it.
- **Ask rather than guess** on anything touching the frozen contracts in §4.
- **Small, reviewable commits**, one per phase minimum.

Start with Phase 0.
