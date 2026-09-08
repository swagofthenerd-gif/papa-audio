// Manage dashboard — the stat-card model for the landing overview.
//
// Pure. Takes the results the five tools already produce and folds them into the
// card model the renderer paints. Every field degrades gracefully: a missing
// input yields a card that says "not measured yet" rather than a wrong number,
// so the dashboard can paint instantly from cache and fill in as fresh results
// land.

;(function () {
  function _num(v) { var n = Number(v); return isFinite(n) ? n : 0 }

  // Health score: a composite 0–100 from the health findings. Start at 100 and
  // dock points by severity, weighted by how many items each finding covers, so
  // one broken file dents it a little and a hundred dent it a lot — but it never
  // goes negative and a clean library scores 100.
  function healthScore(findings) {
    findings = findings || []
    if (!findings.length) return 100
    var penalty = 0
    var weight = { high: 6, medium: 2.5, low: 0.8 }
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i]
      var w = weight[f.severity] != null ? weight[f.severity] : 1
      // Diminishing: the first few items of a kind hurt most; a long tail adds
      // little. log keeps a 500-item finding from zeroing the whole score.
      var count = _num(f.count) || (f.paths ? f.paths.length : 0)
      penalty += w * (1 + Math.log10(1 + Math.max(0, count)))
    }
    var score = Math.round(100 - penalty)
    if (score < 0) score = 0
    if (score > 100) score = 100
    return score
  }

  function healthLabel(score) {
    if (score >= 90) return 'Healthy'
    if (score >= 70) return 'Minor issues'
    if (score >= 40) return 'Needs attention'
    return 'Poor'
  }

  // Build the whole card model. Inputs are all optional; each is the raw output
  // of the corresponding tool:
  //   storage    — { formats:[{format,bytes,tracks}], totalBytes } (music-tools.storageByFormat)
  //   duplicates — { groups:[...], reclaimBytes }  (library-manage.findDuplicates + reclaim)
  //   health     — [findings]                       (library-health.assessLibrary)
  //   genres     — { groups:[...], ungenred }       (music-tools.analyzeGenres)
  //   trash      — { items:[...], totalBytes }       (library-trash-list)
  function buildDashboard(input) {
    input = input || {}
    var storage = input.storage || null
    var duplicates = input.duplicates || null
    var health = input.health || null
    var genres = input.genres || null
    var trash = input.trash || null

    // Health.
    var hFindings = health && health.findings ? health.findings : (Array.isArray(health) ? health : null)
    var hScore = hFindings ? healthScore(hFindings) : null

    // Storage per-format split (top formats, largest first), for the mini bar.
    var formats = (storage && storage.formats) || []
    var storageTotal = storage ? _num(storage.totalBytes) : null

    // Duplicates.
    var dupGroups = duplicates && duplicates.groups ? duplicates.groups.length : null
    var dupReclaim = duplicates ? _num(duplicates.reclaimBytes) : null

    // Genres: variants to merge + albums with no genre.
    var genreVariants = null
    var genreMissing = null
    if (genres) {
      var messy = (genres.groups || []).filter(function (g) { return (g.variants || []).length > 1 })
      genreVariants = messy.length
      genreMissing = _num(genres.ungenred)
    }

    // Trash.
    var trashCount = trash ? (trash.items || []).length : null
    var trashBytes = trash ? _num(trash.totalBytes) : null

    return {
      health: {
        available: hScore != null,
        score: hScore,
        label: hScore != null ? healthLabel(hScore) : null,
        findingCount: hFindings ? hFindings.length : null,
      },
      storage: {
        available: storageTotal != null,
        totalBytes: storageTotal,
        formats: formats.map(function (f) {
          return { format: f.format, bytes: _num(f.bytes), tracks: _num(f.tracks) }
        }),
      },
      duplicates: {
        available: dupGroups != null,
        groupCount: dupGroups,
        reclaimBytes: dupReclaim,
      },
      genres: {
        available: genreVariants != null,
        variantCount: genreVariants,
        missingCount: genreMissing,
      },
      trash: {
        available: trashCount != null,
        itemCount: trashCount,
        bytes: trashBytes,
      },
    }
  }

  var API = {
    healthScore: healthScore,
    healthLabel: healthLabel,
    buildDashboard: buildDashboard,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.PapaManageDashboard = API
})()
