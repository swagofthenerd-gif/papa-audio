'use strict'
// Upgrade-duplicate detection — the module that decides when one copy of a song
// genuinely supersedes another, so his real library at /mnt/data/MUSIC is never
// the thing being experimented on.
//
// Every test here REQUIRES and EXECUTES src/upgrade-dupes.js. Nothing reads the
// source as text except the one explicit no-filesystem guard at the bottom,
// which is guarding a property source text is the right place to check.

const test = require('node:test')
const assert = require('node:assert')
const UD = require('../src/upgrade-dupes')

// ── Fixture helpers ──────────────────────────────────────────────────────────
// Real-shaped library rows: the exact fields main.js puts on a track
// (codec, bitsPerSample, sampleRate, bitrate, fileSize, channels, duration).

let _n = 0
function track(over) {
  _n++
  const base = {
    id: 't' + _n,
    title: 'Song',
    artist: 'Band',
    albumArtist: 'Band',
    album: 'Album',
    trackNumber: 3,
    discNumber: 1,
    duration: 225,
    channels: 2,
    atmos: false,
    filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.flac',
  }
  return Object.assign(base, over)
}

function flac(over = {}) {
  return track(Object.assign({
    codec: 'flac', bitsPerSample: 16, sampleRate: 44100,
    bitrate: 900000, fileSize: 25e6,
    filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.flac',
  }, over))
}

function flacHiRes(over = {}) {
  return flac(Object.assign({
    bitsPerSample: 24, sampleRate: 96000, bitrate: 3000000, fileSize: 90e6,
    filePath: '/mnt/data/MUSIC/Band/Album 24-96/03 - Song.flac',
  }, over))
}

function mp3(over = {}) {
  return track(Object.assign({
    codec: 'mp3', bitsPerSample: 0, sampleRate: 44100,
    bitrate: 320000, codecProfile: 'CBR', fileSize: 9e6,
    filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.mp3',
  }, over))
}

// Deep-freeze so any mutation of the caller's library throws in strict mode.
function freeze(list) {
  for (const t of list) Object.freeze(t)
  return Object.freeze(list)
}

function run(tracks, opts) {
  return UD.findSupersededCopies(freeze(tracks), opts)
}

function removedPaths(res) {
  return res.plan.map(p => p.remove.filePath)
}

// ── 1. The case he actually hit ──────────────────────────────────────────────

test('the FLAC upgrade supersedes the MP3 sitting next to it in the same album', () => {
  const old = mp3({ id: 'old' })
  const better = flac({ id: 'new', filePath: '/mnt/data/MUSIC/Downloads/Band - Album/03 - Song.flac' })
  const res = run([old, better])

  assert.equal(res.plan.length, 1, 'exactly one copy is superseded')
  assert.equal(res.plan[0].remove.id, 'old')
  assert.equal(res.plan[0].keeper.id, 'new')
  assert.match(res.plan[0].reason, /FLAC 16-bit\/44\.1 kHz supersedes MP3 320 kbps/)
  assert.match(res.plan[0].reason, /lossless replaces lossy/)
  assert.equal(res.ambiguous.length, 0)
  assert.equal(res.stats.bytesReclaimable, 9e6)
})

test('same song at FLAC 16/44 and FLAC 24/96 — the hi-res copy wins on bit depth', () => {
  const cd = flac({ id: 'cd' })
  const hi = flacHiRes({ id: 'hi' })
  const res = run([cd, hi])

  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'cd')
  assert.equal(res.plan[0].keeper.id, 'hi')
  assert.match(res.plan[0].reason,
    /FLAC 24-bit\/96 kHz supersedes FLAC 16-bit\/44\.1 kHz — same lossless codec, higher bit depth and sample rate\./)
})

