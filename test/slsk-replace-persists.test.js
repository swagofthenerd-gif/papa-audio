'use strict'
// "Replace and remove the old versions don't work when I try to upgrade."
//
// Three separate faults, all of them real:
//
// 1. The Listening Room never sent replaceLibId. Only the old shop did, and the
//    room replaced the shop as the default library view — so downloading an
//    upgrade left both copies on disk and nothing ever asked about the old one.
// 2. "Grab all N upgrades" called _mgConfirm object-style and then .then() on
//    the result. _mgConfirm is positional and returns undefined, so that button
//    threw on every click and downloaded nothing at all.
// 3. The offer was a 15-second snackbar and nothing else. Miss it, or close the
//    app before answering, and the question was gone for good while the old
//    copy stayed.
//
// Nothing here deletes on its own: a pending entry is only ever cleared by him
// answering it, and the answer and the trashing happen in the same step.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const ROOM = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-room-ui.js'), 'utf8')
const DOSSIER = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-dossier.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

// Lift the real _replacePending out of main.js and give it a store and an fs.
function liftPending(verdicts, onDisk) {
  const start = MAIN.indexOf('function _replacePending()')
  const src = MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 3)
  const sb = {
    sideStores: { slskVerify: { get: () => verdicts } },
    fs: { existsSync: (p) => onDisk.includes(p) },
  }
  vm.runInNewContext(src + '\nthis.f = _replacePending', sb)
  // Call it, and bring the result back across the realm boundary: objects made
  // inside the vm carry the vm's own prototypes, which deepStrictEqual rejects.
  return JSON.parse(JSON.stringify(sb.f()))
}

const rec = (over) => ({
  username: 'peer', folder: 'Camel - Mirage', at: 100,
  replace: { ok: true, artist: 'Camel', album: 'Mirage', newCount: 3, oldCount: 3,
    oldPaths: ['/m/1.flac', '/m/2.flac'], ...over },
})

test('a verified replacement whose old files are still there is still pending', () => {
  const out = liftPending({ k1: rec() }, ['/m/1.flac', '/m/2.flac'])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].key, 'k1')
  assert.strictEqual(out[0].album, 'Mirage')
  assert.deepStrictEqual(out[0].oldPaths, ['/m/1.flac', '/m/2.flac'])
})

test('it survives a restart — the question is read back from the store, not from a snackbar', () => {
  // Same store contents, a fresh process: the entry is still there. This is
  // the whole point; the old flow held the offer only in a live snackbar.
  const store = { k1: rec() }
  assert.strictEqual(liftPending(store, ['/m/1.flac', '/m/2.flac']).length, 1)
  assert.strictEqual(liftPending(store, ['/m/1.flac', '/m/2.flac']).length, 1)
})

test('an answered replacement never asks again', () => {
  for (const how of ['trash', 'keep']) {
    const out = liftPending({ k1: rec({ resolved: how }) }, ['/m/1.flac', '/m/2.flac'])
    assert.strictEqual(out.length, 0, how + ' is an answer')
  }
})

test('a replacement that did not verify is never offered', () => {
  const out = liftPending({ k1: rec({ ok: false, reason: 'counts differ' }) }, ['/m/1.flac'])
  assert.strictEqual(out.length, 0)
})

test('old files already gone means there is nothing to ask about', () => {
  assert.strictEqual(liftPending({ k1: rec() }, []).length, 0)
  // Partly gone: only what is really on disk is offered.
  const out = liftPending({ k1: rec() }, ['/m/2.flac'])
  assert.deepStrictEqual(out[0].oldPaths, ['/m/2.flac'])
})

test('a store that cannot be read yields no pending work rather than throwing', () => {
  const start = MAIN.indexOf('function _replacePending()')
  const src = MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 3)
  const sb = { sideStores: { slskVerify: { get: () => { throw new Error('corrupt') } } }, fs: { existsSync: () => true } }
  vm.runInNewContext(src + '\nthis.f = _replacePending', sb)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.f())), [])
})

test('newest first, so the one he just finished is at the top', () => {
  const out = liftPending({
    old: { ...rec(), at: 1 },
    fresh: { ...rec(), at: 999 },
  }, ['/m/1.flac', '/m/2.flac'])
  assert.deepStrictEqual(out.map(e => e.key), ['fresh', 'old'])
})

// ── The wiring the lifted function cannot see ───────────────────────────────

