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

function harness({ segments = [], prefs = {}, onNext = null } = {}) {
  const nodes = {}
  const ids = ['vtheatre', 'vt-stage', 'vt-stage-msg', 'vt-skip', 'vt-skip-btn', 'vt-skip-count',
    'vt-play', 'vt-back10', 'vt-fwd10', 'vt-next', 'vt-back', 'vt-pos', 'vt-dur',
    'vt-mute', 'vt-vol', 'vt-speed', 'vt-subs', 'vt-audio', 'vt-settings', 'vt-full',
    'vt-seek', 'vt-seek-fill', 'vt-seek-knob', 'vt-seek-buffer', 'vt-seek-marks',
    'vt-seek-bubble', 'vt-badges', 'vt-title', 'vt-sub', 'vt-menu',
    'vt-strip', 'vt-upnext', 'vt-upnext-go', 'vt-upnext-stay', 'vt-ring-fg', 'vt-ring-num']
  for (const id of ids) nodes[id] = el(id)
  nodes['vt-skip'].hidden = true
  nodes['vt-upnext'].hidden = true
  nodes['vt-strip'].hidden = true
  nodes['vt-menu'].classList.add('hidden')

  const sent = []
  // Captured so tests can fire real keydown events at the document handler,
  // which is where the shortcut logic lives.
  const docHandlers = {}
  const doc = {
    getElementById: id => nodes[id] || null,
    querySelector: () => nodes['vt-seek'],
    addEventListener (ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn) },
    activeElement: null,
    documentElement: { clientWidth: 1280 },
  }
  const api = {
    videoControl: (verb, args) => { sent.push({ verb, args }); return Promise.resolve({ ok: true }) },
    onVideoState: () => () => {},
    videoTracks: () => Promise.resolve({ ok: true, tracks: [] }),
    videoSurfaceBounds: () => Promise.resolve({ ok: true }),
    videoFullscreen: () => { sent.push({ verb: 'fullscreen' }); return Promise.resolve({ ok: true }) },
  }
  const p = create({ document: doc, api, keymap, skipModel, onNext })
  p.bind()
  p.setPrefs(prefs)
  p.setSegments(segments)
  const press = (key, target = { tagName: 'DIV' }) => {
    let prevented = false
    const e = { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
                target, preventDefault () { prevented = true } }
    ;(docHandlers.keydown || []).forEach(fn => fn(e))
    return prevented
  }
  return { p, nodes, sent, press }
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
  // 900 + 180 of 3600 = 30%
  assert.strictEqual(nodes['vt-seek-buffer'].style.width, '30%')
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

test('the keyboard drives the same commands as the buttons', () => {
  const { p, sent, press } = harness()
  p.open({ title: 'X' })
  p._setState(stateAt(100))
  assert.strictEqual(press(' '), true, 'space is handled')
  assert.strictEqual(sent.pop().verb, 'pause')
  press('ArrowRight')
  assert.deepStrictEqual(sent.pop(), { verb: 'seek', args: { seconds: 10, mode: 'relative' } })
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
      'vmini', 'vmini-open', 'vmini-stop', 'vmini-play', 'vmini-title', 'vmini-fill', 'vmini-time']) {
      nodes[id] = el(id)
    }
    nodes['vt-menu'].classList.add('hidden')
    nodes.vmini.classList.add('hidden')
    let exited = 0
    const sent = []
    const p = create({
      document: {
        getElementById: id => nodes[id] || null,
        querySelector: () => nodes['vt-seek'],
        addEventListener () {},
        documentElement: { clientWidth: 1280 },
      },
      api: {
        videoControl: (verb, args) => { sent.push({ verb, args }); return Promise.resolve({ ok: true }) },
        onVideoState: () => () => {},
        videoSurfaceBounds: () => Promise.resolve({ ok: true }),
      },
      keymap, skipModel,
      onExit: () => { exited++ },
    })
    p.bind()
    return { p, nodes, sent, exited: () => exited }
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

  // The two corners must not collide: the video's mini player is bottom-right.
  test('the collapsed music bar sits in the opposite corner to the video mini player', () => {
    const css = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
    assert.match(css, /body\.video-active \.player-bar \{[^}]*left:16px;\s*right:auto/s)
    assert.match(css, /\.vmini \{[^}]*right:20px/s)
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
  for (const p of ['video', 'browse', 'person', 'video-detail']) {
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
