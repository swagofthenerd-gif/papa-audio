# Papa Video — Full UX/UI Redesign & Binge-Watching Overhaul

> **Portable spec.** Self-contained so another engineer or model can implement it without this
> conversation. Repo: `~/flac-player` (Electron, CommonJS, no bundler). Branch: `feature/papa-video`.
> Run `npm start`; test `npm test` (currently **1098 passing**).

---

## 1. Context

The Movies/TV/Anime tab works but is a **prototype shell wearing a product's clothes**. The
plumbing is genuinely good — five torrent indexers, honest metadata, prebuffered streaming — but
almost none of it reaches the user, and the parts they touch were never designed.

The worst finding: **there are no playback controls of any kind.** `src/index.html:139-145` is the
entire player — a title and a close button. Once a film starts you cannot pause, seek, change
volume, pick subtitles, or go fullscreen. You can only stop.

**Goal:** surpass mainstream streaming apps on control and convenience — full theatre player,
skip intro/recap/credits, seamless binge, subtitles, complete metadata, and watch state.

---

## 2. Repo orientation (read this first)

**Stack.** Electron 28, CommonJS everywhere, **no build step, no framework**. The renderer is
plain DOM string-building. Match the surrounding style; do not introduce React/TS/bundlers.

**Process split.**
- `main.js` (~6300 lines) — Electron main. All network + `ipcMain.handle` endpoints.
- `preload.js` — `contextBridge` surface. **New IPC channels must be added to the allowlist at
  `preload.js:281` or they silently fail.**
- `src/renderer.js` (~17k lines) — all UI. Video code lives at **lines ~1200–1560**.
- `src/index.html` — static shell. Video panel at `:139`, video settings at `:267`.
- `src/styles.css` — video styles from `.video-panel` onward.

**Video subsystem.**
```
catalog/tmdb.js        TMDB movies+TV      catalog/anilist.js   AniList anime (GraphQL)
providers/yts.js       movie torrents      providers/eztv.js    TV torrents (IMDb id)
providers/nyaa.js      anime torrents      providers/apibay.js  broad TPB index
providers/quality.js   release-name parsing (quality, audio, cam detection, magnet building)
providers/index.js     router: parallel fan-out, timeout, dedupe by infoHash, ranking
torrent-stream.js      WebTorrent → local HTTP server, file picking, prebuffer
video-engine.js        spawns mpv, JSON IPC over a unix socket
mpv-ipc.js             IPC client: command / observe_property / events
```

**Conventions.**
- Every I/O module takes an injectable `fetchFn` so tests run offline. **Keep this.**
- Providers never throw; a total failure returns `[]`.
- Async UI uses a **ticket guard** (`_videoDetailTicket`, `_videoSeasonTicket`) so a slow response
  cannot overwrite newer state. Copy this pattern for every new async path.
- Tests are `node:test`, one file per module in `test/`.

**Reuse — do not rebuild.**

| Need | Use | Location |
|---|---|---|
| Debounced JSON persistence | `SideStore` | `side-store.js` |
| TTL + LRU cache | `makeCache` | `src/ttl-cache.js` |
| mpv property observation | `OBSERVED_PROPS` loop | `mpv-engine.js:52,295` ← **copy this** |
| mpv commands | `client.command()` / `.observe()` | `mpv-ipc.js:101,140` |
| Context menus | `menuItemsFor` | `src/ctx-menu-model.js` |
| HTML escaping | `esc()` | `src/renderer.js:8388` |
| Error → human text | `_videoErrorText` | `src/renderer.js` |
| Audio layout from channels | `classify` | `src/surround-verify.js` |

---

## 3. Verified technical facts

All confirmed on this machine during planning — **do not re-litigate, do not assume otherwise.**

