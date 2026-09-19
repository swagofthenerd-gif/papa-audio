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

### 19 Sep — live QA of the music tabs not yet audited (Fable, twin :9396)
0 renderer console entries across ~60 navigations and ~120 interactions;
paint after navigate ≤ 144 ms on every page except Trail (383 ms, 990 imgs).
Routed to two Opus executors (`fix/qa-nav-dialogs`, `fix/qa-theme-a11y`);
top claims re-checked by the lead in code before routing:
- H1 Back/Forward or restore into any `yt-*` page → skeleton then "Invalid
  artist id" with a Retry that cannot work: `_currentNavId()` has no `yt-`
  case (0 mentions), so history stores `navId:null`; `_NEEDS_NAV_ID` omits
  them too.
- H2 Playlist dialogs and the Soulseek Account modal never call
  `_registerNavDismiss` (0 calls in `_showNewPlaylistWithFolder`,
  `showSlskConfigModal`): they float over the next page, stack on
  double-click; the Soulseek modal ignores Escape.
- H3 light theme: `.cmd-palette-box` background hard-coded `#161618`
  (styles.css:5772) → Omnibox unreadable (1.1:1).
- M1 search Top-result song rows open the album instead of playing; M2
  Downloads shows "Loading…" forever beside the credentials banner; M3
  Omnibox Enter in command mode with no match runs a music search for
  `>zzqq` and remembers it (no `isCommandMode` check); M4 light-theme
  contrast (active search tab 1.3:1; accent-as-text 1.6–2.0 in six places);
  M5 two competing Resume snackbars after an unclean exit, one with the raw
  filename; M6 Trail paints 133 blank squares (bypasses the art miss memory).
- L1–L14: friends "Checking…" forever on a failed lookup; "Resume All" a
  permanent no-op; Home Customize mode sticks; wrong reason on empty
  Rediscover; stale `aria-pressed` on Like/Shuffle/Stop-after; search tabs
  without arrow keys; sub-24 px targets; clipped genre tile; Artists filter
  no-match copy; recent dropdown mouse-only; Soulseek search with empty box
  silent; empty-library Home has no CTA and Liked says "1 Local Likes / 0
  songs"; Omnibox `aria-activedescendant`; one unreproduced false "nothing
  is sounding yet".
Verified fine: Omnibox, Ctrl+1–5, Alt+←/→, F6, ?/F1, Home/Explore/Artists/
Playlists/Liked/Search/Downloads/Soulseek hub states, deck 17 controls,
onboarding wizard, 1024×640 and 2560×1440 without horizontal scroll, light
theme on the main pages, offline banner copy.

### 19 Sep — music-tab QA fixes merged; gate 6,109/0; 16-page sweep clean
- `fix/qa-theme-a11y` (10 commits) and `fix/qa-nav-dialogs` (13 commits)
  merged. My re-checks: Omnibox background back to hex → 12/16 red;
  Top-result row back to navigating → 3/10 red; `YT_NAV_PAGES` branch
  removed from `_currentNavId` → 16/26 red; New-playlist dialog no longer
  registering for nav-dismiss → 6/24 red.
- Measured live in light theme: Omnibox 1.08 → 13.9:1, active search tab
  1.25 → 15.3, Undo 1.58 → 4.96, playing queue title 1.75 → 5.49; every
  accent-as-text case ≥ 4.5 in both themes via new `--*-ink` tokens.
- Two guards tripped honestly after the merges: the global-listener budget
  (one paired Escape listener on the Soulseek modal → 25→26 / keydown cap
  12→13, recorded) and the crash-notice pin (the notice moved into
  `_offerCrashRestore`; the test now follows the delegation). Gate 6,109/0.
- Fresh twin: 16 pages, 0 throws, palette paper-coloured under
  `theme-light`, 0 stray overlays. His app (pid 870491) untouched.
- Deviations accepted: `wrapped` records its year for Back but is not in
  `_NEEDS_NAV_ID` (an id-less entry is not a dead end there); "Resume All"
  removed (slskd has no resume) and "Pause All" relabelled "Stop All".

