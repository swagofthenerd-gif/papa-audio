# Papa Audio vs. Best-in-Class Music Players — Competitive Teardown

Date: 2026-07-02
Compared against: Roon, Plexamp, foobar2000, MusicBee, Audirvana, Strawberry, Spotify, Tidal, and (for the Soulseek side) Nicotine+.
Method: full code audit of `~/flac-player/` (main.js, renderer.js, index.html, bridge-server) + current competitor feature research.

---

## 1. Where Papa Audio is already ahead

Credit where due — no mainstream player has this combination:

- **Integrated Soulseek acquisition** with 6-variant parallel search, folder grouping, FLAC-first scoring, per-user library browsing, upgrade hints. Nicotine+ has the search; nobody has it *inside* the player.
- **AI music agent** with tool use (search → download → play), 3 providers (Ollama/Claude/OpenAI), persistent taste memory. Plexamp's Sonic Sage is the closest and it's playlist-only.
- **Embedded download browser** with link sniffing, saved sites, quality-source auto-discovery.
- **WebTorrent support** in the downloads page.
- Dynamic accent color from album art, saved queues, format badge, channel up-mix modes, Android bridge + GNOME extension.

The identity is "Spotify UI with P2P power." The gaps below are what stands between that and "best of the best."

---

## 2. THE AUDIO ENGINE — biggest credibility gap for a "hi-fi" player

This is where foobar2000, Audirvana, and Roon are categorically ahead, because Papa Audio plays through a Chromium `<audio>` element + Web Audio graph.

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 2.1 | **No gapless playback** | Everyone (foobar, Roon, Audirvana, MusicBee, Strawberry, Spotify, Tidal, Plexamp) | `playNext()` swaps `audio.src` → audible gap between tracks. Live albums, DJ mixes, and concept albums (Dark Side of the Moon) are broken. Crossfade exists but crossfade ≠ gapless — audiophiles turn crossfade *off*. Competitors pre-buffer and splice sample-accurately. |
| 2.2 | **No bit-perfect / exclusive output** | Audirvana (exclusive + integer mode), foobar (WASAPI/ASIO), Roon (RAAT), Strawberry (ALSA hog/direct) | Web Audio resamples *everything* to the device rate (usually 48 kHz). Your 44.1 kHz FLACs and 192 kHz hi-res files are all being resampled by Chromium before they reach the DAC. The format badge shows "24-bit / 96 kHz" but that's the *file*, not what's output. This is the single biggest gap for the hi-fi positioning. |
| 2.3 | **No output device selector** | All of them | No `setSinkId` anywhere — audio goes to system default. Every serious player lets you pick USB DAC vs. speakers *inside the app*, and remembers it. Roon goes further: per-device DSP profiles and volume behavior. |
| 2.4 | **No automatic sample-rate switching** | Audirvana, Roon, foobar, Strawberry | Player should switch the DAC to the content's native rate per track. Impossible via Web Audio; needs native output path. |
| 2.5 | **Indexed formats that can't actually play** | foobar/MusicBee/Strawberry decode everything via own decoders | Scanner regex includes `ape, wv, wma, dsf, dff` and `.m4a` (ALAC), but Chromium cannot decode APE, WavPack, WMA, DSD, or ALAC. Those tracks show in the library and **silently fail on click** — the worst kind of bug: it looks like the app is broken. Either decode them (ffmpeg/WASM decoder path) or don't index them. |
| 2.6 | **No DSD support at all** | Audirvana (native DSD/DoP), foobar, HQPlayer | You index `.dsf/.dff` but can't play them. Audiophile table stakes for the segment you're targeting. |
| 2.7 | **ReplayGain reads tags but can't create them** | foobar (full RG scanner), MusicBee, Plexamp/Roon (automatic R128 analysis of whole library) | `computeReplayGainValue()` only uses `replaygain_track_gain` tags. Soulseek downloads almost never have RG tags → your volume-leveling feature silently does nothing for most of your library. Roon/Plexamp analyze loudness themselves, no tags needed. |
| 2.8 | **No DSP chain beyond 10-band EQ** | foobar (component DSP chain), Audirvana (VST3 hosting!), Roon (parametric EQ, convolution/room correction, crossfeed, headroom mgmt) | Audirvana literally hosts VST3 plugins. Roon does convolution filters for room correction. Papa has fixed-preset EQ + preamp. A parametric EQ and a crossfeed option would go a long way for the headphone crowd. |
| 2.9 | **Volume is a linear gain slider** | Roon/Audirvana (64-bit volume with dithering, configurable curve), foobar | Also no volume normalization ceiling (true-peak limiting) when RG pushes gain up. |
| 2.10 | **Visualizer/EQ always in the signal path** | foobar/Audirvana bypass DSP entirely when off | Even with EQ "off" the audio still runs through the whole Web Audio filter graph (gain nodes, analyser). Purists want a true bypass. |

