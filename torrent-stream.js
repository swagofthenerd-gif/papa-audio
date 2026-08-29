'use strict'
const { EventEmitter } = require('node:events')

function buildFileUrl(port, fileIndex, fileName) {
  return `http://127.0.0.1:${port}/${fileIndex}/${encodeURIComponent(fileName)}`
}

class TorrentStreamer extends EventEmitter {
  constructor({ client, timeoutMs = 20000 } = {}) {
    super()
    if (!client || typeof client.add !== 'function') {
      throw new TypeError('TorrentStreamer requires a webtorrent client with an add() method')
    }
    this.client = client
    this.timeoutMs = timeoutMs
    this._torrent = null
    this._server = null
    this._timer = null
    this._settled = false
    this._pendingReject = null
    this._onDownload = () => {
      const torrent = this._torrent
      if (!torrent) return
      const downloaded = torrent.downloaded ?? 0
      const total = torrent.length ?? 0
      this.emit('progress', {
        downloaded,
        total,
        speed: torrent.downloadSpeed ?? 0,
        percent: total ? downloaded / total : 0,
      })
    }
  }

  static buildFileUrl(port, fileIndex, fileName) {
    return buildFileUrl(port, fileIndex, fileName)
  }

  async start({ magnet, fileIndex = 0 } = {}) {
    this.stop()
    this._settled = false
    return new Promise((resolve, reject) => {
      this._pendingReject = reject
      this._timer = setTimeout(() => this._onTimeout(reject), this.timeoutMs)

      let torrent
      try {
        torrent = this.client.add(magnet, t => this._onReady(t, fileIndex, resolve, reject))
      } catch (err) {
        this._settle(reject, { code: 'CLIENT_ERROR', message: err.message })
        return
      }
      if (torrent) this._torrent = torrent
    })
  }

  _onReady(torrent, fileIndex, resolve, reject) {
    if (this._settled) return
    this._torrent = torrent

    const file = torrent && torrent.files && torrent.files[fileIndex]
    if (!file) {
      this._settle(reject, { code: 'NO_FILE', message: `No file at index ${fileIndex}` })
      return
    }

    let server
    try {
      server = torrent.createServer()
    } catch (err) {
      this._settle(reject, { code: 'SERVER_ERROR', message: err.message })
      return
    }

    this._server = server
    server.once('error', err => {
      this._settle(reject, { code: 'SERVER_ERROR', message: err.message })
    })
    server.listen(0, '127.0.0.1', () => {
      if (this._settled) {
        try { server.close(() => {}) } catch {}
        return
      }
      const port = server.address().port
      const url = buildFileUrl(port, fileIndex, file.name)
      torrent.on('download', this._onDownload)
      this._settled = true
      this._pendingReject = null
      this._clearTimer()
      this.emit('ready', { url })
      resolve({ url })
    })
  }

  _onTimeout(reject) {
    if (this._settled) return
    const torrent = this._torrent
    this._torrent = null
    if (this._server) {
      try { this._server.close(() => {}) } catch {}
      this._server = null
    }
    this._settle(reject, { code: 'NO_SEEDERS', message: `No seeders after ${this.timeoutMs}ms` })
    if (torrent) {
      try { torrent.destroy(() => {}) } catch {}
    }
  }

  _settle(reject, err) {
    if (this._settled) return
    this._settled = true
    this._pendingReject = null
    this._clearTimer()
    if (this.listenerCount('error') > 0) {
      this.emit('error', err)
    }
    reject(err)
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  stop() {
    this._settled = true
    this._clearTimer()
    const server = this._server
    this._server = null
    if (server) {
      try { server.close(() => {}) } catch {}
    }
    const torrent = this._torrent
    this._torrent = null
    if (torrent) {
      try { torrent.removeListener('download', this._onDownload) } catch {}
      try { torrent.destroy(() => {}) } catch {}
    }
    // A caller awaiting start() must not hang forever when stop() races the
    // 'ready' callback. Settle the pending promise with a deliberate, distinct
    // code so the caller can tell a stop apart from a real failure.
    const reject = this._pendingReject
    this._pendingReject = null
    if (reject) reject({ code: 'STOPPED', message: 'stopped before ready' })
  }
}

module.exports = { TorrentStreamer, buildFileUrl }
