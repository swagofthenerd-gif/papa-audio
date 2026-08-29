'use strict'
// Weighted random selection without replacement.
//
// Top-N selection would give the same queue every time from the same seed,
// which is the opposite of what "surprise me" means. Softmax sampling stays in
// the right neighbourhood while never repeating itself.

function softmaxSample(items, scores, { count = 1, temperature = 1, rng = Math.random } = {}) {
  const pool = items.map((item, i) => ({ item, score: Number(scores[i]) || 0 }))
  if (!pool.length) return []
  const t = temperature > 0 ? temperature : 1e-6

  // Subtracting the max before exponentiating is what keeps a large score from
  // overflowing to Infinity and turning every weight into NaN.
  const out = []
  const want = Math.min(count, pool.length)
  while (out.length < want) {
    const max = Math.max(...pool.map(p => p.score))
    const weights = pool.map(p => Math.exp((p.score - max) / t))
    const total = weights.reduce((s, w) => s + w, 0)
    let r = rng() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i]
      if (r <= 0) { idx = i; break }
    }
    out.push(pool[idx].item)
    pool.splice(idx, 1)
  }
  return out
}

module.exports = { softmaxSample }
