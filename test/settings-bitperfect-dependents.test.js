'use strict'
// Ticking Bit-perfect has to change the rest of the Playback page.
//
// It changed nothing. ReplayGain still read "track" and still looked live, the
// transition still read "crossfade", Output still read "System (shared)", and
// the gain line still warned "ReplayGain may raise quiet tracks" — while the
// checkbox's own hint, three rows down, said the mode turns all of those off
// and opens the device exclusively. Every claim on the page contradicted the
// one above it, and there was no way to tell which was true.
//
// main already collapses each of them. The page just never asked again: the
// handler set state.bitPerfect locally and repainted a badge. It now re-reads
// playerGetConfig() and paints what is actually in force.
//
// Two further things were promised and never enforced: the loudness-scan
// leveling went on scaling mpv's volume, and the +30% boost went on being
// folded into the base volume. Those are pinned here too.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const bp = require('../src/bit-perfect.js')
const gain = require('../src/gain-policy.js')

function lift(name) {
	for (const kw of ['\nasync function ', '\nfunction ']) {
		const start = SRC.indexOf(kw + name + '(')
		if (start === -1) continue
		const a = SRC.indexOf('\nfunction ', start + 1)
		const b = SRC.indexOf('\nasync function ', start + 1)
		const stop = [a, b].filter(n => n > -1).sort((x, y) => x - y)[0]
		return SRC.slice(start, stop === undefined ? undefined : stop)
	}
	assert.fail(name + ' must still exist as a top-level function in renderer.js')
}

// main.js's getPlayerSettings(), the part the settings page reads back. Built
// from the REAL bit-perfect module, so it cannot drift from the production rule.
function resolveSettings(saved) {
	const on = saved.bitPerfect === true
	const seconds = Number(saved.crossfadeSeconds) || 0
	const rg = bp.effectiveReplaygain({ replaygain: saved.replaygain, bitPerfect: on })
	const lvl = bp.effectiveLoudnessLeveling({ replaygainApply: saved.replaygainApply === true, bitPerfect: on })
	const boost = bp.effectiveBoost({ boost: saved.boost === true, bitPerfect: on })
	return {
		outputMode: saved.outputMode || 'default',
		replaygain: saved.replaygain || 'no',
		boost: saved.boost === true,
		replaygainApply: saved.replaygainApply === true,
		bitPerfect: on,
		exclusivityNote: bp.EXCLUSIVITY_NOTE,
		crossfadeSeconds: seconds,
		mode: seconds > 0 && !bp.forcesGapless(on) ? 'crossfade' : 'gapless',
		crossfadeSecs: seconds > 0 ? seconds : 4,
		replaygainEffective: rg.mode,
		replaygainSuppressedReason: rg.reason,
		replaygainApplyEffective: lvl.on,
		replaygainApplySuppressedReason: lvl.reason,
		boostEffective: boost.on,
		boostSuppressedReason: boost.reason,
		outputModeEffective: on ? 'exclusive' : (saved.outputMode || 'default'),
	}
}

function stubDom() {
	const els = new Map()
	const rows = new Map()
	const make = id => {
		const row = { cls: new Set(), classList: null }
		row.classList = {
			toggle(name, force) { force ? row.cls.add(name) : row.cls.delete(name) },
			contains: name => row.cls.has(name),
		}
		rows.set(id, row)
		return {
			id, value: '', checked: false, disabled: false, textContent: '',
			style: {}, attrs: {},
			closest: () => row,
			setAttribute(k, v) { this.attrs[k] = v },
			removeAttribute(k) { delete this.attrs[k]; if (k === 'title') this.title = undefined },
		}
	}
	return {
		rows,
		getElementById(id) {
			if (!els.has(id)) els.set(id, make(id))
			return els.get(id)
		},
	}
}

function paint(saved) {
	const document = stubDom()
	const ctx = vm.createContext({ document, console, Number, Boolean })
	vm.runInContext(lift('_paintBitPerfectDependents'), ctx)
	const cfg = resolveSettings(saved)
	ctx.__cfg = cfg
	vm.runInContext('_paintBitPerfectDependents(__cfg)', ctx)
	return { cfg, el: id => document.getElementById(id), row: id => document.rows.get(id) }
}

const LIVE = { replaygain: 'track', replaygainApply: true, boost: true, crossfadeSeconds: 8, outputMode: 'default' }

test('with bit-perfect off, nothing is disabled and the choices stand', () => {
	const p = paint(LIVE)
	for (const id of ['pb-output-mode', 'pb-mode', 'pb-replaygain', 'pb-replaygain-apply', 'pb-boost']) {
		assert.strictEqual(p.el(id).disabled, false, id + ' must stay usable')
	}
	assert.strictEqual(p.el('pb-replaygain').value, 'track')
	assert.strictEqual(p.el('pb-mode').value, 'crossfade')
	assert.strictEqual(p.el('pb-boost').checked, true)
	assert.strictEqual(p.el('pb-replaygain-apply').checked, true)
})

test('ticking it disables every control it overrules', () => {
	const p = paint({ ...LIVE, bitPerfect: true })
	for (const id of ['pb-output-mode', 'pb-mode', 'pb-cf-secs', 'pb-replaygain', 'pb-replaygain-apply', 'pb-boost']) {
		assert.strictEqual(p.el(id).disabled, true, id + ' still looks live while bit-perfect ignores it')
		assert.ok(p.row(id).classList.contains('mcs-set-row-overruled'), id + '\'s row must go quiet too')
	}
})

