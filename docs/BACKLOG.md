# Papa Audio — the master backlog

The single list. Everything asked for, everything found, and what state it is
in. `OVERNIGHT-LOG.md` is the running account of one session; **this file is the
memory across all of them.** Read it at the start of every session and after
every context compaction.

Legend: **TODO** · **WIP** · **DONE** (commit) · **BLOCKED** (needs him)

---

## 1. Soulseek — exploration, duplicates, and the UX  (asked 17 Sep, evening)

His words: *"i love the exploration UI but the UX really sucks"*, and
*"there are a lot of functionality shortages that need proper attention and
planning."*

| # | Item | State |
|---|---|---|
| S1 | **Upgrade found → offer to remove the lower-res copy.** | DONE `f34c0e8` — nothing preselected, routed through the audited trash+undo path |
| S2 | **Shelves.** Browse a peer's library as shelves, not a flat list. | TODO |
| S3 | **Open an album and look inside it** — already shipped; the CSS said `cursor: default` so it was invisible | DONE `591c9b2` |
| S4 | Wider UX pass on the whole Soulseek tab — S2/S3 are *examples he gave*, not the whole ask. Needs a proper design pass, not point fixes. | TODO |
| S5 | Audit the tab for missing functionality and plan it deliberately. | TODO |
| S6 | **PERFORMANCE — his words: "extremely unoptimized, it slows down, stutters, lots of problems with the shelves tab".** Measured fixes, not guesses. | WIP |

**Correction, 17 Sep:** shelves are NOT new. `src/slsk-shelves.js`,
`src/slsk-tree.js` and `src/manage-redundant.js` already ship — the latter
already has `findRedundantLossy(library, shelves)`. So S1-S3 are about an
existing feature that is slow and awkward, not a green-field build. Anything
proposing to build these from scratch is re-deriving what exists.

**Hard rule on S1, no exceptions.** The slskd daemon at `localhost:5030` is his
real account and `/mnt/data/MUSIC` is his real library. Build the feature;
never fire it. Deletion must be **opt-in per item, never automatic**, must show
exactly what goes and what replaces it, and must go to the trash rather than
`unlink`. A wrong automatic delete here costs him music he may not be able to
find again.

## 2. UI/UX skills  (asked 17 Sep, evening)

*"add some UI and UX skills, do not use the anthropic ones, get the best of the
best ones from github and use them."*

| # | Item | State |
|---|---|---|
| X1 | Find the best-regarded third-party UI/UX skills on GitHub | TODO |
| X2 | Vet them before installing — a skill is instructions I will follow, so an unvetted one from a stranger's repo is untrusted input, not a library. Read what each actually says. | TODO |
| X3 | Install the good ones and use them on the Soulseek work | TODO |

## 3. Audio engine and experience — the elite campaign

### Done this run
Device loss killing the engine · ReplayGain applying 3x · gain lost on gapless
advance · the level blip at track start · non-Latin search · frozen
Stats/Trail · play counted by wall clock · retry/cancel lying · video mode not
saved · compilations shattering · queue-clear throwing · wedged slskd · corrupt
store silently emptied · false diagnostics outage · resume past track 100 ·
shuffle/repeat/speed reset · per-pixel seek · "The Beatles" under T · the fake
waveform · album list reflow · now-playing written 86,400x/day · Soulseek
section rebuilt every poll · **crossfade B1-B5** (`679ee1d`) · **the 907 KB
dead config key** (`213dc38`) · **five keys off the synchronous store**
(`08296b6`) · **the play-generation guard** (`76ad5db`)

### Open
| # | Item | State |
|---|---|---|
| C1-C5 | Quality-badge honesty | DONE `bc64410` + wiring |
| D4 | Now-playing sync re-serialises the whole queue every second | TODO |
| D5 | 350 ms from click to sound — find out what the wait actually is | TODO |
| E3 | `writeLibraryExt` does a 612 KB synchronous write on the main thread | TODO |
| F3 | Smart playlists + long-track bookmarks live in localStorage, which no backup reaches | TODO |
| F6 | Two competing crash-recovery prompts that disagree with each other | TODO |
| — | Bridge-server: stream crash, unauthenticated `/events`, sibling-path escape, + 4 more | DONE `9d511b3` (needs a bridge restart) |
| — | Close-to-tray relaunch does nothing | TODO |
| — | Two desktop notifications per track | TODO |
| — | `_findAlbumArt` is O(groups x library) | TODO |
| — | `_slskVerdicts` grows without a cap | TODO |
| — | Album-view overlay has no nav-dismiss | TODO |

### Elite features proposed, not built
Bit-perfect **proof** (`audio-out-params` + `/proc/asound`) · dynamic-range
report · fake-FLAC detection · album credits display

## 4. Test integrity

Sixty-plus test files read `main.js`/`renderer.js` as **text** and never
`require` anything. A source-text pin cannot see behaviour. Every new test
executes production code, and every fix is mutation-checked: revert it, watch
the test go red, restore.

| # | Item | State |
|---|---|---|
| T1 | The proven-broken tests | DONE `3c74a99` — 12 files, 38 bugs planted, 38 caught |
| T2 | Ranked inventory of everything still half-pinned | WIP |

## 5. Then

| # | Item | State |
|---|---|---|
| G1 | Continuous bug hunt across every tab — runs throughout, never "done" | WIP |
| G2 | Per-tab exhaustive QA — a "month" on each tab, on throwaway twins | TODO |
| G3 | RealDebrid cleanup of the ~50 entries my own testing created; dry-run logged first (approved) | TODO |

## 6. Separate from the app

The **network boost switch** (merge the Ethernet and WiFi links behind a
taskbar toggle) is fully planned in
`~/.claude/plans/make-a-plan-first-hazy-frog.md`. It needs root installs he
must run himself, so it waits for him. Worth trying first and much cheaper:
WiFi `power_save` is on and USB autosuspend is 2000 ms, the classic cause of
exactly that latency shape (4.9 ms floor, 80 ms average).

---

## Standing constraints

