'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')

// A cached track carries the artPath parseTrackFile wrote for it. The scan's
// cache hit used to trust that path without looking, and parseTrackFile is the
// only thing that ever writes the art — so once a cover file went missing, the
// file's mtime and size had not changed, it was never re-parsed, and the album
// stayed coverless for good. Found live: 97 of 249 albums pointed at artwork
// that was no longer on disk.
test('a cache hit is refused when the cover file has gone missing', () => {
  const at = MAIN.indexOf('const cache = readJsonSafe(TRACK_CACHE_PATH()')
  assert.ok(at > -1, 'the track cache read must still be there')
  const body = MAIN.slice(at, MAIN.indexOf('writeJsonAtomic(TRACK_CACHE_PATH()', at))
  assert.match(body, /cached\.size === st\.size &&\s*\n\s*!coverIsGone\(cached\.track\)/,
    'the cache hit must also require the cover to still exist')
  assert.match(body, /function|const coverIsGone/, 'the check must be defined')
})

test('the cover check costs one directory listing, not a stat per track', () => {
  const at = MAIN.indexOf('const artOnDisk =')
  assert.ok(at > -1, 'the artwork listing must be read once up front')
  const body = MAIN.slice(at, at + 700)
  assert.match(body, /fs\.promises\.readdir\(artworkDir\)/,
    'one readdir, awaited — the scan phase must not block the loop')
  assert.match(body, /new Set\(/, 'membership must be a set lookup')
  assert.ok(!/existsSync/.test(body.slice(0, body.indexOf('coverIsGone'))),
    'a stat per track would run for every file in the library on every scan')
})

test('an unreadable artwork directory believes the cache rather than rescanning everything', () => {
  const at = MAIN.indexOf('const artOnDisk =')
  const body = MAIN.slice(at, at + 900)
  assert.match(body, /\.catch\(\(\) => null\)/, 'a failed readdir must be distinguishable')
  assert.match(body, /if \(!artOnDisk \|\| !track \|\| !track\.artPath\) return false/,
    'null must mean "do not re-parse", not "re-parse the whole library"')
})
