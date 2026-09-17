'use strict'
// The safety net for the record-shop speed-up.
//
// Every optimisation in src/slsk-shelves.js and src/slsk-tree.js is supposed to
// change how fast the code runs and NOTHING about what it returns. That is an
// easy thing to claim and a hard thing to be sure of, because the inputs are a
// swamp: scene release names, disc subfolders, non-Latin titles, slskd share
// aliases, case-duplicate folders, loose tracks with no album folder.
//
// So: test/fixtures/frozen/ holds a byte-for-byte copy of both modules as they
// stood before the speed-up, and this file runs the frozen pair and the live
// pair over the same large randomised corpus (≈64,000 files, 5,000 albums, 800
// artists) and asserts deep equality of every exported result. If a refactor
// moves a single field, reorders a single array or rounds a single number
// differently, this goes red.
//
// The one place the two are ALLOWED to differ is the artist string when a path
// carries slskd's anonymised share-alias segment ("@@aeylt\…"), which the live
// parser now recognises and the frozen one did not. That difference is asserted
// explicitly and narrowly below (see "share-alias"), so it cannot be used as
// cover for an accidental change anywhere else.
const test = require('node:test')
const assert = require('node:assert')

const LIVE_SH = require('../src/slsk-shelves')
const LIVE_TREE = require('../src/slsk-tree')
const OLD_SH = require('./fixtures/frozen/slsk-shelves-frozen')
const OLD_TREE = require('./fixtures/frozen/slsk-tree-frozen')
const C = require('./helpers/slsk-corpus')

// ── The corpus, built once for the whole file ────────────────────────────────
const share = C.buildShare({})
const library = C.buildLibrary({ count: 2000 })
const groups = C.buildSearchGroups({})

// A tree node holds Maps and cyclic-free children; deepStrictEqual copes, but
// comparing the raw node is slow and unreadable when it fails. This flattens a
// tree to a sorted list of plain rows instead — same information, and a failure
// names the exact folder.
function flattenTree(root) {
	const out = []
	const walk = (n) => {
		out.push([n.path, n.name, n.fileCount, n.totalSize, n.dirs.size,
			n.files.map(f => `${f.name}|${f.fullPath}|${f.size || 0}`).join(';')])
		for (const c of n.dirs.values()) walk(c)
	}
	walk(root)
	return out
}

// Albums carry their whole file list; comparing that in full is the point, but
// a failure printing 60,000 files is useless. Compare the rolled-up identity
// plus a digest of the file list.
function albumRow(a) {
	return [
		a.artist, a.album, a.year, a.folderName, a.folderPath, a.trackCount,
		a.totalSize, a.losslessCount, a.lossless, a.isHiRes, a.maxBitDepth,
		a.maxSampleRate, a.topExt,
		a.files.map(f => `${f.name}|${f.size || 0}|${f.bitDepth || 0}|${f.sampleRate || 0}`).join(';'),
	]
}

// The alias-artist fix is the ONE intended behaviour change. Rows whose frozen
// artist is an "@@alias" are compared on every field except the artist, and the
// artist difference is asserted separately.
function isAliasArtist(s) { return /^@@/.test(String(s || '')) }

test('buildTree: live and frozen build the identical tree over a 64k-file share', () => {
	const live = LIVE_TREE.buildTree(share.dirs)
	const old = OLD_TREE.buildTree(share.dirs)
	assert.deepStrictEqual(flattenTree(live), flattenTree(old))
})

const liveTree = LIVE_TREE.buildTree(share.dirs)
const oldTree = OLD_TREE.buildTree(share.dirs)

test('listDir: every folder in the share lists identically, in every sort order', () => {
	const paths = []
	const collect = (n) => { paths.push(n.path); for (const c of n.dirs.values()) collect(c) }
	collect(oldTree)
	assert.ok(paths.length > 2000, `expected a big share, got ${paths.length} folders`)
	const shape = (r) => r && ({
		path: r.path, parent: r.parent,
		dirs: r.dirs.map(d => `${d.path}|${d.fileCount}|${d.totalSize}|${d.subdirCount}`),
		files: r.files.map(f => `${f.name}|${f.fullPath}|${f.size || 0}`),
	})
	for (const sort of ['name', 'size', 'type']) {
		for (const audioOnly of [false, true]) {
			for (const p of paths) {
				assert.deepStrictEqual(
					shape(LIVE_TREE.listDir(liveTree, p, { sort, audioOnly })),
					shape(OLD_TREE.listDir(oldTree, p, { sort, audioOnly })),
					`listDir mismatch at "${p}" sort=${sort} audioOnly=${audioOnly}`)
			}
		}
	}
})

