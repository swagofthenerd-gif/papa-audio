'use strict'
// A synthetic Soulseek share big enough and messy enough to measure against.
//
// Every perf claim about the record shop has to be made against a share that
// looks like a real one, not against twenty tidy "Artist - Album" folders. The
// shapes below are the ones that actually break the parsers and the ones that
// actually cost time:
//
//   - disc subfolders ("CD1", "Disc 02", "Vol. 3") that must fold into a parent
//   - scene release names ("Artist-Album-2009-GRP", underscores, no spaces)
//   - non-Latin artist and album names (Cyrillic, Japanese, accented Latin)
//   - loose tracks sitting directly in an artist folder with no album folder
//   - a "shelf" folder that holds both subfolders AND enough of its own audio
//   - slskd's anonymised share alias prefix ("@@aeylt\\...") on a slice of paths
//   - case-duplicate folders ("Dark The Suns" / "Dark the Suns")
//   - quality tags smothered over the top ([FLAC][24-96], (2019) [Vinyl])
//
// The generator is seeded, so the corpus is byte-identical run to run: a bench
// that drifts between runs cannot prove anything, and the equivalence test
// needs the same corpus on both sides of the comparison.

function mulberry32(seed) {
	let a = seed >>> 0
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// Eight hundred artists are built by crossing these, so the token vocabulary
// spreads the way a real share does: many artists, each holding a few albums.

const FIRST = [
	'Pink', 'Massive', 'Boards of', 'Black', 'Dark', 'Blue', 'Silver', 'Golden',
	'Electric', 'Velvet', 'Crimson', 'Midnight', 'Northern', 'Solar', 'Lunar',
	'Iron', 'Glass', 'Paper', 'Stone', 'River',
]
const SECOND = [
	'Floyd', 'Attack', 'Canada', 'Sabbath', 'Suns', 'Note', 'Apples', 'Hour',
	'Wizard', 'Underground', 'King', 'Oil', 'Lights', 'Fields', 'Echo',
	'Maiden', 'Animals', 'Trail', 'Roses', 'Deep',
]
// A handful of real-shaped non-Latin names. They matter because normKey strips
// to [a-z0-9] — a Cyrillic album title normalises to the empty string, which is
// exactly the "no usable album token" path the library index has a bucket for.
const NON_LATIN = [
	'Аквариум', 'Кино', 'Гражданская Оборона', 'ДДТ',
	'坂本龍一', '久石譲', 'サカナクション', '宇多田ヒカル',
	'Sigur Rós', 'Björk', 'Mötley Crüe', 'Café Tacvba', 'Émilie Simon',
]
// Album-title vocabulary. The SHAPE matters more than the words: measured over
// a real 4,128-album share, album titles carry 3.37 tokens each drawn from 3,901
// distinct tokens, 59% of which appear exactly once while the head is brutally
// fat ("the" ×486, "of" ×370, "hits" ×195). A flat vocabulary makes every bucket
// in the matcher's index the same size, which flatters a bucketed matcher and
// hides exactly the pathology this corpus exists to expose. So: a short head of
// genuinely common words, then a long manufactured tail, sampled with a cubic
// bias so the frequencies come out Zipf-shaped like the real thing.
const HEAD_WORDS = [
	'The', 'Of', 'In', 'And', 'A', 'To', 'Live', 'Greatest', 'Hits',
	'Collection', 'Complete', 'Best', 'Vol', 'Sessions', 'Anthology',
]
const STEM = [
	'Ambient', 'Works', 'Selected', 'Dark', 'Side', 'Moon', 'Rainbow',
	'Kind', 'Blue', 'Dummy', 'Physical', 'Graffiti', 'Never', 'Black',
	'Water', 'Park', 'Amnesia', 'Mezzanine', 'True', 'Round', 'Ostinato',
	'Migration', 'Lateral', 'Around', 'Homework', 'Discovery', 'Canto',
	'Amsterdam', 'London', 'Rotterdam', 'Tokyo', 'Winter', 'Summer',
	'Machine', 'Garden', 'Mirror', 'Signal', 'Static', 'Harvest', 'Ghost',
]
const SUFFIX = [
	'', 'ism', 'ing', 'ed', 'er', 'land', 'wave', 'light', 'song', 'time',
	'fall', 'rise', 'less', 'ness', 'craft', 'storm', 'field', 'line',
]
function buildVocab() {
	const out = HEAD_WORDS.slice()
	for (const s of STEM) for (const sf of SUFFIX) out.push(s + sf)
	for (let i = 0; i < 2600; i++) out.push('W' + i.toString(36))
	return out
}
const WORDS = buildVocab()
// Cubic bias: index 0 is drawn ~thousands of times more often than the tail, so
// the head/singleton split lands near the measured 59%.
function pickWord(rnd) { return WORDS[Math.floor(WORDS.length * Math.pow(rnd(), 3))] }
const TAGS = [
	'', '', '', ' [FLAC]', ' [24-96]', ' {WEB}', ' [Vinyl]', ' [CDRip]',
	' [FLAC][24-96]', ' [Remastered]', ' [Deluxe Edition]',
]
const SCENE_GRP = ['GRP', 'JUST', 'PERFECT', 'EMG', 'FWYH', 'AMOK']

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)] }

