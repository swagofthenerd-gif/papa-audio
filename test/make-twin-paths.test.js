'use strict'
// tools/make-twin.py must never hand a twin a path that points at his real
// disk. Before 2026-09-19 it copied `videoSettings.streamCacheDir` verbatim —
// his `/mnt/windows/PapaAudioCache` — so a twin's `purgeOrphanStreams` ran
// against HIS cache. This runs the real script against a fixture profile and
// asserts every writable absolute path lands inside the twin dir.
const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.join(__dirname, '..')

function makeSrc(config) {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-src-'))
	fs.writeFileSync(path.join(src, 'config.json'), JSON.stringify(config))
	return src
}

function runMakeTwin(config) {
	const src = makeSrc(config)
	// The script refuses any dst outside /tmp, so keep it there.
	const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-dst-')) + '-t'
	const stdout = execFileSync('python3', ['tools/make-twin.py', dst], {
		cwd: REPO, encoding: 'utf8',
		env: { ...process.env, PAPA_TWIN_SRC: src },
	})
	const out = JSON.parse(fs.readFileSync(path.join(dst, 'config.json'), 'utf8'))
	return { stdout, dst, out, cleanup: () => {
		fs.rmSync(src, { recursive: true, force: true })
		fs.rmSync(dst, { recursive: true, force: true })
	} }
}

test('the stream cache is re-pointed inside the twin, never at his disk', () => {
	const r = runMakeTwin({
		musicFolders: ['/mnt/data/MUSIC'],
		videoSettings: { streamCacheDir: '/mnt/windows/PapaAudioCache', quality: '1080p' },
	})
	try {
		assert.notStrictEqual(r.out.videoSettings.streamCacheDir, '/mnt/windows/PapaAudioCache')
		assert.ok(r.out.videoSettings.streamCacheDir.startsWith(r.dst + path.sep),
			'streamCacheDir must live inside the twin, got ' + r.out.videoSettings.streamCacheDir)
		// And the directory exists, so the app does not silently fall back.
		assert.ok(fs.existsSync(r.out.videoSettings.streamCacheDir))
		// Non-path settings are untouched.
		assert.strictEqual(r.out.videoSettings.quality, '1080p')
	} finally { r.cleanup() }
})

test('every writable absolute path is re-pointed, not just the known ones', () => {
	// Generic by design: a setting added upstream after this was written must be
	// caught without anyone remembering to list it here.
	const r = runMakeTwin({
		musicFolders: ['/mnt/data/MUSIC'],
		slskConfig: { downloadDir: '/mnt/data/MUSIC/Downloads' },
		videoSettings: { streamCacheDir: '/mnt/windows/PapaAudioCache' },
		someFutureSetting: { exportPath: '/home/shaharyar/Documents' },
	})
	try {
		const outside = []
		const walk = (node, p) => {
			if (typeof node === 'string') {
				if (node.startsWith('/') && !node.startsWith(r.dst) && !p.startsWith('.musicFolders')) outside.push(p)
			} else if (Array.isArray(node)) node.forEach((v, i) => walk(v, p + '[' + i + ']'))
			else if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], p + '.' + k)
		}
		walk(r.out, '')
		assert.deepStrictEqual(outside, [], 'these still point at his disk: ' + outside.join(', '))
		assert.ok(r.out.someFutureSetting.exportPath.startsWith(r.dst + path.sep))
	} finally { r.cleanup() }
})

test('read-only music roots are kept — a twin with no library is untestable', () => {
	const r = runMakeTwin({ musicFolders: ['/mnt/data/MUSIC', '/mnt/windows/Music'] })
	try {
		assert.deepStrictEqual(r.out.musicFolders, ['/mnt/data/MUSIC', '/mnt/windows/Music'])
	} finally { r.cleanup() }
})

test('the run prints the leak-style verification line', () => {
	const r = runMakeTwin({
		musicFolders: ['/mnt/data/MUSIC'],
		videoSettings: { streamCacheDir: '/mnt/windows/PapaAudioCache' },
	})
	try {
		assert.match(r.stdout, /0 settings point outside the twin/,
			'the operator must be told, in the same breath as the secret count, that no ' +
			'path escapes the twin. Got:\n' + r.stdout)
		assert.match(r.stdout, /re-pointed videoSettings\.streamCacheDir/)
	} finally { r.cleanup() }
})
