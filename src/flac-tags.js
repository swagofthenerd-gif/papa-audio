'use strict';
// A minimal, spec-correct FLAC VORBIS_COMMENT writer, in pure Node — no ffmpeg,
// no native addon, no npm dependency (the W2 contract forbids new installs, and
// the only metadata dependency present, music-metadata, is read-only).
//
// Why hand-roll it: 82% of the library is FLAC, and the one thing the tag-fixer
// APPLY step (roadmap #9) needs is to rewrite genre/title/artist/album/year on
// FLAC files safely. FLAC's container is simple enough that a correct writer is
// a few hundred lines, and owning it means the write path has no external
// process to spawn, time out, or misparse.
//
// The format (per the FLAC spec, xiph.org/flac/format.html):
//   "fLaC"  — 4-byte stream marker
//   then a sequence of METADATA_BLOCKs, each:
//     1 byte header:  bit7 = last-block flag, bits6..0 = block type
//     3 bytes:        big-endian length of the block body
//     <length> bytes: the block body
//   Block type 4 is VORBIS_COMMENT. Type 0 is STREAMINFO (always first).
//
// The VORBIS_COMMENT body is LITTLE-endian (Vorbis heritage), unlike every
// other FLAC integer, which is big-endian — the single most common way a
// hand-written FLAC tagger corrupts a file:
//   u32  vendor length
//   ...  vendor string (UTF-8)
//   u32  comment count
//   for each: u32 length, then "KEY=value" (UTF-8), KEY case-insensitive
//
// Write discipline: parse the existing blocks, replace (or insert) the single
// VORBIS_COMMENT block, re-emit the whole file to a temp path in the SAME
// directory, fsync, then atomic-rename over the original. The original is never
// truncated in place, so a crash mid-write leaves the intact original behind.
//
// UMD-wrapped like the other src/ modules so it loads as a classic script in the
// renderer and as a CommonJS module in main / tests without leaking globals.
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('fs') : null,
    typeof require === 'function' ? require('path') : null,
    typeof require === 'function' ? require('crypto') : null
  )
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaFlacTags = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fs, path, crypto) {

  const BLOCK_STREAMINFO = 0
  const BLOCK_PADDING = 1
  const BLOCK_VORBIS_COMMENT = 4

  const MAGIC = Buffer.from('fLaC', 'ascii')

  // The change fields the fixer surfaces, mapped to their canonical Vorbis
  // comment keys. `year` is stored under DATE, which is the Vorbis field for it.
  const FIELD_TO_KEY = {
    title: 'TITLE',
    artist: 'ARTIST',
    album: 'ALBUM',
    genre: 'GENRE',
    year: 'DATE',
  }

  const VENDOR = 'Papa Audio FLAC tagger'

  function _isFlacBuffer(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 4 && buf.slice(0, 4).equals(MAGIC)
  }

  // Walk the metadata block chain and return { blocks, audioStart }. Each block
  // is { type, last, body }. `audioStart` is the byte offset where the framed
  // audio begins (right after the last metadata block). Throws on anything that
  // is not a well-formed FLAC header, so the caller can skip the file rather
  // than write garbage.
  function _parseBlocks(buf) {
    if (!_isFlacBuffer(buf)) throw new Error('not a FLAC stream (missing fLaC marker)')
    const blocks = []
    let off = 4
    let sawLast = false
    while (!sawLast) {
      if (off + 4 > buf.length) throw new Error('truncated metadata header')
      const header = buf[off]
      const last = (header & 0x80) !== 0
      const type = header & 0x7f
      const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]
      const bodyStart = off + 4
      const bodyEnd = bodyStart + len
      if (bodyEnd > buf.length) throw new Error('metadata block runs past end of file')
      blocks.push({ type, last, body: buf.slice(bodyStart, bodyEnd) })
      off = bodyEnd
      sawLast = last
    }
    if (!blocks.length || blocks[0].type !== BLOCK_STREAMINFO) {
      throw new Error('first metadata block is not STREAMINFO')
    }
    return { blocks, audioStart: off }
  }

  // Parse a VORBIS_COMMENT body into { vendor, comments:[{key,value}] }. The
  // body is little-endian. A malformed body yields empty comments rather than
  // throwing — a garbled existing tag must not stop us writing a clean one.
  function _parseVorbis(body) {
    const out = { vendor: VENDOR, comments: [] }
    try {
      let p = 0
      const vlen = body.readUInt32LE(p); p += 4
      out.vendor = body.slice(p, p + vlen).toString('utf8'); p += vlen
      const count = body.readUInt32LE(p); p += 4
      for (let i = 0; i < count; i++) {
        const clen = body.readUInt32LE(p); p += 4
        const raw = body.slice(p, p + clen).toString('utf8'); p += clen
        const eq = raw.indexOf('=')
        if (eq < 0) continue
        out.comments.push({ key: raw.slice(0, eq), value: raw.slice(eq + 1) })
      }
    } catch (_) {
      out.comments = []
    }
    return out
  }

  // Serialise { vendor, comments } back into a little-endian VORBIS_COMMENT body.
  function _buildVorbisBody(vorbis) {
    const vendor = Buffer.from(vorbis.vendor || VENDOR, 'utf8')
    const parts = []
    const head = Buffer.alloc(4)
    head.writeUInt32LE(vendor.length, 0)
    parts.push(head, vendor)
    const countBuf = Buffer.alloc(4)
    countBuf.writeUInt32LE(vorbis.comments.length, 0)
    parts.push(countBuf)
    for (const c of vorbis.comments) {
      const entry = Buffer.from(`${c.key}=${c.value}`, 'utf8')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(entry.length, 0)
      parts.push(len, entry)
    }
    return Buffer.concat(parts)
  }

  // Apply the changes to the parsed comment list. Case-insensitive on the key
  // (Vorbis keys are case-insensitive), so an existing lower-case "genre" is
  // replaced rather than duplicated. An empty-string value clears the field
  // (drops every occurrence); a non-empty value collapses to a single entry.
  function _applyChanges(comments, changes) {
    let next = comments.slice()
    for (const field of Object.keys(changes || {})) {
      const key = FIELD_TO_KEY[field]
      if (!key) continue // unknown field — ignore rather than write a junk key
      const raw = changes[field]
      const value = raw == null ? '' : String(raw)
      // Drop every existing spelling of this key first.
      next = next.filter(c => c.key.toUpperCase() !== key)
      // Empty means "clear it"; anything else writes exactly one entry.
      if (value !== '') next.push({ key, value })
    }
    return next
  }

  // Re-emit the whole file: magic + every metadata block (VORBIS_COMMENT
  // replaced/inserted, PADDING dropped since our block is now a different size)
  // + the original audio frames. Returns a Buffer.
  function _reassemble(buf, parsed, newVorbisBody) {
    const kept = []
    let hadVorbis = false
    for (const b of parsed.blocks) {
      if (b.type === BLOCK_VORBIS_COMMENT) {
        kept.push({ type: BLOCK_VORBIS_COMMENT, body: newVorbisBody })
        hadVorbis = true
      } else if (b.type === BLOCK_PADDING) {
        // Padding is re-added below as one trailing block; drop the originals so
        // the file does not grow a padding block per rewrite.
        continue
      } else {
        kept.push({ type: b.type, body: b.body })
      }
    }
    if (!hadVorbis) {
      // Insert right after STREAMINFO (index 0), which is where taggers expect it.
      kept.splice(1, 0, { type: BLOCK_VORBIS_COMMENT, body: newVorbisBody })
    }
    // A small padding block keeps future single-field edits cheap for other
    // tools; harmless and standard. Fixed, modest size.
    kept.push({ type: BLOCK_PADDING, body: Buffer.alloc(256) })

    const out = [MAGIC]
    for (let i = 0; i < kept.length; i++) {
      const b = kept[i]
      const last = i === kept.length - 1
      if (b.body.length > 0xffffff) throw new Error('metadata block too large to frame')
      const header = Buffer.alloc(4)
      header[0] = (last ? 0x80 : 0x00) | (b.type & 0x7f)
      header[1] = (b.body.length >> 16) & 0xff
      header[2] = (b.body.length >> 8) & 0xff
      header[3] = b.body.length & 0xff
      out.push(header, b.body)
    }
    out.push(buf.slice(parsed.audioStart))
    return Buffer.concat(out)
  }

  // Pure core: given the original file bytes and a changes object, return the
  // rewritten bytes. Exposed for tests so the byte-shuffling can be exercised
  // without touching a real disk. Throws on a non-FLAC or malformed input.
  function rewriteBuffer(buf, changes) {
    const parsed = _parseBlocks(buf)
    let vorbis = { vendor: VENDOR, comments: [] }
    for (const b of parsed.blocks) {
      if (b.type === BLOCK_VORBIS_COMMENT) { vorbis = _parseVorbis(b.body); break }
    }
    vorbis.comments = _applyChanges(vorbis.comments, changes)
    const body = _buildVorbisBody(vorbis)
    return _reassemble(buf, parsed, body)
  }

  // Read the comments out of a FLAC buffer as a plain { KEY: value } map (last
  // occurrence wins). For tests and read-back verification.
  function readComments(buf) {
    const parsed = _parseBlocks(buf)
    const map = {}
    for (const b of parsed.blocks) {
      if (b.type !== BLOCK_VORBIS_COMMENT) continue
      const v = _parseVorbis(b.body)
      for (const c of v.comments) map[c.key.toUpperCase()] = c.value
      break
    }
    return map
  }

  function isFlacPath(filePath) {
    return /\.flac$/i.test(String(filePath || ''))
  }

  // Write the changes to one FLAC file on disk with .bak temp-write-rename
  // discipline: the rewritten bytes go to a hidden temp file in the same
  // directory, are fsync'd, then atomically renamed over the original. On any
  // failure the temp file is removed and the original is left untouched.
  // Returns { ok } or { ok:false, reason }.
  function writeFileTags(filePath, changes) {
    if (!fs || !path || !crypto) return { ok: false, reason: 'no filesystem available' }
    if (!isFlacPath(filePath)) return { ok: false, reason: 'unsupported' }
    let buf
    try { buf = fs.readFileSync(filePath) } catch (e) { return { ok: false, reason: e.message } }
    if (!_isFlacBuffer(buf)) return { ok: false, reason: 'unsupported' }
    let outBuf
    try { outBuf = rewriteBuffer(buf, changes) } catch (e) { return { ok: false, reason: e.message } }
    const dir = path.dirname(filePath)
    const tmp = path.join(dir, '.papa-flac-' + crypto.randomBytes(6).toString('hex') + '.tmp')
    try {
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, outBuf)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, filePath)
      return { ok: true }
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) {}
      return { ok: false, reason: e.message }
    }
  }

  // The batch surface behind the tagWriteBatch preload name. Each edit is
  // { filePath, changes:{genre?,title?,artist?,album?,year?} }. FLAC files are
  // written; anything else is skipped with reason 'unsupported'. Returns
  // { written, skipped:[{filePath,reason}] } — exactly the W2-UI contract shape.
  //
  // `guard` is an optional (filePath) => boolean the caller supplies to keep
  // writes inside the music/download folders; a path it rejects is skipped with
  // reason 'refused' rather than written.
  function writeBatch(edits, guard) {
    let written = 0
    const skipped = []
    for (const edit of Array.isArray(edits) ? edits : []) {
      const filePath = edit && edit.filePath
      if (!filePath) { skipped.push({ filePath: filePath || null, reason: 'no path' }); continue }
      if (!isFlacPath(filePath)) { skipped.push({ filePath, reason: 'unsupported' }); continue }
      if (typeof guard === 'function' && !guard(filePath)) {
        skipped.push({ filePath, reason: 'refused' }); continue
      }
      const res = writeFileTags(filePath, (edit && edit.changes) || {})
      if (res.ok) written++
      else skipped.push({ filePath, reason: res.reason || 'write failed' })
    }
    return { written, skipped }
  }

  return {
    FIELD_TO_KEY,
    isFlacPath,
    rewriteBuffer,
    readComments,
    writeFileTags,
    writeBatch,
    // Test/debug hooks.
    _parseBlocks,
    _parseVorbis,
    _buildVorbisBody,
    _applyChanges,
  }
})
