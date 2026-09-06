'use strict';
// Air-date notifications (roadmap #35), the pure half: given the merged airing
// schedule and the set of episode keys already notified, decide which shows have
// an episode inside the notify window and have not been told about yet. All the
// timing and dedupe logic lives here so it is unit-testable without Electron's
// Notification API or the network; main.js supplies the schedule (via the same
// _mergeAiring the airing shelf uses) and fires the actual Notifications.
//
// UMD-wrapped like the other src/ modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaAiringNotify = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The look-ahead: an episode airing within this window of "now" is due for a
  // heads-up. 24 hours, per the roadmap ("an episode airing in the next 24h").
  const DUE_WINDOW_MS = 24 * 60 * 60 * 1000

  // The notified-key ledger is capped so it cannot grow without bound over the
  // life of the install. 200, per the roadmap ("cap 200"). Oldest keys are
  // dropped first.
  const NOTIFIED_CAP = 200

  // The dedupe key for one airing: type + id + episode. The same show's next
  // episode is a new key, so a viewer is told once per episode, never twice for
  // the same one, and again when the following episode approaches.
  function notifyKey(row) {
    if (!row) return null
    const base = row.key != null ? String(row.key) : ''
    if (!base) return null
    const ep = row.episode == null ? '' : String(row.episode)
    return base + '#e' + ep
  }

  // Which rows in the schedule are due and unseen. A row is due when its airsAt
  // is in the future but within DUE_WINDOW_MS of now — an episode that already
  // aired is not a heads-up, and one further out than the window is not yet
  // relevant. `notified` is an array (or Set) of keys already fired. Returns the
  // due rows, each carrying its `notifyKey`, soonest first.
  //
  // opts: { now, windowMs } — both optional, for tests.
  function dueNotifications(schedule, notified, opts) {
    const now = opts && opts.now != null ? Number(opts.now) : Date.now()
    const windowMs = opts && opts.windowMs != null ? Number(opts.windowMs) : DUE_WINDOW_MS
    const seen = notified instanceof Set
      ? notified
      : new Set(Array.isArray(notified) ? notified : [])
    const out = []
    for (const row of Array.isArray(schedule) ? schedule : []) {
      const airsAt = Number(row && row.airsAt)
      if (!Number.isFinite(airsAt)) continue
      // Future, and inside the window. An episode airing exactly now counts;
      // one that aired even a moment ago does not.
      if (airsAt < now) continue
      if (airsAt - now > windowMs) continue
      const key = notifyKey(row)
      if (!key || seen.has(key)) continue
      out.push({ ...row, notifyKey: key })
    }
    out.sort((a, b) => a.airsAt - b.airsAt)
    return out
  }

  // Fold newly-fired keys into the ledger and enforce the cap. Newest keys are
  // kept; the oldest are dropped when the list exceeds NOTIFIED_CAP. Returns a
  // fresh array (does not mutate the input), de-duplicated with newest-wins.
  //
  // opts: { cap } — optional, for tests.
  function recordNotified(existing, newKeys, opts) {
    const cap = opts && opts.cap != null ? Number(opts.cap) : NOTIFIED_CAP
    const prior = (Array.isArray(existing) ? existing : []).filter(k => k != null).map(String)
    const fresh = (Array.isArray(newKeys) ? newKeys : []).filter(k => k != null).map(String)
    // Order: prior first, then fresh, then de-dupe keeping the LAST occurrence
    // (so a re-fired key moves to the end and survives the cap), then keep the
    // newest `cap` entries.
    const combined = prior.concat(fresh)
    const seen = new Set()
    const deduped = []
    for (let i = combined.length - 1; i >= 0; i--) {
      if (seen.has(combined[i])) continue
      seen.add(combined[i])
      deduped.push(combined[i])
    }
    deduped.reverse() // back to oldest-first
    return deduped.length > cap ? deduped.slice(deduped.length - cap) : deduped
  }

  return {
    DUE_WINDOW_MS,
    NOTIFIED_CAP,
    notifyKey,
    dueNotifications,
    recordNotified,
  }
})
