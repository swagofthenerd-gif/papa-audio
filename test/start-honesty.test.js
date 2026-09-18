'use strict'
// Stream-start honesty (V4): every failure between "click Play" and the first
// frame has a sentence and a next action.
const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/start-honesty')

test('each known failure is named with its own next step', () => {
  assert.equal(H.explain('mpv socket not ready: /run/user/1000 (last error: ENOENT)').kind, 'mpv-missing')
  assert.match(H.sentence('spawn mpv ENOENT'), /sudo dnf install -y mpv/)
  assert.equal(H.explain('ffprobe could not read the source: spawn ffprobe ENOENT').kind, 'ffmpeg-missing')
  assert.match(H.sentence('spawn ffmpeg ENOENT'), /sudo dnf install -y ffmpeg/)
  // Roadmap 008: the next step matches the OS it is shown on.
  assert.match(H.sentence('spawn mpv ENOENT', 'darwin'), /brew install mpv/)
  assert.match(H.sentence('spawn mpv ENOENT', 'win32'), /winget install mpv/)
  assert.doesNotMatch(H.sentence('spawn ffmpeg ENOENT', 'darwin'), /dnf|apt/)
  assert.match(H.sentence('spawn ffmpeg ENOENT', 'darwin'), /brew install ffmpeg — or switch to Purist mode/)
  assert.equal(H.explain('ffprobe could not read the source: Invalid data (after 3 attempts)').kind, 'unreadable')
  assert.equal(H.sentence('ffprobe could not read the source'), 'The file could not be read. It may be corrupt, still downloading, or not a video. Try another source from the list below.', 'a finished sentence is followed by a space, not a dash')
  assert.match(H.sentence('Nobody is sharing this right now (searched for 30s)'), /Nobody is sharing.*Try another source/)
  assert.match(H.sentence('Found 3 peers but the stream did not start within 45s'), /3 peers.*Try another source/)
  assert.match(H.sentence('The converter keeps failing on this file'), /Purist mode/)
  assert.match(H.sentence('The smooth player could not play this stream (DEMUXER_ERROR)'), /could not decode.*Purist mode/)
  assert.match(H.sentence('The smooth player could not append the stream'), /could not decode/)
  assert.match(H.sentence('Playback stopped unexpectedly (mpv exited).'), /mpv quit unexpectedly.*Press play/)
  assert.match(H.sentence('This source has no magnet link'), /no magnet link — Pick another source/)
  assert.match(H.sentence('yt-dlp timed out'), /stale yt-dlp/, 'a stale extractor is not a connection problem')
  assert.match(H.sentence('The source timed out'), /Check your connection and try again/)
  assert.match(H.sentence('fetch failed'), /Could not reach the service/)
  assert.match(H.sentence('TMDB returned 401'), /Settings → Video/)
})

test('an unknown failure keeps its words and still gets a next step', () => {
  const e = H.explain('Something odd happened')
  assert.equal(e.kind, 'unknown')
  assert.equal(e.text, 'Something odd happened')
  assert.match(H.sentence('Something odd happened'), /Something odd happened — Try another source/)
  assert.match(H.sentence(''), /Something went wrong — Try another source/)
})

test('a frozen picture says which side is stuck', () => {
  const none = H.stuck({ phase: 'start', waited: 15.4, converted: 0 })
  assert.match(none.text, /Still no picture after 15 s\. The converter has produced nothing yet/)
  assert.match(none.next, /Try another source/)
  const ahead = H.stuck({ phase: 'play', waited: 12, converted: 40 })
  assert.match(ahead.text, /frozen for 12 s\. The converter is 40 s ahead, so the page is the slow part/)
  assert.match(ahead.next, /Purist mode/)
  const purist = H.stuck({ phase: 'play', waited: 12, converted: null })
  assert.match(purist.text, /The source has stopped sending data/)
})

// ── catalogue failures vs playback failures ─────────────────────────────────
// This table was written for the seconds between pressing Play and the first
// frame, where a list of sources sits on screen underneath. The Movies & TV
// catalogue routed through it too, so a title that simply did not come back
// from the titles service was answered with "Try another source from the list
// below" on a detail page that has no source list anywhere on it.
test('a catalogue failure is not told to pick another source', () => {
  const play = H.explain('fetch failed')
  const browse = H.explain('fetch failed', 'linux', 'catalog')
  // Same diagnosis either way — only the next step differs.
  assert.strictEqual(browse.text, play.text)
  assert.strictEqual(browse.kind, play.kind)
})

test('the catch-all is the one that bit: a 404 on a detail page', () => {
  const play = H.explain('Request failed with status 404')
  assert.strictEqual(play.kind, 'unknown')
  assert.strictEqual(play.next, H.SOURCE, 'under the player that is right')
  const browse = H.explain('Request failed with status 404', 'linux', 'catalog')
  assert.strictEqual(browse.next, H.BROWSE, 'on a detail page it was nonsense')
  assert.doesNotMatch(browse.next, /source/i)
})

