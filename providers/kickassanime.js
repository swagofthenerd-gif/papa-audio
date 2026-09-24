'use strict'
// Anime that plays the moment you press it, the way the streaming sites do.
//
// He asked for it in one sentence: "can we figure out a way to play like
// miruro?" Those sites never touch a torrent. They map a show to an episode on
// a streaming host and play the HLS stream that host serves off a CDN — which
// is why they start in a second while a swarm is still finding peers.
//
// Traced live from miruro.tv's own player, 2026-09-24. Of the providers it
// offers, this is the one whose whole chain is in the clear and self-contained:
//
//   1. POST /api/search {query}          -> the show, by title
//   2. GET  /api/show/<slug>/episodes    -> every episode, each with its own slug
//   3. GET  /api/show/<slug>/episode/... -> the servers holding that episode
//   4. GET  <server player url>          -> master.m3u8, plus subtitle tracks
//
// No obfuscation at any step and no third party's backend in the middle: this
// host answers the whole question itself, which is the reason to prefer it over
// the alternatives that need a mapping database we would not own.
//
// Language is the sub/dub switch: ja-JP is subtitled, en-US is dubbed. That is
// a genuinely better answer than the torrent side can give, where a dub means
// hunting a pack and hoping the audio track is inside it.
//
// What it cannot do is carry everything. Kaiji is listed here with zero
// servers — the show exists, the video does not — which is exactly why miruro
// offers several providers and why this one is added ALONGSIDE the torrent
// sources and never instead of them.
const { matchesShowTitle, showTitles } = require('./show-title')

const DEFAULT_BASE_URLS = ['https://kaa.lt']

// The host checks where a request claims to come from and nothing else.
const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://kaa.lt/',
})

// Subtitled and dubbed are the same episode under two language codes.
const LANG_SUB = 'ja-JP'
const LANG_DUB = 'en-US'

// The same lesson the torrent providers learned the hard way: a search that
// runs out of time answers with what it has rather than being killed holding
// everything. Well under resolveStream's own deadline.
const TIME_BUDGET_MS = 9000

// How many candidate shows a search will open. A title search can answer with a
// franchise's worth of entries and each one costs an episode-list round trip;
// the title filter below almost always settles it on the first.
const MAX_CANDIDATES = 3

function _json(res) {
  if (!res || !res.ok) return null
  return res.text().then(t => { try { return JSON.parse(t) } catch (_) { return null } })
}

// Every title the show goes by, as the search terms worth trying. Romaji first:
// this host indexes under it ("Sousou no Frieren"), the same way nyaa does.
function searchTerms(request) {
  const req = request || {}
  const t = req.titles && typeof req.titles === 'object' ? req.titles : {}
  const out = []
  const push = v => {
    const s = String(v == null ? '' : v).trim()
    if (s && !out.includes(s)) out.push(s)
  }
  push(t.romaji)
  push(req.title)
  push(t.english)
  return out
}

// The episode reference this host uses: "ep-12-b2397a", the number and the
// episode's own slug. Confirmed against miruro's own encoding of the same
// episode, which spells it exactly this way.
function episodeRef(episodeNumber, episodeSlug) {
  // Number(null) is 0, which would spell a real-looking "ep-0-…" out of a
  // missing episode — reject the absence itself before coercing.
  if (episodeNumber == null || episodeNumber === '') return null
  const n = Number(episodeNumber)
  const slug = String(episodeSlug == null ? '' : episodeSlug).trim()
  if (!Number.isFinite(n) || n < 0 || !slug) return null
  return 'ep-' + n + '-' + slug
}

