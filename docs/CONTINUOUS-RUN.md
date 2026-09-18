# Continuous run protocol — READ THIS FIRST, EVERY TURN

**Standing order from the user (2026-09-17): do not stop. Keep fixing bugs,
hunting new ones, adding features, and re-examining every tab from new angles
until he says stop, or weekly usage hits 90%.**

## The failure this file exists to prevent

On 2026-09-17 the session's context was compacted at ~10:36. After the compact
I wrote a status summary and **ended my turn instead of continuing**. Ten hours
were lost. A status report is not a stopping point. There is no stopping point.

## Rule after any compaction or interruption

1. Read this file and `OVERNIGHT-LOG.md`.
2. Do **not** write a summary message and stop. Pick the next queue item.
3. Keep at least one background subagent in flight at all times — a completing
   agent re-invokes the session, which is what keeps the loop alive.
4. Only then, if there is something worth saying, say it — after work is running.

## Hard constraints (never relaxed)

- Never touch his running app (`electron .` with no `--remote-debugging-port`).
- Every live test on a throwaway twin profile, volume 0 — built ONLY with
  `python3 tools/make-twin.py /tmp/claude-1000/twin-<name>`, which strips every
  credential and verifies none survives. A hand-copied profile carried his real
  RealDebrid token on 18 Sep and a QA click reached his account (rejected by
  luck). One twin per agent, own port; launch with `PAPA_DRY_RUN=1` once it
  lands; `--keep-slskd` only for read-only Soulseek QA and only with DRY_RUN.
- slskd at :5030 is his real account: search/browse only. No downloads, no
  cancels, no retries, no reordering, no messages, no config changes.
- Manage tab: analyses and dry-runs only. Never apply, fix, delete, reclaim.
- Never enter credentials. Never print the debrid token.
- Never `pkill -f` — it matches its own shell. Verify `/proc/PID/cmdline`.
- `cp` is interactive-aliased here; use `cat >` or python to restore files.
- `/tmp` is tmpfs (RAM). Trim twin profiles before copying.
- Push to `feature/audio-overhaul`, not `feature/papa-video`.

## Test discipline

A test that reads source as text cannot see behaviour. Every new test must
`require`/`lift` production code, and every fix must be mutation-checked:
revert the fix, confirm the test goes red, restore.
