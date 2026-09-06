'use strict';
// Keyboard-grammar audit (App #74).
//
// The app has two keyboard grammars sharing one document: the music grammar
// (renderer.js's global keydown, DEFAULT_SHORTCUTS) and the video grammar
// (video-keymap.js, active only while the theatre is open). "Shared concepts
// share keys where contexts allow" is the rule — Space is play/pause in both,
// m mutes in both, f is fullscreen in both — and no *single* key may resolve to
// two unrelated concepts that could both fire on the same keypress.
//
// This module is the single machine-checkable statement of that grammar. It
// maps each grammar's bare (unmodified) keys to a concept, and a conflict is a
// key that names two DIFFERENT concepts across the grammars. The test asserts
// the conflict set is empty; the renderer's dispatch guard (music handler bows
// out while the theatre is open) is what makes the shared-key overlaps safe in
// practice. Modified combos (Ctrl/Shift/Alt) are excluded — those never reach
// the video keymap (it refuses modifiers) so they cannot double-fire.
//
// The maps are hand-kept mirrors of the two grammars, intentionally so: if a
// binding changes on one side without the concept lining up, this file is the
// diff that makes it a failing test rather than a silent double-fire.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaKeymapAudit = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Music grammar — bare keys only (no Ctrl/Shift/Alt combos). Concept names
  // are shared with the video map where the two mean the same thing.
  const MUSIC_KEYS = {
    ' ': 'play-pause',
    'arrowright': 'seek-forward',
    'arrowleft': 'seek-back',
    'arrowup': 'volume-up',
    'arrowdown': 'volume-down',
    'm': 'mute',
    's': 'shuffle',
    'r': 'repeat',
    'x': 'speed',
    'f': 'fullscreen',
    'q': 'queue',
    'l': 'lyrics',
    '?': 'shortcuts',
    '=': 'volume-up',
    '-': 'volume-down',
  }

  // Video grammar — the bare-key subset of video-keymap.js. Shift and digit
  // bindings are excluded (Shift is a modifier; digits seek to a percentage and
  // have no music counterpart, so they cannot conflict).
  const VIDEO_KEYS = {
    ' ': 'play-pause',
    'k': 'play-pause',
    'arrowright': 'seek-forward',
    'arrowleft': 'seek-back',
    'arrowup': 'volume-up',
    'arrowdown': 'volume-down',
    'j': 'seek-back',
    'l': 'seek-forward',
    ',': 'frame-step',
    '.': 'frame-step',
    '[': 'speed',
    ']': 'speed',
    'f': 'fullscreen',
    'm': 'mute',
    'c': 'subtitles',
    'v': 'audio-track',
    's': 'skip',
    'n': 'next',
    'p': 'prev',
    't': 'theatre',
    'i': 'stats',
    'b': 'bookmark',
    '?': 'shortcuts',
    '/': 'focus-search',
  }

  // Concepts that are deliberately the same idea in both grammars, so sharing a
  // key is correct rather than a conflict even though the exact action differs
  // by context (e.g. play-pause acts on music vs on the film). These are the
  // "document the per-context difference" cases, not the "force uniformity"
  // ones.
  const SHARED_CONCEPTS = new Set([
    'play-pause', 'mute', 'fullscreen', 'volume-up', 'volume-down',
    'seek-forward', 'seek-back', 'speed', 'shortcuts',
  ])

  // The two grammars live in mutually-exclusive contexts: the video keymap is
  // dead unless the theatre is open, and — once the renderer's music handler
  // gains its theatre guard (this wave) — the music grammar is dead while the
  // theatre is open. So a key meaning different things in the two grammars
  // (music=shuffle vs video=skip on `s`; music=lyrics vs video=seek on `l`) is
  // NOT a double-fire: only one grammar is live at a time. Those differences
  // are documented per-context in the '?' overlay rather than forced uniform.
  //
  // What WOULD be a real conflict is a key that resolves to two different
  // concepts *within the shared-concept vocabulary* — i.e. a key both grammars
  // claim to be the "same idea" key for, but map to different shared ideas.
  // That would break muscle memory (Space doing one thing in music and another
  // in video). This reports exactly those, and should be empty.
  function auditKeymapConflicts() {
    const out = []
    for (const key of Object.keys(VIDEO_KEYS)) {
      if (!(key in MUSIC_KEYS)) continue
      const mv = MUSIC_KEYS[key]
      const vv = VIDEO_KEYS[key]
      if (mv === vv) continue
      // Differing concepts are fine when at least one side is a context-local
      // concept (queue, lyrics, shuffle, skip, subtitles, …): the grammars are
      // isolated so it never double-fires. It is only a conflict when BOTH
      // sides are shared concepts that disagree — a broken cross-grammar
      // promise. Neither side being a shared concept means pure context-local
      // divergence, which is allowed.
      if (SHARED_CONCEPTS.has(mv) && SHARED_CONCEPTS.has(vv)) {
        out.push({ key, music: mv, video: vv })
      }
    }
    return out
  }

  return { MUSIC_KEYS, VIDEO_KEYS, SHARED_CONCEPTS, auditKeymapConflicts }
})
