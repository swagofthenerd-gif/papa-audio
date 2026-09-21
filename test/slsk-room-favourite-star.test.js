'use strict'
// The Listening Room shipped with no way to favourite a peer.
//
// The old shop (slsk-shop-ui.js) carried a ☆ in its header — "Save this
// library" — wired to slsk-save-user. When the Listening Room replaced the
// shop as the default library view, the button did not come across. Nothing
// else moved: the main-process handlers (slsk-save-user / slsk-unsave-user /
// slsk-touch-user), the saved-user presence poll, and the "Saved libraries"
// list all kept working. There was simply no longer any way to put a peer on
// the list, so for anyone on the new view the whole feature was unreachable —
// and slsk-touch-user lost its only caller, so saved entries' file counts
// could never be refreshed either.
//
// These tests run the SHIPPED text of the star's three functions against the
// REAL saved-users store, so a paraphrase of the fix cannot pass them.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-room-ui.js'), 'utf8')
const savedUsers = require('../src/saved-users.js')
const roomApi = require('../src/slsk-room-ui.js')
const treeApi = require('../src/slsk-tree.js')

// Lift the star's closure functions out of show() and give them their closure
// variables as vm globals. They are contiguous in the source; the map below
// pins both ends so a future edit that moves them fails loudly here rather
// than silently testing nothing.
function liftStar() {
  const from = SRC.indexOf('    function isSavedNow()')
  const to = SRC.indexOf('    const albumsByPath = new Map()')
  assert.ok(from > 0, 'isSavedNow is defined in show()')
  assert.ok(to > from, 'the star block sits above albumsByPath')
  const body = SRC.slice(from, to)
  assert.ok(body.includes('function paintStar()'), 'paintStar was lifted')
  assert.ok(body.includes('async function toggleSaved()'), 'toggleSaved was lifted')
  return body
}

// A button stand-in that records what the painter did to it.
function fakeButton() {
  return {
    textContent: '', title: '', attrs: {}, classes: new Set(),
    setAttribute(k, v) { this.attrs[k] = v },
    classList: { toggle(c, on) { on ? this.owner.classes.add(c) : this.owner.classes.delete(c) } },
  }
}

// The store as the main process actually keeps it: one array, mutated only by
// the real saved-users helpers, handed back to the renderer on every write.
function harness(opts) {
  opts = opts || {}
  const btn = fakeButton()
  btn.classList.owner = btn
  const calls = []
  const snacks = []
  let store = opts.store || []
  const ctx = {
    username: 'RipMaster',
    savedList: opts.savedList || [],
    dead: false,
    tree: opts.tree !== undefined ? opts.tree : treeApi.buildTree([
      { name: 'Music\\Pink Floyd\\Animals', files: [{ filename: 'a.flac', size: 1 }] },
      { name: 'Music\\Rush\\Hemispheres', files: [{ filename: 'b.flac', size: 1 }] },
    ]),
    headEl: { querySelector: sel => (sel === '#slr-star' && !opts.noButton) ? btn : null },
    countDirs: roomApi.countDirs,
    deps: { showSnackbar: m => snacks.push(m) },
    window: {
      PapaSavedUsers: savedUsers,
      api: {
        slskSaveUser: async p => {
          calls.push(['save', p])
          if (opts.failWrites) throw new Error('ipc down')
          store = savedUsers.saveUser(store, p.username, { fileCount: p.fileCount, dirCount: p.dirCount })
          return store
        },
        slskUnsaveUser: async p => {
          calls.push(['unsave', p])
          if (opts.failWrites) throw new Error('ipc down')
          store = savedUsers.removeUser(store, p.username)
          return store
        },
      },
    },
  }
  vm.createContext(ctx)
  new vm.Script('let savedList = this.savedList;\n' + liftStar() +
    '\nthis.isSavedNow = isSavedNow; this.paintStar = paintStar; this.toggleSaved = toggleSaved;' +
    '\nthis.readSaved = () => savedList;').runInContext(ctx)
  return { ctx, btn, calls, snacks, store: () => store }
}

test('an unsaved peer shows a hollow star that offers to save them', () => {
  const h = harness()
  h.ctx.paintStar()
  assert.equal(h.btn.textContent, '☆')
  assert.equal(h.btn.attrs['aria-pressed'], 'false')
  assert.ok(!h.btn.classes.has('is-on'))
  assert.match(h.btn.attrs['aria-label'], /Save RipMaster/i)
})

test('clicking the star saves the peer, through the real store', async () => {
  const h = harness()
  h.ctx.paintStar()
  await h.ctx.toggleSaved()

  assert.deepEqual(h.calls.map(c => c[0]), ['save'])
  // The counts the Saved libraries list shows must ride along on the write.
  assert.equal(h.calls[0][1].fileCount, 2)
  assert.equal(h.calls[0][1].dirCount, 5, 'the whole share, not the root\'s one child')
  // The real store now holds them...
  assert.ok(savedUsers.isSaved(h.store(), 'RipMaster'))
  // ...and the button reflects the store, not the click.
  assert.equal(h.btn.textContent, '★')
  assert.equal(h.btn.attrs['aria-pressed'], 'true')
  assert.ok(h.btn.classes.has('is-on'))
  assert.match(h.snacks[0], /Saved RipMaster/i)
})

test('clicking a lit star removes them again', async () => {
  const seeded = savedUsers.saveUser([], 'RipMaster', {})
  const h = harness({ store: seeded, savedList: seeded })
  h.ctx.paintStar()
  assert.equal(h.btn.textContent, '★', 'starts lit')

  await h.ctx.toggleSaved()
  assert.deepEqual(h.calls.map(c => c[0]), ['unsave'])
  assert.ok(!savedUsers.isSaved(h.store(), 'RipMaster'))
  assert.equal(h.btn.textContent, '☆')
  assert.match(h.snacks[0], /Removed RipMaster/i)
})

