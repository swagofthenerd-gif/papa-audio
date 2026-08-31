'use strict';
// The three features that had no implementation at all: director in focus (3),
// recommendations from taste (34), and hide what you have seen (35). The last
// two only became possible once the taste store was reachable.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
const shelves = require(path.join(ROOT, 'catalog', 'shelves.js'))
const { createTasteStore, _memoryStorage } = require(path.join(ROOT, 'src', 'taste-store.js'))

// ── 3. Director in focus ───────────────────────────────────────────────────

test('the rotation holds names, not person ids', () => {
  // The plan's own rule is that a shelf query is tuned against the live API and
  // never by reasoning — and a TMDB person id is exactly what cannot be
  // reasoned about. A wrong id does not fail loudly; it builds a confident
  // shelf of the wrong person's films.
  assert.ok(Array.isArray(shelves.FOCUS_DIRECTORS))
  assert.ok(shelves.FOCUS_DIRECTORS.length >= 12, 'a rotation of ' + shelves.FOCUS_DIRECTORS.length)
  for (const name of shelves.FOCUS_DIRECTORS) {
    assert.strictEqual(typeof name, 'string')
    assert.ok(!/^\d+$/.test(name), name + ' looks like an id')
    assert.ok(name.trim().length > 3, 'suspiciously short: ' + name)
  }
  assert.strictEqual(new Set(shelves.FOCUS_DIRECTORS).size, shelves.FOCUS_DIRECTORS.length,
    'a duplicate would come up twice as often')
})

test('the director of the day is stable within a day and moves between days', () => {
  const day = 86400000
  const t = 1_800_000_000_000
  assert.strictEqual(shelves.directorOfTheDay(t), shelves.directorOfTheDay(t + 1000))
  // Over a full cycle every name comes up exactly once.
  const seen = []
  for (let i = 0; i < shelves.FOCUS_DIRECTORS.length; i++) {
    seen.push(shelves.directorOfTheDay(t + i * day))
  }
  assert.strictEqual(new Set(seen).size, shelves.FOCUS_DIRECTORS.length)
})

test('the rotation survives nonsense input', () => {
  for (const bad of [null, undefined, NaN, 'yesterday', -86400000]) {
    const out = shelves.directorOfTheDay(bad)
    assert.ok(shelves.FOCUS_DIRECTORS.includes(out), String(bad) + ' gave ' + out)
  }
})

test('a name that does not resolve produces no shelf', () => {
  // The same rule the movement shelves follow: a shelf that cannot be filled
  // honestly is not shown.
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-shelf'"),
                       MAIN.indexOf('function _shelfDefinition'))
  assert.match(h, /if \(!id\) return \{ ok: false, error: `Could not find \$\{name\} on TMDB` \}/)
})

test('the person lookup prefers an exact name match over the top hit', () => {
  // Searching a director's name can rank an actor of the same name first.
  const fn = MAIN.slice(MAIN.indexOf('async function _resolvePersonId'),
                        MAIN.indexOf("ipcMain.handle('video-taste-shelf'"))
  assert.match(fn, /String\(p\.name \|\| ''\)\.toLowerCase\(\) === name\.toLowerCase\(\)/)
  assert.match(fn, /const pick = exact \|\| list\[0\] \|\| null/)
  // A null is cached too: a name TMDB does not know will not start knowing it.
  assert.match(fn, /_personIdCache\.set\(name, id\)/)
})

test('the shelf is asked for by the home page and resolvable', () => {
  assert.match(RENDERER, /\{ key: 'director-of-the-day' \}/)
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-shelf'"), MAIN.indexOf('function _shelfDefinition'))
  assert.match(h, /director-of-the-day/)
  // And the concrete key it becomes is resolvable.
  const resolver = MAIN.slice(MAIN.indexOf('function _shelfDefinition'))
  assert.match(resolver, /\^director-\(\\d\+\)\$/)
})

test('the shelf is labelled with the name, not the id', () => {
  const def = shelves.directorInFocus(5026, 'Akira Kurosawa')
  assert.match(def.label, /Akira Kurosawa/)
  assert.match(def.url, /with_crew=5026/)
  // No name means no shelf, or the heading reads "Director in Focus: undefined".
  assert.strictEqual(shelves.directorInFocus(5026, ''), null)
  assert.strictEqual(shelves.directorInFocus(null, 'Someone'), null)
})