### 19 Sep — DRY_RUN gate holes on slskd writes (found before any Soulseek live QA)
Scan of every `ipcMain.handle` body for `slskdFetch('POST'|'PUT'|'DELETE')`
without a DRY_RUN check: `slsk-download` (POST /transfers/downloads —
STARTS A REAL DOWNLOAD), `slsk-chat-send` (messages a peer),
`slsk-wishlist-run` (enqueues via `dlSched.addItems` internally, bypassing
the `slsk-enqueue-downloads` IPC gate), `slsk-search` (allowed — searching
is permitted), `slsk-setup` (DELETE; to be read). Plus the scheduler's own
tick POST, reachable from a copied `dlState` with no IPC at all. No twin has
hit these because every twin so far had slskd credentials stripped; a
`--keep-slskd` twin would have. Routed to `fix/dry-run-slskd-holes`: one
choke point in `slskdFetch` (DRY_RUN refuses non-GET except `/searches`
and whatever login needs), per-handler refusals, GATED_CHANNELS + maps,
scheduler test. Soulseek live QA waits for this merge.

### 19 Sep — slskd dry-run choke merged
`fix/dry-run-slskd-holes` (d74736a): `slskdFetch` refuses every non-GET
under `PAPA_DRY_RUN=1` except `/searches` (a real path segment); login's
raw POST `/session` and three GET `/application` probes are the only fetches
outside the choke and a tripwire test pins that list. Per-handler refusals
added on `slsk-download`, `slsk-chat-send`, `slsk-wishlist-run`,
`slsk-setup` (it rewrites slskd.yml and restarts the daemon). The scheduler
tick no longer burns a file's retry budget on a dry-run refusal — a twin
would otherwise have quietly exhausted the queue it was only meant to look
at. My re-checks: allow-list widened to `/transfers` → 7/22 red;
`slsk-download` handler refusal removed (choke intact) → 2 red on the
refusal-shape assertion. A `--keep-slskd` twin is now safe for browse-only
QA; downloads/cancels/messages are physically refused in main.
- Gate after the choke merge: 19 red in four source-scanning tests
  (`main-guards`, `tier6-hygiene`, `main-thread-hygiene`,
  `ipc-channel-wiring`) — not a regression: the choke's comment said
  "/transfers/*" and those tests strip block comments before scanning, so
  the glob opened a comment that swallowed a large stretch of main.js.
  Reworded (3254bd3); gate 6,139/0, pushed. Lesson re-learned: I pushed the
  merge BEFORE the gate this once — gate, then push, always. Comments in
  main.js must not contain a slash-star sequence.

### 19 Sep — main-process audit (Fable, read-only): 3 critical, 6 high, 9 medium, 14 low
Load-bearing claims re-checked by the lead before routing: `stalledItems`
never reads bytes/state; the bridge has 26 `store.get/set` sites on keys
that are ABSENT from his live config.json; config.json mode 666;
`purgeOrphanStreams` has no owner check; `if (!gotLock) { app.quit() }`
with module scope continuing. Routed to three Opus executors:
`fix/audit-scheduler` (C1 stall re-source cancels a live transfer; C2 two
empty snapshots abandon every in-flight song at identity level forever;
H2 same-title tracks collapse; H3 `_foldSources` has no 2% size gate —
the 5.1 scar path; H6 health monitor "restarts" nothing because slskd is
our own child; M2/M3/M4; L10/L11), `fix/audit-bridge` (C3 the phone has
been seeing an EMPTY library since the 27 Aug key retirement and
`/api/library/scan` writes 1.6 MB back into config.json — the 15 orphan
tmp files; H4 token holder can read any file, the AI keys, walk out of
ARTWORK_DIR; M7 `slskFetch` never checks `res.ok`, two Android routes do
not exist; L5), `fix/audit-engine-startup` (H1; H5 relay ends a range
short → mpv waits 30 s; M1 mpv left running on start failure; M5; M6
sync multi-GB copy on the main thread; M8; M9 twins write into HIS
crash-log; L1–L4, L6 `library.json` written by nobody's reader, L7 logger
drops the newest line, L8 no WebTorrent destroy on quit, L9
`library-restore-trashed` ungated, L13, L14).
Verified fine by the audit: IPC wiring 305↔303 with 0 orphans and 0 shape
mismatches; SideStore atomicity; quit ordering; crash flag semantics
(twins fire it only because they copy his `cleanShutdown:false`);
scheduler backoff/caps/sticky cancel; bridge range parsing and `isInside`;
mpv ticker/respawn caps; startup does no serial awaits before the window.
Main timers that never gate on visibility: dlTick 4 s (+~1 MB), presence
20 s, chat 30 s, upload 60/300 s, slskd health 60 s, connectivity 60 s.

