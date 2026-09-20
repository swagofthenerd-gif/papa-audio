const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/slsk-room-ui')

test('headerModel turns stats into ring slices that sum to 100', () => {
  const h = R.headerModel({ albums: 100, hiRes: 18, surround: 8, losslessPct: 71, tracks: 1000, size: 1e12 }, 'A 70s rock collector', { online: true, queue: 2 })
  const sum = h.ring.reduce((s, x) => s + x.pct, 0)
  assert.equal(sum, 100)
  assert.equal(h.ring[0].tier, 'hires')
  assert.equal(h.status, 'online now · 2 in their queue')
  assert.equal(h.line, 'A 70s rock collector')
})

test('modeKey is per peer and seeds from the old global key', () => {
  assert.equal(R.modeKey('Some User'), 'slsk_lib_mode:some user')
})

test('wander shelf order is fixed and empty shelves are dropped', () => {
  const shelves = R.wanderShelves({ goDeep: [], fresh: [1], because: [], onlyHere: null, decade: { decade: 1970, share: 40, albums: [1] }, surround: [], hires: [1] })
  assert.deepEqual(shelves.map(s => s.id), ['fresh', 'decade', 'hires'])
})

// Text-level wiring checks: these three contracts (sliced browse, refresh
// subscription, Folders toggles) are all page-level plumbing that a unit test
// of the exported model functions cannot reach.
const fs = require('fs'), path = require('path')
const roomSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-room-ui.js'), 'utf8')

test('the Folders toggles exist, default to audio-only, and reach setFilters', () => {
  assert.ok(roomSrc.includes('id="slr-f-audio"'), 'an Audio only checkbox is emitted')
  assert.ok(roomSrc.includes('id="slr-f-surround"'), 'a Surround only checkbox is emitted')
  assert.ok(roomSrc.includes('Audio only') && roomSrc.includes('Surround only'))
  // Default ON must match slsk-columns' own `{ audioOnly: true }`.
  assert.ok(/const folders = \{ audioOnly: true, surroundOnly: false \}/.test(roomSrc))
  assert.ok(/columns\.setFilters\(\{ audioOnly: folders\.audioOnly, surroundOnly: folders\.surroundOnly \}\)/.test(roomSrc))
  assert.ok(roomSrc.includes("audioKey(username)"), 'the audio-only choice is persisted per peer')
  assert.ok(roomSrc.includes("'slsk_folders_audio:'"))
  // Only visible in Folders mode.
  assert.ok(/ff\.hidden = m !== 'folders'/.test(roomSrc))
})

test('the library is pulled in slices when the engine offers them', () => {
  assert.ok(roomSrc.includes('window.api.slskBrowseBegin'))
  assert.ok(roomSrc.includes('window.api.slskBrowseChunk'))
  assert.ok(roomSrc.includes('window.api.slskBrowseEnd'))
  assert.ok(roomSrc.includes('createTreeBuilder'), 'the tree is built cooperatively')
  assert.ok(roomSrc.includes('window.api.slskBrowseUser'), 'the single-shot call remains the fallback')
  assert.ok(roomSrc.includes('loadingLine('), 'the loading line carries progress')
})