// ── 34. Recommendations from taste ─────────────────────────────────────────

test('the taste shelf is exposed and asks main, not the store', () => {
  assert.match(PRELOAD, /videoTasteShelf:\s*\(p\) => ipcRenderer\.invoke\('video-taste-shelf', p\)/)
  assert.match(RENDERER, /window\.api\.videoTasteShelf\(\{/)
  // Conclusions, not history: sending the diary would put taste logic in two
  // places.
  const call = RENDERER.slice(RENDERER.indexOf('window.api.videoTasteShelf({'),
                              RENDERER.indexOf('window.api.videoTasteShelf({') + 200)
  assert.match(call, /director: sig\.director/)
  assert.doesNotMatch(call, /diary|entries/)
})

test('an empty history is not a failure', () => {
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-taste-shelf'"),
                       MAIN.indexOf("ipcMain.handle('video-shelf'"))
  assert.match(h, /if \(!director && !decade && !country\)/)
  assert.match(h, /ok: true, results: \[\], reason: null, empty: 'not-enough-history'/)
})

test('one signal is used, not all three intersected', () => {
  // Kurosawa AND the 1950s AND Japan is Kurosawa's 1950s films, which someone
  // with that taste has by definition already seen.
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-taste-shelf'"),
                       MAIN.indexOf("ipcMain.handle('video-shelf'"))
  assert.match(h, /if \(!params && decade\)/, 'decade is a fallback, not an addition')
  assert.match(h, /if \(!params && country\)/)
})

test('the recommendation says why', () => {
  // The difference between a recommendation and a row of posters.
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-taste-shelf'"),
                       MAIN.indexOf("ipcMain.handle('video-shelf'"))
  assert.match(h, /reason = 'You keep coming back to ' \+ director/)
  assert.match(h, /reason = 'More from the ' \+ start \+ 's'/)
  assert.match(RENDERER, /res\.reason \|\| 'From your diary'/)
})

test('the results are normalised before the quality filter, like every other shelf', () => {
  // isLowQualityForFilmShelf reads normalised genre ids, so filtering raw TMDB
  // results would silently pass everything.
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-taste-shelf'"),
                       MAIN.indexOf("ipcMain.handle('video-shelf'"))
  const mapAt = h.indexOf('normalizeMovie')
  const filterAt = h.indexOf('isLowQualityForFilmShelf')
  assert.ok(mapAt > 0 && filterAt > mapAt, 'normalise must come first')
})

test('a short diary shows a count rather than an empty promise', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _renderTasteRow'),
                            RENDERER.indexOf('// ── Hide what you have seen'))
  assert.match(fn, /if \(!sig\.enough\)/)
  assert.match(fn, /films logged/)
  assert.match(fn, /This fills in at ' \+ TASTE_ROW_MIN_TITLES/)
  // And nothing at all when there is nothing at all.
  assert.match(fn, /: ''/)
})

test('the language name is only turned into a code when it is known', () => {
  // The diary stores "Japanese"; discover wants "ja". A guessed code returns a
  // confident shelf of the wrong cinema.
  const from = RENDERER.indexOf('const TASTE_LANGUAGE_CODES')
  const to = RENDERER.indexOf('async function _renderTasteRow')
  // eslint-disable-next-line no-new-func
  const { _tasteLanguageCode } = new Function(RENDERER.slice(from, to) + '; return { _tasteLanguageCode }')()
  assert.strictEqual(_tasteLanguageCode([{ name: 'Japanese' }]), 'ja')
  assert.strictEqual(_tasteLanguageCode([{ name: 'korean' }]), 'ko')
  assert.strictEqual(_tasteLanguageCode([{ name: 'ja' }]), 'ja', 'already a code')
  assert.strictEqual(_tasteLanguageCode([{ name: 'Klingon' }]), null, 'an unknown must not be guessed')
  assert.strictEqual(_tasteLanguageCode([]), null)
  assert.strictEqual(_tasteLanguageCode(null), null)
  // It walks past an unknown to a known one rather than giving up on the first.
  assert.strictEqual(_tasteLanguageCode([{ name: 'Klingon' }, { name: 'Italian' }]), 'it')
})

