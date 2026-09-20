'use strict'
// The dossier's new sections, as a model-to-string function.
//
// The binding rule for every one of them: a section that has nothing to show
// says so in a plain sentence. A headed blank reads as the app having broken,
// so the state table below asserts a non-empty body in every branch, not just
// the happy one.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const D = require('../src/slsk-dossier')

const album = {
  artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975,
  folderName: 'Pink Floyd - 1975 - Wish You Were Here', folderPath: 'Music\\PF\\WYWH',
  lossless: true, totalSize: 4e8,
  files: [{ name: '01 Shine On.flac', size: 4e8, length: 810 }],
}
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const base = (over) => Object.assign(D.model(album, 'vinylhoarder', null), over || {})
const html = m => D.sectionsHtml(m, esc)

// Every `.slr-sec` in the output, as { heading, body-with-tags-stripped }.
function sections(out) {
  const found = []
  const re = /<div class="slr-sec"[^>]*><b>([^<]*)<\/b>([\s\S]*?)(?=<div class="slr-sec"|$)/g
  let m
  while ((m = re.exec(out))) found.push({ heading: m[1], body: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() })
  return found
}
// Entities come back out here: every one of these strings went through esc()
// on the way in, which is the point, and the assertions below are about the
// sentence rather than about the escaping (which has its own test).
const unesc = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const bodyOf = (out, heading) => {
  const s = sections(out).find(x => x.heading === heading)
  assert.ok(s, 'the "' + heading + '" section must be rendered')
  return unesc(s.body)
}

const HIT = {
  ok: true, found: true, confidence: 'firm',
  mbid: 'rg-1', artistMbid: 'artist-1', title: 'Wish You Were Here',
  date: '1975-09-12', primaryType: 'Album', secondaryTypes: [],
  genres: [{ name: 'progressive rock', count: 25 }, { name: 'art rock', count: 16 }],
  wikiExtract: 'Wish You Were Here is the ninth studio album by Pink Floyd.',
  wikiDescription: '1975 studio album by Pink Floyd',
  discogsUrl: 'https://www.discogs.com/master/11703',
}
const DISCOGS = {
  ok: true, rating: null, count: 0, genres: ['Rock'], styles: ['Prog Rock'],
  year: 1975, masterTitle: 'Wish You Were Here', notes: 'Recorded at Abbey Road.',
  url: 'https://www.discogs.com/master/11703', tokenless: true,
}

// ── the state table ──────────────────────────────────────────────────────────

test('no state renders an empty section body', () => {
  const states = {
    'nothing has answered yet': base(),
    'the slow warning is showing': base({ slow: true }),
    'MusicBrainz has no such record': base({ albumInfo: { ok: true, found: false }, reception: { ok: false, reason: 'Discogs has no entry for this album.' } }),
    'the lookup never answered': base({ albumInfo: { ok: false, reason: "The lookup didn't answer. Close and reopen the panel to try again." }, artistReleases: { ok: false, reason: 'x' } }),
    'the folder names no artist': D.model({ ...album, artist: '' }, 'u', null),
    'everything landed': base({ albumInfo: HIT, reception: DISCOGS, artistReleases: { ok: true, artistMbid: 'a', releases: [] }, releaseRows: [] }),
  }
  for (const [what, m] of Object.entries(states)) {
    for (const s of sections(html(m))) {
      assert.ok(s.body.length > 0, `"${s.heading}" was a headed blank when ${what}`)
    }
  }
})

test('About this record says it is still asking, then that it is still asking slowly', () => {
  assert.equal(bodyOf(html(base()), 'About this record'), 'Looking up…')
  assert.equal(bodyOf(html(base({ slow: true })), 'About this record'),
    'Still asking MusicBrainz — it only answers one question a second.')
})

// Discogs' own "no entry for this album" is an ANSWER, and says so in the
// reply: `found: false` beside the reason. Every other ok:false shape is the
// lookup falling over.
const DISCOGS_MISS = { ok: false, found: false, reason: 'Discogs has no entry for this album.' }

test('About this record names the folder as the likely problem on a miss', () => {
  const b = bodyOf(html(base({ albumInfo: { ok: true, found: false }, reception: DISCOGS_MISS })), 'About this record')
  assert.ok(b.includes("I couldn't find this record on MusicBrainz. The folder name may not match what it's filed under."))
  assert.ok(b.includes('No genre tags on this record.'))
})

