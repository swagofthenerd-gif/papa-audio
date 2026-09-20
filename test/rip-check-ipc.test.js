const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path'), vm = require('vm')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const { callSource } = require('./helpers/lift-ipc')
// Paren-balanced, so these assertions cannot pass on unrelated main.js that a
// fixed-width slice would drag in behind the handler.
const RIP = callSource(MAIN, 'slsk-verify-rip')

test('slsk-verify-rip exists, is exposed, and cleans up on every exit', () => {
  assert.ok(MAIN.includes("ipcMain.handle('slsk-verify-rip'"))
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(pre.includes("'slsk-verify-rip'"))
  assert.ok(RIP.includes('finally {'), 'cleanup runs in finally')
  assert.ok(RIP.includes('_ripCleanup('), 'cleanup helper is called')
})

test('slsk-verify-rip refuses to download in dry-run mode', () => {
  const guard = RIP.indexOf('if (DRY_RUN)')
  const call = RIP.indexOf('slskdFetch(')
  assert.ok(guard > 0 && guard < call, 'the dry-run refusal comes before the download request')
  assert.ok(RIP.includes('_dryRunRefusal('), 'it uses the standard refusal shape')
  // The handler's contract is {ok, reason}; the bare refusal only has `error`.
  assert.match(RIP.slice(guard, call), /reason: refusal\.error/,
    'the dry-run refusal also carries reason')
})

test('the ceiling probe builds one highpass+volumedetect pass per band', () => {
  const args = require('../src/rip-check').ceilingArgs('/x/a.flac', 20000)
  assert.deepEqual(args.slice(0, 2), ['-hide_banner', '-nostats'])
  assert.ok(args.join(' ').includes('highpass=f=20000'))
  assert.ok(args.join(' ').includes('volumedetect'))
})

test('astatsArgs and probeArgs name the file and ask for the fields the parsers read', () => {
  const R = require('../src/rip-check')
  assert.ok(R.astatsArgs('/x/a.flac').includes('/x/a.flac'))
  assert.ok(R.astatsArgs('/x/a.flac').join(' ').includes('astats'))
  // parseChannels needs one block per channel, and -map pins the same stream
  // ffprobe described. Note there is no -v error: astats logs at info level and
  // -v error would silence the whole measurement.
  assert.ok(R.astatsArgs('/x/a.flac').join(' ').includes('measure_perchannel=all'))
  assert.ok(R.astatsArgs('/x/a.flac').includes('-map'))
  assert.ok(!R.astatsArgs('/x/a.flac').includes('-v'))
  const p = R.probeArgs('/x/a.flac')
  assert.ok(p.includes('/x/a.flac'))
  assert.ok(p.join(' ').includes('sample_rate'))
  assert.ok(p.join(' ').includes('bits_per_raw_sample'))
  assert.ok(p.join(' ').includes('channels'))
  assert.ok(p.join(' ').includes('channel_layout'))
  assert.ok(p.join(' ').includes('duration'))
})

test('the corruption gate fires straight after the probe, before anything is measured', () => {
  // Six FLACs on this machine report channels=0, sample_rate=0 AND exit 0, so
  // the `if (probe.err)` check above cannot catch them. If the gate sat after
  // the astats or ceiling passes, those passes would measure a damaged file and
  // the app would report a confident verdict about nothing.
  const probe = RIP.indexOf('ripCheck.parseProbe(')
  const gate = RIP.indexOf('declared.channels === 0 && declared.sampleRate === 0')
  assert.ok(probe > 0, 'the handler still parses the probe')
  assert.ok(gate > probe, 'the gate reads what parseProbe returned')
  for (const later of ['ripCheck.astatsArgs(', 'ripCheck.parseAstats(', 'ripCheck.parseChannels(',
    'ripCheck.ceilingArgs(', 'ripCheck.parseCeiling(', 'ripCheck.channelVerdict(', 'ripCheck.verdict(']) {
    const at = RIP.indexOf(later)
    assert.ok(at > 0, later + ' is still called')
    assert.ok(gate < at, 'the corruption gate comes before ' + later)
  }
  assert.match(RIP.slice(gate, gate + 260),
    /reason: "This file wouldn't open properly — it looks damaged or incomplete\."/)
  // channels=0 with a usable sample rate is a different case and must survive
  // to channelVerdict's `unknown` rule, so the gate demands both.
  assert.ok(!RIP.includes('declared.channels === 0 ||'), 'the gate needs both zeroes, not either')
})