test('the row is only offered on the film tabs', () => {
  // The recommendation is built from a film diary; offering it above TV or
  // anime would answer a different question.
  const fn = RENDERER.slice(RENDERER.indexOf('const tasteRow = document.getElementById'),
                            RENDERER.indexOf('const wanted = _videoRows.filter'))
  assert.match(fn, /_videoTab === 'all' \|\| _videoTab === 'movie'/)
  assert.match(fn, /else tasteRow\.innerHTML = ''/)
})

test('the signals come from the store, using the diary metadata', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _tasteSignals'),
                            RENDERER.indexOf('// The diary stores whatever the detail page gave it'))
  assert.match(fn, /store\.profile\(meta\)/)
  assert.match(fn, /_tasteMetaMap\(\)/)
  assert.match(fn, /p\.titles < TASTE_ROW_MIN_TITLES/)
})

test('a real diary produces real signals', () => {
  // End to end through the store: the thing the row depends on.
  const store = createTasteStore({ storage: _memoryStorage(), now: (() => { let t = 1e12; return () => (t += 1000) })() })
  const meta = {}
  const log = (key, title, year, director, lang) => {
    meta[key] = { title, year, runtime: 120, directors: [director], languages: [lang], countries: ['Japan'] }
    store.logViewing(key, { date: '2024-01-01', meta: meta[key] })
  }
  log('movie:1', 'Ikiru', 1952, 'Akira Kurosawa', 'Japanese')
  log('movie:2', 'Ran', 1985, 'Akira Kurosawa', 'Japanese')
  log('movie:3', 'Tokyo Story', 1953, 'Yasujiro Ozu', 'Japanese')
  log('movie:4', 'Late Spring', 1949, 'Yasujiro Ozu', 'Japanese')
  log('movie:5', 'Seven Samurai', 1954, 'Akira Kurosawa', 'Japanese')

  const p = store.profile(meta)
  assert.strictEqual(p.titles, 5)
  assert.strictEqual(p.topDirectors[0].name, 'Akira Kurosawa', 'three films beats two')
  assert.strictEqual(p.decades[0].name, 1950, 'three of the five are 1950s')
  assert.strictEqual(p.topLanguages[0].name, 'Japanese')
})

// ── 35. Hide what you have seen ────────────────────────────────────────────

test('the filter is off by default, because a new user has seen nothing', () => {
  // A toggle that appears to do nothing is worse than no toggle.
  const fn = RENDERER.slice(RENDERER.indexOf('const HIDE_SEEN_KEY'),
                            RENDERER.indexOf('function _cardKey'))
  assert.match(RENDERER, /var _hideSeen = false/)
  assert.match(fn, /localStorage\.getItem\(HIDE_SEEN_KEY\) === '1'/)
})

test('a hidden card is counted out loud', () => {
  // A grid that silently drops rows reads as a broken query.
  // _hideSeen is module state, so it is injected rather than sliced.
  const to = RENDERER.indexOf('// ── Sorting a loaded grid')
  // eslint-disable-next-line no-new-func
  const mod = new Function('window', '_hideSeen',
    RENDERER.slice(RENDERER.indexOf('function _cardKey'), to) +
    '; return { _hideSeenApply, _hideSeenNote, _cardKey }')
  const seen = new Set(['movie:2'])
  const world = { PapaTasteStore: { hasSeen: k => seen.has(k) } }

  // Off: nothing is filtered, whatever has been seen.
  const off = mod(world, false)
  assert.strictEqual(off._hideSeenApply([{ id: 1 }, { id: 2 }]).hidden, 0)
  assert.strictEqual(off._hideSeenApply([{ id: 1 }, { id: 2 }]).shown.length, 2)

  // On: the seen one goes, and is counted.
  const api = mod(world, true)
  const res = api._hideSeenApply([{ id: 1 }, { id: 2 }, { id: 3 }])
  assert.strictEqual(res.hidden, 1)
  assert.deepStrictEqual(res.shown.map(x => x.id), [1, 3])
  // A missing store must not filter everything away.
  const noStore = mod({}, true)
  assert.strictEqual(noStore._hideSeenApply([{ id: 1 }]).shown.length, 1)
  // Non-arrays are survivable.
  assert.deepStrictEqual(api._hideSeenApply(null).shown, [])
  assert.match(api._hideSeenNote(1), /1 title you have seen is hidden/)
  assert.match(api._hideSeenNote(3), /3 titles you have seen are hidden/)
  assert.strictEqual(api._hideSeenNote(0), '', 'nothing hidden says nothing')
})

