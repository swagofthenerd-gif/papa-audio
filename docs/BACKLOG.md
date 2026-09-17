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
