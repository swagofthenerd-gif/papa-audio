'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const RENDERER = root('src/renderer.js')

// The formatters live in a classic script with no exports, so they are lifted
// out and run. Reading them could not catch an off-by-one in a unit conversion.
function lift(from, to, ret) {
  const a = RENDERER.indexOf(from)
  const b = RENDERER.indexOf(to)
  assert.ok(a >= 0 && b > a, `could not lift ${from}`)
  // eslint-disable-next-line no-new-func
  return new Function(RENDERER.slice(a, b) + '; return ' + ret)()
}

// ── 5.1 and 5.2: fmtDur ────────────────────────────────────────────────────

test('fmtDur does not call zero unknown', () => {
  // `!sec` treated 0 as unknown, so the elapsed readout showed an em dash for
  // the first second of every track -- and "-—" as a track ended in remaining
  // mode.
  const fmtDur = lift('function fmtDur(sec)', 'function fmtTime(sec)', 'fmtDur')
  assert.strictEqual(fmtDur(0), '0:00')
  assert.strictEqual(fmtDur(1), '0:01')
  assert.strictEqual(fmtDur(59), '0:59')
})

test('fmtDur has an hours component', () => {
  // An hour-long file -- a live set, a DJ mix, a single classical movement --
  // read as "60:00".
  const fmtDur = lift('function fmtDur(sec)', 'function fmtTime(sec)', 'fmtDur')
  assert.strictEqual(fmtDur(3599), '59:59')
  assert.strictEqual(fmtDur(3600), '1:00:00')
  assert.strictEqual(fmtDur(3661), '1:01:01')
  assert.strictEqual(fmtDur(7325), '2:02:05')
  assert.strictEqual(fmtDur(86399), '23:59:59')
})

test('fmtDur reports unknown only when it is unknown', () => {
  const fmtDur = lift('function fmtDur(sec)', 'function fmtTime(sec)', 'fmtDur')
  // Number(null) and Number('') are both 0, which would render unknown as 0:00
  // -- the opposite of the bug being fixed.
  for (const v of [null, undefined, '', NaN, 'abc', {}]) {
    assert.strictEqual(fmtDur(v), '—', String(v))
  }
  // And a negative is not "-1:-1" any more.
  assert.strictEqual(fmtDur(-1), '0:00')
  assert.strictEqual(fmtDur(-3600), '0:00')
})

// ── 5.3: .NET TimeSpans ────────────────────────────────────────────────────

test('a TimeSpan past 24 hours parses to the right number of seconds', () => {
  // slskd is .NET: a TimeSpan serialises as [d.]hh:mm:ss[.fffffff], and the day
  // part only appears past a day -- exactly when the number matters. Splitting
  // on ':' and calling the first field hours made 1d 2h 3m 4s read as "1h 4m".
  const _hmsToSecs = lift('function _hmsToSecs(hms)', 'function _fmtEta(s)', '_hmsToSecs')
  assert.strictEqual(_hmsToSecs('1.02:03:04'), 93784)
  assert.strictEqual(_hmsToSecs('2.00:00:00'), 172800)
  assert.strictEqual(_hmsToSecs('10.00:00:00'), 864000)
  // Fractional seconds are dropped, not misread as a day.
  assert.strictEqual(_hmsToSecs('00:00:30.5000000'), 30)
  assert.strictEqual(_hmsToSecs('1.00:00:00.5000000'), 86400)
})

test('a short TimeSpan is counted from the right, not the left', () => {
  // A single field was read as hours, so "30" became thirty hours.
  const _hmsToSecs = lift('function _hmsToSecs(hms)', 'function _fmtEta(s)', '_hmsToSecs')
  assert.strictEqual(_hmsToSecs('30'), 30)
  assert.strictEqual(_hmsToSecs('01:04'), 64)
  assert.strictEqual(_hmsToSecs('10:00:00'), 36000)
  assert.strictEqual(_hmsToSecs(''), 0)
  assert.strictEqual(_hmsToSecs(null), 0)
  assert.strictEqual(_hmsToSecs('garbage'), 0)
})

