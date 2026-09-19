# The quit hang — what is known, and what is not

**Status: contained, not root-caused.** Last updated 2026-09-19.

## Symptom

The main process stays alive after its window is gone, spinning a full core,
and never exits. Observed twice in one evening:

| pid | started | seen | cpu | window | slskd child |
|---|---|---|---|---|---|
| 52678 | 13:39 | 19:25 (5h34m later) | 76% | none | zombie |
| 157781 | 19:37 | 19:42 | 54% | none | zombie |

Two knock-on effects, both observed:

- the `slskd` child stays a zombie — the process never gets back to reaping it;
- **a second full copy of the app can start.** Electron releases the
  single-instance lock early in shutdown, so a process that never *finishes*
  shutting down leaves the lock free.

## Evidence

`eu-stack -p <pid>`, sampled repeatedly, always inside `node::FreeEnvironment`
with different work above it:

```
#1  v8::internal::MessageHandler::ReportMessage(...)
#2  v8::internal::Isolate::ReportPendingMessages()
...
#3  node::FreeEnvironment(node::Environment*)
```
```
#2  v8::internal::Isolate::ThrowInternal(...)
#1  v8::internal::DebuggableStackFrameIterator::...
```
```
#1  v8::internal::Isolate::OptionalRescheduleException(bool)
```

So: JavaScript exceptions are being thrown and reported, over and over, while
V8 dismantles the isolate. It is a loop, not a single stuck call — the frames
above `FreeEnvironment` differ between samples while `FreeEnvironment` stays.

The app's own log names the state the first one was in: the network went
offline at 14:18:04 and back at 14:19:04 while YouTube was streaming, leaving a
pile of in-flight fetches. That session's last log line is 14:19:04.

## Hypotheses tried, and why each was discarded

1. **The global `unhandledRejection` / `uncaughtException` handlers do real
   work (a console write, a synchronous crash-log append), and Node settles
   pending promises as it frees the environment.** Both handlers were made to
   stand down once teardown starts (commit 7741932). **Discarded:** pid 157781
   started *after* that fix and hung identically.
2. **A plain quit is enough to trigger it.** Reproduced in a throwaway profile
   (`PAPA_USER_DATA`, which scopes the single-instance lock — see main.js) and
   quit over MPRIS. **Discarded:** exits cleanly in 1–2 s.
3. **The live `slskd` child is required — its `exit` callback fires inside a
   dying environment.** Tried to give the twin its own slskd on port 5031.
   **Not tested:** `SLSKD_BASE` hardcodes `localhost:5030`, so the twin found
   the *real* daemon answering, took the "already running externally" branch,
   and never spawned a child. Still open, and still the best candidate — every
   hang so far had a zombie slskd.

## What is contained

`_armQuitWatchdog()` in `will-quit` spawns a detached `/bin/sh` that sleeps 8 s
and then `kill -9`s us **if we are still alive and still this app** (it reads
`/proc/<pid>/cmdline` first, so a recycled pid is never signalled). By the time
`will-quit` runs, every flush has already happened, so there is nothing left
worth waiting for.

This is deliberately outside the process: the loop is past the point where the
event loop still turns, so a JavaScript timer armed in `will-quit` would never
fire. `shutdownFromSignal` needs no watchdog — it already ends in an
unconditional `app.exit(0)` with a `process.exit(0)` backstop, which is very
likely why a signal shutdown has never produced one of these.

## How to pick this up again

The next reproduction attempt should make `SLSKD_BASE` respect the profile (or
stop the real daemon first) so a twin can own a real slskd child, then quit it
while a download is in flight and the network is being flapped. If it hangs,
attach with `gdb -p <pid>` rather than `eu-stack` — the frames directly above
`FreeEnvironment` are unresolved addresses in the eu-stack output and those are
the ones that name the cleanup hook actually running.
