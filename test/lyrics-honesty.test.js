'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

// When LRCLIB returns UNSYNCED lyrics, the renderer spreads the lines evenly
// across the track's duration so they scroll. That is a reasonable way to show
// them and a terrible thing to let anything else believe: nothing downstream
// distinguished those invented times from real ones, so the panel highlighted
// the wrong line, clicking a line jumped playback to an arbitrary point, and
// — worst — "Search & save lyrics" wrote them to disk as a real timed .lrc.
// A sidecar takes absolute priority on every future play, so a file of guessed
// timings permanently beats the genuine synced lyrics LRCLIB may publish later,
// with no way to remove it from inside the app.
test('invented timings are marked as invented', () => {
  assert.match(R, /return paras\.map\(\(text, i\) => \(\{ time: i \* step, text, estimated: true \}\)\)/,
    'spread-evenly lines must carry a flag, or nothing downstream can tell')
})

test('guessed timings are never written to disk as a timed .lrc', () => {
  const fnAt = R.indexOf('async function searchAndSaveLyrics')
  const body = R.slice(fnAt, R.indexOf('\n}', R.indexOf('showToast', fnAt)) + 2)
  assert.match(body, /const estimated = fetched\.some\(l => l && l\.estimated\)/,
    'the save path must know whether the times were real')
  assert.match(body, /estimated\s*\n?\s*\? fetched\.map\(l => l\.text\)\.join/,
    'and write the text alone when they were not')
  const bracketAt = body.indexOf('`[${String(mins)')
  const guardAt = body.indexOf('const estimated =')
  assert.ok(guardAt > 0 && guardAt < bracketAt,
    'the timestamp branch must sit behind the check, not in front of it')
})

test('the listener is told the saved lyrics will not scroll', () => {
  assert.match(R, /unsynced, so they will not scroll with the song/,
    'saying "saved" alone would imply the timing was real')
})

test('a line with a guessed time is not clickable', () => {
  const fnAt = R.indexOf('function _bindLyricsSeek')
  const body = R.slice(fnAt, R.indexOf('\n}', fnAt) + 2)
  assert.match(body, /_lyrics\.some\(l => l && l\.estimated\)/)
  const guardAt = body.indexOf('estimated')
  const bindAt = body.indexOf("addEventListener('click'")
  assert.ok(guardAt > 0 && guardAt < bindAt, 'the guard returns before anything is bound')
  assert.match(body, /return\n?\s*\}/, 'and it really does return')
})

test('and does not look clickable either', () => {
  assert.match(CSS, /\.lyrics-unsynced \.lyrics-line[\s\S]{0,120}cursor: default/,
    'a pointer cursor on a guessed line still promises a seek')
})

test('real synced lyrics are unaffected', () => {
  // The synced branch returns before the spreading code is ever reached.
  const at = R.indexOf('if (res.synced?.length) return res.synced.filter(l => l.text)')
  assert.ok(at > 0, 'real synced lyrics still short-circuit')
  assert.ok(at < R.indexOf('estimated: true'), 'before anything is marked estimated')
})
