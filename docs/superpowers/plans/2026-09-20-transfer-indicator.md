# Sidebar Transfer Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live pills on the left tab bar showing files downloading in (`↓ 3 +12`) and files peers are taking out (`↑ 2` / "14 today"), with a slide-over Sharing panel listing who is taking what.

**Architecture:** One new pure module `src/transfer-indicator.js` (pill text + sharing rows from snapshots, node-tested), one renderer wiring block riding the EXISTING download poll, one small extension to the existing `slsk-upload-stats` handler to return current upload rows, and a Sharing panel using the queue-panel slide-over pattern. No new timers.

**Tech Stack:** Electron main + plain-script renderer (shared global scope, IIFE modules), `node --test`, slskd `/transfers/uploads`.

**Spec:** `docs/superpowers/specs/2026-09-20-transfer-indicator-design.md`

## Global Constraints

- Work in a fresh git worktree off `feature/papa-video`; never touch the main checkout until merge.
- IIFE wrapper, one `window.PapaTransferIndicator` global + `module.exports`; extend `test/slsk-renderer-scope.test.js`'s file list.
- No new polling timers: downloads ride `_dlPollTimer`'s existing tick (renderer ~line 28992); uploads ride main's `slskUploadPollOnce` (60 s active / 5 min idle).
- Peer names and file names are peer-controlled: everything escapes through `esc`.
- Pill text carries meaning without colour alone.
- Every IPC failure returns `{ ok:false, reason:'<plain sentence>' }`.
- Full suite green before every commit (81 pre-existing bridge-server failures in a worktree without express are the only allowed failures).
- Mutation-check every new pure test. Commits: plain-sentence subject + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Pure model (`src/transfer-indicator.js`)

**Files:** Create `src/transfer-indicator.js`; Test `test/transfer-indicator.test.js`.

**Interfaces — Produces:**
- `downloadPill(transfers) → { text, active, queued } | null` — `transfers` is the `_slskTransfers`-normalised array the poll already builds (users → directories → files with `state`). Active = state matches `InProgress|Initializing`; queued = `Queued`. null when both are 0 (pill hidden). Text: `↓ 3`, or `↓ 3 +12` when queued > 0, or `↓ +12` when only queued.
- `sharingPill(stats) → { text, live } | null` — from `{ activeUploads, totalUploadedToday, distinctPeersToday }`. Live (`↑ 2`) when activeUploads > 0; idle (`14 today`, live:false) when totalUploadedToday > 0; null when both 0 (row hidden).
- `sharingRows(uploads) → [{ username, file, folder, pct, speed, state }]` — from raw slskd upload rows (`filename, username, state, percentComplete, averageSpeed`); folder = parent folder basename; sorted live-first then by username.
- `todayLine(stats) → string` — `"14 files to 3 people today · 2.1 GB"` (0 → `"Nothing shared today yet."`).

- [ ] Step 1: write failing tests covering: pill hidden at zero; active-only, queued-only, both; sharingPill live/idle/null; sharingRows sorting + folder extraction from a backslash path; todayLine plural/zero forms.
- [ ] Step 2: run red (`node --test test/transfer-indicator.test.js`).
- [ ] Step 3: implement (IIFE; pure; no window reads inside functions).
- [ ] Step 4: run green; mutation-check (flip the queued suffix rule; red; restore).
- [ ] Step 5: commit.

### Task 2: Upload rows over IPC

**Files:** Modify `main.js` (`slsk-upload-stats` handler ~line 9414 and `slskUploadPollOnce` ~9365); `preload.js` unchanged (same channel). Test `test/transfer-indicator-ipc.test.js`.

- `slskUploadPollOnce` already fetches the uploads array; keep the latest raw rows in a module-level `_lastUploadRows` (filename, username, state, percentComplete, averageSpeed only — strip the rest) and include `rows: _lastUploadRows` in the handler's success return. Unreachable-daemon path returns `rows: []` with the rolled counters as today.
- Text-level tests: handler returns rows; the slimming keeps only the five fields; failure path keeps `ok` shape.
- [ ] Steps: red → implement → green → commit.

### Task 3: Sidebar pills + wiring

**Files:** Modify `src/index.html` (pill spans inside `#nav-downloads`; new `<li class="nav-item" data-page="sharing" id="nav-sharing" hidden>` after it); `src/renderer.js` (inside the existing download-poll callback, call `PapaTransferIndicator.downloadPill` and paint `#nav-dl-pill`; a 60 s sharing refresh that calls `slskUploadStats()` ONLY to reuse main's cached poll — check `slskUploadPollOnce`'s throttling so this does not force extra slskd traffic, and if it would, add a `cached:true` arg that returns `_lastUploadRows` without polling); `src/styles.css` (pill styles, both themes). Test: extend `test/transfer-indicator-ipc.test.js` with text-level wiring assertions (pill painted from the poll path; `#nav-sharing` unhidden only when sharingPill non-null).
- Clicking `#nav-sharing` opens the panel (Task 4), not a page navigation — mark it `data-noroute` and handle in the sidebar click handler beside the existing special items.
- [ ] Steps: red wiring test → implement → green → commit.

### Task 4: Sharing panel

**Files:** Create panel markup in `src/index.html` next to `#queue-panel` (same slide-over classes, id `#sharing-panel`); renderer block `_openSharingPanel()` in `src/renderer.js`: fetch `slskUploadStats()`, render `sharingRows` + `todayLine`, refresh every 10 s while open, stop on close; peer name is a button calling `showSlskUserExplorer(username)`. Escape closes. Empty state per spec. All strings escaped.
- Test: text-level — panel exists, rows come from `PapaTransferIndicator.sharingRows`, peer button routes to the explorer, refresh interval cleared on close.
- [ ] Steps: red → implement → green → commit.

### Task 5: Scope test, docs, live twin

- Extend `test/slsk-renderer-scope.test.js` with `transfer-indicator.js`.
- Add a short `docs/transfer-indicator.md` (one paragraph per surface).
- Live twin (credential-stripped, ONE twin, kill by `/proc/PID/environ` match and print the 0 count): seed a fake transfers snapshot through the poll seam and fake upload rows via a stubbed handler; verify pills, the Sharing row appearing/hiding, the panel, and zero console exceptions. Screenshots for the account.
- [ ] Steps: implement → full suite → live pass → commit.

## Self-review

Spec coverage: pills (T1/T3), sharing detail (T1/T2/T4), no-new-pollers honored (T2/T3), empty states (T1 todayLine, T4), peer-name → explorer (T4), tests+twin (all/T5). No placeholders. Interfaces named consistently (`PapaTransferIndicator`, `slskUploadStats().rows`).
