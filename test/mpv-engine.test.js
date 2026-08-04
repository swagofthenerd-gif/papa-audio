'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { MpvEngine } = require('../mpv-engine')

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

test('default config uses no device pinning and gapless weak', () => {
  const eng = new MpvEngine({})
  const args = eng._args('/tmp/x.sock')
  assert.ok(!args.some(a => a.startsWith('--audio-device')))
  assert.ok(args.includes('--gapless-audio=weak'))
  assert.ok(args.includes('--replaygain=no'))
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