test('the card key is the same shape the diary stores', () => {
  // Otherwise "seen" here and "seen" in the diary disagree.
  const from = RENDERER.indexOf('function _cardKey')
  // eslint-disable-next-line no-new-func
  const { _cardKey } = new Function(RENDERER.slice(from, RENDERER.indexOf('function _hideSeenApply')) +
    '; return { _cardKey }')()
  assert.strictEqual(_cardKey({ type: 'movie', id: 238 }), 'movie:238')
  assert.strictEqual(_cardKey({ id: 238 }), 'movie:238', 'movie is the default type')
  assert.strictEqual(_cardKey({ type: 'tv', id: 1396 }), 'tv:1396')
  assert.strictEqual(_cardKey(null), '')
})

test('toggling repaints instead of refetching', () => {
  // What you have watched is not part of the query; asking TMDB again for the
  // same page to apply a local filter would be a request for nothing.
  assert.match(RENDERER, /function _paintBrowseGrid\(\)/)
  const bind = RENDERER.slice(RENDERER.indexOf("getElementById('vbrowse-hide-seen')"),
                              RENDERER.indexOf("getElementById('vbrowse-hide-seen')") + 260)
  assert.match(bind, /_paintBrowseGrid\(\)/)
  assert.doesNotMatch(bind, /_fetchBrowse|_runBrowse/)
})

test('both grids offer the toggle and both honour it', () => {
  assert.match(RENDERER, /_hideSeenToggleHtml\('vbrowse-hide-seen'\)/)
  assert.match(RENDERER, /_hideSeenToggleHtml\('vshelf-hide-seen'\)/)
  const paint = RENDERER.slice(RENDERER.indexOf('function _paintBrowseGrid'),
                               RENDERER.indexOf('function _vGridSkeleton'))
  assert.match(paint, /_hideSeenApply\(_browse\.results\)/)
  const shelf = RENDERER.slice(RENDERER.indexOf('function _repaintShelfGrid'),
                               RENDERER.indexOf('// Loads the next page as the end'))
  assert.match(shelf, /_hideSeenApply\(sorted\)/)
})

test('the diary and a filmography are never filtered', () => {
  // Their whole point is the films you have seen.
  const diary = RENDERER.slice(RENDERER.indexOf('function _renderDiaryBody'),
                               RENDERER.indexOf('// A diary row names a film'))
  assert.doesNotMatch(diary, /_hideSeenApply/)
  const person = RENDERER.slice(RENDERER.indexOf('function _paintPersonRows'),
                                RENDERER.indexOf('// The name and photo of the person just clicked'))
  assert.doesNotMatch(person, /_hideSeenApply/)
})

