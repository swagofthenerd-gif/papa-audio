# Handoff — Papa Audio stability work

Written 2026-08-27. Read this first in a new session, then `docs/STABILITY-250.md`.

## Where things stand

| | |
|---|---|
| Branch | `feature/library-management-and-qa-fixes` |
| Tests | 752 passing (`npm test`), 2 skipped — the two real-mpv integration tests, which need mpv installed |
| Tier 1 | **done** — items 1, 2, 3, 6, 7 |
| Tier 2 | **done** — items 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 251, 252. Item 16 partly, and it says why |
| Tier 3 | **done** — items 36, 37, 40, 41, 42, 43, 44, 45, 48, 49, 54, 55, plus 255, a regression this round introduced |
| Tier 4 | **done** — items 91, 92, 93, 94, 96, 98, plus 256. Item 95 partly, and it says which part |
| Tier 5 | **done** — items 71–81, 85, 89, plus 257. Items 82, 83 and 84 partly, each saying which part and why |
| Tier 6 | **done as far as it can be from here.** Every OPEN Critical and all but two OPEN High are closed |
| Catalogue | 125 DONE, 8 OPEN, 2 CLOSED, 123 PROPOSED — see "Where the catalogue stands" below |
| Verified against real mpv | **no.** Everything below is tests and reading. See "How this was, and was not, verified" |
| New findings | items 251–267 at the end of `STABILITY-250.md`, all DONE |
| **Second audit** | **`docs/AUDIT-2026-08-28.md` — 57 further bugs. ALL 57 ARE NOW FIXED.** Each entry is marked `[FIXED]`. |
| Second audit status | Tier 0 `dc2f510` · Tier 1 `2907e93` · Tier 2 `99ae51f` + `f8611ec` · Tier 3 `151c302` · Tier 4 `00884df` · Tier 5 `ef57edc` |

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
3. ~~**Tier 3 — stop the main thread freezing.**~~ **Done.** The store split is the substantial part:
   the five keys that were nearly all of the 2.5 MB config, and nearly all of its writes, each own a
   small file now (`side-store.js`) — read once synchronously, written asynchronously, coalesced, and
   replaced atomically. There is a one-time migration out of the shared config that can only ever run
   when the side file does not exist yet, so a stale config value cannot resurrect over newer data.
   Also: `dirSize` is async and yields and caches; `pollCmd`'s 200 ms sync read-and-write became an
   fs.watch with a 5 s backstop; logging is buffered with a size cap and is installed at module load
   so startup lines are no longer lost; and no synchronous child_process call is left in main.js.
4. ~~**Tier 4 — data integrity.**~~ **Done.** The migration recovers the legacy-keyed entries instead of
   dropping them, quarantines the genuinely unusable rather than deleting them, and reports the range
   it recovered. History is recorded on gapless auto-advance through the same helper as the
   explicit-start path, so the two cannot drift again. The reconciliation reports and does not rewrite.
   The cap archives the overflow monthly instead of discarding it. And `app-recovered-from-crash` is
   wired the whole way through for the first time.
5. ~~**Tier 5 — leaks, races, correctness.**~~ **Mostly done.** All three modal listener leaks (there
   was a third, item 257), the rescan coalescing, both missing stale-render guards, generation tickets
   on the YouTube renders, one validated localStorage reader with nothing parsing it directly any more,
   bounded LRU on the three caches that had no ceiling, CSS.escape on ids from outside, per-subscriber
   IPC teardown, a survivable downloads poll frame, and rejection handlers on the six uncaught chains.

   The three items left partly done are deliberate, and each says so in the catalogue: the 54
   `setTimeout` calls were not audited individually (the ones that mattered are done); item 83's premise
   turned out not to hold — none of the 23 global listeners is reachable from `bindContentEvents`; and
   the 104 empty `catch` blocks were **not** rewritten wholesale. On that last one the criterion was:
   fix every one that hides a consequence the user would notice. Four did — a silently lost scrobble,
   a failed slskd restart that left the UI saying "restarting" forever, a missing optional dependency
   silently disabling the folder watcher, and a library Undo whose restore could fail silently after the
   snackbar had promised it would work. The rest guard an unlink or a stat probe, and a blanket rewrite
   would be a large diff with almost no signal.
6. ~~**Tier 6 — the remaining improvements.**~~ **Done as far as it can be from here.** Worked through
   by severity rather than by number. Every OPEN Critical is closed, and of the OPEN High only 166 and
   183 remain — both deferred with the reason written into the catalogue rather than left silent.
7. ~~**The second audit, all six of its tiers.**~~ **Done.** See the section below.