test('About this record prints the didn\'t-answer sentence on a failure', () => {
  const b = bodyOf(html(base({ albumInfo: { ok: false, reason: "The lookup didn't answer. Close and reopen the panel to try again." } })), 'About this record')
  assert.ok(b.startsWith("The lookup didn't answer."))
})

test('About this record refuses outright when the folder names no artist', () => {
  const b = bodyOf(html(D.model({ ...album, artist: '' }, 'u', null)), 'About this record')
  assert.equal(b, "This folder's name doesn't say who the artist is, so I can't look the record up.")
})

// ── the facts ────────────────────────────────────────────────────────────────

test('the lead line is the date and the kind of record', () => {
  const b = bodyOf(html(base({ albumInfo: HIT })), 'About this record')
  assert.ok(b.includes('Released 12 September 1975 · Studio album'))
})

test('the identity line is printed even when the title matches perfectly', () => {
  // The dangerous failure is a title that matches and a record that doesn't.
  const b = bodyOf(html(base({ albumInfo: HIT })), 'About this record')
  assert.ok(b.includes('MusicBrainz has this as "Wish You Were Here" (1975, Studio album).'))
  assert.ok(!b.includes('might not be the same record'))
})

test('a loose match says so, right under the identity line', () => {
  const b = bodyOf(html(base({ albumInfo: { ...HIT, confidence: 'loose' } })), 'About this record')
  assert.ok(b.includes('MusicBrainz has this as "Wish You Were Here"'))
  assert.ok(b.includes("This might not be the same record as the folder you're looking at."))
})

test('with no date, the Wikipedia description becomes the lead line', () => {
  const b = bodyOf(html(base({ albumInfo: { ...HIT, date: '', wikiExtract: null } })), 'About this record')
  assert.ok(b.includes('1975 studio album by Pink Floyd'))
  assert.ok(!b.includes('Released'))
  assert.equal((b.match(/1975 studio album by Pink Floyd/g) || []).length, 1,
    'the description is the lead line OR the paragraph, never both')
})

test('with no date and no description, the type word stands alone', () => {
  const b = bodyOf(html(base({ albumInfo: { ...HIT, date: '', wikiExtract: null, wikiDescription: null } })), 'About this record')
  assert.ok(b.startsWith('Studio album'))
  assert.ok(b.includes('No one has written this record up on Wikipedia.'))
})

test('the type pill appears for a live album and never for a studio one', () => {
  const live = { ...HIT, secondaryTypes: ['Live'] }
  assert.ok(html(base({ albumInfo: live })).includes('<span class="slr-pill">Live album</span>'))
  assert.ok(!html(base({ albumInfo: HIT })).includes('>Studio album</span>'))
})

test('the type pill is withheld on a loose match', () => {
  // The type belongs to a record we are not sure is this one.
  const loose = { ...HIT, secondaryTypes: ['Live'], confidence: 'loose' }
  assert.ok(!html(base({ albumInfo: loose })).includes('<span class="slr-pill">Live album</span>'))
})

// ── genres ───────────────────────────────────────────────────────────────────

test('genre chips fold MusicBrainz and Discogs into one row and say where from', () => {
  const b = bodyOf(html(base({ albumInfo: HIT, reception: DISCOGS })), 'About this record')
  assert.ok(b.includes('Genres from MusicBrainz and Discogs.'))
  // "Prog Rock" and "progressive rock" are NOT the same fold, but "Rock" and
  // "rock" would be: the first spelling seen survives.
  assert.ok(b.includes('progressive rock'))
  assert.ok(b.includes('Prog Rock'))
})

test('genre chips attribute a single source correctly', () => {
  assert.ok(bodyOf(html(base({ albumInfo: HIT, reception: { ok: false, reason: 'x' } })), 'About this record')
    .includes('Genres from MusicBrainz.'))
  assert.ok(bodyOf(html(base({ albumInfo: { ok: true, found: false }, reception: DISCOGS })), 'About this record')
    .includes('Genres from Discogs.'))
})

