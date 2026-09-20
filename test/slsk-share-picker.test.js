'use strict'
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-share')

// What main hands in: the two things the pure module cannot look up itself.
const HOME = '/home/shaharyar'
const OPTS = { home: HOME, slskdDir: HOME + '/.config/papa-audio/slskd' }

const refused = (p, o) => S.pickRefusal(p, o || OPTS)

test('a whole drive is refused', () => {
  for (const p of ['/', '/home', '/mnt', '/media', '/run', '/mnt/']) {
    const r = refused(p)
    assert.ok(r, p + ' must never be shared whole')
    assert.equal(r.reason, 'drive')
    assert.match(r.error, /whole drive. Pick the folder your music is actually in/)
  }
})

test('the home folder itself is refused, and says what it would have done', () => {
  const r = refused(HOME)
  assert.ok(r)
  assert.equal(r.reason, 'home')
  assert.match(r.error, /whole home folder/)
  assert.match(r.error, /everything on this computer on Soulseek/)
  assert.ok(refused(HOME + '/'), 'trailing slash is the same folder')
})

test('the personal folders and every dotfolder are refused', () => {
  for (const p of [
    HOME + '/Desktop',
    HOME + '/Documents',
    HOME + '/Downloads',
    HOME + '/.config',
    HOME + '/.ssh',
    HOME + '/.ssh/keys',
    HOME + '/.local/share/secrets',
    '/mnt/data/.hidden'
  ]) {
    const r = refused(p)
    assert.ok(r, p + ' must be refused')
    assert.equal(r.reason, 'personal')
    assert.match(r.error, /Pick a music folder instead/)
  }
})

test("Soulseek's own working folder is refused", () => {
  const r = refused('/home/shaharyar/papa-audio/slskd',
    { home: HOME, slskdDir: '/home/shaharyar/papa-audio/slskd' })
  assert.ok(r)
  assert.equal(r.reason, 'slskd')
  const inside = refused('/home/shaharyar/papa-audio/slskd/incomplete',
    { home: HOME, slskdDir: '/home/shaharyar/papa-audio/slskd' })
  assert.ok(inside, 'the folders under it too — that is where the credentials live')
})

test('a real music folder is allowed', () => {
  assert.equal(refused('/mnt/data/MUSIC'), null)
  assert.equal(refused('/mnt/data/MUSIC/Downloads'), null,
    'the app download folder is not ~/Downloads')
  assert.equal(refused('/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos]'), null)
  assert.equal(refused(HOME + '/Music'), null, 'a folder inside home is fine')
  assert.equal(refused(HOME + '/Desktop/FLAC'), null,
    'a chosen folder on the desktop is fine — it is the blanket folders that are not')
})

test('a folder that is not a path at all is refused rather than shared', () => {
  for (const p of ['', '   ', 'Music', null, undefined, 42]) {
    const r = refused(p)
    assert.ok(r, JSON.stringify(p) + ' is not a folder on this computer')
    assert.equal(r.reason, 'invalid')
  }
})

test('the refusal is only advice — it never touches anything', () => {
  // Pure: main calls it on whatever the folder chooser returns, before
  // anything is added to the list or written anywhere.
  assert.equal(typeof S.pickRefusal, 'function')
  assert.equal(S.pickRefusal('/mnt/data/MUSIC', {}), null,
    'with nothing handed in it still refuses only what it can prove')
})
