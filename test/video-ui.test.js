'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')

// ── Papa Video: the renderer-side UI scaffold ───────────────────────────────

test('index.html declares the Movies & TV nav entry', () => {
  assert.match(HTML, /data-page="video"/, 'the sidebar needs a video page entry')
  assert.match(HTML, /Movies &amp; TV/, 'and it must be labelled')
})

test('index.html declares the theatre and its stage', () => {
  assert.match(HTML, /id="vtheatre"/, 'the theatre root')
  assert.match(HTML, /id="vt-stage"/, 'the rectangle the mpv window is positioned onto')
  assert.match(HTML, /id="vt-deck"/, 'the control deck')
})

// mpv paints into a native child window, which sits above the page's
// compositing layer — controls drawn "over" the video would be invisible
// behind it. Every control must therefore live outside the stage element.
test('no control is nested inside the video stage', () => {
  // Just the stage element itself — the strip that follows it is outside the
  // mpv rectangle and is allowed to hold controls.
  const stage = HTML.slice(HTML.indexOf('id="vt-stage"'), HTML.indexOf('id="vt-strip"'))
  for (const id of ['vt-play', 'vt-seek', 'vt-vol', 'vt-full', 'vt-subs']) {
    assert.ok(!stage.includes('id="' + id + '"'), id + ' must not be inside the stage')
  }
  // Nothing at all lives inside the stage, the skip offer included: it was
  // there originally and would have been invisible behind the video. It and
  // the Up Next card now sit in a strip between the stage and the deck.
  assert.ok(!stage.includes('id="vt-skip"'), 'the skip offer would be hidden behind mpv')
  assert.ok(!stage.includes('id="vt-upnext"'))
  assert.match(HTML, /id="vt-strip"[\s\S]*id="vt-skip"[\s\S]*id="vt-upnext"/)
})

test('the theatre has the full transport, not just play and stop', () => {
  for (const id of ['vt-play', 'vt-back10', 'vt-fwd10', 'vt-seek', 'vt-vol',
                    'vt-mute', 'vt-subs', 'vt-audio', 'vt-speed', 'vt-settings', 'vt-full']) {
    assert.match(HTML, new RegExp('id="' + id + '"'), 'missing control: ' + id)
  }
})

test('the transport is labelled for assistive tech', () => {
  const deck = HTML.slice(HTML.indexOf('id="vt-deck"'), HTML.indexOf('id="vt-menu"'))
  const buttons = deck.match(/<button[^>]*>/g) || []
  for (const b of buttons) {
    assert.ok(/aria-label=/.test(b), 'button without an aria-label: ' + b.slice(0, 60))
  }
  assert.match(HTML, /id="vt-seek"[^>]*role="slider"/s)
  assert.match(HTML, /aria-valuemin="0"/)
})

test('the theatre is a modal dialog', () => {
  assert.match(HTML, /id="vtheatre"[^>]*role="dialog"/s)
  assert.match(HTML, /aria-modal="true"/)
})

test('the player controller is loaded before the renderer', () => {
  const player = HTML.indexOf('video-player.js')
  const renderer = HTML.indexOf('renderer.js"')
  assert.ok(player > -1 && player < renderer, 'video-player.js must load before renderer.js')
})

test('renderer.js defines the catalog and detail renders', () => {
  assert.match(RENDERER, /function renderVideo\b/, 'catalog view')
  assert.match(RENDERER, /function renderVideoDetail\b/, 'detail view')
})

test('renderer.js wires the router to the video pages', () => {
  // J1: the video page takes a navId — a search query being retraced — so the
  // router hands it through rather than calling renderVideo() bare.
  assert.match(RENDERER, /page === 'video'\)\s*renderVideo\(navId\)/)
  assert.match(RENDERER, /page === 'video-detail'\)\s*renderVideoDetail\(navId\)/)
})

test('the source picker play buttons are always visible', () => {
  // Play buttons must not hide behind hover. The rule is checked for an
  // opacity at or above .85, matching the app-wide play-button convention.
  const at = CSS.indexOf('.video-source-play {')
  assert.ok(at > 0, 'a .video-source-play rule must exist')
  const rule = CSS.slice(at, CSS.indexOf('}', at))
  const m = rule.match(/opacity:\s*(\.?\d+(?:\.\d+)?)/)
  assert.ok(m, 'the rule must set an opacity')
  const opacity = parseFloat(m[1])
  assert.ok(opacity >= 0.85, `opacity must be >= .85, found ${m[1]}`)
})

