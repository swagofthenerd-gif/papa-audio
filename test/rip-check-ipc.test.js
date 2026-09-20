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
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-verify-rip'"), MAIN.indexOf("ipcMain.handle('slsk-verify-rip'") + 6000)
  assert.ok(body.includes('finally {'), 'cleanup runs in finally')
  assert.ok(body.includes('_ripCleanup('), 'cleanup helper is called')
})

test('slsk-verify-rip refuses to download in dry-run mode', () => {
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-verify-rip'"), MAIN.indexOf("ipcMain.handle('slsk-verify-rip'") + 6000)
  const guard = body.indexOf('if (DRY_RUN)')
  const call = body.indexOf('slskdFetch(')
  assert.ok(guard > 0 && guard < call, 'the dry-run refusal comes before the download request')
  assert.ok(body.includes('_dryRunRefusal('), 'it uses the standard refusal shape')
  // The handler's contract is {ok, reason}; the bare refusal only has `error`.
  assert.match(body.slice(guard, call), /reason: refusal\.error/,
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
  // Both sources go through accusableClaim, never detectSurround's raw label.
  assert.ok(CLAIM_SRC.includes('ripCheck.accusableClaim('), 'the raw label is narrowed')
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