test('a Discogs genre is split on slashes only, never on commas', () => {
  // His live cache proves the comma split turned Discogs' own genre
  // "Folk, World, & Country" into a chip reading "& Country".
  assert.deepEqual(D.splitDiscogsGenre('Folk, World, & Country'), ['Folk, World, & Country'])
  assert.deepEqual(D.splitDiscogsGenre('Electronic/Rock'), ['Electronic', 'Rock'])
  const dg = { ...DISCOGS, genres: ['Folk, World, & Country'], styles: [] }
  const b = bodyOf(html(base({ albumInfo: { ok: true, found: false }, reception: dg })), 'About this record')
  assert.ok(b.includes('Folk, World, &amp; Country') || b.includes('Folk, World, & Country'))
  assert.ok(!b.includes('&amp; Country<'))
})

test('the genre fallback waits for both sources before it speaks', () => {
  // MusicBrainz has answered, Discogs has not: "no genre tags" would be a
  // statement about a lookup that is still running.
  const b = bodyOf(html(base({ albumInfo: { ok: true, found: false } })), 'About this record')
  assert.ok(!b.includes('No genre tags on this record.'))
})

test('a lookup that FAILED never earns the panel a fact about the record', () => {
  // The old gate was `!= null`, which every failure shape satisfies — so the
  // panel stated "No genre tags on this record." two sentences under a line
  // saying it had not managed to find out.
  const failed = { ok: false, reason: "The lookup didn't answer. Close and reopen the panel to try again." }
  const both = bodyOf(html(base({ albumInfo: failed, reception: { ok: false, reason: 'Discogs did not answer: socket hang up' } })), 'About this record')
  assert.ok(both.startsWith("The lookup didn't answer."))
  assert.ok(!both.includes('No genre tags on this record.'), 'nobody looked, so nobody knows')

  // One side down is still one side down.
  const halfA = bodyOf(html(base({ albumInfo: failed, reception: DISCOGS_MISS })), 'About this record')
  assert.ok(!halfA.includes('No genre tags on this record.'))
  const halfB = bodyOf(html(base({ albumInfo: { ok: true, found: false }, reception: { ok: false, reason: 'Discogs is busy right now. Try again in a minute.' } })), 'About this record')
  assert.ok(!halfB.includes('No genre tags on this record.'))

  // And when both really did answer, the sentence is earned.
  const answered = bodyOf(html(base({ albumInfo: { ok: true, found: true, title: 'Wish You Were Here', date: '', primaryType: 'Album', secondaryTypes: [], genres: [], confidence: 'firm' }, reception: DISCOGS_MISS })), 'About this record')
  assert.ok(answered.includes('No genre tags on this record.'))
})

// ── notes and the link ───────────────────────────────────────────────────────

test('the pressing notes are prefixed with their source', () => {
  const b = bodyOf(html(base({ albumInfo: HIT, reception: DISCOGS })), 'About this record')
  assert.ok(b.includes('From Discogs: Recorded at Abbey Road.'))
})

test('notes from a master with a different name say whose they are', () => {
  const dg = { ...DISCOGS, masterTitle: 'Wish You Were Here: Experience Edition' }
  const b = bodyOf(html(base({ albumInfo: HIT, reception: dg })), 'About this record')
  assert.ok(b.includes('From Discogs, for "Wish You Were Here: Experience Edition": Recorded at Abbey Road.'))
})

test('the Discogs link prefers the MusicBrainz relation over the search hit', () => {
  const out = html(base({ albumInfo: HIT, reception: { ...DISCOGS, url: 'https://www.discogs.com/master/99999' } }))
  assert.ok(out.includes('data-act="external" data-url="https://www.discogs.com/master/11703"'))
  assert.ok(out.includes('See it on Discogs'))
})

test('no link and no placeholder when neither source produced one', () => {
  const out = html(base({ albumInfo: { ...HIT, discogsUrl: null }, reception: { ok: false, reason: 'Discogs has no entry for this album.' } }))
  assert.ok(!out.includes('See it on Discogs'))
})

test('a Discogs rate-limit is surfaced; a plain miss beside a good match is not', () => {
  const busy = bodyOf(html(base({ albumInfo: HIT, reception: { ok: false, reason: 'Discogs is busy right now. Try again in a minute.' } })), 'About this record')
  assert.ok(busy.includes('Discogs is busy right now. Try again in a minute.'))
  const quiet = bodyOf(html(base({ albumInfo: HIT, reception: { ok: false, reason: 'Discogs has no entry for this album.' } })), 'About this record')
  assert.ok(!quiet.includes('Discogs has no entry'), 'the section above already gave the date, the type and the paragraph')
})

// ── the expanders ────────────────────────────────────────────────────────────

