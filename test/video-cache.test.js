'use strict'
const test = require('node:test')
const assert = require('node:assert')
const C = require('../src/video-cache')

// V123: automatic cleanup respects the file that is playing.
test('evictPlan never evicts a protected key, and refuses the newcomer rather than touch it', () => {
  const C2 = require('../src/video-cache')
  const e = (key, size, at) => ({ key, path: '/c/' + key, sizeBytes: size, savedAt: at, lastUsedAt: at })
  const entries = [e('old', 4, 1), e('playing', 4, 2), e('new-ish', 4, 3)]
  const plan = C2.evictPlan(entries, 10, 4, ['playing'])
  assert.deepEqual(plan.evict.map(x => x.key), ['old', 'new-ish'], 'the oldest unprotected go, the playing one stays')
  assert.equal(plan.ok, true)
  const blocked = C2.evictPlan([e('playing', 9, 1)], 10, 4, ['playing'])
  assert.deepEqual(blocked, { ok: false, evict: [], blockedBy: 'protected' })
  assert.deepEqual(C2.evictPlan(entries, 0, 1, ['playing']).evict.map(x => x.key), ['old', 'new-ish'], 'cache off still spares what is playing')
})