test('a failed write leaves the star showing what is really saved', async () => {
  const h = harness({ failWrites: true })
  h.ctx.paintStar()
  await h.ctx.toggleSaved()
  // The click did not take, so the button must not claim it did.
  assert.equal(h.btn.textContent, '☆', 'the star does not light on a failed save')
  assert.ok(!h.ctx.isSavedNow())
  assert.match(h.snacks[0], /could not/i)
})

test('the star can be saved before the library has finished loading', async () => {
  // show() paints the header long before the browse completes, so tree is
  // still null. Reading tree.fileCount there would throw and eat the click.
  const h = harness({ tree: null })
  await h.ctx.toggleSaved()
  assert.equal(h.calls[0][1].fileCount, null)
  assert.ok(savedUsers.isSaved(h.store(), 'RipMaster'))
})

test('painting is a no-op before the header exists', () => {
  const h = harness({ noButton: true })
  h.ctx.paintStar()   // must not throw
})

// ── Wiring the lifted functions cannot see ──────────────────────────────────

test('the header emits the star and binds it exactly once', () => {
  assert.ok(SRC.includes('id="slr-star"'), 'the button is in the header markup')
  assert.ok(/headEl\.querySelector\('#slr-star'\)\.addEventListener\('click', toggleSaved\)/.test(SRC),
    'the star is bound to toggleSaved')
  // paintHead is the build-exactly-once function; binding anywhere else would
  // either double-bind or never bind.
  const head = SRC.slice(SRC.indexOf('function paintHead('), SRC.indexOf('function paintBody('))
  assert.ok(head.includes("#slr-star"), 'both the markup and the binding live in paintHead')
})

test('the saved list is fetched up front and repaints the star when it lands', () => {
  assert.ok(SRC.includes('window.api.slskSavedUsers()'), 'the saved list is read')
  assert.ok(/savedReady\.then\(list => \{ if \(dead\) return; savedList = list \|\| \[\]; paintStar\(\) \}\)/.test(SRC),
    'a late reply still lights the star')
})

test('visiting a saved library refreshes its counts', () => {
  // slsk-touch-user lost its only caller when the shop stopped being default.
  // Asserting the string alone would pass on the feature-detect guard with the
  // call itself deleted; require the call, and require it to keep its answer.
  assert.ok(/savedList = await window\.api\.slskTouchUser\(/.test(SRC),
    'the room touches the saved entry and keeps the refreshed list')
  const after = SRC.slice(SRC.indexOf('tree = first.tree'))
  assert.ok(after.indexOf('slskTouchUser') > 0 && after.indexOf('slskTouchUser') < 900,
    'the touch happens once the tree is known, so the counts are real')
})

test('the star has a lit style that survives light mode', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-room.css'), 'utf8')
  assert.ok(css.includes('.slr-star'), 'the star is styled')
  assert.ok(/\.slr-star\.is-on\{[^}]*--slr-hires/.test(css),
    'the lit colour is a token the light-mode block restates')
  assert.ok(/body\.theme-light \.slsk-room\{[^}]*--slr-hires/.test(css), 'that token is restated for paper')
})

// ── The folder count the entry is given ─────────────────────────────────────
// Measured on the twin against a real cached library: Christoperush's entry was
// written with dirCount 1 for 16,511 files, because buildTree hands back the
// ROOT NODE and its .dirs Map is only the top level.

const room = require('../src/slsk-room-ui.js')
const tree = require('../src/slsk-tree.js')

test('countDirs counts the whole share, not the root\'s children', () => {
  // One shared root, everything below it — the shape that produced dirCount 1.
  const t = tree.buildTree([
    { name: 'Music\\Pink Floyd\\Animals', files: [{ filename: 'a.flac', size: 1 }] },
    { name: 'Music\\Pink Floyd\\Meddle', files: [{ filename: 'b.flac', size: 1 }] },
    { name: 'Music\\Rush\\Hemispheres', files: [{ filename: 'c.flac', size: 1 }] },
  ])
  assert.equal(t.dirs.size, 1, 'the root really does hold only one child')
  // Music, Pink Floyd, Animals, Meddle, Rush, Hemispheres
  assert.equal(room.countDirs(t), 6)
})

test('countDirs survives a library deeper than the call stack', () => {
  // A recursive walker dies here; a peer with a deep path should not be able
  // to take the star down with them.
  const deep = { name: '', path: '', dirs: new Map(), files: [], fileCount: 0 }
  let node = deep
  for (let i = 0; i < 50000; i++) {
    const child = { name: 'd' + i, path: 'd' + i, dirs: new Map(), files: [], fileCount: 0 }
    node.dirs.set('d' + i, child)
    node = child
  }
  assert.equal(room.countDirs(deep), 50000)
})

test('countDirs says nothing when there is no tree yet', () => {
  assert.equal(room.countDirs(null), null)
  assert.equal(room.countDirs({}), null)
})

test('both saved-library writes use the real count', () => {
  assert.ok(!/dirCount: tree\.dirs\.size/.test(SRC), 'the root-children count is gone')
  assert.ok(!/dirCount: tree \? tree\.dirs\.size : null/.test(SRC))
  const writes = SRC.match(/dirCount: countDirs\(tree\)/g) || []
  assert.equal(writes.length, 2, 'the save and the touch both count properly')
})
