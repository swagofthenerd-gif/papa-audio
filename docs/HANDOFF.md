# Handoff — Papa Audio stability work

Written 2026-08-27. Read this first in a new session, then `docs/STABILITY-250.md`.

## Where things stand

| | |
|---|---|
| Branch | `feature/library-management-and-qa-fixes` |
| Tests | 488 passing (`npm test`), 2 skipped — the two real-mpv integration tests, which need mpv installed |
| Tier 1 | **done** — items 1, 2, 3, 6, 7 |
| Tier 2 | **done** — items 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 251, 252. Item 16 partly, and it says why |
| Tier 3–6 | not started |
| Verified against real mpv | **no.** Everything below is tests and reading. See "How this was, and was not, verified" |
| New findings | items 251–254 at the end of `STABILITY-250.md`. 254 breaks packaged builds and is not fixed |

Two rounds of QA are already done and merged into this branch (Library, Artists, Playlists, Stats,
Search, Downloads, plus a first stability pass). Round 3 — the full stability pass — is inventoried in
full; **Tier 1 is now implemented**, Tiers 2–6 are not.

What Tier 1 changed, in one line each:

- `mpv-engine.js` — a flight recorder (300 entries, timestamped, with a 15 s position heartbeat), mpv's
  own log captured over IPC, every `end-file` reason mapped, and payloads on all four lifecycle events.
- `engine-diagnostics.js` (new) — formats the log entry that has to explain the next stop. Its own file
  so the format is testable; that text is the deliverable, not a side effect of one.
- `main.js` — writes the diagnostic to the daily log, forwards the four payloads, reports `mpvAvailable`
  separately, and exposes `player-get-diagnostics` for the QA harness.
- `mpv-crossfade.js` — re-emits the same events and merges both engines' recorders, so crossfade users
  are not left out.
- `src/player-shim.js` — the four missing cases, and it stops claiming to be playing while mpv is down.
- `src/renderer.js` — clears `state.isPlaying`, shows a Reconnecting badge, one brief snackbar on
  recovery naming the resume position, and a blocker message written from the real reason.
- `tools/mpv-probe.js`, `tools/fault-inject.sh` (new) — ground truth and fault injection, below.

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
- **Piping mpv's stderr does not capture mpv's messages.** This one was mine — item 1 of
  `STABILITY-250.md` proposed "spawn with stderr piped and `--msg-level=all=warn`", and that would have
  produced an empty ring buffer and the appearance of a fix. `--no-terminal`, which the engine has
  always passed, silences mpv's message output completely. mpv's messages come over the JSON IPC socket
  via `request_log_messages warn`, as `log-message` events with level, subsystem prefix and text. stderr
  is still piped, because it catches what bypasses mpv's logging — libav aborts, asserts, and whatever
  mpv prints while dying before it accepts an IPC connection — but it is the second source, not the
  first. Do not "simplify" this back to one channel, and do not add terminal flags to make stderr work:
  changing spawn args risks an mpv that will not start at all, which is far worse than the bug.

## Order of work

1. ~~**Tier 1 — make the next stop explainable.**~~ **Done.** Items 1, 2, 3, 7 and — ahead of its tier —
   6, because a recovery that resumes the track and then stops at the album boundary is not a recovery.
   Still needs the fault-injection run on the Fedora machine before it can be called verified.
2. ~~**Tier 2 — stop playback dying.**~~ **Done.** All of it, plus the surrounding engine items that
   only make sense together: typed `EngineGone` with generation pinning, per-operation IPC timeouts
   with a retry only where a double-apply is harmless, a stall watchdog that asks mpv rather than
   guessing, one eof state machine so `ended` and `autoAdvanced` can never both fire, a bounded
   resume, device-loss detection with a fallback away from a vanished device, and a load-error policy
   where only a **confirmed** absence may touch the queue. Item 16 is partly done on purpose — the
   playlist-remove arithmetic needs real mpv, and getting the index wrong stops playback audibly.
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

## How Tier 1 was, and was not, verified

Being exact about this, because the rule in this project is that the UI's claims are not evidence — and
neither are mine.

