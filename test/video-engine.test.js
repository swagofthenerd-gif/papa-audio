'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const {
  VideoEngine,
  OBSERVED_PROPS,
  normalizeTrack,
  normalizeChapter,
  emptyState,
} = require('../video-engine')

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

// Embedding without pinning the GPU context is the "blank black window" bug:
// under XWayland mpv otherwise chooses a context that draws nothing into a
// foreign window, starts cleanly, reports no error and exits 0. Verified by
// capturing the embedded window's pixels — default gpu gave one unique colour,
// x11egl gave 26297.
test('_args with wid pins the GPU context so the surface actually renders', () => {
  const eng = new VideoEngine({ config: {} })
  const a = eng._args('/tmp/v.sock', { wid: '0x1a2b' })
  assert.ok(a.includes('--gpu-context=x11egl'))
})

test('_args without wid leaves the GPU context alone', () => {
  const eng = new VideoEngine({ config: {} })
  assert.ok(!eng._args('/tmp/v.sock').some(a => a.startsWith('--gpu-context=')))
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

// ── Observation + control verbs ──────────────────────────────────────────────
// A richer fake: answers get_property from a configured map and can push
// property-change events back to the engine, so the state machine and the verb
// translation are tested against a real socket the way mpv actually behaves.

function fakeMpv2({ props = {} } = {}) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-vid2-')), 'mpv.sock')
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
        let data = null
        if (msg.command[0] === 'get_property' && msg.command[1] in props) data = props[msg.command[1]]
        c.write(JSON.stringify({ error: 'success', data, request_id: msg.request_id }) + '\n')
      }
    })
  })
  const proc = new EventEmitter()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, commands,
    spawnFn: () => proc,
    pushProp(name, data) {
      for (const c of conns) c.write(JSON.stringify({ event: 'property-change', name, data }) + '\n')
    },
    close() { conns.forEach(c => c.destroy()); server.close() },
  })))
}

function waitForState(eng) {
  return new Promise(resolve => eng.once('state', resolve))
}

test('start observes every property the state payload needs', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const observed = f.commands.filter(c => c[0] === 'observe_property').map(c => c[2])
  for (const prop of OBSERVED_PROPS) assert.ok(observed.includes(prop), `must observe ${prop}`)
  eng.stop(); f.close()
})

test('property-change builds the §4.2 state and emits it throttled', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock, stateThrottleMs: 5 })
  await eng.start()
  const statePromise = waitForState(eng)
  f.pushProp('time-pos', 42.5)
  f.pushProp('duration', 3600)
  f.pushProp('pause', false)
  f.pushProp('volume', 80)
  f.pushProp('mute', false)
  f.pushProp('speed', 1.25)
  // Seconds ahead of the playhead, which is what the bar needs. The property
  // this used to push, demuxer-cache-time, is an absolute timestamp.
  f.pushProp('demuxer-cache-duration', 30)
  f.pushProp('video-params', { dw: 1920, dh: 1080, w: 1920, h: 1080 })
  f.pushProp('video-codec', 'h264')
  f.pushProp('audio-params', { 'channel-count': 6, channels: '6', samplerate: 48000 })
  f.pushProp('audio-codec-name', 'aac')
  f.pushProp('sid', 2)
  f.pushProp('aid', 1)
  f.pushProp('chapter-list', [{ title: 'Opening', time: 0 }, { title: 'Part 1', time: 120 }])
  const state = await statePromise
  assert.strictEqual(state.position, 42.5)
  assert.strictEqual(state.duration, 3600)
  assert.strictEqual(state.paused, false)
  assert.strictEqual(state.volume, 80)
  assert.strictEqual(state.muted, false)
  assert.strictEqual(state.speed, 1.25)
  assert.strictEqual(state.buffered, 30)
  assert.strictEqual(state.eof, false)
  assert.deepStrictEqual(state.video, { width: 1920, height: 1080, codec: 'h264' })
  assert.deepStrictEqual(state.audio, { layout: '5.1', channels: 6, codec: 'aac' })
  assert.deepStrictEqual(state.tracks, { sub: 2, audio: 1 })
  assert.deepStrictEqual(state.chapters, [
    { index: 0, title: 'Opening', start: 0 },
    { index: 1, title: 'Part 1', start: 120 },
  ])
  eng.stop(); f.close()
})