| Fact | Evidence |
|---|---|
| **AniSkip works.** `GET https://api.aniskip.com/v2/skip-times/{malId}/{ep}?types=op&types=ed&episodeLength=0` → exact OP/ED intervals. No key. | One Piece ep 1 → `op 28.783–118.783`, `ed 1387.996–1500` |
| **AniList exposes `idMal`**, the key AniSkip needs. Add to the GraphQL selection. | `Media(id:21)` → `idMal: 21` |
| **mpv properties available**: `chapter-list`, `chapters`, `audio-delay`, `sub-delay`, `sub-scale`, `sub-pos`, `video-zoom`, `video-aspect-override`, `af`, `speed`, `volume-max`, `demuxer-cache-time`, `track-list` | `mpv --list-properties` |
| **ffmpeg filters available**: `blackdetect`, `silencedetect`, `dynaudnorm`, `loudnorm` | `ffmpeg -filters` |
| **`fpcalc` (chromaprint) is NOT installed.** Do not depend on it. | `command -v fpcalc` → miss |
| **mpv `--wid` embedding will work.** Session is Wayland, but `Xwayland :0` is running and Electron 28 defaults to X11, so `getNativeWindowHandle()` returns an X11 window id. | `pgrep Xwayland`, `XDG_SESSION_TYPE=wayland`, `DISPLAY=:0` |
| mpv v0.41.0, ffmpeg 8.0.1, WebTorrent 1.9.7 | — |

---

## 4. Audit — what is wrong today

Every item was read in the source.

### Playback (critical)
- **P1 No transport controls.** No play/pause, seek, volume, fullscreen. `src/index.html:139-145`
- **P2 No subtitles.** Not even selecting a track already inside the file.
- **P3 No audio-track selection**, despite a 5.1 rig being the point of this app.
- **P4 Player is a 560px corner box.** Not movable, resizable, or fullscreen. `.video-panel` in CSS
- **P5 No position memory.** Close at 01:47:00, return to 00:00:00.
- **P6 No keyboard shortcuts.**
- **P7 A dead source is a dead end** — no failover to the next source.
- **P8 mpv state is never observed** though `mpv-ipc.js:140` supports it and `mpv-engine.js:52`
  already does it for music.
- **P9 No skip intro / recap / credits.**
- **P10 No auto-next episode.**
- **P11 No audio/subtitle delay correction** — essential for torrents, where desync is common.
- **P12 No night mode / dialogue boost** on a 5.1 system.

### Detail page
- **D1** No cast, director, writers, runtime, certification, tagline, trailer, budget, studio,
  language, providers, or similar titles. TMDB returns all of it; `normalizeMovie` keeps 10 fields.
- **D2** Episodes render as **bare numbered buttons** — we already fetch each episode's title,
  still, air date and synopsis, then discard them.
- **D3** `normalizeEpisode` drops `runtime`, `vote_average`, guest stars.
- **D4** Anime episode picker is a `<select>` with up to **2000 `<option>`s**. One Piece has 1100+.
- **D5** No back button. **D6** No watched state, no next-episode affordance, no season poster.

### Catalog
- **C1 Only 3 hardcoded rows.** `popular-movies`, `trending-tv`, `season-anime` are built in the
  backend and never requested.
- **C2 `.video-poster-row` is a wrapping grid, not a row.** 20 posters dump into a block; three
  sections stack into one long scroll. No carousel anywhere.
- **C3 No pagination.** `page` is plumbed end to end and hardcoded to `1`.
- **C4** No genre/year/rating/sort filters. **C5** No hero or visual hierarchy.
- **C6** Cards show title + year + type only. **C7** No Continue Watching / My List / History.

### Search
- **S1** One undifferentiated grid, no grouping. **S2** No recent searches or suggestions.
- **S3** Plain "Searching…" text, no skeletons. **S4** No keyboard access.
- **S5** Hides the catalog instead of overlaying. **S6** No people search.

### Sources
- **R1** Flat list of ~30 raw label strings; no grouping, filtering or sorting.
- **R2** No auto-play-best — every launch is a manual pick.
- **R3** Size/seeds/quality concatenated into one unsortable string.
- **R4** Cam rips ranked last and labelled, but **nothing warns before you click one**.

