'use strict'
const fs = require('fs')
const path = require('path')

// A key that is written often, or is large, does not belong in the single
// electron-store config file.
//
// electron-store serialises and fsyncs the WHOLE config on every set. With a
// 2.5 MB config that makes a 200-byte playback position cost 2.5 MB of
// synchronous disk I/O — on the one thread that also drives mpv's IPC, every
// other handler and the window. Five of those keys account for nearly all of
// the file and nearly all of the writes.
//
// So: one small file per key, read once synchronously (the IPC handlers that
// serve them are synchronous), written asynchronously, coalesced, and replaced
// atomically so a crash mid-write cannot leave a half-written file behind.

const DEBOUNCE_MS = 400
// A debounce alone can be postponed indefinitely by a steady stream of writes —
// exactly the bug catalogued for the library watcher. This is the ceiling: once
// a value has been waiting this long it is written regardless.
const MAX_DELAY_MS = 4000

class SideStore {
  constructor(opts = {}) {
    if (!opts.dir || !opts.name) throw new Error('SideStore needs a dir and a name')
    this.dir = opts.dir
    this.name = opts.name
    this.file = path.join(opts.dir, `${opts.name}.json`)
    this.tmp = `${this.file}.tmp`
    // flushSync writes to a DIFFERENT tmp path so it can never interleave with
    // the async writer's rename on the shared tmp — two writers on one tmp is
    // how a file ends up holding neither value.
    this.tmpSync = `${this.file}.sync`
    this._fallback = opts.fallback === undefined ? null : opts.fallback
    this._debounceMs = opts.debounceMs ?? DEBOUNCE_MS
    this._maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS
    this._onError = opts.onError || (() => {})
    this._value = undefined          // undefined = not loaded yet
    this._timer = null
    this._firstDirtyAt = 0
    this._writing = null             // the in-flight write, if any
    this._pendingAfterWrite = false
    // A monotonic counter bumped every time the value is dirtied. The async
    // writer captures the seq of the value it is about to persist; flushSync
    // records the seq it lands under. A completing async write then refuses to
    // rename stale content over a newer value that flushSync already wrote.
    this._writeSeq = 0
    this._flushedSeq = 0
    this.stats = { loads: 0, writes: 0, coalesced: 0, errors: 0 }
  }

  fileExists() {
    try { return fs.statSync(this.file).isFile() } catch { return false }
  }

  // Synchronous on purpose, and only once: the handlers that read these are
  // synchronous, and a single read at startup is not the problem being solved.
  _load() {
    if (this._value !== undefined) return
    this.stats.loads++
    try {
      this._value = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // A corrupt file must not take the app down, and must not be silently
        // overwritten either — say so, then start from the fallback.
        //
        // Saying so was not enough. The fallback was adopted in memory and the
        // very next write replaced the unreadable file with it, so a half-written
        // play-history.json became an empty one and two thousand plays were gone
        // with only a console line to show for it. The file is moved aside first,
        // so whatever survived in it is still there to be recovered by hand.
        // video-store.js already does this for a far less precious store.
        this.stats.errors++
        let kept = null
        try {
          kept = `${this.file}.corrupt-${Date.now()}`
          fs.renameSync(this.file, kept)
        } catch (_) { kept = null }
        this._onError(new Error(
          `${this.name}: unreadable (${e.code || e.message}); starting from the default` +
          (kept ? `. The unreadable file was kept at ${kept}` : '')
        ))
      }
      this._value = this._fallback
    }
  }

  get() {
    this._load()
    return this._value
  }

  set(value) {
    this._load()
    this._value = value
    this._schedule()
  }

  // Read-modify-write against the in-memory value, so callers never race the
  // file. Returns the new value.
  update(fn) {
    this._load()
    this._value = fn(this._value)
    this._schedule()
    return this._value
  }

  _schedule() {
    const now = Date.now()
    this._writeSeq++
    if (!this._firstDirtyAt) this._firstDirtyAt = now
    if (this._timer) {
      this.stats.coalesced++
      // Past the ceiling, stop deferring: a steady stream of writes must not be
      // able to postpone the write forever.
      if (now - this._firstDirtyAt >= this._maxDelayMs) return
      clearTimeout(this._timer)
    }
    this._timer = setTimeout(() => this._write(), this._debounceMs)
    this._timer.unref?.()
  }

  async _write() {
    this._timer = null
    this._firstDirtyAt = 0
    // One write at a time. A second value arriving mid-write is written after,
    // never concurrently — two writers racing on one rename is how a file ends
    // up holding neither value.
    if (this._writing) { this._pendingAfterWrite = true; return this._writing }
    const value = this._value
    const seq = this._writeSeq
    this._writing = (async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true })
        await fs.promises.writeFile(this.tmp, JSON.stringify(value), 'utf8')
        // A flushSync on the way out may have landed a newer value on the real
        // file while this write was in flight. Renaming our now-stale tmp over
        // it would undo the shutdown save — so drop it instead. The tmp is
        // cleaned up rather than left behind.
        if (this._flushedSeq >= seq) {
          try { await fs.promises.unlink(this.tmp) } catch { /* nothing to clean up */ }
          return
        }
        await fs.promises.rename(this.tmp, this.file)
        this.stats.writes++
      } catch (e) {
        this.stats.errors++
        this._onError(new Error(`${this.name}: write failed (${(e && e.code) || (e && e.message)})`))
        try { await fs.promises.unlink(this.tmp) } catch { /* nothing to clean up */ }
      } finally {
        this._writing = null
      }
    })()
    await this._writing
    if (this._pendingAfterWrite) {
      this._pendingAfterWrite = false
      // The value changed while we were writing; the newest one still has to land.
      if (this._value !== value) await this._write()
    }
  }

  // The one place a synchronous write is the right answer: the process is
  // exiting, so there is no UI left to block and no later chance to write.
  // Called from will-quit and the signal handler, which cannot await.
  flushSync() {
    if (!this._timer && !this._writing) return false
    clearTimeout(this._timer)
    this._timer = null
    this._firstDirtyAt = 0
    // The value being flushed carries the current seq; recording it stops a
    // still-in-flight async write from renaming its older tmp over this newer
    // one after we return.
    const seq = this._writeSeq
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      // A DIFFERENT tmp path from the async writer's (this.tmp), so a rename
      // here can never collide with an async write mid-flight on the same file.
      fs.writeFileSync(this.tmpSync, JSON.stringify(this._value), 'utf8')
      fs.renameSync(this.tmpSync, this.file)
      this._flushedSeq = seq
      this.stats.writes++
      return true
    } catch (e) {
      this.stats.errors++
      this._onError(new Error(`${this.name}: shutdown write failed (${(e && e.code) || (e && e.message)})`))
      try { fs.unlinkSync(this.tmpSync) } catch { /* nothing to clean up */ }
      return false
    }
  }

  // For shutdown, and for tests. Writes anything outstanding and waits.
  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; await this._write() }
    if (this._writing) await this._writing
  }

  // Migration. Adopts a value that used to live in the shared config, but only
  // when this store has no file of its own — so a second run cannot resurrect
  // stale data over what the app has since written.
  adoptIfEmpty(legacyValue) {
    if (this.fileExists()) return false
    if (legacyValue === undefined || legacyValue === null) return false
    this.set(legacyValue)
    return true
  }
}

module.exports = { SideStore, DEBOUNCE_MS, MAX_DELAY_MS }