// Lift a run of handler source and run it. Pinning where a guard SITS proves
// nothing about what it DECIDES — the position assertions above stayed green
// through two conditions that were provably wrong — so every guard below is
// evaluated on real ffprobe and ffmpeg text instead.
function lift(fromNeedle, toNeedle, params, returns = 'null') {
  const from = RIP.indexOf(fromNeedle)
  assert.ok(from > 0, 'the handler still has ' + JSON.stringify(fromNeedle))
  const to = RIP.indexOf('\n', RIP.indexOf(toNeedle, from))
  assert.ok(to > from, 'the handler still has ' + JSON.stringify(toNeedle))
  const ctx = { ripCheck: require('../src/rip-check'), Date, Math, Number, out: null }
  vm.runInNewContext('out = (function (' + params.join(', ') + ') {\n' +
    RIP.slice(from, to) + '\nreturn ' + returns + '\n})', ctx)
  return ctx.out
}

test('the corruption gate refuses a zero-channel zero-rate file and nothing else', () => {
  const R = require('../src/rip-check')
  const fn = lift('if (declared.channels === 0', 'looks damaged or incomplete', ['declared'])
  // Real ffprobe output from one of the six FLACs on this machine that report
  // both zeroes and exit 0.
  const damaged = R.parseProbe('codec_name=flac\nsample_rate=0\nchannels=0\nchannel_layout=unknown\n')
  assert.deepEqual(fn(damaged),
    { ok: false, reason: "This file wouldn't open properly — it looks damaged or incomplete." })
  // channels=0 with a usable rate must survive to channelVerdict's `unknown`.
  assert.equal(fn(R.parseProbe('codec_name=flac\nsample_rate=44100\nchannels=0\n')), null)
  // And a rate of 0 with real channels must survive too — verdict() answers
  // that one, and it answers 'unknown', not 'genuine 24/?'.
  const noRate = R.parseProbe('codec_name=flac\nsample_rate=0\nchannels=6\nbits_per_raw_sample=24\n')
  assert.equal(fn(noRate), null)
  assert.equal(R.verdict({
    declaredRate: noRate.sampleRate, declaredBits: noRate.bitDepth,
    measuredBits: 24, ceilingHz: 20000, ext: 'flac',
  }).kind, 'unknown')
  assert.equal(fn(R.parseProbe('codec_name=flac\nsample_rate=48000\nchannels=6\n')), null)
})

test('the handler hands channelVerdict the length astats actually decoded', () => {
  // ffmpeg exits 0 on a truncated FLAC and its header still reports the full
  // duration, so `stats.err` above catches nothing. The decoded length is the
  // only thing that does, and the handler has to compute it or channelVerdict
  // cannot use it.
  const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')
  const fn = lift('const samples = ripCheck.parseSampleCount(', 'const decodedSec =',
    ['stats', 'declared'], 'decodedSec')
  const run = (file, rate) => fn({ stderr: fx(file) }, { sampleRate: rate })
  assert.equal(run('astats-animals-5.1.txt', 48000), 86.665, 'an intact file agrees with its header')
  assert.ok(Math.abs(run('astats-truncated-5.1.txt', 48000) - 19.3) < 0.01,
    'the truncated capture played 19.3 s of a file whose header says 120')
  assert.equal(run('astats-animals-5.1.txt', 0), null, 'no rate, no answer — never a zero')
  // And the value really reaches the verdict.
  const call = RIP.slice(RIP.indexOf('ripCheck.channelVerdict({'))
  assert.ok(call.slice(0, call.indexOf('})') + 2).includes('decodedSec'),
    'channelVerdict is given decodedSec')
})

test('the ceiling read is anchored, so a peer cannot write the verdict in a tag', () => {
  // volumedetect logs at ffmpeg's info level, which puts the input's tag dump
  // on the same stderr and BEFORE the filter output. This was an inline
  // unanchored regex in the handler and a non-global .match() takes the first
  // hit, so the tag won. The fixture is a real FLAC re-encoded with
  //   -metadata comment='mean_volume: -999.0 dB'
  const R = require('../src/rip-check')
  const forged = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'volumedetect-tag-injection.txt'), 'utf8')
  assert.equal(R.parseBandVolume(forged), -84.3)
  // The handler must not carry a regex of its own any more — one anchored
  // parser, tested, in the module the other anchored parsers live in.
  assert.ok(RIP.includes('ripCheck.parseBandVolume('), 'the handler uses the module parser')
  assert.ok(!/mean_volume:\s*\(/.test(RIP) && !RIP.includes('/mean_volume'),
    'the handler holds no mean_volume regex of its own')
  // A whole band sweep over forged text must produce the measurement, not -999
  // in every band, which would drive verdict() into its 'transcoded' branch.
  let bandText = ''
  for (const hz of [16000, 20000]) {
    const db = R.parseBandVolume(forged)
    bandText += `band=${hz} mean_volume: ${Number.isFinite(db) ? db : '-999'} dB\n`
  }
  assert.equal(R.parseCeiling(bandText), 20000, 'the forged -999 did not silence every band')
})

