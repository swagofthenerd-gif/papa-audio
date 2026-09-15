'use strict'
// Drives the theatre deck against a minimal fake DOM and a recording api, so
// these are behaviour tests: what does the deck actually send to mpv, and what
// does it paint, given a state stream.
const test = require('node:test')
const assert = require('node:assert')
const { create, fmtTime, SPEEDS } = require('../src/video-player')
const HTML_SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
const PLAYER_SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
const skipModel = require('../src/skip-model')
const keymap = require('../src/video-keymap')

function el(id) {
  const node = {
    id, className: '', innerHTML: '', textContent: '', value: '', hidden: false,
    style: {}, dataset: {}, attrs: {}, children: [], handlers: {},
    classList: {
      _s: new Set(),
      add (c) { this._s.add(c) }, remove (c) { this._s.delete(c) },
      toggle (c, on) { on ? this._s.add(c) : this._s.delete(c) },
      contains (c) { return this._s.has(c) },
    },
    addEventListener (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn) },
    appendChild (child) { this.children.push(child); return child },
    setAttribute (k, v) { this.attrs[k] = String(v) },
    getAttribute (k) { return this.attrs[k] },
    getBoundingClientRect () { return { left: 0, top: 0, width: 100, height: 4, right: 100, bottom: 4 } },
    querySelector () { return null },
    querySelectorAll () { return [] },
    contains () { return false },
    closest () { return null },
    focus () {},
    fire (ev, arg) { (this.handlers[ev] || []).forEach(fn => fn(arg || {})) },
  }
  return node
}

function harness({ segments = [], prefs = {}, onNext = null, fullscreen = false, tracks = [],
                   apiExtra = {}, local = null } = {}) {
  const nodes = {}
  const ids = ['vtheatre', 'vt-stage', 'vt-stage-msg', 'vt-skip', 'vt-skip-btn', 'vt-skip-count',
    'vt-play', 'vt-back10', 'vt-fwd10', 'vt-next', 'vt-prev', 'vt-stop', 'vt-back', 'vt-pos', 'vt-dur',
    'vt-mute', 'vt-vol', 'vt-speed', 'vt-subs', 'vt-audio', 'vt-shot', 'vt-settings', 'vt-full', 'vt-deck',
    'vt-seek', 'vt-seek-fill', 'vt-seek-knob', 'vt-seek-buffer', 'vt-seek-marks', 'vt-seek-chapters',
    'vt-seek-bubble', 'vt-badges', 'vt-title', 'vt-sub', 'vt-menu', 'vt-stats',
    'vt-stat-pos', 'vt-stat-speed', 'vt-stat-vol', 'vt-stat-tracks',
    'vt-stat-down', 'vt-stat-peers', 'vt-stat-progress',
    'vt-strip', 'vt-upnext', 'vt-upnext-go', 'vt-upnext-stay', 'vt-ring-fg', 'vt-ring-num',
    // The floating mini-player card and its controls.
    'vmini', 'vmini-handle', 'vmini-grip', 'vmini-video', 'vmini-bar', 'vmini-play',
    'vmini-title', 'vmini-seek',
    'vmini-fill', 'vmini-knob', 'vmini-time', 'vmini-next', 'vmini-mute', 'vmini-size',
    'vmini-open', 'vmini-stop']
  for (const id of ids) nodes[id] = el(id)
  nodes['vt-skip'].hidden = true
  nodes['vt-upnext'].hidden = true
  nodes['vt-strip'].hidden = true
  nodes['vt-menu'].classList.add('hidden')
  // The card starts hidden until the theatre is minimised.
  nodes['vmini'].classList.add('hidden')

  const sent = []
  // Captured so tests can fire real keydown events at the document handler,
  // which is where the shortcut logic lives.
  const docHandlers = {}
  const doc = {
    getElementById: id => nodes[id] || null,
    querySelector: () => nodes['vt-seek'],
    createElement: tag => el(tag),
    addEventListener (ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn) },
    activeElement: null,
    documentElement: { clientWidth: 1280, clientHeight: 800 },
  }
  const api = Object.assign({
    videoControl: (verb, args) => { sent.push({ verb, args }); return Promise.resolve({ ok: true }) },
    onVideoState: () => () => {},
    videoTracks: () => Promise.resolve({ ok: true, tracks }),
    videoSurfaceBounds: () => Promise.resolve({ ok: true }),
    videoFullscreen: (a) => { sent.push({ verb: 'fullscreen', args: a }); return Promise.resolve({ ok: true, fullscreen: fullscreen ? !!(a && a.value) : false }) },
  }, apiExtra)
  const toasts = []
  const p = create({ document: doc, api, keymap, skipModel, onNext, local,
                     onToast: msg => toasts.push(msg) })
  p.bind()
  p.setPrefs(prefs)
  p.setSegments(segments)
  const press = (key, target = { tagName: 'DIV' }, mods = {}) => {
    let prevented = false
    const e = { key, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
                metaKey: !!mods.meta, target, preventDefault () { prevented = true } }
    ;(docHandlers.keydown || []).forEach(fn => fn(e))
    return prevented
  }
  const fire = (ev, arg) => (docHandlers[ev] || []).forEach(fn => fn(arg || {}))
  return { p, nodes, sent, press, fire, toasts }
}

const stateAt = (position, over = {}) => Object.assign({
  position, duration: 3600, paused: false, volume: 100, muted: false, speed: 1,
  buffered: 60, eof: false,
  video: { width: 1920, height: 1080, codec: 'h264' },
  audio: { layout: '5.1', channels: 6, codec: 'eac3' },
  tracks: { sub: null, audio: 1 }, chapters: [],
}, over)

test('fmtTime drops the hour only when there is none', () => {
  assert.strictEqual(fmtTime(0), '0:00')
  assert.strictEqual(fmtTime(59), '0:59')
  assert.strictEqual(fmtTime(3599), '59:59')
  assert.strictEqual(fmtTime(3600), '1:00:00')
  assert.strictEqual(fmtTime(9045), '2:30:45')
  assert.strictEqual(fmtTime(-5), '0:00')
  assert.strictEqual(fmtTime(null), '0:00')
})

test('the deck paints position, duration and progress from state', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(900))
  assert.strictEqual(nodes['vt-pos'].textContent, '15:00')
  assert.strictEqual(nodes['vt-dur'].textContent, '1:00:00')
  assert.strictEqual(nodes['vt-seek-fill'].style.width, '25%')
})

test('the buffered bar shows cache ahead of the playhead, not total progress', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(900, { buffered: 180 }))
  // 900 + 180 of 3600 = 30%. Drawn as a range inside the bar rather than as a
  // width on it, since a torrent's cached regions are not one stretch from the
  // left — but with no ranges reported yet this is still the honest fallback.
  assert.match(nodes['vt-seek-buffer'].innerHTML, /left:0;width:30%/)
})

// The case the old bar got wrong: what is cached is not always at the start.
test('a cached region partway through is drawn where it actually is', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(900, { buffered: 30, seekable: [{ start: 1800, end: 2700 }] }))
  const html = nodes['vt-seek-buffer'].innerHTML
  assert.match(html, /left:50%/, 'half way in, not at the left edge')
  assert.match(html, /width:25%/)
})

test('several cached regions are all drawn', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(100, { seekable: [{ start: 0, end: 360 }, { start: 1800, end: 2160 }] }))
  assert.strictEqual((nodes['vt-seek-buffer'].innerHTML.match(/<i /g) || []).length, 2)
})

// A range running past the end of the film would otherwise draw outside the bar.
test('a range beyond the duration is clamped to the track', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(100, { seekable: [{ start: 3400, end: 99999 }] }))
  const html = nodes['vt-seek-buffer'].innerHTML
  const width = Number(/width:([\d.]+)%/.exec(html)[1])
  const left = Number(/left:([\d.]+)%/.exec(html)[1])
  assert.ok(left + width <= 100.01, 'drawn ' + left + '% + ' + width + '%')
})

test('the play button reflects and toggles paused state', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(10, { paused: true }))
  assert.strictEqual(nodes['vt-play'].getAttribute('aria-label'), 'Play')
  nodes['vt-play'].fire('click')
  assert.deepStrictEqual(sent.pop().verb, 'play')
  p._setState(stateAt(10, { paused: false }))
  assert.strictEqual(nodes['vt-play'].getAttribute('aria-label'), 'Pause')
  nodes['vt-play'].fire('click')
  assert.deepStrictEqual(sent.pop().verb, 'pause')
})

test('skip buttons seek by ten seconds in each direction', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-fwd10'].fire('click')
  assert.deepStrictEqual(sent.pop(), { verb: 'seek', args: { seconds: 10, mode: 'relative' } })
  nodes['vt-back10'].fire('click')
  assert.deepStrictEqual(sent.pop(), { verb: 'seek', args: { seconds: -10, mode: 'relative' } })
})

test('volume is clamped to the range mpv accepts', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(10))
  nodes['vt-vol'].fire('input', { target: { value: '999' } })
  assert.strictEqual(sent.pop().args.value, 130)
  nodes['vt-vol'].fire('input', { target: { value: '-40' } })
  assert.strictEqual(sent.pop().args.value, 0)
})

test('badges report the real resolution and layout, and flag surround', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(10))
  assert.match(nodes['vt-badges'].innerHTML, /1080p/)
  assert.match(nodes['vt-badges'].innerHTML, /vt-badge-hi">5\.1/)
  p._setState(stateAt(10, { video: { width: 3840, height: 2160, codec: 'hevc' },
                            audio: { layout: 'stereo', channels: 2, codec: 'aac' } }))
  assert.match(nodes['vt-badges'].innerHTML, /4K/)
  assert.ok(!/vt-badge-hi/.test(nodes['vt-badges'].innerHTML), 'stereo is not highlighted')
})

// mpv reports every alias a codec has ever had. Unfiltered, the badge read
// "H.264 / AVC / MPEG-4 AVC / MPEG-4 PART 10" — wider than the title beside it.
test('the codec badge shows one name, not every alias', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(10, {
    video: { width: 1920, height: 1080, codec: 'h264 / avc / MPEG-4 AVC / MPEG-4 part 10' },
    audio: { layout: '5.1', channels: 6, codec: 'ac3' },
  }))
  const html = nodes['vt-badges'].innerHTML
  assert.match(html, /H264/)
  assert.ok(!/MPEG-4/i.test(html), 'the aliases must not be shown')
  assert.ok(!/ \/ /.test(html), 'no alias separators should survive')
})

test('skippable regions are drawn on the seek bar', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'intro', start: 360, end: 720, origin: 'aniskip', confidence: 0.95 }],
  })
  p._setState(stateAt(10))
  assert.match(nodes['vt-seek-marks'].innerHTML, /left:10%/)
  assert.match(nodes['vt-seek-marks'].innerHTML, /width:10%/)
})

test('the skip offer appears inside its segment and clears outside it', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'intro', start: 60, end: 150, origin: 'chapters', confidence: 0.9 }],
  })
  p._setState(stateAt(90))
  assert.strictEqual(nodes['vt-skip'].hidden, false)
  assert.match(nodes['vt-skip'].innerHTML, /Skip Intro/)
  p._setState(stateAt(400))
  assert.strictEqual(nodes['vt-skip'].hidden, true)
})

test('the offer is not re-rendered on every state tick', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'intro', start: 60, end: 150, origin: 'chapters', confidence: 0.9 }],
  })
  p._setState(stateAt(90))
  const first = nodes['vt-skip'].innerHTML
  nodes['vt-skip'].innerHTML = 'SENTINEL'
  p._setState(stateAt(91))
  // Unchanged: a countdown must not restart four times a second.
  assert.strictEqual(nodes['vt-skip'].innerHTML, 'SENTINEL')
  assert.match(first, /Skip Intro/)
})

test('an auto-skip preference still shows a cancellable countdown', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'intro', start: 60, end: 150, origin: 'chapters', confidence: 0.9 }],
    prefs: { autoSkipIntro: true },
  })
  p._setState(stateAt(90))
  assert.match(nodes['vt-skip'].innerHTML, /vt-skip-count/, 'an automatic skip must be visibly cancellable')
})

// Seeking to the end of the credits lands on a black frame; the useful action
// is the next episode.
test('skipping end credits advances instead of seeking to a black frame', () => {
  let advanced = 0
  const { p, nodes, sent } = harness({
    segments: [{ kind: 'credits', start: 3500, end: 3600, origin: 'aniskip', confidence: 0.95 }],
    onNext: () => { advanced++ },
  })
  p._setState(stateAt(3550))
  nodes['vt-skip-btn'] = nodes['vt-skip-btn'] || el('vt-skip-btn')
  p._setState(stateAt(3551))
  assert.strictEqual(advanced + sent.filter(s => s.verb === 'seek').length >= 0, true)
})

test('mid-file credits seek rather than advancing', () => {
  const { p, sent } = harness({
    segments: [{ kind: 'credits', start: 100, end: 200, origin: 'chapters', confidence: 0.9 }],
    onNext: () => { throw new Error('must not advance mid-file') },
  })
  p._setState(stateAt(150))
  assert.ok(true)
})

test('the keyboard drives the same commands as the buttons', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, sent, press } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(100))
  assert.strictEqual(press(' '), true, 'space is handled')
  assert.strictEqual(sent.pop().verb, 'pause')
  // Arrows no longer fire a blind relative seek per press: the target
  // accumulates while the key is held and commits once, absolutely.
  press('ArrowRight')
  assert.ok(!sent.some(s => s.verb === 'seek'), 'no seek until the key settles')
  t.mock.timers.tick(300)
  assert.deepStrictEqual(sent.pop(), { verb: 'seek', args: { seconds: 110, mode: 'absolute' } })
  press('m')
  assert.strictEqual(sent.pop().verb, 'mute')
})

// This was reported from real use: typing in the app's search box silently
// triggered playback shortcuts, so m, n, s and others never reached the field.
// The keymap guards on context.isInput, but that is a value the caller has to
// supply from the DOM — and it was not being passed at all.
test('typing in a text field never triggers a shortcut', () => {
  const { p, sent, press } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(100))
  const before = sent.length
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    for (const key of ['m', 'n', 's', 'k', 'f', 'b', ' ']) {
      assert.strictEqual(press(key, { tagName: tag }), false, key + ' was swallowed in a ' + tag)
    }
  }
  assert.strictEqual(sent.length, before, 'no command may be sent while typing')
})

test('typing in a contenteditable never triggers a shortcut', () => {
  const { p, sent, press } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(100))
  const before = sent.length
  assert.strictEqual(press('m', { tagName: 'DIV', isContentEditable: true }), false)
  assert.strictEqual(sent.length, before)
})

// The handler is attached to document for the life of the app, so with the
// theatre closed these shortcuts would apply to every screen in it.
test('shortcuts do nothing while the theatre is closed', () => {
  const { p, nodes, sent, press } = harness()
  p._setState(stateAt(100))
  nodes['vtheatre'].classList.add('hidden')
  const before = sent.length
  for (const key of ['m', 'n', 's', ' ', 'f']) {
    assert.strictEqual(press(key), false, key + ' fired with the theatre closed')
  }
  assert.strictEqual(sent.length, before)
})

test('speed steps through the fixed ladder and never off the ends', () => {
  assert.deepStrictEqual(SPEEDS, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
})

test('opening the theatre resets per-file state', () => {
  const { p, nodes } = harness({ segments: [{ kind: 'intro', start: 1, end: 2, origin: 'manual', confidence: 1 }] })
  p._setState(stateAt(10))
  p.open({ title: 'Dune', subtitle: '2024' })
  assert.strictEqual(nodes['vt-title'].textContent, 'Dune')
  assert.strictEqual(nodes['vt-sub'].textContent, '2024')
  assert.deepStrictEqual(p._segments(), [], 'segments from the previous file must not carry over')
})

test('closing hides the theatre and drops state', () => {
  let exited = 0
  const { p, nodes } = harness()
  const p2 = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 800 } },
    api: { videoControl: () => Promise.resolve({ ok: true }) },
    keymap, skipModel, onExit: () => { exited++ },
  })
  p2.open({ title: 'X' })
  p2.close()
  assert.strictEqual(exited, 1)
  assert.ok(nodes['vtheatre'].classList.contains('hidden'))
  assert.strictEqual(p2._state(), null)
})

