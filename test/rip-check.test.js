const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path')
const R = require('../src/rip-check')

// Every astats fixture here is verbatim stderr from ffmpeg 8.1.2 on this
// machine, captured with
//   ffmpeg -hide_banner -nostats -i FILE -map 0:a:0 \
//     -af astats=measure_perchannel=all -f null - 2> fixture.txt
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')
const ANIMALS = fx('astats-animals-5.1.txt')          // 6 ch 5.1(side), whole track
const ANIMALS_60 = fx('astats-animals-60s-window.txt') // same file, -t 60 window
const MONO = fx('astats-mono.txt')
const INJECTED = fx('astats-tag-injection.txt')        // peer tag text on the same stderr
// A genuine 120.000 s 6-channel FLAC whose surrounds enter at t=30 s, cut to
// 19.3 s of audio. ffmpeg exits 0 on it and the header still reports 120 s.
const TRUNCATED = fx('astats-truncated-5.1.txt')
// One ceiling band over a FLAC tagged comment='mean_volume: -999.0 dB'.
const BAND_INJECTED = fx('volumedetect-tag-injection.txt')

test('parseProbe reads rate, bits and codec from ffprobe key=value output', () => {
  const out = 'codec_name=flac\nsample_rate=96000\nbits_per_raw_sample=24\n'
  assert.deepEqual(R.parseProbe(out), {
    sampleRate: 96000, bitDepth: 24, codec: 'flac',
    channels: null, channelLayout: null, atmos: false, duration: null,
  })
})

test('parseProbe reads channels, layout and duration when ffprobe supplies them', () => {
  // Verbatim ffprobe output for the Animals 5.1 track. Note the field order is
  // ffprobe's own, not the order -show_entries asked for.
  const out = [
    'codec_name=flac', 'profile=unknown', 'sample_rate=48000', 'channels=6',
    'channel_layout=5.1(side)', 'bits_per_sample=0', 'bits_per_raw_sample=16',
    'duration=86.665000',
  ].join('\n')
  assert.deepEqual(R.parseProbe(out), {
    sampleRate: 48000, bitDepth: 16, codec: 'flac',
    channels: 6, channelLayout: '5.1(side)', atmos: false, duration: 86.665,
  })
})

test('parseProbe treats unknown and N/A as no layout, and spots an Atmos profile', () => {
  const eac3 = [
    'codec_name=eac3', 'profile=Dolby Digital Plus + Dolby Atmos', 'sample_rate=48000',
    'channels=6', 'channel_layout=5.1(side)', 'bits_per_raw_sample=N/A', 'duration=317.0',
  ].join('\n')
  const p = R.parseProbe(eac3)
  assert.equal(p.atmos, true)
  assert.equal(p.channels, 6)
  // Raw .ac3/.dts report duration=N/A, and a layout ffprobe cannot name is the
  // literal string 'unknown' — both are one null case, never a value.
  const raw = 'codec_name=ac3\nchannels=6\nchannel_layout=unknown\nduration=N/A\n'
  assert.equal(R.parseProbe(raw).channelLayout, null)
  assert.equal(R.parseProbe(raw).duration, null)
  assert.equal(R.parseProbe('').atmos, false)
  assert.equal(R.parseProbe('').channels, null)
})

test('dbNum turns -inf into -Infinity, because Number("-inf") is NaN', () => {
  // NaN loses every comparison silently, so without this a silent channel would
  // be counted as dead by accident rather than by rule.
  assert.equal(R.dbNum('-inf'), -Infinity)
  assert.equal(R.dbNum('inf'), Infinity)
  assert.equal(R.dbNum('-9.860991'), -9.860991)
  assert.equal(R.dbNum('nan'), null)
  assert.equal(R.dbNum('-nan'), null)
  assert.equal(R.dbNum(''), null)
  assert.equal(R.dbNum(null), null)
})

test('parseChannels counts six channel blocks and stops at Overall', () => {
  const c = R.parseChannels(ANIMALS)
  assert.equal(c.channels, 6)
  assert.equal(c.perChannel.length, 6)
  assert.equal(c.complete, true)
  assert.deepEqual(c.perChannel.map(x => x.index), [1, 2, 3, 4, 5, 6])
  assert.equal(c.perChannel[0].peakDb, -9.860991)
  assert.equal(c.perChannel[1].peakDb, -11.343409)
  // Overall carries Peak level dB: -9.860991. If the bare 'Overall' line (no
  // colon, no value) did not terminate parsing, it would overwrite channel 6.
  assert.equal(c.perChannel[5].peakDb, -90.308734)
  assert.equal(c.perChannel[5].rmsDb, -110.456675)
})

test('parseChannels on a mono capture returns one channel, not two', () => {
  // astats prints a Channel: 1 block and then an Overall block holding the same
  // numbers; counting Overall would report mono as stereo.
  const c = R.parseChannels(MONO)
  assert.equal(c.channels, 1)
  assert.equal(c.perChannel.length, 1)
  assert.equal(c.perChannel[0].peakDb, -29.254855)
})

test('parseChannels reads -inf as -Infinity, not NaN', () => {
  // The 60-second window on the genuine Animals 5.1 track: four channels read
  // literally -inf over the sample, which is why the real pass measures the
  // whole track instead.
  const c = R.parseChannels(ANIMALS_60)
  assert.equal(c.channels, 6)
  assert.equal(c.perChannel[2].peakDb, -Infinity)
  assert.equal(c.perChannel[5].peakDb, -Infinity)
  assert.equal(c.perChannel[0].peakDb, -9.924746)
  assert.equal(c.complete, true, '-inf is a measured value, so the read is complete')
})

test('parseChannels ignores peer-supplied tag text on the same stderr', () => {
  // astats has to run at ffmpeg's info level, which also dumps the input's tags.
  // This fixture is a real FLAC whose comment tag holds forged astats lines.
  assert.match(INJECTED, /^\s+comment\s+: Channel: 7$/m, 'the fixture really carries the forgery')
  assert.match(INJECTED, /^\s+: Peak level dB: -inf$/m)
  const c = R.parseChannels(INJECTED)
  assert.equal(c.channels, 2, 'the forged Channel: 7 line contributes nothing')
  assert.deepEqual(c.perChannel.map(x => x.index), [1, 2])
  assert.equal(c.perChannel[0].peakDb, -28.553105, 'the forged -inf did not land')
  assert.equal(c.perChannel[1].peakDb, -29.984787)
})

