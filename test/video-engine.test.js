'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { VideoEngine } = require('../video-engine')

function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-vid-')), 'mpv.sock')
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
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

test('_args for 5.1 includes channels and ipc server, never video/spdif flags', () => {
  const eng = new VideoEngine({ config: { audioChannels: '5.1' } })
  const args = eng._args('/tmp/v.sock')
  assert.ok(args.includes('--audio-channels=5.1'))
  assert.ok(args.includes('--input-ipc-server=/tmp/v.sock'))
  assert.ok(!args.includes('--no-video'))
  assert.ok(!args.some(a => a.startsWith('--audio-spdif')))
})

test('_args for auto maps to auto-safe', () => {
  const eng = new VideoEngine({ config: { audioChannels: 'auto' } })
  assert.ok(eng._args('/tmp/v.sock').includes('--audio-channels=auto-safe'))
})

test('_args with wid appends --wid', () => {
  const eng = new VideoEngine({ config: {} })
  assert.ok(eng._args('/tmp/v.sock', { wid: '0x1a2b' }).includes('--wid=0x1a2b'))
})

test('_args without wid omits --wid', () => {
  const eng = new VideoEngine({ config: {} })
  assert.ok(!eng._args('/tmp/v.sock').some(a => a.startsWith('--wid=')))
})

test('exclusive config adds alsa device + exclusive flags', () => {
  const eng = new VideoEngine({ config: { outputMode: 'exclusive', alsaDevice: 'alsa/hw:2,0' } })
  const args = eng._args('/tmp/v.sock')
  assert.ok(args.includes('--audio-device=alsa/hw:2,0'))
  assert.ok(args.includes('--audio-exclusive=yes'))
})

test('_args always includes required mpv basics', () => {
  const eng = new VideoEngine({ config: {} })
  const args = eng._args('/tmp/v.sock')
  for (const flag of ['--no-terminal', '--idle=yes', '--cache=yes', '--demuxer-max-bytes=64MiB', '--ytdl=no']) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
})

test('start spawns mpv and connects the IPC client', async () => {
  const f = await fakeMpv()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  assert.strictEqual(eng.alive, true)
  eng.stop(); f.close()
})

test('load plays a video by path', async () => {
  const f = await fakeMpv()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.commands.length = 0
  await eng.load('/media/movie.mkv')
  assert.ok(f.commands.some(c => c[0] === 'loadfile' && c[1] === '/media/movie.mkv'))
  eng.stop(); f.close()
})

test('start with wid includes --wid in spawn args', async () => {
  const f = await fakeMpv()
  const spawned = []
  const eng = new VideoEngine({
    spawnFn: (bin, args) => { spawned.push(args); return f.proc },
    socketPath: f.sock,
  })
  await eng.start('/media/movie.mkv', { wid: '0x77' })
  assert.ok(spawned[0].includes('--wid=0x77'))
  eng.stop(); f.close()
})

test('engine exposes core public API and config', () => {
  const config = { outputMode: 'exclusive', alsaDevice: 'alsa/hw:2,0', audioChannels: '5.1' }
  const eng = new VideoEngine({ config })
  assert.ok(eng instanceof VideoEngine)
  assert.ok(Array.isArray(eng._args('/tmp/v.sock')))
  assert.strictEqual(eng.config.audioChannels, '5.1')
  assert.strictEqual(eng.config.alsaDevice, 'alsa/hw:2,0')
  assert.strictEqual(typeof eng.start, 'function')
  assert.strictEqual(typeof eng.stop, 'function')
  assert.strictEqual(typeof eng.load, 'function')
  assert.strictEqual(typeof eng.command, 'function')
})