## What is actually left

Everything that can be fixed by reading and testing has been. What remains needs
the app running on the Fedora machine:

1. **Verify against real mpv.** No line of any of this has run against mpv,
   PipeWire, or a real library — this machine has none of them, and the two
   real-mpv integration tests skip throughout. `tools/mpv-probe.js` and
   `tools/fault-inject.sh` exist for exactly this and have never been run.
2. **The three classes of bug no static pass can reach**, listed at the end of
   the audit: render order and layout (does the element land where the CSS
   says), event double-binding (a re-render that binds a handler twice), and
   behaviour over hours (drift, growth, and the interactions between them).
   All three need CDP against the running app.
3. **Catalogue items 166 and 183**, both OPEN High, both deferred with a stated
   reason.
4. **Item 16's playlist-remove arithmetic**, deliberately left partly done: the
   index has to be right against real mpv, and getting it wrong stops playback
   audibly.

## The second audit is complete

`docs/AUDIT-2026-08-28.md` is a separate pass run after the 125 fixes landed. It
found **57 more bugs**, none of which duplicate an OPEN item in
`STABILITY-250.md`. **All 57 are now fixed**, in the audit's own tier order, one
commit per tier. Every entry in that document is marked `[FIXED]`.

What each tier was, and what closing it changed:

- **Tier 0 (5)** — regressions this round introduced, two of them defeating
  guards added in the same round.
- **Tier 1 (9)** — everything that lost or corrupted data: a path round trip
  that decoded what was never encoded, an album key that did not trim,
  double-queued downloads, a permanently poisoned artwork cache, and a startup
  restore that silently replaced whatever the user had just started playing.
- **Tier 2 (14)** — features that were wired and unreachable, or that lied. The
  embedded browser and the saved-sites pair were deleted (nothing could drive
  them); cancel-download, the general settings, the shortcuts dialog, the stats
  range, the compact sidebar and the Discover swipe were wired for real.
- **Tier 3 (12)** — long-session stability: sixteen native dialogs that froze
  the renderer, a synchronous write once a second through all playback, three
  unbounded caches, an undo stack that never expired, and every drag in the app
  being mouse-only.
- **Tier 4 (9)** — interaction: MPRIS Play/Pause/Stop inert, shuffle able to
  pick the current track, and four classes the app applies that had no CSS rule
  at all.
- **Tier 5 (8)** — numbers: no hours in a duration, .NET TimeSpans past a day
  read as hours, no TB unit, a `5.1` detector that matched "Symphony 5 1st
  Movement", a normaliser that ate letters out of album titles, two
  download-state classifiers that disagreed, and a null `eq` that silenced the
  app.

Nine further bugs turned up *while* fixing those, and are items 259–267 in
`STABILITY-250.md`. Two of them (262, 265) were defects introduced by a fix in
this round and caught before shipping; both have a test that pins the ordering
or the state they got wrong.

The audit also records what was checked and came back clean, and the three classes
of bug it structurally could not reach without the app running — which is the
argument for the CDP harness. **That argument is now the main outstanding one:
nothing here has been verified against real mpv, and three classes of bug remain
unreachable from this machine.**

## Where the catalogue stands

125 DONE, 8 OPEN, 2 CLOSED, 123 PROPOSED, plus 17 items found while working (251–267) which are
numbered from 251 so nothing renumbered.

**The 8 still OPEN, and why each one is still open** — none of them is simply unfinished:

| | |
|---|---|
| 16 | playlist-clear in setNext. The cheap half is done (setNext sends nothing when the next path is unchanged, which is the common case). The `playlist-remove` arithmetic depends on mpv's exact playlist semantics after `loadfile replace`, and getting the index wrong removes the entry that is **currently playing**. Needs real mpv. |
| 58 | 104 empty catch blocks. Not rewritten wholesale, on a stated criterion: every one found to hide a consequence the user would notice was fixed (four did). The rest guard an unlink or a stat probe. |
| 60 | Offloading the scan to a worker thread. A real architectural change, and the scan is the thing that builds the library — an incorrect worker boundary corrupts it silently. |
| 95 | History entry size. It left the shared config, so the 344 KB is no longer part of every write. Narrowing entries to filePath and ts is a decision about what history *means* — a play of a file since removed from the library would lose its name. |
| 105 | Preload surface. The half that was a defect is done (a test asserts every channel resolves to a handler). Grouping by domain is a 164-site rename for readability with no defect behind it. |
| 166 | Incremental scan. A partial merge needs a real library to verify against; getting it wrong drops albums silently, which is worse than the scan being slow. The watcher now logs the real cost so the next session can measure before designing it. |
| 178 | Library cache write. The stated solution landed with the store split. SQLite is a storage-engine change plus a migration, and the measurement justifying it does not exist yet. |
| 183 | 14,085 lines across 18 shared-global script tags. The highest-risk change in the document; see the note on that item. Four decision modules were extracted with tests instead, which is how the next one should go. |

