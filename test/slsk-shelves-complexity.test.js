'use strict'
// Complexity guards for the record shop.
//
// The equivalence test proves the speed-up changed no answers. This one proves
// it did not change them back: every guard here fails if a hot path regresses to
// the shape it used to have. That matters because those shapes are the NATURAL
// way to write this code — "for each peer album, scan the library", "derive the
// sort key inside the comparator" — so they come back the moment someone edits
// without knowing the history.
//
// METHOD: count the work, don't time it.
//
// A first draft of this file timed each path at n, 2n and 4n and asserted the
// ratio stayed under 3. Pointed at the frozen pre-speedup modules, three of
// seven guards went red and four stayed GREEN — because a ratio cannot see a
// constant factor. Sorting 4,128 albums by quality took the old code 178 ms and
// the new code 4 ms, and both are n log n, so both "double when you double".
// A guard that green-lights a 32× regression is decoration.
//
// So the guards below instrument the data instead: the objects handed to the
// code under test count how many times their expensive parts are READ. That is
// exact, identical on a fast machine and a loaded one, and it fails loudly on
// precisely the regression it names.
//
// The last two guards that still timed anything — the merge, and buildTree /
// extractAlbums — are counted now too, for the opposite reason: a wall-clock
// ratio cannot be trusted on a loaded machine. Against a bar of 3× they read
// 3.0× and 3.4× with the code unchanged, because garbage collection lands
// systematically in the larger, allocation-heavy size. Interleaving the sizes
// (one run of n, one of 2n, one of n …, keeping the minimum of each) was meant
// to spread that load evenly over both sizes; it did not — five runs of this
// file under a busy 8-core box, five failures. So the interleaving machinery is
// deleted and those two count operations like everything else here.
//
// Two of the counters below cannot reach their operation through a getter,
// because the work happens entirely on objects the module builds for itself.
// They borrow the built-in method the hot loop actually calls (Set.prototype.has
// for the merge's token scoring), count the calls, and put it back. Still a
// count, still exact, still identical on a loaded machine.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const T = require('../src/slsk-tree')
const C = require('./helpers/slsk-corpus')

// ── The adversarial corpus ───────────────────────────────────────────────────
// Every album title is "Live <unique>". That one shared token is what makes a
// naive token index degenerate: the WHOLE library lands in the "live" bucket, so
// every peer lookup walks the whole library again and the index buys nothing. A
// real share does exactly this with "the", "of", "greatest", "hits" — measured
// on a real 4,128-album peer, "the" is carried by 486 of them.
//
// The answer is to scan the RAREST of a peer album's token buckets rather than
// all of them, so the unique half of each title decides the lookup and the
// shared half costs nothing.
function countingLibrary(n, counter) {
	const out = new Array(n)
	for (let i = 0; i < n; i++) {
		const album = `Live ${i.toString(36)}zz`
		const artist = `Artist ${i % 500}`
		const albumTokens = S.normTokenSet(album)
		const artistTokens = S.normTokenSet(artist)
		out[i] = {
			artist, album, ref: { id: `lib${i}` },
			artistTokens,
			albumTokenCount: albumTokens.size,
			lossless: true, maxBitDepth: 16, maxSampleRate: 44100,
			// Read once per real comparison — and once more per entry while the
			// index is being built, which the caller discounts by resetting after.
			get albumTokens() { counter.n++; return albumTokens },
		}
	}
	return out
}
function peerComparables(n) {
	const out = new Array(n)
	for (let i = 0; i < n; i++) {
		out[i] = S.albumComparable({ artist: `Artist ${i % 500}`, album: `Live ${i.toString(36)}zz` })
	}
	return out
}

test('findMatch: the work per lookup does not grow with the library', () => {
	// O(peer × library) is the shape this whole index exists to kill, and a token
	// every album shares is how it sneaks back. Quadrupling the library must not
	// meaningfully change how many library albums a single lookup examines.
	const peers = peerComparables(500)
	const measure = (libSize) => {
		const counter = { n: 0 }
		const idx = S.buildLibraryIndex(countingLibrary(libSize, counter))
		counter.n = 0                       // discount index construction
		let hits = 0
		for (const p of peers) if (idx.findMatch(p)) hits++
		assert.ok(hits >= peers.length * 0.9,
			`the corpus stopped matching (${hits}/${peers.length}); the guard would be measuring nothing`)
		return counter.n / peers.length
	}
	const small = measure(2000)
	const large = measure(8000)
	assert.ok(large < small * 1.5 + 2,
		`findMatch examined ${small.toFixed(1)} library albums per lookup at 2,000 albums ` +
		`but ${large.toFixed(1)} at 8,000 — the cost is growing with the library, which is ` +
		`the O(peer × library) sweep coming back.`)
	// And in absolute terms it must be a handful, not a sweep.
	assert.ok(large < 40,
		`findMatch examined ${large.toFixed(1)} library albums per lookup against an 8,000-album library`)
})

