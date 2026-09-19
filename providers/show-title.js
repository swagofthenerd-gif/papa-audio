'use strict'
// Does this release name actually name the show that was asked for?
//
// Every anime indexer answers a plain AND-over-words text search, so a query
// for a short title matches every unrelated show that happens to contain the
// word. Asking nyaa for "Monster 01" returns Monster Musume, Monster Strike,
// Re:Monster, Monogatari Off & Monster Season and "Pass the Monster Meat,
// Milady" — and not one episode of the 2004 Urasawa series. The providers
// checked the EPISODE NUMBER and nothing else, so all of those were offered,
// ranked by seeds, and played.
//
// The existing `matchesTitle` (providers/apibay.js) only asks that every word
// of the requested title appear somewhere in the release name, which a
// one-word title like "Monster" can never fail. The missing half is the other
// direction: a release that carries words the show does not have is a
// DIFFERENT show.
//
// So the rule here is two-sided:
//   1. some title the show goes by is fully present in the release name, and
//   2. the release's own name portion adds no significant word that none of
//      the show's titles have.
//
// Release names routinely print several titles at once ("Naoki Urasawa's
// Monster (Complete Anime Series) Monsuta"), so (2) is checked against the
// union of every known title, and the name is split into segments at bracket,
// parenthesis and pipe boundaries — each segment is a candidate name in its
// own right and only one has to match.
//
// Pure: no I/O, no network. Shared by nyaa, AnimeTosho and the indexers that
// serve anime alongside film and television.

// Punctuation and case are noise; "&" is spelled out because release names
// disagree about it. Diacritics are folded away by NFKD.
function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Romanisation disagrees about long vowels — "Koushaku"/"Kōshaku"/"Koshaku",
// "Yuusha"/"Yūsha"/"Yusha" — and after NFKD the macron is simply gone, so the
// three spellings differ by an "u" that means nothing. Folding doubled vowels
// to one makes them the same token.
function _fold(token) {
  return token.replace(/ou/g, 'o').replace(/uu/g, 'u').replace(/oo/g, 'o').replace(/([aeiou])\1/g, '$1')
}

// Words too common to prove anything on their own. Same set apibay's
// matchesTitle uses, so the two filters agree about what a significant word is.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'part'])

// Words a release name adds that say nothing about WHICH show it is: format,
// codec, language, packaging. An extra word from this list never makes a
// release a different show.
const NOISE = new Set([
  // resolution / source
  '2160p', '1080p', '720p', '576p', '540p', '480p', '360p', '4k', 'uhd', 'hd', 'sd',
  'bd', 'bdrip', 'bdremux', 'bdbox', 'bluray', 'blu', 'ray', 'dvd', 'dvdrip', 'dvdiso',
  'web', 'webrip', 'webdl', 'dl', 'hdtv', 'tvrip', 'remux', 'iso', 'rip', 'encode', 'reencode',
  'amzn', 'cr', 'crunchyroll', 'funi', 'funimation', 'hidive', 'nf', 'netflix', 'disney', 'adn',
  // video codec
  'hevc', 'avc', 'x264', 'x265', 'h264', 'h265', 'av1', 'xvid', 'divx', 'vp9',
  '10bit', '8bit', 'hi10p', 'hi10', 'bit', 'hdr', 'hdr10', 'sdr', 'dv',
  // audio
  'aac', 'flac', 'opus', 'ac3', 'eac3', 'ddp', 'dd', 'dts', 'truehd', 'pcm', 'mp3', 'vorbis',
  'audio', 'dual', 'dualaudio', 'stereo', 'surround',
  // language / track
  'sub', 'subs', 'subbed', 'subtitle', 'subtitles', 'softsubs', 'hardsubs', 'multi', 'multiple',
  'dub', 'dubbed', 'eng', 'english', 'jpn', 'jap', 'japanese', 'esp', 'spa', 'fre', 'ger', 'ita',
  'rus', 'por', 'ara', 'vostfr', 'raw', 'uncensored', 'censored',
  // packaging
  'batch', 'complete', 'completed', 'collection', 'series', 'season', 'seasons', 'cour', 'saga',
  'all', 'episode', 'episodes', 'ep', 'eps', 'vol', 'volume', 'disc', 'disk', 'set', 'box',
  'repack', 'reupload', 'v0', 'v1', 'v2', 'v3', 'v4', 'final', 'extras', 'extra', 'bonus',
  'ova', 'ovas', 'oad', 'ona', 'special', 'specials', 'movie', 'movies', 'film', 'tv', 'anime',
  'ncop', 'nced', 'op', 'ed', 'nc', 'creditless', 'menu', 'menus', 'scans', 'ost',
  'soundtrack', 'soundtracks', 'end', 'fixed', 'uncut', 'remaster', 'remastered',
  // sequel ordinals written as words or roman numerals. A season number is
  // handled by the season/pack matcher, not here — this filter's job is
  // telling one SHOW from another, and "Frieren 2nd Season" is Frieren.
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix',
  // streaming-service and rip tags that escape the brackets
  'bilibili', 'bstation', 'iqiyi', 'abema', 'ytv', 'vhs', 'vhsrip', 'www', 'ts', 'hybrid',
  // container / misc
  'mkv', 'mp4', 'avi', 'mka', 'ass', 'srt', 'pseudo', 'unknown',
])