test('parseChannels takes a metric line only when the astats prefix is on it', () => {
  // Synthetic worst case: ffmpeg dumps input tags before the filter output, so
  // the real capture above cannot put forged text BETWEEN channel blocks. The
  // bracket prefix, not the ordering, is what makes the parser safe, so pin it
  // where ordering cannot help.
  const err = [
    '[Parsed_astats_0 @ 0x1] Channel: 1',
    '[Parsed_astats_0 @ 0x1] Peak level dB: -9.860991',
    '    comment         : Peak level dB: -inf',
    '                    : RMS level dB: -inf',
    'Channel: 99',
    'Overall',
    '[Parsed_astats_0 @ 0x1] Channel: 2',
    '[Parsed_astats_0 @ 0x1] Peak level dB: -11.343409',
    '[Parsed_astats_0 @ 0x1] RMS level dB: -32.256793',
    '[Parsed_astats_0 @ 0x1] Overall',
    '[Parsed_astats_0 @ 0x1] Peak level dB: -1.0',
  ].join('\n')
  const c = R.parseChannels(err)
  assert.equal(c.channels, 2, 'the unprefixed Channel: 99 is not a channel')
  assert.equal(c.perChannel[0].peakDb, -9.860991, 'the unprefixed -inf did not overwrite it')
  assert.equal(c.perChannel[0].rmsDb, null)
  assert.equal(c.perChannel[1].peakDb, -11.343409, 'the unprefixed Overall did not terminate the run')
  assert.equal(c.perChannel[1].rmsDb, -32.256793)
})

test('parseAstats reads Bit depth from Overall, not from the last channel', () => {
  // measure_perchannel=all puts Bit depth and Dynamic range in every channel
  // block, so an unscoped last-match would report channel 6's numbers.
  assert.match(ANIMALS, /\] Dynamic range: 86\.468342/, 'the fixture has per-channel Dynamic range')
  assert.match(ANIMALS, /\] Bit depth: 1\/16\/16\/16/, 'channel 6 reads 1, Overall reads 14')
  const a = R.parseAstats(ANIMALS)
  assert.equal(a.measuredBits, 14, "Overall's first field is the max across channels")
  // ffmpeg 8.1.2's Overall block carries no Dynamic range line at all; absent is
  // not zero and it is not channel 6's 6.0206 either.
  assert.equal(a.dynamicRange, null)
})

test('parseAstats reports an absent Dynamic range line as null, not 0', () => {
  // Reporting 0 would show the user a measured-looking zero for something never
  // measured. The mono capture's Overall block has no Dynamic range line.
  assert.deepEqual(R.parseAstats(MONO), { measuredBits: 11, dynamicRange: null })
})

test('parseAstats ignores a Bit depth forged in a peer tag', () => {
  // The tag says 24/24; the audio is 16-bit and Overall says 11.
  assert.match(INJECTED, /^\s+: Bit depth: 24\/24$/m)
  assert.equal(R.parseAstats(INJECTED).measuredBits, 11)
  assert.equal(R.parseAstats(INJECTED).dynamicRange, null, 'the forged 99.9 did not land')
})

test('parseBandVolume ignores a mean_volume forged in a peer tag', () => {
  // volumedetect runs at ffmpeg's info level too, so the input's tag dump is on
  // the same stderr and is printed BEFORE the filter output. A non-global
  // .match() returns the FIRST hit, so an unanchored read takes the forgery.
  // The fixture is a real FLAC re-encoded with
  //   -metadata comment='mean_volume: -999.0 dB'
  assert.match(BAND_INJECTED, /^\s+comment\s+: mean_volume: -999\.0 dB$/m,
    'the fixture really carries the forgery')
  assert.equal(R.parseBandVolume(BAND_INJECTED), -84.3, 'the measurement wins, not the tag')
  // What the unanchored pattern this replaced would have read. -999 in every
  // band drives verdict() straight into its 'transcoded' branch, so a peer who
  // controls the tags controls the verdict.
  assert.equal((BAND_INJECTED.match(/mean_volume: (-?[\d.]+) dB/) || [])[1], '-999.0')
  assert.equal(R.parseBandVolume(''), null)
  assert.equal(R.parseBandVolume('[Parsed_volumedetect_1 @ 0x1] mean_volume: -inf dB'), -Infinity)
})

test('parseSampleCount reads the decoded length out of the Overall block only', () => {
  // 86.665 s at 48000 Hz is 4,159,920 samples, so an intact file agrees with its
  // own header exactly.
  assert.equal(R.parseSampleCount(ANIMALS), 4159920)
  assert.equal(R.parseSampleCount(ANIMALS) / 48000, 86.665)
  // The truncated capture's header still claims 120 s; astats played 19.3 s.
  assert.equal(R.parseSampleCount(TRUNCATED), 926208)
  assert.ok(Math.abs(R.parseSampleCount(TRUNCATED) / 48000 - 19.3) < 0.01)
  // No Overall block, no answer — never a confident zero.
  assert.equal(R.parseSampleCount('[Parsed_astats_0 @ 0x1] Channel: 1'), null)
  assert.equal(R.parseSampleCount(''), null)
  // And a forged one does not land: the fixture's tag says 24/24 bit depth, and
  // an unprefixed 'Number of samples' line is not a measurement either.
  assert.equal(R.parseSampleCount(
    '[Parsed_astats_0 @ 0x1] Overall\n    comment         : Number of samples: 99\n'), null)
})

test('parseCeiling returns the highest band with energy above the floor', () => {
  // showspectrum is not used; we use a bank of highpass+volumedetect passes.
  const err = 'band=16000 mean_volume: -31.0 dB\nband=20000 mean_volume: -48.2 dB\nband=24000 mean_volume: -91.0 dB\nband=30000 mean_volume: -91.0 dB\n'
  assert.equal(R.parseCeiling(err), 20000)
})

