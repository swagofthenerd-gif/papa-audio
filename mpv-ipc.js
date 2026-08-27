'use strict'
const net = require('net')
const { EventEmitter } = require('events')

// One 2 s budget for every command was wrong in both directions. A loadfile of
// a 184 MB 24-bit 5.1 FLAC on a cold cache can exceed it, and the rejection was
// then indistinguishable from a real failure; meanwhile a get_property that
// takes 2 s means mpv is wedged, not busy, and waiting longer tells you nothing.
const COMMAND_TIMEOUT_MS = 5000
const TIMEOUTS = {
  loadfile: 20000,
  seek: 10000,
  'playlist-clear': 5000,
  'playlist-remove': 5000,
  'playlist-move': 5000,
  set_property: 5000,
  observe_property: 5000,
  request_log_messages: 5000,
  get_property: 2000,
}

// Commands where running twice is indistinguishable from running once, so a
// retry cannot make things worse. Everything else is deliberately absent:
// a timeout means no reply came, and a late reply plus a retry can double-apply
// something audible. loadfile in particular — a second replace restarts the
// track the user is listening to, and a second append queues it twice.
const IDEMPOTENT = new Set([
  'get_property', 'set_property', 'observe_property',
  'unobserve_property', 'request_log_messages',
])

// A malformed or hostile line must not be able to grow the buffer forever.
const MAX_BUFFER_BYTES = 1024 * 1024

function timeoutFor(args, overrides) {
  const name = args[0]
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name]
  if (overrides && typeof overrides.default === 'number') {
    return TIMEOUTS[name] === undefined ? overrides.default : TIMEOUTS[name]
  }
  return TIMEOUTS[name] ?? COMMAND_TIMEOUT_MS
}

function isRetryable(args) {
  if (!IDEMPOTENT.has(args[0])) return false
  // seek is idempotent only in absolute mode; relative seeks compound.
  if (args[0] === 'seek' && args[2] !== 'absolute') return false
  return true
}

class MpvIpcClient extends EventEmitter {
  // `opts.timeouts` overrides the per-command budgets. Tests use it so a 2 s
  // get_property budget does not cost 2 s of test time; nothing else should.
  constructor(socketPath, opts = {}) {
    super()
    this.socketPath = socketPath
    this._timeouts = opts.timeouts || null
    this.socket = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    // Requests that timed out. If mpv answers late, that reply is evidence the
    // command actually ran — dropping it silently made a slow loadfile look like
    // a failure while mpv was already playing the file.
    this._abandoned = new Map()
    this._lastConnectError = null
    this._droppedBytes = 0
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
        sock.once('error', err => {
          sock.destroy()
          // Keeping the last error turns "mpv socket not ready" into something
          // that says whether it was ENOENT (mpv never created it) or ECONNREFUSED
          // (it exists but nothing is listening) — different faults entirely.
          this._lastConnectError = err
          if (Date.now() - started > timeoutMs) {
            const why = err && (err.code || err.message) ? ` (last error: ${err.code || err.message})` : ''
            reject(new Error(`mpv socket not ready: ${this.socketPath}${why}`))
          } else {
            setTimeout(tryConnect, 100)
          }
        })
      }
      tryConnect()
    })
  }

  command(...args) {
    return this._send(args, isRetryable(args))
  }

  _send(args, mayRetry) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('not connected'))
        return
      }
      const requestId = this.nextId++
      const budget = timeoutFor(args, this._timeouts)
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this._abandoned.set(requestId, { args, at: Date.now() })
        // Only the last 32 matter; this is for correlation, not bookkeeping.
        if (this._abandoned.size > 32) {
          this._abandoned.delete(this._abandoned.keys().next().value)
        }
        const err = new Error(`mpv command timeout after ${budget}ms: ${JSON.stringify(args)}`)
        err.code = 'MPV_TIMEOUT'
        if (mayRetry) {
          this.emit('retry', { args, after: budget })
          this._send(args, false).then(resolve, reject)
        } else {
          reject(err)
        }
      }, budget)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.socket.write(JSON.stringify({ command: args, request_id: requestId }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(e)
      }
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
      } else if (msg.request_id && this._abandoned.has(msg.request_id)) {
        // mpv was slow, not broken. Whoever asked has already been told it
        // failed, so this cannot be resolved — but it must be reported, because
        // it means the command DID run and the app's idea of state is wrong.
        const late = this._abandoned.get(msg.request_id)
        this._abandoned.delete(msg.request_id)
        this.emit('lateReply', {
          args: late.args,
          afterMs: Date.now() - late.at,
          ok: msg.error === 'success',
          error: msg.error === 'success' ? null : msg.error,
          data: msg.data ?? null,
        })
      } else if (msg.event) {
        this.emit('event', msg)
      }
    }
    // No newline in a megabyte is not a long line, it is a broken stream.
    // Drop it and resync at the next newline rather than growing without limit.
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this._droppedBytes += this.buffer.length
      this.emit('overflow', { dropped: this.buffer.length, totalDropped: this._droppedBytes })
      this.buffer = ''
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

module.exports = { MpvIpcClient, COMMAND_TIMEOUT_MS, TIMEOUTS, MAX_BUFFER_BYTES }
