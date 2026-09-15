'use strict'
// Secrets out of logs, exports and error text (roadmap 136). Two halves:
// redactObject for settings-shaped data (by key name) and redactText for
// free text — log lines, error messages, URLs — where a token can appear
// after a header, a query parameter or a JSON field. Pure; tested in
// test/redact.test.js. Redaction keeps the shape ("__redacted__") so a
// reader can see a value was there without the value leaving the machine.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaRedact = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  var MARK = '__redacted__'
  // Key names that hold secrets, wherever they sit in an object.
  var SECRET_KEY = /pass(word|wd)?|token|secret|api[-_]?key|key$|^key|auth(?!or)|cookie|credential|bearer/i

  function redactObject(obj) {
    if (!obj || typeof obj !== 'object') return obj
    var out = Array.isArray(obj) ? [] : {}
    Object.keys(obj).forEach(function (k) {
      var v = obj[k]
      if (SECRET_KEY.test(k) && v != null && v !== '') out[k] = MARK
      else if (v && typeof v === 'object') out[k] = redactObject(v)
      else out[k] = v
    })
    return out
  }

  var TEXT_RULES = [
    // Authorization: Bearer xxx / Basic xxx (headers in error dumps)
    [/(authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic|token)\s+)[^\s"',;]+/gi, '$1' + MARK],
    [/(\bbearer\s+)[A-Za-z0-9\-._~+/]{8,}=*/gi, '$1' + MARK],
    // Cookie: header values
    [/(\bcookie["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1' + MARK],
    // URL query parameters and form fields named like secrets
    [/([?&;](?:api[-_]?key|apikey|key|token|access_token|auth|password|passwd|pass|secret|sig|signature|client_secret)=)[^&\s"'#]+/gi, '$1' + MARK],
    // JSON / YAML / ini style fields named like secrets
    [/(["']?(?:pass(?:word|wd)?|token|secret|api[-_]?key|apikey|auth|cookie|credential)["']?\s*[:=]\s*["']?)(?!__redacted__)[^\s"',;}]+/gi, '$1' + MARK],
    // slskd-style basic auth inside URLs: http://user:pass@host
    [/(https?:\/\/[^\s/:@"']+:)[^\s/@"']+(@)/gi, '$1' + MARK + '$2'],
  ]

  function redactText(text) {
    var s = String(text == null ? '' : text)
    for (var i = 0; i < TEXT_RULES.length; i++) s = s.replace(TEXT_RULES[i][0], TEXT_RULES[i][1])
    return s
  }

  return { redactObject: redactObject, redactText: redactText, MARK: MARK, SECRET_KEY: SECRET_KEY }
})