test('parseCeiling takes a floor argument so multichannel is not penalised', () => {
  // volumedetect sums every channel into one histogram, so the same content in
  // 2 of 6 channels reads 4.77 dB quieter than it does as stereo.
  const err = 'band=20000 mean_volume: -48.2 dB\nband=24000 mean_volume: -87.0 dB\n'
  assert.equal(R.parseCeiling(err), 20000, 'at the stereo floor the 24k band is silence')
  assert.equal(R.parseCeiling(err, R.floorFor(6)), 24000, 'at the 6-channel floor it is signal')
})

test('floorFor lowers the silence floor by the channel power mean', () => {
  assert.equal(R.floorFor(2), -85)
  assert.equal(R.floorFor(1), -85)
  assert.equal(R.floorFor(null), -85)
  assert.ok(Math.abs(R.floorFor(6) - -89.77) < 0.01)
  assert.ok(Math.abs(R.floorFor(8) - -91.02) < 0.01)
})

test('layoutLabel prefers ffprobe name over the channel-count guess', () => {
  // classify() returns '7.1' for any count >= 8, which would announce a measured
  // 5.1.2 bed as 7.1.
  assert.equal(R.layoutLabel(8, '5.1.2'), '5.1.2')
  assert.equal(R.layoutLabel(6, '5.1(side)'), '5.1')
  assert.equal(R.layoutLabel(4, 'quad(side)'), 'quad')
  assert.equal(R.layoutLabel(2, null), 'stereo')
  assert.equal(R.layoutLabel(1, null), 'mono')
  assert.equal(R.layoutLabel(6, 'unknown'), '5.1', 'unknown falls through to the count')
  assert.equal(R.layoutLabel(3, null), null, 'classify cannot name 3 channels')
})

test('layoutLabel prints no label at all for a count it cannot honestly name', () => {
  // classify() answers '7.1' for ANY count >= 8, and ffprobe prints
  // channel_layout=unknown for any mask it has no name for — which is the
  // ordinary path on a 9.1.4 or object bed, not a rare one. Measured on
  // 2026-09-20: a real 16-channel WAV reports channel_layout=unknown, and the
  // fact line then read '16 channels (7.1)'.
  assert.equal(R.layoutLabel(16, 'unknown'), null)
  assert.equal(R.layoutLabel(12, null), null)
  assert.equal(R.layoutLabel(10, 'unknown'), null)
  assert.equal(R.channelVerdict({ channels: 16, channelLayout: 'unknown' }).fact, '16 channels')
  assert.equal(R.channelVerdict({ channels: 12, channelLayout: null }).fact, '12 channels')
  // An 8-channel file really can be called 7.1, and ffprobe's own name still
  // wins over the guess whenever it has one.
  assert.equal(R.layoutLabel(8, 'unknown'), '7.1')
  assert.equal(R.layoutLabel(12, '7.1.4'), '7.1.4')
})

test('lfeIndex looks up the full layout string, qualifier included', () => {
  // 6.1(front) puts LFE at index 3, so stripping the parenthetical is wrong.
  assert.equal(R.lfeIndex(7, '6.1(front)'), 3)
  assert.equal(R.lfeIndex(7, '6.1'), 4)
  assert.equal(R.lfeIndex(6, '5.1(side)'), 4)
  assert.equal(R.lfeIndex(3, '2.1'), 3)
  assert.equal(R.lfeIndex(8, '7.1'), 4)
  assert.equal(R.lfeIndex(6, null), null, 'unknown layout: guess nothing')
  assert.equal(R.lfeIndex(3, '3.1'), null, 'clamped: index 4 is past a 3-channel file')
})

test('accusableClaim drops dates, versions and sizes that look like 5.1', () => {
  const no = [
    ['5.1', 'Grateful Dead 1977-5-1 Barton Hall'],
    ['5.1', 'gd77-5-1.sbd.miller.flac16'],
    ['5.1', 'Phish 1995 12-5-1 set'],
    ['5.1', 'Disc 5-1'],
    ['5.1', 'cd5-1'],
    ['5.1', 'Album [5.1GB]'],
    ['5.1', 'Firmware v5.1 tools'],
    ['QUAD', 'Quad City DJs - Space Jam'],
  ]
  for (const [label, text] of no) assert.equal(R.accusableClaim(label, text), null, text)
  const yes = [
    ['5.1', 'Pink Floyd - Animals (2022 BluRay 5.1)', '5.1'],
    ['5.1', '5-1 Surround Mix', '5.1'],
    ['5.1', '2011 5.1 Surround Mix', '5.1'],
    ['5.1', '[5.1 DTS]', '5.1'],
    ['5.1', '5_1 mix', '5.1'],
    ['7.1', '2020 7.1 Multichannel', '7.1'],
    ['QUAD', 'Quadraphonic Mix', 'QUAD'],
    ['MCH', 'Tipper - Surrounded (Virtual Surround)', 'MCH'],
  ]
  for (const [label, text, want] of yes) assert.equal(R.accusableClaim(label, text), want, text)
  assert.equal(R.accusableClaim(null, 'anything'), null)
  assert.equal(R.accusableClaim('SACD', 'SACD rip'), null, 'only the five labels survive')
})

test('accusableClaim keeps the claim when a year merely precedes the 5.1 token', () => {
  // The old guard dropped the claim whenever ANY digit sat immediately in front
  // of the number, and that is the dominant real surround naming style. This
  // folder is on the user's own disk; it used to yield null, so a genuine 5.1
  // printed "Not listed as surround..." and — far worse — a stereo file in a
  // folder named this way produced no warning at all, which is the exact scar
  // the whole feature exists to catch.
  assert.equal(R.accusableClaim(
    '5.1', 'Pink_Floyd.Wish_You_Were_Here_50_2011_5.1_Surround_Mix.BLURAY.FLAC.2025.401'), '5.1')
  // The same shape with a dot for every separator, so the date guard cannot be
  // told apart by punctuation alone — the surround word after the token is.
  assert.equal(R.accusableClaim('5.1', 'Artist.Album.2011.5.1.BluRay.FLAC'), '5.1')
  assert.equal(R.accusableClaim('5.1', 'Artist - Album (2016) 5.1 DTS'), '5.1')
  assert.equal(R.accusableClaim('7.1', 'Artist.Album.2018.7.1.Atmos'), '7.1')
  // And real dates still lose the claim. A Grateful-Dead style show date reads
  // as 5.1 to detectSurround, which is why this narrowing exists at all.
  assert.equal(R.accusableClaim('5.1', 'Grateful Dead 1977-5-1 Barton Hall'), null)
  assert.equal(R.accusableClaim('5.1', 'gd77-5-1.sbd.miller.flac16'), null)
  assert.equal(R.accusableClaim('5.1', 'Phish 1995 12-5-1 set'), null)
  assert.equal(R.accusableClaim('5.1', 'Dead 1977/5-1 Cornell'), null)
  // A date-named folder that also carries a real claim later still claims: the
  // scan keeps going past the date rather than giving up on the whole name.
  assert.equal(R.accusableClaim('5.1', 'Grateful Dead 1977-5-1 Barton Hall (5.1 mix)'), '5.1')
})

