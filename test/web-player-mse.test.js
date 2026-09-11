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
  v.currentTime = 7
  engine.seekTo(3)
  assert.equal(log.length, 1, 'inside the buffer: no fetch'); assert.equal(v.currentTime, 3)
  engine.seekTo(300)
  await tick(); await tick(); await tick()
  assert.equal(log.length, 2); assert.equal(log[1].t, 300)
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
