'use strict';
// The film diary: ratings, viewings, favourites and hand-made lists, kept in one
// persisted blob behind a synchronous namespace the UI reads directly.
//
// Schema:
//   { version: 1,
//     ratings:    { "movie:27205": { value: 4.5, updatedAt } },
//     diary:      [ { id, key, date: "YYYY-MM-DD", rewatch, note, rating,
//                     meta, loggedAt } ],
//     favourites: [ "movie:27205", … ]            // max 4, ordered
//     lists:      [ { id, name, createdAt, updatedAt,
//                     entries: [ { key, note, addedAt } ] } ],
//     seen:       { "movie:27205": { at } } }     // watched elsewhere
//
// Keys are the ones _watchKey() in renderer.js already produces —
// "movie:<id>", "tv:<id>:s<season>e<episode>", "anime:<id>:e<episode>" — so a
// rating and a resume position describe the same thing without a translation
// table.
//
// A rating is per title; a viewing is per sitting. Watching the same film three
// times is three diary entries and one rating, which is why the diary is an
// append-only array and ratings are a map.
//
// This is the one store in the app holding data that cannot be re-derived from
// anywhere — a decade of diary entries has no upstream to re-fetch from. So:
// unknown fields are preserved verbatim on read and write (a newer build's
// columns survive a downgrade), migrations only ever add, and a blob that is
// corrupt or was half-written degrades to empty instead of throwing and taking
// the whole page down with it.
//
// Persistence goes through an injectable `storage` adapter ({ read, write }),
// same as video-store.js, so tests never touch real disk.
//
// UMD-wrapped so it loads both as a classic <script> in the renderer and via
// require() in tests, without leaking bindings into the shared renderer scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaTasteStore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const KEY = 'papa-taste-store'
  const VERSION = 1

  const MIN_RATING = 0.5
  const MAX_RATING = 5
  const MAX_FAVOURITES = 4

  function _empty() {
    return { version: VERSION, ratings: {}, diary: [], favourites: [], lists: [], seen: {} }
  }

  function _browserStorage() {
    return {
      read() {
        try {
          return (typeof window !== 'undefined' && window.PapaLocal)
            ? window.PapaLocal.readObject(KEY)
            : null
        } catch (_) { return null }
      },
      write(value) {
        try {
          if (typeof window !== 'undefined' && window.PapaLocal) return window.PapaLocal.write(KEY, value)
          return false
        } catch (_) { return false }
      },
    }
  }

  function _memoryStorage(seed) {
    let value = seed === undefined ? null : seed
    return {
      read: () => value,
      write: v => { value = v; return true },
      _dump: () => value,
    }
  }

  function _isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v)
  }

  // A rating is half stars from 0.5 to 5. Zero is not "unrated" — unrated is the
  // absence of a key, because a diary that cannot tell "I gave it nothing" from
  // "I never said" loses information.
  function isValidRating(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return false
    if (n < MIN_RATING || n > MAX_RATING) return false
    return Math.round(n * 2) === n * 2
  }

  // Dates are stored as calendar days, not instants: a viewing belongs to the
  // evening you had, not to a UTC offset that can shift it into yesterday.
  function normalizeDate(input) {
    if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input
    const d = input instanceof Date ? input : new Date(input)
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
    const pad = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function createTasteStore({ storage, now } = {}) {
    const backend = storage || (typeof window !== 'undefined' ? _browserStorage() : _memoryStorage())
    const clock = typeof now === 'function' ? now : () => Date.now()

    let cache = null
    let seq = 0

    // Diary lookups by key would be a scan per call, and the profile/year views
    // call them per title — that is the O(n²) at 10k entries. One lazily built
    // index, invalidated on append, keeps every read linear at worst.
    let byKey = null

    function load() {
      if (cache !== null) return cache
      cache = _sanitize(backend.read())
      return cache
    }
    function save() {
      backend.write(cache)
    }
    function invalidate() {
      byKey = null
    }

    // Every field is checked independently and only the broken ones are
    // replaced, so one bad list does not cost you the diary. Anything the schema
    // does not know about is carried through untouched.
    function _sanitize(raw) {
      const base = _empty()
      if (!_isPlainObject(raw)) return base
      const out = { ...raw, ...base }
      out.version = Number(raw.version) > 0 ? Number(raw.version) : VERSION
      if (_isPlainObject(raw.ratings)) {
        for (const [k, v] of Object.entries(raw.ratings)) {
          if (_isPlainObject(v) && isValidRating(v.value)) out.ratings[k] = { ...v, value: Number(v.value) }
        }
      }
      if (Array.isArray(raw.diary)) {
        out.diary = raw.diary.filter(e => _isPlainObject(e) && typeof e.key === 'string' && normalizeDate(e.date))
      }
      if (Array.isArray(raw.favourites)) {
        out.favourites = raw.favourites.filter(k => typeof k === 'string').slice(0, MAX_FAVOURITES)
      }
      if (Array.isArray(raw.lists)) {
        out.lists = raw.lists
          .filter(l => _isPlainObject(l) && typeof l.id === 'string')
          .map(l => ({ ...l, entries: Array.isArray(l.entries) ? l.entries.filter(e => _isPlainObject(e) && typeof e.key === 'string') : [] }))
      }
      if (_isPlainObject(raw.seen)) out.seen = { ...raw.seen }
      return out
    }

    function _id(prefix) {
      seq += 1
      return prefix + '-' + clock().toString(36) + '-' + seq.toString(36)
    }

    function _index() {
      if (byKey) return byKey
      byKey = new Map()
      for (const e of load().diary) {
        const bucket = byKey.get(e.key)
        if (bucket) bucket.push(e)
        else byKey.set(e.key, [e])
      }
      return byKey
    }

    // ---- ratings ----------------------------------------------------------

    // Returns the stored rating, or null when the value is not a half star in
    // range. Invalid input is refused rather than thrown: a mis-clicked star
    // must not be able to break a render.
    function rate(key, value) {
      if (typeof key !== 'string' || !key) return null
      if (!isValidRating(value)) return null
      const state = load()
      const prev = state.ratings[key] || {}
      const entry = { ...prev, value: Number(value), updatedAt: clock() }
      state.ratings[key] = entry
      save()
      return { ...entry }
    }

    function unrate(key) {
      const state = load()
      const prev = state.ratings[key]
      if (!prev) return null
      delete state.ratings[key]
      save()
      return { ...prev }
    }

    function ratingOf(key) {
      const r = load().ratings[key]
      return r ? r.value : null
    }

    // ---- diary ------------------------------------------------------------

    // Appends one viewing. `rewatch` defaults to whether this key has been
    // logged before, so the common case needs no argument and cannot disagree
    // with the log.
    function logViewing(key, opts) {
      if (typeof key !== 'string' || !key) return null
      const o = _isPlainObject(opts) ? opts : {}
      const date = normalizeDate(o.date === undefined ? clock() : o.date)
      if (!date) return null
      const state = load()
      const seenBefore = _index().has(key)
      const entry = {
        ...o,
        id: _id('d'),
        key,
        date,
        rewatch: typeof o.rewatch === 'boolean' ? o.rewatch : seenBefore,
        note: typeof o.note === 'string' ? o.note : null,
        rating: isValidRating(o.rating) ? Number(o.rating) : null,
        meta: _isPlainObject(o.meta) ? o.meta : null,
        loggedAt: clock(),
      }
      state.diary.push(entry)
      const bucket = byKey && byKey.get(key)
      if (bucket) bucket.push(entry)
      else if (byKey) byKey.set(key, [entry])
      // A rating supplied with a viewing is also the title's rating: the diary
      // records the sitting, the ratings map records the verdict.
      if (entry.rating !== null) rate(key, entry.rating)
      state.seen[key] = state.seen[key] || { at: clock() }
      save()
      return { ...entry }
    }

    // Watching happens mostly elsewhere — a cinema, someone's sofa, years ago.
    // Marking a title seen must never need a playback position.
    function markSeen(key, opts) {
      return logViewing(key, opts)
    }

    function diary(opts) {
      const o = _isPlainObject(opts) ? opts : {}
      let out = load().diary
      if (typeof o.key === 'string') out = _index().get(o.key) || []
      // A year filter, so a year view can ask the diary for a year instead of
      // fetching everything and slicing it -- which is what made the caller
      // reach past the panel and rebuild rows by hand.
      if (o.year !== undefined && o.year !== null) {
        const y = String(o.year)
        out = out.filter(e => String(e.date).slice(0, 4) === y)
      }
      out = out.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (Number(b.loggedAt) || 0) - (Number(a.loggedAt) || 0)))
      return typeof o.limit === 'number' && o.limit > 0 ? out.slice(0, o.limit) : out
    }

    function viewingsOf(key) {
      return (_index().get(key) || []).slice()
    }

    // Editing a note must not rewrite the viewing; only the note field moves.
    function setNote(id, note) {
      const entry = load().diary.find(e => e.id === id)
      if (!entry) return null
      entry.note = typeof note === 'string' ? note : null
      entry.editedAt = clock()
      save()
      return { ...entry }
    }

    // Destructive. Returns the removed entry so the caller can offer undo by
    // handing it straight back to restoreViewing() — a diary entry is typed by
    // hand and is not recoverable from anywhere else.
    function removeViewing(id) {
      const state = load()
      const idx = state.diary.findIndex(e => e.id === id)
      if (idx < 0) return null
      const [gone] = state.diary.splice(idx, 1)
      invalidate()
      // The seen flag is a shadow of the diary, and it used to outlive it: with
      // every viewing of a title deleted, hasSeen() still said yes, so the title
      // stayed hidden behind "hide watched" with nothing left to explain why and
      // no way to take it back.
      if (!(_index().get(gone.key) || []).length) delete state.seen[gone.key]
      save()
      return { ...gone }
    }

    function restoreViewing(entry) {
      if (!_isPlainObject(entry) || typeof entry.key !== 'string') return null
      const state = load()
      if (state.diary.some(e => e.id === entry.id)) return null
      state.diary.push({ ...entry })
      invalidate()
      // Restores the flag as well, or undoing the deletion of a last viewing
      // gives back the entry without giving back the watched state.
      state.seen[entry.key] = state.seen[entry.key] || { at: clock() }
      save()
      return { ...entry }
    }

    // Forgets a title completely: every viewing of it and the seen flag. The
    // rating is deliberately left alone — a verdict on a film survives deciding
    // you logged the evening by mistake.
    //
    // Returns what it removed so the caller can offer undo, which is the only
    // recovery there is for hand-typed entries.
    function unsee(key) {
      if (typeof key !== 'string' || !key) return null
      const state = load()
      const removed = (_index().get(key) || []).map(e => ({ ...e }))
      const hadFlag = !!state.seen[key]
      if (!removed.length && !hadFlag) return null
      state.diary = state.diary.filter(e => e.key !== key)
      delete state.seen[key]
      invalidate()
      save()
      return { key, viewings: removed, hadFlag }
    }

    // Hands back exactly what unsee() returned.
    function resee(removal) {
      if (!_isPlainObject(removal) || typeof removal.key !== 'string') return null
      const state = load()
      const list = Array.isArray(removal.viewings) ? removal.viewings : []
      for (const e of list) {
        if (!_isPlainObject(e) || state.diary.some(x => x.id === e.id)) continue
        state.diary.push({ ...e })
      }
      if (list.length || removal.hadFlag) {
        state.seen[removal.key] = state.seen[removal.key] || { at: clock() }
      }
      invalidate()
      save()
      return viewingsOf(removal.key)
    }

    // ---- correcting an entry ----------------------------------------------

    // A misremembered date and a wrongly-flagged rewatch were the two fields
    // that could not be corrected: only the note could move, so fixing either
    // meant delete-and-re-log, which loses the id the UI holds and any undo
    // token pointing at it.
    //
    // The id is deliberately preserved. Only the fields named in the patch move.
    function editViewing(id, patch) {
      const p = _isPlainObject(patch) ? patch : {}
      const state = load()
      const entry = state.diary.find(e => e.id === id)
      if (!entry) return null
      let touched = false
      if (p.date !== undefined) {
        const date = normalizeDate(p.date)
        // An unparseable date is refused outright rather than falling back to
        // today: silently moving a viewing to now is worse than not moving it.
        if (!date) return null
        if (date !== entry.date) { entry.date = date; touched = true }
      }
      if (p.rewatch !== undefined) {
        const flag = !!p.rewatch
        if (flag !== entry.rewatch) { entry.rewatch = flag; touched = true }
      }
      if (p.note !== undefined) {
        const note = typeof p.note === 'string' ? p.note : null
        if (note !== entry.note) { entry.note = note; touched = true }
      }
      if (p.rating !== undefined) {
        const r = isValidRating(p.rating) ? Number(p.rating) : null
        if (r !== entry.rating) { entry.rating = r; touched = true }
        // Same rule as logViewing: a rating attached to a sitting is also the
        // title's verdict.
        if (r !== null) rate(entry.key, r)
      }
      if (!touched) return { ...entry }
      entry.editedAt = clock()
      // The diary is sorted by date on read, so a changed date needs no
      // re-indexing — but byKey holds references into state.diary, and a date
      // change must not be observed through a stale bucket.
      invalidate()
      save()
      return { ...entry }
    }

    // ---- which years have anything in them --------------------------------

    // A year picker had to scan the whole diary to know what to offer, which
    // means every caller reimplements the same loop and gets the sort order to
    // itself.
    function diaryYears() {
      const counts = new Map()
      for (const e of load().diary) {
        const y = Number(String(e.date).slice(0, 4))
        if (!Number.isFinite(y)) continue
        counts.set(y, (counts.get(y) || 0) + 1)
      }
      // Newest first: a year picker opens on the year you are living in.
      return [...counts.entries()]
        .map(([year, viewings]) => ({ year, viewings }))
        .sort((a, b) => b.year - a.year)
    }

    // ---- query helpers ----------------------------------------------------

    function hasSeen(key) {
      return _index().has(key) || !!load().seen[key]
    }
    function isWatched(key) {
      return hasSeen(key)
    }
    function watchCount(key) {
      return (_index().get(key) || []).length
    }
    // Handed straight to Array#filter by the browse grid's "hide watched" toggle.
    function unwatchedFilter(keyOf) {
      const toKey = typeof keyOf === 'function' ? keyOf : (x => (typeof x === 'string' ? x : x && x.key))
      return item => !hasSeen(toKey(item))
    }

    // ---- favourites -------------------------------------------------------

    function favourites() {
      return load().favourites.slice()
    }

    // Four, because that is the personal canon this is modelled on. A fifth is
    // refused rather than silently dropping one of the four already chosen.
    function setFavourites(keys) {
      if (!Array.isArray(keys)) return null
      const clean = []
      for (const k of keys) {
        if (typeof k !== 'string' || !k || clean.includes(k)) continue
        clean.push(k)
      }
      if (clean.length > MAX_FAVOURITES) return null
      const state = load()
      state.favourites = clean
      save()
      return clean.slice()
    }

    function addFavourite(key) {
      const state = load()
      if (typeof key !== 'string' || !key) return null
      if (state.favourites.includes(key)) return state.favourites.slice()
      if (state.favourites.length >= MAX_FAVOURITES) return null
      state.favourites.push(key)
      save()
      return state.favourites.slice()
    }

    function removeFavourite(key) {
      const state = load()
      const idx = state.favourites.indexOf(key)
      if (idx < 0) return state.favourites.slice()
      state.favourites.splice(idx, 1)
      save()
      return state.favourites.slice()
    }

    // The same reasoning as moveInList, and it was missing here: the only way to
    // reorder was setFavourites(wholeArray), so a UI holding a list read a
    // moment ago would write back four keys and silently undo anything added
    // since. One key, one destination.
    function moveFavourite(key, toIndex) {
      const state = load()
      const from = state.favourites.indexOf(key)
      if (from < 0) return null
      const n = Number(toIndex)
      if (!Number.isFinite(n)) return null
      const to = Math.max(0, Math.min(state.favourites.length - 1, Math.round(n)))
      if (to === from) return state.favourites.slice()
      const [k] = state.favourites.splice(from, 1)
      state.favourites.splice(to, 0, k)
      save()
      return state.favourites.slice()
    }

    // ---- lists ------------------------------------------------------------

    function lists() {
      return load().lists.map(l => ({ ...l, entries: l.entries.map(e => ({ ...e })) }))
    }

    function getList(id) {
      const l = load().lists.find(x => x.id === id)
      return l ? { ...l, entries: l.entries.map(e => ({ ...e })) } : null
    }

    function createList(name, opts) {
      if (typeof name !== 'string' || !name.trim()) return null
      const o = _isPlainObject(opts) ? opts : {}
      const list = {
        ...o,
        id: _id('l'),
        name: name.trim(),
        description: typeof o.description === 'string' ? o.description : null,
        entries: [],
        createdAt: clock(),
        updatedAt: clock(),
      }
      load().lists.push(list)
      save()
      return { ...list, entries: [] }
    }

    function renameList(id, name) {
      const l = load().lists.find(x => x.id === id)
      if (!l || typeof name !== 'string' || !name.trim()) return null
      l.name = name.trim()
      l.updatedAt = clock()
      save()
      return getList(id)
    }

    // createList accepted a description and nothing could ever change it, so the
    // one sentence explaining what a list is FOR was fixed at the moment of
    // least knowledge — before a single title had been added to it.
    //
    // An empty string clears it, which is different from not passing one.
    function describeList(id, description) {
      const l = load().lists.find(x => x.id === id)
      if (!l) return null
      if (description !== null && typeof description !== 'string') return null
      const next = description === null ? null : (description.trim() || null)
      l.description = next
      l.updatedAt = clock()
      save()
      return getList(id)
    }

    // Destructive and requires the list's own name back as confirmation. A list
    // is hand-curated and there is no server copy to restore from, so an
    // accidental single-argument call must not be able to delete it. The removed
    // list is returned whole for undo.
    function deleteList(id, confirmName) {
      const state = load()
      const idx = state.lists.findIndex(x => x.id === id)
      if (idx < 0) return null
      if (state.lists[idx].name !== confirmName) return null
      const [gone] = state.lists.splice(idx, 1)
      save()
      return gone
    }

    // Duplicates are refused: a list is an ordered set, and a title appearing
    // twice is always a double-click, never an intent.
    function addToList(id, key, note) {
      const l = load().lists.find(x => x.id === id)
      if (!l || typeof key !== 'string' || !key) return null
      if (l.entries.some(e => e.key === key)) return null
      l.entries.push({ key, note: typeof note === 'string' ? note : null, addedAt: clock() })
      l.updatedAt = clock()
      save()
      return getList(id)
    }

    function annotateListEntry(id, key, note) {
      const l = load().lists.find(x => x.id === id)
      if (!l) return null
      const entry = l.entries.find(e => e.key === key)
      if (!entry) return null
      entry.note = typeof note === 'string' ? note : null
      l.updatedAt = clock()
      save()
      return getList(id)
    }

    function removeFromList(id, key) {
      const l = load().lists.find(x => x.id === id)
      if (!l) return null
      const idx = l.entries.findIndex(e => e.key === key)
      if (idx < 0) return null
      l.entries.splice(idx, 1)
      l.updatedAt = clock()
      save()
      return getList(id)
    }

    // Reorders by moving one entry to an index, rather than accepting a whole
    // new array: a caller that sends a stale array would silently drop entries
    // added since it read the list.
    function moveInList(id, key, toIndex) {
      const l = load().lists.find(x => x.id === id)
      if (!l) return null
      const from = l.entries.findIndex(e => e.key === key)
      if (from < 0) return null
      const to = Math.max(0, Math.min(l.entries.length - 1, Number(toIndex)))
      if (!Number.isFinite(to)) return null
      const [entry] = l.entries.splice(from, 1)
      l.entries.splice(to, 0, entry)
      l.updatedAt = clock()
      save()
      return getList(id)
    }

    // ---- taste profile ----------------------------------------------------

    // Two numbers, because they answer different questions and a diary of any
    // size makes the difference matter. How many of a director's films you have
    // seen is breadth; how many times you have watched them is devotion. Ranking
    // on breadth alone tied three directors at two films each and broke the tie
    // alphabetically, which said nothing at all — while the viewing counts
    // underneath said plainly that one of them was watched twice as often.
    function _tally(map, value, titleKey) {
      if (value === null || value === undefined || value === '') return
      let e = map.get(value)
      if (!e) { e = { titles: new Set(), viewings: 0 }; map.set(value, e) }
      e.titles.add(titleKey)
      e.viewings += 1
    }
    function _top(map, limit) {
      return [...map.entries()]
        .map(([name, e]) => ({ name, count: e.titles.size, viewings: e.viewings }))
        // Breadth first, devotion as the tie-break, name only as a last resort
        // so the order is stable rather than arbitrary.
        .sort((a, b) => b.count - a.count || b.viewings - a.viewings || (a.name < b.name ? -1 : 1))
        .slice(0, typeof limit === 'number' && limit > 0 ? limit : Infinity)
    }
    function _decadeOf(year) {
      const y = Number(year)
      return Number.isFinite(y) && y > 0 ? Math.floor(y / 10) * 10 : null
    }

    // `meta` maps title key -> { directors, year, countries, languages, runtime }.
    // The store does no I/O: whoever already fetched and cached the metadata
    // passes it in, so the profile can be recomputed offline and never blocks a
    // render on the network.
    function profile(meta, opts) {
      const m = _isPlainObject(meta) ? meta : {}
      const o = _isPlainObject(opts) ? opts : {}
      const entries = Array.isArray(o.entries) ? o.entries : load().diary
      const directors = new Map()
      const decades = new Map()
      const countries = new Map()
      const languages = new Map()
      let runtime = 0
      // Runtime is per viewing — those hours were really spent, and a rewatch
      // costs them again.
      for (const e of entries) runtime += Number((m[e.key] || {}).runtime) || 0
      // Everything else is per distinct title, for the same reason the average
      // rating below is: these describe taste, and taste is about which films
      // you chose, not how many times you put one on. Counting viewings let a
      // single rewatched favourite decide your top decade — in the fixture,
      // watching one 1982 film twice made the 1980s beat a decade with more
      // distinct films in it.
      for (const e of entries) {
        const info = m[e.key] || {}
        const list = Array.isArray(info.directors) ? info.directors : (info.director ? [info.director] : [])
        for (const d of list) _tally(directors, d, e.key)
        _tally(decades, _decadeOf(info.year), e.key)
        for (const c of (Array.isArray(info.countries) ? info.countries : [])) _tally(countries, c, e.key)
        for (const l of (Array.isArray(info.languages) ? info.languages : [])) _tally(languages, l, e.key)
      }
      // Averaged over titles, not viewings: rating is a verdict on the film, and
      // rewatching a favourite must not drag the average toward it.
      //
      // And averaged over the titles IN SCOPE. This read the whole ratings map
      // regardless of the `entries` filter, so yearInReview -- whose entire job
      // is to describe one year -- reported a lifetime average as that year's.
      // The panel omitted the number rather than print something false.
      const ratings = load().ratings
      const scoped = o.entries !== undefined && Array.isArray(o.entries)
      let values
      if (scoped) {
        values = []
        for (const key of new Set(entries.map(e => e.key))) {
          const r = ratings[key]
          if (r && isValidRating(r.value)) values.push(r.value)
        }
      } else {
        values = Object.values(ratings).map(r => r.value)
      }
      const averageRating = values.length
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
        : null
      return {
        viewings: entries.length,
        titles: new Set(entries.map(e => e.key)).size,
        totalRuntime: runtime,
        averageRating,
        ratedTitles: values.length,
        topDirectors: _top(directors, o.limit),
        decades: _top(decades, o.limit),
        topCountries: _top(countries, o.limit),
        topLanguages: _top(languages, o.limit),
      }
    }

    function yearInReview(year, meta, opts) {
      const y = String(year)
      const entries = load().diary.filter(e => e.date.slice(0, 4) === y)
      const base = profile(meta, { ...(opts || {}), entries })
      const distribution = {}
      for (const e of entries) {
        if (e.rating === null || e.rating === undefined) continue
        const k = String(e.rating)
        distribution[k] = (distribution[k] || 0) + 1
      }
      const perMonth = new Array(12).fill(0)
      for (const e of entries) {
        const mo = Number(e.date.slice(5, 7)) - 1
        if (mo >= 0 && mo < 12) perMonth[mo] += 1
      }
      return {
        year: Number(year),
        viewings: base.viewings,
        titles: base.titles,
        hours: Math.round((base.totalRuntime / 60) * 10) / 10,
        totalRuntime: base.totalRuntime,
        // Now genuinely this year's, so the panel can show it.
        averageRating: base.averageRating,
        ratedTitles: base.ratedTitles,
        topDirectors: base.topDirectors,
        decades: base.decades,
        topCountries: base.topCountries,
        topLanguages: base.topLanguages,
        ratingDistribution: distribution,
        perMonth,
        entries,
      }
    }

    function _dump() {
      return JSON.parse(JSON.stringify(load()))
    }
    function _reset() {
      cache = null
      invalidate()
      backend.write(_empty())
    }

    return {
      rate, unrate, ratingOf,
      logViewing, markSeen, diary, viewingsOf, setNote, removeViewing, restoreViewing,
      editViewing, diaryYears, unsee, resee,
      hasSeen, isWatched, watchCount, unwatchedFilter,
      favourites, setFavourites, addFavourite, removeFavourite, moveFavourite,
      lists, getList, createList, renameList, describeList, deleteList,
      addToList, annotateListEntry, removeFromList, moveInList,
      profile, yearInReview,
      _dump, _reset,
    }
  }

  const singleton = createTasteStore()
  return {
    ...singleton,
    createTasteStore,
    _memoryStorage,
    isValidRating,
    normalizeDate,
    VERSION,
    MIN_RATING,
    MAX_RATING,
    MAX_FAVOURITES,
  }
})
