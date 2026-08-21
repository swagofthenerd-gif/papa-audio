const test = require('node:test')
const assert = require('node:assert')
const { detectSurround, groupSurround, isHiRes, isLossless, applyFilterSort } = require('../src/slsk-filters')

const G = (folderName, files = [{ ext: 'flac', isFlac: true }], extra = {}) =>
  ({ folderName, folderPath: folderName, files, ...extra })

test('detects the ways uploaders actually write surround', () => {
  for (const s of ['Pink Floyd - DSOTM [5.1]', 'DSOTM 5_1 mix', 'album 5.1ch',
                   'Wish You Were Here (SACD 5.1)', 'Red - ATMOS Mix',
                   'Aja DVD-Audio 5.1', 'Tubular Bells Quadraphonic']) {
    assert.ok(detectSurround(s), s)
  }
})

test('the most specific label wins', () => {
  assert.equal(detectSurround('Red ATMOS 7.1 mix').label, 'ATMOS')
  assert.equal(detectSurround('album 7.1 surround').label, '7.1')
  assert.equal(detectSurround('album 5.1 multichannel').label, '5.1')
})

test('stereo SACD and DVD-A rips are not mislabelled as surround', () => {
  // The single most common false positive: hi-res stereo discs.
  assert.equal(detectSurround('Wish You Were Here SACD (stereo)'), null)
  assert.equal(detectSurround('Aja DVD-Audio 24-96'), null)
  // ...but they count when multichannel is also stated.
  assert.ok(detectSurround('Aja DVD-Audio multichannel'))
})

test('bare numbers in titles do not trigger a false 5.1', () => {
  for (const s of ['Album 51 Greatest Hits', 'Track 15 1 of 12',
                   'Blink 182 discography', '1971 - Led Zeppelin IV']) {
    assert.equal(detectSurround(s), null, s)
  }
})

test('surround is found in file names, not just the folder', () => {
  const g = G('Some Album', [{ filename: 'CD1\\01 - track (5.1 mix).flac', isFlac: true }])
  assert.equal(groupSurround(g).label, '5.1')
})

test('hi-res and lossless detection', () => {
  assert.ok(isHiRes(G('a', [{ bitDepth: 24, sampleRate: 44100 }])))
  assert.ok(isHiRes(G('a', [{ bitDepth: 16, sampleRate: 96000 }])))
  assert.ok(!isHiRes(G('a', [{ bitDepth: 16, sampleRate: 44100 }])))
  assert.ok(isLossless(G('a', [{ isFlac: true }])))
  assert.ok(!isLossless(G('a', [{ isFlac: false }])))
})

test('the surround filter keeps only surround folders', () => {
  const groups = [G('DSOTM 5.1'), G('DSOTM stereo'), G('Red ATMOS')]
  const out = applyFilterSort(groups, { filter: 'surround' })
  assert.deepEqual(out.map(g => g.folderName), ['DSOTM 5.1', 'Red ATMOS'])
})

test('relevance preserves the caller ordering', () => {
  const groups = [G('b'), G('a'), G('c')]
  assert.deepEqual(applyFilterSort(groups, { sort: 'relevance' }).map(g => g.folderName), ['b', 'a', 'c'])
})

test('sorts put the best first', () => {
  const lo = G('lo', [{ sampleRate: 44100, bitDepth: 16 }], { uploadSpeed: 10 })
  const hi = G('hi', [{ sampleRate: 192000, bitDepth: 24 }], { uploadSpeed: 999 })
  assert.equal(applyFilterSort([lo, hi], { sort: 'sampleRate' })[0].folderName, 'hi')
  assert.equal(applyFilterSort([lo, hi], { sort: 'bitDepth' })[0].folderName, 'hi')
  assert.equal(applyFilterSort([lo, hi], { sort: 'speed' })[0].folderName, 'hi')
  assert.equal(applyFilterSort([G('one', [{}]), G('many', [{}, {}, {}])], { sort: 'tracks' })[0].folderName, 'many')
})

test('filter and sort combine, and unknown names fall back safely', () => {
  const groups = [G('x 5.1', [{ sampleRate: 44100 }]), G('y 5.1', [{ sampleRate: 96000 }]), G('z stereo')]
  assert.deepEqual(applyFilterSort(groups, { filter: 'surround', sort: 'sampleRate' }).map(g => g.folderName),
    ['y 5.1', 'x 5.1'])
  assert.equal(applyFilterSort(groups, { filter: 'nope', sort: 'nope' }).length, 3)
})

