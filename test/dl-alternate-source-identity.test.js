'use strict'
// The alternate-source hunt used to match on the bare track name.
//
// When a download stalls, the app searches for another peer serving the same
// file. It folded the search results into the wanted item on the BASENAME
// alone — "01 - Intro.flac" and nothing else — and then checked only a quality
// fingerprint: lossless, surround layout, bit depth, sample rate. None of those
// can tell two different songs apart, because a 16/44 stereo FLAC looks exactly
// like every other 16/44 stereo FLAC.
//
// So the hunt could take a completely different song off a completely different
// record, download it, and mark the wanted track done. Size is what separates
// them, and src/download-scheduler.js already says so in as many words next to
// fileIdentity — that reasoning just was not being applied here.
//
// Both real fold loops are lifted out of main.js and executed. The rule itself
// is the real exported helper.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const dlSched = require('../src/download-scheduler.js')
const dlFingerprint = require('../src/source-fingerprint.js')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift(startAnchor, endAnchor, what) {
	const at = MAIN.indexOf(startAnchor)
	assert.ok(at > -1, what + ' must still exist in main.js')
	const end = MAIN.indexOf(endAnchor, at)
	assert.ok(end > at, what + ' must still end at its anchor')
	return MAIN.slice(at, end)
}

const dlBaseName = p => String(p || '').split(/[\\/]/).pop()

// ── the rule itself ─────────────────────────────────────────────────────────

test('a size that agrees means the same recording; one that does not, does not', () => {
	const same = dlSched.sameRecordingSize
	assert.strictEqual(same(30000000, 30000000), true, 'the same release between peers is byte-identical')
	assert.strictEqual(same(30000000, 30300000), true, 'another rip of the same recording is within 2%')
	assert.strictEqual(same(30000000, 12000000), false, 'a different song is nowhere near')
	assert.strictEqual(same(30000000, 40000000), false)
})

test('a size nobody knows is refused rather than waved through', () => {
	const same = dlSched.sameRecordingSize
	assert.strictEqual(same(0, 30000000), false, 'unknown on our side proves nothing')
	assert.strictEqual(same(30000000, 0), false, 'unknown on theirs proves nothing either')
	assert.strictEqual(same(null, null), false)
	assert.strictEqual(same(undefined, 30000000), false)
	assert.strictEqual(same('not a number', 30000000), false)
})

// ── the discovery fold (dlSearchAlbum) ──────────────────────────────────────

function runSearchAlbumFold({ responses, wantedBasenames, wantedSize }) {
	const body = lift(
		'    const want = new Set(wantedBasenames)',
		'    return out',
		"dlSearchAlbum's result fold",
	)
	return new Function('responses', 'wantedBasenames', 'wantedSize', 'dlBaseName', 'dlSched', `
		${body}
		return out
	`)(responses, wantedBasenames, wantedSize, dlBaseName, dlSched)
}

test('discovery drops a same-named track that is a different size', () => {
	const responses = [{
		username: 'peerA', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100,
		files: [
			// The one he actually wants, from another peer: same bytes.
			{ filename: '/Music/Wish You Were Here/01 - Intro.flac', size: 30000000, bitDepth: 16, sampleRate: 44100 },
			// A different record's first track. Same name, nothing else in common.
			{ filename: '/Music/Some Other Album/01 - Intro.flac', size: 4200000, bitDepth: 16, sampleRate: 44100 },
		],
	}]

	const out = runSearchAlbumFold({
		responses, wantedBasenames: ['01 - intro.flac'], wantedSize: 30000000,
	})

	assert.strictEqual(out.length, 1, 'only the real alternate survives')
	assert.strictEqual(out[0].filename, '/Music/Wish You Were Here/01 - Intro.flac')
})

test('discovery keeps a genuine alternate ripped by someone else', () => {
	const responses = [{
		username: 'peerB', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100,
		files: [{ filename: '/Shared/WYWH/01 - Intro.flac', size: 30250000, bitDepth: 16, sampleRate: 44100 }],
	}]

	const out = runSearchAlbumFold({
		responses, wantedBasenames: ['01 - intro.flac'], wantedSize: 30000000,
	})

	assert.strictEqual(out.length, 1, 'within 2% is the same recording, and is still a usable source')
})

