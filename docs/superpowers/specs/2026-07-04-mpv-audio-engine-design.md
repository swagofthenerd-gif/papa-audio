# Papa Audio — mpv Audio Engine Design

*Date: 2026-07-04 · Status: approved pending final user review*

## Goal

Replace Chromium-based playback (`<audio>` element + Web Audio graph) with an
mpv-based engine so Papa Audio delivers a clean, unresampled audio path and
true gapless playback. This closes the two biggest gaps identified in the
competitive teardown (`02-research/competitive-teardown-2026-07.md`).

## Decisions (from brainstorming, 2026-07-04)

| Decision | Choice |
|---|---|
| Integration | mpv binary + JSON IPC socket (approach A). No libmpv native bindings, no Web Audio rework. |
| Platform | Linux-first (Fedora). Design stays Windows-portable; Windows untested/unbundled for now. |
| Output default | mpv → PipeWire (no exclusive mode). Settings toggle for exclusive ALSA + device picker, for a future DAC. |
| EQ | **Removed entirely** (purist mode). |
| Visualizer | **Removed entirely.** |
| ReplayGain | Kept, via mpv native `--replaygain` (off / track / album in settings). |
| Crossfade | Kept, rebuilt as two mpv instances with volume ramps. Mutually exclusive with gapless (settings toggle). |
| mpv missing/unrecoverable | **Hard requirement.** Blocking setup screen with install instructions. No `<audio>` fallback. |

## Architecture

```
renderer.js (UI, queue, playlists — unchanged logic)
    │  ipcRenderer: player-* calls          ▲ webContents.send('player-event', …)
    ▼                                       │
main.js ── registers player-* IPC handlers ─┤
    │                                       │
mpv-engine.js (new, main process)───────────┘
    │  spawn + JSON IPC over unix socket
    ▼
mpv --idle --no-video --input-ipc-server=<XDG_RUNTIME_DIR>/papa-mpv-<n>.sock
    ▼
PipeWire (default)  |  ALSA exclusive (toggle)
```

### mpv-engine.js (new module, project root)

Owns the full mpv lifecycle. Public surface (used only by main.js):

- `start(opts)` / `stop()` — spawn/kill mpv with flags derived from settings
  (`--idle=yes --no-video --no-terminal --audio-display=no`,
  `--gapless-audio=weak`, `--replaygain=<mode>`, and in exclusive mode
  `--audio-device=alsa/<dev> --audio-exclusive=yes`).
- `load(path)` — `loadfile <path> replace`.
- `setNext(path|null)` — maintain a sliding two-item mpv playlist
  (current + next) so the decoder prefetches for gapless. Called whenever the
  JS queue changes.
- `play()` / `pause()` / `seek(seconds)` / `setVolume(0-100)`.
- Events emitted to main.js: `position` (throttled ≤4 Hz), `duration`,
  `paused`, `trackChanged` (path), `audioParams` (real sample rate / format),
  `ended`, `engineDown`.
- Command queue with per-command timeout (2 s); request-id matching on the
  JSON IPC socket.

### Crossfade sub-mode

When crossfade is enabled (settings), the engine runs two instances A/B.
On natural track end approach (fade starts at EOF minus the configured
crossfade duration; default 4 s) or manual skip: B loads the next track at volume 0, then a stepped ramp
(A: v→0, B: 0→v, ~20 steps over the configured duration) runs; A is then
stopped and roles swap. Gapless prefetch (`setNext`) is disabled in this mode.

### main.js changes

- New IPC handlers: `player-load`, `player-play-pause`, `player-seek`,
  `player-set-volume`, `player-set-config` (output mode, RG mode,
  gapless/crossfade, crossfade duration), `player-status`,
  `player-list-audio-devices` (parses `mpv --audio-device=help`).
- Pushes engine events to renderer as `player-event` messages.
- MPRIS (`mpris-service`) is fed from engine state instead of renderer state.
- Startup check: resolve mpv binary (`mpv --version`). If absent → send
  `player-event {type:'mpv-missing'}`; renderer shows the blocking setup
  screen with `sudo dnf install mpv` (and distro-generic hint).

### renderer.js changes

- Remove: `AudioContext` init, `createMediaElementSource`, EQ node chain +
  EQ panel UI, analyser + visualizer canvas, dual-`<audio>` crossfade code,
  the `<audio id="audio">` element usage for playback.
- Replace `<audio>` event wiring (timeupdate/ended/loadedmetadata) with
  `player-event` subscriptions. Queue/playlist/shuffle/repeat logic unchanged;
  on queue change, call `setNext` with the upcoming track.
- Hi-res badge now uses `audioParams` from mpv (actual decoded rate/depth)
  instead of file-extension guessing.
- Settings UI: new "Playback engine" section — Output (Default/PipeWire vs
  Bit-perfect/ALSA + device picker), Gapless ⊕ Crossfade (+ duration slider),
  ReplayGain (off/track/album). EQ panel and visualizer settings removed.
- Blocking setup screen for `mpv-missing`.

### Unaffected

`bridge-server/` and the Android app (they read files and slskd directly);
Soulseek search/download; library scanning; lyrics; playlists/likes storage.

## Error handling

- **Engine crash:** auto-respawn, reload current track, seek to last known
  position, restore paused state and volume. >3 respawns in 60 s → give up,
  show persistent error banner (same screen as mpv-missing, with log excerpt).
- **Command timeout / dead socket:** treated as engine-down → respawn path.
- **File load failure** (deleted/corrupt): emit `ended` with error flag;
  renderer skips to next queue item and toasts the failure.
- **Settings changes:** ReplayGain mode and volume apply live via property
  set. Output mode (PipeWire ↔ exclusive ALSA) and gapless ↔ crossfade
  require an engine restart — done seamlessly: save position, restart,
  reload, seek, resume.

## Testing

1. **Unit** (`test/mpv-engine.test.js`, mock socket server): command queue,
   request-id matching, timeout handling, property-observer event mapping,
   respawn back-off logic.
2. **Integration** (real mpv, `--ao=null`): load/play/pause/seek/eof events;
   sliding-playlist gapless enqueue; audio-params reporting; kill -9 recovery.
3. **Manual QA checklist:** gapless live album (no seams), crossfade on
   shuffle, RG track vs album loudness, exclusive-ALSA toggle round-trip,
   mid-song `kill -9` of mpv → auto-recovery at position, MPRIS media keys +
   GNOME extension still work.

Implementation follows superpowers TDD (test first, red → green → refactor).

## Non-goals (this sub-project)

- Windows bundling/testing (design stays portable; deferred).
- Transcode detection, MusicBrainz tag normalization (sub-project 2).
- State backup/sync (sub-project 3).
- Android remote access / offline (sub-project 4).
- Any EQ or visualizer replacement.

## Risks

- **~50 ms IPC command latency** — imperceptible for play/pause/seek.
- **PipeWire still resamples if device rate ≠ file rate** in default mode;
  that's accepted (onboard audio). Exclusive ALSA mode exists for when it
  matters.
- **Crossfade dual-instance timing** is the fiddliest part; it's isolated in
  the engine module and off by default (gapless is the default).
- **renderer.js is 7.5k lines** — removals must be surgical; baseline commit
  `c90fb19` is the rollback point.