test('a background browse refresh is subscribed to and unsubscribed on close', () => {
  assert.ok(roomSrc.includes('window.api.onSlskBrowseRefreshed'))
  assert.ok(/offBrowseRefreshed = window\.api\.onSlskBrowseRefreshed/.test(roomSrc), 'the off-function is stored')
  assert.ok(/if \(offBrowseRefreshed\) \{ try \{ offBrowseRefreshed\(\) \}/.test(roomSrc), 'close() unsubscribes')
  assert.ok(roomSrc.includes("' · Updated just now'"))
})

test('the Folders inspector can open a dossier straight into a verify', () => {
  const cols = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-columns.js'), 'utf8')
  const dos = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-dossier.js'), 'utf8')
  assert.ok(cols.includes('data-act="dossier-verify"') && cols.includes('Verify this rip'))
  assert.ok(cols.includes("autoVerify: act.dataset.act === 'dossier-verify'"))
  assert.ok(/openDossier\(album, opts\)/.test(roomSrc) && roomSrc.includes('autoVerify: !!(opts && opts.autoVerify)'))
  assert.ok(dos.includes('if (autoVerify && !m.rip) verify()'))
})

test('a dossier left behind by a host wipe unhooks its own keydown listener', () => {
  const dos = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-dossier.js'), 'utf8')
  assert.ok(/if \(!root\.isConnected\) \{ document\.removeEventListener\('keydown', onKey, true\); return \}/.test(dos))
})

// The header carries the live search input, so it is built once and only ever
// updated in place after that. A repaint from the refresh path would destroy
// #slr-search mid-keystroke — focus, caret and the pending debounce with it.
test('the header is painted once and the refresh path only updates it in place', () => {
  assert.equal((roomSrc.match(/headEl\.innerHTML\s*=/g) || []).length, 1,
    'exactly one place serialises the header')
  assert.equal((roomSrc.match(/\bpaintHead\(/g) || []).length, 2,
    'paintHead is defined once and called once — only from updateHead\'s first-paint branch')
  assert.ok(/function updateHead\(hm\) \{\s*if \(!headPainted\) \{ paintHead\(hm\); return \}/.test(roomSrc),
    'updateHead builds on first call and updates in place thereafter')
  assert.ok(/function refreshHead\(\) \{[\s\S]*?updateHead\(headerModel\(/.test(roomSrc),
    'refreshHead goes through updateHead, never paintHead')
  assert.ok(!/repaintHead/.test(roomSrc), 'the old head-repainting helper is gone')
  const handler = roomSrc.slice(roomSrc.indexOf('onSlskBrowseRefreshed('))
  assert.ok(handler.includes('refreshHead()'), 'the refresh path updates the head')
  assert.ok(!handler.slice(0, handler.indexOf('const first = await pullBrowse')).includes('paintHead('),
    'the refresh handler never rebuilds the head')
  assert.ok(roomSrc.includes('id="slr-ring"') && roomSrc.includes('id="slr-headline"'),
    'the mutable bits carry ids updateHead can reach')
})

// Nothing heavy rebuilds under a moving finger, and Folders keeps its place.
test('the refresh path waits for the scroll to settle and leaves Folders mounted', () => {
  assert.ok(/roomScrolling = true/.test(roomSrc) && /roomScrolling = false \}, 250\)/.test(roomSrc),
    'a 250 ms scroll settle like the shop\'s shScrolling')
  assert.ok(/while \(roomScrolling &&/.test(roomSrc), 'the refresh waits out the scroll')
  assert.ok(/requestIdleCallback/.test(roomSrc), 'and yields to an idle slot')
  assert.ok(/if \(mode !== 'folders'\) paintBody\(\)/.test(roomSrc),
    'Folders is not destroyed and remounted by a background refresh')
})

test('the background enrichment IIFE declares its own Wm before using it', () => {
  const start = roomSrc.indexOf('// Background: seeds and tags')
  assert.ok(start !== -1, 'background enrichment comment found')
  const iifeStart = roomSrc.indexOf(';(async () => {', start)
  assert.ok(iifeStart !== -1, 'background IIFE found')
  const iifeEnd = roomSrc.indexOf('})()', iifeStart)
  assert.ok(iifeEnd !== -1, 'background IIFE close found')
  const body = roomSrc.slice(iifeStart, iifeEnd)
  const declIdx = body.indexOf('const Wm = W()')
  const guardIdx = body.indexOf('if (!Wm) return')
  const firstUseIdx = body.indexOf('Wm.', guardIdx)
  assert.ok(declIdx !== -1, 'IIFE declares its own const Wm')
  assert.ok(guardIdx !== -1 && declIdx < guardIdx, 'guard clause kept after declaration')
  assert.ok(firstUseIdx !== -1 && declIdx < firstUseIdx, 'Wm is declared before first use')
})
