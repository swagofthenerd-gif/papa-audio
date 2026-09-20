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
  // The tail no longer says "verified": that is the wrong word above a warning,
  // and it is now printed whether or not a channel read came back.
  assert.ok(html.includes('checked one track of 1 (04.flac)'))
  assert.ok(!html.includes('verified from'))
})

// A twelve-track stereo album, so the {tracks} slot the handler leaves in the
// sentence has something real to resolve to.
const album12 = { ...album, trackCount: 12,
  files: Array.from({ length: 12 }, (_, i) => ({ name: String(i + 1).padStart(2, '0') + ' Track.flac', size: 3e7, length: 210 })) }

test('sectionsHtml prints the channel fact first in the grey run', () => {
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 24/96' }, ceilingHz: 22000,
    measuredBits: 24, channels: 6, track: '04.flac', at: Date.now(),
    channelCheck: { kind: 'surround', severity: 'good', channels: 6, fact: '6 channels (5.1)', claim: '5.1',
      text: 'All 6 channels carry sound — nothing is padded with silence. I only checked one track of {tracks}.' } }
  const html = D.sectionsHtml({ ...D.model(album12, 'u', null), rip }, s => s)
  const run = html.slice(html.indexOf('6 channels (5.1)'))
  assert.ok(html.includes('6 channels (5.1) · reaches 22 kHz'), 'channel fact leads, ceiling follows')
  assert.ok(run.indexOf('24 bits used') > 0, 'the rest of the run follows the channel fact')
  // Three or more channels means volumedetect summed them, so the ceiling
  // fragment must not read as a per-channel figure.
  assert.ok(html.includes('22 kHz (all channels together)'))
  // The good-severity sentence is a second line, not part of the ' · ' tail.
  assert.ok(html.includes('<span class="slr-rip-chan">All 6 channels carry sound'))
  assert.ok(html.includes('I only checked one track of 12.'), '{tracks} resolved')
  assert.ok(!html.includes('{tracks}'))
})

test('a warn severity promotes the channel sentence to the bold line', () => {
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 16/44' }, ceilingHz: 22000,
    channels: 2, track: '04.flac', at: Date.now(),
    channelCheck: { kind: 'claim-mismatch', severity: 'warn', channels: 2, fact: 'stereo', claim: '5.1',
      text: 'Listed as 5.1, but the track I checked is plain stereo — 2 channels, not 6. I only checked one track of {tracks}.' } }
  const html = D.sectionsHtml({ ...D.model(album12, 'u', null), rip }, s => s)
  assert.ok(html.includes('<b class="slr-rip-verdict">⚠ Listed as 5.1, but the track I checked is plain stereo'))
  assert.ok(html.includes('slr-rip slr-rip-chan-warn'))
  // The bit-depth verdict must never repaint a contradicted line green.
  assert.ok(!html.includes('slr-rip-genuine'))
  // It is demoted, not deleted.
  assert.ok(html.includes('genuine 16/44'))
  // And the contradiction is repeated as a pill beside the Download button.
  assert.ok(html.includes('<span class="slr-pill slr-pill-warn">listed 5.1 · checked track is stereo</span>'))
})

test('a padded-channels warning names the silence, not the claim', () => {
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 24/48' }, channels: 6, track: '04.flac', at: Date.now(),
    channelCheck: { kind: 'padded-channels', severity: 'warn', channels: 6, fact: '6 channels (5.1)', claim: null,
      text: '6 channels, but 4 of them are completely silent for the whole track. That is what a stereo file padded out to 5.1 looks like. I only checked one track of {tracks}.' } }
  const html = D.sectionsHtml({ ...D.model(album12, 'u', null), rip }, s => s)
  assert.ok(html.includes('<span class="slr-pill slr-pill-warn">surround channels are silent</span>'))
  assert.ok(!html.includes('listed'))
})

test('a cached verdict with no channelCheck invents no channel answer', () => {
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 24/96' }, ceilingHz: 46000, track: '04.flac', at: Date.now() }
  const html = D.sectionsHtml({ ...D.model(album12, 'u', null), rip }, s => s)
  assert.ok(!html.includes('stereo'), 'no truthy default')
  assert.ok(!html.includes('channels'))
  assert.ok(!html.includes('slr-rip-chan'))
  assert.ok(!html.includes('slr-pill-warn'))
  // Instead it offers a re-check, or the feature would not exist for the up to
  // 30 days of verdicts already in localStorage.
  assert.ok(html.includes('data-act="verify">Check again</button>'))
})

test('the idle helper says what the check actually answers', () => {
  const html = D.sectionsHtml(D.model(album, 'u', null), s => s)
  assert.ok(html.includes('Downloads one track, measures it, deletes it.'))
  assert.ok(html.includes("whether it's really surround"))
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

// A real escaper — matching the default shipped in slsk-album-view.js and
// open()'s own fallback. Every other test above passes `s => s`, which
// proves nothing about escaping; this one actually escapes.
function realEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

test('sectionsHtml escapes a hostile folder/album/artist name', () => {
  const payload = '<img src=x onerror=1>'
  const evilAlbum = { ...album, folderName: payload, album: payload, artist: payload }
  const m = D.model(evilAlbum, 'u', null)
  const html = D.sectionsHtml(m, realEsc)
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'))
})

// Every string in the rip block came from a stranger's machine: the file name
// is theirs, and the channel fragment is built from the layout name ffprobe
// read out of their file.
test('sectionsHtml escapes a hostile track name and channel fragment', () => {
  const payload = '<img src=x onerror=1>'
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 24/48' }, channels: 6, track: payload, at: Date.now(),
    channelCheck: { kind: 'claim-short', severity: 'warn', channels: 6, fact: payload, claim: '7.1', text: payload } }
  const html = D.sectionsHtml({ ...D.model(album12, 'u', null), rip }, realEsc)
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'))
  // The unlisted warn kinds fall back to the fragment the check already built,
  // rather than inventing a sentence for the pill.
  assert.ok(html.includes('slr-pill-warn">listed 7.1 · &lt;img'))
})
