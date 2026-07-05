# mpv Audio Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Chromium `<audio>`/Web Audio playback with an mpv-based engine giving a clean unresampled audio path, true gapless playback, native ReplayGain, and dual-instance crossfade.

**Architecture:** Main process spawns `mpv --idle` and controls it over a JSON IPC unix socket (`mpv-ipc.js` → `mpv-engine.js` → optional `mpv-crossfade.js` wrapper). Renderer keeps its UI/queue logic and talks to a drop-in `PapaPlayerShim` that mimics the `HTMLAudioElement` API surface the code already uses, backed by `player-*` IPC.

**Tech Stack:** Node/Electron 28 (CommonJS, no build step), mpv ≥0.35 JSON IPC, `node:test` for tests (system Node v24).

**Spec:** `docs/superpowers/specs/2026-07-04-mpv-audio-engine-design.md`

## Global Constraints

- Linux-first; keep code Windows-portable (no hardcoded `/tmp`, use `XDG_RUNTIME_DIR || os.tmpdir()`), but do not test/bundle Windows.
- EQ and visualizer are **removed**, not stubbed. No dead code left behind.
- mpv is a **hard requirement**: no `<audio>` fallback; blocking setup screen when missing.
- ReplayGain via mpv `--replaygain` (`no`/`track`/`album`). Crossfade via two mpv instances; crossfade ⊕ gapless (settings toggle, default gapless).
- Style: 2-space indent, CommonJS `require`, match existing file conventions. No new npm dependencies.
- Tests run with `npm test` → `node --test 'test/**/*.test.js'` (bare `node --test test/` is broken on this Node v24 — spurious failure). TDD: write test → see it fail → implement → see it pass → commit.
- After editing any renderer/main file, run `node --check <file>` before committing.
- Settings store key `playerSettings`: `{ outputMode:'default'|'exclusive', alsaDevice:string|null, mode:'gapless'|'crossfade', crossfadeSecs:number(4), replaygain:'no'|'track'|'album' }`.
- `player-event` messages to renderer: `{ type, data }` with types `position|duration|paused|volume|audioParams|trackChanged|autoAdvanced|ended|loadError|engineDown|engineFailed|mpvMissing`.

---

### Task 1: MpvIpcClient — JSON IPC socket client

**Files:**
- Create: `mpv-ipc.js`
- Create: `test/mpv-ipc.test.js`
- Modify: `package.json` (add test script)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `class MpvIpcClient extends EventEmitter` with `connect(timeoutMs=5000):Promise`, `command(...args):Promise<data>`, `observe(id, prop):Promise`, `close()`. Emits `'event'` (parsed mpv event objects) and `'disconnected'`. Export: `{ MpvIpcClient, COMMAND_TIMEOUT_MS }`.

- [x] **Step 1: Add test script to package.json**

In `package.json` `"scripts"`, add:

```json
"test": "node --test test/"
```

- [x] **Step 2: Write the failing tests**

Create `test/mpv-ipc.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { MpvIpcClient } = require('../mpv-ipc')

function mockServer(handler) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-test-')), 'mpv.sock')
  const conns = []
  const server = net.createServer(c => {
    conns.push(c)
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.trim()) handler(JSON.parse(line), c)
      }
    })
  })
  return new Promise(res => server.listen(sock, () =>
    res({ sock, server, push: msg => conns.forEach(c => c.write(JSON.stringify(msg) + '\n')),
          close: () => { conns.forEach(c => c.destroy()); server.close() } })))
}

test('command resolves with data on success response', async () => {
  const srv = await mockServer((msg, c) =>
    c.write(JSON.stringify({ error: 'success', data: 42, request_id: msg.request_id }) + '\n'))
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  assert.strictEqual(await client.command('get_property', 'volume'), 42)
  client.close(); srv.close()
})

test('command rejects on mpv error response', async () => {
  const srv = await mockServer((msg, c) =>
    c.write(JSON.stringify({ error: 'property not found', request_id: msg.request_id }) + '\n'))
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  await assert.rejects(client.command('get_property', 'nope'), /property not found/)
  client.close(); srv.close()
})

test('interleaved responses match by request_id', async () => {
  const held = []
  const srv = await mockServer((msg, c) => held.push({ msg, c }))
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  const p1 = client.command('a'); const p2 = client.command('b')
  // answer in reverse order
  await new Promise(r => setTimeout(r, 50))
  held[1].c.write(JSON.stringify({ error: 'success', data: 'B', request_id: held[1].msg.request_id }) + '\n')
  held[0].c.write(JSON.stringify({ error: 'success', data: 'A', request_id: held[0].msg.request_id }) + '\n')
  assert.deepStrictEqual(await Promise.all([p1, p2]), ['A', 'B'])
  client.close(); srv.close()
})

test('events are emitted', async () => {
  const srv = await mockServer(() => {})
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  const got = new Promise(r => client.once('event', r))
  srv.push({ event: 'property-change', id: 1, name: 'time-pos', data: 12.5 })
  const e = await got
  assert.strictEqual(e.name, 'time-pos')
  client.close(); srv.close()
})

test('pending commands reject when socket closes', async () => {
  const srv = await mockServer(() => {})
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  const p = client.command('never-answered')
  srv.close()
  await assert.rejects(p, /socket closed|client closed/)
  client.close()
})

test('connect retries until socket exists, fails after timeout', async () => {
  const client = new MpvIpcClient('/nonexistent/papa.sock')
  await assert.rejects(client.connect(300), /not ready/)
})
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../mpv-ipc'`

- [x] **Step 4: Implement mpv-ipc.js**

Create `mpv-ipc.js`:

