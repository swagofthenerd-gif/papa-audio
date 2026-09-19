const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path'), vm = require('vm')
const SRC = path.join(__dirname, '..', 'src')
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')

test('every room script is a page script, after its dependencies', () => {
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  const at = f => order.indexOf(f)
  for (const f of ['slsk-hunt.js', 'slsk-wander.js', 'slsk-columns.js', 'slsk-dossier.js', 'slsk-room-ui.js']) assert.ok(at(f) >= 0, f + ' is loaded')
  assert.ok(at('slsk-shelves.js') < at('slsk-hunt.js'))
  assert.ok(at('slsk-album-view.js') < at('slsk-dossier.js'))
  assert.ok(at('slsk-dossier.js') < at('slsk-room-ui.js') && at('slsk-columns.js') < at('slsk-room-ui.js'))
  assert.ok(html.includes('href="slsk-room.css"'))
})

test('the six slsk page scripts share one scope without a name collision', () => {
  const files = ['slsk-tree.js', 'slsk-shelves.js', 'slsk-hunt.js', 'slsk-wander.js', 'slsk-columns.js', 'slsk-dossier.js', 'slsk-room-ui.js']
  const src = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n')
  new vm.Script(src, { filename: 'slsk-all.js' })
})

test('renderSoulseekExplore prefers the room and honours the legacy switch', () => {
  const body = renderer.slice(renderer.indexOf('async function renderSoulseekExplore'), renderer.indexOf('async function renderSoulseekExplore') + 2500)
  assert.ok(body.includes('PapaSlskRoomUI'))
  assert.ok(body.includes('slskLegacyShop'))
})

test('the two new Soulseek settings exist and are painted', () => {
  assert.ok(html.includes('id="slsk-legacy-shop"'))
  assert.ok(html.includes('id="slsk-discogs-token"'))
  assert.ok(renderer.includes("getElementById('slsk-legacy-shop')"))
  assert.ok(renderer.includes("getElementById('slsk-discogs-token')"))
})

test('the room close handle is stored and called on navigate-away', () => {
  // The room's background enrichment loop and art observer only stop when the
  // handle show() resolves to has its close() called.
  assert.ok(/let _slskRoomClose = null/.test(renderer), 'a module-level close slot exists')
  assert.ok(/function _closeSlskRoom\s*\(\)/.test(renderer), '_closeSlskRoom tears the slot down')
  assert.ok(/_slskRoomClose = close/.test(renderer), 'the resolved handle is stored')
  assert.ok(/const handle = await S\.show\(/.test(renderer), 'show() is awaited for its handle')

  // Called before a second room opens…
  const body = renderer.slice(renderer.indexOf('async function renderSoulseekExplore'), renderer.indexOf('async function renderSoulseekExplore') + 2500)
  assert.ok(body.indexOf('_closeSlskRoom()') >= 0 && body.indexOf('_closeSlskRoom()') < body.indexOf('const handle = await S.show('))

  // …and on the navigate() teardown path, right beside the page-state reset.
  const nav = renderer.slice(renderer.indexOf("state.currentSlskExploreUser = page === 'soulseek-explore'"))
  assert.ok(/_closeSlskRoom\(\)/.test(nav.slice(0, 700)), 'navigate() closes the room')
})
