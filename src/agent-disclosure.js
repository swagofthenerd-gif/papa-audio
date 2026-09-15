'use strict'
// What the assistant sends off this computer, stated where the provider is
// chosen (roadmap 110). One table; the settings panel reads it. Pure.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaAgentDisclosure = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  var CLOUD_SENT = [
    'your messages in this conversation (the last 12)',
    'a short taste summary (your top artists)',
    'the assistant\'s own instructions',
    'what each tool returns: album, artist and track names, playback status, Soulseek peer names',
  ]
  var NEVER_SENT = [
    'file or folder paths on this computer (scrubbed before sending)',
    'your API keys, Soulseek password or cookies (scrubbed before sending)',
    'your full library listing, play history or files',
  ]
  var VENDORS = { claude: 'Anthropic', openai: 'OpenAI' }

  function disclosure(provider) {
    var p = String(provider || 'ollama').toLowerCase()
    if (!VENDORS[p]) {
      return { cloud: false, vendor: null,
        summary: 'Runs on this computer through Ollama. Nothing you say to the assistant leaves it.',
        sent: [], neverSent: [] }
    }
    return { cloud: true, vendor: VENDORS[p],
      summary: 'Sent to ' + VENDORS[p] + ' with each message you send:',
      sent: CLOUD_SENT.slice(), neverSent: NEVER_SENT.slice() }
  }

  function html(provider, esc) {
    var e = typeof esc === 'function' ? esc : function (x) { return String(x) }
    var d = disclosure(provider)
    if (!d.cloud) return '<p class="mcs-set-hint">' + e(d.summary) + '</p>'
    return '<p class="mcs-set-hint">' + e(d.summary) + '</p>' +
      '<ul class="mcs-disclosure">' + d.sent.map(function (x) { return '<li>' + e(x) + '</li>' }).join('') + '</ul>' +
      '<p class="mcs-set-hint">Never sent:</p>' +
      '<ul class="mcs-disclosure">' + d.neverSent.map(function (x) { return '<li>' + e(x) + '</li>' }).join('') + '</ul>'
  }

  return { disclosure: disclosure, html: html, VENDORS: VENDORS }
})
