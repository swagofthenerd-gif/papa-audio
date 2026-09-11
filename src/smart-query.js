'use strict'
// Shared smart-query core — the search brain three surfaces reuse: the local
// library instant search, YouTube "did you mean", and the Soulseek spelling
// fixer. Pure and DOM-free so it is fully testable with no Electron and no
// disk.
//
// Three jobs, each independently useful:
//   1. tokenize()  — normalize a string into comparable tokens (lowercase,
//      diacritic-fold, strip punctuation). "Björk — Jóga (Live!)" and
//      "bjork joga live" tokenize to the same words, so accents and stray
//      punctuation never hide a match.
//   2. scoreQuery() — order-blind, multi-field relevance. The query tokens are
//      matched against a combined "artist | title | album" field. Every query
//      token must land SOMEWHERE (all-tokens-must-hit), each scored by its best
//      field with exact > prefix > close-typo. "creep radiohead" and
//      "radiohead creep" score identically because word order is ignored.
//   3. correctQuery() — vocabulary-based typo repair. Given the set of real
//      tokens in the library, an off-by-≤2 typo maps to its nearest vocab word
//      ONLY when that nearest word is unambiguous (a single clear winner). This
//      powers offline "did you mean" without asking any network.
//
// Named-global export like the other shared pure modules (library-sig.js): many
// scripts share one global scope in the renderer, so a bare top-level `var API`
// would let a later file clobber an earlier one.

