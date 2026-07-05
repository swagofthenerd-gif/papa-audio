'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { MpvIpcClient } = require('../mpv-ipc')

function mockServer(handler) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-test-')), 'mpv.sock')
  const conns = []
  const server = net.createServer(c => {
    conns.push(c)
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.trim()) handler(JSON.parse(line), c)
      }
    })
  })
  return new Promise(res => server.listen(sock, () =>
    res({ sock, server, push: msg => conns.forEach(c => c.write(JSON.stringify(msg) + '\n')),
          close: () => { conns.forEach(c => c.destroy()); server.close() } })))
}

test('command resolves with data on success response', async () => {
  const srv = await mockServer((msg, c) =>
    c.write(JSON.stringify({ error: 'success', data: 42, request_id: msg.request_id }) + '\n'))
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  assert.strictEqual(await client.command('get_property', 'volume'), 42)
  client.close(); srv.close()
})

test('command rejects on mpv error response', async () => {
  const srv = await mockServer((msg, c) =>
    c.write(JSON.stringify({ error: 'property not found', request_id: msg.request_id }) + '\n'))
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  await assert.rejects(client.command('get_property', 'nope'), /property not found/)
  client.close(); srv.close()
})

test('interleaved responses match by request_id', async () => {
  const held = []
  const srv = await mockServer((msg, c) => held.push({ msg, c }))
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  const p1 = client.command('a'); const p2 = client.command('b')
  // answer in reverse order
  await new Promise(r => setTimeout(r, 50))
  held[1].c.write(JSON.stringify({ error: 'success', data: 'B', request_id: held[1].msg.request_id }) + '\n')
  held[0].c.write(JSON.stringify({ error: 'success', data: 'A', request_id: held[0].msg.request_id }) + '\n')
  assert.deepStrictEqual(await Promise.all([p1, p2]), ['A', 'B'])
  client.close(); srv.close()
})

test('events are emitted', async () => {
  const srv = await mockServer(() => {})
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  const got = new Promise(r => client.once('event', r))
  srv.push({ event: 'property-change', id: 1, name: 'time-pos', data: 12.5 })
  const e = await got
  assert.strictEqual(e.name, 'time-pos')
  client.close(); srv.close()
})

test('pending commands reject when socket closes', async () => {
  const srv = await mockServer(() => {})
  const client = new MpvIpcClient(srv.sock)
  await client.connect()
  const p = client.command('never-answered')
  srv.close()
  await assert.rejects(p, /socket closed|client closed/)
  client.close()
})

test('connect retries until socket exists, fails after timeout', async () => {
  const client = new MpvIpcClient('/nonexistent/papa.sock')
  await assert.rejects(client.connect(300), /not ready/)
})
