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
  for (const flag of ['--no-terminal', '--idle=yes', '--cache=yes', '--ytdl=no']) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
})

// 64MiB is only a few seconds of a 1080p stream, so mpv drained its buffer and
// stalled even while the torrent was keeping up. These are buffer-size and
// transport options only — none of them touch the decode path, so the picture
// and sound are bit-for-bit what the source carries.
test('_args gives mpv a streaming-sized buffer', () => {
  const args = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  const bytes = args.find(a => a.startsWith('--demuxer-max-bytes='))
  assert.ok(bytes, 'a demuxer buffer size must be set')
  const mib = Number(/(\d+)MiB/.exec(bytes)[1])
  assert.ok(mib >= 128, `buffer too small for streaming: ${mib}MiB`)
  assert.ok(args.some(a => a.startsWith('--cache-secs=')))
  assert.ok(args.some(a => a.startsWith('--demuxer-readahead-secs=')))
  assert.ok(args.some(a => a.startsWith('--demuxer-max-back-bytes=')), 'back-buffer makes small seeks instant')
})

// The torrent server returns transient errors while a piece is in flight.
// Without reconnect mpv treats that as end-of-stream and stops.
test('_args tells mpv to ride through transient stream errors', () => {
  const args = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  const lavf = args.find(a => a.startsWith('--stream-lavf-o='))
  assert.ok(lavf, 'reconnect options must be set')
  assert.match(lavf, /reconnect=1/)
  assert.match(lavf, /reconnect_streamed=1/)
  assert.ok(args.some(a => a.startsWith('--network-timeout=')))
})

// Hardware decode offloads the CPU; it does not re-encode or rescale, and
// auto-safe falls back to software whenever the hardware path is not
// known-good for the codec.
test('_args enables hardware decoding without any quality-reducing flag', () => {
  const args = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  assert.ok(args.includes('--hwdec=auto-safe'))
  // These would visibly degrade the picture. None of them may ever appear.
  for (const bad of ['--profile=fast', '--profile=low-latency', '--vd-lavc-skiploopfilter=all', '--scale=bilinear', '--sws-scaler=fast-bilinear']) {
    assert.ok(!args.includes(bad), `${bad} trades quality for speed and must not be set`)
  }
  assert.ok(!args.some(a => a.startsWith('--vf=')), 'no video filter may be inserted')
  assert.ok(!args.some(a => a.startsWith('--af=')), 'no audio filter may be inserted')
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

test('start drains stderr so mpv cannot block on a full pipe', async () => {
  const f = await fakeMpv()
  let resumed = 0
  f.proc.stderr = { resume: () => { resumed++ } }
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  assert.strictEqual(resumed, 1)
  eng.stop(); f.close()
})

test('start kills the spawned mpv when the IPC connect fails', async () => {
  const f = await fakeMpv()
  let killed = false
  f.proc.kill = () => { killed = true; f.proc.emit('exit', 0) }
  const { MpvIpcClient } = require('../mpv-ipc')
  const originalConnect = MpvIpcClient.prototype.connect
  MpvIpcClient.prototype.connect = async () => {
    throw Object.assign(new Error('mpv socket never appeared'), { code: 'ENOENT' })
  }
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  try {
    await assert.rejects(eng.start(), /mpv socket never appeared/)
  } finally {
    MpvIpcClient.prototype.connect = originalConnect
  }
  assert.strictEqual(killed, true, 'spawned mpv killed on connect failure')
  assert.strictEqual(eng.proc, null)
  assert.strictEqual(eng.alive, false)
  f.close()
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

// ── Restart discipline ──────────────────────────────────────────────────────
// start() used to overwrite this.proc without killing the process it replaced,
// so every play stacked another mpv on top of the last one: several windows
// fighting for the audio device, and none of them reachable to stop.
test('a second start() kills the mpv it replaces', async () => {
  const a = await fakeMpv()
  const b = await fakeMpv()
  let killed = 0
  a.proc.kill = () => { killed++; a.proc.emit('exit', 0) }

  const spawned = [a, b]
  let n = 0
  const eng = new VideoEngine({ spawnFn: () => spawned[n++].proc, socketPath: a.sock })
  await eng.start()
  assert.strictEqual(killed, 0, 'nothing to kill on the first start')

  // Point the engine at the second fake socket for the restart.
  eng._fixedSocketPath = b.sock
  await eng.start()
  assert.strictEqual(killed, 1, 'the previous mpv must be killed before respawning')
  assert.strictEqual(eng.alive, true)

  eng.stop()
  a.close(); b.close()
})

test('the generation guard still rejects commands issued against a replaced mpv', async () => {
  const a = await fakeMpv()
  const eng = new VideoEngine({ spawnFn: () => a.proc, socketPath: a.sock })
  await eng.start()
  const stale = eng._guard('load')
  eng._gen++
  await assert.rejects(() => stale('loadfile', 'x'), /ENGINE_GONE|went away/)
  eng.stop()
  a.close()
})