const LONG = 'Wish You Were Here is the ninth studio album by the English rock band Pink Floyd, released in September 1975. ' +
  'Based on material composed while performing in Europe, it explores themes of absence and the music business. ' +
  'The album was recorded at Abbey Road Studios in London over many months during the first half of that year. ' +
  'It reached number one in both the United Kingdom and the United States on release. ' +
  'The cover art shows two businessmen shaking hands, one of them on fire.'

test('the album paragraph gets its own control, independent of the bio', () => {
  const closed = html(base({ albumInfo: { ...HIT, wikiExtract: LONG } }))
  assert.ok(closed.includes('data-act="album-more">Show more</button>'))
  assert.ok(!closed.includes('one of them on fire'))
  const open = html(base({ albumInfo: { ...HIT, wikiExtract: LONG }, albumTextOpen: true }))
  assert.ok(open.includes('data-act="album-more">Show less</button>'))
  assert.ok(open.includes('one of them on fire'))
  assert.ok(!open.includes('data-act="bio-more"'), 'the bio has its own flag and is still closed')
})

test('the pressing notes get their own control too', () => {
  const dg = { ...DISCOGS, notes: LONG }
  assert.ok(html(base({ albumInfo: HIT, reception: dg })).includes('data-act="notes-more">Show more</button>'))
  const open = html(base({ albumInfo: HIT, reception: dg, notesOpen: true }))
  assert.ok(open.includes('data-act="notes-more">Show less</button>'))
  assert.ok(open.includes('one of them on fire'))
})

// ── escaping ─────────────────────────────────────────────────────────────────

test('every externally-sourced string in the new sections is escaped', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const m = base({
    albumInfo: { ...HIT, title: hostile, wikiExtract: hostile, wikiDescription: hostile, genres: [{ name: hostile, count: 3 }], discogsUrl: 'https://x/"' + hostile },
    reception: { ...DISCOGS, genres: [hostile], styles: [hostile], notes: hostile, masterTitle: hostile, url: hostile },
    artistReleases: { ok: true, artistMbid: 'a', releases: [] },
    releaseRows: [{ id: '1', title: hostile, year: '1975', owned: false, folderPath: hostile }],
    peerAlbums: [{ artist: hostile, album: hostile, folderPath: hostile }],
    tagsByArtist: { [hostile.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()]: ['x'] },
    artistTags: { ok: true, tags: [] },
  })
  const out = html(m)
  assert.ok(!out.includes('<img'), 'no raw tag survives anywhere in the panel')
  // And nothing escaped its attribute: every one of these values is carried in
  // a double-quoted data- attribute.
  assert.ok(!/data-(url|peer|wish|sibling)="[^"]*"[^ >]/.test(out), 'no attribute breakout')
  assert.equal((out.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length > 0, true,
    'the hostile string is present, and inert')
})

// ── Artists here with the same tags ──────────────────────────────────────────

const peerAlbum = (artist, name) => ({ artist, album: name, folderPath: 'p/' + artist, lossless: true, files: [{ name: 'a.flac' }] })

test('the tags section is omitted entirely outside the room, never left blank', () => {
  const out = html(base({ peerAlbums: [] }))
  assert.ok(!out.includes('Artists here with the same tags'))
})

test('the tags section says it is reading while this artist has no tags yet', () => {
  const m = base({ peerAlbums: [peerAlbum('Hawkwind', 'Space Ritual')] })
  assert.equal(bodyOf(html(m), 'Artists here with the same tags'), 'Reading genre tags for Pink Floyd…')
})

test('the tags section names the artist when MusicBrainz has no tags for them', () => {
  // A third of his cached artists are in exactly this position.
  const m = base({ peerAlbums: [peerAlbum('Hawkwind', 'Space Ritual')], tagsByArtist: {}, artistTags: { ok: true, tags: [] } })
  assert.equal(bodyOf(html(m), 'Artists here with the same tags'),
    "MusicBrainz has no genre tags for Pink Floyd, so I can't match this one up.")
})

test('the tags section will not blame MusicBrainz for a lookup that failed', () => {
  // Same empty seed, two different reasons for it, and only one of them is a
  // finding. The failure shape was being read as "MusicBrainz has no genre tags
  // for Pink Floyd" — a definitive claim about an answer nobody ever got.
  const m = base({
    peerAlbums: [peerAlbum('Hawkwind', 'Space Ritual')],
    tagsByArtist: {},
    artistTags: { ok: false, reason: 'MusicBrainz did not answer: socket hang up' },
  })
  const b = bodyOf(html(m), 'Artists here with the same tags')
  assert.equal(b, 'MusicBrainz did not answer: socket hang up')
  assert.ok(!b.includes('has no genre tags'), 'a failure is not a finding')
})

