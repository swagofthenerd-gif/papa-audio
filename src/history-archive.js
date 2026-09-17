'use strict'

// Archiving the play history that falls past the cap.
//
// Two bugs lived in the old inline version.
//
// 1. It was fire-and-forget while the truncation committed immediately:
//
//      if (overflow.length) archiveHistoryOverflow(overflow)   // async, not awaited
//      return keep                                             // commits NOW
//
//    so when the write failed, the entries were gone from the live list and had
//    never reached the file. The catch logged "entries kept in memory only",
//    which was the one thing that was definitely not true — `keep` had already
//    excluded them. Silent, permanent loss of the oldest history, which is
//    exactly the part Stats and the listening trail draw their tail from.
//
// 2. The per-month file was an unlocked read-modify-write, so two overlapping
//    calls each read the same `existing` and the second rename discarded the
//    first one's entries.
//
// So: the writes are serialised behind one chain, and the caller is handed a
// promise it can actually act on. On failure the entries go back into the live
// list — over the cap, briefly — because being over a soft cap is not a bug and
// losing his listening history is.

function createHistoryArchive({ fs, path, dir, groupForArchive, log, onError }) {
  // One writer at a time. Every call appends to this chain, so two bursts can
  // never interleave a read-modify-write on the same month file.
  let chain = Promise.resolve()

  function archive(overflow) {
    if (!overflow || !overflow.length) return Promise.resolve({ written: 0, months: [] })
    const run = chain.then(async () => {
      const byMonth = groupForArchive(overflow)
      await fs.promises.mkdir(dir, { recursive: true })
      const months = []
      let written = 0
      for (const [month, entries] of byMonth) {
        const f = path.join(dir, `${month}.json`)
        let existing = []
        try { existing = JSON.parse(await fs.promises.readFile(f, 'utf8')) } catch (_) { existing = [] }
        if (!Array.isArray(existing)) existing = []
        const merged = existing.concat(entries)
        const tmp = f + '.tmp'
        await fs.promises.writeFile(tmp, JSON.stringify(merged), 'utf8')
        await fs.promises.rename(tmp, f)
        months.push(month)
        written += entries.length
        if (log) log(`[papa][history] archived ${entries.length} entries to ${month}.json (${merged.length} total)`)
      }
      return { written, months }
    })
    // The chain must survive a failure, or one bad write wedges every later
    // archive behind a rejected promise.
    chain = run.then(() => undefined, () => undefined)
    return run.catch(e => {
      if (onError) onError(e)
      throw e
    })
  }

  return { archive }
}

module.exports = { createHistoryArchive }
