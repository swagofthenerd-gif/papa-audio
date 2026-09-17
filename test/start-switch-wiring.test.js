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
  assert.match(M, /_videoSession\.switching = true\n\s+const fail = e => \{ _videoSession\.switching = false;/)
  assert.match(M, /videoEngine\(\)\.load\(url\)\.then\(async \(\) => \{\n\s+_videoSession\.switching = false/)
  assert.match(M, /_videoSession\.token\+\+\n\s+_videoSession\.switching = false/)
})
