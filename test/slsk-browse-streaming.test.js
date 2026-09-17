'use strict'
// createTreeBuilder: the renderer half of un-freezing a big peer's open.
//
// The freeze on opening a large share is not in the shelf modules. Measured over
// the captured real payloads and scaled copies of them, the tree/album/shelf
// builders cost tens of milliseconds and are already time-sliced; what costs
// seconds is `slsk-browse-user` handing the WHOLE directory listing back through
// one ipcRenderer.invoke, so the listing crosses the process boundary by
// structured clone in a single uninterruptible step on each side. On a
// 485,000-file payload (114 MB) that measured 594 ms to serialise in main plus
// 1,208 ms to deserialise in the renderer — 1.8 s of dead UI, behind a static
// "Loading…", with no way to cancel.
//
// Chunking that transfer needs a tree builder that can be fed the listing a
// slice at a time. These tests hold that builder to the only bar that matters:
// the tree it produces must be indistinguishable from the one buildTree()
// produces over the whole listing at once, no matter where the slice boundaries
// fall.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const T = require('../src/slsk-tree')
const C = require('./helpers/slsk-corpus')

const share = C.buildShare({ albums: 1200, artists: 200 })

function flatten(root) {
	const out = []
	const walk = (n) => {
		out.push([n.path, n.name, n.fileCount, n.totalSize, n.dirs.size,
			n.files.map(f => `${f.name}|${f.fullPath}|${f.size || 0}`).join(';')])
		for (const c of n.dirs.values()) walk(c)
	}
	walk(root)
	return out
}

function slices(arr, n) {
	const out = []
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
	return out
}

test('a streamed tree is identical to a one-shot tree, at every slice size', () => {
	const whole = flatten(T.buildTree(share.dirs))
	for (const size of [1, 2, 7, 100, 400, 999999]) {
		const tb = S.createTreeBuilder()
		for (const s of slices(share.dirs, size)) tb.add(s)
		assert.deepStrictEqual(flatten(tb.finish()), whole, `slice size ${size} produced a different tree`)
	}
})

test('a folder whose files arrive in two different slices ends up whole', () => {
	// The real hazard of slicing. slskd can return one directory as several
	// entries, and a naive builder that treats a slice as a self-contained unit
	// would leave half the album behind.
	const dirs = [
		{ name: 'Music\\Artist\\Album', files: [{ filename: '01.flac', size: 10 }, { filename: '02.flac', size: 20 }] },
		{ name: 'Music\\Artist\\Album', files: [{ filename: '03.flac', size: 30 }] },
		{ name: 'Music\\Artist\\Album\\CD2', files: [{ filename: '04.flac', size: 40 }] },
	]
	const whole = flatten(T.buildTree(dirs))
	for (const size of [1, 2, 3]) {
		const tb = S.createTreeBuilder()
		for (const s of slices(dirs, size)) tb.add(s)
		const tree = tb.finish()
		assert.deepStrictEqual(flatten(tree), whole, `slice size ${size}`)
		assert.strictEqual(tree.fileCount, 4)
		assert.strictEqual(tree.totalSize, 100)
		assert.strictEqual(S.extractAlbums(tree).length, 1, 'the split album must still be ONE album')
	}
})

test('case-duplicate folders still merge across a slice boundary', () => {
	// Windows paths are case-insensitive and peers really do share both
	// spellings; the tree keys folders lowercased because of it. Splitting the
	// two spellings into different slices must not split the album in two.
	const dirs = [
		{ name: 'Dark The Suns\\Album', files: [{ filename: '01.flac', size: 1 }] },
		{ name: 'Dark the Suns\\Album', files: [{ filename: '02.flac', size: 2 }] },
	]
	const tb = S.createTreeBuilder()
	tb.add([dirs[0]])
	tb.add([dirs[1]])
	const tree = tb.finish()
	assert.deepStrictEqual(flatten(tree), flatten(T.buildTree(dirs)))
	assert.strictEqual(tree.dirs.size, 1, 'the two spellings must be one folder')
	assert.strictEqual(tree.fileCount, 2)
})

