# Papa playback plan — implementation status

**Plan:** `~/Documents/Papa-Playback-Implementation-Plan.md`
**Plan's reviewed commit:** `d0a1cd1` (15 Sep 2026)
**Branch:** `fix/m1-playback-foundation`, worktree `~/flac-player-wt-m1`
**Base:** `4c4e563` on `feature/papa-video`

## Read this first: the plan is a week stale

`d0a1cd1` is what `origin/feature/papa-video` still points at. There are **493
commits** on the local branch that were never pushed, most of them the source
switching, season and manual-pick work. The plan was written from GitHub, so it
does not see any of it. Several items it marks **Blocker** are already fixed.

Every finding below was re-checked against the code that is actually there now.

## Finding-by-finding revalidation (M1 scope)

| ID | Plan says | Verified state now | Action |
|---|---|---|---|
| F03 | Blocker — race counts one failure twice | **LIVE.** `torrent-stream.js:1292-1294` emits `'error'` *and* rejects `start()`; both wired to the race's `fail` | Fixed, `4a72e9c` |
| F06 | Blocker — debrid picks largest file in a pack | **FIXED already.** `src/debrid.js` `pickVideoFile(files, want)` matches the episode, absolute-first; `keyFor(hash, want)` keys the cache by episode too | none |
| F07 | High — pack size ÷ one episode's runtime | **STALE.** The only `capVerdict` caller (`main.js:15985`) passes `height` only, never pack bytes | none |
| F09 | Blocker — `parseRange` accepts start past EOF, no clamp | **FIXED already.** `UNSATISFIABLE` + 416, and `end` clamped | none |
| F10 | Blocker — 200 accepted for a nonzero range, relabelled 206 | **LIVE.** `_upstream` accepted any 200/206 | Fixed, `4803e93` |
| F11 | High — probe waits for both instead of first success | **LIVE.** `Promise.allSettled` under a comment claiming a race | Fixed, `9ee6531` |
| F12 | High — `serve()` blocks on 12 MiB prefill | **LIVE.** Both slurps awaited before the URL returned | Fixed, `9ee6531` |
| F13 | Blocker — `_slurp` unbounded `arrayBuffer()` | **LIVE.** | Fixed, `4803e93` |
| F14 | High — no resume from offset; stop does not abort in-flight work | **PARTLY LIVE.** Stop now bumps an epoch so a fill cannot repopulate a dead relay (`9ee6531`). Resume-from-offset **not done** | partial |
| F15 | Blocker — stale mpv exit kills its replacement | **FIXED already.** `video-engine.js:479-480` guards on captured process identity; `'disconnected'` on client identity | none |
| F16 | High — `loaded` emitted on IPC ack, not file open | **LIVE, now measurable.** The engine still emits `loaded` on the ack; both facts are now traced separately so the gap is a number, not a theory | measured, not yet changed |
| F19 | Blocker — pack episode match ignores season | **LIVE.** Two copies, both matching `f.episode` alone, over a file list that carries the season as `group` | Fixed, this commit |
| F20 | Blocker — pack select does not carry cache identity | **MOSTLY FIXED.** `video-pack-select` takes `cacheKey`/`cacheMeta` and resets `cacheSaved`/`cacheSaving` | none |
| F22 | High — renderer intents not fenced | **PARTLY FIXED** by earlier work (`_switchPending`, `manualPick` gate, play tokens) | deferred to M2 |
| F29 | High — mpv stderr drained and discarded | **LIVE.** | Fixed, `0758b04` |

Two things the plan asserts that measurement contradicts, recorded so they are
not "fixed" later by someone trusting the document:

* **F02** calls `prebufferBytes: 0` a Blocker. It is a deliberate, measured
  change — the stutter it was meant to fix was mpv's demuxer cache, now 256 MiB.
  Reinstating a 12 MiB gate would be a regression.
* The plan's own claim that it reproduced F09 no longer holds against this code.

## Completed

| Commit | What | Evidence |
|---|---|---|
| `0758b04` | Keep mpv's stderr (bounded ring, redacted, bound to the process that filled it) | 8 tests, `test/video-engine-stderr.test.js`. Mutations: drop the identity guard → 1 fail; drop redaction → 1 fail |
| `f969dee` | Trace a play the way a switch is traced; mpv stderr into the trace on engine death; `file-open` on every path | Instrumentation. No behavioural assertion claimed |
| `4a72e9c` | One lane settles once | 4 tests, `test/torrent-race-settles-once.test.js`, run against the real `_startTorrentRace` lifted from `main.js`. Mutation: remove the guard → 3 fail |
| `4803e93` | Refuse an answer that is not the range asked for; bound cached reads; cap a body at the declared length | 7 tests, `test/debrid-relay-wrong-bytes.test.js`, byte-for-byte through a real socket. 3 mutations → 1 fail each |
| `9ee6531` | Warm-up off the critical path + join an in-flight fill; first-valid-success probe with the loser aborted | 5 + 7 tests (`debrid-relay-fast-start`, `debrid-relay-probe-race`). 6 mutations → 1 fail each; the `allSettled` mutation hangs the suite |
| *pending* | Season-aware pack episode matching | 12 tests, `test/pack-next-episode-season.test.js`, file lists produced by the real `TorrentStreamer.files()`. 4 mutations → 1-7 fail each |

## Status of each claim

**Implemented and automatically verified** — everything in the table above.
Node's test runner, on this machine, with mutation checks recorded per commit.

**Manually verified** — nothing yet. No change here has been watched working in
the running app. Two corrections I made to my own work came from mutation
checks, not from the tests passing:

* I claimed a `ReferenceError` hazard in the race that turned out unreachable
  (`winner` is always null at that point, so the read short-circuits away). The
  code change stayed, the claim was withdrawn, the test that "proved" it deleted.
* A `settled = true` I added in `onReady` was redundant — the pre-existing
  `if (winner) return` already covered it. Removed.

**Blocked / not attempted** — every M2-M4 item: incremental discovery, real HTTP
source adapters, HLS, the browser engine, the module split, Electron upgrade,
clean-machine install certification, and the plan's timing gates. None is
started and none should be described as underway.

## Things measurement has not settled

* **The load-accepted → file-open gap.** 10.7 s of a 20.7 s switch on the one
  switch measured so far. Now recorded on every path, including first plays.
  Whether it is mpv or the relay serving first bytes slowly is **not known**, and
  the 12 MiB change above may have moved it. Needs a fresh trace from the app.
* **`_infoHashOfMagnet`** (`/btih:([a-fA-F0-9]{40})/i`) does not parse some
  magnets, so the memory of which sources RealDebrid has already refused records
  nothing for them and they are re-asked at full cost.
* **F16 proper.** The engine still calls an accepted command "loaded". The trace
  now separates the two facts; the state machine does not.
* **F14's resume-from-offset.** A body that breaks after the headers destroys the
  socket (deliberate — mpv sees an error at once) but does not resume.

## Next step

Merge M1 into `feature/papa-video`, push the backlog to GitHub, and get a fresh
trace from a real play and a real switch. The file-open gap is the largest
measured cost left and the 12 MiB change should have moved it — that is a
measurement, not a guess, and it is the next thing worth doing.