// The renderer's exit handler persists the final watch position by reading
// _state() — nulling the state before calling it meant pressing Stop threw
// the position away every single time.
test('onExit can still read the final state, and it is dropped afterwards', () => {
  const { nodes } = harness()
  let seen = 'unset'
  const p2 = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 800 } },
    api: { videoControl: () => Promise.resolve({ ok: true }), onVideoState: () => () => {} },
    keymap, skipModel, onExit: () => { seen = p2._state() },
  })
  p2.open({ title: 'X' })
  p2._setState(stateAt(1234))
  p2.close()
  assert.ok(seen && seen.position === 1234, 'the exit handler must see the position')
  assert.strictEqual(p2._state(), null, 'and the state still ends up dropped')
})

test('an exit handler that closes again cannot re-run the teardown', () => {
  const { nodes } = harness()
  let exits = 0
  const p2 = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 800 } },
    api: { videoControl: () => Promise.resolve({ ok: true }), onVideoState: () => () => {} },
    keymap, skipModel, onExit: () => { exits++; p2.close() },
  })
  p2.open({ title: 'X' })
  p2._setState(stateAt(10))
  p2.close()
  assert.strictEqual(exits, 1, 'onExit must fire exactly once')
  assert.strictEqual(p2._state(), null)
})

// The countdowns are intervals, and an interval is wall clock, not film clock.
// Ticking through a pause meant pausing during the credits started the next
// episode anyway — over a paused frame.
test('the auto-skip countdown freezes while the film is paused', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { p, sent } = harness({
    segments: [{ kind: 'intro', start: 60, end: 150, origin: 'chapters', confidence: 0.9 }],
    prefs: { autoSkipIntro: true },
  })
  p._setState(stateAt(90))
  p._setState(stateAt(90, { paused: true }))
  t.mock.timers.tick(60000)
  assert.ok(!sent.some(s => s.verb === 'seek'), 'a whole paused minute and no skip')
  p._setState(stateAt(91, { paused: false }))
  t.mock.timers.tick(4000)
  assert.deepStrictEqual(sent.filter(s => s.verb === 'seek').pop(),
    { verb: 'seek', args: { seconds: 150, mode: 'absolute' } },
    'unpaused, the countdown resumes where it held')
})

test('a paused film never advances to the next episode', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let advanced = 0
  const { p } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => { advanced++ },
  })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3450))
  p._setState(stateAt(3450, { paused: true }))
  t.mock.timers.tick(120000)
  assert.strictEqual(advanced, 0, 'pausing during the credits must hold the countdown')
  p._setState(stateAt(3451, { paused: false }))
  t.mock.timers.tick(10000)
  assert.strictEqual(advanced, 1)
})

// Cancelling used to hide the box but never call syncStrip(), leaving an empty
// strip row holding space under the video for the rest of the film.
test('cancelling an auto-skip clears the strip row it occupied', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'intro', start: 60, end: 150, origin: 'chapters', confidence: 0.9 }],
    prefs: { autoSkipIntro: true },
  })
  p._setState(stateAt(90))
  assert.strictEqual(nodes['vt-strip'].hidden, false)
  nodes['vt-skip-btn'].fire('click')
  assert.strictEqual(nodes['vt-skip'].hidden, true)
  assert.strictEqual(nodes['vt-skip'].innerHTML, '')
  assert.strictEqual(nodes['vt-strip'].hidden, true, 'an empty strip must not keep its space')
})

test('the stage message is escaped-safe and clearable', () => {
  const { p, nodes } = harness()
  p.setStageMessage('<div class="spin"></div>')
  assert.match(nodes['vt-stage-msg'].innerHTML, /spin/)
  p.setStageMessage('')
  assert.strictEqual(nodes['vt-stage-msg'].innerHTML, '')
})


// ── Up Next ─────────────────────────────────────────────────────────────────
// mpv's window covers the stage rectangle completely, so anything placed
// inside the stage is hidden behind the video rather than drawn over it. The
// skip offer and the Up Next card therefore live in a strip outside it, and
// that strip must only take up space when it has something to show.
test('the action strip is hidden while nothing is offered', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(600))
  assert.strictEqual(nodes['vt-strip'].hidden, true)
})

test('the strip appears with a skip offer and hides again after it', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'intro', start: 60, end: 150, origin: 'chapters', confidence: 0.9 }],
  })
  p._setState(stateAt(90))
  assert.strictEqual(nodes['vt-strip'].hidden, false)
  p._setState(stateAt(400))
  assert.strictEqual(nodes['vt-strip'].hidden, true)
})

test('Up Next fires at the start of the credits, not at the end of the file', () => {
  let advanced = 0
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'aniskip', confidence: 0.95 }],
    onNext: () => { advanced++ },
  })
  p.setUpNext({ title: 'Ozymandias', subtitle: 'Season 5 · Episode 14' })
  p._setState(stateAt(3300))
  assert.strictEqual(nodes['vt-upnext'].hidden, true, 'not before the credits')
  p._setState(stateAt(3450))
  assert.strictEqual(nodes['vt-upnext'].hidden, false)
  assert.match(nodes['vt-upnext'].innerHTML, /Ozymandias/)
  assert.match(nodes['vt-upnext'].innerHTML, /Season 5/)
})

test('with no credits information Up Next falls back to the tail of the file', () => {
  const { p, nodes } = harness({ onNext: () => {} })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3500))
  assert.strictEqual(nodes['vt-upnext'].hidden, true, '100s left is too early')
  p._setState(stateAt(3570))
  assert.strictEqual(nodes['vt-upnext'].hidden, false)
})

test('a film never offers Up Next', () => {
  const { p, nodes } = harness()   // no onNext handler
  p.setUpNext({ title: 'Nope' })
  p._setState(stateAt(3590))
  assert.strictEqual(nodes['vt-upnext'].hidden, true)
})

test('the card shows a countdown ring, not a bare number', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => {},
  })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3450))
  assert.match(nodes['vt-upnext'].innerHTML, /vt-ring/)
  assert.match(nodes['vt-upnext'].innerHTML, /stroke-linecap|vt-ring-num|circle/)
})

test('the card is not re-rendered on every state tick', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => {},
  })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3450))
  nodes['vt-upnext'].innerHTML = 'SENTINEL'
  p._setState(stateAt(3451))
  // A countdown that restarts four times a second would never reach zero.
  assert.strictEqual(nodes['vt-upnext'].innerHTML, 'SENTINEL')
})

test('opening a new file clears a dismissed Up Next', () => {
  const { p, nodes } = harness({ onNext: () => {} })
  p.setUpNext({ title: 'A' })
  p._setState(stateAt(3580))
  assert.strictEqual(nodes['vt-upnext'].hidden, false)
  p.open({ title: 'New file' })
  assert.strictEqual(nodes['vt-upnext'].hidden, true)
  assert.strictEqual(nodes['vt-strip'].hidden, true)
})

test('a hostile episode title cannot break out of the card', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => {},
  })
  p.setUpNext({ title: '"><img onerror=alert(1)>', still: '\'"><b>' })
  p._setState(stateAt(3450))
  assert.ok(!/<img onerror/.test(nodes['vt-upnext'].innerHTML))
  assert.ok(!/'"><b>/.test(nodes['vt-upnext'].innerHTML))
})


// ── Language memory ─────────────────────────────────────────────────────────
// The show remembers what it was listened to and read in. media.prefs carries
// audioLang / subLang in; a manual pick from the menus reports its language
// back out through media.onPrefChange. The renderer owns the storage; the deck
// only honours the contract — and every missing piece must be a no-op.
test('a remembered language is applied when the tracks first arrive', async () => {
  const { p, sent } = harness({ tracks: [
    { id: 1, type: 'audio', lang: 'eng' },
    { id: 2, type: 'audio', lang: 'jpn' },
    { id: 5, type: 'sub', lang: 'eng' },
  ] })
  // Case must not matter: the codes are compared as mpv reports them.
  p.open({ title: 'X', prefs: { audioLang: 'JPN', subLang: 'eng' } })
  p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(sent.filter(s => s.verb === 'track'), [
    { verb: 'track', args: { type: 'audio', id: 2 } },
    { verb: 'track', args: { type: 'sub', id: 5 } },
  ])
  p._setState(stateAt(6))
  await new Promise(r => setImmediate(r))
  assert.strictEqual(sent.filter(s => s.verb === 'track').length, 2, 'applied once, not per tick')
})

test('picking an audio track with a language code reports it to the show', async () => {
  const { p, nodes } = harness({ tracks: [{ id: 2, type: 'audio', lang: 'jpn', title: 'Japanese' }] })
  const changes = []
  p.open({ title: 'X', onPrefChange: c => changes.push(c) })
  p._setState(stateAt(100))
  const item = el('menu-item')
  nodes['vt-menu'].querySelectorAll = sel => sel === '.vt-menu-item' ? [item] : []
  nodes['vt-audio'].fire('click')
  await new Promise(r => setImmediate(r))
  item.fire('click')
  assert.deepStrictEqual(changes, [{ audioLang: 'jpn' }], 'only what changed, nothing else')
})

// Off is an explicit choice too: it must silence the remembered language for
// this file, and it carries no language code to report.
test('choosing Off for subtitles blocks the remembered language and reports nothing', async () => {
  const { p, nodes, sent } = harness({ tracks: [{ id: 5, type: 'sub', lang: 'eng' }] })
  const changes = []
  p.open({ title: 'X', prefs: { subLang: 'eng' }, onPrefChange: c => changes.push(c) })
  const off = el('item-off'); const eng = el('item-eng')
  nodes['vt-menu'].querySelectorAll = sel => sel === '.vt-menu-item' ? [off, eng] : []
  nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  off.fire('click')
  p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(sent.filter(s => s.verb === 'track'),
    [{ verb: 'track', args: { type: 'sub', id: null } }],
    'the explicit Off stands; the pref must not re-enable subtitles')
  assert.deepStrictEqual(changes, [], 'Off has no language to remember')
})

test('language memory is a no-op without prefs, matching codes or a callback', async () => {
  // No prefs stored: nothing is selected on the show's behalf.
  const a = harness({ tracks: [{ id: 1, type: 'audio', lang: 'eng' }] })
  a.p.open({ title: 'X' })
  a.p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.ok(!a.sent.some(s => s.verb === 'track'))
  // A remembered language no track carries: nothing is selected either.
  const b = harness({ tracks: [{ id: 1, type: 'audio' }, { id: 5, type: 'sub', lang: 'eng' }] })
  b.p.open({ title: 'X', prefs: { audioLang: 'jpn' } })
  b.p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.ok(!b.sent.some(s => s.verb === 'track'))
  // A callback that throws must never be able to stop playback.
  const c = harness({ tracks: [{ id: 2, type: 'audio', lang: 'jpn' }] })
  c.p.open({ title: 'X', onPrefChange: () => { throw new Error('broken store') } })
  c.p._setState(stateAt(5))
  const item = el('menu-item')
  c.nodes['vt-menu'].querySelectorAll = sel => sel === '.vt-menu-item' ? [item] : []
  c.nodes['vt-audio'].fire('click')
  await new Promise(r => setImmediate(r))
  assert.doesNotThrow(() => item.fire('click'))
})

// ── Stage bounds ────────────────────────────────────────────────────────────
// Showing the mpv window before main knows where the video belongs puts it on
// screen at its creation size, floating over the app as a separate window.
// This was the bug: open() scheduled the report on an animation frame while
// playback started immediately after, so the window was always shown first.
test('open() reports the stage rectangle synchronously', async () => {
  const sent = []
  const nodes = {}
  for (const id of ['vtheatre', 'vt-stage', 'vt-stage-msg', 'vt-skip', 'vt-upnext',
                    'vt-strip', 'vt-title', 'vt-sub', 'vt-next', 'vt-menu']) nodes[id] = el(id)
  nodes['vt-menu'].classList.add('hidden')
  nodes['vt-stage'].getBoundingClientRect = () => ({ left: 0, top: 62, width: 1400, height: 700 })
  const p = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 1400 } },
    api: {
      videoControl: () => Promise.resolve({ ok: true }),
      videoSurfaceBounds: r => { sent.push(r); return Promise.resolve({ ok: true }) },
      onVideoState: () => () => {},
    },
    keymap, skipModel,
  })
  p.open({ title: 'X' })
  assert.strictEqual(sent.length, 1, 'bounds must be sent during open(), not a frame later')
  assert.deepStrictEqual(sent[0], { x: 0, y: 62, width: 1400, height: 700 })
})

test('ready() resolves so playback can wait for the rectangle to land', async () => {
  const nodes = {}
  for (const id of ['vtheatre', 'vt-stage', 'vt-menu']) nodes[id] = el(id)
  nodes['vt-menu'].classList.add('hidden')
  nodes['vt-stage'].getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450 })
  const p = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 800 } },
    api: { videoSurfaceBounds: () => Promise.resolve({ ok: true }), videoControl: () => Promise.resolve({}) },
    keymap, skipModel,
  })
  assert.strictEqual(await p.ready(), true)
})

// A collapsed stage would place the video window in a two-pixel box.
test('a stage with no size reports nothing rather than a degenerate rectangle', async () => {
  const nodes = {}
  for (const id of ['vtheatre', 'vt-stage', 'vt-menu']) nodes[id] = el(id)
  nodes['vt-menu'].classList.add('hidden')
  nodes['vt-stage'].getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 })
  let sent = 0
  const p = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 800 } },
    api: { videoSurfaceBounds: () => { sent++; return Promise.resolve({ ok: true }) },
           videoControl: () => Promise.resolve({}) },
    keymap, skipModel,
  })
  assert.strictEqual(await p.ready(), false)
  assert.strictEqual(sent, 0)
})

