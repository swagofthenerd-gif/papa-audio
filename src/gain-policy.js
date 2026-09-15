'use strict'
// The documented gain policy (roadmap 096): every source of gain above unity
// in one place, summed, and turned into a clipping verdict a person can read.
// Boost lifts the volume ceiling to 130 % (software gain); an EQ curve adds
// its highest boost minus its preamp; ReplayGain can raise quiet tracks.
// Pure; tested in test/gain-policy.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaGainPolicy = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  function db(ratio) { return 20 * Math.log10(ratio) }
  function round1(x) { return Math.round(x * 10) / 10 }

  // facts: { boost, volumePct, eq: { enabled, preamp, gains }, replaygain }
  function assess(facts) {
    facts = facts || {}
    var parts = []
    var total = 0
    var vol = Number(facts.volumePct)
    if (isFinite(vol) && vol > 100) {
      var v = round1(db(vol / 100))
      parts.push({ source: 'Volume ' + Math.round(vol) + '%', db: v }); total += v
    }
    var eq = facts.eq
    if (eq && eq.enabled) {
      var peak = 0
      ;(eq.gains || []).forEach(function (g) { g = Number(g) || 0; if (g > peak) peak = g })
      var net = round1(peak + (Number(eq.preamp) || 0))
      if (net > 0) { parts.push({ source: 'EQ (+' + peak + ' dB peak, preamp ' + (Number(eq.preamp) || 0) + ' dB)', db: net }); total += net }
      else if (peak > 0) parts.push({ source: 'EQ (preamp covers its +' + peak + ' dB)', db: 0 })
    }
    var rg = String(facts.replaygain || 'no').toLowerCase()
    var rgNote = (rg === 'track' || rg === 'album')
      ? 'ReplayGain may raise quiet tracks; a file\'s peak tag caps it when present.'
      : null
    total = round1(total)
    var risk = total > 3 ? 'likely' : total > 0 ? 'possible' : 'none'
    var text
    if (risk === 'none') text = rgNote ? 'No gain above unity. ' + rgNote : 'No gain above unity — nothing can clip.'
    else text = '+' + total + ' dB above unity from ' + parts.filter(function (p) { return p.db > 0 }).map(function (p) { return p.source }).join(' and ') +
      (risk === 'likely' ? ' — loud passages will clip.' : ' — loud passages may clip.') + (rgNote ? ' ' + rgNote : '')
    return { totalDb: total, risk: risk, parts: parts, text: text }
  }

  return { assess: assess }
})
