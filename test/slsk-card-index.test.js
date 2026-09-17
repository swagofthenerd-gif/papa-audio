'use strict'
// Soulseek result cards carry data-gi, an index into the array the cards were
// rendered from -- which is FLAC-partitioned, surround-sorted, filtered, merged
// by album and capped. bindSlskSearchEvents used to rebuild its own array by
// calling _slskGroupByFolder(), which applies none of that. Every click handler
// therefore indexed a different folder, usually from a different peer.
//
// Measured against a live search for "dark side of the moon": 46 of 60 cards
// (77%) would have acted on the wrong folder.
//
// This file used to check that four strings appeared in renderer.js. None of
// them pins the property that matters — emitting `data-gi="${gi + 1}"` in the
// card, or resolving `groups[gi - 1]` in the handler, leaves every one of them
// green while restoring the bug in full. The pipeline and the handler's index
// resolver are now both lifted and run against the same groups, and the
// divergence between the rendered order and the raw grouping is measured here
// rather than asserted about.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const SF = require('../src/slsk-filters')
const SH = require('../src/slsk-shelves')

function cut(from, to, what) {
  const a = src.indexOf(from)
  assert.ok(a > -1, what + ': renderer.js must still contain "' + from.trim() + '"')
  const b = src.indexOf(to, a + from.length)
  assert.ok(b > a, what + ': and it must still be followed by "' + to.trim() + '"')
  return src.slice(a, b)
}

// One folder-group as _slskGroupByFolder builds them.
function group(username, folderName, { flac = true, n = 10, free = true } = {}) {
  const ext = flac ? '.flac' : '.mp3'
  return {
    username, folderName, folder: folderName,
    key: username + '::' + folderName,
    hasFreeSlot: free, queueLength: free ? 0 : 20, uploadSpeed: 1000,
    files: Array.from({ length: n }, (_, i) => ({
      filename: 'music\\' + folderName + '\\' + (i + 1) + ' Track' + ext,
      size: 30000000, isFlac: flac, extension: ext,
    })),
  }
}

// The render pipeline, exactly as renderSoulseekRow runs it: score, sort,
// FLAC-partition, filter, merge, cap, publish.
function runPipeline(rawGroups, { query = 'dark side of the moon', showLimit = 60,
                                  groupByUploader = false } = {}) {
  const code = cut('  const rawGroups = _slskGroupByFolder()',
    '  _slskMergedMode = merged && !!mergedAlbums', 'the render pipeline')
  const names = ['query', '_slskGroupByFolder', 'window', 'slsk', '_slskShowLimit', 'esc',
    '_slskCorrectionChip', 'state']
  return new Function(...names, `
    var _slskRendered = null
    var _slskMergedMode = false
    ${code}
    _slskMergedMode = merged && !!mergedAlbums
    return { rendered: _slskRendered, displayList: displayList, unitList: unitList,
             mergedMode: _slskMergedMode, ordered: ordered }
  `)(
    // _slskGroupByFolder builds a fresh list on every call; the pipeline sorts
    // in place, so hand it a copy and keep the raw order intact for comparison.
    query, () => rawGroups.slice(),
    { PapaSlskFilters: SF, PapaSlskShelves: SH },
    { filter: 'all', sort: 'best', groupByUploader, searched: true, error: null, results: [{}], searching: false },
    showLimit, s => String(s), () => '', { library: [] },
  )
}

// The handler's own index resolver, lifted out of _bindSlskCards.
function indexResolver(groups, mergedMode) {
  const code = cut('  const _slskUnit = (gi) => {', '\n  // Download all files in a card',
    "the handler's index resolver")
  return new Function('groups', '_slskMergedMode', `
    ${code}
    return { unit: _slskUnit, album: _slskAlbumUnit }
  `)(groups, mergedMode)
}

// A realistic search return: lossless copies scattered through a majority of
// transcodes, which is what makes the rendered order differ from the raw one.
function liveish(n = 40) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(group('peer' + i, 'Pink Floyd - Dark Side of the Moon #' + i,
      { flac: i % 4 === 0, n: 9 + (i % 3), free: i % 3 !== 0 }))
  }
  return out
}

// Several genuinely different albums, each shared by several peers — the shape
// that makes the merge produce more than one card.
const ALBUMS = [
  'Pink Floyd - The Dark Side of the Moon (1973) [FLAC]',
  'Radiohead - OK Computer (1997) [FLAC]',
  'Portishead - Dummy (1994) [FLAC]',
  'Massive Attack - Mezzanine (1998) [FLAC]',
  'Boards of Canada - Music Has the Right to Children (1998) [FLAC]',
  'Aphex Twin - Selected Ambient Works 85-92 (1992) [FLAC]',
]
function sharedAlbums(perAlbum = 4) {
  const out = []
  ALBUMS.forEach((name, i) => {
    for (let q = 0; q < perAlbum; q++) {
      out.push(group('peer' + i + '_' + q, name, { flac: q === 0 }))
    }
  })
  return out
}

