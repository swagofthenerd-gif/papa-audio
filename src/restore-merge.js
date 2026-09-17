'use strict'

// Putting the settings half of a backup back.
//
// The export writes `{ stores, settings }`. The import used to iterate only
// `stores`, deliberately skipping `settings` on the stated grounds that it
// "would clobber real keys with the redaction marker". Measured against his
// actual config, that reasoning was inverted: 31 keys carry real data and only
// 6 are redacted. So the guard against 6 threw away 31 — his liked albums,
// followed artists, download wishlist, music folders, EQ, theme, volume, saved
// Soulseek users and the whole YouTube library — while the UI said "Restored".
//
// The fix is not to restore everything blindly either. Redaction is per-FIELD,
// not per-key: a credentials object keeps its username and loses its session
// key, so skipping the whole key would lose the username too. So this merges,
// and the only thing it refuses to write is a value that is itself the
// redaction marker.

const MARK = '__redacted__'

function isRedacted(v) {
  return typeof v === 'string' && v === MARK
}

// True for a value that carries the marker anywhere inside it. Used only to
// decide whether a value needs the slow per-field walk.
function containsMark(v) {
  if (isRedacted(v)) return true
  if (!v || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some(containsMark)
  return Object.keys(v).some(k => containsMark(v[k]))
}

// Merge `incoming` over `current`, never writing a redacted leaf.
//
// Arrays are replaced wholesale rather than merged: a saved-users list or a
// wishlist is a value, not a namespace, and merging two of them by index would
// produce a list that was never in either backup. An array containing a
// redacted leaf keeps the CURRENT array, because a partial list is worse than
// a stale one.
function mergeUnredacted(current, incoming) {
  if (isRedacted(incoming)) return { value: current, kept: true }
  if (Array.isArray(incoming)) {
    if (containsMark(incoming)) return { value: current, kept: true }
    return { value: incoming, kept: false }
  }
  if (incoming && typeof incoming === 'object') {
    const base = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {}
    const out = { ...base }
    let keptAny = false
    for (const k of Object.keys(incoming)) {
      const r = mergeUnredacted(base[k], incoming[k])
      if (r.kept) keptAny = true
      // Only write the key when the merge produced something. A redacted leaf
      // with nothing currently under it writes nothing at all rather than
      // writing undefined over a key that may exist elsewhere.
      if (!(r.kept && r.value === undefined)) out[k] = r.value
    }
    return { value: out, kept: keptAny }
  }
  return { value: incoming, kept: false }
}

// Plan the settings half of a restore. Pure: returns what to write, and what
// was deliberately not written, so the UI can say so rather than implying a
// complete restore.
function planSettingsRestore(currentSettings, backupSettings) {
  const writes = []
  const skipped = []
  const cur = currentSettings || {}
  const inc = backupSettings || {}
  if (typeof inc !== 'object' || Array.isArray(inc)) return { writes, skipped }

  for (const key of Object.keys(inc)) {
    const r = mergeUnredacted(cur[key], inc[key])
    if (r.kept) skipped.push(key)
    // A wholly-redacted key has nothing to contribute; leave what is there.
    if (isRedacted(inc[key])) continue
    if (r.value === undefined) continue
    writes.push({ key, value: r.value })
  }
  return { writes, skipped }
}

module.exports = { MARK, isRedacted, containsMark, mergeUnredacted, planSettingsRestore }
