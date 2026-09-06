'use strict'
// Parallel mirror racing, shared by the torrent providers.
//
// Mirrors used to be tried in sequence, so a dead first mirror burned its
// whole timeout before the second was even asked — the last-good-first memory
// only softened that from the second query onwards. Racing asks every mirror
// at once: the first usable answer wins, and every loser is aborted through
// the AbortController whose signal was handed to its attempt, so a dead
// mirror now costs nothing instead of a timeout.
//
// `attempt(baseUrl, signal)` runs one mirror and resolves with that mirror's
// parsed payload, or null when the mirror is dead (attempts follow the
// providers' own tryMirror contract: they never throw, but a rejection is
// tolerated and counted as a dead mirror anyway). The race resolves with
// `{ baseUrl, result }` for the winner, or null when every mirror failed —
// it never rejects.
//
// `timeoutMs` bounds the whole race so a direct caller can never hang: if no
// mirror has produced a usable answer by the deadline, the race resolves null
// and every still-running attempt is aborted. The default of 10s is a backstop
// above the providers' own per-request budgets — a mirror whose fetch honours
// its AbortSignal already loses far sooner; this only exists for the pathological
// case where an attempt neither resolves nor respects its signal. Pass 0 (or any
// non-positive number) to disable it.
const DEFAULT_RACE_TIMEOUT_MS = 10000

async function raceMirrors(urls, attempt, { timeoutMs = DEFAULT_RACE_TIMEOUT_MS } = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : []
  if (!list.length) return null
  const controllers = list.map(() => new AbortController())
  return new Promise(resolve => {
    let pending = list.length
    let settled = false
    let timer = null
    // Abort every still-open attempt and mark the race done, so a late resolve
    // from a slow mirror cannot resolve the promise twice.
    const finish = value => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      for (const c of controllers) c.abort()
      resolve(value)
    }
    const failed = () => {
      pending--
      if (!settled && pending === 0) finish(null)
    }
    // The overall backstop: expiry resolves null and aborts the stragglers.
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(null), timeoutMs)
      // Never keep the process alive just for this timer (Node only).
      if (typeof timer.unref === 'function') timer.unref()
    }
    list.forEach((baseUrl, i) => {
      Promise.resolve()
        .then(() => attempt(baseUrl, controllers[i].signal))
        .then(result => {
          if (settled || result == null) return failed()
          finish({ baseUrl, result })
        }, failed)
    })
  })
}

module.exports = { raceMirrors, DEFAULT_RACE_TIMEOUT_MS }
