# Album information, discovery, and the bio fix — implementable spec

Target: `~/flac-player`. Surface: the album dossier (`src/slsk-dossier.js`) that opens when he clicks an album in a Soulseek peer's library.

---

## What this adds

When he opens an album in someone else's library, the panel now tells him what the record actually is — when it came out, whether it's the studio album or a live set or a compilation, what it's filed under, and a paragraph about it — instead of only what the files are. Underneath that it shows what else is in this same library that shares the same specific tags, and what else the artist made that nobody here has, so there's somewhere to go next. And the artist paragraph stops being chopped off mid-sentence: it gets a **Show more** button, and the text behind it gets roughly six times longer.

---

## The artist bio fix

**The bug being replaced:** `src/slsk-dossier.js:155` — a hard `slice(0, 420)` with an ellipsis and no control. Verified: Wikipedia's summary for "Pink Floyd" is 424 characters, so the panel cuts it 4 characters from the end. The second truncation at `src/slsk-room-ui.js:336` (`slice(0, 300)` + `…`) is fixed in the same pass.

### 1. Three states, not two

`m.about` starts `null`, so today the panel prints "Nothing written about this artist yet." *before the lookup has answered*. Replace with:

| Model state | Renders |
|---|---|
| `m.about === null` and a request is in flight | `Looking up…` |
| `m.about && m.about.bio` | the paragraph + control |
| `m.about && !m.about.bio` | `Wikipedia has nothing on ${artist}.` |
| no artist name at all (columns folder) | `This folder's name doesn't say who the artist is, so I can't look the record up.` |
| lookup rejected or `window.api.artistInfo` missing | `The lookup didn't answer. Close and reopen the panel to try again.` |

**Rule to write into the code comment:** `null` means *still asking*, and only a live promise is allowed to hold a slot at `null`. Every `.then` gets a matching `.catch` that writes a failure shape and repaints; every guarded `if (window.api…)` gets an `else` that does the same synchronously.

### 2. The preview cut

New pure helper `bioPreview(text, limit = 420)` in `src/slsk-dossier.js`, returning `{ text, truncated }`:

1. Trim leading/trailing whitespace and newline runs.
2. If `text.length <= limit` → return the whole thing, `truncated: false`, no button.
3. Look for the first blank-line paragraph break at index between 200 and 600 → cut there.
4. Otherwise scan backwards from `limit` for a sentence end: `.`, `!` or `?` followed by a space, where the character after the space is uppercase **and** the word before the punctuation is longer than two characters. (This is what stops "St. ", "Jr. ", "U.S. " and "No. 1" from being treated as sentence ends.)
5. If nothing found past index 200, cut at the last space before `limit`.
6. Append `…`.

**The slice happens on the raw text, `esc()` is applied after.** Escaping first and slicing after can cut an HTML entity in half.

### 3. The control

Rendered immediately after the paragraph, only when `truncated` is true:

```html
<button class="slr-btn slr-btn-quiet" data-act="bio-more">Show more</button>
```

Label flips to `Show less` when open. Two rules that are not optional:

- **`data-act`, never an `id` + `addEventListener`.** The artist page's expander (`src/renderer.js:17923-17943`) uses `id="artist-bio-expand"`; copying that here breaks, because `repaintBody()` re-serialises the entire panel body on every async arrival and destroys directly-bound listeners. The panel's existing delegated `[data-act]` handler (`src/slsk-dossier.js:264`) picks this up with zero new wiring — add a `case 'bio-more': m.bioOpen = !m.bioOpen; repaintBody(); break` to the switch.
- **The open/closed flag lives on the model**, not the DOM. Add `bioOpen: false` to the model line at `src/slsk-dossier.js:54`. Otherwise a Discogs reply landing a second later silently re-collapses a paragraph he just opened.

When open, render the full escaped text in place of the preview. No hidden sibling element.

### 4. Scroll

Scroll lives on `.slr-dossier-panel`, not on the body being replaced, so expanding can't move him. Collapsing shortens the page and the browser clamps `scrollTop`. Fix once, for every late-arriving section: in `repaintBody()`, capture `panel.scrollTop` before the `innerHTML` swap and restore it after.

### 5. Make the text worth expanding

`src/artist-info.js` ends at Wikipedia's REST **summary** endpoint, which returns a lead abstract by design — that is *why* he sees a cut. Repoint the wiki fetcher at the keyless full-intro endpoint:

```
https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&exintro=1&redirects=1&titles=<Title>
```

Measured: 2,736 characters for Pink Floyd against 424. Same one request, no key, no new IPC.

This is a contract change and must be treated as one:

- Add a **new** exported parser `bioFromQueryExtract(json)` beside `bioFromWikiSummary` — do not mutate the tested one. Shape is `json.query.pages[<pageid>].extract`; a `pageid` of `-1` or a missing page means no article.
- Keep the REST summary call as the fallback when the extract is missing or empty.
- Keep a disambiguation guard of your own: the new endpoint carries no `type: 'disambiguation'` field, so apply the same text test the `artist-bio` handler uses — `/may refer to|disambiguation/i` on the first 120 characters.
- Trim the leading and trailing newline pairs this endpoint emits, then split the escaped text on blank lines into separate `<div>` paragraphs so a 2,700-character intro reads as prose rather than one wall.
- **Leave `ipcMain.handle('artist-bio')` on the REST summary.** It is the only source of the `thumbnail` and `description` the library artist page uses.
- Version the bio cache **at the call site** in `main.js` (`'v2:' + artistInfo.cacheKey(artist)`), not inside the exported `cacheKey` helper — that helper is unit-tested and versioning belongs to the caller. Without the bump, up to 100 short bios sit in `artist-info-cache.json` for 30 days.

### 6. The Wander caption

`src/slsk-room-ui.js:336` is a one-line shelf caption, not a reading surface. No expander. Cut at the first sentence end using the same helper and **drop the ellipsis** — the ellipsis is the actual problem there, because it implies more text with no way to reach it.

---

## Album facts

One new section, heading **`About this record`**, inserted between `Rip check` and `About ${artist}` in `sectionsHtml` (album facts before artist facts). The existing `Reception` section is **deleted** and its contents folded in here — one section per subject, not one per source. A section that has lost its contents must not ship as a headed blank.

### Identifying the right release — this governs everything below

Two throttled MusicBrainz hops inside the `album-info` handler:

1. `/release-group/?limit=5&query=releasegroup:"<album>" AND artist:"<artist>"`
2. `/release-group/<mbid>?inc=genres+tags+url-rels+artist-credits`

**The picker must rank, not take `[0]`.** Verified live: "Wish You Were Here" + "Pink Floyd" returns four results all scoring 100, in the order live-single, compilation, single, and the real 1975 album **fourth**.

`pickReleaseGroup(searchJson, { title, year, editionNote })` — a pure function, exported and tested:

- Drop candidates with `score < 70`.
- `yearScore`: folder year present and `|rgYear − folderYear| <= 1` → 2; folder has no year → 1; otherwise 0.
- `typeScore`: `primary-type === 'Album'` with an empty `secondary-types` → 3; `primary-type === 'Album'` → 2; `'EP'` → 1; otherwise 0.
- Sort: `yearScore` desc, then `typeScore` desc, then `first-release-date` ascending (missing date last), then search score desc.
- Compute `confidence`: **`firm`** when `tokenScore(normKey(folderTitle), normKey(rgTitle)) >= 0.6` **and** (no folder year, or the year gap is ≤ 1). Otherwise **`loose`**.

The 0.6 album bar is the project's own established threshold (`PapaSlskShelves.buildLibraryIndex`).

**Always print the identity line. Never conditionally.** The dangerous failure is a title that matches perfectly and a record that doesn't — a self-titled album, or a folder called "Live at Leeds" where the picker's own type preference steers toward the studio record and then stays silent.

- `firm` → `MusicBrainz has this as "${mbTitle}" (${year}, ${typeWord}).`
- `loose` → the same line, followed by `This might not be the same record as the folder you're looking at.`

Everything downstream that could be poisoned by a bad match — the artist MBID, the discography — is gated on `firm` (see *Finding more like it*).

### The facts, in render order

**1. Lead line — release date and what kind of record it is.**
Source: `first-release-date`, `primary-type`, `secondary-types` from hop 2.
Renders: `Released 12 September 1975 · Studio album`. Date formatting: `YYYY-MM-DD` → "12 September 1975"; `YYYY-MM` → "September 1975"; `YYYY` → "1975"; missing date → `Studio album` alone.

`typeWord(primaryType, secondaryTypes)` — pure, exported, tested. Secondary type wins when present: `Live` → "Live album", `Compilation` → "Compilation", `Soundtrack` → "Soundtrack", `Remix` → "Remix album", `Demo` → "Demo", `Mixtape/Street` → "Mixtape", `DJ-mix` → "DJ mix"; two secondary types join with ` · `. Otherwise primary type: `Album` → "Studio album", `EP` → "EP", `Single` → "Single", `Broadcast` → "Broadcast", anything else or absent → "Release". There is no boolean for "studio album" — it is `primary-type === 'Album'` with an empty `secondary-types` array.

Fallback 1 (MusicBrainz matched but has no date): use the Wikipedia summary `description`, which is reliably shaped `1994 studio album by Portishead`, printed verbatim.
Fallback 2 (no MusicBrainz match): `I couldn't find this record on MusicBrainz. The folder name may not match what it's filed under.`

**2. A type pill in the existing `.slr-facts` row** — `Live album` / `Compilation` / `EP` / `Soundtrack` / `Remix album` / `Single`. Emitted **only** when `typeWord` is not "Studio album", and only when confidence is `firm`. Costs nothing beyond the lookup already made. No pill on a plain studio album or an unmatched record — the section below always says what it knows, so absence here is not a silent failure.

**3. The album paragraph.**
Source, mandatory three hops: the release-group's `relations` → the relation whose `type` is `'wikidata'` → `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=<Q>&props=sitelinks&sitefilter=enwiki&format=json` (under 400 bytes; **not** the `Special:EntityData/<Q>.json` endpoint `artist-info.js` uses, which returned 48,718 bytes for the same question) → the enwiki title → the full-intro Wikipedia endpoint from the bio fix.

