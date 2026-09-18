'use strict';
// Bit-perfect output mode (App roadmap #65) — the audiophile path that hands the
// DAC the file's samples untouched: exclusive device access, no resampling, no
// filters. This is the pure policy half; main wires the store key, the IPC and the
// engine respawn.
//
// The whole point of bit-perfect is that NOTHING alters the samples between the
// file and the DAC. Several of the app's normal comforts do exactly that, so they
// are fundamentally incompatible with the mode and must be forced off while it is
// on:
//   - the EQ / lavfi filter chain (--af) rewrites every sample,
//   - ReplayGain (--replaygain) scales the samples for loudness,
//   - the 130% volume ceiling (--volume-max=130) implies software gain above unity,
//   - crossfade mixes two streams, which is by definition not the file's samples.
// Gapless is kept: it is a scheduling choice (open the next file early) and does
// not touch samples, so a gapless album still plays bit-perfect.
//
// This module answers two questions purely, so the precedence is one tested place
// instead of scattered `if (bitPerfect)` checks:
//   1. resolveEngineConfig(cfg): the spawn-time engine config with the sample-
//      altering options stripped when bitPerfect is on.
//   2. forcesGapless(bitPerfect): does bit-perfect override a requested crossfade?
//      (the transition resolver and the crossfade IPC both consult this.)
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaBitPerfect = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The one-line human explanation the settings surface shows next to the toggle,
  // so the user understands why their EQ/ReplayGain/crossfade go quiet while it is
  // on. Returned by getPlayerSettings as `exclusivityNote`.
  // C4 is disclosed here rather than fixed: gapless is kept on in bit-perfect
  // mode, and mpv's --gapless-audio=yes resamples at a handoff between two
  // different sample rates instead of reopening the output. That is a real
  // exception to "exact samples" and the note has to say so.
  const EXCLUSIVITY_NOTE =
    'Bit-perfect sends the DAC the file’s exact samples: EQ, ReplayGain, ' +
    'volume leveling, volume boost and crossfade are disabled and the audio ' +
    'device is opened in exclusive mode while it is on. One exception: gapless ' +
    'stays on, so when the next track has a different sample rate mpv resamples ' +
    'it at the handoff rather than reopening the output — seamless playback is ' +
    'kept and that one conversion is not bit-perfect.'

  // C3 (2026-09 honesty pass): TWO controls were both called "bit-perfect" and
  // meant different things — the Output mode dropdown's "Exclusive
  // (bit-perfect)" option, which only opens the device alone and leaves EQ,
  // ReplayGain, loudness leveling, the +30 % boost and crossfade all free to
  // rewrite samples; and this toggle, which actually strips them. Only one of
  // the two earns the name. The copy lives here so it is one tested string per
  // control instead of prose duplicated across index.html and renderer.js.
  const CONTROL_LABELS = {
    'output-mode-exclusive': {
      label: 'Exclusive device access',
      hint: 'Opens the audio device alone at the file’s own rate, so the system ' +
        'mixer does not resample and nothing else can play through it. This is ' +
        'not bit-perfect on its own — EQ, ReplayGain, volume leveling, the ' +
        'volume boost and crossfade all still change the samples. Use ' +
        'Bit-perfect mode below to turn those off.',
    },
    'bit-perfect-toggle': {
      label: 'Bit-perfect mode (turns off everything that changes the samples)',
      hint: 'Opens the device exclusively AND turns off EQ, ReplayGain, volume ' +
        'leveling, the volume boost and crossfade, so the file’s own samples ' +
        'reach the DAC. Gapless stays on, and a queue that mixes sample rates ' +
        'is still resampled at the handoff to keep it seamless.',
    },
  }

  // Throws on an unknown id on purpose: a typo in a wiring site should fail
  // loudly at the call, not render an empty label.
  function controlLabel(id) {
    const entry = CONTROL_LABELS[id]
    if (!entry) throw new Error(`unknown bit-perfect control id: ${id}`)
    return entry
  }

  // Does this piece of copy claim bit-perfectness? The C3 invariant is that
  // exactly one of the two controls does. Exported so the check is executable
  // rather than a comment someone has to remember.
  function claimsBitPerfect(text) {
    return /bit[-\s]?perfect/i.test(String(text || ''))
  }

  function isOn(bitPerfect) { return bitPerfect === true }

  // Bit-perfect forces gapless: crossfade mixes two streams, so it can never be
  // bit-perfect. The transition resolver and player-set-crossfade both call this
  // so a crossfade request is silently downgraded to gapless while the mode is on,
  // rather than being honoured and quietly breaking bit-perfectness.
  function forcesGapless(bitPerfect) { return isOn(bitPerfect) }

  // C2 (2026-09 honesty pass): resolveEngineConfig forces ReplayGain off at
  // SPAWN time, but the runtime `mpv-replaygain-mode` IPC set mpv's replaygain
  // property directly and persisted the mode, with no bit-perfect gate at all.
  // That left three places holding three different answers: mpv (ReplayGain
  // running), the spawn config (forced 'no', so a respawn silently turned it
  // back off), and getPlayerSettings (the stored mode, which is what the badge
  // reads). This is that one rule on its own, so the runtime path, the spawn
  // path and anything that wants to describe the state all ask the same
  // function instead of each deciding for itself.
  //
  //   mode:       what the engine should actually be given
  //   requested:  what the caller asked for, normalised
  //   suppressed: true when bit-perfect overrode the request
  //   reason:     why, in words a person can read — the point is to SAY it
  //               rather than silently drop it
  function effectiveReplaygain(cfg) {
    cfg = cfg || {}
    const raw = cfg.replaygain
    const requested = raw === 'track' ? 'track' : raw === 'album' ? 'album' : 'no'
    if (!isOn(cfg.bitPerfect) || requested === 'no') {
      return { mode: requested, requested, suppressed: false, reason: '' }
    }
    return {
      mode: 'no',
      requested,
      suppressed: true,
      reason: 'Bit-perfect mode is on, so ReplayGain stays off: it scales the ' +
        'samples, which is exactly what the mode exists to prevent. Turn ' +
        'bit-perfect off to use ReplayGain.',
    }
  }

  // The loudness-scan leveling (replaygainApply) is a SECOND gain path: main
  // folds each track's measured gain into mpv's volume. The bit-perfect hint has
  // always promised "volume leveling" goes off, but nothing enforced it, so the
  // toggle left it running and the samples were scaled anyway. Same shape as
  // effectiveReplaygain so the settings surface can paint either the same way.
  function effectiveLoudnessLeveling(cfg) {
    cfg = cfg || {}
    const requested = cfg.replaygainApply === true
    if (!isOn(cfg.bitPerfect) || !requested) {
      return { on: requested, requested, suppressed: false, reason: '' }
    }
    return {
      on: false,
      requested,
      suppressed: true,
      reason: 'Bit-perfect mode is on, so volume leveling stays off: it raises ' +
        'quiet tracks by changing their level, which is what the mode exists to ' +
        'prevent. Turn bit-perfect off to level volume.',
    }
  }

  // The volume boost is software gain above unity, so bit-perfect suppresses it
  // too — the engine already caps --volume-max at 100 instead of 130 while on.
  function effectiveBoost(cfg) {
    cfg = cfg || {}
    const requested = cfg.boost === true
    if (!isOn(cfg.bitPerfect) || !requested) {
      return { on: requested, requested, suppressed: false, reason: '' }
    }
    return {
      on: false,
      requested,
      suppressed: true,
      reason: 'Bit-perfect mode is on, so the +30% volume boost stays off: it is ' +
        'software gain above unity. Turn bit-perfect off to use it.',
    }
  }

  // Map the player-settings blob to the MpvEngine spawn config. When bitPerfect is
  // off this is a straight pass-through of the existing fields; when on it:
  //   - sets outputMode 'exclusive' (engine adds --audio-exclusive=yes),
  //   - clears the EQ so buildAfGraph emits no --af chain,
  //   - forces replaygain 'no',
  //   - forces gapless (mode is never crossfade),
  //   - marks bitPerfect so the engine caps --volume-max at 100 instead of 130.
  // The caller passes the already-resolved player settings (mode already collapsed
  // to 'gapless'/'crossfade'); this returns the engine-shaped config object.
  function resolveEngineConfig(cfg) {
    cfg = cfg || {}
    const on = isOn(cfg.bitPerfect)
    const base = {
      outputMode: cfg.outputMode,
      alsaDevice: cfg.alsaDevice,
      replaygain: cfg.replaygain,
      gapless: cfg.mode === 'gapless',
      audioChannels: cfg.channels,
      eq: cfg.eq,
      bitPerfect: on,
      // Roadmap 038: what to do when the output device vanishes mid-play.
      onDeviceLoss: cfg.onDeviceLoss === 'continue' ? 'continue' : 'pause',
    }
    if (!on) return base
    return {
      ...base,
      // C2: same rule as the runtime IPC, called rather than restated, so the
      // two can never drift apart again.
      replaygain: effectiveReplaygain(cfg).mode,
      // Exclusive access is the "bit-perfect" part the OS mixer would otherwise
      // undo by resampling to a shared rate. The engine reads outputMode to add
      // --audio-exclusive=yes; a chosen alsaDevice is kept so it is opened
      // exclusively rather than the default shared sink.
      outputMode: 'exclusive',
      gapless: true,
      // A cleared EQ makes buildAfGraph return '' -> no --af filter chain.
      eq: null,
    }
  }

  return {
    EXCLUSIVITY_NOTE, isOn, forcesGapless, resolveEngineConfig,
    effectiveReplaygain, effectiveLoudnessLeveling, effectiveBoost,
    CONTROL_LABELS, controlLabel, claimsBitPerfect,
  }
})
