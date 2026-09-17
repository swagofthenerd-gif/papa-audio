// Format badges shown on albums and tracks.
//
// The point is to make the *spec* legible at a glance: which album is real
// discrete surround, which is Atmos, which is hi-res, which is plain stereo.
// Channel count alone is not enough — a 6-channel eac3 Atmos file and a
// 6-channel FLAC SACD rip are different things and deserve different labels.

// What a DSD file actually is here: a lossless DSD source that is decoded to
// PCM for playback. Kept as one exported string so the album badge, the track
// badge and the now-playing tooltip cannot say three different things.
const DSD_TITLE = 'Direct Stream Digital — decoded to PCM for playback'

function surroundLabel(channels) {
  const c = Number(channels) || 0
  if (c >= 8) return '7.1'
  if (c === 7) return '6.1'
  if (c >= 6) return '5.1'
  if (c === 5) return '5.0'
  if (c === 4) return '4.0'
  return ''
}

// Hi-res is the industry line: better than CD (16/44.1) in depth or rate.
function isHiRes({ bitsPerSample, sampleRate } = {}) {
  const bits = Number(bitsPerSample) || 0
  const rate = Number(sampleRate) || 0
  return bits > 16 || rate > 48000
}

function isLossless(codec) {
  return /^(flac|alac|ape|wavpack|wav|pcm|dsd|dsf|dff|truehd|mlp)/i.test(String(codec || ''))
}

// Ordered most-specific first: Atmos implies surround, so it wins the lead slot.
function formatBadges(src = {}) {
  const t = src || {}
  const out = []
  const codec = String(t.codec || '')
  const chans = t.channels != null ? t.channels : t.maxChannels
  const bits  = Number(t.bitsPerSample || t.maxBitsPerSample) || 0
  const rate  = Number(t.sampleRate || t.maxSampleRate) || 0

  if (t.atmos) out.push({ label: 'ATMOS', kind: 'atmos', title: 'Dolby Atmos object audio' })

  const sur = surroundLabel(chans)
  if (sur) out.push({ label: sur, kind: 'surround', title: `${sur} multichannel audio` })

  if (/^dsd|dsf|dff/i.test(codec)) {
    // C5 (2026-09 honesty pass): the file is DSD, but mpv decodes it to PCM to
    // play it — this app has no DoP or native-DSD output path — so the badge
    // must not let anyone read "DSD" as "DSD reaches the DAC".
    out.push({ label: 'DSD', kind: 'dsd', title: DSD_TITLE })
  } else if (bits > 16 || rate > 48000) {
    const khz = Math.round(rate / 100) / 10
    out.push({ label: 'HI-RES', kind: 'hires', title: `${bits ? bits + '-bit/' : ''}${khz}kHz` })
  }

  if (codec && !isLossless(codec) && !t.atmos) {
    out.push({ label: 'LOSSY', kind: 'lossy', title: `${codec.toUpperCase()} lossy audio` })
  }
  return out
}

// Dual-mode: the renderer runs with contextIsolation and cannot require(),
// so it picks this up as a global via <script>. Tests use the CommonJS export.
// One implementation either way - duplicating it guarantees the two drift.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { surroundLabel, isHiRes, isLossless, formatBadges, DSD_TITLE }
}
if (typeof window !== 'undefined') {
  window.PapaFormat = { surroundLabel, isHiRes, isLossless, formatBadges, DSD_TITLE }
}
