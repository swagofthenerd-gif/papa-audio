'use strict'
// V4 wiring: the honesty table feeds the theatre's error text, the start-up
// watchdog is armed on play and disarmed on the first frame or the stop, and
// the engine's stuck report reaches the stage and the mini card's toast.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const ENGINE = fs.readFileSync(path.join(SRC, 'web-player.js'), 'utf8')
function fn(name) {
  const at = RENDERER.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = RENDERER.indexOf('\nfunction ', at + 1)
  return RENDERER.slice(at, next === -1 ? undefined : next)
}

test('the page loads the honesty table before the video scripts and the error text reads it', () => {
  assert.ok(HTML.indexOf('start-honesty.js') < HTML.indexOf('video-player.js'))
  // Roadmap 008: install-hints loads first so the honesty table can name the
  // right package manager, and the error text passes the platform through.
  assert.ok(HTML.indexOf('install-hints.js') < HTML.indexOf('start-honesty.js'))
  assert.match(fn('_videoErrorText'), /PapaStartHonesty\.sentence\(msg, platform\)/)
})

test('the start-up watchdog is armed on play and disarmed on playing, ended, error and stop', () => {
  assert.match(fn('_videoPlayResult'), /_handleVideoEvent\(\{ kind: 'buffering' \}\)\n\s+_armStartWatch\(\)/)
  const h = fn('_handleVideoEvent')
  assert.match(h, /kind === 'playing'\) \{[\s\S]*?if \(payload\.web\) _disarmStartWatch\(\)/, 'mpv says playing before any frame; only the page engine disarms here')
  assert.match(fn('_onVideoStateTick'), /if \(_startWatch && st && \(st\.position > 0\.05 \|\| \(st\.paused && st\.duration > 0\)\)\) _disarmStartWatch\(\)/)
  assert.match(h, /kind === 'stalled'\) \{\n\s+_startWatchWords\(\)/)
  assert.match(h, /kind === 'ended'\) \{\n\s+_disarmStartWatch\(\)/)
  assert.match(h, /kind === 'error'\) \{\n\s+_disarmStartWatch\(\)/)
  assert.match(h, /kind === 'buffering'\) \{[\s\S]*?_startWatchWords\(\)/)
  assert.match(fn('_videoStopAndHide'), /_disarmStartWatch\(\)/)
  assert.match(fn('_initVideoUI'), /onExit: function \(\) \{\n\s+_disarmStartWatch\(\)/)
})

test('a source the probe cannot read is reported, not handed to mpv to fail silently', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(MAIN, /if \(\/ffprobe could not read the source\/i\.test\(sess\.reason\)\) throw new Error\(sess\.reason\)/)
})

test('a quiet start says how long it has waited, on the stage and once as a toast', () => {
  const src = fn('_armStartWatch') + fn('_disarmStartWatch') + fn('_startWatchWords') + fn('_startWatchTick')
  const msgs = []; const toasts = []
  const ctx = vm.createContext({
    _startWatch: null, _startWatchTimer: null, START_WATCH_QUIET_MS: 15000, START_SWITCH_QUIET_MS: 20000, _startWatchLastSig: '',
    _watch: { pick: null }, _autoSwitchSource() {},
    setInterval: () => 1, clearInterval() {}, Date: { now: () => 100000 },
    _player: { setStageMessage: m => msgs.push(m) }, showToast: t => toasts.push(t),
    esc: s => s, PapaStartHonesty: require('../src/start-honesty'),
  })
  vm.runInContext(src + '\nthis._armStartWatch = _armStartWatch; this._startWatchTick = _startWatchTick; this._startWatchWords = _startWatchWords; this._disarmStartWatch = _disarmStartWatch', ctx)
  ctx._armStartWatch()
  ctx._startWatchTick(100000 + 10000)
  assert.equal(msgs.length, 0, 'ten quiet seconds are fine')
  ctx._startWatchTick(100000 + 16000)
  assert.equal(msgs.length, 1)
  assert.match(msgs[0], /Still no picture after 16 s\. Nothing has arrived from the source yet/)
  assert.match(msgs[0], /Try another source/)
  assert.equal(toasts.length, 1)
  ctx._startWatchTick(100000 + 21000)
  assert.equal(msgs.length, 2, 'the count keeps updating')
  assert.equal(toasts.length, 1, 'the toast is said once')
  ctx._startWatchWords()   // a buffering report at t=100000 (Date.now) resets the quiet clock
  ctx._startWatchTick(100000 + 14000)
  assert.equal(msgs.length, 2)
  ctx._disarmStartWatch()
  ctx._startWatchTick(100000 + 60000)
  assert.equal(msgs.length, 2, 'disarmed: silent')
})

test('the stage words paint above the in-page video', () => {
  const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  const block = CSS.slice(CSS.indexOf('.vt-stage-msg {'), CSS.indexOf('.vt-stage-msg .spin'))
  assert.match(block, /z-index:4/)
  assert.match(block, /\.vt-stage-msg > div:not\(\.spin\) \{\n\s+background:rgba\(0,0,0,\.55\)/)
})

test('a torrent showing no progress at start is swapped after 20 s; repeated identical reports are not progress', () => {
  const h = fn('_handleVideoEvent')
  assert.match(h, /const sig = label \+ '\|' \+ \(pct != null \? pct : ''\)/)
  assert.match(h, /if \(sig !== _startWatchLastSig\) \{ _startWatchLastSig = sig; _startWatchWords\(\) \}/)
  const tick = fn('_startWatchTick')
  assert.match(tick, /now - _startWatch\.wordsAt >= START_SWITCH_QUIET_MS/)
  assert.match(tick, /_watch\.pick\.kind === 'torrent' && \(_watch\.autoSwitches \|\| 0\) < 2/)
  assert.match(tick, /_startWatch\.switched = true\n\s+_autoSwitchSource\(\)/)
})

test('the engine reports a frozen picture and the page says which side is stuck', () => {
  assert.match(ENGINE, /onEvent\(\{ kind: 'stuck', web: true, phase: watch\.hadFrame \? 'play' : 'start', waited: waited \/ 1000, converted: _coveredAheadOf\(pos\) \}\)/)
  assert.match(ENGINE, /onEvent\(\{ kind: 'unstuck', web: true \}\)/)
  const h = fn('_handleVideoEvent')
  assert.match(h, /kind === 'stuck'\) \{[\s\S]*?PapaStartHonesty\.stuck\(payload\)[\s\S]*?showToast\(w\.text\)/)
  assert.match(h, /kind === 'unstuck'\) \{\n\s+_player\.setStageMessage\(''\)/)
  // A wait is reported only once it has lasted 400 ms, and 'ready' clears it.
  assert.match(ENGINE, /waitTimer = setTimeout\(function \(\) \{ waitTimer = null; if \(video && video\.readyState < 3\) onEvent\(\{ kind: 'buffering', web: true \}\) \}, 400\)/)
  assert.match(ENGINE, /video\.addEventListener\('canplay', function \(\) \{ clearTimeout\(waitTimer\); waitTimer = null; onEvent\(\{ kind: 'ready', web: true \}\) \}\)/)
  assert.match(h, /kind === 'ready'\) \{[\s\S]*?_player\.setStageMessage\(''\)/)
  // The in-page engine's own buffering says "Buffering", not "Downloading".
  assert.match(h, /payload\.phase === 'prebuffer' \|\| payload\.web \? 'Buffering' : 'Downloading'/)
})
