'use strict'
// A source that never starts is swapped, not shown as a failure, while other
// sources are listed: at 20 s of no progress, and again on "nobody is
// sharing"/"did not start", up to three times, never back onto one already
// tried. The old stream's end during a switch is not a finished film.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
function fn(name) {
  const at = R.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = R.indexOf('\nfunction ', at + 1)
  return R.slice(at, next === -1 ? undefined : next)
}

test('_nextUntriedSource skips the current pick and everything tried before', () => {
  // _playCtx falls back to the page when nothing is pinned, so the page-scoped
  // globals have to exist in the sandbox even though this case does not use them.
  const ctx = vm.createContext({
    _watch: { pick: { magnet: 'a' }, tried: { b: true } },
    _videoStreams: [{ magnet: 'a' }, { magnet: 'b' }, { magnet: 'c' }, { magnet: 'd' }],
    _videoDetail: null,
    _videoState: null,
  })
  // _nextUntriedSource reads the PLAY context now, not the page-scoped globals:
  // with a film minimised and another title's page open, the old version offered
  // the browsed page's sources to a stall that was about to swap the running
  // film. The harness supplies the accessor the same way it supplies _sourceKey.
  vm.runInContext(fn('_sourceKey') + '\n' + fn('_playCtx') + '\n' + fn('_nextUntriedSource') + '\nthis.next = _nextUntriedSource', ctx)
  assert.deepStrictEqual(ctx.next(), { magnet: 'c' })
  assert.equal(ctx._watch.tried.a, true, 'the current pick is remembered as tried')
  ctx._watch.tried.c = true; ctx._watch.tried.d = true
  assert.equal(ctx.next(), null)
})

test('the switch takes the next untried source and remembers it; a start failure retries up to three times', () => {
  const sw = fn('_autoSwitchSource')
  assert.match(sw, /const next = _nextUntriedSource\(\)\n\s+if \(!next\) return false/)
  assert.match(sw, /_watch\.tried\[_sourceKey\(next\)\] = true/)
  const h = fn('_handleVideoEvent')
  assert.match(h, /if \(\/Nobody is sharing\|did not start within\/i\.test\(payload\.message \|\| ''\) &&\n\s+_watch && _watch\.pick && _watch\.pick\.kind === 'torrent' && \(_watch\.autoSwitches \|\| 0\) < 3\)/)
  assert.match(h, /if \(_nextUntriedSource\(\)\) \{\n\s+_armStartWatch\(\)\n\s+showToast\('That source is dead — trying another…'\)\n\s+_autoSwitchSource\(\)\n\s+return/)
  assert.match(h, /if \(payload\.message && payload\.message === _lastVideoErrorMsg && nowE - _lastVideoErrorAt < 3000\) return/, 'the same failure twice is one message')
})

test("main drops the old stream's end-of-file while a switch is in flight", () => {
  assert.match(M, /if \(_videoSession\.switching\) \{ console\.log\('\[papa-video\] end of the old stream during a switch, ignored'\); return \}/)
  // `fail` grew a body: a failed switch used to show nothing but a 3.2 s toast,
  // because the renderer paints switch errors on the HTML stage, which sits
  // UNDER mpv's window and is invisible in purist mode. It now also says it
  // over the OSD. What must not change is that failing clears the flag.
  assert.match(M, /_videoSession\.switching = true\n[\s\S]{0,400}const fail = e => \{\n\s+_videoSession\.switching = false/)
  assert.match(M, /say\('Could not switch source — ' \+ msg, 8000\)/,
    'and says it where it can actually be seen')
  // The switch resolves debrid before the swarm, so the load is shared by both
  // paths in one async helper rather than written inline in the torrent
  // callback. WHEN the flag clears turned out to matter more than first
  // thought: clearing it at the load left the resume SEEK unprotected, and a
  // seek clamped to (or past) a shorter cut's end makes mpv report
  // end-of-file — which the renderer reads as a finished episode. It now
  // clears only after the seek has settled, so everything the switch causes
  // stays suppressed.
  // The window covers the seek's own error handling, which exists because a
  // swallowed seek failure is why a lost position was never diagnosable.
  assert.match(M, /await videoEngine\(\)\.seek\(target, 'absolute'\)[\s\S]{0,900}_videoSession\.switching = false/)
  assert.doesNotMatch(M, /await videoEngine\(\)\.load\(url\)\n\s+_videoSession\.switching = false/,
    'clearing it at the load is the bug')
  assert.match(M, /const loadInto = async \(url, streamer\) => \{/,
    'one load path, used by the debrid link and by the torrent alike')
  assert.match(M, /_videoSession\.token\+\+\n\s+_videoSession\.switching = false/)
})