test('an ETA over a day is stated in days', () => {
  const _fmtSecs = lift('function _fmtSecs(secs)', 'function _dlFileName(filename)', '_fmtSecs')
  assert.strictEqual(_fmtSecs(93784), '1d 2h')
  assert.strictEqual(_fmtSecs(172800), '2d 0h')
  assert.strictEqual(_fmtSecs(3661), '1h 1m')
  assert.strictEqual(_fmtSecs(64), '1m 4s')
  assert.strictEqual(_fmtSecs(30), '30s')
  assert.strictEqual(_fmtSecs(0), '')
})

test('the two ETA readers share one parser', () => {
  // They did not, so _fmtEta had the same day bug independently.
  const fn = RENDERER.slice(RENDERER.indexOf('function _fmtEta(s)'),
                            RENDERER.indexOf('function _fmtEta(s)') + 260)
  assert.match(fn, /_hmsToSecs\(s\)/)
  assert.doesNotMatch(fn, /s\.split\(':'\)/)
})

// ── 5.4: bytes ─────────────────────────────────────────────────────────────

test('a sub-kilobyte size is stated in bytes', () => {
  // The B branch fired only for exactly zero, so a 1-byte file read "0.0 KB".
  const _fmtBytes = lift('const _BYTE_UNITS', 'function _fmtSpeed(bps)', '_fmtBytes')
  assert.strictEqual(_fmtBytes(1), '1 B')
  assert.strictEqual(_fmtBytes(500), '500 B')
  assert.strictEqual(_fmtBytes(1023), '1023 B')
  assert.strictEqual(_fmtBytes(1024), '1.0 KB')
  assert.strictEqual(_fmtBytes(0), '0 B')
  assert.strictEqual(_fmtBytes(-5), '0 B')
  assert.strictEqual(_fmtBytes(null), '0 B')
})

test('a terabyte is a terabyte', () => {
  // "1024.00 GB" -- and the storage report totals a multi-terabyte library.
  const _fmtBytes = lift('const _BYTE_UNITS', 'function _fmtSpeed(bps)', '_fmtBytes')
  assert.strictEqual(_fmtBytes(1099511627776), '1.00 TB')
  assert.strictEqual(_fmtBytes(1099511627776 * 4), '4.00 TB')
  assert.strictEqual(_fmtBytes(1125899906842624), '1.00 PB')
  // And it never runs off the end of the unit table.
  assert.match(_fmtBytes(Number.MAX_SAFE_INTEGER), / PB$/)
})

// ── 5.5: the 5.1 detector ──────────────────────────────────────────────────

test('a movement number is not a channel layout', () => {
  // `\s` in the separator class reintroduced the very error the mandatory
  // separator was added to prevent. And this is not only a badge: the result is
  // a sort key for search results, it drives the surround-only filter and its
  // count, and a falsely-surround anchor EXCLUDES genuinely matching folders
  // from an album download group.
  const { detectSurround } = require('../src/slsk-filters.js')
  for (const t of [
    'Beethoven Symphony 5 1st Movement',
    'Bach BWV 5 1 Aria',
    'Disc 5 1 of 3',
    'Album 51 Greatest Hits',
    'Track 5 1996 remaster',
    'Symphony No 5.1st mvt',
    'Mahler 7 1st movement',
    'Piano Sonata 7 1 Allegro',
  ]) {
    const r = detectSurround(t)
    assert.strictEqual(r, null, `${t} -> ${r && r.label}`)
  }
})

test('a real surround label is still detected', () => {
  const { detectSurround } = require('../src/slsk-filters.js')
  const expect = {
    'Dark Side of the Moon 5.1 SACD': '5.1',
    'Album [5_1 mix]': '5.1',
    'Something 5-1ch': '5.1',
    'Tubular Bells 7.1': '7.1',
    'The Wall (5.1 Surround)': '5.1',
    'foo.5.1.flac': '5.1',
    'Aja (Dolby Atmos)': 'ATMOS',
  }
  for (const [t, label] of Object.entries(expect)) {
    const r = detectSurround(t)
    assert.ok(r, `${t} was not detected at all`)
    assert.strictEqual(r.label, label, t)
  }
})

