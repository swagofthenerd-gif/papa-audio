# Peer library redesign ("The Listening Room") — design

Date: 2026-09-19. Branch: `feat/peer-library-redesign` off `feature/papa-video`.
Approved direction: C of the three mockups (Hunt / Wander / Folders on one page,
one shared album dossier).

## Goal

Opening a Soulseek peer's library should be two genuinely different experiences
on one screen: a fast **Hunt** for upgrades and gaps, and a **Wander** through
the collection as music, plus a **Folders** browser that lets a file be
understood before it is opened. Every album, from any of the three, opens the
same **dossier** with everything the app can know about it.

Nothing about how a library is fetched, cached, refreshed, or downloaded from
changes. This is a new presentation layer over the existing engines.

## Non-goals

- Replacing `slsk-tree.js`, `slsk-shelves.js`, the browse cache, the download
  scheduler, or the album comparison logic. They are the data source.
- Release-facts enrichment (label, country, official track list). The user
  chose artist story, rip quality, and reception; release facts are out.
- Automatic rip sampling. Verify runs only on demand.
- Deleting the current shop UI on day one (see Rollout).

## Surfaces

### Page shell

Route stays `soulseek-explore` with the username as nav id, so every existing
entry point (search result, saved users, chat, wishlist) keeps working.

Header, top of page:

- Peer name, online state, their queue length (from `slsk-user-statuses`).
- Quality ring: conic chart of hi-res / surround / lossless / lossy album
  share, from `shelves.stats` and the surround flags. Centre shows lossless %.
- Character line: derived from the tree, no network. Top two top-level or
  second-level folder names that look like genres, plus the dominant decade
  from parsed years ("A 70s rock and modern jazz collector"). Falls back to
  "3,412 albums, 71% lossless" when nothing genre-like is found.