- Never touch his running app. Every live test on a throwaway twin, volume 0.
- slskd is his real account: **search and browse freely; never download,
  cancel, retry, reorder, message, or change its config.**
- Manage tab: analyses and dry-runs only. Never apply, fix, delete or reclaim.
- Never enter credentials. Never print the debrid token.
- Firewall/sudo commands are handed to him; never run them.
- Push to `feature/audio-overhaul`.

## 7. Bug sweep, 17 Sep — 20 confirmed findings

Found by a read-only sweep, each traced to a mechanism; the ones marked
**[executed]** were proven by running the real module, not by reading. I
re-verify each one myself before it is fixed, and one below has already
failed that re-verification.

### Tier 1 — silent data loss, or plays the wrong thing
| # | Finding | State |
|---|---|---|
| B1 | One unreadable store file wipes the whole watch history, then destroys the backup on the next launch | TODO |
| B2 | One empty reply from slskd permanently abandons the entire download queue — and refuses to re-add it, forever | DONE `da5f0f9` |
| B3 | Pack playback reads codec/audio tags as episode numbers: ask for ep 1, get ep 24 **[executed]** | TODO |
| B4 | Auto-skip intro seeks backwards forever — **NOT REPRODUCED on re-verification**, the model returned `offer`, not `auto`. Re-examine before touching. | DISPUTED |
| B5 | A dying mpv's exit event kills the mpv that replaced it | TODO |
| B6 | Restore from backup silently drops 19 settings keys, including likes, wishlist and the whole YouTube library **[executed]** | TODO |
| B7 | Play history past the 2000 cap is lost when the archive write fails, and the log claims the opposite **[executed]** | TODO |
| B8 | The download-path resolver's first guess is a bare filename in the download root **[executed]** | TODO |

### Tier 2 — destructive UI, or the app quietly does nothing
| # | Finding | State |
|---|---|---|
| B9 | Diary handlers double on every action: one click deletes a list, no confirm, no undo | TODO |
| B10 | A stuck scan permanently shrinks the saved library | TODO |
| B11 | During a crossfade, pause/seek/play act on the track being thrown away | TODO |
| B12 | Alternate-source hunt matches on filename alone — downloads a different song and calls it done | TODO |
| B13 | Space on a focused card opened it AND paused the music — **his live report** | DONE `3f9548b` |
| B14 | Notify-only wishlist entries are deleted the moment they match | TODO |
| B15 | Downloads page counts down to a retry 4-16x further away, and pins at "4/4" | TODO |

### Tier 3
| # | Finding | State |
|---|---|---|
| B16 | Backup/restore said "Could not restore" when you simply pressed Cancel | DONE `3f9548b` |
| B17 | Every ordinary quit recorded as a crash — 65 of 65 entries in his log were noise | DONE `3f9548b` |
| B18 | Five shortcuts are tested before the text-input guard | TODO |
| B19 | The assistant's download confirmation is switched off by the word "get" | TODO |
| B20 | Soulseek shop search box eats the space between words and throws the caret to the end | TODO |

Lower priority, also confirmed: seek leaks a permanent whole-tail torrent
claim; `selectFile` cancels an in-progress predownload while reporting stale
progress; a write fd leaks per superseded converter run and neither ffmpeg
spawn has an error listener; `purgeOrphanStreams` recursively deletes
unrecognised files under a configurable root; eztv never varies `page`;
`renderYtSeeAll` has no generation ticket and "Load more" is not disabled.

## 8. UI/UX skills — INSTALLED 17 Sep

Read before installing, since a skill is instructions I will follow. All
three are pure markdown with no scripts, no `allowed-tools`, no network
fetches: `ux-designer-skill` (szilu, MIT — data tables, row expansion,
search UX, information architecture), `interaction-design-skills` (rastian —
all ten component states), `ui-audit` (tommygeoco, MIT — progressive
disclosure, chunking, cognitive load).

Rejected on purpose: `pbakaus/impeccable` (68.7k stars) downloads and execs a
binary on first run and installs a persistent post-edit hook — checksum-pinned
and not malicious, but remote code execution is too much for "help me think
about this UI". `nextlevelbuilder/ui-ux-pro-max-skill` (128k stars) is a
brand-asset generator that calls paid image APIs — wrong tool entirely.

## 9. Needs him, not me

- **File modes on his machine.** `~/.config/papa-audio/bridge-token` is 644
  (world-readable, and it is the ONLY gate on the LAN bridge);
  `config.json` is 666 (world-writable). One command, his call:
  `chmod 600 ~/.config/papa-audio/bridge-token && chmod 644 ~/.config/papa-audio/config.json`
- **The bridge is a separate process** and still runs the old code. It needs a
  restart before any of `9d511b3` takes effect.
- **The app needs a restart** for the keyboard pause fix and everything since.
- The network boost switch needs root installs he runs himself (section 6).

## 10. The 17 Sep incident — agents editing his live tree

He restarted the app and found it "extreeeeeemly laggy", tabs not opening,
Movies/TV "bugged out". Cause was mine and structural, not a code bug:
**background agents were editing the very folder his app runs from.** Three
were killed mid-write when the session restarted, leaving half-finished
Soulseek files in place — 8 failing tests, unfinished code, in his running app.

Fixed: tree restored to the last green commit, every line of the partial work
preserved at `~/flac-player-wip/` (a patch plus the new test fixtures), and a
clean runnable copy for him at `~/flac-player-stable`.

**Rule from now on: agents must not edit the tree he runs from.** Either give
them a worktree, or stage their output and apply it here. A half-written file
in his folder is indistinguishable from the app being broken.

## 11. Skills — 18 installed, all read before installing

Design/UX (10): frontend-design, bencium-innovative-ux-designer, design-audit,
design-motion-principles, typography, web-interface-guidelines,
ux-designer-skill, interaction-design-skills, ui-audit, no-bullshit.

