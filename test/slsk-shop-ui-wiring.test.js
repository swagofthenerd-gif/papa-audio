// Structural guards for the Soulseek UI perfection pass. renderer.js can't be
// imported in Node (it touches window/DOM at load), so — like slsk-card-index —
// these assert the source keeps the invariants the features depend on.
//
// Roadmap #62 structural split: the user-library explorer + record shop moved
// out to src/slsk-shop-ui.js. The search-results side (renderSoulseekRow,
// bindSlskSearchEvents, the merge-by-album path, the group-by-uploader toggle,
// the pre-search invite) stays in renderer.js. So these guards read BOTH files
// and slice from whichever now owns each region — CODE for the renderer side,
// SHOP for the shop module.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(__dirname, '../src/slsk-shop-ui.js'), 'utf8')

function sliceIn(code, from, toMarker) {
  const s = code.indexOf(from)
  assert.ok(s > -1, `expected to find: ${from}`)
  const e = code.indexOf(toMarker, s + from.length)
  return code.slice(s, e > -1 ? e : code.length)
}
// The renderer-side slice, unchanged in spirit from before the split.
function slice(from, toMarker) { return sliceIn(CODE, from, toMarker) }
// The shop-module slice, for the regions that moved to slsk-shop-ui.js.
function sliceShop(from, toMarker) { return sliceIn(SHOP, from, toMarker) }

// ── Task 1: merge people per album ────────────────────────────────────────────
test('search results merge sources by album by default', () => {
  const fn = slice('function renderSoulseekRow(', '\nfunction _buildSearchVariants')
  assert.match(fn, /mergeSourcesByAlbum/, 'renderSoulseekRow must merge sources into albums')
  assert.match(fn, /const merged = !slsk\.groupByUploader/,
    'merged is the default; the toggle is the escape hatch')
  // data-gi still indexes exactly what was rendered.
  assert.match(fn, /_slskRendered = displayList/)
  assert.match(fn, /_slskMergedCardHtml\(g, gi, query\)/,
    'merged units render through the merged card')
})

test('group-by-uploader toggle is persisted', () => {
  assert.match(CODE, /localStorage\.setItem\('slsk_group_by_uploader'/,
    'the escape toggle must persist')
  assert.match(CODE, /localStorage\.getItem\('slsk_group_by_uploader'\)/,
    'and be restored on load')
})

test('merged card handlers unwrap to the best source', () => {
  const fn = slice('function bindSlskSearchEvents(', '\n// ── Soulseek user library')
  assert.match(fn, /const _slskUnit = /, 'a unit resolver that unwraps merged albums')
  assert.match(fn, /u\.best \|\| u\.sources\[0\]/, 'unwrap uses the album best source')
  assert.match(fn, /slsk-sources-btn/, 'the sources expander is wired')
})

// ── Task 2: grab all upgrades ─────────────────────────────────────────────────
test('the shop offers a Grab-all-upgrades batch action', () => {
  assert.match(SHOP, /slsh-grab-all/, 'the button exists')
  assert.match(SHOP, /function shBindGrabAll\(\)/, 'and is wired')
  const fn = sliceShop('function shBindGrabAll()', '\n  function renderShelvesSearch')
  assert.match(fn, /_mgConfirm\(/, 'confirm dialog reuses the _mgConfirm pattern')
  assert.match(fn, /_slskEnqueue\(/, 'enqueues via the shared path')
  assert.match(fn, /shTrackProgress\(a\)/, 'shows per-card inline progress')
  assert.match(fn, /showSnackbar\(/, 'and a snackbar summary')
})

// ── Task 3: shelf sort/filter ─────────────────────────────────────────────────
test('the shop has a sort/filter control row applied to the grid and search', () => {
  assert.match(SHOP, /function shControlsHtml\(\)/)
  assert.match(SHOP, /applyShelfFilterSort/, 'controls apply the shelf filter/sort')
  // Applied to BOTH the Everything grid and search-within-library.
  const grid = sliceShop('function shRenderGrid()', '\n  function shBindShelfControls')
  assert.match(grid, /applyShelfFilterSort/)
  const search = sliceShop('function renderShelvesSearch()', '\n  function bindShHero')
  assert.match(search, /applyShelfFilterSort/)
})

// ── Task 4: keyboard nav ──────────────────────────────────────────────────────
test('shop keyboard nav is a single delegated keydown, grid-aware', () => {
  // One document-level keydown for the whole shop modal (onKey), not per-card.
  const fn = sliceShop('function shMoveCardFocus(', '\n  dlg.querySelector')
  assert.match(fn, /getBoundingClientRect/, 'up/down are grid-aware via geometry')
  const onkey = sliceShop('function onKey(e) {', '\n  document.addEventListener')
  assert.match(onkey, /shMoveCardFocus\(e\)/, 'arrows move the focus ring')
  assert.match(onkey, /shCardAction\(card, '\.slsh-play'\)/, 'Enter = play')
  assert.match(onkey, /shCardAction\(card, '\.slsh-dl'\)/, 'D = download')
  assert.match(onkey, /e\.ctrlKey \|\| e\.metaKey.*return/s,
    'must not fight the app global chords')
  assert.match(onkey, /typing.*return/s, 'must not fight text entry')
})

// ── Task 5: real cover art ────────────────────────────────────────────────────
test('shop cover art lazy-loads visible cards via the art-by-name IPC', () => {
  assert.match(SHOP, /const ART_IPC = !!\(window\.api && window\.api\.fetchAlbumArt\)/,
    'feature-detects the existing art IPC')
  assert.match(SHOP, /new IntersectionObserver/, 'only visible cards fetch')
  assert.match(SHOP, /const SH_ART_MAX = 3/, 'small concurrency cap')
  assert.match(SHOP, /const shArtCache = new Map\(\)/, 'in-memory per-session cache')
})

// ── Task 6: polish ────────────────────────────────────────────────────────────
test('hub Results pre-search state invites rather than reporting a failure', () => {
  assert.match(CODE, /Search the network for an album or artist…/,
    'pre-search invite copy')
  const fn = slice('function renderSoulseekRow(', '\nfunction _buildSearchVariants')
  assert.match(fn, /if \(!slsk\.searched\) \{/, 'invite only before a search has run')
})

test('shop hero shows cache provenance when the browse is cached', () => {
  assert.match(SHOP, /shFromCache = !!res\.fromCache/, 'captures fromCache defensively')
  assert.match(SHOP, /from cache/, 'and shows it in the hero')
  assert.match(SHOP, /Updated just now/, 'with a pulse after a background refresh')
})

test('seamless background refresh is feature-detected', () => {
  assert.match(SHOP, /typeof window\.api\.onSlskBrowseRefreshed === 'function'/,
    'engine event is feature-detected, never assumed')
  assert.match(SHOP, /buildFromTree\(\{ refresh: true \}\)/,
    'a refresh rebuilds preserving state')
})

test('the app-wide size formatter is used in the shop hero (no 4-digit units)', () => {
  assert.match(SHOP, /function shFmtSize\(n\) \{ return \(SH && SH\.fmtSize\)/,
    'shop hero uses the TB-aware module formatter')
})