test('a deselected sub track reports null, not false or "no"', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock, stateThrottleMs: 5 })
  await eng.start()
  const p = waitForState(eng)
  f.pushProp('sid', false)
  f.pushProp('aid', 3)
  const state = await p
  assert.deepStrictEqual(state.tracks, { sub: null, audio: 3 })
  eng.stop(); f.close()
})

test('eof-reached maps to the eof flag', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock, stateThrottleMs: 5 })
  await eng.start()
  const p = waitForState(eng)
  f.pushProp('eof-reached', true)
  const state = await p
  assert.strictEqual(state.eof, true)
  eng.stop(); f.close()
})

test('getState returns a copy the caller cannot mutate into the engine', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const s = eng.getState()
  s.position = 9999
  s.video.width = 1
  s.tracks.sub = 7
  s.chapters.push({ index: 99, title: 'x', start: 1 })
  assert.strictEqual(eng.state.position, 0)
  assert.strictEqual(eng.state.video.width, null)
  assert.strictEqual(eng.state.tracks.sub, null)
  assert.strictEqual(eng.state.chapters.length, 0)
  eng.stop(); f.close()
})

test('getTracks normalizes the mpv track-list', async () => {
  const list = [
    { id: 1, type: 'video', codec: 'h264' },
    { id: 2, type: 'audio', title: '5.1', lang: 'eng', codec: 'ac3', default: true, forced: false, external: false },
    { id: 3, type: 'sub', title: 'English', lang: 'eng', codec: 'ass', default: false, forced: false, external: true },
  ]
  const f = await fakeMpv2({ props: { 'track-list': list } })
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const tracks = await eng.getTracks()
  assert.strictEqual(tracks.length, 2)
  assert.deepStrictEqual(tracks[0], { id: 2, type: 'audio', title: '5.1', lang: 'eng', codec: 'ac3', default: true, forced: false, external: false })
  assert.deepStrictEqual(tracks[1], { id: 3, type: 'sub', title: 'English', lang: 'eng', codec: 'ass', default: false, forced: false, external: true })
  eng.stop(); f.close()
})

test('getChapters normalizes the mpv chapter-list', async () => {
  const f = await fakeMpv2({ props: { 'chapter-list': [{ title: 'A', time: 10 }, { title: '', time: 25 }] } })
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  const chapters = await eng.getChapters()
  assert.deepStrictEqual(chapters, [
    { index: 0, title: 'A', start: 10 },
    { index: 1, title: '', start: 25 },
  ])
  eng.stop(); f.close()
})

test('control verbs translate to the right mpv commands', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.commands.length = 0

  await eng.seek(30, 'absolute')
  await eng.setPause(true)
  await eng.setVolume(70)
  await eng.setMute(true)
  await eng.setSpeed(1.5)
  await eng.setTrack('sub', 2)
  await eng.setTrack('audio', null)
  await eng.addSubtitle('/tmp/sub.srt')
  await eng.setSubDelay(-500)
  await eng.setAudioDelay(250)
  await eng.setSubStyle({ scale: 1.2, pos: 90 })
  await eng.setAspect('16:9')
  await eng.setZoom(0.5)
  await eng.setAudioFilter('dynaudnorm')
  await eng.screenshot('/tmp/shot.png')
  await eng.frameStep(1)
  await eng.frameStep(-1)

  const cmds = f.commands.map(c => c.join(' '))
  assert.ok(cmds.includes('seek 30 absolute'))
  assert.ok(cmds.includes('set_property pause true'))
  assert.ok(cmds.includes('set_property volume 70'))
  assert.ok(cmds.includes('set_property mute true'))
  assert.ok(cmds.includes('set_property speed 1.5'))
  assert.ok(cmds.includes('set_property sid 2'))
  assert.ok(cmds.includes('set_property aid no'), 'a null track id must disable, not crash')
  assert.ok(cmds.includes('sub-add /tmp/sub.srt select'))
  assert.ok(cmds.includes('set_property sub-delay -0.5'), 'sub delay is in seconds, not ms')
  assert.ok(cmds.includes('set_property audio-delay 0.25'))
  assert.ok(cmds.includes('set_property sub-scale 1.2'))
  assert.ok(cmds.includes('set_property sub-pos 90'))
  assert.ok(cmds.includes('set_property video-aspect-override 16:9'))
  assert.ok(cmds.includes('set_property video-zoom 0.5'))
  assert.ok(cmds.includes('set_property af dynaudnorm'))
  assert.ok(cmds.includes('screenshot-to-file /tmp/shot.png video'))
  assert.ok(cmds.includes('frame-step'))
  assert.ok(cmds.includes('frame-back-step'))
  eng.stop(); f.close()
})