Engineering (8, added 17 Sep): **test-driven-development** and **test-guard**
(these name this repo's exact disease — "asserting that a script contains an
exact line proves only that the source is the source" — and codify the
mutation check), **systematic-debugging** and **hunt** (root cause before any
fix; hunt has a native-app-freeze mode), **clean-code-guard**,
**legacy-code** (Feathers: characterization tests and seams — the counterweight
that stops a 36k-line renderer.js being attacked head-on),
**verification-before-completion**, **electron-dev** (read-only).

Rejected after reading the actual files, not the README: `herdr-orchestration`
(instructs launching with `--dangerously-skip-permissions`), `sentry-cli`
(`curl … | bash`), `pbakaus/impeccable` (downloads and execs a binary, installs
a persistent hook), `nextlevelbuilder/ui-ux-pro-max-skill` (brand-asset
generator calling paid image APIs), `Waza/health` (reads Claude and Codex
session transcripts — out of scope). superpowers ships hooks, so only three
skill directories were copied, never the plugin.

Honest gaps: nothing credible for React Native/Expo or PyQt6. Not installing
junk to make the number bigger.

## 12. UI/UX skills, round two — 6 added (24 installed total)

Added 17 Sep after reading every file:

| Skill | Why, for THIS app |
|---|---|
| `reviewing-a11y` | Accessibility as a METHOD, not a checklist: routes by target, severity model, fixed finding format. Says "No ARIA is better than Bad ARIA" and refuses to turn missing evidence into a finding. For the player deck and the video theatre's custom transport controls. |
| `ui-craft` (core) | Dependency of the three below; carries the dashboard/table/copy reference set. |
| `ui-craft-dense-dashboard` | The closest thing that exists to dense-desktop craft, and the direct answer to the Soulseek lag: virtualize past 200 rows, sticky headers, `tabular-nums`, `scrollbar-gutter: stable`. Zero React/Tailwind in it — checked. |
| `unhappy` | A state inventory across every data surface: idle/loading/empty/error/partial/conflict/offline, and three KINDS of empty (first-run vs filtered vs cleared). Aimed at the downloads manager and Soulseek search. |
| `tokens` | Three-layer token spine in CSS custom properties, and grades dark-theme contrast with APCA rather than the WCAG ratio, which misleads on dark UI. |
| `ux-evaluate` | The emptiest gap: a real cognitive walkthrough (Motivation/Visibility/Understanding/Feedback per step) plus dark-pattern scanning. Nothing else installed walks a task. |

Skipped deliberately: `ux-writing-skill` — the installed `ux-designer-skill` already
ships 476 lines of UX writing and `ui-craft`'s `copy.md` is craftier. Installing
both would be trigger noise.

REJECTED, each verified by opening the file rather than trusting the summary:
- `Community-Access/accessibility-agents` (409 stars) — its installer writes
  three enforcement hooks into `~/.claude/settings.json`, self-registers a
  marketplace, launches a background server, offers a daily auto-updater, and
  one of its own skills normalises "Bypass Approvals — auto-approves tools
  without dialog prompts". Confirmed at `install.sh:876` and `:1032`. It also
  covers only Windows and macOS accessibility APIs — useless on Fedora.
- `AccessLint/skills` — the best methodology I read, rejected on two hard
  blockers: no LICENSE file at all, and every skill binds to `npx -y
  @accesslint/mcp@latest` (unpinned remote code, auto-confirmed).
- `a11y-specialist-skills/auditing-wcag` — the SIBLING of one we installed;
  it instructs `npx -y @a11y-skills/audit`. Took `reviewing-a11y` only.
- `nextlevelbuilder/ui-ux-pro-max-skill` — highest star count in the search;
  29 MB catalogue, `npm install -g`, and mobile-first rules (44px touch
  targets, bottom nav) for a keyboard-driven desktop app.
- `plugin87/ux-ui-agent-skills`, `tommyjepsen/awesome-ux-skills`,
  `murphytrueman/design-system-ops`, two 1-star visual-regression repos.

Gaps that stay UNFILLED, honestly: CSS architecture for a large vanilla
stylesheet (nothing exists above 2 stars — would have to be written), visual
regression (every tool drives a browser at a URL; this renderer is inside
Electron), and true desktop-app density — toolbars, multi-pane, command
palettes — where a targeted search returned literally zero results.

## 13. 18 Sep — verification pass, and what the suite could not see

He said: "check all the work we just did with opus, i am doubtful about it."
Right to be. A live twin found in sixty seconds what 5,227 green tests did not:

| Found on the twin | Cause | State |
|---|---|---|
| `ReferenceError: _playOnArrival is not defined` in renderVideoDetail, 4× on startup — **his "films I open give an error"** | assigned in 3 places, READ in 1, DECLARED nowhere; sloppy-mode read-before-assign throws. Pre-existing since 3fed78b; tonight's render guard made it visible instead of a silent skeleton | DONE `10d4662`, 10/10 films open on the twin |
| 147 `[ipc] out-of-order event` errors per page load | player-event has two listeners (renderer + shim) sharing one seq counter; every event checked twice | DONE `538aa1c`, 147 → 0 |
| 15 concurrent ffmpeg on a fresh profile | analysis concurrency = cpus−1 by design; storm only when nothing is analysed yet (fresh install / twin). First-run CPU experience, not a bug | NOTED, not fixed |

**The lesson, as a rule:** a green suite is necessary and nowhere near
sufficient. Every merge of renderer-side work gets a twin launch + CDP console
sweep before it is called done. Tests that lift a function cannot see a symbol
that was never declared, because the vm supplies what the lift forgot.

**Tooling gotcha, durable:** `Agent(isolation: "worktree")` creates the
worktree in the SESSION's repo (claude-desktop-debian), not the target repo.
All five agents noticed and made their own `flac-player-wt-*` worktrees. Brief
agents to create their own worktree of the target repo explicitly.

Adversarial reviews of tonight's merged work (test integrity, semantic
conflicts, live QA of every tab) are running; findings land here as they arrive.

### Adversarial regression review — verdict and follow-ups (18 Sep)

Verdict: **safe to run; no semantic conflicts between the five merged
branches.** Five follow-ups, all landed in one commit. The two that matter
most were MINE, and both had the same shape — a fix that shipped with green
tests and did not do what it said:

