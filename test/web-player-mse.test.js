'use strict'
// The engine through Media Source Extensions: one SourceBuffer per session
// that keeps what it is given, so a seek into anything already appended is a
// currentTime change and a seek elsewhere fetches `?t=` with the server's
// start second as the timestamp offset.
const test = require('node:test')
const assert = require('node:assert')
const W = require('../src/web-player')

function fakeDoc() {
  const nodes = {}
  const mk = (id) => ({ id, children: [], appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this }, removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null }, querySelectorAll() { return [] } })
  nodes['vt-stage'] = mk('vt-stage'); nodes['vmini-video'] = mk('vmini-video')
  return {
    getElementById: id => nodes[id] || null,
    createElement(tag) {
      const el = { tag, listeners: {}, attrs: {}, dataset: {}, children: [], classes: new Set(), parentNode: null, ranges: [],
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) },
        setAttribute(k, v) { this.attrs[k] = v }, removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = '' },
        appendChild(c) { this.children.push(c); c.parentNode = this }, querySelectorAll(sel) { return sel === 'track' ? this.children.filter(c => c.tag === 'track') : [] },
        classList: { toggle(c, on) { on ? el.classes.add(c) : el.classes.delete(c) } },
        paused: true, currentTime: 0, duration: 0, volume: 1, muted: false, playbackRate: 1, ended: false, videoWidth: 0, videoHeight: 0, textTracks: [],
        get buffered() { const r = el.ranges; return { length: r.length, start: i => r[i][0], end: i => r[i][1] } },
        play() { this.paused = false; return Promise.resolve() }, pause() { this.paused = true }, load() { this.loaded = (this.loaded || 0) + 1 },
      }
      return el
    },
  }
}

// A MediaSource whose SourceBuffer turns each appended chunk ({t0,t1}) into a
// buffered range shifted by timestampOffset, like the real thing would.
function fakeMSE(video) {
  const sources = []
  class SB {
    constructor() { this.updating = false; this.timestampOffset = 0; this.mode = 'segments'; this.appends = []; this.removed = []; this.l = {} }
    addEventListener(e, fn) { (this.l[e] = this.l[e] || []).push(fn) }
    appendBuffer(chunk) { this.appends.push(chunk); video.ranges.push([this.timestampOffset + chunk.t0, this.timestampOffset + chunk.t1]) }
    abort() { this.aborted = (this.aborted || 0) + 1 }
    remove(a, b) { this.removed.push([a, b]) }
  }
  class MS {
    constructor() { this.readyState = 'closed'; this.l = {}; this.sb = null; sources.push(this) }
    static isTypeSupported(m) { return /avc1|av01/.test(m) }
    addEventListener(e, fn) { (this.l[e] = this.l[e] || []).push(fn) }
    addSourceBuffer(mime) { this.mime = mime; this.sb = new SB(); return this.sb }
    endOfStream() { this.readyState = 'ended' }
    open() { this.readyState = 'open'; (this.l.sourceopen || []).forEach(fn => fn()) }
  }
  return { MS, sources }
}