test('listDir: an unknown path is still null, and the root still lists', () => {
	assert.strictEqual(LIVE_TREE.listDir(liveTree, 'no\\such\\folder'), null)
	assert.strictEqual(OLD_TREE.listDir(oldTree, 'no\\such\\folder'), null)
	assert.deepStrictEqual(
		LIVE_TREE.listDir(liveTree, '').dirs.map(d => d.path),
		OLD_TREE.listDir(oldTree, '').dirs.map(d => d.path))
})

test('searchTree: identical hits, identical order, identical limit behaviour', () => {
	for (const q of ['the', 'a', 'flac', 'cd1', '@@', 'Аквариум', '坂本', 'zzqqxx', '', '  ']) {
		for (const limit of [5, 300, 10000]) {
			const l = LIVE_TREE.searchTree(liveTree, q, limit)
			const o = OLD_TREE.searchTree(oldTree, q, limit)
			assert.deepStrictEqual(
				l.map(r => `${r.type}|${r.name}|${r.path}|${r.fileCount || ''}|${(r.file && r.file.fullPath) || ''}`),
				o.map(r => `${r.type}|${r.name}|${r.path}|${r.fileCount || ''}|${(r.file && r.file.fullPath) || ''}`),
				`searchTree mismatch for q="${q}" limit=${limit}`)
		}
	}
})

test('getNode / parentPath / breadcrumbs are unchanged', () => {
	const paths = []
	const collect = (n) => { paths.push(n.path); for (const c of n.dirs.values()) collect(c) }
	collect(oldTree)
	for (const p of paths.slice(0, 3000)) {
		assert.strictEqual(LIVE_TREE.parentPath(p), OLD_TREE.parentPath(p))
		assert.deepStrictEqual(LIVE_TREE.breadcrumbs(p), OLD_TREE.breadcrumbs(p))
		assert.strictEqual(!!LIVE_TREE.getNode(liveTree, p), !!OLD_TREE.getNode(oldTree, p))
	}
})

// ── slsk-shelves ─────────────────────────────────────────────────────────────

const liveAlbums = LIVE_SH.extractAlbums(liveTree)
const oldAlbums = OLD_SH.extractAlbums(oldTree)

test('extractAlbums: the same albums, in the same order, with the same files', () => {
	assert.strictEqual(liveAlbums.length, oldAlbums.length)
	assert.ok(liveAlbums.length > 4000, `expected ~5k albums, got ${liveAlbums.length}`)
	let aliasFixed = 0
	for (let i = 0; i < oldAlbums.length; i++) {
		const l = albumRow(liveAlbums[i])
		const o = albumRow(oldAlbums[i])
		if (isAliasArtist(oldAlbums[i].artist)) {
			// The one intended difference: field 0 (artist) only.
			aliasFixed++
			assert.deepStrictEqual(l.slice(1), o.slice(1),
				`alias album differed in more than the artist at index ${i}`)
			continue
		}
		assert.deepStrictEqual(l, o, `album ${i} ("${o[4]}") differed`)
	}
	// The corpus is built to contain these; if it stops containing them the
	// alias carve-out above has quietly stopped being tested.
	assert.ok(aliasFixed > 50, `expected the corpus to carry @@alias albums, saw ${aliasFixed}`)
})

test('share-alias: the ONE intended change is that "@@aeylt" stops being an artist', () => {
	let seen = 0
	for (let i = 0; i < oldAlbums.length; i++) {
		if (!isAliasArtist(oldAlbums[i].artist)) continue
		seen++
		assert.ok(!isAliasArtist(liveAlbums[i].artist),
			`live parser still reports an alias artist: ${liveAlbums[i].artist}`)
	}
	assert.ok(seen > 50)
	// And the live parser never INVENTS an alias artist where the frozen one
	// had a real one.
	for (let i = 0; i < liveAlbums.length; i++) {
		assert.ok(!isAliasArtist(liveAlbums[i].artist),
			`album ${i} still has an alias artist`)
	}
})

