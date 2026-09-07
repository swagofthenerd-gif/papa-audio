'use strict'
// Pure controller logic for the YouTube search surfaces: suggestion debounce +
// cancel-on-newer, and the speculative single-flight prefetch. Kept DOM-free and
// clock-injected so the timing rules (only the latest request may paint, only
// one prefetch in flight, a newer top-suggestion cancels the old prefetch) are
// testable without a renderer, a network, or real timers.
//
// The renderer owns the actual setTimeout/fetch; this module owns the decisions:
// "should this response still paint?", "should I start a prefetch and cancel the
// previous?". Named-global export like the other pure modules.

var _PapaYtSuggestModel = (function () {

  // A monotonically increasing token generator. Every debounced suggestion
  // request takes a token; when the response returns, isCurrent(token) says
  // whether a newer request has since superseded it. This is the cancel-on-newer
  // guard in its purest form — no timers, just ordering.
  function createDebouncer(delayMs) {
    var seq = 0
    var current = 0
    var lastQuery = null
    return {
      // Begin a new request for `query`. Returns { token, delayMs, changed } or
      // null when the query is unchanged from the last (no need to refetch).
      begin: function (query) {
        var q = String(query == null ? '' : query).trim()
        if (q === lastQuery) return null
        lastQuery = q
        current = ++seq
        return { token: current, delayMs: delayMs, query: q, changed: true }
      },
      // Is `token` still the newest request? Stale responses must not paint.
      isCurrent: function (token) { return token === current },
      // Force-supersede everything in flight (e.g. on blur / commit).
      cancel: function () { current = ++seq; lastQuery = null },
      _seq: function () { return seq },
    }
  }

  // Single-flight speculative prefetch. When the suggestion list settles, the
  // renderer wants to quietly run the FULL search for the top suggestion so that
  // pressing Enter usually paints from a warm result. Only one prefetch may be in
  // flight; a new top suggestion cancels the previous one. This tracks that state
  // and answers "should I start?", "is this result still wanted?".
  function createPrefetcher() {
    var inFlight = null   // the query currently being prefetched
    var token = 0
    var results = Object.create(null) // query -> result payload (the warm cache)
    return {
      // Ask to prefetch `query`. Returns { token, query } to start, or null when
      // it's already the in-flight one or already cached (nothing to do). Starting
      // a new query implicitly cancels the previous in-flight one (its token goes
      // stale), satisfying the one-in-flight, cancel-on-change rule.
      request: function (query) {
        var q = String(query == null ? '' : query).trim()
        if (!q) return null
        if (q === inFlight) return null            // already fetching this
        if (Object.prototype.hasOwnProperty.call(results, q)) return null // warm
        inFlight = q
        token = token + 1
        return { token: token, query: q }
      },
      // A prefetch returned. Store it only if it's still the wanted one (its token
      // is the latest AND the query still matches in-flight). Returns true when
      // stored (still current), false when dropped as stale.
      settle: function (t, query, payload) {
        var q = String(query == null ? '' : query).trim()
        if (t !== token || q !== inFlight) return false // superseded
        results[q] = payload
        inFlight = null
        return true
      },
      // The warm result for a query, or null. Lets Enter paint instantly.
      get: function (query) {
        var q = String(query == null ? '' : query).trim()
        return Object.prototype.hasOwnProperty.call(results, q) ? results[q] : null
      },
      // Drop everything (blur / cache-size hygiene).
      clear: function () { inFlight = null; token = token + 1; results = Object.create(null) },
      _inFlight: function () { return inFlight },
    }
  }

  // Build the dropdown row model from a suggestion list + the typed text. The
  // typed text is always the first row (so Enter with no arrow keys searches
  // exactly what was typed), followed by de-duplicated suggestions that aren't
  // just the typed text again. Pure list-shaping so the keyboard-nav indexing is
  // testable. `limit` caps the suggestion rows.
  function buildRows(typed, suggestions, limit) {
    var t = String(typed == null ? '' : typed).trim()
    var rows = []
    if (t) rows.push({ text: t, typed: true })
    var seen = Object.create(null)
    if (t) seen[t.toLowerCase()] = 1
    var cap = limit || 8
    var list = Array.isArray(suggestions) ? suggestions : []
    for (var i = 0; i < list.length && rows.length <= cap; i++) {
      var s = String(list[i] == null ? '' : list[i]).trim()
      if (!s) continue
      var k = s.toLowerCase()
      if (seen[k]) continue
      seen[k] = 1
      rows.push({ text: s, typed: false })
    }
    return rows
  }

  // Keyboard navigation over the rows. `idx` is the current highlight (-1 = the
  // input's own typed text, i.e. nothing highlighted). Returns the next index for
  // an arrow key, clamped so ArrowUp past the top returns to -1 (back to what was
  // typed) and ArrowDown stops at the last row. Pure.
  function nextIndex(idx, key, rowCount) {
    if (rowCount <= 0) return -1
    if (key === 'ArrowDown') return idx + 1 >= rowCount ? rowCount - 1 : idx + 1
    if (key === 'ArrowUp') return idx - 1 < -1 ? -1 : idx - 1
    return idx
  }

  return {
    createDebouncer: createDebouncer,
    createPrefetcher: createPrefetcher,
    buildRows: buildRows,
    nextIndex: nextIndex,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaYtSuggestModel
if (typeof window !== 'undefined') window.PapaYtSuggestModel = _PapaYtSuggestModel
