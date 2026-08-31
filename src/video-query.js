'use strict';
// Natural-language search parser for the Movies & TV search box (§40 of
// docs/papa-cinema-plan.md).
//
// Today the search box does one thing: it puts whatever was typed into a title
// query. A cinephile does not type titles. They type "korean thrillers from the
// 90s", "under 90 minutes", "best of 1994", "films like parasite" -- sentences
// that describe a shelf, not a film. Matched literally, every one of those
// returns nothing, and the user concludes the library is empty when it is only
// the query that was wrong.
//
// This module turns that sentence into a structured query and, just as
// importantly, reports what it could NOT interpret. A parser that silently
// swallows half the input is worse than one that returns nothing at all: the
// user gets a screenful of results that quietly ignore the constraint they
// cared about, and has no way to tell. So every recognised fragment carries the
// character span it came from, everything unrecognised survives verbatim in
// `text`, and `confidence` is the honest fraction of meaningful input that was
// understood.
//
// It is a pure function of a string. No I/O, no DOM, no Electron, no network.
// It does not resolve "kurosawa" to a TMDB person id or "parasite" to a movie
// id -- that needs the catalogue and belongs to the caller. It only decides
// *what kind of thing* each fragment is.
//
// UMD-wrapped like video-store.js / video-enrich.js so it loads as a classic
// script in the renderer without leaking bindings into the shared scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoQuery = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---------------------------------------------------------------------------
  // Vocabularies
  // ---------------------------------------------------------------------------

  // TMDB genre names, keyed by every spelling a person actually types. Plurals
  // are handled by a trailing-s fallback at lookup time rather than being
  // enumerated here.
  const GENRES = {
    'action': 'Action',
    'adventure': 'Adventure',
    'animation': 'Animation',
    'animated': 'Animation',
    'cartoon': 'Animation',
    'comedy': 'Comedy',
    'comedies': 'Comedy',
    'crime': 'Crime',
    'documentary': 'Documentary',
    'documentaries': 'Documentary',
    'doc': 'Documentary',
    'docs': 'Documentary',
    'drama': 'Drama',
    'family': 'Family',
    'fantasy': 'Fantasy',
    'history': 'History',
    'historical': 'History',
    'horror': 'Horror',
    'music': 'Music',
    'musical': 'Music',
    'musicals': 'Music',
    'mystery': 'Mystery',
    'mysteries': 'Mystery',
    'romance': 'Romance',
    'romantic': 'Romance',
    'science fiction': 'Science Fiction',
    'scifi': 'Science Fiction',
    'sci-fi': 'Science Fiction',
    'sf': 'Science Fiction',
    'tv movie': 'TV Movie',
    'thriller': 'Thriller',
    'thrillers': 'Thriller',
    'war': 'War',
    'western': 'Western',
    'westerns': 'Western',
  }

  // Nationality adjective -> ISO country. The adjective form is the one people
  // type ("korean films"), almost never the country ("films from South Korea"),
  // which is why the adjective table is the primary one and the noun table
  // below only serves explicit "from <place>" phrasing.
  const NATIONALITIES = {
    'korean': 'KR', 'japanese': 'JP', 'chinese': 'CN', 'taiwanese': 'TW',
    'french': 'FR', 'italian': 'IT', 'german': 'DE', 'austrian': 'AT',
    'spanish': 'ES', 'mexican': 'MX', 'argentine': 'AR', 'argentinian': 'AR',
    'chilean': 'CL', 'brazilian': 'BR', 'portuguese': 'PT',
    'british': 'GB', 'scottish': 'GB', 'welsh': 'GB', 'irish': 'IE',
    'american': 'US', 'canadian': 'CA', 'australian': 'AU',
    'russian': 'RU', 'soviet': 'RU', 'ukrainian': 'UA', 'georgian': 'GE',
    'polish': 'PL', 'czech': 'CZ', 'hungarian': 'HU', 'romanian': 'RO',
    'swedish': 'SE', 'danish': 'DK', 'norwegian': 'NO', 'finnish': 'FI',
    'icelandic': 'IS', 'dutch': 'NL', 'belgian': 'BE', 'swiss': 'CH',
    'greek': 'GR', 'turkish': 'TR', 'israeli': 'IL', 'iranian': 'IR',
    'egyptian': 'EG', 'nigerian': 'NG', 'senegalese': 'SN',
    'indian': 'IN', 'thai': 'TH', 'vietnamese': 'VN', 'indonesian': 'ID',
    'filipino': 'PH',
  }

  const COUNTRY_NOUNS = {
    'korea': 'KR', 'south korea': 'KR', 'north korea': 'KP', 'japan': 'JP',
    'china': 'CN', 'taiwan': 'TW', 'hong kong': 'HK', 'france': 'FR',
    'italy': 'IT', 'germany': 'DE', 'austria': 'AT', 'spain': 'ES',
    'mexico': 'MX', 'argentina': 'AR', 'chile': 'CL', 'brazil': 'BR',
    'portugal': 'PT', 'uk': 'GB', 'britain': 'GB', 'england': 'GB',
    'ireland': 'IE', 'usa': 'US', 'us': 'US', 'america': 'US',
    'canada': 'CA', 'australia': 'AU', 'russia': 'RU', 'ukraine': 'UA',
    'poland': 'PL', 'hungary': 'HU', 'romania': 'RO', 'sweden': 'SE',
    'denmark': 'DK', 'norway': 'NO', 'finland': 'FI', 'iceland': 'IS',
    'netherlands': 'NL', 'holland': 'NL', 'belgium': 'BE',
    'switzerland': 'CH', 'greece': 'GR', 'turkey': 'TR', 'israel': 'IL',
    'iran': 'IR', 'egypt': 'EG', 'nigeria': 'NG', 'senegal': 'SN',
    'india': 'IN', 'thailand': 'TH', 'vietnam': 'VN', 'indonesia': 'ID',
    'philippines': 'PH',
  }

  // Only consulted for explicit language phrasing ("in japanese", "spanish
  // language"). "korean films" is a country claim, not a language one -- a
  // Korean-language film shot in the US is not what the user meant.
  const LANGUAGES = {
    'korean': 'ko', 'japanese': 'ja', 'mandarin': 'zh', 'cantonese': 'zh',
    'chinese': 'zh', 'french': 'fr', 'italian': 'it', 'german': 'de',
    'spanish': 'es', 'portuguese': 'pt', 'english': 'en', 'russian': 'ru',
    'polish': 'pl', 'czech': 'cs', 'hungarian': 'hu', 'romanian': 'ro',
    'swedish': 'sv', 'danish': 'da', 'norwegian': 'no', 'finnish': 'fi',
    'icelandic': 'is', 'dutch': 'nl', 'greek': 'el', 'turkish': 'tr',
    'hebrew': 'he', 'persian': 'fa', 'farsi': 'fa', 'arabic': 'ar',
    'hindi': 'hi', 'tamil': 'ta', 'telugu': 'te', 'thai': 'th',
    'vietnamese': 'vi', 'indonesian': 'id', 'tagalog': 'tl',
  }

  // Film movements. These must be tried before the nationality table, or
  // "french new wave" degrades into a plain France filter and loses the point.
  const MOVEMENTS = {
    'french new wave': 'French New Wave',
    'nouvelle vague': 'French New Wave',
    'italian neorealism': 'Italian Neorealism',
    'neorealism': 'Italian Neorealism',
    'german expressionism': 'German Expressionism',
    'new hollywood': 'New Hollywood',
    'japanese new wave': 'Japanese New Wave',
    'british new wave': 'British New Wave',
    'czech new wave': 'Czech New Wave',
    'iranian new wave': 'Iranian New Wave',
    'hong kong new wave': 'Hong Kong New Wave',
    'soviet montage': 'Soviet Montage',
    'poetic realism': 'Poetic Realism',
    'cinema novo': 'Cinema Novo',
    'dogme 95': 'Dogme 95',
    'mumblecore': 'Mumblecore',
    'new queer cinema': 'New Queer Cinema',
  }

  // Themes that map to catalogue keywords rather than genres.
  const KEYWORDS = {
    'neo-noir': 'neo-noir',
    'neo noir': 'neo-noir',
    'film noir': 'film noir',
    'noir': 'film noir',
    'heist': 'heist',
    'revenge': 'revenge',
    'coming of age': 'coming of age',
    'coming-of-age': 'coming of age',
    'time travel': 'time travel',
    'cyberpunk': 'cyberpunk',
    'post-apocalyptic': 'post-apocalyptic',
    'post apocalyptic': 'post-apocalyptic',
    'dystopian': 'dystopia',
    'dystopia': 'dystopia',
    'zombie': 'zombie',
    'zombies': 'zombie',
    'vampire': 'vampire',
    'vampires': 'vampire',
    'serial killer': 'serial killer',
    'courtroom': 'courtroom',
    'road movie': 'road movie',
    'found footage': 'found footage',
    'slasher': 'slasher',
    'giallo': 'giallo',
    'kaiju': 'kaiju',
    'samurai': 'samurai',
    'yakuza': 'yakuza',
    'spaghetti western': 'spaghetti western',
    'body horror': 'body horror',
    'folk horror': 'folk horror',
  }

  const CATALOGS = {
    'anime': 'anime',
    'tv': 'tv', 'series': 'tv', 'show': 'tv', 'shows': 'tv',
    'tv show': 'tv', 'tv shows': 'tv', 'television': 'tv',
    'film': 'movie', 'films': 'movie', 'movie': 'movie', 'movies': 'movie',
    'cinema': 'movie', 'flick': 'movie', 'flicks': 'movie',
  }

  const WORD_DECADES = {
    'twenties': 1920, 'thirties': 1930, 'forties': 1940, 'fifties': 1950,
    'sixties': 1960, 'seventies': 1970, 'eighties': 1980, 'nineties': 1990,
    'noughties': 2000, 'aughts': 2000,
  }

  // "1917" is a Sam Mendes film. "1984" is a novel, two films and a year.
  // "2012" is a Roland Emmerich film. Nothing in the string can settle it, so
  // the parser refuses to guess: these numbers only become a year filter when
  // the user attached an explicit cue ("from 1917", "best of 1984"). Bare, they
  // stay in the residual text and are searched as a title -- the reading that
  // is recoverable, because a user who meant the year can add one word, while a
  // user who wanted the film cannot un-filter a result set that never contained
  // it.
  const AMBIGUOUS_TITLE_YEARS = new Set([1900, 1917, 1941, 1984, 1987, 1997, 2012, 2046, 2049])

  const MIN_YEAR = 1874
  const MAX_YEAR = new Date().getFullYear() + 5

  // A rating sort without a vote floor surfaces the film with one 10/10 review.
  // §46 of the plan hit exactly this on director filmographies.
  const VOTE_FLOOR = 500

  const FROM_CUES = new Set(['from', 'in', 'of', 'during'])
  const FILLER = new Set(['of', 'from', 'and', 'or', 'a', 'an', 'some', 'me', 'show', 'find', 'search'])

  // ---------------------------------------------------------------------------
  // Tokenising
  // ---------------------------------------------------------------------------

  // Tokens keep their original character span so every intent can point back at
  // the exact substring it came from and the residual can be rebuilt verbatim.
  function tokenize(text) {
    const out = []
    const re = /[A-Za-z0-9][A-Za-z0-9'’À-ɏ-]*/g
    let m
    while ((m = re.exec(text)) !== null) {
      const raw = m[0]
      out.push({ raw: raw, norm: normalize(raw), start: m.index, end: m.index + raw.length })
    }
    return out
  }

  // "1960's" and "1960s" are the same decade; "Sci-Fi" and "sci-fi" the same
  // genre. Trailing possessives are stripped, interior hyphens are not, because
  // "neo-noir" and "post-apocalyptic" need them.
  function normalize(word) {
    let w = word.toLowerCase().replace(/[’]/g, "'")
    w = w.replace(/^(\d{2,4})'s$/, '$1s')
    w = w.replace(/'s$/, '')
    w = w.replace(/^-+|-+$/g, '')
    return w
  }

  // ---------------------------------------------------------------------------
  // Parser state
  // ---------------------------------------------------------------------------

  function emptyFilters() {
    return {
      yearFrom: null, yearTo: null,
      runtimeFrom: null, runtimeTo: null,
      genres: [],
      country: null,
      language: null,
      sort: null,
      minRating: null,
      minVotes: null,
      catalog: null,
      personName: null,
      similarTo: null,
      keyword: null,
      movement: null,
    }
  }

  function createState(text) {
    const toks = tokenize(text)
    return {
      raw: text,
      toks: toks,
      claimed: new Array(toks.length).fill(false),
      intents: [],
      filters: emptyFilters(),
    }
  }

  function free(st, i, j) {
    if (i < 0 || j > st.toks.length || i >= j) return false
    for (let k = i; k < j; k++) if (st.claimed[k]) return false
    return true
  }

  function claim(st, i, j, kind, value, confidence) {
    for (let k = i; k < j; k++) st.claimed[k] = true
    const start = st.toks[i].start
    const end = st.toks[j - 1].end
    st.intents.push({
      kind: kind,
      value: value,
      source: st.raw.slice(start, end),
      span: [start, end],
      confidence: confidence,
    })
  }

  // Phrase lookup: longest run of free tokens starting at i, up to `max` words.
  function phraseAt(st, i, table, max) {
    const limit = Math.min(max, st.toks.length - i)
    for (let n = limit; n >= 1; n--) {
      if (!free(st, i, i + n)) continue
      const key = st.toks.slice(i, i + n).map(function (t) { return t.norm }).join(' ')
      if (Object.prototype.hasOwnProperty.call(table, key)) {
        return { n: n, value: table[key], key: key }
      }
    }
    return null
  }

  function isYearNumber(n) { return n >= MIN_YEAR && n <= MAX_YEAR }

  function asYear(tok) {
    if (!tok) return null
    if (!/^\d{4}$/.test(tok.norm)) return null
    const n = parseInt(tok.norm, 10)
    return isYearNumber(n) ? n : null
  }

  // ---------------------------------------------------------------------------
  // Matchers, most specific first. Each claims the tokens it consumed so a
  // later, looser matcher cannot re-read them; that ordering is what makes the
  // parse order-independent, because every matcher scans the whole token list.
  // ---------------------------------------------------------------------------

  // "films like parasite", "similar to parasite", "more like the thing".
  // Consumes everything after the cue: a title is an open-ended run of words and
  // there is no reliable way to know where it ends, so the cue is only honoured
  // when something follows it.
  function matchSimilar(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const a = st.toks[i].norm
      let n = 0
      if (a === 'like') n = 1
      else if (a === 'similar' && st.toks[i + 1] && st.toks[i + 1].norm === 'to') n = 2
      else if (a === 'resembling') n = 1
      if (!n) continue
      const rest = i + n
      if (rest >= st.toks.length) continue
      if (!free(st, rest, st.toks.length)) continue
      const title = st.raw.slice(st.toks[rest].start, st.toks[st.toks.length - 1].end)
        .replace(/["'“”]/g, '').trim()
      if (!title) continue
      st.filters.similarTo = title
      claim(st, i, st.toks.length, 'similarTo', title, 0.9)
      return
    }
  }

  // "directed by kurosawa", "by kurosawa", "starring toshiro mifune".
  // Only an explicit cue sets personName. A bare "kurosawa" is left in the
  // residual on purpose: the parser cannot tell a surname from a title, and the
  // caller can try both against the catalogue, which it cannot do once the
  // parser has already committed.
  function matchPerson(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const a = st.toks[i].norm
      const b = st.toks[i + 1] ? st.toks[i + 1].norm : null
      let n = 0
      let role = null
      if (a === 'directed' && b === 'by') { n = 2; role = 'director' }
      else if (a === 'director' && b === 'is') { n = 2; role = 'director' }
      else if (a === 'starring') { n = 1; role = 'cast' }
      else if (a === 'with' && b) { n = 1; role = 'cast' }
      else if (a === 'by' && b) { n = 1; role = 'director' }
      if (!n) continue
      const rest = i + n
      if (rest >= st.toks.length || !free(st, rest, st.toks.length)) continue
      const name = st.raw.slice(st.toks[rest].start, st.toks[st.toks.length - 1].end).trim()
      if (!name) continue
      st.filters.personName = name
      st.filters.personRole = role
      claim(st, i, st.toks.length, 'person', name, 0.85)
      return
    }
  }

  // "between 1960 and 1975".
  function matchYearRange(st) {
    for (let i = 0; i + 3 < st.toks.length; i++) {
      if (st.toks[i].norm !== 'between') continue
      const y1 = asYear(st.toks[i + 1])
      const y2 = asYear(st.toks[i + 3])
      if (y1 === null || y2 === null) continue
      if (st.toks[i + 2].norm !== 'and' && st.toks[i + 2].norm !== 'to') continue
      if (!free(st, i, i + 4)) continue
      const lo = Math.min(y1, y2)
      const hi = Math.max(y1, y2)
      st.filters.yearFrom = lo
      st.filters.yearTo = hi
      claim(st, i, i + 4, 'yearRange', { from: lo, to: hi }, 0.95)
    }
  }

  // Runtime, in every phrasing that turns up: "under 90 minutes", "over 3
  // hours", "under 2h", "90 mins or less", "at least 100 min".
  const UNIT_RE = /^(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/
  const ATTACHED_RE = /^(\d{1,3}(?:\.\d+)?)(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/

  function unitToMinutes(value, unit) {
    return /^h/.test(unit) ? Math.round(value * 60) : Math.round(value)
  }

  // Returns { minutes, next } for a quantity starting at i, or null.
  function quantityAt(st, i) {
    const t = st.toks[i]
    if (!t) return null
    const attached = ATTACHED_RE.exec(t.norm)
    if (attached) {
      return { minutes: unitToMinutes(parseFloat(attached[1]), attached[2]), next: i + 1 }
    }
    if (!/^\d{1,3}(\.\d+)?$/.test(t.norm)) return null
    const u = st.toks[i + 1]
    if (u && UNIT_RE.test(u.norm)) {
      return { minutes: unitToMinutes(parseFloat(t.norm), u.norm), next: i + 2 }
    }
    return null
  }

  function matchRuntime(st) {
    const LESS = ['under', 'below', 'less than', 'shorter than', 'at most', 'no longer than', 'up to', 'max'];
    const MORE = ['over', 'above', 'more than', 'longer than', 'at least', 'no shorter than', 'min']

    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      // Leading comparator.
      let dir = null
      let cueLen = 0
      const one = st.toks[i].norm
      const two = st.toks[i + 1] ? one + ' ' + st.toks[i + 1].norm : null
      const three = st.toks[i + 2] && two ? two + ' ' + st.toks[i + 2].norm : null
      for (const phrase of LESS) {
        const words = phrase.split(' ').length
        const probe = words === 1 ? one : words === 2 ? two : three
        if (probe === phrase) { dir = 'to'; cueLen = words; break }
      }
      if (!dir) {
        for (const phrase of MORE) {
          const words = phrase.split(' ').length
          const probe = words === 1 ? one : words === 2 ? two : three
          if (probe === phrase) { dir = 'from'; cueLen = words; break }
        }
      }
      if (!dir) continue
      const q = quantityAt(st, i + cueLen)
      if (!q) continue
      if (!free(st, i, q.next)) continue
      if (dir === 'to') st.filters.runtimeTo = q.minutes
      else st.filters.runtimeFrom = q.minutes
      claim(st, i, q.next, 'runtime', dir === 'to' ? { to: q.minutes } : { from: q.minutes }, 0.95)
    }

    // Trailing comparator: "90 mins or less", "2 hours or more".
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const q = quantityAt(st, i)
      if (!q) continue
      const a = st.toks[q.next] ? st.toks[q.next].norm : null
      const b = st.toks[q.next + 1] ? st.toks[q.next + 1].norm : null
      if (a !== 'or' || !b) continue
      let dir = null
      if (b === 'less' || b === 'under' || b === 'shorter' || b === 'fewer') dir = 'to'
      else if (b === 'more' || b === 'over' || b === 'longer') dir = 'from'
      if (!dir) continue
      if (!free(st, i, q.next + 2)) continue
      if (dir === 'to') st.filters.runtimeTo = q.minutes
      else st.filters.runtimeFrom = q.minutes
      claim(st, i, q.next + 2, 'runtime', dir === 'to' ? { to: q.minutes } : { from: q.minutes }, 0.95)
    }
  }

  // Decades: "1970s", "90s", "the nineties", "1960's", "mid-90s".
  function matchDecade(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const n = st.toks[i].norm
      let base = null
      let conf = 0.95
      let m = /^(\d{4})s$/.exec(n)
      if (m) {
        const y = parseInt(m[1], 10)
        if (y % 10 === 0 && isYearNumber(y)) base = y
      }
      if (base === null) {
        m = /^(\d{2})s$/.exec(n)
        if (m) {
          const two = parseInt(m[1], 10)
          if (two % 10 === 0) {
            // "20s" reads as 2020s today and "90s" as 1990s; the boundary sits
            // where living memory does, not where the century does.
            base = two <= 20 ? 2000 + two : 1900 + two
            conf = 0.85
          }
        }
      }
      if (base === null && Object.prototype.hasOwnProperty.call(WORD_DECADES, n)) {
        base = WORD_DECADES[n]
        conf = 0.9
      }
      if (base === null) continue

      // Absorb an immediately preceding "the" / "from" / "in" / "mid" so they do
      // not survive into the residual as noise.
      let start = i
      while (start > 0 && free(st, start - 1, start) &&
             ['the', 'from', 'in', 'of', 'during', 'mid', 'early', 'late'].indexOf(st.toks[start - 1].norm) !== -1) {
        start--
      }
      st.filters.yearFrom = base
      st.filters.yearTo = base + 9
      claim(st, start, i + 1, 'decade', { from: base, to: base + 9 }, conf)
    }
  }

  // Cued years: "from 1994", "in 1994", "before 1980", "after 2010",
  // "since 1990", "best of 1994".
  function matchCuedYear(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const cue = st.toks[i].norm
      const y = asYear(st.toks[i + 1])
      if (y === null) continue
      if (!free(st, i, i + 2)) continue
      let applied = true
      if (cue === 'before' || cue === 'pre') {
        st.filters.yearTo = y - 1
      } else if (cue === 'after' || cue === 'post') {
        st.filters.yearFrom = y + 1
      } else if (cue === 'since') {
        st.filters.yearFrom = y
      } else if (cue === 'until') {
        st.filters.yearTo = y
      } else if (FROM_CUES.has(cue)) {
        // "from 1994" means the year 1994, not everything after it. "since
        // 1994" is the open-ended one, and is handled above.
        st.filters.yearFrom = y
        st.filters.yearTo = y
      } else {
        applied = false
      }
      if (!applied) continue
      claim(st, i, i + 2, 'year', { from: st.filters.yearFrom, to: st.filters.yearTo }, 0.95)
    }
  }

  // "best of", "top rated", "highest rated", "best". A rating sort is useless
  // without a vote floor -- see VOTE_FLOOR.
  function matchSort(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const a = st.toks[i].norm
      const b = st.toks[i + 1] ? st.toks[i + 1].norm : null
      let n = 0
      let sort = null
      if ((a === 'top' || a === 'highest' || a === 'best') && (b === 'rated' || b === 'reviewed')) { n = 2; sort = 'rating.desc' }
      else if (a === 'best' && b === 'of') { n = 1; sort = 'rating.desc' } // leave "of <year>" to the year matcher
      else if (a === 'best' || a === 'greatest' || a === 'acclaimed') { n = 1; sort = 'rating.desc' }
      else if (a === 'popular' || a === 'trending') { n = 1; sort = 'popularity.desc' }
      else if (a === 'newest' || a === 'latest' || a === 'recent') { n = 1; sort = 'release.desc' }
      else if (a === 'oldest') { n = 1; sort = 'release.asc' }
      if (!n) continue
      if (!free(st, i, i + n)) continue
      st.filters.sort = sort
      if (sort === 'rating.desc') st.filters.minVotes = VOTE_FLOOR
      claim(st, i, i + n, 'sort', sort, 0.9)
    }
  }

  // "rated above 8", "8+", "over 7.5".
  function matchMinRating(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const m = /^(\d(?:\.\d)?)\+$/.exec(st.toks[i].raw.toLowerCase())
      if (m) {
        st.filters.minRating = parseFloat(m[1])
        st.filters.minVotes = st.filters.minVotes || VOTE_FLOOR
        claim(st, i, i + 1, 'minRating', st.filters.minRating, 0.85)
        continue
      }
      if (st.toks[i].norm !== 'rated') continue
      const cue = st.toks[i + 1] ? st.toks[i + 1].norm : null
      const num = st.toks[i + 2] ? st.toks[i + 2].norm : null
      if ((cue === 'above' || cue === 'over') && num && /^\d(\.\d)?$/.test(num) && free(st, i, i + 3)) {
        st.filters.minRating = parseFloat(num)
        st.filters.minVotes = st.filters.minVotes || VOTE_FLOOR
        claim(st, i, i + 3, 'minRating', st.filters.minRating, 0.9)
      }
    }
  }

  function matchMovement(st) {
    for (let i = 0; i < st.toks.length; i++) {
      const hit = phraseAt(st, i, MOVEMENTS, 4)
      if (!hit) continue
      // A bare "neorealism" or "mumblecore" is unambiguous; the multi-word ones
      // are stronger still.
      st.filters.movement = hit.value
      claim(st, i, i + hit.n, 'movement', hit.value, hit.n > 1 ? 0.95 : 0.8)
    }
  }

  function matchKeyword(st) {
    for (let i = 0; i < st.toks.length; i++) {
      const hit = phraseAt(st, i, KEYWORDS, 3)
      if (!hit) continue
      // Guard: "the heist" / "the noir" reads as the start of a title far more
      // often than as a theme.
      if (i > 0 && st.toks[i - 1].norm === 'the' && !st.claimed[i - 1]) continue
      st.filters.keyword = hit.value
      claim(st, i, i + hit.n, 'keyword', hit.value, hit.n > 1 ? 0.9 : 0.75)
    }
  }

  function matchCatalog(st) {
    for (let i = 0; i < st.toks.length; i++) {
      const hit = phraseAt(st, i, CATALOGS, 2)
      if (!hit) continue
      if (i > 0 && st.toks[i - 1].norm === 'the' && !st.claimed[i - 1]) continue
      // "movie" late in a title ("the movie") is noise, but as a standalone
      // catalogue word it is exactly the signal we want. Only the first wins,
      // so "anime series" resolves to anime.
      if (st.filters.catalog === null) st.filters.catalog = hit.value
      claim(st, i, i + hit.n, 'catalog', hit.value, 0.85)
    }
  }

  function matchGenre(st) {
    for (let i = 0; i < st.toks.length; i++) {
      let hit = phraseAt(st, i, GENRES, 2)
      if (!hit) {
        // Plural fallback, so "westerns" and "dramas" work without enumerating.
        if (free(st, i, i + 1)) {
          const n = st.toks[i].norm
          const singular = /s$/.test(n) ? n.replace(/s$/, '') : null
          if (singular && Object.prototype.hasOwnProperty.call(GENRES, singular)) {
            hit = { n: 1, value: GENRES[singular], key: singular }
          }
        }
      }
      if (!hit) continue
      if (i > 0 && st.toks[i - 1].norm === 'the' && !st.claimed[i - 1]) continue
      if (st.filters.genres.indexOf(hit.value) === -1) st.filters.genres.push(hit.value)
      claim(st, i, i + hit.n, 'genre', hit.value, hit.n > 1 || /s$/.test(hit.key) ? 0.9 : 0.8)
    }
  }

  // Explicit language phrasing only.
  function matchLanguage(st) {
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const n = st.toks[i].norm
      // "in japanese", "spoken in french"
      if ((n === 'in' || n === 'spoken') && st.toks[i + 1]) {
        let j = i + 1
        if (n === 'spoken' && st.toks[j].norm === 'in') j++
        const lang = st.toks[j] ? LANGUAGES[st.toks[j].norm] : null
        if (lang && free(st, i, j + 1)) {
          st.filters.language = lang
          claim(st, i, j + 1, 'language', lang, 0.9)
          continue
        }
      }
      // "japanese language", "japanese-language"
      const lang = LANGUAGES[n]
      const next = st.toks[i + 1]
      if (lang && next && next.norm === 'language' && free(st, i, i + 2)) {
        st.filters.language = lang
        claim(st, i, i + 2, 'language', lang, 0.9)
      }
    }
  }

  // Country, and the place where over-matching does the most damage.
  //
  // "the french dispatch" is a Wes Anderson film, not a request for French
  // cinema. A nationality adjective is only a filter when something in the
  // sentence corroborates it: it is followed by a catalogue or genre word
  // ("korean films", "french thrillers"), or it sits next to another recognised
  // intent, or it is the entire query. An adjective followed by an ordinary
  // unrecognised noun is treated as part of a title, because that is what it
  // usually is -- and getting this wrong makes the search actively worse than
  // the literal title match it replaced.
  function matchCountry(st) {
    // Explicit "from <place>" is never ambiguous.
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const n = st.toks[i].norm
      if (n !== 'from' && n !== 'in') continue
      const hit = phraseAt(st, i + 1, COUNTRY_NOUNS, 2)
      if (hit && free(st, i, i + 1 + hit.n)) {
        st.filters.country = hit.value
        claim(st, i, i + 1 + hit.n, 'country', hit.value, 0.95)
        continue
      }
      const adj = st.toks[i + 1] ? NATIONALITIES[st.toks[i + 1].norm] : null
      if (adj && free(st, i, i + 2)) {
        st.filters.country = adj
        claim(st, i, i + 2, 'country', adj, 0.9)
      }
    }

    // Bare country nouns, only when they are the whole remaining thought.
    for (let i = 0; i < st.toks.length; i++) {
      const hit = phraseAt(st, i, COUNTRY_NOUNS, 2)
      if (!hit) continue
      const nextFree = st.toks[i + hit.n] && !st.claimed[i + hit.n]
      if (nextFree) continue
      const prevFree = i > 0 && !st.claimed[i - 1]
      if (prevFree) continue
      if (st.filters.country) continue
      st.filters.country = hit.value
      claim(st, i, i + hit.n, 'country', hit.value, 0.7)
    }

    // Nationality adjectives, corroboration required.
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const code = NATIONALITIES[st.toks[i].norm]
      if (!code) continue
      if (i > 0 && !st.claimed[i - 1] && st.toks[i - 1].norm === 'the') continue

      const after = st.toks[i + 1]
      const before = st.toks[i - 1]
      const followsIntent = after ? st.claimed[i + 1] : false
      const precedesIntent = before ? st.claimed[i - 1] : false
      const alone = st.toks.length === 1
      // A free unrecognised word to the right is the "french dispatch" case.
      const blockedByNoun = !!(after && !st.claimed[i + 1])

      let conf = 0
      if (followsIntent) conf = 0.9
      else if (!after && precedesIntent) conf = 0.85
      else if (alone) conf = 0.7
      else if (!after && st.intents.length > 0) conf = 0.75
      if (!conf || blockedByNoun) continue
      if (st.filters.country) continue
      st.filters.country = code
      claim(st, i, i + 1, 'country', code, conf)
    }
  }

  // ---------------------------------------------------------------------------
  // Residual and confidence
  // ---------------------------------------------------------------------------

  function residual(st) {
    const keep = []
    for (let i = 0; i < st.toks.length; i++) {
      if (st.claimed[i]) continue
      // A stray connector next to something we understood is punctuation, not
      // a title word: "best of" leaves an "of" behind that must not poison the
      // title search.
      if (FILLER.has(st.toks[i].norm)) {
        const touchesIntent = (i > 0 && st.claimed[i - 1]) || (i + 1 < st.toks.length && st.claimed[i + 1])
        const isolated = st.intents.length > 0 &&
          (i === 0 || st.claimed[i - 1]) && (i === st.toks.length - 1 || st.claimed[i + 1])
        if (touchesIntent || isolated) continue
      }
      keep.push(st.toks[i])
    }
    if (!keep.length) return ''
    // Rebuild from the original string over contiguous runs, so internal
    // punctuation inside a leftover title survives.
    const parts = []
    let runStart = 0
    for (let k = 0; k < keep.length; k++) {
      const prev = keep[k - 1]
      const contiguous = prev && st.toks.indexOf(keep[k]) === st.toks.indexOf(prev) + 1
      if (k === 0 || !contiguous) {
        if (k > 0) parts.push(st.raw.slice(keep[runStart].start, keep[k - 1].end))
        runStart = k
      }
    }
    parts.push(st.raw.slice(keep[runStart].start, keep[keep.length - 1].end))
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  // Confidence is the share of meaningful tokens that were understood, weighted
  // by how sure each intent was. Pure filler is excluded from the denominator so
  // "korean films from the 90s" is not punished for its prepositions. A query
  // that is entirely a title scores 0 and that is correct: nothing about it was
  // interpreted, it was only passed through.
  function scoreConfidence(st) {
    let total = 0
    let claimedWeight = 0
    for (let i = 0; i < st.toks.length; i++) {
      const t = st.toks[i]
      const filler = FILLER.has(t.norm) || t.norm === 'the'
      if (filler && !st.claimed[i]) continue
      total++
      if (st.claimed[i]) claimedWeight += 1
    }
    if (!total) return 0
    const coverage = claimedWeight / total
    if (!st.intents.length) return 0
    let sure = 0
    for (const it of st.intents) sure += it.confidence
    const avg = sure / st.intents.length
    return Math.round(coverage * avg * 100) / 100
  }

  // ---------------------------------------------------------------------------
  // parse
  // ---------------------------------------------------------------------------

  function parse(text) {
    const input = typeof text === 'string' ? text : ''
    const st = createState(input)
    if (!st.toks.length) {
      return { input: input, text: input.trim(), intents: [], filters: emptyFilters(), confidence: 0 }
    }

    matchSimilar(st)
    matchPerson(st)
    matchYearRange(st)
    matchRuntime(st)
    matchDecade(st)
    matchSort(st)
    matchCuedYear(st)
    matchMinRating(st)
    matchMovement(st)
    matchKeyword(st)
    matchCatalog(st)
    matchGenre(st)
    matchLanguage(st)
    matchCountry(st)
    matchBareYear(st)

    // Intents are reported in the order they appear in the input, not the order
    // the matchers happened to run, so the UI can render them as the user reads.
    st.intents.sort(function (a, b) { return a.span[0] - b.span[0] })

    return {
      input: input,
      text: residual(st),
      intents: st.intents,
      filters: st.filters,
      confidence: scoreConfidence(st),
    }
  }

  // A bare four-digit year, run last so every cued reading has already had its
  // chance. It is only accepted when the query already means something else
  // ("korean films 1994"), and never for the numbers that are famous titles --
  // see AMBIGUOUS_TITLE_YEARS. Confidence stays low because "korean films 1994"
  // could still be a title.
  function matchBareYear(st) {
    if (!st.intents.length) return
    for (let i = 0; i < st.toks.length; i++) {
      if (!free(st, i, i + 1)) continue
      const y = asYear(st.toks[i])
      if (y === null) continue
      if (AMBIGUOUS_TITLE_YEARS.has(y)) continue
      if (st.filters.yearFrom !== null || st.filters.yearTo !== null) continue
      st.filters.yearFrom = y
      st.filters.yearTo = y
      claim(st, i, i + 1, 'year', { from: y, to: y }, 0.6)
    }
  }

  return {
    parse: parse,
    tokenize: tokenize,
    normalize: normalize,
    GENRES: GENRES,
    NATIONALITIES: NATIONALITIES,
    COUNTRY_NOUNS: COUNTRY_NOUNS,
    LANGUAGES: LANGUAGES,
    MOVEMENTS: MOVEMENTS,
    KEYWORDS: KEYWORDS,
    CATALOGS: CATALOGS,
    AMBIGUOUS_TITLE_YEARS: AMBIGUOUS_TITLE_YEARS,
    VOTE_FLOOR: VOTE_FLOOR,
  }
})
