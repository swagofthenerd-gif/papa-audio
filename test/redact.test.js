'use strict'
const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/redact')

// Roadmap 136: nothing secret leaves the machine in a log, an export or an error.
test('object redaction covers every secret-shaped key, nested, and keeps the shape', () => {
  const out = R.redactObject({
    slskConfig: { username: 'sherry', password: 'hunter2', url: 'http://localhost:5030' },
    tmdbKey: 'abc', anthropicApiKey: 'sk-1', realdebrid: { token: 't', secret: 's', apiKey: 'k' },
    ytCookie: 'SID=xyz', authHeader: 'x', list: [{ key: 'v' }], empty: '', volume: 80,
  })
  assert.equal(out.slskConfig.username, 'sherry')
  assert.equal(out.slskConfig.password, R.MARK)
  assert.equal(out.slskConfig.url, 'http://localhost:5030')
  for (const v of [out.tmdbKey, out.anthropicApiKey, out.realdebrid.token, out.realdebrid.secret, out.realdebrid.apiKey, out.ytCookie, out.authHeader, out.list[0].key]) assert.equal(v, R.MARK)
  assert.equal(out.empty, '', 'an empty secret stays empty rather than pretending a value was there')
  assert.equal(out.volume, 80)
})

test('text redaction scrubs headers, query strings, fields and URL credentials', () => {
  const line = [
    'GET https://api.example.com/v1?api_key=AAAA1111&x=1',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
    "fetch failed { headers: { cookie: 'SID=abc; HSID=def' } }",
    'password=hunter2 token=tok_123',
    'slskd at http://slskd:slskd@localhost:5030/api/v0',
    '{"apiKey":"sk-live-999","volume":80}',
  ].join('\n')
  const out = R.redactText(line)
  for (const leak of ['AAAA1111', 'eyJhbGci', 'SID=abc', 'hunter2', 'tok_123', 'slskd:slskd@', 'sk-live-999']) {
    assert.ok(!out.includes(leak), 'leaked: ' + leak + '\n' + out)
  }
  assert.ok(out.includes('x=1') && out.includes('"volume":80') && out.includes('localhost:5030'), 'non-secrets survive')
})

test('text redaction is idempotent and safe on odd input', () => {
  const once = R.redactText('token=abc')
  assert.equal(R.redactText(once), once)
  assert.equal(R.redactText(null), '')
  assert.equal(R.redactText(12), '12')
})
