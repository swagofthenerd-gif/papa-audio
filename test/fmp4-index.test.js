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