test('parseAlbumFolder: identical on every path in the share bar the alias fix', () => {
	for (const d of share.dirs) {
		const segs = d.name.split('\\').filter(Boolean)
		const l = LIVE_SH.parseAlbumFolder(segs)
		const o = OLD_SH.parseAlbumFolder(segs)
		assert.strictEqual(l.album, o.album, `album differed for ${d.name}`)
		assert.strictEqual(l.year, o.year, `year differed for ${d.name}`)
		if (isAliasArtist(o.artist)) assert.ok(!isAliasArtist(l.artist))
		else assert.strictEqual(l.artist, o.artist, `artist differed for ${d.name}`)
	}
})

// Everything below this line feeds BOTH implementations the same album list —
// the live one, whose artists already carry the alias fix. The alias change is
// proved separately above; factoring it out here means any difference that
// remains is purely algorithmic, which is what these tests are for. (Feeding
// each module its own albums would let a real regression hide behind "oh, the
// artists differ".)

test('buildShelves: identical shelves against a 2,000-album library', () => {
	const surround = (s) => /5\.?1|multichannel|surround|atmos/i.test(s)
	for (const det of [null, surround]) {
		const l = LIVE_SH.buildShelves(liveAlbums, library, { detectSurround: det })
		const o = OLD_SH.buildShelves(liveAlbums, library, { detectSurround: det })
		assert.deepStrictEqual(l.stats, o.stats)
		for (const shelf of ['upgrades', 'missing', 'surround', 'hires', 'everything']) {
			assert.strictEqual(l[shelf].length, o[shelf].length, `${shelf} length`)
			assert.deepStrictEqual(
				l[shelf].map(a => a.folderPath), o[shelf].map(a => a.folderPath),
				`${shelf} membership/order differed`)
		}
		assert.deepStrictEqual(
			l.upgrades.map(a => `${a.upgrade.kind}|${a.upgrade.yours}|${a.upgrade.theirs}|${a.matchedLibId}`),
			o.upgrades.map(a => `${a.upgrade.kind}|${a.upgrade.yours}|${a.upgrade.theirs}|${a.matchedLibId}`))
	}
})

test('buildLibraryIndex.findMatch: the same library album for every peer album', () => {
	// This is the one the prefix filter could silently break: the bucketed
	// finder must return the SAME first-in-library-order match a full scan
	// would, for every single peer album, not just "a" match.
	const li = LIVE_SH.buildLibraryIndex(library)
	const oi = OLD_SH.buildLibraryIndex(library)
	let matched = 0
	for (const pa of liveAlbums) {
		const q = { artist: pa.artist, album: pa.album, lossless: pa.lossless }
		const l = li.findMatch(LIVE_SH.albumComparable(q))
		const o = oi.findMatch(OLD_SH.albumComparable(q))
		assert.strictEqual(l ? l.ref.id : null, o ? o.ref.id : null,
			`findMatch differed for "${pa.artist} — ${pa.album}"`)
		if (o) matched++
	}
	assert.ok(matched > 0, 'the corpus produced no library matches at all; it is not testing the matcher')
})

test('buildLibraryIndex: a library built FROM the share still matches identically', () => {
	// The corpus above deliberately shares little with the library, so most
	// lookups miss. Feed the matcher a library made of the peer's own albums so
	// almost every lookup HITS, and the first-match-wins ordering is exercised.
	const owned = liveAlbums.slice(0, 1500).map((a, i) => ({
		id: `own${i}`, name: a.album, artist: a.artist,
		maxBitsPerSample: a.maxBitDepth, maxSampleRate: a.maxSampleRate,
		tracks: [{ filePath: `/x/${i}.${a.lossless ? 'flac' : 'mp3'}` }],
	}))
	const li = LIVE_SH.buildLibraryIndex(owned)
	const oi = OLD_SH.buildLibraryIndex(owned)
	let hits = 0
	for (const pa of liveAlbums) {
		const q = { artist: pa.artist, album: pa.album, lossless: pa.lossless }
		const l = li.findMatch(LIVE_SH.albumComparable(q))
		const o = oi.findMatch(OLD_SH.albumComparable(q))
		assert.strictEqual(l ? l.ref.id : null, o ? o.ref.id : null,
			`findMatch differed for "${pa.artist} — ${pa.album}"`)
		if (o) hits++
	}
	assert.ok(hits > 1000, `expected most lookups to hit, only ${hits} did`)
})