// The audio languages a master manifest carries, in the order it lists them.
//
// An adaptive stream can hold every dub inside ONE manifest — measured on this
// CDN: Frieren carries nine (Japanese, English, Hindi, Tamil, German, Spanish,
// French, Italian, Portuguese) and the player switches between them without
// re-downloading anything, while The Elusive Samurai carries Japanese alone.
// Nothing outside the manifest says which, so an entry could not tell the
// viewer what it was about to play, and a stream holding a perfectly good
// English track was never offered when a dub was asked for.
function audioTracksOf(manifestText) {
  const out = []
  const text = String(manifestText == null ? '' : manifestText)
  const re = /^#EXT-X-MEDIA:([^\r\n]*TYPE=AUDIO[^\r\n]*)$/gim
  let m
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1]
    const name = /NAME="([^"]+)"/i.exec(attrs)
    const lang = /LANGUAGE="([^"]+)"/i.exec(attrs)
    const label = (name && name[1]) || (lang && lang[1])
    if (!label) continue
    if (out.some(t => t.label === label)) continue
    out.push({ label, lang: lang ? lang[1].toLowerCase() : null })
  }
  return out
}

// The picture qualities a master manifest offers, best first.
//
// An adaptive stream carries every resolution as its own variant playlist —
// measured on this CDN, every stream seen offers 1080p, 720p and 360p. Saying
// "quality: null" left these out of the app's quality picker entirely, so an
// instant source could not be asked for a particular resolution while every
// torrent beside it could. `url` is relative to the master's own address.
function variantsOf(manifestText) {
  const out = []
  const text = String(manifestText == null ? '' : manifestText)
  const re = /^#EXT-X-STREAM-INF:([^\r\n]*)\r?\n([^\r\n#][^\r\n]*)$/gim
  let m
  while ((m = re.exec(text)) !== null) {
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(m[1])
    if (!res) continue
    const height = Number(res[2])
    if (!Number.isFinite(height) || height <= 0) continue
    const url = m[2].trim()
    if (!url || out.some(v => v.height === height)) continue
    out.push({ height, url })
  }
  return out.sort((a, b) => b.height - a.height)
}

// A variant's address. A manifest gives it relative to the master's own URL.
// Null for anything unparsable, so a bad line drops its row instead of
// becoming an entry that cannot play.
function _resolveUrl(baseUrl, relative) {
  try { return new URL(String(relative), String(baseUrl)).toString() } catch (_) { return null }
}

// A height as the app spells qualities. Its vocabulary is 480p/720p/1080p/2160p,
// so a stream's 360p is named honestly rather than promoted into a bracket it
// does not belong in — the picker simply will not list it, which is correct.
function qualityOfHeight(height) {
  const h = Number(height)
  if (!Number.isFinite(h) || h <= 0) return null
  if (h >= 2000) return '2160p'
  if (h >= 1000) return '1080p'
  if (h >= 700) return '720p'
  if (h >= 440) return '480p'
  return h + 'p'
}

// Whether a track list holds an English dub. The CDN spells it "eng"/"English";
// a name check as well as a code check, because a manifest that names a track
// without coding it is still naming English.
function hasEnglishAudio(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .some(t => t && (/^en/i.test(String(t.lang || '')) || /english/i.test(String(t.label || ''))))
}

function hasJapaneseAudio(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .some(t => t && (/^(ja|jp)/i.test(String(t.lang || '')) || /japanese/i.test(String(t.label || ''))))
}

// The scheme-and-host of a URL, as an Origin header value (no trailing slash,
// which is what the header wants). Null for anything unparsable, so a caller
// sends no Origin rather than a broken one.
function _originOf(url) {
  try {
    const u = new URL(String(url))
    if (!/^https?:$/.test(u.protocol)) return null
    return u.protocol + '//' + u.host
  } catch (_) { return null }
}