### 19 Sep — bridge (phone) fixes merged
`fix/audit-bridge` (5 commits): the bridge reads the SideStore files
(`bridge-server/side-store-read.js`, mtime+size cached); phone mutations go
to a bridge-owned `bridge-inbox.json` replayed over the read (202 queued);
`/api/library/scan` no longer writes config.json; `/api/library/cache`
deleted. H4: `/api/folders` writes and `agent-keys` removed, `MUSIC_EXT`
on both `/stream*`, `albumId` shape-checked (Android local ids are base36,
so `^[A-Za-z0-9_-]{1,64}$`), `timingSafeEqual`, token file 0600. M7:
`slskFetch` throws on `!res.ok` → 502; `/api/slsk/transfers` flattened to
the shape the Android `Transfer` type expects (the PC downloads list on the
phone was ALWAYS empty); `/api/slsk/active-count` implemented (badge never
showed); `/api/library/delete-file` answers an honest 501 (no Electron
trash path from the bridge). L5: limiter exempts media/SSE, listen error
handler, unref'd timers, yt-dlp dedupe. My re-checks: library read from the
retired key → 1 red; `/stream` type check removed → 1 red.
FOLLOW-UPS TO ROUTE: (1) desktop ingester for `bridge-inbox.json` (spec in
the executor report: apply ops through `sideStores.*`, persist
`lastIngestedSeq`, truncate); (2) three Android-called routes still absent:
`/api/app-update`, `/api/loudness`, `/api/crash-log` (all inside try/catch
on the phone — update check, ReplayGain fetch and crash reporting are
dead); (3) two-writer risk on the non-retired keys the bridge still writes
into config.json (`likedAlbums`, `followedArtists`, `volume`, `eqSettings`,
`agentModel`, `bridgeTranscode`). HIS ACTION: `papa-bridge.service` must be
restarted to pick the fix up — his call, not ours.

### 19 Sep — download scheduler fixes merged; gate 6,228/0
`fix/audit-scheduler` (11 commits, +9 test files, `test/helpers/lift-main-fn.js`).
C1 `stalledItems(state, cfg, now, progress)`: InProgress or moving bytes is
never a stall; zero bytes never refreshes the clock. My re-check: removing
only the state layer stayed GREEN (every InProgress fixture also carried
bytes) — added a 0-byte InProgress case (3b473b4) that goes red 1/8 under
that mutation; removing both layers → 3/7 red. C2 `dlReconcileMissing`
carries `snapshotLostTrack`: empty list → re-queue via `recordStall`
(attempts kept, nobody blamed); abandonment only when slskd listed others
but not this one; `dl-empty-snapshot.test.js` no longer pins the bug (my
re-check: flag forced false → 1/10 red). H6 `stopSlskdAndWait` (TERM, 10 s,
KILL) before `startSlskd`; "restarted" logged only on a pid change. H2
`_trackNo` in the album-scoped key only (and in `songKey`, or cancelling one
"Untitled" blacklisted the rest). H3 `_foldSources` uses the exported
`sameRecordingSize` 2% rule. M2/L11 retry removes the stranded inflight;
"searching…" rows return `{added:0, searching:true}`. M3 `dispatchOutcome`
→ blame only on an HTTP status. M4 `dlNeedsSnapshot` + 60 s heartbeat (the
first version tested the predicate only and stayed green with the call site
deleted — wiring assertion added). L10 ledgers pruned/capped; refused
members leave the group ledger so albums verify.

### 19 Sep — bridge inbox ingester + the three missing phone routes merged
`feat/bridge-inbox-ingest` (2 commits): `src/bridge-inbox-ingest.js` drains
`bridge-inbox.json` through the desktop's own `sideStores.*` using the
bridge's `applyInbox` verbatim (no drift between what the phone saw and
what the desktop lands); watermark in a sibling `bridge-inbox.state.json`
written BEFORE truncation (a crash re-skips, never re-applies — play counts
are not idempotent); truncation re-reads before rename so a concurrent
append survives; first pass deferred past `retireLegacyKeys`. Two main.js
touch points only. Routes: `/api/loudness` serves the desktop's `gainDb`
from `loudness-map.json` (null when unmeasured — never an invented 0);
`/api/crash-log` appends to a bridge-owned `phone-crash-log.txt` (0600,
1 MB rotate); `/api/app-update` serves the pair `publish-apk.sh` already
writes (`version.json` + `latest.apk`; `$PAPA_BRIDGE_APK_DIR` →
`<USER_DATA>/apk/` → `~/papa-audio-android/dist/`), refusing a manifest
with no APK beside it; `/api/app-update/apk` joins the `?token=` set. My
re-checks: watermark guard removed → 3/9 red; truncation keep-set guard
weakened → 3/9 red. HIS ACTION: restart `papa-bridge.service`.

