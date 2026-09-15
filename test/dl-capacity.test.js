'use strict'
const test = require('node:test')
const assert = require('node:assert')
const C = require('../src/dl-capacity')
const GB = 1e9

// Roadmap 079: capacity and writability are decided before any transfer work.
test('enough space is ok, too little is refused with the shortfall and a next step', () => {
  assert.deepEqual(C.check({ needBytes: 1 * GB, freeBytes: 10 * GB, writable: true }), { ok: true, kind: 'ok', action: 'none', text: '' })
  const r = C.check({ needBytes: 3 * GB, freeBytes: 2 * GB, writable: true, dir: '/Volumes/Music' })
  assert.equal(r.ok, false); assert.equal(r.kind, 'insufficient'); assert.equal(r.action, 'free-space')
  assert.equal(r.shortBytes, 1 * GB + C.RESERVE_BYTES)
  assert.match(r.text, /3\.0 GB/); assert.match(r.text, /2\.0 GB is free/); assert.match(r.text, /choose another folder/)
})

test('the reserve keeps a disk from being filled to the last byte', () => {
  assert.equal(C.check({ needBytes: 1 * GB, freeBytes: 1 * GB + C.RESERVE_BYTES - 1, writable: true }).ok, false)
  assert.equal(C.check({ needBytes: 1 * GB, freeBytes: 1 * GB + C.RESERVE_BYTES, writable: true }).ok, true)
})

test('an unwritable folder is refused before space is even considered', () => {
  const r = C.check({ needBytes: 1, freeBytes: 100 * GB, writable: false, dir: '/mnt/ro' })
  assert.equal(r.kind, 'unwritable'); assert.equal(r.action, 'choose-folder'); assert.match(r.text, /\/mnt\/ro cannot be written/)
})

test('unmeasurable space does not block, but says so', () => {
  const r = C.check({ needBytes: 5 * GB, freeBytes: null, writable: true })
  assert.equal(r.ok, true); assert.equal(r.kind, 'unknown'); assert.match(r.text, /could not be measured/)
})

test('fmt reads like a person would say it', () => {
  assert.equal(C.fmt(1.5e9), '1.5 GB'); assert.equal(C.fmt(2.5e10), '25 GB'); assert.equal(C.fmt(3e6), '3 MB'); assert.equal(C.fmt(0), '0 B')
})