// The stream and its subtitles out of a server's player page.
//
// The page carries its configuration as HTML-escaped JSON, so the manifest and
// every subtitle track are plainly readable. Deliberately read with narrow
// patterns rather than by parsing the whole page: the surrounding markup is the
// host's to change, and a regex that only knows what a manifest URL looks like
// survives a redesign that a structural parse would not.
function extractStream(html) {
  const text = String(html == null ? '' : html)
  const m = /https?:\/\/[^\s"'&<>]+\/master\.m3u8[^\s"'&<>]*/i.exec(text) ||
    /https?:\/\/[^\s"'&<>]+\.m3u8[^\s"'&<>]*/i.exec(text)
  if (!m) return null
  const subtitles = []
  const seen = new Set()
  const subRe = /https?:\/\/[^\s"'&<>]+\.vtt/gi
  let s
  while ((s = subRe.exec(text)) !== null) {
    const url = s[0]
    if (seen.has(url)) continue
    seen.add(url)
    // The thumbnail strip is a .vtt too, and is not a subtitle track.
    if (/preview/i.test(url)) continue
    // The language is named next to the track in the page's own config —
    // which arrives with its quotes HTML-escaped (&quot;), so both spellings
    // are read.
    const near = text.slice(Math.max(0, s.index - 400), s.index)
    const lang = /(?:"|&quot;)name(?:"|&quot;).{0,24}?(?:"|&quot;)([A-Za-z][A-Za-z ()-]{1,30})(?:"|&quot;)/i.exec(near)
    subtitles.push({ url, label: lang ? String(lang[1]) : '' })
  }
  return { url: m[0], subtitles }
}

function createKickAssAnimeProvider({
  fetchFn,
  baseUrls = DEFAULT_BASE_URLS,
  maxResults = 6,
  timeBudgetMs = TIME_BUDGET_MS,
} = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length ? baseUrls : DEFAULT_BASE_URLS

  return async function kickAssAnimeProvider(request) {
    request = request || {}
    if (request.type !== 'anime') return []
    const episode = Number(request.episode)
    if (!Number.isFinite(episode) || episode < 1) return []

    const deadline = timeBudgetMs > 0 ? Date.now() + timeBudgetMs : Infinity
    const outOfTime = () => Date.now() >= deadline
    const base = urls[0]
    const names = showTitles(request)
    const wantDub = request.dub === true
    const lang = wantDub ? LANG_DUB : LANG_SUB

    // 1. The show. Tried under each title the entry goes by until one answers.
    let shows = []
    for (const term of searchTerms(request)) {
      if (outOfTime()) break
      let body = null
      try {
        body = await _json(await fetcher(base + '/api/search', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS),
          body: JSON.stringify({ query: term }),
        }))
      } catch (_) { continue }
      if (Array.isArray(body) && body.length) { shows = body; break }
    }
    if (!shows.length) return []

    // The release-name filter the torrent providers use, for the same reason: a
    // text search for a short title answers with every show that contains the
    // word, and playing one of those is worse than playing nothing.
    const candidates = shows
      .filter(s => s && s.slug && matchesShowTitle(s.title || '', names))
      .slice(0, MAX_CANDIDATES)
    if (!candidates.length) return []

    const entries = []
    for (const show of candidates) {
      if (outOfTime() || entries.length >= maxResults) break
      // A candidate that has already yielded streams settles which show this
      // is; the remaining candidates are OTHER entries that happened to share
      // the title words, and walking them spends seconds to add wrong answers.
      if (entries.length) break

      // 2. The episode's own slug, out of the show's episode list.
      let list = null
      try {
        list = await _json(await fetcher(
          base + '/api/show/' + encodeURIComponent(show.slug) + '/episodes?ep=1&lang=' + lang,
          { headers: HEADERS }))
      } catch (_) { continue }
      const found = (list && Array.isArray(list.result) ? list.result : [])
        .find(e => e && Number(e.episode_number) === episode)
      if (!found) continue
      const ref = episodeRef(episode, found.slug)
      if (!ref || outOfTime()) continue

      // 3. The servers holding it. An empty list is the ordinary case for a
      //    show this host catalogues but has no video for, and is not a fault.
      let ep = null
      try {
        ep = await _json(await fetcher(
          base + '/api/show/' + encodeURIComponent(show.slug) + '/episode/' + ref + '?lang=' + lang,
          { headers: HEADERS }))
      } catch (_) { continue }
      const servers = (ep && Array.isArray(ep.servers) ? ep.servers : []).filter(s => s && s.src)
      if (!servers.length) continue

      // 4. Each server's player page, for the manifest it is holding.
      for (const server of servers) {
        if (outOfTime() || entries.length >= maxResults) break
        let page = null
        try {
          const res = await fetcher(server.src, { headers: HEADERS })
          if (!res || !res.ok) continue
          page = await res.text()
        } catch (_) { continue }
        const stream = extractStream(page)
        if (!stream) continue

        // Read the manifest for the languages it carries. One small fetch —
        // measured at 0.7–1.8 KB — and it is what lets the row say what it is
        // about to play instead of the viewer finding out afterwards.
        // A manifest that will not load leaves the languages unknown rather
        // than losing an otherwise good entry.
        let tracks = []
        let variants = []
        try {
          const mres = await fetcher(stream.url, {
            headers: Object.assign({}, HEADERS, { Origin: _originOf(server.src) || undefined }),
          })
          if (mres && mres.ok) {
            const manifest = await mres.text()
            tracks = audioTracksOf(manifest)
            variants = variantsOf(manifest)
          }
        } catch (_) { /* unknown audio is not a reason to drop the stream */ }

        // What the stream ACTUALLY holds decides these, not which language was
        // asked for. A single manifest carrying both is honestly both, and the
        // player switches between them; saying otherwise hid a perfectly good
        // English track whenever a dub was wanted.
        const english = hasEnglishAudio(tracks)
        const japanese = hasJapaneseAudio(tracks)
        const known = tracks.length > 0

        // One row per picture quality, each pointing at that quality's own
        // playlist — which is how the app already presents torrents, so its
        // existing quality picker works on these with nothing added to it.
        // A manifest that could not be read leaves one row playing the master,
        // where the player chooses the height for itself, exactly as before.
        const rows = variants.length
          ? variants.map(v => ({ url: _resolveUrl(stream.url, v.url), quality: qualityOfHeight(v.height) }))
          : [{ url: stream.url, quality: null }]

        for (const row of rows) {
          if (entries.length >= maxResults) break
          if (!row.url) continue
          entries.push({
            kind: 'http',
            url: row.url,
            source: 'KickAssAnime',
            quality: row.quality,
            // Named like a release: the SHOW first, then the episode. The
            // renderer's plausibility filter rightly hides an entry whose name
            // does not carry the show's title — an entry titled only
            // "Departure" reads as a different work entirely.
            title: (show.title || '') + ' - ' + String(episode).padStart(2, '0') +
              (ep && ep.episode_title ? ' — ' + ep.episode_title : ''),
            // Say what it holds. "Japanese" reads very differently from
            // "9 languages · incl. English" when choosing a row to press, and
            // the difference was invisible until now.
            label: (server.name ? server.name + ' · ' : '') + (
              !known ? (wantDub ? 'Dub' : 'Sub')
                : tracks.length === 1 ? tracks[0].label
                  : tracks.length + ' languages' + (english ? ' · incl. English' : '')),
            sub: known ? japanese : !wantDub,
            dub: known ? english : wantDub,
            // Every language inside this one manifest, so the player can offer
            // them and the UI can say so without opening anything.
            audioLanguages: tracks.map(t => t.label),
            // Plays at once off a CDN — no swarm, no waiting for peers. The list
            // marks these so the difference is visible before pressing anything.
            instant: true,
            // The header the CDN actually enforces, measured against it:
            // Origin, naming the PLAYER's host — not the catalogue site, and not
            // the stream's own host. Everything else gets a 403 on every segment,
            // and mpv answers a 403 on segments by hanging silently forever, so
            // the wrong value here is indistinguishable from a dead source.
            //
            // Derived from the server URL rather than written down, so a host
            // that moves its player keeps working.
            headers: { Origin: _originOf(server.src) },
            subtitles: stream.subtitles,
            // Free from this host and worth having: the skip model can use them
            // instead of detecting an opening from the picture.
            intro: (ep && ep.intro) || null,
            outro: (ep && ep.outro) || null,
          })
        }
      }
    }
    return entries.slice(0, maxResults)
  }
}

module.exports = {
  createKickAssAnimeProvider,
  audioTracksOf,
  variantsOf,
  qualityOfHeight,
  hasEnglishAudio,
  hasJapaneseAudio,
  extractStream,
  episodeRef,
  searchTerms,
  DEFAULT_BASE_URLS,
  HEADERS,
  LANG_SUB,
  LANG_DUB,
  TIME_BUDGET_MS,
}
