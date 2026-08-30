# Handoff — video playback is broken

## The problem

In the Movies & TV tab, **nothing plays**. Movies and anime both. Clicking a source
opens the theatre, shows "Buffering", and never starts. Earlier in the regression it
sat at "Buffering 0%" specifically.

Playback **used to work well** — instant start, mpv's own window and controls. It
broke during a stretch of changes to source discovery and torrent streaming.

## Why the previous session could not fix it

Its shell died. Child processes were killed at exec time — `/bin/echo hi > f` created
the file and died before writing a byte. So the last several edits to the playback
path were made **without being able to run anything**: no `node --check`, no tests, no
app launch. Treat every uncommitted change below as unverified.

**Do not repeat that.** Verify before editing further.

## Verify first, before changing anything

```bash
cd ~/flac-player
node --check main.js && node --check torrent-stream.js && \
node --check src/renderer.js && node --check providers/nyaa.js && \
node --check providers/quality.js && echo ALL-PARSE
npm test            # was 1427 passing at commit 6ba213e
node tools/video-doctor.js          # movie path
node tools/video-doctor.js anime    # anime path
```

`tools/video-doctor.js` already exists and walks the whole chain outside Electron:
module loading → mpv argument acceptance → source resolution → torrent connection
(with live peer/byte/speed counts) → whether mpv can open the resulting URL. It prints
PASS/FAIL per stage. **The first FAIL is the bug.**

The peer counts settle the main open question:
- peers climbing, bytes flowing → the chain works, fault is in the UI layer
- peers climbing, zero bytes → connection blocked (firewall / VPN / ISP)
- zero peers throughout → tracker or DHT problem

## Repository state

- Branch `feature/papa-video`, last commit **`6ba213e`** (verified at the time: 1427
  tests passing, app launched clean — but playback itself was never exercised).
- The user then ran, on the previous session's advice:
  `git checkout 6ba213e~1 -- torrent-stream.js main.js src/renderer.js`

So those three files are at `6ba213e~1`, everything else is at `6ba213e` or newer.

### Uncommitted, unverified changes

| File | Change | Rationale |
|---|---|---|
| `main.js` | `prebufferBytes: 0` in the `TorrentStreamer` construction | Removes a 12 MB prebuffer gate so mpv starts immediately |
| `providers/quality.js` | `PUBLIC_TRACKERS` expanded 4 → 12 | Added `http://nyaa.tracker.wf:7777/announce` and the public set TPB peers use |
| `providers/nyaa.js` | `matchesEpisode` no longer accepts season packs | Restores consistency with the reverted streamer |
| `preload.js` | `videoDubCheck`, `videoPackSelect` lines | Handlers no longer exist after the revert; harmless, nothing calls them |
| `tools/video-doctor.js` | new | The diagnostic above |

**Known inconsistency to be aware of:** the revert left `providers/nyaa.js` (new,
returns season packs) paired with `torrent-stream.js` (old, cannot select a file
inside a pack). The nyaa edit above was made to resolve that, but was never run.

## The three suspects, in order of confidence

1. **Thin tracker list.** Nyaa and apibay return only an info hash, so the magnet is
   built in `magnetFromHash()` (`providers/quality.js`). It originally carried four
   generic trackers and was missing `nyaa.tracker.wf`, which every nyaa release
   announces to. A magnet with no reachable tracker never fetches metadata — the
   `client.add()` callback never fires and playback sits there. This also explains why
   it worked before: movies used to come from YTS, whose magnets are real magnets with
   their own trackers, and only later did apibay/nyaa become the top sources.

2. **The prebuffer gate.** `TorrentStreamer` held `ready` until 12 MB had arrived,
   measured as *contiguous bytes from the file's first piece*. Until that one piece
   verifies it reads exactly 0% however much is downloading. On a large season pack
   that looks frozen. Added while trying to fix stutter — but the real fix for the
   stutter was raising mpv's demuxer cache 64 MiB → 256 MiB in the same commit, so the
   gate was redundant on top of it.

3. **Pack/streamer mismatch** from the partial revert, described above.

## Playback chain, for orientation

```
src/renderer.js  _videoPlayResult()      picks a source, opens the theatre
   → IPC 'video-play'                    main.js
   → TorrentStreamer.start()             torrent-stream.js
       client.add(magnet, cb)            metadata — hangs here if no tracker/DHT
       _onReady → pickVideoFile          chooses the file
       createServer + listen             local HTTP server
       _awaitPrebuffer                   the gate (now disabled)
       emit 'ready' { url }
   → VideoEngine.start(url, { wid:null }) video-engine.js — mpv in its own window
   → 'video-event' { kind:'playing' }     back to the renderer
```

mpv is spawned with no `--wid`, so it manages its own window. `video-engine.js` was
verified to spawn correctly with its full argument set.

## Repo conventions

Electron 28, CommonJS, no build step, no framework. Tests are `node:test` in `test/`,
run with `npm test`. Providers never throw; a total failure returns `[]`. Async UI uses
ticket guards so a stale response cannot overwrite newer state. Full context in
`docs/papa-video-plan.md` and `docs/papa-video-handoff.md`.

## The goal

Playback that starts promptly for movies and anime, as it did before. Once it works,
the dub and season-pack support can be reinstated properly — that work is in commit
`6ba213e` and needs the streamer to select a file inside a pack by name, which is the
half that was missing when it was reverted.
