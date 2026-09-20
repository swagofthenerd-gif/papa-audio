'use strict'
// What Papa Audio shares with Soulseek peers. The daemon used to be handed
// whatever folder the app picked for you — the first music folder, or the
// download folder — with no word said and only a three-way dropdown to
// change it. Now you tick the folders yourself, and this is the one place
// that turns those ticks into the directories the daemon is told about.
//
// Pure: no filesystem, no `require`, no Electron. It loads in main and in the
// renderer, so path handling here is string work only — the caller does every
// piece of I/O (does this folder still exist, where is home) and hands the
// answer in.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaSlskShare = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // The old three-way setting. Read exactly once more, by the migration
  // below, and never written again — see fromLegacyMode.
  var MODES = ['library', 'downloads', 'off']
  var DEFAULT = 'library'

  function normalise(mode) { return MODES.indexOf(mode) >= 0 ? mode : DEFAULT }

  // '/a/b/', '/a/./b' and '/a/c/../b' are all the same folder; say so in one
  // spelling. Text only: no symlinks are followed and nothing is touched on
  // disk, because this also runs in the renderer where there is no `path`.
  function normalisePath(p) {
    if (typeof p !== 'string') return ''
    var s = p.trim()
    if (!s) return ''
    var absolute = s.charAt(0) === '/'
    var parts = s.split('/')
    var out = []
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i]
      if (!seg || seg === '.') continue
      if (seg === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop()
        else if (!absolute) out.push('..')
        continue
      }
      out.push(seg)
    }
    return absolute ? '/' + out.join('/') : out.join('/')
  }

  // Is `child` somewhere underneath `parent`? Both already normalised.
  function isInside(child, parent) {
    if (!child || !parent || child === parent) return false
    return child.indexOf(parent === '/' ? '/' : parent + '/') === 0
  }

  // Normalise a list, drop the empties, keep the first spelling of each
  // folder. Order is the order it was given in.
  function _clean(list) {
    var arr = Array.isArray(list) ? list : []
    var seen = Object.create(null)
    var out = []
    for (var i = 0; i < arr.length; i++) {
      var p = normalisePath(arr[i])
      if (!p || seen[p]) continue
      seen[p] = true
      out.push(p)
    }
    return out
  }

  // A ticked folder that sits inside another ticked folder is not told to the
  // daemon — the parent already covers everything in it, and sending both
  // makes slskd index the same files twice. The child is not thrown away
  // silently: it comes back in `covered`, naming the folder that covers it,
  // so its row in the list can say so.
  //
  // -> { dirs: string[], covered: [{ path, coveredBy }] }
  function collapse(selection) {
    var dirs = _clean(selection)
    var kept = []
    var covered = []
    for (var i = 0; i < dirs.length; i++) {
      var top = ''
      for (var j = 0; j < dirs.length; j++) {
        if (i === j || !isInside(dirs[i], dirs[j])) continue
        // The shortest ancestor is the one that actually goes to the daemon:
        // anything longer is itself covered by it.
        if (!top || dirs[j].length < top.length) top = dirs[j]
      }
      if (top) covered.push({ path: dirs[i], coveredBy: top })
      else kept.push(dirs[i])
    }
    return { dirs: kept, covered: covered }
  }

  // A folder that is not there any more is never sent to the daemon. This
  // module does no I/O, so the caller hands in the existence test
  // (fs.existsSync in main) and gets both halves back — the missing ones are
  // what the list paints as "can't find this folder any more".
  //
  // -> { present: string[], missing: string[] }
  function filterMissing(selection, exists) {
    var dirs = _clean(selection)
    var test = typeof exists === 'function' ? exists : function () { return true }
    var present = []
    var missing = []
    for (var i = 0; i < dirs.length; i++) {
      (test(dirs[i]) ? present : missing).push(dirs[i])
    }
    return { present: present, missing: missing }
  }

  // The one and only read of the old slskShareMode, run the first time
  // anything asks for slskShareFolders and finds it undefined.
  //
  // EVERY ROW HERE REPRODUCES EXACTLY WHAT THE OLD shareDirs() RETURNED FOR
  // THE SAME INPUTS. That is the whole point: upgrading must not change one
  // byte of what a person shares. test/slsk-share.test.js pins it against a
  // copy of the old code.
  //
  //   'library'                  -> the FIRST music folder only
  //   'library', no music folders-> the download folder, if there is one
  //   'downloads'                -> the download folder, if there is one
  //   'off'                      -> nothing
  //   anything else              -> same as 'library' (the old default)
  function fromLegacyMode(mode, musicFolders, downloadDir) {
    var m = normalise(mode)
    if (m === 'off') return []
    if (m === 'downloads') return downloadDir ? [downloadDir] : []
    var folders = Array.isArray(musicFolders) ? musicFolders : []
    var first = folders.filter(Boolean)[0]
    if (first) return [first]
    return downloadDir ? [downloadDir] : []
  }

  // The directories slskd should share (may be empty).
  //
  // `selection` is the ticked list. Anything that is not an array — undefined,
  // or one of the old mode strings — means "not migrated yet" and is routed
  // through fromLegacyMode, so an old store and a new one produce the same
  // file. Missing folders are the caller's job to drop first; this does no I/O.
  function shareDirs(selection, musicFolders, downloadDir) {
    var picked = Array.isArray(selection)
      ? selection
      : fromLegacyMode(selection, musicFolders, downloadDir)
    return collapse(picked).dirs
  }

  // The sentence shown under the folder list.
  function describe(dirs, legacyDirs) {
    // Called as describe(dirs). describe(mode, dirs) was the old shape and is
    // still understood, so a caller mid-migration gets a true sentence rather
    // than the word "library" read back as a folder name.
    var list = _clean(Array.isArray(dirs) ? dirs : legacyDirs)
    if (!list.length) {
      return "You're not sharing anything. Soulseek still works — you can " +
        'search and download — but a lot of people won\'t let you download ' +
        'from them if you share nothing back.'
    }
    var where = list.length === 1 ? 'this folder: ' : 'these folders: '
    return 'Other people can browse and download anything in ' + where +
      list.join(', ') + '. Images, logs and text files stay hidden.'
  }

  // Folders that must never go out whole, whatever the folder chooser
  // returns. Sharing any of these puts private files on Soulseek, and none
  // of them is where anybody keeps their music.
  var DRIVE_ROOTS = ['/', '/home', '/mnt', '/media', '/run']
  var HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads']

  var REFUSAL_DRIVE = "That's a whole drive. Pick the folder your music is " +
    'actually in.'
  var REFUSAL_HOME = "That's your whole home folder — sharing it would put " +
    'everything on this computer on Soulseek. Pick a music folder instead.'
  var REFUSAL_PERSONAL = "That's a personal folder, not music — sharing it " +
    'would put private files on Soulseek. Pick a music folder instead.'
  var REFUSAL_INVALID = "That doesn't look like a folder on this computer. " +
    'Pick a music folder instead.'

  // Should this folder be refused before it is ever added to the list?
  // Pure, so main can call it on whatever the folder chooser returns.
  //
  //   pickRefusal(dir, { home, slskdDir })
  //     -> null                      the folder is fine
  //     -> { reason, error }         show `error`, add nothing
  //
  // A folder deep inside home is fine — it is the blanket folders that are
  // refused, not everything under them.
  function pickRefusal(dir, opts) {
    var o = opts || {}
    var p = normalisePath(dir)
    if (!p || p.charAt(0) !== '/') {
      return { reason: 'invalid', error: REFUSAL_INVALID }
    }
    if (DRIVE_ROOTS.indexOf(p) >= 0) {
      return { reason: 'drive', error: REFUSAL_DRIVE }
    }
    var home = normalisePath(o.home)
    if (home && p === home) return { reason: 'home', error: REFUSAL_HOME }
    var slskd = normalisePath(o.slskdDir)
    if (slskd && (p === slskd || isInside(p, slskd))) {
      return { reason: 'slskd', error: REFUSAL_PERSONAL }
    }
    // Any dotfolder, at any depth: ~/.config, ~/.ssh and everything in them.
    var segs = p.split('/')
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].charAt(0) === '.') {
        return { reason: 'personal', error: REFUSAL_PERSONAL }
      }
    }
    for (var j = 0; home && j < HOME_FOLDERS.length; j++) {
      if (p === home + '/' + HOME_FOLDERS[j]) {
        return { reason: 'personal', error: REFUSAL_PERSONAL }
      }
    }
    return null
  }

  return {
    MODES: MODES,
    DEFAULT: DEFAULT,
    normalise: normalise,
    normalisePath: normalisePath,
    isInside: isInside,
    collapse: collapse,
    filterMissing: filterMissing,
    fromLegacyMode: fromLegacyMode,
    shareDirs: shareDirs,
    describe: describe,
    pickRefusal: pickRefusal
  }
})