### 19 Sep — engine / startup / config hygiene merged
`fix/audit-engine-startup` (18 commits, +14 test files). H1 purge deletes
only names it made (`s-`, `thumbs-`, `warm-` + fixed dirs) inside a
`papa-video-streams` subdir (my re-check: owner guard removed → 1 red).
M8 `new Store({ configFileMode: 0o600 })` + startup sweep of
`config.json.tmp-*` older than 1 h (my re-check: option dropped → 2 red).
M5 `app.exit(0)` before any store opens; quit handlers guarded on
`gotLock`. H5 relay `res.destroy()` after headers; the shim's idle timeout
disarmed once a streaming body starts. M1 `_abandonStart` kills mpv on a
failed start. M6 async cross-device move (main-thread heartbeat test).
M9 crash log under `USER_DATA`. L1–L4, L7, L8 (`_torrentTeardown` on quit —
deliberately NOT in `_videoTeardown`, which would cancel background
downloads every time a film stops), L9 `library-restore-trashed` gated,
L10 person caches capped, L13 probe sockets discarded.
L6 FINDING: `library.json` IS read — by the legacy GNOME Shell extension
(800 ms poll), still in `gsettings enabled-extensions` though KDE is the
session. Kept; writes coalesced to a 2 s timer + async rename.
L14 not acted on (policy calls): `video-cache/`, `web-stream-cache/`,
`thumbs/`, `artwork/` unbounded on disk with no startup sweep; `backups/`
rotation unverified for the scheduled path.

### 19 Sep — post-merge twin sweep + two startup fixes
Fresh twin after the three main-process merges: starts cleanly, 12 pages
0 throws, `config.json` mode 600 on the twin. Two things seen in its
startup output and fixed (9459fa5): the banner printed twice on a terminal
launch (stdout via the patched console AND a belt-and-braces stderr copy —
one copy now; test pins exactly one), and "stream cache <dir> is not
writable; falling back to <dir>/papa-video-streams" — a false warning,
because `setStreamRoot` now answers with its own subfolder and main compared
it to the chosen dir with `!==`; fallback is now "active root not under the
chosen one". Gate 6,324/0. Note: `twin-probe` connects once — on a busy
machine give the twin ~10 s before probing (one false "ECONNREFUSED" scare).

### 19 Sep — Soulseek shop live QA (Fable, `--keep-slskd` + DRY_RUN on :9404)
The gate held: zero real downloads/cancels/messages; every write hit a
per-handler refusal (the choke's log line fires only for a raw non-GET, so
`grep "DRY RUN: refused"` read 0 — expected). Credential-bearing profile
deleted and verified. 20 defects, routed to `fix/slsk-shelves-qa` and
`fix/slsk-ui-honesty`; lead re-checked #1, #2, #4, #5 in code:
- #1 CRITICAL "Upgrades for you" offers STEREO 24/192 over his 6-channel
  24/88.2 masters (9 of 13 "upgrades" were his surround copies; Grab all
  would download them). `libAlbumToComparable` drops channels;
  `upgradeReason` never reads them (0 mentions each). The 5.1 scar, new path.
- #2 CRITICAL every download control reports success on a refused enqueue:
  `_slskEnqueue` has no branch for a plain `{ok:false}`; the "Downloading
  from N sources" snackbar fires BEFORE the await; grab-all counts any
  non-throw; the tree button prints "N queued" unconditionally.
- #3 Failed → Retry swallows `{ok:false}` and snaps to an empty tab; #4 848
  iTunes art requests in one session (438 × 429, 410 × 403), no cooldown;
  #5 old cards stay with no searching state while the spelling correction
  awaits a 6 s network lookup; #6 up to 8 parallel `POST /searches` trip
  slskd's limiter and Retry re-trips it; #7 "Disc 1"/"CD1"/"44.1" leaves
  render as separate albums; #8 "This folder is empty" beside "1.9 GB
  below"; #9 "5.1 Surround Sound" → album "1 Surround Sound" (leaks into the
  wishlist); #10 "N new files" badge with no shelf, wiped by background
  refresh; #11 raw "slskd 500" copy, offline friend gets 404 wording (the QA
  said `slskUserStatus` is missing from preload — it is there; executor to
  find the real cause); #12 copy says "Settings → Soulseek" but no such
  section exists; #13 wishlist dedupe + generic error; #14 shop focus
  management; #15–#20 a11y/labels/TB sizes/unknown `navigate` ids/copy.