test('discovery refuses a candidate whose size the peer did not report', () => {
	const responses = [{
		username: 'peerC', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100,
		files: [{ filename: '/Shared/Whatever/01 - Intro.flac', bitDepth: 16, sampleRate: 44100 }],
	}]

	const out = runSearchAlbumFold({
		responses, wantedBasenames: ['01 - intro.flac'], wantedSize: 30000000,
	})

	assert.deepStrictEqual(out, [], 'an unverifiable substitution is how the wrong song gets downloaded')
})

// ── the seed fold (the folder-level hunt) ───────────────────────────────────

function runSeedFold({ responses, group, dlState }) {
	// Both for-loops close inside this slice, so it is lifted whole rather than
	// having its braces closed by hand.
	const body = lift(
		'      const want = new Map()',
		'      if (added) { dlPersist(); dlBroadcast() }',
		"the seed hunt's candidate fold",
	)
	const added = []
	const env = {
		dlBaseName, dlSched, dlFingerprint, dlState,
		dlWantedSize: it => {
			const own = Number(it && it.size)
			if (Number.isFinite(own) && own > 0) return own
			const src = (it && it.sources && it.sources[0]) || {}
			const s = Number(src.size)
			return Number.isFinite(s) && s > 0 ? s : 0
		},
		addSourcesSpy: (key, srcs) => { added.push({ key, srcs }); return srcs.length },
	}
	const count = new Function('env', 'responses', 'group', `
		const { dlBaseName, dlSched: _real, dlFingerprint, dlState, dlWantedSize, addSourcesSpy } = env
		// Every scheduler call is the real one except addSources, which is watched
		// so the test can see exactly what the hunt decided to fetch.
		const dlSched = Object.assign({}, _real, { addSources: (_s, key, srcs) => addSourcesSpy(key, srcs) })
		${body}
		return added
	`)(env, responses, group)
	return { added, count }
}

test('the seed hunt does not fetch a different record and call it the wanted track', () => {
	const group = [{
		filename: '/dl/Wish You Were Here/01 - Intro.flac',
		size: 30000000,
		sources: [{ username: 'slowpeer', size: 30000000, bitDepth: 16, sampleRate: 44100 }],
	}]
	const responses = [{
		username: 'peerX', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100,
		files: [{
			// Same track name, same quality fingerprint, utterly different song.
			filename: '/Shared/Completely Different Record/01 - Intro.flac',
			size: 4200000, bitDepth: 16, sampleRate: 44100,
		}],
	}]
	const dlState = { subLog: [] }

	const { added } = runSeedFold({ responses, group, dlState })

	assert.deepStrictEqual(added, [],
		'a shared track name is not a shared recording — nothing may be queued from it')
	const rejection = (dlState.subLog || []).find(e => e && e.accepted === false)
	assert.ok(rejection, 'and the refusal is written down so the Source-decisions panel can show it')
	assert.match(String(rejection.reason), /different recording/)
})

test('the seed hunt still takes a real alternate for the same file', () => {
	const group = [{
		filename: '/dl/Wish You Were Here/01 - Intro.flac',
		size: 30000000,
		sources: [{ username: 'slowpeer', size: 30000000, bitDepth: 16, sampleRate: 44100 }],
	}]
	const responses = [{
		username: 'fastpeer', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 900,
		files: [{
			filename: '/Shared/WYWH [FLAC]/01 - Intro.flac',
			size: 30000000, bitDepth: 16, sampleRate: 44100,
		}],
	}]
	const dlState = { subLog: [] }

	const { added } = runSeedFold({ responses, group, dlState })

	assert.strictEqual(added.length, 1, 'the whole point of the hunt still works')
	assert.strictEqual(added[0].srcs[0].username, 'fastpeer')
})