test('renderer.js surfaces catalog/detail/streams errors with a helper', () => {
  assert.match(RENDERER, /function _videoError\b/, 'a _videoError helper must exist')
  assert.match(
    RENDERER,
    /TMDB API key\|401/,
    'the helper must detect TMDB-key and 401 errors'
  )
})

test('renderer.js hints where to set the TMDB key', () => {
  assert.match(
    RENDERER,
    /Set your TMDB API key in Settings → Video\./,
    'the hint string must be present'
  )
})

test('styles.css defines the error banner rule', () => {
  assert.match(CSS, /\.video-error\s*\{/, 'a .video-error rule must exist')
})

// ── Season browsing, search and error containment ───────────────────────────

function fnBody(name) {
  const start = RENDERER.indexOf(`function ${name}(`)
  assert.ok(start > -1, `${name} not found in the renderer`)
  const next = RENDERER.indexOf('\nfunction ', start + 1)
  const nextAsync = RENDERER.indexOf('\nasync function ', start + 1)
  const ends = [next, nextAsync].filter(i => i > -1)
  return RENDERER.slice(start, ends.length ? Math.min(...ends) : RENDERER.length)
}

// The old guard compared the live _videoDetailTicket against itself, so it was
// always true: switching season 1 → 2 → 3 quickly could leave season 3 selected
// while showing season 1's episodes.
test('season switching is guarded by a ticket captured before the request', () => {
  assert.match(RENDERER, /var _videoSeasonTicket = 0/, 'a season ticket must exist')
  const body = fnBody('_refreshTvEpisodes')
  assert.match(body, /function _refreshTvEpisodes\(ticket, seasonTicket\)/)
  assert.match(RENDERER, /async function _refreshTvEpisodes\(ticket, seasonTicket\)/)
  assert.match(body, /_videoSeasonTicket !== seasonTicket/, 'the response must be checked against its own ticket')
  assert.ok(!/_refreshTvEpisodes\(_videoDetailTicket\)\s*$/m.test(RENDERER),
    'no caller may pass the live detail ticket as its own guard')
})

test('every season and episode change mints a new season ticket', () => {
  const changes = RENDERER.match(/\+\+_videoSeasonTicket/g) || []
  assert.ok(changes.length >= 6, `expected the season ticket to be bumped on each change, saw ${changes.length}`)
})

test('_loadVideoSources checks both tickets before touching the DOM', () => {
  const body = fnBody('_loadVideoSources')
  assert.match(body, /_videoDetailTicket !== ticket \|\| _videoSeasonTicket !== seasonTicket/)
})

// Refetching the whole show on every season click was two TMDB calls per click,
// forever, because nothing kept what came back.
test('episodes already fetched for a season are reused instead of refetched', () => {
  const body = fnBody('_refreshTvEpisodes')
  assert.match(body, /const known =/)
  assert.match(body, /if \(!episodes\)/, 'the request must be skipped when episodes are known')
  assert.match(body, /known\.episodes = episodes/, 'the payload must be stored back on the detail')
})

// A failing source lookup used to replace the whole page, throwing away the
// hero, the season picker and the episode list.
test('a failed source lookup stays inside the sources panel', () => {
  const body = fnBody('_loadVideoSources')
  assert.ok(!/_videoError\(res\.error\)/.test(body),
    'a source failure must not blow away the detail page')
  assert.match(body, /video-sources-retry/, 'and it must offer a retry')
})

test('a failing catalog row does not wipe the rows that already loaded', () => {
  const body = fnBody('_renderVideoTab')
  assert.match(body, /Promise\.all/, 'rows must load in parallel')
  assert.ok(!/_videoError\(res\.error\)/.test(body),
    'one bad section must not replace the whole page')
  // The failure is rendered into that row's own shell, with a retry.
  assert.match(body, /_rowError\(row\.key, res\.error\)/)
  assert.match(RENDERER, /function _rowError\(/)
  assert.match(fnBody('_rowError'), /data-retry=/)
})

test('the catalog rows load in parallel rather than one after another', () => {
  const body = fnBody('_renderVideoTab')
  assert.ok(!/for \(const sec of _videoRows\)/.test(body),
    'a sequential await loop costs one round-trip per row, back to back')
})

// popular-movies, trending-tv and season-anime were built in the backend and
// never requested — the page only ever showed three of the seven rows.
// Derived from the backend rather than listed here, so it keeps telling the
// truth when a section is deliberately added or removed. Hardcoding the seven
// names meant the test failed on a considered removal exactly as loudly as on
// an accidental one, which is the wrong signal.
test('every catalog row the backend serves is used', () => {
  const MAIN = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  const handler = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-catalog-get'"))
  const body = handler.slice(0, handler.indexOf('ipcMain.handle', 10))
  // The TMDB rows are a switch (case labels); the anime rows moved into an
  // `anilistFns` map so they can share the outage-cache path, so the served set
  // is the union of both — every section the backend can build.
  const served = [
    ...[...body.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]),
    ...[...body.matchAll(/'([a-z-]+anime)':\s*c =>/g)].map(m => m[1]),
  ]
  assert.ok(served.length >= 5, 'expected the catalog sections, found ' + served.length)
  const block = RENDERER.slice(RENDERER.indexOf('var _videoRows = ['), RENDERER.indexOf('function _curatedRows'))
  for (const key of served) {
    assert.ok(block.includes(key), `row ${key} is served by the backend but never requested`)
  }
})

// The other direction: a shelf the page asks for that the backend cannot build
// is a row that renders an error every time it loads.
test('every curated shelf the page asks for can be resolved', () => {
  const MAIN = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  // From the handler, not from _shelfDefinition: resolution begins in the
  // handler, which turns a rotating key into a concrete one before the
  // definition is looked up. director-of-the-day is resolved there because it
  // needs an async person lookup that a synchronous definition cannot do.
  const resolver = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-shelf'"),
    MAIN.indexOf('ipcMain.handle(\'video-catalog-get\''))
  const fn = RENDERER.slice(RENDERER.indexOf('function _curatedRows'),
    RENDERER.indexOf('var _videoTabs'))
  // A key ending in a dash is a prefix being concatenated with a rotating
  // value, not a shelf name; those are checked as families below.
  const fixed = [...fn.matchAll(/key: '([a-z0-9-]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('-'))
  for (const key of fixed) {
    assert.ok(resolver.includes("'" + key + "'"), key + ' is requested but cannot be resolved')
  }
  // The parameterised families are matched by pattern, not by name.
  for (const family of ['decade-', 'movement-', 'theme-', 'country-', 'studio-']) {
    assert.ok(fn.includes("'" + family) && resolver.includes(family),
      family + ' shelves are built but not resolvable')
  }
})

// videoSearch was fully implemented in main and preload and called by nothing.
test('the search box exists and is wired to videoSearch', () => {
  assert.match(RENDERER, /id="video-search-input"/, 'there must be a search input')
  assert.match(RENDERER, /window\.api\.videoSearch\(/, 'and it must call the search API')
  // The debounce lives with the listeners; the request and its stale-guard moved
  // into _runVideoTitleSearch when the parsed path needed to fall back to it.
  assert.match(fnBody('_bindVideoSearch'), /setTimeout\(run, window\.PapaSearchMemory \? window\.PapaSearchMemory\.DEBOUNCE\.remote : 300\)/, 'typing must be debounced by the shared budget')
  assert.match(fnBody('_runVideoTitleSearch'), /_videoSearchTicket !== ticket/,
    'a slow earlier query must not win')
})

test('the search box is styled', () => {
  assert.match(CSS, /\.vsearch\b/)
  assert.match(CSS, /\.vsearch input:focus/, 'a text field needs a visible focus state')
})

// The old catalog was a wrapping grid called a "row": twenty posters in a
// block, three sections stacked into one long scroll.
test('the rails scroll horizontally instead of wrapping into a grid', () => {
  assert.match(CSS, /\.vrail\s*\{[^}]*overflow-x:\s*auto/s)
  assert.match(CSS, /\.vrail\s*\{[^}]*grid-auto-flow:\s*column/s)
  assert.ok(!/\.video-poster-row/.test(CSS), 'the wrapping grid must be gone')
})

test('rail arrows are hidden when there is nothing to scroll to', () => {
  const body = fnBody('_bindRail')
  assert.match(body, /prev\.hidden = rail\.scrollLeft <= 4/)
  assert.match(body, /next\.hidden = rail\.scrollLeft >= max - 4/)
})

test('cards carry rating, type and resume progress, not just a title', () => {
  const body = fnBody('_videoCard')
  assert.match(body, /vbadge-rating/)
  assert.match(body, /vbadge-type/)
  assert.match(body, /vcard-progress/)
  // AniList scores 0-100 and TMDB 0-10; one badge must mean one thing.
  assert.match(body, /r > 10 \? Math\.round\(r \/ 10/)
})

test('a card is keyboard operable', () => {
  const card = fnBody('_videoCard')
  assert.match(card, /tabindex="0"/)
  assert.match(card, /role="button"/)
  assert.match(card, /aria-label=/)
  const bind = fnBody('_bindVideoCards')
  assert.match(bind, /e\.key === 'Enter' \|\| e\.key === ' '/)
})

// The store lands with the engine work; until then these rows are simply
// absent rather than throwing on every render.
test('the catalog degrades when the watch store is not loaded', () => {
  const body = fnBody('_personalRows')
  assert.match(body, /if \(!store\) return \[\]/)
  assert.match(body, /catch/)
})

test('search results are grouped by type and overlay the catalog', () => {
  const body = fnBody('_runVideoTitleSearch')
  // The grouping moved into _paintVideoSearchResults when the result filters
  // (App §20) landed, so the type labels live there now; the title search still
  // owns the overlay behaviour and the fetch.
  const paint = fnBody('_paintVideoSearchResults')
  assert.match(paint, /Films/)
  assert.match(paint, /Series/)
  assert.match(paint, /Anime/)
  // Hidden, not unmounted, so clearing the query does not refetch every row.
  assert.match(body, /rows\.style\.display = 'none'/)
  assert.match(body, /_videoSearchTicket !== ticket/)
})

test('the hero rotates and is stopped when the page changes', () => {
  assert.match(fnBody('_startVideoHero'), /setInterval/)
  assert.match(fnBody('_stopVideoHero'), /clearInterval/)
  assert.match(fnBody('_startVideoHero'), /state\.currentPage !== 'video'/)
})

// AniList overviews are HTML fragments, unlike TMDB's plain text.
test('AniList markup is stripped before it reaches the hero', () => {
  assert.match(fnBody('_stripTags'), /replace\(\/<\[\^>\]\*>/)
  assert.match(fnBody('_paintVideoHero'), /_stripTags\(item\.overview\)/)
})

test('the tab strip is an accessible tablist', () => {
  const head = fnBody('_vHeadHtml')
  assert.match(head, /role="tablist"/)
  assert.match(head, /role="tab"/)
  assert.match(head, /aria-selected=/)
})

test('reduced motion is respected', () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/)
})

test('the stream request carries the imdb id the TV indexer needs', () => {
  const body = fnBody('_videoStreamRequest')
  assert.match(body, /imdbId: d\.imdbId \|\| null/)
})

test('an unplayable source reported as ok:false is surfaced, not swallowed', () => {
  const body = fnBody('_videoPlayResult')
  assert.match(body, /res\.ok === false/)
})

test('the measured audio layout from ffprobe is displayed', () => {
  const body = fnBody('_handleVideoEvent')
  assert.match(body, /payload\.kind === 'audio'/)
})

test('buffering shows real progress rather than an indefinite spinner', () => {
  const body = fnBody('_handleVideoEvent')
  assert.match(body, /payload\.percent/)
})

test('backend errors are translated into something actionable', () => {
  const body = fnBody('_videoErrorText')
  assert.match(body, /401\|api key/)
  assert.match(body, /Settings → Video/)
})

// Nyaa indexes under the romaji title, so the English display title alone
// found nothing for a large share of shows.
test('the anime stream request carries every AniList title variant', () => {
  const body = fnBody('_videoStreamRequest')
  assert.match(body, /titles: d\.titles \|\| null/)
})

// ── Curation ────────────────────────────────────────────────────────────────
// Every shelf the home tab showed was a variant of "what is popular right now",
// which is why nothing made before this year ever reached the page.
test('the page carries shelves that are not about this week', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _curatedRows'), RENDERER.indexOf('var _videoTabs'))
  for (const family of ['canon', 'decade-', 'movement-', 'theme-', 'country-', 'studio-', 'hidden-gems']) {
    assert.ok(fn.includes(family), family + ' is missing from the home page')
  }
})

// Eight decade rows at once would bury everything else, and a page that shows
// the same rows forever stops being worth opening.
test('the rotating shelves are stable within a day and change between days', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _curatedRows'), RENDERER.indexOf('var _videoTabs'))
  assert.match(fn, /Math\.floor\(Date\.now\(\) \/ 86400000\)/, 'the seed must be the day, not the moment')
  assert.match(fn, /day % /, 'and it must actually select with it')
})

// Deliberately NOT de-duplicated across shelves. Seven Samurai belongs in the
// canon, in Japanese cinema and in world cinema, and removing it from two of
// them to avoid a repeat makes those two shelves less true to what they claim
// to be. A shelf's job is to be right about its own category, not to be
// disjoint from its neighbours.
//
// Within a single grid is different: the catalogue repeats titles across page
// boundaries, and the same poster twice in one grid is a bug, not a category.
test('a film may appear on every shelf it genuinely belongs to', () => {
  const fn = fnBody('_renderVideoTab')
  assert.ok(!/const seen = new Set/.test(fn),
    'cross-shelf de-duplication would make a shelf lie about its own category')
})

test('but one grid never shows the same film twice', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _loadShelfPage'),
    RENDERER.indexOf('function _bindShelfScroll'))
  assert.match(fn, /const have = new Set/)
  assert.match(fn, /!have\.has/)
})