test('what the handler resolves is the very array the cards were rendered from', () => {
  const raw = liveish()
  const p = runPipeline(raw, { groupByUploader: true })
  assert.ok(p.rendered, '_slskRendered must be published')
  assert.strictEqual(p.rendered, p.displayList,
    'it must be the same array object, not a copy that can drift')

  const r = indexResolver(p.rendered, p.mergedMode)
  for (let gi = 0; gi < p.displayList.length; gi++) {
    assert.strictEqual(r.unit(gi), p.displayList[gi],
      'card ' + gi + ' must resolve to the folder card ' + gi + ' shows')
  }
})

test('a handler that regrouped from scratch would act on the wrong peer', () => {
  // The bug, measured rather than described. If the resolver is ever pointed at
  // a fresh _slskGroupByFolder() again, this is how wrong it gets.
  const raw = liveish()
  const p = runPipeline(raw, { groupByUploader: true })
  const regrouped = indexResolver(raw, p.mergedMode)

  let wrong = 0
  for (let gi = 0; gi < p.displayList.length; gi++) {
    if (regrouped.unit(gi).username !== p.displayList[gi].username) wrong++
  }
  assert.ok(wrong > p.displayList.length / 2,
    'the raw grouping and the rendered order must genuinely differ, or this test proves nothing ' +
    `(only ${wrong} of ${p.displayList.length} differ)`)
})

test('in the mode people actually use, a regroup lands on another album entirely', () => {
  // Merged is the default. The rendered unit is an album built by the merge;
  // a raw folder-group at the same index is a different record by a different
  // artist from a different peer.
  const raw = sharedAlbums()
  const p = runPipeline(raw)
  assert.ok(p.mergedMode, 'merging is the default')
  assert.ok(p.displayList.length >= 4,
    'the fixture must produce several album cards, or this proves nothing (got ' +
    p.displayList.length + ')')

  const regrouped = indexResolver(raw, p.mergedMode)
  let wrong = 0
  for (let gi = 0; gi < p.displayList.length; gi++) {
    if (!p.displayList[gi].sources.includes(regrouped.unit(gi))) wrong++
  }
  assert.ok(wrong >= p.displayList.length - 1,
    'a regroup lands on the wrong album for nearly every card (got ' + wrong + ')')
})

test('lossless is offered first, so card 0 is a lossless copy', () => {
  const raw = liveish()
  const p = runPipeline(raw, { groupByUploader: true })
  assert.ok(p.displayList[0].files.some(f => f.isFlac),
    'FLAC-first is the whole ordering promise')
  const firstMp3 = p.ordered.findIndex(g => !g.files.some(f => f.isFlac))
  const lastFlac = p.ordered.map(g => g.files.some(f => f.isFlac)).lastIndexOf(true)
  assert.ok(lastFlac < firstMp3, 'no transcode may be offered above a lossless copy')
})

test('the cap limits what is shown, and every shown card still resolves', () => {
  const raw = liveish(120)
  const p = runPipeline(raw, { showLimit: 20, groupByUploader: true })
  assert.strictEqual(p.displayList.length, 20)
  const r = indexResolver(p.rendered, p.mergedMode)
  assert.strictEqual(r.unit(19), p.displayList[19])
  assert.strictEqual(r.unit(20), null, 'past the cap there is no card, and no folder')
  assert.strictEqual(r.unit(-1), null)
  assert.strictEqual(r.unit('nonsense'), null, 'a junk index downloads nothing')
})

test('in merged mode a card resolves to the best source of the album it shows', () => {
  // Thirty peers sharing one album render one card. Pressing Download on it
  // must reach into THAT album's sources, not into a neighbouring album's.
  const raw = sharedAlbums()
  const p = runPipeline(raw)
  assert.ok(p.mergedMode, 'merging is the default')
  assert.ok(p.displayList.length < raw.length, 'sources really were merged into albums')
  assert.ok(p.displayList.length >= 4, 'and into more than one, or the check is vacuous')

  const r = indexResolver(p.rendered, p.mergedMode)
  for (let gi = 0; gi < p.displayList.length; gi++) {
    const album = p.displayList[gi]
    const chosen = r.unit(gi)
    assert.ok(chosen, 'card ' + gi + ' resolves to something')
    assert.ok(album.sources.includes(chosen),
      'the chosen source must belong to the album on card ' + gi +
      ' (got ' + chosen.folderName + ' for ' + album.folderName + ')')
    assert.strictEqual(r.album(gi), album, 'and the sources list is that album')
  }
})

test('the card and the handler are wired to the same index, by construction', () => {
  // The two halves of the contract that only the source can state: the cards
  // are mapped off displayList with their own index, and the bind side is
  // handed _slskRendered rather than regrouping.
  const render = cut('function renderSoulseekRow(', '\nfunction _buildSearchVariants(', 'render')
  assert.match(render, /_slskRendered\s*=\s*displayList/,
    'renderSoulseekRow must publish displayList, the array data-gi indexes')
  assert.match(src, /displayList\.map\(\(g, gi\)/, 'cards are indexed off displayList')

  const bind = cut('function bindSlskSearchEvents(', '\nfunction ', 'bind')
  assert.match(bind, /_bindSlskCards\(section, query, _slskRendered\)/,
    'handlers must index the rendered array')
  const cards = cut('function _bindSlskCards(', '\nfunction ', 'cards')
  assert.ok(!/_slskGroupByFolder\(/.test(cards) && !/_slskGroupByFolder\(/.test(bind),
    'a fresh regroup here has no filter, no sort, no merge and no cap — it is the bug')
})
