'use strict'
// An incremental index of a fragmented MP4 as it streams out of ffmpeg: the
// byte length of the init segment (ftyp + moov), the video track's timescale,
// and for every fragment its start time (seconds) and byte offset. With it the
// stream server can serve an already-converted span from disk — a seek back
// into what has played is a file read, not a second ffmpeg run. Pure; fed
// Buffers in any chunking; tested in test/fmp4-index.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaFmp4Index = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  function create() {
    let pending = []        // buffered bytes not yet consumed
    let pendingLen = 0
    let pos = 0             // absolute offset of pending[0]
    const st = { initLength: 0, timescale: 0, trackId: 0, fragments: [], bytes: 0, ready: false }

    function _peek(n) {
      if (pendingLen < n) return null
      if (pending.length === 1) return pending[0].subarray(0, n)
      const b = Buffer.concat(pending, pendingLen)
      pending = [b]
      return b.subarray(0, n)
    }
    function _take(n) {
      let out = Buffer.concat(pending, pendingLen).subarray(0, n)
      const all = Buffer.concat(pending, pendingLen)
      pending = all.length > n ? [all.subarray(n)] : []
      pendingLen = all.length - n
      pos += n
      return out
    }
    function _drop(n) { _take(n) }

    // moov → trak → tkhd: the id of the first track (the video, mapped first).
    // Fragments of other tracks (ffmpeg writes audio-only moofs too) are on a
    // different clock and must not be indexed.
    function _trackIdOf(moov) {
      let off = 8
      while (off + 8 <= moov.length) {
        const size = moov.readUInt32BE(off), type = moov.toString('latin1', off + 4, off + 8)
        if (size < 8) break
        if (type === 'trak') {
          const trak = moov.subarray(off, off + size)
          let o2 = 8
          while (o2 + 8 <= trak.length) {
            const s2 = trak.readUInt32BE(o2), t2 = trak.toString('latin1', o2 + 4, o2 + 8)
            if (s2 < 8) break
            if (t2 === 'tkhd') {
              const v = trak[o2 + 8]
              // version 0: flags(3) ctime(4) mtime(4) track_ID; version 1: 8-byte times.
              return v === 1 ? trak.readUInt32BE(o2 + 8 + 4 + 8 + 8) : trak.readUInt32BE(o2 + 8 + 4 + 4 + 4)
            }
            o2 += s2
          }
          return 0
        }
        off += size
      }
      return 0
    }
    // moov → trak → mdia → mdhd: the timescale of the first track (the video,
    // which is mapped first). tfdt in its traf is on the same clock.
    function _timescaleOf(moov) {
      let off = 8
      while (off + 8 <= moov.length) {
        const size = moov.readUInt32BE(off), type = moov.toString('latin1', off + 4, off + 8)
        if (size < 8) break
        if (type === 'trak') {
          const trak = moov.subarray(off, off + size)
          let o2 = 8
          while (o2 + 8 <= trak.length) {
            const s2 = trak.readUInt32BE(o2), t2 = trak.toString('latin1', o2 + 4, o2 + 8)
            if (s2 < 8) break
            if (t2 === 'mdia') {
              const mdia = trak.subarray(o2, o2 + s2)
              let o3 = 8
              while (o3 + 8 <= mdia.length) {
                const s3 = mdia.readUInt32BE(o3), t3 = mdia.toString('latin1', o3 + 4, o3 + 8)
                if (s3 < 8) break
                if (t3 === 'mdhd') {
                  const v = mdia[o3 + 8]
                  return v === 1 ? mdia.readUInt32BE(o3 + 8 + 4 + 8 + 8) : mdia.readUInt32BE(o3 + 8 + 4 + 4 + 4)
                }
                o3 += s3
              }
            }
            o2 += s2
          }
          return 0
        }
        off += size
      }
      return 0
    }

    // moof → traf (of the indexed track, by tfhd track_ID) → tfdt: the
    // fragment's base decode time. null when this moof carries no fragment
    // of that track.
    function _tfdtOf(moof) {
      let off = 8
      while (off + 8 <= moof.length) {
        const size = moof.readUInt32BE(off), type = moof.toString('latin1', off + 4, off + 8)
        if (size < 8) break
        if (type === 'traf') {
          let o2 = off + 8
          const end = off + size
          let trackId = null, tfdt = null
          while (o2 + 8 <= end) {
            const s2 = moof.readUInt32BE(o2), t2 = moof.toString('latin1', o2 + 4, o2 + 8)
            if (s2 < 8) break
            if (t2 === 'tfhd') trackId = moof.readUInt32BE(o2 + 12)
            if (t2 === 'tfdt') {
              const v = moof[o2 + 8]
              tfdt = v === 1 ? Number(moof.readBigUInt64BE(o2 + 12)) : moof.readUInt32BE(o2 + 12)
            }
            o2 += s2
          }
          if (tfdt != null && (!st.trackId || trackId === st.trackId)) return tfdt
        }
        off += size
      }
      return null
    }

    // Feed the next chunk. Returns the fragments discovered in this call.
    function push(chunk) {
      if (!chunk || !chunk.length) return []
      pending.push(chunk); pendingLen += chunk.length; st.bytes += chunk.length
      const found = []
      for (;;) {
        const head = _peek(8)
        if (!head) break
        let size = head.readUInt32BE(0)
        const type = head.toString('latin1', 4, 8)
        let hdr = 8
        if (size === 1) {
          const big = _peek(16)
          if (!big) break
          size = Number(big.readBigUInt64BE(8)); hdr = 16
        } else if (size === 0) { size = pendingLen } // to end of stream
        if (size < hdr) { _drop(hdr); continue }
        if (type === 'moof') {
          if (pendingLen < size) break
          const start = pos
          const moof = _take(size)
          const t = _tfdtOf(moof)
          if (t != null) {
            const f = { time: st.timescale ? t / st.timescale : 0, offset: start }
            st.fragments.push(f); found.push(f)
          }
          continue
        }
        if (type === 'moov') {
          if (pendingLen < size) break
          const moov = _take(size)
          st.timescale = _timescaleOf(moov) || st.timescale
          st.trackId = _trackIdOf(moov) || st.trackId
          st.initLength = pos
          st.ready = true
          continue
        }
        if (type === 'ftyp') {
          if (pendingLen < size) break
          _drop(size); continue
        }
        // mdat and anything else: skip whole boxes without holding their bytes.
        if (pendingLen >= size) { _drop(size); continue }
        // A box larger than what we hold: consume what we have and remember the rest.
        const remain = size - pendingLen
        _drop(pendingLen)
        skipping = remain
        break
      }
      if (skipping > 0) return found
      return found
    }

    // Large mdat boxes arrive over many chunks; the remainder is swallowed
    // before parsing resumes.
    let skipping = 0
    const rawPush = push
    function pushChunk(chunk) {
      if (!chunk || !chunk.length) return []
      if (skipping > 0) {
        if (chunk.length <= skipping) { skipping -= chunk.length; pos += chunk.length; st.bytes += chunk.length; return [] }
        const rest = chunk.subarray(skipping)
        pos += skipping; st.bytes += skipping; skipping = 0
        return rawPush(rest)
      }
      return rawPush(chunk)
    }

    // The last fragment whose start is at or before `sec`, or null.
    function fragmentAt(sec) {
      let best = null
      for (const f of st.fragments) { if (f.time <= sec + 1e-6) best = f; else break }
      return best
    }
    // Seconds covered so far: the start of the last fragment (its own length
    // is unknown until the next arrives, so this is conservative).
    function coveredSec() { return st.fragments.length ? st.fragments[st.fragments.length - 1].time : 0 }

    return { push: pushChunk, fragmentAt, coveredSec, state: st }
  }
  return { create }
})