test('the tags section is still reading while its own lookup is in flight', () => {
  // The room swept this artist and came back empty, so `mine` is an array and
  // the first guard lets it through — but our own request is still out.
  const m = base({
    peerAlbums: [peerAlbum('Hawkwind', 'Space Ritual')],
    tagsByArtist: { 'pink floyd': [] },
    artistTags: null,
  })
  assert.equal(bodyOf(html(m), 'Artists here with the same tags'), 'Reading genre tags for Pink Floyd…')
})

test('the tags section names the generic tags when nothing is specific enough', () => {
  // Two artists, both tagged only `rock` and `pop` — which every one of them
  // carries, so nothing is rare and nothing qualifies.
  const tags = { 'pink floyd': ['rock', 'pop'], hawkwind: ['rock', 'pop'], yes: ['rock', 'pop'] }
  const m = base({
    peerAlbums: [peerAlbum('Hawkwind', 'Space Ritual'), peerAlbum('Yes', 'Fragile')],
    tagsByArtist: tags, artistTags: { ok: true, tags: tags['pink floyd'] },
  })
  const b = bodyOf(html(m), 'Artists here with the same tags')
  assert.ok(b.startsWith('Nothing else here shares anything specific with Pink Floyd — the tags they have in common are just '))
  assert.ok(/rock and pop|pop and rock/.test(b))
})

test('a match carries its matched tags and a clickable chip', () => {
  const tags = {
    'pink floyd': ['progressive rock', 'space rock'],
    hawkwind: ['progressive rock', 'space rock'],
    abba: ['pop'], blondie: ['pop'], queen: ['pop'], wham: ['pop'],
    'the beatles': ['pop'], oasis: ['pop'], blur: ['pop'], pulp: ['pop'],
  }
  const peerAlbums = Object.keys(tags).filter(k => k !== 'pink floyd').map(k => peerAlbum(k, k + ' album'))
  const m = base({ peerAlbums, tagsByArtist: tags, artistTags: { ok: true, tags: tags['pink floyd'] }, tagsDone: true })
  const out = html(m)
  assert.ok(out.includes('data-peer="p/hawkwind"'))
  assert.ok(out.includes('space rock · progressive rock') || out.includes('progressive rock · space rock'))
  assert.ok(bodyOf(out, 'Artists here with the same tags')
    .includes('Matched on shared MusicBrainz tags. I have tags for'))
})

test('the honesty line is in the present tense while the sweep is still running', () => {
  const tags = { 'pink floyd': ['space rock'], hawkwind: ['space rock'] }
  const m = base({ peerAlbums: [peerAlbum('Hawkwind', 'x')], tagsByArtist: tags, artistTags: { ok: true, tags: ['space rock'] }, tagsDone: false })
  const b = bodyOf(html(m), 'Artists here with the same tags')
  // One shared tag is under the two-tag floor, so this is the no-match branch —
  // what matters is that neither branch ever prints "of <total>".
  assert.ok(!/of \d+ artists/.test(b), 'the warm-up stops at the top 40, so a denominator would be a lie')
})

// ── the ranking, against his own cache ───────────────────────────────────────

const RAW_TAGS = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'album-info', 'peer-artist-tags.json'), 'utf8'))
// The cache is keyed by the raw lowercased artist name; the room keys its live
// map by PapaSlskWander.norm. Fold it the way the room does.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const LIVE_TAGS = {}
for (const k of Object.keys(RAW_TAGS)) LIVE_TAGS[norm(k)] = RAW_TAGS[k]
const LIVE_ALBUMS = Object.keys(RAW_TAGS).map(a => peerAlbum(a, 'An album by ' + a))

test('the real cache is the shape this ranking was tuned against', () => {
  const artists = Object.keys(RAW_TAGS)
  assert.equal(artists.length, 181)
  assert.equal(artists.filter(a => !RAW_TAGS[a].length).length, 60, 'a third have no tags at all')
  const df = new Map()
  for (const a of artists) for (const t of new Set(RAW_TAGS[a])) df.set(t, (df.get(t) || 0) + 1)
  assert.equal(df.size, 260)
  assert.equal(df.get('rock'), 67, 'the commonest tag is useless for telling artists apart')
})