// ── 5.6: normalizeName ─────────────────────────────────────────────────────

test('normalizeName does not eat letters out of titles', () => {
  // A plain substring replace with no word boundary, and 'remaster' before
  // 'remastered', so the shorter word destroyed the longer from the inside.
  const { normalizeName } = require('../src/library-manage.js')
  assert.strictEqual(normalizeName('The Snow Goose Remastered'), 'the snow goose')
  assert.strictEqual(normalizeName('The Snow Goose (Remastered)'), 'the snow goose')
  assert.strictEqual(normalizeName('The Snow Goose'), 'the snow goose')
  // Legitimate titles that were being mangled.
  assert.strictEqual(normalizeName('Editions of You'), 'editions of you')
  assert.strictEqual(normalizeName('Mixed Emotions'), 'mixed emotions')
  assert.strictEqual(normalizeName('Remixes'), 'remixes')
  assert.strictEqual(normalizeName('Atmospheres'), 'atmospheres')
})

test('normalizeName never reduces a title to nothing', () => {
  // "Stereo" as an album name is an album called Stereo; emptying it makes it
  // match every other untitled thing in the library.
  const { normalizeName } = require('../src/library-manage.js')
  for (const t of ['Stereo', 'Surround', 'Mix', 'Edition', 'Deluxe', 'Atmos', 'FLAC']) {
    assert.notStrictEqual(normalizeName(t), '', t + ' became empty')
  }
})

test('the two spellings of one album are seen as duplicates', () => {
  // This is the job the function exists to do, and it returned [].
  const { findDuplicates } = require('../src/library-manage.js')
  const tracks = [
    { filePath: '/m/Camel - The Snow Goose (Remastered)/01.flac', albumArtist: 'Camel',
      album: 'The Snow Goose (Remastered)', duration: 200, size: 1e6, title: 'Great Marsh' },
    { filePath: '/m/Camel - The Snow Goose Remastered/01.flac', albumArtist: 'Camel',
      album: 'The Snow Goose Remastered', duration: 200, size: 1e6, title: 'Great Marsh' },
  ]
  const groups = findDuplicates(tracks)
  assert.strictEqual(groups.length, 1)
  assert.strictEqual(groups[0].key, 'camel :: the snow goose')
  assert.strictEqual(groups[0].folders.length, 2)
})

test('two genuinely different albums are still not duplicates', () => {
  const { findDuplicates } = require('../src/library-manage.js')
  const tracks = [
    { filePath: '/m/Camel - Mirage/01.flac', albumArtist: 'Camel', album: 'Mirage', duration: 200, size: 1e6, title: 'Freefall' },
    { filePath: '/m/Camel - Moonmadness/01.flac', albumArtist: 'Camel', album: 'Moonmadness', duration: 200, size: 1e6, title: 'Aristillus' },
  ]
  assert.deepStrictEqual(findDuplicates(tracks), [])
})

// ── 5.7: one download-state classifier ─────────────────────────────────────

test('every state slskd emits classifies the same way on both sides', () => {
  const D = require('../src/dl-state.js')
  const MAIN = root('main.js')
  // main's dlClassify is now a thin wrapper, so the shared module IS both
  // answers. The assertion is that neither side has its own table any more.
  assert.match(MAIN, /const dlState_ = require\('\.\/src\/dl-state'\)/)
  const fn = MAIN.slice(MAIN.indexOf('function dlClassify(stateStr)'),
                        MAIN.indexOf('function dlClassify(stateStr)') + 400)
  assert.match(fn, /dlState_\.classify\(stateStr\)/)
  assert.doesNotMatch(fn, /indexOf\('Completed'\)/, "only checked whether it STARTS WITH Completed")
  assert.match(RENDERER, /window\.PapaDlState\.classify\(stateStr\)/)
  assert.match(RENDERER, /window\.PapaDlState\.label\(stateStr\)/)
  // And the module is actually loaded in the renderer.
  const HTML = root('src/index.html')
  assert.match(HTML, /<script src="dl-state\.js"><\/script>/)
})

