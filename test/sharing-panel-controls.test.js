'use strict'
// The Sharing panel is where sharing is managed.
//
// It used to only watch: a row per upload and the day's tally, while every
// control that decided what went out sat in Settings → Soulseek. Clicking a
// thing called "Sharing" and finding nothing you can change is the wrong
// answer, so the controls moved into the panel and Settings kept only the
// account and the download folder.
//
// Four things have to stay true for that to be an improvement rather than a
// rearrangement, and this file pins them:
//   1. the controls are in the panel, in the order they have to be read in;
//   2. the sidebar row is always there, because it is a destination now;
//   3. the panel scrolls, and re-reads its state on every open;
//   4. the ten-second live refresh cannot stamp over a tick he has made and
//      not yet applied.
// (That the controls are GONE from Settings is pinned in
// test/settings-soulseek-section.test.js, next to what Settings kept.)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const HTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
const R = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')
const TI = require(path.join(root, 'src', 'transfer-indicator.js'))

// The panel's markup, from its opening tag to the end of the file's next
// top-level block. Slicing at the Now Playing modal keeps it honest: an id
// that drifted out of the panel and down the page would stop matching.
function panelMarkup() {
	const at = HTML.indexOf('id="sharing-panel"')
	assert.ok(at > -1, '#sharing-panel must still exist')
	const end = HTML.indexOf('id="np-modal"', at)
	assert.ok(end > at, 'the Now Playing modal still follows the panel')
	return HTML.slice(at, end)
}

// One function's exact source, by brace counting, so it can be RUN rather than
// pattern-matched.
function liftFn(marker) {
	const start = R.indexOf(marker)
	assert.ok(start > -1, marker + ' must still exist in renderer.js')
	let i = R.indexOf('{', start)
	let depth = 0
	for (; i < R.length; i++) {
		if (R[i] === '{') depth++
		else if (R[i] === '}') { depth--; if (!depth) { i++; break } }
	}
	return R.slice(start, i)
}

// ── 1. the controls are in the panel ─────────────────────────────────────────

test('every Soulseek control he can change is inside the Sharing panel', () => {
	const inner = panelMarkup()
	for (const id of ['slsk-enabled', 'slsk-enabled-text', 'slsk-enabled-timer-btn',
		'slsk-share-count', 'slsk-share-list', 'slsk-share-busy',
		'slsk-share-add-btn', 'slsk-share-apply-btn', 'slsk-share-apply-hint',
		'slsk-share-text', 'slsk-upload-slots', 'slsk-upload-mbps',
		'slsk-upload-text']) {
		assert.ok(inner.includes('id="' + id + '"'),
			'#' + id + ' must be inside #sharing-panel')
	}
})

test('the controls are read top to bottom, and the live transfers come last', () => {
	// The off switch governs everything under it: with Soulseek off, the folder
	// ticks and the upload caps describe something that is not running, so it
	// has to be read first. The live rows are the result of all of it, so they
	// are last, under a divider.
	const inner = panelMarkup()
	const order = ['slsk-enabled', 'slsk-share-count', 'slsk-share-list',
		'slsk-share-apply-btn', 'slsk-upload-slots', 'slsk-upload-mbps',
		'sharing-list', 'sharing-today']
	const at = order.map(id => inner.indexOf('id="' + id + '"'))
	for (let i = 0; i < order.length; i++) {
		assert.ok(at[i] > -1, '#' + order[i] + ' must be in the panel')
		if (i) {
			assert.ok(at[i] > at[i - 1],
				'#' + order[i] + ' must come after #' + order[i - 1])
		}
	}
	assert.ok(inner.indexOf('sharing-divider') > at[order.indexOf('slsk-upload-mbps')],
		'the divider sits between the controls and the live half')
	assert.ok(inner.indexOf('sharing-divider') < at[order.indexOf('sharing-list')],
		'and above the transfer rows')
})

// ── 2. the sidebar row is a destination, not an alert ────────────────────────

test('the Sharing row is never hidden, whatever the counts say', () => {
	// The rule changed on purpose. The row used to appear only while a peer was
	// taking something or had taken something today; it is now the only way to
	// reach the Soulseek switch, the shared folders and the upload caps, and he
	// has to be able to get there on a completely quiet day.
	const row = /<li class="nav-item" data-page="sharing" id="nav-sharing"[^>]*>/.exec(HTML)
	assert.ok(row, 'the row still exists')
	assert.ok(!/\bhidden\b/.test(row[0]), 'and does not ship hidden: ' + row[0])

	// And the paint agrees: run it for real with nothing happening at all.
	const rowEl = { hidden: true, title: '' }
	const pillEl = {
		hidden: false, textContent: '',
		classList: { toggle() {} }, setAttribute() {},
	}
	const ctx = {
		document: {
			getElementById: id => (id === 'nav-sharing' ? rowEl
				: id === 'nav-sharing-pill' ? pillEl : null),
		},
		window: { PapaTransferIndicator: TI },
		_sharingStats: { daemon: true, activeUploads: 0, filesUploadedToday: 0 },
	}
	vm.createContext(ctx)
	vm.runInContext(
		R.match(/(?:const|var) SHARING_ROW_DEFAULT_TITLE = .*/)[0].replace(/^const\b/, 'var') +
		'\n' + liftFn('function _paintSharingPill(') + '\n_paintSharingPill()', ctx)
	assert.strictEqual(rowEl.hidden, false,
		'nothing in flight and nothing shared today still leaves the row in the sidebar')
	assert.strictEqual(pillEl.hidden, true, 'only the pill goes: a badge saying 0 is noise')
	assert.strictEqual(pillEl.textContent, '')
})

