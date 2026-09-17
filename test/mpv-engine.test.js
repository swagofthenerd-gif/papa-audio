'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { MpvEngine, channelsValue } = require('../mpv-engine')

// Fake mpv: a mock IPC server + a fake child process handle.
function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-eng-')), 'mpv.sock')
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
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, commands,
    spawnFn: () => proc,
    push: msg => conns.forEach(c => c.write(JSON.stringify(msg) + '\n')),
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

test('start observes core properties and emits ready', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const observed = f.commands.filter(c => c[0] === 'observe_property').map(c => c[2])
  for (const p of ['time-pos', 'duration', 'pause', 'path', 'audio-params', 'volume']) {
    assert.ok(observed.includes(p), `missing observer for ${p}`)
  }
  eng.stop(); f.close()
})

test('load without play pauses first, then loads', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.commands.length = 0
  await eng.load('/music/a.flac', { play: false })
  assert.deepStrictEqual(f.commands[0], ['set_property', 'pause', true])
  assert.deepStrictEqual(f.commands[1], ['loadfile', '/music/a.flac', 'replace'])
  eng.stop(); f.close()
})

test('setNext clears playlist tail and appends', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.commands.length = 0
  await eng.setNext('/music/b.flac')
  assert.deepStrictEqual(f.commands[0], ['playlist-clear'])
  assert.deepStrictEqual(f.commands[1], ['loadfile', '/music/b.flac', 'append'])
  eng.stop(); f.close()
})

test('property changes update state and emit mapped events', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const dur = new Promise(r => eng.once('duration', r))
  f.push({ event: 'property-change', name: 'duration', data: 213.4 })
  assert.strictEqual(await dur, 213.4)
  assert.strictEqual(eng.getState().duration, 213.4)
  const paused = new Promise(r => eng.once('paused', r))
  f.push({ event: 'property-change', name: 'pause', data: false })
  assert.strictEqual(await paused, false)
  eng.stop(); f.close()
})

test('path change to the prefetched next emits autoAdvanced', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  await eng.load('/music/a.flac')
  await eng.setNext('/music/b.flac')
  const adv = new Promise(r => eng.once('autoAdvanced', r))
  f.push({ event: 'property-change', name: 'path', data: '/music/b.flac' })
  assert.strictEqual(await adv, '/music/b.flac')
  eng.stop(); f.close()
})

test('end-file eof with no following start-file emits ended', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const ended = new Promise(r => eng.once('ended', r))
  f.push({ event: 'end-file', reason: 'eof' })
  await ended
  eng.stop(); f.close()
})

test('end-file eof followed by start-file does NOT emit ended', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  let endedFired = false
  eng.on('ended', () => { endedFired = true })
  f.push({ event: 'end-file', reason: 'eof' })
  f.push({ event: 'start-file' })
  await new Promise(r => setTimeout(r, 300))
  assert.strictEqual(endedFired, false)
  eng.stop(); f.close()
})

test('unexpected exit emits engineDown; intentional stop does not', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  let down = false
  eng.on('engineDown', () => { down = true })
  eng.stop()
  await new Promise(r => setTimeout(r, 50))
  assert.strictEqual(down, false)

  const f2 = await fakeMpv()
  const eng2 = new MpvEngine({ spawnFn: f2.spawnFn, socketPath: f2.sock })
  await eng2.start()
  const downP = new Promise(r => eng2.once('engineDown', r))
  f2.proc.emit('exit', 1)
  await downP
  eng2.stop(); f.close(); f2.close()
})

test('exclusive config adds alsa device + exclusive flags', () => {
  const eng = new MpvEngine({ config: { outputMode: 'exclusive', alsaDevice: 'alsa/hw:1,0' } })
  const args = eng._args('/tmp/x.sock')
  assert.ok(args.includes('--audio-device=alsa/hw:1,0'))
  assert.ok(args.includes('--audio-exclusive=yes'))
})

