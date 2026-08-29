'use strict';
// Pure keyboard mapping for the video player: `(event, context) → action`.
//
// The theatre is keyboard-complete (plan §8), but "keyboard-complete" only
// survives if the mapping is one pure function the UI feeds raw key events
// into — otherwise the same Space handling drifts across the transport bar,
// the seek bar and the shortcut sheet, and one of them forgets the input guard.
//
// Two hard rules live here, not at the call sites:
//   1. Focus in an input returns null — typing a space in the search box must
//      not toggle playback.
//   2. Ctrl/Alt/Meta combos return null — the browser owns those (reload,
//      copy, the OS shortcuts). Shift is the one modifier that means something
//      (±60 s seek, and '?').
//
// `action` is a UI-level verb; the player translates it into a videoControl
// call or a local DOM change. `arg` carries the parameter where one exists.
//
// UMD-wrapped like ttl-cache.js so it loads as a classic script without leaking
// a top-level `resolve` into the shared renderer scope (library-prune.js already
// owns that name).
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoKeymap = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const SEEK_SHORT = 10
  const SEEK_LONG = 60
  const VOLUME_STEP = 5

  // The exact verb set the player understands. Listed here so a typo in a case
  // label is a test failure, not a silent no-op at 1am.
  const ACTIONS = {
    PLAY_PAUSE: 'playPause',
    SEEK: 'seek',            // arg: signed seconds
    SEEK_TO: 'seekTo',       // arg: fraction 0..1
    VOLUME: 'volume',        // arg: signed step
    FRAME: 'frameStep',      // arg: -1 | 1
    SPEED: 'speed',          // arg: -1 | 1 (step through the ladder)
    FULLSCREEN: 'fullscreen',
    MUTE: 'mute',
    SUBTITLES: 'subtitles',
    AUDIO_TRACK: 'audioTrack',
    SKIP: 'skip',
    NEXT: 'next',
    PREV: 'prev',
    THEATRE: 'theatre',
    STATS: 'stats',
    BOOKMARK: 'bookmark',
    EXIT: 'exit',
    FOCUS_SEARCH: 'focusSearch',
    SHORTCUTS: 'shortcuts',
  }

  function resolve(event, context = {}) {
    if (!event || typeof event.key !== 'string') return null
    if (context.isInput) return null
    if (event.ctrlKey || event.altKey || event.metaKey) return null

    const key = event.key
    const shift = !!event.shiftKey
    // Lowercase everything, not only single letters: 'Escape' and 'ArrowLeft'
    // arrive with different casing across platforms.
    const lk = key.toLowerCase()

    switch (lk) {
      case ' ':
      case 'k':
        return { action: ACTIONS.PLAY_PAUSE }

      case 'arrowleft':
        return { action: ACTIONS.SEEK, arg: shift ? -SEEK_LONG : -SEEK_SHORT }
      case 'arrowright':
        return { action: ACTIONS.SEEK, arg: shift ? SEEK_LONG : SEEK_SHORT }
      case 'j':
        return { action: ACTIONS.SEEK, arg: -SEEK_SHORT }
      case 'l':
        return { action: ACTIONS.SEEK, arg: SEEK_SHORT }

      case 'arrowup':
        return { action: ACTIONS.VOLUME, arg: VOLUME_STEP }
      case 'arrowdown':
        return { action: ACTIONS.VOLUME, arg: -VOLUME_STEP }

      case ',':
        return { action: ACTIONS.FRAME, arg: -1 }
      case '.':
        return { action: ACTIONS.FRAME, arg: 1 }

      case '[':
        return { action: ACTIONS.SPEED, arg: -1 }
      case ']':
        return { action: ACTIONS.SPEED, arg: 1 }

      case 'f': return { action: ACTIONS.FULLSCREEN }
      case 'm': return { action: ACTIONS.MUTE }
      case 'c': return { action: ACTIONS.SUBTITLES }
      case 'v': return { action: ACTIONS.AUDIO_TRACK }
      case 's': return { action: ACTIONS.SKIP }
      case 'n': return { action: ACTIONS.NEXT }
      case 'p': return { action: ACTIONS.PREV }
      case 't': return { action: ACTIONS.THEATRE }
      case 'i': return { action: ACTIONS.STATS }
      case 'b': return { action: ACTIONS.BOOKMARK }
      case 'escape': return { action: ACTIONS.EXIT }
      case '/': return shift ? { action: ACTIONS.SHORTCUTS } : { action: ACTIONS.FOCUS_SEARCH }
      case '?': return { action: ACTIONS.SHORTCUTS }
    }

    // 0-9 seek to a percentage. '0' is 0%, '9' is 90% — the convention every
    // streaming app uses and the one users already know.
    if (/^[0-9]$/.test(lk)) {
      return { action: ACTIONS.SEEK_TO, arg: Number(lk) / 10 }
    }

    return null
  }

  return { resolve, ACTIONS, SEEK_SHORT, SEEK_LONG, VOLUME_STEP }
})