test('subStyle ignores keys it does not know', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  f.commands.length = 0
  await eng.setSubStyle({ scale: 2, malicious: 'sub-delay' })
  assert.strictEqual(f.commands.length, 1)
  assert.deepStrictEqual(f.commands[0], ['set_property', 'sub-scale', 2])
  eng.stop(); f.close()
})

test('setTrack rejects an unknown track type', async () => {
  const f = await fakeMpv2()
  const eng = new VideoEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  await assert.rejects(() => eng.setTrack('video', 1), /unknown track type/)
  eng.stop(); f.close()
})

test('verbs reject with EngineGone before the engine has started', async () => {
  const eng = new VideoEngine({})
  await assert.rejects(() => eng.seek(10), /ENGINE_GONE|went away/)
  await assert.rejects(() => eng.setPause(true), /ENGINE_GONE|went away/)
  await assert.rejects(() => eng.getTracks(), /ENGINE_GONE|went away/)
})

test('normalizeTrack returns null for video and junk entries', () => {
  assert.strictEqual(normalizeTrack({ id: 1, type: 'video' }, 0), null)
  assert.strictEqual(normalizeTrack(null, 0), null)
  assert.strictEqual(normalizeTrack({ id: 2, type: 'sub', default: true }, 3).id, 2)
})

test('normalizeChapter returns null for entries without a time', () => {
  assert.strictEqual(normalizeChapter(null, 0), null)
  assert.strictEqual(normalizeChapter({ title: 'x' }, 0), null)
  assert.deepStrictEqual(normalizeChapter({ title: 'x', time: 5 }, 2), { index: 2, title: 'x', start: 5 })
})

test('emptyState has the full §4.2 shape with safe defaults', () => {
  const s = emptyState()
  assert.deepStrictEqual(s, {
    position: 0, duration: 0, paused: true, volume: 0, muted: false, speed: 1,
    // buffered is seconds ahead of the playhead; seekable is where playback can
    // actually jump to, which on a torrent is a very different answer.
    buffered: 0, seekable: [], eof: false,
    video: { width: null, height: null, codec: null },
    audio: { layout: 'unknown', channels: 0, codec: null },
    tracks: { sub: null, audio: null },
    chapters: [],
  })
})

// mpv's built-in keybindings are active on its own window by default. With
// the video focused, 's' took an mpv screenshot instead of skipping the
// intro, 'f' fullscreened the video out from under the deck, and 'q' quit
// the player outright. Every control is driven over IPC, so mpv needs no
// keyboard of its own.
// The video plays in its own window, so it needs its own controls: the app's
// deck is in a different window and unreachable while the video has focus.
// Stripping mpv's on-screen controller left a bare picture with no way to
// pause, seek or change volume at all.
test('_args keeps mpv\u2019s own transport controls', () => {
  const args = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  assert.ok(args.includes('--osc=yes'), 'the video window needs a transport')
  assert.ok(!args.includes('--input-default-bindings=no'), 'mpv keeps its keyboard')
  assert.ok(!args.includes('--input-vo-keyboard=no'))
  assert.ok(!args.includes('--no-osc'))
})

// Without this, mpv writes mpv-shot0001.jpg into the process working
// directory — which is the application folder.
test('_args points mpv screenshots away from the working directory', () => {
  const args = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  const dir = args.find(a => a.startsWith('--screenshot-directory='))
  assert.ok(dir, 'a screenshot directory must be set')
  const value = dir.split('=')[1]
  assert.ok(value && value !== '.' && value !== process.cwd(),
    'screenshots must not land in the application folder')
})

test('screenshotDir resolves without Electron present', () => {
  const { screenshotDir } = require('../video-engine')
  const dir = screenshotDir()
  assert.ok(typeof dir === 'string' && dir.length > 0)
  assert.ok(dir !== process.cwd())
})