The Wikidata hop is not optional: looking "Dummy" up on Wikipedia by bare title returns a disambiguation page, and a common album title that is also a film would otherwise be printed as fact about the record.

Rendered with the same `bioPreview` helper and its own independent `data-act="album-more"` control backed by `m.albumTextOpen`.

Fallback 1 (no enwiki sitelink, but a `description` exists): print that one line.
Fallback 2: `No one has written this record up on Wikipedia.`
Expect fallback 2 often — measured extracts run 413 characters for *Wish You Were Here*, 124 for *Dummy*, 95 for an Emancipator record, and below that tier there is frequently no Wikidata sitelink at all.

**4. Genre chips.**
Sources in order: MusicBrainz release-group `genres` filtered to `count > 0`, then Discogs `genres`, then Discogs `styles`. Use `genres`, not `tags` — verified, MusicBrainz free-text tags carry downvoted junk at `count: -1` and `-2` ("groundbreaking", "laut.de", "male vocalist").

Deduped through `PapaSlskWander.norm` (lowercase, non-alphanumeric → space) so "Prog Rock" and "progressive rock" collapse to one chip, keeping the first display form. Capped at 10. Rendered as plain `.slr-chip` spans — **not clickable** (see *Deliberately out of scope*).

Split Discogs genre strings on `/` only, never on commas: his live cache proves the current comma split turns Discogs' own genre "Folk, World, & Country" into a chip reading `& Country`.

A muted source line below: `Genres from MusicBrainz and Discogs.` / `Genres from MusicBrainz.` / `Genres from Discogs.` as appropriate.
Fallback: `No genre tags on this record.`

**5. Pressing and edition notes.**
Source: the Discogs master `notes` field, which `main.js:7871` already downloads on every dossier open and `discogsSummary` then discards. Verified live content for *Dummy*: "Winner of the 1995 Mercury Music Prize. Following the initial issue, there were Australian, American & Euro releases with an additional track…". This is exactly what a lossless collector reads.

Before printing, run a pure `cleanDiscogsNotes(text)` — the raw field is submitter text with CRLF runs and Discogs bracket markup:
- `[a=Beth Gibbons]` → `Beth Gibbons`, `[l=Go! Beat]` → `Go! Beat`, `[m=...]` → its inner text
- `[url=https://…]label[/url]` → `label`
- strip any remaining `[...]` wrapper markup
- collapse `\r\n` runs: a double break becomes a paragraph break, a single break becomes a space
- then slice with `bioPreview(text, 300)`, then `esc()`

Prefixed `From Discogs: `, with its own `data-act="notes-more"` control backed by `m.notesOpen`.

**Guard against the wrong record's prose.** `pickDiscogsMaster` today takes the first search result of type `master` with no title check. His own cache proves it already mismatches: `discogs:mike oldfield::tubular bells` is cached against master 937480, *"Tubular Bells II / Tubular Bells III"*. Change `pickDiscogsMaster(json, { title })` to score candidates on `tokenScore(normKey(candidateTitle), normKey(title))` and reject anything under 0.6. When the chosen master's title still differs from the folder title, print `From Discogs, for "${masterTitle}": ` instead.

Fallback: when `notes` is empty or no master cleared the bar, print nothing. The never-blank rule binds **sections**, not every optional line inside one — the section above it has already given the date, the type and the paragraph.

**6. The Discogs link.**
`<button class="slr-btn slr-btn-quiet" data-act="external" data-url="…">See it on Discogs</button>`, routed through the delegated handler to `window.api.openExternal(url)` (`preload.js:486`; `main.js` already refuses anything that is not https). Zero new requests — `discogs-album` has been returning `url` all along and the panel has never rendered it.

Prefer the MusicBrainz `discogs` relation URL when present (verified exact: *Wish You Were Here* → `discogs.com/master/11703`, *Dummy* → `master/5542`) — that is an authoritative id rather than the first hit of a text search. Fall back to the Discogs search result's own `url`. No link and no placeholder when neither produced one.

**7. The star rating — deleted outright.**
Delete the `.slr-stars` row from the panel and the `rating` / `count` display entirely. It has never worked and cannot: `discogs-album` asks for `/masters/{id}`, and a Discogs **master** carries no community rating. Verified twice — the live API returns `"community": null`, and all 18 `discogs:` entries in his own cache read `rating: null, count: 0` while genres and styles are full. Every dossier he has ever opened printed `★☆☆☆☆ — · 0 ratings on Discogs`, which reads as "this album is rated zero". That is worse than nothing.

Delete the `★★★★☆ 4.3 · 1,204 ratings on Discogs` string from the design too. A code path that has never once fired should not ship as dead copy.

**8. Discogs without a token.**
Today `discogs-album` returns `{ok:false, reason:'no-token'}` *before any network call*, and the panel prints "Add a Discogs token in Settings to see ratings and tags." With the star row gone, that sentence promises the one thing a token demonstrably cannot buy, and it costs a token-less user the year, the notes, the chips and the link — all of which were verified to return keyless with only a User-Agent (`/masters/5542` → HTTP 200; headers `x-discogs-ratelimit: 25` unauthenticated vs 60 authenticated).

