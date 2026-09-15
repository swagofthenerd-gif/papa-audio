'use strict'
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-share')

// Roadmap 137: sharing is explicit — default, scope and off are all stated.
test('the three modes map to share directories', () => {
  assert.deepEqual(S.shareDirs('library', ['/m/Music', '/m/More'], '/m/Music/Downloads'), ['/m/Music'])
  assert.deepEqual(S.shareDirs('downloads', ['/m/Music'], '/m/Music/Downloads'), ['/m/Music/Downloads'])
  assert.deepEqual(S.shareDirs('off', ['/m/Music'], '/m/Music/Downloads'), [])
  assert.deepEqual(S.shareDirs('library', [], '/dl'), ['/dl'], 'no library yet: the download folder stands in')
  assert.deepEqual(S.shareDirs('nonsense', ['/m'], '/dl'), ['/m'], 'unknown falls back to the stated default')
  assert.equal(S.DEFAULT, 'library')
})

test('the description says what is exposed, and warns about sharing nothing', () => {
  assert.match(S.describe('library', ['/m/Music']), /\/m\/Music.*browse and download everything/)
  assert.match(S.describe('downloads', ['/dl']), /Only your download folder/)
  assert.match(S.describe('off', []), /refuse downloads to people who share nothing/)
})