// An empty shelf reads as a failure of the app rather than as an absence of
// films, and a shelf padded to look full is worse than either.
test('a shelf that cannot be filled honestly is removed', () => {
  const fn = fnBody('_renderVideoTab')
  assert.match(fn, /items\.length < \d+\) return _dropRow/)
  assert.match(RENDERER, /function _dropRow/)
})

// The label and the line beneath it live beside the query that justifies them,
// so the copy cannot drift away from what the shelf actually returns.
test('the curatorial line arrives with the results', () => {
  assert.match(RENDERER, /function _setRowHead/)
  assert.match(RENDERER, /_setRowHead\(row\.key, res\.shelf\)/)
  assert.match(RENDERER, /vrow-note/)
})

// ── Opening a shelf out ─────────────────────────────────────────────────────
// A rail is a preview, not a ceiling: it shows twenty and the canon runs to a
// thousand. The whole point of curating a shelf is that there is more behind it
// than fits on one screen.
test('a curated shelf can be opened out', () => {
  assert.match(RENDERER, /data-shelf-all=/)
  assert.match(RENDERER, /function renderShelf/)
  assert.match(RENDERER, /page === 'shelf'\)\s*renderShelf/)
})

// The buttons appear as each shelf's results arrive, so binding them once per
// page beats binding them per shelf and missing the ones that land late.
test('the expanders are bound by delegation', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _bindShelfExpanders'),
    RENDERER.indexOf('function _setRowHead'))
  assert.match(fn, /closest\('\[data-shelf-all\]'\)/)
  assert.match(fn, /shelfAllBound/, 'binding twice would navigate twice on one click')
})

