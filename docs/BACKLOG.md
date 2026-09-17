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
| S1 | **Upgrade found → offer to remove the lower-res copy.** Today an upgrade downloads alongside the old file and both sit in the same album, so the album shows duplicate tracks. Detect that the new file supersedes an existing one and offer removal. | TODO |
| S2 | **Shelves.** Browse a peer's library as shelves, not a flat list. | TODO |
| S3 | **Open an album and look inside it** from the browse view. | TODO |
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
| C1-C5 | Quality-badge honesty — fixed in modules, **wiring not yet applied** | WIP |
| D4 | Now-playing sync re-serialises the whole queue every second | TODO |
| D5 | 350 ms from click to sound — find out what the wait actually is | TODO |
| E3 | `writeLibraryExt` does a 612 KB synchronous write on the main thread | TODO |
| F3 | Smart playlists + long-track bookmarks live in localStorage, which no backup reaches | TODO |
| F6 | Two competing crash-recovery prompts that disagree with each other | TODO |
| — | Bridge-server: stream crash, unauthenticated `/events`, prefix-match path escape | WIP |
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
| T1 | The five proven-broken tests (`failure-honesty` `norm()`, `session-restore` `windowFor`, analysis banner, credits-skip tautology, slskd throttle) | WIP |
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
| B2 | One empty reply from slskd permanently abandons the entire download queue — and refuses to re-add it, forever | TODO |
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