## 3. PLAYBACK BEHAVIOR & QUEUE — the small clicks that add up

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 3.1 | **No MPRIS D-Bus interface** | Strawberry, every native Linux player, even Spotify | You grab media keys with `globalShortcut` (which *steals* them from other apps even when Papa is idle) and sync a custom GNOME extension. MPRIS would give you: GNOME/KDE media controls, lock-screen info, `playerctl`, sound-panel integration, Bluetooth headset buttons — for free, on every desktop. This is the #1 Linux-integration gap. |
| 3.2 | **No tray icon / background play** | MusicBee, Strawberry, Spotify | Closing the window kills the music. No minimize-to-tray, no "keep playing in background" option. |
| 3.3 | **No mini-player mode** | MusicBee (compact player), Spotify (miniplayer), Plexamp (tiny always-on-top window — its signature look) | A small always-on-top art+controls window while you work. Plexamp built its whole brand on this. |
| 3.4 | **Repeat-one missing granularity check** | — | You cycle repeat modes (good), but there's no visible A-B loop or "stop after current track" (foobar has Stop After Current; MusicBee too). Sleep timer partially covers this — add "stop after this track" to the sleep panel. |
| 3.5 | **Seek quality-of-life** | foobar/MusicBee | No mouse-wheel-on-progress-bar seeking, no wheel-on-volume (check), no click-to-seek preview waveform. Plexamp shows a **waveform seek bar** — huge perceived-quality win. |
| 3.6 | **Queue: no "save queue as playlist" one-click, no clear-queue button, no queue duration total** | Spotify/MusicBee | You have saved queues (great, rare feature!) but the queue panel lacks a visible total-time and a clear-all. |
| 3.7 | **No resume-position for long tracks** | Plexamp, audiobook-aware players | 1-hour DJ mixes should remember position. You persist playback state across restarts (good) but per-track bookmarks don't exist. |
| 3.8 | **Crossfade is time-based only** | MusicBee (smart crossfade: skips it for gapless albums), Spotify (automix) | Crossfading between consecutive tracks of the same album is wrong; competitors auto-disable it there. |