// The catalogue repeats titles across page boundaries often enough that
// appending blindly shows the same poster twice in one grid.
test('paging in more films cannot repeat one already shown', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _loadShelfPage'),
    RENDERER.indexOf('function _bindShelfScroll'))
  assert.match(fn, /const have = new Set/)
  assert.match(fn, /!have\.has/)
  // And a page that arrives after the user opened a different shelf must not
  // append itself to whatever is on screen now.
  assert.match(fn, /_shelfPage\.ticket !== ticket/)
})

test('the next page loads on approach rather than on a button press', () => {
  assert.match(RENDERER, /function _bindShelfScroll/)
  const fn = RENDERER.slice(RENDERER.indexOf('function _bindShelfScroll'))
  assert.match(fn.slice(0, 700), /new IntersectionObserver/)
  assert.match(fn.slice(0, 700), /rootMargin: '600px'/)
})

// ── Filtering by country ────────────────────────────────────────────────────
// "Watch any film from any country" means the whole list, not a curated
// shortlist — there are 251 and the interesting ones are not always the obvious
// ones.
test('browse can filter by where a film was made', () => {
  assert.match(RENDERER, /id="vf-countries"/)
  assert.match(RENDERER, /id="vf-countrysearch"/)
  assert.match(RENDERER, /function _countryChipsHtml/)
  const MAIN = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(MAIN, /ipcMain\.handle\('video-countries'/)
})

// Country of production is not the same question as language: a French-language
// Canadian film is Canadian.
test('the filter asks about origin, not language', () => {
  const TMDB = require('fs').readFileSync(require('path').join(__dirname, '..', 'catalog', 'tmdb.js'), 'utf8')
  assert.match(TMDB, /push\('with_origin_country', opts\.country\)/)
  assert.match(RENDERER, /country: f\.country/)
})

// Someone who wants Iranian cinema should not have to know Iran is in the list
// before they can find out.
test('the major film countries are offered without typing', () => {
  const list = /_COUNTRY_SHORTLIST = \[([\s\S]*?)\]/.exec(RENDERER)
  assert.ok(list, 'a shortlist must exist')
  for (const code of ['IR', 'JP', 'KR', 'FR', 'IT', 'IN', 'TW', 'HK']) {
    assert.ok(list[1].includes("'" + code + "'"), code + ' belongs on the shortlist')
  }
})

// The origin filter is an AND, so asking for two countries asks for films made
// in both and returns almost nothing.
test('one country at a time, and choosing it again clears it', () => {
  const fn = RENDERER.slice(RENDERER.indexOf("getElementById('vf-countries')"),
    RENDERER.indexOf("getElementById('vf-sort')"))
  assert.match(fn, /f\.country === code \? null : code/)
})

// A country chosen and then not on the shortlist would otherwise have to be
// searched for again before it could be cleared.
test('a chosen country stays visible when the search is cleared', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _countryChipsHtml'),
    RENDERER.indexOf('function _tagChipsHtml'))
  assert.match(fn, /if \(chosen && !rank\[chosen\]\)/)
})