test('buildLibraryIndex: non-default thresholds agree too', () => {
	for (const opts of [{ albumMin: 0.9, artistMin: 0.5 }, { albumMin: 0.3, artistMin: 0.1 },
		{ albumMin: 0, artistMin: 0 }, { albumMin: 1, artistMin: 1 }]) {
		const li = LIVE_SH.buildLibraryIndex(library, opts)
		const oi = OLD_SH.buildLibraryIndex(library, opts)
		for (const pa of liveAlbums.slice(0, 1200)) {
			const q = { artist: pa.artist, album: pa.album }
			const l = li.findMatch(LIVE_SH.albumComparable(q))
			const o = oi.findMatch(OLD_SH.albumComparable(q))
			assert.strictEqual(l ? l.ref.id : null, o ? o.ref.id : null,
				`findMatch differed at albumMin=${opts.albumMin} for "${pa.album}"`)
		}
	}
})

test('albumsMatch / tokenScore / normKey: unchanged over thousands of real-shaped pairs', () => {
	for (let i = 0; i < liveAlbums.length; i += 3) {
		const a = liveAlbums[i]
		const b = liveAlbums[(i * 7 + 13) % liveAlbums.length]
		assert.strictEqual(LIVE_SH.albumsMatch(a, b), OLD_SH.albumsMatch(a, b))
		assert.strictEqual(LIVE_SH.tokenScore(a.album, b.album), OLD_SH.tokenScore(a.album, b.album))
		assert.strictEqual(LIVE_SH.normKey(a.album), OLD_SH.normKey(a.album))
		assert.strictEqual(LIVE_SH.albumQualityLabel(a), OLD_SH.albumQualityLabel(a))
	}
})

test('mergeSourcesByAlbum: identical buckets, identical source ordering', () => {
	const surround = (s) => /5\.?1|multichannel|surround/i.test(s)
	for (const det of [null, surround]) {
		const l = LIVE_SH.mergeSourcesByAlbum(groups, { detectSurround: det })
		const o = OLD_SH.mergeSourcesByAlbum(groups, { detectSurround: det })
		assert.strictEqual(l.length, o.length)
		assert.ok(l.length > 500, `expected a big merge, got ${l.length}`)
		for (let i = 0; i < o.length; i++) {
			const li = l[i], oi = o[i]
			assert.strictEqual(li.album, oi.album, `merged album ${i} title`)
			assert.strictEqual(li.year, oi.year)
			assert.strictEqual(li.peopleCount, oi.peopleCount, `merged album ${i} people`)
			assert.strictEqual(li.trackCount, oi.trackCount)
			assert.strictEqual(li.totalSize, oi.totalSize)
			assert.strictEqual(li.lossless, oi.lossless)
			assert.strictEqual(li.isHiRes, oi.isHiRes)
			assert.strictEqual(li.surround, oi.surround)
			assert.deepStrictEqual(li.bestQuality, oi.bestQuality)
			assert.strictEqual(li.best && li.best.username, oi.best && oi.best.username)
			assert.deepStrictEqual(
				li.sources.map(s => s.folderPath + '@' + s.username),
				oi.sources.map(s => s.folderPath + '@' + s.username),
				`merged album ${i} source order`)
			// artist can carry the alias fix
			if (isAliasArtist(oi.artist)) assert.ok(!isAliasArtist(li.artist))
			else assert.strictEqual(li.artist, oi.artist)
		}
	}
})

test('sortMergedAlbums: every key produces the identical order', () => {
	const merged = OLD_SH.mergeSourcesByAlbum(groups)
	for (const key of ['quality', 'az', 'year', 'size', 'nonsense', undefined]) {
		assert.deepStrictEqual(
			LIVE_SH.sortMergedAlbums(merged, key).map(a => `${a.artist}|${a.album}|${a.totalSize}`),
			OLD_SH.sortMergedAlbums(merged, key).map(a => `${a.artist}|${a.album}|${a.totalSize}`),
			`sort key "${key}" differed`)
	}
	// And over shelf albums, which carry the flat quality fields instead.
	for (const key of ['quality', 'az', 'year', 'size']) {
		assert.deepStrictEqual(
			LIVE_SH.sortMergedAlbums(liveAlbums, key).map(a => a.folderPath),
			OLD_SH.sortMergedAlbums(liveAlbums, key).map(a => a.folderPath),
			`shelf sort key "${key}" differed`)
	}
})

test('sourceScore / sourceQuality / qualityRankTuple: unchanged per group', () => {
	for (const g of groups) {
		assert.strictEqual(LIVE_SH.sourceScore(g), OLD_SH.sourceScore(g))
		assert.deepStrictEqual(LIVE_SH.sourceQuality(g), OLD_SH.sourceQuality(g))
		assert.deepStrictEqual(
			LIVE_SH.qualityRankTuple(LIVE_SH.sourceQuality(g)),
			OLD_SH.qualityRankTuple(OLD_SH.sourceQuality(g)))
	}
})

