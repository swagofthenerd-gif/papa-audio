'use strict';
// Anime absolute-numbering override — pure math + persistence, no DOM.
//
// The problem (roadmap #44): fansub groups number a continuing season
// absolutely ("Attack on Titan 64"), while AniList files each season as its own
// entry starting at episode 1. Main.js already translates automatically from the
// cached season chain (_animeAbsoluteEpisode), but that walk fails on a gap in
// the episode counts, a cold cache, or a mis-linked chain — and then the
// seasonal number stands alone and matches the wrong (or no) release. This is
// the rare manual escape hatch: the viewer states "this entry's episode 1 is
// really absolute episode N", and every episode is shifted by N-1.
//
// The apply path is renderer-only (main.js is untouchable this wave). See
// applyToRequest below: when an override exists we compute the absolute number
// ourselves, send it as the request's `episode`, and drop `anilistId` so main's
// own _animeAbsoluteEpisode never runs (it keys on anilistId and would either
// double-add prior seasons or overwrite our value). The anime provider matches
// on request.episode directly, so the shifted number reaches nyaa unchanged.
//
// UMD-wrapped so it loads as a classic <script> in the renderer and as a plain
// require() in the tests, without leaking bindings into the shared renderer
// scope.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PapaAnimeNumbering = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // localStorage key. A single object map: anilistId (string) -> startAbs, the
  // absolute episode number the entry's episode 1 corresponds to.
  const KEY = 'papa-anime-numbering';

  // A start number is valid when it is a whole number >= 1. "Episode 1 is
  // absolute 1" is the identity and means no shift, so it is treated as no
  // override at all (get returns null, set clears) — storing it would be a
  // no-op override that only clutters the map and the UI.
  function normalizeStart(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const i = Math.floor(n);
    if (i < 1) return null;
    return i;
  }

  // The stored start number for an id, or null when there is no override. Reads
  // are tolerant: a missing store, a non-object blob, or a bad member all read
  // as "no override" rather than throwing into the render path.
  function get(store, anilistId) {
    if (anilistId == null) return null;
    let map;
    try {
      map = store && typeof store.readObject === 'function'
        ? store.readObject(KEY) : null;
    } catch (_) { map = null; }
    if (!map || typeof map !== 'object') return null;
    const v = normalizeStart(map[String(anilistId)]);
    return v == null || v === 1 ? null : v;
  }

  // Persist (or clear) the override for an id. startAbs of 1, null, or anything
  // that does not normalize removes the entry — the identity is not an override.
  // Returns the value actually stored (null when cleared).
  function set(store, anilistId, startAbs) {
    if (anilistId == null || !store || typeof store.readObject !== 'function') return null;
    let map;
    try { map = store.readObject(KEY); } catch (_) { map = null; }
    if (!map || typeof map !== 'object') map = {};
    else map = Object.assign({}, map);
    const id = String(anilistId);
    const v = normalizeStart(startAbs);
    let stored = null;
    if (v == null || v === 1) delete map[id];
    else { map[id] = v; stored = v; }
    try {
      if (Object.keys(map).length) store.write(KEY, map);
      else if (typeof store.remove === 'function') store.remove(KEY);
      else store.write(KEY, map);
    } catch (_) { /* a full store must not break the dialog */ }
    return stored;
  }

  // Remove any override for an id. Thin alias over set(..., null) for callers
  // that read as "clear" at the call site.
  function clear(store, anilistId) {
    return set(store, anilistId, null);
  }

  // The absolute episode number for a (start, episode) pair. Episode E under an
  // override that says "episode 1 is absolute N" is N + (E - 1). Returns null
  // when there is no usable override or episode, so the caller sends the request
  // unchanged and the automatic path (or the plain seasonal number) stands.
  function absoluteFor(startAbs, episode) {
    const s = normalizeStart(startAbs);
    if (s == null || s === 1) return null;
    const e = Number(episode);
    if (!Number.isFinite(e) || e < 1) return null;
    return s + (Math.floor(e) - 1);
  }

  // Rewrite a video-streams request in place-safe fashion (returns a new object)
  // so the override is honoured without any main-process change. Only touches
  // anime requests that carry an anilistId and an episode and have an override;
  // everything else is returned unchanged. See the module header for why
  // anilistId is dropped rather than kept.
  //
  // `req` is the object _videoStreamRequest() built; `startAbs` is the stored
  // override (get()'s return). A null/absent override is a pass-through.
  function applyToRequest(req, startAbs) {
    if (!req || req.type !== 'anime') return req;
    const abs = absoluteFor(startAbs, req.episode);
    if (abs == null) return req;
    const out = Object.assign({}, req);
    out.episode = abs;
    // Drop anilistId so main.js's _animeAbsoluteEpisode never fires on this
    // request — it keys on anilistId and would re-derive (and overwrite) the
    // number from the season chain, defeating the manual override. The anime
    // backends select on type and titles, not anilistId, so the lookup is
    // unaffected. absoluteEpisode is also cleared for the same reason.
    out.anilistId = undefined;
    if ('absoluteEpisode' in out) out.absoluteEpisode = undefined;
    // A marker the renderer can read back for a subtle "using your numbering"
    // hint; ignored by main, which destructures only the fields it knows.
    out._numberingOverride = abs;
    return out;
  }

  return { KEY, normalizeStart, get, set, clear, absoluteFor, applyToRequest };
});
