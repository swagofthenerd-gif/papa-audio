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
  const EXCLUSIVITY_NOTE =
    'Bit-perfect sends the DAC the file’s exact samples: EQ, ReplayGain, ' +
    'volume boost and crossfade are disabled and the audio device is opened in ' +
    'exclusive mode while it is on.'

  function isOn(bitPerfect) { return bitPerfect === true }

  // Bit-perfect forces gapless: crossfade mixes two streams, so it can never be
  // bit-perfect. The transition resolver and player-set-crossfade both call this
  // so a crossfade request is silently downgraded to gapless while the mode is on,
  // rather than being honoured and quietly breaking bit-perfectness.
  function forcesGapless(bitPerfect) { return isOn(bitPerfect) }

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
    }
    if (!on) return base
    return {
      ...base,
      // Exclusive access is the "bit-perfect" part the OS mixer would otherwise
      // undo by resampling to a shared rate. The engine reads outputMode to add
      // --audio-exclusive=yes; a chosen alsaDevice is kept so it is opened
      // exclusively rather than the default shared sink.
      outputMode: 'exclusive',
      replaygain: 'no',
      gapless: true,
      // A cleared EQ makes buildAfGraph return '' -> no --af filter chain.
      eq: null,
    }
  }

  return { EXCLUSIVITY_NOTE, isOn, forcesGapless, resolveEngineConfig }
})
