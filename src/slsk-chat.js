'use strict';
// Soulseek peer chat (App roadmap #55) — the pure half of the chat contract the
// UI agent consumes. slskd owns the data over its /conversations API; this module
// holds only the shape-mapping and the new-message diff so both are testable
// without a live daemon.
//
// slskd's live shapes (verified against the running daemon):
//   GET /conversations            -> [{ username, isActive, unAcknowledgedMessageCount,
//                                        hasUnAcknowledgedMessages }]
//   GET /conversations/{username} -> { username, ..., messages: [{ timestamp, id,
//                                        username, direction:'In'|'Out', message,
//                                        isAcknowledged, wasReplayed }] }
//   POST /conversations/{username}  body: a JSON-encoded message STRING (not an
//                                        object) -> sends a private message.
//
// The renderer-facing contract normalises those into:
//   slskChatList()            -> [{ username, unreadCount, lastMessageAt }]
//   slskChatHistory(username) -> [{ direction:'in'|'out', message, at }]
//   slskChatSend(...)         -> { ok }
// with `at`/`lastMessageAt` as epoch-ms numbers (0 when unknown) so the UI never
// has to parse slskd's ISO timestamps or capitalised direction itself.
//
// Kept pure — no clock, no I/O — so the mapping and the per-user last-seen diff
// (for the 30s poll's incoming-message event) are testable with plain fixtures.
// main wires the fetch, the poll cadence and the last-seen side-store.
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaSlskChat = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // slskd stamps timestamps as ISO 8601 strings ("2026-07-16T21:52:19Z"). The
  // contract exposes epoch-ms numbers instead, so the UI can sort and format
  // without a date parser. An unparseable or missing stamp becomes 0 — a real
  // number the UI can treat as "unknown", never NaN.
  function _toMs(ts) {
    if (ts == null) return 0
    if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0
    const ms = Date.parse(String(ts))
    return Number.isFinite(ms) ? ms : 0
  }

  // 'In'/'Out' (slskd) -> 'in'/'out' (contract). Anything unrecognised is treated
  // as incoming: a message we cannot classify is safer shown than silently hidden,
  // and only an exact 'Out' is genuinely ours.
  function _dir(direction) {
    return String(direction || '').toLowerCase() === 'out' ? 'out' : 'in'
  }

  // One conversation-list row -> the contract's { username, unreadCount,
  // lastMessageAt }. The list endpoint carries no timestamp of its own, so
  // lastMessageAt is 0 here; main fills it from the per-user history where it has
  // one, and leaves it 0 otherwise. unreadCount reads slskd's
  // unAcknowledgedMessageCount, clamped to a non-negative integer.
  function normalizeListRow(row) {
    row = row || {}
    let unread = Number(row.unAcknowledgedMessageCount)
    if (!Number.isFinite(unread) || unread < 0) unread = 0
    return {
      username: String(row.username || ''),
      unreadCount: Math.floor(unread),
      lastMessageAt: _toMs(row.lastMessageAt),
    }
  }

  // The full /conversations array -> the contract list. Rows with no username are
  // dropped (they cannot be addressed), and a non-array answer degrades to [].
  function normalizeList(rows) {
    if (!Array.isArray(rows)) return []
    return rows.map(normalizeListRow).filter(r => r.username)
  }

  // One message -> the contract's { direction, message, at }. `id` rides along on
  // a non-enumerable-free copy? No — kept minimal on purpose; the last-seen diff
  // below reads ids straight off the raw slskd messages, so the contract shape
  // stays exactly the three documented fields.
  function normalizeMessage(m) {
    m = m || {}
    return {
      direction: _dir(m.direction),
      message: String(m.message == null ? '' : m.message),
      at: _toMs(m.timestamp),
    }
  }

  // A per-user history payload -> the contract's message array, oldest-first (the
  // order slskd already returns). A payload with no messages array degrades to [].
  function normalizeHistory(convo) {
    const msgs = convo && Array.isArray(convo.messages) ? convo.messages : []
    return msgs.map(normalizeMessage)
  }

  // The newest message timestamp (epoch ms) in a per-user history, or 0 when the
  // conversation is empty. Used to backfill lastMessageAt on the list rows, so the
  // UI can order conversations by recency without a second parse.
  function lastMessageAt(convo) {
    const msgs = convo && Array.isArray(convo.messages) ? convo.messages : []
    let max = 0
    for (const m of msgs) {
      const at = _toMs(m.timestamp)
      if (at > max) max = at
    }
    return max
  }

  // ── New-incoming diff for the 30s poll ─────────────────────────────────────
  // Given a user's raw slskd messages and the id we last surfaced for that user,
  // return the incoming messages that are newer than the watermark, plus the new
  // watermark to store. Only 'In' messages count as "new to notify" — our own
  // outgoing messages must never fire the incoming event.
  //
  // slskd message ids are monotonic per the daemon's own store, so "newer than the
  // last-seen id" is the cheap, reliable test. The very first poll for a user
  // (lastSeenId == null) establishes the watermark WITHOUT emitting: the app just
  // started and every existing message would otherwise arrive as "new". The
  // renderer loads history explicitly; the event is only for genuinely-arrived
  // messages while the app is running.
  function diffIncoming(rawMessages, lastSeenId) {
    const msgs = Array.isArray(rawMessages) ? rawMessages : []
    // Highest id present, so the watermark always advances to the newest message
    // even when the newest is one of ours (outgoing) — otherwise our own reply
    // would leave the watermark behind and re-notify an old incoming message.
    let maxId = (typeof lastSeenId === 'number') ? lastSeenId : -Infinity
    for (const m of msgs) {
      const id = Number(m && m.id)
      if (Number.isFinite(id) && id > maxId) maxId = id
    }
    const newMax = Number.isFinite(maxId) ? maxId : null

    // First sight of this user: adopt the watermark, emit nothing.
    if (lastSeenId == null) {
      return { fresh: [], lastSeenId: newMax }
    }

    const fresh = []
    for (const m of msgs) {
      const id = Number(m && m.id)
      if (!Number.isFinite(id) || id <= lastSeenId) continue
      if (_dir(m && m.direction) !== 'in') continue
      fresh.push({
        username: String((m && m.username) || ''),
        message: String(m && m.message == null ? '' : m.message),
        at: _toMs(m && m.timestamp),
        id,
      })
    }
    // Oldest-first, so the UI shows arrivals in the order they were sent.
    fresh.sort((a, b) => a.id - b.id)
    return { fresh, lastSeenId: newMax }
  }

  return {
    normalizeList, normalizeListRow,
    normalizeHistory, normalizeMessage,
    lastMessageAt, diffIncoming,
    _toMs, _dir,
  }
})
