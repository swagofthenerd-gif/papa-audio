'use strict'
// V1: the in-page engine speaks the controller's language: state stream,
// verbs, tracks, seek-by-restart, and the API proxy that routes calls.
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
      const el = { tag, listeners: {}, attrs: {}, dataset: {}, children: [], classes: new Set(), parentNode: null,
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) },
        fire(ev) { (this.listeners[ev] || []).forEach(fn => fn({})) },
        setAttribute(k, v) { this.attrs[k] = v }, removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = '' },
        appendChild(c) { this.children.push(c); c.parentNode = this }, querySelectorAll(sel) { return sel === 'track' ? this.children.filter(c => c.tag === 'track') : [] },
        classList: { toggle(c, on) { on ? el.classes.add(c) : el.classes.delete(c) } },
        // <video> behaviour
        paused: true, currentTime: 0, duration: 0, volume: 1, muted: false, playbackRate: 1, ended: false, videoWidth: 0, videoHeight: 0, textTracks: [],
        buffered: { length: 1, start() { return 0 }, end() { return 30 } },
        play() { this.paused = false; return Promise.resolve() }, pause() { this.paused = true }, load() { this.loaded = (this.loaded || 0) + 1; this.currentTime = 0 },
      }
      el.textTracks = []
      return el
    },
  }
}
const session = { id: 'ab', streamUrl: 'http://127.0.0.1:5/s/ab.mp4', duration: 1200, plan: { mode: 'transcode', badges: ['converted'], video: { index: 0, codec: 'hevc', copy: false, width: 1920 }, audio: { index: 1, codec: 'aac', copy: true, channels: 6 } },
  audios: [{ index: 1, codec: 'aac', channels: 6, lang: 'jpn' }, { index: 2, codec: 'aac', channels: 6, lang: 'eng' }], subtitles: [{ index: 3, lang: 'eng', title: 'English', url: 'http://127.0.0.1:5/s/ab/sub/3.vtt' }] }

test('open mounts the picture on the stage, loads the stream from 0, and reports a state the deck can render', () => {
  const doc = fakeDoc(); const events = []
  const e = W.create({ document: doc, api: {}, onEvent: ev => events.push(ev.kind) })
  e.open(session, 0)
  const v = e._video()
  assert.equal(v.parentNode.id, 'vt-stage')
  assert.equal(v.src, 'http://127.0.0.1:5/s/ab.mp4?t=0&fresh=1&a=1')
  assert.equal(v.children.filter(c => c.tag === 'track').length, 1, 'one WebVTT sidecar')
  const s = e.state()
  assert.equal(s.duration, 1200); assert.equal(s.paused, false); assert.equal(s.audio.channels, 6); assert.equal(s.audio.layout, 'surround'); assert.equal(s.video.codec, 'h264')
  v.fire('playing')
  assert.deepEqual(events, ['playing'])
  e.close()
  assert.equal(e.active(), false)
})

test('seek inside the buffer moves currentTime; outside it restarts the stream at the target with the offset carried', () => {
  const doc = fakeDoc()
  const e = W.create({ document: doc, api: {}, onEvent() {} })
  e.open(session, 0)
  const v = e._video()
  e.control('seek', { seconds: 12, mode: 'absolute' })
  assert.equal(v.currentTime, 12); assert.equal(v.loaded, 1, 'no reload')
  e.control('seek', { seconds: 600, mode: 'absolute' })
  assert.equal(v.src, 'http://127.0.0.1:5/s/ab.mp4?t=600&fresh=1&a=1'); assert.equal(v.loaded, 2)
  v.currentTime = 5
  assert.equal(e.state().position, 605, 'offset + currentTime')
  e.control('seek', { seconds: -10, mode: 'relative' })
  assert.equal(e.state().position, 595)
  e.close()
})

test('verbs: pause/play, volume in percent, mute, speed, audio track switch restarts at the same second, subtitle select', () => {
  const doc = fakeDoc()
  const e = W.create({ document: doc, api: {}, onEvent() {} })
  e.open(session, 0)
  const v = e._video()
  e.control('pause'); assert.equal(v.paused, true)
  e.control('pause', { paused: false }); assert.equal(v.paused, false)
  e.control('volume', { value: 40 }); assert.equal(v.volume, 0.4)
  e.control('mute', { value: true }); assert.equal(v.muted, true)
  e.control('speed', { value: 1.5 }); assert.equal(v.playbackRate, 1.5); assert.equal(e.state().speed, 1.5)
  v.currentTime = 33
  e.control('track', { type: 'audio', id: 2 })
  assert.equal(v.src, 'http://127.0.0.1:5/s/ab.mp4?t=33&fresh=1&a=2')
  assert.ok(e.trackList().find(t => t.type === 'audio' && t.id === 2).selected)
  e.control('track', { type: 'sub', id: 3 })
  assert.ok(e.trackList().find(t => t.type === 'sub' && t.id === 3).selected)
  e.close()
})

test('the API proxy routes to the engine while a session is active and to the real API otherwise', async () => {
  const doc = fakeDoc(); const calls = []
  const real = { videoControl: (verb) => { calls.push('native:' + verb); return Promise.resolve({ ok: true }) }, onVideoState: (cb) => { real._cb = cb; return () => { real._off = true } },
    videoTracks: () => Promise.resolve({ ok: true, tracks: ['native'] }), videoChapters: () => Promise.resolve({ ok: true, chapters: ['c'] }), videoSurfaceBounds: () => { calls.push('bounds'); return Promise.resolve() },
    videoSurfaceVisible: () => Promise.resolve(), videoMiniMode: (p) => { calls.push('native:mini'); return Promise.resolve() }, videoOsd: () => Promise.resolve(), videoThumbAt: () => Promise.resolve('thumb'), videoThumb: () => Promise.resolve('thumb'), videoStreamStats: () => Promise.resolve({ native: true }), videoStop: () => { calls.push('stop'); return Promise.resolve({ ok: true }) }, videoOther: () => 'passthrough' }
  const e = W.create({ document: doc, api: real, onEvent() {} })
  const p = e.wrapApi(real)
  await p.videoControl('pause'); assert.deepEqual(calls, ['native:pause'], 'no session → mpv')
  assert.equal(p.videoOther(), 'passthrough')
  const seen = []
  p.onVideoState(s => seen.push(s.web ? 'web' : 'native'))
  real._cb({}); assert.deepEqual(seen, ['native'])
  e.open(session, 0)
  await p.videoControl('pause'); assert.equal(calls.length, 1, 'session active → engine, not mpv')
  await p.videoSurfaceBounds({}); assert.equal(calls.length, 1, 'no native bounds while web')
  await p.videoMiniMode({ on: true, rect: {} }); assert.equal(e._video().parentNode.id, 'vmini-video', 'mini mode reparents the picture')
  await p.videoMiniMode({ on: false }); assert.equal(e._video().parentNode.id, 'vt-stage')
  assert.deepEqual((await p.videoTracks()).tracks.map(t => t.type), ['audio', 'audio', 'sub'])
  assert.deepEqual((await p.videoChapters()).chapters, [])
  assert.equal(await p.videoThumbAt({ sec: 1 }), null)
  const before = seen.length
  real._cb({}); assert.equal(seen.filter(x => x === 'native').length, 1, 'native state is muted while web is active')
  assert.ok(seen.length >= before && seen.slice(1).every(x => x === 'web'), 'only the engine speaks while a session is active')
  await p.videoStop(); assert.equal(e.active(), false); assert.ok(calls.includes('stop'))
})