test('every source-pointing answer is rewritten for the catalogue', () => {
  const messages = [
    'Request failed with status 404',
    'ffprobe could not read the source',
    'Nobody is sharing this right now',
    'The stream did not start within 60s',
    'no magnet link',
    'the file could not be played',
    'the converter keeps failing',
  ]
  for (const m of messages) {
    const browse = H.explain(m, 'linux', 'catalog')
    assert.doesNotMatch(String(browse.next || ''), /source (from|below)|list below/i,
      m + ' still pointed at a source list that is not on the page')
  }
})

test('advice that fits a catalogue is left exactly as it was', () => {
  // Not every case points at the source list, and those must not be rewritten
  // into something vaguer than the truth.
  assert.strictEqual(H.explain('401 api key', 'linux', 'catalog').next,
    'Set it in Settings → Video.')
  assert.strictEqual(H.explain('request timed out', 'linux', 'catalog').next,
    'Check your connection and try again.')
  assert.strictEqual(H.explain('ENOTFOUND', 'linux', 'catalog').next,
    'Check your connection.')
})

test('playback keeps the source advice — the default did not move', () => {
  assert.strictEqual(H.explain('Request failed with status 404').next, H.SOURCE)
  assert.strictEqual(H.explain('Nobody is sharing this', 'linux', 'playback').next, H.SOURCE)
  assert.match(H.sentence('Request failed with status 404'), /another source/)
})

test('a one-line sentence carries the context through', () => {
  assert.match(H.sentence('Request failed with status 404', 'linux', 'catalog'), /Try again, or go back\./)
  assert.doesNotMatch(H.sentence('Request failed with status 404', 'linux', 'catalog'), /source/i)
})

// The renderer's own wrapper is where the context actually has to travel: the
// detail page's error screen calls it, and that is the screen the wrong advice
// was printed on.
test("the renderer's _videoErrorText hands the context to the table", () => {
  const fs = require('fs')
  const path = require('path')
  const vm = require('vm')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const start = src.indexOf('function _videoErrorText(')
  assert.ok(start > -1)
  let depth = 0, end = -1
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break } }
  }
  const ctx = { PapaStartHonesty: H, console }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(src.slice(start, end), ctx)
  assert.match(ctx._videoErrorText('Request failed with status 404'), /another source/,
    'under the player it still points at the list')
  assert.match(ctx._videoErrorText('Request failed with status 404', 'catalog'), /Try again, or go back/)
  assert.doesNotMatch(ctx._videoErrorText('Request failed with status 404', 'catalog'), /source/i,
    'this is the sentence a detail page was printing with no source list on it')
})

// ── the theatre has no list below it either ────────────────────────────────
// A failed or refused play paints its sentence over the player, which covers
// the page. "Try another source from the list below." pointed at a list the
// viewer could not see and could not reach without first knowing to press
// Escape — so the advice names the way out instead.

test('a failure raised over the player does not point at a list', () => {
  const inTheatre = H.explain('The file could not be played — it may be corrupt', 'linux', 'theatre')
  assert.strictEqual(inTheatre.next, H.THEATRE)
  assert.doesNotMatch(inTheatre.next, /below/,
    'nothing is below the theatre; it covers the page')
})

test('every source-pointing answer is rewritten for the theatre', () => {
  const sourcePointing = [
    'ffprobe could not read the source',
    'Nobody is sharing this right now',
    'the stream did not start within 60s',
    'no magnet link',
    'this file could not be played',
  ]
  for (const m of sourcePointing) {
    const inTheatre = H.explain(m, 'linux', 'theatre')
    assert.doesNotMatch(inTheatre.next, /list below|below\./,
      m + ' still sent the viewer to a list that is not on screen')
  }
})

test('Purist mode is still offered in the theatre — it is reachable from anywhere', () => {
  const inTheatre = H.explain('the converter keeps failing', 'linux', 'theatre')
  assert.match(inTheatre.next, /Purist mode/, 'that half of the advice still works')
  assert.doesNotMatch(inTheatre.next, /below/)
})

test('advice that has nothing to do with a source list is untouched', () => {
  assert.strictEqual(H.explain('401 api key', 'linux', 'theatre').next,
    H.explain('401 api key', 'linux').next)
  assert.strictEqual(H.explain('request timed out', 'linux', 'theatre').next,
    H.explain('request timed out', 'linux').next)
})

test('and playback outside the theatre still points at the list', () => {
  assert.strictEqual(H.explain('Nobody is sharing this', 'linux').next, H.SOURCE)
  assert.strictEqual(H.explain('Nobody is sharing this', 'linux', 'playback').next, H.SOURCE)
})
