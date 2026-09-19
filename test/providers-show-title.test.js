'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalize, significantTokens, nameSegments, showTitles, matchesShowTitle,
} = require('../providers/show-title')

// The show that prompted this: every anime indexer answers a plain AND-over-
// words search, so "Monster 01" comes back full of shows that merely contain
// the word. These are real nyaa release names from that search.
const MONSTER = ['Monster', 'MONSTER', "Naoki Urasawa's Monster", 'Monsuta']

const MONSTER_YES = [
  '[sam] Monster (2004) - S01E03 (BD 712p HEVC x265 10-bit AC-3) [Dual-Audio]',
  '[Anime Time] Monster (2004 - 2005) Complete [Dual Audio] [DVD][480p][HEVC 10bit x265][AAC]',
  "Naoki Urasawa's Monster (2004-2005) BD-Remux 1080P ENG",
  "[AnimeRG] Naoki Urasawa's Monster (Complete Anime Series) Monsuta [480p] [Dual-Audio] [HEVC]",
  'Monster (The Complete Anime Series) [DUAL-AUDIO] [480p] [HEVC]',
  '[DVDISO] Monster (2004) complete series- R4 dual-audio',
]

const MONSTER_NO = [
  '[llbx] Monster Strike Deadverse Reloaded - 01 (AMZN.WEB-DL 1080p H.264 DDP2.0) [14FE7FD6].mkv',
  '[SubsPlease] Monogatari Series - Off & Monster Season - 01 (1080p) [196CB8E2].mkv',
  '[Mocha] Akujiki Reijou to Kyouketsu Koushaku (Pass the Monster Meat Milady) - 01 [WEB 1080p x265]',
  '[Noem-light] Monster Musume no Iru Nichijou | Everyday Life with Monster Girls Complete Batch (BD 720p)',
  '[MuGi] Re:Monster Season 1 (BD 1080p HEVC 10-bit FLAC) [Dual Audio] | Re Monster',
  '[INDEX] My Little Monster {Tonari no Kaibutsu-kun} [JP.BD][HI10][1080p][FLAC] (English Subbed)',
  'Monster Strike Season 1 plus 2OVA complete',
  'Pocket Monsters Diamond and Pearl (Complete)',
  '[Erai-raws] S-Rank Monster no -Behemoth- dakedo, Neko to Machigawarete Elf Musume no Pet toshite Kurashitemasu - 01 [1080p]',
]

test('a release naming the show is accepted', () => {
  for (const name of MONSTER_YES) {
    assert.strictEqual(matchesShowTitle(name, MONSTER), true, name)
  }
})

test('a release that merely contains the word is a different show', () => {
  for (const name of MONSTER_NO) {
    assert.strictEqual(matchesShowTitle(name, MONSTER), false, name)
  }
})

test('format, packaging and language words are not part of the name', () => {
  const t = ['Sousou no Frieren']
  assert.strictEqual(matchesShowTitle('[SubsPlease] Sousou no Frieren - 09 (1080p) [AAC2.0].mkv', t), true)
  assert.strictEqual(matchesShowTitle('[Judas] Sousou no Frieren S2 (01-10) [Dual Audio][x265][10bit][Batch]', t), true)
  // Ordinal and season suffixes name the same show; which season a release
  // holds is the episode/pack matcher's question, not this one's.
  assert.strictEqual(matchesShowTitle('[Erai-raws] Sousou no Frieren 2nd Season - 01 [1080p CR WEB-DL]', t), true)
  // A release-version tag and an fps tail are noise, not words.
  assert.strictEqual(matchesShowTitle('[Raze] Sousou no Frieren - 01v2 x265 10bit 1080p 143.8561fps.mkv', t), true)
})

test('an arc or cour subtitle after a spaced dash does not disqualify a release', () => {
  assert.strictEqual(
    matchesShowTitle('[A&C] One Piece Season 01 - East Blue [0001-0061] (DVD) [Multi-Audio-Subs]', ['One Piece']),
    true)
  assert.strictEqual(
    matchesShowTitle('[ShouryuuReppa] BLEACH: Sennen Kessen-hen - Ketsubetsu-tan 01 1080p [AAC]',
      ['BLEACH: Sennen Kessen-hen']),
    true)
})

