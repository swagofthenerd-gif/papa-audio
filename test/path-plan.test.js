const test = require('node:test')
const assert = require('node:assert')
const P = require('../src/path-plan')

const files = (dir, ...names) => names.map(n => dir + '/' + n)

test('ordinary album folder names are accepted', () => {
  // A validator that rejects spaces or dashes would reject nearly every album.
  for (const n of [
    'Wish You Were Here 50',
    '1977 - Animals (2022 BluRay 5.1)',
    'AC-DC',
    'The Beatles [Remastered]',
    "Sgt. Pepper's Lonely Hearts Club Band",
  ]) {
    assert.deepEqual(P.validateName(n), [], n)
  }
})

test('names NTFS cannot store are rejected with a reason', () => {
  assert.match(P.validateName('bad:name')[0], /not allowed/)
  assert.match(P.validateName('has/slash')[0], /not allowed/)
  assert.match(P.validateName('trailing ')[0], /dot or a space/)
  assert.match(P.validateName('CON')[0], /reserved/)
  assert.match(P.validateName('')[0], /cannot be empty/)
})

test('a suggested name is offered, and is itself valid', () => {
  const s = P.suggestName('AC/DC: Back in Black ')
  assert.deepEqual(P.validateName(s), [], 'the suggestion must pass validation: ' + s)
  assert.equal(P.suggestName('CON'), 'CON_')
})

test('renaming produces the new path and a remap for every file under it', () => {
  const plan = P.renamePlan({
    dir: '/m/Old Name',
    newName: 'New Name',
    files: files('/m/Old Name', '01.flac', 'art/cover.jpg'),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.to, '/m/New Name')
  assert.deepEqual(plan.remaps, [
    { from: '/m/Old Name/01.flac', to: '/m/New Name/01.flac' },
    { from: '/m/Old Name/art/cover.jpg', to: '/m/New Name/art/cover.jpg' },
  ])
})

test('files outside the folder are never remapped', () => {
  // A prefix match that is not a path boundary would drag in a sibling.
  const plan = P.renamePlan({
    dir: '/m/Album',
    newName: 'Album2',
    files: ['/m/Album/1.flac', '/m/AlbumOther/1.flac'],
  })
  assert.deepEqual(plan.remaps.map(r => r.from), ['/m/Album/1.flac'])
})

test('a rename onto an existing sibling is refused', () => {
  const plan = P.renamePlan({
    dir: '/m/A', newName: 'B', files: [], siblings: ['/m/B', '/m/C'],
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.conflict, '/m/B')
  assert.deepEqual(plan.remaps, [], 'a refused plan must carry no operations')
})

test('conflict detection is case-insensitive, as the filesystem effectively is', () => {
  const plan = P.renamePlan({ dir: '/m/A', newName: 'b', files: [], siblings: ['/m/B'] })
  assert.equal(plan.conflict, '/m/B')
})

test('renaming to the same name is rejected rather than silently doing nothing', () => {
  const plan = P.renamePlan({ dir: '/m/Album', newName: 'Album', files: [] })
  assert.equal(plan.ok, false)
  assert.match(plan.invalid.join(' '), /already the folder name/)
})

test('an invalid rename carries no remaps at all', () => {
  const plan = P.renamePlan({
    dir: '/m/A', newName: 'bad:name', files: files('/m/A', '1.flac'),
  })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.remaps, [])
  assert.ok(plan.suggestion, 'a fixable name should come with a suggestion')
})

test('moving keeps the folder name and remaps under the new root', () => {
  const plan = P.movePlan({
    dir: '/m/Rock/Album', destRoot: '/m2/Sorted',
    files: files('/m/Rock/Album', '1.flac', '2.flac'),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.to, '/m2/Sorted/Album')
  assert.deepEqual(plan.remaps[0], { from: '/m/Rock/Album/1.flac', to: '/m2/Sorted/Album/1.flac' })
})

test('a folder cannot be moved into itself or its own child', () => {
  assert.match(P.movePlan({ dir: '/m/A', destRoot: '/m/A' }).invalid.join(' '), /inside itself/)
  assert.match(P.movePlan({ dir: '/m/A', destRoot: '/m/A/Sub' }).invalid.join(' '), /inside itself/)
})

test('moving somewhere it already is, is rejected', () => {
  assert.match(P.movePlan({ dir: '/m/Rock/A', destRoot: '/m/Rock' }).invalid.join(' '), /already in that folder/)
})

test('a move onto an existing folder is refused', () => {
  const plan = P.movePlan({ dir: '/m/A', destRoot: '/m2', existing: ['/m2/A'] })
  assert.equal(plan.ok, false)
  assert.equal(plan.conflict, '/m2/A')
})

test('the plan explains itself in plain language', () => {
  const good = P.renamePlan({ dir: '/m/A', newName: 'B', files: files('/m/A', '1.flac', '2.flac') })
  assert.equal(P.describePlan(good), '2 files will move.')
  const bad = P.renamePlan({ dir: '/m/A', newName: 'B', files: [], siblings: ['/m/B'] })
  assert.match(P.describePlan(bad), /already exists/)
})