**The 123 PROPOSED are not in that list on purpose.** They are improvements rather than defects, and a
large number of them are decisions that are yours, not mine — what to show in the now-playing line,
whether to surface the applied ReplayGain, how a notification centre should behave, whether the EQ
should be on at all (item 32 explicitly says it is your setting and only asks that the contradiction be
visible). Working through those unilaterally would be inventing product decisions, so they were left.

Two exceptions where the *bug* inside a PROPOSED item was fixed and the *design* left alone: item 126
(notices now persist in a bounded list; what a real notification centre looks like is still open) and
item 150 (the results cap now says what it is hiding and can be extended; pagination proper is not).

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

**Verified.** 635 tests pass, up from 399. The 236 new ones test behaviour, not implementation:
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

1. `npm test` — the two skipped tests should now run there. 637 passing expected.
2. Play a local album. `node tools/mpv-probe.js` should agree with the UI about path, position and pause.
3. `tools/fault-inject.sh` — SIGKILL, SIGSTOP, PipeWire restart, device suspend. It checks the daily log
   and mpv's socket automatically and prints what needs your eyes. Before this work all four were
   silent; `sigkill` must now produce a named log line, a visible Reconnecting badge, a resume at the
   same position, and one brief notice.
3b. **Check the log for the startup reports.** Three run before the window is usable and each says
   something worth reading once: the history migration (how many entries were recovered from the old
   `timestamp` key, and the date range that extends the history to), the counts-vs-history
   reconciliation (a delta is expected and is not rewritten), and the store migration (five keys
   leaving `config.json`, which should then shrink from ~2.5 MB to tens of kilobytes).
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
- **The store migration**, above. It is tested, but not against a real 2.5 MB config with real data in
  it.
- **`fs.watch` on the command file.** If the browser extension stops working, that is the first
  suspect; the 5 s backstop poll should cover it, so a total failure would mean neither path fires.
- **The `run()` helper's timeouts**: unzip 120 s, ffprobe 10 s, ps 10 s, mpv --version 5 s. All guesses.
- **The IPC deadlines.** 60 s default, with named exemptions for the endpoints that genuinely take
  longer. If something legitimate ever times out, the log names the channel and the budget, so it is a
  number to change rather than a mystery — but the exemption list was written by reading the handlers,
  not by timing them.
- **The completed-transfer purge.** It deletes from slskd. It runs only after reconciliation and skips
  anything still in flight, and there are tests for both, but the first run on a real install will
  delete around 1,451 records in passes of 60. If that is not wanted, raise `DL_PURGE_MIN_AGE_MS` or
  disable `dlPurgeSucceeded` before the first launch.
- **The download-folder fallback.** If `slskConfig.downloadDir` is empty, downloads now go to
  `<first music folder>/Papa Audio Downloads` rather than the library root. On this install the
  setting is populated, so nothing should move — but check it, because the alternative was peer-named
  folders landing in the library root.
- **The watcher depth change**, 30 to 8. A library nested deeper than artist/album/disc/CD1 would stop
  being watched below level 8. Check `find <music root> -type d -printf '%d\n' | sort -rn | head -1`.
- **Everything in Tier 6.** The same limitation as Tier 5: static assertions and unit tests on the
  extracted modules, not the running app.
- **The history migration against the real file.** Tested against a reconstruction of the reported
  shape, not against the actual 1224 entries. Back up `config.json` before the first launch if you want
  a way back — the migration itself never deletes, but that is a claim about code I could not run here.
- **The ten newly wired channels.** The tray menu, MPRIS seek/volume/shuffle/loop, and suspend/resume
  have never worked, so there is no previous behaviour to compare against. MPRIS in particular needs a
  desktop applet to test at all.
- **Everything in Tier 5.** All of it is renderer code, and the renderer cannot be loaded in a test
  here: the checks are unit tests on the extracted modules (`local-store.js`, `load-error-policy.js`)
  plus static assertions over renderer.js. The behaviour that matters — a modal opened twice not
  leaking, a stale render not repainting, the YouTube ticket discarding a late response — needs the
  real app. `test/renderer-hygiene.test.js` proves the code says what it should, not that it does what
  it should.

