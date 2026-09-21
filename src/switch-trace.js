'use strict'
// A written record of what a source switch actually did.
//
// Every attempt to fix the switch so far was reasoned from reading the code,
// and each one fixed something real without fixing what he was seeing. The
// switch spans two processes and a dozen decisions — debrid or peers, a
// budget, a relay, a file open, a seek, a confirmation — and any of them can
// be the one that stops. Guessing which has cost days.
//
// So it writes them down. One line per step, with the time since the switch
// began, appended to switch-trace.log in the app's own data directory. He
// reproduces the fault once and the file says where it stopped.
//
// Rules this has to obey, because it runs inside playback:
//   * never throw — a broken trace must never break a switch;
//   * never block — append-and-forget, no awaiting;
//   * never grow without bound — truncated past a cap;
//   * never record anything private — magnets are identifiers, but a debrid
//     URL carries the account's token, so URLs are recorded as their shape
//     and length, never verbatim.
const fs = require('fs')
const path = require('path')

const CAP_BYTES = 1024 * 1024
const NAME = 'switch-trace.log'

let _dir = null
let _seq = 0
let _t0 = 0

function setDir(dir) { _dir = dir || null }
function file() { return _dir ? path.join(_dir, NAME) : null }

// A URL's shape without its secrets: scheme, host, and how long the rest is.
// A RealDebrid link carries the account token in its path.
function safeUrl(u) {
  const s = String(u == null ? '' : u)
  if (!s) return null
  try {
    const p = new URL(s)
    return p.protocol + '//' + p.host + ' (+' + (s.length - (p.protocol.length + 2 + p.host.length)) + ' chars)'
  } catch (_) {
    return '(' + s.length + ' chars)'
  }
}

// Start a new switch. Returns the id every later line carries.
function begin(what) {
  _seq += 1
  _t0 = Date.now()
  write('BEGIN', Object.assign({ id: _seq }, what || {}))
  return _seq
}

function write(step, data) {
  const f = file()
  if (!f) return
  try {
    try {
      const st = fs.statSync(f)
      if (st.size > CAP_BYTES) fs.writeFileSync(f, '')
    } catch (_) { /* no file yet */ }
    const line = JSON.stringify(Object.assign({
      at: new Date().toISOString(),
      ms: _t0 ? Date.now() - _t0 : 0,
      step,
    }, data || {})) + '\n'
    fs.appendFileSync(f, line)
  } catch (_) { /* a trace must never break a switch */ }
}

module.exports = { setDir, file, begin, write, safeUrl, CAP_BYTES, NAME }