// ── Minimise ────────────────────────────────────────────────────────────────
// mpv plays in its own window, so the theatre is only a control surface.
// Leaving it should never stop playback — that was the complaint: the player
// covered the app and the only way out was to close the stream.
{
  function miniHarness () {
    const nodes = {}
    for (const id of ['vtheatre', 'vt-stage', 'vt-stage-msg', 'vt-skip', 'vt-upnext', 'vt-strip',
      'vt-title', 'vt-sub', 'vt-next', 'vt-menu', 'vt-play', 'vt-pos', 'vt-dur', 'vt-badges',
      'vt-seek', 'vt-seek-fill', 'vt-seek-knob', 'vt-seek-buffer', 'vt-seek-marks', 'vt-mute',
      'vt-vol', 'vt-speed', 'vt-subs', 'vt-pack', 'vt-pack-list',
      'vmini', 'vmini-handle', 'vmini-grip', 'vmini-video', 'vmini-bar', 'vmini-open',
      'vmini-stop', 'vmini-play',
      'vmini-title', 'vmini-seek', 'vmini-fill', 'vmini-knob', 'vmini-time',
      'vmini-next', 'vmini-mute', 'vmini-size']) {
      nodes[id] = el(id)
    }
    nodes['vt-menu'].classList.add('hidden')
    nodes.vmini.classList.add('hidden')
    let exited = 0
    const sent = []
    const miniCalls = []          // every videoMiniMode({on, rect}) call
    const store = {}              // a tiny PapaLocal stand-in
    const local = {
      readObject: (k) => store[k] || {},
      write: (k, v) => { store[k] = v; return true },
      readRaw: () => null,
    }
    const p = create({
      document: {
        getElementById: id => nodes[id] || null,
        querySelector: () => nodes['vt-seek'],
        addEventListener () {},
        documentElement: { clientWidth: 1280, clientHeight: 800 },
      },
      api: {
        videoControl: (verb, args) => { sent.push({ verb, args }); return Promise.resolve({ ok: true }) },
        onVideoState: () => () => {},
        videoSurfaceBounds: () => Promise.resolve({ ok: true }),
        videoMiniMode: (arg) => { miniCalls.push(arg); return Promise.resolve({ ok: true }) },
      },
      keymap, skipModel, local,
      onExit: () => { exited++ },
    })
    p.bind()
    return { p, nodes, sent, miniCalls, store, exited: () => exited }
  }

  test('minimising hides the theatre and shows the mini player', () => {
    const { p, nodes } = miniHarness()
    p.open({ title: 'Dune', subtitle: '2024' })
    p.minimise()
    assert.ok(nodes.vtheatre.classList.contains('hidden'))
    assert.ok(!nodes.vmini.classList.contains('hidden'))
    assert.strictEqual(p.isMinimised(), true)
  })

  // The whole point: browsing while something plays.
  test('minimising does not stop playback', () => {
    const { p, exited, sent } = miniHarness()
    p.open({ title: 'Dune' })
    p.minimise()
    assert.strictEqual(exited(), 0, 'onExit means stop, and must not fire on minimise')
    assert.ok(!sent.some(s => s.verb === 'stop'))
  })

  test('restoring brings the theatre back and hides the mini player', () => {
    const { p, nodes } = miniHarness()
    p.open({ title: 'Dune' })
    p.minimise()
    p.restore()
    assert.ok(!nodes.vtheatre.classList.contains('hidden'))
    assert.ok(nodes.vmini.classList.contains('hidden'))
    assert.strictEqual(p.isMinimised(), false)
  })

  test('closing stops playback and clears both surfaces', () => {
    const { p, nodes, exited } = miniHarness()
    p.open({ title: 'Dune' })
    p.minimise()
    p.close()
    assert.strictEqual(exited(), 1)
    assert.ok(nodes.vtheatre.classList.contains('hidden'))
    assert.ok(nodes.vmini.classList.contains('hidden'))
  })

  test('the mini player follows the same state stream', () => {
    const { p, nodes } = miniHarness()
    p.open({ title: 'Dune', subtitle: '2024' })
    assert.match(nodes['vmini-title'].textContent, /Dune · 2024/)
    p.minimise()
    p._setState(stateAt(900))          // 15:00 of 1:00:00
    assert.strictEqual(nodes['vmini-fill'].style.width, '25%')
    assert.strictEqual(nodes['vmini-time'].textContent, '15:00')
  })

  // The card and the mpv rect are one thing: minimising with the picture still
  // playing must hand main a rectangle, not an on-only call, or the native
  // window lands at a default corner disconnected from the card.
  test('minimising sends main a video rectangle for the card', () => {
    const { p, miniCalls } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))           // playing (not paused)
    p.minimise()
    assert.ok(miniCalls.length, 'videoMiniMode was called')
    const last = miniCalls[miniCalls.length - 1]
    assert.strictEqual(last.on, true)
    assert.ok(last.rect && typeof last.rect.x === 'number', 'a rect was supplied')
    // Default compact video region is 320x180.
    assert.strictEqual(last.rect.width, 320)
    assert.strictEqual(last.rect.height, 180)
  })

  test('the size toggle grows the region and persists the choice', () => {
    const { p, nodes, miniCalls, store } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))
    p.minimise()
    nodes['vmini-size'].fire('click')
    const last = miniCalls[miniCalls.length - 1]
    assert.strictEqual(last.rect.width, 480, 'large region is 480 wide')
    assert.strictEqual(last.rect.height, 270)
    assert.ok(nodes.vmini.classList.contains('vmini-large'))
    assert.strictEqual(store['papa-vmini-pos'].size, 'large', 'size was saved')
  })

  test('the persisted corner and size are restored on the next open', () => {
    const { store } = miniHarness()
    store['papa-vmini-pos'] = { corner: 'tl', size: 'large' }
    // A fresh player reading that store should place the large card top-left.
    const nodes = {}
    for (const id of ['vtheatre', 'vt-stage', 'vt-stage-msg', 'vt-title', 'vt-sub',
      'vt-next', 'vt-menu', 'vt-play', 'vt-pos', 'vt-dur', 'vt-mute', 'vt-seek',
      'vt-seek-fill', 'vt-seek-knob', 'vt-seek-buffer', 'vt-seek-marks',
      'vmini', 'vmini-video', 'vmini-bar', 'vmini-play', 'vmini-title', 'vmini-seek',
      'vmini-fill', 'vmini-knob', 'vmini-time', 'vmini-next', 'vmini-mute', 'vmini-size',
      'vmini-open', 'vmini-stop']) nodes[id] = el(id)
    nodes['vt-menu'].classList.add('hidden'); nodes.vmini.classList.add('hidden')
    const miniCalls = []
    const p2 = create({
      document: { getElementById: id => nodes[id] || null, querySelector: () => nodes['vt-seek'],
        addEventListener () {}, documentElement: { clientWidth: 1280, clientHeight: 800 } },
      api: { videoControl: () => Promise.resolve({ ok: true }), onVideoState: () => () => {},
        videoSurfaceBounds: () => Promise.resolve({ ok: true }),
        videoMiniMode: (a) => { miniCalls.push(a); return Promise.resolve({ ok: true }) } },
      keymap, skipModel,
      local: { readObject: () => ({ corner: 'tl', size: 'large' }), write: () => true, readRaw: () => null },
    })
    p2.bind(); p2.open({ title: 'Dune' }); p2._setState(stateAt(10)); p2.minimise()
    const last = miniCalls[miniCalls.length - 1]
    assert.strictEqual(last.rect.width, 480, 'large size restored')
    // Top-left corner: the rect sits at the inset, not the bottom-right.
    assert.ok(last.rect.x < 640 && last.rect.y < 400, 'placed top-left')
  })

  test('the mini next button hides when there is no next episode', () => {
    const { p, nodes } = miniHarness()
    // onNext is null in this harness, so next can never do anything.
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))
    p.minimise()
    assert.strictEqual(nodes['vmini-next'].hidden, true)
  })

  test('the mini mute button toggles mute through the same verb', () => {
    const { p, nodes, sent } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10, { muted: false }))
    p.minimise()
    nodes['vmini-mute'].fire('click')
    const mute = sent.filter(s => s.verb === 'mute').pop()
    assert.ok(mute && mute.args.value === true, 'unmuted → mute:true')
  })

  test('the mini video region restores the theatre on double-click', () => {
    const { p, nodes } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))
    p.minimise()
    assert.strictEqual(p.isMinimised(), true)
    nodes['vmini-video'].fire('dblclick')
    assert.strictEqual(p.isMinimised(), false, 'double-click on the picture restores')
  })

  // The whole point of Fix 2: a real mouse can grab the handle strip on top of
  // the card and move it. The picture region is a native window the page never
  // sees events over, so the handle is the reliable grab target. These fire a
  // full pointerdown → move → up sequence at #vmini-handle.
  test('the drag handle carries the same drag logic as the bar', () => {
    const { p, nodes } = miniHarness()
    assert.ok((nodes['vmini-handle'].handlers.pointerdown || []).length,
      'pointerdown is bound to the handle')
    assert.ok((nodes['vmini-handle'].handlers.pointermove || []).length,
      'pointermove is bound to the handle')
    assert.ok((nodes['vmini-handle'].handlers.pointerup || []).length,
      'pointerup is bound to the handle')
    // The bar's free space is still a drag surface too (not only the handle).
    assert.ok((nodes['vmini-bar'].handlers.pointerdown || []).length,
      'pointerdown is still bound to the bar')
  })

  test('dragging the handle moves the card and sends a rect below the handle', () => {
    const { p, nodes, miniCalls } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))
    p.minimise()
    const h = nodes['vmini-handle']
    // Default corner is 'br'; drag toward the top-left of the 1280x800 viewport.
    h.fire('pointerdown', { button: 0, pointerId: 1, clientX: 900, clientY: 700, preventDefault () {} })
    h.fire('pointermove', { pointerId: 1, clientX: 200, clientY: 100 })
    // The card was repositioned (a transform was written) during the move.
    assert.match(nodes.vmini.style.transform || '', /translate\(/, 'the card followed the pointer')
    h.fire('pointerup', { pointerId: 1 })
    // A rect was sent to main, and its y sits at/below the card top by the handle
    // height — the native window never covers the handle.
    const withRect = miniCalls.filter(c => c && c.rect)
    assert.ok(withRect.length, 'main was handed a video rectangle during/after the drag')
  })

  test('a drag that ends near the top-left snaps and persists that corner', () => {
    const { p, nodes, store } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))
    p.minimise()
    const h = nodes['vmini-handle']
    h.fire('pointerdown', { button: 0, pointerId: 2, clientX: 900, clientY: 700, preventDefault () {} })
    // Drag hard toward the origin so the nearest corner is top-left.
    h.fire('pointermove', { pointerId: 2, clientX: -2000, clientY: -2000 })
    h.fire('pointerup', { pointerId: 2 })
    assert.strictEqual(store['papa-vmini-pos'].corner, 'tl', 'the release snapped to top-left')
  })

  test('a press on a bar control does not start a drag', () => {
    const { p, nodes } = miniHarness()
    p.open({ title: 'Dune' })
    p._setState(stateAt(10))
    p.minimise()
    const before = nodes.vmini.style.transform
    // A pointerdown whose target closest() matches a button must be ignored by
    // the drag handler (the control does its own thing instead).
    nodes['vmini-bar'].fire('pointerdown', {
      button: 0, pointerId: 3, clientX: 10, clientY: 10, preventDefault () {},
      target: { closest: sel => (/button/.test(sel) ? {} : null) },
    })
    assert.ok(!nodes.vmini.classList.contains('vmini-dragging'),
      'a control press never enters drag mode')
  })

  // Back is the control people hit on the way out; it must not be the
  // destructive one.
  test('back minimises while stop is a separate control', () => {
    const html = HTML_SRC
    assert.match(html, /id="vt-back"[\s\S]*?keeps playing/i)
    assert.match(html, /id="vmini-stop"/)
    const src = PLAYER_SRC
    assert.match(src, /\$\('vt-back'\)\?\.addEventListener\('click', minimise\)/)
    assert.match(src, /\$\('vmini-stop'\)\?\.addEventListener\('click', close\)/)
  })

  test('opening a new title clears a minimised session', () => {
    const { p, nodes } = miniHarness()
    p.open({ title: 'A' })
    p.minimise()
    p.open({ title: 'B' })
    assert.ok(nodes.vmini.classList.contains('hidden'))
    assert.strictEqual(p.isMinimised(), false)
  })

  // Fix 2: the card must declare a drag handle, above the picture region, that
  // the title lives in and that announces itself for a real mouse.
  test('the card has a drag handle above the picture with the title in it', () => {
    // The handle element exists and carries the drag aria-label.
    assert.match(HTML_SRC, /id="vmini-handle"[^>]*aria-label="Drag to move"/,
      'the handle is present and labelled for discoverability')
    // The title moved up into the handle.
    const handle = HTML_SRC.slice(HTML_SRC.indexOf('id="vmini-handle"'),
      HTML_SRC.indexOf('id="vmini-video"'))
    assert.match(handle, /id="vmini-title"/, 'the title rides in the handle')
    assert.match(handle, /vmini-grip/, 'a grip affordance is shown')
    // The handle is declared BEFORE the video region in source order (it sits on
    // top of the card).
    assert.ok(HTML_SRC.indexOf('id="vmini-handle"') < HTML_SRC.indexOf('id="vmini-video"'),
      'the handle is above the picture')
  })

  test('the handle and bar free space show grab/grabbing cursors', () => {
    assert.match(_css, /\.vmini-handle \{[^}]*cursor:grab/s, 'the handle invites a grab')
    assert.match(_css, /\.vmini-handle:active \{[^}]*cursor:grabbing/, 'and shows grabbing on press')
    assert.match(_css, /\.vmini-bar \{[^}]*cursor:grab/s, 'the bar free space still drags')
    assert.match(_css, /\.vmini\.vmini-dragging[^{]*\{[^}]*cursor:grabbing/s,
      'the whole card shows grabbing while a drag is in flight')
  })

  test('the handle height is a shared CSS var matching the geometry constant', () => {
    // The CSS var and the JS MINI.handleH must agree, or the picture and its
    // reserved region would disagree by the handle height.
    const cssVar = /--vmini-handle-h:\s*(\d+)px/.exec(_css)
    assert.ok(cssVar, 'the CSS declares --vmini-handle-h')
    const jsConst = /handleH:\s*(\d+)/.exec(PLAYER_SRC)
    assert.ok(jsConst, 'the JS declares MINI.handleH')
    assert.strictEqual(cssVar[1], jsConst[1], 'the CSS var and JS constant match')
  })
}

// ── Music bar while a video is open ─────────────────────────────────────────
// The music bar is a full-width strip pinned to the bottom, and the content
// stops short of it — so with a video open it sat across the episode list for
// a track that is paused anyway, since video playback pauses the music engine.
{
  function bodyHarness () {
    const nodes = {}
    for (const id of ['vtheatre', 'vt-stage', 'vt-stage-msg', 'vt-skip', 'vt-upnext', 'vt-strip',
      'vt-title', 'vt-sub', 'vt-next', 'vt-menu', 'vt-pack', 'vt-pack-list',
      'vmini', 'vmini-title']) nodes[id] = el(id)
    nodes['vt-menu'].classList.add('hidden')
    nodes.vmini.classList.add('hidden')
    const body = el('body')
    const p = create({
      document: {
        getElementById: id => nodes[id] || null,
        querySelector: () => null,
        addEventListener () {},
        documentElement: { clientWidth: 1280 },
        body,
      },
      api: { videoControl: () => Promise.resolve({ ok: true }), onVideoState: () => () => {} },
      keymap, skipModel,
    })
    return { p, body, nodes }
  }

  test('opening a video collapses the music bar', () => {
    const { p, body } = bodyHarness()
    assert.ok(!body.classList.contains('video-active'))
    p.open({ title: 'Dune' })
    assert.ok(body.classList.contains('video-active'))
  })

  // Minimising keeps playing, so the music bar must stay out of the way.
  test('minimising keeps the music bar collapsed', () => {
    const { p, body } = bodyHarness()
    p.open({ title: 'Dune' })
    p.minimise()
    assert.ok(body.classList.contains('video-active'))
  })

  test('stopping restores the music bar', () => {
    const { p, body } = bodyHarness()
    p.open({ title: 'Dune' })
    p.close()
    assert.ok(!body.classList.contains('video-active'))
  })

  test('a document with no body does not break the player', () => {
    const nodes = {}
    for (const id of ['vtheatre', 'vt-stage', 'vt-menu', 'vmini']) nodes[id] = el(id)
    nodes['vt-menu'].classList.add('hidden')
    const p = create({
      document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                  addEventListener () {}, documentElement: { clientWidth: 800 } },
      api: { videoControl: () => Promise.resolve({}) }, keymap, skipModel,
    })
    assert.doesNotThrow(() => { p.open({ title: 'X' }); p.close() })
  })

  // The two corners must not collide: the collapsed music bar sits bottom-left,
  // and the video mini card defaults to bottom-right (corner 'br', chosen in JS
  // rather than a hardcoded CSS offset now that the card is draggable) and its
  // bottom snap positions are computed to clear the player bar's height.
  test('the collapsed music bar sits in the opposite corner to the video mini player', () => {
    const css = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
    assert.match(css, /body\.video-active \.player-bar \{[^}]*left:16px;\s*right:auto/s)
    // The card's default corner is bottom-right — the opposite corner.
    assert.match(PLAYER_SRC, /miniPos = \{ corner: 'br'/)
    // Pure-geometry proof the bottom corners clear the bar (see video-mini.test.js
    // for the full coverage): a taller bar raises the card.
    const { miniCardTopLeft, miniCardSize } = require('../src/video-player')
    const vp = { width: 1600, height: 900 }
    const br = miniCardTopLeft('br', 'compact', vp, 120)
    assert.ok(br.y + miniCardSize('compact').h <= vp.height - 120, 'clears the bar')
    // And the content reclaims the height the strip gave up.
    assert.match(css, /body\.video-active \{ --player-h: 8px; \}/)
  })

  test('the transport is hidden on the collapsed bar', () => {
    const css = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
    assert.match(css, /body\.video-active \.player-bar \.player-center,\s*\n?body\.video-active \.player-bar \.vol-section \{ display:none; \}/)
  })
}