test('the builder reports honest progress without walking anything', () => {
	const tb = S.createTreeBuilder()
	let dirs = 0, files = 0
	for (const s of slices(share.dirs, 250)) {
		tb.add(s)
		dirs += s.length
		for (const d of s) files += (d.files || []).length
		assert.strictEqual(tb.dirCount, dirs)
		assert.strictEqual(tb.fileCount, files)
	}
	assert.strictEqual(tb.dirCount, share.dirs.length)
	assert.strictEqual(tb.finish().fileCount, files)
})

test('finish() is idempotent, and a slice arriving after it is ignored', () => {
	// A cancelled open can have a slice in flight. It must not double-count the
	// rolled-up sizes of a tree the UI is already rendering.
	const tb = S.createTreeBuilder()
	tb.add(share.dirs)
	const first = tb.finish()
	const snapshot = flatten(first)
	assert.strictEqual(tb.finished, true)
	const second = tb.finish()
	assert.strictEqual(second, first, 'finish() must return the same tree, not rebuild')
	// The load-bearing half. _treeRoll recomputes from scratch rather than
	// accumulating, so calling it twice is harmless by itself — mutation-checked,
	// and removing the finish() guard alone changes nothing. What DOES matter is
	// that a slice arriving after finish() cannot reach the tree: it would add
	// files the rolled-up counts know nothing about, in a tree the UI is already
	// rendering. Deleting the `if (done)` guard in add() turns this red.
	tb.add([{ name: 'Late\\Folder', files: [{ filename: 'x.flac', size: 99 }] }])
	assert.deepStrictEqual(flatten(tb.finish()), snapshot, 'a late slice must be ignored')
})

test('an empty or absent slice is harmless', () => {
	const tb = S.createTreeBuilder()
	tb.add([])
	tb.add(null)
	tb.add(undefined)
	tb.add(share.dirs)
	tb.add([])
	assert.deepStrictEqual(flatten(tb.finish()), flatten(T.buildTree(share.dirs)))
	const empty = S.createTreeBuilder()
	assert.strictEqual(empty.finish().fileCount, 0)
	assert.strictEqual(S.extractAlbums(empty.finish()).length, 0)
})

test('the streamed tree drives the rest of the shop identically', () => {
	// The builder is only useful if everything downstream cannot tell. Run the
	// full open path off a streamed tree and off a one-shot tree and compare.
	const library = C.buildLibrary({ count: 300 })
	const tb = S.createTreeBuilder()
	for (const s of slices(share.dirs, 137)) tb.add(s)
	const streamed = tb.finish()
	const oneShot = T.buildTree(share.dirs)

	const a = S.extractAlbums(streamed)
	const b = S.extractAlbums(oneShot)
	assert.deepStrictEqual(a.map(x => `${x.artist}|${x.album}|${x.folderPath}|${x.trackCount}|${x.totalSize}`),
		b.map(x => `${x.artist}|${x.album}|${x.folderPath}|${x.trackCount}|${x.totalSize}`))

	const sa = S.buildShelves(a, library, {})
	const sb = S.buildShelves(b, library, {})
	assert.deepStrictEqual(sa.stats, sb.stats)
	for (const shelf of ['upgrades', 'missing', 'hires', 'everything']) {
		assert.deepStrictEqual(sa[shelf].map(x => x.folderPath), sb[shelf].map(x => x.folderPath), shelf)
	}
	for (const q of ['the', 'flac', 'cd1']) {
		assert.deepStrictEqual(
			T.searchTree(streamed, q, 300).map(r => `${r.type}|${r.path}|${r.name}`),
			T.searchTree(oneShot, q, 300).map(r => `${r.type}|${r.path}|${r.name}`), q)
	}
	for (const p of ['', 'Music', 'Everything']) {
		const l1 = T.listDir(streamed, p, { sort: 'name' })
		const l2 = T.listDir(oneShot, p, { sort: 'name' })
		assert.deepStrictEqual(l1 && l1.dirs.map(d => d.path), l2 && l2.dirs.map(d => d.path), p)
	}
})

test('the streaming builder agrees with the chunked builder too', async () => {
	const tb = S.createTreeBuilder()
	for (const s of slices(share.dirs, 300)) tb.add(s)
	const chunked = await S.buildTreeChunked(share.dirs, { budgetMs: 2 })
	assert.deepStrictEqual(flatten(tb.finish()), flatten(chunked))
})
