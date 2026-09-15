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

  // Local paths out of anything bound for a cloud provider (roadmap 110). A
  // file path is where a person keeps their music; a model has no use for it.
  var LOCAL_PATH = /(?:\/(?:Users|home|mnt|Volumes|media|run\/media|srv|opt|var|tmp|private)\/[^\s"'<>|]+|\b[A-Za-z]:\\[^\s"'<>|]+)/g
  function stripLocalPaths(text) {
    return String(text == null ? '' : text).replace(LOCAL_PATH, '[local path]')
  }
  // Scrub a provider message list in place-safe fashion: strings, text blocks
  // and tool_result contents all pass through stripLocalPaths + redactText.
  function scrubMessagesForCloud(messages) {
    var clean = function (v) { return redactText(stripLocalPaths(v)) }
    return (messages || []).map(function (m) {
      if (!m || typeof m !== 'object') return m
      var out = Object.assign({}, m)
      if (typeof out.content === 'string') out.content = clean(out.content)
      else if (Array.isArray(out.content)) {
        out.content = out.content.map(function (b) {
          if (!b || typeof b !== 'object') return typeof b === 'string' ? clean(b) : b
          var nb = Object.assign({}, b)
          if (typeof nb.text === 'string') nb.text = clean(nb.text)
          if (typeof nb.content === 'string') nb.content = clean(nb.content)
          if (nb.input && typeof nb.input === 'object') nb.input = JSON.parse(clean(JSON.stringify(nb.input)))
          return nb
        })
      }
      return out
    })
  }

  return { redactObject: redactObject, redactText: redactText, stripLocalPaths: stripLocalPaths,
    scrubMessagesForCloud: scrubMessagesForCloud, MARK: MARK, SECRET_KEY: SECRET_KEY }
})