test('rarity, not raw count: Gong outranks Camel for Pink Floyd', () => {
  // Under a raw shared-tag count Camel (4 shared) beats Gong (3). Under rarity
  // Gong wins, because it shares `space rock` — 3 of 121 tagged artists — where
  // Camel's extra tag is `rock`, which 67 of them carry. Replace the rarity
  // score with a raw count and this assertion inverts.
  const r = D.rankSameTagArtists({ artist: 'Pink Floyd', peerAlbums: LIVE_ALBUMS, tagsByArtist: LIVE_TAGS, cap: 20 })
  const at = n => r.matches.findIndex(m => norm(m.artist) === n)
  assert.ok(at('hawkwind') === 0, 'Hawkwind first — psychedelic and space rock')
  assert.ok(at('yes') === 1)
  assert.ok(at('gong') >= 0 && at('gong') < at('camel'), 'Gong above Camel')
  assert.ok(at('frank zappa') === -1 || at('frank zappa') > 7,
    'Zappa shares only rock, art rock and progressive rock — the generic three')
  assert.equal(r.tagged, 121)
})

test('every Tipper match is the same generic electronic pair', () => {
  // The specificity floor does NOT save this seed: `ambient` (9 of 121) and
  // `electronic` (15 of 121) are both under the rarity bar, so all seven
  // candidates qualify and all seven tie on score. The design predicted zero
  // matches here; his real cache says otherwise, and this test pins what the
  // data actually does rather than what was hoped for.
  const r = D.rankSameTagArtists({ artist: 'Tipper', peerAlbums: LIVE_ALBUMS, tagsByArtist: LIVE_TAGS, cap: 20 })
  assert.equal(r.total, 7)
  for (const m of r.matches) {
    assert.deepEqual(m.shared.slice().sort(), ['ambient', 'electronic'],
      m.artist + ' shares nothing but the generic electronic pair')
  }
})

test('the cap is eight, and one album per artist', () => {
  const doubled = LIVE_ALBUMS.concat(LIVE_ALBUMS.map(a => ({ ...a, album: a.album + ' (again)', folderPath: a.folderPath + '-2' })))
  const r = D.rankSameTagArtists({ artist: 'Pink Floyd', peerAlbums: doubled, tagsByArtist: LIVE_TAGS })
  assert.equal(r.matches.length, 8)
  assert.equal(new Set(r.matches.map(m => norm(m.artist))).size, 8, 'no artist may flood the shelf')
})

test('the ranking prefers an album he does not already own', () => {
  // Ten filler artists so `space rock` is genuinely rare here rather than
  // rare-by-arithmetic in a library of two.
  const tags = { 'pink floyd': ['space rock', 'progressive'], hawkwind: ['space rock', 'progressive'] }
  const filler = []
  for (let i = 0; i < 10; i++) { tags['filler ' + i] = ['pop']; filler.push(peerAlbum('Filler ' + i, 'x')) }
  const owned = { ...peerAlbum('Hawkwind', 'Owned One'), folderPath: 'p/owned' }
  const not = { ...peerAlbum('Hawkwind', 'Missing One'), folderPath: 'p/missing' }
  const r = D.rankSameTagArtists({
    artist: 'Pink Floyd', peerAlbums: [owned, not].concat(filler), tagsByArtist: tags, owns: a => a.folderPath === 'p/owned',
  })
  assert.equal(r.matches.length, 1)
  assert.equal(r.matches[0].album, 'Missing One')
  assert.equal(r.matches[0].owned, false)
})

// ── More by ${artist} ────────────────────────────────────────────────────────

test('More by says it is looking while the discography is in flight', () => {
  assert.equal(bodyOf(html(base()), 'More by Pink Floyd'), 'Looking up their records…')
})

test('More by shows the peer\'s own folders instantly, before any reply lands', () => {
  const m = base({ siblings: [{ folderPath: 'p/animals', album: 'Animals', isHiRes: true }] })
  const out = html(m)
  assert.ok(out.includes('data-sibling="p/animals"'))
  assert.ok(out.includes('Animals · hi-res'))
  assert.ok(bodyOf(out, 'More by Pink Floyd').includes('Looking up their records…'))
})

