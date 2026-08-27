'use strict'
// Turns an engine diagnostic into the log entry that has to explain the next
// unexplained playback stop. Kept out of main.js so the format itself is
// testable — this text is the deliverable, not a side effect of one.

// How much of each ring reaches the daily log. The full rings stay available
// over IPC for the QA harness; this is what is worth writing to a file on every
// fault without turning the log into the problem.
const DIAG_FLIGHT_LINES = 60
const DIAG_LOG_LINES = 40

function fields(entry, skip) {
  return Object.keys(entry)
    .filter(k => !skip.has(k) && entry[k] !== null && entry[k] !== undefined)
    .map(k => `${k}=${typeof entry[k] === 'string' ? entry[k] : JSON.stringify(entry[k])}`)
    .join(' ')
}

// Times are relative to the fault because "12.3s before the stop" is the
// question being asked; sixty absolute ISO stamps answer it much more slowly.
function formatDiagnostic(d) {
  const diag = d || {}
  const flight = (diag.flight || []).slice(-DIAG_FLIGHT_LINES)
  const log = (diag.log || []).slice(-DIAG_LOG_LINES)
  const zero = flight.length ? flight[flight.length - 1].at
    : (log.length ? log[log.length - 1].at : 0)
  const at = t => `${((t - zero) / 1000).toFixed(3).padStart(9)}s`
  const more = (shown, cap) => (shown >= cap ? '+' : '')
  const out = []
  out.push(`[papa][engine] DIAGNOSTIC ${diag.kind || 'unknown'} ${fields(diag.detail || {}, new Set())}`.trimEnd())
  if (diag.state) {
    out.push(`[papa][engine]   state ${fields(diag.state, new Set(['audioParams']))}`)
  }
  out.push(`[papa][engine]   mpv said (${log.length}${more(log.length, DIAG_LOG_LINES)} lines):`)
  if (!log.length) {
    out.push('[papa][engine]     (nothing — mpv logged no warnings or errors)')
  }
  for (const l of log) {
    out.push(`[papa][engine]    ${at(l.at)} ${l.source}: ${l.text}`)
  }
  out.push(`[papa][engine]   flight recorder (${flight.length}${more(flight.length, DIAG_FLIGHT_LINES)} entries):`)
  if (!flight.length) {
    out.push('[papa][engine]     (empty — the recorder had nothing, which is itself a finding)')
  }
  for (const f of flight) {
    out.push(`[papa][engine]    ${at(f.at)} ${f.ev} ${fields(f, new Set(['at', 'ev']))}`.trimEnd())
  }
  return out.join('\n')
}

module.exports = { formatDiagnostic, DIAG_FLIGHT_LINES, DIAG_LOG_LINES }