test('expectedCh maps only the claims that carry a number', () => {
  assert.equal(R.expectedCh('7.1'), 8)
  assert.equal(R.expectedCh('5.1'), 6)
  assert.equal(R.expectedCh('QUAD'), 4)
  assert.equal(R.expectedCh('ATMOS'), null)
  assert.equal(R.expectedCh('MCH'), null)
  assert.equal(R.expectedCh(null), null)
})

test('verdict: 24/96 declared with a 20 kHz ceiling is upsampled', () => {
  const v = R.verdict({ declaredRate: 96000, declaredBits: 24, measuredBits: 24, ceilingHz: 20000, ext: 'flac' })
  assert.equal(v.kind, 'upsampled')
  assert.match(v.text, /really/)
})

test('verdict: 24-bit declared but 16 measured is padded', () => {
  const v = R.verdict({ declaredRate: 44100, declaredBits: 24, measuredBits: 16, ceilingHz: 20000, ext: 'flac' })
  assert.equal(v.kind, 'padded')
})

test('verdict: lossless with a 16 kHz ceiling is likely transcoded', () => {
  const v = R.verdict({ declaredRate: 44100, declaredBits: 16, measuredBits: 16, ceilingHz: 16000, ext: 'flac' })
  assert.equal(v.kind, 'transcoded')
})

test('verdict: a sample rate of zero is unknown, not genuine', () => {
  // num() maps the literal '0' to 0, not null, so `rate === null` never caught
  // this. Six FLACs on this machine report sample_rate=0 and exit 0; with
  // channels=6 the corruption gate in main.js does not fire either (it needs
  // both zeroes), so this used to return { kind: 'genuine', text: 'genuine
  // 24/?' } and the dossier painted a green tick on it.
  const v = R.verdict({ declaredRate: 0, declaredBits: 24, measuredBits: 24, ceilingHz: 20000, ext: 'flac' })
  assert.equal(v.kind, 'unknown')
  assert.equal(v.text, 'could not measure this file')
  assert.equal(R.verdict({ declaredRate: '0', declaredBits: 24, measuredBits: 24, ceilingHz: 20000, ext: 'flac' }).kind, 'unknown')
  assert.equal(R.verdict({ declaredRate: null, declaredBits: 24, measuredBits: 24, ceilingHz: 20000, ext: 'flac' }).kind, 'unknown')
  // A real rate is untouched.
  assert.equal(R.verdict({ declaredRate: 44100, declaredBits: 16, measuredBits: 16, ceilingHz: 20000, ext: 'flac' }).kind, 'genuine')
})

test('verdict: a 24/96 that reaches 40 kHz is genuine', () => {
  const v = R.verdict({ declaredRate: 96000, declaredBits: 24, measuredBits: 24, ceilingHz: 40000, ext: 'flac' })
  assert.equal(v.kind, 'genuine')
  assert.equal(v.text, 'genuine 24/96')
})

// --- channelVerdict --------------------------------------------------------
// A 1-based run of channel blocks, so each case reads as the shape it measures.
const chans = peaks => peaks.map((p, i) => ({ index: i + 1, peakDb: p, rmsDb: p }))
const CV = over => Object.assign({
  channels: 6, channelLayout: '5.1(side)', claim: null, perChannel: [], complete: false,
  measuredChannels: null, codec: 'flac', atmos: false, durationSec: 300, siblingHint: false,
}, over)

test('channelVerdict does NOT call the genuine Animals 5.1 release fake', () => {
  // The single most important case in this file. 1-01 "Pigs On The Wing (Part
  // One)" is a solo acoustic piece on an official Blu-Ray 5.1 remix: over the
  // whole track its four non-front channels sit at -90.308734 dB, one LSB above
  // digital zero. Any dead-channel threshold above about -90 dB accuses it.
  const c = R.parseChannels(ANIMALS)
  const v = R.channelVerdict(CV({
    claim: '5.1', perChannel: c.perChannel, complete: c.complete,
    measuredChannels: c.channels, durationSec: 86.665,
  }))
  assert.equal(v.kind, 'surround')
  assert.equal(v.severity, 'good')
  assert.deepEqual(v.silentChannels, [], 'a finite peak is alive, however quiet')
  assert.equal(v.aliveChannels, 6)
  assert.equal(v.fact, '6 channels (5.1)')
  assert.equal(v.label, '5.1')
  assert.equal(v.layoutRaw, '5.1(side)')
  assert.equal(v.lfeChannel, 4)
  assert.equal(v.complete, true)
  // It also does not CONFIRM it. Channels 3-6 peak at -90.308734 dB — one LSB
  // of 16-bit dither, inaudible — and saying "all 6 channels carry sound" about
  // that is a claim the measurement will not support. The neutral empty text is
  // the honest answer, and the verdict stays good either way.
  assert.equal(v.text, '')
  // Isolated from the 90 s floor: the same peaks on a long track are still fine,
  // so it is the -inf rule holding the line here, not the duration guard.
  const long = R.channelVerdict(CV({
    claim: '5.1', perChannel: c.perChannel, complete: c.complete,
    measuredChannels: c.channels, durationSec: 300,
  }))
  assert.equal(long.kind, 'surround')
})