test('the handler owns a deadline that keeps its answer in the documented shape', () => {
  // The IPC budget can only reject the invoke with a thrown Error, and the
  // renderer reads {ok, reason} on every other exit. The handler's own worst
  // case is 180 s wait + 15 s ffprobe + 60 s astats + seven 60 s bands = 675 s,
  // so a 300 s budget cut legitimate checks off in exactly that broken way.
  const budget = Number((MAIN.match(/'slsk-verify-rip': (\d+),/) || [])[1])
  const deadline = (MAIN.match(/^const RIP_DEADLINE_MS = ([\d *]+)$/m) || [])[1]
    .split('*').reduce((a, b) => a * Number(b.trim()), 1)
  assert.ok(deadline > 675000, 'the handler deadline covers its own worst case: ' + deadline)
  assert.ok(budget > deadline, 'the IPC budget sits above the handler deadline, as a backstop')
  // And the deadline is enforced, not decorative: `budget()` clamps every child
  // process to the time left, so no stage can run past it.
  const clamp = lift('const expiry = Date.now() +', 'const budget =', ['RIP_DEADLINE_MS'], 'budget')
  assert.equal(clamp(600000)(60000), 60000, 'plenty of time left: the stage keeps its own timeout')
  assert.equal(clamp(10000)(60000), 10000, 'less time left than the stage wants: clamped')
  assert.equal(clamp(-5000)(60000), 1000, 'past the deadline: a floor, never a negative timeout')
  // Every out-of-time exit answers in the handler's shape.
  const exits = RIP.match(/return \{ ok: false, reason: RIP_OUT_OF_TIME \}/g) || []
  assert.ok(exits.length >= 2, 'the deadline is checked between stages, not once')
  assert.match(MAIN, /^const RIP_OUT_OF_TIME = '[^']*\.'$/m, 'and it says so in plain words')
})

// The claim lines lifted out of the real handler and run for real, so the
// "which text" rule is proven by evaluation rather than by a substring match.
const CLAIM_SRC = (() => {
  const from = RIP.indexOf('const seg =')
  const to = RIP.indexOf('\n', RIP.indexOf('ripCheck.accusableClaim(', from))
  assert.ok(from > 0 && to > from, 'the handler still computes the claim inline')
  return RIP.slice(from, to)
})()

function claimFor(folderPath, filename) {
  const sandbox = {
    path, folderPath, filename,
    ripCheck: require('../src/rip-check'),
    slskFilters: require('../src/slsk-filters'),
    out: null,
  }
  vm.runInNewContext(CLAIM_SRC + '\nout = claim', sandbox)
  return sandbox.out
}

test('the claim is read from the folder name and the sampled file name, and nothing else', () => {
  // The folder itself claims 5.1: that is the case the feature exists for.
  assert.equal(claimFor('Pink Floyd - Animals (2022 BluRay 5.1)', '1-01 Pigs On The Wing.flac'), '5.1')
  // The sampled file's own basename counts too.
  assert.equal(claimFor('Artist - Album', 'Artist - Album/02 Song (5.1 mix).flac'), '5.1')
  // An ancestor segment does NOT: a share path like this would otherwise stamp
  // a 5.1 claim on every album underneath it and accuse all of them.
  assert.equal(claimFor('@@someone/5.1 Surround Collection/Artist - Album', '01 Track.flac'), null)
  // Only the basename of the sampled file is read, so a directory component of
  // the filename cannot smuggle a claim in either.
  assert.equal(claimFor('Artist - Album', '5.1 Surround Collection/01 Track.flac'), null)
  // Sibling filenames cannot reach the claim at all: `files` is not in scope of
  // the computation, so one "(5.1 mix).flac" among eleven stereo tracks cannot
  // make the album claim 5.1.
  assert.ok(!/\bfiles\b/.test(CLAIM_SRC), 'the claim never looks at the sibling list')
  // The narrowing survives the trip: an unpadded date-named taper folder reads
  // as 5.1 to detectSurround and must not accuse.
  assert.equal(claimFor('Grateful Dead 1977-5-1 Barton Hall', 'gd77-5-1d1t01.flac'), null)
  assert.equal(claimFor('Some Album [5.1GB]', '01 Track.flac'), null)
  // ...but the narrowing must not eat the dominant real surround naming style.
  // This folder is on the user's own disk, and it used to produce no claim at
  // all — so a stereo file inside it got no warning, which is the exact case
  // the whole check exists for.
  assert.equal(claimFor(
    'Pink_Floyd.Wish_You_Were_Here_50_2011_5.1_Surround_Mix.BLURAY.FLAC.2025.401',
    '01 Shine On You Crazy Diamond.flac'), '5.1')
  assert.equal(claimFor('Artist.Album.2011.5.1.BluRay.FLAC', '01 Track.flac'), '5.1')
  // Both sources go through accusableClaim, never detectSurround's raw label.
  assert.ok(CLAIM_SRC.includes('ripCheck.accusableClaim('), 'the raw label is narrowed')
})

