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
//
// Three shapes reach a declaration too early, and all three are checked:
//   const X = make(...)        — the callee
//   const X = obj.make(...)    — the object a method is called on
//   const X = make(laterConst) — a value passed in, evaluated before the call
// The first is what happened on 17 Sep. The other two were found by an
// adversarial read of this file and were invisible to it: the callee regex
// required the identifier to be followed immediately by '(', and nothing
// looked at arguments at all.

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

// Words that look like references but are not.
const NOT_A_REFERENCE = new Set([
  'new', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'await',
  'true', 'false', 'null', 'undefined', 'this', 'function', 'return', 'yield',
])

// The identifiers an initializer READS as it runs. Passing something into a
// call reaches it exactly as hard as calling it: `const X = make(laterConst)`
// is the same dead zone as `const X = laterConst()`.
//
// Text, not a parser, so it is deliberately conservative: a callback body runs
// after the module has loaded, so scanning stops at the first one rather than
// reading its contents as load-time references.
function argumentIdentifiers(text) {
  const deferred = text.search(/=>|\bfunction\b/)
  let src = deferred === -1 ? text : text.slice(0, deferred)
  // Nothing inside a literal is a reference.
  src = src.replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  const names = []
  const re = /[A-Za-z_$][\w$]*/g
  let m
  while ((m = re.exec(src))) {
    if (src[m.index - 1] === '.') continue               // a property name
    if (/^\s*:/.test(src.slice(m.index + m[0].length))) continue   // an object key
    if (NOT_A_REFERENCE.has(m[0])) continue
    names.push(m[0])
  }
  return names
}