test('default config pins no device and asks for real gapless', () => {
  const eng = new MpvEngine({})
  const args = eng._args('/tmp/x.sock')
  assert.ok(!args.some(a => a.startsWith('--audio-device')))
  // Was 'weak', which stays gapless only when the next file's format matches
  // exactly — so a 44.1kHz track after a 48kHz one gapped.
  assert.ok(args.includes('--gapless-audio=yes'))
  // And without prefetch mpv opens the next file only once the current one
  // ends, which gaps regardless of the setting above.
  assert.ok(args.includes('--prefetch-playlist=yes'))
  assert.ok(args.includes('--replaygain=no'))
})

test('gapless off means gapless off', () => {
  const args = new MpvEngine({ config: { gapless: false } })._args('/tmp/x.sock')
  assert.ok(args.includes('--gapless-audio=no'))
})

// ── Bit-perfect output (roadmap #65) ──────────────────────────────────────────
test('bit-perfect caps volume-max at 100 and opens the device exclusively', () => {
  const args = new MpvEngine({ config: { bitPerfect: true } })._args('/tmp/x.sock')
  assert.ok(args.includes('--volume-max=100'), 'no software gain above unity')
  assert.ok(!args.includes('--volume-max=130'), 'the 130% headroom is dropped')
  assert.ok(args.includes('--audio-exclusive=yes'), 'exclusive even without a hand-picked device')
})

test('bit-perfect adds no --af filter chain (eq resolved to null upstream)', () => {
  const args = new MpvEngine({ config: { bitPerfect: true, eq: null } })._args('/tmp/x.sock')
  assert.ok(!args.some(a => a.startsWith('--af=')), 'the samples reach the DAC untouched')
})

test('bit-perfect off keeps the normal 130 ceiling and no exclusive flag', () => {
  const args = new MpvEngine({ config: { bitPerfect: false } })._args('/tmp/x.sock')
  assert.ok(args.includes('--volume-max=130'))
  assert.ok(!args.includes('--audio-exclusive=yes'))
})

// mpv rejects seeks between start-file and playback-restart, so the engine
// must defer them until the file is seekable.
test('seek after load is deferred until playback-restart', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  await eng.load('/music/a.flac')
  f.commands.length = 0
  let resolved = false
  const seekP = eng.seek(42).then(() => { resolved = true })
  await new Promise(r => setTimeout(r, 50))
  assert.ok(!f.commands.some(c => c[0] === 'seek'), 'seek sent before playback-restart')
  assert.strictEqual(resolved, false)
  f.push({ event: 'playback-restart' })
  await seekP
  assert.deepStrictEqual(f.commands.find(c => c[0] === 'seek'), ['seek', 42, 'absolute'])
  eng.stop(); f.close()
})

test('seek while playing sends immediately; deferred seeks coalesce to latest', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  await eng.load('/music/a.flac')
  f.push({ event: 'playback-restart' })
  await new Promise(r => setTimeout(r, 50))
  f.commands.length = 0
  await eng.seek(10)
  assert.deepStrictEqual(f.commands[0], ['seek', 10, 'absolute'])

  await eng.load('/music/b.flac')
  f.commands.length = 0
  const s1 = eng.seek(5)
  const s2 = eng.seek(7)
  f.push({ event: 'playback-restart' })
  await Promise.all([s1, s2])
  const seeks = f.commands.filter(c => c[0] === 'seek')
  assert.deepStrictEqual(seeks, [['seek', 7, 'absolute']], 'only latest deferred seek sent')
  eng.stop(); f.close()
})

test('audioChannels config maps to --audio-channels arg', () => {
  const eng = new MpvEngine({ config: { audioChannels: '5.1' } })
  assert.ok(eng._args('/tmp/x.sock').includes('--audio-channels=5.1'))
})

test('channelsValue is a pure helper: auto -> auto-safe, others pass through', () => {
  assert.strictEqual(channelsValue('auto'), 'auto-safe')
  assert.strictEqual(channelsValue('5.1'), '5.1')
  assert.strictEqual(channelsValue('stereo'), 'stereo')
})

test('default channels is auto-safe and volume ceiling is 130', () => {
  const args = new MpvEngine({})._args('/tmp/x.sock')
  assert.ok(args.includes('--audio-channels=auto-safe'))
  assert.ok(args.includes('--volume-max=130'))
})

