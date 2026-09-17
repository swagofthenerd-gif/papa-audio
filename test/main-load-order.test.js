'use strict'
// main.js must be able to finish loading.
//
// On 17 Sep a require was placed at line 4914 while the module-scope const that
// CALLS it sat at line 4269. At module scope that is the temporal dead zone:
// main.js threw partway through loading, every declaration after that point
// stayed uninitialised, and handlers registered earlier fired against consts
// that no longer existed. The app opened and sat there.
//
// `node --check` passes on that file, because it is a runtime error, not a
// syntax one. And no test in the suite loads main.js, so 4,900 tests were green
// while the app could not start. This is that missing guard.
//
// It reasons only about TOP-LEVEL statements — the ones that execute during
// module evaluation. A reference inside a function body is fine, because the
// function runs later.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'main.js')
const SRC = fs.readFileSync(FILE, 'utf8')
const LINES = SRC.split('\n')

// In this file every top-level declaration starts at column 0. Anything
// indented is inside a block, and runs later.
function topLevelDeclarations(lines = LINES) {
  const decls = new Map()   // name -> line index
  lines.forEach((line, i) => {
    let m = /^(?:const|let|var)\s+(\w+)\s*=/.exec(line)
    if (m) { if (!decls.has(m[1])) decls.set(m[1], i); return }
    // Destructured: const { a, b } = require(...)
    m = /^(?:const|let|var)\s+\{([^}]+)\}\s*=/.exec(line)
    if (m) {
      for (const raw of m[1].split(',')) {
        const name = raw.split(':').pop().trim()
        if (name && !decls.has(name)) decls.set(name, i)
      }
      return
    }
    m = /^(?:async\s+)?function\s+(\w+)\s*\(/.exec(line)
    // Function declarations hoist, so they are available from line 0.
    if (m && !decls.has(m[1])) decls.set(m[1], -1)
  })
  return decls
}

// Top-level `const X = someCall(...)` — an initializer that RUNS at load.
function topLevelInitializerCalls(lines = LINES) {
  const calls = []
  lines.forEach((line, i) => {
    const m = /^(?:const|let|var)\s+(?:\w+|\{[^}]*\})\s*=\s*(?:new\s+)?(\w+)\s*\(/.exec(line)
    if (m) calls.push({ callee: m[1], line: i })
  })
  return calls
}

function analyse(lines = LINES) {
  const decls = topLevelDeclarations(lines)
  const problems = []
  for (const { callee, line } of topLevelInitializerCalls(lines)) {
    if (!decls.has(callee)) continue          // a global, or imported elsewhere
    const at = decls.get(callee)
    if (at === -1) continue                   // hoisted function declaration
    if (at > line) {
      problems.push(`${callee} is called at main.js:${line + 1} but declared at main.js:${at + 1}`)
    }
  }
  return problems
}

test('no top-level initializer calls something declared later in the file', () => {
  const problems = analyse()
  assert.deepStrictEqual(problems, [],
    'a module-scope const used before its declaration aborts main.js while it loads, ' +
    'and every declaration after that point stays uninitialised:\n  ' + problems.join('\n  '))
})

test('every require of a local ./src module resolves', () => {
  // A typo'd path throws at load in exactly the same place, with the same
  // consequence, and node --check will not see it either.
  const missing = []
  const re = /require\(\s*'(\.\/[^']+)'\s*\)/g
  let m
  while ((m = re.exec(SRC))) {
    const spec = m[1]
    const base = path.join(__dirname, '..', spec)
    const ok = fs.existsSync(base) || fs.existsSync(base + '.js') ||
               fs.existsSync(path.join(base, 'index.js'))
    if (!ok) missing.push(spec)
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'these requires point at nothing')
})

test('the guard can actually see the defect it exists for', () => {
  // Runs the REAL detector over a synthetic file, rather than re-checking its
  // regexes by hand. A self-test that mirrors the implementation passes even
  // after the implementation stops working, which is the exact failure class
  // this file exists to catch.
  const broken = [
    "const thing = makeThing({ a: 1 })",
    "const { makeThing } = require('./src/thing')",
  ]
  const found = analyse(broken)
  assert.strictEqual(found.length, 1, 'the 17 Sep defect shape must be detected')
  assert.match(found[0], /makeThing is called at main\.js:1 but declared at main\.js:2/)
})

test('and does NOT fire on a use inside a function body', () => {
  // Those run after the module has finished loading, so a later require is
  // fine. A guard that flagged them would be noise, and noise gets silenced.
  const fine = [
    "function useIt() { return makeThing({ a: 1 }) }",
    "const { makeThing } = require('./src/thing')",
  ]
  assert.deepStrictEqual(analyse(fine), [])
})

test('a hoisted function declaration is never a problem', () => {
  const fine = [
    "const x = helper()",
    "function helper() { return 1 }",
  ]
  assert.deepStrictEqual(analyse(fine), [], 'function declarations hoist')
})
