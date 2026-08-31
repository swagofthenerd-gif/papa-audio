'use strict';

/**
 * Structural guards for the Papa Cinema section of src/styles.css.
 *
 * There is no DOM in this test run, so nothing here can prove the section
 * *looks* right. What it can prove is that the section stays structurally
 * safe: scoped, complete, motion-respecting and focus-visible. Each test below
 * names the specific regression it exists to catch — if you are about to
 * loosen one, the comment tells you what breaks in the app when you do.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'src', 'styles.css');
const RAW = fs.readFileSync(CSS_PATH, 'utf8');

const MARKER = 'PAPA CINEMA  ·  the film identity';
const SCOPE = '.cinema';

const TOKENS = [
  '--cin-ground', '--cin-surface', '--cin-raised', '--cin-line',
  '--cin-bone', '--cin-bone-2', '--cin-muted', '--cin-ember', '--cin-rec'
];

const TOKEN_VALUES = {
  '--cin-ground': '#0B0B0C',
  '--cin-surface': '#141416',
  '--cin-raised': '#1B1B1E',
  '--cin-line': '#26262A',
  '--cin-bone': '#EDE8E0',
  '--cin-bone-2': '#B4ADA3',
  '--cin-muted': '#7C766D',
  '--cin-ember': '#E9A13B',
  '--cin-rec': '#D8453F'
};

/** Everything from the section banner to the end of the file. */
function cinemaSection() {
  const at = RAW.indexOf(MARKER);
  assert.ok(at !== -1, 'cinema section marker missing from styles.css');
  // The marker lives inside the banner comment; start at the comment itself so
  // comment stripping stays balanced.
  const start = RAW.lastIndexOf('/*', at);
  return RAW.slice(start === -1 ? at : start);
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flatten a stylesheet fragment into { selector, body, inAtRule } records.
 * Handles one level of at-rule nesting, which is all this section uses.
 */
function rules(css) {
  const out = [];
  const src = stripComments(css);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    // Find the matching close brace.
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      for (const inner of rules(body)) {
        out.push({ selector: inner.selector, body: inner.body, inAtRule: prelude });
      }
    } else {
      out.push({ selector: prelude, body, inAtRule: null });
    }
    i = j;
  }
  return out;
}

const SECTION = cinemaSection();
const RULES = rules(SECTION);

test('cinema section is appended at the end and nothing follows it', () => {
  // Guards the integration contract: this section is meant to be the last
  // thing in the file so its (equal-specificity) rules win by source order.
  // If someone appends more CSS after it, some cinema rules silently stop
  // applying and the failure looks like "the film tab half-reverted".
  assert.ok(RULES.length > 20, 'cinema section parsed to almost nothing');
  const idx = RAW.indexOf(MARKER);
  assert.ok(idx > RAW.length * 0.5, 'cinema section is not near the end of the file');
});

test('every design token is defined, once, with the value from the plan', () => {
  // A var() with no fallback makes the whole declaration invalid and the
  // property is dropped silently — the exact failure the file's own header
  // comment records for --text1. A typo'd or missing token here does not
  // error, it just makes text or borders vanish.
  const root = RULES.find(r => r.selector === SCOPE);
  assert.ok(root, 'no `.cinema` rule defining the token block');
  for (const token of TOKENS) {
    const m = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(root.body);
    assert.ok(m, `token ${token} is not defined on .cinema`);
    assert.strictEqual(
      m[1].trim().split(/\s+/)[0].toUpperCase(),
      TOKEN_VALUES[token].toUpperCase(),
      `token ${token} does not carry the value from the plan`
    );
  }
});

