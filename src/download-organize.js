'use strict';
// Post-download verification (roadmap #49) and auto-organize (roadmap #50), the
// pure half: folder grouping, verdict shapes, and target-path building. All the
// decisions live here so they can be unit-tested without slskd, ffprobe or a
// real disk; main.js supplies the I/O (ffprobe channel probe, fs move) and calls
// these to decide what to do.
//
// A Soulseek "album group" is one remote folder's worth of files from one peer,
// keyed `username::folder`. The scheduler tracks individual files; this maps a
// completed file back to its group and reports when a whole group is done.
//
// UMD-wrapped like the other src/ modules.
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('path') : null
  )
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaDownloadOrganize = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodePath) {

  // Split a slskd remote filename (backslash- or forward-slash-separated) into
  // path segments, dropping empties. slskd reports Windows-style paths for most
  // peers, so both separators must be handled.
  function _segments(filename) {
    return String(filename == null ? '' : filename)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
  }

  // The immediate parent folder of a remote file — the album folder. This is the
  // grouping key's folder half. Empty when the file has no parent (a loose file
  // at the peer's share root), which the caller treats as ungroupable.
  function folderOf(filename) {
    const segs = _segments(filename)
    return segs.length >= 2 ? segs[segs.length - 2] : ''
  }

  // The full remote folder PATH (everything but the basename), used as the group
  // identity so two different albums that happen to share a leaf folder name
  // ("CD1") under different parents do not collapse together.
  function folderPathOf(filename) {
    const segs = _segments(filename)
    return segs.slice(0, -1).join('/')
  }

  function groupKey(username, filename) {
    return String(username || '') + '::' + folderPathOf(filename)
  }

  // Does a folder name (or any file in it) claim to be surround? The label the
  // download promised, used by the surround check. Matches the tokens the
  // shelves/fingerprint code recognises: 5.1, 7.1, 5 1, surround, multichannel,
  // atmos. Returns the canonical label ('5.1'/'7.1'/'surround') or null.
  function surroundLabel(text) {
    const s = String(text || '').toLowerCase()
    if (/\b7[._ ]?1\b/.test(s)) return '7.1'
    if (/\b5[._ ]?1\b/.test(s)) return '5.1'
    if (/\batmos\b/.test(s)) return 'surround'
    if (/\bmulti[- ]?channel\b/.test(s) || /\bsurround\b/.test(s)) return 'surround'
    return null
  }

  // Build the group ledger from the set of files the user enqueued. Each item is
  // { username, filename }. Returns a map of groupKey -> {
  //   username, folder, folderPath, expected, files:Set<filename>, surroundLabel
  // }. `expected` is the enqueued track count for the folder — the completeness
  // baseline #49 checks the finished count against.
  function buildGroups(items) {
    const groups = new Map()
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || !it.filename) continue
      const folderPath = folderPathOf(it.filename)
      if (!folderPath) continue // loose file, not an album group
      const key = groupKey(it.username, it.filename)
      let g = groups.get(key)
      if (!g) {
        g = {
          key,
          username: it.username || '',
          folder: folderOf(it.filename),
          folderPath,
          expected: 0,
          files: new Set(),
          surroundLabel: surroundLabel(it.filename) || surroundLabel(folderPath),
        }
        groups.set(key, g)
      }
      if (!g.files.has(it.filename)) { g.files.add(it.filename); g.expected++ }
      // A surround label on any file promotes the whole group.
      if (!g.surroundLabel) g.surroundLabel = surroundLabel(it.filename)
    }
    return groups
  }

  // Given a group and the set of filenames that have SUCCEEDED, is the group
  // complete? A group is complete when every enqueued file has succeeded (the
  // scheduler abandons dead files, so completeness is measured against what is
  // still wanted — the caller passes the still-wanted count as `outstanding`).
  function isGroupComplete(group, succeeded) {
    if (!group || !group.files || group.files.size === 0) return false
    for (const f of group.files) if (!succeeded.has(f)) return false
    return true
  }

  // Decide the verification verdict from the probe results. `probes` is an array
  // of { filename, filePath, ok, channels } (ok=false means ffprobe could not
  // read it — corrupt/incomplete). `expected` is the enqueued track count.
  // Returns { ok, problems:[{type, ...}] } — the persisted per-folder verdict
  // shape (#49). Problem types:
  //   'corrupt'       — a file ffprobe could not read      { filename }
  //   'missing'       — fewer files on disk than enqueued  { expected, found }
  //   'channels'      — surround-labelled but a stereo/mono file slipped in
  //                     { filename, channels, label }
  function verdict(probes, expected, label) {
    const list = Array.isArray(probes) ? probes : []
    const problems = []
    for (const p of list) {
      if (!p || p.ok === false) problems.push({ type: 'corrupt', filename: p && p.filename })
    }
    const found = list.length
    if (typeof expected === 'number' && expected > 0 && found < expected) {
      problems.push({ type: 'missing', expected, found })
    }
    if (label) {
      // Surround-labelled: every readable track must actually be surround
      // (>= 4 channels). One stereo track hiding in a 5.1 album is the failure
      // most likely to go unnoticed, so it is reported per file.
      for (const p of list) {
        if (!p || p.ok === false) continue
        const ch = Number(p.channels) || 0
        if (ch > 0 && ch < 4) {
          problems.push({ type: 'channels', filename: p.filename, channels: ch, label })
        }
      }
    }
    return { ok: problems.length === 0, problems }
  }

  // ── Auto-organize (#50) ──────────────────────────────────────────────────────

  // Characters that are illegal or hostile in a folder name on Linux/other FS,
  // plus leading/trailing dots and spaces that make folders awkward. Collapsed
  // to a single space, then trimmed. Never returns an empty string for a
  // non-empty input made only of illegal characters — it returns '' so the
  // caller can fall back to the original folder name.
  function sanitizeName(name) {
    return String(name || '')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim()
  }

  // Build the destination folder name from parsed album metadata (#50). Format:
  // "Artist - Album". A missing artist falls back to just the album; a missing
  // album falls back to the original folder name so a file is never orphaned
  // into a nameless folder. Returns '' when nothing usable is available, so the
  // caller skips the move rather than inventing a folder.
  //
  // `parsed` is the shape src/slsk-shelves.parseAlbumFolder returns:
  // { artist, album, year }. `fallbackFolder` is the original remote folder name.
  function targetFolderName(parsed, fallbackFolder) {
    const artist = sanitizeName(parsed && parsed.artist)
    const album = sanitizeName(parsed && parsed.album)
    if (artist && album) return `${artist} - ${album}`
    if (album) return album
    const fallback = sanitizeName(fallbackFolder)
    return fallback || ''
  }

  // Compute the concrete moves for one completed, verified group. Returns an
  // array of { from, to } absolute paths, plus the target directory. Pure: the
  // caller supplies the current on-disk file paths (`files`, absolute) and the
  // download root, and this decides where each goes. `pathJoin`/`basename`
  // default to node's path but are injectable for tests.
  //
  // Collision safety and the never-delete rule are enforced by the caller at
  // move time (a target that already exists is skipped); this only builds the
  // intended destinations.
  function planMoves(opts) {
    const {
      files,          // absolute source paths on disk
      downloadRoot,   // where organized folders are created
      targetName,     // from targetFolderName()
      pathJoin,
      basename,
    } = opts || {}
    const join = pathJoin || (nodePath && nodePath.join)
    const base = basename || (nodePath && nodePath.basename)
    if (!join || !base) return { targetDir: null, moves: [] }
    if (!targetName || !downloadRoot || !Array.isArray(files) || !files.length) {
      return { targetDir: null, moves: [] }
    }
    const targetDir = join(downloadRoot, targetName)
    const moves = []
    for (const from of files) {
      if (!from) continue
      const to = join(targetDir, base(from))
      // A file already sitting in its destination needs no move.
      if (from === to) continue
      moves.push({ from, to })
    }
    return { targetDir, moves }
  }

  return {
    folderOf,
    folderPathOf,
    groupKey,
    surroundLabel,
    buildGroups,
    isGroupComplete,
    verdict,
    sanitizeName,
    targetFolderName,
    planMoves,
  }
})
