'use strict'
const test = require('node:test')
const assert = require('node:assert')
const G = require('../src/gain-policy')

// Roadmap 096: one documented gain policy, with clipping risk stated.
test('unity is unity', () => {
  const r = G.assess({ boost: false, volumePct: 100, eq: { enabled: false }, replaygain: 'no' })
  assert.equal(r.totalDb, 0); assert.equal(r.risk, 'none'); assert.match(r.text, /nothing can clip/)
})

test('boost above 100 % is software gain and is named', () => {
  const r = G.assess({ boost: true, volumePct: 130 })
  assert.equal(r.totalDb, 2.3); assert.equal(r.risk, 'possible'); assert.match(r.text, /Volume 130%/)
})

test('an EQ curve counts its peak minus its preamp; a covering preamp costs nothing', () => {
  assert.equal(G.assess({ eq: { enabled: true, preamp: 0, gains: [6, 3, 0] } }).totalDb, 6)
  assert.equal(G.assess({ eq: { enabled: true, preamp: 0, gains: [6, 3, 0] } }).risk, 'likely')
  const covered = G.assess({ eq: { enabled: true, preamp: -6, gains: [6, 3, 0] } })
  assert.equal(covered.totalDb, 0); assert.equal(covered.risk, 'none')
  assert.equal(G.assess({ eq: { enabled: false, preamp: 0, gains: [12] } }).totalDb, 0, 'a disabled EQ is not gain')
})

test('sources add up and ReplayGain is noted rather than guessed', () => {
  const r = G.assess({ volumePct: 130, eq: { enabled: true, preamp: -2, gains: [4] }, replaygain: 'album' })
  assert.equal(r.totalDb, 4.3); assert.equal(r.risk, 'likely')
  assert.match(r.text, /Volume 130% and EQ/); assert.match(r.text, /ReplayGain may raise quiet tracks/)
})