// fetch that answers `?t=` with two chunks covering [start, start+10) and a
// start header the server chooses (a cache hit may begin earlier).
function fakeFetch(log, startFor) {
  return function (url, init) {
    const t = Number(/t=(\d+)/.exec(url)[1])
    const start = startFor ? startFor(t) : t
    log.push({ url, t, aborted: false, signal: init && init.signal })
    if (init && init.signal) init.signal.addEventListener('abort', () => { log[log.length - 1].aborted = true })
    const chunks = [{ t0: 0, t1: 5 }, { t0: 5, t1: 10 }]
    let i = 0
    return Promise.resolve({
      headers: { get: k => (k === 'X-Papa-Start' ? String(start) : null) },
      body: { getReader() { return { read() { return Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }, cancel() {} } } },
    })
  }
}
class FakeAbort { constructor() { this.signal = { aborted: false, l: [], addEventListener(e, fn) { this.l.push(fn) } } } abort() { this.signal.aborted = true; this.signal.l.forEach(fn => fn()) } }
const URLApi = { createObjectURL: () => 'blob:x', revokeObjectURL() {} }
const session = { id: 'ab', streamUrl: 'http://127.0.0.1:5/s/ab.mp4', duration: 6000, mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', plan: { mode: 'transcode', badges: [], video: { index: 0, codec: 'hevc', copy: false }, audio: { index: 1, codec: 'aac', copy: true, channels: 6 } }, audios: [], subtitles: [] }
const tick = () => new Promise(r => setImmediate(r))

test('open goes through MSE: one SourceBuffer, the stream from 0 appended at offset 0', async () => {
  const doc = fakeDoc(); const log = []
  const e = W.create({ document: doc, api: {}, onEvent() {} })
  const v0 = null
  const mse = fakeMSE({ ranges: [] })
  // The engine creates the video lazily; wire the fake MSE to it afterwards.
  const eng = W.create({ document: doc, api: {}, onEvent() {}, MediaSource: null })
  void e; void v0; void eng
  const holder = { video: null }
  const F = fakeMSE(holder)
  const doc2 = fakeDoc(); const origCreate = doc2.createElement
  doc2.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges } })
  const engine = W.create({ document: doc2, api: {}, onEvent() {}, MediaSource: F.MS, fetch: fakeFetch(log), URL: URLApi, AbortController: FakeAbort })
  engine.open(session, 0)
  assert.equal(F.sources.length, 1)
  assert.equal(holder.video.src, 'blob:x')
  F.sources[0].open()
  await tick(); await tick(); await tick()
  assert.equal(log.length, 1); assert.equal(log[0].t, 0)
  assert.equal(F.sources[0].sb.timestampOffset, 0)
  assert.equal(F.sources[0].sb.appends.length, 2)
  assert.deepEqual(holder.video.ranges, [[0, 5], [5, 10]])
  assert.equal(engine.state().position, 0)
  engine.close()
  assert.equal(engine._mse(), null)
})

test('a seek into appended data is a currentTime change; a seek elsewhere fetches and takes the server\'s start as the offset', async () => {
  const holder = { video: null }
  const F = fakeMSE(holder)
  const doc = fakeDoc(); const origCreate = doc.createElement
  doc.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges } })
  const log = []
  // The server answers a request for 300 from its cached run that began at 290.
  const engine = W.create({ document: doc, api: {}, onEvent() {}, MediaSource: F.MS, fetch: fakeFetch(log, t => (t === 300 ? 290 : t)), URL: URLApi, AbortController: FakeAbort })
  engine.open(session, 0)
  F.sources[0].open()
  await tick(); await tick(); await tick()
  const v = holder.video
  v.currentTime = 2
  engine.seekTo(3)
  assert.equal(log.length, 1, 'inside the buffer: no fetch'); assert.equal(v.currentTime, 3)
  // A scrub preview outside the buffer never fetches (a converter start per
  // pointer move was the lag); a real seek is coalesced for 180 ms so a run
  // of arrow presses is one fetch.
  engine.control('seek', { seconds: 250, mode: 'absolute+keyframes' })
  await new Promise(r => setTimeout(r, 250))
  assert.equal(log.length, 1, 'preview: no fetch')
  // (Paused: the fake response ends at once, which would let the starvation
  // check ask again; a real stream keeps the fetch open.)
  v.paused = true
  engine.seekTo(280)
  engine.seekTo(300)
  await new Promise(r => setTimeout(r, 250)); await tick(); await tick()
  assert.equal(log.length, 2, 'two quick seeks, one fetch'); assert.equal(log[1].t, 300)
  assert.equal(F.sources[0].sb.timestampOffset, 290, 'the response starts at 290: that is the offset')
  assert.deepEqual(v.ranges.slice(2), [[290, 295], [295, 300]])
  assert.equal(v.currentTime, 300)
  // Back into the first span: still no fetch, and the offset maths give the film's own seconds.
  engine.seekTo(4)
  assert.equal(log.length, 2); assert.equal(v.currentTime, 4)
  assert.equal(engine.state().position, 4)
  engine.control('seek', { seconds: 2, mode: 'relative' })
  assert.equal(v.currentTime, 6, 'relative seeks use the film timeline, not a stream offset')
  engine.close()
})

test('a MIME the browser refuses falls back to a plain src with the old restart behaviour', () => {
  const doc = fakeDoc(); const log = []
  const holder = { video: null }; const F = fakeMSE(holder)
  const origCreate = doc.createElement
  doc.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  const engine = W.create({ document: doc, api: {}, onEvent() {}, MediaSource: F.MS, fetch: fakeFetch(log), URL: URLApi, AbortController: FakeAbort })
  engine.open(Object.assign({}, session, { mime: 'video/mp4; codecs="hev1"' }), 30)
  assert.equal(F.sources.length, 0)
  assert.match(holder.video.src, /\?t=30(&|$)/)
  assert.equal(engine._mse(), null)
  engine.close()
})

