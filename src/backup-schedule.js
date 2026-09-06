'use strict';
// Scheduled backup policy (App roadmap #23). The heavy lifting — building the
// payload, writing the file — stays in main.js next to the stores it reads; this
// module is the pure decisions around it, so the "is a backup due?" rule and the
// "keep the newest N, delete the rest" rotation are testable with no disk and no
// real clock.
//
//   isBackupDue   — given the interval (days), the last backup time and now,
//                   decide whether to run. 0 days means the schedule is off.
//   staleBackups  — given a list of backup filenames and a keep-count, return
//                   the ones to delete (oldest first, keeping the newest N).
//
// Backup filenames are ISO-stamped (papa-backup-<ISO>.json), and an ISO stamp
// sorts chronologically as a plain string, which is what the rotation relies on
// — the same trick the in-app auto-backup rotation uses.
//
// UMD-wrapped like the other pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaBackupSchedule = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // How many dated backups the scheduled path keeps on disk. Older ones are
  // deleted on each run. Distinct from the in-app auto-backup's own keep-count.
  const KEEP = 5

  const DAY_MS = 24 * 60 * 60 * 1000

  // True when a scheduled backup should run now. intervalDays <= 0 disables the
  // schedule entirely. A never-run schedule (lastBackupAt null/0) is always due
  // once enabled. Otherwise it is due once a full interval has elapsed.
  function isBackupDue({ intervalDays = 0, lastBackupAt = 0, now = 0 } = {}) {
    const days = Number(intervalDays) || 0
    if (days <= 0) return false
    const last = Number(lastBackupAt) || 0
    if (last <= 0) return true
    return (Number(now) || 0) - last >= days * DAY_MS
  }

  // The backup filenames to DELETE so that only the newest `keep` remain. Input
  // order does not matter: names are sorted (ISO stamps sort chronologically),
  // the newest `keep` are retained, the rest returned oldest-first. A list at or
  // under the cap yields nothing.
  function staleBackups(names, keep = KEEP) {
    const list = Array.isArray(names) ? names.filter(n => typeof n === 'string') : []
    const cap = Number.isFinite(keep) && keep > 0 ? keep : KEEP
    const sorted = list.slice().sort() // ISO-stamped names sort by time
    const excess = sorted.length - cap
    if (excess <= 0) return []
    return sorted.slice(0, excess)
  }

  return {
    isBackupDue,
    staleBackups,
    KEEP,
    DAY_MS,
  }
})
