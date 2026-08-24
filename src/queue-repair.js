// Queue repair after files disappear.
//
// When a track is deleted the queue still holds it. Fixing that is pure index
// arithmetic — which is exactly the kind of code that looks obviously right and
// is off by one. Removing an entry BEFORE the current index shifts the current
// track; removing the current entry means playback has to move somewhere; and
// removing everything has to land on a defined state rather than index -1 into
// an empty array.

function pathSet(paths) {
  var out = {}
  for (var i = 0; i < (paths || []).length; i++) {
    if (paths[i]) out[String(paths[i])] = true
  }
  return out
}

function repairQueue(opts) {
  var queue = (opts && opts.queue) || []
  var index = (opts && typeof opts.queueIndex === 'number') ? opts.queueIndex : 0
  var doomed = pathSet(opts && opts.removedPaths)

  var kept = []
  var removedBefore = 0
  var removedCurrent = false
  var removedCount = 0

  for (var i = 0; i < queue.length; i++) {
    var t = queue[i]
    var fp = t && t.filePath
    if (fp && doomed[String(fp)]) {
      removedCount++
      if (i < index) removedBefore++
      else if (i === index) removedCurrent = true
      continue
    }
    kept.push(t)
  }

  if (!kept.length) {
    return { queue: [], queueIndex: 0, removedCurrent: removedCurrent, removedCount: removedCount, empty: true, nextIndex: -1 }
  }

  var nextIndex
  if (removedCurrent) {
    // The slot the current track occupied now holds whatever followed it.
    nextIndex = index - removedBefore
    if (nextIndex > kept.length - 1) nextIndex = kept.length - 1
    if (nextIndex < 0) nextIndex = 0
  } else {
    nextIndex = index - removedBefore
    if (nextIndex > kept.length - 1) nextIndex = kept.length - 1
    if (nextIndex < 0) nextIndex = 0
  }

  return {
    queue: kept,
    queueIndex: nextIndex,
    removedCurrent: removedCurrent,
    removedCount: removedCount,
    empty: false,
    nextIndex: nextIndex,
  }
}

// Which queue entries a pending delete would hit, so the user can be warned
// BEFORE the files go rather than discovering it when playback stops.
function queueImpact(queue, index, removedPaths) {
  var doomed = pathSet(removedPaths)
  var hits = []
  var playingHit = false
  for (var i = 0; i < (queue || []).length; i++) {
    var t = queue[i]
    var fp = t && t.filePath
    if (!fp || !doomed[String(fp)]) continue
    hits.push({ index: i, filePath: fp, title: (t && t.title) || '' })
    if (i === index) playingHit = true
  }
  return { hits: hits, count: hits.length, playingHit: playingHit }
}

var API = { repairQueue: repairQueue, queueImpact: queueImpact, pathSet: pathSet }

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.PapaQueueRepair = API