test('the seek bar sees the browser buffer plus the server\'s converted spans; chapters, screenshots and burn-in subtitles work in the page', async () => {
  const holder = { video: null }
  const F = fakeMSE(holder)
  const doc = fakeDoc(); const origCreate = doc.createElement
  doc.createElement = function (tag) {
    const el = origCreate.call(this, tag)
    if (tag === 'video') holder.video = el
    if (tag === 'canvas') { el.getContext = () => ({ drawImage() {} }); el.toDataURL = () => 'data:image/png;base64,AAAA' }
    return el
  }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges } })
  const log = []
  const saved = []
  const fetch2 = function (url, init) {
    if (/\/coverage$/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ranges: [[0, 40], [300, 500]] }) })
    return fakeFetch(log)(url, init)
  }
  const api = { videoSaveFrame: p => { saved.push(p); return Promise.resolve({ ok: true, path: '/shots/x.png' }) }, videoThumbAt: () => Promise.resolve({ ok: true, path: '/t.jpg' }) }
  const engine = W.create({ document: doc, api, onEvent() {}, MediaSource: F.MS, fetch: fetch2, URL: URLApi, AbortController: FakeAbort })
  const sess = Object.assign({}, session, { coverageUrl: 'http://127.0.0.1:5/s/ab/coverage', chapters: [{ index: 0, title: 'One', start: 0 }, { index: 1, title: 'Two', start: 500 }], burnable: [{ index: 9, lang: 'eng', title: 'Signs', styled: true }] })
  engine.open(sess, 0)
  F.sources[0].open()
  await tick(); await tick(); await tick()
  // Coverage is polled; force one poll now.
  await new Promise(r => setTimeout(r, 10))
  const proxy = engine.wrapApi(api)
  const ch = await proxy.videoChapters()
  assert.deepEqual(ch.chapters.map(c => c.title), ['One', 'Two'])
  assert.deepEqual(engine.state().chapters.length, 2)
  // Seekable: the browser buffer [0,10] merged with converted [0,40] and [300,500].
  engine._pollCoverageNow && engine._pollCoverageNow()
  await new Promise(r => setTimeout(r, 10))
  const seekable = engine.state().seekable
  assert.deepEqual(seekable, [{ start: 0, end: 40 }, { start: 300, end: 500 }])
  const shot = await engine.control('screenshot')
  assert.deepEqual(shot, { ok: true, value: { path: '/shots/x.png' } })
  assert.equal(saved[0].dataUrl, 'data:image/png;base64,AAAA')
  const th = await proxy.videoThumbAt({ sec: 3 })
  assert.equal(th.path, '/t.jpg', 'thumbnails pass through to the real thumbnailer')
  const list = engine.trackList()
  const burn = list.find(t => t.burn)
  assert.ok(burn && /drawn in/.test(burn.title))
  const before = log.length
  engine.control('track', { type: 'sub', id: 9 })
  // A burn-in is a new stream: the engine opens a fresh media source.
  assert.equal(F.sources.length, 2); F.sources[1].open()
  await new Promise(r => setTimeout(r, 250)); await tick(); await tick()
  assert.ok(log.length > before && /burn=9/.test(log[log.length - 1].url), 'a burn-in pick restarts the stream with the burn parameter')
  engine.close()
})

test('three empty responses in a row stop the engine asking again and raise an error', async () => {
  const holder = { video: null }
  const F = fakeMSE(holder)
  const doc = fakeDoc(); const origCreate = doc.createElement
  doc.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges } })
  let n = 0; const events = []
  const emptyFetch = function (url) { n++; return Promise.resolve({ headers: { get: () => '0' }, body: { getReader() { return { read: () => Promise.resolve({ done: true }), cancel() {} } } } }) }
  const engine = W.create({ document: doc, api: {}, onEvent: e => events.push(e.kind), MediaSource: F.MS, fetch: emptyFetch, URL: URLApi, AbortController: FakeAbort })
  engine.open(session, 0)
  F.sources[0].open()
  await tick(); await tick()
  holder.video.paused = false
  // The starvation check runs on the tick; give it a few.
  await new Promise(r => setTimeout(r, 900))
  assert.ok(n >= 3 && n <= 4, 'stopped after three failures, not a storm: ' + n)
  assert.ok(events.includes('error'))
  engine.close()
})

