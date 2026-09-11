# The Elite Experience Roadmap — search, journeys, and everything they touch

Written 2026-09-11. Sources: two architecture studies (navigation internals,
search-surface inventory), three Fable-5 usage-simulation crews (~3 hours of
instrumented live driving: music, video/anime, soulseek/chaos — 87 screenshots,
longtask + heap series), and orchestrator line-level verification of every
headline claim. Two agent overclaims were caught and corrected in that
verification (the "zombie smart playlist in the real profile" does not exist —
the crew created it in its own sandbox; taste *recording* works, only the
profile refresh crashes). Everything below is either verified in code or
reproduced live.

The through-line of every finding: **the engine is elite, the memory is not.**
Playback survived seek-spam, page-thrash and hour-long marathons with a dead-flat
20 MB heap and zero errors. But the app forgets: forgets your search when you
open a result, forgets your scroll when you come back, forgets your recents,
forgets mid-search when you dare to switch pages, and tells three different
stories about one download queue. The plan is therefore built around one idea:

> **The app should remember your journeys the way you remember them.**
> "That album I found Tuesday night, from that search, three pages deep" is one
> memory in the user's head. It should be one memory in the app.

---

## Part I — The Journey Engine (the centerpiece; W-J)

The architecture study found the parts already exist in fragments: a real
200-entry back/forward stack (`navHistory`, renderer ~199), per-query scroll
memory (`_scrollMemory`), a music search that already does query-keyed
restore correctly, three separate recent-search stores, three separate typo
engines, and five persistence stores that each know one slice of the user's
past. Nothing shares. The Journey Engine unifies them.

### J1. One navigation truth
- The video/anime search gets a navId carrying its query (exactly like the
  music search already has) plus a replayable results cache, so Back from any
  detail page restores the query, the results, the filters (type chips +
  decade), and the exact scroll offset. (Root cause verified: `renderVideo`
  emits a fresh empty input and `_renderVideoTab` actively wipes results;
  navId-less pages share one anonymous scroll slot.)
- Every "back-like" affordance routes through the history stack. Today only
  the two header arrows do; `#video-error-back`, `#vshelf-back` and friends
  hardcode `navigate('video')`. A detail page's escape hatch must mean
  "return to where I was", never "go to the tab's front page".
- **The stack survives restarts.** `sessionState` today persists one page;
  the whole navHistory (page + navId + scroll) becomes part of it, so Back
  works across an app restart and "opens on Home" stops being the default
  fate of every deep link.
- Detail pages keep the section chrome (tab bar + search field) instead of
  stripping it — the study confirmed the chrome vanishes on entry, which is
  half of why "back to my search" feels impossible.

### J2. One search memory
- A single recents store replaces the three disjoint ones (`pa_search_history`
  localStorage, `papa-lib-recent-searches`, `papaVideoRecentSearches`). Every
  entry: query, surface, timestamp, and what was opened from it.
- One commit rule everywhere: a search is remembered when it is *acted on*
  (Enter, result click) — never on debounce ticks. This kills the verified
  prefix junk ("transf", "knight of") and the verified under-capture (four
  real searches, zero recorded).
- Recents appear the same way on every surface: focus an empty box → dropdown
  of recents (relative time, per-row delete that doesn't collapse the whole
  dropdown — verified bug), plus the landing-page chips where they exist.
