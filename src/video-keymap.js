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
  // T (theatre mode), B (bookmark) and / (focus search) used to resolve here.
  // The theatre's own key handler had no case for any of them — they fell to
  // `default: return` — and the renderer's global handler stands down entirely
  // while the theatre is open. So all three were bound keys that did nothing,
  // advertised in the help list as features. A key that resolves to an action
  // nobody performs is worse than an unbound one: it makes the viewer doubt
  // the keys that do work. Unbound until something actually does them.
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
    SCREENSHOT: 'screenshot',
    NEXT: 'next',
    PREV: 'prev',
    STATS: 'stats',
    EXIT: 'exit',
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
      // Plain s skips the active segment; Shift+S grabs a screenshot (§48). The
      // two never collide because one needs the modifier and the other refuses it.
      case 's': return shift ? { action: ACTIONS.SCREENSHOT } : { action: ACTIONS.SKIP }
      case 'n': return { action: ACTIONS.NEXT }
      case 'p': return { action: ACTIONS.PREV }
      case 'i': return { action: ACTIONS.STATS }
      case 'escape': return { action: ACTIONS.EXIT }
      case '/': return shift ? { action: ACTIONS.SHORTCUTS } : null
      case '?': return { action: ACTIONS.SHORTCUTS }
    }

    // 0-9 seek to a percentage. '0' is 0%, '9' is 90% — the convention every
    // streaming app uses and the one users already know.
    if (/^[0-9]$/.test(lk)) {
      return { action: ACTIONS.SEEK_TO, arg: Number(lk) / 10 }
    }

    return null
  }

  // ── The detail page's season shortcut ───────────────────────────────────────
  // Separate from resolve(): the theatre's digits SEEK, the detail page's
  // digits pick a SEASON, and conflating the two is how one of them ends up
  // silently doing the other's job.
  //
  // It used to read event.key and accept 1-9 only, so a show with ten or more
  // seasons — Doctor Who, Grey's Anatomy, It's Always Sunny — had no shortcut
  // for most of its run, with nothing on screen to say where the keyboard
  // stopped (audit N19). Now: 1-9 are themselves, 0 is season 10, and Shift
  // adds ten, so Shift+1 is 11 through Shift+9 is 19 and Shift+0 is 20.
  //
  // Read from event.CODE, not event.key. Shift+1 arrives as '!' on a US
  // layout, '"' on a UK one and something else again on a German one — a
  // shifted digit has no stable key. `code` is the physical key and is the
  // same everywhere. event.key is still accepted as a fallback for the plain
  // digits, because synthetic events (and the odd remote) carry no code.
  function seasonFromKey(event, context = {}) {
    if (!event) return null
    if (context.isInput) return null
    if (event.ctrlKey || event.altKey || event.metaKey) return null

    let digit = null
    const code = typeof event.code === 'string' ? event.code : ''
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(code)
    if (m) digit = Number(m[1])
    // No code: only an unshifted digit can be trusted from `key` alone.
    else if (!event.shiftKey && typeof event.key === 'string' && /^[0-9]$/.test(event.key)) digit = Number(event.key)

    if (digit == null) return null
    // 0 is the tenth season, not the zeroth: there is no season zero to pick
    // (TMDB's specials bucket is season 0, but the picker names it "Specials"
    // and it is reached by its own entry, not by a digit).
    const base = digit === 0 ? 10 : digit
    return event.shiftKey ? base + 10 : base
  }

  // How the help sheet says it, so the sheet and the mapping can never drift.
  const SEASON_KEYS_LABEL = '1–9, 0, Shift+1–9'
  const SEASON_KEYS_DESC = 'Pick a season (0 is season 10; Shift adds ten, so Shift+3 is 13)'

  return { resolve, seasonFromKey, SEASON_KEYS_LABEL, SEASON_KEYS_DESC, ACTIONS, SEEK_SHORT, SEEK_LONG, VOLUME_STEP }
})