### Cross-cutting
No skeletons, no designed empty states, no focus management, no ARIA, no reduced-motion, and
**nothing persists** — every visit starts cold.

---

## 5. Design principles

1. **The film is the interface.** Artwork leads; chrome recedes and auto-hides.
2. **Never a dead end.** Every failure offers a next action.
3. **Two clicks to playing.** Poster → Play. The source picker is opt-in, never mandatory.
4. **Show the metadata we already paid for.** Seeds, size, codec, layout as sortable columns.
5. **Keyboard-complete.** Every action reachable without a mouse.
6. **Honest state.** Real percentages, peer counts, and errors.
7. **Binge is the primary flow for series.** Zero clicks between episodes.

---

## 6. Phase 0 — Foundations

**Runtime check.** Confirm `_videoWid()` returns non-null. If null, the theatre falls back to a
separate mpv window driven by the *same* control deck. Build the fallback first so it is real.

**New pure modules** (unit-testable, no I/O, mirroring `providers/` style):
- `src/video-format.js` — duration, size, bitrate, relative dates, certification.
- `src/video-store.js` — watch state over `SideStore`.
- `src/video-keymap.js` — pure `(event, context) → action`.
- `src/skip-model.js` — merges skip segments from all sources, resolves overlaps, decides which
  button to show at a given timestamp.

**Metadata expansion — `catalog/tmdb.js`.** One bundled request:
`append_to_response=credits,videos,similar,recommendations,release_dates,external_ids,watch/providers`
(TMDB allows 20 sub-requests; this is 7). Extend the normalizers with runtime, tagline,
certification (from `release_dates`, US/GB), cast, crew, trailers, studios, languages, providers,
collection, similar. Extend `normalizeEpisode` with `runtime`, `rating`, `guestStars`.

**`catalog/anilist.js`.** Add `idMal` to `MEDIA_SELECTION` — AniSkip needs it.

---

## 7. Phase 1 — Playback core

**`video-engine.js`** — observe properties exactly as `mpv-engine.js:52` does:
`time-pos`, `duration`, `pause`, `volume`, `mute`, `speed`, `track-list`, `sid`, `aid`,
`chapter-list`, `eof-reached`, `demuxer-cache-time`, `video-params`, `audio-params`.
Emit a **throttled** `state` event (~4/s — a seek bar does not need 60fps).

New verbs: `seek(sec, mode)`, `setPause`, `setVolume`, `setMute`, `setSpeed`, `setTrack(type,id)`,
`addSubtitle(path)`, `setSubDelay`, `setAudioDelay`, `setSubStyle`, `setAspect`, `setZoom`,
`setAudioFilter`, `screenshot`, `getChapters`.

**`main.js`** — IPC: `video-control` (verb + args), `video-state` (push), `video-tracks`,
`video-chapters`, `video-skip-segments`. **Add every channel to `preload.js:281`.**

**Theatre surface** — replace the corner box. mpv renders into the child `BrowserWindow`
positioned over the content area; the overlay is a sibling DOM layer so controls stay crisp and
themeable. Fullscreen, mini-player, real resize.

---

## 8. Phase 2 — Transport UI & keyboard

**`src/video-player.js`** (new):
- **Seek bar**: buffered-ahead shading, hover time bubble, chapter ticks, **coloured intro/credit
  segments** so you can see the skippable regions.
- **Thumbnail scrubbing**: on load, background-generate a sprite sheet with ffmpeg
  (`fps=1/10,scale=160:-1,tile=10x10`) into a temp file; show tiles on hover. Cache per file.
- Play/pause, ±10s, prev/next episode, volume + mute, speed 0.25–4× with pitch correction.
- Title block: show → S/E → episode title. Live badges: resolution, audio layout, codec, bitrate.
- Auto-hide after 3s idle; reappear on move/key; never hide while paused.
- **Settings flyout**: aspect override, zoom-to-fill (kill black bars), rotate, deinterlace,
  **audio delay** and **subtitle delay** nudges (±50ms, P11), **night mode** (`af=dynaudnorm`) and
  **dialogue boost** (centre-channel gain, P12), stats overlay.
