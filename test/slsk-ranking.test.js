// slskd sends hasFreeUploadSlot (boolean) and queueLength on every search
// response. The renderer read `resp.freeUploadSlots`, which slskd has never
// sent, so `|| 0` made it 0 and the +10 availability bonus never once fired.
// queueLength was not used in ranking at all.
//
// Confirmed against a live response, whose fields are exactly:
//   fileCount, files, hasFreeUploadSlot, lockedFileCount, lockedFiles,
//   queueLength, token, uploadSpeed, username
// One peer in that sample had queueLength 1727 and ranked like an idle one.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RAW = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
// Strip comments: the fix documents the old field name in prose, and a naive
// grep would match that and fail forever.
const R = RAW.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n')
const M = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')

test('the renderer no longer reads a field slskd does not send', () => {
  assert.ok(!/freeUploadSlots/.test(R),
    'freeUploadSlots is not part of the slskd search-response schema')
})

test('it reads the fields slskd actually sends', () => {
  assert.ok(/hasFreeUploadSlot/.test(R), 'availability must come from hasFreeUploadSlot')
  assert.ok(/queueLength:\s*resp\.queueLength/.test(R), 'queue depth must be captured')
})

test('main.js and the renderer agree on the field names', () => {
  // main.js already had this right in its discovery paths; the search path did
  // not, and that divergence is what hid the bug.
  for (const f of ['hasFreeUploadSlot', 'queueLength']) {
    assert.ok(M.includes(f) && R.includes(f), f + ' must be read on both sides')
  }
})

test('queue depth participates in ranking', () => {
  assert.ok(/queueLength[\s\S]{0,120}Math\.log2/.test(R) || /Math\.min\(a\.queueLength/.test(R),
    'a peer 1700 deep must not rank like an idle one')
})