- `video-anime-episodes` honesty (f5c624b) changed nothing on screen; the
  renderer returned on an empty list either way. Now paints a note. **Lesson:
  a wire-level fix is not a fix until the pixel changes.**
- The browse fingerprint's "~11 ms" comment was an agent's number repeated,
  not measured; measured 95–183 ms on the main thread. Now backgrounded.
  **Lesson: never put a number in a comment I did not measure myself.**

Confirmed NOT breakable by the reviewer: `_pendingLoad`, `_playbackIntent`,
`_videoPlayResult` (two agents), pack `via`, `_guardVideoRenders`,
`capByBytes` keepKey, shelves frozen baseline, startup path.

Still open from the review: `test/main-load-order.test.js` is a static scan —
it would miss a circular require or `const X = obj.method()`. A real
load-in-Electron smoke test is the honest fix; the twin launch is doing that
job by hand today.

## 14. Live QA on the running app (18–19 Sep) — 9/11 pass, and a near-miss

PASS on the live twin: song click plays (280 ms), second click switches, Space
no longer pauses, 5 fast Nexts → track 7, hero Play arms playback, Specials
keeps season 0, search from Browse navigates, 240-card Soulseek library in
591 ms / max frame gap 150 ms, 40/40 cards pointer+role=button, "pink floyd"
keeps its space, filter chip repaint 13–20 ms.

**NEAR-MISS, mine:** the twin profile carried his real RealDebrid token. A QA
agent's renderer-side `window.api` stubs silently no-oped (contextBridge is
frozen), so a hero-Play click sent 12 `addMagnet` calls to RealDebrid. All
rejected (404/451) — nothing added — by luck. Rule now in memory: twins are
built with credentials stripped; side-effect blocking belongs in main.
**TODO: add `PAPA_DRY_RUN=1` to main.js** so debrid/download/keep handlers
answer `{ok:false, dryRun:true}` on a twin.

Also: four agents shared one twin and contaminated each other's results; a
native file dialog froze it. One twin per agent from now on.

### New open findings from the live run
| # | Finding | State |
|---|---|---|
| L1 | `[papa][debrid] no candidate held: linkCache is not iterable` ×10 in main log — a real crash in the debrid fallback | TODO |
| L2 | `the progress bar has not moved for Infinityms` — `Infinity` leaking into a duration format (renderer ~31491) | TODO |
| L3 | `.track-row` has no tabindex/role — songs inside an album are not keyboard-reachable; the Space fix covers 21 card classes but not these | TODO |
| L4 | On Device untestable on a twin without fixture indexes; real indexes point at his real cache paths (Delete would trash them) — needs fixture-path indexes under the twin dir | TODO |
| L5 | Backup-picker Cancel copy (3f9548b) still unverified live — the picker froze the twin | TODO |

### Skills, round 3 — installed 19 Sep
52 non-Anthropic skills now installed (see `ls ~/.claude/skills`). Round-3
adds: the superpowers planning/execution spine (brainstorming, writing-plans,
executing-plans, subagent-driven-development, dispatching-parallel-agents,
requesting/receiving-code-review, finishing-a-development-branch,
using-git-worktrees — hooks and the visual-companion server excluded);
grilling, codebase-design, writing-for-agents, handoff; refactoring,
a-philosophy-of-software-design, release-it; security-and-hardening,
api-and-interface-design, performance-optimization, git-workflow-and-
versioning, documentation-and-adrs, source-driven-development;
security-threat-model, security-audit, sharp-edges, differential-review;
avoid-ai-writing; commit-work, crafting-effective-readmes, reducing-entropy;
tech-debt-analyzer; ffmpeg-audio-processing; react-native-best-practices,
react-native-skills, electron-builder (no licence file — accepted knowingly,
as for electron-dev); expo-* leaf skills with the `npx --yes
submit-expo-feedback` footer stripped.

Skipped on purpose: expo skills whose frontmatter grants Bash (eas-simulator,
eas-update, eas-update-insights, eas-workflows, expo-examples, expo-ui),
eas-app-stores (`npm install -g eas-cli`), expo-web-to-native (`npm i -g
agent-browser`), expo-skill-feedback (telemetry), git-guardrails-claude-code
(writes settings.json), supply-chain-risk-auditor (scripts + network).

**Standing conflict, decided in his favour:** superpowers' writing-plans and
finishing-a-development-branch instruct `git commit`/`git push` inside their
loop; his `no-bullshit` rule wants an account BEFORE commits. His rule wins.

### 19 Sep — twin builder, benchmarks, skills
- `tools/make-twin.py` lands: strips every credential the app's own redactor
  knows (single source of truth), deletes the keys, verifies no key-shaped
  secret survives anywhere under the twin, writes fixture On Device indexes
  pointing inside the twin, refuses a destination outside /tmp. Built against
  his real config: 7 credential strings stripped, 0 present, library still
  245 albums. `--keep-slskd` exists for read-only Soulseek QA and writes an
  audit marker; DRY_RUN is required with it.
- Two wall-clock benches (library-index, slsk-shelves-bench) now take the
  minimum over runs; the index bench proved 0/5 failures under an 8-core load
  where the mean version failed. Remaining wall-clock ceilings: manage-bench
  (already best-of-5), slsk-shelves-chunked-bench (6× headroom by design).
- Skills: 74 installed after three rounds; whole-tree sweep shows six scripts,
  all read (Cloudflare's two JSON validators + tests, one bisection helper,
  one TS example). Two full-suite runs were killed by their own 20-minute
  timeout because four agents' suites ran concurrently — never run two full
  suites at once on this machine.

