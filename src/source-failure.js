'use strict'
// Why an online source came back empty (roadmap 057). "No results" was the
// answer to five different situations — offline, cancelled, timed out, rate
// limited, and genuinely nothing — and each needs a different next step.
// Pure; tested in test/source-failure.test.js. Both the Soulseek and the
// YouTube sections read this so the wording and the actions match.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaSourceFailure = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  function strip(e) {
    var m = String((e && e.message) || e || '')
    return m.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '').trim()
  }

  // `source` is the display name ("YouTube", "Soulseek"). `opts.offline` is
  // navigator.onLine === false; `opts.cancelled` is the caller's own flag.
  // Returns { kind, text, action } where action is one of
  // 'retry' | 'wait' | 'connection' | 'settings' | 'none'.
  function explain(source, error, opts) {
    opts = opts || {}
    var m = strip(error)
    var s = source || 'The source'
    if (opts.cancelled) return { kind: 'cancelled', text: s + ' search cancelled.', action: 'retry' }
    if (opts.offline) return { kind: 'offline', text: 'You are offline — ' + s + ' is unavailable.', action: 'connection' }
    if (/\b429\b|rate.?limit|too many requests/i.test(m)) return { kind: 'ratelimited', text: s + ' is rate-limiting searches — wait a moment, then retry.', action: 'wait' }
    if (/\b401\b|\b403\b|unauthor|forbidden|sign in|login|cookie/i.test(m)) return { kind: 'auth', text: s + ' rejected the request — check its sign-in or key in Settings.', action: 'settings' }
    if (/abort|timeout|timed out|did not respond/i.test(m)) return { kind: 'timeout', text: s + ' did not respond in time.', action: 'retry' }
    if (/not connected/i.test(m)) return { kind: 'disconnected', text: s + ' is not connected.', action: 'connection' }
    if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|EAI_AGAIN|ECONNRESET/i.test(m)) return { kind: 'unreachable', text: 'Could not reach ' + s + '.', action: 'connection' }
    if (/\b5\d\d\b/.test(m)) return { kind: 'server', text: s + ' hit an internal error (' + m + ').', action: 'retry' }
    if (m) return { kind: 'error', text: s + ' search failed: ' + m, action: 'retry' }
    return { kind: 'empty', text: 'Nothing found on ' + s + '.', action: 'none' }
  }

  // The one-word label a button gets for an action.
  function actionLabel(action) {
    return { retry: 'Retry', wait: 'Retry in a moment', connection: 'Check connection', settings: 'Open Settings' }[action] || ''
  }

  return { explain: explain, actionLabel: actionLabel, strip: strip }
})
