'use strict'
// "when i select a song to play, it fucking pauses man" — the MOUSE path.
//
// Picking a local track runs playCurrentTrack's fast path:
//     audio.src = 'file://' + track.filePath   ->  ipc player-load {play:false}
//     audio.play()                             ->  ipc player-play
// Two independent ipcRenderer.invoke calls. Nothing in main orders them, and
// main's player-load handler awaits a real mpv round trip (applyLoudnessGain's
// volume set) BEFORE player.load sends its own `pause true` + `loadfile`. So the
// play overtakes the load. Traced on the live app, the order arriving at mpv's
// socket was:
//     ["set_property","volume",0]
//     ["set_property","pause",false]     <- the play, first
//     ["set_property","pause",true]      <- the load's own pre-load pause
//     ["loadfile","<the track>","replace"]
// mpv opened the chosen track while paused and stayed paused — currentTime 0,
// one position report, and 2.5 s later the reconcile timer put the button back
// to Play. The song was selected and never played.
//
// This exercises the real shim (src/player-shim.js), the real MpvEngine and the
// real MpvIpcClient over a real unix socket, with main.js's player-load /
// player-play handler shape reproduced exactly — including the awaited volume
// set that opens the window the play jumps through.
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const { MpvEngine } = require('../mpv-engine')

const SHIM_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'player-shim.js'), 'utf8')
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms))

// A real socket that answers like mpv and records what it was told, in order.
function fakeMpv() {
	const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-race-')), 'mpv.sock')
	const conns = []
	const commands = []
	const server = net.createServer(c => {
		conns.push(c)
		let buf = ''
		c.on('data', d => {
			buf += d
			let i
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1)
				if (!line.trim()) continue
				const msg = JSON.parse(line)
				commands.push(msg.command)
				c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n')
			}
		})
	})
	const proc = new EventEmitter()
	proc.stderr = new PassThrough()
	proc.kill = () => proc.emit('exit', 0)
	return new Promise(res => server.listen(sock, () => res({
		sock, proc, commands,
		spawnFn: () => proc,
		close: () => { conns.forEach(c => c.destroy()); server.close() },
	})))
}

// Replay the command stream the way mpv does: `pause` is a property, and a
// loadfile does not reset it, so the file plays or does not play according to
// whatever the last `set_property pause` said.
function mpvState(commands) {
	let paused = true             // mpv is spawned idle and paused
	let loaded = null
	for (const c of commands) {
		if (c[0] === 'set_property' && c[1] === 'pause') paused = !!c[2]
		if (c[0] === 'loadfile' && c[2] === 'replace') loaded = c[1]
	}
	return { loaded, paused }
}

const dump = commands => commands.map(c => JSON.stringify(c)).join('\n  ')

// main.js's player-load and player-play, in the shape that matters: player-load
// awaits applyLoudnessGain (a real mpv round trip) before it touches the engine.
// Both are invoked the way ipcMain invokes them — independently, unordered.
function mainHandlers(engine) {
	return {
		playerLoad: async ({ path: p, play }) => {
			// applyLoudnessGain(resolved) — awaited, and it really talks to mpv.
			await engine.setVolume(0).catch(() => {})
			try { await engine.load(p, { play }); return { ok: true } }
			catch (e) { return { ok: false, error: String(e.message || e) } }
		},
		playerPlay: async () => {
			try { await engine.play(); return { ok: true } }
			catch (e) { return { ok: false, error: String(e.message || e) } }
		},
		playerPause: async () => {
			try { await engine.pause(); return { ok: true } }
			catch (e) { return { ok: false, error: String(e.message || e) } }
		},
	}
}

// Load the real shim with a fake window, as test/player-shim-engine.test.js does.
function loadShim(handlers) {
	const window = {
		api: new Proxy({ on: () => {} }, {
			get: (t, k) => (k in t ? t[k]
				: (...args) => (handlers[k] ? handlers[k](...args) : Promise.resolve({ ok: true }))),
		}),
	}
	new Function('window', SHIM_SRC)(window)
	return window.__papaPlayer
}

// One wired-up rig: real socket, real engine, real shim. Always torn down, so a
// failing assertion cannot leave the runner hanging on an open server.
async function rig(body) {
	const f = await fakeMpv()
	const engine = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
	await engine.start()
	try {
		await body({ shim: loadShim(mainHandlers(engine)), commands: f.commands, engine })
	} finally {
		try { engine.stop() } catch (_) { /* already down */ }
		f.close()
	}
}

const TRACK = '/mnt/data/MUSIC/Love and Theft/01 - Tweedle Dee & Tweedle Dum.flac'
const SECOND = '/mnt/data/MUSIC/Love and Theft/02 - Mississippi.flac'

test('selecting a track leaves mpv playing it, not holding it paused', async () => {
	await rig(async ({ shim, commands }) => {
		commands.length = 0
		// Exactly what playCurrentTrack's local-file fast path does.
		shim.src = `file://${TRACK}`
		await shim.play()
		await settle()

		const s = mpvState(commands)
		assert.strictEqual(s.loaded, TRACK, 'the chosen track never reached mpv')
		assert.strictEqual(s.paused, false,
			'the selected song is sitting paused — the play overtook the load, so ' +
			'nothing comes out until play is pressed by hand:\n  ' + dump(commands))
	})
})

test('the unpause is sent only after the file is open', async () => {
	await rig(async ({ shim, commands }) => {
		commands.length = 0
		shim.src = `file://${TRACK}`
		await shim.play()
		await settle()

		const loadAt = commands.findIndex(c => c[0] === 'loadfile')
		const unpauseAt = commands.findIndex(c => c[0] === 'set_property' && c[1] === 'pause' && c[2] === false)
		assert.ok(loadAt >= 0, 'no loadfile was sent')
		assert.ok(unpauseAt >= 0, 'nothing ever unpaused mpv')
		assert.ok(unpauseAt > loadAt,
			`the unpause was sent before the file was open (unpause at ${unpauseAt}, ` +
			`loadfile at ${loadAt}):\n  ` + dump(commands))
	})
})

test('picking a second track while one is playing also ends up playing', async () => {
	// The same path with playCurrentTrack's leading `audio.pause()` in front of
	// it — the shape of clicking a song while another one is already going.
	await rig(async ({ shim, commands }) => {
		shim.src = `file://${TRACK}`
		await shim.play()
		await settle()

		commands.length = 0
		shim.pause()                   // `if (!audio.paused && !audio.ended) audio.pause()`
		shim.src = `file://${SECOND}`
		await shim.play()
		await settle()

		const s = mpvState(commands)
		assert.strictEqual(s.loaded, SECOND)
		assert.strictEqual(s.paused, false,
			'switching tracks left the new one paused:\n  ' + dump(commands))
	})
})
