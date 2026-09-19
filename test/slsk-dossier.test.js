const test = require('node:test')
const assert = require('node:assert')
const D = require('../src/slsk-dossier')

const album = { artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975, folderName: 'Pink Floyd - 1975 - Wish You Were Here [2016 Remaster] [24-96]',
  folderPath: 'Music\\Pink Floyd\\WYWH', lossless: true, isHiRes: true, maxBitDepth: 24, maxSampleRate: 96000, totalSize: 1.1e9, trackCount: 5,
  files: [{ name: '01 Shine On.flac', size: 4.6e8, bitDepth: 24, sampleRate: 96000, length: 810 }, { name: 'cover.jpg', size: 1e5 },
    { name: 'rip.log', size: 1e3 }, { name: 'album.cue', size: 1e3 }] }

test('model reads edition note, extras, length and tier', () => {
  const m = D.model(album, 'vinylhoarder', null)
  assert.equal(m.editionNote, '2016 Remaster')
  assert.deepEqual(m.extras, { log: true, cue: true, art: true })
  assert.equal(m.length, '13:30')
  assert.equal(m.tier, 'hires')
  assert.equal(m.tracks.length, 1)
})

test('sectionsHtml shows the Discogs prompt when there is no token', () => {
  const html = D.sectionsHtml({ ...D.model(album, 'u', null), reception: { ok: false, reason: 'no-token' } }, s => s)
  assert.ok(html.includes('Add a Discogs token in Settings'))
})

test('sectionsHtml renders a rip verdict and the measured facts', () => {
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 24/96' }, ceilingHz: 46000, dynamicRange: 13.4, track: '04.flac', at: Date.now() - 120000 }
  const html = D.sectionsHtml({ ...D.model(album, 'u', null), rip }, s => s)
  assert.ok(html.includes('genuine 24/96'))
  assert.ok(html.includes('46 kHz'))
  assert.ok(html.includes('verified from 04.flac'))
})

test('sectionsHtml lists sibling albums as chips', () => {
  const html = D.sectionsHtml({ ...D.model(album, 'u', null), siblings: [{ album: 'Animals', folderPath: 'p' }] }, s => s)
  assert.ok(html.includes('data-sibling="p"'))
  assert.ok(html.includes('Animals'))
})

test('sectionsHtml never prints a missing dynamic range as a number', () => {
  const base = D.model(album, 'u', null)
  const rip = { ok: true, verdict: { kind: 'upscaled', text: 'upscaled from 16/44' }, ceilingHz: 22000, track: '02.flac', at: Date.now() }
  const html = D.sectionsHtml({ ...base, rip }, s => s)
  assert.ok(!html.includes('dynamic range'))
  assert.ok(html.includes('upscaled from 16/44'))
})