- **Sleep timer**: "after this episode", 30/60/90 min.
- **A-B loop**, frame step, **bookmark this moment**, screenshot.
- Prevent system sleep while playing; auto-pause on suspend.

**Keyboard (`src/video-keymap.js`)**
```
Space/K play-pause   ←/→ ±10s      Shift+←/→ ±60s    ↑/↓ volume
J/L ±10s             , / . frame    [ / ] speed       0-9 seek to %
F fullscreen         M mute         C subtitles       V audio track
S skip intro/credits N next episode P previous        T theatre/mini
I stats              B bookmark     Esc exit          / focus search
? shortcut sheet
```

**Failover (P7):** on playback error or prebuffer timeout, automatically try the next ranked
source with a toast naming what it is doing, plus undo. Blacklist the failed source for the session.

---

## 9. Phase 3 — Skip intro / recap / credits ★

The headline convenience feature. **Four layers, best available wins**, merged by `src/skip-model.js`.

### Layer 1 — Embedded chapters (free, instant, no network)
Many mkv releases ship named chapters. Read mpv's `chapter-list` and classify titles by regex:
```
intro|opening|op\b|title(s)? sequence   → intro
recap|previously|prologue               → recap
credits|ending|ed\b|outro|end card      → credits
preview|next episode|next time          → preview
```
Highest confidence when it hits. Costs nothing.

### Layer 2 — AniSkip for anime (verified working)
`GET https://api.aniskip.com/v2/skip-times/{malId}/{episode}?types=op&types=ed&episodeLength={sec}`
- `malId` from AniList `idMal` (Phase 0). No API key.
- Returns exact `op` and `ed` intervals. Cache in `ttl-cache` (7 days) and in `video-store`.
- New module `skip/aniskip.js`, injectable `fetchFn`, never throws, returns `[]` on failure.

### Layer 3 — Cross-episode audio correlation for TV (the real work)
A series intro is **the same audio in every episode of a season**. Detect it locally:
1. When an episode starts, background-decode the **first 5 minutes** of this and one already-seen
   episode of the same season: `ffmpeg -i <url> -t 300 -ac 1 -ar 8000 -f s16le -`.
2. Reduce each to a compact fingerprint in Node — per 100ms frame, an 8-bit energy bucket. A
   ~30 KB array, no native dependency (**`fpcalc` is not installed — do not use chromaprint**).
3. Cross-correlate the two sequences; the longest match ≥ 20s is the intro. Record start/end.
4. Persist per **season** — computed once, reused for every later episode.
5. Strictly background, low priority, cancellable, never blocks playback.

### Layer 4 — Manual + heuristic (always available)
- **"Set intro start/end here"** in the settings flyout — applies to the whole season immediately.
  One user action fixes a show forever.
- Credits fallback: `blackdetect` + `silencedetect` over the last 15% of runtime; else the last
  `min(8%, 90s)` of the file.
- Users can correct any auto-detected segment; a manual correction always wins.

### UX
- **Skip Intro** appears 1s before the segment, bottom-right, auto-dismisses 5s after it ends.
- **Skip Recap** and **Skip Credits** behave the same; credits also triggers Up Next.
- **Binge mode** (per show, default on after the first manual skip): skips automatically with a
  4s "Skipping intro — Cancel" toast. Never silently steals control the first time.
- Segments drawn on the seek bar.
- Manual `S` key skips the current segment at any time.

---

## 10. Phase 4 — Auto-next & binge ★

- **Up Next card** at credits start (not file end): next episode's still, title, synopsis, and a
  **10s countdown ring**. Buttons: Play Now, Cancel, Watch Credits.