Move the token guard **down** the handler. With no token stored, make the same two calls with the User-Agent alone and return `{ ok: true, rating: null, count: 0, genres, styles, year, notes, url, tokenless: true }`. Nothing about the panel changes for a token-less user, because the panel no longer renders a rating. The existing test asserting the early return is updated deliberately, and the commit says why: the guard existed to avoid putting a credential on the wire, and no credential goes on the wire either way. If the unauthenticated ceiling is hit, the handler's own reason sentence surfaces: `Discogs is busy right now. Try again in a minute.`

**9. The empty-artist case.**
`src/slsk-columns.js:417` synthesises an album with `artist: ''` when a folder has no parsed artist. With an empty artist the MusicBrainz query is literally `artist:""` and would burn two throttled slots landing on whatever Lucene liked. Guard every new lookup on `m.artist && m.title` and, when the artist is empty, set the slot **synchronously** to a named refusal covering all four new sections: `This folder's name doesn't say who the artist is, so I can't look the record up.`

---

## Finding more like it

Ranked by how often each leads somewhere. Instant and local first.

### 1. `More by ${artist}` — most reliable, one network request

Replaces the existing `Also by ${artist} here` heading and grows a second half.

**First half (instant, no network):** this peer's own folders by the same artist — the existing `m.siblings`, rendered exactly as today (`data-sibling` chips that close and reopen the dossier).

**Second half (one throttled request):** what the artist actually made that is not in this library. `/release-group?artist=<mbid>&type=album&limit=50`, filtered to entries with `primary-type === 'Album'` and an **empty** `secondary-types` array — verified, this leaves Portishead's exact studio discography (Dummy 1994, Portishead 1997, Third 2008) out of 49 release-groups.

**Where the artist MBID comes from.** When the album match is `firm`, it is free inside `artist-credit[0].artist.id` from hop 2. When the match is `loose` or missing, **do not inherit it** — an MBID from a wrong match produces a confidently wrong catalogue, which is the most damaging output in this design. Instead fall back to one throttled `/artist?query=artist:"<name>"&limit=1`, cached under `artistmbid:v1:<name-lower>` so it is paid once per artist, not once per album. This converts the design's most frequent dead end into a working section.

**Marks, all local and instant.** For each MusicBrainz title: match against `deps.state.library` with `PapaSlskShelves.normKey` / `tokenScore` at 0.6 album / 0.34 artist → `you have it`. Match against `peerAlbums` the same way → `here too`, and the row becomes a chip that opens that dossier. Neither → a `Wishlist` button calling `deps.wishlistAdd(artist + ' ' + title)`.

**Summary line above the list, attributed to its source** — this is not a discography, it is what MusicBrainz has filed:
`MusicBrainz lists ${n} studio albums for ${artist}. ${username} has ${k}. You have ${j}.`

Sorted by date, capped at 10, with `Showing the first 10 of ${n}.` when it overflows.

Empty states: in flight → `Looking up their records…`; no artist MBID at all → `I couldn't find ${artist} on MusicBrainz, so I can't list what else they made.`; MBID found but nothing clears the studio-album filter → `MusicBrainz lists no other studio albums for ${artist}.`

### 2. `Artists here with the same tags` — instant, zero network

Named for what it actually is. Matching is at **artist** level; calling it "More like this" would overclaim, because artist tags cannot tell an artist's ambient record from their breakbeat one.

**Candidates:** the peer's whole `albums` array, already in memory in `src/slsk-room-ui.js` and today passed only as the same-artist subset. Pass the whole array as `peerAlbums`.

**Tags:** `wander.tags` passed **by reference** as `tagsByArtist`, so rows that fill in during the room's background sweep appear on the next repaint. The dossier additionally fires **one** `window.api.musicbrainzArtistTags({ artist: m.artist })` for its own artist rather than hoping the warm-up covered it — the room only warms the peer's top 40 artists by shelf depth, so the 60th-ranked artist would never appear. That call is cache-backed (his store already holds 181 artists) and is usually free.

**Scoring — rarity, not raw count.** Raw shared-tag counting does not discriminate. Measured on his live `peer-enrich.json`: 181 cached artists, 60 with an empty tag list, 112 with ≥2 tags, 260 distinct tags — and the tags doing the work are generic (`rock` appears for 67 artists, `pop rock` 29, `british` 26, `pop` 25). Seed "tipper" produces seven candidates all tied at exactly 2 shared tags, every one of them `{electronic, ambient}`, so the top-8 is whatever the array happened to sort first.

So:

- One pass over `tagsByArtist`, restricted to artists that appear in `peerAlbums`, builds `df[tag]` and `tagged` (artists with ≥1 tag). In memory, no network.
- `rarity(t) = Math.log(tagged / Math.max(df[t], 1))`.
- A candidate artist qualifies when the shared set has **≥2 tags** *and* **at least one shared tag with `df[t] / tagged < 0.15`**.
- `score = sum(rarity(t))` over the shared set.
- One album per artist (the best: not-owned first, then lossless/hi-res, then most tracks) so a prolific artist can't flood the list.
- Sort by score desc, then not-owned first, then lossless. Cap **8**.