```js
'use strict'
const net = require('net')
const { EventEmitter } = require('events')

const COMMAND_TIMEOUT_MS = 2000

class MpvIpcClient extends EventEmitter {
  constructor(socketPath) {
    super()
    this.socketPath = socketPath
    this.socket = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tryConnect = () => {
        const sock = net.createConnection(this.socketPath)
        sock.once('connect', () => {
          this.socket = sock
          sock.setEncoding('utf8')
          sock.on('data', chunk => this._onData(chunk))
          sock.on('close', () => this._onClose())
          sock.on('error', () => {})
          resolve()
        })
        sock.once('error', () => {
          sock.destroy()
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`mpv socket not ready: ${this.socketPath}`))
          } else {
            setTimeout(tryConnect, 100)
          }
        })
      }
      tryConnect()
    })
  }

  command(...args) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('not connected'))
        return
      }
      const requestId = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`mpv command timeout: ${JSON.stringify(args)}`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket.write(JSON.stringify({ command: args, request_id: requestId }) + '\n')
    })
  }

  observe(id, property) {
    return this.command('observe_property', id, property)
  }

  close() {
    this._rejectAll('client closed')
    this.socket?.destroy()
    this.socket = null
  }

  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id)
        this.pending.delete(msg.request_id)
        clearTimeout(p.timer)
        if (msg.error === 'success') {
          p.resolve(msg.data)
        } else {
          p.reject(new Error(`mpv: ${msg.error}`))
        }
      } else if (msg.event) {
        this.emit('event', msg)
      }
    }
  }

  _onClose() {
    this._rejectAll('socket closed')
    this.socket = null
    this.emit('disconnected')
  }

  _rejectAll(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

module.exports = { MpvIpcClient, COMMAND_TIMEOUT_MS }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all 6 tests PASS

- [x] **Step 6: Commit**

```bash
git add package.json mpv-ipc.js test/mpv-ipc.test.js
git commit -m "feat: mpv JSON IPC client with request matching and timeouts"
```

---

### Task 2: MpvEngine — lifecycle, playback API, events

**Files:**
- Create: `mpv-engine.js`
- Create: `test/mpv-engine.test.js`
- Create: `test/mpv-engine.integration.test.js`

**Interfaces:**
- Consumes: `MpvIpcClient` from `mpv-ipc.js`.
- Produces: `class MpvEngine extends EventEmitter`. Constructor `new MpvEngine({ binary?, config?, spawnFn?, socketPath? })` (last two are test injection). Methods: `start():Promise`, `stop()`, `load(path, {play=true}):Promise`, `setNext(path|null):Promise`, `play():Promise`, `pause():Promise`, `seek(seconds):Promise`, `setVolume(0-100):Promise`, `setSpeed(x):Promise`, `setReplaygain('no'|'track'|'album'):Promise`, `listAudioDevices():Promise<[{name,description}]>`, `restart(newConfig):Promise`, `getState():{path,position,duration,paused,volume,audioParams}`. Events: `ready`, `position(sec)`, `duration(sec)`, `paused(bool)`, `volume(0-100)`, `audioParams({samplerate,format,channels})`, `trackChanged(path)`, `autoAdvanced(path)`, `ended`, `loadError(path)`, `engineDown`, `engineFailed`. Export: `{ MpvEngine }`.

- [x] **Step 1: Write failing unit tests (mock spawn + mock server)**

Create `test/mpv-engine.test.js`:

```js
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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../mpv-engine'`

- [x] **Step 3: Implement mpv-engine.js**

Create `mpv-engine.js`:

```js
'use strict'
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const { MpvIpcClient } = require('./mpv-ipc')

const POSITION_THROTTLE_MS = 250
const RESPAWN_WINDOW_MS = 60000
const MAX_RESPAWNS = 3
const EOF_GRACE_MS = 150

const OBSERVED_PROPS = ['time-pos', 'duration', 'pause', 'path', 'audio-params', 'volume']

let sockCounter = 0

class MpvEngine extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.binary = opts.binary || 'mpv'
    this.config = {
      outputMode: 'default',
      alsaDevice: null,
      replaygain: 'no',
      gapless: true,
      ...opts.config,
    }
    this._spawnFn = opts.spawnFn || spawn
    this._fixedSocketPath = opts.socketPath || null
    this.client = null
    this.proc = null
    this.alive = false
    this._stopping = false
    this._respawns = []
    this._lastPosEmit = 0
    this._nextPath = null
    this._eofTimer = null
    this.state = { path: null, position: 0, duration: 0, paused: true, volume: 100, audioParams: null }
  }

  _args(socketPath) {
    const a = [
      '--idle=yes', '--no-video', '--no-terminal', '--audio-display=no',
      `--input-ipc-server=${socketPath}`,
      `--replaygain=${this.config.replaygain}`,
      `--gapless-audio=${this.config.gapless ? 'weak' : 'no'}`,
    ]
    if (this.config.outputMode === 'exclusive' && this.config.alsaDevice) {
      a.push(`--audio-device=${this.config.alsaDevice}`, '--audio-exclusive=yes')
    }
    return a
  }

  async start() {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()
    const socketPath = this._fixedSocketPath ||
      path.join(runtimeDir, `papa-mpv-${process.pid}-${sockCounter++}.sock`)
    this._stopping = false
    this.proc = this._spawnFn(this.binary, this._args(socketPath), { stdio: 'ignore' })
    this.proc.on('exit', () => this._onExit())
    this.proc.on('error', () => this._onExit())
    this.client = new MpvIpcClient(socketPath)
    await this.client.connect()
    this.client.on('event', e => this._onEvent(e))
    this.client.on('disconnected', () => this._onExit())
    let obsId = 1
    for (const prop of OBSERVED_PROPS) {
      await this.client.observe(obsId++, prop)
    }
    this.alive = true
    this.emit('ready')
  }

  stop() {
    this._stopping = true
    this.alive = false
    clearTimeout(this._eofTimer)
    this.client?.close()
    this.client = null
    try { this.proc?.kill() } catch { /* already dead */ }
    this.proc = null
  }

  async load(filePath, { play = true } = {}) {
    this._nextPath = null
    if (!play) await this.client.command('set_property', 'pause', true)
    await this.client.command('loadfile', filePath, 'replace')
    if (play) await this.client.command('set_property', 'pause', false)
    this.state.path = filePath
    this.state.position = 0
  }

  async setNext(filePath) {
    await this.client.command('playlist-clear')
    this._nextPath = filePath || null
    if (filePath) await this.client.command('loadfile', filePath, 'append')
  }

  async play() { await this.client.command('set_property', 'pause', false) }
  async pause() { await this.client.command('set_property', 'pause', true) }
  async seek(seconds) { await this.client.command('seek', seconds, 'absolute') }
  async setVolume(v) { await this.client.command('set_property', 'volume', v) }
  async setSpeed(x) { await this.client.command('set_property', 'speed', x) }
  async setReplaygain(mode) {
    this.config.replaygain = mode
    await this.client.command('set_property', 'replaygain', mode)
  }

  async listAudioDevices() {
    return this.client.command('get_property', 'audio-device-list')
  }

  async restart(newConfig = {}) {
    const resume = { ...this.state }
    this.stop()
    this.config = { ...this.config, ...newConfig }
    await this.start()
    if (resume.path) {
      await this.load(resume.path, { play: false })
      if (resume.position > 1) await this.seek(resume.position)
      await this.setVolume(resume.volume)
      if (!resume.paused) await this.play()
    }
  }

  getState() { return { ...this.state } }

  _onEvent(e) {
    if (e.event === 'property-change') {
      this._onProp(e.name, e.data)
    } else if (e.event === 'end-file') {
      if (e.reason === 'error') this.emit('loadError', this.state.path)
      if (e.reason === 'eof') {
        clearTimeout(this._eofTimer)
        this._eofTimer = setTimeout(() => this.emit('ended'), EOF_GRACE_MS)
      }
    } else if (e.event === 'start-file') {
      clearTimeout(this._eofTimer)
    }
  }

  _onProp(name, data) {
    switch (name) {
      case 'time-pos': {
        if (data == null) return
        this.state.position = data
        const now = Date.now()
        if (now - this._lastPosEmit >= POSITION_THROTTLE_MS) {
          this._lastPosEmit = now
          this.emit('position', data)
        }
        break
      }
      case 'duration':
        if (data == null) return
        this.state.duration = data
        this.emit('duration', data)
        break
      case 'pause':
        this.state.paused = data
        this.emit('paused', data)
        break
      case 'volume':
        if (data == null) return
        this.state.volume = data
        this.emit('volume', data)
        break
      case 'audio-params':
        if (!data) return
        this.state.audioParams = data
        this.emit('audioParams', data)
        break
      case 'path': {
        if (!data || data === this.state.path) return
        this.state.path = data
        if (data === this._nextPath) {
          this._nextPath = null
          this.emit('autoAdvanced', data)
        } else {
          this.emit('trackChanged', data)
        }
        break
      }
    }
  }

  async _onExit() {
    if (this._stopping || !this.alive) return
    this.alive = false
    this.client?.close()
    this.client = null
    this.emit('engineDown')
    const now = Date.now()
    this._respawns = this._respawns.filter(t => now - t < RESPAWN_WINDOW_MS)
    if (this._respawns.length >= MAX_RESPAWNS) {
      this.emit('engineFailed')
      return
    }
    this._respawns.push(now)
    const resume = { ...this.state }
    try {
      await this.start()
      if (resume.path) {
        await this.load(resume.path, { play: false })
        if (resume.position > 1) await this.seek(resume.position)
        await this.setVolume(resume.volume)
        if (!resume.paused) await this.play()
      }
    } catch {
      this.emit('engineFailed')
    }
  }
}

module.exports = { MpvEngine }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all Task 1 + Task 2 tests PASS

- [x] **Step 5: Write integration test against real mpv (auto-skips when absent)**

Create `test/mpv-engine.integration.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('child_process')
const { spawn } = require('child_process')
const { MpvEngine } = require('../mpv-engine')