test('and each one says why, on itself', () => {
	const p = paint({ ...LIVE, bitPerfect: true })
	for (const id of ['pb-mode', 'pb-replaygain', 'pb-replaygain-apply', 'pb-boost']) {
		assert.match(String(p.el(id).title || ''), /bit-perfect/i,
			id + ' must carry the reason, not just go grey')
	}
	assert.match(p.el('pb-replaygain').title, /scales the samples/i)
	assert.match(p.el('pb-replaygain-apply').title, /volume leveling stays off/i)
	assert.match(p.el('pb-boost').title, /above unity/i)
})

test('and the values shown are what is actually in force', () => {
	const p = paint({ ...LIVE, bitPerfect: true })
	assert.strictEqual(p.el('pb-replaygain').value, 'no', 'ReplayGain reads Off, not "track"')
	assert.strictEqual(p.el('pb-mode').value, 'gapless', 'the transition reads Gapless, not Crossfade')
	assert.strictEqual(p.el('pb-output-mode').value, 'exclusive', 'the output reads Exclusive, not System (shared)')
	assert.strictEqual(p.el('pb-boost').checked, false)
	assert.strictEqual(p.el('pb-replaygain-apply').checked, false)
	assert.strictEqual(p.el('pb-cf-row').style.display, 'none', 'and crossfade length is gone')
	assert.strictEqual(p.el('pb-device-row').style.display, '', 'while the device picker appears')
})

test('the page spells the reason out in full, not only as a tooltip', () => {
	const p = paint({ ...LIVE, bitPerfect: true })
	assert.strictEqual(p.el('pb-bitperfect-active-note').style.display, '')
	assert.match(p.el('pb-bitperfect-active-note').textContent, /exact samples/i)
	const off = paint(LIVE)
	assert.strictEqual(off.el('pb-bitperfect-active-note').style.display, 'none')
})

test('turning it back off restores his own choices', () => {
	const saved = { ...LIVE, bitPerfect: true }
	paint(saved)
	const after = paint({ ...saved, bitPerfect: false })
	assert.strictEqual(after.el('pb-replaygain').value, 'track', 'his preference was kept, not overwritten')
	assert.strictEqual(after.el('pb-mode').value, 'crossfade')
	assert.strictEqual(after.el('pb-boost').checked, true)
	for (const id of ['pb-replaygain', 'pb-boost']) {
		assert.strictEqual(after.el(id).disabled, false)
		assert.ok(!after.row(id).classList.contains('mcs-set-row-overruled'))
	}
})

test('the gain line stops warning about ReplayGain that is not running', () => {
	const on = resolveSettings({ ...LIVE, bitPerfect: true })
	const r = gain.assess({
		boost: on.boostEffective, replaygain: on.replaygain,
		replaygainEffective: on.replaygainEffective,
		replaygainApply: on.replaygainApplyEffective, bitPerfect: true,
	})
	assert.doesNotMatch(r.text, /ReplayGain may raise quiet tracks/,
		'nothing is raising anything while bit-perfect is on')
	assert.doesNotMatch(r.text, /Volume leveling from the loudness scan is on/)

	const off = resolveSettings(LIVE)
	const r2 = gain.assess({
		boost: off.boostEffective, replaygain: off.replaygain,
		replaygainEffective: off.replaygainEffective,
		replaygainApply: off.replaygainApplyEffective, bitPerfect: false,
	})
	assert.match(r2.text, /ReplayGain may raise quiet tracks/, 'and it still warns when it should')
})

test('the toggle handler re-reads the settings instead of guessing', () => {
	const init = SRC.slice(SRC.indexOf('async function initPlaybackSettings('))
	const handler = init.slice(init.indexOf("$('pb-bitperfect').onchange"))
		.slice(0, 900)
	assert.match(handler, /playerGetConfig\(\)/,
		'the page must ask main what is now in force — that is the whole fix')
	assert.match(handler, /_paintBitPerfectDependents/)
})

test('main really does suppress the leveling and the boost, not just say so', () => {
	// The hint promised both for months while nothing enforced either.
	assert.match(MAIN, /if \(!cfg\.replaygainApplyEffective\)/,
		'applyLoudnessGain must gate on the effective value')
	assert.match(MAIN, /linearToMpv\(lastLinearVolume, cfg\.boostEffective\)/)
	assert.match(MAIN, /linearToMpv\(linear, getPlayerSettings\(\)\.boostEffective\)/)
	assert.match(MAIN, /replaygainApplyEffective: levelingEffective\.on/)
	assert.match(MAIN, /boostEffective: boostEffective\.on/)
})

test('the policy module keeps the two new rules honest', () => {
	assert.deepStrictEqual(
		bp.effectiveLoudnessLeveling({ replaygainApply: true, bitPerfect: false }),
		{ on: true, requested: true, suppressed: false, reason: '' })
	const s = bp.effectiveLoudnessLeveling({ replaygainApply: true, bitPerfect: true })
	assert.strictEqual(s.on, false)
	assert.strictEqual(s.suppressed, true)
	assert.ok(s.reason.length > 20, 'a suppression must come with words')
	assert.strictEqual(bp.effectiveBoost({ boost: true, bitPerfect: true }).on, false)
	assert.strictEqual(bp.effectiveBoost({ boost: true, bitPerfect: false }).on, true)
	// Nothing is "suppressed" that was never asked for.
	assert.strictEqual(bp.effectiveBoost({ boost: false, bitPerfect: true }).suppressed, false)
})