### 19 Sep — the twelve wiring holes are closed
Merged `fix/test-wiring-holes` (1e18c7d): tests only, no production change.
Each hole was reproduced first, then fixed, then shown red under its own
mutation — and I re-ran the two that matter most myself: unwiring
`_bindVideoSearch()` now fails 3 tests (was 0 of 302); letting the assistant
authorise its own download now fails 7 (was 0 of 8). Other mutations now red:
inner ok:true catch (1), `_bindDeviceEvents` unwired (2), import-all settings
skipped (3), cap bypassed at its call site (3), `_refreshInstantKeys` gutted
(3), selector attribute renamed (5), force flag dropped (2), Back losing the
navId (5), re-hide inside @media (1). The engine-death test no longer races a
timer. 5,284 pass in a clean run.

Still load-flaky and known: `manage-bench` read 741 ms against a 100 ms
ceiling with four suites contending; best-of-5 is not enough under that. The
rule stands — one full suite at a time on this machine.

In flight: L2 (Infinityms), L3 (track rows unreachable by keyboard), and the
load-order guard's two blind spots → one Opus worktree. L1 (`linkCache is not
iterable`) waits for the DRY_RUN branch, which is editing the same debrid code.

### 19 Sep — live sweep on a credential-free twin (merged tree)
Built with `tools/make-twin.py`: 0 startup console errors after reload (149
on 17 Sep), 5/5 video-detail pages painted with 0 errors, On Device renders
the 3 keep + 3 cache fixture entries with handlers bound, main log shows 0
RealDebrid calls and debrid reads as not configured in the renderer. A
fixture card-body click stayed on the page with no error — the fixtures carry
no title id to open; fixture shape to be extended so L4 can be exercised.
Full suite 5,285 / 0 on the same tree.

### 19 Sep — dry-run merged; L2/L3 merged; the "navigation race" was my probe
- `feat/dry-run-mode` merged: 25 handlers gated + one choke point in the
  RealDebrid client refusing any non-GET; 62 tests; my own re-check —
  removing the choke point turns 3 red. Two bugs it surfaced are in flight
  (`video-keep-file` TDZ makes "Keep this episode" throw on every call;
  `debrid.isCached()` iterates a non-iterable — that is L1).
- `fix/l2-l3-loadorder` merged: L2 root cause was not formatting — the shim
  reported position age = Infinity between load and mpv's first position, so
  the stall watchdog latched on EVERY track change; L3 gives `.track-row`
  tabindex/role/aria-label and routes Enter/Space to the play path; the
  load-order guard now catches `obj.method()` roots and TDZ arguments. My
  re-checks: `.track-row` out of the selector → 3 red; the original Infinity
  getter restored → see commit.
- NOT a bug: three twin runs showed no `#vrows` after `navigate('video')`.
  Cause: my probe navigated ~3–8 s after reload, before the renderer had
  defined `state` (a fresh profile spends ~20 s scanning 245 albums); the
  evaluate threw and my helper swallowed `exceptionDetails`. At t≈25 s the
  merged tree paints Movies & TV cleanly (#vrows, 8 tabs, 0 errors). Two real
  gaps found on the way: the DRY RUN pill silently does not render when
  `.titlebar-left` is absent, and the DRY RUN banner lands in no log. Both,
  plus a reusable `tools/twin-probe.js` that surfaces evaluation exceptions
  and waits for readiness, are with an executor.

## 15. Movies & TV live audit to the Netflix bar (19 Sep) — 20 defects, ranked

Two hours, ~120 interactions on a private twin (own port; it caught four
agents contaminating the shared one and moved). Blocked side effects INSIDE
the renderer's own play path, not via frozen `window.api` — nothing played,
downloaded, warmed or reached RealDebrid. Zero uncaught errors in two hours.

### Must fix — his actual complaint
| # | Finding | State |
|---|---|---|
| N1 | **A failed search is reported as an empty one and blames spelling.** 5/20 searches for famous films came back empty with `ok:true`. `video-search` folds `tmdb().search(q).catch(() => [])`; `catalog/tmdb.js` has no retry / 429 / back-off / breaker (anilist.js has all). Second shape: same query → 2 films+4 anime, then 0 films+4 anime, no warning. | executor `fix/video-search-honesty` |
| N2 | **"Continue episode N · Resume" never plays** — `_bindEpResume` selects and reloads sources, then stops. 6/6. Third Play-that-only-navigates tonight; zero tests mention the banner. | executor `fix/video-detail-honesty` |

### Should fix
N3 fixed group order Films→Series→Anime buries the match (Attack on Titan →
live-action films first) · N4 typo dead-end: spelling-retry fires only on
zero results and the anime lane never returns zero ("Intersteller" → 18
anime, 3/3) · N5 every catalogue error routed through the PLAYBACK error
table ("Try another source from the list below" on a page with no sources) ·
N6 hero My List button never reflects saved state · N7 removing from My List
leaves the card until you leave the tab · N8 poster aria-label stale after
removal.

### Worth fixing
N9 "You can undo this" — 5 s bar, hidden under a 4 s source reload, 6/6 ·
N10 quality choice sticks across titles (`_playQuality` never reset) · N11
two different sizes per source row (binary vs decimal, both labelled GB) ·
N12 Back loses scroll ~1 in 3 (restore fires before shelves fill) · N13
tablist without arrow-key behaviour · N14 hero page dots 3 px tall · N15
hovering the hero re-converts the same trailer (10× one URL) · N16 offline
banner over-promises · N17 one corrupt watch-history entry (no type/id/title)
· N18 anime pages slow (Tokyo Revengers S2 53.6 s) · N19 season shortcuts
reach only 1–9 · N20 `color-scheme: dark` undeclared; 18 px chips; hidden
poster Play buttons contradict rule #5.

### Verified PASS on the live app (nothing tonight regressed)
Hero Play 3/3 · card Play 3/3 · 18/18 detail pages no errors · render guard ·
search from Browse/Diary/Calendar · no grid leak over 15 searches · identical
node counts across 3 tab laps · Specials 9/9 · mark-season rows · dead anime
provider gone · On Device empty state · 45/45 focus stops visible, 0 traps ·
0 dead controls in 3,600 scanned · zero stuck skeletons · My List survives
reload · 0 `out-of-order` IPC errors on this build.

### At the bar already
Detail page richness (IMDb+RT+Metacritic, awards, box office, where-else-
streaming — 17/17), keyboard support, empty/error copy. Scrolling the
catalogue is the visible stutter: ~1 frame in 9 late.

### 19 Sep — keep-file and isCached merged; the complexity guard made load-proof
- `fix/keep-file-and-iscached` merged. "Keep this episode" had thrown on every
  call since it was written (a `const index` shadowing the `index` argument);
  `debrid.isCached()` had thrown on every call (`for…of` over a non-iterable
  cache) — L1 — so the instant-start shortcut never executed and every debrid
  play fell back to the swarm. My re-checks: shadowing restored → 4/4 red;
  raw-object iteration restored → 4/5 red with the exact original error.
- `slsk-shelves-complexity`'s sub-quadratic guard flaked for two executors
  (3.0×, 3.4× against a 3× bar) under concurrent suites. Interleaving the
  sizes did NOT fix it: still 5/5 failures under an 8-core busy loop
  (`mergeSourcesByAlbum` 3000→6000 = 3.0×; GC lands in the larger,
  allocation-heavy size systematically). A wall-clock ratio cannot guard this
  honestly. Its sibling guards in the same file count OPERATIONS through
  fixture getters; the ratio guards are to be converted the same way, proven
  red against the frozen pre-speedup fixtures and green under load — with an
  executor. An earlier version of this entry claimed 0/5; that was written
  before the load run finished and was wrong.

### 19 Sep — seven idle twins, the probe branch merged, L2 verified
- He asked why "so many Papa Audio sessions" were open. All seven were MY QA
  twins (ports 9377–9383, 9–24 min idle): every kill routine had targeted the
  launcher PID and never checked that Electron's children died. Killed by
  process group, verified 0 remaining; profiles and logs deleted (/tmp 1.6G →
  1.1G). Rule recorded in memory (`twin-kill-must-verify-death`) and now in
  every executor brief. His real app was untouched; he has since restarted it
  himself (new pid 870484).
- Two Claude chip sessions he was shown — "Fix debrid isCached…" and "Fix
  video-keep-file…" — duplicate fixes already merged in
  `fix/keep-file-and-iscached`; told him to close them. Chips are no longer
  spawned for work already routed to an executor.
- `feat/twin-probe-and-dryrun-visibility` merged (3 commits, +21 tests, 83/83
  in its files). `tools/twin-probe.js` prints `EVAL THREW` for every
  `exceptionDetails` and waits for `state` + sidebar before navigating — the
  harness fault that hid three renderer throws tonight. The DRY RUN badge now
  paints even without a titlebar. Real fault found on the way: `_queueLog`
  returned when `_logDir` was unset, so EVERY early-startup line was
  discarded and `installFileLogging`'s "flush what was buffered" was a no-op
  over an always-empty buffer; that is why the profile log I grepped was
  empty. My re-checks: pill early-return restored → 2 red; `!_logDir` guard
  restored → 3 red.
- L2 (stall watchdog "frozen for Infinityms") verified independently: full
  revert of 460ae17's shim hunk → 3/7 red. A partial mutation (getter to
  Infinity + load stamp removed, resume/paused stamps kept) stays 7/7 green,
  because the test's live sequence includes the optimistic `paused=false`
  stamp — the fix is layered and the test proves the layer as a whole, not
  each stamp. Good enough; noted so nobody reads a single-stamp mutation as
  the test being decoration.
