const test = require('node:test')
const assert = require('node:assert')
const { planSpread, planPeers, trackNumber, trackKey, sizeCompatible } = require('../src/download-spread')

// A 5.1 FLAC track is roughly 3x its stereo counterpart.
const SUR = 90_000_000, STEREO = 30_000_000

const G = (username, files, extra = {}) => ({
  username, folderPath: username + '\\album', uploadSpeed: 100, freeUploadSlots: 1,
  files: files.map(f => ({ isFlac: true, ...f })), ...extra,
})
const album = (size, n = 4) =>
  Array.from({ length: n }, (_, i) => ({ filename: `0${i + 1} - Track.flac`, size }))

test('track numbers and keys survive different naming styles', () => {
  assert.equal(trackNumber('01 - Time.flac'), 1)
  assert.equal(trackNumber('Pink Floyd - Time.flac'), null)
  assert.equal(trackKey('01. Time.flac'), trackKey('01 - Time.flac'))
})

test('one album from many peers is spread across them', () => {
  const groups = ['ann', 'bob', 'cid', 'dee'].map(u => G(u, album(SUR)))
  const plan = planSpread(groups, { anchor: groups[0], maxPerUser: 1 })
  assert.equal(plan.length, 4, 'every track planned once')
  assert.equal(planPeers(plan), 4, 'one track per peer')
})

test('maxPerUser caps how much any single peer is asked for', () => {
  const groups = ['ann', 'bob'].map(u => G(u, album(SUR, 6)))
  const plan = planSpread(groups, { anchor: groups[0], maxPerUser: 3 })
  const per = {}
  for (const p of plan) per[p.username] = (per[p.username] || 0) + 1
  assert.deepEqual(Object.values(per).sort(), [3, 3])
})

test('a stereo copy never completes a 5.1 download', () => {
  // The key case: the surround release is the anchor, another peer has stereo.
  const surround = G('surr', album(SUR))
  const stereo   = G('ster', album(STEREO))
  const plan = planSpread([surround, stereo], { anchor: surround, maxPerUser: 1 })
  assert.equal(plan.length, 4)
  assert.ok(plan.every(p => p.username === 'surr'),
    'must not mix a stereo rip into a surround album')
})

test('a genuine second copy of the same release IS used', () => {
  const a = G('ann', album(SUR))
  const b = G('bob', album(SUR * 1.05))   // same release, trivial size variation
  const plan = planSpread([a, b], { anchor: a, maxPerUser: 1 })
  assert.equal(planPeers(plan), 2, 'similar sizes mean the same release')
})

test('size tolerance rejects a lossy stand-in', () => {
  assert.ok(sizeCompatible(SUR, SUR * 0.9, 0.25))
  assert.ok(!sizeCompatible(SUR, STEREO, 0.25))
  assert.ok(!sizeCompatible(SUR, 5_000_000, 0.25))
})

test('peers with a free slot are preferred over merely fast ones', () => {
  const busyFast = G('fast', album(SUR), { uploadSpeed: 9999, freeUploadSlots: 0 })
  const freeSlow = G('free', album(SUR), { uploadSpeed: 1,    freeUploadSlots: 3 })
  const plan = planSpread([busyFast, freeSlow], { anchor: busyFast, maxPerUser: 99 })
  assert.ok(plan.some(p => p.username === 'free'), 'a peer with an open slot must get work')
})

test('tracks are planned in order so a partial download is still playable', () => {
  const g = G('ann', [
    { filename: '03 - Three.flac', size: SUR },
    { filename: '01 - One.flac',   size: SUR },
    { filename: '02 - Two.flac',   size: SUR },
  ])
  assert.deepEqual(planSpread([g], { anchor: g }).map(p => p.key), ['n1', 'n2', 'n3'])
})

test('non-audio files are never queued', () => {
  const g = G('ann', [
    { filename: '01 - One.flac', size: SUR },
    { filename: 'cover.jpg', size: 90000 },
    { filename: 'info.nfo', size: 900 },
  ])
  assert.deepEqual(planSpread([g], { anchor: g }).map(p => p.filename), ['01 - One.flac'])
})

test('lossless is preferred when both are offered at a sane size', () => {
  const g = G('ann', [
    { filename: '01 - One.mp3',  size: SUR, isFlac: false },
    { filename: '01 - One.flac', size: SUR, isFlac: true },
  ])
  assert.ok(planSpread([g], { anchor: g })[0].filename.endsWith('.flac'))
})

test('empty input does not throw', () => {
  assert.deepEqual(planSpread([], {}), [])
  assert.deepEqual(planSpread(null, {}), [])
})

test('the planner is wired into the download button', () => {
  const fs = require('fs'), path = require('path')
  const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  const html = R('src/index.html')
  assert.ok(html.indexOf('download-spread.js') < html.indexOf('renderer.js'),
    'download-spread.js must load before renderer.js')
  assert.ok(R('src/download-spread.js').includes('window.PapaSpread'),
    'renderer cannot require(), needs the global')
  const r = R('src/renderer.js')
  assert.ok(r.includes('planSpread'), 'download-all must use the planner')
  assert.ok(r.includes('anchor: g'), 'the chosen folder must anchor the release')
})
