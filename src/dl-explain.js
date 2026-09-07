'use strict';
// Why a download is not moving — as pure functions, plus the auto-nudge throttle.
//
// A file can sit at 0% for a long time while its peer is perfectly online, and
// the old UI said only "Waiting", which reads as "the app has given up". It has
// not: the file is in line at a peer, or the peer stopped responding, or the
// scheduler is about to re-source it. Each of those is a different, honest thing
// to tell the user, and the data to tell them apart already exists — slskd's
// transfer record carries queue position and state, and the scheduler carries
// the retry/attempt state. This module turns that data into the one line a
// waiting row should show, and decides when the background auto-nudge may fire.
//
// Everything here is pure: no clock of its own (the caller passes `now`), no I/O.
// That keeps the reason strings and — critically — the nudge throttle testable
// without a daemon or a running scheduler.
//
// Loaded by main via require and by the renderer as a classic script (UMD).
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./dl-state') : (root.PapaDlState))
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaDlExplain = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dlState) {

  // How long an inflight file may sit at zero bytes, with its peer reporting
  // online, before the background nudge re-sources it. Five minutes: long enough
  // that a slow-starting transfer is not disturbed, short enough that a truly
  // wedged one is not left for the 20-minute stall timer.
  const NUDGE_AFTER_MS = 5 * 60 * 1000;
  // At most one automatic nudge per file per this window, so a genuinely stuck
  // file is not re-searched every tick (which would storm slskd and the peer).
  const NUDGE_THROTTLE_MS = 30 * 60 * 1000;

  function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // The queue position slskd reports for a queued transfer. slskd's list field is
  // `placeInQueue`, populated only while the transfer is actually queued; a
  // per-transfer position poll fills it in when the list omits it. 0 and negative
  // are "not a real position" (slskd uses 0 for not-yet-known), so they read as
  // unknown rather than "position 0".
  function placeInQueue(file) {
    if (!file) return null;
    const p = _num(file.placeInQueue);
    return p != null && p > 0 ? p : null;
  }

  // The one-line reason a waiting/queued row is not moving. Returns a string, or
  // '' when the row is actively downloading (nothing to explain) or nothing is
  // known. `sched` is the scheduler view of this file (attempts, sourceCount,
  // nextRetryInMs) when it has one; `now` is the caller's clock.
  //
  // Precedence, most-specific first:
  //   1. actively downloading                          -> '' (no explanation)
  //   2. the scheduler is about to re-source it         -> "Retrying via another
  //      (attempt/backoff known)                            source in Ns (attempt X/4)"
  //   3. a known queue position                         -> "In line at <peer>
  //                                                          (position N)"
  //   4. a stalled/errored/timed-out state              -> "Peer not responding"
  //   5. plain queued, position unknown                 -> "In line at <peer>"
  function waitingReason(file, sched, now) {
    if (!file) return '';
    const cat = dlState.classify(file.state);
    if (cat === 'active' && String(file.state || '').includes('InProgress') &&
        (_num(file.bytesTransferred) || 0) > 0) {
      return '';
    }

    // 2. The scheduler has a retry lined up: say when and which attempt. This is
    //    the most reassuring thing to show — the app is actively working on it.
    if (sched) {
      const attempts = _num(sched.attempts);
      const max = _num(sched.maxAttempts) || 4;
      const inMs = _num(sched.nextRetryInMs);
      if (inMs != null && inMs > 0 && attempts != null) {
        const secs = Math.max(1, Math.round(inMs / 1000));
        // attempts is the count already made; the next one is attempts+1.
        const shown = Math.min(attempts + 1, max);
        return `Retrying via another source in ${secs}s (attempt ${shown}/${max})`;
      }
    }

    const peer = _peerName(file);

    // 3. A concrete queue position is the clearest honest answer.
    const pos = placeInQueue(file);
    if (pos != null) {
      return peer ? `In line at ${peer} (position ${pos})` : `In line (position ${pos})`;
    }

    // 4. The transfer errored / timed out / was rejected — the peer is not
    //    responding. (A cancelled transfer is the user's doing and not shown as a
    //    stall.)
    if (cat === 'failed') return 'Peer not responding';

    // 5. Queued with no position yet: still an honest "in line", just without the
    //    number.
    if (cat === 'active') {
      return peer ? `In line at ${peer}` : 'In line';
    }
    return '';
  }

  function _peerName(file) {
    const u = file && file.username;
    if (!u) return '';
    const s = String(u);
    // The scheduler uses "searching…" / "searching for a source" as a placeholder
    // username before a real peer is chosen; that is not a peer to be "in line" at.
    if (/^searching/i.test(s)) return '';
    return s;
  }

  // Should the background nudge re-source this inflight file now? Pure so the
  // whole throttle is testable. True only when ALL of:
  //   - the file has made zero progress (0 bytes transferred), and
  //   - it has been inflight at least NUDGE_AFTER_MS, and
  //   - its peer is reported online (presence 'Online'), and
  //   - it has not been nudged within NUDGE_THROTTLE_MS.
  //
  //   live      : the scheduler inflight entry ({ since, bytesTransferred? })
  //   ctx       : { now, peerOnline, lastNudgeAt }
  function shouldNudge(live, ctx) {
    if (!live) return false;
    ctx = ctx || {};
    const now = _num(ctx.now) || Date.now();
    // Any real progress means it is not wedged — leave it alone.
    if ((_num(live.bytesTransferred) || 0) > 0) return false;
    const since = _num(live.since);
    if (since == null || (now - since) < NUDGE_AFTER_MS) return false;
    if (!ctx.peerOnline) return false;
    const last = _num(ctx.lastNudgeAt) || 0;
    if (last && (now - last) < NUDGE_THROTTLE_MS) return false;
    return true;
  }

  return {
    NUDGE_AFTER_MS: NUDGE_AFTER_MS,
    NUDGE_THROTTLE_MS: NUDGE_THROTTLE_MS,
    placeInQueue: placeInQueue,
    waitingReason: waitingReason,
    shouldNudge: shouldNudge,
  };
});
