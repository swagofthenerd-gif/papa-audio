// Verifying that a download is genuinely surround.
//
// Everything upstream of this trusts labels: Soulseek never reports channel
// count, so folder names and file sizes are the only signals available when
// choosing what to fetch. Both can be wrong - a folder called "DSOTM 5.1" may
// hold a stereo rip, and a size heuristic is a proxy, not proof.
//
// Once a file is on disk the guessing ends: ffprobe reports the real channel
// count. This module decides what that means, so a download that claimed
// surround and arrived stereo is caught and reported rather than quietly
// joining the library.

function classify(channels) {
  const c = Number(channels) || 0
  if (c >= 8) return '7.1'
  if (c === 7) return '6.1'
  if (c >= 6) return '5.1'
  if (c === 5) return '5.0'
  if (c === 4) return '4.0'
  if (c === 2) return 'stereo'
  if (c === 1) return 'mono'
  return 'unknown'
}

function isSurround(channels) {
  return (Number(channels) || 0) >= 4
}

/**
 * Compare what a download promised against what actually arrived.
 * expectedLabel: from the folder/file text ('5.1', 'ATMOS', null, ...)
 * actualChannels: from ffprobe
 */
function verdict(expectedLabel, actualChannels) {
  const actual = classify(actualChannels)
  const expectedSurround = !!expectedLabel
  const actuallySurround = isSurround(actualChannels)

  if (!Number(actualChannels)) {
    return { ok: null, actual, severity: 'unknown',
             message: 'Could not read the channel count.' }
  }
  if (expectedSurround && !actuallySurround) {
    return { ok: false, actual, severity: 'mismatch',
             message: `Labelled ${expectedLabel} but arrived as ${actual}.` }
  }
  if (!expectedSurround && actuallySurround) {
    // A pleasant surprise, still worth surfacing - it may be mislabelled and
    // worth keeping for that reason.
    return { ok: true, actual, severity: 'bonus',
             message: `Not labelled surround, but it is ${actual}.` }
  }
  if (expectedSurround && actuallySurround) {
    return { ok: true, actual, severity: 'confirmed',
             message: `Confirmed ${actual}.` }
  }
  return { ok: true, actual, severity: 'plain', message: `${actual}.` }
}

// An album is only genuinely surround if EVERY track is. One stereo track in a
// 5.1 album is exactly the failure the size heuristic exists to prevent, and
// the one most likely to go unnoticed.
function auditAlbum(tracks) {
  const list = (tracks || []).filter(t => Number(t.channels))
  if (!list.length) return { ok: null, surround: 0, total: 0, offenders: [] }
  const offenders = list.filter(t => !isSurround(t.channels))
  const surround = list.length - offenders.length
  return {
    ok: offenders.length === 0,
    surround,
    total: list.length,
    mixed: surround > 0 && offenders.length > 0,
    offenders: offenders.map(t => ({ name: t.name || t.filePath, channels: t.channels })),
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classify, isSurround, verdict, auditAlbum }
}
if (typeof window !== 'undefined') {
  window.PapaVerify = { classify, isSurround, verdict, auditAlbum }
}
