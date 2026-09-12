'use strict'
// Stream-start honesty (V4): every failure between "click Play" and the first
// frame has a sentence and a next action.
const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/start-honesty')

test('each known failure is named with its own next step', () => {
  assert.equal(H.explain('mpv socket not ready: /run/user/1000 (last error: ENOENT)').kind, 'mpv-missing')
  assert.match(H.sentence('spawn mpv ENOENT'), /sudo dnf install mpv/)
  assert.equal(H.explain('ffprobe could not read the source: spawn ffprobe ENOENT').kind, 'ffmpeg-missing')
  assert.match(H.sentence('spawn ffmpeg ENOENT'), /sudo dnf install ffmpeg/)
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
