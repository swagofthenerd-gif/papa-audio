# Sidebar transfer indicator — design

Date: 2026-09-20. Approved direction: BOTH directions (incoming downloads and
people taking from the user's shared library) on the left tab bar, expandable
into detail.

## Goal

The left sidebar always shows, at a glance, what is moving: how many files
are coming IN (your downloads) and how many are going OUT (peers taking from
your library). Clicking through gives the detail: which files, which peers,
progress, speed.

## What exists already (reuse, don't rebuild)

- Downloads: the renderer polls `slsk-get-transfers` every 6 s (adaptive,
  `_dlPollTimer` around src/renderer.js:28992) and the Downloads page renders
  the full list. The indicator must ride this existing poll — no new timer.
- Uploads: main polls `/transfers/uploads` (60 s active / 5 min idle) and
  `slsk-upload-stats` returns `{ activeUploads, totalUploadedToday,
  distinctPeersToday }`. For the detail view it must also expose the
  current upload rows (filename, username, state, progress) — a small
  extension of the existing handler, not a new poller.
- There is no existing sidebar badge system; this creates the first one, as
  a small reusable pattern.

## The indicator (tab bar)

- Lives on the existing Downloads nav item (`#nav-downloads`) plus a new
  sibling row "Sharing" that appears ONLY while at least one upload is
  active or someone took a file today.
- Downloads item gains a pill: `↓ 3` = three files actively downloading
  (queued files show as `↓ 3 +12` when something is queued behind). Hidden
  when nothing is moving.
- Sharing item shows `↑ 2` while peers are pulling files, and when idle
  shows the day's tally as a muted count ("14 today"). Clicking it opens the
  sharing detail panel.
- Pills update from the existing polls; no click needed. Colours use the
  app's accent for downloads and a neutral ink for uploads, never red/green
  alone (colour-blind safe, text carries the meaning).

## The detail views

- Downloads detail is the existing Downloads page — unchanged, the pill is
  just a live signpost to it.
- Sharing detail is a new lightweight panel (same slide-over pattern as the
  queue panel): a row per active upload — peer name, file name (album folder
  shown small), progress bar, speed — and under it "Today": N files to M
  people, total size. A peer name links to their library page (the new
  Listening Room), because someone taking your files is often worth
  browsing back.
- Empty state: "Nobody is taking anything right now. N files went to M
  people today." — never a blank panel.

## Non-goals

- No notifications/toasts on new uploads (can be a later opt-in).
- No per-peer bandwidth controls here (slskd owns that).
- No history beyond "today" (the daily counters already reset at midnight;
  history is a separate feature if ever wanted).

## Testing

- Pure model: pill text from a transfers snapshot (active/queued counts,
  hidden states) and sharing rows from an uploads snapshot — node tests,
  mutation-checked.
- Wiring tests: the sidebar rows exist, the pill updates from the poll path,
  the Sharing row hides when idle-and-zero.
- Live twin pass: seed fake transfer snapshots through the poll seam, verify
  pills and panel render, zero console errors.