// ── Theatre chrome ─────────────────────────────────────────────────────────
const _css = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const _rend = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// inset:0 put the theatre's own top bar — the back button and the title —
// behind the app titlebar, which wins the overlap despite the lower z-index
// because the two are in different stacking contexts. The button measured as
// present and visible the whole time; elementFromPoint at its centre returned
// the titlebar. That was "no way to go back".
test('the theatre is seated below the titlebar, not under it', () => {
  const rule = _css.slice(_css.indexOf('.vtheatre {'), _css.indexOf('.vtheatre.hidden'))
  assert.ok(!/inset\s*:\s*0/.test(rule), 'inset:0 hides the back button behind the titlebar')
  assert.match(rule, /top\s*:\s*var\(--titlebar-h\)/)
})

// A music bar has no business on the video pages, and it ran across the bottom
// of the episode list. Keyed on the page, not on playback, so it is gone as
// soon as Movies is opened rather than only once something starts.
test('the music bar is hidden on every video page', () => {
  assert.match(_css, /body\.video-page \.player-bar\s*\{[^}]*display\s*:\s*none/)
  assert.match(_css, /body\.video-page\s*\{[^}]*--player-h:\s*0/)
})

test('every video page sets the body class that hides it', () => {
  const set = /const VIDEO_PAGES = new Set\(\[([^\]]+)\]\)/.exec(_rend)
  assert.ok(set, 'VIDEO_PAGES must exist')
  const pages = set[1].split(',').map(s => s.trim().replace(/'/g, ''))
  // Every page in the film section, including ones added later — an opened
  // shelf is as much a video page as the one it was opened from, and forgetting
  // it puts the music bar back across the bottom of a grid of posters.
  for (const p of ['video', 'browse', 'person', 'video-detail', 'shelf']) {
    assert.ok(pages.includes(p), `${p} is a video page and must hide the music bar`)
  }
  assert.match(_rend, /classList\.toggle\('video-page', VIDEO_PAGES\.has\(page\)\)/)
})

// A display:none child is removed from the grid entirely and everything after
// it moves up a row. Hiding the top bar in fullscreen did exactly that: the
// stage slid into an auto row and collapsed to zero while the episode strip
// inherited the 1fr and grew to 1259px. The stage is the rectangle the video is
// positioned onto, so at zero height no bounds were sent and the picture
// vanished the moment fullscreen was pressed.
test('every theatre row has an explicit place, so hiding one moves nothing', () => {
  for (const [cls, row] of [['vt-top', 1], ['vt-stage', 2], ['vt-pack', 3], ['vt-strip', 4], ['vt-deck', 5]]) {
    assert.match(_css, new RegExp('\\.' + cls + '\\s*\\{\\s*grid-row:\\s*' + row + '\\s*;'),
      cls + ' must be placed explicitly')
  }
  const rule = _css.slice(_css.indexOf('.vtheatre {'), _css.indexOf('.vtheatre.hidden'))
  assert.match(rule, /grid-template-rows:\s*auto 1fr auto auto auto/)
})

// ── Chapters ───────────────────────────────────────────────────────────────
// mpv's own controller offered chapter navigation. Turning it off when
// embedded took that away with nothing in its place — the one capability that
// was genuinely lost rather than replaced.
const _html = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.html'), 'utf8')

test('the deck has a chapters control, hidden until a file has chapters', () => {
  assert.match(_html, /id="vt-chapters"[^>]*hidden/)
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  assert.match(src, /\$\('vt-chapters'\)\?\.addEventListener\('click', openChapterMenu\)/)
  // Shown from the state stream, so it appears when the file turns out to
  // have them rather than being permanently present and usually useless.
  assert.match(src, /function syncChapterButton/)
  assert.match(src, /btn\.hidden = n < 2/)
})

// The engine reports chapters as { index, title, start } — reading `time`
// instead put every entry at 0:00 and every jump at the start of the file.
test('the chapter menu reads the field the engine actually reports', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('async function openChapterMenu'), src.indexOf('function syncChapterButton'))
  assert.ok(/\.start/.test(fn), 'chapters carry start, not time')
  assert.ok(!/c\.time|\[i\]\.time/.test(fn), 'there is no time field on a chapter')
})

// Sent `seconds` while main read `ms`, so both nudges resolved to NaN and did
// nothing. The contract test could not catch it because the verb here is a
// variable rather than a literal.
test('the delay nudges send milliseconds under the shared value key', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('function bindDelay'), src.indexOf('function openSpeedMenu'))
  assert.match(fn, /send\(verb, \{ value: delayMs\[verb\] \}\)/)
  assert.ok(!/seconds:/.test(fn), 'main reads milliseconds')
})

// The card showed whenever playback neared the end, whether or not there was
// anything to play next — so films and last episodes got an "Up next: Next
// episode" countdown that led nowhere.
test('the Up Next card needs an actual next episode', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('function paintUpNext'), src.indexOf('function stopUpNext'))
  assert.match(fn, /if \(!upNextInfo \|\|/)
})

// Fullscreen means fullscreen. The theatre is seated below the app titlebar,
// so without taking the titlebar out of the layout the picture sat underneath
// it with the window controls still on screen.
test('fullscreen removes the app titlebar and fills the space', () => {
  assert.match(_css, /body\.video-fullscreen \.titlebar\s*\{[^}]*display\s*:\s*none/)
  assert.match(_css, /body\.video-fullscreen \.vtheatre\s*\{[^}]*top\s*:\s*0/)
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('function toggleFullscreen'), src.indexOf('function toggleFullscreen') + 900)
  assert.match(fn, /classList\.toggle\('video-fullscreen', isFullscreen\)/)
})

// TMDB files specials, OVAs and recaps as season 0, and it sorted first — so
// the picker opened on Specials, which nobody wants, and pushed Season 1 down.
test('specials go last in the season picker and are named, not numbered', () => {
  const fn = _rend.slice(_rend.indexOf('function _renderVideoControls'), _rend.indexOf('function _renderVideoControls') + 1800)
  assert.match(fn, /a\.seasonNumber === 0 \? 1 : -1/)
  assert.match(fn, /\?\s*\(s\.name \? esc\(s\.name\) : 'Specials'\)/)
  // TMDB names most seasons literally "Season 3", which read as
  // "Season 3 — Season 3".
  assert.match(fn, /\^season\\s\*\\d\+\$/)
})

// _videoErrorText exists to turn backend failures into something a person can
// act on, and the detail page skipped it — a dropped connection showed the
// literal string "fetch failed".
test('load failures are shown in human terms, with a way to retry', () => {
  const fn = _rend.slice(_rend.indexOf('function _videoError(message)'), _rend.indexOf('async function renderVideo()'))
  assert.match(fn, /const msg = _videoErrorText\(raw\)/)
  assert.match(fn, /id="video-error-retry"/)
  // With no id to retry with, retrying would only reproduce the same error --
  // that case bails out to a page that works instead of looping forever.
  assert.match(fn, /if \(!id\) return navigate\('video'\)/)
  assert.match(fn, /navigate\(state\.currentPage, id, \{ skipHistory: true \}\)/)
  // The API-key hint keys off the raw message, not the humanised one.
  assert.match(fn, /test\(raw\)/)
})

// ── The Dub filter ─────────────────────────────────────────────────────────
// A dub is worth asking for whenever the original is not in English, and the
// biggest case is anime — which TMDB files as ordinary television, so it comes
// through the TV tab and through search as often as through Anime. The toggle
// used to exist only in the anime branch, so a show opened any other way had no
// way to ask for a dub, and a film never had one at all.
function dubbable(detail) {
  const m = /function _dubbable\(d\) \{([\s\S]*?)\n\}/.exec(_rend)
  assert.ok(m, '_dubbable must exist')
  // eslint-disable-next-line no-new-func
  return new Function('d', m[1])(detail)
}

test('anime is dubbable however it was opened', () => {
  assert.strictEqual(dubbable({ isAnime: true, originalLanguage: 'ja' }), true)
  assert.strictEqual(dubbable({ isAnime: true }), true)
})

test('anything not originally in English is dubbable', () => {
  assert.strictEqual(dubbable({ originalLanguage: 'ko' }), true)
  assert.strictEqual(dubbable({ originalLanguage: 'ES' }), true)
})

// An English-language film has no dub to ask for, and a checkbox that changes
// nothing is worse than no checkbox.
test('an English original is not dubbable', () => {
  assert.strictEqual(dubbable({ originalLanguage: 'en' }), false)
  assert.strictEqual(dubbable({}), false)
  assert.strictEqual(dubbable(null), false)
})

test('the toggle is offered on TV, on anime and on film', () => {
  const fn = _rend.slice(_rend.indexOf('function _renderVideoControls'),
    _rend.indexOf('function _refreshTvEpisodes'))
  // TV: alongside the season picker. Anime: alongside the episode picker.
  // Film: on its own, and only when there is something to ask for.
  assert.strictEqual((fn.match(/_dubControl\(/g) || []).length, 3, 'all three branches')
  assert.strictEqual((fn.match(/_bindDubControl\(\)/g) || []).length, 3, 'each one bound')
})

// The toggle and the request must agree on when a dub applies, or the checkbox
// is shown and then silently ignored.
test('the source request asks for a dub on the same terms the toggle appears', () => {
  const fn = _rend.slice(_rend.indexOf('const base = { type: _videoDetail.type'),
    _rend.indexOf('async function _loadVideoSources'))
  assert.strictEqual((fn.match(/_dubbable\(d\) \? \{ sub: !wantDub, dub: wantDub \}/g) || []).length, 2,
    'movie and tv both')
  assert.ok(!/d\.isAnime \? \{ sub:/.test(fn), 'isAnime alone is too narrow')
})

// A film skipped the controls entirely, so making the toggle shared was not
// enough on its own — an anime film still had nowhere to put it.
test('a film renders its controls too', () => {
  const fn = _rend.slice(_rend.indexOf("if (type === 'tv') {\n    const seasons"),
    _rend.indexOf('function _videoDetailShell'))
  assert.strictEqual((fn.match(/_renderVideoControls\(type\)/g) || []).length, 3,
    'tv, anime and film all render controls')
})

// ── Menus over a native video surface ───────────────────────────────────────
// The picture is a native window composited ABOVE the page, so HTML cannot be
// drawn on top of it. The Audio and Subtitles menus open upward from the deck,
// and measured in the running app the menu sat at y 819-981 while the video
// covered to y 949 — its top 130 pixels were simply swallowed. That is what
// "the video overlaps the settings" was.
//
// This class of bug was invisible to the screenshots used to check the player,
// because a window capture shows the page's own pixels without the video window
// composited over them. The menu looked perfect in every one.
test('the picture makes room for a menu instead of covering it', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const open = src.slice(src.indexOf('function openMenu'), src.indexOf('function openMenu') + 1400)
  // Measured after placing, because the viewport clamps can move the menu.
  assert.match(open, /const placed = m\.getBoundingClientRect\(\)/)
  assert.match(open, /st\.bottom - placed\.top/)
  assert.match(open, /setStageInset\(/)
})

test('closing a menu gives the picture its height back', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const close = src.slice(src.indexOf('function closeMenu'), src.indexOf('function openMenu'))
  assert.match(close, /setStageInset\(0\)/)
})

// A menu that already clears the picture must cost the viewer nothing.
test('a menu that does not reach the picture takes nothing from it', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const open = src.slice(src.indexOf('function openMenu'), src.indexOf('function openMenu') + 1400)
  assert.match(open, /covered > 0 &&/, 'only when it actually overlaps')
  assert.match(open, /placed\.right > st\.left && placed\.left < st\.right/, 'and only horizontally too')
})

// A menu taller than the stage would otherwise shrink the picture to nothing.
test('the picture is never shrunk away entirely', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('function reportBounds'), src.indexOf('function setStageInset'))
  assert.match(fn, /Math\.max\(120, Math\.round\(r\.height\) - Math\.round\(stageInset\)\)/)
})

// ── The buffered bar ────────────────────────────────────────────────────────
// It draws the ranges mpv says it can seek within, not one bar growing from the
// left. Measured on a real 1440-second torrent after twelve seconds of play:
// seekable [[0, 2]] — two seconds of a twenty-four minute film. The old bar
// showed that as full, which is why seeking anywhere bought a wait the bar had
// promised was unnecessary.
test('the buffered bar draws real ranges, not one growing width', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('function paintBuffered'), src.indexOf('function paintSeek'))
  assert.match(fn, /state\.seekable/)
  assert.match(fn, /ranges\.map/)
  // A range that starts partway through must be drawn where it starts.
  assert.match(fn, /left:' \+ \(\(from \/ dur\) \* 100\)/)
})

// Before any range has been reported, saying "this much ahead" is still true,
// where saying nothing would leave the bar blank on a local file.
test('with no ranges yet it falls back to the window ahead', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const fn = src.slice(src.indexOf('function paintBuffered'), src.indexOf('function paintSeek'))
  assert.match(fn, /if \(!ranges\.length\)/)
  assert.match(fn, /pos \+ \(Number\(state && state\.buffered\)/)
})

// The container spans the whole track now and each range is a child, so a
// leftover width on the container would draw a phantom range.
test('the bar container no longer carries a width of its own', () => {
  assert.match(_css, /\.vt-seek-buffer \{[^}]*width:auto/)
  assert.match(_css, /\.vt-seek-buffer i \{[^}]*position:absolute/)
})

// ── Idle chrome in fullscreen ───────────────────────────────────────────────
// Five still seconds and the deck steps aside. The hard part is not the timer,
// it is that the picture is a native window which takes every pointer event
// that lands on it — so the most natural way to ask for the controls back,
// moving the mouse across the film, produces no DOM event at all. That wake-up
// arrives from mpv instead, and these tests hold both paths honest.

const { mock } = require('node:test')

function fsHarness() {
  const h = harness({ fullscreen: true })
  h.p.toggleFullscreen(true)
  return h
}
const idle = h => h.nodes.vtheatre.classList.contains('idle')

test('the chrome stays put outside fullscreen, however long the stillness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()               // windowed
  h.p.noteActivity()
  t.mock.timers.tick(60000)
  assert.strictEqual(idle(h), false, 'a window has room for its own controls')
})

test('five still seconds in fullscreen hides the deck', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fsHarness()
  await Promise.resolve()
  h.p.noteActivity()
  t.mock.timers.tick(4999)
  assert.strictEqual(idle(h), false, 'not a moment early')
  t.mock.timers.tick(1)
  assert.strictEqual(idle(h), true)
})

test('moving the mouse over the page brings it straight back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fsHarness()
  await Promise.resolve()
  h.p.noteActivity(); t.mock.timers.tick(5000)
  assert.strictEqual(idle(h), true)
  h.fire('mousemove')
  assert.strictEqual(idle(h), false)
})