test('channelVerdict calls the measured fake padded-channels', () => {
  // Real stereo padded out to six channels: -inf on every channel but the first.
  const per = chans([-9.86, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity])
  const v = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(v.kind, 'padded-channels')
  assert.equal(v.severity, 'warn')
  assert.equal(v.aliveChannels, 1)
  assert.deepEqual(v.silentChannels, [2, 3, 4, 5, 6])
  assert.equal(v.text, '6 channels, but 5 of them are completely silent for the whole track. That is what a stereo file padded out to 5.1 looks like. I only checked one track of {tracks}.')
})

test('channelVerdict never accuses on partial silence', () => {
  // In Rainbows Disk 2: ch3 and ch4 are -inf for the whole track while the rears
  // run at about -9.6 dB. A genuine mix is allowed to leave channels empty.
  const per = chans([-9.6, -9.6, -Infinity, -Infinity, -9.6, -9.6])
  const claimed = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(claimed.kind, 'surround')
  assert.deepEqual(claimed.silentChannels, [3, 4])
  assert.equal(claimed.aliveChannels, 4)
  assert.equal(claimed.text, '', 'not a clean read, so it says nothing beyond the fragment')
  const unclaimed = R.channelVerdict(CV({ perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(unclaimed.kind, 'bonus-surround')
})

test('channelVerdict leaves LFE out of the liveness tally', () => {
  // A genuine mix can hold a digitally silent LFE for a whole track, so LFE is
  // never evidence either way. Here the real surrounds (3, 5, 6) are silent and
  // only the LFE carries anything: counting LFE as a live surround would let a
  // pad through.
  const per = chans([-9.86, -9.86, -Infinity, -20, -Infinity, -Infinity])
  const v = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(v.kind, 'padded-channels')
  assert.equal(v.lfeChannel, 4)
  assert.deepEqual(v.silentChannels, [3, 5, 6])
  // With no layout to place LFE, every channel counts, which makes the rule
  // harder to fire — the safe direction.
  const blind = R.channelVerdict(CV({ channelLayout: null, claim: '5.1', perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(blind.lfeChannel, null)
  assert.equal(blind.kind, 'surround')
})

test('channelVerdict does not call a wholly silent file a fake', () => {
  // If the fronts are dead too we measured silence, not a pad.
  const per = chans([-Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity])
  const v = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(v.kind, 'surround')
  assert.equal(v.aliveChannels, 0)
})

test('channelVerdict holds its fire on a track under 90 seconds', () => {
  // Short tracks on surround albums are disproportionately interludes and solo
  // acoustic pieces, which is exactly the near-miss class.
  const per = chans([-9.86, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity])
  const v = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: true, measuredChannels: 6, durationSec: 86 }))
  assert.equal(v.kind, 'surround')
  const over = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: true, measuredChannels: 6, durationSec: 90 }))
  assert.equal(over.kind, 'padded-channels', '90 s is the floor, not the exclusion')
})

test('channelVerdict says surround-unverified when the read cannot carry an opinion', () => {
  // One channel block came back without a parsable Peak level dB. This is the
  // explicit cannot-tell, not an error path.
  const per = chans([-9.86, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity])
  per[3].peakDb = null
  const v = R.channelVerdict(CV({ claim: '5.1', perChannel: per, complete: false, measuredChannels: 6 }))
  assert.equal(v.kind, 'surround-unverified')
  assert.equal(v.severity, 'plain')
  assert.equal(v.text, '')
  assert.equal(v.complete, false)
  assert.equal(v.silentChannels, null, 'no raw opinion escapes an unverified read')
  assert.equal(v.aliveChannels, null)
  assert.equal(v.fact, '6 channels (5.1)', 'the channel fact is still stated')
  // astats and ffprobe disagreeing on the count is the same cannot-tell: we are
  // then not looking at the stream we think we are.
  const disagree = R.channelVerdict(CV({ claim: '5.1', perChannel: chans([-9, -9]), complete: true, measuredChannels: 2 }))
  assert.equal(disagree.kind, 'surround-unverified')
  const padded = chans([-9.86, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity])
  const wrongCount = R.channelVerdict(CV({ claim: '5.1', perChannel: padded, complete: true, measuredChannels: 5 }))
  assert.equal(wrongCount.kind, 'surround-unverified', 'six blocks but astats counted five: no accusation')
  // No astats output at all is also the same cannot-tell.
  assert.equal(R.channelVerdict(CV({ claim: '5.1' })).kind, 'surround-unverified')
})

test('channelVerdict does not accuse a surround file that arrived truncated', () => {
  // The proven false accusation. ffmpeg exits 0 on a FLAC cut mid-stream, so
  // `if (stats.err)` in main.js never fires, and the container header still
  // reports the full duration. This capture is a genuine 120.000 s 6-channel
  // file whose surrounds enter at t=30 s, cut to 19.3 s of audio: six complete
  // channel blocks, four of them -inf, and every guard in the padding rule
  // satisfied.
  const c = R.parseChannels(TRUNCATED)
  assert.equal(c.channels, 6)
  assert.equal(c.complete, true, 'the truncated read looks complete, which is the whole trap')
  assert.deepEqual(c.perChannel.slice(2).map(x => x.peakDb), [-Infinity, -Infinity, -Infinity, -Infinity])
  const decodedSec = R.parseSampleCount(TRUNCATED) / 48000
  const input = {
    channels: 6, channelLayout: '5.1(side)', claim: '5.1', codec: 'flac', atmos: false,
    perChannel: c.perChannel, complete: c.complete, measuredChannels: c.channels,
    durationSec: 120, siblingHint: false,
  }
  // Without the decoded length there is nothing to catch it, and this is the
  // answer the app used to give about a genuine surround release.
  assert.equal(R.channelVerdict(input).kind, 'padded-channels')
  // With it, the honest answer.
  const v = R.channelVerdict({ ...input, decodedSec })
  assert.equal(v.kind, 'surround-unverified')
  assert.equal(v.severity, 'plain')
  assert.equal(v.text, '', 'it says nothing about fakery')
  assert.equal(v.complete, false)
  assert.equal(v.silentChannels, null)
  assert.equal(v.fact, '6 channels (5.1)', 'the channel count is still stated')
})

