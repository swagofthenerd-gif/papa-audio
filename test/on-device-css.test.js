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

// Rules that apply to the app's own window, in document order.
//
// @media blocks used to be skipped wholesale, on the grounds that a
// reduced-motion override is not the resting state. That was too blunt: a
// width query that is true at any size the app can be — `@media (min-width:
// 1px)` at the extreme — is as much the resting state as a top-level rule,
// and re-hiding the device buttons inside one left every test here green.
//
// So the blocks are evaluated against a fixed 1280x800 window, which is what
// the app opens at. A query that is true is descended into and its rules take
// their place in document order (a media block adds no specificity); a query
// that is false, or one this evaluator does not understand, is skipped.
const VIEWPORT = { width: 1280, height: 800 }

// One `(feature: value)` test. Unknown features answer false: a rule that
// might not apply must not be allowed to decide the resting state.
function mediaFeature(text) {
  const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/.exec(text.trim())
  if (!m) return false
  const name = m[1]
  const value = (m[2] || '').trim()
  const px = () => parseFloat(value)
  switch (name) {
    case 'min-width': return VIEWPORT.width >= px()
    case 'max-width': return VIEWPORT.width <= px()
    case 'min-height': return VIEWPORT.height >= px()
    case 'max-height': return VIEWPORT.height <= px()
    // A desktop window with a mouse.
    case 'hover': return value === 'hover'
    case 'any-hover': return value === 'hover'
    case 'pointer': return value === 'fine'
    case 'any-pointer': return value === 'fine'
    // Preferences are the user's, not the app's: never assumed on.
    case 'prefers-reduced-motion':
    case 'prefers-reduced-data':
    case 'prefers-contrast':
    case 'prefers-color-scheme':
    case 'forced-colors':
      return false
    default: return false
  }
}

// `screen and (min-width: 700px), print` — true if any comma branch is true.
function mediaApplies(prelude) {
  const query = prelude.replace(/^@media\s*/, '').trim()
  if (!query) return true
  return splitSelectors(query).some(branch => {
    const terms = branch.split(/\s+and\s+/i).map(t => t.trim()).filter(Boolean)
    return terms.every(term => {
      if (/^not\b/i.test(term)) return false      // not understood: skip the block
      if (term === 'screen' || term === 'all') return true
      if (term === 'print' || term === 'speech') return false
      return mediaFeature(term)
    })
  })
}

function collectRules(css, rules) {
  rules = rules || []
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
    if (prelude.startsWith('@media')) {
      // A block whose condition holds for this window contributes its rules in
      // place; one that does not is skipped, as are @font-face, @keyframes and
      // the rest, which contribute nothing to a resolved property anyway.
      if (mediaApplies(prelude)) collectRules(body, rules)
    } else if (prelude.startsWith('@')) {
      /* not a wrapper of ordinary rules */
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

const RULES = collectRules(stripComments(CSS))

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
  const rules = collectRules(stripComments(broken))
  const got = resolve(rules, chainFor({}), 'opacity')
  assert.strictEqual(got.value, '0', 'which is the state he was complaining about')
})

test('the media evaluator answers for the window the app actually opens', () => {
  // A floor on the evaluator: if it said "no" to everything, including media
  // blocks would be the same as skipping them and the test below would pass
  // on nothing.
  assert.strictEqual(mediaApplies('@media (min-width: 1px)'), true)
  assert.strictEqual(mediaApplies('@media (max-width: 1100px)'), false, 'a 1280px window is wider')
  assert.strictEqual(mediaApplies('@media (min-width: 900px) and (max-width: 1400px)'), true)
  assert.strictEqual(mediaApplies('@media screen and (min-width: 600px)'), true)
  assert.strictEqual(mediaApplies('@media print'), false)
  assert.strictEqual(mediaApplies('@media (prefers-reduced-motion: reduce)'), false,
    'a preference is the user\'s, and never the resting state')
  // And the collector really descends into the ones that apply, and only those.
  assert.strictEqual(collectRules('@media (min-width:1px){.x{opacity:0}}').length, 1)
  assert.strictEqual(collectRules('@media (max-width:100px){.x{opacity:0}}').length, 0)
  assert.strictEqual(collectRules('@media print{.x{opacity:0}}').length, 0)
  assert.strictEqual(collectRules('@keyframes spin{from{opacity:0}}').length, 0,
    'a keyframe step is not a rule that applies to anything')
})

test('MUTATION: re-hiding the buttons inside an always-true media block is caught', () => {
  // Same selectors as the rule that makes them visible, so this is a pure
  // ordering win — the realistic shape of an accidental re-hide.
  const broken = CSS + '\n@media (min-width: 1px) {\n' +
    '  .vdevice-card .vcard-actions,\n  .cinema .vdevice-card .vcard-actions { opacity: 0 }\n}\n'
  const rules = collectRules(stripComments(broken))
  const got = resolve(rules, chainFor({}), 'opacity')
  assert.strictEqual(got.value, '0',
    'the resolver must SEE the media block — otherwise the buttons can be hidden ' +
    'again in one and nothing here notices')
})