function makeArtists(rnd, n) {
	const out = []
	const seen = new Set()
	for (const nl of NON_LATIN) { out.push(nl); seen.add(nl) }
	while (out.length < n) {
		const name = `${pick(rnd, FIRST)} ${pick(rnd, SECOND)}`
		// Case-duplicate a slice of them: peers really do share both spellings,
		// and the tree keys folders case-insensitively because of it.
		const cand = rnd() < 0.04 ? name.toLowerCase() : name
		if (seen.has(cand)) { if (rnd() < 0.5) continue }
		seen.add(cand)
		out.push(cand)
	}
	return out
}

function makeTitle(rnd) {
	const n = 1 + Math.floor(rnd() * 5)
	const out = []
	for (let i = 0; i < n; i++) out.push(pickWord(rnd))
	return out.join(' ')
}

// slskd's browse response carries the full path on the DIRECTORY and a bare
// basename on each file — that is what the captured real payloads look like.
// A slice is emitted with a full path anyway, because older daemons do that and
// buildTree's basename extraction has to survive both.
function audioFile(rnd, n, lossless, hi, prefix) {
	const ext = lossless ? (rnd() < 0.08 ? 'wav' : 'flac') : (rnd() < 0.15 ? 'm4a' : 'mp3')
	const num = String(n).padStart(2, '0')
	const base = `${num} - ${makeTitle(rnd)}.${ext}`
	return {
		filename: rnd() < 0.15 ? `${prefix}\\${base}` : base,
		size: Math.floor((lossless ? 25e6 : 8e6) * (0.5 + rnd())),
		bitDepth: lossless ? (hi ? 24 : 16) : 0,
		sampleRate: lossless ? (hi ? 96000 : 44100) : 0,
		bitRate: lossless ? 0 : pick(rnd, [128, 192, 256, 320]),
	}
}

// One directory entry in the slskd browse shape: { name, files:[{filename,…}] }.
// `name` is the full Windows-style path.
function dirEntry(rnd, path, trackCount, lossless, hi) {
	const files = []
	for (let i = 1; i <= trackCount; i++) files.push(audioFile(rnd, i, lossless, hi, path))
	// Real folders carry covers and logs; they must not be counted as tracks.
	if (rnd() < 0.5) files.push({ filename: "folder.jpg", size: 240000 })
	if (rnd() < 0.2) files.push({ filename: `${makeTitle(rnd)}.log`, size: 4000 })
	return { name: path, files }
}

// Build the whole share. Returns the slskd browse payload (a flat directory
// array) plus the counts, so a bench can assert it actually built what it says.
function buildShare({ seed = 20260917, albums = 5000, artists = 800 } = {}) {
	const rnd = mulberry32(seed)
	const names = makeArtists(rnd, artists)
	const dirs = []
	let fileCount = 0
	const push = (d) => { dirs.push(d); fileCount += d.files.length }

	for (let i = 0; i < albums; i++) {
		const artist = names[i % names.length]
		const title = makeTitle(rnd)
		const year = 1965 + Math.floor(rnd() * 60)
		const lossless = rnd() > 0.35
		const hi = lossless && rnd() > 0.55
		const tracks = 4 + Math.floor(rnd() * 12)
		// slskd hides a share behind an alias for peers who anonymise; the alias
		// segment is a literal "@@xxxxx" that is NOT an artist and must never be
		// read as one.
		const alias = rnd() < 0.25 ? `@@aeylt\\` : ''
		const root = rnd() < 0.5 ? 'Music\\' : ''
		const r = rnd()

		if (r < 0.10) {
			// Scene release: one flat folder, underscores, no spaces, group suffix.
			const scene = `${artist.replace(/\s+/g, '_')}-${title.replace(/\s+/g, '_')}-${year}-${pick(rnd, SCENE_GRP)}`
			push(dirEntry(rnd, `${alias}${root}${scene}`, tracks, lossless, hi))
		} else if (r < 0.22) {
			// Multi-disc: parent holds nothing, CD1/CD2 hold the tracks.
			const base = `${alias}${root}${artist}\\${title} (${year})${pick(rnd, TAGS)}`
			const discs = 2 + Math.floor(rnd() * 2)
			const label = pick(rnd, ['CD', 'Disc ', 'Disk', 'CD ', 'Vol. '])
			for (let d = 1; d <= discs; d++) {
				push(dirEntry(rnd, `${base}\\${label}${d}`, tracks, lossless, hi))
			}
			// The parent directory exists in the listing with only a cover in it.
			push({ name: base, files: [{ filename: `${base}\\cover.jpg`, size: 300000 }] })
		} else if (r < 0.30) {
			// Loose tracks straight in the artist folder — no album folder at all.
			push(dirEntry(rnd, `${alias}${root}${artist}`, tracks, lossless, hi))
		} else if (r < 0.36) {
			// "Artist - Year - Album" all in one leaf segment.
			push(dirEntry(rnd, `${alias}${root}${artist} - ${year} - ${title}${pick(rnd, TAGS)}`, tracks, lossless, hi))
		} else if (r < 0.44) {
			// Generic container standing in for the artist ("Music\\FLAC\\Album").
			const box = pick(rnd, ['FLAC', 'Albums', 'Various Artists', 'Collection'])
			push(dirEntry(rnd, `${alias}${root}${box}\\${artist} - ${title}`, tracks, lossless, hi))
		} else if (r < 0.48) {
			// A shelf: real subfolders AND enough of its own loose audio to be an
			// album in its own right. Both must come out of extractAlbums.
			const shelf = `${alias}${root}${artist}\\Singles`
			push(dirEntry(rnd, shelf, tracks, lossless, hi))
			push(dirEntry(rnd, `${shelf}\\${title} EP`, 3, lossless, hi))
		} else {
			// The common case: Artist\\Year - Album, tags and all.
			const leaf = rnd() < 0.5
				? `${year} - ${title}${pick(rnd, TAGS)}`
				: `${title} (${year})${pick(rnd, TAGS)}`
			push(dirEntry(rnd, `${alias}${root}${artist}\\${leaf}`, tracks, lossless, hi))
		}
	}
	// A pathological wide folder: one directory holding a few thousand loose
	// files. This is the shape that made Math.max(0, ...files.map(…)) throw.
	const wide = []
	for (let i = 1; i <= 3000; i++) wide.push(audioFile(rnd, i, true, false, 'Everything'))
	push({ name: 'Everything', files: wide })

	return { dirs, fileCount, albumCount: albums, artistCount: names.length }
}

