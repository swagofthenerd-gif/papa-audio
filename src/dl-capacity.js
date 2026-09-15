'use strict'
// Destination capacity before a download starts (roadmap 079). Insufficient
// space or an unwritable folder used to be discovered mid-transfer, after
// peers had been asked and bytes had moved; now it is decided before any
// transfer work, and the answer is a choice the person can act on. Pure;
// tested in test/dl-capacity.test.js. Sizes are bytes.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaDlCapacity = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // Keep this much free after the download: a full disk breaks more than the
  // download (the library cache, logs, the OS).
  var RESERVE_BYTES = 500 * 1024 * 1024

  function fmt(bytes) {
    var b = Number(bytes) || 0
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB'
    if (b >= 1e6) return Math.round(b / 1e6) + ' MB'
    if (b >= 1e3) return Math.round(b / 1e3) + ' KB'
    return b + ' B'
  }

  // facts: { needBytes, freeBytes (null = unknown), writable (true/false/null), dir }
  // → { ok, kind: 'ok'|'insufficient'|'unwritable'|'unknown', text, action }
  //   action: 'none' | 'choose-folder' | 'free-space' | 'proceed'
  function check(facts) {
    facts = facts || {}
    var need = Math.max(0, Number(facts.needBytes) || 0)
    var free = facts.freeBytes == null ? null : Number(facts.freeBytes)
    var dir = facts.dir ? String(facts.dir) : 'the download folder'
    if (facts.writable === false) {
      return { ok: false, kind: 'unwritable', action: 'choose-folder',
        text: dir + ' cannot be written to. Choose another download folder.' }
    }
    if (free == null || !isFinite(free)) {
      // Cannot measure (a network share, an odd filesystem): say so and let
      // the download go ahead rather than blocking on a guess.
      return { ok: true, kind: 'unknown', action: 'proceed',
        text: 'Free space at ' + dir + ' could not be measured.' }
    }
    if (need + RESERVE_BYTES > free) {
      var short = need + RESERVE_BYTES - free
      return { ok: false, kind: 'insufficient', action: 'free-space', shortBytes: short,
        text: 'Not enough space at ' + dir + ': this needs about ' + fmt(need) +
          ' and ' + fmt(free) + ' is free (keeping ' + fmt(RESERVE_BYTES) + ' spare). Free up ' + fmt(short) + ' or choose another folder.' }
    }
    return { ok: true, kind: 'ok', action: 'none', text: '' }
  }

  return { check: check, fmt: fmt, RESERVE_BYTES: RESERVE_BYTES }
})