test('More by names the artist when MusicBrainz could not find them', () => {
  const m = base({ artistReleases: { ok: true, artistMbid: null, releases: [] }, releaseRows: [] })
  assert.equal(bodyOf(html(m), 'More by Pink Floyd'),
    "I couldn't find Pink Floyd on MusicBrainz, so I can't list what else they made.")
})

test('More by says so when the artist has no other studio albums filed', () => {
  const m = base({ artistReleases: { ok: true, artistMbid: 'a', releases: [] }, releaseRows: [] })
  assert.equal(bodyOf(html(m), 'More by Pink Floyd'), 'MusicBrainz lists no other studio albums for Pink Floyd.')
})

test('More by counts what each of them has, attributed to MusicBrainz', () => {
  const rows = [
    { id: '1', title: 'Animals', year: '1977', owned: true, folderPath: '' },
    { id: '2', title: 'The Wall', year: '1979', owned: false, folderPath: 'p/wall' },
    { id: '3', title: 'Meddle', year: '1971', owned: false, folderPath: '' },
  ]
  const m = base({ artistReleases: { ok: true, artistMbid: 'a', releases: rows }, releaseRows: rows })
  const out = html(m)
  assert.ok(bodyOf(out, 'More by Pink Floyd')
    .includes('MusicBrainz lists 3 studio albums for Pink Floyd. vinylhoarder has 1. You have 1.'))
  assert.ok(out.includes('data-peer="p/wall"'), 'the one that is here opens that dossier')
  assert.ok(out.includes('here too'))
  assert.ok(out.includes('you have it'))
  assert.ok(out.includes('data-act="wish" data-wish="Pink Floyd Meddle"'), 'and the missing one is wishlistable')
})

test('More by states no total when the list could not be read to the end', () => {
  // Paul McCartney's browse reports 181 release groups; one page of 50 held 24
  // studio albums where all 181 hold 42. A count off a truncated list is a
  // wrong number stated as a fact, so when the paging gives up, the sentence
  // says what it read instead of what MusicBrainz has.
  const rows = [
    { id: '1', title: 'Ram', year: '1971', owned: true, folderPath: '' },
    { id: '2', title: 'Band on the Run', year: '1973', owned: false, folderPath: 'p/botr' },
  ]
  const partial = base({ artistReleases: { ok: true, artistMbid: 'a', releases: rows, complete: false }, releaseRows: rows })
  const b = bodyOf(html(partial), 'More by Pink Floyd')
  assert.ok(!b.includes('MusicBrainz lists'), 'no total off a list that was cut short')
  assert.ok(b.includes('This artist has more records than I could read in one go. Of the 2 studio albums I did read, vinylhoarder has 1 and you have 1.'))

  // And a browse that finished still counts out loud.
  const whole = base({ artistReleases: { ok: true, artistMbid: 'a', releases: rows, complete: true }, releaseRows: rows })
  assert.ok(bodyOf(html(whole), 'More by Pink Floyd')
    .includes('MusicBrainz lists 2 studio albums for Pink Floyd. vinylhoarder has 1. You have 1.'))
})

test('More by caps the list at ten and says how many it held back', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: String(i), title: 'Album ' + i, year: '19' + (70 + i), owned: false, folderPath: '' }))
  const m = base({ artistReleases: { ok: true, artistMbid: 'a', releases: rows }, releaseRows: rows })
  const body = bodyOf(html(m), 'More by Pink Floyd')
  assert.ok(body.includes('Showing the first 10 of 14.'))
  assert.ok(body.includes('Album 9'))
  assert.ok(!body.includes('Album 10'))
})

test('More by prints the didn\'t-answer sentence rather than an empty list', () => {
  const m = base({ artistReleases: { ok: false, reason: "The lookup didn't answer. Close and reopen the panel to try again." } })
  assert.ok(bodyOf(html(m), 'More by Pink Floyd').includes("The lookup didn't answer."))
})

// ── markReleases ─────────────────────────────────────────────────────────────

test('markReleases finds a release in his library and in the peer\'s', () => {
  const rows = D.markReleases(
    [{ id: '1', title: 'The Dark Side of the Moon', date: '1973-03-01' }, { id: '2', title: 'Animals', date: '1977-01-23' }],
    {
      artist: 'Pink Floyd',
      library: [{ name: 'Dark Side of the Moon', artist: 'Pink Floyd' }],
      peerAlbums: [{ artist: 'Pink Floyd', album: 'Animals', folderPath: 'p/animals' }],
    })
  assert.equal(rows[0].owned, true, 'the leading article must not cost a match')
  assert.equal(rows[0].folderPath, '')
  assert.equal(rows[1].owned, false)
  assert.equal(rows[1].folderPath, 'p/animals')
  assert.equal(rows[1].year, '1977')
})