// The app's actions have to work while the video window has focus, because the
// deck is in another window and never sees those keypresses. Binding them over
// IPC after connect left pending commands that outlived the socket and held
// the event loop open; a config file is applied by mpv at startup instead.
test('app actions are bound through an input.conf, not post-connect IPC', () => {
  const { inputConfBody, APP_KEYS } = require('../video-engine')
  const body = inputConfBody()
  assert.match(body, /^s script-message papa skip$/m)
  assert.match(body, /^n script-message papa next$/m)
  assert.strictEqual(APP_KEYS.length, 3)
  const args = new VideoEngine({ config: {}, inputConf: '/tmp/papa-input.conf' })._args('/tmp/v.sock')
  assert.ok(args.includes('--input-conf=/tmp/papa-input.conf'))
})

// Only the listed keys are overridden; every other mpv default still applies,
// which is what keeps the window's native transport intact.
test('the input.conf claims only the keys the app owns', () => {
  const { inputConfBody } = require('../video-engine')
  const lines = inputConfBody().trim().split('\n')
  assert.ok(lines.every(l => /^\S+ script-message papa \w+$/.test(l)), 'no line may rebind anything else')
  assert.ok(!inputConfBody().includes('f '), 'fullscreen stays mpv\u2019s own')
  assert.ok(!inputConfBody().includes('space'), 'play/pause stays mpv\u2019s own')
})

test('a video engine still builds when the input.conf cannot be written', () => {
  const args = new VideoEngine({ config: {}, inputConf: null })._args('/tmp/v.sock')
  assert.ok(!args.some(a => a.startsWith('--input-conf=')), 'a missing conf must not produce a broken flag')
  assert.ok(args.includes('--osc=yes'), 'and playback still has controls')
})

// Embedded, the app's deck sits directly beneath the picture and is fully
// reachable, so mpv's own controller is a second transport stacked on the
// first — its seek bar, filename and cache readout drawn over the bottom of
// the video, immediately above ours. In its own window the deck is in another
// window entirely and mpv needs controls of its own.
test('mpv draws no controls of its own when embedded', () => {
  const a = new VideoEngine({ config: {} })._args('/tmp/v.sock', { wid: '0x1' })
  assert.ok(a.includes('--osc=no'))
  assert.ok(!a.includes('--osc=yes'))
})

test('mpv keeps its controls when it owns the window', () => {
  const a = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  assert.ok(a.includes('--osc=yes'))
  assert.ok(a.includes('--osd-bar=yes'))
})

// Double-click is the universal fullscreen gesture, and the click lands on mpv
// rather than on the page, so the app never sees it. mpv's own default —
// cycle fullscreen — would expand the embedded surface alone, burying the
// deck, the skip offer and the episode list with no way to reach any of them.
test('double-click is relayed to the app when embedded', () => {
  const { inputConfBody } = require('../video-engine.js')
  const body = inputConfBody(true)
  assert.match(body, /MBTN_LEFT_DBL script-message papa fullscreen/)
})

test('double-click is left to mpv when it owns the window', () => {
  const { inputConfBody } = require('../video-engine.js')
  assert.ok(!/MBTN_LEFT_DBL/.test(inputConfBody(false)),
    'in its own window mpv fullscreening itself is the correct behaviour')
})

test('the embedded and windowed configs are separate files', () => {
  const a = new VideoEngine({ config: {} })._args('/tmp/v.sock', { wid: '0x1' })
  const b = new VideoEngine({ config: {} })._args('/tmp/v.sock')
  const conf = args => (args.find(x => x.startsWith('--input-conf=')) || '')
  assert.notStrictEqual(conf(a), conf(b), 'one file cannot carry both bindings')
  assert.match(conf(a), /embedded/)
})

// ── Orphaned players ───────────────────────────────────────────────────────
// mpv does not die with the app. If Papa Audio is killed rather than closed,
// its mpv keeps running, keeps playing and keeps an audio device. The next
// launch spawns its own, so the user hears one process while the deck drives
// another: audio with no picture and controls that appear to do nothing.
// Seen exactly that way, an orphan from a long-dead instance playing beside a
// live one.
const _fs = require('fs')
const _os = require('os')
const _path = require('path')
const { orphanPlayerSockets, purgeOrphanPlayers } = require('../video-engine.js')

