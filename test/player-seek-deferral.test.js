'use strict'
// Every restored session printed three of these:
//
//   player-seek did not answer within 60000ms
//
// as unhandled promise rejections. Session restore sets currentTime while mpv
// is still opening the file, the shim fired the seek anyway, the IPC deadline
// rejected it a minute later, and nobody was holding the promise.
//
// The real shim class is lifted and driven against a fake mpv timeline.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'player-shim.js'), 'utf8')
// Everything but the `window.__papaPlayer = new ...` line at the end.
const CLASS = SRC.slice(SRC.indexOf('const OPTIMISTIC_PAUSE_MS'), SRC.lastIndexOf('window.__papaPlayer'))

function makeShim({ seekFails } = {}) {
	const log = []
	let onPlayerEvent = null
	const api = {
		on(channel, fn) { if (channel === 'player-event') onPlayerEvent = fn },
		playerLoad(spec) { log.push('load:' + spec.path); return Promise.resolve({ ok: true }) },
		playerSeek(s) {
			log.push('seek:' + s)
			return seekFails
				? Promise.reject(new Error('player-seek did not answer within 60000ms'))
				: Promise.resolve({ ok: true })
		},
		playerSetVolume() {}, playerSetSpeed() {}, playerSetNext() { return Promise.resolve() },
	}
	const warned = []
	const env = { api, log, warned }
	const shim = new Function('env', `
		const { api, log, warned } = env
		const window = { api }
		const console = { warn(...a) { warned.push(a.join(' ')) }, error() {} }
		${CLASS}
		return new PapaPlayerShim()
	`)(env)
	return { shim, log, warned, emit: (type, data) => onPlayerEvent({ type, data }) }
}

test('a seek asked for while mpv is still opening the file is held, not fired', async () => {
	const { shim, log } = makeShim()
	shim.src = '/mnt/data/MUSIC/a.flac'
	shim.currentTime = 42
	await new Promise(r => setTimeout(r, 0))
	assert.ok(!log.some(l => l.startsWith('seek:')),
		'the seek must wait for mpv rather than time out against a file it has not opened: ' + JSON.stringify(log))
	assert.strictEqual(shim.currentTime, 42, 'the UI still shows where the person asked to be')
})

test('the held seek goes out once mpv says what it has open', async () => {
	const { shim, log, emit } = makeShim()
	shim.src = '/mnt/data/MUSIC/a.flac'
	shim.currentTime = 42
	await new Promise(r => setTimeout(r, 0))
	emit('trackChanged', '/mnt/data/MUSIC/a.flac')
	assert.ok(log.includes('seek:42'), JSON.stringify(log))
})

test('only the last position asked for is seeked to, not every one', async () => {
	const { shim, log, emit } = makeShim()
	shim.src = '/mnt/data/MUSIC/a.flac'
	shim.currentTime = 10
	shim.currentTime = 42
	shim.currentTime = 90
	await new Promise(r => setTimeout(r, 0))
	emit('trackChanged', '/mnt/data/MUSIC/a.flac')
	assert.deepStrictEqual(log.filter(l => l.startsWith('seek:')), ['seek:90'])
})

test('a seek on a track mpv already has open goes straight out, as it always did', async () => {
	const { shim, log, emit } = makeShim()
	shim.src = '/mnt/data/MUSIC/a.flac'
	await new Promise(r => setTimeout(r, 0))
	emit('trackChanged', '/mnt/data/MUSIC/a.flac')
	log.length = 0
	shim.currentTime = 120
	assert.deepStrictEqual(log, ['seek:120'])
})

test('a held seek is dropped when the album advances past its track', async () => {
	const { shim, log, emit } = makeShim()
	shim.src = '/mnt/data/MUSIC/a.flac'
	shim.currentTime = 42
	emit('autoAdvanced', '/mnt/data/MUSIC/b.flac')
	emit('trackChanged', '/mnt/data/MUSIC/b.flac')
	await new Promise(r => setTimeout(r, 0))
	assert.ok(!log.some(l => l === 'seek:42'),
		'42 seconds into the PREVIOUS track is not a position in this one: ' + JSON.stringify(log))
})

test('a seek that fails is reported once, and never as an unhandled rejection', async () => {
	const rejections = []
	const onRejection = r => rejections.push(String(r && r.message || r))
	process.on('unhandledRejection', onRejection)
	try {
		const { shim, warned, emit } = makeShim({ seekFails: true })
		shim.src = '/mnt/data/MUSIC/a.flac'
		await new Promise(r => setTimeout(r, 0))
		emit('trackChanged', '/mnt/data/MUSIC/a.flac')
		shim.currentTime = 1
		shim.currentTime = 2
		shim.currentTime = 3
		// Give the microtask queue and the rejection hook time to run.
		await new Promise(r => setTimeout(r, 20))
		assert.deepStrictEqual(rejections, [], 'nothing may reach unhandledRejection: ' + JSON.stringify(rejections))
		assert.strictEqual(warned.length, 1, 'said once, not once per seek: ' + JSON.stringify(warned))
		assert.ok(/did not land/.test(warned[0]), warned[0])
	} finally {
		process.off('unhandledRejection', onRejection)
	}
})
