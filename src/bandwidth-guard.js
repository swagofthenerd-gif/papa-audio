'use strict'
// Why a bandwidth cap is a playback problem (instant-play A, 2026-09-20).
//
// Settings → Video carries one number — the download limit, in megabits per
// second — and it throttles the whole WebTorrent client: every peer-backed
// stream and every background download at once. A cap is harmless for a
// download, which simply finishes later. Live watching is a different promise:
// the stream has to arrive at least as fast as it is played, or it never
// catches up, however healthy the swarm is and however many peers answer.
//
// Found live 2026-09-20: the stored cap was 1 Mbps (≈125 KB/s) while the
// quality preference asked for 2160p, which needs 25–60. Every play that fell
// back to peers buffered forever, only RealDebrid worked (a plain HTTPS
// download, outside the client's throttle), and nothing on screen ever said
// why — so a correctly-working app was indistinguishable from a broken one.
//
// This module is that arithmetic and the two decisions which follow from it,
// pure and DOM-free: lift once a cap that cannot stream at all, and say so
// plainly when a cap still in force cannot carry the file being opened.
// Tested in test/bandwidth-guard.test.js.

// 1 megabit = 125000 bytes. The same conversion main.js has always used at the
// streamer boundary; exported so there is one definition of it, not three.
const BYTES_PER_MBIT = 125000

// Below this, no real video sustains. 1080p anime (≈1.4 GB for 24 min) needs
// about 8 Mbps; even a 720p re-encode wants 3–4. A cap under this floor cannot
// stream anything worth watching, whatever the file turns out to be, so it is
// the one judgement that can be made before a single byte is known.
const STREAMABLE_FLOOR_MBPS = 5

// A stream is not delivered at a perfectly even rate — peers come and go, and
// a file's own average hides its busiest minutes. Ask for this much over the
// file's average before calling a cap sufficient.
const HEADROOM = 1.25

// What a release of a given height typically needs, in Mbps, for when the
// runtime is not known yet (the stream list is picked before anything is
// probed). Deliberately the high end of ordinary: being told a cap is too low
// and finding it coped is a far cheaper mistake than the silent stall.
const BY_HEIGHT = [
  [2160, 35],
  [1440, 18],
  [1080, 8],
  [720, 4],
  [0, 2.5],
]

// The stamp written when the one-time lift below has run, so it runs once.
const MIGRATION_STAMP = '2026-09-20'

function _n(v) {
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

// The stored Mbps setting as bytes/second, or null when uncapped. null, 0,
// a negative and any non-number all mean "no cap" — the same reading main.js
// has always taken, kept here so every caller agrees.
function capBytesPerSec(mbps) {
  const n = _n(mbps)
  if (mbps == null || n == null || n <= 0) return null
  return Math.floor(n * BYTES_PER_MBIT)
}

// Whether a cap is actually in force.
function isCapped(mbps) {
  return capBytesPerSec(mbps) != null
}

// The rate a file of this height usually arrives at.
function typicalMbpsForHeight(height) {
  const h = _n(height)
  if (h == null || h <= 0) return null
  for (const [min, mbps] of BY_HEIGHT) {
    if (h >= min) return mbps
  }
  return null
}

// The release-list vocabulary ('2160p', '1080p', …) as a height, so a verdict
// can be reached from a source entry before anything is probed. Anything else
// — 'CAM', 'unknown', a missing field — is no answer rather than a wrong one.
function heightOfQuality(quality) {
  const m = /^(\d{3,4})p$/i.exec(String(quality || '').trim())
  if (!m) return null
  const h = Number(m[1])
  return Number.isFinite(h) && h > 0 ? h : null
}

// The file's own average rate: its size spread over its runtime.
function sustainedMbps({ bytes, durationSec } = {}) {
  const b = _n(bytes)
  const d = _n(durationSec)
  if (b == null || d == null || b <= 0 || d <= 0) return null
  return (b / d) / BYTES_PER_MBIT
}

// What this play needs to keep up: the file's measured average with headroom
// when the size and runtime are known, else the table by height, else nothing
// (in which case only the floor rule can speak).
function neededMbps({ bytes, durationSec, height } = {}) {
  const measured = sustainedMbps({ bytes, durationSec })
  if (measured != null) return Math.round(measured * HEADROOM * 10) / 10
  return typicalMbpsForHeight(height)
}

function _round(mbps) {
  if (mbps == null) return null
  return mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10
}

// Can this cap carry this play? `ok` false is a stall that has not happened
// yet. `message` is written for a viewer, not a log, and is the string
// start-honesty matches on.
function capVerdict({ capMbps, bytes, durationSec, height } = {}) {
  const cap = _n(capMbps)
  if (!isCapped(capMbps)) {
    return { ok: true, capped: false, capMbps: null, neededMbps: null, message: null, next: null }
  }
  const needed = neededMbps({ bytes, durationSec, height })
  // With nothing known about the file, the floor is the only honest test.
  const ok = needed == null ? cap >= STREAMABLE_FLOOR_MBPS : cap >= needed
  if (ok) {
    return { ok: true, capped: true, capMbps: cap, neededMbps: _round(needed), message: null, next: null }
  }
  const shown = _round(needed)
  const message = shown == null
    ? 'Your download speed limit (' + _round(cap) + ' Mbps) is too slow to watch anything from other people.'
    : 'Your download speed limit (' + _round(cap) + ' Mbps) is slower than this needs (about ' +
      shown + ' Mbps), so it can never catch up.'
  return {
    ok: false,
    capped: true,
    capMbps: cap,
    neededMbps: shown,
    message,
    next: 'Raise or clear the limit in Settings → Video.',
  }
}

// The one-time lift. A cap below the floor cannot stream, and a cap nobody
// chose deliberately is not worth a permanent stall — so it is cleared once,
// stamped, and never touched again. A cap the user set themselves afterwards
// carries downloadLimitByUser and is left exactly alone, the same contract
// playerModeByUser has.
function migrateCap(stored) {
  const s = stored && typeof stored === 'object' ? stored : {}
  const keep = reason => ({ changed: false, next: s, from: null, reason })
  if (s.downloadLimitMigrated) return keep('already migrated')
  if (s.downloadLimitByUser === true) return keep('the user chose this cap')
  if (!isCapped(s.downloadLimitMbps)) return keep('uncapped')
  const mbps = _n(s.downloadLimitMbps)
  if (mbps >= STREAMABLE_FLOOR_MBPS) return keep('cap can stream')
  return {
    changed: true,
    from: mbps,
    reason: 'cap of ' + mbps + ' Mbps cannot sustain video',
    next: Object.assign({}, s, { downloadLimitMbps: null, downloadLimitMigrated: MIGRATION_STAMP }),
  }
}

module.exports = {
  BYTES_PER_MBIT,
  STREAMABLE_FLOOR_MBPS,
  HEADROOM,
  MIGRATION_STAMP,
  capBytesPerSec,
  isCapped,
  typicalMbpsForHeight,
  heightOfQuality,
  sustainedMbps,
  neededMbps,
  capVerdict,
  migrateCap,
}
