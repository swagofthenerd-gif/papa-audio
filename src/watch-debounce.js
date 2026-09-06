'use strict';
// Folder auto-watch debounce policy (App roadmap #18). The library watcher
// coalesces bursts of filesystem events into one rescan. Two knobs matter and
// both are pure decisions, extracted here so they can be tested without a real
// watcher, a real clock or a real disk:
//
//   1. chooseDebounce — how long to wait after an event before scanning. Normal
//      edits use a short window; but when the Soulseek Downloads directory sits
//      INSIDE a watched music root, a running download writes a storm of events
//      (part-files, renames, chunk flushes) that should not each provoke a scan.
//      During active downloads that case uses a much longer window.
//
//   2. shouldRunNow — the ceiling. A steady stream of events can postpone a
//      debounce forever, so once the FIRST event in a burst is older than the
//      max-wait the scan runs regardless of how many more arrive. This mirrors
//      the same ceiling side-store.js uses for its writes.
//
// pathInside is the small filesystem-shaped helper the Downloads-inside-a-root
// test relies on; it is string logic, not I/O, so it lives here too.
//
// UMD-wrapped like the other pure modules so Node's test runner and (if ever
// needed) a classic renderer script both load it.
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('path') : null)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaWatchDebounce = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodePath) {

  // The ordinary coalescing window: long enough to fold a burst of edits (an
  // album copied in), short enough that a single dropped-in file appears
  // promptly.
  const NORMAL_DEBOUNCE_MS = 5000

  // The hard window used while a download is in flight AND its directory is
  // inside a watched root. A download writes continuously; scanning every few
  // seconds during it is pure waste, so back well off.
  const DOWNLOAD_DEBOUNCE_MS = 30000

  // The ceiling for the NORMAL case. Once the first event in a burst is this
  // old the scan runs no matter what — a steady trickle must not defer forever.
  const NORMAL_MAX_WAIT_MS = 30000

  // The ceiling while downloading. Higher than the download debounce so the
  // long window can actually elapse, but still bounded so a marathon download
  // does not starve the library of a scan indefinitely.
  const DOWNLOAD_MAX_WAIT_MS = 120000

  // Normalise for prefix comparison: a trailing separator on the parent so
  // "/music" does not swallow "/musicXL", and OS-consistent separators. Pure
  // string work — no realpath, no stat.
  function _norm(p) {
    if (p == null) return ''
    let s = String(p)
    if (nodePath && typeof nodePath.normalize === 'function') s = nodePath.normalize(s)
    // Strip a trailing separator so the join below is predictable.
    s = s.replace(/[\\/]+$/, '')
    return s
  }

  // True when `child` is `parent` itself or lives beneath it. Guards the
  // "/music" vs "/musicXL" false-positive by requiring a separator boundary.
  function pathInside(child, parent) {
    const c = _norm(child)
    const p = _norm(parent)
    if (!c || !p) return false
    if (c === p) return true
    const sep = (nodePath && nodePath.sep) || '/'
    return c.startsWith(p + sep) || c.startsWith(p + '/')
  }

  // True when the Downloads directory is inside ANY watched root — the case that
  // turns a download into a watch storm.
  function downloadsInsideWatched(downloadDir, watchedRoots) {
    if (!downloadDir || !Array.isArray(watchedRoots)) return false
    return watchedRoots.some(r => pathInside(downloadDir, r))
  }

  // The debounce window to use for the next scheduled scan. The long window is
  // used only when BOTH a download is active AND its directory is inside a
  // watched root; otherwise ordinary edits get the short window.
  function chooseDebounce({ activeDownloads = false, downloadsInsideWatchedRoot = false } = {}) {
    return (activeDownloads && downloadsInsideWatchedRoot)
      ? DOWNLOAD_DEBOUNCE_MS
      : NORMAL_DEBOUNCE_MS
  }

  // The matching ceiling for the same conditions.
  function chooseMaxWait({ activeDownloads = false, downloadsInsideWatchedRoot = false } = {}) {
    return (activeDownloads && downloadsInsideWatchedRoot)
      ? DOWNLOAD_MAX_WAIT_MS
      : NORMAL_MAX_WAIT_MS
  }

  // The ceiling decision: has the first event in the current burst been waiting
  // long enough that the scan must run now rather than defer again? A zero/absent
  // firstEventAt means no burst is in progress, so never force.
  function shouldRunNow({ firstEventAt = 0, now = 0, maxWaitMs = NORMAL_MAX_WAIT_MS } = {}) {
    const first = Number(firstEventAt) || 0
    if (first <= 0) return false
    return (Number(now) || 0) - first >= (Number(maxWaitMs) || 0)
  }

  return {
    pathInside,
    downloadsInsideWatched,
    chooseDebounce,
    chooseMaxWait,
    shouldRunNow,
    NORMAL_DEBOUNCE_MS,
    DOWNLOAD_DEBOUNCE_MS,
    NORMAL_MAX_WAIT_MS,
    DOWNLOAD_MAX_WAIT_MS,
  }
})
