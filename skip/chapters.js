'use strict'
// Layer 1 skip source: classify named mkv/mp4 chapters into skip segments.
// Pure — no I/O — so it is tested against a chapter list, not a file.
//
// Many releases ship chapters with meaningful names ("Opening", "ED1",
// "Previously on...", "Next Episode Preview"). Reading them is free and
// instant, and it is the highest-confidence source when it fires — no network,
// no signal processing, no guess. The regexes are deliberately narrow: a false
// "Skip Intro" is worse than none, so only words that actually mean the thing
// match, case-insensitively and as whole words.

// The digit suffix is not optional decoration: anime chapters are named "OP1",
// "OP2", "ED1", "ED2" far more often than a bare "OP"/"ED", and \bed\b cannot
// match ED1 because the digit is a word character, so no boundary exists after
// the "D". Without \d* this layer misses the exact case it was written for.
const INTRO_RE = /\b(intro|opening|op\d*|title\s+sequences?|title\s+cards?)\b/i
const RECAP_RE = /\b(recap|previously|prologue)\b/i
const CREDITS_RE = /\b(credits?|ending|ed\d*|outro|end\s+cards?)\b/i
const PREVIEW_RE = /\b(preview|next\s+episode|next\s+time|coming\s+next)\b/i

function classifyTitle(title) {
  const t = typeof title === 'string' ? title : ''
  if (!t) return null
  // Priority matters when a single title could match two patterns ("Opening
  // and Ending"). Intro is the common lead slot, so it wins.
  if (INTRO_RE.test(t)) return 'intro'
  if (RECAP_RE.test(t)) return 'recap'
  if (CREDITS_RE.test(t)) return 'credits'
  if (PREVIEW_RE.test(t)) return 'preview'
  return null
}

// A chapter has no end of its own; its end is the next chapter's start, and a
// trailing chapter (credits, usually) ends at the file's duration. Without a
// duration the last chapter is dropped rather than guessing at its length.
function classifyChapters(chapters, { duration } = {}) {
  if (!Array.isArray(chapters)) return []
  const out = []
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const kind = classifyTitle(ch && ch.title)
    if (!kind) continue
    const start = Number(ch.start)
    if (!Number.isFinite(start)) continue
    const next = chapters[i + 1]
    let end = next ? Number(next.start) : Number(duration)
    if (!Number.isFinite(end) || end <= start) continue
    out.push({ kind, start, end, origin: 'chapters', confidence: 0.9 })
  }
  return out
}

module.exports = { classifyTitle, classifyChapters, INTRO_RE, RECAP_RE, CREDITS_RE, PREVIEW_RE }