- Cross-surface awareness: a recent committed on the music search is offered
  on the Soulseek box and vice versa ("you searched this on YouTube — search
  Soulseek too?").

### J3. One brain behind every box
- `smart-query.js` becomes the single typo/scoring engine. Today there are
  three (smart-query, `music-tools.fuzzyFilter`, `_fuzzyFind`) plus a
  no-typo majority; the live dropdown is smart while the committed search page
  is a dumb substring — the verified "camel mirage" failure.
- Committed library search matches across fields (artist+album+title
  together), fixing the single most natural query form ("king crimson
  discipline" → found).
- Did-you-mean suggestions execute as a *structured* search (artist=X,
  album=Y), never as the literal "Artist — Album" string — the verified
  guaranteed-dead-end. Every auto-correction gets the same chip + undo the
  dropdown already has, and undo returns to *pre-correction results*, not to
  a re-search of the typo (verified dead-end on the Soulseek side).
- Debounce and keyboard behavior standardized (today: instant/150/160/180/
  250/300ms/Enter-only across nine surfaces; arrow-key result navigation
  exists on exactly two).

### J4. The Trail (the part that exists nowhere else)
A persistent, browsable timeline of journeys — sessions as stories:
- Every session records its spine: searches committed, pages dwelled on,
  things played/opened/downloaded, connected into episodes ("Tuesday night:
  searched *camel* → browsed Mirage → previewed → downloaded Moonmadness").
  Built on stores that already exist (`playHistory` has timestamps,
  `videoStore` has `updatedAt`, the new unified recents has surfaces).
- A Trail page: scroll back through your own history of *doing*, not just
  playing. Click any moment to restore it — query, results, scroll, the
  works — powered by J1's persistent stack.
- Home gets "pick up where you left off" trail cards (the session-restore
  prompt already exists for the queue; this generalizes it to journeys).
- Fully local, exportable, and erasable — it is the user's memory, not
  telemetry.

### J5. The Omnibox
Ctrl+K stops being "focus the music search" and becomes the app's front door:
one box that searches the library, Movies & TV, anime, Soulseek, YouTube,
playlists, settings panels, and commands (the command palette merges in),
with the unified recents, the one brain, and full keyboard navigation.
Result groups jump straight to the right surface with journey context intact.

### J6. Journey-aware cross-jumps
"Other sources", "Find soundtrack", artist links and their siblings currently
*replace* your context (verified: "Other sources" destroys the Soulseek
query, results, and pagination with no way back). Every cross-surface jump
parks the origin and shows a return breadcrumb ("← back to your 420
results"). Powered by J1; this is the rule that makes the app feel like it
has your back.

---

## Part II — The Repair Wave (verified breaks; W-R)

Ranked by daily pain. All verified in code or reproduced live.

1. **Taste refresh crash** — `tasteRecordPlay` is `ipcRenderer.send` (returns
   undefined); renderer chains `.catch()` on it → the app's only uncaught
   TypeError, once per qualifying track. Recording still works (verified in
   the real profile); the profile refresh and taste pills never update.
   One-line preload fix + regression test.
2. **Committed search single-field matching** + **did-you-mean dead end** —
   folded into J3 but shippable standalone if J3 waits.
3. **Live Soulseek search killed by navigation** — navigate away ≤2s into a
   search → return → false "No results" (bail path at renderer ~22652 sets
   `searched=false`, nothing resumes). Search must continue in the
   background and re-render on return; same fix family as the launch race
   (`slsk.status.connected` stale → dead fallback branch on first search).
4. **Two Soulseek connection truths** — `slsk.status.connected` vs
   `state.connectionStatus.slskd` disagree; hub can show "Connecting…"
   forever while the footer dot is green. One source of truth.
5. **Downloads page tells three stories** — "74 Active" card vs "0 ACTIVE /
   74 QUEUED" strip vs "108 waiting" header vs totals that leave 111 items
   unaccounted; "Active" label counts queued. One reconciled model, labeled
   units (albums vs files vs scheduler entries), one test per displayed
   number. Same disease on the Soulseek results header (3779 vs 4267).
6. **Mood chips dead** — Explore "How are you feeling?" filters to zero (case
   mismatch family) or dumps to an inconsistent destination. Route through
   the same normalized genre keys the Manage merge tool uses.
7. **Save-search zombie** — saved smart playlist opens as an empty regular
   playlist and its delete silently no-ops (`state.smartPlaylists` vs
   `state.playlists` routing). Fix routing + delete; migration sweep for any
   existing zombies.
8. **Modal/overlay navigation rules** — a class, not a bug: the saved-libraries
   modal, the anime numbering modal, the smart-playlist modal and the sleep
   panel all survive navigation (some with unresponsive ×); the smart-playlist
   modal ignores Esc and backdrop-click entirely. One standard: every overlay
   closes on Esc, backdrop, and navigation, unless it is a persistent drawer
   by design (queue, chat).
9. **Manage → Health lists raw hex IDs** — "Albums with missing tags" shows
   32-char hashes with no name, path, or click-through; resolve to real
   album rows with actions.
10. **OMDb title collision** — junk search entries wear the real show's IMDb
    rating and awards (verified "Reacher"). Enrichment must match on year/
    type, not title alone; junk entries (no year, no poster, ★0) rank last
    or fold away.
11. **Natural-language search chasm** — "90s korean thrillers" silently omits
    Films/Series and shows absurd anime fuzz, while Browse answers the same
    intent perfectly. Bridge the existing `PapaVideoQuery.parse` (Enter-only,
    ≥0.6 confidence today) into the live search path with an offered chip
    ("Browse: Thriller · South Korea · 1990s →"), and stop rendering fuzzy
    anime junk for clearly-parsed intent queries.
12. **Trailer failure lies** — extraction failure reported as "source timed
    out / check your connection"; in mini mode, a silent black frame stuck at
    0:00. Honest copy + surfaced error in mini mode + yt-dlp health check
    integration (the maintenance suite already knows how to update it).
13. **Continue Watching removal doesn't update the shelf** until tab re-entry;
    remove in place with the undo toast.
14. **Person page flaky fetch dead-end** — error state with no Retry while
    the second visit works; add retry + honest copy.
15. **Offline peer browse shows raw daemon error** ("slskd 404 on GET …") when
    the card already knows "Offline · 18d ago"; say that instead.
16. **Server-side search throttling reads as "No results"** — consecutive
    empty results while connected should surface a "you may be rate-limited,
    try again in a few minutes" hint instead of lying.
17. **Playlists "New folder" creates an invisible folder** (empty folders
    never render, no feedback, no delete path).
18. **Smart-queues banner stuck at "0 of 2376 (0%)"** while claiming to
    analyse (two crews hit it; label doesn't live-update or work raced
    unseen — diagnose, then make the number real).
19. **Anime outage unevenness** — "Popular Anime" shows a raw "(AniList
    request failed (403))" banner while sibling shelves fall back; This
    Season renders duplicate cards; a raw MAL "Approved" status chip leaks
    as a genre tag. Polish the fallback chain shipped this week.

---

## Part III — The Speed Wave (W-S)

Instrumented longtask evidence from the crews:

1. **Peer-library tree build blocks 2.4–2.8s** — and pays it at least twice
   per open (cached open + background refresh rebuild), 4× back-to-back
   observed (~10s cumulative). Move `buildTree`/`buildFromTree` off the main
   thread (worker) or chunk it; target <150ms blocked, bench-tested like the
   shelves work.
2. **Typing in a big peer's library: 2.4s freezes per keystroke pass**
   (101k files) — same family, same fix, plus the memoization pattern that
   took shelves from 11.1s to 2.8s.
3. **"Show 60 more" rebuilds the whole list** — 112→249ms growing linearly
   (~500ms by page 10); append instead of innerHTML rebuild.
4. **Stats page: every interaction a ~350ms freeze** (range chips measured
   344–363ms per click; Wrapped 1.2s); incremental/deferred chart rendering.
5. **Tab switches block ~200–250ms** (18 longtasks over 42 switches);
   profile the render path, defer below-fold work (the startup-deferral
   pattern from W1 applies).
6. **Context-menu "Add to playlist" freezes ~1s** (939/1066ms measured).
7. **AniList retry storm** — degraded requests every ~30s forever during the
   outage; exponential backoff with a ceiling.
8. **First-paint blanks** — following-row artist art renders as blank circles
   before filling; placeholder treatment.

---

## Part IV — The Truth & Polish Wave (W-T)

Honesty, consistency, and the details that read as care:

- **Episode pickers become episode lists** — titles, air dates, thumbnails,
  synopses (TMDB already has them; the thumbnailer exists). "Which one is
  the bathtub episode?" becomes answerable.
- **Sources show release names** — the actual torrent/release title on the
  row (fansub group, batch label), not just seeder counts; keeps the honest
  probed-resolution badge that already exists.
- **Genre chip bar uses the Manage merge normalization** — 59 raw chips for
  267 albums today, incl. "Library", "Music", and comma-joined compounds as
  single chips.
- **Pluralization sweep** ("1 albums" in folder tree + artist hero; the
  playlist folder count does it right — one helper, used everywhere).
- **Empty-state sweep** — settings filter with no matches shows a blank
  panel; the 10k-char paste echoes into the empty-state message; several
  small filters fail silently. One voice for "nothing here" everywhere.
- **Main-process input validation** — `api.slskSearch({})` throws a raw
  TypeError from main; guard IPC edges.
- **Queue panel reopen centers the current track** (lands just below the
  fold today); Prev at queue start shouldn't wrap to a random appended tail.
- **Video deck hides film-irrelevant controls** (Episodes/Next-episode shown
  for movies and trailers — the codebase's own doctrine says a control that
  cannot do anything is worse than none).
- **Decade filter parity** (search results stop at 1990s; shelves go to the
  1920s), collection ordering ("PART 1" on a sequel), "WATCHING" badge
  wording, diary delete gets undo, ratings "—" dashes below the fold,
  "Untitled" card in home shelf, global-search Movies strip card quality
  (black unlabeled rectangles, squeezed captions — bring it to Movies-tab
  standard).
- **Correction-undo family unified with J3** (chip + undo everywhere, undo
  restores, never re-searches the typo).

---

## Part V — Delivery & proof

- Order: W-R1 (taste crash) ships immediately; then W-J in slices
  (J1 nav truth → J2 memory → J3 brain → J5 omnibox → J4 Trail → J6 jumps),
  with W-R items folded into the slice that touches their surface; W-S and
  W-T run as parallel lanes behind them.
- Every slice: unit tests in the suite (3,942 green today — stays green),
  live twin verification with screenshots, and the orchestrator's personal
  gate before it counts. Perf items get bench tests with hard budgets, like
  the shelves work (<150ms).
- Known needs-user items stay tracked separately (bit-perfect listen test,
  overlay-controls visual check, HDR display, Last.fm import data,
  auto-update hosting).
- Not reached by the crews (honest debt, retest during builds): real-input
  mini-player drag, skip-marker/CC with a subtitle-bearing file, airing
  calendar surfacing (exists in src, not found in UI — investigate),
  download context menus and scheduler actions on a real queue, preview-▶
  streams on live peers, audible audio-chain checks (crossfade/EQ/gapless),
  drag-and-drop reorder, multi-select, MPRIS/tray.