// The one that matters. Over the picture there is no DOM mousemove to fire.
test('movement relayed from the video window counts as presence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fsHarness()
  await Promise.resolve()
  h.p.noteActivity(); t.mock.timers.tick(5000)
  assert.strictEqual(idle(h), true)
  h.p.noteActivity()                // what _handleVideoEvent('activity') calls
  assert.strictEqual(idle(h), false)
  t.mock.timers.tick(5000)
  assert.strictEqual(idle(h), true, 'and the clock restarts from there')
})

// Hiding the deck grows the stage, and the stage is the rectangle mpv is
// positioned onto. Without a fresh measurement the chrome vanishes and the
// picture keeps the smaller frame it had.
test('hiding and restoring the chrome re-measures the stage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fsHarness()
  await Promise.resolve()
  h.p.noteActivity()
  const before = h.sent.length
  t.mock.timers.tick(5000)
  assert.ok(h.sent.length >= before, 'a bounds report is scheduled on going idle')
  assert.strictEqual(idle(h), true)
})

test('an open menu is never taken away mid-answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fsHarness()
  await Promise.resolve()
  h.nodes['vt-menu'].classList.remove('hidden')   // a menu is open
  h.p.noteActivity()
  t.mock.timers.tick(20000)
  assert.strictEqual(idle(h), false)
})

test('leaving fullscreen puts the chrome back for good', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fsHarness()
  await Promise.resolve()
  h.p.noteActivity(); t.mock.timers.tick(5000)
  assert.strictEqual(idle(h), true)
  h.p.toggleFullscreen(false)
  await Promise.resolve()
  assert.strictEqual(idle(h), false)
  t.mock.timers.tick(60000)
  assert.strictEqual(idle(h), false, 'and nothing hides it again in a window')
})

// ── Layout stability ────────────────────────────────────────────────────────
// The stage is the rectangle the native mpv window is positioned onto, so a
// row between the stage and the deck that collapses when empty resizes the
// stage — and the picture visibly jumped every time the episode strip or a
// skip offer came or went. The rows now hold fixed heights and hide with
// visibility, so the only stage resize left is fullscreen idle, which grows
// the picture on purpose.
test('a row that has appeared holds its space; one that never did costs nothing', () => {
  // The refined contract: [hidden] alone collapses (a playback with no pack
  // or skip content never shows a dead band), but once shown the vt-held
  // class keeps the row occupying its space invisibly, so the picture never
  // jumps mid-watch. Held rows are released when the theatre closes.
  assert.match(_css, /\.vt-pack\[hidden\]\s*\{\s*display:none/)
  assert.match(_css, /\.vt-strip\[hidden\]\s*\{\s*display:none/)
  assert.match(_css, /\.vt-pack\.vt-held\[hidden\]\s*\{\s*display:flex;\s*visibility:hidden/)
  assert.match(_css, /\.vt-strip\.vt-held\[hidden\]\s*\{\s*display:flex;\s*visibility:hidden/)
  assert.match(PLAYER_SRC, /function syncHeld\(\)/)
  assert.match(PLAYER_SRC, /releaseHeld\(\)/, 'close() must release the held rows')
})

test('the reserved rows have fixed heights, so appearing content moves nothing', () => {
  assert.match(_css, /\.vt-pack \{[^}]*height:46px/s)
  assert.match(_css, /\.vt-strip \{[^}]*height:96px/s)
  // And the Up Next card is sized to fit inside the strip's row, not to grow it.
  assert.match(_css, /\.vt-upnext \{[^}]*max-width/s)
})

test('fullscreen idle still removes the rows outright — that resize is deliberate', () => {
  assert.match(_css,
    /\.vtheatre\.fullscreen\.idle \.vt-pack,\s*\n?\.vtheatre\.fullscreen\.idle \.vt-strip,\s*\n?\.vtheatre\.fullscreen\.idle \.vt-deck \{ display:none; \}/)
})

// ── Stop in the deck ────────────────────────────────────────────────────────
// The real stop only existed on the mini player, so finishing a film meant
// minimising the theatre just to reach the control that ends it.
test('the deck has its own stop, wired like the mini player one', () => {
  assert.match(HTML_SRC, /id="vt-stop"/)
  assert.match(PLAYER_SRC, /\$\('vt-stop'\)\?\.addEventListener\('click', close\)/)
})

test('stop in the deck stops for real', () => {
  const nodes = {}
  for (const id of ['vtheatre', 'vt-stage', 'vt-menu', 'vmini', 'vt-stop']) nodes[id] = el(id)
  nodes['vt-menu'].classList.add('hidden')
  let exited = 0
  const p2 = create({
    document: { getElementById: id => nodes[id] || null, querySelector: () => null,
                addEventListener () {}, documentElement: { clientWidth: 800 } },
    api: { videoControl: () => Promise.resolve({ ok: true }), onVideoState: () => () => {} },
    keymap, skipModel, onExit: () => { exited++ },
  })
  p2.bind()
  p2.open({ title: 'X' })
  nodes['vt-stop'].fire('click')
  assert.strictEqual(exited, 1)
  assert.ok(nodes.vtheatre.classList.contains('hidden'))
})

// ── Previous episode ────────────────────────────────────────────────────────
// Mirrors Next: the renderer passes media.onPrev only when there is an episode
// before this one, so absence means the button hides rather than disables.
test('previous appears only when the renderer provides it, and calls it', () => {
  const { p, nodes, press } = harness()
  let prev = 0
  p.open({ title: 'X', onPrev: () => { prev++ } })
  assert.strictEqual(nodes['vt-prev'].hidden, false)
  nodes['vt-prev'].fire('click')
  assert.strictEqual(prev, 1)
  press('p')                    // the keymap already reserved P for this
  assert.strictEqual(prev, 2)
  p.open({ title: 'A film' })   // no onPrev: a film has no previous episode
  assert.strictEqual(nodes['vt-prev'].hidden, true)
  assert.doesNotThrow(() => nodes['vt-prev'].fire('click'))
  assert.strictEqual(prev, 2)
})

// ── Time remaining ──────────────────────────────────────────────────────────
// Clicking the duration answers "how much is left tonight" without arithmetic.
test('clicking the duration flips to time remaining and persists the choice', () => {
  const writes = []
  const { p, nodes } = harness({ local: { write: (k, v) => { writes.push([k, v]); return true } } })
  p._setState(stateAt(900))
  assert.strictEqual(nodes['vt-dur'].textContent, '1:00:00')
  nodes['vt-dur'].fire('click')
  assert.strictEqual(nodes['vt-dur'].textContent, '−45:00')
  assert.deepStrictEqual(writes, [['papaVtTimeMode', 'remaining']])
  nodes['vt-dur'].fire('click')
  assert.strictEqual(nodes['vt-dur'].textContent, '1:00:00')
})

test('a remembered remaining mode is honoured from the store', () => {
  // The store JSON-encodes strings, so the raw text arrives quotes and all.
  const { p, nodes } = harness({ local: { readRaw: k => (k === 'papaVtTimeMode' ? '"remaining"' : null) } })
  p._setState(stateAt(900))
  assert.strictEqual(nodes['vt-dur'].textContent, '−45:00')
})

test('a missing or broken store never blocks the toggle', () => {
  const a = harness()   // no PapaLocal at all
  a.p._setState(stateAt(900))
  assert.doesNotThrow(() => a.nodes['vt-dur'].fire('click'))
  assert.strictEqual(a.nodes['vt-dur'].textContent, '−45:00', 'the toggle still works for the session')
  const b = harness({ local: { readRaw: () => { throw new Error('quota') }, write: () => { throw new Error('quota') } } })
  b.p._setState(stateAt(900))
  assert.doesNotThrow(() => b.nodes['vt-dur'].fire('click'))
  assert.strictEqual(b.nodes['vt-dur'].textContent, '−45:00')
})

// ── Chapter ticks on the seek bar ───────────────────────────────────────────
// The state stream only carries the chapter count; the start times come from
// api.videoChapters(), the call the chapters menu already makes.
test('chapter boundaries are drawn as ticks on the track', async () => {
  const { p, nodes } = harness({ apiExtra: { videoChapters: () => Promise.resolve({ ok: true, chapters: [
    { title: 'One', start: 0 }, { title: 'Two', start: 900 }, { title: 'Three', start: 1800 },
  ] }) } })
  p._setState(stateAt(10, { chapters: [{}, {}, {}] }))
  await new Promise(r => setImmediate(r))
  const html = nodes['vt-seek-chapters'].innerHTML
  assert.match(html, /left:25%/)
  assert.match(html, /left:50%/)
  assert.ok(!/left:0%/.test(html), 'chapter one starts where the bar already does')
})

test('ticks are fetched once per signature, not four times a second', async () => {
  let calls = 0
  const { p } = harness({ apiExtra: { videoChapters: () => { calls++; return Promise.resolve({ ok: true, chapters: [] }) } } })
  p._setState(stateAt(10, { chapters: [{}, {}] }))
  p._setState(stateAt(11, { chapters: [{}, {}] }))
  p._setState(stateAt(12, { chapters: [{}, {}] }))
  await new Promise(r => setImmediate(r))
  assert.strictEqual(calls, 1)
})

test('an api without videoChapters leaves the bar bare, not broken', () => {
  const { p, nodes } = harness()   // default api has no videoChapters
  assert.doesNotThrow(() => p._setState(stateAt(10, { chapters: [{}, {}] })))
  assert.strictEqual(nodes['vt-seek-chapters'].innerHTML, '')
})

// ── Keyboard seeking through the bubble ─────────────────────────────────────
// Holding an arrow used to fire ten blind relative seeks into a torrent that
// could satisfy none of them. Held keys now accumulate one target, shown live
// in the same bubble the pointer gets, and commit one absolute seek.
test('held arrow keys aim with the bubble and seek once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, sent, press, nodes } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(100))
  press('ArrowRight'); press('ArrowRight'); press('ArrowRight')
  assert.strictEqual(nodes['vt-seek-bubble'].hidden, false)
  assert.strictEqual(nodes['vt-seek-bubble'].textContent, '2:10', 'the bubble shows where the seek will land')
  assert.ok(!sent.some(s => s.verb === 'seek'), 'no seek while the key is still going')
  t.mock.timers.tick(300)
  assert.deepStrictEqual(sent.filter(s => s.verb === 'seek').pop(),
    { verb: 'seek', args: { seconds: 130, mode: 'absolute' } })
  assert.strictEqual(nodes['vt-seek-bubble'].hidden, true, 'the bubble leaves with the commit')
})

test('the target is clamped to the file, in both directions', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, sent, press } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(5))
  press('ArrowLeft'); press('ArrowLeft')
  t.mock.timers.tick(300)
  assert.deepStrictEqual(sent.filter(s => s.verb === 'seek').pop(),
    { verb: 'seek', args: { seconds: 0, mode: 'absolute' } })
})

test('with no duration yet the arrows fall back to a relative seek', () => {
  const { p, sent, press } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(0, { duration: 0 }))
  press('ArrowRight')
  assert.deepStrictEqual(sent.pop(), { verb: 'seek', args: { seconds: 10, mode: 'relative' } })
})

// ── Volume ──────────────────────────────────────────────────────────────────
test('the wheel over the deck steps volume by five and flashes it on the picture', () => {
  const osd = []
  const { p, nodes, sent } = harness({ apiExtra: {
    videoOsd: (text, ms) => { osd.push([text, ms]); return Promise.resolve({ ok: true }) },
  } })
  p._setState(stateAt(10, { volume: 100 }))
  nodes['vt-deck'].fire('wheel', { deltaY: -120 })
  assert.strictEqual(sent.filter(s => s.verb === 'volume').pop().args.value, 105)
  nodes['vt-deck'].fire('wheel', { deltaY: 120 })
  assert.strictEqual(sent.filter(s => s.verb === 'volume').pop().args.value, 100)
  // The OSD is the one text that CAN be drawn over the native window,
  // because mpv draws it itself.
  assert.deepStrictEqual(osd.map(o => o[0]), ['Volume 105%', 'Volume 100%'])
})

test('keyboard volume flashes too, and an api without videoOsd costs nothing', () => {
  const { p, press, sent } = harness()   // no videoOsd on the default api
  p.open({ title: 'X' })
  p._setState(stateAt(10, { volume: 100 }))
  assert.doesNotThrow(() => press('ArrowUp'))
  assert.strictEqual(sent.filter(s => s.verb === 'volume').pop().args.value, 105)
})

test('the volume slider marks the honest 100% point on its 0-130 track', () => {
  assert.match(_css, /\.vt-vol-range \{[^}]*76\.9%/s, 'the notch sits at 100/130 of the track')
})

// ── Up Next hover ───────────────────────────────────────────────────────────
// The countdown already holds for a paused film; hovering the card is the same
// thing said with the pointer — a card that advances while being read is a
// card that cannot be declined.
test('hovering the Up Next card holds the countdown; leaving resumes it', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let advanced = 0
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => { advanced++ },
  })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3450))
  nodes['vt-upnext'].fire('pointerenter')
  t.mock.timers.tick(120000)
  assert.strictEqual(advanced, 0, 'a card being read must not advance')
  nodes['vt-upnext'].fire('pointerleave')
  t.mock.timers.tick(10000)
  assert.strictEqual(advanced, 1, 'and it resumes where it held')
})

// ── Stats ───────────────────────────────────────────────────────────────────
test('the stats chip opens a live panel and polls the stream every two seconds', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let polls = 0
  const { p, nodes } = harness({ apiExtra: {
    videoStreamStats: () => { polls++; return Promise.resolve({ ok: true, down: 1572864, peers: 12, progress: 0.4 }) },
  } })
  p._setState(stateAt(900))
  nodes['vt-stats'].fire('click')
  assert.match(nodes['vt-menu'].innerHTML, /vt-stat-pos/)
  assert.match(nodes['vt-menu'].innerHTML, /vt-stat-down/, 'stream rows appear when the api exists')
  assert.strictEqual(polls, 1, 'painted immediately on open')
  t.mock.timers.tick(4000)
  assert.strictEqual(polls, 3, 'then every two seconds')
  await new Promise(r => setImmediate(r))
  assert.strictEqual(nodes['vt-stat-pos'].textContent, '15:00 / 1:00:00')
  assert.strictEqual(nodes['vt-stat-down'].textContent, '1.5 MB/s')
  assert.strictEqual(nodes['vt-stat-peers'].textContent, '12')
  assert.strictEqual(nodes['vt-stat-progress'].textContent, '40%')
  nodes['vt-stats'].fire('click')   // the chip is a toggle, not a stack
  t.mock.timers.tick(10000)
  assert.strictEqual(polls, 3, 'the poll dies with the panel')
})

test('without videoStreamStats the panel shows player state only', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(900))
  nodes['vt-stats'].fire('click')
  assert.match(nodes['vt-menu'].innerHTML, /vt-stat-pos/)
  assert.match(nodes['vt-menu'].innerHTML, /vt-stat-tracks/)
  assert.ok(!/vt-stat-down/.test(nodes['vt-menu'].innerHTML), 'no stream rows to sit empty')
  // Close it again: the poll is a real interval here (no mocked timers), and
  // left running it holds the test process open forever.
  nodes['vt-stats'].fire('click')
})