test('the toggle is styled and the note reads as an aside', () => {
  assert.match(CSS, /\.cinema \.vhide-seen \{/)
  assert.match(CSS, /\.cinema \.vhide-seen-note \{/)
  assert.match(CSS, /grid-column: 1 \/ -1/, 'the note must span the grid, not sit in a cell')
})

// ── the metadata map, memoised ─────────────────────────────────────────────

test('the metadata map is built once per render, not once per row', () => {
  // labelFor is called once per diary row and four times per favourite, and the
  // first version rebuilt the whole map on every call: a diary of N entries did
  // N walks of N entries to render N rows. Measured at 1200 rows, 100ms became
  // 1ms.
  const from = RENDERER.indexOf('var _tasteMetaCache')
  const to = RENDERER.indexOf('function _tasteLabelFor')
  assert.ok(from > 0 && to > from, 'found the memo')
  const store = { calls: 0, diary: [] }
  const world = {
    PapaTasteStore: {
      diary() { store.calls++; return store.diary },
    },
  }
  // eslint-disable-next-line no-new-func
  const api = new Function('window', RENDERER.slice(from, to) +
    '; return { _tasteMetaMap, _invalidateTasteMeta }')(world)

  store.diary = [
    { key: 'movie:1', meta: { title: 'Ikiru' } },
    { key: 'movie:2', meta: { title: 'Ran' } },
  ]
  const first = api._tasteMetaMap()
  assert.strictEqual(first['movie:1'].title, 'Ikiru')
  const callsAfterFirst = store.calls
  // Ten more reads must not rebuild.
  for (let i = 0; i < 10; i++) api._tasteMetaMap()
  assert.strictEqual(api._tasteMetaMap(), first, 'the same object is returned')
  // diary() is still consulted each time (to compare the length), but the map
  // is not rebuilt — which is what the identity check above proves.
  assert.ok(store.calls > callsAfterFirst, 'the length is still checked')
})

test('a new entry invalidates the map by length alone', () => {
  // The backstop: a write that bypassed _onTasteChange is still noticed.
  const from = RENDERER.indexOf('var _tasteMetaCache')
  const to = RENDERER.indexOf('function _tasteLabelFor')
  const store = { diary: [{ key: 'movie:1', meta: { title: 'Ikiru' } }] }
  const world = { PapaTasteStore: { diary: () => store.diary } }
  // eslint-disable-next-line no-new-func
  const api = new Function('window', RENDERER.slice(from, to) +
    '; return { _tasteMetaMap, _invalidateTasteMeta }')(world)

  assert.strictEqual(Object.keys(api._tasteMetaMap()).length, 1)
  store.diary = store.diary.concat({ key: 'movie:2', meta: { title: 'Ran' } })
  assert.strictEqual(Object.keys(api._tasteMetaMap()).length, 2, 'a longer diary rebuilt')
})

test('an edit that does not change the length still invalidates', () => {
  // Correcting a note or a date leaves the count identical, so length alone
  // would serve a stale title forever. This is why both mechanisms exist.
  const from = RENDERER.indexOf('var _tasteMetaCache')
  const to = RENDERER.indexOf('function _tasteLabelFor')
  const store = { diary: [{ key: 'movie:1', meta: { title: 'Ikiru' } }] }
  const world = { PapaTasteStore: { diary: () => store.diary } }
  // eslint-disable-next-line no-new-func
  const api = new Function('window', RENDERER.slice(from, to) +
    '; return { _tasteMetaMap, _invalidateTasteMeta }')(world)

  assert.strictEqual(api._tasteMetaMap()['movie:1'].title, 'Ikiru')
  store.diary = [{ key: 'movie:1', meta: { title: 'Ikiru (1952)' } }]
  assert.strictEqual(api._tasteMetaMap()['movie:1'].title, 'Ikiru', 'same length, cache held')
  api._invalidateTasteMeta()
  assert.strictEqual(api._tasteMetaMap()['movie:1'].title, 'Ikiru (1952)', 'explicit invalidation works')
})

test('every mutation invalidates before anything reads', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _onTasteChange'),
                            RENDERER.indexOf('var _browseTasteDirty'))
  assert.match(fn, /_invalidateTasteMeta\(\)/)
  // First line of the handler, before either page repaints.
  assert.ok(fn.indexOf('_invalidateTasteMeta()') < fn.indexOf('_renderDiaryBody'),
    'the map must be invalidated before a repaint reads it')
})

test('a later snapshot still wins after memoising', () => {
  // The ordering the map exists for: metadata improves as TMDB fills in, so the
  // most recent sitting has the best version.
  const from = RENDERER.indexOf('var _tasteMetaCache')
  const to = RENDERER.indexOf('function _tasteLabelFor')
  const world = {
    PapaTasteStore: {
      diary: () => [
        // diary() returns newest first.
        { key: 'movie:1', meta: { title: 'Ikiru', year: 1952 } },
        { key: 'movie:1', meta: { title: 'Ikiru' } },
      ],
    },
  }
  // eslint-disable-next-line no-new-func
  const api = new Function('window', RENDERER.slice(from, to) + '; return { _tasteMetaMap }')(world)
  assert.strictEqual(api._tasteMetaMap()['movie:1'].year, 1952, 'the newest snapshot won')
})