test('Scheduled is active, and is labelled as such', () => {
  // The renderer filed Scheduled under FAILED while its own label table called
  // it "Waiting", so a scheduled transfer appeared in the Failed tab labelled
  // "Waiting".
  const D = require('../src/dl-state.js')
  assert.strictEqual(D.classify('Scheduled'), 'active')
  assert.strictEqual(D.label('Scheduled').label, 'Waiting')
})

test('a bare failure is over, not running', () => {
  // main said active, because it only checked for a leading "Completed" -- so
  // the scheduler treated a failed transfer as still running and never recorded
  // the failure, leaving the file un-resourced until the 20-minute stall timer.
  const D = require('../src/dl-state.js')
  for (const s of ['Failed', 'Aborted', 'TimedOut', 'Rejected', 'Errored']) {
    assert.strictEqual(D.classify(s), 'failed', s)
    assert.strictEqual(D.isActive(s), false, s)
    assert.strictEqual(D.isFinished(s), true, s)
  }
})

test('an unknown or empty state is finished, not active', () => {
  // Treating an unknown as active is what made the scheduler wait on transfers
  // that were never coming back.
  const D = require('../src/dl-state.js')
  for (const s of ['', null, undefined, 'None', 'SomethingNewInSlskd', 'Completed']) {
    assert.strictEqual(D.classify(s), 'failed', String(s))
  }
})

test('the full flag set slskd emits is classified as expected', () => {
  const D = require('../src/dl-state.js')
  const expect = {
    'Requested': 'active',
    'Queued': 'active',
    'Queued, Remotely': 'active',
    'Initializing': 'active',
    'Initialising': 'active',
    'InProgress': 'active',
    'Scheduled': 'active',
    'Completed, Succeeded': 'completed',
    'Completed, Errored': 'failed',
    'Completed, Cancelled': 'cancelled',
    'Completed, TimedOut': 'failed',
    'Completed, Rejected': 'failed',
  }
  for (const [s, kind] of Object.entries(expect)) {
    assert.strictEqual(D.classify(s), kind, s)
  }
})

test('every label the module can produce carries a class', () => {
  // A label with no class renders as unstyled text next to styled siblings.
  const D = require('../src/dl-state.js')
  for (const s of ['InProgress', 'Scheduled', 'Completed, Succeeded', 'Failed',
                   'Cancelled', 'Completed', '', 'Nonsense']) {
    const l = D.label(s)
    assert.ok(l.cls, `${JSON.stringify(s)} produced no class`)
    assert.ok(l.label, `${JSON.stringify(s)} produced no label`)
  }
})

// ── 5.8: a null eq must not silence the app ────────────────────────────────

test('buildAfGraph survives a null eq', () => {
  // normalize's default parameter defended against undefined and not null, and
  // getPlayerSettings spreads the persisted settings over the defaults, so a
  // stored `eq: null` won and reached it. buildAfGraph(null) then threw inside
  // _args(), inside start() -- a confusing start-error with no audio at all.
  const eq = require('../eq.js')
  for (const v of [null, undefined, 0, '', false, [], NaN, 'nonsense']) {
    assert.doesNotThrow(() => eq.buildAfGraph(v), String(v))
    assert.strictEqual(eq.buildAfGraph(v), '', String(v))
  }
})

test('a real eq still builds its filter graph', () => {
  const eq = require('../eq.js')
  const out = eq.buildAfGraph({ enabled: true, preamp: 3, gains: [1, 2] })
  assert.match(out, /volume=volume=3/)
  assert.match(out, /equalizer=/)
})