// A token that is only a number, a season/episode marker, a resolution or a
// release-version tag carries no identity. Years included: "Monster (2004)"
// is Monster.
function _isNoiseToken(token) {
  if (!token) return true
  if (NOISE.has(token)) return true
  if (/^\d+$/.test(token)) return true                 // 01, 2004, 100
  if (/^s\d{1,3}(e\d{1,4})?$/.test(token)) return true // s01, s01e03
  if (/^e\d{1,4}$/.test(token)) return true            // e03
  if (/^\d{3,4}p$/.test(token)) return true            // 1080p
  if (/^v\d{1,2}$/.test(token)) return true            // v2
  if (/^\d{1,4}v\d{1,2}$/.test(token)) return true     // 01v2 (episode re-release)
  if (/^\d+(st|nd|rd|th)$/.test(token)) return true    // 2nd, 3rd — see the ordinals above
  if (/^\d+fps$/.test(token)) return true              // 144fps, and the 8561fps tail of 143.8561fps
  if (/^[0-9a-f]{8}$/.test(token)) return true         // CRC32 stamp
  return false
}

// The significant, identity-carrying words of a piece of text.
function significantTokens(text) {
  const out = []
  for (const raw of normalize(text).split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue
    if (_isNoiseToken(raw)) continue
    out.push(_fold(raw))
  }
  return out
}

// A release name split into the names it might be claiming to be. Bracketed
// blocks (group tags, hashes, metadata), parenthesised blocks (alternative
// titles as often as metadata), pipe/slash separators and a spaced dash all
// end one segment and begin another, so "[Judas] Akujiki Reijou (Pass the
// Monster Meat)" is two candidate names, not one run-on string — and neither
// of them is "Monster".
//
// The spaced dash is split on for the same reason nyaa's own query builder
// treats it as a subtitle boundary: it separates the show from an arc name or
// a cour subtitle ("One Piece Season 01 - East Blue") at least as often as it
// separates the show from its episode number. Splitting there keeps the arc
// release; the cost is that a same-franchise spin-off ("Kaijuu 8-gou - Narumi
// no Heijitsu") is offered too, which is a far smaller wrong than offering
// Monster Musume for Monster.
//
// Scene names carry no brackets at all — "Monster.Garage.S01E01.1080p.WEB-
// GROUP" is one run of dots — but they do follow a convention: the title
// comes first and everything from the year, the resolution or the SxxEyy
// onward is metadata. So a segment is cut at its first metadata marker too,
// and both halves are kept as segments of their own. Without this the release
// group's name ("-VARYG") reads as a word of the title and every scene
// release looks like a different film.
function _splitAtMetadata(segment) {
  const words = segment.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length < 2) return [segment]
  for (let i = 1; i < words.length; i++) {
    if (!_isMetadataMarker(_fold(normalize(words[i])))) continue
    return [words.slice(0, i).join(' '), words.slice(i).join(' ')]
  }
  return [segment]
}

