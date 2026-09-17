'use strict'
// Resolving a finished download must not match a generic bare filename first.
//
// "01.flac" and "Track 03.mp3" are names dozens of albums share, so a match on
// one sitting loose in the download root plays an unrelated song and "Show in
// folder" opens the wrong file. With autoOrganizeDownloads on, the same wrong
// path is what the organiser moves.
//
// The guard for this already existed — but it was applied only to the LAST
// candidate, while for a two-segment remote path (the commonest Soulseek
// shape) the bare basename was candidate #0 and was checked FIRST.
//
// The real functions are lifted out of main.js and executed.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift() {
  const g = MAIN.match(/function slskGenericBaseName[\s\S]*?\n}/)
  const c = MAIN.match(/function slskCandidatePaths[\s\S]*?\n}/)
  assert.ok(g, 'slskGenericBaseName must still exist')
  assert.ok(c, 'slskCandidatePaths must still exist')
  return new Function('path', `${g[0]}\n${c[0]}\nreturn { slskCandidatePaths, slskGenericBaseName }`)(path)
}
const { slskCandidatePaths, slskGenericBaseName } = lift()

const DD = '/mnt/data/MUSIC/Downloads'
const idx = (list, p) => list.indexOf(p)

test('a generic bare name is never the first thing checked', () => {
  const c = slskCandidatePaths('Best Of\\01.flac', 'peer', DD)
  assert.ok(slskGenericBaseName('01.flac'), 'premise: 01.flac is a generic name')
  assert.notStrictEqual(c[0], path.join(DD, '01.flac'),
    'checking the bare name first is what plays the wrong song')
  const bare = idx(c, path.join(DD, '01.flac'))
  const qualified = idx(c, path.join(DD, 'Best Of', '01.flac'))
  assert.ok(qualified > -1, 'the qualified path must still be a candidate')
  assert.ok(bare === -1 || bare > qualified,
    'the qualified path must be tried before the bare one')
})

test('the same holds for a spaced generic name', () => {
  const c = slskCandidatePaths('Greatest\\Track 03.mp3', 'peer', DD)
  const bare = idx(c, path.join(DD, 'Track 03.mp3'))
  const qualified = idx(c, path.join(DD, 'Greatest', 'Track 03.mp3'))
  assert.ok(bare === -1 || bare > qualified)
})

test('a distinctive filename is unaffected and still resolves early', () => {
  const c = slskCandidatePaths('Artist\\Album\\05 - Song Title.flac', 'peer', DD)
  assert.strictEqual(slskGenericBaseName('05 - Song Title.flac'), false)
  assert.strictEqual(c[0], path.join(DD, 'Album', '05 - Song Title.flac'),
    'ordinary resolution must not be slowed down by the guard')
})

test('a flat download can still be found — the generic name is kept, just last', () => {
  // Dropping it outright would break a genuinely flat download.
  const c = slskCandidatePaths('Best Of\\01.flac', 'peer', DD)
  assert.ok(c.includes(path.join(DD, '01.flac')),
    'still reachable as a last resort, or a flat download never resolves')
})

test('every candidate stays inside the download directory', () => {
  const nasty = '..\\..\\etc\\passwd'
  for (const c of slskCandidatePaths(nasty, 'peer', DD)) {
    assert.ok(path.resolve(c).startsWith(path.resolve(DD) + path.sep) || path.resolve(c) === path.resolve(DD),
      'a peer-supplied name must never resolve outside the download root: ' + c)
  }
})

test('an empty or junk filename yields nothing rather than the download root', () => {
  assert.deepStrictEqual(slskCandidatePaths('', 'peer', DD), [])
  assert.deepStrictEqual(slskCandidatePaths(null, 'peer', DD), [])
})