function socketDir(names) {
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'papa-orphan-test-'))
  for (const n of names) _fs.writeFileSync(_path.join(dir, n), '')
  return dir
}

test('a socket whose owning process is gone is an orphan', () => {
  const dir = socketDir(['papa-video-999999-aabbccdd.sock'])
  assert.deepStrictEqual(
    orphanPlayerSockets(dir).map(f => _path.basename(f)),
    ['papa-video-999999-aabbccdd.sock'])
  _fs.rmSync(dir, { recursive: true, force: true })
})

// Killing a running instance's player would stop the video the user is
// actually watching, which is far worse than leaving an orphan behind.
test('a socket owned by a live process is left alone', () => {
  const dir = socketDir([`papa-video-${process.pid}-aabbccdd.sock`])
  assert.deepStrictEqual(orphanPlayerSockets(dir), [])
  _fs.rmSync(dir, { recursive: true, force: true })
})

test('unrelated sockets are never touched', () => {
  const dir = socketDir(['papa-mpv-999999-aabbccdd.sock', 'something.sock', 'papa-video-notapid-x.sock'])
  assert.deepStrictEqual(orphanPlayerSockets(dir), [])
  _fs.rmSync(dir, { recursive: true, force: true })
})

// A socket file left behind by a player that already died has nothing to quit;
// it should be cleared rather than waited on.
test('a stale socket is removed without hanging', async () => {
  const dir = socketDir(['papa-video-999998-deadbeef.sock'])
  const r = await purgeOrphanPlayers({ dir, timeoutMs: 300 })
  assert.strictEqual(r.quit, 0)
  assert.strictEqual(_fs.existsSync(_path.join(dir, 'papa-video-999998-deadbeef.sock')), false)
  _fs.rmSync(dir, { recursive: true, force: true })
})

test('an empty directory is not an error', async () => {
  const dir = socketDir([])
  assert.deepStrictEqual(await purgeOrphanPlayers({ dir }), { quit: 0, stale: 0 })
  _fs.rmSync(dir, { recursive: true, force: true })
})

// ── What the buffered bar is told ───────────────────────────────────────────
// mpv has two cache properties and they are not interchangeable.
// demuxer-cache-time is the ABSOLUTE timestamp of the end of the cache;
// demuxer-cache-duration is seconds ahead of the playhead. Measured on a
// 120-second file at position 32.96: cache-time 119.98, cache-duration 86.77.
// The bar added the absolute value to the position, so it read 152s of a 120s
// film, clamped to full, and sat there permanently.
test('the cache is observed as a duration, not an absolute timestamp', () => {
  const { OBSERVED_PROPS } = require('../video-engine.js')
  assert.ok(OBSERVED_PROPS.includes('demuxer-cache-duration'))
  assert.ok(!OBSERVED_PROPS.includes('demuxer-cache-time'),
    'adding an absolute timestamp to a position is how the bar came to lie')
})

// A demuxer window says how far ahead mpv has read. It says nothing about
// whether the bytes for somewhere else exist — on a torrent they usually do
// not, which is why a full-looking bar still bought a wait on every seek.
// Measured on a real 1440-second torrent after twelve seconds: seekable
// [[0, 2]], two seconds of a twenty-four minute film.
test('what is genuinely seekable is reported separately', () => {
  const { OBSERVED_PROPS } = require('../video-engine.js')
  assert.ok(OBSERVED_PROPS.includes('demuxer-cache-state'))
})

test('seekable ranges are normalised, and nonsense is dropped', () => {
  const eng = new VideoEngine({ config: {} })
  eng._onProp('demuxer-cache-state', {
    'seekable-ranges': [
      { start: 0, end: 12.5 },
      { start: 400, end: 430 },
      { start: 5, end: 5 },          // empty
      { start: 90, end: 10 },        // backwards
      { start: null, end: 3 },       // unusable
    ],
  })
  assert.deepStrictEqual(eng.state.seekable, [
    { start: 0, end: 12.5 },
    { start: 400, end: 430 },
  ])
})

test('no ranges at all is an empty list, not a crash', () => {
  const eng = new VideoEngine({ config: {} })
  eng._onProp('demuxer-cache-state', null)
  assert.deepStrictEqual(eng.state.seekable, [])
  eng._onProp('demuxer-cache-state', {})
  assert.deepStrictEqual(eng.state.seekable, [])
})
