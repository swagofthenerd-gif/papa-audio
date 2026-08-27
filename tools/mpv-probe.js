#!/usr/bin/env node
'use strict'
// Ground truth for playback state: mpv's own IPC socket, read directly.
//
// The lesson from two QA rounds is that the UI's claims are not evidence. This
// asks mpv. It shares no code with the app's engine on purpose — a probe that
// reuses the thing under test can agree with it while both are wrong.
//
//   tools/mpv-probe.js                     # find the socket, dump key state
//   tools/mpv-probe.js --get pause         # one property, raw
//   tools/mpv-probe.js --watch             # follow position until interrupted
//   tools/mpv-probe.js --socket /path.sock # pin the socket explicitly
//   tools/mpv-probe.js --json              # machine-readable, for scripts

const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')

const RUNTIME = process.env.XDG_RUNTIME_DIR || os.tmpdir()
const PROPS = [
  'path', 'media-title', 'pause', 'time-pos', 'duration', 'idle-active', 'core-idle',
  'eof-reached', 'seekable', 'volume', 'audio-device', 'audio-params',
  'demuxer-cache-time', 'playlist-count', 'playlist-pos', 'filename',
]

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const has = name => process.argv.includes(name)

// Newest first: after a respawn the stale socket file can still be on disk.
function findSockets() {
  let entries
  try { entries = fs.readdirSync(RUNTIME) } catch { return [] }
  return entries
    .filter(f => /^papa-mpv-.*\.sock$/.test(f))
    .map(f => path.join(RUNTIME, f))
    .map(p => { try { return { p, m: fs.statSync(p).mtimeMs } } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .map(x => x.p)
}

function connect(sockPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath)
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`timed out connecting to ${sockPath}`)) }, timeoutMs)
    s.once('connect', () => { clearTimeout(timer); s.setEncoding('utf8'); resolve(s) })
    s.once('error', e => { clearTimeout(timer); reject(e) })
  })
}

function makeClient(sock) {
  let id = 1
  const pending = new Map()
  const eventHandlers = []
  let buf = ''
  sock.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.request_id && pending.has(msg.request_id)) {
        const { resolve } = pending.get(msg.request_id)
        pending.delete(msg.request_id)
        resolve(msg.error === 'success' ? msg.data : { __error: msg.error })
      } else if (msg.event) {
        for (const h of eventHandlers) h(msg)
      }
    }
  })
  return {
    command(...args) {
      return new Promise((resolve, reject) => {
        const rid = id++
        const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`no reply to ${JSON.stringify(args)} in 3s — mpv is wedged, not just quiet`)) }, 3000)
        pending.set(rid, { resolve: v => { clearTimeout(timer); resolve(v) } })
        sock.write(JSON.stringify({ command: args, request_id: rid }) + '\n')
      })
    },
    onEvent: h => eventHandlers.push(h),
  }
}

async function main() {
  const pinned = argOf('--socket')
  const sockets = pinned ? [pinned] : findSockets()
  if (!sockets.length) {
    console.error(`no papa-mpv-*.sock in ${RUNTIME} — mpv is not running, or the app never spawned it`)
    process.exit(2)
  }
  const sockPath = sockets[0]
  if (!has('--json')) {
    console.error(`# socket: ${sockPath}${sockets.length > 1 ? `  (${sockets.length - 1} older also present)` : ''}`)
  }
  const sock = await connect(sockPath)
  const c = makeClient(sock)

  const one = argOf('--get')
  if (one) {
    const v = await c.command('get_property', one)
    console.log(typeof v === 'string' ? v : JSON.stringify(v))
    sock.destroy()
    return
  }

  const out = {}
  for (const p of PROPS) {
    try { out[p] = await c.command('get_property', p) } catch (e) { out[p] = { __error: String(e.message || e) } }
  }

  if (has('--json')) {
    console.log(JSON.stringify({ socket: sockPath, props: out }, null, 2))
  } else {
    const fmt = v => v && v.__error ? `<${v.__error}>` : (typeof v === 'object' ? JSON.stringify(v) : String(v))
    for (const p of PROPS) console.log(`${p.padEnd(20)} ${fmt(out[p])}`)
    // The combination that matters: mpv idle while the app thinks it is playing
    // is the exact silent-stop signature.
    if (out['idle-active'] === true) {
      console.log('\n!! mpv is IDLE — nothing is loaded. If the UI shows a track playing, that is the bug.')
    }
  }

  if (has('--watch')) {
    console.error('# watching; Ctrl-C to stop')
    c.onEvent(e => {
      if (e.event === 'property-change') console.log(`${new Date().toISOString()} ${e.name}=${JSON.stringify(e.data)}`)
      else console.log(`${new Date().toISOString()} EVENT ${JSON.stringify(e)}`)
    })
    let oid = 1
    for (const p of ['time-pos', 'pause', 'path', 'idle-active']) await c.command('observe_property', oid++, p)
    await c.command('request_log_messages', 'warn')
    return // hold the socket open
  }
  sock.destroy()
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1) })