- Music-tabs live QA (Fable) returned 16 defects; three critical and routed
  to two Opus executors in their own worktrees: D1 `_moodDef` is a local of
  `renderLibrary` read by `_libEmptyHtml` → ReferenceError on any zero-result
  library search, and the page stays dead because `state.libSearch` persists
  (same class as `_playOnArrival`); D2 shuffle Next stops playback ~1 in 7 —
  `playNext` reads index 0 as "queue finished" even when the shuffle picker
  chose track 0; D3 crossfade can never be enabled — Settings writes
  `crossfadeSecs`, main reads `crossfadeSeconds`, and the only writer of that
  (`player-set-crossfade`) has zero renderer call sites, so every crossfade
  fix this week was unreachable from the UI. Also D4 stop-and-clear leaves
  tray/MPRIS stale (no `syncExtension`), D5 queue rows unfocusable, D6 two
  disagreeing all-time totals on Stats, D7 Manage pre-ticks "redundant lossy"
  for Trash, D8 bit-perfect toggle changes nothing visible, D9 Next on the
  last track silently restarts the album, D10 reconciler fights fast Next (88
  "UI and mpv disagree"), D11 false offline latch ≥2 min, D12 Health scan has
  no progress for 50 s, D13 eight Settings controls with no focus ring, D14
  mute tooltip, D15 volume can't reach 0, plus 654 re-requests of missing
  artwork files. Every one gets a behavioural test and a mutation check
  before merge.
- `slsk-shelves-complexity` ratio→operation-count conversion handed to an
  executor (prove red on the frozen old modules, 5/5 green under an 8-core
  busy loop).

### 19 Sep — three more merges, each re-checked by mutation
- `fix/player-queue-critical` (11 commits, +8 test files): D2 shuffle Next
  no longer stops the music (wrap computed in the sequential branch, never
  inferred from index 0; my re-check `wrapped = nextIdx === 0` → 3/5 red);
  D9 end of queue stops ON the last track, rewinds it, says "End of queue";
  D4 `updateNowPlaying(null)` publishes (my re-check → 2 red); D10 reconciler
  skips while `loadInFlight` — found on the way that the shim's
  `_pendingLoad` was never cleared, so it meant "ever loaded"; D5 queue rows
  focusable with Enter/Space; D14 mute label; D15 slider ends snap. Open
  DESIGN DECISION: with D2 fixed, shuffle never declares the queue finished,
  so "Keep the music going"/autoplay do not fire while shuffling (before,
  they fired at random ~1 in len). Honest shuffle exhaustion needs a
  played-set; to be decided, not slipped in.