## 4. LIBRARY MANAGEMENT — where MusicBee/foobar/Strawberry crush everyone

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 4.1 | **No real-time folder watching** | MusicBee, foobar, Strawberry, Plex server | You rescan on timers after downloads (15/45/120 s) and on manual refresh. An `fs.watch`/chokidar watcher on music folders makes the library always-correct and removes the whole rescan hack. |
| 4.2 | **No tag editor** | MusicBee (best-in-class), foobar (mass tagger), Strawberry, Picard | You cannot fix a typo'd artist, wrong track number, or missing album without leaving the app. For a Soulseek-fed library this hurts *double* — P2P files are notoriously mistagged. Even a minimal single-album editor (title/artist/album/year/track#/art) would transform library quality. |
| 4.3 | **No MusicBrainz/AcoustID auto-tagging** | Picard, MusicBee, beets | Acoustic fingerprinting identifies mistagged/unnamed files automatically. Perfect post-download step: fingerprint → correct tags → proper album grouping. |
| 4.4 | **No star ratings** | MusicBee, foobar, Strawberry, Plexamp | Only binary like/heart. Ratings feed smart playlists ("4+ stars, not played this month") and better radio seeds. |
| 4.5 | **No smart/auto playlists** | MusicBee (auto-playlists), foobar (facets/queries), Plexamp (smart playlists + "Rediscover"), Strawberry (smart playlists) | Rule-based playlists: "FLAC only", "added last 30 days", "never played", "genre = jazz AND year < 1970". You have the data (play counts, dates, formats) — no query engine over it. |
| 4.6 | **Browse dimensions: only Artists/Albums** | foobar (facets by any tag), MusicBee (genre/year/composer nodes), Plexamp (genres, moods, decades, styles) | No genre view, no year/decade browse, no composer view (you even extract composer into the DB and never surface it in navigation). |
| 4.7 | **No duplicate detection** | MusicBee, beets | Soulseek library = same album downloaded twice in different bitrates. You even have upgrade-hints — dedupe is the natural sibling feature. |
| 4.8 | **No CUE sheet support** | foobar, Strawberry, MusicBee | Single-file album rips with .cue show as one giant track. |
| 4.9 | **No multi-select / bulk actions** | Every desktop player | Shift-click a range of tracks → queue/playlist/like them all. Currently one-at-a-time context menus. |
| 4.10 | **No library statistics on health** | beets, MusicBee | You have a Stats page (plays); nothing about "album missing art / missing year / lossy albums count". You care about lossless — show "12% of library is lossy" with a one-click hunt-upgrades action. |
| 4.11 | **No import/export** | Everyone (M3U/PLS) | Playlists can't be exported to M3U or imported from other players. Lock-in with no escape hatch. |

## 5. SEARCH & NAVIGATION MICRO-INTERACTIONS

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 5.1 | **No fuzzy/typo-tolerant search** | Spotify (excellent typo handling), Plexamp | "Opteh" should find Opeth. Substring matching punishes fast typing. |
| 5.2 | **No search result keyboard navigation** | Spotify (arrow keys + enter plays top result) | Ctrl+K focuses search (good); arrows should walk results, Enter should play the top hit. |
| 5.3 | **No filter-as-you-type within album/playlist view** | foobar, MusicBee (instant filter box) | Inside a 300-track playlist there's sort but no local filter field. |
| 5.4 | **No jump-to-letter / alphabet rail in Artists** | MusicBee, Plexamp (letter scrubber) | Long artist lists need A–Z jump. |
| 5.5 | **No "recently added" as a first-class row** | Plexamp, Spotify, MusicBee | Home has a clock and recently played; a Recently Added shelf is the natural landing spot for a download-driven app. (If it exists, make it more prominent — new downloads should visibly appear there.) |

## 6. DISCOVERY & RECOMMENDATIONS — Plexamp/Spotify territory

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 6.1 | **Radio is artist/genre + random** | Plexamp (neural sonic analysis: Track Radio, Album Radio, **Sonic Adventure** — path between two songs), Spotify (collaborative filtering) | `startRadio()` scores +10 same artist, +5 same genre, + random. That's a shuffle with preferences, not similarity. Local sonic embeddings (e.g., MusiCNN/essentia) would give real "sounds like" radio over your own files. |
| 6.2 | **No daily mixes / auto-generated stations** | Plexamp ("Mixes for You" clusters your heavy-rotation albums), Spotify (Daily Mix 1-6, Discover Weekly) | You track plays and taste — nothing regenerates a fresh "Your Mix" every morning. |
| 6.3 | **No "what to acquire next" discovery** | Spotify/Tidal (recommendations), Lidarr (automated wanted-list) | Unique-to-you opportunity: recommend albums you *don't own* based on taste profile, then one-click Soulseek them. Nobody can copy this. |
| 6.4 | **Followed-artist new releases are library-diff only** | Spotify (release radar from global catalog), Lidarr (MusicBrainz release calendar) | `checkFollowedArtistsForNew()` only notices new *local* albums. Poll MusicBrainz release groups for followed artists → notify → auto-download. |
| 6.5 | **No scrobbling** | MusicBee, Strawberry, foobar, Spotify — all do Last.fm/ListenBrainz | Your listening history is siloed. ListenBrainz is a simple POST; Last.fm users can never adopt Papa without this. |