// AniList has no country of origin, so offering the filter there would be a
// control that silently does nothing.
test('the country list is not fetched for the catalog that cannot use it', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _loadBrowseVocab'),
    RENDERER.indexOf('function _renderFilterRail'))
  assert.match(fn, /catalog !== 'anime' && !_browseVocab\.countries/)
})

// ── Fix 1b: honest empty-state during an AniList outage ──────────────────────
// An anime shelf that comes back empty BECAUSE AniList is down must say so and
// offer a retry — never "Nothing here right now", which is a lie about a
// healthy-but-empty result. These pin the renderer's outage branch.

test('the catalog-row loader distinguishes an outage-empty from a plain empty', () => {
  // The empty branch must check res.outage before falling through to "Nothing
  // here right now", so an outage never reads as a healthy empty shelf. Anchored
  // on the catalog-row loader specifically (its "Nothing here right now" copy).
  const nh = RENDERER.indexOf("_rowEmpty(row.key, 'Nothing here right now')")
  assert.ok(nh > -1, 'the catalog-row empty copy must exist')
  const at = RENDERER.lastIndexOf('if (!items.length) {', nh)
  assert.ok(at > -1, 'the empty-row branch must exist')
  const branch = RENDERER.slice(at, nh + 60)
  assert.match(branch, /if \(res\.outage\) return _rowOutage\(row\.key, res\.outage\)/,
    'an outage takes the honest _rowOutage path')
  assert.match(branch, /_rowEmpty\(row\.key, 'Nothing here right now'\)/,
    '"Nothing here" survives only for a genuine healthy-but-empty result')
})