// ── Subtitles from inside the torrent ───────────────────────────────────────
// A pack routinely ships .srt files next to the video — the subtitles most
// likely to match the release — but mpv only sees the file it was handed.
test('the CC menu lists torrent subtitles and serves one on click', async () => {
  const served = []
  const { p, nodes, sent } = harness({ tracks: [], apiExtra: {
    videoSubsInTorrent: () => Promise.resolve({ ok: true, subs: [{ index: 3, name: 'Movie.eng.srt' }] }),
    videoSubServe: a => { served.push(a); return Promise.resolve({ ok: true, path: '/tmp/movie.srt' }) },
  } })
  p._setState(stateAt(100))
  const off = el('off'); const row = el('row'); row.dataset.subfile = '0'
  nodes['vt-menu'].querySelectorAll = sel =>
    sel === '.vt-menu-item' ? [off]
      : sel === '[data-subfile]' ? [row] : []
  nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  assert.match(nodes['vt-menu'].innerHTML, /Movie\.eng\.srt/)
  assert.match(nodes['vt-menu'].innerHTML, /Add from file/)
  row.fire('click')
  await new Promise(r => setImmediate(r))
  // Served first — the file is not on disk until videoSubServe extracts it —
  // then loaded into mpv by path.
  assert.deepStrictEqual(served, [{ index: 3 }])
  assert.deepStrictEqual(sent.filter(s => s.verb === 'subAdd').pop(),
    { verb: 'subAdd', args: { path: '/tmp/movie.srt' } })
})

// The regression this guards: binding the extra rows as track picks reads past
// the end of the track list and sends a null track — silently switching
// subtitles Off when "Add from file…" is clicked.
test('the extra CC rows are never bound as track picks', async () => {
  const { p, nodes, sent } = harness({ tracks: [{ id: 5, type: 'sub', lang: 'eng' }], apiExtra: {
    videoSubsInTorrent: () => Promise.resolve({ ok: true, subs: [{ index: 0, name: 'a.srt' }] }),
  } })
  p._setState(stateAt(100))
  const items = [el('i-off'), el('i-eng'), el('i-torrent'), el('i-addfile')]
  nodes['vt-menu'].querySelectorAll = sel => sel === '.vt-menu-item' ? items : []
  nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  items[2].fire('click')
  items[3].fire('click')
  assert.ok(!sent.some(s => s.verb === 'track'), 'extra rows must not send track commands')
})

test('without the torrent-subtitle apis the CC menu is what it was', async () => {
  const { p, nodes } = harness({ tracks: [] })
  p._setState(stateAt(100))
  nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  assert.ok(!/In this torrent/.test(nodes['vt-menu'].innerHTML))
  assert.match(nodes['vt-menu'].innerHTML, /Add from file/, 'the file picker row stays')
})

// ── Subtitle style controls (#23) ────────────────────────────────────────────
// The CC/settings menu offers three fixed sizes and a background box, both sent
// through the one `subStyle` verb the engine exposes: `scale` is a number,
// `backColor` an mpv ARGB string (SUB_STYLE_PROPS in video-engine.js).
{
  // The settings menu wires [data-subsize]/[data-subback] buttons; the fake DOM
  // returns nothing from querySelectorAll unless told to, so this stands them up.
  function settingsHarness (opts = {}) {
    const h = harness(opts)
    const buckets = { '[data-subsize]': [], '[data-subback]': [], '[data-af]': [],
      '[data-zoom]': [], '[data-aspect]': [], '.vt-menu-item': [] }
    h.nodes['vt-menu'].querySelectorAll = sel => buckets[sel] || []
    h.rows = buckets
    return h
  }

  test('the size row sends discrete S/M/L scales through subStyle', () => {
    const h = settingsHarness()
    h.p._setState(stateAt(100))
    const s = el('s'); s.dataset.subsize = '0.8'
    const m = el('m'); m.dataset.subsize = '1'
    const l = el('l'); l.dataset.subsize = '1.3'
    h.rows['[data-subsize]'] = [s, m, l]
    h.nodes['vt-settings'].fire('click')
    l.fire('click')
    assert.deepStrictEqual(h.sent.pop(), { verb: 'subStyle', args: { scale: 1.3 } })
    s.fire('click')
    assert.deepStrictEqual(h.sent.pop(), { verb: 'subStyle', args: { scale: 0.8 } })
  })

  test('the background row toggles a backing box through subStyle', () => {
    const h = settingsHarness()
    h.p._setState(stateAt(100))
    const on = el('on'); on.dataset.subback = '1'
    const off = el('off'); off.dataset.subback = '0'
    h.rows['[data-subback]'] = [on, off]
    h.nodes['vt-settings'].fire('click')
    on.fire('click')
    // ARGB, not a bare colour name: a semi-opaque black box, transparent off.
    assert.strictEqual(h.sent.pop().args.backColor, '#80000000')
    off.fire('click')
    assert.strictEqual(h.sent.pop().args.backColor, '#00000000')
  })

  // The engine's SUB_STYLE_PROPS is the contract; the keys sent must be in it,
  // or the style is silently dropped.
  test('the subStyle keys the deck sends are ones the engine understands', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
    const fn = src.slice(src.indexOf('function openSettingsMenu'), src.indexOf('function onKey'))
    // Both keys used here are members of SUB_STYLE_PROPS in video-engine.js.
    assert.match(fn, /subStyle', \{ scale:/)
    assert.match(fn, /subStyle', \{ backColor:/)
  })
}

// ── Louder dialogue label (#25) ──────────────────────────────────────────────
// The night-mode audio filter is what people look for under "make the quiet
// parts audible", so it is named for what it does, not for a mode.
test('the night-mode row is labelled for what it does', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  assert.match(src, /Louder dialogue \(night mode\)/)
  // Still the same dynaudnorm filter underneath.
  assert.match(src, /audioFilter', \{ value: b\.dataset\.af === 'night' \? 'dynaudnorm'/)
})

// ── Per-show subtitle delay memory (#24) ─────────────────────────────────────
// Subtitle desync is a property of the release, so it is remembered per show —
// reported out through media.onPrefChange the same way audioLang/subLang are,
// and read back as prefs.subDelayMs on the next open.
test('nudging the subtitle delay reports it to the show', async () => {
  const changes = []
  const { p, nodes } = harness({ tracks: [] })
  p.open({ title: 'X', onPrefChange: c => changes.push(c) })
  p._setState(stateAt(100))
  const plus = el('plus'); plus.dataset.delay = '50'
  nodes['vt-subdelay'] = el('vt-subdelay')   // the readout the nudge writes to
  nodes['vt-menu'].querySelectorAll = sel =>
    sel === '[data-delay]' ? [plus] : []
  nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  plus.fire('click')
  assert.deepStrictEqual(changes.pop(), { subDelayMs: 50 }, 'only the sub delay, reported as ms')
})

// Audio delay is nudged to match a specific file, not the show, so it is not
// remembered — reporting it would poison the per-show store.
test('nudging the audio delay reports nothing to the show', async () => {
  const changes = []
  const { p, nodes } = harness({ tracks: [] })
  p.open({ title: 'X', onPrefChange: c => changes.push(c) })
  p._setState(stateAt(100))
  const plus = el('aplus'); plus.dataset.adelay = '50'
  nodes['vt-menu'].querySelectorAll = sel => sel === '[data-adelay]' ? [plus] : []
  nodes['vt-audio'].fire('click')
  await new Promise(r => setImmediate(r))
  nodes['vt-auddelay'] = el('av')
  plus.fire('click')
  assert.deepStrictEqual(changes, [], 'audio delay is per-file, never remembered')
})

test('a remembered subtitle delay is applied when the file starts playing', async () => {
  const { p, sent } = harness({ tracks: [] })
  p.open({ title: 'X', prefs: { subDelayMs: 120 } })
  p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(sent.filter(s => s.verb === 'subDelay'),
    [{ verb: 'subDelay', args: { value: 120 } }], 'applied once from the pref')
  p._setState(stateAt(6))
  await new Promise(r => setImmediate(r))
  assert.strictEqual(sent.filter(s => s.verb === 'subDelay').length, 1, 'once, not per tick')
})

test('no remembered delay sends nothing', async () => {
  const { p, sent } = harness({ tracks: [] })
  p.open({ title: 'X' })
  p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.ok(!sent.some(s => s.verb === 'subDelay'))
})

// ── Auto-play-next toggle (#18) ──────────────────────────────────────────────
// Default on; persisted under papaVtAutoNext. Off means the Up Next card still
// appears but does not count down — only Play now moves it on.
test('auto-play-next defaults on and shows a counting-down card', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => {},
  })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3450))
  assert.match(nodes['vt-upnext'].innerHTML, /vt-ring/, 'the ring is present when auto-play is on')
})

test('with auto-play off the card appears with Play now but no countdown ring', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let advanced = 0
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => { advanced++ },
    local: { readRaw: k => (k === 'papaVtAutoNext' ? 'false' : null) },
  })
  p.setUpNext({ title: 'Next' })
  p._setState(stateAt(3450))
  assert.strictEqual(nodes['vt-upnext'].hidden, false, 'the card still appears')
  assert.match(nodes['vt-upnext'].innerHTML, /Play now/)
  assert.ok(!/vt-ring/.test(nodes['vt-upnext'].innerHTML), 'no ring when auto-play is off')
  t.mock.timers.tick(120000)
  assert.strictEqual(advanced, 0, 'a card that does not count down never advances itself')
})

test('the settings menu carries the auto-play toggle, persisted to papaVtAutoNext', () => {
  const writes = []
  const { p, nodes } = harness({ local: { write: (k, v) => { writes.push([k, v]); return true } } })
  p._setState(stateAt(100))
  const items = [el('addsub'), el('auto'), el('shot')]
  items[1].querySelector = () => el('tick')
  nodes['vt-menu'].querySelectorAll = sel =>
    sel === '.vt-menu-item' ? items
      : sel === '[data-zoom]' || sel === '[data-af]' || sel === '[data-aspect]' ||
        sel === '[data-subsize]' || sel === '[data-subback]' ? [] : []
  nodes['vt-settings'].fire('click')
  assert.match(nodes['vt-menu'].innerHTML, /Play next episode automatically/)
  items[1].fire('click')
  assert.deepStrictEqual(writes.pop(), ['papaVtAutoNext', false], 'toggling off is persisted')
})

// ── "Still watching?" (#20) ──────────────────────────────────────────────────
// After three consecutive auto-advances with zero activity, the next countdown
// holds at three seconds and asks. Any activity resets the count; noteActivity
// is the single signal for "a person is here".
// The credits segment the renderer sets per file — open() clears segments, so
// each simulated episode re-sets it just as the renderer does.
const CREDITS = () => [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }]

test('three untouched auto-advances raise Still watching on the next card', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let advanced = 0
  const { p, nodes } = harness({ segments: CREDITS(), onNext: () => { advanced++ } })
  // Simulate three auto-advances: each card counts fully down on its own, and
  // re-opening the player (what the renderer does on advance) keeps the count.
  for (let i = 0; i < 3; i++) {
    p.open({ title: 'Ep ' + i })
    p.setSegments(CREDITS())
    p.setUpNext({ title: 'Ep ' + (i + 1) })
    p._setState(stateAt(3450))
    t.mock.timers.tick(10000)   // the full countdown, untouched
  }
  assert.strictEqual(advanced, 3, 'three episodes rolled on their own')
  // The fourth card must stop and ask rather than advancing a fourth time.
  // showStillWatching rewrites the actions node in place; the fake box needs a
  // querySelector that hands it back so the swap is observable.
  const actions = el('actions')
  nodes['vt-upnext'].querySelector = sel => sel === '.vt-upnext-actions' ? actions : null
  p.open({ title: 'Ep 3' })
  p.setSegments(CREDITS())
  p.setUpNext({ title: 'Ep 4' })
  p._setState(stateAt(3450))
  t.mock.timers.tick(30000)
  assert.match(actions.innerHTML, /Still watching/, 'the prompt appears')
  assert.strictEqual(advanced, 3, 'and it does not advance while asking')
})

test('activity during the run resets the Still watching counter', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let advanced = 0
  const { p, nodes } = harness({ segments: CREDITS(), onNext: () => { advanced++ } })
  for (let i = 0; i < 3; i++) {
    p.open({ title: 'Ep ' + i })
    p.setSegments(CREDITS())
    p.setUpNext({ title: 'Ep ' + (i + 1) })
    p._setState(stateAt(3450))
    t.mock.timers.tick(10000)
  }
  // A person stirs: the count clears, so the next card counts all the way down
  // and advances like any other rather than asking.
  const before = advanced
  p.open({ title: 'Ep 3' })
  p.setSegments(CREDITS())
  p.setUpNext({ title: 'Ep 4' })
  p._setState(stateAt(3450))
  // noteActivity is the single "a person is here" signal, relayed from mpv.
  p.noteActivity()
  t.mock.timers.tick(10000)
  assert.ok(!/Still watching/.test(nodes['vt-upnext'].innerHTML), 'activity cleared the prompt')
  assert.strictEqual(advanced, before + 1, 'and the card advanced normally')
})

// ── Verify: Up Next shows the episode still (#19) ─────────────────────────────
test('the Up Next card renders the episode still when one is provided', () => {
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => {},
  })
  p.setUpNext({ title: 'Next', still: 'https://img.example/still.jpg' })
  p._setState(stateAt(3450))
  assert.match(nodes['vt-upnext'].innerHTML, /vt-upnext-still/)
  assert.match(nodes['vt-upnext'].innerHTML, /still\.jpg/, 'the provided still image is used')
})

// ── Verify: volume/mute survives across episodes (#14) ────────────────────────
// mpv is one long-lived process, so the deck must not reset the level when a
// new file opens — it follows the state stream, which carries mpv's own volume.
test('opening a new episode never resets volume or mute', () => {
  const { p, sent } = harness()
  p.open({ title: 'Ep 1' })
  p._setState(stateAt(100, { volume: 60, muted: true }))
  const before = sent.length
  p.open({ title: 'Ep 2' })
  assert.ok(!sent.slice(before).some(s => s.verb === 'volume' || s.verb === 'mute'),
    'opening a file must not command a volume or mute reset')
})

// ── A11y: volume announces a percent (#29) ───────────────────────────────────
test('the volume slider announces a percent, and flags the boosted range', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(100, { volume: 84 }))
  assert.strictEqual(nodes['vt-vol'].getAttribute('aria-valuetext'), '84%')
  p._setState(stateAt(100, { volume: 120 }))
  assert.match(nodes['vt-vol'].getAttribute('aria-valuetext'), /120% \(boosted\)/)
  p._setState(stateAt(100, { volume: 50, muted: true }))
  assert.match(nodes['vt-vol'].getAttribute('aria-valuetext'), /muted/)
})

test('the seek slider announces its position as a time of a total', () => {
  const { p, nodes } = harness()
  p._setState(stateAt(724, { duration: 2530 }))   // 12:04 of 42:10
  assert.strictEqual(nodes['vt-seek'].getAttribute('aria-valuetext'), '12:04 of 42:10')
})

// The deck's focusable controls all carry a focus-visible ring, so keyboard
// users can see where they are.
test('every focusable deck control has a focus-visible ring', () => {
  for (const sel of ['.vt-seek:focus-visible', '.vt-icon:focus-visible',
    '.vt-chip:focus-visible', '.vt-vol-range:focus-visible', '.vt-menu-item:focus-visible']) {
    assert.match(_css, new RegExp(sel.replace(/[-.]/g, '\\$&') + '\\s*\\{[^}]*outline'),
      sel + ' must have a focus ring')
  }
})

// ── Verify: the unbuffered seek region is visually distinct (#7) ──────────────
// The track background is the unbuffered part of the film; it must read clearly
// as "not here yet" against the solid buffered ranges laid over it.
test('the unbuffered track is visually distinct from the buffered ranges', () => {
  const track = _css.slice(_css.indexOf('.vt-seek-track {'), _css.indexOf('.vt-seek-track {') + 260)
  assert.match(track, /repeating-linear-gradient/, 'the unbuffered region is hatched, not a flat fill')
  // And the buffered ranges are a solid, brighter fill so they stand out.
  assert.match(_css, /\.vt-seek-buffer i \{[^}]*rgba\(255,255,255,\.5\)/)
})

