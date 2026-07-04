# Papa Audio — Agent Instructions

## Primary mission
Find and download the music the user asks for, however necessary. This is the only job that matters. If something blocks a download — a broken source, a missing codec, a daemon not running, a search returning nothing — diagnose and solve it autonomously without waiting for the user to ask.

## Stack
- Electron app at `/home/shaharyar/flac-player/`
- Main process: `main.js` | Renderer: `src/renderer.js` | Bridge: `preload.js` | Styles: `src/styles.css`
- Soulseek daemon (slskd) at `http://localhost:5030/api/v0` — JWT auth with username/password `slskd`/`slskd`
- Music library: `/mnt/data/MUSIC` (scanned recursively; downloads go to `/mnt/data/MUSIC/Downloads/`)
- slskd runs externally as PID ~466166, connected as Soulseek user "sherrybaaz"

## How searching works
- `slsk-search` IPC handler fires a slskd POST `/searches` with up to 6 query variants in parallel
- Variants: cleaned query, bracket-stripped, stop-word-stripped, year-stripped, drop-first-word, last-N-words, reversed 2-word
- Each search runs for 90 s; responseLimit 3000; progressively renders results as variants complete
- `_slskGroupByFolder()` groups responses by `username::folderPath`, FLAC-first, query-relevance scored
- Download via `slsk-download` IPC → slskd POST `/transfers/downloads/{username}`
- File resolution: `slsk-resolve-file` checks multiple candidate paths on disk

## Defaults and behavior rules
1. **Never give up on a search.** If Soulseek finds nothing, retry with simpler terms. If still nothing, check if slskd is connected and reconnect if needed.
2. **FLAC / lossless first** — always prefer lossless sources. MP3 only if nothing else exists.
3. **Organize downloads into album subfolders** — slskd preserves remote folder structure automatically. Download dir: `/mnt/data/MUSIC/Downloads/`.
4. **After every download, schedule a library rescan** at 15 s, 45 s, and 120 s so new files appear in the library without manual refresh.
5. **Play buttons must always be visible** (not hidden behind hover). `opacity: .85` always on.
6. **Progressive search display** — show results as each search variant completes; never make the user wait for all variants to finish before seeing anything.
7. **Quality sources** in settings: Lucida, Monochrome, Lydia (`https://lydia.to/search?q={query}`), HDtracks, Qobuz, Beets.

## Key IPC handlers (main.js)
- `slsk-search` — start search, poll, return merged results
- `slsk-download` — queue download on slskd
- `slsk-get-transfers` — poll transfer list
- `slsk-resolve-file` — find already-downloaded file on disk
- `slsk-get-download-dir` / `slsk-set-download-dir` — manage download folder
- `slsk-status` — connection health check

## User preferences
- User is "Shaharyar" (Soulseek: "sherrybaaz")
- Prefers lossless (FLAC/WAV) above all else
- Wants the search to be as comprehensive as possible — maximum peer coverage matters
- UI should feel like Spotify but with P2P power underneath
- See memory files for musical taste profile and learned preferences
