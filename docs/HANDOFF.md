# Handoff — Papa Audio stability work

Written 2026-08-27. Read this first in a new session, then `docs/STABILITY-250.md`.

## Where things stand

| | |
|---|---|
| Branch | `feature/library-management-and-qa-fixes` |
| Last commit before this handoff | `678ed7b` — error boundaries |
| Tests | 399 passing (`npm test`) |
| Working tree | clean |
| Code changed for the 250-item plan | **none yet** — the user chose document-first |

Two rounds of QA are already done and merged into this branch (Library, Artists, Playlists, Stats,
Search, Downloads, plus a first stability pass). Round 3 — the full stability pass — is planned and
inventoried but **not started**.

## The bug that started round 3

The user reported playback stopping abruptly mid-album. Reconstructed from evidence, not code:

- Stopped at `06 - The Snow Goose.flac`, **85.2 s into a 192 s track**, of a 12-track album
  (`/mnt/data/MUSIC/Downloads/1975 - Camel - The Snow Goose (5.1)/`).
- Newest `playHistory` entry 2026-08-27 01:23:38; history is written 30 s after a track starts
  (`renderer.js:5836`), so the track began 01:23:08.
- Last line the app ever logged: 01:23:05.
- Saved queue at that moment: **6 tracks** — 01, 02, 04, 05, 06, 07 — index 4.
- systemd journal 01:10–01:40: **nothing**. No crash, no coredump, no PipeWire event, no OOM.
- All 12 files present and healthy on disk (48 kHz / 5.1 / 24-bit FLAC); all 12 in `libraryCache`.

**It stopped mid-track, the machine was fine, and the app recorded nothing.** The cause was not
determined and should not be guessed at. Six mechanisms each produce exactly this symptom and all are
silent by construction — items 1–6 in `STABILITY-250.md`. That is why instrumentation is Tier 1.

Reproduce the forensics with:

```bash
python3 -c "import json;d=json.load(open('$HOME/.config/papa-audio/config.json'));print(d['playbackState'])"
ls ~/.config/papa-audio/logs/          # daily logs, ERROR/INFO only
journalctl --user --since "<date>" | grep launch.sh
```

## Decisions already made — do not re-open these

1. **Recovery behaviour.** When mpv dies and the app can recover: resume from the same position, then
   show a brief non-blocking notice ("Playback engine restarted — resumed at 1:25"). Never a blocking
   prompt, never silent.
2. **CPU-rasterisation flags stay.** `disable-gpu-rasterization`, `disable-zero-copy`,
   `num-raster-threads=2` in `main.js`. They are the remaining half of the monitor-switch hitch, but
   this machine also runs DaVinci Resolve and the user chose VRAM headroom. Closed, not a bug. The
   stale comment claiming Electron has no hardware acceleration should still be corrected to state
   the real reason.
3. **Document first, then fix.** The 250 items were delivered before any code change.

## Corrections to earlier claims — do not re-introduce these

- **`playHistory` is not corrupt.** An earlier report said 598 entries had `ts: undefined` and
  proposed dropping them. Wrong. The array is newest-first and every entry has a valid time; there
  was a field rename from `timestamp` to `ts` on 2026-08-04 with no migration. Indices 0–625 use
  `ts`, 626–1223 use `timestamp`. Dropping the tail would **delete 463 real plays**. Read
  `ts ?? timestamp` and migrate. Item 91.
- **`shell.trashItem` is guarded.** Both call sites go through `libPathAllowed()`, which uses
  `realpathSync`, requires strictly-inside-a-root and fails closed. Do not "fix" it.
- **`var API` across 8 files is latent, not live.** Each file captures its namespaced export before
  the next overwrites the bare global. The real gap is that `test/script-globals.test.js` guards
  `function` collisions but not `var`.
- **`pollCmd`'s catch never fires** — the `cmd` file exists at 0 bytes. It is a 5 Hz synchronous
  *read*, which is still worth fixing, but not a write loop.

## Order of work

1. **Tier 1 — make the next stop explainable.** Capture mpv's stderr (it is currently
   `stdio:'ignore'`), a playback flight recorder into the existing daily log, handle every `end-file`
   reason, wire `engineDown` through the shim, make `engineFailed` report the real reason.
2. **Tier 2 — stop playback dying.** Null-safe engine commands, re-arm prefetch after respawn,
   per-operation IPC timeouts with one retry, `dropMissingTrack` must verify the file is gone,
   resolve the `ended`/`autoAdvanced` double-fire, detect audio-device loss distinctly.
3. **Tier 3 — stop the main thread freezing.** `dirSize` async, `dlPersist` debounced, split the
   2.5 MB store, replace `pollCmd` with a watch, async logging, ffprobe off the main thread.
4. **Tier 4 — data integrity.** The `ts`/`timestamp` migration, history on auto-advance, reconcile
   `playCounts` against `playHistory`.
5. **Tier 5 — leaks, races, correctness.** Modal listener leaks, `_scheduleLibRescan` coalescing,
   missing stale-render guards, unguarded `JSON.parse(localStorage…)`, unbounded caches, the 105
   empty `catch` blocks.
6. **Tier 6 — the remaining improvements.**

## How to verify (this matters more than the code)

The lesson from two rounds: **verify against ground truth, never against the UI's own claims.**

- Per fix: `node --check` on touched files, then `npm test`.
- Per batch: relaunch and drive the real app over CDP. The harness lives in `.qa/` (gitignored,
  local only): `cdpd.js` is a persistent-connection daemon, `ev.js` a thin client, `relaunch.sh`
  enforces the ordering. `.qa/README.md` explains why a naive CDP connection hangs.
- **Electron's `--remote-debugging-port` socket is inherited by every child it spawns**, mpv and
  yt-dlp included. A new connection can be accepted by mpv, which does not speak the protocol, and
  hangs forever — it looks exactly like a hung renderer. Kill Electron *before* mpv, and wait for the
  port to be free.
- Ground truth for playback is mpv's own IPC socket (`$XDG_RUNTIME_DIR/papa-mpv-*.sock`), not the UI.
- The stop itself needs a fault-injection harness, not a code read: SIGKILL mpv mid-track, SIGSTOP it
  past the command timeout, restart PipeWire, remove the ALSA sink. Each must produce a log line
  naming the cause and a visible UI state, and playback must recover. Today all four are silent.
- Final pass: all 10 tabs, zero runtime errors, no orphaned mpv, and a full gapless album played end
  to end with **all 12 tracks landing in `playHistory`**.

## Environment facts worth not rediscovering

- Fedora 44, KDE Plasma on Wayland. Monitors at different scales (3840x2160 @1.7, 1920x1080 @1.0).
- Playback is **mpv over JSON IPC**, never the `<audio>` element. mpv is a hard requirement.
- slskd runs externally at `http://localhost:5030/api/v0`, creds `slskd`/`slskd` (localhost default).
- Config: `~/.config/papa-audio/config.json` — currently **2.56 MB**, rewritten synchronously in full
  on every one of 73 `store.set` call sites.
- Logs: `~/.config/papa-audio/logs/papa-YYYY-MM-DD.log` — ERROR/INFO only, via blocking
  `appendFileSync` on the main thread.
- `src/renderer.js` is 14,085 lines, one of 18 classic `<script>` tags sharing a single global scope.