let hasMpv = true
try { execFileSync('mpv', ['--version'], { stdio: 'ignore' }) } catch { hasMpv = false }

// Generate a 2-second test tone wav with ffmpeg if available, else skip.
const fs = require('fs')
const os = require('os')
const path = require('path')
function makeTone(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    `sine=frequency=440:duration=${seconds}`, file], { stdio: 'ignore' })
}
let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

test('real mpv: load/play/seek/eof and gapless enqueue', { skip: !hasMpv || !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-int-'))
  const a = path.join(dir, 'a.wav'); const b = path.join(dir, 'b.wav')
  makeTone(a, 2); makeTone(b, 2)

  // --ao=null → no sound card needed
  const eng = new MpvEngine({
    spawnFn: (bin, args, o) => spawn(bin, [...args, '--ao=null'], o),
  })
  await eng.start()

  const gotDuration = new Promise(r => eng.once('duration', r))
  await eng.load(a)
  assert.ok(Math.abs(await gotDuration - 2) < 0.5, 'duration ~2s')

  await eng.setNext(b)
  const adv = new Promise(r => eng.once('autoAdvanced', r))
  await eng.seek(1.8)
  assert.strictEqual(await adv, b, 'gapless auto-advance to b')

  const ended = new Promise(r => eng.once('ended', r))
  await eng.seek(1.8)
  await ended
  eng.stop()
})

test('real mpv: survives kill -9 via respawn', { skip: !hasMpv || !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-int2-'))
  const a = path.join(dir, 'a.wav'); makeTone(a, 30)
  const eng = new MpvEngine({
    spawnFn: (bin, args, o) => spawn(bin, [...args, '--ao=null'], o),
  })
  await eng.start()
  await eng.load(a)
  const down = new Promise(r => eng.once('engineDown', r))
  const ready = new Promise(r => eng.once('ready', r))
  process.kill(eng.proc.pid, 'SIGKILL')
  await down
  await ready
  assert.strictEqual(eng.getState().path, a, 'track reloaded after respawn')
  eng.stop()
})
```

- [x] **Step 6: Run tests (integration skips until mpv installed — that's expected)**

Run: `npm test`
Expected: unit tests PASS; integration tests report `# SKIP` if mpv/ffmpeg missing. Once `sudo dnf install -y mpv` has been run, re-run and expect PASS.

- [x] **Step 7: Commit**

```bash
git add mpv-engine.js test/mpv-engine.test.js test/mpv-engine.integration.test.js
git commit -m "feat: mpv engine with lifecycle, gapless prefetch, respawn recovery"
```

---

### Task 3: MpvCrossfade — dual-instance crossfade wrapper

**Files:**
- Create: `mpv-crossfade.js`
- Create: `test/mpv-crossfade.test.js`

**Interfaces:**
- Consumes: two objects with the `MpvEngine` surface (injected via factory for tests).
- Produces: `class MpvCrossfade extends EventEmitter` with the **same public surface as MpvEngine** (`start/stop/load/setNext/play/pause/seek/setVolume/setSpeed/setReplaygain/listAudioDevices/restart/getState`) so `main.js` can hold either behind one variable. Extra constructor opts: `{ crossfadeSecs=4, engineFactory, tickMs=100 }`. Re-emits active-engine events; on fade completion emits `autoAdvanced(path)`. Export: `{ MpvCrossfade }`.

- [x] **Step 1: Write failing tests with fake engines**

Create `test/mpv-crossfade.test.js`:

```js
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
  async listAudioDevices() { return [] }
  async restart() { this.calls.push(['restart']) }
  getState() { return { ...this.state } }
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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../mpv-crossfade'`

- [x] **Step 3: Implement mpv-crossfade.js**

Create `mpv-crossfade.js`:

