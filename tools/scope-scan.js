'use strict'
// Finds the bug class that killed the video detail page (_playOnArrival,
// 10d4662) and the Library page (_moodDef): a top-level function that reads an
// identifier which is only ever declared INSIDE some other function.
//
// The renderer is one huge sloppy-mode classic script. An assignment to an
// undeclared name quietly makes a global, but a READ of a name that has never
// been assigned throws ReferenceError — and inside an async renderer that
// throw is a permanently grey page, not a message. No amount of unit testing
// sees it, because the function under test is usually called with its sibling
// already on the stack.
//
// Usage:  node tools/scope-scan.js src/renderer.js [more files...]
// Exits non-zero (and prints one line per finding) if anything is found.

const fs = require('fs')
const path = require('path')
const acorn = require('acorn')

const FN = { FunctionDeclaration: 1, FunctionExpression: 1, ArrowFunctionExpression: 1 }

function walk(node, visit, parent) {
	if (!node || typeof node.type !== 'string') return
	visit(node, parent)
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
		const v = node[key]
		if (Array.isArray(v)) {
			for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node)
		} else if (v && typeof v.type === 'string') {
			walk(v, visit, node)
		}
	}
}

// Every name a binding pattern introduces: plain, destructured, rest, default.
function patternNames(p, out) {
	if (!p) return out
	switch (p.type) {
		case 'Identifier': out.push(p.name); break
		case 'ObjectPattern': p.properties.forEach(pr => patternNames(pr.value || pr.argument, out)); break
		case 'ArrayPattern': p.elements.forEach(e => patternNames(e, out)); break
		case 'AssignmentPattern': patternNames(p.left, out); break
		case 'RestElement': patternNames(p.argument, out); break
	}
	return out
}

// Everything a function closes over from itself: params, vars, lets, consts,
// nested function and class names, nested params, catch params. Deliberately
// flat — `var` hoists to the function anyway, and for this check treating a
// block-scoped inner name as "declared here" only ever makes us quieter.
function declaredWithin(fn) {
	const names = new Set()
	patternNames({ type: 'ArrayPattern', elements: fn.params }, []).forEach(n => names.add(n))
	walk(fn.body, n => {
		if (n.type === 'VariableDeclarator') patternNames(n.id, []).forEach(x => names.add(x))
		if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) names.add(n.id.name)
		if (FN[n.type]) {
			patternNames({ type: 'ArrayPattern', elements: n.params }, []).forEach(x => names.add(x))
			if (n.id) names.add(n.id.name)
		}
		if (n.type === 'CatchClause' && n.param) patternNames(n.param, []).forEach(x => names.add(x))
	})
	return names
}

// A name in a position that READS it, as opposed to declaring or labelling it.
function isRead(node, parent) {
	if (node.type !== 'Identifier' || !parent) return node.type === 'Identifier'
	if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false
	if (parent.type === 'Property' && parent.key === node && !parent.computed) return false
	if (parent.type === 'VariableDeclarator' && parent.id === node) return false
	if (FN[parent.type] && (parent.id === node || parent.params.includes(node))) return false
	if (parent.type === 'ClassDeclaration' && parent.id === node) return false
	if (parent.type === 'CatchClause' && parent.param === node) return false
	if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
		parent.type === 'ContinueStatement') return false
	if (parent.type === 'AssignmentPattern' && parent.left === node) return false
	if (parent.type === 'RestElement' || parent.type === 'ArrayPattern' ||
		parent.type === 'ObjectPattern') return false
	return true
}

function scanSource(src, filename) {
	const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true })

	const topNames = new Set()
	for (const n of ast.body) {
		if (n.type === 'VariableDeclaration') {
			n.declarations.forEach(d => patternNames(d.id, []).forEach(x => topNames.add(x)))
		} else if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) {
			topNames.add(n.id.name)
		}
	}

	const topFns = ast.body.filter(n => n.type === 'FunctionDeclaration' && n.id)
	const localsOf = new Map()
	for (const f of topFns) localsOf.set(f.id.name, declaredWithin(f))

	// The narrowing that makes this quiet enough to be a test: only names that
	// exist SOMEWHERE as another top-level function's local. A genuinely unknown
	// global (a browser API, a window.* script's export) is not this bug class.
	const ownerOf = new Map()
	for (const [fname, set] of localsOf) {
		for (const n of set) if (!topNames.has(n) && !ownerOf.has(n)) ownerOf.set(n, fname)
	}

	const findings = []
	const seen = new Set()
	for (const f of topFns) {
		const mine = localsOf.get(f.id.name)
		walk(f.body, (n, parent) => {
			if (n.type !== 'Identifier' || !isRead(n, parent)) return
			const name = n.name
			if (mine.has(name) || topNames.has(name)) return
			const owner = ownerOf.get(name)
			if (!owner || owner === f.id.name) return
			const key = f.id.name + '|' + name
			if (seen.has(key)) return
			seen.add(key)
			findings.push({ file: filename, line: n.loc.start.line, fn: f.id.name, name, owner })
		})
	}
	return findings
}

function scanFile(file) {
	return scanSource(fs.readFileSync(file, 'utf8'), path.basename(file))
}

function format(f) {
	return `${f.file}:${f.line}  ${f.fn}() reads ${f.name}, which is only declared inside ${f.owner}()`
}

module.exports = { scanSource, scanFile, format }

if (require.main === module) {
	const files = process.argv.slice(2)
	if (!files.length) {
		console.error('usage: node tools/scope-scan.js <file.js> [...]')
		process.exit(2)
	}
	let n = 0
	for (const file of files) for (const f of scanFile(file)) { console.log(format(f)); n++ }
	console.log(n ? `${n} cross-function scope read(s)` : 'clean')
	process.exit(n ? 1 : 0)
}