test('sortMergedAlbums(quality) reads each album\'s files once, not once per comparison', () => {
	// qr() walks a source group's entire file list. The old comparator called it
	// on BOTH sides of every comparison, so the sort did ~2·n·log2(n) file walks
	// to order n albums — 178 ms on a real 4,128-album share. Decorate-sort-
	// undecorate makes it exactly n.
	// The input must be genuinely UNSORTED and its keys must genuinely differ.
	// A first draft handed the sort a fully reversed run of equal-quality albums;
	// TimSort spots a reversed run and flips it in a single linear pass, so even
	// the old comparator only did ~2n reads and the guard passed against the code
	// it was written to catch. Seeded shuffle, four distinct quality tiers.
	const n = 4096
	const counter = { n: 0 }
	const rnd = C.mulberry32(99)
	const tiers = [
		[{ name: '1.flac', size: 2e7, isFlac: true, bitDepth: 24, sampleRate: 96000 }],
		[{ name: '1.flac', size: 2e7, isFlac: true, bitDepth: 16, sampleRate: 44100 }],
		[{ name: '1.mp3', size: 8e6, isFlac: false, bitDepth: 0, sampleRate: 0 }],
		[{ name: '1.flac', size: 2e7, isFlac: true, bitDepth: 24, sampleRate: 192000 }],
	]
	const albums = new Array(n)
	for (let i = 0; i < n; i++) {
		const files = tiers[Math.floor(rnd() * tiers.length)]
		albums[i] = {
			artist: `A${i % 700}`, album: `Album ${i}`, totalSize: Math.floor(rnd() * 1e9),
			best: { get files() { counter.n++; return files } },
		}
	}
	S.sortMergedAlbums(albums, 'quality')
	// n log2 n for this n is ~49,000; one-per-album is 4,096. The bar sits well
	// clear of both so it cannot flake, and a regression cannot slip under it.
	assert.ok(counter.n <= n * 2,
		`the quality sort walked ${counter.n} file lists to order ${n} albums ` +
		`(once per album would be ${n}; once per comparison is ~${Math.round(n * Math.log2(n))})`)
})

test('finalizeMergedAlbum measures each source once, not once per comparison', () => {
	// Same trap one level down: ordering the people who hold one album used to
	// recompute sourceQuality AND sourceScore on both sides of every comparison.
	const n = 512
	const counter = { n: 0 }
	const files = [{ name: '01.flac', size: 2e7, isFlac: true, bitDepth: 16, sampleRate: 44100 }]
	const sources = new Array(n)
	for (let i = 0; i < n; i++) {
		sources[i] = {
			username: `peer${i}`, hasFreeSlot: i % 2 === 0, queueLength: i % 17, uploadSpeed: i * 97,
			get files() { counter.n++; return files },
		}
	}
	const bucket = { ident: { artist: 'A', album: 'B', year: null }, sources, seq: 0 }
	S.finalizeMergedAlbum(bucket, null)
	// sourceQuality + sourceScore + the best-quality pass = a small fixed number
	// of reads per source. Once per comparison would be ~2·n·log2(n) ≈ 9,200.
	assert.ok(counter.n <= n * 4,
		`finalizeMergedAlbum read ${counter.n} file lists to order ${n} sources (expected <= ${n * 4})`)
})

test('listDir derives its sort keys once per row, not once per comparison', () => {
	// The `type` ordering re-split the filename on both sides of every
	// comparison. Build the node by hand so the rows can count their own reads —
	// buildTree copies files by spread, which would flatten the getters away.
	const n = 4096
	for (const sort of ['name', 'type']) {
		const counter = { n: 0 }
		const files = new Array(n)
		for (let i = 0; i < n; i++) {
			const nm = `track ${i.toString(36)}.flac`
			files[i] = { size: i, fullPath: nm, get name() { counter.n++; return nm } }
		}
		const node = { name: 'Everything', path: 'Everything', dirs: new Map(), files, fileCount: n, totalSize: 0 }
		const root = { name: '', path: '', dirs: new Map([['everything', node]]), files: [], fileCount: n, totalSize: 0 }
		const r = T.listDir(root, 'Everything', { sort })
		assert.strictEqual(r.files.length, n)
		assert.ok(counter.n <= n * 4,
			`listDir(sort:${sort}) read ${counter.n} names to order ${n} rows ` +
			`(expected <= ${n * 4}; once per comparison is ~${Math.round(2 * n * Math.log2(n))})`)
	}
})

