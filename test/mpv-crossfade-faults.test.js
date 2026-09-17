'use strict'
// What the crossfade wrapper does when something goes wrong, and what shape the
// fade itself has.
//
// Every test here drives the real MpvCrossfade from ../mpv-crossfade against a
// scriptable fake engine — the production class is required and executed, not
// read as text. The five behaviours pinned:
//
//   B1 a fade that throws must not leave the wrapper stuck mid-fade forever
//   B2 a quarantined ("poisoned") track must reach the renderer so it can skip
//   B3 the idle engine's lifecycle events must not be reported as the player's
//   B4 the ramp must hold constant power through mpv's CUBIC volume domain
//   B5 exclusive/bit-perfect output and crossfade cannot share a device

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const {
  MpvCrossfade, FADE_STEPS, crossfadeStep, mpvVolumeForAmplitude, wantsExclusiveDevice,
} = require('../mpv-crossfade')

class FakeEngine extends EventEmitter {
  constructor(opts) {
    super()
    this.opts = opts
    this.calls = []
    this.fail = {}          // method name -> Error to throw (once, then cleared)
    this.state = { path: null, position: 0, duration: 0, paused: true, volume: 100, audioParams: null }
  }
  _maybeFail(name) {
    const e = this.fail[name]
    if (!e) return
    delete this.fail[name]
    throw e
  }
  async start() { this.calls.push(['start']) }
  stop() { this.calls.push(['stop']) }
  async load(p, o) { this.calls.push(['load', p, o]); this._maybeFail('load'); this.state.path = p; this.state.paused = false }
  async setNext(p) { this.calls.push(['setNext', p]); this._maybeFail('setNext') }
  async play() { this.calls.push(['play']); this.state.paused = false }
  async pause() { this.calls.push(['pause']); this._maybeFail('pause'); this.state.paused = true }
  async seek(s) { this.calls.push(['seek', s]) }
  async setVolume(v) { this.calls.push(['setVolume', v]); this._maybeFail('setVolume'); this.state.volume = v }
  async setSpeed(x) { this.calls.push(['setSpeed', x]) }
  async setReplaygain(m) { this.calls.push(['setReplaygain', m]) }
  async setChannels(l) { this.calls.push(['setChannels', l]) }
  async setEq(s) { this.calls.push(['setEq', s]) }
  async setProperty(n, v) { this.calls.push(['setProperty', n, v]) }
  async listAudioDevices() { return [] }
  async restart() { this.calls.push(['restart']) }
  getState() { return { ...this.state } }
  isActuallyPlaying() { return Boolean(!this.state.paused && this.state.path) }
  volumes() { return this.calls.filter(c => c[0] === 'setVolume').map(c => c[1]) }
  did(name) { return this.calls.some(c => c[0] === name) }
}

function make(opts = {}) {
  const engines = []
  const built = []
  const cf = new MpvCrossfade({
    crossfadeSecs: opts.crossfadeSecs ?? 2,
    tickMs: opts.tickMs ?? 1,
    engineOpts: opts.engineOpts,
    engineFactory: o => { built.push(o); const e = new FakeEngine(o); engines.push(e); return e },
  })
  return { cf, engines, built }
}

// Drive the active engine to the point where a fade should begin.
function nudgeIntoFadeWindow(engine, duration = 100) {
  engine.state.duration = duration
  engine.emit('duration', duration)
  engine.state.position = duration - 0.5
  engine.emit('position', duration - 0.5)
}

function once(em, name, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for ' + name)), ms)
    em.once(name, v => { clearTimeout(t); resolve(v) })
  })
}

function never(em, name, ms = 60) {
  return new Promise(resolve => {
    let seen = null
    const h = v => { seen = v == null ? true : v }
    em.on(name, h)
    setTimeout(() => { em.off(name, h); resolve(seen) }, ms)
  })
}

// ── B1: a failed fade must not wedge the player ───────────────────────────────

