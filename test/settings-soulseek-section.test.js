'use strict'
// Two messages told people to "check them in Settings → Soulseek". There was
// no Soulseek section in Settings: the account modal could only be opened from
// the shop's own config button, and only while the daemon was unconfigured.
// The advice named a place that did not exist.
//
// This checks the markup carries the block, and lifts the real init function
// so the account button genuinely reaches the existing modal and the folder
// button genuinely reaches the existing picker -- no new IPC.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(decl) {
	const at = R.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in renderer.js')
	let i = R.indexOf('{', at) + 1
	let depth = 1
	while (depth > 0 && i < R.length) {
		const c = R[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return R.slice(at, i)
}

const INIT = liftFn('async function _initSoulseekAccountSettings() {')

test('Settings has a Soulseek block, at the id the copy can link to', () => {
	assert.ok(/id="soulseek-settings"/.test(HTML),
		'openSettings("soulseek") resolves to #soulseek-settings')
	const block = HTML.slice(HTML.indexOf('id="soulseek-settings"'))
	const end = block.indexOf('id="video-settings"')
	const inner = block.slice(0, end)
	assert.ok(/id="slsk-account-btn"/.test(inner), 'the account button must be in the block')
	assert.ok(/id="slsk-folder-btn"/.test(inner), 'the download folder must be in the block')
	assert.ok(/id="slsk-share-mode"/.test(inner), 'sharing stays where it was')
})

function node(id) {
	return {
		id, textContent: '', title: '', listeners: {},
		addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
		click() { return Promise.all((this.listeners.click || []).map(fn => fn())) },
	}
}

function run(status, dir, { setDir } = {}) {
	const els = {
		'slsk-account-btn': node('slsk-account-btn'),
		'slsk-account-text': node('slsk-account-text'),
		'slsk-folder-btn': node('slsk-folder-btn'),
		'slsk-folder-label': node('slsk-folder-label'),
	}
	const log = []
	const env = { els, log, status, dir, setDir }
	return new Function('env', `
		const { els, log } = env
		let _dlDownloadDir = null
		const slsk = { lastQuery: 'kind of blue' }
		const document = { getElementById(id) { return els[id] || null } }
		const window = { api: {
			slskStatus() { return Promise.resolve(env.status) },
			slskGetDownloadDir() { return Promise.resolve(env.dir) },
			slskSetDownloadDir() { log.push('picker'); return Promise.resolve(env.setDir) },
		} }
		function showSlskConfigModal(q) { log.push('config-modal:' + String(q)) }
		function showSnackbar(m) { log.push('say:' + String(m)) }
		${INIT}
		return _initSoulseekAccountSettings()
	`)(env).then(() => ({ els, log }))
}

test('the account button opens the Soulseek account modal', async () => {
	const { els, log } = await run({ connected: true, configured: true, username: 'sherrybaaz' }, '/mnt/data/MUSIC/Downloads')
	await els['slsk-account-btn'].click()
	assert.ok(log.some(l => l.startsWith('config-modal:')), JSON.stringify(log))
})

test('the block says whether the daemon is actually signed in', async () => {
	const a = await run({ connected: true, configured: true, username: 'sherrybaaz' }, '/x')
	assert.strictEqual(a.els['slsk-account-text'].textContent, 'Connected as sherrybaaz.')
	const b = await run({ connected: false, configured: true }, '/x')
	assert.ok(/not connected/.test(b.els['slsk-account-text'].textContent))
	const c = await run({ connected: false, configured: false }, '/x')
	assert.ok(/No Soulseek account/.test(c.els['slsk-account-text'].textContent))
})

test('the download folder shows the current folder and changing it goes through the existing picker', async () => {
	const { els, log } = await run({ connected: true, configured: true }, '/mnt/data/MUSIC/Downloads',
		{ setDir: { ok: true, downloadDir: '/mnt/data/MUSIC/Other' } })
	assert.strictEqual(els['slsk-folder-label'].textContent, 'Downloads')
	await els['slsk-folder-btn'].click()
	assert.ok(log.includes('picker'))
	assert.strictEqual(els['slsk-folder-label'].textContent, 'Other')
})

test('a folder the daemon will not accept is reported, not silently ignored', async () => {
	const { els, log } = await run({ connected: true }, '/mnt/data/MUSIC/Downloads',
		{ setDir: { ok: false, error: 'that folder is not writable' } })
	await els['slsk-folder-btn'].click()
	assert.ok(log.includes('say:that folder is not writable'), JSON.stringify(log))
	assert.strictEqual(els['slsk-folder-label'].textContent, 'Downloads', 'the label must not lie about the change')
})