// V4: never a black frame with no words. The engine watches the position
// while unpaused and, frozen for 12 s, says which side is stuck — once per
// freeze, cleared the moment the picture moves.
test('a frozen picture is reported once with which side is stuck, and cleared when it moves', async () => {
  const holder = { video: null }; const F = fakeMSE(holder)
  const doc2 = fakeDoc(); const origCreate = doc2.createElement
  doc2.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges } })
  const events = []; const log = []
  const inner = fakeFetch(log)
  const fetchFn = (url, init) => /coverage/.test(url) ? Promise.resolve({ json: () => Promise.resolve({ ranges: [[0, 60]] }) }) : inner(url, init)
  const engine = W.create({ document: doc2, api: {}, onEvent(e) { events.push(e) }, MediaSource: F.MS, fetch: fetchFn, URL: URLApi, AbortController: FakeAbort })
  engine.open(Object.assign({}, session, { coverageUrl: 'http://127.0.0.1:5/s/ab/coverage' }), 0)
  F.sources[0].open(); await tick(); await tick(); await tick()
  const v = holder.video; v.paused = false
  const t0 = 1000
  engine._watchdogNow(t0)
  engine._watchdogNow(t0 + 11000)
  assert.ok(!events.some(e => e.kind === 'stuck'), 'under the limit: silence')
  engine._watchdogNow(t0 + 12500)
  let stuck = events.filter(e => e.kind === 'stuck')
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].phase, 'start', 'no first frame yet')
  assert.ok(stuck[0].waited >= 12)
  engine._watchdogNow(t0 + 30000)
  assert.equal(events.filter(e => e.kind === 'stuck').length, 1, 'not repeated while still frozen')
  v.currentTime = 3; engine._watchdogNow(t0 + 31000)
  assert.ok(events.some(e => e.kind === 'unstuck'), 'movement clears it')
  // Playing, then frozen again with the converter far ahead: the page is the slow part.
  v.listeners.playing.forEach(fn => fn())
  engine._pollCoverageNow(); await tick(); await tick()
  engine._watchdogNow(t0 + 44000)
  stuck = events.filter(e => e.kind === 'stuck')
  assert.equal(stuck.length, 2)
  assert.equal(stuck[1].phase, 'play')
  assert.equal(Math.round(stuck[1].converted), 57, 'seconds the converter has ahead of the playhead')
  // Paused is not stuck.
  v.currentTime = 4; engine._watchdogNow(t0 + 45000); v.paused = true
  engine._watchdogNow(t0 + 70000)
  assert.equal(events.filter(e => e.kind === 'stuck').length, 2)
  engine.close()
})

// V4, the 4K quota storm. The browser holds ~150 MB of video: forty seconds
// of 4K. The engine used to retry a refused append 14,000 times a second
// while the reader piled the whole file into a queue. Now the look-ahead
// tightens to what the browser holds, the queue is capped in bytes, only a
// remove that frees something is issued, and a hole the browser evicted
// right after the playhead is refetched at the edge.
function quotaMSE(video, limitSec) {
  const sources = []
  class SB {
    constructor() { this.updating = false; this.timestampOffset = 0; this.mode = 'segments'; this.appends = 0; this.quota = 0; this.removes = []; this.l = {} }
    addEventListener(e, fn) { (this.l[e] = this.l[e] || []).push(fn) }
    _total() { return video.ranges.reduce((n, r) => n + (r[1] - r[0]), 0) }
    _fire() { setImmediate(() => { this.updating = false; (this.l.updateend || []).forEach(fn => fn()) }) }
    appendBuffer(chunk) {
      this.appends++
      if (this._total() + (chunk.t1 - chunk.t0) > limitSec) { this.quota++; const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e }
      const a = this.timestampOffset + chunk.t0, b = this.timestampOffset + chunk.t1
      const hit = video.ranges.find(r => Math.abs(r[1] - a) < 0.01)
      if (hit) hit[1] = b; else video.ranges.push([a, b])
      this.updating = true; this._fire()
    }
    abort() {}
    remove(a, b) {
      this.removes.push([a, b])
      video.ranges = video.ranges.map(r => [Math.max(r[0], b === Infinity ? r[0] : (r[0] < a ? r[0] : Math.min(r[1], b))), r[1]]).filter(() => true)
      // trim precisely: keep the parts outside [a,b)
      const out = []
      for (const r of video.ranges) {
        if (r[1] <= a || r[0] >= b) { out.push(r); continue }
        if (r[0] < a) out.push([r[0], a])
        if (r[1] > b) out.push([b, r[1]])
      }
      video.ranges = out
      this.updating = true; this._fire()
    }
  }
  class MS {
    constructor() { this.readyState = 'closed'; this.l = {}; this.sb = null; sources.push(this) }
    static isTypeSupported() { return true }
    addEventListener(e, fn) { (this.l[e] = this.l[e] || []).push(fn) }
    addSourceBuffer() { this.sb = new SB(); return this.sb }
    endOfStream() { this.readyState = 'ended' }
    open() { this.readyState = 'open'; (this.l.sourceopen || []).forEach(fn => fn()) }
  }
  return { MS, sources }
}
// A never-ending stream of 5 s chunks of `bytes` each from t.
function endlessFetch(log, bytes) {
  return function (url, init) {
    const t = Number(/t=(\d+)/.exec(url)[1])
    log.push({ url, t })
    let i = 0
    return Promise.resolve({
      headers: { get: k => (k === 'X-Papa-Start' ? String(t) : null) },
      body: { getReader() { return { read() { const c = { t0: i * 5, t1: i * 5 + 5, byteLength: bytes }; i++; return Promise.resolve({ done: false, value: c }) }, cancel() {} } } },
    })
  }
}
const settle = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }

test('a full browser buffer frees what is behind, tightens the look-ahead, caps the queue and stops the retry storm', async () => {
  const holder = { video: null }
  const doc2 = fakeDoc(); const origCreate = doc2.createElement
  doc2.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges }, set(v) { holder.video.ranges = v } })
  const F = quotaMSE(holder, 40)   // the browser holds forty seconds
  const log = []
  const engine = W.create({ document: doc2, api: {}, onEvent() {}, MediaSource: F.MS, fetch: endlessFetch(log, 4 * 1048576), URL: URLApi, AbortController: FakeAbort })
  try {
    engine.open(session, 0)
    F.sources[0].open()
    const v = holder.video; v.paused = false
    await settle(60)
    const sb = F.sources[0].sb, mse = engine._mse()
    // Playhead at 0, nothing behind: the browser refused once at 40 s, the
    // look-ahead tightened to 20 s, the rest was dropped and the reading stopped.
    assert.equal(sb.quota, 1, 'one refusal, not a storm')
    assert.equal(mse.aheadCap, 20)
    assert.deepEqual(v.ranges, [[0, 20]])
    assert.ok(sb.removes.some(r => r[0] === 20 && r[1] === Infinity))
    assert.equal(mse.fetching, false, 'the sequential stream was stopped at the cut')
    await new Promise(r => setTimeout(r, 650))
    assert.equal(sb.quota, 1, 'waiting, not retrying')
    assert.equal(mse.queue.length, 0, 'nothing piles up in the queue')
    assert.equal(log.length, 1, 'no fetch while the playhead is far from the edge')
    // Playback nears the edge: a fetch from the edge refills; the browser
    // fills at 40 s and this time what is behind goes (five seconds kept);
    // when it fills once more the look-ahead tightens and the stream stops
    // at the cut again — a handful of refusals, never a storm.
    v.currentTime = 16
    await new Promise(r => setTimeout(r, 900)); await settle(60)
    assert.equal(log.length, 2); assert.equal(log[1].t, 20, 'fetched from the edge of what is held')
    assert.ok(sb.removes.some(r => r[0] === 0 && r[1] === 11), 'kept five seconds behind: ' + JSON.stringify(sb.removes))
    assert.ok(v.ranges[0][0] === 11 && v.ranges[0][1] >= 33, JSON.stringify(v.ranges))
    assert.ok(sb.quota <= 3, 'a refusal per fill, not per chunk: ' + sb.quota)
    assert.equal(mse.fetching, false, 'stopped at the cut')
    // Nearing the new edge fetches from it again.
    v.currentTime = v.ranges[0][1] - 3
    await new Promise(r => setTimeout(r, 900)); await settle(60)
    assert.equal(log.length, 3); assert.equal(log[2].t, Math.round(v.currentTime + 3), 'fetched from the edge')
    assert.ok(v.ranges[v.ranges.length - 1][1] > v.currentTime + 10, 'refilled: ' + JSON.stringify(v.ranges))
    assert.ok(sb.quota <= 6, 'still a handful: ' + sb.quota)
    assert.ok(mse.queuedBytes <= 16 * 1048576 + 4 * 1048576, 'the queue is capped in bytes')
  } finally { engine.close() }
})

