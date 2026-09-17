'use strict'
// What Pause, Play, Seek and "play this instead" do while a crossfade is running.
//
// The wrapper holds two engines and flips `activeIdx` only at the END of the
// ramp, so for the whole length of the configured crossfade — at every single
// track boundary — `this._active` is still the engine being faded OUT and
// thrown away. play/pause/seek/load all route through `this._active`, so during
// that window:
//
//   Pause paused the departing track while the arriving one kept ramping up, so
//   the music got LOUDER and the button sprang back to Play.
//   Seek moved a track that was seconds from being discarded: the progress bar
//   did nothing.
//   Picking a different track loaded it into the departing engine, and the fade
//   then handed over to the other engine — so he got the auto-next track
//   instead of the one he chose.
//
// An earlier commit fixed the wedged `_fading` flag and the event gating; it did
// not touch these four verbs.
//
// The real MpvCrossfade is driven against a scriptable fake engine. Nothing here
// reads source as text.

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const { MpvCrossfade } = require('../mpv-crossfade')

class FakeEngine extends EventEmitter {
	constructor(opts) {
		super()
		this.opts = opts
		this.calls = []
		this.state = { path: null, position: 0, duration: 0, paused: true, volume: 100, audioParams: null }
	}
	async start() { this.calls.push(['start']) }
	stop() { this.calls.push(['stop']) }
	async load(p, o) { this.calls.push(['load', p, o]); this.state.path = p; this.state.paused = false }
	async setNext(p) { this.calls.push(['setNext', p]) }
	async play() { this.calls.push(['play']); this.state.paused = false }
	async pause() { this.calls.push(['pause']); this.state.paused = true }
	async seek(s) { this.calls.push(['seek', s]); this.state.position = s }
	async setVolume(v) { this.calls.push(['setVolume', v]); this.state.volume = v }
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

const TICK = 5
// Twenty steps at TICK ms, plus room for the handover that follows them.
const PAST_THE_WHOLE_FADE = 20 * TICK + 120

function make() {
	const engines = []
	const cf = new MpvCrossfade({
		crossfadeSecs: 2,
		tickMs: TICK,
		engineFactory: o => { const e = new FakeEngine(o); engines.push(e); return e },
	})
	return { cf, engines }
}

function nudgeIntoFadeWindow(engine, duration = 100) {
	engine.state.duration = duration
	engine.emit('duration', duration)
	engine.state.position = duration - 0.5
	engine.emit('position', duration - 0.5)
}

async function waitFor(pred, what, ms = 2000) {
	const t0 = Date.now()
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what)
		await new Promise(r => setTimeout(r, 1))
	}
}

const settle = ms => new Promise(r => setTimeout(r, ms))

// A wrapper playing /m/a.flac with /m/b.flac queued, stopped part-way through
// the ramp into b — the exact window every one of these bugs lives in.
async function midFade() {
	const { cf, engines } = make()
	await cf.start()
	await cf.load('/m/a.flac')
	await cf.setVolume(80)
	await cf.setNext('/m/b.flac')

	const advanced = []
	cf.on('autoAdvanced', p => advanced.push(p))
	const failures = []
	cf.on('crossfadeFailed', d => failures.push(d))

	nudgeIntoFadeWindow(engines[0])
	// Three steps in: both tracks are audible and the handover has not happened.
	await waitFor(() => engines[1].volumes().length >= 3, 'the ramp to start')
	assert.strictEqual(cf._fading, true, 'the fade must still be running')
	assert.strictEqual(cf.activeIdx, 0, 'and the handover must not have happened yet')
	return { cf, engines, advanced, failures }
}

test('Pause during a crossfade actually stops the music', async () => {
	const { cf, engines, advanced } = await midFade()

	await cf.pause()
	await settle(PAST_THE_WHOLE_FADE)

	assert.strictEqual(cf.isActuallyPlaying(), false,
		'the player must be stopped — it used to keep playing and get louder')
	assert.strictEqual(engines[0].state.paused, true, 'the track he was listening to is paused')
	assert.strictEqual(engines[1].state.paused, true, 'and the one fading in is stopped too')
	assert.strictEqual(engines[1].volumes().pop(), 0, 'the arriving track is silenced, not left ramping')
	assert.strictEqual(cf.activeIdx, 0, 'no handover happens behind a pause')
	assert.deepStrictEqual(advanced, [], 'and the queue does not advance while paused')
})

test('Play during a crossfade resumes the track he was listening to', async () => {
	const { cf, engines, advanced } = await midFade()

	await cf.play()
	await settle(PAST_THE_WHOLE_FADE)

	assert.strictEqual(cf.activeIdx, 0, 'the departing engine stays the one in charge')
	assert.strictEqual(cf.getState().path, '/m/a.flac', 'and it is still his track')
	assert.strictEqual(engines[0].volumes().pop(), 80, 'restored to his volume, not left mid-ramp')
	assert.strictEqual(engines[1].state.paused, true, 'the other engine is stopped')
	assert.deepStrictEqual(advanced, [], 'no silent auto-advance')
})

test('Seek during a crossfade moves the track he can hear, and it sticks', async () => {
	const { cf, engines, advanced } = await midFade()

	await cf.seek(30)
	await settle(PAST_THE_WHOLE_FADE)

	assert.ok(engines[0].did('seek'), 'the seek lands on the track he is listening to')
	assert.strictEqual(cf.activeIdx, 0,
		'and it must still be the active track afterwards — otherwise the seek was thrown away')
	assert.strictEqual(cf.getState().path, '/m/a.flac')
	assert.strictEqual(cf.getState().position, 30, 'the progress bar moved and stayed moved')
	assert.deepStrictEqual(advanced, [], 'seeking is not an advance')
})

test('Picking a different track during a crossfade plays that track, not the auto-next one', async () => {
	const { cf, engines, advanced } = await midFade()

	await cf.load('/m/chosen.flac')
	await settle(PAST_THE_WHOLE_FADE)

	assert.strictEqual(cf.getState().path, '/m/chosen.flac',
		'he gets what he picked — this used to hand over to the queued track instead')
	assert.notStrictEqual(cf.getState().path, '/m/b.flac')
	assert.strictEqual(cf.isActuallyPlaying(), true, 'and it is playing')
	assert.strictEqual(engines[0].volumes().pop(), 80, 'at his volume, not part-way down the ramp')
	assert.strictEqual(engines[1].state.paused, true, 'the abandoned fade makes no sound')
	assert.deepStrictEqual(advanced, [], 'the queue did not advance on its own')
})

test('interrupting a fade is not reported to him as a failure', async () => {
	const { cf, failures } = await midFade()

	await cf.pause()
	await settle(PAST_THE_WHOLE_FADE)

	assert.deepStrictEqual(failures, [],
		'nothing failed — he pressed a button, and "that crossfade did not complete" would be a lie')
})

test('an uninterrupted crossfade still hands over exactly as before', async () => {
	const { cf, engines } = make()
	await cf.start()
	await cf.load('/m/a.flac')
	await cf.setVolume(80)
	await cf.setNext('/m/b.flac')

	const advanced = new Promise(r => cf.once('autoAdvanced', r))
	nudgeIntoFadeWindow(engines[0])

	assert.strictEqual(await advanced, '/m/b.flac')
	assert.strictEqual(cf.activeIdx, 1, 'the handover happens when nothing interrupts it')
	assert.strictEqual(cf._fading, false)
	assert.strictEqual(cf.getState().path, '/m/b.flac')
	assert.ok(engines[0].did('pause'), 'and the finished track is stopped')
})
