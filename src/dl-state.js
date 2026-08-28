'use strict';
// One classifier for slskd's transfer states.
//
// There were two, and they disagreed. Measured over the states slskd actually
// emits:
//
//   'Scheduled'                    renderer: failed   main: active
//     The renderer's own label table maps Scheduled to "Waiting", so a
//     scheduled transfer appeared in the FAILED tab labelled "Waiting".
//
//   'Failed' / 'Aborted'           renderer: failed   main: active
//     main's dlClassify only checked whether the string STARTS WITH
//     "Completed", so a bare failure looked like a running transfer. The
//     scheduler therefore never recorded the failure and the file was not
//     re-sourced until the 20-minute stall timer gave up on it.
//
//   '' or an unknown state         renderer: failed   main: active
//
// slskd's TransferStates is a .NET [Flags] enum, so a state is a comma-joined
// set: "Completed, Succeeded", "Completed, Errored", "Requested, Queued". The
// leading group ("None", "Requested", "Queued", "Initializing", "InProgress",
// "Completed") says where the transfer is; the trailing one, when the leading
// group is Completed, says how it ended.
//
// Loaded by main via require and by the renderer as a classic script.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaDlState = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Both spellings: slskd has used Initializing and Initialising across versions.
  const IN_FLIGHT = new Set([
    'Requested', 'Queued', 'Initializing', 'Initialising', 'InProgress', 'Scheduled',
  ])
  // How a completed transfer ended. Errored is slskd's spelling; Failed and
  // TimedOut appear in older builds and in our own synthetic states.
  const ENDED_BADLY = new Set([
    'Errored', 'Failed', 'TimedOut', 'Aborted', 'Rejected',
  ])
  const ENDED_CANCELLED = new Set(['Cancelled', 'Canceled'])

  function parts(stateStr) {
    return String(stateStr == null ? '' : stateStr)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
  }

  // 'active' | 'completed' | 'cancelled' | 'failed'
  //
  // An empty or unrecognised state is 'failed', not 'active': treating an
  // unknown as active is what made the scheduler wait on transfers that were
  // never coming back.
  function classify(stateStr) {
    const p = parts(stateStr)
    if (!p.length) return 'failed'
    if (p.includes('Succeeded')) return 'completed'
    if (p.some(x => ENDED_CANCELLED.has(x))) return 'cancelled'
    if (p.some(x => ENDED_BADLY.has(x))) return 'failed'
    // Completed with no outcome word is over, and we do not know how.
    if (p.includes('Completed')) return 'failed'
    if (p.some(x => IN_FLIGHT.has(x))) return 'active'
    return 'failed'
  }

  function isActive(stateStr) { return classify(stateStr) === 'active' }
  // The scheduler's question: is this transfer over, however it ended?
  function isFinished(stateStr) { return classify(stateStr) !== 'active' }

  // The label shown next to a transfer. Kept beside the classifier so a state
  // can never be labelled from one table and filed under another -- which is
  // precisely how "Waiting" ended up in the Failed tab.
  const LABELS = [
    ['InProgress',   'Downloading', 'dl2-tag-progress'],
    ['Scheduled',    'Waiting',     'dl2-tag-waiting'],
    ['Queued',       'Queued',      'dl2-tag-queued'],
    ['Initializing', 'Connecting',  'dl2-tag-queued'],
    ['Initialising', 'Connecting',  'dl2-tag-queued'],
    ['Requested',    'Requested',   'dl2-tag-queued'],
    ['Succeeded',    'Done',        'dl2-tag-done'],
    ['TimedOut',     'Timed out',   'dl2-tag-failed'],
    ['Errored',      'Failed',      'dl2-tag-failed'],
    ['Failed',       'Failed',      'dl2-tag-failed'],
    ['Cancelled',    'Cancelled',   'dl2-tag-failed'],
    ['Canceled',     'Cancelled',   'dl2-tag-failed'],
    ['Aborted',      'Aborted',     'dl2-tag-failed'],
    ['Rejected',     'Rejected',    'dl2-tag-failed'],
  ]

  function label(stateStr) {
    const p = parts(stateStr)
    for (const [flag, text, cls] of LABELS) {
      if (p.includes(flag)) return { label: text, cls: cls }
    }
    // 'Completed' alone, or something new: say what it was rather than
    // inventing a status for it.
    return { label: String(stateStr || '?'), cls: 'dl2-tag-failed' }
  }

  return {
    classify: classify,
    isActive: isActive,
    isFinished: isFinished,
    label: label,
    // Exported for the test that enumerates every state slskd emits.
    IN_FLIGHT: IN_FLIGHT,
    ENDED_BADLY: ENDED_BADLY,
    ENDED_CANCELLED: ENDED_CANCELLED,
  }
})
