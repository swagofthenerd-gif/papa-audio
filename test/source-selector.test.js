'use strict'
// The source selector (2026-09-16).
//
// Sources were always gathered — anime queries six or seven indexers, MORE
// than film does — but Play picked one silently, and the only control beside
// it chose a RESOLUTION, not a release. So the app looked like it had exactly
// one source: "my anime is only playing from a single source, please add a
// selector... so that i can choose to watch it from different sources if i
// want to."
//
// These EXECUTE the renderer's functions. Four dead-Play-button bugs on this
// path were all ReferenceErrors that a regex pin looked straight past, so
// anything on the Play path gets run here, not grepped.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The slice carrying _isInstantSource, _sourceOptionLabel, _renderSourcePicker,
// _streamable/_requiredMbps and _pickForPlay — everything the hero selector and
// Play share.
function pickerCtx(over) {
  const ctx = Object.assign({
    console, Number, String, Boolean, Array, Object, Math, JSON, Date,
    _debridPick: null,
    _debridHeld: [],
    _playSourceKey: '',
    _playQuality: '',
    _videoStreams: [],
    _videoDetail: { type: 'anime', id: 21, d: { id: 21, title: 'One Piece' } },
    _videoState: { season: null, episode: 7 },
    _watch: { pick: null, tried: {} },
    _QUALITY_ORDER: ['2160p', '1080p', '720p', '480p'],
    _sourceKey: x => (x && (x.magnet || x.url)) || '',
    _fmtBytes: n => Math.round(n / 1e9) + ' GB',
    _autoPickStream: () => null,
    _preferredSourceOf: () => null,
    _pickMatchingStream: () => null,
    _syncSourcesHighlight() {},
    _rememberPreferredSource() {},
    esc: v => String(v == null ? '' : v),
    document: { getElementById: () => null },
    window: { PapaReleaseName: { parse: t => ({ group: (/^\[([^\]]+)\]/.exec(t || '') || [])[1] || null }) } },
  }, over || {})
  vm.createContext(ctx)
  const start = RENDERER.indexOf('// Is RealDebrid holding this source?')
  assert.ok(start > 0, 'found the picker block')
  const end = RENDERER.indexOf('function _autoPickStream(')
  assert.ok(end > start, 'found the end of the picker block')
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return ctx
}

const S = (o) => Object.assign({ kind: 'torrent', quality: '1080p', seeders: 100, sizeBytes: 2e9 }, o)

test('a source RealDebrid is holding is marked instant; the rest are not', () => {
  const held = S({ magnet: 'magnet:a', title: '[SubsPlease] Show - 07.mkv' })
  const cold = S({ magnet: 'magnet:b', title: '[Erai] Show - 07.mkv' })
  const ctx = pickerCtx({ _debridHeld: ['magnet:a'] })
  assert.strictEqual(ctx._isInstantSource(held), true)
  assert.strictEqual(ctx._isInstantSource(cold), false)
  // The winner of the pick counts too, even if `held` never arrived.
  const ctx2 = pickerCtx({ _debridPick: 'magnet:b' })
  assert.strictEqual(ctx2._isInstantSource(cold), true)
  // A direct-HTTP source is never "instant" — debrid has nothing to do with it.
  assert.strictEqual(ctx2._isInstantSource({ kind: 'http', url: 'https://x' }), false)
})

test('a source is described by what actually decides between sources', () => {
  const ctx = pickerCtx({ _debridHeld: ['magnet:a'] })
  const label = ctx._sourceOptionLabel(S({ magnet: 'magnet:a', title: '[SubsPlease] Show - 07.mkv' }))
  for (const part of ['instant', '1080p', 'SubsPlease', '100 seeds', '2 GB']) {
    assert.ok(label.includes(part), 'missing "' + part + '" in: ' + label)
  }
  // Nothing is invented for a source the indexer said nothing about.
  const bare = ctx._sourceOptionLabel({ kind: 'torrent', magnet: 'magnet:z' })
  assert.ok(!/seeds|GB|instant/.test(bare), 'no fabricated facts: ' + bare)
})

