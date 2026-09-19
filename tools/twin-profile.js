#!/usr/bin/env node
'use strict'
// CPU-profile a twin while a script runs. Usage:
//   node tools/twin-profile.js --port 9424 --run "<js expression returning a promise>" [--top 25]
// Prints the hottest functions by SELF time (ms) with file:line, so a laggy
// page is diagnosed from a measurement rather than a guess.
const WebSocket = require('ws')
const http = require('http')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d }
const port = opt('--port', '9222'), run = opt('--run', 'Promise.resolve()'), top = Number(opt('--top', 25))

function listTargets() {
  return new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/json/list`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  }).on('error', rej))
}
;(async () => {
  const targets = await listTargets()
  const page = targets.find(t => t.type === 'page' && !/about:blank/.test(t.url)) || targets[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  let id = 0; const pending = new Map()
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } })
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 })
  await send('Profiler.start')
  const t0 = Date.now()
  const ev = await send('Runtime.evaluate', { expression: run, awaitPromise: true, returnByValue: true })
  const wall = Date.now() - t0
  const { result } = await send('Profiler.stop')
  const prof = result.profile
  const nodes = new Map(prof.nodes.map(n => [n.id, n]))
  const self = new Map()
  const dt = prof.timeDeltas
  for (let i = 0; i < prof.samples.length; i++) {
    const n = nodes.get(prof.samples[i]); if (!n) continue
    const cf = n.callFrame
    const key = `${cf.functionName || '(anon)'}  ${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`
    self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000)
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  const total = [...self.values()].reduce((a, b) => a + b, 0)
  const val = ev.result && ev.result.result ? ev.result.result.value : (ev.result && ev.result.exceptionDetails ? 'THREW: ' + ev.result.exceptionDetails.text : undefined)
  console.log(`wall ${wall} ms · sampled ${Math.round(total)} ms · result ${String(JSON.stringify(val)).slice(0, 200)}`)
  for (const [k, ms] of rows) console.log(String(Math.round(ms)).padStart(6), 'ms ', k)
  ws.close()
})().catch(e => { console.error('PROFILE FAILED:', e.message); process.exit(1) })