test('bit depth alone decides, and outranks file size', () => {
  // Same sample rate and no bitrate on either side, so ONLY the bit-depth rule
  // can pick the keeper — and the 16-bit copy is the bigger file, so a ranking
  // that fell back to size would pick the wrong one.
  const deep = flac({ id: 'deep', bitsPerSample: 24, sampleRate: 44100,
    bitrate: null, fileSize: 30e6,
    filePath: '/mnt/data/MUSIC/Band/Album 24-44/03 - Song.flac' })
  const shallow = flac({ id: 'shallow', bitsPerSample: 16, sampleRate: 44100,
    bitrate: null, fileSize: 33e6 })

  assert.ok(UD.compareQuality(deep, shallow) < 0, 'bit depth outranks file size')
  const res = run([shallow, deep])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'shallow')
  assert.equal(res.plan[0].keeper.id, 'deep')
  assert.match(res.plan[0].reason,
    /FLAC 24-bit\/44\.1 kHz supersedes FLAC 16-bit\/44\.1 kHz — same lossless codec, higher bit depth\./)
})

test('sample rate alone decides when the bit depth is equal', () => {
  const fast = flac({ id: 'fast', bitsPerSample: 16, sampleRate: 96000,
    bitrate: null, fileSize: 30e6,
    filePath: '/mnt/data/MUSIC/Band/Album 16-96/03 - Song.flac' })
  const slow = flac({ id: 'slow', bitsPerSample: 16, sampleRate: 44100,
    bitrate: null, fileSize: 33e6 })
  const res = run([slow, fast])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'slow')
  assert.match(res.plan[0].reason, /same lossless codec, higher sample rate\./)
})

test('FLAC 24/96 over MP3 320 reads exactly the way the UI needs it to', () => {
  const res = run([mp3({ id: 'lossy' }), flacHiRes({ id: 'hires' })])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].reason,
    'FLAC 24-bit/96 kHz supersedes MP3 320 kbps — lossless replaces lossy.')
})

test('three copies collapse onto one keeper, each with its own reason', () => {
  const res = run([mp3({ id: 'm' }), flac({ id: 'cd' }), flacHiRes({ id: 'hi' })])
  assert.equal(res.plan.length, 2)
  assert.deepEqual(res.plan.map(p => p.remove.id).sort(), ['cd', 'm'])
  for (const item of res.plan) assert.equal(item.keeper.id, 'hi')
  assert.equal(res.groups.length, 1)
  assert.equal(res.groups[0].superseded.length, 2)
})

// ── 2. Tagging differences must not hide a duplicate ─────────────────────────

test('case, punctuation and apostrophes fold together', () => {
  const a = mp3({ id: 'a', title: "Don't Stop Me Now!", album: 'A Night At The Opera' })
  const b = flac({ id: 'b', title: 'dont stop me now', album: 'a night at the opera' })
  const res = run([a, b])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'a')
})

test('"feat." spellings do not split a duplicate apart', () => {
  const a = mp3({ id: 'a', title: 'Song (feat. Drake)' })
  const b = flac({ id: 'b', title: 'Song feat. Drake' })
  const c = flacHiRes({ id: 'c', title: 'Song' })
  const res = run([a, b, c])
  assert.equal(res.plan.length, 2, 'all three are the same recording')
  assert.equal(res.groups[0].keeper.id, 'c')
})

test('track-number prefixes, zero padding and disc prefixes in the title tag fold away', () => {
  const a = mp3({ id: 'a', title: '03 - Song' })
  const b = flac({ id: 'b', title: '3. Song' })
  const c = flacHiRes({ id: 'c', title: '1-03 Song' })
  const res = run([a, b, c])
  assert.equal(res.groups.length, 1, 'one group, not three')
  assert.equal(res.plan.length, 2)
})

test('a number that is part of the song title is NOT eaten as a track number', () => {
  assert.equal(UD.titleKey({ title: '99 Problems' }), '99 problems')
  assert.equal(UD.titleKey({ title: '1979' }), '1979')
  assert.equal(UD.titleKey({ title: '1-800-273-8255' }), '1 800 273 8255')
  assert.equal(UD.titleKey({ title: '24K Magic' }), '24k magic')
})

