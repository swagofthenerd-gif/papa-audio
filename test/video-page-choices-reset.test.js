'use strict'
// Pick 720p on Interstellar, then open The Godfather: its Auto line read
// "Auto — 720p" and Play started a 720p file, for a choice nobody had made
// about that film. The hand-picked SOURCE was cleared when a new detail page
// opened; the hand-picked QUALITY was not. The quality picker only dropped a
// stale choice when the new title had no source at that quality at all —
// which is the rare case, not the common one, so in practice it stuck for the
// rest of the session.
//
// Both choices now live in one reset, and this runs the real reset and the
// real picker to prove the second title starts clean.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = source.indexOf('{', source.indexOf('(', start)); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// A title with the same three qualities the previous one had — which is why
// the stale choice survived the picker's own "is it still on offer?" check.
const GODFATHER = [
  { title: 'The.Godfather.2160p', quality: '2160p', kind: 'torrent', magnet: 'magnet:4k', seeders: 900, sizeBytes: 20e9 },
  { title: 'The.Godfather.1080p', quality: '1080p', kind: 'torrent', magnet: 'magnet:1080', seeders: 800, sizeBytes: 8e9 },
  { title: 'The.Godfather.720p', quality: '720p', kind: 'torrent', magnet: 'magnet:720', seeders: 700, sizeBytes: 3e9 },
]

function ctxWith (extra) {
  const s = Object.assign({
    console,
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    // page state the reset owns
    _videoStreams: [],
    _debridPick: null,
    _debridHeld: [],
    _playSourceKey: '',
    _playQuality: '',
    _lastNumbering: null,
    _playing: null,
    _prefetch: null,
    // what the picker leans on
    _playMinutes: () => 175,
    _streamable: () => true,
    _sourceKey: x => (x && (x.magnet || x.url || '')) || '',
    // No remembered cross-session preference in play here: this is about the
    // choice made on the PREVIOUS page leaking onto this one.
    _preferredSourceOf: () => null,
    _QUALITY_ORDER: ['2160p', '1080p', '720p', '480p'],
  }, extra || {})
  s.globalThis = s
  vm.createContext(s)
  vm.runInContext([
    extractFn(SRC, '_resetDetailPageChoices'),
    extractFn(SRC, '_pickForPlay'),
    extractFn(SRC, '_autoPickStream'),
    extractFn(SRC, '_availableQualities'),
  ].join('\n'), s)
  return s
}

test('a quality picked on one film does not follow you to the next one', () => {
  const s = ctxWith({})
  // On Interstellar the viewer chose 720p by hand.
  s._playQuality = '720p'
  s._videoStreams = GODFATHER
  assert.strictEqual(s._pickForPlay(GODFATHER).quality, '720p',
    'on the title the choice was made about, it is honoured')

  // Now open a different title.
  s._resetDetailPageChoices()
  assert.strictEqual(s._playQuality, '', 'the choice did not travel')
  assert.strictEqual(s._pickForPlay(GODFATHER).quality, '2160p',
    'the new title picks the best it has, not last title\'s 720p')
})

test('the source choice is reset too — it always was, and still is', () => {
  const s = ctxWith({})
  s._playSourceKey = 'magnet:720'
  s._resetDetailPageChoices()
  assert.strictEqual(s._playSourceKey, '')
  assert.strictEqual(s._pickForPlay(GODFATHER).magnet, 'magnet:4k')
})

test('one reset clears every page-scoped decision', () => {
  // These drifted apart once already. Naming them all here means the next
  // field added to the page can only drift if someone edits this list.
  const s = ctxWith({
    _videoStreams: GODFATHER,
    _debridPick: 'magnet:720',
    _debridHeld: ['magnet:720'],
    _playSourceKey: 'magnet:720',
    _playQuality: '720p',
    _lastNumbering: { kind: 'absolute' },
    _playing: { dub: true, source: 'x', quality: '720p' },
    _prefetch: { key: 'k', streams: GODFATHER, inflight: true },
  })
  s._resetDetailPageChoices()
  assert.strictEqual(s._videoStreams.length, 0)
  assert.strictEqual(s._debridPick, null)
  assert.strictEqual(s._debridHeld.length, 0)
  assert.strictEqual(s._playSourceKey, '')
  assert.strictEqual(s._playQuality, '')
  assert.strictEqual(s._lastNumbering, null)
  assert.deepStrictEqual({ ...s._playing }, { dub: null, source: null, quality: null })
  assert.deepStrictEqual({ ...s._prefetch }, { key: null, streams: null, inflight: false })
})

test('a debrid-held source no longer inherits the last title\'s quality veto', () => {
  // _pickForPlay refuses a held source whose quality is not the chosen one.
  // With a stale choice that veto applied to a title the viewer had said
  // nothing about, so the instant-start source was passed over for a slow one.
  const s = ctxWith({ _debridPick: 'magnet:4k' })
  s._playQuality = '720p'
  assert.strictEqual(s._pickForPlay(GODFATHER).quality, '720p', 'the veto bites while the choice stands')
  s._debridPick = 'magnet:4k'
  s._resetDetailPageChoices()
  s._debridPick = 'magnet:4k'
  assert.strictEqual(s._pickForPlay(GODFATHER).magnet, 'magnet:4k',
    'after the reset the held source is taken')
})
