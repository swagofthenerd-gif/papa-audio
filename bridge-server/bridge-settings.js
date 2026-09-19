'use strict'

// The bridge's OWN settings file: <USER_DATA>/bridge-settings.json.
//
// Why this exists at all. `bridgeTranscode` used to live in config.json, which
// the desktop's `conf` instance rewrites whole (tmp + rename) on every set().
// The bridge wrote it there with a second electron-store instance, so a phone
// toggle and a desktop settings change could destroy each other, and the
// bridge's write dropped the desktop's `configFileMode: 0o600`.
//
// The other settings keys the bridge used to write are genuinely desktop-owned
// (the desktop reads and renders them), so those go through the inbox and the
// desktop applies them — see inbox.js. `bridgeTranscode` is different: grep the
// desktop for it and there are zero readers. It is set from the phone and read
// only by the bridge, to decide whether /stream may transcode. A key with one
// reader and one writer does not belong in a file owned by a third process, so
// it lives here instead, where the bridge is the single writer of a file the
// desktop never opens.
//
// A config.json that still carries an old `bridgeTranscode` is harmless: it is
// used as the seed value the first time this file is consulted, and after that
// nothing reads it. We deliberately do NOT delete it from config.json — that
// would make the bridge a config.json writer again, which is the whole thing
// this module removes.

const fs = require('fs')
const path = require('path')

const SETTINGS_FILE = 'bridge-settings.json'

function settingsPath(userData) { return path.join(userData, SETTINGS_FILE) }

function readAll(userData) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(userData), 'utf8'))
    if (raw && typeof raw === 'object') return raw
  } catch (_) {}
  return { version: 1 }
}

// `fallback` is consulted only when this file has never carried the key, which
// is what lets the legacy config.json value seed the first read after an
// upgrade without the bridge writing config.json to migrate it.
function get(userData, key, fallback) {
  const all = readAll(userData)
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback
}

// Atomic (tmp beside the file, then rename) and 0600, the same discipline as
// the inbox and the pairing token: a crash mid-write cannot leave a truncated
// settings file, and another local account cannot read or flip it.
function set(userData, key, value) {
  const file = settingsPath(userData)
  const tmp = `${file}.tmp`
  const next = Object.assign(readAll(userData), { version: 1, [key]: value })
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  // A file that already existed keeps its old mode through a rename, so set it
  // explicitly rather than trusting the tmp file's creation mode.
  try { fs.chmodSync(file, 0o600) } catch (_) {}
  return value
}

module.exports = { get, set, readAll, settingsPath, SETTINGS_FILE }