test('edition and format tags on the album name do not split a duplicate apart', () => {
  const a = mp3({ id: 'a', album: 'Kind of Blue' })
  const b = flac({ id: 'b', album: 'Kind of Blue (Remastered 2011)' })
  const c = flacHiRes({ id: 'c', album: 'Kind of Blue [FLAC 24-96]' })
  const res = run([a, b, c])
  assert.equal(res.groups.length, 1)
  assert.equal(res.plan.length, 2)
})

test('non-Latin titles are matched, not silently dropped', () => {
  // slsk-shelves' normKey folds to [a-z0-9] and would turn both of these into
  // the empty string, hiding the duplicate with no error. This is why the
  // module uses smart-query's \p{L}/\p{N} tokeniser.
  const a = mp3({ id: 'a', title: '新しい日の誕生', album: '新しい日の誕生', artist: '長谷川白紙' })
  const b = flac({ id: 'b', title: '新しい日の誕生', album: '新しい日の誕生', artist: '長谷川白紙' })
  assert.notEqual(UD.titleKey(a), '', 'a Japanese title must produce a real key')
  const res = run([a, b])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'a')

  const ru = run([
    mp3({ id: 'ru-a', title: 'Ленинград', album: 'Ленинград', artist: 'Аквариум' }),
    flac({ id: 'ru-b', title: 'ленинград', album: 'ленинград', artist: 'аквариум' }),
  ])
  assert.equal(ru.plan.length, 1, 'Cyrillic, and case-folded')
})

// ── 3. Refusals — a false positive here costs him music ──────────────────────

test('a live version with the same title is not a duplicate', () => {
  const studio = flacHiRes({ id: 'studio', title: 'Song', duration: 225 })
  const live = flac({ id: 'live', title: 'Song (Live)', duration: 251 })
  const res = run([studio, live])
  assert.equal(res.plan.length, 0, 'nothing may be proposed for removal')
  assert.equal(res.ambiguous.length, 0, 'it is not even a maybe — it is a different take')
})

test('a remix is not a duplicate', () => {
  const orig = flacHiRes({ id: 'orig', title: 'Song' })
  const remix = flac({ id: 'remix', title: 'Song (Chris Lake Remix)', duration: 380 })
  const res = run([orig, remix])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 0)
})

test('a 3-second difference is the same recording; a 3-minute difference is not', () => {
  const near = run([
    mp3({ id: 'a', duration: 225 }),
    flacHiRes({ id: 'b', duration: 228 }),
  ])
  assert.equal(near.plan.length, 1, '3 seconds is encoder/tagging noise')
  assert.equal(near.plan[0].remove.id, 'a')

  const far = run([
    mp3({ id: 'c', duration: 192 }),
    flacHiRes({ id: 'd', duration: 372 }),
  ])
  assert.equal(far.plan.length, 0, '3 minutes apart is a different recording')
  assert.equal(far.ambiguous.length, 0)
  assert.equal(far.stats.separatedByDuration, 1)
})

