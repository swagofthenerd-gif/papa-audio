'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const { MpvCrossfade } = require('../mpv-crossfade')

class FakeEngine extends EventEmitter {
  constructor() {
    super()
    this.calls = []
    this.state = { path: null, position: 0, duration: 0, paused: true, volume: 100, audioParams: null }
  }
  async start() { this.calls.push(['start']) }
  stop() { this.calls.push(['stop']) }
  async load(p, o) { this.calls.push(['load', p, o]); this.state.path = p }
  async setNext(p) { this.calls.push(['setNext', p]) }
  async play() { this.calls.push(['play']); this.state.paused = false }
  async pause() { this.calls.push(['pause']); this.state.paused = true }
  async seek(s) { this.calls.push(['seek', s]) }
  async setVolume(v) { this.calls.push(['setVolume', v]); this.state.volume = v }
  async setSpeed(x) { this.calls.push(['setSpeed', x]) }
  async setReplaygain(m) { this.calls.push(['setReplaygain', m]) }
  async setChannels(l) { this.calls.push(['setChannels', l]) }
  async listAudioDevices() { return [] }
  async restart() { this.calls.push(['restart']) }
  getState() { return { ...this.state } }
  isActuallyPlaying() { return Boolean(!this.state.paused && this.state.path) }
}

function make(crossfadeSecs = 2) {
  const engines = []
  const cf = new MpvCrossfade({
    crossfadeSecs,
    tickMs: 5,
    engineFactory: () => { const e = new FakeEngine(); engines.push(e); return e },
  })
  return { cf, engines }
}

test('start spawns two engines, load goes to active only', async () => {
  const { cf, engines } = make()
  await cf.start()
  assert.strictEqual(engines.length, 2)
  await cf.load('/m/a.flac')
  assert.ok(engines[0].calls.some(c => c[0] === 'load' && c[1] === '/m/a.flac'))
  assert.ok(!engines[1].calls.some(c => c[0] === 'load'))
})

test('nearing end-of-track starts fade into queued next and emits autoAdvanced', async () => {
  const { cf, engines } = make(2)
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setVolume(80)
  await cf.setNext('/m/b.flac')
  const adv = new Promise(r => cf.once('autoAdvanced', r))
  engines[0].state.duration = 100
  engines[0].emit('duration', 100)
  engines[0].emit('position', 98.5) // inside the 2s fade window
  assert.strictEqual(await adv, '/m/b.flac')
  // b loaded+playing on the second engine
  assert.ok(engines[1].calls.some(c => c[0] === 'load' && c[1] === '/m/b.flac'))
  // fade ramp touched both volumes; final: new active at user volume, old silenced+paused
  const lastVolNew = engines[1].calls.filter(c => c[0] === 'setVolume').pop()
  assert.strictEqual(lastVolNew[1], 80)
  assert.ok(engines[0].calls.some(c => c[0] === 'pause'))
})

test('after fade, subsequent load goes to the new active engine', async () => {
  const { cf, engines } = make(2)
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  const adv = new Promise(r => cf.once('autoAdvanced', r))
  engines[0].state.duration = 10
  engines[0].emit('duration', 10)
  engines[0].emit('position', 9.5)
  await adv
  await cf.load('/m/c.flac')
  assert.ok(engines[1].calls.some(c => c[0] === 'load' && c[1] === '/m/c.flac'))
})

test('without a queued next, track end emits ended (no fade)', async () => {
  const { cf, engines } = make(2)
  await cf.start()
  await cf.load('/m/a.flac')
  const ended = new Promise(r => cf.once('ended', r))
  engines[0].emit('ended')
  await ended
})

test('getState reflects active engine', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  engines[0].state.position = 42
  assert.strictEqual(cf.getState().position, 42)
})

test('isActuallyPlaying forwards to the active engine', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  assert.strictEqual(cf.isActuallyPlaying(), false, 'loaded but paused by default')
  engines[0].state.paused = false
  assert.strictEqual(cf.isActuallyPlaying(), true)
})

test('setChannels fans out to both engines', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.setChannels('5.1')
  for (const e of engines) {
    assert.ok(e.calls.some(c => c[0] === 'setChannels' && c[1] === '5.1'))
  }
})