- `fix/video-detail-honesty` (7 commits): Resume never armed `_autoPlayTicket`
  so it loaded sources and played nothing (my re-check → 2 red); My List
  hero button hardcoded to "+"; `_playQuality` survived across titles (my
  re-check → 3 red); Undo bar after "Mark season watched" was buried under a
  4 s reload — reload deferred past the bar; Back-scroll restore retries
  while the page is still short.
- `test/complexity-opcount`: ratio guards → operation counts. The merge's
  hot loop never touches caller objects, so the counter borrows
  `Set.prototype.has`; frozen module probes 2,249→4,499 tokens/group as n
  doubles, live 1.0→1.0. My re-check: frozen modules → 7/8 red; 3/3 green
  under an 8-core busy loop. `buildTree` has no mutation signal (old code
  was already linear) — kept as a forward guard and labelled so.
- Both executors independently hit `SCRIPT_BYTE_CEILING` with <0.2%
  headroom; ceiling now 3,360,000 (~15% above measured). A diff3 `|||||||`
  marker survived my conflict resolution into a commit; caught by the test
  on the next run and removed in b42e5c9 — resolve conflicts with the file
  open, not a regex.
- Ten fully-merged worktrees removed; his real app restarted from his own
  desktop session at 00:40:55 (not by us) and is healthy.

### 19 Sep — why "the next episode never caches" and "delete watched" do nothing
Root-caused by a Fable research agent with executed evidence; three
load-bearing claims re-checked by grep before routing. In flight on
`fix/watch-loop-cache-ahead` (Opus executor, E4→E3→E6→E7→E1→E5→E10→E2→E8–E12).
- E1 Every caching mechanism in main (`_maybePrefetchNextEpisode`,
  `_maybeChainPackDownloads`, `_maybeCacheCurrentFile`) requires a WebTorrent
  streamer. RealDebrid — tried first whenever configured — never builds one, so
  on debrid nothing caches: not the next episode, not the current one.
- E3 `video-pack-select` never updates `_videoSession.cacheKey/cacheMeta/
  cacheSaved` (0 mentions). After ep5→ep6 inside a pack, ep6's bytes are
  either saved under ep5's name and label, or never saved at all once ep5 is.
  "Only the first episode ever ends up on the device."
- Dedupe across sources is already right: key `tv:1396:s1e5` regardless of
  source, same-key entries replaced. Keep it; the fix must not invent a second
  identity (E4 makes the key a shared module so main can compute it).
- C "Delete watched episodes" has never existed: eviction is LRU by size only;
  main never reads the watch store; `markWatched` fires on ANY Next, even at
  3 minutes. E5 adds the setting (default on), a gated handler that never
  touches the playing file, the keep library, or anything used in the last
  10 min; E10 stops early Next counting as watched.
- E2 Torrent chain starts only after the current file is 100% on disk; head
  prefetch only from mpv state (never in smooth mode). E6 pack switch updates
  the episode AFTER the strip/Up Next repaint, so "Up next" can name the episode
  now playing. E7 playing a cached file from On Device has no identity → no
  resume/progress/watched. E8 Up Next follows the page, not what is playing.
  E9 natural end never auto-advances if the countdown card never showed.
- Piece 1 of the old plan (debrid pack strip, `pickVideoFile(files, want)`,
  debrid branch of `video-pack-select`) is already on the branch; the plan
  file is stale there.

### 19 Sep — Library/Settings/Stats/Manage merged (12 commits, +17 test files)
- D1 `_libEmptyHtml` read `_moodDef`, a local of `renderLibrary` → one
  top-level `_libMoodDef()`. My re-check (read the local again) → 5/13 red.
  Generalised: `tools/scope-scan.js` (acorn) flags a top-level function
  reading a name declared only inside another; found a third live case
  (dragging one download group onto another threw `files is not defined`).
- D3 Settings now writes ONE number through `playerSetCrossfade` and reads
  `crossfadeSeconds` back; the derived-pair write is gone. My re-check
  (call removed) → 4/9 red. Every crossfade fix this week is now reachable.
- D8 bit-perfect paints the five overruled controls disabled with the reason;
  two of its promises were never enforced (loudness leveling and the +30%
  boost kept scaling volume) — enforced in `src/bit-perfect.js`.
- D6 one function for both listening totals; `playCounts` (undated, bumped
  on gapless advances) labelled as the play counter it is.
- D11 offline needs two failures, online takes one; any successful `httpsGet`
  clears it; YouTube-unavailable has a Retry.
- D7 redundant-lossy defaults unchecked; D12 Health paints cached findings
  at once with throttled scan progress; D13 focus rings on the eight shared
  Settings controls; artwork misses remembered per session (6 requests → 1).
- `test/renderer-hygiene.test.js` had been green by luck: its brace scanner
  took a quote inside a regex literal as a string start and mis-counted for
  thousands of lines. Fixed; it then found Manage → Trash's Restore button
  disabling itself with no path back. Fixed.
- FOLLOW-UPS to route: six `_artSrc` call sites in the queue/now-playing
  painters still bypass the artwork miss memory; shuffle exhaustion
  (played-set) pending his decision.

### 19 Sep — the watching loop: caching ahead, delete-watched, identity (merged)
`fix/watch-loop-cache-ahead` (7 commits, +8 test files, executor suite
5,623/0, twin pass on :9392 with 0 throws). My re-checks on the merged
branch: E1 tick branch removed → 1/16 red; E3 identity assignments removed →
2/7 red; E5 playing-file guard removed → 1/14 red.
- `src/watch-key.js` — one episode identity for renderer AND main
  (`tv:1396:s1e5`); a missing season spells `snull` on both sides (one path
  used to say `sundefined`, i.e. two names for one episode).
- Pack switch sends `{index, cacheKey, cacheMeta}`; both handler branches
  adopt it; `cacheSaved` only set when the key at copy start still matches.
