'use strict';
// Pure media-handoff state machine (App #72).
//
// One app, two players: mpv-for-music (`mpv-engine.js`) and mpv-for-video
// (`video-engine.js`). They share nothing — different processes, different
// windows, different audio streams — so without a referee they talk over each
// other: start a film and the album keeps playing under the dialogue.
//
// The rule the user actually wants is not "pause the other thing." It is
// "the thing I just started is the thing I hear, and when I'm done with it the
// thing I interrupted comes back — but only if I didn't already move on."
// That last clause is the whole reason this is a state machine and not a pair
// of pause() calls: resuming music blindly on video-close would restart an
// album the user paused by hand ten minutes ago.
//
// So we remember exactly one fact: "media X was auto-paused by media Y, and is
// owed a resume." Any manual action on X (the user plays or pauses it
// themselves) cancels the debt, because the user has taken ownership.
//
// State shape (all booleans, no timers, no DOM — trivially testable):
//   musicOwesResume  music was playing, video paused it, resume on video-stop
//   videoOwesResume  video was playing, music paused it, resume on music-stop
// Only one can be true at a time: starting one clears the other's debt (you
// can't owe a resume to something you just interrupted again).
//
// The six transitions the tests pin:
//   1. video-start while music plays  → pause music, musicOwesResume = true
//   2. video-start while music paused → nothing owed
//   3. video-stop with musicOwesResume → resume music, clear debt
//   4. music-start while video plays  → pause video, videoOwesResume = true
//   5. music-stop with videoOwesResume → resume video, clear debt
//   6. user manually plays/pauses the paused side → debt cleared, no auto-resume
//
// UMD-wrapped (like video-keymap.js) so it loads as a classic script in the
// renderer without leaking names, and `require()`s cleanly in tests.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaMediaHandoff = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function create() {
    // The single remembered fact, split by direction. At most one is true.
    let musicOwesResume = false
    let videoOwesResume = false

    function state() {
      return { musicOwesResume, videoOwesResume }
    }

    // A play/pause instruction the caller carries out. `target` is 'music' or
    // 'video'; `op` is 'pause' or 'resume'. Returning the intent rather than
    // calling anything keeps this module pure — the renderer owns the actual
    // player objects and does the side effect.
    function _act(target, op) {
      return { target, op }
    }

    // Video is starting. `musicPlaying` is the truth right now (audio not
    // paused). If music is playing we pause it and remember the debt; either
    // way any debt video owed music is void — video is the foreground now.
    function onVideoStart(musicPlaying) {
      videoOwesResume = false
      if (musicPlaying) {
        musicOwesResume = true
        return _act('music', 'pause')
      }
      musicOwesResume = false
      return null
    }

    // Video stopped or closed. Resume music only if this machine paused it and
    // the debt still stands (the user didn't touch music in the meantime).
    function onVideoStop() {
      if (musicOwesResume) {
        musicOwesResume = false
        return _act('music', 'resume')
      }
      return null
    }

    // Symmetric: music is starting while a film may be playing.
    function onMusicStart(videoPlaying) {
      musicOwesResume = false
      if (videoPlaying) {
        videoOwesResume = true
        return _act('video', 'pause')
      }
      videoOwesResume = false
      return null
    }

    // Music stopped. Resume the film we paused, if the debt stands.
    function onMusicStop() {
      if (videoOwesResume) {
        videoOwesResume = false
        return _act('video', 'resume')
      }
      return null
    }

    // The user manually acted on music (pressed play or pause themselves).
    // Whatever we owed is void — they've taken the wheel. Called for both the
    // play and the pause so a manual pause-then-resume never triggers a second
    // auto-resume, and a manual resume of paused music isn't undone later.
    function onMusicUserAction() {
      musicOwesResume = false
    }

    // The user manually acted on the video (play/pause inside the theatre).
    function onVideoUserAction() {
      videoOwesResume = false
    }

    // Belt-and-braces reset, e.g. on a hard teardown where neither side should
    // keep a claim on the other.
    function reset() {
      musicOwesResume = false
      videoOwesResume = false
    }

    return {
      state,
      onVideoStart,
      onVideoStop,
      onMusicStart,
      onMusicStop,
      onMusicUserAction,
      onVideoUserAction,
      reset,
    }
  }

  return { create }
})