Verified against his own cache, this floor flips Tipper from 7 arbitrary ties to **zero matches** — the correct answer — while Pink Floyd's list stays good (Hawkwind on space rock / psychedelic rock / progressive rock, Yes, King Crimson, Camel, Gong) and drops the raw-count noise.

**Each row** is a chip carrying `data-peer="<folderPath>"` labelled `${album} · ${artist}`, with its two rarest shared tags in muted text beside it and a `you have it` mark where applicable. Clicking closes this panel and opens that one via `deps.openDossier`, exactly as `data-sibling` already behaves. Showing the matched tags on the row is what makes a bad match visible rather than mysterious.

**Empty states — all four, never a blank:**

- Own artist's tags still in flight → `Reading genre tags for ${artist}…`
- MusicBrainz has no tags for this artist (33% of his cached artists) → `MusicBrainz has no genre tags for ${artist}, so I can't match this one up.`
- Nothing clears the specificity floor → `Nothing else here shares anything specific with ${artist} — the tags they have in common are just ${tagA} and ${tagB}.`
- Matches found → the honesty line below, **tense driven by `wander.tagsDone`**:
  - while `false`: `Still reading genre tags for the artists here (${done} so far).`
  - once `true`: `Matched on shared MusicBrainz tags. I have tags for ${done} of the biggest artists in this library.`

Never print `of ${total}` — the warm-up loop stops permanently at the top 40 plus three seeds, so a denominator it can never reach is a lie.

The section is **always rendered** (never omitted). The columns surface is mounted *by* the room and handed the room's own `openDossier` (`src/slsk-room-ui.js:382`), so `peerAlbums`, `tagsByArtist` and `ownsPeerAlbum` are always in closure. The only real edge case is the empty-artist folder, covered by the one guard sentence above.

---

## Copy

Every user-facing string, verbatim.

**Headings**
```
About this record
Artists here with the same tags
More by ${artist}
About ${artist}
```

**Album facts**
```
Released 12 September 1975 · Studio album
Released September 1975 · Studio album
Released 1975 · Studio album
MusicBrainz has this as "${mbTitle}" (${year}, ${typeWord}).
This might not be the same record as the folder you're looking at.
Looking up…
Still asking MusicBrainz — it only answers one question a second.
I couldn't find this record on MusicBrainz. The folder name may not match what it's filed under.
No one has written this record up on Wikipedia.
The lookup didn't answer. Close and reopen the panel to try again.
This folder's name doesn't say who the artist is, so I can't look the record up.
Show more
Show less
From Discogs: ${notes}
From Discogs, for "${masterTitle}": ${notes}
See it on Discogs
Genres from MusicBrainz and Discogs.
Genres from MusicBrainz.
Genres from Discogs.
No genre tags on this record.
Discogs has no entry for this album.
Discogs is busy right now. Try again in a minute.
```

**Facts-row pills** (only when the record is not a plain studio album)
```
Live album
Compilation
EP
Single
Soundtrack
Remix album
Demo
Mixtape
DJ mix
Broadcast
```

**Artists here with the same tags**
```
Reading genre tags for ${artist}…
MusicBrainz has no genre tags for ${artist}, so I can't match this one up.
Nothing else here shares anything specific with ${artist} — the tags they have in common are just ${tagA} and ${tagB}.
Still reading genre tags for the artists here (${done} so far).
Matched on shared MusicBrainz tags. I have tags for ${done} of the biggest artists in this library.
you have it
```

**More by ${artist}**
```
Looking up their records…
MusicBrainz lists ${n} studio albums for ${artist}. ${username} has ${k}. You have ${j}.
I couldn't find ${artist} on MusicBrainz, so I can't list what else they made.
MusicBrainz lists no other studio albums for ${artist}.
Showing the first 10 of ${n}.
Wishlist
you have it
here too
```

**About ${artist}**
```
Looking up…
Wikipedia has nothing on ${artist}.
The lookup didn't answer. Close and reopen the panel to try again.
Show more
Show less
```

---

## Plumbing

### New IPC #1 — `album-info`

**Args:** `{ artist, album, year, editionNote }`
**Returns, always this shape, never throws:**
```js
{ ok: true, found: boolean, confidence: 'firm'|'loose'|null,
  mbid, artistMbid, title, date, primaryType, secondaryTypes: [],
  genres: [{ name, count }],
  wikiExtract: string|null, wikiDescription: string|null,
  discogsUrl: string|null }
// or
{ ok: false, reason: '<a readable sentence>' }
```

**Hops:** (1) MusicBrainz release-group search, **throttled**; (2) MusicBrainz release-group lookup with `?inc=genres+tags+url-rels+artist-credits`, **throttled** — one response yields the genres, the wikidata relation, the discogs relation and the artist MBID; (3) Wikidata `wbgetentities&props=sitelinks&sitefilter=enwiki`, keyless and unthrottled; (4) Wikipedia `action=query&prop=extracts&exintro=1&explaintext=1&redirects=1`, keyless.