test('a hole the browser evicted right after the playhead is refetched at the edge', async () => {
  const holder = { video: null }
  const doc2 = fakeDoc(); const origCreate = doc2.createElement
  doc2.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges }, set(v) { holder.video.ranges = v } })
  const F = quotaMSE(holder, 1000)
  const log = []
  const engine = W.create({ document: doc2, api: {}, onEvent() {}, MediaSource: F.MS, fetch: endlessFetch(log, 1024), URL: URLApi, AbortController: FakeAbort })
  engine.open(session, 0)
  F.sources[0].open()
  await settle(20)
  const v = holder.video; v.paused = false
  // Pretend the browser evicted 10–14 s: the playhead sits at 10 with data further on.
  v.ranges = [[0, 10], [14, 60]]
  v.currentTime = 10
  engine._watchdogNow(1000)          // records the position...
  engine._watchdogNow(1000)          // ...and it has not moved since
  const before = log.length
  engine._starveNow()
  assert.equal(log.length, before + 1, 'one fetch')
  assert.equal(log[log.length - 1].t, 10, 'at the edge of the hole')
  engine._starveNow()
  assert.equal(log.length, before + 1, 'not again within five seconds')
  engine.close()
})

// A stream the browser cannot decode fails on every rebuild: after three the
// engine gives up with one error instead of refetching the same second a
// thousand times (seen live on an AV1 + burned-subtitle run).
test('three media errors in a session end the stream with one error, not a refetch storm', async () => {
  const holder = { video: null }
  const doc2 = fakeDoc(); const origCreate = doc2.createElement
  doc2.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges }, set(v) { holder.video.ranges = v } })
  const F = quotaMSE(holder, 1000)
  const log = []; const events = []
  const engine = W.create({ document: doc2, api: {}, onEvent(e) { events.push(e) }, MediaSource: F.MS, fetch: endlessFetch(log, 1024), URL: URLApi, AbortController: FakeAbort })
  try {
    engine.open(session, 0)
    F.sources[0].open()
    await settle(10)
    const v = holder.video
    // Every append from now on finds the element dead.
    v.error = { code: 3, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }
    for (let i = 0; i < 12; i++) { F.sources[F.sources.length - 1].open(); await settle(10) }
    assert.ok(F.sources.length <= 5, 'rebuilt at most three times: ' + F.sources.length)
    assert.ok(log.length <= 6, 'a handful of fetches, not a storm: ' + log.length)
    const errs = events.filter(e => e.kind === 'error')
    assert.equal(errs.length, 1, 'one error to the deck')
    assert.match(errs[0].message, /could not play this stream \(DEMUXER_ERROR_COULD_NOT_OPEN\)/)
    assert.equal(engine._mse().dead, true)
  } finally { engine.close() }
})

// A span that begins behind the playhead overwrites the pictures the decoder
// is standing on; a seek to the same second after the first append re-arms it.
test('a refetch that starts behind the playhead nudges the element once', async () => {
  const holder = { video: null }
  const doc2 = fakeDoc(); const origCreate = doc2.createElement
  doc2.createElement = function (tag) { const el = origCreate.call(this, tag); if (tag === 'video') holder.video = el; return el }
  Object.defineProperty(holder, 'ranges', { get() { return holder.video.ranges }, set(v) { holder.video.ranges = v } })
  const F = quotaMSE(holder, 1000)
  const log = []
  // The server answers a request for t with a span starting 1.4 s earlier.
  const fetchFn = (url, init) => { const t = Number(/t=(\d+)/.exec(url)[1]); const inner = fakeFetch(log, () => t - 1.4); return inner(url, init) }
  const engine = W.create({ document: doc2, api: {}, onEvent() {}, MediaSource: F.MS, fetch: fetchFn, URL: URLApi, AbortController: FakeAbort })
  try {
    engine.open(session, 0)
    F.sources[0].open(); await settle(10)
    const v = holder.video; v.paused = false
    let sets = 0; let cur = 30
    Object.defineProperty(v, 'currentTime', { get() { return cur }, set(x) { sets++; cur = x }, configurable: true })
    v.ranges = [[0, 30]]
    engine._starveNow()          // ahead < 5: fetch at 30 → the span starts at 28.6
    await settle(20)
    assert.equal(log[log.length - 1].t, 30)
    assert.equal(F.sources[0].sb.timestampOffset, 28.6)
    assert.equal(sets, 1, 'one nudge after the first append')
    await settle(20)
    assert.equal(sets, 1, 'not repeated')
  } finally { engine.close() }
})
