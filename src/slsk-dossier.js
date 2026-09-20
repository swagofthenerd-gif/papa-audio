// The album dossier: everything the app can know about one remote album, in
// one panel, opened from Hunt, Wander, Folders or search. Replaces the
// slide-over in slsk-album-view.js for the new page; reuses its comparison
// table and my-copy lookup so the two never disagree.
;(function () {
  const AV = () => (typeof window !== 'undefined' && window.PapaSlskAlbumView) ||
    (typeof require === 'function' ? require('./slsk-album-view.js') : null)
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? require('./slsk-shelves.js') : null)
  const CMP = () => (typeof window !== 'undefined' && window.PapaSlskCompare) ||
    (typeof require === 'function' ? require('./slsk-compare.js') : null)
  const WN = () => (typeof window !== 'undefined' && window.PapaSlskWander) ||
    (typeof require === 'function' ? require('./slsk-wander.js') : null)
  const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|aac|ogg|opus|ape|wv|alac|dsf|dff)$/i

  function fmtDur(sec) {
    const n = Math.round(Number(sec) || 0)
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0')
  }
  function fmtSize(n) { const s = SH(); return s && s.fmtSize ? s.fmtSize(n) : Math.round(n / 1e6) + ' MB' }
  function ago(ts) {
    const d = Date.now() - ts
    if (d < 90e3) return 'just now'
    if (d < 3600e3) return Math.round(d / 60e3) + ' min ago'
    if (d < 86400e3) return Math.round(d / 3600e3) + ' h ago'
    return Math.round(d / 86400e3) + ' d ago'
  }
  function tierOf(a) { return a.surround ? 'surround' : a.isHiRes ? 'hires' : a.lossless ? 'lossless' : 'lossy' }

  // "[2016 Remaster]", "(Deluxe Edition)", "{Vinyl}" out of the folder name.
  function editionOf(folderName) {
    const m = String(folderName || '').match(/[\[({]([^\])}]*(remaster|deluxe|edition|vinyl|mono|anniversary|expanded|japan|sacd|mfsl|dcc)[^\])}]*)[\])}]/i)
    return m ? m[1].trim() : ''
  }

  function model(album, username, mine) {
    const files = album.files || []
    const tracks = files.filter(f => AUDIO_RE.test(f.name || f.filename || ''))
    const total = tracks.reduce((s, f) => s + (Number(f.length) || 0), 0)
    const names = files.map(f => String(f.name || f.filename || '').toLowerCase())
    const s = SH()
    return {
      album, username, mine,
      title: album.album || album.folderName || '', artist: album.artist || '', year: album.year || null,
      editionNote: editionOf(album.folderName),
      quality: s && s.qualityString ? s.qualityString(album) : '',
      tier: tierOf(album),
      tracks, length: total ? fmtDur(total) : '', size: fmtSize(album.totalSize || 0),
      extras: {
        log: names.some(n => n.endsWith('.log')),
        cue: names.some(n => n.endsWith('.cue')),
        art: names.some(n => /\.(jpe?g|png|webp)$/.test(n)),
      },
      verdict: album.upgrade ? 'Upgrade over yours' : (mine ? 'You have this' : 'Not yours'),
      rip: null, reception: null, about: null, siblings: [],
      // What the record IS, and what else there is to hear. `null` means STILL
      // ASKING in every one of these slots, and only a live promise is allowed
      // to hold one at null — see NO_ANSWER.
      albumInfo: null, artistReleases: null, artistTags: null,
      // The discography's marks, worked out once when the reply lands rather
      // than on each of the six repaints an open panel does.
      releaseRows: null,
      // Every expander's open flag lives HERE, not in the DOM: repaintBody()
      // re-serialises the whole body on every async arrival, so a flag read off
      // the markup would be thrown away by the next reply that lands.
      bioOpen: false, albumTextOpen: false, notesOpen: false,
      // Set by a renderer-side timer at 12 s, not by any reply.
      slow: false,
      // Handed down by the room that opened this panel. Absent for any other
      // caller, and every section that reads them tolerates that.
      peerAlbums: [], tagsByArtist: null, tagsDone: false, library: [],
      ownsPeerAlbum: null,
    }
  }

  // The sentence the lookup didn't finish. Written into a slot by the .catch of
  // every lookup and by the else of every `if (window.api…)` guard, so `null`
  // keeps its one meaning: a live promise is still out.
  const NO_ANSWER = "The lookup didn't answer. Close and reopen the panel to try again."

  // Where a sentence really ends: `.`, `!` or `?`, then a space, then an
  // uppercase LETTER, and the word before the punctuation longer than two
  // characters. That last clause is what keeps "St. Petersburg", "Jr. Walker"
  // and "U.S. Army" whole, and the uppercase-letter test is what keeps
  // "No. 1 hit" whole.
  function isSentenceEnd(s, i) {
    const ch = s[i]
    if (ch !== '.' && ch !== '!' && ch !== '?') return false
    if (s[i + 1] !== ' ') return false
    const next = s[i + 2]
    if (!next || next !== next.toUpperCase() || next === next.toLowerCase()) return false
    let j = i - 1, len = 0
    while (j >= 0 && !/[\s.!?]/.test(s[j])) { len++; j-- }
    return len > 2
  }

  // Normalise the newline runs Wikipedia's intro endpoint emits, without
  // destroying the blank lines that separate its paragraphs.
  function tidyText(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  // The preview cut. Pure: takes raw text, returns { text, truncated }. The
  // slice happens on the RAW string and esc() is applied to the result by the
  // caller — escaping first and slicing after can cut an HTML entity in half.
  function bioPreview(text, limit) {
    const lim = Number(limit) > 0 ? Math.floor(Number(limit)) : 420
    const s = tidyText(text)
    if (s.length <= lim) return { text: s, truncated: false }
    // The author's own paragraph break beats any sentence we pick.
    const breaks = /\n[ \t]*\n/g
    let br
    while ((br = breaks.exec(s))) {
      if (br.index > 600) break
      if (br.index >= 200) return { text: s.slice(0, br.index).trim() + '…', truncated: true }
    }
    for (let i = Math.min(lim, s.length - 3); i >= 200; i--) {
      if (isSentenceEnd(s, i)) return { text: s.slice(0, i + 1) + '…', truncated: true }
    }
    const sp = s.lastIndexOf(' ', lim)
    return { text: s.slice(0, sp > 200 ? sp : lim).trim() + '…', truncated: true }
  }

  // One sentence and no ellipsis, for a caption that has no expander behind it.
  // Same sentence-end rule as bioPreview, so the abbreviations it protects are
  // protected here too. An ellipsis is deliberately absent: on a shelf header it
  // promises more text with no way to reach it.
  function firstSentence(text, max) {
    const cap = Number(max) > 0 ? Math.floor(Number(max)) : 300
    const s = tidyText(text)
    for (let i = 0; i < Math.min(s.length, cap); i++) {
      if (isSentenceEnd(s, i)) return s.slice(0, i + 1)
    }
    if (s.length <= cap) return s
    const sp = s.lastIndexOf(' ', cap)
    return s.slice(0, sp > 0 ? sp : cap).trim()
  }

  // Blank-line-separated prose into stacked divs, so a 2,700-character intro
  // reads as paragraphs rather than one wall. Split on the RAW text, escape
  // each paragraph after.
  function paragraphsHtml(text, esc) {
    return String(text == null ? '' : text).split(/\n[ \t]*\n/)
      .map(p => p.trim()).filter(Boolean)
      .map(p => `<div>${esc(p)}</div>`).join('')
  }

  // ── What the record is, in English ──────────────────────────────────────────
  // There is no boolean for "studio album" in MusicBrainz: it is primary-type
  // Album with an EMPTY secondary-types array, and any secondary type that IS
  // present outranks the primary one — an Album/Live is a live album, not a
  // studio one.
  const SECONDARY_WORD = {
    Live: 'Live album',
    Compilation: 'Compilation',
    Soundtrack: 'Soundtrack',
    Remix: 'Remix album',
    Demo: 'Demo',
    'Mixtape/Street': 'Mixtape',
    'DJ-mix': 'DJ mix',
  }
  const PRIMARY_WORD = { Album: 'Studio album', EP: 'EP', Single: 'Single', Broadcast: 'Broadcast' }
  function typeWord(primaryType, secondaryTypes) {
    const words = (Array.isArray(secondaryTypes) ? secondaryTypes : [])
      .map(s => SECONDARY_WORD[String(s || '')]).filter(Boolean)
    if (words.length) return words.join(' · ')
    return PRIMARY_WORD[String(primaryType || '')] || 'Release'
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']

  // MusicBrainz dates arrive at three precisions and all three are worth
  // printing. Anything else — a malformed date included — is no date at all,
  // and the lead line has a fallback for that.
  function formatReleaseDate(date) {
    const s = String(date == null ? '' : date).trim()
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
    if (m && MONTHS[Number(m[2]) - 1]) return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1]
    m = /^(\d{4})-(\d{2})$/.exec(s)
    if (m && MONTHS[Number(m[2]) - 1]) return MONTHS[Number(m[2]) - 1] + ' ' + m[1]
    m = /^(\d{4})$/.exec(s)
    if (m) return m[1]
    return ''
  }

  // The room keys wander.tags by PapaSlskWander.norm, so the lookups here have
  // to use the very same folding. Wander's own function when it is loaded; the
  // identical one-liner when it is not, so a module load order can never turn
  // this into a silently empty section.
  function tagKey(s) {
    const w = WN()
    if (w && w.norm) return w.norm(s)
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  }

  // One album per artist, so a prolific artist cannot flood the shelf: the one
  // he hasn't got, then the best-sounding, then the fullest.
  function bestAlbumOf(list, owns) {
    const rank = a => [
      owns && owns(a) ? 0 : 1,
      a.surround ? 3 : a.isHiRes ? 2 : a.lossless ? 1 : 0,
      (a.files || []).length,
    ]
    let best = null, bestRank = null
    for (const a of list || []) {
      const r = rank(a)
      // Compared element by element: [1,2,10] beats [1,2,9], which a `>` on the
      // arrays themselves would get backwards.
      let better = !best
      if (best) for (let i = 0; i < r.length; i++) { if (r[i] !== bestRank[i]) { better = r[i] > bestRank[i]; break } }
      if (better) { best = a; bestRank = r }
    }
    return best
  }

  // Artists in THIS library whose MusicBrainz tags overlap this one's — scored
  // by how RARE the shared tags are, not by how many there are.
  //
  // Raw shared-tag counting does not discriminate. Measured on his own cache:
  // 181 artists, 260 distinct tags, and the tags doing the work are generic —
  // `rock` appears for 67 artists, `pop rock` 29, `british` 26. Under a raw
  // count, seven candidates tie at exactly two shared tags and the top of the
  // list is whatever the array happened to sort first.
  //
  // So a candidate has to share at least two tags AND at least one tag that
  // fewer than RARE_TAG_SHARE of the tagged artists here carry, and the score
  // is the sum of the shared tags' rarity.
  const RARE_TAG_SHARE = 0.15
  function rankSameTagArtists(opts) {
    const o = opts || {}
    const seedKey = tagKey(o.artist)
    const byArtist = o.tagsByArtist || {}
    const albums = o.peerAlbums || []
    const owns = typeof o.owns === 'function' ? o.owns : null
    const cap = Number(o.cap) > 0 ? Number(o.cap) : 8
    // Every artist actually present in this library, with their albums.
    const here = new Map()
    for (const a of albums) {
      const k = tagKey(a && a.artist)
      if (!k) continue
      if (!here.has(k)) here.set(k, [])
      here.get(k).push(a)
    }
    // One pass for the document frequencies. In memory, no network.
    const df = new Map()
    let tagged = 0
    for (const k of here.keys()) {
      const tags = byArtist[k]
      if (!Array.isArray(tags) || !tags.length) continue
      tagged++
      for (const t of new Set(tags)) df.set(t, (df.get(t) || 0) + 1)
    }
    const seedTags = new Set(Array.isArray(byArtist[seedKey]) ? byArtist[seedKey] : [])
    const rarity = t => Math.log(Math.max(tagged, 1) / Math.max(df.get(t) || 0, 1))
    const matches = []
    // The tags a near-miss DID share, so the "nothing specific" sentence can
    // name the generic ones rather than waving at them.
    const nearMiss = new Map()
    if (seedTags.size) {
      for (const [k, list] of here) {
        if (k === seedKey) continue
        const tags = byArtist[k]
        if (!Array.isArray(tags) || !tags.length) continue
        const shared = [...new Set(tags)].filter(t => seedTags.has(t))
        if (shared.length < 2) continue
        if (!shared.some(t => (df.get(t) || 0) / Math.max(tagged, 1) < RARE_TAG_SHARE)) {
          for (const t of shared) nearMiss.set(t, (nearMiss.get(t) || 0) + 1)
          continue
        }
        const album = bestAlbumOf(list, owns)
        if (!album) continue
        matches.push({
          artist: album.artist || k,
          album: album.album || album.folderName || '',
          folderPath: album.folderPath || '',
          owned: !!(owns && owns(album)),
          shared: shared.slice().sort((a, b) => rarity(b) - rarity(a)),
          score: shared.reduce((s, t) => s + rarity(t), 0),
        })
      }
    }
    matches.sort((a, b) =>
      b.score - a.score ||
      (a.owned === b.owned ? 0 : a.owned ? 1 : -1) ||
      (a.album < b.album ? -1 : a.album > b.album ? 1 : 0))
    // What to name in the "nothing specific" sentence: the tags the near-misses
    // kept sharing, or failing that the seed's own commonest.
    const generic = (nearMiss.size
      ? [...nearMiss.keys()].sort((a, b) => (nearMiss.get(b) - nearMiss.get(a)) || ((df.get(b) || 0) - (df.get(a) || 0)))
      : [...seedTags].sort((a, b) => (df.get(b) || 0) - (df.get(a) || 0))).slice(0, 2)
    return { tagged, total: matches.length, matches: matches.slice(0, cap), generic, seedTagCount: seedTags.size }
  }

  // Where each MusicBrainz release already lives — in his own library, or in
  // this peer's. Both answers are local and instant; neither costs a request.
  function markReleases(releases, opts) {
    const o = opts || {}
    const sh = SH()
    const score = (a, b) => (sh && sh.tokenScore ? sh.tokenScore(a, b) : (tagKey(a) === tagKey(b) ? 1 : 0))
    // The project's own bars, the ones buildLibraryIndex matches albums with.
    const sameAlbum = (a, b) => score(a, b) >= 0.6
    const sameArtist = (a, b) => !a || !b || score(a, b) >= 0.34
    const artist = o.artist || ''
    const library = o.library || []
    const peerAlbums = o.peerAlbums || []
    return (releases || []).map(r => {
      const title = String((r && r.title) || '')
      const owned = library.some(l => l && sameAlbum(l.name || '', title) && sameArtist(l.artist || '', artist))
      const here = peerAlbums.find(a => a &&
        sameAlbum(a.album || a.folderName || '', title) && sameArtist(a.artist || '', artist))
      return {
        id: (r && r.id) || '',
        title,
        year: String((r && r.date) || '').slice(0, 4),
        owned,
        folderPath: here ? (here.folderPath || '') : '',
      }
    })
  }

  function labelDot(tier) { return `<i class="slr-lbl slr-lbl-${tier}"></i>` }

  // The claim vocabulary the check speaks, in English. Kept beside the pill and
  // nowhere else: main already turned the folder name into one of these tokens.
  const CLAIM_WORD = { '5.1': '5.1', '7.1': '7.1', ATMOS: 'Atmos', QUAD: 'quadraphonic', MCH: 'surround' }

  // channelVerdict builds its sentence in the main process, which measures one
  // track and cannot know how many the album holds, so it leaves the literal
  // token {tracks}. Fill it here. With no count, the whole clause is dropped
  // rather than printing a brace at someone.
  function fillTracks(text, n) {
    const s = String(text == null ? '' : text)
    if (!s) return ''
    if (n) return s.split('{tracks}').join(String(n))
    return s.replace(/ of \{tracks\}/g, '')
  }

  // The pill that sits next to the header's Download button. Both halves are
  // built from words the check already returned — never from a raw dB figure.
  function warnPillText(c) {
    const listed = CLAIM_WORD[String(c.claim || '')] || null
    let right = c.fact || ''
    if (c.kind === 'padded-channels') right = 'surround channels are silent'
    else if (c.kind === 'claim-mismatch') right = Number(c.channels) === 1 ? 'checked track is mono' : 'checked track is stereo'
    return [listed ? 'listed ' + listed : '', right].filter(Boolean).join(' · ')
  }

  function ripHtml(m, esc) {
    const r = m.rip
    if (!r) return `<div class="slr-rip slr-rip-idle"><button class="slr-btn" data-act="verify">Verify this rip</button>
      <span>Downloads one track, measures it, deletes it. Tells you the real bit depth and whether it's really surround. A minute or two.</span></div>`
    if (r.running) return `<div class="slr-rip slr-rip-busy"><span class="slr-spin"></span>Pulling ${esc(r.track || 'a track')}…</div>`
    if (!r.ok) return `<div class="slr-rip slr-rip-fail">${esc(r.reason || 'Could not verify.')} <button class="slr-btn slr-btn-quiet" data-act="verify">Try again</button></div>`
    // Absent-tolerant on purpose: a verdict cached before this feature existed
    // has no channelCheck at all, and must not acquire a default opinion.
    const chan = r.channelCheck || null
    const warn = !!(chan && chan.severity === 'warn')
    const n = (m.tracks && m.tracks.length) || 0
    const chanText = chan ? fillTracks(chan.text, n) : ''
    // Only measured facts that actually came back get printed.
    const facts = []
    // volumedetect reports one number for the summed mix, so the wording can
    // never claim a per-channel figure.
    if (r.ceilingHz) facts.push('reaches ' + Math.round(r.ceilingHz / 1000) + ' kHz' +
      (Number(r.channels) >= 3 ? ' (all channels together)' : ''))
    if (r.dynamicRange != null) facts.push('dynamic range ' + r.dynamicRange)
    if (r.measuredBits) facts.push(r.measuredBits + ' bits used')
    const verdict = r.verdict || {}
    // On a warning the channel sentence takes the bold line, so the bit-depth
    // verdict demotes into the grey run rather than disappearing.
    if (warn && verdict.text) facts.push(verdict.text)
    // The channel fact leads the run: it is the thing he came to read.
    if (chan && chan.fact) facts.unshift(chan.fact)
    const checked = (n ? 'checked one track of ' + n : 'checked one track') +
      (r.track ? ' (' + r.track + ')' : '')
    const tail = [facts.join(' · '), checked, ago(r.at || Date.now())]
      .filter(Boolean).join(' · ')
    // The warn class REPLACES slr-rip-<kind> rather than joining it, so no CSS
    // source-order tie can leave a contradicted line painted green.
    const cls = warn ? 'slr-rip slr-rip-chan-warn' : `slr-rip slr-rip-${esc(verdict.kind || 'unknown')}`
    const bold = warn
      ? `⚠ ${esc(chanText)}`
      : `${verdict.kind === 'genuine' ? '✓' : '⚠'} ${esc(verdict.text || '')}`
    // A second line, never folded into the ' · ' tail.
    const second = (!warn && chanText) ? `<span class="slr-rip-chan">${esc(chanText)}</span>` : ''
    // Verdicts cached for up to 30 days predate the channel read; without this
    // button the feature would not exist for any album already checked.
    const recheck = chan ? '' : `<button class="slr-btn slr-btn-quiet" data-act="verify">Check again</button>`
    return `<div class="${cls}"><b class="slr-rip-verdict">${bold}</b>
      <span>${esc(tail)}</span>${second}${recheck}</div>`
  }

  // The one sentence every new lookup owes a folder whose name doesn't say who
  // made the record. slsk-columns synthesises those with artist:'' and nothing
  // downstream can look anything up from that.
  const NO_ARTIST = "This folder's name doesn't say who the artist is, so I can't look the record up."

  function muted(text, esc) { return `<div class="slr-muted">${esc(text)}</div>` }

  // Did this lookup come back with a FINDING? Three shapes reach a slot: null
  // (a promise is still out), a reply, and a failure. Only the first two are
  // allowed to support a sentence about the record — and Discogs' own "no entry
  // for this album" is a finding, which is why it carries `found: false`
  // alongside its reason rather than being read off the reason text.
  function answered(slot) {
    if (slot == null) return false
    return slot.ok !== false || slot.found === false
  }

  // An expander that survives repaintBody: the flag is on the model and the
  // control is delegated, never an id with a listener bound to it.
  function expandable(raw, open, act, limit, esc) {
    const cut = bioPreview(raw, limit)
    const shown = open ? tidyText(raw) : cut.text
    // Rendered off `truncated`, which is a fact about the TEXT and not about
    // the flag, so the control does not vanish when the text is open.
    const more = cut.truncated
      ? `<button class="slr-btn slr-btn-quiet" data-act="${act}">${open ? 'Show less' : 'Show more'}</button>`
      : ''
    return { html: paragraphsHtml(shown, esc), more }
  }

  // The Discogs genre string "Folk, World, & Country" is ONE genre. Splitting
  // it on commas — which the old chip row did — put a chip reading "& Country"
  // on his screen. Only a slash separates two genres.
  function splitDiscogsGenre(s) {
    return String(s == null ? '' : s).split('/').map(x => x.trim()).filter(Boolean)
  }

  // MusicBrainz genres first, then Discogs genres, then Discogs styles, folded
  // together so "Prog Rock" and "progressive rock" are one chip and the first
  // spelling seen is the one shown.
  function genreChips(m) {
    const ai = m.albumInfo && m.albumInfo.ok !== false ? m.albumInfo : null
    const dg = m.reception && m.reception.ok !== false ? m.reception : null
    const seen = new Set()
    const names = []
    const sources = []
    const take = (list, source) => {
      let used = false
      for (const raw of list) {
        for (const name of splitDiscogsGenre(raw)) {
          const k = tagKey(name)
          if (!k || seen.has(k)) continue
          seen.add(k)
          names.push(name)
          used = true
          if (names.length >= 10) break
        }
        if (names.length >= 10) break
      }
      if (used && !sources.includes(source)) sources.push(source)
    }
    // `genres`, never `tags`: MusicBrainz's free-text tags carry downvoted junk
    // at count -1 and -2 ("groundbreaking", "laut.de", "male vocalist").
    if (ai) take((ai.genres || []).filter(g => g && (Number(g.count) || 0) > 0).map(g => g.name), 'MusicBrainz')
    if (dg) take(dg.genres || [], 'Discogs')
    if (dg) take(dg.styles || [], 'Discogs')
    return { names, sources }
  }

  // ── About this record ───────────────────────────────────────────────────────
  // One section per SUBJECT, not one per source: the old Reception section
  // showed Discogs' genres under a heading of its own, above a star row that
  // had never once had a number behind it. Every fact here carries its own
  // fallback sentence, because a headed blank is the one thing this must not be.
  function aboutRecordHtml(m, esc) {
    if (!m.artist) return muted(NO_ARTIST, esc)
    const ai = m.albumInfo
    const dg = m.reception && m.reception.ok !== false ? m.reception : null
    const out = []
    let descriptionUsed = false
    if (ai == null) {
      // Twelve seconds, not six: a cold album costs 4-7 s through the throttle,
      // and a warning that fires on every normal open reads as breakage.
      out.push(muted(m.slow
        ? 'Still asking MusicBrainz — it only answers one question a second.'
        : 'Looking up…', esc))
    } else if (ai.ok === false) {
      out.push(muted(ai.reason || NO_ANSWER, esc))
    } else if (!ai.found) {
      out.push(muted("I couldn't find this record on MusicBrainz. The folder name may not match what it's filed under.", esc))
    } else {
      const word = typeWord(ai.primaryType, ai.secondaryTypes)
      const when = formatReleaseDate(ai.date)
      let lead
      if (when) lead = 'Released ' + when + ' · ' + word
      else if (ai.wikiDescription) { lead = ai.wikiDescription; descriptionUsed = true }
      else lead = word
      out.push(`<div>${esc(lead)}</div>`)
      // ALWAYS printed, never conditionally. The dangerous failure is a title
      // that matches perfectly and a record that doesn't — a self-titled album,
      // or a folder called "Live at Leeds" that the picker's own type
      // preference steers onto the studio record.
      const year = String(ai.date || '').slice(0, 4)
      const paren = [year, word].filter(Boolean).join(', ')
      out.push(muted(`MusicBrainz has this as "${ai.title}"${paren ? ' (' + paren + ')' : ''}.`, esc))
      if (ai.confidence === 'loose') {
        out.push(muted("This might not be the same record as the folder you're looking at.", esc))
      }
      if (ai.wikiExtract) {
        const e = expandable(ai.wikiExtract, m.albumTextOpen, 'album-more', 420, esc)
        out.push(`<div class="slr-muted">${e.html}</div>${e.more}`)
      } else if (ai.wikiDescription && !descriptionUsed) {
        out.push(muted(ai.wikiDescription, esc))
      } else {
        out.push(muted('No one has written this record up on Wikipedia.', esc))
      }
    }
    const chips = genreChips(m)
    if (chips.names.length) {
      out.push(`<div class="slr-chips">${chips.names.map(n => `<span class="slr-chip">${esc(n)}</span>`).join('')}</div>`)
      out.push(muted('Genres from ' + chips.sources.join(' and ') + '.', esc))
    } else if (answered(ai) && answered(m.reception)) {
      // Only once BOTH sources have ANSWERED. `!= null` was the old gate, and
      // every failure shape satisfies it — so the panel stated a fact about the
      // record two sentences under a line saying it could not find out.
      out.push(muted('No genre tags on this record.', esc))
    }
    // The pressing notes: submitter text the Discogs master carries and the
    // panel has never shown. Sliced raw, escaped after.
    if (dg && dg.notes) {
      const sh = SH()
      const master = String(dg.masterTitle || '')
      // The master cleared the 0.6 title bar, but "cleared the bar" is not "is
      // the same record" — say whose notes these are when the names differ.
      const differs = master && sh && sh.normKey && sh.normKey(master) !== sh.normKey(m.title)
      const prefix = differs ? `From Discogs, for "${master}": ` : 'From Discogs: '
      const e = expandable(dg.notes, m.notesOpen, 'notes-more', 300, esc)
      out.push(`<div class="slr-muted">${esc(prefix)}${e.html}</div>${e.more}`)
    }
    const url = (ai && ai.ok !== false && ai.discogsUrl) || (dg && dg.url) || ''
    if (url) {
      out.push(`<div><button class="slr-btn slr-btn-quiet" data-act="external" data-url="${esc(url)}">See it on Discogs</button></div>`)
    }
    // A Discogs failure is worth a line when it explains a gap he can see —
    // the rate ceiling always, a plain miss only when MusicBrainz came up empty
    // too. Otherwise it is noise below a section that already said plenty.
    const dgFail = m.reception && m.reception.ok === false ? String(m.reception.reason || '') : ''
    const matched = !!(ai && ai.ok !== false && ai.found)
    if (dgFail && dgFail !== 'no-token' && (/busy/i.test(dgFail) || !matched)) out.push(muted(dgFail, esc))
    return out.join('')
  }

  // ── Artists here with the same tags ─────────────────────────────────────────
  // Named for what it actually is. The matching is at ARTIST level, so calling
  // it "more like this" would overclaim: artist tags cannot tell an artist's
  // ambient record from their breakbeat one.
  function sameTagsHtml(m, esc) {
    if (!m.artist) return muted(NO_ARTIST, esc)
    if (!(m.peerAlbums || []).length) return muted('There is nothing else in this library to match against.', esc)
    const tags = m.tagsByArtist || {}
    const mine = tags[tagKey(m.artist)]
    // The room only warms the peer's top 40 artists by shelf depth, so the
    // dossier asks for its own artist rather than hoping the sweep covered it.
    if (m.artistTags == null && !Array.isArray(mine)) return muted(`Reading genre tags for ${m.artist}…`, esc)
    const r = rankSameTagArtists({
      artist: m.artist, peerAlbums: m.peerAlbums, tagsByArtist: tags, owns: m.ownsPeerAlbum,
    })
    if (!r.seedTagCount) {
      // A FAILED lookup is not a finding. This branch was reached with
      // m.artistTags holding { ok: false, reason } and printed "MusicBrainz has
      // no genre tags for X" — a definitive claim about an answer nobody ever
      // got. The reply is only allowed to speak for MusicBrainz when it came
      // back; the room's own swept tags count too, and if they had any, the
      // seed count would not be zero.
      if (m.artistTags == null) return muted(`Reading genre tags for ${m.artist}…`, esc)
      if (!answered(m.artistTags)) return muted(m.artistTags.reason || NO_ANSWER, esc)
      return muted(`MusicBrainz has no genre tags for ${m.artist}, so I can't match this one up.`, esc)
    }
    if (!r.matches.length) {
      const two = r.generic.length ? r.generic.join(' and ') : 'the generic ones'
      return muted(`Nothing else here shares anything specific with ${m.artist} — the tags they have in common are just ${two}.`, esc)
    }
    const rows = r.matches.map(x => {
      // The matched tags ON the row are what make a bad match visible rather
      // than mysterious.
      const why = x.shared.slice(0, 2).join(' · ')
      return `<div class="slr-chips"><button class="slr-chip slr-chip-btn" data-peer="${esc(x.folderPath)}">${esc(x.album)} · ${esc(x.artist)}</button>` +
        (why ? `<span class="slr-chip">${esc(why)}</span>` : '') +
        (x.owned ? `<span class="slr-chip">you have it</span>` : '') + `</div>`
    }).join('')
    // Never "of ${total}": the warm-up stops permanently at the top 40 plus
    // three seeds, so a denominator it can never reach is a lie.
    const note = m.tagsDone
      ? `Matched on shared MusicBrainz tags. I have tags for ${r.tagged} of the biggest artists in this library.`
      : `Still reading genre tags for the artists here (${r.tagged} so far).`
    return rows + muted(note, esc)
  }

  // ── More by ${artist} ───────────────────────────────────────────────────────
  // The peer's own folders first — already in memory, instant — then what
  // MusicBrainz says the artist made that nobody here has.
  function moreByHtml(m, esc) {
    if (!m.artist) return muted(NO_ARTIST, esc)
    const out = []
    const sibs = (m.siblings || []).map(s =>
      `<button class="slr-chip slr-chip-btn" data-sibling="${esc(s.folderPath)}">${esc(s.album)}${s.isHiRes ? ' · hi-res' : ''}${s.surround ? ' · surround' : ''}</button>`).join('')
    if (sibs) out.push(`<div class="slr-chips">${sibs}</div>`)
    const ar = m.artistReleases
    if (ar == null) { out.push(muted('Looking up their records…', esc)); return out.join('') }
    if (ar.ok === false) { out.push(muted(ar.reason || NO_ANSWER, esc)); return out.join('') }
    const rows = m.releaseRows || []
    if (!rows.length) {
      out.push(muted(ar.artistMbid
        ? `MusicBrainz lists no other studio albums for ${m.artist}.`
        : `I couldn't find ${m.artist} on MusicBrainz, so I can't list what else they made.`, esc))
      return out.join('')
    }
    // Attributed to its source on purpose: this is not a discography, it is
    // what MusicBrainz has filed.
    //
    // And the total is only stated when the whole list was actually read. The
    // browse used to stop at one page of 50: Paul McCartney's type=album browse
    // reports 181 release groups, whose first 50 hold 24 studio albums where
    // all 181 hold 42 — so the panel printed "42 studio albums" as "24" and
    // meant it. `complete` comes from the handler that does the paging.
    const here = rows.filter(r => r.folderPath).length
    const yours = rows.filter(r => r.owned).length
    out.push(muted(ar.complete === false
      ? `This artist has more records than I could read in one go. Of the ${rows.length} studio albums I did read, ${m.username} has ${here} and you have ${yours}.`
      : `MusicBrainz lists ${rows.length} studio albums for ${m.artist}. ${m.username} has ${here}. You have ${yours}.`, esc))
    for (const r of rows.slice(0, 10)) {
      const label = r.title + (r.year ? ' · ' + r.year : '')
      const cell = r.folderPath
        ? `<button class="slr-chip slr-chip-btn" data-peer="${esc(r.folderPath)}">${esc(label)}</button><span class="slr-chip">here too</span>`
        : `<span class="slr-chip">${esc(label)}</span>` + (r.owned
          ? `<span class="slr-chip">you have it</span>`
          : `<button class="slr-btn slr-btn-quiet" data-act="wish" data-wish="${esc(m.artist + ' ' + r.title)}">Wishlist</button>`)
      out.push(`<div class="slr-chips">${cell}</div>`)
    }
    if (rows.length > 10) out.push(muted(`Showing the first 10 of ${rows.length}.`, esc))
    return out.join('')
  }

  // Three states, not two. `null` means STILL ASKING — and only a live promise
  // is allowed to hold the slot at null, which is why every lookup writes a
  // failure shape from its .catch and from the else of its bridge guard. The
  // old code printed "Nothing written about this artist yet." the instant the
  // panel opened, before Wikipedia had been asked anything.
  function aboutHtml(m, esc) {
    if (!m.artist) return `<div class="slr-muted">This folder's name doesn't say who the artist is, so I can't look the record up.</div>`
    const a = m.about
    if (a == null) return `<div class="slr-muted">Looking up…</div>`
    if (a.ok === false) return `<div class="slr-muted">${esc(a.reason || NO_ANSWER)}</div>`
    const bio = a.bio ? String(a.bio) : ''
    if (!bio) return `<div class="slr-muted">Wikipedia has nothing on ${esc(m.artist)}.</div>`
    const e = expandable(bio, m.bioOpen, 'bio-more', 420, esc)
    return `<div class="slr-muted">${e.html}</div>${e.more}`
  }

  function sectionsHtml(m, esc) {
    // A contradiction is worth nothing further down the panel: the Download
    // button is in the header, so the pill leads the row directly beneath it.
    const chan = m.rip && m.rip.ok ? m.rip.channelCheck : null
    // The type pill costs nothing beyond the lookup already made, and it only
    // appears when there is something to say: no pill on a plain studio album,
    // and none at all on a loose match, where the type belongs to a record we
    // are not sure is this one.
    const ai = m.albumInfo && m.albumInfo.ok !== false && m.albumInfo.found ? m.albumInfo : null
    const word = ai && ai.confidence === 'firm' ? typeWord(ai.primaryType, ai.secondaryTypes) : ''
    const facts = [
      (chan && chan.severity === 'warn') ? `<span class="slr-pill slr-pill-warn">${esc(warnPillText(chan))}</span>` : '',
      (word && word !== 'Studio album') ? `<span class="slr-pill">${esc(word)}</span>` : '',
      `<span class="slr-pill">${labelDot(m.tier)}${esc(m.quality)}</span>`,
      `<span class="slr-pill">${m.tracks.length} track${m.tracks.length === 1 ? '' : 's'}${m.length ? ' · ' + esc(m.length) : ''}</span>`,
      `<span class="slr-pill">${esc(m.size)}</span>`,
      (m.extras.log || m.extras.cue) ? `<span class="slr-pill">${[m.extras.log && 'log', m.extras.cue && 'cue'].filter(Boolean).join(' + ')}</span>` : '',
      `<span class="slr-pill slr-pill-verdict">${esc(m.verdict)}</span>`,
    ].filter(Boolean).join('')
    const about = aboutHtml(m, esc)
    const tracks = m.tracks.map((t, i) => {
      const name = String(t.name || t.filename || '')
      const n = (name.match(/^\s*(\d{1,3})/) || [])[1] || (i + 1)
      const q = [t.bitDepth && t.bitDepth + '/' + Math.round((t.sampleRate || 0) / 1000), !t.bitDepth && t.bitRate && t.bitRate + ' kbps'].filter(Boolean).join('')
      return `<div class="slr-track" data-fi="${i}"><span class="slr-n slr-mono">${esc(String(n))}</span><span class="slr-t">${esc(name.replace(/^\s*\d{1,3}\s*[-._)]*\s*/, '').replace(/\.[a-z0-9]+$/i, ''))}</span>
        <span class="slr-q slr-mono">${t.length ? esc(fmtDur(t.length)) + ' · ' : ''}${esc(q)}</span>
        <span class="slr-track-acts"><button class="slr-mini" data-act="preview" data-fi="${i}" title="Preview">⚡</button><button class="slr-mini" data-act="dl" data-fi="${i}" title="Download">↓</button></span></div>`
    }).join('')
    return `
      <div class="slr-facts">${facts}</div>
      <div class="slr-sec"><b>Rip check</b>${ripHtml(m, esc)}</div>
      <div class="slr-sec"><b>About this record</b>${aboutRecordHtml(m, esc)}</div>
      <div class="slr-sec"><b>About ${esc(m.artist || 'this artist')}</b>${about}</div>
      <div class="slr-sec"><b>More by ${esc(m.artist || 'this artist')}</b>${moreByHtml(m, esc)}</div>
      ${(m.peerAlbums || []).length ? `<div class="slr-sec"><b>Artists here with the same tags</b>${sameTagsHtml(m, esc)}</div>` : ''}
      <div class="slr-sec"><b>Tracks</b><div class="slr-tracks">${tracks}</div></div>
      <div class="slr-sec" id="slr-compare"><b>Tracks vs yours</b>${m.compareHtml || '<div class="slr-muted">You don\'t have this album.</div>'}</div>`
  }

  function open({ album, username, host, deps, siblings, autoVerify }) {
    const esc = deps.esc || (s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
    const showSnackbar = deps.showSnackbar || (() => {})
    const av = AV()
    const mine = av && av.findMyCopy ? av.findMyCopy(album, deps.state) : null
    const m = model(album, username, mine)
    m.siblings = siblings || []
    // Handed down by the room. peerAlbums is its whole albums array and
    // tagsByArtist is a LIVE reference to wander.tags, so rows that fill in
    // during the background sweep appear on the next repaint. Absent for any
    // caller outside the room, and every section that reads them says so.
    m.peerAlbums = Array.isArray(deps.peerAlbums) ? deps.peerAlbums : []
    m.tagsByArtist = deps.tagsByArtist || null
    m.ownsPeerAlbum = typeof deps.ownsPeerAlbum === 'function' ? deps.ownsPeerAlbum : null
    m.library = (deps.state && deps.state.library) || []
    // Read once here as well as in repaintBody, so a panel opened AFTER the
    // room's sweep finished doesn't say "still reading" on its first paint.
    m.tagsDone = typeof deps.tagsDone === 'function' ? !!deps.tagsDone() : !!deps.tagsDone
    // Real signatures: findMyCopy(a, state); compareDrawerHtml(cmp, mine, a, esc),
    // where cmp comes from PapaSlskCompare.compareAlbums(theirFiles, myTracks).
    if (mine && av && av.compareDrawerHtml) {
      try {
        const c = CMP()
        if (c && c.compareAlbums) {
          const cmp = c.compareAlbums(album.files || [], mine.tracks || [])
          m.compareHtml = av.compareDrawerHtml(cmp, mine, album, esc)
        }
      } catch (_) {}
    }

    const root = document.createElement('div')
    root.className = 'slr-dossier'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', m.title)
    const mount = host || document.body
    mount.appendChild(root)

    function paint() {
      root.innerHTML = `
        <div class="slr-dossier-scrim" data-act="close"></div>
        <div class="slr-dossier-panel">
          <button class="slr-x" data-act="close" aria-label="Close">×</button>
          <div class="slr-dossier-head">
            <div class="slr-dossier-cover" id="slr-cover"></div>
            <div>
              <h2 class="slr-dossier-title">${esc(m.title)}</h2>
              <div class="slr-muted">${esc([m.artist, m.year, m.editionNote, 'from ' + username].filter(Boolean).join(' · '))}</div>
              <div class="slr-acts">
                <button class="slr-btn slr-btn-pri" data-act="download">Download album</button>
                <button class="slr-btn" data-act="preview" data-fi="0">Preview a track</button>
                ${deps.wishlistAdd ? `<button class="slr-btn" data-act="wishlist">Add to wishlist</button>` : ''}
                ${deps.openSlskChat ? `<button class="slr-btn" data-act="chat">Message ${esc(username)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="slr-dossier-body">${sectionsHtml(m, esc)}</div>
        </div>`
      paintCover()
      armResizer()
    }

    // paint() re-serialises the whole panel, which throws the grab strip away
    // with everything else, so the resizer is re-attached on every paint. It is
    // not collapsible: folding a dossier to a rail leaves the album you opened
    // with nowhere to be, which reads as the page having broken rather than as
    // a panel having folded.
    function armResizer() {
      const PR = (typeof window !== 'undefined' && window.PapaPanelResize) || null
      const panel = root.querySelector('.slr-dossier-panel')
      if (!PR || !panel) return
      PR.attach({ el: panel, edge: 'left', key: 'slr_dossier_w', min: 380, max: 900, defaultPx: 560 })
    }

    function paintCover() {
      const el = root.querySelector('#slr-cover')
      if (!el) return
      const lib = mine && mine.artPath ? mine.artPath : null
      if (lib) { el.innerHTML = `<img src="file://${esc(lib)}" alt="">`; return }
      const hue = Math.abs([...m.title].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
      el.style.background = `linear-gradient(135deg,hsl(${hue},45%,20%),hsl(${(hue + 40) % 360},35%,12%))`
      if (window.api && window.api.fetchAlbumArt && m.artist) {
        window.api.fetchAlbumArt({ albumId: 'slsk-' + (m.artist + '-' + m.title).replace(/[^a-z0-9]+/gi, '-').toLowerCase(), artist: m.artist, album: m.title })
          .then(p => { if (p && root.isConnected) el.innerHTML = `<img src="${/^https?:/.test(p) ? esc(p) : 'file://' + esc(p)}" alt="">` }).catch(() => {})
      }
    }

    async function verify() {
      m.rip = { running: true, track: '' }
      repaintBody()
      const res = await window.api.slskVerifyRip({ username, folderPath: album.folderPath, files: album.files }).catch(e => ({ ok: false, reason: e.message }))
      m.rip = res || { ok: false, reason: 'The check did not answer.' }
      try { localStorage.setItem('slr_rip:' + username + ':' + album.folderPath, JSON.stringify(m.rip)) } catch (_) {}
      repaintBody()
    }

    // Scroll lives on .slr-dossier-panel, not on the body being replaced, so
    // swapping the body cannot move him — except that collapsing the bio makes
    // the page shorter and the browser clamps scrollTop on the spot. Capturing
    // and restoring here fixes it once for every late-arriving section.
    function repaintBody() {
      const b = root.querySelector('.slr-dossier-body')
      if (!b) return
      // tagsDone is a getter over the room's own sweep flag, so it is read at
      // paint time rather than captured once when the panel opened.
      m.tagsDone = typeof deps.tagsDone === 'function' ? !!deps.tagsDone() : !!deps.tagsDone
      const panel = root.querySelector('.slr-dossier-panel')
      const top = panel ? panel.scrollTop : 0
      b.innerHTML = sectionsHtml(m, esc)
      if (panel && top) panel.scrollTop = top
    }

    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-act],[data-sibling]')
      if (!t) return
      if (t.dataset.sibling) { const s = m.siblings.find(x => x.folderPath === t.dataset.sibling); close(); if (s && deps.openDossier) deps.openDossier(s); return }
      // Same behaviour as data-sibling, over the peer's whole library rather
      // than this artist's corner of it.
      if (t.dataset.peer) { const p = (m.peerAlbums || []).find(x => x && x.folderPath === t.dataset.peer); close(); if (p && deps.openDossier) deps.openDossier(p); return }
      const fi = Number(t.dataset.fi)
      const f = m.tracks[fi]
      switch (t.dataset.act) {
        case 'close': close(); break
        case 'verify': verify(); break
        // Delegated, never an id + addEventListener: repaintBody() destroys
        // directly-bound listeners on every async arrival.
        case 'bio-more': m.bioOpen = !m.bioOpen; repaintBody(); break
        case 'album-more': m.albumTextOpen = !m.albumTextOpen; repaintBody(); break
        case 'notes-more': m.notesOpen = !m.notesOpen; repaintBody(); break
        // main already refuses anything that is not https.
        case 'external':
          if (t.dataset.url && window.api && window.api.openExternal) window.api.openExternal(t.dataset.url)
          break
        case 'wish':
          if (!deps.wishlistAdd) { showSnackbar('The wishlist is not wired up'); break }
          deps.wishlistAdd(t.dataset.wish || '')
          showSnackbar('Added ' + (t.dataset.wish || '') + ' to the wishlist')
          break
        case 'download': {
          if (!deps._slskEnqueue) { showSnackbar('Downloads are not wired up'); break }
          const items = m.tracks.map(x => ({ username, filename: x.fullPath || x.filename || x.name, size: x.size || 0 }))
          const r = await deps._slskEnqueue(items)
          showSnackbar(r && r.ok ? 'Downloading ' + m.title : (r && r.reason) || 'Could not start the download')
          if (r && r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan()
          break
        }
        case 'preview':
          if (!f) break
          if (!deps.startPreview) { showSnackbar('Preview is not wired up'); break }
          deps.startPreview({ username, filename: f.fullPath || f.filename || f.name, title: m.title })
          break
        case 'dl': {
          if (!f) break
          if (!deps._slskEnqueue) { showSnackbar('Downloads are not wired up'); break }
          const r = await deps._slskEnqueue([{ username, filename: f.fullPath || f.filename || f.name, size: f.size || 0 }])
          showSnackbar(r && r.ok ? 'Downloading' : 'Could not start the download')
          break
        }
        case 'wishlist': if (deps.wishlistAdd) deps.wishlistAdd(m.artist + ' ' + m.title); break
        case 'chat': if (deps.openSlskChat) deps.openSlskChat(username); break
      }
    })
    // A room teardown wipes host.innerHTML, which removes this root without
    // ever calling close() — so the listener would outlive the panel. First
    // keystroke after that unhooks it.
    function onKey(e) {
      if (!root.isConnected) { document.removeEventListener('keydown', onKey, true); return }
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    document.addEventListener('keydown', onKey, true)
    let slowTimer = null
    function close() {
      document.removeEventListener('keydown', onKey, true)
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null }
      root.remove()
    }

    paint()
    // Async sections: cached rip verdict, reception, about. Each paints when it lands.
    try { const c = localStorage.getItem('slr_rip:' + username + ':' + album.folderPath); if (c) { const r = JSON.parse(c); if (r && r.at && Date.now() - r.at < 30 * 86400e3) { m.rip = r; repaintBody() } } } catch (_) {}
    // Same rule as every other lookup in this file, which this one used to
    // break: a bare .catch(() => {}) and no else left m.reception at null for
    // good on a rejection or a missing bridge, and null means STILL ASKING —
    // so the genre line and the pressing notes never resolved.
    if (window.api && window.api.discogsAlbum) {
      window.api.discogsAlbum({ artist: m.artist, album: m.title })
        .then(r => { m.reception = r || { ok: false, reason: NO_ANSWER }; if (root.isConnected) repaintBody() })
        .catch(() => { m.reception = { ok: false, reason: NO_ANSWER }; if (root.isConnected) repaintBody() })
    } else {
      m.reception = { ok: false, reason: NO_ANSWER }
      repaintBody()
    }
    // m.about stays null only while this promise is out. A rejection, a reply
    // that never came back, or a missing bridge each write the failure shape —
    // a bare .catch(() => {}) would leave "Looking up…" on screen for good.
    if (m.artist) {
      if (window.api && window.api.artistInfo) {
        window.api.artistInfo({ artist: m.artist })
          .then(r => { m.about = r || { ok: false, reason: NO_ANSWER }; if (root.isConnected) repaintBody() })
          .catch(() => { m.about = { ok: false, reason: NO_ANSWER }; if (root.isConnected) repaintBody() })
      } else {
        m.about = { ok: false, reason: NO_ANSWER }
        repaintBody()
      }
    }

    // ── The record's own facts, and what else there is ────────────────────────
    // Every one of these follows the same rule as the bio above: a slot stays
    // null only while a live promise is out, so each .then has a matching
    // .catch and each bridge guard has an else, both writing a failure shape
    // and repainting. Nothing is awaited before the first paint.
    function settle(slot, value) {
      m[slot] = value
      if (root.isConnected) repaintBody()
    }
    function askArtistReleases() {
      const ai = m.albumInfo
      // The MBID is inherited ONLY from a firm match. From a loose one it
      // produces a confidently wrong catalogue, so the handler pays for an
      // artist search instead — cached per artist, not per album.
      const firm = !!(ai && ai.ok !== false && ai.found && ai.confidence === 'firm' && ai.artistMbid)
      const arg = firm ? { artistMbid: ai.artistMbid, artist: m.artist } : { artist: m.artist }
      const land = r => {
        const v = r || { ok: false, reason: NO_ANSWER }
        // The marks are local and instant, but they are worked out ONCE here
        // rather than on each of the repaints that follow.
        m.releaseRows = v.ok !== false
          ? markReleases(v.releases || [], { artist: m.artist, library: m.library, peerAlbums: m.peerAlbums })
          : []
        settle('artistReleases', v)
      }
      if (window.api && window.api.artistReleases) {
        window.api.artistReleases(arg).then(land).catch(() => land(null))
      } else land(null)
    }
    if (m.artist && m.title) {
      if (window.api && window.api.albumInfo) {
        window.api.albumInfo({ artist: m.artist, album: m.title, year: m.year, editionNote: m.editionNote })
          .then(r => { settle('albumInfo', r || { ok: false, reason: NO_ANSWER }); askArtistReleases() })
          .catch(() => { settle('albumInfo', { ok: false, reason: NO_ANSWER }); askArtistReleases() })
      } else {
        m.albumInfo = { ok: false, reason: NO_ANSWER }
        askArtistReleases()
      }
      // The room warms only the peer's top 40 artists, so the 60th-ranked one
      // would never have tags. Cache-backed and usually free.
      if (window.api && window.api.musicbrainzArtistTags) {
        window.api.musicbrainzArtistTags({ artist: m.artist })
          .then(r => {
            const v = r || { ok: false, reason: NO_ANSWER }
            // Fold the answer into the live map the room owns, so this artist's
            // tags are there for the ranking exactly like the swept ones.
            if (v.ok && m.tagsByArtist && Array.isArray(v.tags)) m.tagsByArtist[tagKey(m.artist)] = v.tags
            settle('artistTags', v)
          })
          .catch(() => settle('artistTags', { ok: false, reason: NO_ANSWER }))
      } else m.artistTags = { ok: false, reason: NO_ANSWER }
      // Twelve seconds, not six: a cold album genuinely costs 4-7 s through the
      // 1.1 s throttle, and a warning that fires on every normal open reads as
      // breakage rather than as patience.
      slowTimer = setTimeout(() => {
        slowTimer = null
        if (m.albumInfo == null) { m.slow = true; if (root.isConnected) repaintBody() }
      }, 12000)
    } else {
      // An empty artist is a folder name that did not parse. Refuse
      // SYNCHRONOUSLY and make no request at all: `artist:""` would burn two
      // throttled slots landing on whatever Lucene liked.
      const refusal = {
        ok: false,
        reason: m.artist
          ? "This folder has no album name in it, so I can't look the record up."
          : "This folder's name doesn't say who the artist is, so I can't look the record up.",
      }
      m.albumInfo = refusal
      m.artistReleases = refusal
      m.artistTags = refusal
      m.releaseRows = []
      repaintBody()
    }
    requestAnimationFrame(() => {
      root.classList.add('is-open')
      // "Verify this rip" opens the dossier and starts the check in one go;
      // a cached verdict already on screen is answer enough.
      if (autoVerify && !m.rip) verify()
    })
    return { close }
  }

  const api = {
    open, model, sectionsHtml, aboutHtml, aboutRecordHtml, sameTagsHtml, moreByHtml,
    bioPreview, firstSentence, editionOf, fmtDur,
    typeWord, formatReleaseDate, rankSameTagArtists, markReleases, splitDiscogsGenre,
  }
  if (typeof window !== 'undefined') window.PapaSlskDossier = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