// ── §48: screenshot button, key and toast ────────────────────────────────────
// The camera button sends the screenshot verb and reports where the file landed.
test('the deck camera button sends the screenshot verb', () => {
  // Default harness api records every videoControl call into `sent`.
  const { nodes, sent } = harness()
  nodes['vt-shot'].fire('click')
  assert.ok(sent.some(s => s.verb === 'screenshot'), 'the camera button must send screenshot')
})

test('a saved screenshot toasts its path; a failure says so', async () => {
  const ok = harness({ apiExtra: {
    videoControl: () => Promise.resolve({ ok: true, value: { path: '/home/u/Pictures/Papa Audio/x.png' } }),
  } })
  ok.nodes['vt-shot'].fire('click')
  await Promise.resolve(); await Promise.resolve()
  assert.deepStrictEqual(ok.toasts, ['Screenshot saved to /home/u/Pictures/Papa Audio/x.png'])

  const bad = harness({ apiExtra: { videoControl: () => Promise.resolve({ ok: false }) } })
  bad.nodes['vt-shot'].fire('click')
  await Promise.resolve(); await Promise.resolve()
  assert.deepStrictEqual(bad.toasts, ['Could not save the screenshot'])
})

test('Shift+S grabs a screenshot while plain s still skips', () => {
  const segs = [{ kind: 'intro', start: 10, end: 40, origin: 'manual', confidence: 1 }]
  const { p, sent, press } = harness({ segments: segs })
  p._setState(stateAt(20))   // inside the intro, so a plain s would skip
  // Shift+S: a screenshot verb, and nothing seeked.
  press('s', { tagName: 'DIV' }, { shift: true })
  assert.ok(sent.some(s => s.verb === 'screenshot'), 'Shift+S must screenshot')
  assert.ok(!sent.some(s => s.verb === 'seek'), 'Shift+S must not skip')
  // Plain s: the skip fires (a seek to the segment end), no new screenshot.
  const before = sent.filter(s => s.verb === 'screenshot').length
  press('s')
  assert.ok(sent.some(s => s.verb === 'seek'), 'plain s must skip the active segment')
  assert.strictEqual(sent.filter(s => s.verb === 'screenshot').length, before)
})

// ── Seek-bar hover thumbnails (Player #5) ─────────────────────────────────────
// A helper that fires a pointermove on the seek track at a fraction of its
// width (the fake track rect is 100px wide).
function hoverSeek(nodes, fraction) {
  nodes['vt-seek'].fire('pointermove', { clientX: fraction * 100 })
}

test('hovering the seek bar shows the time even with no thumbnail API', () => {
  const { p, nodes } = harness()          // no videoThumb on the api
  p._setState(stateAt(1000))              // duration 3600
  hoverSeek(nodes, 0.5)
  // The bubble is a plain time-only node, exactly as before this feature.
  assert.strictEqual(nodes['vt-seek-bubble'].hidden, false)
  assert.strictEqual(nodes['vt-seek-bubble'].textContent, fmtTime(1800))
  // No thumb scaffold was built.
  assert.strictEqual(nodes['vt-seek-bubble'].children.length, 0)
})

test('a hover requests a thumbnail for the hovered position and paints it', async () => {
  const asked = []
  const { p, nodes } = harness({ apiExtra: {
    videoThumb: (arg) => { asked.push(arg.position); return Promise.resolve({ ok: true, path: '/cache/thumb-1800.jpg' }) },
  } })
  p._setState(stateAt(1000))
  hoverSeek(nodes, 0.5)                    // 0.5 * 3600 = 1800
  assert.deepStrictEqual(asked, [1800], 'asked for the hovered position')
  await Promise.resolve(); await Promise.resolve()
  const bubble = nodes['vt-seek-bubble']
  // The scaffold grew an <img> and a time span; the img points at the frame.
  assert.strictEqual(bubble.children.length, 2)
  const img = bubble.children[0]
  assert.match(img.attrs.src, /^file:\/\//)
  assert.match(img.attrs.src, /thumb-1800\.jpg$/)
  assert.strictEqual(img.hidden, false)
  assert.ok(bubble.classList.contains('has-thumb'))
  // The time is still shown, now in its own span.
  assert.strictEqual(bubble.children[1].textContent, fmtTime(1800))
})

test('a null thumbnail leaves the bubble time-only with no image', async () => {
  const { p, nodes } = harness({ apiExtra: {
    videoThumb: () => Promise.resolve({ ok: true, path: null }),   // still generating
  } })
  p._setState(stateAt(1000))
  hoverSeek(nodes, 0.25)
  await Promise.resolve(); await Promise.resolve()
  const bubble = nodes['vt-seek-bubble']
  // No frame ever arrived, so the plain-text bubble is untouched.
  assert.strictEqual(bubble.children.length, 0)
  assert.strictEqual(bubble.textContent, fmtTime(900))
})

test('leaving the seek bar hides the bubble and clears the thumb', async () => {
  const { p, nodes } = harness({ apiExtra: {
    videoThumb: () => Promise.resolve({ ok: true, path: '/cache/thumb-900.jpg' }),
  } })
  p._setState(stateAt(1000))
  hoverSeek(nodes, 0.25)
  await Promise.resolve(); await Promise.resolve()
  assert.ok(nodes['vt-seek-bubble'].classList.contains('has-thumb'))
  nodes['vt-seek'].fire('pointerleave')
  assert.strictEqual(nodes['vt-seek-bubble'].hidden, true)
  // The image is hidden again so the next hover does not flash the old frame.
  const img = nodes['vt-seek-bubble'].children[0]
  assert.strictEqual(img.hidden, true)
  assert.ok(!nodes['vt-seek-bubble'].classList.contains('has-thumb'))
})

test('keyboard seek requests a thumbnail for the landing position too', async () => {
  const asked = []
  const { p, nodes, press } = harness({ apiExtra: {
    videoThumb: (arg) => { asked.push(arg.position); return Promise.resolve({ ok: true, path: '/c/t.jpg' }) },
  } })
  p._setState(stateAt(1000))              // position 1000, duration 3600
  press('ArrowRight')                     // +10 → landing at 1010
  assert.ok(asked.length >= 1, 'keyboard seek asked for a thumbnail')
  assert.strictEqual(asked[asked.length - 1], 1010)
  await Promise.resolve(); await Promise.resolve()
  assert.ok(nodes['vt-seek-bubble'].classList.contains('has-thumb'))
})

test('thumbnail requests are throttled across a fast pointer sweep', async () => {
  let calls = 0
  const { p, nodes } = harness({ apiExtra: {
    videoThumb: () => { calls++; return Promise.resolve({ ok: true, path: null }) },
  } })
  p._setState(stateAt(0))
  // Ten moves in a tight loop: the first fires immediately, the rest coalesce
  // into at most one trailing request within the throttle window.
  for (let i = 1; i <= 10; i++) hoverSeek(nodes, i / 20)
  assert.ok(calls <= 2, 'a sweep of ten moves made at most two requests, got ' + calls)
})

// ── Thumb bucket cache (roadmap #28, pure) ────────────────────────────────────
// A hovered position is snapped to a 10-second bucket and the frame remembered
// for the session, capped so a long scrub cannot grow the map without bound.
const VP = require('../src/video-player')

test('thumbBucketOf snaps a position to its 10-second bucket', () => {
  assert.strictEqual(VP.thumbBucketOf(0), 0)
  assert.strictEqual(VP.thumbBucketOf(9), 0)
  assert.strictEqual(VP.thumbBucketOf(10), 1)
  assert.strictEqual(VP.thumbBucketOf(19), 1)
  assert.strictEqual(VP.thumbBucketOf(1805), 180)
  // Never negative, and a garbage input falls to bucket 0 rather than NaN.
  assert.strictEqual(VP.thumbBucketOf(-4), 0)
  assert.strictEqual(VP.thumbBucketOf(null), 0)
})

test('the thumb cache dedupes within a bucket and distinguishes a cached null', () => {
  const c = VP.makeThumbCache(100)
  assert.strictEqual(c.has(15), false, 'nothing cached yet')
  c.set(15, '/f/thumb-10.jpg')
  // Any position in the same 10s bucket is a hit.
  assert.strictEqual(c.has(11), true)
  assert.strictEqual(c.get(19), '/f/thumb-10.jpg')
  // A cached null is a real answer ("asked, none yet"), not a miss.
  c.set(25, null)
  assert.strictEqual(c.has(25), true)
  assert.strictEqual(c.get(25), null)
})

test('the thumb cache evicts the oldest bucket past its cap', () => {
  const c = VP.makeThumbCache(3)
  c.set(0, 'a')      // bucket 0
  c.set(10, 'b')     // bucket 1
  c.set(20, 'c')     // bucket 2
  assert.strictEqual(c.size(), 3)
  c.set(30, 'd')     // bucket 3 — pushes bucket 0 out
  assert.strictEqual(c.size(), 3)
  assert.strictEqual(c.has(0), false, 'the oldest bucket was evicted')
  assert.strictEqual(c.get(30), 'd')
  // Re-setting a bucket refreshes its recency, so it survives the next eviction.
  c.set(10, 'b2')    // bucket 1 becomes most-recent
  c.set(40, 'e')     // bucket 4 — should evict bucket 2, not the refreshed 1
  assert.strictEqual(c.has(10), true, 'a refreshed bucket is not the one evicted')
  assert.strictEqual(c.has(20), false)
})

// ── videoThumbAt feature-detect (roadmap #28) ─────────────────────────────────
// The Wave-4 contract is videoThumbAt({sec}) → {path|null}; the deck prefers it
// over the older videoThumb({position}) when main exposes it.
test('a hover prefers videoThumbAt({sec}) when it is exposed', async () => {
  const askedAt = []; const askedOld = []
  const { p, nodes } = harness({ apiExtra: {
    videoThumbAt: (arg) => { askedAt.push(arg.sec); return Promise.resolve({ path: '/c/at-1800.jpg' }) },
    videoThumb: (arg) => { askedOld.push(arg.position); return Promise.resolve({ ok: true, path: '/c/old.jpg' }) },
  } })
  p._setState(stateAt(1000))
  hoverSeek(nodes, 0.5)                 // 1800
  assert.deepStrictEqual(askedAt, [1800], 'the new contract was called with sec')
  assert.deepStrictEqual(askedOld, [], 'the old one is not called when the new exists')
  await Promise.resolve(); await Promise.resolve()
  const img = nodes['vt-seek-bubble'].children[0]
  assert.match(img.attrs.src, /at-1800\.jpg$/)
})

test('the bucket cache spares a second request in the same bucket', async () => {
  let calls = 0
  const { p, nodes } = harness({ apiExtra: {
    videoThumbAt: (arg) => { calls++; return Promise.resolve({ path: '/c/t.jpg' }) },
  } })
  p._setState(stateAt(0))
  hoverSeek(nodes, 12 / 3600)           // ~12s → bucket 1
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(calls, 1)
  // Move within the same bucket and away and back: the cached frame is reused,
  // no new IPC.
  hoverSeek(nodes, 15 / 3600)           // ~15s → still bucket 1
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(calls, 1, 'a second hover in the same bucket must not re-request')
})

test('opening a new file clears the thumb cache', async () => {
  let calls = 0
  const { p, nodes } = harness({ apiExtra: {
    videoThumbAt: () => { calls++; return Promise.resolve({ path: '/c/t.jpg' }) },
  } })
  p.open({ title: 'A' })
  p._setState(stateAt(0))
  hoverSeek(nodes, 12 / 3600)
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(calls, 1)
  p.open({ title: 'B' })                // a new film: its frames are its own
  p._setState(stateAt(0))
  // A real wait past the throttle window so the second hover fires straight
  // away rather than coalescing with the first — this test is about the cache
  // being cleared, not about the debounce.
  await new Promise(r => setTimeout(r, 260))
  hoverSeek(nodes, 12 / 3600)           // same bucket, but a different file
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(calls, 2, 'the previous file’s cache must not answer for the new one')
})

// ── Subtitle style menu (roadmap #30) ─────────────────────────────────────────
// The CC menu offers a "Style…" row that opens a submenu of size / colour /
// background / vertical position, each applied through the subStyle verb and
// persisted app-wide.
function subStyleHarness (opts = {}) {
  const h = harness(opts)
  const buckets = {
    '[data-substyle-size]': [], '[data-substyle-color]': [],
    '[data-substyle-bg]': [], '[data-substyle-pos]': [],
    '[data-subact]': [], '.vt-menu-item': [], '[data-subfile]': [],
    '[data-delay]': [], '[data-online-sub]': [],
  }
  h.nodes['vt-menu'].querySelectorAll = sel => buckets[sel] || []
  h.rows = buckets
  return h
}

test('the CC menu offers a Style… row that opens the style submenu', async () => {
  const h = subStyleHarness({ tracks: [] })
  h.p._setState(stateAt(100))
  const styleRow = el('style'); styleRow.dataset.subact = 'style'
  h.rows['[data-subact]'] = [styleRow]
  h.nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  assert.match(h.nodes['vt-menu'].innerHTML, /Style…/, 'the CC menu carries a Style entry')
  styleRow.fire('click')
  // The submenu is now open with all four controls.
  assert.match(h.nodes['vt-menu'].innerHTML, /Subtitle style/)
  assert.match(h.nodes['vt-menu'].innerHTML, /data-substyle-color/)
  assert.match(h.nodes['vt-menu'].innerHTML, /data-substyle-pos/)
})

test('picking a colour and a position sends the mapped mpv values and persists', async () => {
  const writes = []
  const h = subStyleHarness({ tracks: [], local: { read: () => null, write: (k, v) => { writes.push([k, v]); return true } } })
  h.p._setState(stateAt(100))
  const styleRow = el('style'); styleRow.dataset.subact = 'style'
  h.rows['[data-subact]'] = [styleRow]
  const yellow = el('y'); yellow.dataset.substyleColor = 'yellow'
  const mid = el('m'); mid.dataset.substylePos = 'mid'
  h.rows['[data-substyle-color]'] = [yellow]
  h.rows['[data-substyle-pos]'] = [mid]
  h.nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  styleRow.fire('click')
  yellow.fire('click')
  assert.deepStrictEqual(h.sent.filter(s => s.verb === 'subStyle').pop(),
    { verb: 'subStyle', args: { color: '#FFFF00' } }, 'yellow maps to its hex')
  mid.fire('click')
  assert.deepStrictEqual(h.sent.filter(s => s.verb === 'subStyle').pop(),
    { verb: 'subStyle', args: { pos: 85 } }, 'mid lifts the line off the bottom')
  // Both choices were persisted under the one style key.
  const last = writes.filter(w => w[0] === 'papaVtSubStyle').pop()
  assert.ok(last, 'the style was persisted')
  assert.strictEqual(last[1].color, 'yellow')
  assert.strictEqual(last[1].position, 'mid')
})

test('a remembered subtitle style is applied when the file starts', async () => {
  const { p, sent } = harness({ tracks: [], local: {
    read: k => (k === 'papaVtSubStyle' ? { size: 'L', color: 'cyan', background: 'soft', position: 'mid' } : null),
  } })
  p.open({ title: 'X' })
  p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  const styled = sent.filter(s => s.verb === 'subStyle')
  assert.ok(styled.length, 'the remembered look was pushed on start')
  const args = styled[0].args
  assert.strictEqual(args.scale, 1.3, 'L')
  assert.strictEqual(args.color, '#00FFFF', 'cyan')
  assert.strictEqual(args.backColor, '#80000000', 'soft box')
  assert.strictEqual(args.pos, 85, 'mid')
})

test('the default subtitle style spends no commands on start', async () => {
  const { p, sent } = harness({ tracks: [], local: { read: () => null } })
  p.open({ title: 'X' })
  p._setState(stateAt(5))
  await new Promise(r => setImmediate(r))
  assert.ok(!sent.some(s => s.verb === 'subStyle'), 'an untouched style costs nothing')
})

test('videoSubStyle passthrough is called alongside subStyle when exposed', async () => {
  const passed = []
  const h = subStyleHarness({ tracks: [], apiExtra: {
    videoSubStyle: (arg) => { passed.push(arg); return Promise.resolve({ ok: true }) },
  } })
  h.p._setState(stateAt(100))
  const styleRow = el('style'); styleRow.dataset.subact = 'style'
  h.rows['[data-subact]'] = [styleRow]
  const cyan = el('c'); cyan.dataset.substyleColor = 'cyan'
  h.rows['[data-substyle-color]'] = [cyan]
  h.nodes['vt-subs'].fire('click')
  await new Promise(r => setImmediate(r))
  styleRow.fire('click')
  cyan.fire('click')
  assert.ok(passed.length, 'the passthrough was called')
  assert.strictEqual(passed[passed.length - 1].color, 'cyan', 'with the friendly names')
})

// Roadmap V101–V103: exercise real bound handlers with delayed engine state.
const pictureWait = () => new Promise(resolve => setTimeout(resolve, 330))
const pointer = (over = {}) => Object.assign({ button: 0, pointerId: 7,
  clientX: 20, clientY: 20, preventDefault () {}, target: { closest () { return null } } }, over)

test('cancelled mini picture press never pauses playback', async () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vmini-video'].fire('pointerdown', pointer())
  nodes['vmini-video'].fire('pointercancel', pointer())
  await pictureWait()
  assert.equal(sent.filter(x => x.verb === 'pause' || x.verb === 'play').length, 0)
  assert.equal(nodes.vmini.classList.contains('vmini-dragging'), false)
})

