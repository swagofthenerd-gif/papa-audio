// Duplicates 2.0 — honest reclaimable space and safe auto-pick rules.
//
// THE 0 MB BUG
// ------------
// library-manage.js's assessGroup() computes group.deletableBytes as the sum of
// only the folders where f.safeToDelete === true, and safeToDelete is true only
// when the group is `reliable` AND some other copy strictly covers this one
// (more channels, every track present). assessGroup marks a group UNRELIABLE the
// moment "every copy has the same channel layout" — which is the single most
// common real duplicate: two stereo rips of the same album. So for ordinary
// duplicates deletableBytes is 0 for every folder, and the header summed 0.
//
// That conservative number answers one question — "what can I delete with zero
// judgement because a strictly-better copy already holds every track?" — and it
// should stay exactly as strict as it is, because deleting the stereo copy of a
// surround upgrade that is missing tracks destroys music. But it is the WRONG
// number for the header, which the user reads as "how much space are these
// duplicates costing me?".
//
// This module answers THAT question instead, without ever silently deciding to
// delete: given a duplicate group, pick which copies to KEEP under a stated rule
// ("keep the best quality", "keep the largest"), and report the summed size of
// the copies that rule would drop. The keepers are always the winners; the
// losers are only ever *proposed* for review — the caller still runs them
// through the same confirm-and-trash funnel.