// A word that can only be metadata: a year, a resolution, a season/episode
// marker, or one of the format/packaging words. Anything from here on in a
// scene name is about the FILE, never about which show it is.
function _isMetadataMarker(token) {
  if (!token) return false
  if (/^(19|20)\d{2}$/.test(token)) return true
  if (/^\d{3,4}p$/.test(token)) return true
  if (/^s\d{1,3}(e\d{1,4})?$/.test(token)) return true
  if (/^\d{1,2}x\d{1,3}$/.test(token)) return true
  return NOISE.has(token)
}

function nameSegments(name) {
  const text = String(name == null ? '' : name).replace(/\.(mkv|mp4|avi|torrent)$/i, '')
  const out = []
  // The whole name, cut at its first metadata marker, is a segment too: a
  // title that carries its own dash ("Dune - Part Two 2024 1080p...") is split
  // by the rules below into halves that each hold only part of it. Adding the
  // undivided name can only ever let more through — a match still has to
  // survive the extra-words test, which the run-on names that mix two shows
  // together never do.
  const whole = _splitAtMetadata(text.replace(/[[\](){}|/]+/g, ' ').replace(/\s+/g, ' ').trim())[0]
  if (whole && whole.trim()) out.push(whole.trim())
  for (const part of text.split(/[[\](){}|/]+|\s[-\u2013\u2014~]+\s/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    for (const piece of _splitAtMetadata(trimmed)) {
      const t = piece.trim()
      if (t) out.push(t)
    }
  }
  return out
}

// Every title the show is known by: the display title, AniList's romaji /
// english / native, and its synonyms — the alternative names release groups
// actually print ("Naoki Urasawa's Monster", "Monsuta").
function showTitles(request) {
  const req = request || {}
  const t = req.titles && typeof req.titles === 'object' ? req.titles : {}
  const out = []
  const push = v => {
    const s = String(v == null ? '' : v).trim()
    if (s) out.push(s)
  }
  push(req.title)
  push(t.romaji); push(t.english); push(t.native)
  push(req.originalName)
  for (const list of [t.synonyms, req.synonyms]) {
    if (Array.isArray(list)) for (const s of list.slice(0, 40)) push(s)
  }
  return Array.from(new Set(out))
}

// Does `releaseName` name the show `titles` describes?
//
// Accepts when some title is wholly present in one segment of the name AND
// that segment adds no significant word that no title has. A release with no
// name at all cannot be judged and is let through, the same way the renderer's
// `plausible` treats it — silence is not evidence of a mismatch.
function matchesShowTitle(releaseName, titles) {
  const name = String(releaseName == null ? '' : releaseName).trim()
  if (!name) return true
  const list = (Array.isArray(titles) ? titles : [titles]).filter(Boolean)
  if (!list.length) return true

  // The vocabulary of the show: every significant word of every title it goes
  // by. An extra word in the release name is forgiven only if it is in here.
  const vocabulary = new Set()
  const wanted = []
  for (const title of list) {
    const tokens = significantTokens(title)
    if (!tokens.length) continue
    for (const tok of tokens) vocabulary.add(tok)
    wanted.push(tokens)
  }
  // Nothing significant to check against (a title of pure stopwords, or one
  // that normalises away entirely) — do not reject on no evidence.
  if (!wanted.length) return true

  for (const segment of nameSegments(name)) {
    const tokens = significantTokens(segment)
    if (!tokens.length) continue
    const present = new Set(tokens)
    // (1) some title is fully present in this segment...
    if (!wanted.some(w => w.every(tok => present.has(tok)))) continue
    // (2) ...and the segment claims nothing else.
    if (tokens.every(tok => vocabulary.has(tok))) return true
  }
  return false
}

module.exports = {
  NOISE,
  STOPWORDS,
  normalize,
  significantTokens,
  nameSegments,
  showTitles,
  matchesShowTitle,
}