- Console: `player-seek did not answer within 60000ms` ×3 unhandled during
  session-restore seeks; `[papa][ipc] missed N event(s) on slsk-progress` ×3.
Verified fine: hub 54 ms; 764-album search 4.4 s; charXX (7,635 albums,
111k tracks, 3.4 TB) shelves 10.9 s, max frame gap 75 ms; fingerprints
arrive on `slsk-browse-end` at 6k AND 218k files (the "never arrives"
hypothesis is dead); Escape mid-pull clean; cache-hit reopen 316 ms.

### 19 Sep — Soulseek shelves fixes merged
`fix/slsk-shelves-qa` (7 commits, +7 test files). #1 `upgradeReason` gates
on channels BEFORE the depth/rate ladder: surround copy + non-surround peer
→ never an upgrade; surround peer + KNOWN stereo copy → `kind:'surround'`;
unknown channels make no claim (frozen-module equivalence stays green).
My re-check: gate line removed → 5/11 red. #7 `stripLeafNoise` folds
disc/quality leaves once per group (complexity guard green). #9
`LEADING_NUM` no longer eats "5." and a surround-only leaf folds into its
parent with `surround:true`. #4 iTunes cooldown (Retry-After, else 60 s
doubling to 15 min); `{throttled:true}` marker, no `_artMisses` write on
a throttle (my re-check: arming removed → 4/7 red). #6 one token bucket for
`POST /searches` (1/1.5 s, burst 2) honouring the global throttle window;
the first mutation pass caught that deleting the CALL SITE left everything
green — a wiring assertion was added. #10 hashed folder snapshots in
`saved-users`; `newDirs` (≤200) on the browse head; background refresh no
longer rotates. #11 real cause: preload exposed `slskUserStatuses` (plural)
only — my grep hit the plural and I wrongly told the executor the singular
existed; the QA was right. `slskUserStatus` now bridged from the cached
snapshot; 5xx → "slskd could not fetch this library — try again";
`browseFailureRetryable` for the UI executor.
- Gate after the shelves merge: my own `review-followups` pin (exact cache-hit
  reply object) collided with the executor's `newDirs` contract. Adopted the
  cleaner one — always an array on the internal `_browseDirectories` reply,
  dropped at the IPC boundary when empty — and updated my pin (92f40b4).
  Gate 6,379/0, pushed. Note to self: a `&&` chain after `grep` committed
  once while a test was red; the gate caught it, but commit only after the
  test line prints `fail 0`.

### 19 Sep — Soulseek UI honesty merged; gate 6,483/0; 17-page sweep clean
`fix/slsk-ui-honesty` (13 commits): `_slskEnqueue` answers one shape and
speaks a refusal once; every caller gates on `res.ok` (results card,
shelves batch, folders/album buttons, Play spinner); Retry/Remove/Clear on
Downloads read the IPC result (the Done list had the same swallow,
unreported); `_slskBeginSearchPaint` runs before the correction await;
`#soulseek-settings` group (account, folder, sharing) makes the copy true;
folders label/size/download share one `audioBelow` walk with a confirm
above 50 files / 5 GB; wishlist dedupe via `PapaWishlist`; shop focus in/
out, album view `aria-modal`, folder rows focusable; a11y pass; `NAV_PAGES`
allow-list in `navigate()`; jump moves focus; disabled states with reasons;
indeterminate "Fetching X's file list from slskd…" before the first chunk;
`set currentTime` holds a seek until mpv answers (no unhandled rejection);
preload re-baselines the IPC sequence after a zero-listener gap so a late
subscriber is not reported as a "miss". My re-checks: `ok:false` branch
silenced → 2/11 red; pre-correction paint removed → 2/2 red.
Merge combination broke five harnesses that each branch passed alone
(`journey-nav` lifts `navigate` without `NAV_PAGES`; the Stop All row is now
three lines; the search reset moved; the jump focuses; the pull block calls
`shLoadingProgress`/`classList`). Fixed in 0515daa; gate 6,483/0; 17-page
twin sweep 0 throws, `#soulseek-settings` present, unknown page id refused.
The probe's `settings`/`queue`/`slsk` ids were never real `navigate` pages
(0 call sites) — they only ever "worked" because navigate accepted anything.