test('setChannels sets property live and persists in config for restarts', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.commands.length = 0
  await eng.setChannels('7.1')
  assert.deepStrictEqual(f.commands[0], ['set_property', 'audio-channels', '7.1'])
  assert.strictEqual(eng.config.audioChannels, '7.1')
  await eng.setChannels('auto')
  assert.deepStrictEqual(f.commands[1], ['set_property', 'audio-channels', 'auto-safe'])
  eng.stop(); f.close()
})

test('args enable audio-only ytdl format for URL streaming', () => {
  const args = new MpvEngine({})._args('/tmp/x.sock')
  assert.ok(args.includes('--ytdl-format=bestaudio'))
})

test('constructor handles invalid socket path without throwing', () => {
  const eng = new MpvEngine({ socketPath: '/nonexistent/path/mpv.sock' })
  assert.ok(eng instanceof MpvEngine)
  assert.ok(eng.getState())
  assert.strictEqual(typeof eng.start, 'function')
  assert.strictEqual(typeof eng.stop, 'function')
  assert.strictEqual(typeof eng.load, 'function')
  assert.strictEqual(typeof eng.seek, 'function')
  assert.strictEqual(typeof eng.setNext, 'function')
  assert.strictEqual(typeof eng.setChannels, 'function')
})

test('engine exposes core public API and config', () => {
  const config = { outputMode: 'exclusive', alsaDevice: 'alsa/hw:2,0', audioChannels: 'stereo' }
  const eng = new MpvEngine({ config })
  assert.ok(eng.getState())
  assert.strictEqual(eng.config.outputMode, 'exclusive')
  assert.strictEqual(eng.config.alsaDevice, 'alsa/hw:2,0')
  assert.strictEqual(eng.config.audioChannels, 'stereo')
  assert.ok(Array.isArray(eng._args('/tmp/x.sock')))
  assert.ok(eng instanceof MpvEngine)
})

test('setEq pushes an af property to the running process', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const gains = new Array(10).fill(0)
  gains[0] = 6
  await eng.setEq({ enabled: true, preamp: -3, gains })
  const set = f.commands.filter(c => c[0] === 'set_property' && c[1] === 'af')
  assert.strictEqual(set.length, 1)
  assert.strictEqual(set[0][2], 'lavfi=[volume=volume=-3dB,equalizer=f=31:t=q:w=1:g=6]')
  eng.stop(); f.close()
})

test('disabling the EQ clears the af chain rather than flattening it', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  await eng.setEq({ enabled: false, preamp: 0, gains: new Array(10).fill(6) })
  const set = f.commands.filter(c => c[0] === 'set_property' && c[1] === 'af')
  assert.strictEqual(set[0][2], '')
  eng.stop(); f.close()
})

test('EQ config is passed as --af so it survives a respawn', async () => {
  const f = await fakeMpv()
  const spawned = []
  const gains = new Array(10).fill(0)
  gains[9] = -5
  const eng = new MpvEngine({
    spawnFn: (bin, args) => { spawned.push(args); return f.proc },
    socketPath: f.sock,
    config: { eq: { enabled: true, preamp: 0, gains } },
  })
  await eng.start()
  const af = spawned[0].find(a => a.startsWith('--af='))
  assert.strictEqual(af, '--af=lavfi=[equalizer=f=16000:t=q:w=1:g=-5]')
  eng.stop(); f.close()
})

test('a flat EQ adds no --af argument at all', async () => {
  const f = await fakeMpv()
  const spawned = []
  const eng = new MpvEngine({
    spawnFn: (bin, args) => { spawned.push(args); return f.proc },
    socketPath: f.sock,
  })
  await eng.start()
  assert.ok(!spawned[0].some(a => a.startsWith('--af=')))
  eng.stop(); f.close()
})

test('isActuallyPlaying is true while loaded and unpaused', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  f.push({ event: 'property-change', name: 'pause', data: false })
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(eng.isActuallyPlaying(), true)
  eng.stop(); f.close()
})

