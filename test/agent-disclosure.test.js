'use strict'
const test = require('node:test')
const assert = require('node:assert')
const D = require('../src/agent-disclosure')
const R = require('../src/redact')

// Roadmap 110: provider setup states what leaves the device; paths and secrets never do.
test('Ollama is local and says so; cloud providers list what is sent and what never is', () => {
  const o = D.disclosure('ollama')
  assert.equal(o.cloud, false); assert.match(o.summary, /Nothing you say .* leaves it/)
  const c = D.disclosure('claude')
  assert.equal(c.vendor, 'Anthropic'); assert.ok(c.sent.length >= 3); assert.ok(c.neverSent.some(x => /paths/.test(x)))
  assert.equal(D.disclosure('openai').vendor, 'OpenAI')
  assert.match(D.html('openai', x => x.replace(/</g, '&lt;')), /Never sent:/)
})

test('messages bound for a cloud provider carry no local paths and no secrets', () => {
  const msgs = [
    { role: 'user', content: 'play the flac at /Users/me/Music/Camel/01.flac please' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: '1', name: 'x', input: { path: 'C:\\Music\\a.flac' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'Downloaded to /mnt/data/MUSIC/Downloads/x via token=abc' }] },
  ]
  const out = R.scrubMessagesForCloud(msgs)
  const flat = JSON.stringify(out)
  assert.ok(!/\/Users\/me|C:\\\\Music|\/mnt\/data|token=abc/.test(flat), flat)
  assert.ok(flat.includes('[local path]') && flat.includes(R.MARK))
  assert.equal(msgs[0].content.includes('/Users/me'), true, 'the original is not mutated')
})