Both MusicBrainz hops go through the existing `_mbThrottle` / `_mbGetJson` pair (`main.js:7710-7755`) with the existing `MB_UA`. No new client, no second throttle.

**Preload:** `albumInfo: (p) => ipcRenderer.invoke('album-info', p)`, beside the peer-enrichment block at `preload.js:519-525`. Nothing named `album-info` or `albumInfo` exists anywhere in `src/`, `main.js` or `preload.js` today.

### New IPC #2 — `artist-releases`

**Args:** `{ artistMbid, artist }` — `artistMbid` when `album-info` returned `confidence: 'firm'`, otherwise `artist` alone and the handler resolves the MBID itself with one throttled `/artist?query=artist:"<name>"&limit=1`.
**Returns:** `{ ok: true, artistMbid, releases: [{ id, title, date, primaryType, secondaryTypes }] }` or `{ ok: false, reason }`.
One throttled `/release-group?artist=<mbid>&type=album&limit=50`.
**Preload:** `artistReleases: (p) => ipcRenderer.invoke('artist-releases', p)`.

Split from `album-info` deliberately: the facts section paints as soon as it can instead of waiting for the discography.

### IPC deadlines

Add to `IPC_TIMEOUT_OVERRIDES` (`main.js` ~110-155), with the same one-line justification the existing `'musicbrainz-check-album': 120000` entry carries:
```js
// MusicBrainz at a 1 req/s ceiling, plus Wikidata and Wikipedia.
'album-info': 120000,
'artist-releases': 120000,
```
Without them the wrapper at `main.js:171-200` races the handler against `IPC_DEFAULT_TIMEOUT_MS = 60000` and **rejects the invoke** — which, with a bare `.catch(() => {})`, becomes a permanent "Looking up…".

### Cache

Reuse `sideStores.peerEnrich` and its `_enrichGet` / `_enrichSet` helpers, `ENRICH_TTL_MS = 30 * 24 * 3600 * 1000`.

| Key | Holds |
|---|---|
| `albuminfo:v1:<artist>::<album>` (lowercased) | the whole `album-info` value |
| `artistrgs:v1:<artistMbid>` | the `artist-releases` value |
| `artistmbid:v1:<artist-lower>` | the fallback artist-search MBID |
| `discogs:v2:<artist>::<album>` (lowercased) | **bumped** — the widened Discogs shape |

**The cache read happens at the very top of the handler, before any `_mbThrottle` call** — the way `discogs-album` already does. A cached album must paint in milliseconds even while the room's warm sweep owns the chain.

**Policy** (copying the rule `main.js:4681-4687` already applies to bios): cache `ok: true` replies for 30 days **including a clean `found: false`** — MusicBrainz genuinely not having the record is a stable fact. **Never cache a transport failure**; a network blip must not pin "nothing found" on an album for a month. Keep the cached value lean — ids, dates, types, the trimmed extract, the chip list; not raw API responses. The store has no cap and no eviction, only a TTL checked on read.

**The `discogs:v2:` bump is load-bearing and easy to forget.** 18 of his albums already hold the narrow `{rating, count, genres, styles, url}` shape; without the bump the pressing notes and the year simply never appear on any album he has already opened, for up to a month.

### Rate limiting

Three throttled MusicBrainz calls per cold album (two for `album-info`, one for `artist-releases`), all serialised through the single existing `_mbChain` at `MB_MIN_INTERVAL_MS = 1100`. Wikidata and Wikipedia stay unthrottled and keyless. Discogs stays at its existing 1000 ms spacing with `_discogsRedact` guarding every error string that leaves main — the cleaned `notes` text goes through the same redaction path.

**No priority lane is needed.** The room's warm-up loop `await`s each call in turn (`src/slsk-room-ui.js:596-600`), so only one background request is ever sitting on the chain; a dossier's hops interleave and pay roughly one extra 1.1 s slot each — about 4-7 s cold, not the 45 s a naive reading suggests.

**One honesty note for the same change:** `ipcMain.handle('artist-info')` currently bypasses `_mbThrottle` entirely via a bare `fetch()` in `_artistInfoFetchJson` (`main.js:4646`), hitting MusicBrainz twice per uncached artist with no spacing. Move that path onto `_mbThrottle` in this change — otherwise the app's 1 req/s promise still is not kept, and adding well-behaved traffic beside it does not fix that.

### Model slots, loading and empty states

Add to the model line at `src/slsk-dossier.js:54`:
```js
albumInfo: null, artistReleases: null, artistTags: null,
bioOpen: false, albumTextOpen: false, notesOpen: false, slow: false,
```

Every new lookup joins the block at the bottom of `open()` as another
`.then(r => { m.x = r; if (root.isConnected) repaintBody() })` — **plus a `.catch` that writes `{ ok: false, reason: 'The lookup didn't answer. Close and reopen the panel to try again.' }` and repaints**, and an `else` on the `if (window.api…)` guard that writes the same shape synchronously. Nothing is awaited before first paint.