test('a release group tag is never mistaken for the show name', () => {
  // "Hunter" appears in the group tag and in another show's name; neither is
  // Hunter x Hunter.
  assert.strictEqual(matchesShowTitle('Mamono Hunter Youko OVA 01 [Kingmenu].mkv', ['HUNTER×HUNTER']), false)
  assert.strictEqual(
    matchesShowTitle('[HuangSubs] The Demon Hunter Season 3 01-15 (1080p)', ['HUNTER×HUNTER']),
    false)
})

test('romanisation of long vowels does not decide a match', () => {
  assert.strictEqual(matchesShowTitle('[ASW] Kaijuu 8-gou - 17 [1080p]', ['Kaijū 8-gō']), true)
  assert.strictEqual(matchesShowTitle('[x] Yuusha Party - 01', ['Yūsha Party']), true)
})

test('a release with no name at all is not judged', () => {
  assert.strictEqual(matchesShowTitle('', MONSTER), true)
  assert.strictEqual(matchesShowTitle(null, MONSTER), true)
})

test('a request with no titles filters nothing', () => {
  assert.strictEqual(matchesShowTitle('[x] Anything - 01', []), true)
  assert.strictEqual(matchesShowTitle('[x] Anything - 01', ['']), true)
})

test('nameSegments splits on brackets, parentheses, pipes and a spaced dash', () => {
  assert.deepStrictEqual(
    nameSegments('[Judas] Akujiki Reijou (Pass the Monster Meat) - 01 [1080p].mkv'),
    // The undivided name leads, then each delimited part.
    ['Judas Akujiki Reijou Pass the Monster Meat 01',
     'Judas', 'Akujiki Reijou', 'Pass the Monster Meat', '01', '1080p'])
})

// Scene names have no brackets — the title runs into the metadata on dots —
// so the cut is made at the first word that can only be metadata.
test('a scene name is cut at the year, resolution or SxxEyy', () => {
  assert.deepStrictEqual(nameSegments('Dune.Part.Two.2024.1080p.BluRay.x264-VARYG'),
    ['Dune Part Two', 'Dune Part Two', '2024 1080p BluRay x264 VARYG'])
  assert.strictEqual(matchesShowTitle('Dune.Part.Two.2024.1080p.BluRay.x264-VARYG', ['Dune: Part Two']), true)
  // ...and the release group's name is never read as a word of the title.
  assert.strictEqual(matchesShowTitle('Oppenheimer.2023.1080p.BluRay.DD5.1.x264-GalaxyRG', ['Oppenheimer']), true)
  // A film whose name merely starts the same way is still a different film.
  assert.strictEqual(matchesShowTitle('Monster.House.2006.1080p.BrRip.x264-YIFY', ['Monster']), false)
  assert.strictEqual(matchesShowTitle('Sicario.Day.of.the.Soldado.2018.1080p.AMZN.WEB-DL', ['Sicario']), false)
  assert.strictEqual(matchesShowTitle('The.LEGO.Batman.Movie.2017.1080p.BluRay', ['The Batman']), false)
  assert.strictEqual(
    matchesShowTitle('Blaze and the Monster Machines S07E21 Super Slide 1080p WEB-DL', ['Monster']), false)
})

test('significantTokens drops stopwords, metadata, numbers and markers', () => {
  assert.deepStrictEqual(significantTokens('The Monster (2004) S01E03 1080p BD x265 [ABCD1234]'), ['monster'])
})

test('normalize folds case, punctuation, accents and "&"', () => {
  assert.strictEqual(normalize("Fate/stay night: Heaven's Feel & more"), 'fate stay night heavens feel and more')
})

test('showTitles gathers every name a show goes by, including synonyms', () => {
  const names = showTitles({
    title: 'Monster',
    titles: { romaji: 'MONSTER', english: 'Monster', native: 'モンスター', synonyms: ["Naoki Urasawa's Monster"] },
  })
  assert.ok(names.includes('Monster'))
  assert.ok(names.includes("Naoki Urasawa's Monster"))
  // Deduplicated, and a missing field is simply absent.
  assert.strictEqual(new Set(names).size, names.length)
  assert.deepStrictEqual(showTitles(null), [])
})