// ── Counted guards for the two paths that used to be timed ──────────────────
// The merge does all of its comparing on objects it builds for itself — it
// reads folderPath/folderName once per group and never touches the caller's
// objects again — so there is no getter to hang a counter on. What the inner
// loop DOES call, once per token of the smaller set on every candidate
// comparison, is Set.prototype.has (inside tokenScoreSets). Borrow it, count
// the calls, put it back. Exact, and unaffected by load.
function countSetProbes(fn) {
	const real = Set.prototype.has
	let n = 0
	Set.prototype.has = function (v) { n++; return real.call(this, v) }
	try { fn() } finally { Set.prototype.has = real }
	return n
}

test('mergeSourcesByAlbum compares a fixed amount per group, however many groups arrive', () => {
	// Genuinely quadratic in the old form: the buckets grow as the merge runs, so
	// every new group compares against every bucket sharing its "Live" token —
	// and with this corpus that is every bucket there is.
	const make = (n) => {
		const out = new Array(n)
		for (let i = 0; i < n; i++) {
			out[i] = {
				username: `peer${i % 200}`,
				folderPath: `Music\\Artist ${i % 400}\\Live ${i.toString(36)}zz`,
				folderName: `Live ${i.toString(36)}zz`,
				files: [{ name: '01.flac', size: 1e6, isFlac: true }, { name: '02.flac', size: 1e6, isFlac: true }],
				hasFreeSlot: true, queueLength: 1, uploadSpeed: 1000,
			}
		}
		return out
	}
	const perGroup = (n) => countSetProbes(() => S.mergeSourcesByAlbum(make(n))) / n
	const small = perGroup(1500)
	const large = perGroup(3000)
	// Measured: the live merge does exactly 1.0 token probes per group at both
	// sizes. The frozen pre-speed-up merge does 2,249.5 at 1,500 groups and
	// 4,499.5 at 3,000 — it doubles when the input doubles, which is the
	// definition of the quadratic scan. Both halves of this assertion are red
	// against it, by three orders of magnitude.
	assert.ok(large < small * 1.5 + 2,
		`the merge probed ${small.toFixed(1)} tokens per group over 1,500 groups but ` +
		`${large.toFixed(1)} over 3,000 — the cost per group is growing with the number of ` +
		`groups, which is the every-bucket scan coming back.`)
	assert.ok(large < 20,
		`the merge probed ${large.toFixed(1)} tokens per group over 3,000 groups; a bucket ` +
		`scan that stays targeted is a handful of probes, not a sweep.`)
	// The corpus above gives every group a unique title on purpose — that is the
	// worst case for a bucket scan, because nothing ever merges and every bucket
	// is walked to the end. So check separately that the merge still merges: the
	// same shape with each album held by three different people must collapse to
	// one card per album, not three.
	const shared = make(900).flatMap(g => [0, 1, 2].map(p => ({ ...g, username: `peer${p}_${g.folderName}` })))
	const merged = S.mergeSourcesByAlbum(shared)
	assert.strictEqual(merged.length, 900)
	assert.ok(merged.every(m => m.peopleCount === 3))
	// …and that the no-duplicates corpus produces exactly one card per group.
	assert.strictEqual(S.mergeSourcesByAlbum(make(900)).length, 900)
})

test('buildTree reads each directory a fixed number of times, however big the share', () => {
	// Already linear and still is — a forward guard, not a fix. What it catches is
	// any future edit that re-walks the directory list (or the tree) per
	// directory: the per-directory read count would climb with the share.
	const countingDirs = (n, counter) => C.buildShare({ albums: n, artists: Math.max(40, n / 6) })
		.dirs.map(d => {
			const name = d.name
			return { files: d.files, get name() { counter.n++; return name } }
		})
	const perDir = (n) => {
		const counter = { n: 0 }
		const dirs = countingDirs(n, counter)
		const root = T.buildTree(dirs)
		assert.ok(root.fileCount > n, `the share stopped producing files (${root.fileCount})`)
		return counter.n / dirs.length
	}
	const small = perDir(1500)
	const large = perDir(6000)
	// Measured ~22.5 at 1,500 albums and ~20.1 at 6,000 — one read for the path
	// split plus one per file for fullPath, so it tracks tracks-per-folder and
	// drifts slightly DOWN as the share grows. Identical on the frozen module.
	assert.ok(large < small * 1.5 + 2,
		`buildTree read each directory ${small.toFixed(1)} times over a 1,500-album share but ` +
		`${large.toFixed(1)} times over a 6,000-album one — the per-directory cost is growing ` +
		`with the share, which is a re-walk.`)
})

