// What the right-click menu offers, decided from the item you clicked.
//
// The app has ONE static context menu shared by every list, so a playlist row
// and an album card get the same items. That is how a playlist row ended up
// offering "Move to Trash…" — deleting the file off disk — when the only thing
// a person means there is "take it out of this playlist".
//
// Two rules are enforced here rather than left to each caller:
//   1. Removing something from a list is NEVER styled or worded as a deletion,
//      and never carries `danger`.
//   2. `danger` means one thing only: files leave the disk. Nothing else may
//      set it.

var LABELS = {
  'ctx-play':            'Play',
  'ctx-queue':           'Add to queue',
  'ctx-play-next':       'Play next',
  'ctx-radio':           'Go to Radio',
  'ctx-addpl':           'Add to playlist',
  'ctx-wishlist':        'Add to wishlist',
  'ctx-artist':          'View artist',
  'ctx-copy-path':       'Copy file path',
  'ctx-show-folder':     'Show in folder',
  'ctx-trash':           'Move to Trash…',
  'ctx-like':            'Like',
  'ctx-remove-playlist': 'Remove from playlist',
  'ctx-remove-queue':    'Remove from queue',
  'ctx-queue-up':        'Move up in queue',
  'ctx-queue-down':      'Move down in queue',
  'ctx-unlike':          'Remove from Liked Songs',
  'ctx-edit-tags':       'Edit tags…',
  'ctx-artwork':         'Set artwork…',
  'ctx-rename':          'Rename folder…',
  'ctx-move':            'Move to…',
}

// Items that take files off the disk. The single source of truth for `danger`.
var DISK_SCOPED = { 'ctx-trash': true }

function item(id, opts) {
  opts = opts || {}
  return {
    id: id,
    label: opts.label || LABELS[id] || id,
    danger: !!DISK_SCOPED[id],
    separatorBefore: !!opts.separatorBefore,
  }
}

function isStreamKind(kind) {
  return kind === 'yt-track' || kind === 'stream'
}

function menuItemsFor(ctx) {
  ctx = ctx || {}
  var kind = ctx.kind || 'track'
  var out = []

  // — playback —
  if (kind !== 'folder-node') {
    out.push(item('ctx-play'))
    out.push(item('ctx-queue'))
    out.push(item('ctx-play-next'))
  }
  if (ctx.artist && kind !== 'folder-node') out.push(item('ctx-radio'))
  if (kind !== 'folder-node' && kind !== 'artist') out.push(item('ctx-addpl'))
  if (kind === 'album' || kind === 'search-result') out.push(item('ctx-wishlist'))
  if (ctx.artist && kind !== 'artist' && kind !== 'folder-node') out.push(item('ctx-artist'))

  // — list membership. Never destructive, never worded like a delete. —
  var listItem = null
  if (kind === 'playlist-track') {
    listItem = item('ctx-remove-playlist', {
      label: ctx.listName ? 'Remove from “' + ctx.listName + '”' : LABELS['ctx-remove-playlist'],
    })
  } else if (kind === 'queue-item') {
    // Roadmap 118/046: reordering without a drag. Shown whenever the row can
    // move in that direction; the renderer passes queueIdx and queueLength.
    var qi = Number(ctx.queueIdx), qn = Number(ctx.queueLength)
    if (Number.isFinite(qi) && qi > 0) out.push(item('ctx-queue-up', { separatorBefore: true }))
    if (Number.isFinite(qi) && Number.isFinite(qn) && qi < qn - 1) out.push(item('ctx-queue-down', { separatorBefore: !(qi > 0) }))
    listItem = item('ctx-remove-queue')
  } else if (kind === 'liked-track') {
    listItem = item('ctx-unlike')
  }
  if (listItem) { listItem.separatorBefore = true; out.push(listItem) }

  // — files on disk. Only for things that actually have a path. —
  var diskBacked = !isStreamKind(kind) && ctx.hasPath !== false
  if (diskBacked) {
    // Only things that ARE a folder can be renamed or moved. A single track
    // inside an album is not one, and offering it there would be a lie.
    // Tags belong to files, so anything file-backed can be retagged.
    if (kind !== 'folder-node') out.push(item('ctx-edit-tags', { separatorBefore: !listItem }))
    // Artwork is an album-level thing; setting it from one track of many would
    // be ambiguous about which album it belongs to.
    if (kind === 'album') out.push(item('ctx-artwork'))
    if (kind === 'album' || kind === 'folder-node') {
      out.push(item('ctx-rename', { separatorBefore: kind === 'folder-node' && !listItem }))
      out.push(item('ctx-move'))
    }
    out.push(item('ctx-copy-path', { separatorBefore: !listItem && kind !== 'album' && kind !== 'folder-node' }))
    // Previously omitted for albums because the handler only read a track path;
    // an album resolves to its first track, so there is no reason to hide it.
    out.push(item('ctx-show-folder'))
    out.push(item('ctx-trash'))
  }

  // — album-level like, last, on its own —
  if (kind === 'album') {
    out.push(item('ctx-like', {
      label: ctx.isLiked ? 'Unlike' : 'Like',
      separatorBefore: true,
    }))
  }

  return out
}

// Wording for the disk-delete confirmation, kept next to the menu it belongs to
// so the two cannot drift apart.
function deleteTitleFor(ctx, fileCount) {
  var n = fileCount || 0
  if (ctx && ctx.kind === 'artist') return 'Move everything by this artist to Trash?'
  if (ctx && ctx.kind === 'album') return 'Move this album to Trash?'
  if (ctx && ctx.kind === 'folder-node') return 'Move this folder to Trash?'
  return 'Move ' + n + ' file' + (n === 1 ? '' : 's') + ' to Trash?'
}

// Named per file on purpose: eight scripts share one global scope, and a bare
// `var API` in each meant every later file overwrote the earlier binding. It
// was latent only because each one reads it on the next line.
var _PapaCtxMenu = {
  LABELS: LABELS,
  DISK_SCOPED: DISK_SCOPED,
  menuItemsFor: menuItemsFor,
  deleteTitleFor: deleteTitleFor,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaCtxMenu
if (typeof window !== 'undefined') window.PapaCtxMenu = _PapaCtxMenu