;(function () {
  // A copy's quality rank, best first. Mirrors slsk-shelves' upgrade ordering:
  // lossless beats lossy, then bit depth, then sample rate. Channels are NOT a
  // quality tiebreak here on purpose — a 5.1 rip is a different edition, not a
  // better copy of the stereo one, and library-manage already refuses to treat
  // one as covering the other. We compare like editions.
  function _isLosslessCodecs(codecs) {
    // buildFolders stores { codec: count }. A folder is lossless if the majority
    // of its tracks are a lossless codec.
    var loss = 0
    var total = 0
    for (var c in (codecs || {})) {
      if (!Object.prototype.hasOwnProperty.call(codecs, c)) continue
      total += codecs[c]
      if (/^(flac|alac|ape|wavpack|wav|pcm|dsd|dsf|dff|truehd|mlp)/i.test(c)) loss += codecs[c]
    }
    return total > 0 && loss >= total / 2
  }

  // A single comparable quality tuple for a folder entry (from buildFolders).
  function qualityOf(folder) {
    var f = folder || {}
    return {
      lossless: _isLosslessCodecs(f.codecs),
      bitDepth: Number(f.maxBitDepth) || 0,
      sampleRate: Number(f.maxSampleRate) || 0,
      bytes: Number(f.bytes) || 0,
      trackCount: Number(f.trackCount) || 0,
      channels: Number(f.maxChannels) || 0,
    }
  }

  // Compare two folders by quality. Returns >0 when a is better than b, <0 when
  // worse, 0 when tied on every quality axis. Ordering: lossless > bit depth >
  // sample rate. (Size and track count are used only as tiebreakers so the
  // "best" pick is deterministic, never as the primary quality signal.)
  function _cmpQuality(a, b) {
    var qa = qualityOf(a)
    var qb = qualityOf(b)
    if (qa.lossless !== qb.lossless) return qa.lossless ? 1 : -1
    if (qa.bitDepth !== qb.bitDepth) return qa.bitDepth - qb.bitDepth
    if (qa.sampleRate !== qb.sampleRate) return qa.sampleRate - qb.sampleRate
    // Tiebreakers among genuinely equal-quality copies: keep the most complete,
    // then the largest, then a stable path order so the choice never flickers.
    if (qa.trackCount !== qb.trackCount) return qa.trackCount - qb.trackCount
    if (qa.bytes !== qb.bytes) return qa.bytes - qb.bytes
    return String(b.dir || '') < String(a.dir || '') ? 1 : -1
  }

  // "Keep the best quality" — within a group, keep the single highest-quality
  // copy and propose every other copy for review. A mixed-channel folder (holds
  // both stereo and surround tracks) is NEVER proposed for deletion: dropping it
  // wholesale would take its surround tracks with it. Neither is a folder that
  // holds a track no keeper has (a surround upgrade missing songs the stereo copy
  // has) — those are protected the same way library-manage protects them.
  //
  // Returns { keep: [dirs], drop: [dirs], reclaimBytes, protected: [{dir,reason}] }.
  function pickKeepBest(group) {
    return _pick(group, function (folders) {
      var best = folders[0]
      for (var i = 1; i < folders.length; i++) {
        if (_cmpQuality(folders[i], best) > 0) best = folders[i]
      }
      return [best]
    })
  }

  // "Keep the largest" — keep the single largest copy by bytes, propose the rest.
  // Same protections as pickKeepBest.
  function pickKeepLargest(group) {
    return _pick(group, function (folders) {
      var best = folders[0]
      for (var i = 1; i < folders.length; i++) {
        var bi = Number(folders[i].bytes) || 0
        var bb = Number(best.bytes) || 0
        if (bi > bb || (bi === bb && String(folders[i].dir) < String(best.dir))) best = folders[i]
      }
      return [best]
    })
  }

  // Union of the title sets of the keeper folders — the songs that survive.
  function _keeperTitles(keepers) {
    var titles = {}
    for (var i = 0; i < keepers.length; i++) {
      var t = keepers[i].titles || {}
      for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) titles[k] = true
    }
    return titles
  }

  // Which songs in `folder` are not present in the keeper set. These are the
  // tracks that would be lost forever if this folder were dropped.
  function _lostTitles(folder, keeperTitles) {
    var out = []
    var t = folder.titles || {}
    for (var k in t) {
      if (Object.prototype.hasOwnProperty.call(t, k) && !keeperTitles[k]) out.push(k)
    }
    return out
  }

  function _pick(group, chooseKeepers) {
    var folders = (group && group.folders) || []
    if (folders.length < 2) {
      return { keep: folders.map(function (f) { return f.dir }), drop: [], reclaimBytes: 0, protected: [] }
    }
    var keepers = chooseKeepers(folders.slice())
    var keepSet = {}
    for (var i = 0; i < keepers.length; i++) keepSet[keepers[i].dir] = true
    var keeperTitles = _keeperTitles(keepers)

    var drop = []
    var protectedList = []
    var reclaimBytes = 0
    for (var j = 0; j < folders.length; j++) {
      var f = folders[j]
      if (keepSet[f.dir]) continue
      // A folder holding both stereo and surround tracks is not a mere duplicate.
      if (f.mixedChannels) {
        protectedList.push({ dir: f.dir, reason: 'mixes stereo and surround tracks' })
        continue
      }
      // Would dropping it lose a song no keeper has? Then it is not redundant.
      var lost = _lostTitles(f, keeperTitles)
      if (lost.length) {
        protectedList.push({
          dir: f.dir,
          reason: 'has ' + lost.length + ' track' + (lost.length === 1 ? '' : 's') +
            ' the kept copy does not',
        })
        continue
      }
      drop.push(f.dir)
      reclaimBytes += Number(f.bytes) || 0
    }
    return {
      keep: keepers.map(function (k) { return k.dir }),
      drop: drop,
      reclaimBytes: reclaimBytes,
      protected: protectedList,
    }
  }

  // The header number, done right: across every duplicate group, how much space
  // a given rule would reclaim. Sums the per-group reclaimBytes of the chosen
  // rule. `rule` is 'best' (default) or 'largest'.
  function reclaimableAcross(groups, rule) {
    var pick = rule === 'largest' ? pickKeepLargest : pickKeepBest
    var total = 0
    for (var i = 0; i < (groups || []).length; i++) {
      total += pick(groups[i]).reclaimBytes
    }
    return total
  }

  var API = {
    qualityOf: qualityOf,
    pickKeepBest: pickKeepBest,
    pickKeepLargest: pickKeepLargest,
    reclaimableAcross: reclaimableAcross,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.PapaManageReclaim = API
})()