A renderer-side `setTimeout` at **12 seconds** sets `m.slow = true` and repaints if `m.albumInfo` is still `null`, swapping "Looking up…" for "Still asking MusicBrainz — it only answers one question a second." Twelve, not six: cold cost is 4-7 s, and a warning that fires on every normal open reads as breakage. Clear the timer in `close()`.

`artist-releases` fires only after `album-info` answers, so it can pass the firm MBID or the artist name.

**Every new section renders from `m` alone and holds no DOM-local state.** `repaintBody()` re-serialises the whole body with no diffing and no debounce — six async arrivals now means six re-serialisations, which is fine, but anything left in the DOM is destroyed by each one.

### New deps, all absent-tolerant

Supplied from `src/slsk-room-ui.js`'s `openDossier` closure (line 210-216), passed unconditionally:

- `peerAlbums` — the room's whole `albums` array
- `tagsByArtist` — a live reference to `wander.tags`
- `tagsDone` — a getter reading `wander.tagsDone`
- `ownsPeerAlbum: a => !missingSet.has(a)` — the room already computes `missingSet` at line 110

When `peerAlbums` is absent (a caller outside the room), the tags section renders nothing and no other section changes.

### Rendering

`sectionsHtml(m, esc)` stays a **pure model-to-string function** with no DOM and no network — `test/slsk-dossier.test.js` drives it directly with plain objects. New section renderers follow the existing `(m, esc) => htmlString` signature beside `ripHtml`. Every externally-sourced string — Wikipedia extracts, Discogs notes, MusicBrainz titles, genre names — goes through `esc()`, and **every slice happens before `esc()`**.

No new CSS classes. `.slr-sec` / `.slr-sec>b`, `.slr-muted`, `.slr-chip`, `.slr-chip-btn`, `.slr-chips`, `.slr-pill`, `.slr-btn-quiet` and `.slr-story` cover every element above and already carry their light-mode and reduced-motion treatment in `src/slsk-room.css`. No new renderer module, so the script order in `src/index.html` that `test/slsk-room-wiring.test.js` pins is untouched. All new content must survive the panel's 380 px minimum width.

---

## Tests

**Pure node tests (`node --test`), each with a mutation check — revert the fix and the test must go red:**