```js
'use strict'
const { EventEmitter } = require('events')
const { MpvEngine } = require('./mpv-engine')

const FADE_STEPS = 20

// Wraps two MpvEngine instances and exposes the same surface as one engine.
// Gapless prefetch is disabled in this mode; "next" is faded in instead.
class MpvCrossfade extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.crossfadeSecs = opts.crossfadeSecs ?? 4
    this._tickMs = opts.tickMs ?? (this.crossfadeSecs * 1000) / FADE_STEPS
    this._factory = opts.engineFactory || (() => new MpvEngine(opts.engineOpts || {}))
    this.engines = []
    this.activeIdx = 0
    this.userVolume = 100
    this._nextPath = null
    this._fading = false
  }

  get _active() { return this.engines[this.activeIdx] }
  get _inactive() { return this.engines[1 - this.activeIdx] }

  async start() {
    this.engines = [this._factory(), this._factory()]
    for (let i = 0; i < 2; i++) this._wire(this.engines[i], i)
    await Promise.all(this.engines.map(e => e.start()))
  }

  stop() { this.engines.forEach(e => e.stop()) }

  _wire(engine, idx) {
    const ifActive = fn => (...args) => { if (idx === this.activeIdx && !this._fading) fn(...args) }
    engine.on('position', p => {
      if (idx !== this.activeIdx) return
      this.emit('position', p)
      this._maybeStartFade(p)
    })
    engine.on('duration', ifActive(d => this.emit('duration', d)))
    engine.on('paused', ifActive(p => this.emit('paused', p)))
    engine.on('audioParams', ifActive(a => this.emit('audioParams', a)))
    engine.on('ended', ifActive(() => this.emit('ended')))
    engine.on('loadError', ifActive(p => this.emit('loadError', p)))
    engine.on('trackChanged', ifActive(p => this.emit('trackChanged', p)))
    engine.on('engineDown', () => this.emit('engineDown'))
    engine.on('engineFailed', () => this.emit('engineFailed'))
  }

  _maybeStartFade(position) {
    const st = this._active.getState()
    if (this._fading || !this._nextPath || !st.duration) return
    if (position < st.duration - this.crossfadeSecs) return
    this._startFade().catch(() => {})
  }

  async _startFade() {
    this._fading = true
    const next = this._nextPath
    this._nextPath = null
    const from = this._active
    const to = this._inactive
    await to.setVolume(0)
    await to.load(next, { play: true })
    for (let i = 1; i <= FADE_STEPS; i++) {
      const t = i / FADE_STEPS
      await from.setVolume(Math.round(this.userVolume * (1 - t)))
      await to.setVolume(Math.round(this.userVolume * t))
      await new Promise(r => setTimeout(r, this._tickMs))
    }
    await from.pause()
    this.activeIdx = 1 - this.activeIdx
    this._fading = false
    this.emit('autoAdvanced', next)
  }

  // ── MpvEngine-compatible surface ──
  async load(p, o) { this._nextPath = null; await this._active.setVolume(this.userVolume); await this._active.load(p, o) }
  async setNext(p) { this._nextPath = p || null }
  async play() { await this._active.play() }
  async pause() { await this._active.pause() }
  async seek(s) { await this._active.seek(s) }
  async setVolume(v) { this.userVolume = v; await this._active.setVolume(v) }
  async setSpeed(x) { await this._active.setSpeed(x) }
  async setReplaygain(m) { await Promise.all(this.engines.map(e => e.setReplaygain(m))) }
  async listAudioDevices() { return this._active.listAudioDevices() }
  async restart(cfg) { for (const e of this.engines) await e.restart(cfg) }
  getState() { return this._active.getState() }
}

module.exports = { MpvCrossfade }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (integration still SKIP without mpv)

- [x] **Step 5: Commit**

```bash
git add mpv-crossfade.js test/mpv-crossfade.test.js
git commit -m "feat: dual-instance crossfade wrapper with engine-compatible surface"
```

---

### Task 4: Purge EQ, visualizer, Web Audio graph, and old crossfade from the app

App still plays through `<audio>` after this task — it just loses EQ/viz (approved "purist mode"). This isolates the deletions from the engine swap.

**Files:**
- Modify: `src/renderer.js` (delete Web Audio/EQ/viz/crossfade code)
- Modify: `src/index.html` (delete EQ panel, EQ button, viz canvases)
- Modify: `src/styles.css` (delete `.eq-*`, `.viz-*`, `.np-modal-viz` rules)
- Modify: `main.js:616-620` (delete `get-eq-settings` / `save-eq-settings` handlers)
- Modify: `preload.js:56-58` (delete `getEqSettings`/`saveEqSettings`)

**Interfaces:**
- Consumes: nothing.
- Produces: a renderer with **no** references to `audioCtx`, `AudioContext`, `analyser`, `eq`, `startViz`, `_cf`. `playCurrentTrack()` (renderer.js:2662) plays via bare `audio.src`/`audio.play()` with the graph calls removed. ReplayGain UI is gone for now (returns via mpv in Task 7).

- [ ] **Step 1: Delete renderer Web Audio / EQ / viz / crossfade code**

In `src/renderer.js`, delete (find each with the grep below — line numbers will drift):
- The state variables at top: `audioCtx`, `audioSource`, `replayGainNode`, `preampNode`, `eqNodes`, `analyserNode`, `_cfAudio`, `_cfSrc`, `_cfGain`, `_cfRgGain`, `_cfActive`, `_cfNextTrack`, and any `eqEnabled/eqGains/eqPreamp` fields in `state`.
- Functions: `ensureAudioGraph()`, `applyReplayGain()`, `startViz()`, `stopViz()`, every `renderEq*`/`eq*` UI function, `cleanupCrossfade()` and all `_cf*` crossfade functions, and the EQ panel open/close + keyboard-shortcut (`E`) wiring.
- In `playCurrentTrack()` (renderer.js:2662): remove the `cleanupCrossfade()`, `ensureAudioGraph()`, `applyReplayGain(track)`, `audioCtx?.resume()`, and `startViz()` lines. Keep everything else.
- Any call sites: `stopViz()`, viz canvas drawing in the now-playing modal (renderer.js:2547-2548), EQ settings load in `init()` (`getEqSettings`), crossfade slider handling.

Find every remaining reference:

```bash
grep -n -iE "audioCtx|AudioContext|analyser|eqNodes|eqGains|eqPreamp|eq-panel|btn-eq|startViz|stopViz|_cf[A-Z]|cleanupCrossfade|getEqSettings|replayGainNode|preampNode" src/renderer.js
```

Expected after edits: no output.

- [ ] **Step 2: Delete markup and CSS**

- `src/index.html`: delete the viz canvas (line 376), the EQ button (line 394), the now-playing-modal viz canvas (line 432), and the whole `#eq-panel` block (lines 562-~605).
- `src/styles.css`: delete all `.eq-*`, `.viz-canvas`, `.np-modal-viz` rules.

Verify:

```bash
grep -n -iE "eq-|viz" src/index.html src/styles.css
```

Expected: no output (ignore unrelated matches like "request" — refine with `grep -w` if needed).

- [ ] **Step 3: Delete main/preload EQ settings plumbing**

- `main.js`: delete the `get-eq-settings` handle and `save-eq-settings` listener (lines 616-620).
- `preload.js`: delete lines 56-58 (`getEqSettings`, `saveEqSettings`).

- [ ] **Step 4: Syntax-check and manually verify**

```bash
node --check src/renderer.js && node --check main.js && node --check preload.js && npm test
```

