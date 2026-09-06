'use strict';
// Pure path/name helpers for "Keep this episode" (App #44).
//
// Saving a streamed episode out of the throwaway cache and into ~/Videos means
// building a destination path from two attacker-adjacent strings: a show title
// and a filename, both ultimately sourced from torrent metadata. So the safe
// path is built here, in one place, from sanitized segments — never by
// interpolating a raw remote name into a shell or a path.join that a `..`
// could climb out of. main.js's video-keep-file handler calls these; the tests
// pin them without touching the disk.
//
// UMD-wrapped so it require()s in tests and, if ever needed, loads as a classic
// script in the renderer without leaking names.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoKeep = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Collapse a string to a single safe path segment: no separators, no drive
  // colons, no wildcard/pipe characters, no leading dots (which hide files and
  // spell `..`). Runs of unsafe characters each become one underscore so the
  // result stays readable. Falls back to 'video' when nothing safe remains.
  function sanitizeName(name) {
    if (name == null) return 'video'
    let s = String(name)
    // Any path separator or shell/FS-hostile character → underscore.
    s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    // Trim surrounding whitespace and leading dots/underscores (so '..' and
    // hidden-file prefixes cannot survive as a leading segment).
    s = s.replace(/^[\s._]+/, '').replace(/\s+$/, '')
    // A bare '..' or empty string is not a filename.
    if (!s || s === '.' || s === '..') return 'video'
    return s
  }

  // Very small path.join that does not depend on Node's path module (so the
  // renderer copy is portable) and always uses '/'. Each segment is sanitized;
  // the root is trusted (it comes from app.getPath, not remote data) and is
  // only stripped of a trailing slash.
  function destPath(root, show, file) {
    const base = String(root == null ? '' : root).replace(/\/+$/, '')
    const showSeg = sanitizeName(show && String(show).trim() ? show : 'Videos')
    const fileSeg = sanitizeName(file && String(file).trim() ? file : 'video')
    return base + '/' + showSeg + '/' + fileSeg
  }

  // A predownload/progress report is complete only when the downloaded byte
  // count has reached (or passed) the file's total, and the total is real.
  function isComplete(progress) {
    if (!progress) return false
    const total = Number(progress.total) || 0
    const bytes = Number(progress.bytes) || 0
    return total > 0 && bytes >= total
  }

  // Total bytes currently held by the kept-file list. A missing or non-numeric
  // sizeBytes counts as zero rather than poisoning the sum with NaN — a stale
  // entry whose file has gone should not make the quota check throw.
  function usageBytes(entries) {
    const list = Array.isArray(entries) ? entries : []
    let sum = 0
    for (const e of list) {
      const n = Number(e && e.sizeBytes)
      if (Number.isFinite(n) && n > 0) sum += n
    }
    return sum
  }

  // Gigabytes as the settings slider speaks them → bytes. 1 GB = 1e9 bytes here
  // (decimal, matching how disk sizes are advertised), not 2^30 — the number the
  // user typed should mean the number they expect on the drive label.
  function quotaBytes(quotaGB) {
    const gb = Number(quotaGB)
    if (!Number.isFinite(gb) || gb <= 0) return 0
    return Math.floor(gb * 1e9)
  }

  // Would keeping a file of `addBytes` push the list past its quota? Returns a
  // verdict the handler turns straight into an answer: `ok` to proceed, plus the
  // numbers a "you're using X of Y" message needs. A quota of 0 (unset or
  // cleared) means no ceiling, so it always fits — the feature is opt-in on a
  // real number, not a silent block at zero.
  function quotaCheck(entries, quotaGB, addBytes) {
    const limit = quotaBytes(quotaGB)
    const used = usageBytes(entries)
    const add = Math.max(0, Number(addBytes) || 0)
    if (limit <= 0) return { ok: true, used, limit: 0, add, after: used + add }
    const after = used + add
    return { ok: after <= limit, used, limit, add, after }
  }

  return {
    sanitizeName, destPath, isComplete,
    usageBytes, quotaBytes, quotaCheck,
  }
})
