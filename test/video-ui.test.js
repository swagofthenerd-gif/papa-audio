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

test('index.html declares the video playback panel', () => {
  assert.match(HTML, /id="video-panel"/, 'the mpv surface mounts in this panel')
})

test('renderer.js defines the catalog and detail renders', () => {
  assert.match(RENDERER, /function renderVideo\b/, 'catalog view')
  assert.match(RENDERER, /function renderVideoDetail\b/, 'detail view')
})

test('renderer.js wires the router to the video pages', () => {
  assert.match(RENDERER, /page === 'video'\)\s*renderVideo\(\)/)
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
test('every catalog row the backend serves is used', () => {
  const block = RENDERER.slice(RENDERER.indexOf('var _videoRows = ['), RENDERER.indexOf('var _videoTabs'))
  for (const key of ['trending-movies', 'popular-movies', 'trending-tv', 'popular-tv',
                     'trending-anime', 'popular-anime', 'season-anime']) {
    assert.ok(block.includes(key), `row ${key} is served by the backend but never requested`)
  }
})

// videoSearch was fully implemented in main and preload and called by nothing.
test('the search box exists and is wired to videoSearch', () => {
  assert.match(RENDERER, /id="video-search-input"/, 'there must be a search input')
  assert.match(RENDERER, /window\.api\.videoSearch\(/, 'and it must call the search API')
  const body = fnBody('_bindVideoSearch')
  assert.match(body, /setTimeout\(run, 300\)/, 'typing must be debounced')
  assert.match(body, /_videoSearchTicket !== ticket/, 'a slow earlier query must not win')
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
  const body = fnBody('_bindVideoSearch')
  assert.match(body, /Films/)
  assert.match(body, /Series/)
  assert.match(body, /Anime/)
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