- **Prebuffer the next episode during credits** — resolve its sources and start its torrent while
  the current one finishes. This is what makes binge feel instant; the source-resolution and
  prebuffer machinery already exists.
- **Seamless mode**: with prebuffer complete, the next episode starts with no visible gap.
- Auto-roll into the **next season** at a season's end, with confirmation.
- **"Still watching?"** after 3 unattended episodes.
- Mark watched at 90%; skip already-watched episodes when auto-advancing.
- Per-show binge preferences: auto-skip intro, auto-skip credits, auto-next, countdown length.

---

## 11. Phase 5 — Subtitles

`subtitles/opensubtitles.js` (new; same shape as providers). REST: `https://api.opensubtitles.com/api/v1`,
header `Api-Key`, `GET /subtitles?imdb_id=&season_number=&episode_number=&languages=`, then
`POST /download` for a link. Free key; add a Settings field beside the TMDB one.

- Merge **embedded tracks** (mpv `track-list`) and downloadable results into one `CC ▾` menu.
- Rank by download count + rating; show language, SDH flag, uploader rating.
- Download to temp, `sub-add`, remember the choice per show.
- **Sync nudges** (±50ms) with an on-screen readout — torrents desync constantly.
- Styling: size, position, colour, background opacity, font — persisted.
- Auto-select preferred language when present; auto-download when absent (opt-in).

---

## 12. Phase 6 — Detail page

- **Hero**: backdrop, poster, title, tagline, year · runtime · certification · rating, genre chips.
  Primary **Play** resolves the best source and starts — no source picker required. For a series,
  Play means **resume the next unwatched episode**, labelled as such.
- Secondary: My List, Trailer (in-app), Sources, Mark watched.
- **Cast row** with photos and character names → person filmography pages.
- **Crew line**: director, writers.
- **Episode list (D2)**: still, number, title, air date, runtime, synopsis, rating, watched tick,
  resume bar, per-episode source menu. Season selector as a tab strip with a watched count.
- **Anime picker (D4)**: replace the 2000-option `<select>` with a searchable virtualised grid.
- **Similar / Recommended / Collection** rows.
- **Where to watch**, studios, languages, budget/revenue.
- **Back button** and breadcrumb (D5).

---

## 13. Phase 7 — Catalog & browse

- **Real carousels** (C2): horizontal scroll, arrows, snap, keyboard, lazy images.
- **All seven backend rows** (C1) plus Continue Watching, My List, Recently Watched, Because You
  Watched X, New Releases, Top Rated.
- **Hero spotlight** — rotating feature with backdrop, synopsis, Play / My List.
- **Infinite pagination** (C3) — `page` is already plumbed.
- **Filter bar** (C4): type, genre, year range, min rating, sort; persisted.
- **Richer cards** (C6): rating, certification, runtime, resume bar, hover preview with synopsis
  and quick Play / My List / Mark watched.
- Sub-tabs: Movies · TV · Anime · My List.
- **Surprise Me** — a random pick honouring the current filters.
- **Upcoming calendar** + notifications for followed shows.

---

## 14. Phase 8 — Search

- Overlay above the catalog rather than hiding it (S5).
- **Grouped** by Movies / TV / Anime / **People** (S1, S6).
- Recent searches, trending suggestions, designed empty state (S2).
- Skeletons (S3). Full keyboard: `/`, arrows, Enter, Esc (S4).
- Operators: `year:2024`, `genre:horror`, `actor:…`.
- **Keep** the existing 300ms debounce and ticket guard — both already correct.

---

## 15. Phase 9 — Source picker

A **table**, not a list: Quality · Audio · Size · Seeds · Source · Health.
- Sortable columns; filters for quality, layout, min seeds.
- Health dot from seed count (shape as well as colour, for colourblind users).
- **Cam-rip confirmation** before playing a flagged source (R4).
- "Best" badge on the auto-pick; Play uses it silently.
- Remember the preferred source and quality per show.
- **Download for offline** — the WebTorrent client already exists (`getTorrentClient`).
- Global bandwidth limit; pause downloads while streaming.