test('every cin- token that is used is also defined', () => {
  // Catches renames and typos (--cin-bone2 vs --cin-bone-2). Using an
  // undefined custom property drops the declaration without any console
  // error, so nothing but a test will notice.
  const used = new Set();
  for (const m of stripComments(SECTION).matchAll(/var\(\s*(--cin-[a-z0-9-]+)/g)) used.add(m[1]);
  const defined = new Set();
  for (const m of stripComments(SECTION).matchAll(/(--cin-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const token of used) {
    assert.ok(defined.has(token), `var(${token}) is used but never defined`);
  }
});

test('no rule escapes the .cinema scope', () => {
  // The music player and the film section share class names (.vcard, .vhero,
  // .vrow-title). One unscoped selector here restyles the music library.
  for (const rule of RULES) {
    for (const part of rule.selector.split(',')) {
      const sel = part.trim();
      if (!sel) continue;
      assert.ok(
        sel === SCOPE || sel.startsWith(`${SCOPE} `) || sel.startsWith(`${SCOPE}.`) ||
        sel.startsWith(`${SCOPE}:`) || sel.startsWith(`${SCOPE}>`),
        `selector "${sel}" is not scoped to ${SCOPE}`
      );
    }
  }
});

test('the section never uses !important', () => {
  // Appending to a 6600-line stylesheet, !important is the tempting way to
  // win a specificity fight — and it is unwinnable later, because the only
  // way to override it is another !important. The section is written to win
  // on specificity instead; this keeps it that way.
  assert.ok(
    !/!important/.test(stripComments(SECTION)),
    'cinema section uses !important — win on specificity instead'
  );
});

test('every selector that adds a transition is disabled under reduced motion', () => {
  // A missing entry here means one animation keeps running for a user who
  // asked the OS for no motion. Listing the reduced-motion block by hand is
  // easy to forget when a new transition is added, so it is checked.
  const animated = new Set();
  for (const rule of RULES) {
    if (rule.inAtRule) continue;
    if (!/(^|[;{\s])transition\s*:/.test(rule.body)) continue;
    if (/transition\s*:\s*none/.test(rule.body)) continue;
    for (const part of rule.selector.split(',')) animated.add(part.trim());
  }
  assert.ok(animated.size > 0, 'no transitions found — parser is probably broken');

  const reduced = RULES.filter(r => r.inAtRule && /prefers-reduced-motion/.test(r.inAtRule));
  assert.ok(reduced.length > 0, 'no prefers-reduced-motion block in the cinema section');
  const silenced = new Set();
  for (const rule of reduced) {
    if (!/transition\s*:\s*none/.test(rule.body)) continue;
    for (const part of rule.selector.split(',')) silenced.add(part.trim());
  }
  for (const sel of animated) {
    assert.ok(silenced.has(sel), `"${sel}" animates but is not reset under prefers-reduced-motion`);
  }
});

test('reduced motion also cancels hover travel and skeleton shimmer', () => {
  // transition:none alone is not enough: a transform still jumps, and the
  // skeleton shimmer is a keyframe animation, not a transition.
  const reduced = RULES.filter(r => r.inAtRule && /prefers-reduced-motion/.test(r.inAtRule));
  const body = reduced.map(r => `${r.selector}{${r.body}}`).join('\n');
  assert.ok(/transform\s*:\s*none/.test(body), 'reduced motion does not cancel any transform');
  assert.ok(/animation\s*:\s*none/.test(body), 'reduced motion does not cancel the skeleton shimmer');
  assert.ok(/scroll-behavior\s*:\s*auto/.test(body), 'reduced motion leaves smooth rail scrolling on');
});

test('interactive elements have a visible focus style', () => {
  // Keyboard users navigate the shelves; the card reveal is bound to
  // :focus-within precisely so it works without a mouse. A focus style that
  // is only `outline:none` would make the section unusable by keyboard.
  const focusRules = RULES.filter(r => /:focus-visible/.test(r.selector));
  assert.ok(focusRules.length >= 2, 'almost no :focus-visible rules in the cinema section');
  const outlined = focusRules.filter(r => /outline\s*:\s*\d/.test(r.body));
  assert.ok(outlined.length > 0, 'no :focus-visible rule draws a real outline');
  for (const rule of focusRules) {
    assert.ok(
      !/outline\s*:\s*(none|0)\s*;/.test(rule.body),
      `"${rule.selector}" removes the focus outline`
    );
  }
  // The card actions must reveal on keyboard focus, not hover alone.
  const revealed = RULES.some(r => /:focus-within/.test(r.selector) && /\.vcard-actions/.test(r.selector));
  assert.ok(revealed, 'card actions are not revealed on :focus-within');
});

test('no colour is defined only inside a media query', () => {
  // A colour that exists only under a matching media query disappears
  // entirely when the query does not match — the element renders with the
  // inherited or default colour and the section looks half-styled. Colours
  // belong in the unconditional rules; media queries adjust motion and
  // layout only.
  for (const rule of RULES) {
    if (!rule.inAtRule) continue;
    const colourish = rule.body.match(/(^|[;\s])(color|background|background-color|border-color|outline-color|fill)\s*:[^;]*(#[0-9a-f]{3,8}|rgba?\(|var\(--cin-)/gi);
    assert.ok(
      !colourish,
      `colour declared only inside "${rule.inAtRule}" for "${rule.selector}": ${colourish && colourish[0].trim()}`
    );
  }
});

test('wide content scrolls inside the rail, not the page', () => {
  // Posters, long director credits and the ratings row all sit in a
  // horizontally scrolling track. Without these two declarations a wide shelf
  // makes the whole window scroll sideways and the header drifts off screen.
  const root = RULES.find(r => r.selector === SCOPE);
  assert.match(root.body, /overflow-x\s*:\s*hidden/, '.cinema does not clamp page-level horizontal overflow');
  const rail = RULES.find(r => r.selector === `${SCOPE} .vrail` && !r.inAtRule);
  assert.ok(rail, 'no unconditional .cinema .vrail rule');
  assert.match(rail.body, /overflow-x\s*:\s*auto/, 'the rail itself does not scroll horizontally');
  // Truncating text needs min-width:0 inside a grid/flex track or it refuses
  // to shrink and pushes the track wider than its column.
  const meta = RULES.find(r => /\.vcard-credit/.test(r.selector) && /text-overflow/.test(r.body));
  assert.ok(meta, 'no truncation rule for the card credit line');
  assert.match(meta.body, /min-width\s*:\s*0/, 'credit line can widen its grid track');
});

test('the hero title has a Bodoni fallback for films with no logo art', () => {
  // Rule 3 of the design is that heroes use the film's own title art, but
  // most titles have none. If .vhero-title were left unstyled the fallback
  // would render in the music player's Poppins and break the identity.
  const title = RULES.find(r => r.selector === `${SCOPE} .vhero-title`);
  assert.ok(title, 'no .cinema .vhero-title rule');
  assert.match(title.body, /font-family\s*:\s*var\(--cin-display\)/, 'hero fallback title is not set in Bodoni');
  const logo = RULES.find(r => r.selector === `${SCOPE} .vhero-logo`);
  assert.ok(logo, 'no .cinema .vhero-logo rule');
  assert.match(logo.body, /max-width\s*:/, 'title logo is not width-capped and can overflow the hero');
  assert.match(logo.body, /max-height\s*:/, 'title logo is not height-capped');
});

test('all three rating sources are styled and none relies on colour alone', () => {
  // IMDb /10, Rotten Tomatoes % and Metacritic /100 are three different
  // scales. Each needs its own bar hue AND a visible source label, so the row
  // is still readable for a colour-blind viewer or in a screenshot.
  for (const src of ['vrate-imdb', 'vrate-rt', 'vrate-mc']) {
    assert.ok(
      RULES.some(r => r.selector.includes(src)),
      `no styling for rating source .${src}`
    );
  }
  assert.ok(RULES.some(r => r.selector.includes('.vrate-src')), 'no source label style — hue would be the only cue');
  assert.ok(RULES.some(r => r.selector.includes('.vrate-val')), 'no numeric value style');
  const val = RULES.find(r => r.selector === `${SCOPE} .vrate-val`);
  assert.match(val.body, /tabular-nums/, 'rating numbers are not tabular and will jitter across a shelf');
});

test('the card skeleton mirrors the real card', () => {
  // A skeleton of a different height makes the shelf jump when data lands.
  const skel = RULES.filter(r => r.selector.includes('.vcard-skel'));
  assert.ok(skel.length >= 4, 'the .vcard-skel skeleton is barely styled');
  const art = RULES.find(r => r.selector === `${SCOPE} .vcard-art`);
  const skelCard = skel.find(r => r.selector.includes('.vskel-card'));
  const ratio = /aspect-ratio\s*:\s*2\s*\/\s*3/;
  assert.match(art.body, ratio, 'card poster is not 2/3');
  assert.match(skelCard.body, ratio, 'skeleton poster ratio does not match the real card');
});

test('empty and error states share a shape', () => {
  // An error shelf that restyles itself into a different box makes a
  // transient API failure look like a broken page.
  const msg = RULES.find(r => r.selector === `${SCOPE} .vrow-msg`);
  const err = RULES.find(r => r.selector === `${SCOPE} .vrow-msg.err`);
  assert.ok(msg && err, 'row message / error states are not both styled');
  assert.ok(
    !/padding|border-radius|display\s*:/.test(err.body),
    'the error state changes the box, not just the accent colour'
  );
  assert.ok(RULES.some(r => r.selector === `${SCOPE} .vempty-title`), 'no styled empty-state title');
});
