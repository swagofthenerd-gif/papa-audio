const test = require('node:test')
const assert = require('node:assert')
const Q = require('../src/queue-repair')

const q = (...paths) => paths.map((p, i) => ({ filePath: p, title: 't' + i }))

test('removing a track BEFORE the current one keeps the same song playing', () => {
  const r = Q.repairQueue({ queue: q('/a', '/b', '/c'), queueIndex: 2, removedPaths: ['/a'] })
  assert.deepEqual(r.queue.map(t => t.filePath), ['/b', '/c'])
  assert.equal(r.queueIndex, 1)          // still pointing at /c
  assert.equal(r.removedCurrent, false)
})

test('removing a track AFTER the current one does not move the index', () => {
  const r = Q.repairQueue({ queue: q('/a', '/b', '/c'), queueIndex: 0, removedPaths: ['/c'] })
  assert.equal(r.queueIndex, 0)
  assert.equal(r.queue.length, 2)
})

test('removing the CURRENT track lands on whatever followed it', () => {
  const r = Q.repairQueue({ queue: q('/a', '/b', '/c'), queueIndex: 1, removedPaths: ['/b'] })
  assert.deepEqual(r.queue.map(t => t.filePath), ['/a', '/c'])
  assert.equal(r.queueIndex, 1)          // /c
  assert.equal(r.removedCurrent, true)
})

test('removing the LAST track while it is playing clamps to the new last', () => {
  const r = Q.repairQueue({ queue: q('/a', '/b'), queueIndex: 1, removedPaths: ['/b'] })
  assert.deepEqual(r.queue.map(t => t.filePath), ['/a'])
  assert.equal(r.queueIndex, 0)
  assert.equal(r.removedCurrent, true)
})

test('removing everything yields a defined empty state, never index -1', () => {
  const r = Q.repairQueue({ queue: q('/a', '/b'), queueIndex: 1, removedPaths: ['/a', '/b'] })
  assert.deepEqual(r.queue, [])
  assert.equal(r.queueIndex, 0)
  assert.equal(r.empty, true)
  assert.equal(r.nextIndex, -1)
  assert.equal(r.removedCurrent, true)
})

test('removing several before the current one shifts by exactly that many', () => {
  const r = Q.repairQueue({ queue: q('/a', '/b', '/c', '/d'), queueIndex: 3, removedPaths: ['/a', '/c'] })
  assert.deepEqual(r.queue.map(t => t.filePath), ['/b', '/d'])
  assert.equal(r.queueIndex, 1)          // still /d
})

test('removing nothing leaves the queue and index untouched', () => {
  const before = q('/a', '/b')
  const r = Q.repairQueue({ queue: before, queueIndex: 1, removedPaths: [] })
  assert.deepEqual(r.queue.map(t => t.filePath), ['/a', '/b'])
  assert.equal(r.queueIndex, 1)
  assert.equal(r.removedCount, 0)
})

test('entries with no filePath (streams) are never removed', () => {
  const queue = [{ videoId: 'yt1' }, { filePath: '/a' }]
  const r = Q.repairQueue({ queue, queueIndex: 0, removedPaths: ['/a'] })
  assert.equal(r.queue.length, 1)
  assert.equal(r.queue[0].videoId, 'yt1')
})

test('impact warns BEFORE deleting that the playing track is a target', () => {
  const i = Q.queueImpact(q('/a', '/b', '/c'), 1, ['/b', '/c'])
  assert.equal(i.count, 2)
  assert.equal(i.playingHit, true)
  assert.deepEqual(i.hits.map(h => h.index), [1, 2])
})

test('impact reports no playing hit when the current track survives', () => {
  const i = Q.queueImpact(q('/a', '/b'), 0, ['/b'])
  assert.equal(i.count, 1)
  assert.equal(i.playingHit, false)
})
