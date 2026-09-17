'use strict'
// The On-device card's Play and Delete buttons must be visible without hovering
// (2026-09-17).
//
// `.vcard-actions { opacity:0 }` is right for a catalogue poster — the actions
// there are secondary to the picture. On the On-device page the actions ARE the
// page: playing the file and deleting it are the only two things the surface
// exists to do. Hiding them until the pointer is over the card is a large part
// of "i cant even delete them man", and it contradicts the project's own
// default (CLAUDE.md rule 5: play buttons always visible, opacity .85).
//
// This does not grep the stylesheet for a string. It parses the real rules,
// computes specificity, and RESOLVES the cascade for the actual element chain
// the page renders — so a later rule that re-hides the buttons fails here even
// though the declaration this fix added is still present in the file.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

// ── A cascade resolver, for the selector shapes this stylesheet uses ─────────
// Descendant combinators of compound class selectors, with optional
// pseudo-classes. Anything it cannot parse is skipped rather than guessed at.
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, '') }

// Top-level rules only: @media blocks are collected separately so a
// reduced-motion override cannot be mistaken for the resting state.
function topLevelRules(css) {
  const rules = []
  let i = 0
  while (i < css.length) {
    const brace = css.indexOf('{', i)
    if (brace === -1) break
    const prelude = css.slice(i, brace).trim()
    let depth = 1
    let j = brace + 1
    for (; j < css.length && depth; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
    }
    const body = css.slice(brace + 1, j - 1)
    if (prelude.startsWith('@')) {
      // At-rules that wrap rules (media, supports) contribute nothing to the
      // resting state; at-rules that do not (font-face, keyframes) contribute
      // nothing at all. Either way, skipped here deliberately.
    } else if (prelude) {
      rules.push({ selectors: splitSelectors(prelude), body: body })
    }
    i = j
  }
  return rules
}

// Commas inside :is()/:not() are not selector separators.
function splitSelectors(prelude) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of prelude) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// A compound like `.cinema` or `.vcard:hover` or `article.vcard-x`.
function parseCompound(text) {
  const classes = []
  const states = []
  let ok = true
  const re = /(::?[a-zA-Z-]+(?:\([^)]*\))?)|\.([A-Za-z0-9_-]+)|([A-Za-z][A-Za-z0-9-]*)|(\[[^\]]*\])|(#[A-Za-z0-9_-]+)/g
  let m
  let consumed = 0
  while ((m = re.exec(text))) {
    consumed += m[0].length
    if (m[1]) states.push(m[1])
    else if (m[2]) classes.push(m[2])
    else if (m[3]) { /* a tag name; every selector here that uses one is fine */ }
    else ok = false
  }
  if (consumed !== text.length) ok = false
  return ok ? { classes, states } : null
}

function parseSelector(sel) {
  if (/[>+~]/.test(sel)) return null          // not used by the rules under test
  const parts = sel.trim().split(/\s+/).map(parseCompound)
  return parts.every(Boolean) ? parts : null
}

function specificity(parts) {
  let b = 0
  for (const p of parts) b += p.classes.length + p.states.length
  return b
}

// Does `parts` match the element at the end of `chain`? Descendant matching,
// right to left.
function matches(parts, chain) {
  const fits = (p, el) =>
    p.classes.every(c => el.classes.includes(c)) &&
    p.states.every(s => el.states.includes(s))
  let pi = parts.length - 1
  let ci = chain.length - 1
  if (!fits(parts[pi], chain[ci])) return false
  pi--; ci--
  while (pi >= 0) {
    let found = false
    while (ci >= 0) {
      if (fits(parts[pi], chain[ci])) { found = true; ci--; break }
      ci--
    }
    if (!found) return false
    pi--
  }
  return true
}

function declarations(body, prop) {
  const out = []
  const re = new RegExp('(^|[;{])\\s*' + prop + '\\s*:\\s*([^;}]+)', 'g')
  let m
  while ((m = re.exec(body))) out.push(m[2].trim())
  return out
}

// The winning value of `prop` for the element at the end of `chain`.
function resolve(rules, chain, prop) {
  let best = null
  rules.forEach((rule, order) => {
    for (const sel of rule.selectors) {
      const parts = parseSelector(sel)
      if (!parts || !matches(parts, chain)) continue
      const vals = declarations(rule.body, prop)
      if (!vals.length) continue
      const spec = specificity(parts)
      if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) {
        best = { spec, order, value: vals[vals.length - 1], sel }
      }
    }
  })
  return best
}

const RULES = topLevelRules(stripComments(CSS))

// The chain the page actually renders:
//   .page.vpage.cinema > .vdevice-page > section > .vgrid
//     > article.vcard.vdevice-card > .vcard-art > .vcard-actions
function chainFor(opts) {
  opts = opts || {}
  const card = { classes: ['vcard', 'vdevice-card'], states: [] }
  if (opts.hover) card.states.push(':hover')
  if (opts.focusWithin) card.states.push(':focus-within')
  return [
    { classes: opts.cinema === false ? ['page', 'vpage'] : ['page', 'vpage', 'cinema'], states: [] },
    { classes: ['vdevice-page'], states: [] },
    { classes: ['vdevice-section'], states: [] },
    { classes: ['vgrid'], states: [] },
    card,
    { classes: ['vcard-art'], states: [] },
    { classes: ['vcard-actions'], states: [] },
  ]
}
// The same chain for an ordinary catalogue poster, which must keep its
// hover-reveal behaviour.
function posterChain(opts) {
  opts = opts || {}
  const card = { classes: ['vcard'], states: [] }
  if (opts.hover) card.states.push(':hover')
  return [
    { classes: ['page', 'vpage', 'cinema'], states: [] },
    { classes: ['vrail'], states: [] },
    card,
    { classes: ['vcard-art'], states: [] },
    { classes: ['vcard-actions'], states: [] },
  ]
}

test('a device card shows its Play and Delete buttons without a hover', () => {
  for (const cinema of [true, false]) {
    const got = resolve(RULES, chainFor({ cinema }), 'opacity')
    assert.ok(got, 'some rule sets opacity on the device card actions (cinema=' + cinema + ')')
    assert.notStrictEqual(got.value, '0',
      'the buttons are invisible at rest under "' + got.sel + '" (cinema=' + cinema + ')')
    assert.ok(Number(got.value) >= 0.8,
      'and visible enough to be found: got ' + got.value + ' from "' + got.sel + '"')
  }
})

test('hovering or focusing one still takes them to full strength', () => {
  for (const state of [{ hover: true }, { focusWithin: true }]) {
    const got = resolve(RULES, chainFor(state), 'opacity')
    assert.strictEqual(got.value, '1', 'from "' + got.sel + '"')
  }
})

test('an ordinary catalogue poster keeps its hover reveal', () => {
  const rest = resolve(RULES, posterChain({}), 'opacity')
  assert.strictEqual(rest.value, '0',
    'the shared rule is untouched — this fix is scoped to the On-device card')
  const hover = resolve(RULES, posterChain({ hover: true }), 'opacity')
  assert.strictEqual(hover.value, '1')
})

test('MUTATION: without the scoped rule the device buttons hide again', () => {
  const broken = CSS.replace(/\.vdevice-card \.vcard-actions,\n\.cinema \.vdevice-card \.vcard-actions \{[^}]*\}\n/, '')
  assert.notStrictEqual(broken, CSS, 'the mutation applied')
  const rules = topLevelRules(stripComments(broken))
  const got = resolve(rules, chainFor({}), 'opacity')
  assert.strictEqual(got.value, '0', 'which is the state he was complaining about')
})
