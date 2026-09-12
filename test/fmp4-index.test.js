'use strict'
// The fragmented-MP4 index that lets a seek back be a file read. Boxes are
// hand-built so the test needs no ffmpeg; chunking is varied on purpose.
const test = require('node:test')
const assert = require('node:assert')
const { create } = require('../src/fmp4-index')

function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length)
  b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4, 'latin1'); payload.copy(b, 8); return b
}
function full(type, version, flags, payload) {
  const h = Buffer.alloc(4); h[0] = version; return box(type, Buffer.concat([h, payload]))
}
function mdhd(timescale) {
  const p = Buffer.alloc(20); p.writeUInt32BE(timescale, 8); return full('mdhd', 0, 0, p)
}
function tkhd(id) { const p = Buffer.alloc(80); p.writeUInt32BE(id, 8); return full('tkhd', 0, 0, p) }
function moov(timescale) { return box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), box('trak', Buffer.concat([tkhd(1), box('mdia', mdhd(timescale))])), box('trak', Buffer.concat([tkhd(2), box('mdia', mdhd(48000))]))])) }
function tfhd(id) { const p = Buffer.alloc(4); p.writeUInt32BE(id, 0); return full('tfhd', 0, 0, p) }
function moof(tfdt, v1, trackId) {
  const p = v1 ? Buffer.alloc(8) : Buffer.alloc(4)
  if (v1) p.writeBigUInt64BE(BigInt(tfdt), 0); else p.writeUInt32BE(tfdt, 0)
  return box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), box('traf', Buffer.concat([tfhd(trackId || 1), full('tfdt', v1 ? 1 : 0, 0, p)]))]))
}
function mdat(n) { return box('mdat', Buffer.alloc(n, 7)) }

test('init length, timescale and fragment times/offsets come out whatever the chunking', () => {
  const ts = 90000
  const stream = Buffer.concat([box('ftyp', Buffer.alloc(16)), moov(ts), moof(0), mdat(5000), moof(ts * 2), mdat(70000), moof(ts * 4, true), mdat(10)])
  for (const size of [1, 7, 64, 4096, stream.length]) {
    const ix = create()
    for (let o = 0; o < stream.length; o += size) ix.push(stream.subarray(o, Math.min(stream.length, o + size)))
    assert.equal(ix.state.timescale, ts, 'chunk ' + size)
    assert.equal(ix.state.initLength, 24 + moov(ts).length)
    assert.deepEqual(ix.state.fragments.map(f => f.time), [0, 2, 4])
    assert.equal(ix.state.fragments[0].offset, ix.state.initLength)
    assert.equal(ix.state.fragments[1].offset, ix.state.initLength + moof(0).length + 5008)
    assert.equal(ix.state.bytes, stream.length)
    assert.equal(ix.coveredSec(), 4)
    assert.equal(ix.fragmentAt(3).time, 2); assert.equal(ix.fragmentAt(0).time, 0); assert.equal(ix.fragmentAt(99).time, 4)
    assert.equal(ix.fragmentAt(-1), null)
  }
})

test('push reports the fragments found in that call', () => {
  const ix = create()
  assert.deepEqual(ix.push(Buffer.concat([box('ftyp', Buffer.alloc(8)), moov(1000)])), [])
  const got = ix.push(Buffer.concat([moof(500), mdat(3), moof(1500), mdat(3)]))
  assert.deepEqual(got.map(f => f.time), [0.5, 1.5])
  assert.deepEqual(ix.push(null), [])
})

test('only the video track\'s fragments are indexed: an audio-only moof on another clock is skipped', () => {
  const ix = create()
  ix.push(Buffer.concat([box('ftyp', Buffer.alloc(8)), moov(1000), moof(0, false, 1), mdat(3), moof(48000 * 7, false, 2), mdat(3), moof(2000, false, 1), mdat(3)]))
  assert.equal(ix.state.trackId, 1)
  assert.deepEqual(ix.state.fragments.map(f => f.time), [0, 2], 'the audio fragment at "7 s" on its 48 kHz clock is not a video fragment')
})