test('channelVerdict accepts a decoded length that matches the header', () => {
  // An intact file matches exactly — 86.665 s at 48000 Hz is 4,159,920 samples
  // — so the 2% slack is slack, not a working tolerance, and a complete read
  // still reaches a verdict.
  const per = chans([-9.86, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity])
  const input = {
    channels: 6, channelLayout: '5.1(side)', claim: '5.1', codec: 'flac',
    perChannel: per, complete: true, measuredChannels: 6, durationSec: 300,
  }
  assert.equal(R.channelVerdict({ ...input, decodedSec: 300 }).kind, 'padded-channels')
  assert.equal(R.channelVerdict({ ...input, decodedSec: 299 }).kind, 'padded-channels', '0.3% short is rounding')
  assert.equal(R.channelVerdict({ ...input, decodedSec: 290 }).kind, 'surround-unverified', '3% short is a cut file')
  // A missing decoded length is not evidence of anything, so it changes nothing.
  assert.equal(R.channelVerdict({ ...input, decodedSec: null }).kind, 'padded-channels')
  // Neither is a missing header duration: the 90 s floor already declines then.
  assert.equal(R.channelVerdict({ ...input, durationSec: null, decodedSec: 20 }).kind, 'surround')
})

test('channelVerdict only says the channels carry sound when they measurably do', () => {
  // Animals "Pigs On The Wing (Part One)": channels 3-6 at Peak -90.308734 /
  // RMS -108 dB, one LSB of 16-bit dither. That is not "sound", and the app
  // used to say it was. Failing the margin costs the sentence and nothing else
  // — the verdict stays good, and no accusation is ever reachable from here.
  const dither = chans([-9.86, -11.34, -90.31, -90.31, -90.31, -90.31])
  const quiet = R.channelVerdict({
    channels: 6, channelLayout: '5.1(side)', claim: '5.1', perChannel: dither,
    complete: true, measuredChannels: 6, durationSec: 300, codec: 'flac',
  })
  assert.equal(quiet.kind, 'surround')
  assert.equal(quiet.severity, 'good')
  assert.equal(quiet.text, '')
  // Animals "Dogs", the same release, a full-band track: the quietest non-LFE
  // channel peaks at -14.913804 and the LFE at -31.488449.
  const real = chans([-0.041718, 0.000265, -14.913804, -31.488449, -3.465414, -6.141519])
  const loud = R.channelVerdict({
    channels: 6, channelLayout: '5.1(side)', claim: '5.1', perChannel: real,
    complete: true, measuredChannels: 6, durationSec: 1024.525, codec: 'flac',
  })
  assert.equal(loud.kind, 'surround')
  assert.equal(loud.text,
    'All 6 channels carry sound — nothing is padded with silence. I only checked one track of {tracks}.')
  // LFE is outside the margin test, exactly as it is outside the liveness
  // tally: a genuine mix may hold it near digital zero all track.
  const quietLfe = chans([-1, -1, -3, -89, -5, -6])
  assert.match(R.channelVerdict({
    channels: 6, channelLayout: '5.1(side)', claim: '5.1', perChannel: quietLfe,
    complete: true, measuredChannels: 6, durationSec: 300, codec: 'flac',
  }).text, /^All 6 channels carry sound/)
})

test('channelVerdict reports a 5.1-listed folder whose track is plain stereo', () => {
  // The user's scar. This fires on the ffprobe integer alone, immune to every
  // astats trap.
  const v = R.channelVerdict(CV({ channels: 2, channelLayout: 'stereo', claim: '5.1', measuredChannels: 2, perChannel: chans([-9, -9]), complete: true }))
  assert.equal(v.kind, 'claim-mismatch')
  assert.equal(v.severity, 'warn')
  assert.equal(v.expected, 6)
  assert.equal(v.fact, 'stereo')
  assert.equal(v.text, 'Listed as 5.1, but the track I checked is plain stereo — 2 channels, not 6. I only checked one track of {tracks}.')
  const mono = R.channelVerdict(CV({ channels: 1, channelLayout: 'mono', claim: '5.1' }))
  assert.equal(mono.kind, 'claim-mismatch')
  assert.equal(mono.text, 'Listed as 5.1, but the track I checked is mono — 1 channel, not 6. I only checked one track of {tracks}.')
  // A claim with no number checks only surround vs not-surround.
  const atmos = R.channelVerdict(CV({ channels: 2, channelLayout: 'stereo', claim: 'ATMOS' }))
  assert.equal(atmos.kind, 'claim-mismatch')
  assert.equal(atmos.text, 'Listed as Atmos, but the track I checked is plain stereo — 2 channels. I only checked one track of {tracks}.')
  // The smallest-file branch is where a stereo bonus track gets picked.
  const small = R.channelVerdict(CV({ channels: 2, channelLayout: 'stereo', claim: '5.1', sampledSmallest: true }))
  assert.match(small.text, /This was the smallest file in the folder, which on a surround album is often a stereo bonus track\.$/)
})

test('channelVerdict downgrades to claim-unverified when a big sibling could be the mix', () => {
  const v = R.channelVerdict(CV({ channels: 2, channelLayout: 'stereo', claim: '5.1', siblingHint: true }))
  assert.equal(v.kind, 'claim-unverified')
  assert.equal(v.severity, 'plain')
  assert.equal(v.text, "The track I checked is plain stereo. Bigger files in this folder look like they could be the surround mix, so this doesn't mean the album isn't 5.1.")
})

test('channelVerdict reports a three-channel 2.1 under a 5.1 claim as claim-short', () => {
  // The ch >= 3 bound closes the hole where a 2.1 or 3.0(back) file under a 5.1
  // claim produced no verdict at all.
  const v = R.channelVerdict(CV({ channels: 3, channelLayout: '2.1', claim: '5.1', measuredChannels: 3, perChannel: chans([-9, -9, -9]), complete: true }))
  assert.equal(v.kind, 'claim-short')
  assert.equal(v.severity, 'warn')
  assert.equal(v.lfeChannel, 3)
  assert.equal(v.fact, '3 channels (2.1)')
  assert.equal(v.text, 'Listed as 5.1, but the track I checked has 3 channels (2.1), not 6.')
})