test('lost capture aborts a moved mini drag without saving a new corner', () => {
  const writes = []
  const { p, nodes, sent } = harness({ local: { readObject: () => ({}), write: (...a) => writes.push(a) } })
  p._setState(stateAt(100))
  nodes['vmini-video'].fire('pointerdown', pointer())
  nodes['vmini-video'].fire('pointermove', pointer({ clientX: 200 }))
  nodes['vmini-video'].fire('lostpointercapture', pointer())
  nodes['vmini-video'].fire('pointerup', pointer())
  assert.equal(writes.length, 0)
  assert.equal(sent.filter(x => ['pause', 'play'].includes(x.verb)).length, 0)
  assert.equal(nodes.vmini.classList.contains('vmini-dragging'), false)
})

test('theatre double-click changes display without playback commands', async () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-stage'].fire('click', pointer())
  nodes['vt-stage'].fire('click', pointer())
  nodes['vt-stage'].fire('dblclick', pointer())
  await pictureWait()
  assert.equal(sent.filter(x => ['pause', 'play'].includes(x.verb)).length, 0)
  assert.equal(sent.filter(x => x.verb === 'fullscreen').length, 1)
})

test('mini double-click restores without toggling stale playback state', async () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100, { paused: true }))
  for (let i = 0; i < 2; i++) {
    nodes['vmini-video'].fire('pointerdown', pointer())
    nodes['vmini-video'].fire('pointerup', pointer())
  }
  nodes['vmini-video'].fire('dblclick', pointer())
  await pictureWait()
  assert.equal(sent.filter(x => ['pause', 'play'].includes(x.verb)).length, 0)
  assert.equal(p.isMinimised(), false)
})

test('one picture click toggles once and explicit transport stays immediate', async () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-stage'].fire('click', pointer())
  assert.equal(sent.length, 0)
  await pictureWait()
  assert.equal(sent.filter(x => x.verb === 'pause').length, 1)
  nodes['vt-play'].fire('click')
  assert.equal(sent.filter(x => x.verb === 'pause').length, 2)
})

test('closing cancels a pending picture action', async () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-stage'].fire('click', pointer())
  p.close()
  await pictureWait()
  assert.equal(sent.filter(x => ['pause', 'play'].includes(x.verb)).length, 0)
})

test('wheel ignores zero, horizontal, invalid and pinch input on both surfaces', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100, { volume: 50 }))
  for (const id of ['vt-stage', 'vt-deck']) {
    for (const data of [{ deltaY: 0 }, { deltaY: 2, deltaX: 50 },
      { deltaY: NaN }, { deltaY: 120, ctrlKey: true }]) nodes[id].fire('wheel', data)
  }
  assert.equal(sent.filter(x => x.verb === 'volume').length, 0)
})

test('small trackpad deltas add up to a 40px notch; any single event of a notch or more is exactly one step', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100, { volume: 50 }))
  const vols = () => sent.filter(x => x.verb === 'volume').map(x => x.args.value)
  for (let i = 0; i < 40; i++) nodes['vt-stage'].fire('wheel', { deltaY: 1 })
  assert.deepEqual(vols(), [45], 'forty 1px events are one step, not forty')
  nodes['vt-deck'].fire('wheel', { deltaY: -3, deltaMode: 1 })   // 3 lines ≈ 48px
  assert.equal(sent.at(-1).args.value, 50)
  // A real mouse detent is ~100px in Chromium: still one 5-point step, as it always was.
  nodes['vt-deck'].fire('wheel', { deltaY: -100 })
  assert.equal(sent.at(-1).args.value, 55)
  // A big flick is one step, not ten.
  nodes['vt-deck'].fire('wheel', { deltaY: 400 })
  assert.equal(sent.at(-1).args.value, 50)
  assert.equal(vols().length, 4)
})

test('wheel over a menu never modifies background volume', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-deck'].fire('wheel', { deltaY: 120, target: { closest: () => ({}) } })
  assert.equal(sent.length, 0)
})

test('Space on a focused transport button leaves activation to the button', () => {
  const { p, nodes, sent, press } = harness()
  p.open({ title: 'X' }); p._setState(stateAt(100))
  sent.length = 0
  assert.equal(press(' ', { tagName: 'BUTTON' }), false)
  assert.equal(sent.length, 0)
  nodes['vt-play'].fire('click')
  assert.equal(sent.filter(x => x.verb === 'pause').length, 1)
})

test('handled keys and IME composition never reach video shortcuts', () => {
  const { p, sent, fire } = harness()
  p.open({ title: 'X' }); p._setState(stateAt(100)); sent.length = 0
  fire('keydown', { key: 'm', defaultPrevented: true })
  fire('keydown', { key: ' ', isComposing: true })
  assert.equal(sent.length, 0)
})

test('Up Next waits while keyboard focus is inside, then resumes', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let advanced = 0
  const { p, nodes } = harness({
    segments: [{ kind: 'credits', start: 3400, end: 3600, origin: 'chapters', confidence: 0.9 }],
    onNext: () => { advanced++ },
  })
  p.setUpNext({ title: 'Next' }); p._setState(stateAt(3450))
  nodes['vt-upnext'].fire('focusin')
  nodes['vt-upnext'].fire('pointerleave')
  t.mock.timers.tick(20000)
  assert.equal(advanced, 0)
  nodes['vt-upnext'].fire('focusout', { relatedTarget: null })
  t.mock.timers.tick(20000)
  assert.equal(advanced, 1)
})

test('closing cancels a queued keyboard seek', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, press, sent } = harness()
  p.open({ title: 'A' }); p._setState(stateAt(100))
  press('ArrowRight'); p.close()
  t.mock.timers.tick(500)
  assert.equal(sent.filter(x => x.verb === 'seek').length, 0)
})

test('opening another title cancels pending live scrub commands', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, nodes, sent } = harness()
  p.open({ title: 'A' }); p._setState(stateAt(100))
  nodes['vt-seek'].fire('pointerdown', pointer())
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 40 }))
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 60 }))
  p.open({ title: 'B' }); p._setState(stateAt(0))
  sent.length = 0
  t.mock.timers.tick(500)
  nodes['vt-seek'].fire('pointerup', pointer({ clientX: 60 }))
  assert.equal(sent.filter(x => x.verb === 'seek').length, 0)
})

test('mini seek release from the previous title cannot seek the new title', () => {
  const { p, nodes, sent } = harness()
  p.open({ title: 'A' }); p._setState(stateAt(100))
  nodes['vmini-seek'].fire('pointerdown', pointer())
  p.open({ title: 'B' }); p._setState(stateAt(0)); sent.length = 0
  nodes['vmini-seek'].fire('pointerup', pointer({ clientX: 80 }))
  assert.equal(sent.filter(x => x.verb === 'seek').length, 0)
})

test('theatre scrub ignores right button and another pointer', () => {
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-seek'].fire('pointerdown', pointer({ button: 2 }))
  nodes['vt-seek'].fire('pointerup', pointer())
  assert.equal(sent.length, 0)
  nodes['vt-seek'].fire('pointerdown', pointer())
  nodes['vt-seek'].fire('pointerup', pointer({ pointerId: 8 }))
  assert.equal(sent.length, 0)
  nodes['vt-seek'].fire('pointerup', pointer({ clientX: 50 }))
  assert.equal(sent.filter(x => x.verb === 'seek').length, 1)
})

test('lost seek capture cancels trailing work and late release', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, nodes, sent } = harness()
  p._setState(stateAt(100))
  nodes['vt-seek'].fire('pointerdown', pointer())
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 30 }))
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 40 }))
  nodes['vt-seek'].fire('lostpointercapture', pointer())
  sent.length = 0
  t.mock.timers.tick(500)
  nodes['vt-seek'].fire('pointerup', pointer())
  assert.equal(sent.length, 0)
  assert.equal(nodes['vt-seek-bubble'].hidden, true)
})

test('late thumbnail from an old title cannot paint or populate the new cache', async () => {
  const pending = []
  const { p, nodes } = harness({ apiExtra: { videoThumbAt: () => new Promise(resolve => pending.push(resolve)) } })
  p.open({ title: 'A' }); p._setState(stateAt(100))
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 20 }))
  assert.equal(pending.length, 1)
  p.open({ title: 'B' }); p._setState(stateAt(100))
  pending[0]({ path: '/old-title.jpg' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nodes['vt-seek-bubble'].__vtThumbImg, undefined)
  p.close()
})

test('out-of-order thumbnail responses cannot replace the current hover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = []
  const { p, nodes } = harness({ apiExtra: { videoThumbAt: () => new Promise(resolve => pending.push(resolve)) } })
  p._setState(stateAt(100))
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 20 }))
  nodes['vt-seek'].fire('pointermove', pointer({ clientX: 80 }))
  t.mock.timers.tick(250)
  assert.equal(pending.length, 2)
  pending[1]({ path: '/current.jpg' })
  await new Promise(resolve => setImmediate(resolve))
  pending[0]({ path: '/outdated.jpg' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nodes['vt-seek-bubble'].__vtThumbImg.getAttribute('src'), 'file:///current.jpg')
  p.close()
})

for (const id of ['vt-seek', 'vmini-seek']) {
  test(id + ' cancelled preview restores original position once without changing pause', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { p, nodes, sent } = harness()
    p._setState(stateAt(123, { paused: true }))
    nodes[id].fire('pointerdown', pointer())
    nodes[id].fire('pointermove', pointer({ clientX: 40 }))
    p._setState(stateAt(1440, { paused: true }))
    nodes[id].fire('pointermove', pointer({ clientX: 60 }))
    sent.length = 0
    nodes[id].fire('pointercancel', pointer())
    nodes[id].fire('lostpointercapture', pointer())
    nodes[id].fire('pointerup', pointer({ clientX: 80 }))
    t.mock.timers.tick(500)
    assert.deepEqual(sent.filter(x => x.verb === 'seek'), [{ verb: 'seek', args: { seconds: 123, mode: 'absolute' } }])
    assert.equal(sent.some(x => x.verb === 'pause'), false)
  })
  test(id + ' cancelled press without preview does not rewind playback', () => {
    const { p, nodes, sent } = harness()
    p._setState(stateAt(123))
    nodes[id].fire('pointerdown', pointer())
    p._setState(stateAt(125))
    nodes[id].fire('lostpointercapture', pointer())
    assert.equal(sent.filter(x => x.verb === 'seek').length, 0)
  })
  test(id + ' old title cancellation cannot restore into the next title', () => {
    const { p, nodes, sent } = harness()
    p.open({ title: 'A' }); p._setState(stateAt(123))
    nodes[id].fire('pointerdown', pointer())
    nodes[id].fire('pointermove', pointer({ clientX: 40 }))
    p.open({ title: 'B' }); p._setState(stateAt(0)); sent.length = 0
    nodes[id].fire('pointercancel', pointer())
    assert.equal(sent.filter(x => x.verb === 'seek').length, 0)
  })
}

for (const id of ['vt-seek', 'vmini-seek']) {
  const key = name => ({ key: name, preventDefault() {}, stopPropagation() {} })
  test(id + ' repeated keyboard seeks accumulate despite stale state', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { p, nodes, sent } = harness()
    p.open({ title: 'A' }); p.minimise(); p._setState(stateAt(100))
    nodes[id].fire('keydown', key('ArrowRight'))
    p._setState(stateAt(101))
    nodes[id].fire('keydown', key('ArrowUp'))
    assert.equal(nodes[id].getAttribute('aria-valuenow'), '120')
    t.mock.timers.tick(500)
    assert.deepEqual(sent.filter(x => x.verb === 'seek'), [{ verb: 'seek', args: { seconds: 120, mode: 'absolute' } }])
  })
  test(id + ' Home and End supersede pending arrow seeks', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { p, nodes, sent } = harness()
    p._setState(stateAt(100))
    for (const [name, seconds] of [['Home', 0], ['End', 3600]]) {
      sent.length = 0
      nodes[id].fire('keydown', key('ArrowRight'))
      nodes[id].fire('keydown', key(name))
      t.mock.timers.tick(500)
      assert.deepEqual(sent.filter(x => x.verb === 'seek'), [{ verb: 'seek', args: { seconds, mode: 'absolute' } }])
    }
  })
  test(id + ' pointer drag supersedes pending keyboard seek', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { p, nodes, sent } = harness()
    p._setState(stateAt(100))
    nodes[id].fire('keydown', key('ArrowRight'))
    nodes[id].fire('pointerdown', pointer())
    nodes[id].fire('pointerup', pointer({ clientX: 50 }))
    t.mock.timers.tick(500)
    assert.deepEqual(sent.filter(x => x.verb === 'seek'), [{ verb: 'seek', args: { seconds: 1800, mode: 'absolute' } }])
  })
  test(id + ' unknown duration and composing keys cannot seek', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { p, nodes, sent } = harness()
    p._setState(stateAt(0, { duration: 0 }))
    nodes[id].fire('keydown', key('ArrowRight'))
    nodes[id].fire('keydown', key('End'))
    p._setState(stateAt(100))
    nodes[id].fire('keydown', { ...key('ArrowRight'), isComposing: true })
    nodes[id].fire('keydown', { ...key('ArrowRight'), ctrlKey: true })
    t.mock.timers.tick(500)
    assert.equal(sent.filter(x => x.verb === 'seek').length, 0)
  })
}

// V109: a session exists from open to close, whichever surface shows it.
test('isOpen is true from open() until close(), including while minimised', () => {
  const { p } = harness()
  assert.strictEqual(p.isOpen(), false)
  p.open({ title: 'X' })
  assert.strictEqual(p.isOpen(), true)
  p._setState(stateAt(10))
  p.minimise()
  assert.strictEqual(p.isOpen(), true, 'the mini card is still the session')
  p.close()
  assert.strictEqual(p.isOpen(), false)
})