// Chromium reads mvhd.duration = 0 (what ffmpeg's empty_moov streaming
// writes) as a live stream and decodes it single-threaded; stamping the real
// duration into the init segment gives a 4K picture its decoder threads.
const { stampDuration } = require('../src/fmp4-index')
function sbox(type, payload) { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length, 0); b.write(type, 4, 'ascii'); payload.copy(b, 8); return b }
function sfull(type, version, body) { const p = Buffer.alloc(4 + body.length); p[0] = version; body.copy(p, 4); return sbox(type, p) }
test('stampDuration writes the duration into mvhd and mehd, versions 0 and 1, and touches nothing else', () => {
  // v0: creation, modification, timescale 1000, duration 0, then rate/volume etc.
  const mvhd0 = sfull('mvhd', 0, Buffer.concat([Buffer.alloc(8), Buffer.from([0, 0, 3, 232]), Buffer.alloc(4), Buffer.alloc(80, 7)]))
  const mehd0 = sfull('mehd', 0, Buffer.alloc(4))
  const trex = sbox('trex', Buffer.alloc(24, 1))
  const trak = sbox('trak', Buffer.alloc(30, 9))
  const init0 = Buffer.concat([sbox('ftyp', Buffer.from('isom\0\0\0\0iso6mp41', 'ascii')), sbox('moov', Buffer.concat([mvhd0, trak, sbox('mvex', Buffer.concat([mehd0, trex]))]))])
  const out0 = Buffer.from(stampDuration(init0, 6882.144))
  assert.equal(out0.length, init0.length)
  const mv = out0.indexOf('mvhd') + 4
  assert.equal(out0.readUInt32BE(mv + 12), 1000, 'timescale untouched')
  assert.equal(out0.readUInt32BE(mv + 16), 6882144, 'mvhd duration in timescale units')
  const me = out0.indexOf('mehd') + 4
  assert.equal(out0.readUInt32BE(me + 4), 6882144, 'mehd fragment_duration too')
  // Everything else is byte-identical (the trak, the trex, the ftyp).
  assert.ok(out0.subarray(0, mv + 12).equals(init0.subarray(0, mv + 12)))
  assert.ok(out0.subarray(mv + 20, me + 4).equals(init0.subarray(mv + 20, me + 4)))
  assert.ok(out0.subarray(me + 8).equals(init0.subarray(me + 8)))
  assert.ok(init0.readUInt32BE(mv + 16) === 0, 'the input was left alone')
  // v1: 64-bit fields (creation 8, modification 8, timescale 4, duration 8)
  const mvhd1 = sfull('mvhd', 1, Buffer.concat([Buffer.alloc(16), Buffer.from([0, 0, 0, 90]), Buffer.alloc(8), Buffer.alloc(80, 7)]))
  const mehd1 = sfull('mehd', 1, Buffer.alloc(8))
  const init1 = Buffer.concat([sbox('moov', Buffer.concat([mvhd1, sbox('mvex', Buffer.concat([mehd1, trex]))]))])
  const out1 = Buffer.from(stampDuration(init1, 100))
  const mv1 = out1.indexOf('mvhd') + 4
  assert.equal(out1.readUInt32BE(mv1 + 24), 0); assert.equal(out1.readUInt32BE(mv1 + 28), 9000, '100 s × 90')
  const me1 = out1.indexOf('mehd') + 4
  assert.equal(out1.readUInt32BE(me1 + 8), 9000)
  // No duration, or no moov: a copy, unchanged.
  assert.ok(Buffer.from(stampDuration(init0, 0)).equals(init0))
  assert.ok(Buffer.from(stampDuration(Buffer.from('not mp4 at all'), 5)).equals(Buffer.from('not mp4 at all')))
})