test('isActuallyPlaying is false once idle after a track ends, even though pause never fired', async () => {
  // This is the exact bug isActuallyPlaying exists to fix: state.paused only
  // updates from mpv's pause observer, which never fires again once mpv goes
  // idle after end-of-file. paused stays false forever, but the track is
  // over -- isActuallyPlaying must say so via _eofState, not via paused.
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  f.push({ event: 'property-change', name: 'pause', data: false })
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(eng.isActuallyPlaying(), true, 'sanity: playing before eof')
  const ended = new Promise(r => eng.once('ended', r))
  f.push({ event: 'end-file', reason: 'eof' })
  await ended
  assert.strictEqual(eng.getState().paused, false, 'sanity: paused never flips')
  assert.strictEqual(eng.isActuallyPlaying(), false, 'idle after eof must not read as playing')
  eng.stop(); f.close()
})

test('isActuallyPlaying is false with no path loaded', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  assert.strictEqual(eng.isActuallyPlaying(), false)
  eng.stop(); f.close()
})

// B5: a dying mpv's exit event tore down the mpv that replaced it.
//
// stop() SIGTERMs the old process but never removes its listeners, and the
// start() that follows clears _stopping in the same tick. Node delivers the old
// process's 'exit' later -- a real mpv takes far longer than a tick to close
// its files and go -- and _onExit() only asked "am I stopping?" and "am I
// alive?", both of which by then describe the REPLACEMENT. The same object is
// restarted in place on the respawn path inside _onExit, so the engine's own
// crash recovery was exposed to it too.
function fakeMpvPerSpawn() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-eng-gen-')), 'mpv.sock')
  const conns = []
  const commands = []
  const procs = []
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
  const spawnFn = () => {
    const proc = new EventEmitter()
    proc.killed = false
    // SIGTERM is a request, not an execution. The delay IS the bug's window.
    proc.kill = () => { proc.killed = true; setTimeout(() => proc.emit('exit', 0), 5) }
    procs.push(proc)
    return proc
  }
  return new Promise(res => server.listen(sock, () => res({
    sock, commands, procs, spawnFn,
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

const settle = () => new Promise(r => setTimeout(r, 60))

test('a dying mpv does not tear down the mpv that replaced it', async () => {
  const f = await fakeMpvPerSpawn()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const first = f.procs[0]
  eng.stop()
  await eng.start()
  assert.strictEqual(f.procs.length, 2)
  assert.strictEqual(eng.alive, true)

  const down = []
  eng.on('engineDown', d => down.push(d))
  // The first process finally goes, and its socket finishes closing.
  await settle()

  assert.strictEqual(eng.alive, true, 'the replacement is still alive')
  assert.deepStrictEqual(down, [], 'and nothing was told the engine went down')
  f.commands.length = 0
  await eng.load('/music/a.flac')
  assert.ok(f.commands.some(c => c[0] === 'loadfile' && c[1] === '/music/a.flac'),
    'the replacement still reaches mpv')
  eng.stop(); f.close()
})

test('the corpse of a crashed mpv does not kill the respawn that replaced it', async () => {
  const f = await fakeMpvPerSpawn()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const first = f.procs[0]
  const down = []
  eng.on('engineDown', d => down.push(d))

  first.emit('exit', 1)          // mpv crashes; _onExit respawns in place
  await settle()
  assert.strictEqual(f.procs.length, 2, 'the engine respawned')
  assert.strictEqual(eng.alive, true, 'and the respawn is up')
  assert.strictEqual(down.length, 1, 'one engineDown for the one crash')

  // A dead process can still emit after its exit -- a broken stdio pipe, say.
  first.emit('error', new Error('EPIPE from a process that is already gone'))
  await settle()
  assert.strictEqual(eng.alive, true, 'the respawn survives the corpse')
  assert.strictEqual(down.length, 1, 'and no second engineDown was invented')
  eng.stop(); f.close()
})

test('the CURRENT mpv dying is still reported as the engine going down', async () => {
  const f = await fakeMpvPerSpawn()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  eng.stop()
  await eng.start()
  await settle()
  const down = []
  eng.on('engineDown', d => down.push(d))
  f.procs[1].emit('exit', 1)     // the live process crashes on its own
  await settle()
  assert.strictEqual(down.length, 1, 'the crash is reported exactly once')
  eng.stop(); f.close()
})