test('a duration gap too big to trust but too small to dismiss is ambiguous, never planned', () => {
  const res = run([
    mp3({ id: 'a', duration: 225 }),
    flacHiRes({ id: 'b', duration: 245 }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 1)
  assert.equal(res.ambiguous[0].kind, 'duration')
  assert.equal(res.ambiguous[0].selected, false)
  assert.match(res.ambiguous[0].reason, /3:45 and 4:05/)
})

test('a missing duration means unsure, not a guess', () => {
  const res = run([
    mp3({ id: 'a', duration: 0 }),
    flacHiRes({ id: 'b', duration: 225 }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 1)
  assert.match(res.ambiguous[0].reason, /no duration recorded/)
})

test('a different album entirely is never grouped', () => {
  const res = run([
    mp3({ id: 'a', album: 'Kind of Blue' }),
    flacHiRes({ id: 'b', album: 'Bitches Brew' }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 0)
  assert.equal(res.groups.length, 0)
})

test('the same song title by two different artists on one compilation is not a duplicate', () => {
  const res = run([
    mp3({ id: 'a', album: 'Now 100', artist: 'Band A', albumArtist: 'Band A' }),
    flacHiRes({ id: 'b', album: 'Now 100', artist: 'Band B', albumArtist: 'Band B' }),
  ])
  assert.equal(res.plan.length, 0)
})

test('MP3 320 vs MP3 V0 is too close to call — ambiguous, never planned', () => {
  const cbr = mp3({ id: 'cbr', bitrate: 320000, codecProfile: 'CBR' })
  const v0 = mp3({ id: 'v0', bitrate: 245000, codecProfile: 'V0', fileSize: 7e6 })
  const res = run([cbr, v0])
  assert.equal(res.plan.length, 0, 'a VBR bitrate understates quality — this is not a proven upgrade')
  assert.equal(res.ambiguous.length, 1)
  assert.equal(res.ambiguous[0].kind, 'quality')
  assert.equal(res.ambiguous[0].selected, false)
  assert.match(res.ambiguous[0].reason, /VBR bitrate understates/)
  assert.match(res.ambiguous[0].reason, /MP3 V0 \(~245 kbps\)/)
})

test('MP3 320 vs MP3 128 IS a proven upgrade', () => {
  const res = run([
    mp3({ id: 'hi', bitrate: 320000, codecProfile: 'CBR' }),
    mp3({ id: 'lo', bitrate: 128000, codecProfile: 'CBR', fileSize: 3.6e6,
      filePath: '/mnt/data/MUSIC/Band/Album old/03 - Song.mp3' }),
  ])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'lo')
  assert.match(res.plan[0].reason, /MP3 320 kbps supersedes MP3 128 kbps — same codec, 2\.5× the bitrate\./)
})

test('two different lossy codecs are not on the same bitrate scale', () => {
  const res = run([
    mp3({ id: 'mp3', bitrate: 320000, codecProfile: 'CBR' }),
    mp3({ id: 'aac', codec: 'aac', bitrate: 256000, codecProfile: 'CBR', fileSize: 7.2e6,
      filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.m4a' }),
  ])
  assert.equal(res.plan.length, 0, '256 kbps AAC is not worse than 320 kbps MP3')
  assert.equal(res.ambiguous.length, 1)
  assert.match(res.ambiguous[0].reason, /not on the same scale/)
})

test('two lossless copies at the same depth and rate — nothing says one is better', () => {
  const res = run([
    flac({ id: 'a', fileSize: 25e6, filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.flac' }),
    flac({ id: 'b', fileSize: 27e6, filePath: '/mnt/data/MUSIC/Downloads/Band/03 - Song.flac' }),
  ])
  assert.equal(res.plan.length, 0, 'file size must not decide between two lossless copies')
  assert.equal(res.ambiguous.length, 1)
  assert.match(res.ambiguous[0].reason, /same 16-bit\/44\.1 kHz/)
})

test('bit depth and sample rate that disagree are a trade, not an upgrade', () => {
  const res = run([
    flac({ id: 'deep', bitsPerSample: 24, sampleRate: 44100 }),
    flac({ id: 'fast', bitsPerSample: 16, sampleRate: 96000,
      filePath: '/mnt/data/MUSIC/Band/Album b/03 - Song.flac' }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 1)
  assert.match(res.ambiguous[0].reason, /That is a trade, not an upgrade/)
})

test('a 5.1 mix is a different release, not a duplicate of the stereo one', () => {
  const stereo = flac({ id: 'stereo', channels: 2 })
  const surround = flac({ id: 'sur', channels: 6, bitsPerSample: 24, sampleRate: 96000,
    fileSize: 200e6, filePath: '/mnt/data/MUSIC/Band/Album 5.1/03 - Song.flac' })
  const res = run([stereo, surround])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 1)
  assert.equal(res.ambiguous[0].kind, 'layout')
  assert.match(res.ambiguous[0].reason, /5\.1 vs stereo/)
})

test('a multichannel copy is not allowed to supersede one whose channels were never read', () => {
  const res = run([
    flac({ id: 'unknown', channels: 0, bitsPerSample: 16, sampleRate: 44100 }),
    flac({ id: 'sur', channels: 6, bitsPerSample: 24, sampleRate: 96000, fileSize: 200e6,
      filePath: '/mnt/data/MUSIC/Band/Album 5.1/03 - Song.flac' }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous[0].kind, 'layout')
})

test('an Atmos copy and a stereo copy are different mixes', () => {
  const res = run([
    flac({ id: 'stereo' }),
    flac({ id: 'atmos', atmos: true, codec: 'eac3', bitrate: 768000, channels: 2,
      filePath: '/mnt/data/MUSIC/Band/Album Atmos/03 - Song.eac3' }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous[0].kind, 'layout')
})

test('a track whose tags disagree with its file is never on either end of a deletion', () => {
  // The tags claim FLAC; the file on disk is an .mp3. Nothing this file says
  // can be trusted, including its bit depth.
  const liar = track({
    id: 'liar', codec: 'flac', bitsPerSample: 24, sampleRate: 96000,
    bitrate: 320000, fileSize: 9e6,
    filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.mp3',
  })
  const honest = flac({ id: 'honest' })
  const res = run([liar, honest])
  assert.equal(res.plan.length, 0, 'a lying file may not delete an honest one, or be deleted by it')
  assert.equal(res.ambiguous.length, 1)
  assert.equal(res.ambiguous[0].kind, 'metadata')
  assert.match(res.ambiguous[0].reason, /tags and the file disagree/)
  assert.equal(UD.qualityOf(liar).conflict, true)
  assert.equal(UD.qualityOf(honest).conflict, false)
})

test('an unidentified format gets no verdict', () => {
  const res = run([
    track({ id: 'mystery', codec: null, filePath: '/mnt/data/MUSIC/Band/Album/03 - Song.m4a',
      duration: 225, fileSize: 9e6 }),
    flacHiRes({ id: 'hi' }),
  ])
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous[0].kind, 'metadata')
  assert.match(res.ambiguous[0].reason, /not identified/)
})

// ── 4. DSD, told honestly ────────────────────────────────────────────────────

test('DSD is not ranked against PCM lossless — it is decoded to PCM here', () => {
  const dsd = track({
    id: 'dsd', codec: 'dsd', bitsPerSample: 1, sampleRate: 2822400,
    fileSize: 300e6, filePath: '/mnt/data/MUSIC/Band/Album SACD/03 - Song.dsf',
  })
  const hi = flacHiRes({ id: 'hi' })
  const res = run([dsd, hi])
  assert.equal(res.plan.length, 0, 'a 1-bit/2.8 MHz number must not "beat" 24/96 on arithmetic')
  assert.equal(res.ambiguous.length, 1)
  assert.match(res.ambiguous[0].reason, /decoded to PCM for playback here/)

  const q = UD.qualityOf(dsd)
  assert.equal(q.cls, 'dsd')
  assert.equal(q.bits, null, 'DSD bit depth is parked, not compared')
  assert.equal(q.rate, null, 'DSD rate is parked, not compared')
  assert.equal(q.dsdRate, 2822400)
  assert.equal(q.label, 'DSD — decoded to PCM for playback')
})

test('DSD does supersede a lossy copy, and says why honestly', () => {
  const dsd = track({
    id: 'dsd', codec: 'dsd', bitsPerSample: 1, sampleRate: 2822400,
    fileSize: 300e6, filePath: '/mnt/data/MUSIC/Band/Album SACD/03 - Song.dsf',
  })
  const res = run([dsd, mp3({ id: 'lossy' })])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'lossy')
  assert.match(res.plan[0].reason, /lossless DSD source \(decoded to PCM here\) replaces lossy/)
})

// ── 5. The ranking rule itself ───────────────────────────────────────────────

test('compareQuality orders lossless over lossy, then depth, then rate, then bitrate, then size', () => {
  const best = (a, b) => UD.compareQuality(a, b) < 0
  assert.ok(best(flac(), mp3()), 'lossless beats lossy')
  assert.ok(best(flac({ bitsPerSample: 24, fileSize: 1e6 }), flac({ bitsPerSample: 16, fileSize: 9e9 })),
    '24-bit beats 16-bit at the same rate, whatever the file sizes say')
  assert.ok(best(flac({ sampleRate: 96000, fileSize: 1e6 }), flac({ sampleRate: 44100, fileSize: 9e9 })),
    'higher rate beats lower at the same depth')
  assert.ok(best(mp3({ bitrate: 320000 }), mp3({ bitrate: 128000 })), 'higher bitrate beats lower')
  assert.ok(best(mp3({ bitrate: 0, fileSize: 9e6 }), mp3({ bitrate: 0, fileSize: 3e6 })),
    'file size is the last resort')
})

test('describeQuality speaks the same vocabulary the badges do', () => {
  assert.equal(UD.describeQuality(flacHiRes()), 'FLAC 24-bit/96 kHz')
  assert.equal(UD.describeQuality(flac()), 'FLAC 16-bit/44.1 kHz')
  assert.equal(UD.describeQuality(mp3()), 'MP3 320 kbps')
  assert.equal(UD.describeQuality(mp3({ bitrate: 245000, codecProfile: 'V0' })), 'MP3 V0 (~245 kbps)')
  assert.equal(UD.describeQuality(flac({ channels: 6 })), 'FLAC 16-bit/44.1 kHz 5.1')
})

test('a lossy file cannot smuggle in a bit depth', () => {
  // An mp3 tagged 24-bit is noise; believing it would make it outrank FLAC.
  const q = UD.qualityOf(mp3({ bitsPerSample: 24 }))
  assert.equal(q.bits, null)
  assert.ok(UD.compareQuality(flac(), mp3({ bitsPerSample: 24 })) < 0)
})

test('bitrate is accepted in bits/sec or kbps and reported in kbps either way', () => {
  assert.equal(UD.qualityOf(mp3({ bitrate: 320000 })).bitrate, 320)
  assert.equal(UD.qualityOf(mp3({ bitrate: 320 })).bitrate, 320)
})

test('durationRelation is the stated tolerance, not a vibe', () => {
  assert.equal(UD.durationRelation(225, 228), 'same')
  assert.equal(UD.durationRelation(225, 245), 'unsure')
  assert.equal(UD.durationRelation(192, 372), 'different')
  assert.equal(UD.durationRelation(225, 0), 'missing')
})

// ── 6. Safety properties — non-negotiable ────────────────────────────────────

test('the module never mutates the library it was handed', () => {
  // The fixtures are deep-frozen; in strict mode any write throws.
  const res = run([mp3({ id: 'a' }), flacHiRes({ id: 'b' }), flac({ id: 'c' })])
  assert.ok(res.plan.length > 0)
})

test('every plan item is unselected and goes to the trash, never unlink', () => {
  const res = run([mp3({ id: 'a' }), flacHiRes({ id: 'b' })])
  assert.ok(res.plan.length > 0)
  for (const item of res.plan) {
    assert.equal(item.selected, false, 'nothing may be preselected')
    assert.equal(item.action, 'trash', 'removal must go to the trash')
    assert.equal(item.confidence, 'high')
    assert.ok(item.reason && item.reason.length > 10, 'every item states its reason')
    assert.ok(item.remove.filePath, 'the UI needs a path to show')
    assert.ok(item.keeper.filePath, 'and the path of what replaces it')
  }
})

test('every ambiguous entry is unselected and carries no removal action', () => {
  const res = run([
    mp3({ id: 'cbr', bitrate: 320000, codecProfile: 'CBR' }),
    mp3({ id: 'v0', bitrate: 245000, codecProfile: 'V0', fileSize: 7e6 }),
  ])
  assert.ok(res.ambiguous.length > 0)
  for (const a of res.ambiguous) {
    assert.equal(a.selected, false)
    assert.equal(a.confidence, 'unsure')
    assert.equal(a.action, undefined, 'an unsure entry has nothing to execute')
    assert.ok(Array.isArray(a.copies) && a.copies.length >= 2)
  }
})

test('toRemovalPlan with no selection removes NOTHING', () => {
  const res = run([mp3({ id: 'a' }), flacHiRes({ id: 'b' })])
  assert.ok(res.plan.length > 0)
  for (const ids of [undefined, null, [], 'all', {}]) {
    const out = UD.toRemovalPlan(res, ids)
    assert.equal(out.items.length, 0, 'an empty or bogus selection must never mean "everything"')
    assert.equal(out.paths.length, 0)
  }
})

test('toRemovalPlan accepts only ids that are in the plan', () => {
  const res = run([mp3({ id: 'a' }), flacHiRes({ id: 'b' })])
  const good = res.plan[0].id
  const out = UD.toRemovalPlan(res, [good, good, 'remove:made-up'])
  assert.equal(out.action, 'trash')
  assert.equal(out.items.length, 1, 'duplicates collapse')
  assert.deepEqual(out.paths, [res.plan[0].remove.filePath])
  assert.deepEqual(out.rejected, ['remove:made-up'])
})

test('an ambiguous id can never be turned into a removal', () => {
  const res = run([
    mp3({ id: 'cbr', bitrate: 320000, codecProfile: 'CBR' }),
    mp3({ id: 'v0', bitrate: 245000, codecProfile: 'V0', fileSize: 7e6 }),
  ])
  assert.equal(res.plan.length, 0)
  const out = UD.toRemovalPlan(res, [res.ambiguous[0].id])
  assert.equal(out.items.length, 0)
  assert.deepEqual(out.rejected, [res.ambiguous[0].id])
})

test('the module touches no filesystem and spawns nothing', () => {
  // A source-text guard, deliberately: the property being protected is that a
  // FUTURE edit cannot quietly add IO to a module that analyses his real music.
  const fs = require('node:fs')
  const raw = fs.readFileSync(require.resolve('../src/upgrade-dupes'), 'utf8')
  // Comments are allowed to NAME the things the code must not do — the header
  // says so at length. Only executable text is checked.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  assert.ok(src.indexOf('findSupersededCopies') !== -1, 'the comment strip must not eat the code')
  for (const forbidden of [
    "require('fs')", 'require("fs")', "require('node:fs')", 'require("node:fs")',
    'child_process', 'unlinkSync', 'rmSync', 'renameSync', 'writeFileSync',
    'readFileSync', 'shell.trashItem', 'electron',
  ]) {
    assert.ok(src.indexOf(forbidden) === -1, `upgrade-dupes.js must not contain ${forbidden}`)
  }
  // And it exports nothing that could execute a removal.
  for (const k of Object.keys(UD)) {
    assert.ok(!/^(delete|remove|trash|unlink|apply|commit|execute)/i.test(k),
      `exported ${k} looks like it performs a removal`)
  }
})

// ── 7. Input shapes ──────────────────────────────────────────────────────────

test('it accepts the renderer album array directly, inheriting album and artist', () => {
  const library = [{
    id: 'alb', name: 'Kind of Blue', artist: 'Miles Davis',
    tracks: [
      { id: 'x', title: 'So What', duration: 545, codec: 'mp3', bitrate: 320000,
        codecProfile: 'CBR', sampleRate: 44100, channels: 2, fileSize: 21e6,
        filePath: '/mnt/data/MUSIC/Miles Davis/Kind of Blue/01 So What.mp3' },
      { id: 'y', title: 'So What', duration: 545, codec: 'flac', bitsPerSample: 24,
        sampleRate: 96000, bitrate: 3000000, channels: 2, fileSize: 190e6,
        filePath: '/mnt/data/MUSIC/Miles Davis/Kind of Blue/01 So What.flac' },
      { id: 'z', title: 'Freddie Freeloader', duration: 586, codec: 'flac',
        bitsPerSample: 24, sampleRate: 96000, channels: 2, fileSize: 200e6,
        filePath: '/mnt/data/MUSIC/Miles Davis/Kind of Blue/02 Freddie Freeloader.flac' },
    ],
  }]
  const res = UD.findSupersededCopies(library)
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'x')
  assert.equal(res.plan[0].remove.album, 'Kind of Blue')
  assert.equal(res.plan[0].remove.artist, 'Miles Davis')
})

test('empty, junk and single-copy input produce an empty plan, not a throw', () => {
  for (const input of [undefined, null, [], [null, 3, 'x'], [flac()]]) {
    const res = UD.findSupersededCopies(input)
    assert.equal(res.plan.length, 0)
    assert.equal(res.ambiguous.length, 0)
  }
})

test('a track with no title cannot be identified and is skipped', () => {
  const res = run([mp3({ id: 'a', title: '' }), flacHiRes({ id: 'b', title: '' })])
  assert.equal(res.plan.length, 0)
})

// ── 8. Renderer wiring ───────────────────────────────────────────────────────

test('it loads and runs in a browser-shaped scope, in ANY script order', () => {
  const vm = require('node:vm')
  const fs = require('node:fs')
  const path = require('node:path')
  const SRC = path.join(__dirname, '..', 'src')
  // Deliberately loaded FIRST, before the three modules it depends on. The
  // renderer loads classic scripts into one shared scope, so a load-time
  // dependency grab would break on a wrong <script> order in index.html.
  const order = ['upgrade-dupes.js', 'format-badges.js', 'quality-badge.js', 'smart-query.js']
  const ctx = vm.createContext({ console })
  vm.runInContext('var window = this; var self = this; var module = undefined;', ctx)
  for (const f of order) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f })
  }
  assert.ok(ctx.window.PapaUpgradeDupes, 'must publish window.PapaUpgradeDupes')
  const res = ctx.window.PapaUpgradeDupes.findSupersededCopies([
    Object.assign({}, mp3({ id: 'a' })),
    Object.assign({}, flacHiRes({ id: 'b' })),
  ])
  assert.equal(res.plan.length, 1)
  assert.equal(res.plan[0].remove.id, 'a')
  assert.equal(res.plan[0].selected, false)
})

test('a genuinely missing dependency throws rather than reporting "no duplicates"', () => {
  const vm = require('node:vm')
  const fs = require('node:fs')
  const path = require('node:path')
  const SRC = path.join(__dirname, '..', 'src')
  const ctx = vm.createContext({ console })
  vm.runInContext('var window = this; var self = this; var module = undefined;', ctx)
  vm.runInContext(fs.readFileSync(path.join(SRC, 'upgrade-dupes.js'), 'utf8'), ctx,
    { filename: 'upgrade-dupes.js' })
  // Nothing else loaded: an empty plan here would read as "your library is
  // clean", which is the one wrong answer this module must never give.
  assert.throws(() => ctx.window.PapaUpgradeDupes.findSupersededCopies([mp3(), flacHiRes()]),
    /smart-query is not loaded/)
})

// ── 9. Options are real ──────────────────────────────────────────────────────

test('hiResSupersedesCd:false leaves the hi-res-vs-CD call to him', () => {
  const res = run([flac({ id: 'cd' }), flacHiRes({ id: 'hi' })], { hiResSupersedesCd: false })
  assert.equal(res.plan.length, 0)
  assert.equal(res.ambiguous.length, 1)
  assert.match(res.ambiguous[0].reason, /set not to supersede/)
})

test('a tighter duration tolerance turns a borderline pair into unsure', () => {
  const pair = [mp3({ id: 'a', duration: 225 }), flacHiRes({ id: 'b', duration: 228 })]
  assert.equal(run(pair).plan.length, 1)
  const strict = UD.findSupersededCopies(pair.map(t => Object.assign({}, t)),
    { durationToleranceSec: 1, durationTolerancePct: 0 })
  assert.equal(strict.plan.length, 0)
  assert.equal(strict.ambiguous.length, 1)
})
