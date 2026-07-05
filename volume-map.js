'use strict'
// mpv's softvol scale is cubic (volume 50 ≈ -18 dB) while the renderer's
// slider — like the old HTMLAudioElement — is linear amplitude (0.5 = -6 dB).
// Map the slider's linear 0–1 to the mpv value that yields the same gain,
// otherwise every position below max plays far quieter than pre-mpv builds.

const MPV_MAX = 130 // mpv --volume-max default: ~2.2x amplitude (+6.8 dB) headroom
const BOOST_FACTOR = 1.3 // full slider lands on MPV_MAX when boost is on

function linearToMpv(linear, boost = false) {
  const v = Math.min(Math.max(linear, 0), 1)
  const mpv = Math.cbrt(v) * 100 * (boost ? BOOST_FACTOR : 1)
  return Math.min(Math.round(mpv * 10) / 10, MPV_MAX)
}

module.exports = { linearToMpv, MPV_MAX }
