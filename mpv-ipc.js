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