// Top-level `const X = someCall(...)` — an initializer that RUNS at load.
//
// The callee is taken as its ROOT identifier, so `const X = db.open(...)` is
// recorded against `db`: calling a method on an object that has not been
// declared yet dies in the same place and for the same reason as calling a
// function that has not been declared yet, and the earlier version of this
// regex could not see that shape at all — it required the identifier to be
// followed immediately by '(', and in `db.open(` it is followed by '.'.
function topLevelInitializerCalls(lines = LINES) {
  const calls = []
  lines.forEach((line, i) => {
    const m = /^(?:const|let|var)\s+(?:\w+|\{[^}]*\})\s*=\s*(?:new\s+)?([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(line)
    if (!m) return
    calls.push({
      callee: m[1],
      path: m[2] || '',
      args: argumentIdentifiers(line.slice(m[0].length)),
      line: i,
    })
  })
  return calls
}

function analyse(lines = LINES) {
  const decls = topLevelDeclarations(lines)
  const problems = []
  // Declared at column 0, below this line, and not a hoisted function.
  const declaredLater = (name, line) => {
    if (!decls.has(name)) return false        // a global, or imported elsewhere
    const at = decls.get(name)
    return at !== -1 && at > line
  }
  for (const { callee, path: memberPath, args, line } of topLevelInitializerCalls(lines)) {
    const where = `main.js:${line + 1}`
    if (declaredLater(callee, line)) {
      const at = `main.js:${decls.get(callee) + 1}`
      problems.push(memberPath
        ? `${callee}${memberPath} is called at ${where} but ${callee} is declared at ${at}`
        : `${callee} is called at ${where} but declared at ${at}`)
    }
    for (const name of new Set(args)) {
      if (name === callee) continue           // already reported as the callee
      if (declaredLater(name, line)) {
        problems.push(`${name} is passed at ${where} but declared at main.js:${decls.get(name) + 1}`)
      }
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

// ── The two shapes the first version of this guard could not see ────────────
//
// An adversarial read of the analyser found both. Each runs the REAL detector
// over a synthetic file, for the same reason the self-test above does: a
// self-test that re-implements the detector keeps passing after the detector
// stops working.

test('a method called on an object declared later is caught', () => {
  // `const X = obj.method(...)`. The object has to exist for the property to
  // be read at all, so this dies in exactly the same place as calling a
  // function too early — and the old regex could not even see it, because it
  // required the identifier to be followed immediately by '('.
  const broken = [
    "const conn = store.open('library')",
    "const store = require('./src/store')",
  ]
  const found = analyse(broken)
  assert.strictEqual(found.length, 1, 'a member call on a later declaration must be detected')
  assert.match(found[0], /store\.open is called at main\.js:1 but store is declared at main\.js:2/)
})

test('a deeper member path is still reported against its root object', () => {
  const broken = [
    "const dir = paths.user.config()",
    "const paths = require('./src/paths')",
  ]
  const found = analyse(broken)
  assert.strictEqual(found.length, 1)
  assert.match(found[0], /paths\.user\.config is called at main\.js:1/)
})

test('a value PASSED to an initializer is caught, not just the callee', () => {
  // `const X = make(laterConst)`. The argument is evaluated before the call,
  // so it is read at load just like the callee, and it throws just as hard.
  const broken = [
    "const engine = makeEngine(SETTINGS)",
    "function makeEngine(s) { return s }",
    "const SETTINGS = { volume: 80 }",
  ]
  const found = analyse(broken)
  assert.strictEqual(found.length, 1, 'the argument is the defect here, and the callee is fine')
  assert.match(found[0], /SETTINGS is passed at main\.js:1 but declared at main\.js:3/)
})

test('an argument inside an object literal is still an argument', () => {
  const broken = [
    "const engine = makeEngine({ store: LIBRARY, retries: 3 })",
    "function makeEngine(o) { return o }",
    "const LIBRARY = '/mnt/data/MUSIC'",
  ]
  const found = analyse(broken)
  assert.strictEqual(found.length, 1)
  assert.match(found[0], /LIBRARY is passed at main\.js:1 but declared at main\.js:3/)
})

test('both faults on one line are both reported', () => {
  const broken = [
    "const engine = store.build(SETTINGS)",
    "const store = require('./src/store')",
    "const SETTINGS = {}",
  ]
  assert.strictEqual(analyse(broken).length, 2)
})

// ── And the things that are NOT faults stay quiet ───────────────────────────

test('a member call on something declared EARLIER is fine', () => {
  const fine = [
    "const store = require('./src/store')",
    "const conn = store.open('library')",
  ]
  assert.deepStrictEqual(analyse(fine), [])
})

test('a member call inside a function body is fine', () => {
  const fine = [
    "function open() { return store.open('library') }",
    "const store = require('./src/store')",
  ]
  assert.deepStrictEqual(analyse(fine), [], 'the function runs after the module has loaded')
})

test('an argument read inside a callback body is fine', () => {
  // The callback runs later, so the reference is not made at load. Flagging it
  // would be noise, and noise gets the whole guard silenced.
  const fine = [
    "const off = bus.on('ready', () => start(SETTINGS))",
    "const bus = require('./src/bus')",
    "const SETTINGS = {}",
  ]
  const found = analyse(fine)
  assert.strictEqual(found.length, 1, 'only the object the method is called on')
  assert.match(found[0], /bus\.on is called/)
})

test('a hoisted function passed as an argument is fine', () => {
  const fine = [
    "const engine = makeEngine(onReady)",
    "function makeEngine(f) { return f }",
    "function onReady() {}",
  ]
  assert.deepStrictEqual(analyse(fine), [], 'function declarations hoist, wherever they are used')
})

test('a property name is not a reference to a variable of the same name', () => {
  const fine = [
    "const size = opts.cache('small')",
    "const opts = {}",
    "const cache = 1",
  ]
  const found = analyse(fine)
  assert.strictEqual(found.length, 1, 'opts is the only fault; .cache is a property')
  assert.match(found[0], /opts\.cache is called/)
})

test('an object KEY is not a reference either', () => {
  const fine = [
    "const engine = makeEngine({ store: 1 })",
    "function makeEngine(o) { return o }",
    "const store = require('./src/store')",
  ]
  assert.deepStrictEqual(analyse(fine), [], '{ store: 1 } names a key, it does not read `store`')
})

test('a name that only appears inside a string is not a reference', () => {
  const fine = [
    "const engine = makeEngine('SETTINGS')",
    "function makeEngine(s) { return s }",
    "const SETTINGS = {}",
  ]
  assert.deepStrictEqual(analyse(fine), [])
})
