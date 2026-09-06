// Album-art colour extraction for the Now Playing surfaces.
//
// The fullscreen player is meant to feel like the record is lighting the room:
// the scrim, the play button and the seek hairline all take their colour from
// the cover. This module turns an <img> (or a URL) into three usable colours —
// a dominant background tone, a vivid accent for controls/highlights, and a
// muted mid-tone for secondary text — with no external dependency and no
// network. It downsamples the image to 16x16 on a canvas and does the rest in
// pure arithmetic, so the maths is unit-testable without a browser at all.
//
// Two halves, deliberately split:
//   • palettePfrom(pixels)   — pure. Takes an RGBA byte array (any length that
//                              is a multiple of 4) and returns {dominant,
//                              accent, muted}. This is what the tests exercise.
//   • extractPalette(imgOrUrl) — the browser wrapper. Draws to a guarded 16x16
//                              canvas, reads the pixels, hands them to
//                              palettePfrom, and caches the result per album id.
//
// The wrapper is guarded for the test/headless environment (no document, no
// canvas, a tainted cross-origin image, a canvas that refuses to give up its
// data): every failure path returns null so the caller falls back to the app
// accent rather than throwing.

(function () {
  'use strict'

  var DOWNSAMPLE = 16          // 16x16 = 256 samples: enough to be stable, cheap
  var CACHE_CAP = 100          // per-album results; oldest evicted past the cap

  // ── colour helpers (pure) ─────────────────────────────────────────────────

  function clamp8(n) {
    n = Math.round(n)
    return n < 0 ? 0 : n > 255 ? 255 : n
  }

  function toHex(r, g, b) {
    return '#' + [clamp8(r), clamp8(g), clamp8(b)].map(function (v) {
      var s = v.toString(16)
      return s.length === 1 ? '0' + s : s
    }).join('')
  }

  // Relative luminance, 0..255 scale (Rec. 601 weights — cheap and good enough
  // for deciding light vs dark text/scrim).
  function luma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  // HSV saturation and value, 0..1. Used to pick the *accent*: the pixel bucket
  // with the most colour, not the most pixels (a cover is mostly its background,
  // and the background is usually the dull part).
  function satVal(r, g, b) {
    var max = Math.max(r, g, b)
    var min = Math.min(r, g, b)
    var v = max / 255
    var s = max === 0 ? 0 : (max - min) / max
    return { s: s, v: v }
  }

  // Nudge a colour toward a target luminance so an accent stays legible on a
  // dark scrim: if it is too dark, lighten it; too bright, darken it. Preserves
  // hue by scaling the channels together.
  function ensureVivid(rgb) {
    var l = luma(rgb[0], rgb[1], rgb[2])
    if (l < 60) {
      var up = 90 / Math.max(l, 1)
      return [clamp8(rgb[0] * up), clamp8(rgb[1] * up), clamp8(rgb[2] * up)]
    }
    if (l > 210) {
      var down = 190 / l
      return [clamp8(rgb[0] * down), clamp8(rgb[1] * down), clamp8(rgb[2] * down)]
    }
    return [clamp8(rgb[0]), clamp8(rgb[1]), clamp8(rgb[2])]
  }

  // Group pixels into a coarse RGB grid so near-identical shades count together,
  // then return the buckets sorted by population. Each bucket keeps the running
  // average colour of the pixels that fell into it, not the grid centre, so the
  // returned colour is the true average rather than a quantised approximation.
  function bucketize(pixels, step) {
    var buckets = new Map()
    for (var i = 0; i + 3 < pixels.length; i += 4) {
      var a = pixels[i + 3]
      if (a < 125) continue                 // skip transparent padding
      var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
      // Skip near-white and near-black: they dominate scans and carry no hue,
      // so they would drown out the album's actual colour.
      var l = luma(r, g, b)
      if (l < 12 || l > 244) continue
      var key = (Math.round(r / step)) + ',' +
                (Math.round(g / step)) + ',' +
                (Math.round(b / step))
      var e = buckets.get(key)
      if (e) { e.n++; e.r += r; e.g += g; e.b += b }
      else buckets.set(key, { n: 1, r: r, g: g, b: b })
    }
    var out = []
    buckets.forEach(function (e) {
      out.push({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n })
    })
    out.sort(function (x, y) { return y.n - x.n })
    return out
  }

  // The pure core. Given an RGBA byte array, return the three named colours.
  // Falls back sensibly when the image is empty or single-colour so a caller
  // always gets a usable, complete object (never a partial one).
  function palettePfrom(pixels) {
    if (!pixels || !pixels.length || pixels.length % 4 !== 0) {
      return { dominant: '#2a2a2e', accent: '#7fa8ff', muted: '#8a8a90' }
    }
    var buckets = bucketize(pixels, 24)
    if (!buckets.length) {
      // Everything was clipped as near-black/white/transparent: read the plain
      // average so a monochrome cover still tints rather than defaulting.
      var sr = 0, sg = 0, sb = 0, sn = 0
      for (var i = 0; i + 3 < pixels.length; i += 4) {
        if (pixels[i + 3] < 125) continue
        sr += pixels[i]; sg += pixels[i + 1]; sb += pixels[i + 2]; sn++
      }
      if (!sn) return { dominant: '#2a2a2e', accent: '#7fa8ff', muted: '#8a8a90' }
      var ar = sr / sn, ag = sg / sn, ab = sb / sn
      var av = ensureVivid([ar, ag, ab])
      return {
        dominant: toHex(ar, ag, ab),
        accent: toHex(av[0], av[1], av[2]),
        muted: toHex((ar + 128) / 2, (ag + 128) / 2, (ab + 128) / 2)
      }
    }

    // Dominant: the most populous bucket.
    var dom = buckets[0]
    var dominant = toHex(dom.r, dom.g, dom.b)

    // Accent: the bucket with the highest saturation*value*population score,
    // considering only buckets with real presence so a single stray vivid pixel
    // cannot win. This is what makes the accent read as "the colour of the
    // record" rather than "the colour of the background".
    var best = null, bestScore = -1
    for (var b = 0; b < buckets.length; b++) {
      var bk = buckets[b]
      var sv = satVal(bk.r, bk.g, bk.b)
      var score = sv.s * sv.v * Math.sqrt(bk.n)
      if (score > bestScore) { bestScore = score; best = bk }
    }
    if (!best) best = dom
    var acc = ensureVivid([best.r, best.g, best.b])
    var accent = toHex(acc[0], acc[1], acc[2])

    // Muted: a mid-population bucket, pulled toward mid-grey so secondary text
    // stays readable regardless of the cover. Prefer the second bucket if there
    // is one, else derive from the dominant.
    var mid = buckets[Math.min(1, buckets.length - 1)]
    var muted = toHex((mid.r + 138) / 2, (mid.g + 138) / 2, (mid.b + 138) / 2)

    return { dominant: dominant, accent: accent, muted: muted }
  }

  // ── the cache (LRU-ish, capped) ───────────────────────────────────────────
  // Keyed by album id so switching tracks within one album is free, and so the
  // Map never grows without bound however long the app runs.
  var _cache = new Map()

  function cacheGet(id) {
    if (id == null) return undefined
    var v = _cache.get(id)
    if (v !== undefined) {
      // Touch: move to newest so it survives eviction.
      _cache.delete(id); _cache.set(id, v)
    }
    return v
  }

  function cacheSet(id, val) {
    if (id == null) return
    if (_cache.has(id)) _cache.delete(id)
    _cache.set(id, val)
    while (_cache.size > CACHE_CAP) {
      var oldest = _cache.keys().next().value
      _cache.delete(oldest)
    }
  }

  function cacheClear() { _cache.clear() }

  // ── the browser wrapper ───────────────────────────────────────────────────
  // Returns a Promise<{dominant,accent,muted}|null>. null means "extraction was
  // not possible here" — the caller falls back to the app accent. Never throws.
  function _readPixels(imgEl) {
    // Guard everything the headless/test world lacks or that a cross-origin
    // image will trip. Any miss returns null → caller falls back.
    if (typeof document === 'undefined' || !document.createElement) return null
    if (!imgEl || !imgEl.naturalWidth) return null
    var canvas
    try { canvas = document.createElement('canvas') } catch (_) { return null }
    if (!canvas.getContext) return null
    canvas.width = DOWNSAMPLE
    canvas.height = DOWNSAMPLE
    var ctx
    try { ctx = canvas.getContext('2d', { willReadFrequently: true }) } catch (_) { return null }
    if (!ctx) return null
    try {
      ctx.drawImage(imgEl, 0, 0, DOWNSAMPLE, DOWNSAMPLE)
      return ctx.getImageData(0, 0, DOWNSAMPLE, DOWNSAMPLE).data
    } catch (_) {
      // SecurityError from a tainted canvas, or a broken image: give up quietly.
      return null
    }
  }

  function _loadImage(url) {
    return new Promise(function (resolve) {
      if (typeof Image === 'undefined') { resolve(null); return }
      var img = new Image()
      // Local file:// art is same-origin under the app; crossOrigin lets remote
      // art be read too where the server allows it, and simply fails to null
      // (caught in _readPixels) where it does not.
      try { img.crossOrigin = 'anonymous' } catch (_) {}
      img.onload = function () { resolve(img) }
      img.onerror = function () { resolve(null) }
      img.src = url
    })
  }

  // extractPalette(imgElOrUrl, albumId)
  //   imgElOrUrl : an <img> already in the DOM, or a URL string to load.
  //   albumId    : optional cache key. When given, a repeat call is free.
  function extractPalette(imgElOrUrl, albumId) {
    if (albumId != null) {
      var hit = cacheGet(albumId)
      if (hit !== undefined) return Promise.resolve(hit)
    }
    var finish = function (pixels) {
      var pal = pixels ? palettePfrom(pixels) : null
      if (albumId != null) cacheSet(albumId, pal)
      return pal
    }
    // An <img> element: read directly if it is decoded, else wait for it.
    if (imgElOrUrl && typeof imgElOrUrl === 'object' && imgElOrUrl.tagName === 'IMG') {
      var el = imgElOrUrl
      if (el.complete && el.naturalWidth) {
        return Promise.resolve(finish(_readPixels(el)))
      }
      return new Promise(function (resolve) {
        var done = false
        var onDone = function () {
          if (done) return; done = true
          resolve(finish(_readPixels(el)))
        }
        el.addEventListener('load', onDone, { once: true })
        el.addEventListener('error', function () {
          if (done) return; done = true
          resolve(finish(null))
        }, { once: true })
      })
    }
    // A URL string.
    if (typeof imgElOrUrl === 'string' && imgElOrUrl) {
      return _loadImage(imgElOrUrl).then(function (img) {
        return finish(img ? _readPixels(img) : null)
      })
    }
    return Promise.resolve(finish(null))
  }

  var api = {
    palettePfrom: palettePfrom,
    extractPalette: extractPalette,
    // exposed for tests and for a deliberate clear on library reset
    _cacheGet: cacheGet,
    _cacheSet: cacheSet,
    _cacheClear: cacheClear,
    _cacheCap: CACHE_CAP,
    _luma: luma,
    _toHex: toHex
  }

  // Dual-mode, matching the rest of src/*: a global for the sandboxed renderer,
  // a CommonJS export for the tests. One implementation, no drift.
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.PapaPalette = api
})()
