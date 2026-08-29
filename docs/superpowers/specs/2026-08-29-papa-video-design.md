# Papa Video — Movies, TV & Anime Streaming — Design

**Date:** 2026-08-29
**Status:** Approved in brainstorming, ready for implementation planning

---

## In plain terms

Papa Audio grows a second screen: browse trending movies, TV shows and anime,
pick a title (or an episode), and watch it play in the app — with the same
purist standards the music side already has, chief among them that **5.1 audio
is never downmixed**.

The streams come from the free streaming sites catalogued by
[YarrList](https://yarrlist.net/). But YarrList is a *directory*, not a stream
source — it is a page of links to sites that change domains constantly, sit
behind Cloudflare, and serve obfuscated embeds. Scraping 45 of them directly
would be a full-time maintenance job that is broken more often than it works.

So the design splits the problem the way it actually splits:

- **YarrList** supplies the *directory* — which sites exist, and whether they
  are reachable. It is the landscape map, refreshed in the background.
- **TMDB** and **AniList** supply *what to watch* — titles, posters,
  descriptions, ratings, trending/popular lists, seasons and episodes.
- **Provider scrapers** supply *how to watch* — a small set of maintained
  resolvers that turn a title into direct, playable stream URLs.
- **mpv** plays it, in a separate video process, embedded in the window.

---

## Decisions locked in brainstorming

| Question | Decision |
|---|---|
| Approach | YarrList as directory + provider backends + TMDB/AniList catalog |
| Content | Movies + TV (seasons/episodes) + Anime (sub/dub) |
| Finding content | Browse a catalog (trending/popular/new), pick a title |
| Playback surface | Embedded in-app panel |
| 5.1 output | PCM over the existing ALSA path, like music plays today |
| Provider implementation | Wrap a maintained scraper library, hand-roll only as fallback |

---

## Architecture

Eight new units. The catalog and provider layers are pure I/O-free functions
around which the networking is a thin shell, so nearly everything is testable
without the network.

```
                    ┌────────────────────────┐
   videoSettings ──▶│  catalog/tmdb.js       │  TMDB  (key from settings/env)
   (tmdbApiKey)     │  catalog/anilist.js    │  AniList GraphQL (keyless)
                    └───────────┬────────────┘
                                │  titles, posters, seasons/episodes, sub/dub
                                ▼
                    ┌────────────────────────┐
   resolve request ▶│  providers/index.js    │  rank + fan-out
                    │  providers/movie-tv.js │  VidSrc/VidPlay/2Embed-style
                    │  providers/anime.js    │  gogoanime/hianime/Consumet-style
                    │  providers/yts.js      │  YTS API → magnets (5.1 AC3)
                    └───────────┬────────────┘
                                │  [{ url|magnet, kind, quality, audioLayout, ... }]
                                ▼
   magnet ─────────▶┌────────────────────────┐
                    │  torrent-stream.js     │  existing webtorrent client,
                    │                        │  select file, serve via createServer
                    └───────────┬────────────┘
                                │  http://127.0.0.1:<port>/stream
                                ▼
   play(url) ──────▶┌────────────────────────┐
                    │  video-engine.js       │  separate mpv, --wid embed, JSON IPC
                    └───────────┬────────────┘
                                │  5.1 PCM via existing ALSA path
                                ▼
                    ┌────────────────────────┐
                    │  yarrlist-directory.js │  background source map + health
                    └────────────────────────┘
```

| Unit | File | Purpose | Depends on |
|---|---|---|---|
| TMDB catalog | `catalog/tmdb.js` | Movies/TV metadata: trending, popular, search, detail, seasons | fetch, `ttl-cache.js` |
| AniList catalog | `catalog/anilist.js` | Anime metadata: trending, popular, season, search, episodes, sub/dub | fetch, `ttl-cache.js` |
| Provider router | `providers/index.js` | Accept a resolve request, fan out to sources, rank results | provider backends |
| Movie/TV providers | `providers/movie-tv.js` | Resolve TMDB id → stream URLs | maintained library |
| Anime providers | `providers/anime.js` | Resolve AniList id → stream URLs, sub/dub tags | maintained library |
| YTS torrent provider | `providers/yts.js` | YTS API → torrents/magnets, tagged 5.1 AC3 | fetch, `ttl-cache.js` |
| Torrent stream engine | `torrent-stream.js` | Add magnet to the existing client, select file, serve via `createServer()` (Range-aware) | `webtorrent` (existing), http |
| Video engine | `video-engine.js` | Spawn/own the video mpv process, embed, controls | mpv binary, IPC |
| Source directory | `yarrlist-directory.js` | Fetch + parse YarrList pages, health-check, persist | fetch, side-store |

`ttl-cache.js` already exists and is the right home for catalog + provider
caching. `side-store.js` (already in use) holds the YarrList directory so it
does not pollute the shared config written on every playback event.

---

## 1. Catalog — TMDB (movies & TV)

Key lives in `electron-store` under `videoSettings.tmdbApiKey`, with a Settings
field to paste it, falling back to the `TMDB_API_KEY` environment variable.
**Never hardcoded, never committed.**

Endpoints used, all read-only:

- `GET /trending/movie/week`, `/trending/tv/week` — the default rows
- `GET /movie/popular`, `/tv/popular`, `/movie/now_playing`, `/tv/airing_today`
- `GET /search/multi` — text search across movies and TV
- `GET /movie/{id}`, `/tv/{id}` — detail (overview, rating, runtime, genres)
- `GET /tv/{id}/season/{n}` — episode lists for the TV detail screen

Responses are normalised to one internal shape the UI renders regardless of
backend:

```
{ id, type: 'movie'|'tv'|'anime', title, year, poster, backdrop,
  overview, rating, genres[], seasons?[], sub?/dub? }
```

Cached in `ttl-cache.js` for a day; search for a few hours. Rate limits
(40 req/10s) are a non-issue for one local user.

## 2. Catalog — AniList (anime)

No key. GraphQL `POST https://graphql.anilist.co`. Queries for trending,
popular, this-season, text search, and `Media` detail (episodes,
`nextAiringEpisode`, external IDs). Sub vs dub is **not** in AniList metadata —
it is a property of the *streams*, so sub/dub is surfaced at the source-picker
level, not the catalog level (see §4).

AniList is the primary anime source because its IDs and episode structure line
up with anime stream providers; TMDB is not used for anime in v1.

---

## 3. Providers — turning a title into playable URLs

One interface, everything behind it:

```
resolveStream({ type, tmdbId?, anilistId?, season?, episode? })
  → [{ kind: 'http'|'torrent', url?, magnet?, infoHash?, fileIndex?,
       quality, label, audioLayout?, sub?, dub? }]
```

`kind` splits the result into two playback paths: `http` goes straight to mpv;
`torrent` carries a magnet and is handed to `torrent-stream.js`, which returns a
local `http://127.0.0.1:<port>/stream` URL for mpv.

The router fans the request out to the relevant backends concurrently, collects,
de-duplicates, and ranks. A backend that throws or times out is skipped without
failing the request.

**Ranking order:**

1. Higher resolution first (4K > 1080p > 720p).
2. Within a resolution, **multichannel audio beats stereo** — this is how the
   5.1 requirement influences source choice, not just playback. A 1080p 5.1
   source outranks a 4K stereo source for the user.
3. Stable tie-break on source name so results are not jittery across calls.

**Backends.** Movie/TV and anime resolvers via a maintained scraper library
(`@movie-web/providers` or a maintained fork — the exact package is pinned at
implementation time, wrapped behind `providers/` so it is swappable). The
wrapper is the contract; the library is an implementation detail that can be
replaced without touching the UI or the engine.

**5.1-capable sources — the concrete list.** 5.1 availability is a property of
the *source file*, and in free streaming it shows up reliably in only one
family. These are the backends enabled first, tagged `audioLayout`-capable so
the ranker can prefer them:

| Backend | Mirrors / domains | Audio | 5.1? |
|---|---|---|---|
| **YTS (torrent)** | yts.mx API (magnet) | AC3 5.1 @ 640kbps | **Yes — the reliable 5.1 source (lossy)** |
| **VidSrc** | vidsrc.me, vidsrc.to, vidsrc.cc, vidsrc.xyz | EAC3 / AC3 | Yes — where the host file has it |
| **VidPlay** | vidplay.site, vidplay.lol, vidplay.xyz | EAC3 / AC3 | Yes — common on WEB-DL titles |
| **VidCloud / upcloud** | movieshd.watch, upcloud.icu | mixed | Partial (5.1 on some titles) |
| 2embed / SuperEmbed | 2embed.cc, multiembed.mov | AAC | No — stereo only |
| Smashy-stream | smashystream.xyz | AAC | No — stereo only |
| Anime embeds (gogoanime/hianime) | gogoanime, hianime, Consumet | AAC | No — anime is stereo; only BD movie rips carry 5.1 |

`audioLayout` on a result is a *hint* from the provider, not proof — sites
re-encode and mislabel. The ground truth is the ffprobe probe in §4, which is
what the surround badge reports. The `preferSurround` setting (on by default)
adds a ranking bonus to sources tagged 5.1-capable and, once probed, to sources
that actually resolved multichannel.

**Torrent tier — YTS + the existing WebTorrent client.** `providers/yts.js`
queries the free YTS API (`yts.mx/api/v2/list_movies.json`, keyless) and returns
one entry per quality, `kind: 'torrent'` with a magnet, `infoHash`, `fileIndex`,
and `audioLayout: '5.1'` (YTS rips are AC3 5.1). On play, `torrent-stream.js`
adds the magnet to the **existing** `webtorrent` client (already wired for the
downloads tab — no second engine), selects the video file for prioritisation,
and serves it through WebTorrent's built-in HTTP server
(`torrent.createServer()`, Range-aware) so mpv can seek and stream. mpv plays the
local URL with `--cache`; playback starts once the first pieces arrive.

The installed `webtorrent` 1.x is WebRTC-only, so availability depends on WebRTC
seeders — YTS provides these via its own player swarm. Upgrading to a TCP-capable
engine (wider tracker/DHT swarm) is a flagged risk in §Risks, not a v1 change.

Torrent entries rank **above** direct-stream entries when `preferSurround` is on,
because YTS is the only source that reliably carries 5.1. The trade-off is
startup latency (a few seconds to resolve the swarm) versus instant HTTP —
which is why direct-stream sources remain in the list and the UI shows both.

**The lossless tier, deliberately deferred.** YTS 5.1 is AC3 (lossy) — the
"320kbps MP3" of surround. True lossless surround (DTS-HD MA / TrueHD from
BluRay remuxes) lives in 25–50GB torrents that need a debrid cache or a very
fast pipe. That is the v2 escalation (Real-Debrid or 1337x remuxes behind the
same `providers/` interface), not v1.

**Sub/dub.** Anime resolvers tag each result `sub` or `dub`. The UI shows a
sub/dub picker; the default is whichever the user last chose.

---

## 4. Video engine — a second mpv, with video on

The existing engine launches mpv with `--no-video --audio-display=no`. Video
is a **separate process** owned by `video-engine.js`, mirroring the discipline
of `mpv-engine.js` (JSON IPC socket, command guards, generation counters,
respawn, stall detection).

Launch arguments:

- `--input-ipc-server=<socket>` — controls, same protocol as the audio engine
- `--wid=<native-window-id>` — embed into the panel
- `--audio-channels=<channelsValue(...)>` — **reuses the exact same**
  `channelsValue()` so `auto` → `auto-safe`, or an explicit `5.1`
- `--audio-device=<alsaDevice>` + `--audio-exclusive=yes` when the user's
  `outputMode` is `exclusive` — **PCM multichannel out, bit-for-bit, like music**
- `--cache=yes --demuxer-max-bytes=…` — buffering for network streams

No `--audio-spdif` passthrough in v1: the user outputs PCM over ALSA, not
bitstream to a receiver (explicit decision, out of scope below).

**Two playback paths, one engine.** mpv always receives an HTTP URL. An `http`
result is handed straight to mpv; a `torrent` result is first resolved by
`torrent-stream.js` into a local `http://127.0.0.1:<port>/stream` URL. The video
engine does not care which path produced the URL — only that it plays. For
torrents, `video-play` reports progress (pieces buffered / time available) so
the UI can show "buffering…" until playback actually starts.

**5.1 guarantee, stated precisely:** the video engine never forces a downmix.
`auto-safe` (or an explicit layout) is always passed; when exclusive mode is on,
the device is opened exclusively with the stream's real channel count. What we
cannot do is invent a 5.1 track a site does not serve — so we do the next best
things: prefer multichannel sources in ranking (§3), and **probe** the chosen
stream with ffprobe to show the real audio layout. The probe reuses
`surround-verify.js`'s `classify()`, so a stream that claims 5.1 but arrives
stereo is shown as such rather than quietly accepted.

**Mutual exclusion.** Video and audio mpv never play at once. Starting a video
pauses/stops the audio engine first (both are owned by the same main process,
so this is an explicit handoff, not a race on the ALSA device).

**Wayland embedding.** `--wid` is an X11 concept and the user is on KDE Plasma
Wayland. This is the highest-risk part of the design and is de-risked **first**
with a spike (see plan): if native-Wayland Electron offers no X window id, the
fallbacks are, in order, forcing the video surface through XWayland, then a
frameless always-on-top mpv window. The rest of the design does not depend on
which fallback wins — only `video-engine.js` knows about it.

---

## 5. YarrList directory — the landscape map

`yarrlist-directory.js` fetches `https://yarrlist.net/movies-and-tv-shows` and
`/anime-list`, parses site names and URLs, and persists them to the side-store.
A periodic pass (and an on-demand one from the UI) does a reachability check on
each and records it.

The result is a **sources panel**: "47 sites known, 12 reachable, 3 used by
your providers". This is what keeps YarrList genuinely in the loop — a living
map of the ecosystem — without making playback depend on the reachability of 45
fragile sites.

---

## 6. Data flow and IPC

```
UI ──ipc:video-catalog-get {section,page}──▶ tmdb/anilist (cached) ──▶ rows
UI ──ipc:video-search {query,type}────────▶ tmdb/anilist search ─────▶ results
UI ──ipc:video-detail {type,id}───────────▶ detail + seasons/episodes
UI ──ipc:video-streams {type,id,season,episode}─▶ providers ──▶ ranked list (http + torrent)
UI ──ipc:video-probe {url}────────────────▶ ffprobe ──▶ audioLayout badge
UI ──ipc:video-play {result,title,...}────▶ torrent? torrent-stream → local URL ─┐
                                            └─ http ─────────────────────────────┼──▶ video-engine spawn
UI ──ipc:video-stop ──────────────────────▶ tear down video mpv (+ drop torrent)
```

New handlers in `main.js`, exposed via `preload.js` the same way the `slsk-*`
handlers are. The renderer talks to the video engine through a shim, mirroring
`player-shim.js`.

---

## 7. User interface

- **Sidebar entry** "Movies & TV" — a new top-level view alongside Library,
  Discover, etc., styled with the existing CSS variables (`--bg3`, `--text2`).
- **Rows** of poster cards: Trending Movies, Popular TV, Trending Anime,
  Now Playing, Airing Today.
- **Detail view:** backdrop, poster, overview, rating, genres; for TV a season
  selector and episode list; for anime a sub/dub toggle.
- **Source picker:** the ranked stream list with quality and audio-layout
  badges ("YTS · 1080p · 5.1", "1080p · 5.1", "720p · stereo"), a torrent
  marker on `kind: 'torrent'` entries, and Play button on each.
- **Video panel:** embedded mpv output with play/pause/seek/fullscreen.
  Switching back to the music view tears the video process down cleanly and
  drops any active torrent.
- **Sources panel:** the YarrList directory + health, under Manage.
- **Settings** (`videoSettings` in `electron-store`): TMDB key, `preferSurround`
  (on by default — bonus for 5.1-capable sources, and ranks YTS above HTTP),
  `torrentSources` (on by default), `preferredQuality` (1080p default), and the
  last sub/dub choice.

---

## 8. Error handling and reliability

- Provider fan-out is failure-isolated: one dead backend never blocks the rest.
- Catalog and provider results are cached; provider cache is deliberately short
  (streams rot within hours), catalog cache is long (metadata is stable).
- A source that fails N consecutive times is temporarily disabled and shown
  unhealthy in the sources panel.
- Video playback failure (stream 404, codec) surfaces in the panel with the
  next-best source offered, rather than a blank screen.
- The video engine must never block app startup or music playback, and a
  crashed video mpv must not take the audio engine down.
- A torrent with no seeders times out and falls back to the next HTTP source,
  rather than hanging the source picker.

---

## 9. Testing

The decision-bearing code is pure and tested without the network, mpv, or the
app running:

- `catalog/*` — response normalisation from fixture JSON, cache keying, search
  → internal-shape mapping
- `providers/*` — ranking (resolution, then multichannel), the `preferSurround`
  bonus (a 1080p 5.1 source beats a 4K stereo source when enabled), sub/dub
  tagging, de-duplication, failure isolation with a throwing backend
- `video-engine.js` — arg construction mirroring `mpv-engine.test.js`: `--wid`
  present, `--audio-channels` via `channelsValue()`, exclusive ALSA args when
  configured, and that no `--audio-spdif` appears
- `yarrlist-directory.js` — parsing the YarrList page fixture, health-check
  result recording
- `providers/yts.js` — YTS API fixture → magnet/quality/`audioLayout` mapping
- `torrent-stream.js` — magnet add → file selection → local URL construction
  (fake client), and no-seeder timeout behaviour
- surround badge — `classify()` from a probe fixture returns the right label

Integration checks that need the app: video starts, renders in the panel, and
music pauses on handoff.

---

## 10. Out of scope

- Bitstream/SPDIF passthrough to a receiver (user outputs PCM over ALSA)
- Saving/downloading video files into the library; debrid; lossless remux 5.1
  (the future path to *consistent* 5.1 — see §3). Torrent *streaming* is in
  scope; persistent video downloads are not.
- Live TV, live sports, manga, games, ebooks (other YarrList categories)
- Casting to other devices
- Multi-user, cloud sync, or sharing

---

## Risks

1. **Wayland `--wid` embedding** — highest risk, de-risked first by the spike.
   Fallbacks: XWayland, frameless mpv window.
2. **Provider library maintenance** — pinned at implementation time; the
   `providers/` wrapper exists so the backend can be swapped without touching
   the engine or UI.
3. **Stream rot** — provider URLs die fast; mitigated by short cache, ranking,
   and offering next-best on failure.
4. **WebTorrent 1.x is WebRTC-only** — YTS seeders make this workable, but a
   TCP-capable engine (or debrid) is the fallback if availability proves thin.