### 19 Sep — second live re-test (Fable, twin :9410 + ephemeral bridge :42539)
Every fix merged since the first re-test re-checked live: H1 Back into
`yt-artist` renders with its id; H2 dialogs close on navigation, one per
double-click, Soulseek modal closes on Escape; H3 palette 13.9:1 in light
theme; M1 Top-result row plays (queue index moves, page stays search,
aria-label present); M2–M6 PASS (one Resume prompt with the TITLE "If at
1:10 · 5 tracks"; Trail 104 gone covers → glyphs, not re-requested on
repaint); L-items PASS except friends presence; Soulseek #2 (only the
refusal text, no "Downloading from N"), #3, #5 (0 cards + "Searching…" in
0.4 ms), #12, #18, #19, #9/#7/#1 (module-level) PASS; bridge on an ephemeral
port: library from `library-cache.json`, `/api/slsk/active-count` exists
(honest 502 without creds), `/api/loudness` `{gain:null}`, `/api/app-update`
v22 manifest, `/stream?path=/etc/passwd` 403, `agent-keys` 404, a phone
like → inbox seq 1 → ingested into `liked-tracks.json` in 14 s. Console: 0
ReferenceError/TypeError, 0 out-of-order, 0 missed events, 0 seek timeouts;
banner once; no false "not writable".
NEW (routed to `fix/retest2-focus-presence`): NEW-3 the shop's `opener` is
captured AFTER focus moves to its close button, so close never restores
focus (undoes half of #14); NEW-1 `showSlskConfigModal` takes/returns no
focus; NEW-2 friends read "Checking…" forever when slskd is not logged in
(`pollPresenceOnce` resolves Unknown for everyone; L1 covered only the
rejection path) → `connected:false` → "Soulseek offline".

### 19 Sep — re-test follow-ups merged; night closed at 6,5xx/0
`fix/retest2-focus-presence` (3 commits): shop `opener` captured before the
dialog exists (my re-check: opener nulled → 3/18 red); Soulseek Account
modal focuses its username field, traps focus, restores the opener;
`pollPresenceOnce` returns `{statuses, connected}` and friends read
"Soulseek offline" when the daemon is not logged in (my re-check:
`connected` dropped from the reply → red). Gate green; pushed. Every branch
of the night merged; only `flac-player-stable` remains as a worktree.
READY FOR HIS RESTART. His actions: restart Papa Audio (he launches from
the working tree); restart `papa-bridge.service` for the phone; decide
shuffle exhaustion; try a debrid season pack and watch On Device for the
next episode arriving.

### 19 Sep — phone-side audit (Fable, read-only) vs the rewritten bridge
Lead re-checked: the phone's `downloads.tsx` flattens `directories[]`
itself, so tonight's server-side flattening of `/api/slsk/transfers` left
the On PC list empty for a NEW reason (C1 — the earlier "always empty" was
the `!res.ok` swallow, not the shape); play-history POSTs carry `playedAt`,
the desktop needs `ts`, the bridge stamps neither → phone plays quarantined
(H4). ~/papa-audio-android IS a git repo (CLAUDE.md says otherwise).
Bridge-side (no rebuild; routed after the two-writer executor lands, same
files): C1 nested passthrough + keep `/active-count`; H1 `/api/library/scan`
returns the desktop cache instead of re-parsing 3.4 TB with ids that match
nothing; H2 exempt `/api/health` from the 60/min limiter (a launch is ~12
calls + one per playlist + one per artless album → 429 → "Offline"); H4
`ts`/`playedAt` both ways; H5 liked-tracks POST as add/remove diffs (last
writer wins wipes the other device's likes); M2 `remainingTime` seconds; M5
`addresses` in `/api/health` (failover has never had candidates); L3
coalesce `playbackState.set`; L4 filter `unavailable` albums.
Phone-side (rebuild by him; routed to `fix/bridge-contract-2026-09-19` in
the Android repo): C2 opening Downloads marks every in-flight download
"Failed" (`load()` re-run on tab mount); H3 playlists deleted on the PC are
resurrected every launch; H2 art misses never remembered; M1 "Phone only"
silently keeps the PC copy; M2 `formatEta("00:01:23")` = "NaNm"; M3 502
looks like "nothing downloading"; M4 recently-played never sent; L1 PC art
path stored on local albums. Left alone: L5 swipe-away stops playback
(design), M6 MP3 transcode is unseekable (needs a transcode cache — his
call), L2 publish script JSON escaping.