test('the module is wired into the renderer', () => {
  const fs = require('fs'), path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/slsk-filters.js'), 'utf8')
  assert.ok(src.includes('window.PapaSlskFilters'), 'renderer cannot require(), needs the global')
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')
  assert.ok(html.indexOf('slsk-filters.js') < html.indexOf('renderer.js'),
    'slsk-filters.js must load before renderer.js')
  const r = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  assert.ok(r.includes('data-slsk-filter'), 'filter chips must be rendered')
  assert.ok(r.includes("id=\"slsk-sort\""), 'sort control must be rendered')
  assert.ok(r.includes('_rerenderSlskSection'), 'filter/sort must re-render, not re-search')
})

test('real-world folder names from the tracker listings', () => {
  const cases = [
    ['Pink Floyd - The Dark Side Of The Moon (2003) [Flac 24-88 SACD 5.1]', '5.1'],
    ['King Crimson - Red - ATMOS Mix', 'ATMOS'],
    ['Eagles - One Of These Nights [Dolby Atmos] (16_48)', 'ATMOS'],
    ['Pink Floyd - Wish You Were Here - 1975, DSD 128 (tracks)', null],
    ['Pink Floyd - Collection (6 albums) MB DSD128', null],
  ]
  for (const [name, want] of cases) {
    const got = detectSurround(name)
    assert.equal(got ? got.label : null, want, name)
  }
})

test('the surround detector is shared with YouTube search', () => {
  const fs = require('fs'), path = require('path')
  const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  assert.ok(R('src/slsk-filters.js').includes('window.PapaSurround'),
    'detector must be exposed for the YouTube renderer')
  const r = R('src/renderer.js')
  assert.ok(r.includes('_ytSurroundBadge'), 'YouTube rows need the badge')
  assert.ok(r.includes('yt-surround-toggle'), 'YouTube needs the surround-only toggle')
  assert.ok(r.includes('data-surround'), 'rows need the marker the filter hides on')
  assert.ok(R('src/styles.css').includes('#yt-results.surround-only'),
    'the filter needs its CSS rule')
})

test('YouTube-style titles are classified correctly', () => {
  const cases = [
    ['Official Dolby 5.1 Speaker Test Demo [True YouTube 5.1 Surround Sound]', '5.1'],
    ['Pink Floyd - Time (Dolby Atmos Mix)', 'ATMOS'],
    ['Hotel California - 7.1 surround', '7.1'],
    ['Top 51 Guitar Solos of All Time', null],
    ['Blink 182 - All The Small Things', null],
    ['Bohemian Rhapsody (Official Video)', null],
  ]
  for (const [title, want] of cases) {
    const got = detectSurround(title)
    assert.equal(got ? got.label : null, want, title)
  }
})

test('surround-targeted queries widen the net', () => {
  const { surroundQueries } = require('../src/slsk-filters')
  const q = surroundQueries('dark side of the moon')
  assert.ok(q.length >= 3)
  assert.ok(q.every(x => x.startsWith('dark side of the moon ')))
  assert.ok(q.some(x => /5\.1/.test(x)))
  assert.ok(q.some(x => /sacd/i.test(x)))
})

test('a term the user already typed is not asked for twice', () => {
  const { surroundQueries } = require('../src/slsk-filters')
  assert.ok(!surroundQueries('dsotm 5.1').some(x => x.endsWith(' 5.1')))
  assert.ok(!surroundQueries('red atmos mix').some(x => /atmos$/i.test(x)))
})

test('junk input yields no queries', () => {
  const { surroundQueries } = require('../src/slsk-filters')
  assert.deepEqual(surroundQueries(''), [])
  assert.deepEqual(surroundQueries('a'), [])
  assert.deepEqual(surroundQueries(null), [])
})

test('surround discovery is wired into search and the explorer', () => {
  const fs = require('fs'), path = require('path')
  const r = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  assert.ok(r.includes('renderSurroundFolders'), 'explorer needs the surround scan')
  assert.ok(r.includes('slskx-surround'), 'explorer needs the 5.1-only button')
})
