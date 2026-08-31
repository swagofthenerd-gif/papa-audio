# Papa Cinema — turning the Movies & TV tab into a cinephile's app

> Written 2026-08-31 against the running app on branch `feature/papa-video`.
> Companion page (design direction, readable): published artifact "The Projection Booth".
> Everything in §2 was verified against the live APIs before being proposed.

---

## 1. The audit

The home tab renders seven shelves from `_videoRows` (`src/renderer.js` ~line 1940):

```
trending-movies, popular-movies, trending-tv, popular-tv,
trending-anime, popular-anime, season-anime
```

Plus two personal rows from `_personalRows()`: Continue Watching, My List.

Observed by driving the real app and photographing it:

| Finding | Evidence |
|---|---|
| Six of seven shelves ask "what is popular now" | The row list above |
| Titles repeat across rows | Spider-Man, The Odyssey in both movie rows; Lanterns, Silo, Reacher in both TV rows |
| Nothing predates the current year | Every visible card on first load was 2026 |
| The hero is not curated | `_startVideoHero(items)` is called with `wanted[0]`'s results — the first trending row |
| Non-film content ranks | *Tagesschau* (a daily German news bulletin, TMDB tv/1952) sits in Popular TV |
| Cards carry a score, a type tag and a year | `_videoCard()` — no director, runtime, certificate or second rating |
| Cast renders as initials, not faces | Detail page cast row shows letter avatars |

**The catalogue is far richer than the surface.** Everything in §2 already exists behind the keys the app holds.

---

## 2. Verified capability (do not re-litigate)

Checked live on 2026-08-31 with the user's own keys.

### TMDB

| Capability | Query | Result observed |
|---|---|---|
| Canon by rating with a vote floor | `discover/movie?sort_by=vote_average.desc&vote_count.gte=5000` | Shawshank 8.729, Godfather 8.686, Godfather II 8.573 |
| Decade | `discover/movie?primary_release_date.gte=1970-01-01&primary_release_date.lte=1979-12-31&sort_by=vote_average.desc&vote_count.gte=1000` | Godfather, Godfather II, Cuckoo's Nest, Apocalypse Now |
| Keyword search | `search/keyword?query=neo-noir` | id 207268 |
| By keyword | `discover/movie?with_keywords=207268&sort_by=vote_average.desc&vote_count.gte=500` | Dark Knight, Pulp Fiction, Se7en, Silence of the Lambs — 140 total |
| Director filmography | `search/person` → `discover/movie?with_crew=<id>` | Kurosawa id resolved, 112 titles (**needs a `vote_count.gte` floor** — raw order surfaces obscure early work) |
| Crew, keywords, certificate, images | `movie/238?append_to_response=credits,keywords,release_dates,images` | Director "Francis Ford Coppola"; keywords `based on novel or book, gangster, italy, symbolism…`; US cert `R`; runtime 175; collection "The Godfather Collection"; **152 backdrops, 84 logos** |

### OMDb

Key lives in settings (`videoSettings.omdbApiKey`), never hardcoded.

`http://www.omdbapi.com/?i=tt0068646&apikey=…` returns:

```
imdbRating 9.2 · imdbVotes 2,222,804 · Metascore 100
Ratings: [IMDb 9.2/10, Rotten Tomatoes 97%, Metacritic 100/100]
Rated R · Runtime 175 min · BoxOffice $136,381,073
Awards "Won 3 Oscars. 31 wins & 31 nominations total"
```

Also resolves by title (`?t=Seven+Samurai`). Bad ids return `{"Response":"False","Error":…}` — not an HTTP error, so **check `Response` not just status**.

**Known limit:** OMDb is keyed on IMDb ids. Coverage is strong for film and television, patchy for anime.

---

## 3. Design direction

Film gets its own identity inside the app; it should not wear the music player's clothes.

| Token | Value | Use |
|---|---|---|
| ground | `#0B0B0C` | page |
| surface | `#141416` | cards, panels |
| raised | `#1B1B1E` | hover, menus |
| line | `#26262A` | borders |
| bone | `#EDE8E0` | primary text |
| bone-2 | `#B4ADA3` | secondary text |
| muted | `#7C766D` | labels |
| ember | `#E9A13B` | the single accent — projector light |
| rec | `#D8453F` | live/destructive only |

Type: **Bodoni Moda** (display — titles, headings), **Archivo** (body), **IBM Plex Mono** (numbers, labels). Google Fonts.

