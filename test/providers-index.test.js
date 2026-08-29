'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  qualityRank,
  isMultichannel,
  rankStreams,
  resolveStream,
} = require('../providers/index')

function entry(overrides) {
  return Object.assign(
    {
      kind: 'http',
      url: null,
      magnet: null,
      infoHash: null,
      fileIndex: null,
      source: 'test',
      quality: null,
      label: null,
      audioLayout: null,
      sub: null,
      dub: null,
    },
    overrides
  )
}

test('qualityRank maps quality strings to numbers', () => {
  assert.strictEqual(qualityRank('2160p'), 4)
  assert.strictEqual(qualityRank('1080p'), 3)
  assert.strictEqual(qualityRank('720p'), 2)
  assert.strictEqual(qualityRank('480p'), 1)
  assert.strictEqual(qualityRank('360p'), 0)
  assert.strictEqual(qualityRank(null), 0)
  assert.strictEqual(qualityRank(undefined), 0)
})

test('isMultichannel is true only for 5.1', () => {
  assert.strictEqual(isMultichannel('5.1'), true)
  assert.strictEqual(isMultichannel('2.0'), false)
  assert.strictEqual(isMultichannel(null), false)
  assert.strictEqual(isMultichannel(undefined), false)
})

test('rankStreams: surround-aware 1080p 5.1 beats 2160p stereo when preferSurround', () => {
  const a = entry({ quality: '1080p', audioLayout: '5.1', source: 'a' })
  const b = entry({ quality: '2160p', audioLayout: null, source: 'b' })
  const ranked = rankStreams([b, a], { preferSurround: true })
  assert.strictEqual(ranked[0], a)
  assert.strictEqual(ranked[1], b)
})

test('rankStreams: 2160p beats 1080p 5.1 when preferSurround is false', () => {
  const a = entry({ quality: '1080p', audioLayout: '5.1', source: 'a' })
  const b = entry({ quality: '2160p', audioLayout: null, source: 'b' })
  const ranked = rankStreams([a, b], { preferSurround: false })
  assert.strictEqual(ranked[0], b)
  assert.strictEqual(ranked[1], a)
})

test('rankStreams: same quality, 5.1 above stereo', () => {
  const stereo = entry({ quality: '1080p', audioLayout: '2.0', source: 's' })
  const surround = entry({ quality: '1080p', audioLayout: '5.1', source: 'x' })
  const ranked = rankStreams([stereo, surround])
  assert.strictEqual(ranked[0], surround)
  assert.strictEqual(ranked[1], stereo)
})

test('rankStreams sorts by score, then multichannel, then quality, then source', () => {
  const e1 = entry({ quality: '720p', audioLayout: null, source: 'c' })
  const e2 = entry({ quality: '720p', audioLayout: '5.1', source: 'b' })
  const e3 = entry({ quality: '1080p', audioLayout: null, source: 'a' })
  const e4 = entry({ quality: '1080p', audioLayout: '5.1', source: 'a' })
  const ranked = rankStreams([e1, e2, e3, e4])
  // e4 (1080 5.1, score 4) > e2 (720 5.1, score 3, multichannel) >
  // e3 (1080, score 3, stereo) > e1 (720, score 2)
  assert.deepStrictEqual(
    ranked.map(r => r.source + r.quality + (r.audioLayout || '')),
    ['a1080p5.1', 'b720p5.1', 'a1080p', 'c720p']
  )
})

test('rankStreams does not mutate the input array', () => {
  const input = [
    entry({ quality: '480p', audioLayout: null, source: 'x' }),
    entry({ quality: '1080p', audioLayout: '5.1', source: 'y' }),
  ]
  const snapshot = input.slice()
  rankStreams(input)
  assert.deepStrictEqual(input, snapshot)
})

test('resolveStream returns fulfilled results and skips rejected backends', async () => {
  const entryA = entry({ quality: '1080p', source: 'backend-a' })
  const backends = [
    async () => [entryA],
    async () => {
      throw new Error('backend down')
    },
  ]
  const result = await resolveStream({ type: 'movie', title: 'Inception' }, backends)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0], entryA)
})

test('resolveStream de-duplicates identical (kind, url) across backends', async () => {
  const shared = entry({ quality: '1080p', url: 'https://cdn/x.mp4', source: 'dup' })
  const backends = [
    async () => [shared],
    async () => [{ ...shared }],
  ]
  const result = await resolveStream({ type: 'movie' }, backends)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0], shared)
})

test('resolveStream de-duplicates by magnet when url is absent', async () => {
  const torrent = entry({
    kind: 'torrent',
    url: null,
    magnet: 'magnet:?xt=urn:btih:AAA',
    source: 'dup',
  })
  const backends = [
    async () => [torrent],
    async () => [{ ...torrent }],
  ]
  const result = await resolveStream({ type: 'movie' }, backends)
  assert.strictEqual(result.length, 1)
})

test('resolveStream ranks results after flattening', async () => {
  const low = entry({ quality: '720p', audioLayout: null, source: 'a', url: 'https://cdn/low.mp4' })
  const high = entry({ quality: '1080p', audioLayout: '5.1', source: 'b', url: 'https://cdn/high.mp4' })
  const backends = [
    async () => [low],
    async () => [high],
  ]
  const result = await resolveStream({ type: 'movie' }, backends)
  assert.strictEqual(result[0], high)
  assert.strictEqual(result[1], low)
})