test('extractAlbums reads each file\'s name twice, not once per node it passes under', () => {
	// The old walk built a filtered array of gathered audio for EVERY node in the
	// tree, shelves included, and threw it away after asking how long it was. The
	// live walk counts instead of gathering when the node is a shelf. Measured:
	// 2.02 name reads per file live, 2.95 frozen — so the 2.5 bar below is red
	// against the pre-speed-up module and has a comfortable margin above the
	// live one.
	const perFile = (n) => {
		const share = C.buildShare({ albums: n, artists: Math.max(40, n / 6) })
		const root = T.buildTree(share.dirs)
		const counter = { n: 0 }
		const instrument = (node) => {
			node.files = node.files.map(f => {
				const nm = f.name
				const o = { ...f }
				Object.defineProperty(o, 'name',
					{ get() { counter.n++; return nm }, enumerable: true })
				return o
			})
			for (const c of node.dirs.values()) instrument(c)
		}
		instrument(root)
		const albums = S.extractAlbums(root)
		assert.ok(albums.length > n * 0.8,
			`the share stopped producing albums (${albums.length} from ${n}); the guard ` +
			'would be measuring nothing')
		return counter.n / share.fileCount
	}
	const small = perFile(1500)
	const large = perFile(6000)
	assert.ok(large < small * 1.2 + 0.5,
		`extractAlbums read each file's name ${small.toFixed(2)} times over a 1,500-album ` +
		`share but ${large.toFixed(2)} times over a 6,000-album one — the per-file cost is ` +
		'growing with the share.')
	assert.ok(large < 2.5,
		`extractAlbums read each file's name ${large.toFixed(2)} times; gathering the audio ` +
		'list for shelf nodes as well as album nodes is what pushes this past 2.5.')
})

// ── The argument-spread crash ────────────────────────────────────────────────
test('a folder with 300,000 files in it builds an album instead of throwing', () => {
	// `Math.max(0, ...files.map(…))` does not merely walk the list twice: it
	// spreads it into an ARGUMENT LIST, and past roughly 150,000 entries on this
	// runtime that is a RangeError. A peer who shares one flat pile of files is an
	// ordinary Soulseek shape, and it made the shop throw on open rather than
	// render. The plain loop that replaced it has no such ceiling.
	const n = 300000
	const files = new Array(n)
	for (let i = 0; i < n; i++) {
		files[i] = { name: `t${i}.flac`, size: 1000, bitDepth: 24, sampleRate: 96000, bitRate: 0 }
	}
	const node = { name: 'Everything', path: 'Everything', dirs: new Map(), files }
	const album = S.buildAlbum(node, ['Everything'], { files, discCount: 0 })
	assert.strictEqual(album.trackCount, n)
	assert.strictEqual(album.maxBitDepth, 24)
	assert.strictEqual(album.maxSampleRate, 96000)
	assert.strictEqual(album.topExt, 'flac')
	assert.strictEqual(album.isHiRes, true)
	// The same ceiling existed in the search-side quality read,
	const q = S.sourceQuality({ files })
	assert.strictEqual(q.maxBitDepth, 24)
	assert.strictEqual(q.lossless, true)
	// in the library-side adapter,
	const tracks = new Array(n)
	for (let i = 0; i < n; i++) tracks[i] = { filePath: `/x/${i}.flac`, bitsPerSample: 24, sampleRate: 96000 }
	const comp = S.libAlbumToComparable({ name: 'Big', artist: 'A', tracks })
	assert.strictEqual(comp.maxBitDepth, 24)
	assert.strictEqual(comp.lossless, true)
	// and in the lossy bitrate label.
	const lossy = new Array(n)
	for (let i = 0; i < n; i++) lossy[i] = { name: `t${i}.mp3`, bitRate: 320 }
	assert.strictEqual(
		S.albumQualityLabel({ topExt: 'mp3', lossless: false, files: lossy }), 'MP3 · 320')
})