Expected: no syntax errors, tests still pass. Then `npm start`: play a track — audio works, no console errors, EQ button and visualizer gone, crossfade slider gone.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove EQ, visualizer, Web Audio graph, and element crossfade (purist mode)"
```

---

### Task 5: Wire engine into main process + preload

**Files:**
- Modify: `main.js` (engine construction, `player-*` IPC handlers, event forwarding, mpv detection)
- Modify: `preload.js` (player API + `player-event` channel)

**Interfaces:**
- Consumes: `MpvEngine` (`mpv-engine.js`), `MpvCrossfade` (`mpv-crossfade.js`).
- Produces (renderer-visible, via `window.api`):
  - `playerLoad({ path, play })`, `playerSetNext(path|null)`, `playerPlay()`, `playerPause()`, `playerSeek(seconds)`, `playerSetVolume(vol0to100)`, `playerSetSpeed(x)` — all `invoke`, resolve `{ ok:true }` or `{ ok:false, error }`.
  - `playerGetStatus()` → `{ available:boolean, state|null, config }`.
  - `playerGetConfig()` / `playerSetConfig(partialConfig)` (setConfig live-applies `replaygain`; restarts engine for `outputMode`/`alsaDevice`/`mode`/`crossfadeSecs`).
  - `playerListDevices()` → mpv `audio-device-list` array.
  - Event channel `'player-event'` with `{ type, data }` (types listed in Global Constraints).

- [ ] **Step 1: Add player module to main.js**

In `main.js`, after the existing `require` block at the top, add:

```js
const { execFileSync } = require('child_process')
const { MpvEngine } = require('./mpv-engine')
const { MpvCrossfade } = require('./mpv-crossfade')
```

Then add this section near the MPRIS section (`main.js:403`):

```js
// ── mpv player engine ─────────────────────────────────────────────────────────
let player = null
let mpvAvailable = false

function getPlayerSettings() {
  return {
    outputMode: 'default', alsaDevice: null,
    mode: 'gapless', crossfadeSecs: 4, replaygain: 'no',
    ...store.get('playerSettings', {}),
  }
}