test('the Listening Room names the copy an upgrade would replace', () => {
  assert.ok(/function itemsFor\(a\)/.test(ROOM), 'one helper builds every download item')
  assert.ok(/replaceLibId: String\(a\.matchedLibId\)/.test(ROOM))
  // Both bulk paths go through it — selected rows and Grab all upgrades.
  assert.ok(ROOM.includes('picked.flatMap(itemsFor)'))
  assert.ok(ROOM.includes('shelves.upgrades.flatMap(itemsFor)'))
  // And the dossier's own Download button.
  assert.ok(/replaceLibId: String\(album\.matchedLibId\)/.test(DOSSIER))
})

test('an album he does not already own carries no replace id', () => {
  // itemsFor is inside show(); run the shipped text of it directly.
  const start = ROOM.indexOf('    function itemsFor(a) {')
  const src = ROOM.slice(start, ROOM.indexOf('\n    }', start) + 6)
  const sb = { username: 'peer', T: () => ({ AUDIO_RE: /\.flac$/i }) }
  vm.runInNewContext(src + '\nthis.f = itemsFor', sb)
  const files = [{ name: 'a.flac', fullPath: 'p/a.flac', size: 1 }]
  assert.strictEqual(sb.f({ files }).length, 1)
  assert.strictEqual(sb.f({ files })[0].replaceLibId, undefined, 'nothing to replace')
  assert.strictEqual(sb.f({ files, matchedLibId: 'lib7' })[0].replaceLibId, 'lib7')
  assert.strictEqual(sb.f(null).length, 0, 'no album, no items')
})

test('Grab all upgrades calls the confirm the way the confirm actually works', () => {
  // _mgConfirm(title, bodyHtml, confirmLabel, onConfirm) — positional, and it
  // returns nothing. The old object-style call with .then() threw every time.
  assert.ok(!/_mgConfirm\(\{/.test(ROOM), 'no object-style call survives')
  assert.ok(!/_mgConfirm\([^)]*\)\.then\(/.test(ROOM), 'and nothing awaits a return value')
  const at = ROOM.indexOf('deps._mgConfirm(')
  assert.ok(at > 0, 'the confirm is still there')
  assert.match(ROOM.slice(at, at + 400), /'Download',\s*\n\s*go/, 'the action is passed as the callback')
  assert.ok(!/_mgConfirm\(\{/.test(RENDERER), 'and the renderer does not do it either')
})

test('both answers are exposed to the renderer and gated in main', () => {
  assert.ok(/slskReplacePending: \(\)  => ipcRenderer\.invoke\('slsk-replace-pending'\)/.test(PRELOAD))
  assert.ok(/slskReplaceResolve: \(p\) => ipcRenderer\.invoke\('slsk-replace-resolve', p\)/.test(PRELOAD))
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-replace-resolve'"))
  const body = h.slice(0, h.indexOf('\n})\n') + 4)
  assert.ok(body.includes('_dryRunRefusal'), 'a dry-run twin never answers for him')
  assert.ok(body.indexOf('_dryRunRefusal') < body.indexOf('_trashPathsGuarded'),
    'and it is refused before anything is trashed')
  assert.match(body, /action !== 'trash' && action !== 'keep'/, 'only the two real answers')
  assert.ok(body.includes("_replaceMarkResolved(key, 'trash')"), 'trashing records the answer')
  assert.ok(body.includes("_replaceMarkResolved(key, 'keep')"), 'so does keeping both')
})

test('the answer is written even when some files refused to move', () => {
  // Otherwise a part-failed trash re-asks the same question for ever.
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-replace-resolve'"))
  const body = h.slice(0, h.indexOf('\n})\n') + 4)
  const mark = body.indexOf("_replaceMarkResolved(key, 'trash')")
  const ret = body.indexOf('return { ok: out.failed === 0')
  assert.ok(mark > 0 && ret > mark, 'the answer is recorded before the result is reported')
})

test('the Downloads page carries the durable question', () => {
  assert.ok(RENDERER.includes('id="dl-replace-section"'), 'a section exists')
  assert.ok(RENDERER.includes('id="dl-replace-body"'))
  assert.ok(/async function _renderPendingReplacements\(\)/.test(RENDERER))
  assert.ok(RENDERER.includes('Move old copy to Trash') && RENDERER.includes('Keep both'),
    'both answers are spelled out as buttons')
  assert.match(RENDERER, /Nothing is deleted until you say so/, 'and the page says so')
  // Repainted when a verification lands and when the page is drawn.
  const bind = RENDERER.slice(RENDERER.indexOf('if (rec.replace) _offerUpgradeReplace(rec)'))
  assert.match(bind.slice(0, 200), /_renderPendingReplacements\(\)/)
})