// The renderer's library album shape, for the "do I already own this" matcher.
// A slice deliberately re-uses the share's own artists and titles so real
// matches exist; the rest are noise the matcher must reject.
function buildLibrary({ seed = 7, count = 2000, share = null } = {}) {
	const rnd = mulberry32(seed)
	const names = makeArtists(mulberry32(20260917), 800)
	const out = []
	for (let i = 0; i < count; i++) {
		const lossless = rnd() > 0.5
		const hi = lossless && rnd() > 0.7
		// A slice of the library has NO usable album token: normKey strips to
		// [a-z0-9], so a purely Cyrillic or Japanese title, or one that is only
		// punctuation, normalises to the empty string. The matcher keeps those in
		// a separate fallback bucket that is only reachable when albumMin is 0 or
		// below — a branch nothing exercises unless the corpus actually contains
		// such albums. His real 245-album library has three.
		const noToken = rnd() < 0.01
		out.push({
			id: `lib${i}`,
			name: noToken ? pick(rnd, ['Аквариум', '坂本龍一', '!!!', '…', '宇多田ヒカル']) : makeTitle(rnd),
			artist: names[Math.floor(rnd() * names.length)],
			maxBitsPerSample: lossless ? (hi ? 24 : 16) : 0,
			maxSampleRate: lossless ? (hi ? 96000 : 44100) : 0,
			tracks: [
				{ filePath: `/mnt/data/MUSIC/a${i}/01.${lossless ? 'flac' : 'mp3'}` },
				{ filePath: `/mnt/data/MUSIC/a${i}/02.${lossless ? 'flac' : 'mp3'}` },
			],
		})
	}
	return out
}

// Search folder-groups, the shape mergeSourcesByAlbum takes. Many peers hold
// the same album, which is the whole point of the merge.
function buildSearchGroups({ seed = 11, albums = 1200, peersPer = 6 } = {}) {
	const rnd = mulberry32(seed)
	const names = makeArtists(mulberry32(20260917), 800)
	const out = []
	for (let i = 0; i < albums; i++) {
		const artist = names[Math.floor(rnd() * names.length)]
		const title = makeTitle(rnd)
		const n = 1 + Math.floor(rnd() * peersPer)
		for (let p = 0; p < n; p++) {
			const lossless = rnd() > 0.4
			const tracks = 4 + Math.floor(rnd() * 12)
			const folderPath = `${rnd() < 0.2 ? '@@aeylt\\' : ''}Music\\${artist}\\${title}${pick(rnd, TAGS)}`
			const files = []
			for (let t = 1; t <= tracks; t++) {
				files.push({
					name: `${String(t).padStart(2, '0')}.${lossless ? 'flac' : 'mp3'}`,
					filename: `${folderPath}\\${String(t).padStart(2, '0')}.${lossless ? 'flac' : 'mp3'}`,
					size: Math.floor((lossless ? 25e6 : 8e6) * (0.5 + rnd())),
					isFlac: lossless,
					bitDepth: lossless ? (rnd() > 0.6 ? 24 : 16) : 0,
					sampleRate: lossless ? (rnd() > 0.6 ? 96000 : 44100) : 0,
				})
			}
			out.push({
				username: `peer${p}_${i % 97}`,
				folderPath,
				folderName: title,
				files,
				hasFreeSlot: rnd() > 0.5,
				queueLength: Math.floor(rnd() * 40),
				uploadSpeed: Math.floor(rnd() * 900000),
			})
		}
	}
	return out
}

module.exports = { mulberry32, buildShare, buildLibrary, buildSearchGroups }