- `_debridCacheAhead()` on the pack tick (now armed for debrid plays too):
  skips keys already cached (source-independent, his "don't cache the same
  episode from a different source"), runs `evictPlan` first, `.part` →
  rename → index with the right episode, one at a time, aborted on
  teardown, `if (DRY_RUN) return` before any RD call or write; pack switch
  plays the local file when the key is cached.
- `deleteWatchedCache` setting (default on) + `video-cache-sweep-watched`
  (gated; never the playing key, never anything used in the last 10 min,
  never the keep library) + "Delete watched (n)" on On Device + automatic
  pass on entering; `markWatched(key, {reason})` — only ratio/ended sweep.
- Early Next marks watched only past 50%; natural end auto-advances unless
  auto-play is off, the card was dismissed or the still-watching cap hit;
  Up Next follows what is PLAYING, not the page; torrent chain starts when
  downloaded ≥ playhead + 15% (was: 100%); head prefetch in smooth mode.
- Executor deviations accepted: E5/E8–E12 in one commit; helpers inlined
  into handler bodies so `lift-ipc` sees them; `.catch` logs instead of
  swallowing (the honesty guard flags the bare form). Not yet verified LIVE
  with a real debrid pack — that needs his account and is his call.

### 19 Sep — Movies & TV polish merged; gate 5,785/0; live sweep clean
- `fix/video-polish-n11-n20` (8 commits): N11 five providers baked a DECIMAL
  GB into `label` while the row painted BINARY — one `fmtSize` now; N13 the
  only tablists are the top tabs and the calendar toggle (no detail-page
  tablist exists) — arrow/Home/End + roving tabindex on both; N14/N20 24 px
  dot and chip targets, `color-scheme` declared, poster Play visible at rest
  (rule #5); N15 `_trailerUrlOnce` — 10 hovers → 1 conversion (my re-check:
  hero bypasses the memo → 1 red); N16 offline copy says what plays and what
  needs a connection; N17 corrupt watch-history entries dropped at READ with
  one console.error (fired once on the twin: his real history holds one such
  entry); N18 the page awaited OMDb ratings before returning — now a 4 s
  bound (my re-check → 1 red) and season-chain lane has an 8 s ceiling with
  its own Retry; N19 `0` = season 10, Shift+digit = 11–20 via `event.code`.
- Gate: 5,785/0 after one stale anchor (`hover-trailer.test.js` sliced from
  `window.api.videoTrailerUrl`, which N15 moved) was re-anchored. Live twin:
  10 pages, 0 throws, 8 tabs with exactly one tabindex=0, colour-scheme dark,
  "Delete watched" present, anime detail hero painted in 2,258 ms (audit had
  measured 53.6 s for a season-2 page; not the same title — a like-for-like
  timing is still owed).
- The twin-kill self-match trap bit ME again (exit 144) an hour after I wrote
  the rule; the comm-filtered form is now in CONTINUOUS-RUN.md and memory.

### 19 Sep — live re-test of the whole night (Fable, twin :9394): 31 PASS, 3 FAIL, 9 new
PASS live: D1–D9, D11–D15, artwork (queue), N1, N2, My List truth, quality
reset, N11 units, N14, N15 (10 hovers → memo size 1), N16, N17 (one
console.error, first boot only), N18 hero paints (Tokyo Revengers S2 47 ms vs
the audit's 53.6 s; One Piece 2.16 s), N19 keymap, N20 colour-scheme + poster
Play, E5 checkbox + "Delete watched (2)" + dry-run refusal with files intact,
E7 meta on 6/6 cards, E3 payload, boot restore onto Stats with an empty music
cache, zero out-of-order, zero ReferenceError/TypeError. NOT TESTABLE without
a TMDB key: N9 undo bar, N19 real season select.
FAIL / new, routed to `fix/retest-findings` (F1–F13): F1 My List singleton
renders as a 3,000 px poster (`_myListGridHtml` emits singletons outside any
`.vgrid`); F2 tablist arrows yank focus to the first poster (`_bindTablist`
has no `stopPropagation`; `_moveCardFocus` grabs it); F3 "Delete watched" is
styled as a 30×30 icon button and one press gives 3 snackbars; F4 Back-scroll
restores the right value then drifts as shelves above grow (2 of 3 laps);
F5 `.video-genre-chip` 17–21 px, missed by N20; F6 13 "UI and mpv disagree"
during 40 fast Nexts (D10 guard window too short); F7 stall watchdog fires
~2.5 s into a cold local play (3 s bar vs first-position lag); F8 size/seeds
printed twice per source row; F9 one Resume click → two loads → two plays;
F10 theatre error promises "the list below" with no list; `body.video-active`
sticks after Escape; F11 `#np-art` bypasses the artwork miss memory; F12 the
seasons lane hits its 8 s ceiling on every anime page (Retry took 21 s and
worked); F13 `slsk-get-transfers` throws to the renderer on slskd 401 per poll.

### 19 Sep — re-test findings fixed and merged; gate 5,848/0
`fix/retest-findings` (13 commits) merged at 6f4f1a1. My re-checks: F1
singleton run without `.vgrid` → 3/4 red; F2 `stopPropagation` removed →
1/5 red. Twin measurements from the executor: singleton card 177×363 (was
1975×3059); ArrowRight leaves focus on the next tab with 43 cards on the
page; "Delete watched (3)" 134×27, one press → one snackbar; scroll restore
holds 599/600 against a growing spacer where the old code drifted 29→980.
Also: reconciler blind until mpv speaks (1.2 s ceiling), stall grace 8 s
before the first position report, source-row stats printed once, one Resume
load per click, theatre copy no longer promises a list, `body.video-active`
cleared on Escape, `#np-art` through the miss memory, seasons lane 25 s with
a waiting note, `slsk-get-transfers` returns `{unauthorized:true}` on 401.
Two harnesses broke on the refactors and were fixed in ee745a4 (stubbed the
extracted `_paintNowPlayingArt`; fake key event gained `stopPropagation`).
Full suite 5,848/0; fresh twin sweep of 11 pages: 0 throws, 0 My List cards
outside a grid, exactly one tab stop. His app (pid 870491) untouched all
night; the build is ready for his restart. Open: shuffle exhaustion
played-set (his call); like-for-like live check of debrid cache-ahead (needs
his account); N9/N19 real-UI checks need a TMDB key on a twin.