test('markReleases will not credit another artist\'s album of the same name', () => {
  const rows = D.markReleases([{ id: '1', title: 'Animals', date: '1977' }], {
    artist: 'Pink Floyd',
    library: [{ name: 'Animals', artist: 'Talking Heads' }],
    peerAlbums: [],
  })
  assert.equal(rows[0].owned, false)
})

// ── the lookups open() actually fires ────────────────────────────────────────
// Everything above is model-to-string. This last block runs the real open()
// against a DOM just big enough to hold the panel, because the defect it covers
// is in the WIRING and not in any string: the Discogs lookup had a bare
// .catch(() => {}) and no else for a missing bridge, so its slot stayed at null
// — which this module reads as STILL ASKING — for the life of the panel.

function makeDom() {
  const docListeners = {}
  function El(tag) {
    const kids = new Map()
    return {
      tagName: tag, className: '', innerHTML: '', isConnected: false,
      style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute: () => null,
      addEventListener() {}, removeEventListener() {},
      // One stub per selector, so repaintBody's '.slr-dossier-body' is the same
      // element every time and the test can read what was last written to it.
      querySelector(sel) {
        if (!kids.has(sel)) kids.set(sel, El('div'))
        return kids.get(sel)
      },
      querySelectorAll: () => [],
      remove() { this.isConnected = false },
    }
  }
  const doc = {
    mounted: [],
    body: { appendChild(el) { el.isConnected = true; doc.mounted.push(el); return el } },
    createElement: tag => El(tag),
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn) },
    removeEventListener() {},
  }
  return doc
}

// Run open() with the given bridge, let every promise settle, and hand back the
// panel body as it stands.
async function openPanel(api) {
  const prev = { window: globalThis.window, document: globalThis.document, raf: globalThis.requestAnimationFrame, ls: globalThis.localStorage }
  const doc = makeDom()
  globalThis.document = doc
  globalThis.window = {
    api,
    PapaSlskAlbumView: { findMyCopy: () => null },
    PapaSlskShelves: require('../src/slsk-shelves'),
    PapaSlskCompare: {},
    PapaSlskWander: { norm: s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() },
  }
  globalThis.requestAnimationFrame = () => {}
  globalThis.localStorage = { getItem: () => null, setItem() {} }
  try {
    const panel = D.open({ album, username: 'vinylhoarder', deps: {}, siblings: [] })
    assert.ok(panel && panel.close, 'open() returns a handle')
    // Several turns: each lookup's .then/.catch, and the repaint behind it.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    assert.equal(doc.mounted.length, 1, 'the panel mounted')
    return doc.mounted[0].querySelector('.slr-dossier-body').innerHTML
  } finally {
    globalThis.window = prev.window
    globalThis.document = prev.document
    globalThis.requestAnimationFrame = prev.raf
    globalThis.localStorage = prev.ls
  }
}

test('a Discogs lookup that rejects fills its slot instead of leaving it null', async () => {
  // null means STILL ASKING in this module, so a rejection that writes nothing
  // leaves the panel waiting on a promise that is already dead.
  const api = {
    discogsAlbum: () => Promise.reject(new Error('socket hang up')),
    albumInfo: () => Promise.resolve({ ok: true, found: false }),
    artistReleases: () => Promise.resolve({ ok: true, artistMbid: null, releases: [] }),
    musicbrainzArtistTags: () => Promise.resolve({ ok: true, tags: [] }),
    artistInfo: () => Promise.resolve({ ok: true, bio: '' }),
  }
  const body = await openPanel(api)
  assert.ok(body.includes("The lookup didn't answer."), 'the Discogs slot resolved')
})

test('a missing Discogs bridge fills its slot too', async () => {
  const api = {
    albumInfo: () => Promise.resolve({ ok: true, found: false }),
    artistReleases: () => Promise.resolve({ ok: true, artistMbid: null, releases: [] }),
    musicbrainzArtistTags: () => Promise.resolve({ ok: true, tags: [] }),
    artistInfo: () => Promise.resolve({ ok: true, bio: '' }),
  }
  const body = await openPanel(api)
  assert.ok(body.includes("The lookup didn't answer."))
})