test('B1 a fade that throws restores the playing track instead of wedging silent', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setVolume(80)
  await cf.setNext('/m/b.flac')
  // The incoming engine cannot open the queued file.
  engines[1].fail.load = new Error('engine gone during load')

  const failed = once(cf, 'crossfadeFailed')
  nudgeIntoFadeWindow(engines[0])
  const ev = await failed
  assert.strictEqual(ev.path, '/m/b.flac')

  // The track the listener is actually hearing is back at the user's volume,
  // not left at whatever the ramp had reached.
  assert.strictEqual(engines[0].volumes().pop(), 80,
    'the still-playing engine must be restored to the user volume')
  // Nothing else is making sound.
  assert.strictEqual(engines[1].volumes().pop(), 0)
  assert.ok(engines[1].did('pause'), 'the half-started incoming engine must be stopped')
  // The active engine never changed: the handoff did not happen.
  assert.strictEqual(cf.activeIdx, 0)
  assert.strictEqual(cf._fading, false, 'the fade flag must not survive the failure')
})

test('B1 after a failed fade the engine events still reach the player', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  engines[1].fail.load = new Error('engine gone during load')
  const failed = once(cf, 'crossfadeFailed')
  nudgeIntoFadeWindow(engines[0])
  await failed

  // _fading gates every ifActive forward. Left true, the album goes silent at the
  // end of this track: 'ended' never arrives, so the renderer never advances.
  const ended = once(cf, 'ended')
  engines[0].emit('ended')
  await ended
  const paused = once(cf, 'paused')
  engines[0].emit('paused', true)
  assert.strictEqual(await paused, true)
})

test('B1 a later fade still works after an earlier one failed', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setVolume(100)
  await cf.setNext('/m/b.flac')
  engines[1].fail.load = new Error('engine gone during load')
  const failed = once(cf, 'crossfadeFailed')
  nudgeIntoFadeWindow(engines[0], 100)
  await failed

  // Same track, next prefetch: the fade must be allowed to run again.
  await cf.setNext('/m/c.flac')
  const adv = once(cf, 'autoAdvanced')
  engines[0].state.position = 99.6
  engines[0].emit('position', 99.6)
  assert.strictEqual(await adv, '/m/c.flac')
  assert.strictEqual(cf.activeIdx, 1)
})

test('B1 a failure after the ramp completes keeps the handoff', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  // Everything works except silencing the outgoing engine at the very end.
  engines[0].fail.pause = new Error('engine gone during pause')
  const adv = once(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  assert.strictEqual(await adv, '/m/b.flac')
  assert.strictEqual(cf.activeIdx, 1, 'the new track is audible, so it is the active one')
  assert.strictEqual(cf._fading, false)
})

// ── B2: a quarantined track has to reach the renderer ─────────────────────────

test('B2 the playing engine quarantining a file is forwarded so the queue moves on', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  const seen = once(cf, 'trackUnplayable')
  engines[0].emit('trackUnplayable', {
    path: '/m/a.flac', deaths: 2, reason: 'the audio engine crashed on this file',
  })
  const d = await seen
  assert.strictEqual(d.path, '/m/a.flac')
  assert.strictEqual(d.deaths, 2)
})

test('B2 a quarantined file on the idle engine is reported without skipping the playing track', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  const next = once(cf, 'nextTrackUnplayable')
  const wrongSkip = never(cf, 'trackUnplayable')
  engines[1].emit('trackUnplayable', { path: '/m/b.flac', deaths: 2, reason: 'crashes' })
  assert.strictEqual((await next).path, '/m/b.flac')
  assert.strictEqual(await wrongSkip, null,
    'skipping here would cut the healthy playing track short')
  assert.strictEqual(cf._nextPath, null, 'the poisoned file must not be queued for a fade')
})

test('B2 the forwarding follows the active engine across a fade', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  const adv = once(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  await adv
  const seen = once(cf, 'trackUnplayable')
  engines[1].emit('trackUnplayable', { path: '/m/b.flac', deaths: 2, reason: 'crashes' })
  assert.strictEqual((await seen).path, '/m/b.flac')
})

// ── B3: the idle engine is not the player ─────────────────────────────────────

test('B3 the idle engine going down does not tell the UI playback stopped', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  const down = never(cf, 'engineDown')
  const recovered = never(cf, 'engineRecovered')
  engines[1].emit('engineDown', { path: null, position: 0, willRecover: true })
  engines[1].emit('engineRecovered', { path: null, position: 0, resumed: false })
  assert.strictEqual(await down, null, 'the idle engine is inaudible; its respawn is not the player stopping')
  assert.strictEqual(await recovered, null)
})