test('a fromCache row renders content and pins the saved-list note', () => {
  assert.match(RENDERER, /if \(res\.fromCache\) _rowCacheNote\(row\.key\)/,
    'saved content renders normally, with a note that it may be stale')
})

test('_rowOutage says AniList is down, carries its message, and offers a retry', () => {
  const fn = fnBody('_rowOutage')
  // The wording lives in _anilistOutageText (R19): per status, in words.
  assert.match(fn, /const note = _anilistOutageText\(message\)/, 'the message names the real cause, in words')
  assert.match(fn, /data-retry="/, 'a retry button is offered, like the This-Season path')
  assert.match(fn, /_renderVideoTab\(\+\+_videoCatalogTicket\)/, 'retry re-runs the tab')
})

test('_rowCacheNote admits the shelf is showing a saved list', () => {
  const fn = fnBody('_rowCacheNote')
  assert.match(fn, /showing saved list — AniList is down/)
  assert.match(fn, /vrow-cache-note/, 'the note is de-duplicated by its own class')
})

test('the Browse grid treats an outage as down, not as a too-narrow filter', () => {
  const at = RENDERER.indexOf('if (!_browse.results.length) {')
  assert.ok(at > -1, 'the empty-grid branch must exist')
  const branch = RENDERER.slice(at, at + 700)
  assert.match(branch, /if \(res\.outage\) \{/, 'an outage is handled before _browseEmptyHtml')
  assert.match(branch, /AniList is temporarily down/, 'and says AniList is down, not "nothing matches"')
})
