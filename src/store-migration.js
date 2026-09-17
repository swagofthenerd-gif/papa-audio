'use strict'

// Retiring the legacy copies left behind in the shared config.
//
// The original migration was one-shot in the wrong way:
//
//   if (side.adoptIfEmpty(store.get(key))) store.delete(key)
//
// `adoptIfEmpty` returns false as soon as the side file exists, so the delete
// only ever ran on the single run that did the adopting. Any key whose side
// file came into being by another route -- a normal write during the same
// session, a restore, a fresh install that wrote before the loop -- kept its
// full legacy copy in config.json for good. On this machine that left a
// 907 KB `libraryCache` key sitting in a 1.3 MB config, none of it read by
// anything, 70% of the file.
//
// It is not merely wasted disk. electron-store's .set() is a synchronous
// writeFileSync of the WHOLE config, on the main process thread that also owns
// the window message pump -- so every settings write, every window move that
// reaches the config, paid to serialise and fsync that dead weight.
//
// So: adopt when the side file is missing (as before), and then retire the
// legacy key whenever the side store actually holds the data -- whichever run
// put it there. The guard is that the side store must have a real value first;
// a key is never deleted on the strength of a read that failed or came back
// empty, because that would destroy the only surviving copy.

function retireLegacyKeys({ sideStores, store, log, onError }) {
  const adopted = []
  const retired = []
  const kept = []

  for (const [key, side] of Object.entries(sideStores || {})) {
    try {
      if (!store.has || !store.has(key)) continue

      if (side.adoptIfEmpty(store.get(key))) adopted.push(key)

      // Re-read through the side store: this is the proof that the data
      // survives the delete. `fileExists()` alone is not enough -- a truncated
      // or unparsable side file exists and reads back as the fallback.
      let live
      try { live = side.get() } catch (_) { live = undefined }

      if (live === undefined || live === null) { kept.push(key); continue }
      if (Array.isArray(live) && live.length === 0) { kept.push(key); continue }
      if (typeof live === 'object' && !Array.isArray(live) && Object.keys(live).length === 0) {
        kept.push(key)
        continue
      }

      store.delete(key)
      retired.push(key)
    } catch (e) {
      if (onError) onError(new Error(`${key}: migration failed (${(e && e.message) || e})`))
    }
  }

  if (log) {
    if (adopted.length) log(`[papa][store] moved out of the shared config: ${adopted.join(', ')}`)
    if (retired.length) log(`[papa][store] retired legacy config copies: ${retired.join(', ')}`)
    if (kept.length) log(`[papa][store] legacy copy kept (side store empty): ${kept.join(', ')}`)
  }

  return { adopted, retired, kept }
}

module.exports = { retireLegacyKeys }