## What the history migration will do on first launch — read this before running it

It moves and rewrites two months of real listening data, so it is worth knowing what to expect.

- **It reports before it writes.** The log will say how many entries were already keyed on `ts`, how
  many were recovered from the old `timestamp` key, and the date range that recovery extends the
  history to. On the reported data that should be roughly 626 already fine, 598 recovered, and a range
  reaching back to 2026-06-25 instead of 2026-08-04.
- **Statistics will change substantially, and that is the fix.** Every stat drawn from history was
  reading 62% of it. Numbers going up is the migration working.
- **Nothing is deleted.** Entries with a genuinely unusable time go to `history-quarantine.json`. If
  that file appears, read it — on this data it should not, and if it does the assumption that every
  entry has a valid time was wrong somewhere.
- **The cap now archives.** Past 2000 entries the overflow goes to `history-archive/YYYY-MM.json`
  rather than being spliced away. The migration recovering the older entries is what makes this
  urgent: without it the next few plays would have started discarding real history.
- **Counts and history will still disagree, and it will say so.** Gapless auto-advance counted a play
  without recording it, so the counts are ahead. The reconciliation logs the delta and rewrites
  nothing. From now on both paths record, so new plays agree by construction — the historical gap
  stays, honestly, rather than being papered over.

## What the store split changes on disk

Worth knowing before the first launch on the real machine, because it moves data:

- Five keys leave `~/.config/papa-audio/config.json` and become their own files in the same directory:
  `library-cache.json`, `playback-state.json`, `session-state.json`, `recently-played.json`,
  `download-scheduler.json`.
- The move happens once, at startup, and only for a key whose side file does not exist yet. A second
  run cannot re-adopt a stale config value over what the app has since written — there is a test for
  exactly that, because getting it wrong would resurrect an old library cache over a fresh scan.
- The old keys are deleted from `config.json` after a successful adoption, so the file should shrink
  from ~2.5 MB to a few tens of kilobytes on first launch. **That shrink is the thing to check first.**
  If config.json is still 2.5 MB afterwards, the migration did not run and the log will say why.
- Writes are coalesced and asynchronous, and flushed synchronously on both exit paths — the signal
  handler as well as will-quit, because `app.exit()` skips handlers. If a playback position is ever
  lost across a quit, that flush is where to look.
- A corrupt side file falls back to the default and says so in the log rather than crashing, and is not
  silently overwritten.

## New modules, and why each one exists

Four pieces of logic were pulled out of the two large files so they could be tested against real
shapes rather than inferred from the code that uses them. If you extract a fifth, do it the same way —
pure logic, its own test file, and for a renderer one, registered in `test/script-globals.test.js`.

| | |
|---|---|
| `engine-diagnostics.js` | Formats the log entry that has to explain the next stop. Its own file because that text *is* the deliverable. |
| `side-store.js` | One small file per hot key, read once synchronously, written asynchronously and coalesced, replaced atomically. |
| `history.js` | The `ts`/`timestamp` migration, the counts reconciliation, and the archive split. Pure, so the migration could be tested against the reported 626-plus-598 shape. |
| `src/load-error-policy.js` | Decides what to do about a track that will not load. The invariant its tests assert: only a **confirmed** absence may mutate the queue. |
| `src/local-store.js` | The validated localStorage reader. Returns the right *shape*, not merely valid JSON. |

## The tests that guard couplings across files

Worth knowing these exist, because they are what will fail if a future change breaks a link that no
single file owns. Every one of them was written after a real bug of exactly that shape.

| | |
|---|---|
| `engine-event-wiring` | engine emits -> main forwards -> shim translates -> renderer listens, for every lifecycle event. Item 3 was an event that made it three of those four steps. |
| `ipc-channel-wiring` | Every channel main pushes has something able to receive it, with the deliberate exceptions listed and reasoned. Item 256 was eleven that did not. |
| `mpv-socket-name` | The engine generates socket names; main's reaper parses them. Item 255 was a rename that silently broke the reaper. |
| `rescan-cadence` | One cadence across main, the renderer and CLAUDE.md. Item 168 was three different answers. |
| `preload-surface` | Every preload channel resolves to a registered handler, and nothing is registered twice. |
| `packaged-build` | Every local module main.js requires is in `build.files`. Derived from main.js's own requires, so the next module cannot be forgotten. |
| `script-globals` | No two renderer scripts declare the same top-level `const`/`let`, `var` or `function`. The `var` half is item 184. |
| `main-thread-hygiene` | No synchronous child_process, no direct `webContents.send`, the hot keys never read through the shared config. |

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