test('groupByLetter / computeStats / libAlbumToComparable: unchanged', () => {
	assert.deepStrictEqual(
		LIVE_SH.groupByLetter(liveAlbums).map(g => `${g.letter}:${g.albums.length}`),
		OLD_SH.groupByLetter(liveAlbums).map(g => `${g.letter}:${g.albums.length}`))
	assert.deepStrictEqual(LIVE_SH.computeStats(liveAlbums, { surroundCount: 7 }),
		OLD_SH.computeStats(liveAlbums, { surroundCount: 7 }))
	for (const a of library) {
		const l = LIVE_SH.libAlbumToComparable(a)
		const o = OLD_SH.libAlbumToComparable(a)
		assert.strictEqual(l.artist, o.artist)
		assert.strictEqual(l.album, o.album)
		assert.strictEqual(l.lossless, o.lossless)
		assert.strictEqual(l.maxBitDepth, o.maxBitDepth)
		assert.strictEqual(l.maxSampleRate, o.maxSampleRate)
	}
})

test('fmtSize / upgradeReason / isDiscFolder / cleanSegment / extractYear: unchanged', () => {
	for (const n of [0, -1, 1, 1023, 1024, 1536, 1048576, 1e9, 1.1e12, 9.9e15, NaN]) {
		assert.strictEqual(LIVE_SH.fmtSize(n), OLD_SH.fmtSize(n))
	}
	const names = ['CD1', 'CD 2', 'Disc 04', 'Disk3', 'Vol. 2', 'Volume Three', 'CD',
		'Discography', 'Disc', 'cd01', 'CDs', 'Music', '']
	for (const n of names) assert.strictEqual(LIVE_SH.isDiscFolder(n), OLD_SH.isDiscFolder(n))
	for (const d of share.dirs) {
		for (const seg of d.name.split('\\')) {
			assert.strictEqual(LIVE_SH.cleanSegment(seg), OLD_SH.cleanSegment(seg), `cleanSegment("${seg}")`)
			assert.strictEqual(LIVE_SH.extractYear(seg), OLD_SH.extractYear(seg), `extractYear("${seg}")`)
		}
	}
	for (const a of liveAlbums.slice(0, 2000)) {
		for (const b of library.slice(0, 5)) {
			const p = LIVE_SH.albumComparable({ artist: a.artist, album: a.album, lossless: a.lossless, maxBitDepth: a.maxBitDepth, maxSampleRate: a.maxSampleRate })
			const m = LIVE_SH.libAlbumToComparable(b)
			assert.deepStrictEqual(LIVE_SH.upgradeReason(p, m), OLD_SH.upgradeReason(p, m))
		}
	}
})

test('the chunked builders still agree with their sync twins after the speed-up', async () => {
	const tree = await LIVE_SH.buildTreeChunked(share.dirs, { budgetMs: 4 })
	assert.deepStrictEqual(flattenTree(tree), flattenTree(liveTree))
	const alb = await LIVE_SH.extractAlbumsChunked(tree, { budgetMs: 4 })
	assert.deepStrictEqual(alb.map(albumRow), liveAlbums.map(albumRow))
	const sh = await LIVE_SH.buildShelvesChunked(alb, library, { budgetMs: 4 })
	const sync = LIVE_SH.buildShelves(liveAlbums, library, {})
	for (const shelf of ['upgrades', 'missing', 'hires', 'everything']) {
		assert.deepStrictEqual(sh[shelf].map(a => a.folderPath), sync[shelf].map(a => a.folderPath), shelf)
	}
	assert.deepStrictEqual(sh.stats, sync.stats)
	assert.strictEqual(LIVE_SH.fingerprintBrowse(share.dirs), OLD_SH.fingerprintBrowse(share.dirs))
	const idx = await LIVE_SH.buildTreeSearchIndexChunked(liveTree, { budgetMs: 4 })
	for (const q of ['the', 'flac', 'cd1', 'zzqq']) {
		assert.deepStrictEqual(
			LIVE_SH.searchTreeIndex(idx, q, 300).map(r => `${r.type}|${r.name}|${r.path}`),
			OLD_TREE.searchTree(oldTree, q, 300).map(r => `${r.type}|${r.name}|${r.path}`), q)
	}
})