test('channelVerdict does not call an Atmos bed short of a 7.1 claim', () => {
  // 112 files here report profile=Dolby Digital Plus + Dolby Atmos with a
  // 6-channel bed while being object-based; ffprobe's count understates them.
  const per = chans([-9, -9, -9, -9, -9, -9])
  const v = R.channelVerdict(CV({ claim: '7.1', codec: 'eac3', atmos: true, perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(v.kind, 'surround')
  // A lossy codec alone is enough to decline the accusation.
  const lossy = R.channelVerdict(CV({ claim: '7.1', codec: 'dts', atmos: false, perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(lossy.kind, 'surround')
  // A FLAC really is only what it says it is.
  const flac = R.channelVerdict(CV({ claim: '7.1', codec: 'flac', perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(flac.kind, 'claim-short')
  assert.equal(flac.text, 'Listed as 7.1, but the track I checked has 6 channels (5.1), not 8.')
})

test('channelVerdict announces an unlabelled multichannel rip as a bonus', () => {
  const per = chans([-9, -9, -9, -9, -9, -9])
  const v = R.channelVerdict(CV({ perChannel: per, complete: true, measuredChannels: 6 }))
  assert.equal(v.kind, 'bonus-surround')
  assert.equal(v.severity, 'good')
  assert.equal(v.text, 'Not listed as surround, but the track I checked has 6 channels (5.1).')
})

test('channelVerdict reports plain stereo and mono without an opinion', () => {
  const s = R.channelVerdict(CV({ channels: 2, channelLayout: 'stereo', measuredChannels: 2, perChannel: chans([-9, -9]), complete: true }))
  assert.equal(s.kind, 'stereo')
  assert.equal(s.severity, 'plain')
  assert.equal(s.fact, 'stereo')
  assert.equal(s.text, '')
  const m = R.channelVerdict(CV({ channels: 1, channelLayout: 'mono', measuredChannels: 1, perChannel: chans([-9]), complete: true }))
  assert.equal(m.kind, 'mono')
  assert.equal(m.fact, 'mono')
  assert.equal(m.text, '')
  // Three channels with nothing claimed is the leftover case.
  const o = R.channelVerdict(CV({ channels: 3, channelLayout: null, measuredChannels: 3, perChannel: chans([-9, -9, -9]), complete: true }))
  assert.equal(o.kind, 'other')
  assert.equal(o.fact, '3 channels')
  assert.equal(o.text, '')
})

test('channelVerdict refuses to guess when ffprobe reports no channels', () => {
  // Six FLACs on this machine report channels=0 and exit 0.
  for (const ch of [0, null, undefined, NaN, 'N/A']) {
    const v = R.channelVerdict(CV({ channels: ch }))
    assert.equal(v.kind, 'unknown', String(ch))
    assert.equal(v.severity, 'unknown')
    assert.equal(v.fact, '', 'nothing is printed for a count we do not have')
    assert.equal(v.text, "Couldn't tell how many channels this track has.")
  }
  assert.equal(R.channelVerdict().kind, 'unknown')
})

test('pickTrack prefers the biggest audio file under 80 MB', () => {
  const files = [
    { name: 'a.flac', size: 30e6, length: 200 },
    { name: 'b.flac', size: 79e6, length: 600 },
    { name: 'c.flac', size: 200e6, length: 900 },
    { name: 'cover.jpg', size: 1e5 },
  ]
  assert.equal(R.pickTrack(files).name, 'b.flac')
})

test('pickTrack falls back to the smallest when everything is over 80 MB', () => {
  const files = [{ name: 'a.flac', size: 120e6, length: 1 }, { name: 'b.flac', size: 90e6, length: 1 }]
  assert.equal(R.pickTrack(files).name, 'b.flac')
})

test('pickTrackInfo is deterministic when slskd omits every length', () => {
  // The two under-cap files in the Animals folder. slskd often leaves `length`
  // out; a length-only comparator is then a no-op and selection falls to input
  // order, so whether the app accuses a genuine release would depend on whether
  // a stranger's client filled in an optional field.
  const files = [{ name: 'a.flac', size: 8164901 }, { name: 'b.flac', size: 11371400 }]
  assert.equal(R.pickTrackInfo(files).file.name, 'b.flac')
  assert.equal(R.pickTrackInfo(files.slice().reverse()).file.name, 'b.flac')
  assert.equal(R.pickTrackInfo(files).fallback, false)
})

test('pickTrackInfo flags the fallback when every file is over the cap', () => {
  const files = [{ name: 'a.flac', size: 448e6, length: 300 }, { name: 'b.flac', size: 139e6, length: 90 }]
  const p = R.pickTrackInfo(files)
  assert.equal(p.file.name, 'b.flac')
  assert.equal(p.fallback, true)
  assert.equal(R.pickTrackInfo([{ name: 'cover.jpg', size: 1e5 }]), null)
})

test('siblingSurroundHint spots a file big enough to be the surround mix', () => {
  const sampled = { name: 'bonus.flac', size: 8e6, length: 90 }          // ~89 kB/s
  const big = { name: '01.flac', size: 250e6, length: 359 }              // ~696 kB/s
  assert.equal(R.siblingSurroundHint([sampled, big], sampled), true)
  // A stereo sibling of ordinary size is not a hint.
  assert.equal(R.siblingSurroundHint([sampled, { name: '02.flac', size: 30e6, length: 340 }], sampled), false)
  assert.equal(R.siblingSurroundHint([sampled], sampled), false)
  assert.equal(R.siblingSurroundHint([sampled, { name: 'art.jpg', size: 250e6, length: 359 }], sampled), false)
})

test('siblingSurroundHint clears the 16-bit Blu-Ray rips it used to miss', () => {
  // The floor used to be 400,000 B/s. Measured with ffprobe on 2026-09-20, not
  // one genuine 16-bit Blu-Ray 5.1 track on this machine reaches that, so the
  // hint was dead for the commonest real surround format: the quiet
  // 'claim-unverified' outcome never fired and the app accused instead.
  const sampled = { name: 'bonus.flac', size: 8164901, length: 86.665 }  // 94,212 B/s
  const real = [
    ['04 - San Tropez.flac', 49171162, 223.0],                      // 220,498 B/s
    ['1-04 - Sheep.flac', 139111386, 618.74],                       // 224,830
    ['1-03 - Pigs (Three Different Ones).flac', 161471272, 686.855], // 235,088
    ['1-02 - Dogs.flac', 250229183, 1024.525],                      // 244,239
    ['03 - Lucy In The Sky With Diamonds.flac', 61030086, 207.072],  // 294,729
  ]
  for (const [name, size, length] of real) {
    const bps = size / length
    assert.ok(bps < 400000, name + ' really does sit under the old floor (' + Math.round(bps) + ')')
    assert.equal(R.siblingSurroundHint([sampled, { name, size, length }], sampled), true, name)
  }
  // The floor still rejects stereo. 16/44 stereo FLAC measured 52-115 kB/s over
  // 390 files here; this is a 24/44 stereo track at the top of that spread.
  assert.equal(R.siblingSurroundHint([sampled, { name: 'st.flac', size: 30e6, length: 200 }], sampled), false)
})

test('siblingSurroundHint works on size alone, because slskd often omits length', () => {
  // A hint that needs `length` is a hint a stranger's client can switch off.
  // Sizes always arrive, and inside one folder they carry the signal on their
  // own: measured over 182 real album folders here, the largest file is at most
  // 2.4x the file this code would sample in a stereo-only folder (95th
  // percentile) and only 3 of 124 reached 4x.
  const sampled = { name: 'bonus.flac', size: 18e6 }
  const mix = { name: '01.flac', size: 181e6 }
  assert.equal(R.siblingSurroundHint([sampled, mix], sampled), true,
    'a 181 MB sibling beside an 18 MB sample, with no durations anywhere')
  // Same pair, with the duration present: the answer must not depend on it.
  assert.equal(R.siblingSurroundHint(
    [{ ...sampled, length: 120 }, { ...mix, length: 300 }], { ...sampled, length: 120 }), true)
  // An ordinary spread of stereo track sizes is still no hint, so the user's
  // scar — a wholly stereo folder named for a 5.1 release — still gets warned
  // about. 3x is under the 4x floor.
  assert.equal(R.siblingSurroundHint([sampled, { name: '02.flac', size: 54e6 }], sampled), false)
  // Nothing to compare against invents nothing.
  assert.equal(R.siblingSurroundHint([{ name: 'a.flac' }, { name: 'b.flac' }], { name: 'a.flac' }), false)
})

test('slskdFailureReason tells a broken daemon apart from a peer saying no', () => {
  // Every one of these used to read "The peer did not accept the download:
  // slskd 500 on POST /transfers/downloads/<user>" — three wrong answers and a
  // path the user has no use for.
  const dead = new TypeError('fetch failed')
  assert.equal(R.slskdFailureReason(dead), 'Papa could not reach Soulseek on this machine. Check that it is running.')
  const gone = Object.assign(new Error('slskd 500 on POST /transfers/downloads/u'), { status: 500 })
  assert.equal(R.slskdFailureReason(gone), 'Soulseek had a problem on this machine and could not start the download.')
  const auth = Object.assign(new Error('x'), { status: 401 })
  assert.equal(R.slskdFailureReason(auth), 'Papa could not sign in to Soulseek. Check the Soulseek settings.')
  const busy = Object.assign(new Error('x'), { code: 'SLSKD_THROTTLED', throttled: true })
  assert.equal(R.slskdFailureReason(busy), 'Soulseek is handling too many requests right now. Give it a minute and try again.')
  const missing = Object.assign(new Error('x'), { status: 404 })
  assert.equal(R.slskdFailureReason(missing), 'The peer is not online any more, or no longer has that file.')
  const refused = Object.assign(new Error('x'), { status: 400 })
  assert.equal(R.slskdFailureReason(refused), 'The peer did not accept the download.')
  const twin = Object.assign(new Error('Dry run — POST ... was not performed'), { dryRun: true, code: 'DRY_RUN' })
  assert.equal(R.slskdFailureReason(twin), 'This is a test copy of the app, so nothing was downloaded.')
  // No sentence leaks an endpoint, a status number or the word slskd, and none
  // of them is empty.
  for (const e of [dead, gone, auth, busy, missing, refused, twin, undefined, null, {}]) {
    const s = R.slskdFailureReason(e)
    assert.ok(s.length > 10, JSON.stringify(s))
    assert.ok(!/\/transfers|slskd|POST |\b[45]\d\d\b/.test(s), s)
  }
})

test('isPcmFamily knows which codecs cannot understate their channel count', () => {
  for (const c of ['flac', 'alac', 'wav', 'pcm_s16le', 'ape', 'wavpack', 'aiff', 'aif']) {
    assert.equal(R.isPcmFamily(c), true, c)
  }
  for (const c of ['eac3', 'ac3', 'dts', 'mp3', 'opus', '', null]) {
    assert.equal(R.isPcmFamily(c), false, String(c))
  }
})

// ── Date guard: the taper-folder classes the first fix missed ────────────────
// Soulseek is full of live-show folders named for a date, and an unpadded date
// reads as "5.1" to detectSurround. Three shapes were measured returning a
// false claim after the first rewrite; widening the guard can only ever DROP a
// claim, never invent one, so it cannot turn a genuine rip into an accusation.
test('a date component before the token kills the claim however it is joined', () => {
  const dated = [
    'Grateful Dead 1977-5-1 Barton Hall',     // original case, joined by the token's separator
    'Grateful Dead 1977 5-1 Cornell',         // year spelled off with a SPACE
    'Phish 1995 5-1 Albany',
    'gd77 3-5-1 Fillmore East',               // ONE-digit component
    'Allman Brothers 1971 3-5-1 Fillmore',
    'Dead 9-5-1 show',
    'Zappa 6-5-1 Roxy',
  ]
  for (const name of dated) {
    assert.equal(R.accusableClaim('5.1', name), null, name)
  }
})

test('a real surround name still claims, however the year is written', () => {
  const real = [
    'Pink_Floyd.Wish_You_Were_Here_50_2011_5.1_Surround_Mix.BLURAY.FLAC.2025.401',
    'Artist.Album.2011.5.1.BluRay.FLAC',
    'Some Album (2016) 5.1 Surround',
    'Album 1977 5.1 Surround Mix',
    'DSOTM 5.1 DTS',
  ]
  for (const name of real) {
    assert.equal(R.accusableClaim('5.1', name), '5.1', name)
  }
})