// ── 3. it behaves like a settings surface ────────────────────────────────────

test('the panel scrolls as one, with the day line pinned under it', () => {
	const inner = panelMarkup()
	const bodyAt = inner.indexOf('id="sharing-body"')
	assert.ok(bodyAt > -1, '#sharing-body is the scroller')
	// The day line must sit OUTSIDE the scrolling body, or it walks off the
	// bottom as soon as the folder list is long.
	const bodyEnd = inner.indexOf('</div>\n  <div class="sharing-today"')
	assert.ok(bodyEnd > bodyAt,
		'#sharing-today must close out of #sharing-body, not sit inside it')
	assert.match(CSS, /\.sharing-body \{[^}]*overflow-y:\s*auto/,
		'.sharing-body scrolls')
	assert.match(CSS, /\.sharing-body \{[^}]*min-height:\s*0/,
		'and can actually shrink inside the flex column, or it never scrolls at all')
	// The transfer list must not be a second scroller inside the first.
	assert.ok(!/<div class="queue-list sharing-list" id="sharing-list"/.test(HTML),
		'#sharing-list dropped .queue-list, which was flex:1 + overflow-y:auto')
})

test('opening the panel re-reads the controls rather than trusting the last paint', () => {
	const open = liftFn('function _openSharingPanel(')
	assert.match(open, /_repaintSharingSettings\(\)/,
		'a fresh read of the switch, the ticks and the caps on every open')
	assert.ok(open.indexOf('_repaintSharingSettings()') < open.indexOf('_renderSharingPanel()'),
		'before the live half is painted')
	// And nothing else re-reads them behind his back: the settings tab used to,
	// which would have thrown away a tick he had made in the panel.
	const tab = liftFn('function _switchMcsTab(')
	assert.ok(!tab.includes('_repaintSharingSettings'),
		'switching to Settings must not re-read the sharing controls any more')
})

// ── 4. the live refresh leaves his unapplied ticks alone ─────────────────────

// The panel painted live, against a fake document that also holds the folder
// checklist. Returns what the checklist looked like afterwards.
function refreshWithChecklist(stats) {
	const shareList = { id: 'slsk-share-list', innerHTML: '<b>his unapplied ticks</b>' }
	const sharingList = {
		id: 'sharing-list', innerHTML: '',
		querySelectorAll() { return [] },
	}
	const today = { id: 'sharing-today', textContent: '' }
	const touched = []
	const ctx = {
		document: {
			getElementById(id) {
				const el = id === 'slsk-share-list' ? shareList
					: id === 'sharing-list' ? sharingList
						: id === 'sharing-today' ? today : null
				if (el) touched.push(id)
				return el
			},
		},
		window: { PapaTransferIndicator: TI },
		_sharingStats: stats,
		esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
		_fmtSpeed: n => n + 'B/s',
		_closeSharingPanel() {},
		showSlskUserExplorer() {},
	}
	vm.createContext(ctx)
	vm.runInContext(
		liftFn('function _sharingRowHtml(') + '\n' +
		liftFn('function _renderSharingPanel(') + '\n_renderSharingPanel()', ctx)
	return { shareList, sharingList, today, touched }
}

test('a tick he has made and not applied survives the ten-second refresh', () => {
	// The hazard is real: this refresh replaces innerHTML, and the folder
	// checklist now lives in the same panel. If it ever redraws the whole
	// panel, every ten seconds his half-made choice is silently undone.
	const out = refreshWithChecklist({
		daemon: true,
		rows: [{ username: 'sherrybaaz', filename: '/music/Kind of Blue/01.flac',
			state: 'InProgress', percentComplete: 40, averageSpeed: 120000 }],
		filesUploadedToday: 3, totalUploadedToday: 900, distinctPeersToday: 2,
	})
	assert.strictEqual(out.shareList.innerHTML, '<b>his unapplied ticks</b>',
		'the folder checklist is not touched by the live refresh')
	assert.ok(out.sharingList.innerHTML.includes('sherrybaaz'),
		'while the live half did repaint')
	assert.ok(out.today.textContent.length > 0, 'and so did the day line')
	assert.ok(!out.touched.includes('slsk-share-list'),
		'the refresh does not even look the checklist up: ' + out.touched.join(', '))
})

test('the same holds on a quiet refresh, where the panel paints its empty state', () => {
	const out = refreshWithChecklist({
		daemon: true, rows: [],
		filesUploadedToday: 0, totalUploadedToday: 0, distinctPeersToday: 0,
	})
	assert.strictEqual(out.shareList.innerHTML, '<b>his unapplied ticks</b>')
	assert.match(out.sharingList.innerHTML, /Nobody is taking anything right now/)
})
