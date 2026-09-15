'use strict'
// What to do about a track that would not load.
//
// The old behaviour spliced the track out of the queue on a single load error,
// with no check of any kind. A transient demuxer or cache error on a large FLAC
// permanently removed a file that was still on disk, and it never came back.
//
// Pure on purpose: no DOM, no IPC, no state. The renderer gathers the facts and
// carries out the decision; this only decides, so the decision can be tested.
;(function () {
  // `verdict` is the answer from the filesystem, via the track-exists IPC:
  //   { checked: true,  exists: false } -> confirmed gone
  //   { checked: true,  exists: true  } -> confirmed present
  //   { checked: false, ...           } -> could not tell (EACCES, dead mount,
  //                                        a stream, a path outside the roots)
  //
  // Actions:
  //   'mark'  the file is confirmed gone: keep the entry, mark it missing so it
//           stays identifiable with Locate / Remove (roadmap 048), and play
//           past it — the only action allowed to touch the queue
  //   'retry' load the same track once more
  //   'skip'  move to the next track, leaving the queue untouched
  //   'stop'  nothing else to play
  function decide(facts) {
    const f = facts || {}
    const verdict = f.verdict || {}
    const queueLength = Number(f.queueLength) || 0

    // Confirmed gone by the filesystem. This is the ONLY route to 'mark':
    // "could not tell" must never be treated as "it is missing".
    if (verdict.checked === true && verdict.exists === false) {
      return { action: 'mark', reason: 'confirmed-missing' }
    }

    // Present, or unknown. One retry, because the common case here is a
    // transient read error on a large file.
    if (!f.alreadyRetried) {
      return {
        action: 'retry',
        reason: verdict.checked === true ? 'present-but-failed' : 'existence-unknown',
      }
    }

    // Twice is not transient. Move on, but leave the queue alone — the track is
    // not missing, so marking it would be lying and deleting it would be losing
    // the user's data to work around a playback problem.
    if (queueLength > 1) return { action: 'skip', reason: 'failed-twice' }
    return { action: 'stop', reason: 'failed-twice-nothing-else' }
  }

  window.PapaLoadError = { decide }
})()
