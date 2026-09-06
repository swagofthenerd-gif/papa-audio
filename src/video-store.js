'use strict';
// Watch state, watchlist, skip segments and per-show preferences, in one
// persisted blob behind a synchronous namespace the UI reads directly.
//
// The schema is §16 of docs/papa-video-plan.md:
//   { items:     { "movie:27205" | "tv:1396:s1e2": { type, id, title, poster,
//                 position, duration, watched, updatedAt, source, … } },
//     watchlist: [ { type, id, title, poster, addedAt } ],
//     skip:      { "tv:1396:s1": Segment[] },
//     prefs:     { "tv:1396": { autoSkipIntro, autoSkipCredits, autoNext, … } } }
//
// Watched means the file reached ≥90%; anything under 2% is not "in progress"
// and so never shows up in Continue Watching.
//
// Ids are strings, always. They arrive as numbers from API objects and as
// strings from DOM data attributes, and the strict comparisons here used to
// see 1396 and "1396" as two different shows — duplicate watchlist rows,
// wrong button states. Every public entry point now normalises ids to
// strings, and load() normalises (and dedupes) whatever an older blob saved.
//
// Persistence goes through an injectable `storage` adapter so the logic is
// fully testable without localStorage. `read`/`write` are required; the rest
// is optional and exists to survive a corrupt blob:
//   read()          → parsed value or null
//   write(value)    → boolean
//   readRaw()       → the raw stored string (lets load() see corruption that
//                     a parse-with-fallback would silently turn into {})
//   quarantine(text)→ copy a corrupt blob aside before anything overwrites it
//   readBackup()    → parsed rolling backup or null
//   writeBackup(v)  → refresh the rolling backup
// The renderer's default adapter reads/writes through window.PapaLocal, the
// one validated localStorage reader in the app; tests inject an in-memory
// adapter.
//
// When the main process exposes a store bridge (window.__papaVideoStoreBridge,
// wired by preload to a main-process SideStore that is flushed synchronously
// on every quit path), persistence goes through that instead of localStorage —
// localStorage only reaches disk when Chromium feels like it, which is why
// main.js has to call flushStorageData() at quit at all. The bridge is four
// async methods over raw text:
//   read()           → Promise<string|null>
//   write(text)      → Promise<boolean>
//   readBackup?()    → Promise<string|null>
//   writeBackup?(t)  → Promise<boolean>
// init() hydrates the cache from the bridge ONCE at startup — the renderer
// awaits it before first use — and every public method stays synchronous
// afterwards. Saves write the whole blob through the bridge behind a short
// debounce; flush() hands back the pending write's promise so the quit path
// can wait for the last write to land before the window goes away. On the
// first run with a bridge and an empty bridge store, the old localStorage
// blob is copied across and the localStorage key renamed to
// papa-video-store.migrated — history is never deleted. Quarantine (and the
// rolling backup, when the bridge doesn't offer one) stays on localStorage.
// Without a bridge — tests, dev, an old preload — behaviour is exactly the
// localStorage path above, and init()/flush() are settled no-ops.
//
// UMD-wrapped like ttl-cache.js so it loads as a classic script without leaking
// top-level bindings into the shared renderer scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoStore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const KEY = 'papa-video-store'
  const BAK_KEY = KEY + '.bak'
  const CORRUPT_KEY = KEY + '.corrupt'
  const MIGRATED_KEY = KEY + '.migrated'

  const WATCHED_AT = 0.9
  const MIN_PROGRESS = 0.02

  // A duration mpv reports can be a lie: a season pack sometimes serves a
  // short NC/OP extra, or a pre-load value of a few seconds, before the real
  // file settles. A 90-second "duration" on a 24-minute episode auto-marked it
  // watched at position 87. So `watched` is only trusted when the reported
  // duration is at least plausible for the kind of thing being watched:
  // a real TV/anime episode runs at least a few minutes; a feature film far
  // longer. Below these floors the duration is treated as untrustworthy —
  // `watched` stays false and a previously-recorded longer duration is kept.
  const MIN_EPISODE_DURATION = 300 // 5 min — the shortest believable episode
  const MIN_MOVIE_DURATION = 900   // 15 min — the shortest believable feature

  // Items accumulate one entry per episode ever touched and the whole blob is
  // rewritten every 5 s of playback, so without a ceiling the blob only ever
  // grows. 1000 items is years of viewing; eviction starts with what is
  // cheapest to lose (see _prune).
  const MAX_ITEMS = 1000

  // Bridge writes are debounced so the every-5-s position updates don't turn
  // into an IPC round-trip per keystroke of the seek bar. Short, because the
  // debounce window is the only data the main-process store can't flush at
  // quit — flush() closes it on the quit path.
  const DEBOUNCE_MS = 250

  function _empty() {
    return { items: {}, watchlist: [], skip: {}, prefs: {} }
  }

  function _log(...args) {
    try { console.error('[papa][video-store]', ...args) } catch (_) {}
  }

  // The renderer storage. PapaLocal is loaded first (local-store.js precedes
  // this in index.html), so every localStorage touch here survives quota
  // failures and private windows without throwing into the caller. The main
  // key is read raw — not through readObject — because readObject turns a
  // corrupt blob into {}, and load() needs to tell corruption apart from an
  // empty store to quarantine and recover instead of overwriting.
  function _browserStorage() {
    function local() {
      try { return (typeof window !== 'undefined' && window.PapaLocal) || null } catch (_) { return null }
    }
    return {
      read() {
        const l = local()
        try { return l ? l.readObject(KEY) : null } catch (_) { return null }
      },
      readRaw() {
        const l = local()
        try { return l && typeof l.readRaw === 'function' ? l.readRaw(KEY) : null } catch (_) { return null }
      },
      write(value) {
        const l = local()
        try { return l ? l.write(KEY, value) : false } catch (_) { return false }
      },
      quarantine(text) {
        const l = local()
        try { return l && typeof l.writeRaw === 'function' ? l.writeRaw(CORRUPT_KEY, text) : false } catch (_) { return false }
      },
      readBackup() {
        const l = local()
        try {
          const text = l && typeof l.readRaw === 'function' ? l.readRaw(BAK_KEY) : null
          if (text == null || text === '') return null
          return JSON.parse(text)
        } catch (_) { return null }
      },
      writeBackup(value) {
        const l = local()
        try { return l ? l.write(BAK_KEY, value) : false } catch (_) { return false }
      },
    }
  }

  // Test / Node storage: one blob in memory, inspectable via _dump. The bak
  // and corrupt slots mirror the adapter contract so recovery is testable.
  function _memoryStorage(seed) {
    let value = seed === undefined ? null : seed
    let bak = null
    let corrupt = null
    return {
      read: () => value,
      write: v => { value = v; return true },
      readBackup: () => bak,
      writeBackup: v => { bak = v; return true },
      quarantine: text => { corrupt = text; return true },
      _dump: () => value,
      _bak: () => bak,
      _corrupt: () => corrupt,
    }
  }

  // Test bridge: the async four-method contract over one in-memory text slot,
  // with a switch for the failure a real IPC bridge can have. _writes counts
  // attempts so the debounce is observable.
  function _memoryBridge(seedText) {
    let text = seedText === undefined ? null : seedText
    let bak = null
    let failWrites = false
    let writes = 0
    return {
      read: async () => text,
      write: async t => { writes++; if (failWrites) return false; text = String(t); return true },
      readBackup: async () => bak,
      writeBackup: async t => { bak = String(t); return true },
      _text: () => text,
      _bak: () => bak,
      _writes: () => writes,
      _fail: v => { failWrites = !!v },
    }
  }

  function _defaultBridge() {
    try { return (typeof window !== 'undefined' && window.__papaVideoStoreBridge) || null } catch (_) { return null }
  }

  // The localStorage side of bridge mode: migration source, quarantine, and
  // the backup fallback. PapaLocal-shaped (readRaw/writeRaw/write/remove);
  // tests inject a Map-backed fake.
  function _defaultLegacy() {
    try { return (typeof window !== 'undefined' && window.PapaLocal) || null } catch (_) { return null }
  }

  function _normId(id) {
    return id == null ? id : String(id)
  }

  function _watchKey(type, id) {
    return (type == null ? '' : String(type)) + ':' + (id == null ? '' : String(id))
  }

  // The floor a reported duration must clear before `watched` is trusted, by
  // kind. Movies need the feature floor; everything episodic uses the shorter
  // episode floor. Anything else falls back to the episode floor as the more
  // permissive of the two.
  function _minPlausibleDuration(type) {
    return type === 'movie' ? MIN_MOVIE_DURATION : MIN_EPISODE_DURATION
  }

  // The id an item is really about, taken from meta first and the key prefix
  // second (keys are "movie:ID", "tv:ID:s1e2", "anime:ID:e2"). An entry with
  // no real id is a ghost — "movie:" with nothing after it — and must never be
  // written or kept.
  function _idFromKey(k) {
    const parts = String(k).split(':')
    return parts.length >= 2 ? parts[1] : ''
  }
  // The type prefix of a key ("movie:27205" -> "movie", "tv:1396:s1e2" -> "tv").
  function _keyType(k) {
    const parts = String(k).split(':')
    return parts.length ? parts[0] : ''
  }
  function _hasRealId(k, meta) {
    const fromMeta = meta && meta.id != null ? String(meta.id) : ''
    const id = fromMeta || _idFromKey(k)
    return id !== '' && id !== 'undefined' && id !== 'null'
  }

  // The 'YYYY-MM-DD' local-calendar day for a timestamp, matching how the taste
  // store's diary keys its entries by date. Used by the auto-log dedupe so one
  // finish per title per day yields one diary entry, not one per position tick.
  function _dayOf(ts) {
    const d = new Date(Number(ts))
    if (!Number.isFinite(d.getTime())) return ''
    const p = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function createVideoStore(opts = {}) {
    const { storage, now, maxItems, debounceMs, onWatched } = opts
    // Diary auto-log (roadmap #34). When an item flips to watched:true, this is
    // called with { key, id, type, title, season, episode, watchedAt } so the
    // renderer can append a diary entry (the diary lives in taste-store, which is
    // renderer-side; main/tests inject their own or none). Fired only on the
    // false→true transition, never on a re-save of an already-watched item, so a
    // finished film logs once. The caller is responsible for the key+day dedupe
    // against whatever the diary already holds — watchedLogKey/alreadyLogged
    // below give it the same day-granularity the diary uses.
    const watchedHook = typeof onWatched === 'function' ? onWatched : null
    const backend = storage || (typeof window !== 'undefined' ? _browserStorage() : _memoryStorage())
    const bridge = 'bridge' in opts ? (opts.bridge || null) : _defaultBridge()
    const legacy = 'legacy' in opts ? (opts.legacy || null) : _defaultLegacy()
    const clock = typeof now === 'function' ? now : () => Date.now()
    const cap = typeof maxItems === 'number' && maxItems > 0 ? maxItems : MAX_ITEMS
    const wait = typeof debounceMs === 'number' && debounceMs >= 0 ? debounceMs : DEBOUNCE_MS

    let cache = null
    // A failed write means the in-memory cache and disk have diverged; the
    // flag flips back on the next save that lands (every save writes the
    // whole blob, so every save is a retry). In bridge mode the flip happens
    // when the async write settles, not when save() returns.
    let healthy = true

    // Bridge-mode state. hydrated flips once init() has adopted a cache; if
    // the bridge can't even read at startup, bridgeDown parks the whole
    // session on the localStorage path so nothing is lost to a broken pipe.
    let hydrated = !bridge
    let bridgeDown = false
    let initPromise = null
    let timer = null
    // The settled promise of the last bridge write. Writes chain through it
    // so they land in order; flush() returns it.
    let queued = Promise.resolve(true)

    // What is actually stored under the main key, with corruption made
    // visible: readRaw (when the adapter has it) hands back the raw text, and
    // a parse failure here — instead of inside a fallback-to-{} reader — is
    // what lets load() quarantine and recover.
    function _readMain() {
      if (typeof backend.readRaw === 'function') {
        let text = null
        try { text = backend.readRaw() } catch (_) { text = null }
        if (text == null || text === '') return { value: null, present: false, corrupt: false }
        try {
          return { value: JSON.parse(text), present: true, corrupt: false }
        } catch (_) {
          return { value: null, present: true, corrupt: true, text }
        }
      }
      let v = null
      try { v = backend.read() } catch (_) { v = null }
      return { value: v, present: v != null, corrupt: false }
    }

    function load() {
      if (cache !== null) return cache
      if (bridge && !bridgeDown && hydrated) {
        // Only reachable through _reset in bridge mode: the bridge blob was
        // adopted at init, so an empty cache here means start empty.
        cache = _normalize(_sanitize(null))
        return cache
      }
      const main = _readMain()
      if (main.corrupt) {
        // Quarantine the raw text FIRST: the next save() fires 5 s into any
        // playback and would overwrite the main key, and a truncated blob is
        // usually mostly recoverable by hand.
        try { if (typeof backend.quarantine === 'function') backend.quarantine(main.text) } catch (_) {}
        let bak = null
        try { bak = typeof backend.readBackup === 'function' ? backend.readBackup() : null } catch (_) { bak = null }
        cache = _normalize(_sanitize(bak))
        _log(`${KEY} is corrupt; raw blob copied to ${CORRUPT_KEY};`,
          bak ? 'recovered from ' + BAK_KEY : 'no usable backup, starting empty')
        // Replace the corrupt blob with the recovered state deliberately —
        // the original is safe in quarantine now.
        save()
      } else {
        cache = _normalize(_sanitize(main.value))
        // Rolling backup: refreshed once per session (load() runs once — the
        // cache short-circuits after) from the first VALID stored blob, so a
        // crash mid-write always leaves last session's good copy behind.
        const valid = main.present && main.value && typeof main.value === 'object' && !Array.isArray(main.value)
        if (valid) {
          try { if (typeof backend.writeBackup === 'function') backend.writeBackup(cache) } catch (_) {}
        }
      }
      return cache
    }

    function save() {
      _prune(cache)
      if (bridge && !bridgeDown && hydrated) {
        _scheduleWrite()
        return
      }
      let ok = false
      try { ok = backend.write(cache) !== false } catch (_) { ok = false }
      if (!ok && healthy) _log(`could not write ${KEY}; watch state is only in memory until a save lands`)
      healthy = ok
    }

    function storageHealthy() {
      return healthy
    }

    // ── Bridge mode ──────────────────────────────────────────────────────────

    // Hydrate once, migrate if this is the first bridge run, then never touch
    // the bridge read path again. Idempotent: callers can await it twice.
    function init() {
      if (!bridge) { load(); return Promise.resolve(true) }
      if (!initPromise) initPromise = _hydrate()
      return initPromise
    }

    async function _hydrate() {
      let text = null
      try {
        text = await bridge.read()
      } catch (e) {
        // Can't even read: don't risk clobbering whatever the bridge store
        // holds. Park the session on localStorage — exactly the old path.
        bridgeDown = true
        _log(`the bridge could not read ${KEY}; staying on localStorage this session:`, e && e.message)
        load()
        return false
      }
      if (text == null || text === '') {
        // First run with a bridge: carry the localStorage history across, and
        // leave the old copy behind under a name the store no longer reads.
        const old = _legacyRaw(KEY)
        if (old != null && old !== '') {
          let ok = false
          try { ok = (await bridge.write(old)) !== false } catch (_) { ok = false }
          if (ok) {
            try { if (legacy && typeof legacy.writeRaw === 'function') legacy.writeRaw(MIGRATED_KEY, old) } catch (_) {}
            try { if (legacy && typeof legacy.remove === 'function') legacy.remove(KEY) } catch (_) {}
            _log(`migrated ${KEY} from localStorage to the bridge store; the old copy is kept as ${MIGRATED_KEY}`)
          } else {
            healthy = false
            _log(`could not copy ${KEY} into the bridge store; localStorage is untouched, migration retries next launch`)
          }
          text = old
        }
      }
      if (cache !== null) {
        // Someone read or wrote before init() settled and the localStorage
        // fallback answered. That state may hold writes, so it wins — write
        // it through rather than clobbering it with the bridge blob.
        _log(`${KEY} was touched before init() settled; keeping the early state and writing it through`)
        hydrated = true
        _scheduleWrite()
        return true
      }
      if (text == null || text === '') {
        cache = _normalize(_sanitize(null))
        hydrated = true
        return true
      }
      let parsed = null
      let corrupt = false
      try { parsed = JSON.parse(text) } catch (_) { corrupt = true }
      if (corrupt) {
        // Same drill as the localStorage path: quarantine the raw bytes first
        // (localStorage is still the quarantine shelf — the bridge contract
        // has no slot for it), then recover from whichever backup exists.
        try { if (legacy && typeof legacy.writeRaw === 'function') legacy.writeRaw(CORRUPT_KEY, text) } catch (_) {}
        const bak = await _readBridgeBackup()
        cache = _normalize(_sanitize(bak))
        _log(`${KEY} from the bridge is corrupt; raw blob copied to ${CORRUPT_KEY};`,
          bak ? 'recovered from the backup' : 'no usable backup, starting empty')
        hydrated = true
        // Replace the corrupt blob with the recovered state deliberately —
        // the original is safe in quarantine now.
        save()
        return true
      }
      cache = _normalize(_sanitize(parsed))
      hydrated = true
      // Rolling backup, same once-per-session rule as load(): only a VALID
      // stored blob refreshes it, so a crash mid-write leaves the good copy.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        await _writeBridgeBackup(JSON.stringify(cache))
      }
      return true
    }

    function _legacyRaw(key) {
      try { return legacy && typeof legacy.readRaw === 'function' ? legacy.readRaw(key) : null } catch (_) { return null }
    }

    // Backup goes through the bridge when it offers the methods; a bridge
    // backup that is missing or unreadable still falls through to the
    // localStorage .bak, which is where pre-migration sessions left theirs.
    async function _readBridgeBackup() {
      if (typeof bridge.readBackup === 'function') {
        try {
          const t = await bridge.readBackup()
          if (t != null && t !== '') return JSON.parse(t)
        } catch (_) {}
      }
      try {
        const t = _legacyRaw(BAK_KEY)
        if (t != null && t !== '') return JSON.parse(t)
      } catch (_) {}
      return null
    }

    async function _writeBridgeBackup(text) {
      if (typeof bridge.writeBackup === 'function') {
        try { return (await bridge.writeBackup(text)) !== false } catch (_) { return false }
      }
      try { return legacy && typeof legacy.writeRaw === 'function' ? legacy.writeRaw(BAK_KEY, text) : false } catch (_) { return false }
    }

    function _scheduleWrite() {
      if (timer !== null) return
      timer = setTimeout(_fireWrite, wait)
      // Node's test runner should not be held open by a debounce window.
      if (timer && typeof timer.unref === 'function') timer.unref()
    }

    // Serialise at fire time — the cache may have moved since the schedule,
    // and the newest whole blob is always the right thing to write. Chained
    // through `queued` so writes land in order.
    function _fireWrite() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      const text = JSON.stringify(load())
      const attempt = queued
        .then(() => {
          try { return Promise.resolve(bridge.write(text)).catch(() => false) } catch (_) { return false }
        })
        .then(result => {
          const ok = result !== false
          if (!ok && healthy) _log(`could not write ${KEY} through the bridge; watch state is only in memory until a save lands`)
          healthy = ok
          return ok
        })
      queued = attempt
      return attempt
    }

    // The quit-path hook: fires any pending debounced write now and resolves
    // when the last write has settled. Without a bridge there is nothing
    // pending — localStorage writes are synchronous — so it settles at once.
    function flush() {
      if (!bridge || bridgeDown) return Promise.resolve(healthy)
      if (timer !== null) return _fireWrite()
      return queued
    }

    // ── Blob shape ───────────────────────────────────────────────────────────

    // A corrupt or wrong-shaped blob must not take down a render — every field
    // is read defensively and replaced by its default when it is not the right
    // shape.
    function _sanitize(raw) {
      const base = _empty()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
      if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) base.items = raw.items
      if (Array.isArray(raw.watchlist)) base.watchlist = raw.watchlist
      if (raw.skip && typeof raw.skip === 'object' && !Array.isArray(raw.skip)) base.skip = raw.skip
      if (raw.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs)) base.prefs = raw.prefs
      return base
    }

    // One-time repair of a blob written before ids were normalised: every id
    // becomes a string, and watchlist entries that collide once normalised
    // (1396 and "1396") merge down to one, keeping the more recent addedAt.
    function _normalize(state) {
      for (const k of Object.keys(state.items)) {
        const it = state.items[k]
        // One-time self-heal (like the watchlist dedupe below and the renderer's
        // search-history cleanup): a blob written before ids were validated can
        // hold a ghost entry keyed "movie:"/"tv:" with no real id. It renders an
        // empty Continue Watching card that 404s on click — drop it on load.
        if (!_hasRealId(k, it)) { delete state.items[k]; continue }
        if (it && typeof it === 'object' && it.id != null) it.id = String(it.id)
      }
      const seen = new Map()
      const deduped = []
      for (const w of state.watchlist) {
        if (!w || typeof w !== 'object') continue
        const entry = { ...w, id: _normId(w.id) }
        const key = _watchKey(entry.type, entry.id)
        if (seen.has(key)) {
          const at = seen.get(key)
          if ((Number(entry.addedAt) || 0) > (Number(deduped[at].addedAt) || 0)) deduped[at] = entry
        } else {
          seen.set(key, deduped.length)
          deduped.push(entry)
        }
      }
      state.watchlist = deduped
      return state
    }

    // Keeps items under the cap. Eviction order: oldest-updated items that are
    // fully watched or stale (not in progress) go first; oldest in-progress
    // items go only if that was not enough; anything on the watchlist is never
    // evicted, even over the cap.
    function _prune(state) {
      const keys = Object.keys(state.items)
      let excess = keys.length - cap
      if (excess <= 0) return
      const listed = new Set(state.watchlist.map(w => _watchKey(w.type, w.id)))
      const done = []
      const inProgress = []
      for (const k of keys) {
        const it = state.items[k]
        if (it && typeof it === 'object' && listed.has(_watchKey(it.type, it.id))) continue
        ;(_inProgress(it) ? inProgress : done).push(k)
      }
      const oldestFirst = (a, b) =>
        (Number(state.items[a].updatedAt) || 0) - (Number(state.items[b].updatedAt) || 0)
      done.sort(oldestFirst)
      inProgress.sort(oldestFirst)
      for (const k of done.concat(inProgress)) {
        if (excess <= 0) break
        delete state.items[k]
        excess--
      }
    }

    function ratio(item) {
      const pos = Number(item && item.position) || 0
      const dur = Number(item && item.duration) || 0
      return dur > 0 ? pos / dur : 0
    }

    function get(key) {
      return load().items[String(key)] || null
    }

    // Upserts the item identified by `key`, merging `meta` (the identifying and
    // display fields) over whatever was already saved for it. Records the
    // position, recomputes `watched`, and stamps `updatedAt` so Continue Watching
    // orders by most-recent.
    function setPosition(key, meta, position, duration) {
      const state = load()
      const k = String(key)
      // A ghost entry keyed with an empty id ("movie:") renders an empty
      // Continue Watching card that 404s when clicked. Never write one.
      if (!_hasRealId(k, meta)) return null
      const prev = state.items[k] || {}
      const pos = Number(position) || 0
      const dur = Number(duration) || 0
      // Trust the reported duration to mark `watched` only when it is at least
      // plausible for the kind being watched; an implausibly short duration is
      // an mpv/pack artefact (App audit #8), so keep `watched` false and hold
      // on to any previously-recorded longer duration rather than clobbering it.
      const type = (meta && meta.type) || prev.type || _idFromKey(k) && String(k).split(':')[0]
      const plausible = dur >= _minPlausibleDuration(type)
      const prevDur = Number(prev.duration) || 0
      const item = {
        ...prev,
        ...(meta && typeof meta === 'object' ? meta : {}),
        position: pos,
        duration: plausible ? dur : (prevDur > dur ? prevDur : dur),
        watched: plausible && dur > 0 && pos / dur >= WATCHED_AT
          ? true
          : (plausible ? false : (prev.watched === true)),
        updatedAt: clock(),
      }
      if (item.id != null) item.id = String(item.id)
      state.items[k] = item
      save()
      _fireWatched(k, prev, item)
      return item
    }

    function markWatched(key) {
      const state = load()
      const k = String(key)
      const prev = state.items[k] || {}
      const item = { ...prev, watched: true, updatedAt: clock() }
      state.items[k] = item
      save()
      _fireWatched(k, prev, item)
      return item
    }

    // Fire the diary auto-log hook on the watched false→true transition only.
    // A re-save of an already-watched item, or an update that leaves watched
    // false, must not re-log — that is the dedupe the roadmap asks for at the
    // transition level; the day-granularity dedupe against the diary is the
    // caller's, via alreadyLogged() below.
    function _fireWatched(k, prev, item) {
      if (!watchedHook) return
      if (item.watched !== true) return
      if (prev && prev.watched === true) return
      try {
        watchedHook({
          key: k,
          id: item.id != null ? String(item.id) : _idFromKey(k),
          type: item.type || _keyType(k),
          title: item.title != null ? item.title : null,
          season: item.season != null ? item.season : null,
          episode: item.episode != null ? item.episode : null,
          watchedAt: Number(item.updatedAt) || clock(),
        })
      } catch (_) { /* the hook must never break a save */ }
    }

    function _inProgress(item) {
      if (!item || item.watched) return false
      const dur = Number(item.duration) || 0
      if (dur <= 0) return false
      return ratio(item) >= MIN_PROGRESS
    }

    function _newest(list, limit) {
      const sorted = list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      return typeof limit === 'number' && limit > 0 ? sorted.slice(0, limit) : sorted
    }

    // Continue Watching collapses episodic shows to one card each — the most
    // recently watched episode of a series wins, so a viewer part-way through
    // S1E26 does not also see S1E25 as a separate card (App audit #6/#13).
    // Movies stay individual: each film is its own title, keyed by its own id.
    function continueWatching(limit) {
      const inProgress = Object.values(load().items).filter(_inProgress)
      const bestPerShow = new Map()
      for (const it of inProgress) {
        // Films are never grouped; each gets a unique bucket so none collapse.
        const showKey = it.type === 'movie'
          ? 'movie:' + _watchKey(it.type, it.id) + ':' + (it.updatedAt || Math.random())
          : _watchKey(it.type, it.id)
        const prev = bestPerShow.get(showKey)
        if (!prev || (Number(it.updatedAt) || 0) > (Number(prev.updatedAt) || 0)) {
          bestPerShow.set(showKey, it)
        }
      }
      return _newest(Array.from(bestPerShow.values()), limit)
    }

    function watchlist() {
      return load().watchlist.slice()
    }

    // Adds when absent, removes when present. Returns the new list so the caller
    // can re-render without a second read.
    function toggleWatchlist(item) {
      const state = load()
      const type = item && item.type
      const id = _normId(item && item.id)
      const idx = state.watchlist.findIndex(w => w.type === type && w.id === id)
      if (idx >= 0) {
        state.watchlist.splice(idx, 1)
      } else if (type != null && id != null) {
        const entry = {
          type,
          id,
          title: (item && item.title) ?? null,
          poster: (item && item.poster) ?? null,
          addedAt: clock(),
        }
        // Persist the TMDB collection when the caller has it (App #22), so My
        // List can group franchise entries by the real collection rather than
        // guessing from the title. Older entries lack it and fall back to the
        // title heuristic; only stored when it is a real {id,name}.
        if (item && item.collection && item.collection.id != null) {
          entry.collection = {
            id: String(item.collection.id),
            name: item.collection.name || null,
          }
        }
        state.watchlist.push(entry)
      }
      save()
      return state.watchlist.slice()
    }

    function inWatchlist(type, id) {
      const nid = _normId(id)
      return load().watchlist.some(w => w.type === type && w.id === nid)
    }

    // Watched items, newest first. This is the History view.
    function history(limit) {
      return _newest(Object.values(load().items).filter(it => it.watched === true), limit)
    }

    function prefs(showKey) {
      return { ...(load().prefs[String(showKey)] || {}) }
    }

    function setPrefs(showKey, patch) {
      const state = load()
      const k = String(showKey)
      const next = { ...(state.prefs[k] || {}), ...(patch && typeof patch === 'object' ? patch : {}) }
      state.prefs[k] = next
      save()
      return { ...next }
    }

    function skip(seasonKey) {
      const k = String(seasonKey)
      return Array.isArray(load().skip[k]) ? load().skip[k].slice() : []
    }

    function setSkip(seasonKey, segments) {
      const state = load()
      const k = String(seasonKey)
      state.skip[k] = Array.isArray(segments) ? segments.slice() : []
      save()
      return state.skip[k].slice()
    }

    // Test/debug hooks. Not part of the §4.4 surface the UI relies on.
    function _dump() {
      return JSON.parse(JSON.stringify(load()))
    }
    function _reset() {
      cache = null
      backend.write(_empty())
    }

    return {
      init, flush,
      get, setPosition, markWatched,
      continueWatching, watchlist, toggleWatchlist, inWatchlist, history,
      prefs, setPrefs, skip, setSkip,
      storageHealthy,
      _dump, _reset,
    }
  }

  // ── Diary auto-log dedupe (roadmap #34) ──────────────────────────────────────
  // Pure helpers the renderer uses to feed the same source the Diary tab reads
  // (taste-store's diary, via logViewing). The dedupe granularity is key+day:
  // finishing the same title twice on one day is one diary entry, matching how
  // the diary keys entries by 'YYYY-MM-DD'.

  // The dedupe identity for an auto-log: the item key plus the calendar day it
  // was watched. `payload` is what the onWatched hook receives.
  function watchedLogKey(payload) {
    if (!payload || payload.key == null) return null
    return String(payload.key) + '@' + _dayOf(payload.watchedAt)
  }

  // Is there already a diary entry for this title on this day? `diaryEntries` is
  // whatever taste-store.diary() returns for the key — [{ key, date, ... }]. A
  // match on the same day means the auto-log is a duplicate and must be skipped.
  function alreadyLogged(payload, diaryEntries) {
    if (!payload || payload.key == null) return false
    const key = String(payload.key)
    const day = _dayOf(payload.watchedAt)
    for (const e of Array.isArray(diaryEntries) ? diaryEntries : []) {
      if (!e || typeof e !== 'object') continue
      if (String(e.key) === key && String(e.date) === day) return true
    }
    return false
  }

  // The §4.4 surface: the default instance's methods, plus the factory and the
  // constants the tests and later phases reach for.
  const singleton = createVideoStore()
  const api = {
    ...singleton,
    createVideoStore,
    watchedLogKey,
    alreadyLogged,
    _dayOf,
    _memoryStorage,
    _memoryBridge,
    WATCHED_AT,
    MIN_PROGRESS,
    MAX_ITEMS,
  }

  return api
})
