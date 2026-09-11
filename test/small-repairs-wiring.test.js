'use strict'
// R8 / R14 / R15 / R17 + the plural sweep: small truths, each pinned.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const shop = require('../src/slsk-shop-ui')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('R8: the anime numbering dialog closes on backdrop, Escape and navigation', () => {
  const d = fn('_openAnimeNumberingDialog')
  assert.match(d, /dlg\.addEventListener\('click', function \(e\) \{ if \(e\.target === dlg\) close\(\) \}\)/)
  assert.match(d, /if \(e\.key === 'Escape'\) close\(\)/)
  assert.match(d, /_registerNavDismiss\(close\)/)
})

test('R14: the person page error state offers Try again that re-runs the render', () => {
  const p = fn('renderPerson')
  assert.match(p, /id="vperson-retry">Try again<\/button>/)
  assert.match(p, /getElementById\('vperson-retry'\)\?\.addEventListener\('click', function \(\) \{ renderPerson\(personId\) \}\)/)
})

test('R15: a peer who is offline is told as such; a 404 is worded for a person', () => {
  assert.match(shop.browseFailureText('bob', 'slskd 404 on GET /users/bob/browse', false), /bob is offline/)
  assert.match(shop.browseFailureText('bob', 'slskd 404 on GET /users/bob/browse', null), /no record of bob/)
  assert.match(shop.browseFailureText('bob', 'fetch failed', true), /Could not reach the slskd daemon/)
  assert.match(shop.browseFailureText('bob', 'yt timed out', true), /did not answer in time/)
  assert.match(shop.browseFailureText('bob', '', true), /Could not load this library: unknown error/)
  const src = fs.readFileSync(path.join(SRC, 'slsk-shop-ui.js'), 'utf8')
  assert.match(src, /browseFailureText\(username, res\.error, online\)/)
})

test('R17: an empty playlist folder renders, says so, and can be deleted with Undo', () => {
  const p = fn('renderPlaylists')
  assert.match(p, /\(state\.playlistFolders \|\| \[\]\)\.forEach\(function \(f\) \{ if \(f && !folders\[f\]\) folders\[f\] = \[\] \}\)/)
  assert.match(p, /class="pl-folder-empty">Empty folder/)
  assert.match(p, /\.pl-folder-delete'\)\.forEach/)
  assert.match(p, /showSnackbar\('Folder "' \+ name \+ '" deleted', 'Undo'/)
})

test('plural sweep: the known "1 albums" sites use the one helper', () => {
  assert.match(CODE, /_plural\(count, 'album'\)/, 'folder tree')
  assert.match(CODE, /_plural\(artistAlbums\.length, 'album'\) \+ ' &middot; ' \+ _plural\(totalTracks, 'track'\)/, 'artist hero')
  assert.match(CODE, /\? _plural\(sortedAlbums\.length, 'album'\)/, 'library count')
  assert.equal((CODE.match(/_plural\(state\.library\.length, 'album'\) \+ ' found'/g) || []).length, 2, 'scan snackbars')
})
