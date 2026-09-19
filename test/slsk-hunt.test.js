const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/slsk-hunt')

const mk = (o) => ({ artist: 'A', album: 'X', year: 1975, folderPath: 'A\\X', trackCount: 5, totalSize: 1e9,
  lossless: true, isHiRes: true, maxBitDepth: 24, maxSampleRate: 96000, surround: false, files: [], ...o })
const lib = [{ id: 'l1', name: 'X', artist: 'A', tracks: [{ bitsPerSample: 16, sampleRate: 44100 }] }]

test('an upgrade row says how many tracks are better and what yours is', () => {
  const shelves = { upgrades: [{ ...mk(), upgrade: { kind: 'bitdepth', yours: 'FLAC 16/44', theirs: 'FLAC 24/96', better: 4, of: 5 }, matchedLibId: 'l1' }],
    missing: [], surround: [], hires: [], everything: [mk()], stats: {} }
  const rows = H.buildRows(shelves, lib)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdictKind, 'upgrade')
  assert.equal(rows[0].verdictText, 'upgrade · 4/5 tracks')
  assert.equal(rows[0].yours, 'FLAC 16/44')
  assert.equal(rows[0].tier, 'hires')
})

test('surround you lack beats a plain upgrade in the words', () => {
  const a = { ...mk({ surround: true }), upgrade: { kind: 'surround', yours: 'FLAC 16/44 stereo', theirs: 'FLAC 24/96 5.1' }, matchedLibId: 'l1' }
  const rows = H.buildRows({ upgrades: [a], missing: [], surround: [a], hires: [], everything: [a], stats: {} }, lib)
  assert.equal(rows[0].verdictText, 'surround you lack')
  assert.equal(rows[0].tier, 'surround')
})

test('missing rows say not in library; matched non-upgrades say same or yours is better', () => {
  const missing = mk({ album: 'Y' })
  const same = mk({ album: 'X', maxBitDepth: 16, maxSampleRate: 44100, isHiRes: false })
  const worse = mk({ album: 'X', lossless: false, isHiRes: false, maxBitDepth: 0, maxSampleRate: 44100, topExt: 'mp3' })
  const rows = H.buildRows({ upgrades: [], missing: [missing], surround: [], hires: [], everything: [missing, same, worse], stats: {} }, lib)
  const byT = Object.fromEntries(rows.map(r => [r.album.album + r.album.lossless, r.verdictText]))
  assert.equal(byT['Ytrue'], 'not in library')
  assert.equal(byT['Xtrue'], 'same as yours')
  assert.equal(byT['Xfalse'], 'yours is better')
})

test('sortRows by verdict puts upgrades first, then missing, then the rest', () => {
  const rows = [{ verdictKind: 'same', title: 'a' }, { verdictKind: 'upgrade', title: 'b' }, { verdictKind: 'missing', title: 'c' }]
  assert.deepEqual(H.sortRows(rows, 'verdict', 'asc').map(r => r.title), ['b', 'c', 'a'])
})

test('filterRows matches artist or title, case-insensitively', () => {
  const rows = [{ title: 'Wish You Were Here', artist: 'Pink Floyd' }, { title: 'Aja', artist: 'Steely Dan' }]
  assert.equal(H.filterRows(rows, 'floyd').length, 1)
  assert.equal(H.filterRows(rows, '').length, 2)
})

test('tiles carry the four counts', () => {
  const t = H.tiles({ upgrades: [1, 2], missing: [1], surround: [], hires: [] }, 3)
  assert.deepEqual(t.map(x => [x.id, x.n]), [['upgrades', 2], ['missing', 1], ['surround', 0], ['new', 3]])
})