**Verified.** 488 tests pass, up from 399. The 89 new ones test behaviour, not implementation:
every `end-file` reason including ones mpv has not invented yet; our own `loadfile`/`playlist-clear`
not being mistaken for a fault; the timeline being bounded and copied on read; mpv's log reaching the
ring and faults reaching the timeline inline; `engineDown` carrying `willRecover`; recovery seeking back
to the same position; `engineFailed` carrying `respawn-limit` with mpv's own lines; the shim translating
all four events and correcting its `_paused`; and the exact log text, checked against a reconstruction
of the Snow Goose stop. `test/engine-event-wiring.test.js` asserts the emit → forward → shim → renderer
chain across four files, so the original bug's *shape* — emitted, forwarded, silently dropped — now
fails the build.

**Not verified, and this is the gap that matters.** None of it has run against real mpv. The session
that implemented it was on a macOS machine with no mpv, no PipeWire, no `~/.config/papa-audio`, and no
`.qa/` (it is gitignored, so it does not travel). The two real-mpv integration tests skipped for exactly
that reason. So on the Fedora machine, before trusting any of this:

1. `npm test` — the two skipped tests should now run there. 490 passing expected.
2. Play a local album. `node tools/mpv-probe.js` should agree with the UI about path, position and pause.
3. `tools/fault-inject.sh` — SIGKILL, SIGSTOP, PipeWire restart, device suspend. It checks the daily log
   and mpv's socket automatically and prints what needs your eyes. Before this work all four were
   silent; `sigkill` must now produce a named log line, a visible Reconnecting badge, a resume at the
   same position, and one brief notice.
4. The `sigstop` case should now **pass** its log check — per-operation timeouts landed in Tier 2, so a
   wedged mpv produces a timeout line naming the command. The harness's message still says it is
   expected to fail; if it passes, that message is what is out of date, not the result.
5. Then the full pass from the section below — ten tabs, no orphaned mpv, a gapless album end to end
   with all 12 tracks in `playHistory`.

Things I could not test at all, and would look at first if something is wrong:

- The `Resume` action on the unexplained-stop snackbar. It reloads the track and then sets
  `currentTime`, relying on the engine's deferred-seek path.
- `updateNextPrefetch()` on recovery.
- **The per-operation timeouts.** These are guesses at what real hardware needs: loadfile 20 s, seek
  10 s, get_property 2 s. If a large 5.1 FLAC on a cold cache still trips the loadfile budget, raise it
  — the flight recorder will name the command and the budget it exceeded, so this is measurable rather
  than a matter of opinion.
- **The 3 s eof advance wait.** If gapless transitions ever feel like they hesitate, look for
  `advance-failed` in the log: that is the 3 s ceiling being reached, and it means the handoff genuinely
  failed rather than the wait being too long.
- **The stall watchdog's 8 s threshold.** Long enough not to fire on a slow seek across a network mount;
  short enough to catch a stop. Untested against a real dead mount, which is the case most likely to
  produce a false positive.
- **`setProperty('audio-device', …)`** for the Settings device picker. That path has never once worked
  (item 252), so it has no working behaviour to regress — but equally, nobody has ever seen it succeed.

## New tools

- `tools/mpv-probe.js` — reads mpv's IPC socket directly and prints its state. Deliberately shares no
  code with the engine: a probe built from the thing under test can agree with it while both are wrong.
  `--json` for scripts, `--watch` to follow events live, `--get <prop>` for one value.
- `tools/fault-inject.sh` — the four injections, with automatic checks against the daily log and mpv's
  socket, and explicit `CONFIRM BY EYE` lines for what only a human or CDP can see. In `tools/` rather
  than `.qa/` on purpose: `.qa/` is gitignored, so anything put there does not reach the machine that
  needs to run it.

## Environment facts worth not rediscovering

- Fedora 44, KDE Plasma on Wayland. Monitors at different scales (3840x2160 @1.7, 1920x1080 @1.0).
- Playback is **mpv over JSON IPC**, never the `<audio>` element. mpv is a hard requirement.
- slskd runs externally at `http://localhost:5030/api/v0`, creds `slskd`/`slskd` (localhost default).
- Config: `~/.config/papa-audio/config.json` — currently **2.56 MB**, rewritten synchronously in full
  on every one of 73 `store.set` call sites.
- Logs: `~/.config/papa-audio/logs/papa-YYYY-MM-DD.log` — ERROR/INFO only, via blocking
  `appendFileSync` on the main thread.
- `src/renderer.js` is 14,085 lines, one of 18 classic `<script>` tags sharing a single global scope.