test('B3 the playing engine going down is still reported', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  const down = once(cf, 'engineDown')
  engines[0].emit('engineDown', { path: '/m/a.flac', position: 12, willRecover: true })
  assert.strictEqual((await down).path, '/m/a.flac')
  const rec = once(cf, 'engineRecovered')
  engines[0].emit('engineRecovered', { path: '/m/a.flac', position: 12, resumed: true })
  assert.strictEqual((await rec).resumed, true)
})

test('B3 the gate follows the handoff: after a fade the other engine is the player', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  const adv = once(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  await adv
  const stale = never(cf, 'engineDown')
  engines[0].emit('engineDown', { path: '/m/a.flac', position: 99, willRecover: true })
  assert.strictEqual(await stale, null, 'the engine that was faded out is now the idle one')
  const live = once(cf, 'engineDown')
  engines[1].emit('engineDown', { path: '/m/b.flac', position: 3, willRecover: true })
  assert.strictEqual((await live).path, '/m/b.flac')
})

test('B3 an idle engine failing for good degrades crossfade instead of killing the player', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  const killed = never(cf, 'engineFailed')
  const notice = once(cf, 'crossfadeUnavailable')
  engines[1].emit('engineFailed', { reason: 'respawn-limit', detail: 'mpv died 4 times in 60s' })
  assert.strictEqual((await notice).reason, 'engine-failed')
  assert.strictEqual(await killed, null,
    'main tears the whole player down on engineFailed; the idle engine must not trigger that')
  assert.strictEqual(cf.crossfadeEnabled, false)

  // With one engine left, the queued path has to reach mpv or nothing prefetches.
  await cf.setNext('/m/b.flac')
  assert.ok(engines[0].calls.some(c => c[0] === 'setNext' && c[1] === '/m/b.flac'))
  // And no fade is attempted into the dead engine.
  const noFade = never(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  assert.strictEqual(await noFade, null)
})

test('B3 the playing engine failing is still reported', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  const failed = once(cf, 'engineFailed')
  engines[0].emit('engineFailed', { reason: 'respawn-limit', detail: 'mpv died 4 times in 60s' })
  assert.strictEqual((await failed).reason, 'respawn-limit')
})

// ── B4: the ramp is a curve in the amplitude domain, not in mpv's ─────────────

// mpv's volume property is cubic: amplitude = (volume/100)^3. Recover the
// amplitude a given mpv volume actually produced, relative to the user's setting.
function amplitudeOf(mpvVolume, userVolume) {
  return Math.pow(Number(mpvVolume) / Number(userVolume), 3)
}

test('B4 the step table holds constant power right through the fade', () => {
  const user = 100
  for (let i = 0; i <= FADE_STEPS; i++) {
    const t = i / FADE_STEPS
    const step = crossfadeStep(user, t)
    const out = amplitudeOf(step.from, user)
    const inc = amplitudeOf(step.to, user)
    const power = out * out + inc * inc
    assert.ok(Math.abs(power - 1) < 0.02,
      `combined power at t=${t} was ${power.toFixed(3)} (mpv ${step.from}/${step.to}); ` +
      'a linear ramp in mpv\'s cubic domain collapses to 0.03 here')
  }
})

test('B4 the midpoint is not the linear half a cubic-domain ramp would give', () => {
  const mid = crossfadeStep(100, 0.5)
  // Equal power at the midpoint: both sides at 1/sqrt(2) amplitude, which in
  // mpv's cubic domain is cbrt(0.7071) = 0.891 of the user volume.
  assert.ok(Math.abs(mid.from - 89.1) < 0.5, `outgoing midpoint was ${mid.from}`)
  assert.ok(Math.abs(mid.to - 89.1) < 0.5, `incoming midpoint was ${mid.to}`)
  assert.ok(mid.from > 60, 'a linear ramp would sit at 50 here and dip ~12 dB')
})

test('B4 the ends of the ramp are still silence and the user volume', () => {
  assert.strictEqual(crossfadeStep(80, 0).to, 0)
  assert.strictEqual(crossfadeStep(80, 0).from, 80)
  assert.strictEqual(crossfadeStep(80, 1).to, 80)
  assert.strictEqual(crossfadeStep(80, 1).from, 0)
  // The cube root is the same mapping volume-map.js uses for the slider and
  // loudness.js uses for a stored gain: half amplitude is ~0.794 of the volume.
  assert.strictEqual(mpvVolumeForAmplitude(100, 0.125), 50)
  assert.strictEqual(mpvVolumeForAmplitude(100, 1), 100)
  assert.strictEqual(mpvVolumeForAmplitude(100, 0), 0)
})

