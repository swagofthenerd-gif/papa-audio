'use strict'
// What Papa Audio shares with Soulseek peers (roadmap 137). The daemon used
// to be handed the first music folder — the whole library — with no word
// said and no way to change it. The choice is now explicit and this is the
// one place that turns it into share directories. Pure; tested.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaSlskShare = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  var MODES = ['library', 'downloads', 'off']
  var DEFAULT = 'library'   // unchanged from before; now stated, not silent

  function normalise(mode) { return MODES.indexOf(mode) >= 0 ? mode : DEFAULT }

  // → the list of directories slskd should share (may be empty).
  function shareDirs(mode, musicFolders, downloadDir) {
    var m = normalise(mode)
    if (m === 'off') return []
    if (m === 'downloads') return downloadDir ? [downloadDir] : []
    var first = (musicFolders || []).filter(Boolean)[0]
    if (first) return [first]
    return downloadDir ? [downloadDir] : []
  }

  // The sentence shown under the setting.
  function describe(mode, dirs) {
    var m = normalise(mode)
    if (m === 'off') return 'Nothing on this computer is shared. Note: many Soulseek users refuse downloads to people who share nothing.'
    var where = (dirs && dirs.length) ? dirs.join(', ') : 'nothing yet (no folder set)'
    if (m === 'downloads') return 'Only your download folder is shared: ' + where + '. Other people can browse and download those files.'
    return 'Your first music folder is shared: ' + where + '. Other people on Soulseek can browse and download everything in it (images, logs and text files are hidden).'
  }

  return { MODES: MODES, DEFAULT: DEFAULT, normalise: normalise, shareDirs: shareDirs, describe: describe }
})