## 7. LYRICS

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 7.1 | Single provider (lrclib) with no fallback | MusicBee plugins, Strawberry (multiple providers cascade) | One 404 = no lyrics. Add fallbacks (NetEase, Genius plain text). |
| 7.2 | **Plain lyrics are fake-synced** | Everyone shows unsynced lyrics as static text | You spread plain lyrics evenly across duration and highlight them like synced ones — actively misleading. Show plain lyrics as a scrollable static page instead. |
| 7.3 | No lyric offset adjustment | MusicBee, Musixmatch | ±0.5 s nudge control for out-of-sync LRC. |
| 7.4 | No embedded/local `.lrc` reading | foobar/MusicBee/Strawberry read LYRICS tags and sidecar .lrc first | Files often ship with lyrics embedded — you go straight to network. |

## 8. ECOSYSTEM — remote, casting, mobile

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 8.1 | **No casting/multi-room** | Roon (zones/RAAT), Plexamp (cast to any Plex player + TV), Strawberry (no) / MusicBee (UPnP), Spotify (Connect — the gold standard) | No Chromecast, no DLNA/UPnP renderer output, no "play on my Android phone from desktop". Spotify Connect-style handoff between your desktop and your Android app via the bridge would be a killer feature and the plumbing already half-exists. |
| 8.2 | **No secure remote access** | Plexamp (Plex relay), Roon ARC (port-forward + auth) | Bridge is LAN-only HTTP. Your library is unreachable from outside. (See also 10.1 — right now that's a *good* thing.) |
| 8.3 | **No offline sync to mobile** | Plexamp (downloads), Spotify/Tidal offline | Android app streams only; no "sync these albums to phone storage". |
| 8.4 | Bridge has no push/WebSocket | Plexamp/Roon apps update instantly | Android app presumably polls; now-playing sync should be push. |

## 9. UI POLISH / PLATFORM DETAILS

| # | Gap | Who does it better | Detail |
|---|-----|--------------------|--------|
| 9.1 | Drag-and-drop *into* the app | MusicBee/foobar (drop files/folders to play or import) | Dropping a folder on the window should offer play/import. |
| 9.2 | No light theme / theme options | Spotify (no!), MusicBee (skins), Plexamp (several) | Accent-from-art is lovely; an optional light/AMOLED-black pair would cover most requests. |
| 9.3 | No per-album art in file manager exports, no "set custom art" | MusicBee (paste/choose art) | Can fetch art (good) but can't manually replace a wrong fetch. |
| 9.4 | No undo/confirm on destructive actions | — | Delete playlist / clear memory are instant; add a 5-s undo toast (Spotify pattern). |
| 9.5 | No first-run import feedback | Plexamp/Roon show scan progress with counts | `showLoading()` is a spinner; big libraries need "Scanning… 4,213 files, 312 albums". |
| 9.6 | Window state persistence check | Everyone | Verify size/position/maximized restore; also `Alt+←` conflicts with browser-view usage. |
| 9.7 | No accessibility pass | Spotify (decent ARIA) | Custom controls (sliders, toggles) have no ARIA roles/labels; screen-reader unusable. |

## 10. RELIABILITY & SECURITY FINDINGS (from the code audit)

| # | Finding | Severity |
|---|---------|----------|
| 10.1 | **Bridge server has zero authentication** and `GET /api/settings/agent-keys` returns your **Anthropic/OpenAI API keys in plaintext** to anyone on your LAN/Wi-Fi. Any device on the network can also trigger downloads and read your whole library. Add a token (even a static one shared with the Android app) before anything else. | Critical |
| 10.2 | slskd credentials (`slskd`/`slskd`) hardcoded in two repos. Fine for localhost-only, but bridge+slskd on 0.0.0.0 would expose it. | Medium |
| 10.3 | `renderer.js` is 7,574 lines in one file, no tests, no bundler. Every player that lasted a decade (foobar's component model, MusicBee plugins) modularized. Refactor before it calcifies. | Medium |
| 10.4 | Library scan is fully synchronous-recursive per folder (`scanDir` with `readdirSync`) then per-file metadata parse — big libraries (50k+ tracks) will lock and take minutes. MusicBee/Plexamp scan incrementally with a persisted DB (yours is a JSON cache). Consider SQLite. | Medium |
| 10.5 | Silent failure modes: unsupported codecs (2.5), missing RG tags (2.7), lyrics 404s — none surface any message. Competitors' golden rule: never fail silently. | Medium |

---

## 11. WHERE EVEN THE BEST COULD BE BEATEN — ideas beyond state of the art

Things none of them do well, that Papa Audio is uniquely positioned to do:

1. **Closed acquisition loop**: taste profile → recommend unowned albums → auto-hunt lossless on Soulseek → auto-tag via AcoustID → appear in library with a "New for you" shelf. Roon recommends but can't acquire; Lidarr acquires but doesn't play; Spotify streams but you own nothing. Nobody closes the loop.
2. **Automatic quality-upgrade sweeps**: you already have `_markUpgradeHints`. Make it a background job: find every lossy album, quietly search Soulseek for FLAC, queue upgrades, swap files, keep play counts. "Your library upgraded itself to lossless" is a marketing line nobody else can say.
3. **Wishlist that never sleeps** (Nicotine+ has a primitive version): rare album not found today → standing search re-runs daily until a peer appears, then auto-downloads and notifies. Perfect for the "never give up on a search" mission.
4. **AI DJ over your own files**: Spotify's AI DJ only works on their catalog. Yours has an agent + local library + lyrics + taste memory. Commentary between tracks ("this next one is the 1971 Fillmore version you found last week") via local TTS would be genuinely novel.
5. **Sonic-similarity radio computed locally** (leapfrogging Plexamp): Plexamp needs a Plex server and x86; an embedded embedding model over your files with a "Sonic Adventure"-style A→B path picker inside a P2P player would beat them at their own flagship feature.
6. **Provenance-aware library**: every file knows where it came from (which Soulseek user/folder, which site, when). Surface it: "downloaded from X, 3 alternatives exist at higher bitrate." No player has acquisition provenance because no player acquires.
7. **Listening-context memory in the agent**: "play what I was into last December", "make a mix of what I listen to while coding" — you already store play history with timestamps; the agent can query it. Spotify Wrapped once a year; you can do it conversationally, any day.

---

## 12. Priority shortlist (if you only fix ten things)

1. Bridge auth (10.1) — critical, one evening.
2. Gapless playback (2.1) — table stakes; Web Audio buffer-scheduling or dual-element preload.
3. Output device selection (2.3) — `setSinkId`, one day.
4. MPRIS (3.1) — replaces the media-key grab and the custom-extension fragility; `mpris-service` npm package exists.
5. Stop indexing what can't play, or decode it (2.5) — silent-failure killer.
6. Folder watching (4.1) — deletes the triple-rescan hack.
7. Minimal tag editor + AcoustID post-download tagging (4.2/4.3) — biggest library-quality lever for P2P files.
8. Smart playlists (4.5) — the data is all there.
9. ListenBrainz scrobbling (6.5) — cheap, expected.
10. Automated upgrade sweep + wishlist (11.2/11.3) — the differentiator doubled down.

## Sources

- [Plexamp Sonic Analysis — Plex Support](https://support.plex.tv/articles/sonic-analysis-music/)
- [Super Sonic: Plexamp sonic features — Plex blog](https://www.plex.tv/blog/super-sonic-get-closer-to-your-music-in-plexamp/)
- [Plexamp Sonic Sage announcement](https://www.prnewswire.com/news-releases/plexamp-adds-sonic-sage-chatgpt-based-feature-for-creating-incredible-playlists-301814850.html)
- [Roon 2.0 / ARC overview — ecoustics](https://www.ecoustics.com/news/roon-arc/)
- [Roon music sources (TIDAL/Qobuz) — roon.app](https://roon.app/en/compatibility/music)
- [Roon in 2025, 10 years on — Archimago](https://archimago.blogspot.com/2025/06/roon-in-2025-10-years-on-sound-quality.html)
- [Roon ARC review — TechHive](https://www.techhive.com/article/1443872/roon-arc-review.html)