var _PapaSmartQuery = (function () {

  // ── Tokenizer ──────────────────────────────────────────────────────────────
  // Fold combining diacritics (NFD splits "é" into "e" + U+0301, which we drop),
  // lowercase, then split on anything that is not a latin letter or digit. The
  // remaining tokens are the comparable words. "&" between words ("hall & oates")
  // becomes a separator, which is what we want — nobody types the ampersand the
  // same way twice.
  function _fold(str) {
    var s = String(str == null ? '' : str).toLowerCase()
    // normalize is present in every runtime we target (Node ≥ 8, Electron), but
    // guard it so a stubbed String prototype in a test can't throw.
    if (typeof s.normalize === 'function') {
      s = s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    }
    return s
  }

  function tokenize(str) {
    var folded = _fold(str)
    var out = []
    var raw = folded.split(/[^a-z0-9]+/)
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]) out.push(raw[i])
    }
    return out
  }

  // A single normalized string (space-joined tokens) — handy for exact-phrase
  // comparisons and for building the combined field key.
  function normalize(str) {
    return tokenize(str).join(' ')
  }

  // ── Edit distance ────────────────────────────────────────────────────────────
  // Bounded Levenshtein. We only ever care whether two short tokens are within a
  // small edit budget, so the classic full-matrix cost is irrelevant and a
  // length-gap early-out keeps the common "wildly different words" case at O(1).
  // Returns the true distance when it is ≤ maxDist, otherwise maxDist + 1.
  function editDistance(a, b, maxDist) {
    a = String(a == null ? '' : a)
    b = String(b == null ? '' : b)
    if (a === b) return 0
    if (typeof maxDist !== 'number' || maxDist < 0) maxDist = Infinity
    var la = a.length
    var lb = b.length
    if (Math.abs(la - lb) > maxDist) return maxDist + 1
    if (la === 0) return lb <= maxDist ? lb : maxDist + 1
    if (lb === 0) return la <= maxDist ? la : maxDist + 1

    // Two rolling rows.
    var prev = new Array(lb + 1)
    var cur = new Array(lb + 1)
    for (var j = 0; j <= lb; j++) prev[j] = j
    for (var i = 1; i <= la; i++) {
      cur[0] = i
      var rowMin = cur[0]
      var ca = a.charCodeAt(i - 1)
      for (var k = 1; k <= lb; k++) {
        var cost = ca === b.charCodeAt(k - 1) ? 0 : 1
        var del = prev[k] + 1
        var ins = cur[k - 1] + 1
        var sub = prev[k - 1] + cost
        var v = del < ins ? del : ins
        if (sub < v) v = sub
        cur[k] = v
        if (v < rowMin) rowMin = v
      }
      // If the whole row already exceeds the budget, no later row can recover.
      if (rowMin > maxDist) return maxDist + 1
      var tmp = prev; prev = cur; cur = tmp
    }
    var d = prev[lb]
    return d <= maxDist ? d : maxDist + 1
  }

  // ── Per-token field scoring ──────────────────────────────────────────────────
  // How well one query token matches one field token. A tiered score so the
  // ranking is stable and explainable:
  //   exact         → 1.0
  //   field startsWith query (prefix, ≥2 chars) → 0.75 .. 0.9 by coverage
  //   close typo (edit distance ≤ 2, scaled)    → up to ~0.55
  //   no match      → 0
  // Prefix beats typo on purpose: "rad" for "radiohead" is a deliberate prefix,
  // not a misspelling, and should rank above an edit-distance coincidence.
  var TYPO_MAX = 2

  function _tokenScore(q, field) {
    if (!q || !field) return 0
    if (q === field) return 1
    // Prefix: the field word begins with what was typed. Longer typed prefixes
    // are more confident. Require ≥ 2 typed chars so a lone letter doesn't
    // prefix-match half the library.
    if (q.length >= 2 && field.length > q.length && field.indexOf(q) === 0) {
      var cover = q.length / field.length // 0..1
      return 0.75 + 0.15 * cover
    }
    // Close typo. Budget grows with word length but never past TYPO_MAX, so
    // "kance" ~ "dance" counts but two-letter words can't drift into each other.
    var budget = Math.min(TYPO_MAX, Math.floor(Math.min(q.length, field.length) / 3) + 1)
    if (budget < 1) budget = 1
    var d = editDistance(q, field, budget)
    if (d <= budget && d > 0) {
      // Nearer edits score higher; normalize by the budget.
      return 0.55 * (1 - (d - 1) / budget) + 0.15
    }
    return 0
  }

  // The best score for one query token across all field tokens.
  function _bestFieldScore(q, fieldTokens) {
    var best = 0
    for (var i = 0; i < fieldTokens.length; i++) {
      var s = _tokenScore(q, fieldTokens[i])
      if (s > best) { best = s; if (best === 1) break }
    }
    return best
  }

  // ── Order-blind, all-tokens-must-hit scorer ──────────────────────────────────
  // Score a query against a pre-tokenized combined field. Returns 0 when any
  // query token fails to land anywhere — a query is a conjunction of terms, so a
  // record that matches "radiohead" but not "creep" is not a hit for
  // "radiohead creep". Otherwise the score is the mean per-token best score,
  // lightly boosted when the record is tight (few field tokens → the match is
  // more "about" the query). Order is irrelevant: we only ever look at the best
  // field token per query token.
  function scoreTokens(queryTokens, fieldTokens) {
    if (!queryTokens || !queryTokens.length) return 0
    if (!fieldTokens || !fieldTokens.length) return 0
    var sum = 0
    for (var i = 0; i < queryTokens.length; i++) {
      var s = _bestFieldScore(queryTokens[i], fieldTokens)
      if (s <= 0) return 0 // all-tokens-must-hit
      sum += s
    }
    var mean = sum / queryTokens.length
    // Tightness boost: a 2-word query hitting a 2-word field is a cleaner match
    // than the same query hitting a 12-word field. Small, capped, never enough
    // to overturn a stronger per-token score.
    var tightness = queryTokens.length / (fieldTokens.length + queryTokens.length)
    return mean * (1 + 0.08 * tightness)
  }

  // Convenience: score raw strings. `field` may be a single combined string or
  // an array of field strings (artist, title, album) that get concatenated.
  function scoreQuery(query, field) {
    var qTokens = tokenize(query)
    var fTokens
    if (Array.isArray(field)) {
      fTokens = []
      for (var i = 0; i < field.length; i++) {
        var t = tokenize(field[i])
        for (var j = 0; j < t.length; j++) fTokens.push(t[j])
      }
    } else {
      fTokens = tokenize(field)
    }
    return scoreTokens(qTokens, fTokens)
  }

  // ── Vocabulary-based corrector ───────────────────────────────────────────────
  // Build a vocabulary from records' combined fields: a token → frequency map.
  // Frequency lets ambiguity be broken sensibly and lets us keep the vocab small
  // and hot. `records` is an array of strings or arrays-of-strings.
  function buildVocabulary(records) {
    var vocab = Object.create(null)
    if (!records || !records.length) return vocab
    for (var i = 0; i < records.length; i++) {
      var rec = records[i]
      var toks
      if (Array.isArray(rec)) {
        toks = []
        for (var k = 0; k < rec.length; k++) {
          var t = tokenize(rec[k])
          for (var m = 0; m < t.length; m++) toks.push(t[m])
        }
      } else {
        toks = tokenize(rec)
      }
      for (var j = 0; j < toks.length; j++) {
        var w = toks[j]
        vocab[w] = (vocab[w] || 0) + 1
      }
    }
    return vocab
  }

  // Correct ONE token against the vocabulary. Returns the token unchanged when:
  //   - it is already in the vocab (a real word — never "correct" a real word),
  //   - nothing is within edit distance ≤ 2,
  //   - OR the nearest candidates are ambiguous.
  //
  // Ambiguity rule (the important one): among the closest candidates (those at
  // the minimum edit distance), a correction is only applied when there is a
  // SINGLE clear winner. Two vocab words tie at the same minimum distance and
  // neither is far more frequent than the other → we refuse, because "kid a" →
  // "kid b" is exactly the kind of guess that ruins trust. A candidate wins the
  // tie only if it is much more common than the runner-up (frequency dominance).
  var CORRECT_MAX = 2
  var FREQ_DOMINANCE = 3 // winner must be ≥ this many times as frequent to break a tie

  // `maxDist` lets a caller widen the correction reach beyond the scorer's own
  // typo tolerance so the "did you mean" fallback can rescue heavier misspellings
  // the scorer already gave up on (the library-index zero-hit path passes 3).
  function correctToken(token, vocab, maxDist) {
    var q = tokenize(token)[0] || _fold(token)
    if (!q) return { token: token, corrected: false }
    if (vocab && Object.prototype.hasOwnProperty.call(vocab, q)) {
      return { token: q, corrected: false } // already real
    }
    if (!vocab) return { token: q, corrected: false }

    var cap = typeof maxDist === 'number' && maxDist > 0 ? maxDist : CORRECT_MAX
    var budget = Math.min(cap, Math.floor(q.length / 3) + 1)
    if (budget < 1) budget = 1
    // Very short words are too easy to turn into a different real word; only
    // correct when there is a genuinely near, dominant candidate.
    var bestDist = Infinity
    var atBest = [] // [{ word, freq }]
    for (var w in vocab) {
      // Length gate before the (bounded) distance work.
      if (Math.abs(w.length - q.length) > budget) continue
      var d = editDistance(q, w, budget)
      if (d > budget) continue
      if (d < bestDist) {
        bestDist = d
        atBest = [{ word: w, freq: vocab[w] }]
      } else if (d === bestDist) {
        atBest.push({ word: w, freq: vocab[w] })
      }
    }
    if (!atBest.length || bestDist === 0) return { token: q, corrected: false }

    if (atBest.length === 1) {
      return { token: atBest[0].word, corrected: true, distance: bestDist }
    }
    // Tie at the minimum distance → require frequency dominance to pick one.
    atBest.sort(function (a, b) { return b.freq - a.freq })
    if (atBest[0].freq >= atBest[1].freq * FREQ_DOMINANCE && atBest[0].freq > 1) {
      return { token: atBest[0].word, corrected: true, distance: bestDist, tiebroken: true }
    }
    // Ambiguous — leave it alone.
    return { token: q, corrected: false, ambiguous: true }
  }

  // The nearest real words to a token, for building "did you mean" alternatives
  // when correctToken refuses (ambiguous tie) or when several plausible fixes
  // deserve to be offered side by side. Sorted by distance, then frequency.
  // A token that is itself a real word returns only itself at distance 0.
  function nearestTokens(token, vocab, maxDist, limit) {
    var q = tokenize(token)[0] || _fold(token)
    if (!q || !vocab) return []
    if (Object.prototype.hasOwnProperty.call(vocab, q)) return [{ word: q, dist: 0, freq: vocab[q] }]
    var cap = typeof maxDist === 'number' && maxDist > 0 ? maxDist : CORRECT_MAX
    var budget = Math.min(cap, Math.floor(q.length / 3) + 1)
    if (budget < 1) budget = 1
    var out = []
    for (var w in vocab) {
      if (Math.abs(w.length - q.length) > budget) continue
      var d = editDistance(q, w, budget)
      if (d > budget) continue
      out.push({ word: w, dist: d, freq: vocab[w] })
    }
    out.sort(function (a, b) { return a.dist - b.dist || b.freq - a.freq || (a.word < b.word ? -1 : 1) })
    return out.slice(0, limit > 0 ? limit : 3)
  }

  // Correct a whole query token-by-token against the vocab. Returns the possibly-
  // corrected string plus whether anything changed, so the caller can show a
  // "did you mean" note only when a real fix happened.
  function correctQuery(query, vocab, maxDist) {
    var toks = tokenize(query)
    if (!toks.length) return { query: '', corrected: false, tokens: [] }
    var out = []
    var changed = false
    for (var i = 0; i < toks.length; i++) {
      var r = correctToken(toks[i], vocab, maxDist)
      out.push(r.token)
      if (r.corrected && r.token !== toks[i]) changed = true
    }
    return { query: out.join(' '), corrected: changed, tokens: out, original: toks.join(' ') }
  }

  // ── Small-edit spelling-fix detector (Soulseek gate) ─────────────────────────
  // Decide whether a candidate string (e.g. a YouTube suggestion) is a plain
  // spelling fix of the query rather than a different intent. The rule is strict
  // on purpose so we never redirect a real search to something the user didn't
  // ask for:
  //   - same number of tokens (a suggestion that adds/drops words is a different
  //     search, not a spelling fix),
  //   - each token pair within edit distance ≤ 2,
  //   - at least one token actually differs (otherwise there's nothing to fix),
  //   - AND the total edit distance stays within a small budget so a string of
  //     tiny drifts across many words can't masquerade as one correction.
  var SLSK_PER_TOKEN = 2
  var SLSK_TOTAL = 4

  // vocab is optional: when given, a query whose every token is already a real
  // word in the user's library is NEVER "corrected" — the user searched for a
  // thing they own ("camel" the band), not a typo of something more popular.
  function isSpellingFix(query, candidate, vocab) {
    var a = tokenize(query)
    var b = tokenize(candidate)
    if (!a.length || a.length !== b.length) return false
    if (vocab) {
      var allReal = true
      for (var v = 0; v < a.length; v++) {
        if (!Object.prototype.hasOwnProperty.call(vocab, a[v])) { allReal = false; break }
      }
      if (allReal) return false
    }
    var total = 0
    var anyDiff = false
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) anyDiff = true
      // Growing a word by appending ("camel" -> "camelot") is AUTOCOMPLETE,
      // not a spelling repair — the field bug that turned a real band into a
      // musical. Same for the reverse (truncation). A repair changes letters
      // within a word; a strict prefix relationship never qualifies.
      if (a[i] !== b[i] && (b[i].indexOf(a[i]) === 0 || a[i].indexOf(b[i]) === 0)) return false
      var d = editDistance(a[i], b[i], SLSK_PER_TOKEN)
      if (d > SLSK_PER_TOKEN) return false
      total += d
    }
    if (!anyDiff) return false
    if (total > SLSK_TOTAL) return false
    return true
  }

  return {
    tokenize: tokenize,
    normalize: normalize,
    editDistance: editDistance,
    scoreTokens: scoreTokens,
    scoreQuery: scoreQuery,
    buildVocabulary: buildVocabulary,
    correctToken: correctToken,
    nearestTokens: nearestTokens,
    correctQuery: correctQuery,
    isSpellingFix: isSpellingFix,
    _tokenScore: _tokenScore,
    TYPO_MAX: TYPO_MAX,
    CORRECT_MAX: CORRECT_MAX,
    FREQ_DOMINANCE: FREQ_DOMINANCE,
    SLSK_PER_TOKEN: SLSK_PER_TOKEN,
    SLSK_TOTAL: SLSK_TOTAL,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaSmartQuery
if (typeof window !== 'undefined') window.PapaSmartQuery = _PapaSmartQuery