// The actual point of the feature: Play must start the source that was chosen.
test('an explicitly chosen source is what Play starts', () => {
  const a = S({ magnet: 'magnet:a', quality: '2160p', title: '[A] Show.mkv' })
  const b = S({ magnet: 'magnet:b', quality: '720p', title: '[B] Show.mkv' })
  const list = [a, b]
  // Left alone, Play takes the ranked first.
  assert.strictEqual(pickerCtx({})._pickForPlay(list), list[0])
  // Chosen by hand, Play takes THAT — even though it is the worse picture and
  // even though debrid is holding the other one.
  const ctx = pickerCtx({ _playSourceKey: 'magnet:b', _debridPick: 'magnet:a', _debridHeld: ['magnet:a'] })
  const got = ctx._pickForPlay(list)
  assert.strictEqual(got.magnet, 'magnet:b', 'an explicit choice is not a suggestion')
})

test('a chosen source that is no longer offered does not strand the picker', () => {
  // Nothing to select into: _renderSourcePicker must clear the stale key
  // rather than leaving Play pointed at a source that is gone.
  const list = [S({ magnet: 'magnet:a', title: '[A] Show.mkv' }), S({ magnet: 'magnet:c', title: '[C] Show.mkv' })]
  const wrap = { hidden: true }
  const sel = { innerHTML: '', dataset: {}, addEventListener() {} }
  const ctx = pickerCtx({
    _playSourceKey: 'magnet:gone',
    _videoStreams: list,
    document: { getElementById: id => (id === 'vdet-source-wrap' ? wrap : id === 'vdet-source' ? sel : null) },
  })
  ctx._renderSourcePicker(list)
  assert.strictEqual(ctx._playSourceKey, '', 'a source that vanished is not still selected')
  assert.strictEqual(wrap.hidden, false, 'two sources is a choice, so the control shows')
  assert.ok(sel.innerHTML.includes('Auto'), 'auto stays the default')
  assert.strictEqual((sel.innerHTML.match(/<option/g) || []).length, 3, 'Auto plus both sources')
})

test('one source is not a choice, so the selector stays hidden', () => {
  const wrap = { hidden: false }
  const sel = { innerHTML: '', dataset: {}, addEventListener() {} }
  const ctx = pickerCtx({
    document: { getElementById: id => (id === 'vdet-source-wrap' ? wrap : id === 'vdet-source' ? sel : null) },
  })
  ctx._renderSourcePicker([S({ magnet: 'magnet:a', title: '[A] Show.mkv' })])
  assert.strictEqual(wrap.hidden, true)
})

// The deck's Source chip, which is how a stalling source gets swapped without
// leaving the video.
test('the deck is offered the same sources the page shows, with what is playing marked', () => {
  const list = [
    S({ magnet: 'magnet:a', title: '[SubsPlease] Show - 07.mkv' }),
    S({ magnet: 'magnet:b', title: '[Erai] Show - 07.mkv' }),
  ]
  const ctx = pickerCtx({ _videoStreams: list, _debridHeld: ['magnet:b'], _watch: { pick: list[0], tried: {} } })
  const start = RENDERER.indexOf('function _playerSourceList(')
  const end = RENDERER.indexOf('async function _playerPickSource(')
  vm.runInContext(RENDERER.slice(start, end), ctx)
  const offered = Array.from(ctx._playerSourceList())
  assert.strictEqual(offered.length, 2)
  assert.strictEqual(offered[0].current, true, 'what is playing is marked')
  assert.strictEqual(offered[1].current, false)
  assert.strictEqual(offered[1].instant, true, 'the held one is marked instant')
  assert.strictEqual(offered[0].short, 'SubsPlease', 'the chip names the release group')
  assert.ok(offered[0].key && offered[0].key !== offered[1].key, 'each is addressable')
})