test('B4 a real fade sends those volumes to the engines', async () => {
  const { cf, engines } = make()
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setVolume(100)
  await cf.setNext('/m/b.flac')
  const adv = once(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  await adv
  // The ramp is the tail: everything before it is setup (load() restoring the
  // user volume, setVolume(), and the incoming engine being opened at 0).
  const out = engines[0].volumes().slice(-FADE_STEPS)
  const inc = engines[1].volumes().slice(-FADE_STEPS)
  assert.strictEqual(engines[0].volumes().length, FADE_STEPS + 2)
  assert.strictEqual(engines[1].volumes().length, FADE_STEPS + 1)
  for (let i = 0; i < FADE_STEPS; i++) {
    const power = Math.pow(out[i] / 100, 6) + Math.pow(inc[i] / 100, 6)
    assert.ok(Math.abs(power - 1) < 0.02,
      `step ${i + 1} sent ${out[i]}/${inc[i]}, combined power ${power.toFixed(3)}`)
  }
})

// ── B5: exclusive output and crossfade cannot share one device ────────────────

test('B5 exclusive output is detected from either spelling', () => {
  assert.strictEqual(wantsExclusiveDevice({ outputMode: 'exclusive', alsaDevice: 'hw:1,0' }), true)
  assert.strictEqual(wantsExclusiveDevice({ bitPerfect: true }), true)
  assert.strictEqual(wantsExclusiveDevice({ outputMode: 'default' }), false)
  assert.strictEqual(wantsExclusiveDevice(null), false)
})

test('B5 exclusive output means one engine, gapless, and a spoken-aloud downgrade', async () => {
  const { cf, engines, built } = make({
    engineOpts: { config: { outputMode: 'exclusive', alsaDevice: 'hw:1,0', gapless: false } },
  })
  const notice = once(cf, 'crossfadeUnavailable')
  await cf.start()
  const ev = await notice
  assert.strictEqual(ev.reason, 'exclusive-output')
  assert.strictEqual(ev.mode, 'gapless')
  assert.match(ev.detail, /exclusive/i)

  assert.strictEqual(engines.length, 1,
    'a second engine would fight the first for the exclusive device handle')
  assert.strictEqual(cf.crossfadeEnabled, false)
  // The one engine has to do mpv-side gapless, or the fallback transitions worse
  // than plain gapless would.
  assert.strictEqual(built[0].config.gapless, true)
  // The caller's own config is not mutated.
  assert.strictEqual(built[0].config.outputMode, 'exclusive')
})

test('B5 bit-perfect output degrades the same way', async () => {
  const { cf, engines } = make({ engineOpts: { config: { bitPerfect: true, gapless: false } } })
  const notice = once(cf, 'crossfadeUnavailable')
  await cf.start()
  assert.strictEqual((await notice).reason, 'exclusive-output')
  assert.strictEqual(engines.length, 1)
})

test('B5 the degraded wrapper prefetches through mpv and never fades', async () => {
  const { cf, engines } = make({ engineOpts: { config: { outputMode: 'exclusive' } } })
  await cf.start()
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  assert.ok(engines[0].calls.some(c => c[0] === 'setNext' && c[1] === '/m/b.flac'),
    'with one engine the queued path must reach mpv itself')
  const noFade = never(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  assert.strictEqual(await noFade, null, 'there is no second engine to fade into')
  // mpv doing the handoff still has to reach the renderer.
  const adv = once(cf, 'autoAdvanced')
  engines[0].emit('autoAdvanced', '/m/b.flac')
  assert.strictEqual(await adv, '/m/b.flac')
})

test('B5 shared output keeps the two-engine crossfade', async () => {
  const { cf, engines } = make({ engineOpts: { config: { outputMode: 'default', gapless: false } } })
  const quiet = never(cf, 'crossfadeUnavailable')
  await cf.start()
  assert.strictEqual(await quiet, null)
  assert.strictEqual(engines.length, 2)
  assert.strictEqual(cf.crossfadeEnabled, true)
  await cf.load('/m/a.flac')
  await cf.setNext('/m/b.flac')
  const adv = once(cf, 'autoAdvanced')
  nudgeIntoFadeWindow(engines[0])
  assert.strictEqual(await adv, '/m/b.flac')
})