---

## 16. Phase 10 — Watch data

`src/video-store.js` over `SideStore`:
```js
{ items: { "movie:27205": { type, id, title, poster, position, duration,
                            watched, updatedAt, source },
           "tv:1396:s1e2": { ..., showId, season, episode } },
  watchlist: [ { type, id, title, poster, addedAt } ],
  skip: { "tv:1396:s1": { intro:{start,end}, credits:{start,end},
                          origin:"chapters|aniskip|detected|manual" } },
  prefs: { "tv:1396": { autoSkipIntro, autoSkipCredits, autoNext,
                        subLang, preferredQuality, audioDelay, subDelay } } }
```
- Resume: save every 5s and on stop; resume prompt with a thumbnail and "Start over".
- Continue Watching, Watchlist, History views; mark watched at 90%.
- **Stats**: hours watched, top genres, longest binge.
- Export / import JSON.

---

## 17. Phase 11 — Trakt sync (optional)

`trakt/client.js` — OAuth **device flow** (no redirect URI needed for desktop), token refresh,
scrobble start/pause/stop, watchlist + history pull/push, conflict resolution favouring the most
recent. Behind a Settings toggle. **Every Phase 10 feature must work fully without it.**

---

## 18. Phase 12 — Polish

Skeletons everywhere; every empty state designed with an action. Focus rings, ARIA, focus trapping
in the player, `prefers-reduced-motion`. Lazy images, `content-visibility` on off-screen rows,
poster cache. Toasts for background events. `?` cheat sheet. Onboarding when no TMDB key is set.

---

## 19. Files

**New**
```
src/video-player.js   src/video-store.js   src/video-format.js
src/video-keymap.js   src/skip-model.js    skip/aniskip.js
skip/detect-intro.js  subtitles/opensubtitles.js   trakt/client.js
```
plus one test file each, following `test/providers-*.test.js`.

**Modified**
```
catalog/tmdb.js     metadata expansion          catalog/anilist.js  add idMal
video-engine.js     observation + control verbs main.js             IPC, theatre window
preload.js          surface + CHANNEL ALLOWLIST src/renderer.js     catalog/search/detail/sources
src/index.html      theatre + settings          src/styles.css      substantial
```

---

## 20. Verification

1. `npm test` — every new pure module tested. Target ~1300 (from 1098).
2. `npm start` — manual: play, pause, seek, volume, subtitle on/off, audio track, fullscreen,
   exit, resume, next episode.
3. **Skip:** an anime with a known OP (AniSkip), an mkv with named chapters (Layer 1), a TV season
   with neither (Layer 3), and a manual correction (Layer 4).
4. **Binge:** watch to credits → Up Next → next episode starts with no visible gap.
5. Kill a source mid-play → confirm automatic failover.
6. Resume: close at a known position, reopen, confirm the offer.
7. Keyboard-only run of the whole tab.
8. Confirm `_videoWid()` non-null; force it null to exercise the fallback.
9. Live provider checks with real fetches (the pattern used throughout this session).

---

## 21. Risks

- **mpv `--wid` embedding** is load-bearing. XWayland is present and Electron defaults to X11, so
  it should hold — Phase 0 proves it before Phase 1 depends on it; the separate-window fallback
  keeps everything else working.
- **Layer 3 intro detection is the hardest part.** It is a genuine signal-processing task on
  partially-downloaded files. Layers 1, 2 and 4 cover most real cases; **ship those first** and
  treat Layer 3 as an enhancement. It must always be cancellable and never block playback.
- **OpenSubtitles / Trakt need keys.** Both optional and isolated.
- **`fpcalc` is not installed** — the fingerprint must be computed in Node from ffmpeg PCM output.
  Do not add a native dependency.
- **Scope.** Twelve phases. Phases 1–2 alone transform the tab; 3–4 are the binge features that
  differentiate it. Each phase is independently shippable; ship in order.
