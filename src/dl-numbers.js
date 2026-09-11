'use strict';
// One reconciled model for every number the Downloads page shows (roadmap R5).
//
// The page told three stories about one queue. The dashboard card said
// "74 Active" (every in-flight file, queued ones included), the strip under it
// said "0 active · 74 queued" (only InProgress is "active" there), and the
// header said "108 waiting" (scheduler ENTRIES, a different universe from
// slskd transfers). Cancelled transfers fell into no card and no tab, so the
// Total never added up. And a file the scheduler was quietly retrying after a
// failed attempt showed up under Failed, because the held copy was dropped
// whenever any transfer with the same name existed.
//
// This module is the single source: it merges the two lists (what slskd
// knows, what the scheduler still holds), files every transfer into exactly
// one bucket, and derives every displayed figure from that one model with
// its unit named. Pure and DOM-free; the renderer only paints.
//
// Buckets (each file lands in exactly one):
//   downloading       bytes are moving (InProgress)
//   connecting        slskd asked the peer, no answer yet (Requested/Initializing)
//   queuedAtPeer      the peer accepted and has us in ITS queue (Queued)
//   waitingForSource  the scheduler still holds it — no peer chosen or every
//                     candidate is busy/benched (our synthetic 'sched:' rows)
//   completed / failed / cancelled — over, and how
//
// inQueue = downloading + connecting + queuedAtPeer + waitingForSource: what
// the "Downloading" tab and the nav badge count.
//
// Loaded by the renderer as a classic script (after dl-state.js) and by tests
// via require.
(function (root, factory) {
  const DS = (typeof module === 'object' && module.exports)
    ? require('./dl-state')
    : root.PapaDlState
  const api = factory(DS)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaDlNumbers = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DS) {

  const BUCKETS = ['downloading', 'connecting', 'queuedAtPeer', 'waitingForSource', 'completed', 'failed', 'cancelled']
  const LABELS = {
    downloading: 'downloading',
    connecting: 'connecting',
    queuedAtPeer: 'queued at peers',
    waitingForSource: 'waiting for a source',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  }

  function isHeld(f) {
    return !!(f && (f.scheduled === true || String(f.id || '').indexOf('sched:') === 0))
  }

  function bucket(f) {
    if (!f) return 'failed'
    const cat = DS.classify(f.state)
    if (cat !== 'active') return cat // completed | failed | cancelled
    if (isHeld(f)) return 'waitingForSource'
    const s = String(f.state || '')
    if (s.indexOf('InProgress') !== -1) return 'downloading'
    if (s.indexOf('Queued') !== -1) return 'queuedAtPeer'
    return 'connecting' // Requested, Initializing, a bare Scheduled from slskd
  }

  function folderOf(filename) {
    const s = String(filename == null ? '' : filename)
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
    return i === -1 ? '' : s.slice(0, i)
  }

  // Merge what slskd reports with what the scheduler still holds. A held file
  // whose name slskd has never seen is simply added. One whose earlier attempt
  // FAILED (or was cancelled) at the daemon REPLACES that finished row: the
  // scheduler is retrying it, so it is waiting, not failed. One that slskd is
  // actively moving, or has already delivered, is not shown twice.
  function mergeHeld(transfers, held) {
    const out = (Array.isArray(transfers) ? transfers : []).slice()
    const byName = new Map()
    for (let i = 0; i < out.length; i++) {
      const name = out[i] && out[i].filename
      if (name == null) continue
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name).push(i)
    }
    const drop = new Set()
    for (const h of (Array.isArray(held) ? held : [])) {
      if (!h) continue
      const idxs = byName.get(h.filename)
      if (!idxs) { out.push(h); continue }
      let live = false
      for (const i of idxs) {
        const cat = DS.classify(out[i].state)
        if (cat === 'active' || cat === 'completed') { live = true; break }
      }
      if (live) continue
      for (const i of idxs) drop.add(i)
      out.push(h)
    }
    return drop.size ? out.filter((_, i) => !drop.has(i)) : out
  }

  function hmsToSecs(str) {
    const p = String(str || '').split(':').map(Number)
    if (p.some(n => !isFinite(n))) return 0
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
    if (p.length === 2) return p[0] * 60 + p[1]
    return p[0] || 0
  }

  // The model. `stats` is the scheduler's stats() object (pending, inflight,
  // peers, benched[]) or null when it never arrived.
  function reconcile(files, stats) {
    const list = Array.isArray(files) ? files.filter(Boolean) : []
    const f = {}
    for (const b of BUCKETS) f[b] = 0
    const albums = { inQueue: new Set(), completed: new Set(), failed: new Set() }
    let speed = 0, remaining = 0, etaSecs = 0
    for (const x of list) {
      const b = bucket(x)
      f[b]++
      const key = (x.username || '') + '::' + folderOf(x.filename)
      if (b === 'completed') albums.completed.add(key)
      else if (b === 'failed') albums.failed.add(key)
      else if (b !== 'cancelled') albums.inQueue.add(key)
      if (b === 'downloading') {
        speed += x.averageSpeed || 0
        const eta = hmsToSecs(x.remainingTime || '0')
        if (eta > etaSecs) etaSecs = eta
      }
      if (b !== 'completed' && b !== 'failed' && b !== 'cancelled') remaining += x.bytesRemaining || 0
    }
    f.inQueue = f.downloading + f.connecting + f.queuedAtPeer + f.waitingForSource
    f.waiting = f.connecting + f.queuedAtPeer + f.waitingForSource
    f.total = list.length
    const s = stats && typeof stats === 'object' ? stats : null
    const scheduler = {
      known: !!s,
      waiting: s ? (s.pending || 0) : 0,
      sending: s ? (s.inflight || 0) : 0,
      peers: s ? (s.peers || 0) : 0,
      benched: s && Array.isArray(s.benched) ? s.benched.length : 0,
    }
    return {
      files: f,
      albums: { inQueue: albums.inQueue.size, completed: albums.completed.size, failed: albums.failed.size },
      scheduler: scheduler,
      speed: speed,
      remaining: remaining,
      etaSecs: etaSecs,
      // The invariant every displayed total rests on.
      consistent: f.downloading + f.connecting + f.queuedAtPeer + f.waitingForSource + f.completed + f.failed + f.cancelled === f.total,
    }
  }

  // The headline cards. Units are FILES, and they add up to Total: the
  // Cancelled card appears only when there is something to count.
  function dashboardCards(model) {
    const f = model.files
    const cards = [
      { key: 'downloading', value: f.downloading, label: 'Downloading', sub: 'files moving now' },
      { key: 'waiting', value: f.waiting, label: 'Waiting', sub: waitingSub(f) },
      { key: 'completed', value: f.completed, label: 'Completed', sub: model.albums.completed + ' album' + (model.albums.completed === 1 ? '' : 's') },
      { key: 'failed', value: f.failed, label: 'Failed', sub: model.albums.failed + ' album' + (model.albums.failed === 1 ? '' : 's') },
    ]
    if (f.cancelled > 0) cards.push({ key: 'cancelled', value: f.cancelled, label: 'Cancelled', sub: 'files' })
    cards.push({ key: 'total', value: f.total, label: 'Total', sub: 'files' })
    return cards
  }

  function waitingSub(f) {
    const parts = []
    if (f.queuedAtPeer) parts.push(f.queuedAtPeer + ' at peers')
    if (f.connecting) parts.push(f.connecting + ' connecting')
    if (f.waitingForSource) parts.push(f.waitingForSource + ' for a source')
    return parts.length ? parts.join(' · ') : 'files'
  }

  // The strip above the Downloading tab: the queue broken into its states.
  // Zero-valued waiting states are omitted; "downloading" always shows.
  function queueStrip(model) {
    const f = model.files
    const out = [{ key: 'downloading', value: f.downloading, label: LABELS.downloading }]
    for (const k of ['queuedAtPeer', 'connecting', 'waitingForSource']) {
      if (f[k] > 0) out.push({ key: k, value: f[k], label: LABELS[k] })
    }
    return out
  }

  // The tab badges: the same three categories dl-state files transfers into.
  function tabCounts(model) {
    const f = model.files
    return { active: f.inQueue, completed: f.completed, failed: f.failed }
  }

  // The scheduler readout in the page header, in scheduler units (entries),
  // worded so it cannot be mistaken for the file counts below it.
  function schedulerLine(model) {
    const s = model.scheduler
    if (!s.known) return 'Scheduler status unavailable'
    if (!s.waiting && !s.sending) return 'Scheduler idle'
    const parts = []
    if (s.sending) parts.push(s.sending + ' being sent across ' + s.peers + ' peer' + (s.peers === 1 ? '' : 's'))
    if (s.waiting) parts.push(s.waiting + ' waiting for a source')
    if (s.benched) parts.push(s.benched + ' source' + (s.benched === 1 ? '' : 's') + ' benched')
    return parts.join(' · ')
  }

  // The sidebar badge: the queue while there is one, else today's finishes.
  function navBadge(model, todayDone) {
    const f = model.files
    if (f.inQueue > 0) {
      return {
        show: true,
        text: String(f.inQueue),
        title: f.inQueue + ' file' + (f.inQueue === 1 ? '' : 's') + ' in the download queue (' + f.downloading + ' downloading now)',
      }
    }
    const n = todayDone || 0
    return { show: n > 0, text: String(n), title: n + ' completed today' }
  }

  return {
    BUCKETS: BUCKETS,
    LABELS: LABELS,
    bucket: bucket,
    isHeld: isHeld,
    folderOf: folderOf,
    mergeHeld: mergeHeld,
    reconcile: reconcile,
    dashboardCards: dashboardCards,
    queueStrip: queueStrip,
    tabCounts: tabCounts,
    schedulerLine: schedulerLine,
    navBadge: navBadge,
    hmsToSecs: hmsToSecs,
  }
})
