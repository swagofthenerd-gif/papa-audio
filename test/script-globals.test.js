const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')

function scriptsInOrder() {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
  return [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(f => !f.startsWith('http'))
}

// Every one of these loads as a classic script into ONE shared global scope.
// A top-level `const`/`let` that another file already declared is a SyntaxError
// that kills the whole file — and the only symptom is a console message nobody
// reads. This is exactly how download-spread.js silently never loaded, which
// meant album downloads never spread across peers.
test('no two scripts declare the same top-level const/let', () => {
  const owner = new Map()
  const collisions = []
  for (const file of scriptsInOrder()) {
    let src
    try { src = fs.readFileSync(path.join(SRC, file), 'utf8') } catch (_) { continue }
    const names = new Set()
    for (const m of src.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
    for (const n of names) {
      if (owner.has(n)) collisions.push(`${n}: ${owner.get(n)} vs ${file}`)
      else owner.set(n, file)
    }
  }
  assert.deepEqual(collisions, [], 'top-level const/let collisions make a whole file fail to parse')
})

test('every renderer module actually publishes its global', () => {
  // A module that parses but forgets its window export is just as broken.
  const expected = {
    'library-sig.js': 'PapaLibrarySig',
    'queue-repair.js': 'PapaQueueRepair',
    'load-error-policy.js': 'PapaLoadError',
    'local-store.js': 'PapaLocal',
    'library-prune.js': 'PapaLibraryPrune',
    'ctx-menu-model.js': 'PapaCtxMenu',
    'multi-select.js': 'PapaMultiSelect',
    'library-health.js': 'PapaLibraryHealth',
    'library-manage.js': 'PapaLibraryManage',
    'download-spread.js': 'PapaSpread',
    'slsk-tree.js': 'PapaSlskTree',
    'saved-users.js': 'PapaSavedUsers',
    'slsk-presence.js': 'PapaSlskPresence',
  }
  const loaded = scriptsInOrder()
  for (const [file, global] of Object.entries(expected)) {
    assert.ok(loaded.includes(file), `${file} must be loaded by index.html`)
    const src = fs.readFileSync(path.join(SRC, file), 'utf8')
    assert.match(src, new RegExp('window\\.' + global + '\\s*='), `${file} must set window.${global}`)
  }
})

test('each renderer module executes cleanly in a browser-like scope', () => {
  // Catches load-time throws that node --check cannot see.
  const vm = require('node:vm')
  const ctx = { window: {}, console, module: undefined }
  vm.createContext(ctx)
  for (const file of scriptsInOrder()) {
    if (file === 'renderer.js' || file === 'player-shim.js') continue  // need real DOM
    const src = fs.readFileSync(path.join(SRC, file), 'utf8')
    assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: file }),
      `${file} threw while loading into the shared scope`)
  }
  assert.ok(ctx.window.PapaSpread, 'PapaSpread must survive loading alongside its neighbours')
  assert.ok(ctx.window.PapaLibraryHealth, 'PapaLibraryHealth must survive too')
})

// A top-level `function` collision is quieter than a const/let one: it does not
// throw, the later file just silently overwrites the earlier binding. That is
// how slsk-filters.js's isLossless(group) replaced format-badges.js's
// isLossless(codec), making formatBadges() tag EVERY lossless file "LOSSY".
// `var` was the gap: this guarded const/let (which throw) and function (which
// silently overwrites), but not var — and eight files each declared a top-level
// `var API`, so every later file overwrote the earlier binding. Latent only
// because each file read it on the very next line.
test('no two scripts declare the same top-level var', () => {
  const owner = new Map()
  const collisions = []
  for (const file of scriptsInOrder()) {
    let src
    try { src = fs.readFileSync(path.join(SRC, file), 'utf8') } catch (_) { continue }
    const names = new Set()
    for (const m of src.matchAll(/^var\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
    for (const n of names) {
      if (owner.has(n)) collisions.push(`${n}: ${owner.get(n)} vs ${file}`)
      else owner.set(n, file)
    }
  }
  assert.deepEqual(collisions, [],
    'a later file silently overwrites the earlier binding, with no error anywhere')
})

test('no two scripts declare the same top-level function', () => {
  const owner = new Map()
  const collisions = []
  for (const file of scriptsInOrder()) {
    let src
    try { src = fs.readFileSync(path.join(SRC, file), 'utf8') } catch (_) { continue }
    const names = new Set()
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
    for (const n of names) {
      if (owner.has(n)) collisions.push(`${n}: ${owner.get(n)} vs ${file}`)
      else owner.set(n, file)
    }
  }
  assert.deepEqual(collisions, [],
    'a later file silently overwrites the earlier binding, with no error anywhere')
})