- Cache provenance line as today ("from cache, updated 2 h ago" / "updated
  just now").
- Mode switch: Hunt | Wander | Folders. Remembered per peer in
  `localStorage` key `slsk_lib_mode:<username>`; the old global
  `slsk_lib_mode` seeds the first visit.
- The search box stays in the header and searches whichever mode is active
  (albums in Hunt/Wander, files and folders in Folders). The
  never-repaint-the-input rule from the current shop carries over.

### Hunt

- Four tiles: upgrades, not in your library, surround, new since last visit.
  Clicking a tile filters the ledger to that set. Numbers come from
  `buildShelves` output unchanged.
- Ledger table, one row per album: cover (lazy, existing art pipeline),
  title + artist + year + edition note, theirs quality (label dot + string),
  yours quality (from the matched library album, or "—"), verdict in plain
  words, size. Verdict vocabulary: `upgrade · 4/5 tracks`, `upgrade · all`,
  `surround you lack`, `not in library`, `same as yours`, `yours is better`.
  Verdicts reuse `upgradeReason` and the comparison module so the row and the
  dossier can never disagree.
- Sort by any column; sort state remembered per peer. Filter by typing.
  Checkbox multi-select with a batch bar (download selected, add to
  wishlist). "Grab all N upgrades" stays as it is today.
- Virtualised rows above 300 albums (render a window, not the whole list).
  Row height is fixed so the window is cheap.

### Wander

Shelves, each with a title and a reason line, rendered in this order and
hidden when empty:

1. **They go deep on** — artists with ≥ 8 albums here, sorted by count. Card
   shows artist, album count, "N you lack". Click opens an artist shelf
   (all their albums here, ledger-style).
2. **Fresh arrivals** — `newDirs` from the engine, as today's "New since last
   visit".
3. **Because you own …** — one shelf per seed artist, up to three seeds. Seeds
   are the user's top-affinity artists from `taste-model.buildAffinity` that
   the peer also holds. Members are peer albums whose artist shares ≥ 2
   MusicBrainz artist tags with the seed. Tags are fetched through a new
   `musicbrainz-artist-tags` handler (keyless, 1 req/s, cached in a
   SideStore for 30 days). The shelf appears when its data is ready; the
   page never waits on it.
4. **Only here** — albums whose artist+album key matches nothing in any
   other cached peer's albums (browse cache). Reason line names how many
   peers were checked. Skipped when fewer than 3 other peers are cached.
5. **A decade they love** — the single decade with the most albums, as a
   shelf; reason line gives the share.
6. **Their surround room** — surround albums.
7. **Hi-res** — as today.

Under the shelves: one featured artist (the top "go deep" artist) with the
Wikipedia summary from the existing `artist-info` handler and a link to that
artist's shelf.

Cards carry the label dot and a one-word hint (`not yours`, `24/96`, `you
have it`). Keyboard: arrows move between cards, Enter opens the dossier,
as today.

### Folders

Three columns in a horizontally scrolling rail, Finder-style:

- Column 1..N: directory listing for each level of the current path. Rows
  show name, subfolder/file counts, and the per-folder quality summary
  (`_slskDirQuality`). Selecting a row opens the next column to its right and
  trims deeper columns.
- Last column: the inspector for the selected item. For a folder that reads
  as an album: cover, title/year, quality string, "yours" quality and verdict,
  extras present (log, cue, artwork), track list with per-track quality and
  length, and buttons: Download album, Preview a track, Verify this rip, Open
  dossier. For a non-album folder: counts, size, majority format, "Download
  everything below". For a file: name, exact bit depth / rate / bitrate /
  length / size, Preview, Download & play, Download.
- Keyboard: ←/→ move between columns, ↑/↓ within, Enter opens, Backspace
  goes up. Breadcrumbs stay above the rail and are clickable.
- Filters carry over: audio only, surround only (renders the flat surround
  list in the first column), search (renders results in the first column).
- Multi-select of files with checkboxes and "Download selected" carry over.

### Album dossier

Replaces the slide-over from `slsk-album-view.js` for all three modes and for
search results. Same host/overlay mounting rules. Sections, in order:

1. Header: cover, title, artist, year, edition note, source peer.
2. Facts row: quality label, track count and total length, size, extras
   (log/cue/art), verdict chip.
3. Actions: Download album, Preview a track, Verify this rip, Compare with
   mine, Add to wishlist, Chat with peer.
4. **Rip check**: empty state is the Verify button with one sentence about
   what it does. Running state shows which track is being pulled and a
   progress bar. Result shows verdict, measured spectral ceiling, effective
   bit depth, dynamic-range figure, and "verified from track N, X ago".
   Results are cached per album key for 30 days.
5. **Reception**: Discogs community rating, rating count, genre/style tags.
   Requires a Discogs personal token in Settings → Soulseek. Without one the
   section shows one line: "Add a Discogs token in Settings to see ratings
   and tags." Cached 30 days per artist+album.
6. **About**: Wikipedia extract via the existing `artist-info` handler.
7. **Also by this artist here**: chips for the peer's other albums by the
   same artist, each opening its dossier.
8. **Tracks vs yours**: the existing comparison table.

### Rip check (new main-process handler `slsk-verify-rip`)

Input: username, album folder path, list of audio files. Steps:

1. Pick the track: the longest one under 80 MB, else the smallest.
2. Download it via the existing slskd download path into
   `<userData>/rip-check/<hash>/`, not the music download dir, so the library
   scanner never sees it. Wait for completion with the existing transfer
   poller; time out at 3 minutes.
3. Run ffprobe for declared bit depth and sample rate. Run ffmpeg with
   `astats` (bit depth actually used, dynamic range) and a spectral pass
   (`aspectralstats` rolloff, or a highpass-then-volume measurement) to find
   the highest frequency with real energy.
4. Verdict rules: declared rate 88.2k+ but ceiling below 22 kHz →
   "upsampled, really ~16/44". Declared 24-bit but measured bit depth ≤ 16 →
   "padded 16-bit". Lossless extension but ceiling below 16 kHz with a sharp
   shelf → "likely transcoded from lossy". Otherwise "genuine <bd>/<sr>".
5. Delete the scratch folder. Return the measurements and verdict.

Every failure path (peer offline, queue full, timeout, ffmpeg missing)
returns `{ ok: false, reason }` with copy the dossier can show verbatim.

### Discogs (new main-process handler `discogs-album`)

`GET /database/search?artist=&release_title=&type=master` with the personal
token, then the master's `community.rating`, `genres`, `styles`. Token stored
in electron-store under `discogsToken`; Settings gets one input field beside
the existing Soulseek settings. Rate-limited to 1 req/s. No key → handler
returns `{ ok: false, reason: 'no-token' }` and never calls out.

## Files

New:

- `src/slsk-room-ui.js` — page shell, header, mode switch, wires the three
  modes. Takes the same `deps` object `slsk-shop-ui.js` takes today.
- `src/slsk-hunt.js` — ledger model (pure: rows, verdict words, sort, filter)
  and its renderer.
- `src/slsk-wander.js` — shelf model (pure: go-deep, decade, only-here,
  because-you-own given tags) and its renderer.
- `src/slsk-columns.js` — column browser + inspector.
- `src/slsk-dossier.js` — the album dossier.
- `src/rip-check.js` — pure parser for ffmpeg/ffprobe output and the verdict
  rules.
- `src/slsk-room.css` — all styling, scoped under `.slsk-room`, classes
  prefixed `slr-`, reusing the tokens and label colours from
  `slsk-explorer.css`.
- `docs/peer-library.md` — user-facing description of the three modes.

Changed:

- `main.js` — handlers `slsk-verify-rip`, `discogs-album`,
  `musicbrainz-artist-tags`; Settings plumbing for the Discogs token.
- `preload.js` — expose the three handlers.
- `src/renderer.js` — `renderSoulseekExplore` picks the new shell unless
  the setting `slskLegacyShop` is true.
- `src/index.html` — script and stylesheet tags.

Untouched: `slsk-tree.js`, `slsk-shelves.js`, `slsk-compare.js`, browse
cache, download paths.

## Testing

- Pure modules (`slsk-hunt`, `slsk-wander`, `rip-check`) get node tests
  with fixture trees; verdict words and shelf membership are asserted
  exactly. Mutation-check each: break the rule, confirm the test goes red.
- Renderer scope test (`slsk-renderer-scope.test.js`) is extended to load the
  new scripts together so a top-level name collision cannot ship silently.
- IPC handlers get tests with stubbed slskd and ffmpeg; every failure path
  is asserted to return `{ ok: false, reason }`.
- A live twin run (credential-stripped profile, one twin) opens a cached
  peer, switches all three modes, opens a dossier from each, walks Folders
  with the keyboard, and runs a CDP console sweep for errors. Screenshots go
  in the PR.
- Full suite stays green.

## Rollout

- Setting `slskLegacyShop` (default off) switches back to `slsk-shop-ui.js`.
  The old files stay for one release cycle, then get removed in a follow-up
  once the user has lived with the new one.
- Discogs stays empty until a token is added; the app never prompts for it.

## Open items

- MusicBrainz tag fetch for many artists is slow at 1 req/s. Cap at the top
  40 artists per peer per session; the shelf says "based on N artists" so
  the limit is visible.