Three rules:
1. **The poster is the interface** — chrome gets out of its way.
2. **Every shelf says why it exists** — a curatorial line under each heading. A row called "Trending" explains nothing.
3. **Heroes use the film's own title art** (`images.logos`), not the title set in the app's font.

---

## 4. The forty-one

### Curation (01–15)
1. **The Canon** — rating desc, `vote_count.gte` floor.
2. **Decade shelves** — 1950s→2020s, ranked within decade.
3. **Director in focus** — rotating; portrait, ranked filmography, one line of context.
4. **Movements** — French New Wave, New Hollywood, Italian Neorealism, Dogme 95, Japanese Golden Age (keyword + year window).
5. **Thematic shelves** — neo-noir, heist, one-location, coming-of-age, unreliable narrator (keywords).
6. **National cinema** — `with_original_language` + region.
7. **Studio shelves** — `with_companies` (A24 2, Ghibli 10342, Pixar 3…).
8. **Hidden gems** — high rating, `vote_count` between a low floor and a low ceiling.
9. **Anniversaries** — released this week, N years ago.
10. **Runtime shelves** — `with_runtime.lte=90`, `with_runtime.gte=180`.
11. **Awards** — Best Picture keyword/list, plus OMDb `Awards` on the detail.
12. **Franchises in order** — `belongs_to_collection` → collection parts, release order, watched state.
13. **Coming soon** — release calendar.
14. **De-duplication** — a title appears once per page; the shelf with the better claim keeps it.
15. **Quality filter** — drop news/talk/sports genres from film shelves.

### Depth (16–25)
16. Director on the card. 17. Runtime on the card. 18. IMDb + RT + Metacritic. 19. Awards line.
20. Certificate. 21. Cast with photographs. 22. Crew (DP, composer, editor, writer).
23. Title-logo heroes. 24. Thematic "more like this" (shared keywords/crew, not genre).
25. Where else to watch (`watch/providers`).

### Taste (26–35)
26. Rate (half stars). 27. Diary with rewatches. 28. Notes. 29. Mark watched without playing.
30. Four favourites. 31. Own lists (ordered, annotated). 32. Taste profile (directors/decades/countries/languages).
33. Year in review. 34. Recommendations from taste. 35. Hide what you've seen.

### Movement (36–41)
36. See-all grids. 37. Sort anywhere. 38. Keyboard throughout. 39. Trailer on hover.
40. Search that parses ("kurosawa", "1970s thrillers", "under 90 minutes"). 41. Jump back in.

---

## 5. Phases

Each ends green (`npm test`), launching clean, and committed.

**Status, 2026-08-31: all seven done.** All forty-one features have an
implementation, verified by auditing the code rather than reading this table —
which is how three features with no implementation at all, and a fifth
built-but-never-called module, were found after the table already said "done".

| # | Pass | Files |
|---|---|---|
| 1 | **Foundations** — OMDb client, richer TMDB detail, keyword/crew/discover helpers, the taste store | `catalog/omdb.js`, `catalog/tmdb.js`, `main.js`, `preload.js`, `src/video-store.js` |
| 2 | **Identity** — tokens, type, card rebuilt (director/runtime/ratings), logo hero | `src/styles.css`, `src/renderer.js`, `src/index.html` |
| 3 | **Curation** — shelves 01–15, with de-dup and the quality filter | `catalog/shelves.js` (new), `main.js`, `src/renderer.js` |
| 4 | **Depth** — cast photos, crew, awards, certs, thematic similar, collections | `src/renderer.js`, `catalog/tmdb.js` |
| 5 | **Taste** — ratings, diary, notes, lists, favourites, profile, year in review | `src/video-store.js`, `src/renderer.js` |
| 6 | **Movement** — see-all, sort, keyboard, hover trailers, parsed search | `src/renderer.js`, `src/video-keymap.js` |
| 7 | **The soak** — long unattended run, leak hunt | `tools/video-soak.js` (new) |

### What the phases did not catch, and what did

Five modules in this project were written, tested, exported and reachable by
nothing: `taste-store.js`, `taste-panel.js`, `video-query.js`,
`video-keymap.js` (reachable, as it turned out, but only from the player) and
`shelves.directorInFocus`. Two more, `ttl-cache.js` and `surround-verify.js`,
were parsed into the renderer at every startup for main's benefit only.

A phase is not done when its module passes its tests. It is done when something
in the app calls it. There are now three tests that say so mechanically:

- `test/preload-surface.test.js` — every `ipcMain` registration is reachable
  from preload, or listed with a reason.
- `test/soak-probe.test.js` — no script is loaded into the renderer that
  nothing there uses.
- `test/video-ui.test.js` — every shelf the page asks for can be resolved, and
  every shelf the backend serves is asked for.

### What the soak found

It had never run, and could not have: its entry guard is false under Electron,
so the child it spawns for itself loaded the module, defined every function and
did nothing, forever. Separately, main loaded the renderer by a relative path,
so under the harness every measurement would have been of a blank window.

Once running it reported a listener leak. That was its own metric — it counted
registrations, not live listeners, which on an innerHTML renderer can only
rise. Corrected to a WeakRef live count, the picture was flat.

Then, with per-call-site attribution added, it found a real one:

    global: 20 x checkConnections :: dragover
    global: 20 x checkConnections :: drop

The drag-and-drop file handlers were registered at the end of a function that
runs on a thirty-second interval. Two listeners a minute, for as long as the
app was open — and because every drop event runs all of them, dropping a file
after an hour enqueued it about a hundred and twenty times.

The lesson is specific and worth keeping: **when a measurement disagrees with
you, make it name its own cause before you touch its threshold.** A controlled
reproduction of six rounds of clicking showed the count flat, and it was flat,
because the leak is driven by a timer and not by navigation. Four minutes of
clicking is not four minutes of waiting.

### Four metrics that measured the wrong thing

Every one produced a confident verdict, and every one had to be caught by
checking the instrument rather than by reading the result. This is the part of
the soak work most worth carrying forward, because the failure is silent by
construction: a metric that is wrong still prints a number.

| Metric | What it actually measured | How it read |
|---|---|---|
| `listeners` | listeners *created*, not alive | false leak — could only ever rise on an innerHTML renderer |
| `rendererHeapUsed` | Chromium's privacy placeholder | false pass — one constant value across 400 samples |
| `liveNodes` / `detachedNodes` / `cdpListeners` | garbage not yet collected | false leak — GC slows as a process settles, lifting every window's floor |
| `rendererRss` | real, but dominated by allocator behaviour | false leak over 100 min, resolved itself over the same run once trusted |

Two produced false passes, two false failures. The three checks that now catch
this class:

1. **A constant series gets its own verdict.** A metric that never varied is
   not a measurement of a stable thing; it is a measurement of nothing, and it
   no longer counts towards the metrics that decided anything.
2. **A failed probe install aborts the run.** Zero at every sample reads as
   flat, and flat is a pass.
3. **The DOM counters are read after a forced collection**, so they answer
   "what cannot be collected" rather than "what has not been collected yet".

And the discipline that found all four: before believing a verdict, check that
each metric's series actually varied, and reproduce a flagged metric with an
independent probe before touching its threshold. Both are cheap. A threshold
raised to silence a red light is the one repair that can never be undone by
evidence.

### On the soak (phase 7)

Smoothness over hours is a different property from smoothness in a demo and cannot be promised, only measured. The run must:

- drive hundreds of page changes, shelf loads, detail opens and player start/stops unattended;
- sample at intervals: heap used, external memory, DOM node count, listener counts, cache entry counts, IPC round-trip time, stream cache size on disk;
- compare the last decile of the run against the first;
- fail on any monotonic rise.

**A number that only goes up is a leak, whatever the app looks like while it happens.**

---

## 6. Constraints and honest limits

- **No new accounts.** TMDB + AniList + OMDb only, all keyed from settings. Trakt and Letterboxd were considered and declined.
- **Keywords are volunteer-written.** Movements and themes are strong for canonical cases, thin at the edges. **A shelf that cannot be filled honestly is not shown** — no padding.
- **OMDb is patchy for anime** (IMDb-id keyed).
- **The taste engine is empty on day one.** It earns its value with history.
- **Never hardcode a key.** Both keys live in `videoSettings` and are read at use.

## 7. Repo conventions (for whoever picks this up)

Electron 28, CommonJS, **no build step, no framework, no TypeScript**. Renderer is plain DOM string-building.
Tests are `node:test` in `test/`, run with `npm test` (1524 passing at the time of writing).
Providers never throw; total failure returns `[]`. Async UI uses ticket guards so a stale response cannot overwrite newer state.
New preload push channels **must** be added to the allowlist in `preload.js` or they fail silently.
Handlers that wait on a person (file pickers) need a `0` entry in `IPC_TIMEOUT_OVERRIDES`.