function detectMpv() {
  try { execFileSync('mpv', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

function sendPlayerEvent(type, data) {
  mainWindow?.webContents.send('player-event', { type, data })
}

function buildPlayer(cfg) {
  const engineConfig = {
    outputMode: cfg.outputMode, alsaDevice: cfg.alsaDevice,
    replaygain: cfg.replaygain, gapless: cfg.mode === 'gapless',
  }
  const p = cfg.mode === 'crossfade'
    ? new MpvCrossfade({ crossfadeSecs: cfg.crossfadeSecs, engineOpts: { config: engineConfig } })
    : new MpvEngine({ config: engineConfig })
  p.on('position',     d => sendPlayerEvent('position', d))
  p.on('duration',     d => sendPlayerEvent('duration', d))
  p.on('paused',       d => sendPlayerEvent('paused', d))
  p.on('audioParams',  d => sendPlayerEvent('audioParams', d))
  p.on('autoAdvanced', d => sendPlayerEvent('autoAdvanced', d))
  p.on('trackChanged', d => sendPlayerEvent('trackChanged', d))
  p.on('ended',        () => sendPlayerEvent('ended'))
  p.on('loadError',    d => sendPlayerEvent('loadError', d))
  p.on('engineDown',   () => sendPlayerEvent('engineDown'))
  p.on('engineFailed', () => sendPlayerEvent('engineFailed'))
  return p
}

async function initPlayer() {
  mpvAvailable = detectMpv()
  if (!mpvAvailable) { sendPlayerEvent('mpvMissing'); return }
  player = buildPlayer(getPlayerSettings())
  try { await player.start() } catch (e) {
    console.error('mpv engine failed to start:', e)
    sendPlayerEvent('engineFailed')
  }
}

const wrap = fn => async (...args) => {
  if (!player) return { ok: false, error: 'engine unavailable' }
  try { await fn(...args); return { ok: true } } catch (e) { return { ok: false, error: String(e.message || e) } }
}

ipcMain.handle('player-load',       (_, { path: p, play }) => wrap(() => player.load(p, { play }))())
ipcMain.handle('player-set-next',   (_, p) => wrap(() => player.setNext(p))())
ipcMain.handle('player-play',       () => wrap(() => player.play())())
ipcMain.handle('player-pause',      () => wrap(() => player.pause())())
ipcMain.handle('player-seek',       (_, s) => wrap(() => player.seek(s))())
ipcMain.handle('player-set-volume', (_, v) => wrap(() => player.setVolume(v))())
ipcMain.handle('player-set-speed',  (_, x) => wrap(() => player.setSpeed(x))())
ipcMain.handle('player-get-status', () => ({
  available: mpvAvailable && !!player,
  state: player ? player.getState() : null,
  config: getPlayerSettings(),
}))
ipcMain.handle('player-get-config', () => getPlayerSettings())
ipcMain.handle('player-list-devices', async () => {
  if (!player) return []
  try { return await player.listAudioDevices() } catch { return [] }
})
ipcMain.handle('player-set-config', async (_, partial) => {
  const cfg = { ...getPlayerSettings(), ...partial }
  store.set('playerSettings', cfg)
  if (!player) return { ok: false, error: 'engine unavailable' }
  const needsRebuild = ['outputMode', 'alsaDevice', 'mode', 'crossfadeSecs']
    .some(k => k in partial)
  try {
    if (needsRebuild) {
      const resume = player.getState()
      player.stop()
      player = buildPlayer(cfg)
      await player.start()
      if (resume.path) {
        await player.load(resume.path, { play: false })
        if (resume.position > 1) await player.seek(resume.position)
        await player.setVolume(resume.volume)
        if (!resume.paused) await player.play()
      }
    } else if ('replaygain' in partial) {
      await player.setReplaygain(cfg.replaygain)
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})
```

Call `initPlayer()` where the app finishes creating the window — find the line `initMpris()` (main.js:346) and add `initPlayer()` directly after it. Also add to the app-quit path (search `app.isQuitting = true`): `player?.stop()`.

- [ ] **Step 2: Expose player API in preload.js**

In `preload.js`, add before the `// Events from main process` comment:

```js
  // mpv player engine
  playerLoad:        (p) => ipcRenderer.invoke('player-load', p),
  playerSetNext:     (p) => ipcRenderer.invoke('player-set-next', p),
  playerPlay:        ()  => ipcRenderer.invoke('player-play'),
  playerPause:       ()  => ipcRenderer.invoke('player-pause'),
  playerSeek:        (s) => ipcRenderer.invoke('player-seek', s),
  playerSetVolume:   (v) => ipcRenderer.invoke('player-set-volume', v),
  playerSetSpeed:    (x) => ipcRenderer.invoke('player-set-speed', x),
  playerGetStatus:   ()  => ipcRenderer.invoke('player-get-status'),
  playerGetConfig:   ()  => ipcRenderer.invoke('player-get-config'),
  playerSetConfig:   (c) => ipcRenderer.invoke('player-set-config', c),
  playerListDevices: ()  => ipcRenderer.invoke('player-list-devices'),
```

In the `allowed` channel list (preload.js:143-148), add `'player-event'` and `'media-seek'` (the MPRIS seek channel at main.js:431-432 sends `media-seek`, which the current allowlist silently drops — pre-existing bug, fixed here).

- [ ] **Step 3: Verify**

```bash
node --check main.js && node --check preload.js && npm test
```

Then `npm start`, open DevTools console (Ctrl+Shift+I) and run:

```js
await window.api.playerGetStatus()
// If mpv installed: { available: true, state: {...}, config: {...} }
// If not yet installed: { available: false, ... } — acceptable until dnf install
await window.api.playerLoad({ path: '/mnt/data/MUSIC/<any file>.flac', play: true })
// With mpv installed: audio plays OUTSIDE the <audio> element (old UI stays silent/idle)
```

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat: player IPC surface wiring mpv engine into main process"
```

---

### Task 6: PapaPlayerShim — swap the renderer onto mpv

**Files:**
- Create: `src/player-shim.js`
- Modify: `src/index.html` (script tag + remove `<audio>` element; add format chip)
- Modify: `src/renderer.js` (audio global swap, setNext wiring, auto-advance handler, format chip)

**Interfaces:**
- Consumes: `window.api.player*` and `window.api.on('player-event')` from Task 5.
- Produces: global `window.__papaPlayer` — an `EventTarget` implementing the `HTMLAudioElement` subset the renderer uses: `src` (get/set, accepts `file://` URLs), `play():Promise`, `pause()`, `paused`, `ended`, `currentTime` (get/set), `duration`, `volume` (0..1 get/set), `playbackRate` (set). Events dispatched: `timeupdate`, `loadedmetadata`, `durationchange`, `play`, `pause`, `ended`, `error`, plus custom `autoadvanced` (`detail: path`) and `audioparams` (`detail: {samplerate, format, channels}`).

- [ ] **Step 1: Implement the shim**

Create `src/player-shim.js`:

```js
'use strict'
// Drop-in replacement for the #audio element, backed by the mpv engine.
// Implements only the HTMLAudioElement surface renderer.js actually uses.
class PapaPlayerShim extends EventTarget {
  constructor() {
    super()
    this._src = ''
    this._currentTime = 0
    this._duration = 0
    this._paused = true
    this._ended = false
    this._volume = 0.8
    this.audioParams = null

    window.api.on('player-event', ({ type, data }) => {
      switch (type) {
        case 'position':
          this._currentTime = data
          this.dispatchEvent(new Event('timeupdate'))
          break
        case 'duration':
          this._duration = data
          this.dispatchEvent(new Event('durationchange'))
          this.dispatchEvent(new Event('loadedmetadata'))
          break
        case 'paused':
          this._paused = data
          this.dispatchEvent(new Event(data ? 'pause' : 'play'))
          break
        case 'audioParams':
          this.audioParams = data
          this.dispatchEvent(new CustomEvent('audioparams', { detail: data }))
          break
        case 'autoAdvanced':
          this._src = `file://${data}`
          this._currentTime = 0
          this._ended = false
          this.dispatchEvent(new CustomEvent('autoadvanced', { detail: data }))
          break
        case 'ended':
          this._ended = true
          this._paused = true
          this.dispatchEvent(new Event('ended'))
          break
        case 'loadError':
          this.dispatchEvent(new Event('error'))
          break
      }
    })
  }

  _pathOf(src) { return decodeURI(String(src).replace(/^file:\/\//, '')) }

  get src() { return this._src }
  set src(v) {
    this._src = v
    this._ended = false
    this._currentTime = 0
    this._duration = 0
    window.api.playerLoad({ path: this._pathOf(v), play: false })
  }

  async play() {
    const r = await window.api.playerPlay()
    if (!r.ok) throw new Error(r.error)
    this._paused = false
  }

  pause() { this._paused = true; window.api.playerPause() }

  get paused() { return this._paused }
  get ended() { return this._ended }
  get duration() { return this._duration }
  get currentTime() { return this._currentTime }
  set currentTime(s) { this._currentTime = s; window.api.playerSeek(s) }
  get volume() { return this._volume }
  set volume(v) { this._volume = v; window.api.playerSetVolume(Math.round(v * 100)) }
  set playbackRate(x) { window.api.playerSetSpeed(x) }

  // renderer uses audio.addEventListener/removeEventListener — inherited from EventTarget
  setNext(path) { window.api.playerSetNext(path) }
}

window.__papaPlayer = new PapaPlayerShim()
```

- [ ] **Step 2: Load shim and drop the element**

In `src/index.html`:
- Delete `<audio id="audio"></audio>` (line ~690).
- Immediately before the `<script src="renderer.js">` tag, add `<script src="player-shim.js"></script>`.
- In the player bar, next to the track title/artist block, add the live format chip: `<span class="np-format" id="np-format"></span>` and in `src/styles.css`: `.np-format { font-size: 10px; opacity: .6; margin-left: 8px; letter-spacing: .5px; }`.

- [ ] **Step 3: Swap the renderer onto the shim**

In `src/renderer.js`:

Replace line 62:

```js
const audio = document.getElementById('audio')
```

with:

```js
const audio = window.__papaPlayer
```

Add next-track prefetch + auto-advance. Near `playCurrentTrack()` (renderer.js:2662), add:

```js
// Mirror of nextTrack()'s selection, without side effects — used for gapless prefetch
function computeNextIndex() {
  if (state.repeat === 'one') return state.queueIndex
  if (state.shuffle && state.queue.length > 1) return null // shuffle picks lazily; skip prefetch
  if (state.queueIndex + 1 < state.queue.length) return state.queueIndex + 1
  return state.repeat === 'all' ? 0 : null
}

function updateNextPrefetch() {
  const idx = computeNextIndex()
  audio.setNext(idx == null ? null : state.queue[idx].filePath)
}
```

**Check `nextTrack()` (renderer.js:~2817) before writing `computeNextIndex`** — the mirror above must match its actual repeat/shuffle branch logic; adjust if it differs (e.g. if shuffle picks the next index eagerly, prefetch that index instead of skipping).

At the end of `playCurrentTrack()`'s `.then()` block, add `updateNextPrefetch()`. Also call `updateNextPrefetch()` wherever the queue or modes change: in the shuffle toggle handler, repeat toggle handler, and queue mutation points (find them with `grep -n "state.repeat =\|state.shuffle =\|state.queue =" src/renderer.js`).

Add the auto-advance handler next to the existing `audio.addEventListener('ended', ...)` wiring:

```js
audio.addEventListener('autoadvanced', (e) => {
  // mpv already switched tracks gaplessly — sync UI state without reloading
  const idx = state.queue.findIndex(t => t.filePath === e.detail)
  if (idx === -1) return
  state.queueIndex = idx
  const track = state.queue[idx]
  state.isPlaying = true
  updatePlayBtn()
  updateNowPlaying(track)
  updateTrackHighlight()
  updatePlayerLikeBtn()
  if (state.queuePanelOpen) renderQueuePanel()
  if (state.modalOpen) { updateNowPlayingModal(); syncModalPlayBtn() }
  window.api.savePlaybackState({ filePath: track.filePath, position: 0 })
  state.playCounts[track.filePath] = (state.playCounts[track.filePath] || 0) + 1
  window.api.incrementPlayCount(track.filePath)
  _lyrics = null
  renderLyricsPanel()
  updateLyricsDrawer()
  fetchLyrics(track).then(lines => { _lyrics = lines; renderLyricsPanel(); updateLyricsDrawer() })
  syncExtension()
  updateNextPrefetch()
})

audio.addEventListener('audioparams', (e) => {
  const el = document.getElementById('np-format')
  if (!el) return
  const p = e.detail
  el.textContent = p?.samplerate ? `${(p.format || '').toUpperCase()} ${Math.round(p.samplerate / 1000)}kHz` : ''
})
```

**Cross-check the UI-update calls above against the real `.then()` body of `playCurrentTrack()` (renderer.js:2670-2695)** — reuse exactly the functions it calls (they exist today: `updatePlayBtn`, `updateNowPlaying`, `updateTrackHighlight`, `updatePlayerLikeBtn`, `renderQueuePanel`, `updateNowPlayingModal`, `syncModalPlayBtn`, `syncExtension`).

- [ ] **Step 4: Verify end-to-end**

```bash
node --check src/renderer.js src/player-shim.js && npm test
```

Then `npm start` (mpv must be installed by now — if not, install first):
- Play a track → audio comes from mpv; seek bar, volume, next/prev, pause all work.
- Play an album → let a track end naturally → next track starts **gaplessly**, UI updates without a reload flash.
- Media keys / GNOME extension still control playback (MPRIS path unchanged).
- Format chip shows e.g. `FLAC 44kHz` / `FLAC 96kHz` while playing.
- Restart app → playback state resumes at saved position, paused.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: renderer plays through mpv via HTMLAudioElement-compatible shim"
```

---

### Task 7: Playback settings UI (output mode, gapless/crossfade, ReplayGain)

**Files:**
- Modify: `src/index.html` (Playback section at top of `#mcs-panel-settings`, line ~207)
- Modify: `src/renderer.js` (load/save handlers)
- Modify: `src/styles.css` (reuse existing `.mcs-set-*` styles; add only what's missing)

**Interfaces:**
- Consumes: `window.api.playerGetConfig/playerSetConfig/playerListDevices` (Task 5).
- Produces: user-visible settings persisted in `playerSettings`; engine restarts seamlessly on structural changes.

- [ ] **Step 1: Add markup**

Inside `#mcs-panel-settings` (src/index.html line ~207), before existing content, add:

```html
<div class="mcs-set-group" id="playback-settings">
  <div class="mcs-set-title">Playback</div>
  <label class="mcs-set-row">Output
    <select id="pb-output-mode">
      <option value="default">System (PipeWire)</option>
      <option value="exclusive">Bit-perfect (exclusive ALSA)</option>
    </select>
  </label>
  <label class="mcs-set-row" id="pb-device-row" style="display:none">Device
    <select id="pb-alsa-device"></select>
  </label>
  <label class="mcs-set-row">Track transition
    <select id="pb-mode">
      <option value="gapless">Gapless</option>
      <option value="crossfade">Crossfade</option>
    </select>
  </label>
  <label class="mcs-set-row" id="pb-cf-row" style="display:none">Crossfade duration
    <input type="range" id="pb-cf-secs" min="1" max="12" step="1" value="4">
    <span id="pb-cf-label">4s</span>
  </label>
  <label class="mcs-set-row">ReplayGain
    <select id="pb-replaygain">
      <option value="no">Off</option>
      <option value="track">Track</option>
      <option value="album">Album</option>
    </select>
  </label>
</div>
```

- [ ] **Step 2: Wire it in renderer.js**

Add near the other settings wiring (find with `grep -n "mcs-set-save-btn" src/renderer.js`):

```js
async function initPlaybackSettings() {
  const cfg = await window.api.playerGetConfig()
  const $ = id => document.getElementById(id)
  $('pb-output-mode').value = cfg.outputMode
  $('pb-mode').value = cfg.mode
  $('pb-cf-secs').value = cfg.crossfadeSecs
  $('pb-cf-label').textContent = `${cfg.crossfadeSecs}s`
  $('pb-replaygain').value = cfg.replaygain
  $('pb-device-row').style.display = cfg.outputMode === 'exclusive' ? '' : 'none'
  $('pb-cf-row').style.display = cfg.mode === 'crossfade' ? '' : 'none'

  const devices = await window.api.playerListDevices()
  $('pb-alsa-device').innerHTML = devices
    .filter(d => d.name.startsWith('alsa/'))
    .map(d => `<option value="${d.name}" ${d.name === cfg.alsaDevice ? 'selected' : ''}>${d.description}</option>`)
    .join('')

  const apply = (partial) => window.api.playerSetConfig(partial)
  $('pb-output-mode').onchange = e => {
    $('pb-device-row').style.display = e.target.value === 'exclusive' ? '' : 'none'
    apply({ outputMode: e.target.value, alsaDevice: $('pb-alsa-device').value || null })
  }
  $('pb-alsa-device').onchange = e => apply({ alsaDevice: e.target.value })
  $('pb-mode').onchange = e => {
    $('pb-cf-row').style.display = e.target.value === 'crossfade' ? '' : 'none'
    apply({ mode: e.target.value })
  }
  $('pb-cf-secs').oninput = e => { $('pb-cf-label').textContent = `${e.target.value}s` }
  $('pb-cf-secs').onchange = e => apply({ crossfadeSecs: Number(e.target.value) })
  $('pb-replaygain').onchange = e => apply({ replaygain: e.target.value })
}
```

Call `initPlaybackSettings()` from `init()` (renderer.js:506).

- [ ] **Step 3: Verify**

```bash
node --check src/renderer.js && npm test
```

`npm start` → Settings tab:
- Switch transition to Crossfade, play two tracks, skip → audible fade; switch back to Gapless → seamless album playback resumes after engine restart (position preserved).
- ReplayGain Track/Album applies without playback interruption.
- Output → Bit-perfect lists ALSA devices; selecting one restarts engine and resumes.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: playback settings — output mode, gapless/crossfade, ReplayGain"
```

---

### Task 8: mpv-missing blocking setup screen

**Files:**
- Modify: `src/index.html` (overlay markup)
- Modify: `src/styles.css` (overlay styles)
- Modify: `src/renderer.js` (show/hide + recheck)
- Modify: `main.js` (add `player-recheck` handler)
- Modify: `preload.js` (expose `playerRecheck`)

**Interfaces:**
- Consumes: `player-event` types `mpvMissing` / `engineFailed`; `playerGetStatus()`.
- Produces: full-screen overlay `#mpv-blocker` that blocks all interaction until mpv is available; `window.api.playerRecheck()` → main re-runs `initPlayer()` and returns `{ available }`.

- [ ] **Step 1: Markup + styles**

At the end of `<body>` in `src/index.html` (before scripts):

```html
<div id="mpv-blocker" class="mpv-blocker" style="display:none">
  <div class="mpv-blocker-card">
    <h2>Playback engine required</h2>
    <p>Papa Audio plays audio through <b>mpv</b>, which isn't installed (or keeps crashing).</p>
    <pre>sudo dnf install -y mpv</pre>
    <p class="mpv-blocker-hint">Debian/Ubuntu: <code>sudo apt install mpv</code> &middot; Arch: <code>sudo pacman -S mpv</code></p>
    <button id="mpv-recheck-btn">I installed it — check again</button>
    <p id="mpv-recheck-msg"></p>
  </div>
</div>
```

`src/styles.css`:

```css
.mpv-blocker { position: fixed; inset: 0; z-index: 9999; background: rgba(8,8,12,.96);
  display: flex; align-items: center; justify-content: center; }
.mpv-blocker-card { max-width: 460px; padding: 32px; background: #16161d; border-radius: 12px;
  text-align: center; }
.mpv-blocker-card pre { background: #000; padding: 12px; border-radius: 8px; user-select: all; }
.mpv-blocker-hint { opacity: .6; font-size: 12px; }
#mpv-recheck-btn { margin-top: 12px; padding: 10px 20px; border-radius: 8px; border: 0;
  background: var(--accent, #1db954); color: #000; font-weight: 600; cursor: pointer; }
```

- [ ] **Step 2: Recheck handler in main + preload**

`main.js` (in the player section from Task 5):

```js
ipcMain.handle('player-recheck', async () => {
  if (player) { player.stop(); player = null }
  await initPlayer()
  return { available: mpvAvailable && !!player }
})
```

`preload.js`: add `playerRecheck: () => ipcRenderer.invoke('player-recheck'),` next to the other player methods.

- [ ] **Step 3: Renderer wiring**

In `src/renderer.js` `init()` (renderer.js:506), add:

```js
const blocker = document.getElementById('mpv-blocker')
const showBlocker = show => { blocker.style.display = show ? 'flex' : 'none' }
window.api.on('player-event', ({ type }) => {
  if (type === 'mpvMissing' || type === 'engineFailed') showBlocker(true)
})
const status = await window.api.playerGetStatus()
if (!status.available) showBlocker(true)
document.getElementById('mpv-recheck-btn').onclick = async () => {
  const msg = document.getElementById('mpv-recheck-msg')
  msg.textContent = 'Checking…'
  const r = await window.api.playerRecheck()
  if (r.available) { showBlocker(false); msg.textContent = '' }
  else { msg.textContent = 'Still not found. Install mpv, then try again.' }
}
```

- [ ] **Step 4: Verify**

Temporarily rename the mpv binary lookup to simulate absence: launch with `PATH=/usr/bin-nonexistent npm start` is impractical for Electron; instead test by editing `detectMpv()` to `return false`, launch, confirm blocker shows and app is unusable behind it, revert the edit, click "check again" → blocker clears and playback works. Also `kill -9` the mpv PID 4+ times within a minute while playing → `engineFailed` → blocker appears.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: blocking setup screen when mpv is missing or unrecoverable"
```

---

### Task 9: Full QA pass + docs

**Files:**
- Modify: `CLAUDE.md` (stack section: mpv engine, purist mode, playerSettings)
- Modify: `docs/superpowers/plans/2026-07-04-mpv-audio-engine.md` (check off)

**Interfaces:** none.

- [ ] **Step 1: Run the manual QA checklist from the spec**

1. Gapless: play a live/DJ-mix album start to finish — zero audible seams at boundaries.
2. Crossfade: enable, shuffle across albums, manual skip — smooth fades, UI in sync.
3. ReplayGain: track mode on an RG-tagged album vs off — audible level normalization.
4. Exclusive ALSA: toggle on with a device, play hi-res FLAC, toggle back — resumes at position both ways.
5. Crash recovery: `pkill -9 -f 'papa-mpv'` once mid-song → playback resumes within ~2s at position.
6. MPRIS: play/pause/next from GNOME media controls + Strawberry-controls extension; seek from the MPRIS slider (fixed `media-seek` channel).
7. Resume: quit mid-song, relaunch → track loaded paused at saved position.
8. Agent tools: in chat, "pause", "set volume to 50%", "skip" still work (they drive the same `audio` shim).
9. `npm test` fully green including integration tests.
10. 30-minute listening session — no console errors, memory stable (`ps -o rss -p <pid>` roughly flat).

Record any failure as a bug, fix using superpowers:systematic-debugging before proceeding.

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md` Stack section add:

```markdown
- Playback: mpv engine (`mpv-engine.js`, JSON IPC) — NOT the <audio> element. Purist mode: no EQ, no visualizer. Settings in electron-store key `playerSettings`. Renderer talks to it via `src/player-shim.js` (`window.__papaPlayer`). mpv is a hard requirement (`dnf install mpv`).
```

And under behavior rules: `8. Never reintroduce Web Audio / AudioContext processing — playback must stay in mpv.`

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "docs: mpv engine QA pass complete, update agent instructions"
```

---

## Self-Review Notes

- **Spec coverage:** IPC client (T1), engine/gapless/respawn/exclusive (T2), crossfade (T3), EQ/viz removal (T4), main+preload IPC (T5), renderer swap + hi-res chip + media-seek fix (T6), settings UI + live/restart config (T7), hard-require blocker (T8), QA checklist + docs (T9). Windows bundling explicitly out of scope per spec.
- **Known judgment call:** MPRIS stays renderer-driven (`update-now-playing`), which the spec loosely wanted engine-fed; renderer state is now sourced from mpv via the shim, so accuracy is equivalent. Noted as an accepted deviation.
- **Line numbers** were sampled at commit `1fff792`; they drift — every renderer edit step includes a grep anchor.
