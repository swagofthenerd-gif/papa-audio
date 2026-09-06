'use strict';
// Soulseek peer-chat model — pure conversation + unread-badge logic, no DOM and
// no IPC (roadmap #55). The panel and the toast live in renderer.js; every
// decision they make about ordering, unread counts and bubble shape is made
// here so the view stays a thin painter and the logic is testable in node.
//
// Message shape (the onSlskChatMessage contract): { username, message, at }.
// `at` is an epoch-ms timestamp; a missing one is tolerated (sorts as 0). An
// outgoing message the renderer echoes locally carries direction 'out'; an
// incoming one is 'in'. Direction is derived, not sent by the peer.
//
// UMD-wrapped like the other renderer-family logic modules.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PapaSlskChatModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function ts(m) {
    const n = Number(m && m.at);
    return Number.isFinite(n) ? n : 0;
  }

  // Fold a flat message list into per-peer threads, newest activity first.
  // Each thread: { username, messages (chronological), last, unread }.
  // `readAt` maps username(lowercased) -> the `at` of the last message the user
  // has seen in that thread; anything strictly newer and incoming is unread.
  // Outgoing messages are never unread (you wrote them).
  function threads(messages, readAt) {
    const seen = readAt || {};
    const byUser = new Map();
    const list = Array.isArray(messages) ? messages : [];
    for (const m of list) {
      if (!m || m.username == null) continue;
      const key = String(m.username).toLowerCase();
      if (!byUser.has(key)) {
        byUser.set(key, { username: String(m.username), messages: [] });
      }
      byUser.get(key).messages.push(m);
    }
    const out = [];
    for (const [key, t] of byUser) {
      t.messages.sort((a, b) => ts(a) - ts(b));
      const readCut = Number(seen[key]) || 0;
      let unread = 0;
      for (const m of t.messages) {
        if (m.direction !== 'out' && ts(m) > readCut) unread++;
      }
      t.last = t.messages[t.messages.length - 1] || null;
      t.unread = unread;
      out.push(t);
    }
    // Most recent conversation first; a tie breaks on name so the order is
    // stable across renders rather than Map-insertion-dependent.
    out.sort((a, b) => {
      const d = ts(b.last) - ts(a.last);
      return d !== 0 ? d
        : String(a.username).toLowerCase().localeCompare(String(b.username).toLowerCase());
    });
    return out;
  }

  // Total unread across every thread — the number on the hub's Messages button
  // and the app badge. Never negative; capped display is the view's business.
  function totalUnread(messages, readAt) {
    return threads(messages, readAt).reduce((sum, t) => sum + t.unread, 0);
  }

  // The `at` to record as "read" for a thread once its view is open: the newest
  // message in it (incoming or outgoing), or the existing cut when the thread is
  // empty, so opening an empty thread never rewinds a prior read mark.
  function readMarkFor(thread, prevAt) {
    const prev = Number(prevAt) || 0;
    if (!thread || !Array.isArray(thread.messages) || !thread.messages.length) return prev;
    let max = prev;
    for (const m of thread.messages) { const t = ts(m); if (t > max) max = t; }
    return max;
  }

  // Merge a newly-arrived message into an existing flat list, de-duplicating an
  // exact echo (same user, text and timestamp) so a locally-echoed outgoing send
  // that also comes back over the wire is not shown twice. Returns a new array.
  function ingest(messages, incoming) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    if (!incoming || incoming.username == null) return list;
    const key = String(incoming.username).toLowerCase();
    const dup = list.some(m =>
      m && String(m.username).toLowerCase() === key &&
      String(m.message) === String(incoming.message) &&
      ts(m) === ts(incoming));
    if (!dup) list.push(incoming);
    return list;
  }

  // A short label for the toast shown when a message lands while the panel is
  // closed. Pure so the toast text is tested, not eyeballed.
  function toastFor(msg) {
    const who = msg && msg.username != null ? String(msg.username) : 'someone';
    return 'Message from ' + who + ' — click to open';
  }

  return { threads, totalUnread, readMarkFor, ingest, toastFor };
});