- `pickReleaseGroup` — fed the real four-result Pink Floyd search fixture (saved JSON, not hand-written), asserts it picks the 1975 studio album, not `[0]`. Mutation: restore `[0]` → red.
- `pickReleaseGroup` year preference — a fixture where the folder year is 1975 and a 1968 release-group scores higher; asserts the 1975 one wins and `confidence === 'firm'`.
- `pickReleaseGroup` confidence — a title under the 0.6 bar returns `'loose'`.
- `typeWord` — the six live secondary-type values plus the plain-album case; asserts `['Live']` → "Live album" and `[]` + `Album` → "Studio album".
- `formatReleaseDate` — `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, empty.
- `bioPreview` — under the limit returns whole text and `truncated:false`; a paragraph break inside 200-600 wins; "St. Petersburg" and "No. 1" are not cut at; nothing past 200 falls back to the last space. Mutation: drop the uppercase-after check → the abbreviation case goes red.
- `cleanDiscogsNotes` — the live `/masters/5542` notes string in, `[a=…]`/`[l=…]`/`[url=…]` gone and CRLF collapsed out.
- `pickDiscogsMaster` — the Tubular Bells mismatch fixture returns `null` at the 0.6 bar. Mutation: remove the bar → red.
- `discogsSummary` widened — asserts `year` and `notes` survive.
- `bioFromQueryExtract` — the `query.pages[<id>].extract` shape, a `pageid: -1` miss, and a disambiguation extract → `null`.
- Tag ranking (`rankSameTagArtists`) — driven by a **copy of his real cache** committed as a fixture: asserts the Tipper seed returns zero matches (every shared pair is just `{electronic, ambient}`) and the Pink Floyd seed returns Hawkwind and Yes above Frank Zappa. Mutation: replace rarity scoring with a raw count → Tipper returns 7 and the test goes red.
- `sectionsHtml` state table — one assertion per state: `null` slot prints "Looking up…", `slow` prints "Still asking MusicBrainz", `found:false` prints the folder-name sentence, `ok:false` prints the didn't-answer sentence, empty artist prints the folder-name-doesn't-say sentence. **No state may render an empty `.slr-sec`** — assert each section's body is non-empty in every branch.
- `sectionsHtml` escaping — extend the two existing hostile-input tests to cover the Wikipedia extract, the Discogs notes and the MusicBrainz title fields; assert no raw `<img` survives.
- `bioOpen` / `albumTextOpen` / `notesOpen` — `sectionsHtml` with the flag true renders the full text and the "Show less" label; with it false renders the preview and "Show more".

**IPC wiring tests that execute, not string-match** (`test/peer-enrich-ipc.test.js` style): register the handlers with a stubbed `_mbGetJson` / `httpsGet` returning the saved fixtures, then **invoke** them.

- `album-info` returns the documented shape for a hit, a `found:false` miss, and a thrown fetch (asserting `ok:false` with a sentence, and asserting nothing was written to the cache on the throw).
- `album-info` reads the cache **before** the first throttle call — stub `_mbThrottle` to throw and assert a cached album still returns `ok:true`. Mutation: move the cache read below the throttle → red.
- `artist-releases` with no `artistMbid` performs the artist-search fallback and caches the MBID; a second call makes no network call at all.
- `discogs-album` with no token now makes its calls and returns `tokenless: true` with genres and notes populated — this **replaces** the existing no-token early-return assertion; the commit message says why.
- Both new channels exist in `main.js` **and** are exposed in `preload.js`.
- Both new channels appear in `IPC_TIMEOUT_OVERRIDES`.

**Live twin pass, last, on a stripped profile** (no Discogs token, no debrid token, one twin, kill the process group and print the zero count afterwards):

1. Open a peer library, open a well-known album → the facts section fills in within ~7 s with a date, a type and a paragraph; the identity line is present.
2. Open an obscure album → the section still shows date + type + genres, and prints the Wikipedia fallback sentence rather than a gap.
3. Open an album whose folder name is wrong → the "might not be the same record" line appears and no discography is shown from a poisoned MBID.
4. Click **Show more** on the artist bio, then wait for the discography to land → **the paragraph must stay open** (this is the `repaintBody` trap) and the scroll position must not jump.
5. Open a folder through the Folders/columns view with no artist in the name → the single refusal sentence, and a CDP network check confirming **no** MusicBrainz request was made.
6. Open an album by an artist with no MusicBrainz tags → the named sentence, not an empty section.
7. CDP console sweep across all of the above: zero uncaught errors, zero CSP violations.
8. Resize the panel to its 380 px minimum → nothing overflows horizontally.

---

## Deliberately out of scope

- **A "similar albums" / "you might also like" section from an online source** — tested, not assumed: MusicBrainz tag search re-ranked every way never surfaces Massive Attack for `tag:"trip hop"` (MusicBrainz publishes no popularity field, only a Lucene text score), Wikipedia's related-pages endpoint answers HTTP 403, and Wikidata SPARQL answered HTTP 502 after 42.9 s and again after 49.8 s.
- **Anything built on Last.fm** — `LASTFM_API_KEY = 'PLACEHOLDER'` (`main.js:298`) and his `lastfmConfig` is empty; it would be a permanently blank section.
- **Looking the album up on Wikipedia by bare title** — "Dummy" returns a disambiguation page; the Wikidata hop is mandatory.
- **Taking `release-groups[0]`** — verified to pick a live single over the real album.
- **Reusing `musicbrainz-check-album`** — it returns no genres, no release-group, no url-rels and no artist MBID, and widening it would break the tag fixer's contract.
- **Clickable genre chips that filter the peer's shelf** — the chips carry album vocabulary (MusicBrainz release-group genres, Discogs styles) while any filter would match artist tags; a Discogs style like "Prog Rock" would return an empty shelf that reads as a fact about the peer. Lowest value of anything proposed, highest embarrassment risk, and the room's search box already filters the list he's looking at.
- **A priority lane on `_mbThrottle`** — rejected as unnecessary: the warm-up loop awaits each call, so only one background request is ever queued and a dossier pays about one extra second, not forty-five.
- **A canonical tracklist next to the peer's files** — costs another throttled lookup and would cry wolf on every deluxe edition; the rip check and "Tracks vs yours" answer the real question.
- **Cover Art Archive artwork from the MBID** — `paintCover` already prefers his own local art and the MBID arrives seconds later; a late swap from a fuzzy match could replace correct art with the wrong sleeve, for no gain against his actual request.
- **Hanging metadata off `fetch-album-art`** — that handler hard-pauses all cover lookups for 60 s to 15 minutes after one 429.
- **Widening the renderer CSP with `connect-src`** — already rejected once in this codebase, and its absence is what silently killed the artist bio for months.
- **Chasing the Discogs community rating via `main_release`** — a per-edition number, a third request against a rate ceiling, for a row that has shown "★☆☆☆☆ — · 0 ratings" on every album he has ever opened. The honest fix is to stop printing it.
- **Discogs `num_for_sale`, `lowest_price`, `videos`, `images`, `data_quality`** — he collects files, not pressings; none of it changes a download decision.
- **An expander on the Wander caption (`src/slsk-room-ui.js:336`)** — it's a one-line shelf header; cutting at the first sentence and dropping the ellipsis is the fix.
- **Copying the artist page's expander verbatim** — its `id` + direct listener and `style.display` toggle both break under `repaintBody()`. Only the wording carries over.
- **Auto-expanding the bio** — a 2,700-character paragraph would push the tracklist and the rip check far below the fold on a 380 px panel.
- **Versioning inside `artistInfo.cacheKey`** — it's an exported, unit-tested pure helper; the version belongs at the `main.js` call site.
- **Omitting the discovery section on the columns surface** — the premise was wrong: columns is mounted by the room and handed the room's own `openDossier`, so the peer library is always in closure. The real edge case is an empty artist name, handled by one guard sentence.