test('a failed download request names the real fault and leaks no endpoint', () => {
  // Every slskd-side failure used to be reported as the peer's refusal and
  // every one of them printed the internal path: a dead local daemon, an
  // expired token and a 429 all read "The peer did not accept the download:
  // slskd 500 on POST /transfers/downloads/<user>".
  const R = require('../src/rip-check')
  const fn = lift('// A dead daemon, an expired token', 'ripCheck.slskdFailureReason(e)', ['e'])
  const cases = [
    [new TypeError('fetch failed'), /could not reach Soulseek/],
    [Object.assign(new Error('slskd 500 on POST /transfers/downloads/bob'), { status: 500 }), /problem on this machine/],
    [Object.assign(new Error('x'), { status: 401 }), /could not sign in/],
    [Object.assign(new Error('x'), { code: 'SLSKD_THROTTLED', throttled: true }), /too many requests/],
    [Object.assign(new Error('x'), { status: 400 }), /peer did not accept/],
  ]
  for (const [err, want] of cases) {
    const out = fn(err)
    assert.equal(out.ok, false)
    assert.match(out.reason, want)
    assert.ok(!/\/transfers|slskd|POST /.test(out.reason), out.reason)
  }
  // The handler no longer pastes the thrown message into the sentence.
  assert.ok(!RIP.includes("'The peer did not accept the download: '"))
  assert.equal(R.slskdFailureReason(cases[0][0]), fn(cases[0][0]).reason)
})

test('the channel block is added without disturbing any field the dossier already reads', () => {
  const ret = RIP.slice(RIP.indexOf('return { ok: true, verdict,'))
  for (const pinned of ['verdict,', 'ceilingHz,', 'measuredBits: measured.measuredBits',
    'declaredBits: declared.bitDepth', 'declaredRate: declared.sampleRate',
    'track: path.basename(filename)', 'at: Date.now()']) {
    assert.ok(ret.includes(pinned), pinned + ' is still returned unchanged')
  }
  // Absent is not zero, still.
  assert.ok(ret.includes('measured.dynamicRange === null || measured.dynamicRange === undefined ? null : measured.dynamicRange'))
  // verdict() keeps its own closed kind set: the channel answer is a separate
  // object, because verdict.kind drives the CSS class and the tick/warn glyph.
  assert.ok(RIP.includes('const verdict = ripCheck.verdict({'))
  assert.ok(!/ripCheck\.verdict\(\{[^}]*chan/.test(RIP), 'the channel answer never feeds verdict()')
  // Every input channelVerdict's rules read. A dropped siblingHint turns the
  // quiet "this doesn't mean the album isn't 5.1" into a warning that accuses,
  // and a dropped sampledSmallest drops the sentence saying the sample was the
  // smallest file in the folder.
  const call = RIP.slice(RIP.indexOf('ripCheck.channelVerdict({'))
  const args = call.slice(0, call.indexOf('})') + 2)
  for (const arg of ['channels: declared.channels', 'channelLayout: declared.channelLayout', 'claim,',
    'perChannel: chans.perChannel', 'complete: chans.complete', 'measuredChannels: chans.channels',
    'codec: declared.codec', 'atmos: declared.atmos', 'durationSec: declared.duration',
    'siblingHint: ripCheck.siblingSurroundHint(files || [], track)', 'sampledSmallest: pick.fallback']) {
    assert.ok(args.includes(arg), 'channelVerdict is given ' + arg)
  }
  for (const added of ['channels: declared.channels', 'channelLayout: declared.channelLayout',
    'atmos: declared.atmos', 'durationSec: declared.duration', 'sampledBytes:',
    'sampledSmallest: pick.fallback', 'claimLabel: claim', 'channelCheck: chan']) {
    assert.ok(ret.includes(added), added + ' is returned')
  }
  // Scope fence: the rip block states what it measured, and no other surround
  // surface changes. One track is not an album, and silently overriding the
  // shelf from one sampled track puts the 5.1 scar back from the other side.
  const code = RIP.replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/album\.surround|upgradeReason|tierOf|slskShelves|store\.set/.test(code),
    'nothing here writes back to album surround or shelf membership')
})
